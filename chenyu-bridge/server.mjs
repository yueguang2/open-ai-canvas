// 晨羽 Bridge HTTP 服务。
// 兼容影策 "newapi-media-task-v1" 异步视频协议：
//   POST /v1/videos            { model, input:{prompt,media[]}, parameters:{ratio,duration,...} }
//   GET  /v1/videos/{id}       → { id, status, video_url, message }
// 另提供：GET /v1/models、GET /files/:name、GET /healthz。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.mjs';
import { runTask, parseModel, chenyu, bridgeInstances, bridgeAccount } from './lib.mjs';

const PUBLIC_BASE = (process.env.BRIDGE_PUBLIC_BASE || `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
const tasks = new Map(); // id -> { id, status, url, message, kind, createdAt }

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

function modelList() {
  const out = [];
  for (const [k, p] of Object.entries(config.presets)) {
    for (const gpu of ['4080', '4090d', '5090', 'ngpu48', 'ngpu32']) out.push({ id: `${k}@${gpu}`, object: 'model', capability: p.capability });
  }
  return out;
}

function startTask(task, presetKey, gpuAlias, params) {
  task.status = 'running';
  runTask(presetKey, gpuAlias, params, task.id, (s) => { task.message = s; })
    .then((r) => { task.status = 'succeeded'; task.kind = r.kind; task.url = `${PUBLIC_BASE}/files/${r.file}`; task.message = null; })
    .catch((e) => { task.status = 'failed'; task.message = String(e && e.message || e); });
}

async function handle(req, res) {
  const u = new URL(req.url, PUBLIC_BASE);
  const p = u.pathname;

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, presets: Object.keys(config.presets) });
  if (req.method === 'GET' && p === '/v1/models') return send(res, 200, { object: 'list', data: modelList() });

  // 状态数据接口（供排障，无独立页面）
  if (req.method === 'GET' && p === '/api/bridge/overview') {
    const [instances, account] = await Promise.all([bridgeInstances(), bridgeAccount()]);
    return send(res, 200, { presets: Object.keys(config.presets), models: modelList().map((m) => m.id), instances, account, presetsDetail: config.presets });
  }
  if (req.method === 'GET' && p === '/api/bridge/tasks') {
    return send(res, 200, { tasks: Array.from(tasks.values()).reverse() });
  }

  if (req.method === 'POST' && p === '/v1/videos') {
    const body = JSON.parse(await readBody(req) || '{}');
    const { presetKey, gpuAlias } = parseModel(body.model);
    if (!config.presets[presetKey]) return send(res, 400, { error: { message: '未知模型 ' + body.model } });
    const inp = body.input || {};
    const prm = body.parameters || {};
    const params = {
      prompt: inp.prompt,
      media: inp.media || [],
      ratio: prm.ratio,
      duration: prm.duration,
      resolution: prm.resolution,
      megapixels: prm.megapixels,
    };
    const id = newId();
    const task = { id, status: 'pending', url: null, message: null, kind: config.presets[presetKey].capability, createdAt: Date.now() };
    tasks.set(id, task);
    startTask(task, presetKey, gpuAlias, params);
    return send(res, 200, { id, status: 'pending', object: 'video' });
  }

  if (req.method === 'POST' && p === '/v1/images/generations') {
    const body = JSON.parse(await readBody(req) || '{}');
    const { presetKey, gpuAlias } = parseModel(body.model);
    const preset = config.presets[presetKey];
    if (!preset) return send(res, 400, { error: { message: '未知模型 ' + body.model } });
    const ratio = /^[0-9]+:[0-9]+$/.test(String(body.size || '')) ? body.size : (body.aspect_ratio || '16:9');
    const params = { prompt: body.prompt, ratio, megapixels: body.megapixels, resolution: body.resolution };
    const id = newId();
    try {
      const r = await runTask(presetKey, gpuAlias, params, id);
      return send(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: `${PUBLIC_BASE}/files/${r.file}` }] });
    } catch (e) {
      return send(res, 500, { error: { message: String(e && e.message || e) } });
    }
  }

  const vm = /^\/v1\/videos\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && vm) {
    const task = tasks.get(decodeURIComponent(vm[1]));
    if (!task) return send(res, 200, { id: vm[1], status: 'failed', message: '任务不存在' });
    return send(res, 200, { id: task.id, status: task.status, video_url: task.url || undefined, message: task.message || undefined });
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

  return send(res, 404, { error: 'not found', path: p });
}

export function createBridgeServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { error: { message: String(e && e.message || e) } }); } catch {} });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBridgeServer();
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`chenyu-bridge listening on 127.0.0.1:${config.port}  public=${PUBLIC_BASE}`);
    if (!config.apiKey) console.warn('⚠️  CHENYU_API_KEY 未设置，向晨羽的请求会失败');
  });
}
