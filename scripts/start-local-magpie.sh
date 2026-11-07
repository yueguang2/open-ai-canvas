#!/usr/bin/env bash
# 本地一键启动：Go 后端(SQLite) + 前端(生产预览) + 本机 Magpie 渠道配置
#
# 需要：Go 1.25+、Bun、本机 Magpie 已运行（默认 127.0.0.1:3425）。
# 用法：  scripts/start-local-magpie.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 工具链（按需调整）
export PATH="$HOME/.local/go/bin:$HOME/.bun/bin:$PATH"
GO_BIN="${GO_BIN:-$HOME/.local/go/bin/go}"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

DATA_DIR="$ROOT/.local/project-workbench-debug"
mkdir -p "$DATA_DIR" "$ROOT/.local/cache/go-build" "$ROOT/.local/cache/go-mod"

echo "==> 启动后端 (SQLite, 允许本机私网上游)"
cd "$ROOT/backend"
CANVAS_BACKEND_ADDR=127.0.0.1:8080 \
CANVAS_BACKEND_DATA_DIR="$DATA_DIR" \
GOCACHE="$ROOT/.local/cache/go-build" \
GOMODCACHE="$ROOT/.local/cache/go-mod" \
CANVAS_ALLOW_PRIVATE_UPSTREAMS=true \
CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1 \
CANVAS_CORS_ORIGINS=http://localhost:3000 \
"$GO_BIN" run ./cmd/server >"$ROOT/.local/backend.log" 2>&1 &
BACKEND_PID=$!
echo "    backend pid=$BACKEND_PID  log=.local/backend.log"

echo "==> 等待后端就绪"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:8080/api/health"; then break; fi
  sleep 1
done

echo "==> 配置本机 Magpie 渠道（首次会注册管理员 admin / Admin123456）"
node "$ROOT/scripts/configure-local-magpie.mjs" || echo "    (配置脚本失败：确认本机 Magpie 在 127.0.0.1:3425 运行)"

echo "==> 构建并启动前端"
cd "$ROOT/web"
if [ ! -d dist ]; then "$BUN_BIN" run build; fi
"$BUN_BIN" run start >"$ROOT/.local/web.log" 2>&1 &
WEB_PID=$!
echo "    web pid=$WEB_PID  log=.local/web.log"

echo ""
echo "✅ 打开 http://localhost:3000  用 admin / Admin123456 登录"
echo "   Ctrl+C 结束前端；后端仍在后台（kill $BACKEND_PID 结束）"
wait "$WEB_PID"
