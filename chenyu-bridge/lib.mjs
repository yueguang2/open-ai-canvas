// 晨羽 API + ComfyUI 客户端 + 实例编排。
import fs from 'node:fs';
import path from 'node:path';
import { config, GPU_ALIASES, ASPECT_LABELS } from './config.mjs';

const UA = 'curl/8.5.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 状态持久化 ----------------
function statePath() { return path.join(config.dataDir, 'state.json'); }
let state = (() => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } })();
function saveState() { try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch {} }

// ---------------- 晨羽 API ----------------
async function cyCall(method, p, body) {
  const res = await fetch(config.apiBase + p, {
    method,
    headers: { authorization: 'Bearer ' + config.apiKey, 'content-type': 'application/json', 'user-agent': UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ code: -1, msg: 'bad json' }));
  if (j.code !== 0) { const e = new Error(`晨羽 ${p} code=${j.code} ${j.msg || ''}`); e.chenyuCode = j.code; throw e; }
  return j.data;
}
export const chenyu = {
  gpuList: () => cyCall('GET', '/gpu/list'),
  podList: (o = {}) => cyCall('GET', `/pod/list?page=${o.page || 1}&page_size=${o.size || 10}${o.keyword ? '&keyword=' + encodeURIComponent(o.keyword) : ''}`),
  info: (id) => cyCall('GET', '/instance/info?instance_uuid=' + encodeURIComponent(id)),
  balanceInfo: () => cyCall('GET', '/balance/info'),
  createByPod: (podUuid, podTag, gpuUuid, gpuNums) => cyCall('POST', '/instance/create_by_pod', { pod_uuid: podUuid, pod_tag: podTag, gpu_uuid: gpuUuid, gpu_nums: gpuNums }),
  startup: (id) => cyCall('POST', '/instance/startup', { instance_uuid: id }),
  shutdown: (id) => cyCall('POST', '/instance/shutdown', { instance_uuid: id }),
};

// ---------------- 实例编排 ----------------
const STOPPED = new Set([0, 4, 22, 23]);
const STARTING = new Set([1, 24, 27]);
const statusOf = (info) => (info ? Number(info.status) : -1);

function comfyBase(info) {
  const map = info.server_map || [];
  const webui = map.find((s) => s.port_type === 'http' && /webui|comfy/i.test(s.title || ''));
  const anyHttp = map.find((s) => s.port_type === 'http');
  const u = (webui && webui.url) || (anyHttp && anyHttp.url) || (info.server_url || [])[0];
  if (!u) throw new Error('实例没有可用的 http 地址（server_map 为空）');
  return String(u).replace(/\/$/, '');
}

async function pollInstance(id, timeoutMs = 300000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const info = await chenyu.info(id);
    if (statusOf(info) === 2) return info;
    await sleep(6000);
  }
  throw new Error('实例开机超时');
}

async function ensureBalance() {
  let b;
  try { b = await chenyu.balanceInfo(); } catch (e) { return; } // 查询失败不阻塞，但日志
  const cash = Number(b && b.balance);
  if (isFinite(cash) && cash <= config.minBalance) {
    throw new Error(`晨羽现金余额不足（当前 ¥${cash}，阈值 ¥${config.minBalance}）：Pod 开机服务费需现金余额，请充值后再生成`);
  }
}

