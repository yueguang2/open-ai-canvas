#!/usr/bin/env bash
# 本地一键启动：影策后端(SQLite) + 前端(生产预览) + 本机 Magpie 渠道 + 晨羽桥接(可选)
#
# 需要：Go 1.25+、Bun、本机 Magpie(默认 127.0.0.1:3425)。
# 晨羽桥接：把 CHENYU_API_KEY 写进 .local/chenyu.env 即自动随启动（.local 已被 git 忽略）。
# 用法：  scripts/start-local-magpie.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/go/bin:$HOME/.bun/bin:$PATH"
GO_BIN="${GO_BIN:-$HOME/.local/go/bin/go}"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

DATA_DIR="$ROOT/.local/project-workbench-debug"
mkdir -p "$DATA_DIR" "$ROOT/.local/cache/go-build" "$ROOT/.local/cache/go-mod"

# 内置 Agent 运行时依赖（缺了会导致“Agent执行失败”）
PI_DIR="$ROOT/backend/agent-runtime/pi"
if [ ! -d "$PI_DIR/node_modules" ]; then
  echo "==> 安装 Agent 运行时依赖（首次，约 15s）"
  ( cd "$PI_DIR" && npm install --no-audit --no-fund ) || echo "    (Agent 依赖安装失败，Agent 功能可能不可用)"
fi

# 本地密钥/配置（.local 被 git 忽略，不会进仓库）
if [ -f "$ROOT/.local/chenyu.env" ]; then
  set -a; . "$ROOT/.local/chenyu.env"; set +a
fi

PIDS=()
cleanup() {
  echo ""
  echo "==> 结束进程..."
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

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
BACKEND_PID=$!; PIDS+=("$BACKEND_PID")
echo "    backend pid=$BACKEND_PID  log=.local/backend.log"

echo "==> 等待后端就绪"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:8080/api/health"; then break; fi
  sleep 1
done

echo "==> 配置本机 Magpie 渠道（首次会注册管理员 admin / Admin123456）"
node "$ROOT/scripts/configure-local-magpie.mjs" || echo "    (Magpie 配置失败：确认本机 Magpie 在 127.0.0.1:3425 运行)"

# ---- 晨羽桥接已拆分为独立项目（/home/yueguang/DSH/云GPU中间件）----
# 本脚本不再启动/配置中间件；请在中间件项目内部署（docker compose up -d）。
if [ -n "${CHENYU_API_KEY:-}" ]; then
  echo "==> 提示：晨羽桥接已独立为「云GPU中间件」，本脚本不再启动它"
fi

echo "==> 构建并启动前端"
cd "$ROOT/web"
if [ ! -d dist ]; then "$BUN_BIN" run build; fi
"$BUN_BIN" run start >"$ROOT/.local/web.log" 2>&1 &
WEB_PID=$!; PIDS+=("$WEB_PID")
echo "    web pid=$WEB_PID  log=.local/web.log"

echo ""
echo "✅ 打开 http://localhost:3000  用 admin / Admin123456 登录"
echo "   Ctrl+C 结束全部（后端/前端/桥接）"
wait "$WEB_PID"
