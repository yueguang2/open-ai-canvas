// 晨羽 Bridge HTTP 服务。
// 对接影策：/v1/videos（异步视频）、/v1/images/generations（图片）、/v1/models、/files、/healthz。
// 另提供自包含的管理控制台（/、/admin）与 /api/bridge/* 管理接口。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config, GPU_ALIASES } from './config.mjs';
import { runTask, parseModel, chenyu, bridgeInstances, bridgeAccount, armIdleForKnownInstances, pruneOldFiles, budgetHistory, workflowExists, warmInstance } from './lib.mjs';
import { loadRuntimeSettings, currentSettings, saveRuntimeSettings, installLogCapture, recentLogs, clearLogs, logEvent, currentAdminToken, logFileInfo, readLogFile, currentBridgeApiKey } from './runtime.mjs';
import { loadPresets, listWorkflows, getWorkflow, upsertWorkflow, deleteWorkflow, saveWorkflowFile, readWorkflowFile, presetsMeta } from './presets.mjs';
import { analyzeWorkflow } from './workflow-analyzer.mjs';

loadRuntimeSettings();
loadPresets();
installLogCapture();

let PKG = { version: '0.0.0' };
try { PKG = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')); } catch {}

const ADMIN_HTML = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
const PUBLIC_BASE = (process.env.BRIDGE_PUBLIC_BASE || `http://127.0.0.1:${config.port}`).replace(/\/$/, '');

const tasks = new Map(); // id -> { id,status,url,message,kind,model,params,dedupKey,_session,createdAt,updatedAt }
const tasksFilePath = () => path.join(config.dataDir, 'tasks.json');
let persistTimer = null;
function stripSession(t) { const { _session, ...rest } = t; return rest; }
function persistTasksNow() {
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(tasksFilePath(), JSON.stringify(Array.from(tasks.values()).slice(-400).map(stripSession))); } catch {}
}
function persistTasks() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistTasksNow, 400);
  broadcastTasks();
}
// 启动/建服时加载任务并做重启恢复（路径按当前 dataDir 解析，适配测试与迁移后的数据目录）
function hydrateTasks() {
  tasks.clear();
  try { for (const t of JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))) if (t && t.id) tasks.set(t.id, t); } catch {}
  let recoveredTasks = 0;
  for (const t of tasks.values()) {
    if (t.status === 'running' || t.status === 'pending') {
      t.status = 'failed'; t.message = '桥接服务重启，任务已中断，请重试'; t.updatedAt = Date.now(); recoveredTasks += 1;
    }
  }
  if (recoveredTasks) { persistTasksNow(); logEvent('warn', `重启恢复：${recoveredTasks} 个未完成任务标记为失败`); }
}

// ---- 限流 / 队列上限 / 幂等去重 ----
const MAX_QUEUE = Number(process.env.BRIDGE_MAX_QUEUE || 30);
const RATE_PER_MIN = Number(process.env.BRIDGE_RATE_PER_MIN || 60);
const DEDUP_WINDOW_MS = Number(process.env.BRIDGE_DEDUP_WINDOW_SEC || 900) * 1000;
let submitTimes = [];
function queuedCount() { let n = 0; for (const t of tasks.values()) if (t.status === 'running' || t.status === 'pending') n += 1; return n; }
function rateLimited() {
  const now = Date.now();
  submitTimes = submitTimes.filter((x) => now - x < 60000);
  if (submitTimes.length >= RATE_PER_MIN) return true;
  submitTimes.push(now); return false;
}
function dedupKeyFor(headerKey, model, params) {
  const explicit = String(headerKey || '').trim();
  if (explicit) return 'ik:' + explicit;
  try { return 'h:' + crypto.createHash('sha1').update(JSON.stringify({ model, params })).digest('hex'); } catch { return ''; }
}
function findDuplicate(dedupKey) {
  if (!dedupKey) return null;
  const now = Date.now();
  for (const t of tasks.values()) {
    if (t.dedupKey !== dedupKey) continue;
    if (!t._session) continue; // 仅对本次进程创建的任务去重，避免命中历史/重启前任务
    if (now - (t.createdAt || 0) > DEDUP_WINDOW_MS) continue;
    if (t.status === 'running' || t.status === 'pending' || t.status === 'succeeded') return t;
  }
  return null;
}
function submissionGuard(res) {
  if (queuedCount() >= MAX_QUEUE) { send(res, 429, { error: { message: '队列已满，请稍后再试（同时进行/排队的任务已达上限）' } }); return false; }
  if (rateLimited()) { send(res, 429, { error: { message: '请求过于频繁，请稍后再试' } }); return false; }
  return true;
}