// ---------------- 预算保护 ----------------
let gpuPriceCache = { at: 0, map: {} };
async function gpuHourPrice(gpuUuid) {
  const now = Date.now();
  if (now - gpuPriceCache.at > 5 * 60000) {
    try {
      const d = await chenyu.gpuList();
      const map = {};
      for (const g of d.gpu_list || []) map[g.gpu_uuid] = Number((g.price && g.price.hour) || 0);
      gpuPriceCache = { at: now, map };
    } catch {}
  }
  const p = gpuPriceCache.map[gpuUuid];
  return isFinite(p) && p > 0 ? p : config.priceFallbackCny;
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function ensureBudget(pricePerHour) {
  if (!(config.dailyBudgetCny > 0)) return;
  const spent = Number((state.budget && state.budget[todayKey()]) || 0);
  const est = pricePerHour * (config.maxRunMinutes / 60);
  if (spent + est > config.dailyBudgetCny) {
    throw new Error(`今日预算不足：已花 ¥${spent.toFixed(3)}，本次预计 ≥¥${est.toFixed(3)}，上限 ¥${config.dailyBudgetCny}`);
  }
}
function recordSpend(pricePerHour, elapsedMs) {
  const amount = pricePerHour * (Math.max(0, elapsedMs) / 3600000);
  if (!(amount > 0)) return;
  if (!state.budget) state.budget = {};
  const k = todayKey();
  state.budget[k] = Number(state.budget[k] || 0) + amount;
  saveState();
}

async function instanceFor(presetKey, gpuAlias) {
  const preset = config.presets[presetKey];
  const gpuUuid = GPU_ALIASES[gpuAlias] || GPU_ALIASES[preset.defaultGpu];
  if (!gpuUuid) throw new Error('未知 GPU 型号: ' + gpuAlias);
  const key = preset.pod.uuid + '@' + gpuUuid;
  let id = state[key];
  if (id) {
    const info = await chenyu.info(id).catch(() => null);
    if (info) {
      if (statusOf(info) === 2) return { id, info };
      await ensureBalance();
      if (STOPPED.has(statusOf(info)) || statusOf(info) === 0) await chenyu.startup(id);
      return { id, info: await pollInstance(id) };
    }
  }
  await ensureBalance();
  const created = await chenyu.createByPod(preset.pod.uuid, preset.pod.tag, gpuUuid, 1);
  id = created.instance_uuid;
  state[key] = id; saveState();
  return { id, info: await pollInstance(id) };
}

// ---------------- ComfyUI ----------------
function ch(extra) { return { 'user-agent': UA, accept: '*/*', ...extra }; }

export async function comfyWaitReady(base, timeoutMs = 300000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try { const r = await fetch(base + '/object_info', { headers: ch() }); if (r.ok) { await r.arrayBuffer(); return true; } } catch {}
    await sleep(3000);
  }
  throw new Error('ComfyUI 未就绪（object_info 超时）');
}

export async function comfyUpload(base, buf, filename, mime) {
  const form = new FormData();
  form.append('image', new Blob([buf], { type: mime || 'image/png' }), filename || 'image.png');
  form.append('overwrite', 'true');
  const r = await fetch(base + '/upload/image', { method: 'POST', headers: ch(), body: form });
  if (!r.ok) throw new Error('ComfyUI 上传失败 ' + r.status);
  return await r.json();
}

export async function comfyQueue(base, prompt) {
  const r = await fetch(base + '/prompt', { method: 'POST', headers: ch({ 'content-type': 'application/json' }), body: JSON.stringify({ prompt, client_id: 'bridge-' + Date.now() }) });
  const j = await r.json();
  if (j.node_errors && Object.keys(j.node_errors).length) throw new Error('ComfyUI 校验失败: ' + JSON.stringify(j.node_errors).slice(0, 400));
  if (!j.prompt_id) throw new Error('ComfyUI 未返回 prompt_id');
  return j.prompt_id;
}

export async function comfyWaitHistory(base, promptId, timeoutMs = 1200000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const r = await fetch(base + '/history/' + encodeURIComponent(promptId), { headers: ch() });
    if (r.ok) {
      const j = await r.json();
      if (j[promptId]) {
        const h = j[promptId];
        if (h.status && h.status.status_str === 'error') throw new Error('ComfyUI 执行失败: ' + JSON.stringify(h.status.messages || h.status).slice(0, 400));
        return h;
      }
    }
    await sleep(3000);
  }
  throw new Error('生成超时');
}

