// 用 mock 的 晨羽+ComfyUI HTTP 服务验证编排（不需要真实 GPU）。
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../config.mjs';
import { runTask, fillWorkflow } from '../lib.mjs';

async function startMock(opts = {}) {
  let infoCalls = 0;
  let createCalls = 0;
  let capturedPrompt = null;
  let base = '';

  function route(res, p, bodyText) {
    const reply = (obj, code = 200, raw) => {
      res.writeHead(code, { 'content-type': raw ? 'application/octet-stream' : 'application/json' });
      res.end(raw || JSON.stringify(obj));
    };
    if (p === '/gpu/list') return reply({ code: 0, data: { gpu_list: [{ gpu_uuid: 'c873233d835647ea8d985f370792a85a', gpu_name: 'RTX 4080', price: { hour: 2.18 } }], total: 1 } });
    if (p === '/balance/info') return reply({ code: 0, data: { balance: opts.balance ?? 10, card_balance: 0 } });
    if (p === '/pod/list') return reply({ code: 0, data: { pod_list: [], total: 0 } });
    if (p === '/instance/create_by_pod') { createCalls += 1; return reply({ code: 0, data: { instance_uuid: 'inst1', status: 1 } }); }
    if (p === '/instance/info') {
      infoCalls += 1;
      const status = infoCalls < 2 ? 1 : 2;
      return reply({ code: 0, data: { instance_uuid: 'inst1', status, server_map: [{ title: 'WebUI', url: base, port_type: 'http' }], server_url: [base] } });
    }
    if (p === '/instance/startup' || p === '/instance/shutdown') return reply({ code: 0, data: {} });
    if (p === '/object_info') return reply({}, 200);
    if (p === '/upload/image') return reply({ name: 'uploaded.png', subfolder: '', type: 'input' });
    if (p === '/prompt') { try { capturedPrompt = JSON.parse(bodyText).prompt; } catch {} return reply({ prompt_id: 'p1', number: 1, node_errors: {} }); }
    if (p === '/history/p1') return reply({ p1: { status: { status_str: 'success' }, outputs: { '364': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] }, '49': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    if (p === '/view') return reply(null, 200, Buffer.from('VIDEO_BYTES'));
    return reply({ error: 'unknown ' + p }, 404);
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => route(res, u.pathname, Buffer.concat(chunks).toString('utf8')));
      return;
    }
    route(res, u.pathname, '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  return { server, getBase: () => base, getPrompt: () => capturedPrompt, getCreateCalls: () => createCalls };
}

test('fillWorkflow 映射 prompt/时长/画幅/参考图槽位', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(config.workflowsDir, 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.api.json'), 'utf8'));
  const out = fillWorkflow(wf, config.presets.h3.mapping, { prompt: '一只猫', duration: 8, ratio: '16:9', seed: 42 }, ['a.png', 'b.png', 'c.png']);
  assert.equal(out['263'].inputs.text, '一只猫');
  assert.equal(out['259'].inputs.value, 8);
  assert.equal(out['252'].inputs.aspect_ratio, '16:9 (Widescreen)');
  assert.equal(out['397'].inputs.seed, 42);
  // 参考图按顺序进 ref_image_0/1/2 (节点 51/49/50)
  assert.equal(out['51'].inputs.image, 'a.png');
  assert.equal(out['49'].inputs.image, 'b.png');
  assert.equal(out['50'].inputs.image, 'c.png');
});

test('runTask 端到端（mock）', async () => {
  const mock = await startMock();
  config.apiBase = mock.getBase();
  config.apiKey = 'test';
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-bridge-'));
  config.idleMinutes = 999;
  try {
    const r = await runTask('h3', '4080', { prompt: '海边的猫', media: [], ratio: '16:9', duration: 6 }, 'task_1');
    assert.equal(r.kind, 'video');
    assert.equal(r.file, 'task_1.mp4');
    const fp = path.join(config.dataDir, 'files', r.file);
    assert.ok(fs.existsSync(fp));
    assert.equal(fs.readFileSync(fp, 'utf8'), 'VIDEO_BYTES');
    const pr = mock.getPrompt();
    assert.equal(pr['263'].inputs.text, '海边的猫');
    assert.equal(pr['259'].inputs.value, 6);
  } finally {
    mock.server.close();
  }
});

test('余额不足时拦截开机（不创建实例）', async () => {
  const mock = await startMock({ balance: -0.5 });
  config.apiBase = mock.getBase();
  config.apiKey = 'test';
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-bridge-low-'));
  config.minBalance = 0;
  config.idleMinutes = 999;
  try {
    await assert.rejects(
      () => runTask('h3', '5090', { prompt: 'x', media: [], ratio: '16:9', duration: 5 }, 'task_low'),
      /余额不足/,
    );
    assert.equal(mock.getCreateCalls(), 0, '余额不足不应创建实例');
  } finally {
    mock.server.close();
  }
});

test('runTask 图片(MOSS) 端到端（mock）', async () => {
  const mock = await startMock();
  config.apiBase = mock.getBase();
  config.apiKey = 'test';
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-bridge-img-'));
  config.minBalance = 0;
  config.idleMinutes = 999;
  try {
    const r = await runTask('moss', '4080', { prompt: '一只猫', ratio: '16:9' }, 'img_1');
    assert.equal(r.kind, 'image');
    assert.equal(r.file, 'img_1.png');
    assert.ok(fs.existsSync(path.join(config.dataDir, 'files', r.file)));
    const pr = mock.getPrompt();
    assert.equal(pr['88'].inputs.value, '一只猫');
  } finally {
    mock.server.close();
  }
});

test('超出每日预算时拦截（不创建实例）', async () => {
  const mock = await startMock();
  config.apiBase = mock.getBase();
  config.apiKey = 'test';
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-bridge-budget-'));
  config.minBalance = 0;
  config.idleMinutes = 999;
  config.dailyBudgetCny = 0.001;
  config.maxRunMinutes = 15;
  config.priceFallbackCny = 2.18;
  try {
    await assert.rejects(() => runTask('h3', 'ngpu48', { prompt: 'x', ratio: '16:9', duration: 5 }, 'task_budget'), /预算/);
    assert.equal(mock.getCreateCalls(), 0, '预算不足不应创建实例');
  } finally {
    mock.server.close();
    config.dailyBudgetCny = 0;
  }
});

test('fillWorkflow 提交时动态接 9图/3视频/3音频 槽位', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(config.workflowsDir, 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.api.json'), 'utf8'));
  const images = ['i0.png', 'i1.png', 'i2.png', 'i3.png', 'i4.png'];
  const videos = ['v0.mp4', 'v1.mp4'];
  const audios = ['a0.wav'];
  const out = fillWorkflow(wf, config.presets.h3.mapping, { prompt: 'x' }, { images, videos, audios });
  for (let i = 0; i < 5; i++) {
    const link = out['265'].inputs['ref_images.ref_image_' + i];
    assert.ok(link, 'img slot ' + i);
    assert.equal(out[link[0]].inputs.image, images[i]);
  }
  assert.equal(out['265'].inputs['ref_images.ref_image_5'], undefined);
  for (let i = 0; i < 2; i++) {
    const link = out['265'].inputs['ref_videos.ref_video_' + i];
    assert.ok(link, 'vid slot ' + i);
    assert.equal(out[link[0]].class_type, 'VHS_LoadVideo');
    assert.equal(out[link[0]].inputs.video, videos[i]);
  }
  const al = out['265'].inputs['ref_audios.ref_audio_0'];
  assert.ok(al, 'audio slot 0');
  assert.equal(out[al[0]].class_type, 'LoadAudio');
  assert.equal(out[al[0]].inputs.audio, audios[0]);
});

test('fillWorkflow 少于3张图时移除未用默认图节点', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(config.workflowsDir, 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.api.json'), 'utf8'));
  const out = fillWorkflow(wf, config.presets.h3.mapping, { prompt: 'x' }, { images: ['only.png'] });
  assert.equal(out['265'].inputs['ref_images.ref_image_0'][0], '51');
  assert.equal(out['51'].inputs.image, 'only.png');
  assert.equal(out['265'].inputs['ref_images.ref_image_1'], undefined);
  assert.equal(out['49'], undefined);
  assert.equal(out['50'], undefined);
});