// ---- SSE：任务状态实时推送（管理后台用）----
const sseClients = new Set();
let sseTimer = null;
function tasksSnapshot() { return Array.from(tasks.values()).reverse(); }
function broadcastTasks() {
  if (!sseClients.size) return;
  clearTimeout(sseTimer);
  sseTimer = setTimeout(() => {
    const payload = 'event: tasks\ndata: ' + JSON.stringify({ tasks: tasksSnapshot() }) + '\n\n';
    for (const res of sseClients) { try { res.write(payload); } catch {} }
  }, 150);
}

function adminAllowed(req, url) {
  const token = currentAdminToken();
  if (!token) return true;
  const header = req.headers['x-admin-token'];
  const q = url.searchParams.get('token');
  return header === token || q === token;
}
// 业务接口鉴权（/v1/*）：配置了 key 才校验，支持 Authorization: Bearer 或 x-api-key。
function businessAllowed(req) {
  const key = currentBridgeApiKey();
  if (!key) return true;
  const auth = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const hk = String(req.headers['x-api-key'] || '').trim();
  return auth === key || hk === key;
}

function newId() { return 'cy_' + crypto.randomBytes(8).toString('hex'); }
function send(res, code, obj, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}
function readBody(req, limit = 32 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function jsonBody(req) { return readBody(req).then((s) => (s ? JSON.parse(s) : {})).catch(() => ({})); }

function modelList() {
  const out = [];
  for (const [k, p] of Object.entries(config.presets)) {
    for (const gpu of Object.keys(GPU_ALIASES)) out.push({ id: `${k}@${gpu}`, object: 'model', capability: p.capability });
  }
  return out;
}

function startTask(task, presetKey, gpuAlias, params) {
  task.status = 'running';
  task.updatedAt = Date.now();
  logEvent('info', `任务开始 ${task.id} ${task.kind || ''} ${task.model || presetKey + '@' + gpuAlias}`);
  persistTasks(); broadcastTasks();
  runTask(presetKey, gpuAlias, params, task.id, (s) => { task.message = s; task.updatedAt = Date.now(); broadcastTasks(); })
    .then((r) => {
      if (task.cancelled) { task.status = 'cancelled'; task.message = '任务已取消'; task.updatedAt = Date.now(); logEvent('info', `任务已取消 ${task.id}`); persistTasks(); broadcastTasks(); return; }
      task.status = 'succeeded'; task.kind = r.kind; task.url = `${PUBLIC_BASE}/files/${r.file}`; task.message = null; task.updatedAt = Date.now(); logEvent('info', `任务成功 ${task.id}`); persistTasks(); broadcastTasks();
    })
    .catch((e) => {
      if (task.cancelled) { task.status = 'cancelled'; task.message = '任务已取消'; task.updatedAt = Date.now(); logEvent('info', `任务已取消 ${task.id}`); persistTasks(); broadcastTasks(); return; }
      task.status = 'failed'; task.message = String((e && e.message) || e); task.updatedAt = Date.now(); logEvent('error', `任务失败 ${task.id}: ${task.message}`); persistTasks(); broadcastTasks();
    });
}

function dirUsage(dir) {
  let files = 0, bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      try { const st = fs.statSync(fp); if (st.isFile()) { files += 1; bytes += st.size; } } catch {}
    }
  } catch {}
  return { files, bytes };
}