export async function comfyView(base, file) {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
  const r = await fetch(base + '/view?' + q.toString(), { headers: ch() });
  if (!r.ok) throw new Error('ComfyUI 取文件失败 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------- 工作流填充 ----------------
function setIn(wf, node, input, val) {
  if (!wf[node] || !wf[node].inputs) throw new Error('工作流缺少节点 ' + node);
  wf[node].inputs[input] = val;
}
function clampDuration(v, min, max) { const n = Number(v); if (!isFinite(n) || n <= 0) return null; return Math.min(max, Math.max(min, Math.round(n))); }

export function fillWorkflow(wf, mapping, params, imageNames = {}) {
  const g = structuredClone(wf);
  if (mapping.prompt && params.prompt != null) setIn(g, mapping.prompt.node, mapping.prompt.input, String(params.prompt));
  if (mapping.duration && params.duration != null) {
    const d = clampDuration(params.duration, mapping.duration.min || 1, mapping.duration.max || 60);
    if (d != null) setIn(g, mapping.duration.node, mapping.duration.input, d);
  }
  if (mapping.seed && params.seed != null) setIn(g, mapping.seed.node, mapping.seed.input, Number(params.seed));
  if (mapping.aspect && params.ratio) setIn(g, mapping.aspect.node, mapping.aspect.input, ASPECT_LABELS[params.ratio] || params.ratio);
  if (mapping.megapixels) {
    const mp = params.megapixels != null ? Number(params.megapixels) : mapping.megapixels.default;
    if (mp) setIn(g, mapping.megapixels.node, mapping.megapixels.input, mp);
  }
  for (const slot of mapping.imageSlots || []) {
    const name = imageNames[slot.role];
    if (name) setIn(g, slot.node, 'image', name);
  }
  return g;
}

function loadWorkflow(file) { return JSON.parse(fs.readFileSync(path.join(config.workflowsDir, file), 'utf8')); }

function extractOutput(hist, node, kind) {
  const nodeOut = (hist.outputs || {})[node] || {};
  for (const v of Object.values(nodeOut)) {
    if (Array.isArray(v)) for (const it of v) if (it && it.filename) return it;
  }
  // 兜底：任意含 filename 的输出
  for (const n of Object.values(hist.outputs || {})) for (const v of Object.values(n)) {
    if (Array.isArray(v)) for (const it of v) if (it && it.filename) return it;
  }
  return null;
}

async function fetchMediaBytes(url) {
  if (!url) return null;
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  }
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('拉取参考素材失败 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------- 串行 + 空闲关机 ----------------
const chains = new Map();
function withLock(key, fn) { const prev = chains.get(key) || Promise.resolve(); const next = prev.then(fn, fn); chains.set(key, next.catch(() => {})); return next; }
const idleTimers = new Map();
function cancelIdle(key) { const t = idleTimers.get(key); if (t) { clearTimeout(t); idleTimers.delete(key); } }
function scheduleIdle(key) { cancelIdle(key); const t = setTimeout(async () => { idleTimers.delete(key); try { const id = state[key]; if (id) await chenyu.shutdown(id); } catch {} }, config.idleMinutes * 60000); if (t.unref) t.unref(); idleTimers.set(key, t); }

export function parseModel(model) {
  const s = String(model || '').trim();
  const i = s.indexOf('@');
  if (i < 0) return { presetKey: s, gpuAlias: config.presets[s]?.defaultGpu };
  return { presetKey: s.slice(0, i), gpuAlias: s.slice(i + 1) };
}

// 统一入口：跑一次生成，返回 { file, kind }（文件写在 dataDir/files 下）
export async function runTask(presetKey, gpuAlias, params, taskId, onStage = () => {}) {
  const preset = config.presets[presetKey];
  if (!preset) throw new Error('未知 preset: ' + presetKey);
  const gpuUuid = GPU_ALIASES[gpuAlias] || GPU_ALIASES[preset.defaultGpu];
  const key = preset.pod.uuid + '@' + gpuUuid;
  return withLock(key, async () => {
    cancelIdle(key);
    const startedAt = Date.now();
    let pricePerHour = config.priceFallbackCny;
    try {
      pricePerHour = await gpuHourPrice(gpuUuid);
      ensureBudget(pricePerHour);
      onStage('准备实例（未运行则开机）');
      const { info } = await instanceFor(presetKey, gpuAlias);
      const base = comfyBase(info);
      onStage('等待 ComfyUI 就绪');
      await comfyWaitReady(base);
      const imageNames = {};
      for (const m of params.media || []) {
        const buf = await fetchMediaBytes(m.url);
        if (!buf) continue;
        const up = await comfyUpload(base, buf, (m.type || 'image') + '-' + taskId + '.png', m.mime || 'image/png');
        const fname = up.subfolder ? up.subfolder + '/' + up.name : up.name;
        const role = m.type || 'reference_image';
        const slot = (preset.mapping.imageSlots || []).find((s) => s.role === role && !imageNames[s.role]);
        if (slot) imageNames[slot.role] = fname;
        else if (!imageNames['reference_image']) imageNames['reference_image'] = fname;
      }
      const wf = fillWorkflow(loadWorkflow(preset.workflowFile), preset.mapping, params, imageNames);
      onStage('生成中');
      const promptId = await comfyQueue(base, wf);
      const hist = await comfyWaitHistory(base, promptId);
      onStage('下载产物');
      const out = extractOutput(hist, preset.outputNode, preset.outputKind);
      if (!out) throw new Error('工作流没有产出文件');
      const buf = await comfyView(base, out);
      const ext = preset.outputKind === 'video' ? '.mp4' : (path.extname(out.filename) || '.png');
      const fname = taskId + ext;
      const dir = path.join(config.dataDir, 'files');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fname), buf);
      return { file: fname, kind: preset.outputKind };
    } finally {
      scheduleIdle(key);
      recordSpend(pricePerHour, Date.now() - startedAt);
    }
  });
}
