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

  // ---- 状态面板 ----
  if (req.method === 'GET' && (p === '/' || p === '/dashboard')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }
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

function dashboardHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>晨羽 Bridge 状态</title>
<style>
:root{--bg:#0f1116;--card:#181b22;--line:#262b36;--mut:#8b93a7;--fg:#e6e9f0;--ok:#2ecc71;--warn:#f5a623;--bad:#e74c3c;--accent:#5b8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}header .dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px rgba(46,204,113,.15)}
main{padding:18px 22px;display:grid;gap:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--mut);font-size:12px}.card .v{font-size:22px;font-weight:600;margin-top:6px}
section h2{font-size:13px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
th{color:var(--mut);font-weight:500;background:#1c2029}tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px}
.p-run{background:rgba(46,204,113,.15);color:var(--ok)}.p-stop{background:rgba(139,147,167,.15);color:var(--mut)}
.p-run2{background:rgba(245,166,35,.15);color:var(--warn)}.p-bad{background:rgba(231,76,60,.15);color:var(--bad)}
.p-ok{background:rgba(91,140,255,.15);color:var(--accent)}
a{color:var(--accent);text-decoration:none}code{color:#cfd6e6}
.muted{color:var(--mut)}
</style></head><body>
<header><span class="dot"></span><h1>晨羽 Bridge 状态</h1>
<span class="muted" id="ts" style="margin-left:auto;font-size:12px"></span></header>
<main>
  <div class="cards">
    <div class="card"><div class="k">现金余额 (¥)</div><div class="v" id="balance">--</div></div>
    <div class="card"><div class="k">算力卡余额 (¥)</div><div class="v" id="card">--</div></div>
    <div class="card"><div class="k">今日花费 / 预算 (¥)</div><div class="v" id="spend">--</div></div>
    <div class="card"><div class="k">实例数</div><div class="v" id="instcount">--</div></div>
  </div>
  <section><h2>实例状态（保留实例、平时关机）</h2>
    <table><thead><tr><th>实例</th><th>GPU</th><th>状态</th><th>instance_uuid</th></tr></thead><tbody id="inst"></tbody></table>
  </section>
  <section><h2>可用模型（model = preset@gpu，@后即设备）</h2>
    <table><thead><tr><th>model</th></tr></thead><tbody id="models"></tbody></table>
  </section>
  <section><h2>最近任务</h2>
    <table><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>阶段/信息</th><th>产物</th></tr></thead><tbody id="tasks"></tbody></table>
  </section>
</main>
<script>
var SM={0:'已创建',1:'开机中',2:'运行中',3:'关机中',4:'已关机',21:'关机中',22:'已关机',23:'已关机(异常)',24:'开机中',27:'重启中'};
function cls(s){if(s===2)return 'p-run';if(s===1||s===24||s===27||s===21||s===3)return 'p-run2';if(s==='error')return 'p-bad';return 'p-stop';}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function tcls(s){if(s==='succeeded')return 'p-run';if(s==='failed')return 'p-bad';if(s==='running')return 'p-run2';return 'p-stop';}
async function tick(){
  try{
    var o=await (await fetch('/api/bridge/overview')).json();
    document.getElementById('balance').textContent=(o.account.balance==null?'--':Number(o.account.balance).toFixed(3));
    document.getElementById('card').textContent=(o.account.card==null?'--':Number(o.account.card).toFixed(2));
    var db=Number(o.account.dailyBudgetCny)>0?(' / '+Number(o.account.dailyBudgetCny).toFixed(2)):' / 不限';
    document.getElementById('spend').textContent=Number(o.account.spendToday).toFixed(3)+db;
    document.getElementById('instcount').textContent=o.instances.length;
    document.getElementById('inst').innerHTML=o.instances.length?o.instances.map(function(i){
      return '<tr><td>'+esc(i.key)+'</td><td>'+esc(i.gpuName)+'</td><td><span class="pill '+cls(i.status)+'">'+esc(SM[i.status]||i.status)+'</span></td><td><code>'+esc(i.instanceId)+'</code></td></tr>';
    }).join(''):'<tr><td colspan="4" class="muted">还没有实例（首次生成时按所选用 GPU 创建）</td></tr>';
    document.getElementById('models').innerHTML=o.models.map(function(m){return '<tr><td><code>'+esc(m)+'</code></td></tr>';}).join('');
  }catch(e){document.getElementById('ts').textContent='连接失败: '+e.message;}
  try{
    var t=await (await fetch('/api/bridge/tasks')).json();
    document.getElementById('tasks').innerHTML=t.tasks.length?t.tasks.map(function(x){
      var link=x.url?'<a href="'+esc(x.url)+'" target="_blank">打开</a>':'';
      var stage=x.status==='failed'?('<span style="color:#e74c3c">'+esc(x.message||'')+'</span>'):esc(x.message||'');
      return '<tr><td><code>'+esc(x.id)+'</code></td><td>'+esc(x.kind)+'</td><td><span class="pill '+tcls(x.status)+'">'+esc(x.status)+'</span></td><td>'+stage+'</td><td>'+link+'</td></tr>';
    }).join(''):'<tr><td colspan="5" class="muted">暂无任务</td></tr>';
  }catch(e){}
  document.getElementById('ts').textContent='更新于 '+new Date().toLocaleTimeString();
}
tick();setInterval(tick,3000);
</script></body></html>`;
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
