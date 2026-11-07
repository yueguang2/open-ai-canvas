#!/usr/bin/env node
// 列出晨羽 GPU / Pod，供管理员在 config.mjs 里配置 preset 时选用。
// 用法：
//   CHENYU_API_KEY=sk-xxx node devices.mjs gpu
//   CHENYU_API_KEY=sk-xxx node devices.mjs pod [关键词]
import { chenyu } from './lib.mjs';
import { config } from './config.mjs';

const key = process.env.CHENYU_API_KEY || config.apiKey;
if (!key) { console.error('需要 CHENYU_API_KEY 环境变量'); process.exit(1); }

const cmd = process.argv[2] || 'gpu';
if (cmd === 'gpu') {
  const d = await chenyu.gpuList();
  console.log('GPU 列表：gpu_uuid | 名称 | 元/小时 | 状态');
  for (const g of d.gpu_list || []) console.log(`${g.gpu_uuid} | ${g.gpu_name} | ${g.price && g.price.hour} | ${g.status}`);
} else if (cmd === 'pod') {
  const kw = process.argv[3] || '';
  console.log(`Pod 列表${kw ? '（关键词：' + kw + '）' : ''}：uuid | 标题 | 版本 | 元/小时`);
  let page = 1, shown = 0;
  for (; page <= 20; page++) {
    const d = await chenyu.podList({ page, size: 10, keyword: kw });
    const list = d.pod_list || [];
    if (!list.length) break;
    for (const p of list) { console.log(`${p.uuid} | ${p.title} | ${(p.pod_tag || []).join(',')} | ${p.price && p.price.hour}`); shown++; }
    if (kw && shown >= 10) break; // 关键词命中前 10 条即可
    if (!kw && page >= 3) break;  // 无关键词只展示前 30 条，避免刷屏
  }
  console.log(`共展示 ${shown} 条（晨羽 total 通常上千，建议加关键词缩小范围）`);
} else {
  console.error('用法: node devices.mjs gpu | node devices.mjs pod [关键词]');
  process.exit(1);
}
