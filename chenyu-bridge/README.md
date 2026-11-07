# 晨羽 Bridge（本地桥接服务）

把「晨羽智云 Pod 实例 + ComfyUI 工作流」包成一个本地 HTTP 服务，影策用现成的
`newapi-media-task-v1`（异步视频）协议把本服务当渠道接入，**不改影策核心**。

## 流程

点生成 → 桥接服务 `ensure instance`（无则 `create_by_pod`，关机则 `startup`）→ 等
实例 `status=2` 且 ComfyUI `object_info` 就绪 → 上传参考图（`/upload/image`）→
用 API 格式工作流填参（prompt/时长/画幅/seed/首帧）→ `POST /prompt` →
轮询 `/history/{id}` → `GET /view` 下载产物 → 空闲 N 分钟自动 `shutdown`。

## 接口（对齐 newapi-media-task-v1）

- `POST /v1/videos` `{ model:"h3@4080", input:{prompt,media:[{type,url}]}, parameters:{ratio,duration,...} }` → `{ id, status:"pending" }`
- `GET /v1/videos/{id}` → `{ id, status, video_url }`（status: pending/running/succeeded/failed）
- `GET /v1/models`、`GET /files/{name}`、`GET /healthz`

`model` = `<preset>@<gpu>`，preset 见 `config.mjs`（`h3` 视频、`moss` 图片），gpu 别名
`4080/4090d/5090/ngpu48/ngpu32` → 即「界面选设备」。

## 运行

```bash
cd chenyu-bridge
CHENYU_API_KEY=sk-xxx BRIDGE_PORT=3400 node server.mjs
# 或
CHENYU_API_KEY=sk-xxx node server.mjs
```

环境变量：`CHENYU_API_KEY`（必填）、`BRIDGE_PORT`(默认3400)、`BRIDGE_PUBLIC_BASE`、
`BRIDGE_IDLE_MINUTES`(默认10)。

> API Key 只从环境变量读取，不写入仓库。

## 在影策里挂成渠道

后台新建系统渠道：baseUrl=`http://127.0.0.1:3400`，协议选 `newapi-media-task-v1`，
模型 key 填 `h3@4080` 等，能力=视频。（后端需 `CANVAS_ALLOW_PRIVATE_UPSTREAMS=true`
且放行 `127.0.0.1`，本机已配置。）

## 测试

```bash
cd chenyu-bridge && node --test   # 纯 mock，不需要 GPU
```

## 已在影策创建（本机实测）

- 渠道：`晨羽桥接`（CHANNEL_000002，baseUrl `http://127.0.0.1:3400`）
- 视频模型：`h3@4080` → 逻辑模型 `chenyu-h3-4080`「晨羽 H3 视频（4080）」，协议 `newapi-channel-1`
- 图片模型：`moss@4080` → 逻辑模型 `chenyu-moss-4080`「晨羽 MOSS 文生图（4080）」，协议 `openai-image`
- 两者均已在 `/api/models` 暴露（image/video，available）

切换 GPU 只需在影策里把模型 key 换成 `h3@5090` / `h3@ngpu48` 等（`@` 后即设备）。

## 成本保护

桥接开机前会查 `GET /balance/info`，现金余额 ≤ `BRIDGE_MIN_BALANCE` 时拒绝开机并报「余额不足」。

## 选设备 / 选 Pod（管理端）

```bash
CHENYU_API_KEY=sk-xxx node devices.mjs gpu          # 列出 GPU 型号 + 时价 + gpu_uuid
CHENYU_API_KEY=sk-xxx node devices.mjs pod 关键词     # 按关键词搜应用市场 Pod（uuid/版本）
```
把选中的 `gpu_uuid` 填进 `GPU_ALIASES`，`pod.uuid/tag` 填进 `config.presets`，`workflowFile` 放该 Pod 的 ComfyUI API 格式工作流即可扩展新模型。
