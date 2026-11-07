#!/usr/bin/env node
/**
 * Configure the local Magpie gateway as an OpenAI-compatible model channel.
 *
 * Usage:
 *   node scripts/configure-local-magpie.mjs
 *
 * Env (all optional, sensible local defaults):
 *   CANVAS_BACKEND   default http://127.0.0.1:8080
 *   MAGPIE_GATEWAY   default http://127.0.0.1:3425/v1
 *   ADMIN_USER       default admin
 *   ADMIN_PASS       default Admin123456
 *
 * It is idempotent: existing "本机 Magpie" channel and existing logical models
 * are reused instead of duplicated.
 */
const BACKEND = (process.env.CANVAS_BACKEND || 'http://127.0.0.1:8080').replace(/\/$/, '');
const MAGPIE = (process.env.MAGPIE_GATEWAY || 'http://127.0.0.1:3425/v1').replace(/\/$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin123456';
const CHANNEL_NAME = '本机 Magpie';

const TEXT_CAP = {
  version: 1,
  text: {
    streaming: true,
    contextWindowTokens: 1000000,
    maxOutputTokens: 16384,
    references: { promptMaxChars: 200000, maxImages: 4, maxImageBytes: 10485760, maxVideos: 0, maxVideoBytes: 0 },
  },
};

let cookie = '';

function captureCookie(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    const pair = c.split(';')[0];
    if (pair.startsWith('open_ai_canvas_session=')) cookie = pair;
  }
}

async function api(method, path, body) {
  const res = await fetch(BACKEND + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  captureCookie(res);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function loginOrRegister() {
  let r = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (r.status === 200 && r.json.code === 0) return 'login';
  r = await api('POST', '/api/auth/register', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
    acceptedTerms: true,
    displayName: '管理员',
  });
  if (r.status === 200 && r.json.code === 0) return 'register';
  if (r.json && r.json.code === 200) return 'register';
  throw new Error('登录/注册失败：' + JSON.stringify(r.json).slice(0, 300));
}

async function magpieModels() {
  const res = await fetch(`${MAGPIE}/models`);
  if (!res.ok) throw new Error(`Magpie /models HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

async function ensureChannel(models) {
  const list = await api('GET', '/api/admin/channels?pageSize=100');
  const existing = (list.json.data?.channels || []).find((c) => c.name === CHANNEL_NAME);
  if (existing) return existing;
  const created = await api('POST', '/api/admin/channels', {
    name: CHANNEL_NAME,
    baseUrl: MAGPIE,
    apiKey: 'magpie-local',
    models,
    enabled: true,
  });
  if (created.json.code !== 0) throw new Error('创建渠道失败：' + JSON.stringify(created.json).slice(0, 300));
  return created.json.data.channel;
}

async function main() {
  const how = await loginOrRegister();
  console.log(`admin: ${how} (${ADMIN_USER})`);
  const models = await magpieModels();
  console.log(`magpie models: ${models.length}`);
  const channel = await ensureChannel(models);
  console.log(`channel: ${channel.id} ${channel.name}`);

  // channel models (create or patch with text capability)
  const cm = await api('GET', `/api/admin/channels/${channel.id}/models?pageSize=200`);
  const byKey = new Map((cm.json.data?.models || []).map((m) => [m.modelKey, m]));
  const channelModelId = new Map();
  for (const key of models) {
    const existing = byKey.get(key);
    const body = {
      modelKey: key,
      providerModelKey: key,
      displayName: key,
      capability: 'text',
      protocol: 'chat-completion',
      billingMode: 'fixed_request',
      enabled: true,
      priceConfigured: true,
      capabilityConfig: TEXT_CAP,
    };
    if (existing) {
      await api('PATCH', `/api/admin/channels/${channel.id}/models/${existing.id}`, body);
      channelModelId.set(key, existing.id);
    } else {
      const r = await api('POST', `/api/admin/channels/${channel.id}/models`, body);
      if (r.json.code === 0) channelModelId.set(key, r.json.data.model.id);
    }
  }
  console.log(`channel models ready: ${channelModelId.size}`);

  // logical models (one per channel model)
  const lm = await api('GET', '/api/admin/logical-models?pageSize=200');
  const lcodes = new Set((lm.json.data?.models || []).map((m) => m.code));
  let created = 0;
  for (const [key, cmid] of channelModelId) {
    const code = 'm-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (lcodes.has(code)) continue;
    const r = await api('POST', '/api/admin/logical-models', {
      code,
      name: key,
      capability: 'text',
      enabled: true,
      sortOrder: 0,
      pricePolicy: 'channel',
      billingMode: 'fixed_request',
      unitPriceMicrocredits: 0,
      capabilitySpec: { version: 1, capability: 'text' },
      defaultOptions: {},
      routes: [{ channelModelId: cmid, enabled: true, priority: 1, weight: 1 }],
    });
    if (r.json.code === 0) created += 1;
  }
  console.log(`logical models created: ${created}`);

  const pub = await api('GET', '/api/models');
  console.log(`public models now: ${pub.json.data?.models?.length ?? 0}`);
  console.log('done. 打开 http://localhost:3000 ，用 ' + ADMIN_USER + ' 登录即可选择本机 Magpie 模型。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
