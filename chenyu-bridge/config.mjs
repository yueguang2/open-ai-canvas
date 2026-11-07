// 晨羽 Bridge 配置。API Key 只从环境变量读取，不落仓库。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// GPU 型号别名 -> 晨羽 gpu_uuid（来自 /gpu/list）
export const GPU_ALIASES = {
  '4080': 'c873233d835647ea8d985f370792a85a',
  '4090d': '32ceabe6c96e44bdb1e4d80358a3b8ae',
  '5090': 'a7f3d92e4c5b4a7e9b8c6f1e2d3a4b5c',
  ngpu48: 'd92a57488465f63af5eaab49b403952f',
  ngpu32: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9',
};

// ResolutionSelector 合法档位
export const ASPECT_LABELS = {
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
};

// 一个 preset = 一个镜像/工作流；model 名形如 "<preset>@<gpuAlias>"，如 "h3@4080"
export const config = {
  port: Number(process.env.BRIDGE_PORT || 3400),
  apiBase: 'https://www.chenyu.cn/api/open/v2',
  apiKey: process.env.CHENYU_API_KEY || '',
  idleMinutes: Number(process.env.BRIDGE_IDLE_MINUTES || 10),
  // 现金余额阈值：低于它就不开机（晨羽 Pod 开机服务费扣现金余额）
  minBalance: Number(process.env.BRIDGE_MIN_BALANCE || 0),
  dataDir: path.join(__dirname, 'data'),
  workflowsDir: path.join(__dirname, 'workflows'),
  presets: {
    h3: {
      capability: 'video',
      pod: { uuid: '1166fbd2cbe44b7f9c58dc5dfa834e7c', tag: 'V1.0.0' },
      defaultGpu: '4080',
      workflowFile: 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.api.json',
      outputNode: '364',
      outputKind: 'video',
      mapping: {
        prompt: { node: '263', input: 'text' },
        duration: { node: '259', input: 'value', min: 5, max: 15 },
        seed: { node: '397', input: 'seed' },
        aspect: { node: '252', input: 'aspect_ratio' },
        megapixels: { node: '252', input: 'megapixels', default: 1.5 },
        imageSlots: [
          { role: 'first_frame', node: '50' },
          { role: 'reference_image', node: '49' },
        ],
      },
    },
    moss: {
      capability: 'image',
      pod: { uuid: '1166fbd2cbe44b7f9c58dc5dfa834e7c', tag: 'V1.0.0' },
      defaultGpu: '4080',
      workflowFile: 'YZ金鱼-MOSS-文生图.api.json',
      outputNode: '49',
      outputKind: 'image',
      mapping: {
        prompt: { node: '88', input: 'value' },
        seed: { node: '13', input: 'seed' },
        aspect: { node: '8', input: 'aspect_ratio' },
        megapixels: { node: '8', input: 'megapixels', default: 3 },
        imageSlots: [],
      },
    },
  },
};
