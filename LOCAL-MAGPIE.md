# 本地运行 + 接入本机 Magpie

本项目（影策 open-ai-canvas）可作为二次开发底座。以下是在**单机、无 Docker** 环境把前后端跑起来并接入本机 Magpie 模型的方式。

## 依赖

- Go 1.25+（后端，SQLite 用纯 Go 驱动，不需要 CGO）
- Bun（前端，仓库只带 `bun.lock`）
- 本机 Magpie 已运行，OpenAI 兼容网关默认 `http://127.0.0.1:3425/v1`（本机无需鉴权）

## 一键启动

```bash
scripts/start-local-magpie.sh
```

脚本会：启动后端（SQLite，数据在 `.local/project-workbench-debug`，允许访问本机私网上游）→ 等待健康检查 → 用 `scripts/configure-local-magpie.mjs` 注册管理员并配置「本机 Magpie」渠道与逻辑模型 → 构建并启动前端预览。

打开 http://localhost:3000 ，用 **admin / Admin123456** 登录。

## 手工步骤

后端：

```bash
cd backend
CANVAS_BACKEND_ADDR=127.0.0.1:8080 \
CANVAS_BACKEND_DATA_DIR=../.local/project-workbench-debug \
GOCACHE=../.local/cache/go-build GOMODCACHE=../.local/cache/go-mod \
CANVAS_ALLOW_PRIVATE_UPSTREAMS=true CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1 \
go run ./cmd/server
```

前端（生产预览，`vite preview` 已配置 `/api` 代理）：

```bash
cd web
bun install --frozen-lockfile
bun run build   # 首次或改动后
bun run start   # http://localhost:3000
```

> 说明：本环境里 `vite dev` 因 React Fast Refresh 预置未注入会出现白屏，因此默认用生产预览（`build + start`）。若要开发模式，请排查 `@vitejs/plugin-react` 与 Vite 版本匹配。

## 把本机 Magpie 配成渠道

`scripts/configure-local-magpie.mjs` 自动完成：

1. 登录；若系统无用户则注册第一个用户（自动成为管理员）。
2. 读取 `http://127.0.0.1:3425/v1/models`。
3. 创建/复用「本机 Magpie」渠道（baseUrl=`http://127.0.0.1:3425/v1`）。
4. 每个模型标记 `capability=text`、`protocol=chat-completion` 并写入文本能力参数。
5. 为每个渠道模型创建对应「逻辑模型」，使其出现在前台 `/api/models`。

可传环境变量覆盖：`CANVAS_BACKEND`、`MAGPIE_GATEWAY`、`ADMIN_USER`、`ADMIN_PASS`。

## 注意

- 后端默认拒绝访问本机/私网上游（SSRF 防护）。接本机 Magpie 必须 `CANVAS_ALLOW_PRIVATE_UPSTREAMS=true` 且把 `127.0.0.1` 加入允许主机；仅限本机可信环境。
- 图片/视频能力：本机 Magpie 的图片/视频是 MCP 工具（`generate_image` / `generate_video`），不是 OpenAI 兼容 chat；如需让影策的图像/视频节点走 Magpie，需要额外适配（可作为下一步二次开发）。
- `.local/` 为本地数据与缓存，已在 `.gitignore` 中忽略，不进入仓库。
