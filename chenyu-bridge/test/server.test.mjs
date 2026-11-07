// 桥接 HTTP 接口的集成测试（模拟影策调用），不需要 GPU。
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../config.mjs';
import { createBridgeServer } from '../server.mjs';

async function startUpstream() {
  let base = '';
  function route(res, p, bodyText) {
    const reply = (obj, code = 200, raw) => { res.writeHead(code, { 'content-type': raw ? 'application/octet-stream' : 'application/json' }); res.end(raw || JSON.stringify(obj)); };
    if (p === '/gpu/list') return reply({ code: 0, data: { gpu_list: [], total: 0 } });
    if (p === '/balance/info') return reply({ code: 0, data: { balance: 10, card_balance: 0 } });
    if (p === '/pod/list') return reply({ code: 0, data: { pod_list: [], total: 0 } });
    if (p === '/instance/create_by_pod') return reply({ code: 0, data: { instance_uuid: 'instS', status: 1 } });
    if (p === '/instance/info') return reply({ code: 0, data: { instance_uuid: 'instS', status: 2, server_map: [{ title: 'WebUI', url: base, port_type: 'http' }], server_url: [base] } });
    if (p === '/instance/startup' || p === '/instance/shutdown') return reply({ code: 0, data: {} });
    if (p === '/object_info') return reply({}, 200);
    if (p === '/upload/image') return reply({ name: 'u.png', subfolder: '', type: 'input' });
    if (p === '/prompt') return reply({ prompt_id: 'p1', number: 1, node_errors: {} });
    if (p === '/history/p1') return reply({ p1: { status: { status_str: 'success' }, outputs: { '364': { gifs: [{ filename: 'o.mp4', subfolder: '', type: 'output' }] }, '49': { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } } } });
    if (p === '/view') return reply(null, 200, Buffer.from('VIDEO_BYTES'));
    return reply({ error: 'unknown ' + p }, 404);
  }
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => route(res, u.pathname, Buffer.concat(c).toString('utf8'))); return; }
    route(res, u.pathname, '');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${s.address().port}`; r(); }));
  return { server: s, base };
}

function listen(s) { return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('POST /v1/videos → 轮询成功 → 取到文件', async () => {
  const up = await startUpstream();
  config.apiBase = up.base; config.apiKey = 'test'; config.minBalance = 0; config.idleMinutes = 999;
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-srv-'));
  const bridge = createBridgeServer();
  const port = await listen(bridge);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'h3@4080', input: { prompt: '海边的猫' }, parameters: { ratio: '16:9', duration: 6 } }) });
    const { id } = await r.json();
    assert.ok(id);
    let st = null;
    for (let i = 0; i < 20; i++) { const j = await (await fetch(`http://127.0.0.1:${port}/v1/videos/${id}`)).json(); st = j; if (j.status === 'succeeded' || j.status === 'failed') break; await sleep(300); }
    assert.equal(st.status, 'succeeded', JSON.stringify(st));
    const fname = st.video_url.split('/files/')[1];
    const fr = await fetch(`http://127.0.0.1:${port}/files/${fname}`);
    assert.equal(await fr.text(), 'VIDEO_BYTES');
  } finally { bridge.close(); up.server.close(); }
});

test('POST /v1/images/generations → 返回 data[].url', async () => {
  const up = await startUpstream();
  config.apiBase = up.base; config.apiKey = 'test'; config.minBalance = 0; config.idleMinutes = 999;
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-srv-img-'));
  const bridge = createBridgeServer();
  const port = await listen(bridge);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'moss@4080', prompt: '一只猫', size: '16:9' }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(j.data && j.data[0] && j.data[0].url, JSON.stringify(j));
  } finally { bridge.close(); up.server.close(); }
});

test('状态数据接口 overview 返回余额', async () => {
  const up = await startUpstream();
  config.apiBase = up.base; config.apiKey = 'test'; config.minBalance = 0; config.idleMinutes = 999;
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-srv-dash-'));
  const bridge = createBridgeServer();
  const port = await listen(bridge);
  try {
    const ov = await (await fetch(`http://127.0.0.1:${port}/api/bridge/overview`)).json();
    assert.equal(ov.account.balance, 10);
    assert.ok(Array.isArray(ov.models) && ov.models.includes('h3@4080'));
  } finally { bridge.close(); up.server.close(); }
});
