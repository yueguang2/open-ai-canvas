// 运行时配置与日志：支持后台在线修改（持久化到 data/settings.json），以及内存日志缓冲。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const settingsPath = () => path.join(config.dataDir, 'settings.json');
let adminTokenOverride = null;
let chenyuApiKeyOverride = null;
const envApiKey = (process.env.CHENYU_API_KEY || '').trim();

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function clampBool(v, def) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return def;
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  if (s.idleMinutes != null) config.idleMinutes = clampNum(s.idleMinutes, 0, 240, config.idleMinutes);
  if (s.dailyBudgetCny != null) config.dailyBudgetCny = clampNum(s.dailyBudgetCny, 0, 1e6, config.dailyBudgetCny);
  if (s.minBalance != null) config.minBalance = clampNum(s.minBalance, 0, 1e6, config.minBalance);
  if (s.maxRunMinutes != null) config.maxRunMinutes = clampNum(s.maxRunMinutes, 1, 600, config.maxRunMinutes);
  if (s.priceFallbackCny != null) config.priceFallbackCny = clampNum(s.priceFallbackCny, 0, 1e4, config.priceFallbackCny);
  config.budgetEnabled = clampBool(s.budgetEnabled, config.budgetEnabled !== false);
  if (s.adminToken !== undefined) {
    const t = String(s.adminToken == null ? '' : s.adminToken).trim();
    adminTokenOverride = t ? t.slice(0, 200) : null;
  }
  if (s.chenyuApiKey !== undefined) {
    const t = String(s.chenyuApiKey == null ? '' : s.chenyuApiKey).trim();
    chenyuApiKeyOverride = t || null;
    config.apiKey = chenyuApiKeyOverride || envApiKey;
  }
}

export function loadRuntimeSettings() {
  try { applySettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); } catch {}
}

export function currentSettings() {
  return {
    idleMinutes: config.idleMinutes,
    dailyBudgetCny: config.dailyBudgetCny,
    minBalance: config.minBalance,
    maxRunMinutes: config.maxRunMinutes,
    priceFallbackCny: config.priceFallbackCny,
    budgetEnabled: config.budgetEnabled !== false,
    hasAdminToken: !!(adminTokenOverride || (process.env.BRIDGE_ADMIN_TOKEN || '').trim()),
    hasChenyuApiKey: !!config.apiKey,
  };
}

export function saveRuntimeSettings(patch) {
  const cur = currentSettings();
  const next = {
    idleMinutes: clampNum(patch.idleMinutes != null ? patch.idleMinutes : cur.idleMinutes, 0, 240, cur.idleMinutes),
    dailyBudgetCny: clampNum(patch.dailyBudgetCny != null ? patch.dailyBudgetCny : cur.dailyBudgetCny, 0, 1e6, cur.dailyBudgetCny),
    minBalance: clampNum(patch.minBalance != null ? patch.minBalance : cur.minBalance, 0, 1e6, cur.minBalance),
    maxRunMinutes: clampNum(patch.maxRunMinutes != null ? patch.maxRunMinutes : cur.maxRunMinutes, 1, 600, cur.maxRunMinutes),
    priceFallbackCny: clampNum(patch.priceFallbackCny != null ? patch.priceFallbackCny : cur.priceFallbackCny, 0, 1e4, cur.priceFallbackCny),
    budgetEnabled: clampBool(patch.budgetEnabled != null ? patch.budgetEnabled : cur.budgetEnabled, cur.budgetEnabled),
  };
  if (patch.adminToken !== undefined) next.adminToken = String(patch.adminToken == null ? '' : patch.adminToken).trim().slice(0, 200);
  // 晨羽 API Key：'—' 或 '-' 表示清除；空串表示不变；有值则覆盖。
  if (patch.chenyuApiKey !== undefined) {
    const t = String(patch.chenyuApiKey == null ? '' : patch.chenyuApiKey).trim();
    if (t === '-' || t === '—') next.chenyuApiKey = '';
    else if (t) next.chenyuApiKey = t;
    else if (chenyuApiKeyOverride) next.chenyuApiKey = chenyuApiKeyOverride;
  } else if (chenyuApiKeyOverride) {
    next.chenyuApiKey = chenyuApiKeyOverride;
  }
  applySettings(next);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
    try { fs.chmodSync(settingsPath(), 0o600); } catch {}
  } catch {}
  logEvent('info', `配置已更新 idle=${next.idleMinutes}min 日预算=${next.dailyBudgetCny}(${next.budgetEnabled ? '开' : '关'}) 最低余额=${next.minBalance} 最长运行=${next.maxRunMinutes}min`);
  return currentSettings();
}

// 当前生效的管理口令：后台设置优先，其次环境变量。
export function currentAdminToken() {
  const t = adminTokenOverride != null ? adminTokenOverride : (process.env.BRIDGE_ADMIN_TOKEN || '').trim();
  return t || '';
}

// ---------------- 内存日志 ----------------
const LOGS = [];
const LOG_MAX = 800;
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function pushLog(level, args) {
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || safeJson(a))).join(' ').slice(0, 1200);
    LOGS.push({ t: Date.now(), level, msg });
    if (LOGS.length > LOG_MAX) LOGS.shift();
  } catch {}
}
export function logEvent(level, msg) { pushLog(level, [msg]); }

let installed = false;
export function installLogCapture() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); pushLog(level, args); };
  }
}

export function recentLogs(limit = 200) {
  const n = Math.max(1, Math.min(LOG_MAX, Number(limit) || 200));
  return LOGS.slice(-n);
}
export function clearLogs() { LOGS.length = 0; }
