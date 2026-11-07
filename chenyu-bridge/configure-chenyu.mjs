#!/usr/bin/env node
// 幂等地把「晨羽桥接」渠道 + 所有 GPU × (H3视频/MOSS文生图) 模型 + 逻辑模型写入影策，
// 并把画幅/画质/时长等能力参数与 ComfyUI 工作流对齐。
// 用法： node configure-chenyu.mjs
import { config, GPU_ALIASES, QUALITY_TIERS } from './config.mjs';

const BACKEND = (process.env.CANVAS_BACKEND || 'http://127.0.0.1:8080').replace(/\/$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin123456';
const CHANNEL_NAME = '晨羽桥接';
const CHANNEL_BASE = process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:3400';

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
const LABEL = { h3: 'H3 视频', moss: 'MOSS 文生图' };

let cookie = '';
function cap(res) { const s = res.headers.getSetCookie ? res.headers.getSetCookie() : []; for (const c of s) { const p = c.split(';')[0]; if (p.startsWith('open_ai_canvas_session=')) cookie = p; } }
async function api(method, path, body) {
  const res = await fetch(BACKEND + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  cap(res);
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: res.status, json: j };
}

function videoCap() {
  return { version: 1, video: {
    references: { promptMaxChars: 8000, minImages: 0, maxImages: 3, maxImageBytes: 10485760, maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0, maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0 },
    duration: { selection: 'range', min: 1, max: 30, step: 1, default: 12 }, durationSupported: true,
    ratios: RATIOS, defaultRatio: '16:9',
    resolutions: QUALITY_TIERS, defaultResolution: '1.5MP',
    generateAudio: { supported: false, default: false }, watermark: { supported: false, default: false },
    operations: ['text_to_video', 'reference_to_video'], defaultOperation: 'text_to_video',
  } };
}
function imageCap() {
  return { version: 1, image: {
    parameters: [
      { name: 'size', label: '画幅', type: 'string', binding: 'aspectRatio', encoding: 'pixels', values: RATIOS, default: '16:9', pricing: true },
      { name: 'imageResolution', label: '画质', type: 'string', binding: 'resolution', values: QUALITY_TIERS, default: '3.0MP', pricing: true },
      { name: 'count', label: '生成数量', type: 'integer', binding: 'imageCount', min: 1, max: 1, step: 1, default: 1 },
      { name: 'quality', label: '图片质量', type: 'string', binding: 'quality', enabled: false },
    ],
    references: { promptMaxChars: 8000, maxImages: 0, maxImageBytes: 0, maskSupported: false },
    size: { parameter: 'size', values: RATIOS, default: '16:9', allowCustom: false },
    resolution: { supported: true, values: QUALITY_TIERS, default: '3.0MP' },
    quality: { supported: false, values: [], default: '' },
    transparentBackground: { supported: false, default: false },
    responseFormat: { supported: false, default: '' }, outputFormat: { supported: false, default: '' }, maxOutputs: 1,
  } };
}

async function loginOrRegister() {
  let r = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (r.status === 200 && r.json.code === 0) return 'login';
  r = await api('POST', '/api/auth/register', { username: ADMIN_USER, password: ADMIN_PASS, acceptedTerms: true, displayName: '管理员' });
  if (r.json.code === 0) return 'register';
  throw new Error('登录/注册失败：' + JSON.stringify(r.json).slice(0, 300));
}

async function ensureChannel() {
  const list = await api('GET', '/api/admin/channels?pageSize=100');
  const ex = (list.json.data?.channels || []).find((c) => c.name === CHANNEL_NAME);
  if (ex) return ex;
  const c = await api('POST', '/api/admin/channels', { name: CHANNEL_NAME, baseUrl: CHANNEL_BASE, apiKey: '', models: [], enabled: true });
  if (c.json.code !== 0) throw new Error('创建渠道失败：' + JSON.stringify(c.json).slice(0, 300));
  return c.json.data.channel;
}

async function main() {
  console.log('admin:', await loginOrRegister());
  const ch = await ensureChannel();
  console.log('channel:', ch.id, ch.name);

  const cm = await api('GET', `/api/admin/channels/${ch.id}/models?pageSize=200`);
  const existing = new Map((cm.json.data?.models || []).map((m) => [m.modelKey, m.id]));

  const modelIdByKey = new Map();
  for (const presetKey of Object.keys(config.presets)) {
    const preset = config.presets[presetKey];
    const isVideo = preset.capability === 'video';
    const bodyBase = {
      capability: preset.capability,
      protocol: isVideo ? 'newapi-channel-1' : 'openai-image',
      billingMode: 'fixed_request', enabled: true, priceConfigured: true,
      capabilityConfig: isVideo ? videoCap() : imageCap(),
    };
    for (const gpu of Object.keys(GPU_ALIASES)) {
      const key = `${presetKey}@${gpu}`;
      const body = { ...bodyBase, modelKey: key, providerModelKey: key, displayName: `${LABEL[presetKey] || presetKey}（${gpu.toUpperCase()}）` };
      let id = existing.get(key);
      if (id) { const r = await api('PATCH', `/api/admin/channels/${ch.id}/models/${id}`, body); if (r.json.code !== 0) console.log('PATCH fail', key, r.json.msg); }
      else { const r = await api('POST', `/api/admin/channels/${ch.id}/models`, body); if (r.json.code === 0) id = r.json.data.model.id; else console.log('CREATE fail', key, r.json.msg); }
      if (id) modelIdByKey.set(key, id);
    }
  }
  console.log('channel models ready:', modelIdByKey.size);

  const lm = await api('GET', '/api/admin/logical-models?pageSize=300');
  const codes = new Set((lm.json.data?.models || []).map((m) => m.code));
  let created = 0;
  for (const presetKey of Object.keys(config.presets)) {
    const preset = config.presets[presetKey];
    const isVideo = preset.capability === 'video';
    for (const gpu of Object.keys(GPU_ALIASES)) {
      const key = `${presetKey}@${gpu}`;
      const cmid = modelIdByKey.get(key);
      if (!cmid) continue;
      const code = `chenyu-${presetKey}-${gpu}`;
      if (codes.has(code)) continue;
      const spec = isVideo ? { version: 1, capability: 'video', operations: ['text_to_video', 'reference_to_video'] } : { version: 1, capability: 'image' };
      const r = await api('POST', '/api/admin/logical-models', {
        code, name: `${LABEL[presetKey] || presetKey}（${gpu.toUpperCase()}）`, capability: preset.capability,
        enabled: true, sortOrder: 0, pricePolicy: 'channel', billingMode: 'fixed_request', unitPriceMicrocredits: 0,
        capabilitySpec: spec, defaultOptions: {}, routes: [{ channelModelId: cmid, enabled: true, priority: 1, weight: 1 }],
      });
      if (r.json.code === 0) created++; else console.log('LM create fail', code, r.json.msg);
    }
  }
  console.log('logical models created:', created);

  const pub = await api('GET', '/api/models');
  const v = (pub.json.data?.models || []).filter((m) => m.capability === 'video').length;
  const i = (pub.json.data?.models || []).filter((m) => m.capability === 'image').length;
  console.log(`public models: video=${v} image=${i}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
