// 工作流预设管理：内置预设来自 config.mjs，可在后台覆盖/新增/删除，持久化到 data/presets.json。
// 上传的工作流文件写到 data/workflows/，与内置 workflows/ 一起被加载（data 优先）。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const ORIGINAL = JSON.parse(JSON.stringify(config.presets));
const ORIGINAL_KEYS = new Set(Object.keys(ORIGINAL));
const storePath = () => path.join(config.dataDir, 'presets.json');
const dataWorkflowsDir = () => path.join(config.dataDir, 'workflows');

let store = { overrides: {}, removed: [] };

function fileExists(file) {
  if (!file) return false;
  try {
    return [path.join(config.dataDir, 'workflows', file), path.join(config.workflowsDir, file)].some((p) => fs.existsSync(p));
  } catch { return false; }
}

function apply() {
  const base = JSON.parse(JSON.stringify(ORIGINAL));
  for (const k of store.removed) delete base[k];
  for (const [k, v] of Object.entries(store.overrides)) base[k] = v;
  for (const k of Object.keys(config.presets)) delete config.presets[k];
  Object.assign(config.presets, base);
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
  } catch {}
}

export function loadPresets() {
  try {
    const d = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    store = { overrides: d.overrides || {}, removed: Array.isArray(d.removed) ? d.removed : [] };
  } catch { store = { overrides: {}, removed: [] }; }
  apply();
}

function normalizeDef(def) {
  const out = JSON.parse(JSON.stringify(def || {}));
  out.capability = out.capability === 'video' ? 'video' : 'image';
  out.pod = out.pod && typeof out.pod === 'object' ? out.pod : { uuid: '', tag: '' };
  out.pod.uuid = String(out.pod.uuid || '');
  out.pod.tag = String(out.pod.tag || '');
  out.defaultGpu = String(out.defaultGpu || '4080');
  out.workflowFile = String(out.workflowFile || '');
  out.outputNode = String(out.outputNode || '');
  out.outputKind = out.outputKind === 'video' ? 'video' : 'image';
  out.mapping = out.mapping && typeof out.mapping === 'object' ? out.mapping : {};
  out.enabled = out.enabled !== false;
  return out;
}

export function listWorkflows() {
  return Object.entries(config.presets).map(([key, p]) => ({
    key,
    capability: p.capability,
    pod: p.pod,
    defaultGpu: p.defaultGpu,
    workflowFile: p.workflowFile,
    outputNode: p.outputNode,
    outputKind: p.outputKind,
    mapping: p.mapping,
    enabled: p.enabled !== false,
    builtin: ORIGINAL_KEYS.has(key) && !store.overrides[key],
    overridden: !!store.overrides[key],
    workflowExists: fileExists(p.workflowFile),
    models: Object.keys(config.presets).length ? undefined : undefined,
  }));
}

export function getWorkflow(key) { return config.presets[key] || null; }

export function upsertWorkflow(key, def) {
  const k = String(key || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(k)) throw new Error('key 只能是字母/数字/下划线/短横线，长度 1-40');
  const norm = normalizeDef(def);
  if (!norm.pod.uuid) throw new Error('Pod UUID 不能为空');
  if (!norm.outputNode) throw new Error('输出节点不能为空');
  if (!norm.workflowFile) throw new Error('工作流文件不能为空（请先上传或填写文件名）');
  if (!fileExists(norm.workflowFile)) throw new Error('工作流文件不存在：' + norm.workflowFile + '（请先上传）');
  store.overrides[k] = norm;
  store.removed = store.removed.filter((x) => x !== k);
  apply(); save();
  return norm;
}

export function deleteWorkflow(key) {
  const k = String(key || '').trim();
  if (!config.presets[k]) throw new Error('工作流不存在');
  delete store.overrides[k];
  if (ORIGINAL_KEYS.has(k)) { if (!store.removed.includes(k)) store.removed.push(k); }
  apply(); save();
}

export function saveWorkflowFile(key, filename, content) {
  const k = String(key || '').trim();
  const def = config.presets[k];
  if (!def && !/^[a-zA-Z0-9_-]{1,40}$/.test(k)) throw new Error('工作流 key 无效');
  const name = path.basename(String(filename || '').trim());
  if (!name) throw new Error('缺少文件名');
  let parsed;
  try { parsed = JSON.parse(String(content)); } catch (e) { throw new Error('工作流不是合法 JSON：' + (e && e.message)); }
  if (!parsed || typeof parsed !== 'object') throw new Error('工作流 JSON 必须是对象');
  fs.mkdirSync(dataWorkflowsDir(), { recursive: true });
  fs.writeFileSync(path.join(dataWorkflowsDir(), name), JSON.stringify(parsed, null, 2));
  if (def) { const next = JSON.parse(JSON.stringify(def)); next.workflowFile = name; store.overrides[k] = normalizeDef(next); store.removed = store.removed.filter((x) => x !== k); apply(); save(); }
  return { filename: name, bytes: Buffer.byteLength(JSON.stringify(parsed)) };
}

export function readWorkflowFile(filename) {
  const name = path.basename(String(filename || '').trim());
  const candidates = [path.join(config.dataDir, 'workflows', name), path.join(config.workflowsDir, name)];
  for (const p of candidates) { try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch {} }
  return null;
}

export function presetsMeta() {
  return { builtinKeys: Array.from(ORIGINAL_KEYS), overriddenKeys: Object.keys(store.overrides), removedKeys: store.removed.slice() };
}