async function handle(req, res) {
  const u = new URL(req.url, PUBLIC_BASE);
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/admin')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(ADMIN_HTML);
    return;
  }
  if (p.startsWith('/api/bridge/') && !adminAllowed(req, u)) return send(res, 401, { error: 'unauthorized' });
  if (p.startsWith('/v1/') && !businessAllowed(req)) return send(res, 401, { error: { message: 'unauthorized（业务接口需要 API Key）' } });

  // ------- 影策对接接口 -------
  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, presets: Object.keys(config.presets), version: PKG.version, apiKeyConfigured: !!config.apiKey });
  if (req.method === 'GET' && p === '/healthz/ready') {
    const out = { ok: true, version: PKG.version, checks: { apiKey: !!config.apiKey, upstream: false, balance: null, card: null } };
    if (!config.apiKey) { out.ok = false; out.checks.error = '未配置晨羽 API Key'; return send(res, 503, out); }
    try {
      const b = await Promise.race([
        chenyu.balanceInfo(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('上游查询超时')), 5000)),
      ]);
      out.checks.upstream = true;
      out.checks.balance = b ? b.balance : null;
      out.checks.card = b ? b.card_balance : null;
    } catch (e) {
      out.ok = false; out.checks.error = '上游不可用：' + ((e && e.message) || e);
      return send(res, 503, out);
    }
    return send(res, 200, out);
  }
  if (req.method === 'GET' && p === '/v1/models') return send(res, 200, { object: 'list', data: modelList() });

  if (req.method === 'POST' && p === '/v1/videos') {
    const body = await jsonBody(req);
    const { presetKey, gpuAlias } = parseModel(body.model);
    if (!config.presets[presetKey]) return send(res, 400, { error: { message: '未知模型 ' + body.model } });
    const inp = body.input || {}; const prm = body.parameters || {};
    const params = { prompt: inp.prompt, media: inp.media || [], ratio: prm.ratio, duration: prm.duration, resolution: prm.resolution, megapixels: prm.megapixels };
    const dedupKey = dedupKeyFor(body.idempotencyKey || req.headers['idempotency-key'], body.model, params);
    const dup = findDuplicate(dedupKey);
    if (dup) { logEvent('info', `幂等命中：复用任务 ${dup.id}`); return send(res, 200, { id: dup.id, status: dup.status === 'succeeded' ? 'succeeded' : 'pending', object: 'video' }); }
    if (!submissionGuard(res)) return;
    const id = newId();
    const task = { id, status: 'pending', url: null, message: null, kind: config.presets[presetKey].capability, model: body.model, params, dedupKey, _session: true, createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, task);
    startTask(task, presetKey, gpuAlias, params);
    return send(res, 200, { id, status: 'pending', object: 'video' });
  }

  if (req.method === 'POST' && p === '/v1/images/generations') {
    const body = await jsonBody(req);
    const { presetKey, gpuAlias } = parseModel(body.model);
    const preset = config.presets[presetKey];
    if (!preset) return send(res, 400, { error: { message: '未知模型 ' + body.model } });
    const ratio = /^[0-9]+:[0-9]+$/.test(String(body.size || '')) ? body.size : (body.aspect_ratio || '16:9');
    const params = { prompt: body.prompt, ratio, megapixels: body.megapixels, resolution: body.resolution };
    const dedupKey = dedupKeyFor(body.idempotencyKey || req.headers['idempotency-key'], body.model, params);
    const dup = findDuplicate(dedupKey);
    if (dup) {
      if (dup.status === 'succeeded' && dup.url) { logEvent('info', `幂等命中(图片)：复用结果 ${dup.id}`); return send(res, 200, { created: Math.floor((dup.createdAt || Date.now()) / 1000), data: [{ url: dup.url }] }); }
      if (dup.status === 'running' || dup.status === 'pending') return send(res, 429, { error: { message: '相同请求正在生成，请稍候再试' } });
    }
    if (!submissionGuard(res)) return;
    const id = newId();
    const task = { id, status: 'running', url: null, message: null, kind: 'image', model: body.model, params, dedupKey, _session: true, createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, task);
    logEvent('info', `任务开始 ${id} image ${body.model}`);
    persistTasks();
    try {
      const r = await runTask(presetKey, gpuAlias, params, id);
      task.status = 'succeeded'; task.url = `${PUBLIC_BASE}/files/${r.file}`; task.updatedAt = Date.now();
      logEvent('info', `任务成功 ${id}`); persistTasks();
      return send(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: task.url }] });
    } catch (e) {
      task.status = 'failed'; task.message = String((e && e.message) || e); task.updatedAt = Date.now();
      logEvent('error', `任务失败 ${id}: ${task.message}`); persistTasks();
      return send(res, 500, { error: { message: task.message } });
    }
  }

  const vcancel = /^\/v1\/videos\/([^/]+)\/cancel$/.exec(p);
  if (req.method === 'POST' && vcancel) {
    const task = tasks.get(decodeURIComponent(vcancel[1]));
    if (!task) return send(res, 404, { error: { message: '任务不存在' } });
    task.cancelled = true;
    if (task.status === 'pending' || task.status === 'running') { task.status = 'cancelled'; task.message = '任务已取消'; task.updatedAt = Date.now(); }
    logEvent('info', `取消任务 ${task.id}`);
    persistTasks();
    try { const insts = await bridgeInstances(); for (const it of insts) { if (it.status === 2) { try { await chenyu.shutdown(it.instanceId); } catch {} } } } catch {}
    return send(res, 200, { ok: true, id: task.id, status: 'cancelled' });
  }
  const vm = /^\/v1\/videos\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && vm) {
    const task = tasks.get(decodeURIComponent(vm[1]));
    if (!task) return send(res, 200, { id: vm[1], status: 'failed', message: '任务不存在' });
    const st = task.status === 'cancelled' ? 'failed' : task.status;
    const msg = task.status === 'cancelled' ? '任务已取消' : (task.message || undefined);
    return send(res, 200, { id: task.id, status: st, video_url: task.url || undefined, message: msg });
  }
  if (req.method === 'DELETE' && vm) {
    const task = tasks.get(decodeURIComponent(vm[1]));
    if (!task) return send(res, 404, { error: { message: '任务不存在' } });
    task.cancelled = true;
    if (task.status === 'pending' || task.status === 'running') { task.status = 'cancelled'; task.message = '任务已取消'; task.updatedAt = Date.now(); }
    logEvent('info', `取消任务(DELETE) ${task.id}`);
    persistTasks();
    try { const insts = await bridgeInstances(); for (const it of insts) { if (it.status === 2) { try { await chenyu.shutdown(it.instanceId); } catch {} } } } catch {}
    return send(res, 200, { ok: true, id: task.id, status: 'cancelled' });
  }

  if (req.method === 'GET' && p.startsWith('/files/')) {
    const name = decodeURIComponent(p.slice('/files/'.length));
    const fp = path.join(config.dataDir, 'files', path.basename(name));
    if (!fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
    const ct = name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // ------- 管理接口 -------
  if (req.method === 'GET' && p === '/api/bridge/overview') {
    const [instances, account] = await Promise.all([bridgeInstances(), bridgeAccount()]);
    const list = Array.from(tasks.values());
    const taskStats = { total: list.length, running: 0, succeeded: 0, failed: 0 };
    for (const t of list) {
      if (t.status === 'running' || t.status === 'pending') taskStats.running += 1;
      else if (t.status === 'succeeded') taskStats.succeeded += 1;
      else if (t.status === 'failed') taskStats.failed += 1;
    }
    return send(res, 200, {
      version: PKG.version, publicBase: PUBLIC_BASE, port: config.port, apiBase: config.apiBase, node: process.version, uptimeSec: Math.round(process.uptime()),
      settings: currentSettings(), budgetHistory: budgetHistory(), taskStats,
      presets: Object.keys(config.presets), models: modelList().map((m) => m.id), instances, account, presetsDetail: config.presets,
    });
  }
  if (req.method === 'GET' && p === '/api/bridge/tasks') return send(res, 200, { tasks: Array.from(tasks.values()).reverse() });
  if (req.method === 'GET' && p === '/api/bridge/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write('event: tasks\ndata: ' + JSON.stringify({ tasks: tasksSnapshot() }) + '\n\n');
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }
  if (req.method === 'GET' && p === '/api/bridge/gpus') { try { return send(res, 200, (await chenyu.gpuList()) || {}); } catch (e) { return send(res, 502, { error: String((e && e.message) || e), gpu_list: [] }); } }
  if (req.method === 'GET' && p === '/api/bridge/logs') return send(res, 200, { logs: recentLogs(u.searchParams.get('limit') || 300) });
  if (req.method === 'POST' && p === '/api/bridge/logs/clear') { clearLogs(); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && p === '/api/bridge/logs/fileinfo') return send(res, 200, logFileInfo());
  if (req.method === 'GET' && p === '/api/bridge/logs/download') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="bridge.log"' });
    res.end(readLogFile() || '');
    return;
  }
  if (req.method === 'GET' && p === '/api/bridge/settings') return send(res, 200, { settings: currentSettings(), apiBase: config.apiBase, port: config.port, publicBase: PUBLIC_BASE });
  if (req.method === 'PUT' && p === '/api/bridge/settings') {
    try { const body = await jsonBody(req); return send(res, 200, { ok: true, settings: saveRuntimeSettings(body) }); }
    catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (req.method === 'GET' && p === '/api/bridge/models') {
    const list = listWorkflows().map((wf) => ({
      key: wf.key, capability: wf.capability, defaultGpu: wf.defaultGpu, workflowFile: wf.workflowFile, workflowExists: wf.workflowExists,
      outputNode: wf.outputNode, outputKind: wf.outputKind, enabled: wf.enabled, builtin: wf.builtin,
      gpus: Object.keys(GPU_ALIASES).map((g) => ({ alias: g, uuid: GPU_ALIASES[g], model: `${wf.key}@${g}` })),
    }));
    return send(res, 200, { presets: list });
  }
  if (req.method === 'GET' && p === '/api/bridge/workflows') return send(res, 200, { workflows: listWorkflows(), meta: presetsMeta() });
  const wfGet = /^\/api\/bridge\/workflows\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && wfGet) {
    const key = decodeURIComponent(wfGet[1]); const def = getWorkflow(key);
    if (!def) return send(res, 404, { error: '工作流不存在' });
    return send(res, 200, { key, workflow: { key, ...def, workflowExists: workflowExists(def.workflowFile) } });
  }
  if (req.method === 'PUT' && wfGet) {
    const key = decodeURIComponent(wfGet[1]);
    try { const body = await jsonBody(req); const def = upsertWorkflow(key, body); logEvent('info', `更新工作流 ${key}`); return send(res, 200, { ok: true, workflow: def }); }
    catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }
  if (req.method === 'DELETE' && wfGet) {
    const key = decodeURIComponent(wfGet[1]);
    try { deleteWorkflow(key); logEvent('info', `删除工作流 ${key}`); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }
  if (req.method === 'POST' && p === '/api/bridge/workflows') {
    try { const body = await jsonBody(req); if (!body.key) return send(res, 400, { ok: false, error: '缺少 key' }); const def = upsertWorkflow(body.key, body); logEvent('info', `新增工作流 ${body.key}`); return send(res, 200, { ok: true, workflow: def }); }
    catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }
  if (req.method === 'GET' && p === '/api/bridge/pods') {
    try {
      const d = await chenyu.podList({ page: 1, size: 100 });
      const list = (d && (d.pod_list || d.list || d.items)) || (Array.isArray(d) ? d : []);
      const pods = list.map((x) => ({ uuid: x.uuid || x.pod_uuid || '', title: x.title || x.name || '', remark: x.remark || '', tags: x.pod_tag || x.tags || [], price: x.price || null }));
      return send(res, 200, { pods });
    } catch (e) { return send(res, 502, { error: String((e && e.message) || e), pods: [] }); }
  }
  if (req.method === 'POST' && p === '/api/bridge/workflows/analyze') {
    try { const body = await jsonBody(req); return send(res, 200, { ok: true, analysis: analyzeWorkflow(body.content) }); }
    catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }
  const wfUpload = /^\/api\/bridge\/workflows\/([^/]+)\/upload$/.exec(p);
  if (req.method === 'POST' && wfUpload) {
    const key = decodeURIComponent(wfUpload[1]);
    try {
      const body = await jsonBody(req);
      const r = saveWorkflowFile(key, body.filename, body.content);
      let analysis = null; try { analysis = analyzeWorkflow(body.content); } catch {}
      logEvent('info', `上传工作流文件 ${r.filename} -> ${key}`);
      return send(res, 200, { ok: true, ...r, analysis });
    } catch (e) { return send(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }
  const wfFile = /^\/api\/bridge\/workflows\/([^/]+)\/file$/.exec(p);
  if (req.method === 'GET' && wfFile) {
    const key = decodeURIComponent(wfFile[1]); const def = getWorkflow(key);
    if (!def) return send(res, 404, { error: '工作流不存在' });
    const content = readWorkflowFile(def.workflowFile);
    if (content == null) return send(res, 404, { error: '工作流文件不存在' });
    return send(res, 200, { filename: def.workflowFile, content });
  }
  if (req.method === 'GET' && p === '/api/bridge/system') {
    const files = dirUsage(path.join(config.dataDir, 'files'));
    return send(res, 200, {
      version: PKG.version, node: process.version, platform: process.platform, arch: process.arch,
      uptimeSec: Math.round(process.uptime()), memory: process.memoryUsage(),
      dataDir: config.dataDir, filesCount: files.files, filesBytes: files.bytes,
      apiKeyConfigured: !!config.apiKey, adminTokenSet: !!currentAdminToken(), businessAuthEnabled: !!currentBridgeApiKey(),
      queue: { pending: queuedCount(), maxQueue: MAX_QUEUE, ratePerMin: RATE_PER_MIN },
      publicBase: PUBLIC_BASE, port: config.port, apiBase: config.apiBase,
      presets: Object.keys(config.presets),
    });
  }
  const instInfo = /^\/api\/bridge\/instances\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && instInfo) {
    const id = decodeURIComponent(instInfo[1]);
    try {
      const info = await chenyu.info(id);
      const url = (info && ((info.server_map || []).find((s) => s.port_type === 'http' && /webui|comfy/i.test(s.title || '')) || (info.server_map || []).find((s) => s.port_type === 'http') || {}).url) || (info && (info.server_url || [])[0]) || '';
      return send(res, 200, { id, status: info && info.status, gpuName: info && info.gpu_name, title: info && info.title, url, raw: { server_map: info && info.server_map } });
    } catch (e) { return send(res, 502, { error: String((e && e.message) || e) }); }
  }
  if (req.method === 'POST' && p === '/api/bridge/instances/shutdown-all') {
    const insts = await bridgeInstances();
    const out = [];
    for (const it of insts) {
      try { if (it.status === 2) { await chenyu.shutdown(it.instanceId); out.push({ id: it.instanceId, ok: true }); } }
      catch (e) { out.push({ id: it.instanceId, ok: false, error: String((e && e.message) || e) }); }
    }
    logEvent('info', `全部关机：${out.filter((x) => x.ok).length} 个`);
    return send(res, 200, { ok: true, results: out });
  }
  const instMatch = /^\/api\/bridge\/instances\/([^/]+)\/(startup|shutdown)$/.exec(p);
  if (req.method === 'POST' && instMatch) {
    const id = decodeURIComponent(instMatch[1]);
    try {
      const result = instMatch[2] === 'startup' ? await chenyu.startup(id) : await chenyu.shutdown(id);
      logEvent('info', `实例${instMatch[2] === 'startup' ? '开机' : '关机'} ${id}`);
      return send(res, 200, { ok: true, result: result ?? null });
    } catch (e) {
      logEvent('error', `实例${instMatch[2] === 'startup' ? '开机' : '关机'}失败 ${id}: ${(e && e.message) || e}`);
      return send(res, 502, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (req.method === 'POST' && p === '/api/bridge/prewarm') {
    try {
      const body = await jsonBody(req);
      const model = String(body.model || '').trim();
      if (!model) return send(res, 400, { ok: false, error: '缺少 model' });
      const { presetKey, gpuAlias } = parseModel(model);
      if (!config.presets[presetKey]) return send(res, 400, { ok: false, error: '未知模型 ' + model });
      logEvent('info', `预热实例 ${model}`);
      const r = await warmInstance(presetKey, gpuAlias);
      logEvent('info', `预热完成 ${model} status=${r.status}`);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      logEvent('error', `预热失败：${(e && e.message) || e}`);
      return send(res, 502, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (req.method === 'POST' && p === '/api/bridge/test') {
    const body = await jsonBody(req);
    const model = String(body.model || '').trim();
    if (!model) return send(res, 400, { ok: false, error: '缺少 model' });
    const { presetKey, gpuAlias } = parseModel(model);
    const preset = config.presets[presetKey];
    if (!preset) return send(res, 400, { ok: false, error: '未知模型 ' + model });
    if (!String(body.prompt || '').trim()) return send(res, 400, { ok: false, error: '缺少 prompt' });
    const params = {
      prompt: String(body.prompt),
      ratio: body.ratio || '16:9',
      duration: body.duration != null ? Number(body.duration) : preset.capability === 'video' ? 12 : undefined,
      megapixels: body.megapixels != null ? Number(body.megapixels) : undefined,
      resolution: body.resolution,
      media: [],
    };
    const id = newId();
    const task = { id, status: 'pending', url: null, message: null, kind: preset.capability, model, params, source: 'admin-test', _session: true, createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, task);
    startTask(task, presetKey, gpuAlias, params);
    return send(res, 200, { ok: true, id });
  }
  const retryMatch = /^\/api\/bridge\/tasks\/([^/]+)\/retry$/.exec(p);
  if (req.method === 'POST' && retryMatch) {
    const old = tasks.get(decodeURIComponent(retryMatch[1]));
    if (!old) return send(res, 404, { ok: false, error: '任务不存在' });
    if (old.status === 'running' || old.status === 'pending') return send(res, 409, { ok: false, error: '任务仍在进行中' });
    if (!old.model || !old.params) return send(res, 400, { ok: false, error: '该任务缺少原始参数，无法重试（旧数据）' });
    const { presetKey, gpuAlias } = parseModel(old.model);
    if (!config.presets[presetKey]) return send(res, 400, { ok: false, error: '模型已不存在' });
    const id = newId();
    const task = { id, status: 'pending', url: null, message: null, kind: old.kind, model: old.model, params: old.params, source: 'retry', _session: true, createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, task);
    startTask(task, presetKey, gpuAlias, old.params);
    return send(res, 200, { ok: true, id });
  }
  if (req.method === 'POST' && p === '/api/bridge/tasks/clear') {
    let removed = 0;
    for (const [id, t] of Array.from(tasks.entries())) { if (t.status !== 'running' && t.status !== 'pending') { tasks.delete(id); removed += 1; } }
    persistTasks();
    logEvent('info', `清理任务记录 ${removed} 条`);
    return send(res, 200, { ok: true, removed });
  }
  if (req.method === 'POST' && p === '/api/bridge/prune') {
    const n = pruneOldFiles(7);
    logEvent('info', `清理过期产物 ${n} 个`);
    return send(res, 200, { ok: true, removed: n });
  }

  return send(res, 404, { error: 'not found', path: p });
}

export function createBridgeServer() {
  hydrateTasks();
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { error: { message: String((e && e.message) || e) } }); } catch {} });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBridgeServer();
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  server.listen(config.port, host, () => {
    console.log(`chenyu-bridge listening on ${host}:${config.port}  public=${PUBLIC_BASE}`);
    if (!config.apiKey) console.warn('⚠️  CHENYU_API_KEY 未设置，向晨羽的请求会失败');
    try { const n = pruneOldFiles(7); if (n) console.log(`已清理过期产物 ${n} 个`); } catch {}
    armIdleForKnownInstances().catch(() => {});
  });
}
