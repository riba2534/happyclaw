#!/bin/bash
set -e

# Set permissive umask so files created by the container (node user, uid 1000)
# are writable by the host backend (agent user, uid 1002).
# Without this, the host cannot delete/modify files created by the container.
umask 0000

# Fix ownership on mounted volumes.
# Host uid may differ from container node user (uid 1000), especially in
# rootless podman where uid remapping causes EACCES on bind mounts.
# Running as root here so chown works regardless of host uid.
chown -R node:node /home/node/.claude 2>/dev/null || true
chown -R node:node /home/node/.feishu-cli 2>/dev/null || true
chown -R node:node /workspace/group /workspace/ipc 2>/dev/null || true

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
# Host uid may differ from container node user, causing git to refuse operations.
# 使用通配符 '*' 因为挂载路径动态（extra mounts、customCwd），无法枚举具体目录。
git config --global --add safe.directory '*' 2>/dev/null || true

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# Prepend agent-runner 的本地 node_modules/.bin 到 PATH。
# agent-runner/package.json 声明了 @anthropic-ai/claude-code 依赖，npm install
# 会在 /app/node_modules/.bin/claude 生成 shim。但若不把该目录加入 PATH，
# agent-runner 内 `which claude` 找不到 CLI，SDK 会 fallback 到空的 native
# binary optionalDependency（@anthropic-ai/claude-agent-sdk-linux-x64 等）
# 导致 "Native CLI binary for linux-x64 not found" 启动失败。
export PATH="/app/node_modules/.bin:${PATH}"

# CLAUDE_CONFIG_DIR: CLI 默认用 $HOME/.claude.json 作为身份文件，但该文件被
# readonly 挂载（避免容器篡改宿主机配置）。CLI 启动时尝试写入（更新 numStartups
# 等计数器），readonly 导致静默失败 → query() 返回 0 messages。
# 显式设 CLAUDE_CONFIG_DIR 让 CLI 改读写 /home/node/.claude/.claude.json（session
# 目录，可写），与宿主机模式的 hostEnv['CLAUDE_CONFIG_DIR'] 保持一致。
export CLAUDE_CONFIG_DIR=/home/node/.claude

# IS_SANDBOX: Claude Code 2.1.114+ 要求 IS_SANDBOX=1 才允许 --dangerously-skip-permissions。
# 与宿主机模式的 hostEnv['IS_SANDBOX'] = '1' 保持一致。
export IS_SANDBOX=1

# Persist Agent's `npm install -g <pkg>` to per-user mounted extra dir.
# 容器是 docker run --rm 模式，每次结束销毁。如果 Agent 在容器里跑
# `npm install -g lark-cli`、`@fanfanv5/feishu-cli`、各类 MCP server 包等，
# 默认会装到镜像内层 /usr/local/lib/node_modules，下次新容器又得重装。
# 把 npm prefix 指向已挂载的 /workspace/extra/.npm-global（host 端
# data/extra/{folder}/.npm-global/，per-user 隔离）即可让全局包持久化。
NPM_GLOBAL_DIR=/workspace/extra/.npm-global
mkdir -p "$NPM_GLOBAL_DIR/bin" "$NPM_GLOBAL_DIR/lib"
chown -R node:node "$NPM_GLOBAL_DIR" 2>/dev/null || true
# 写到 node user 的 ~/.npmrc 让 npm 全局命令默认走该 prefix。
# 镜像每次启动重置 /home/node，所以 entrypoint 每次都重写一遍是稳妥做法。
cat > /home/node/.npmrc <<EOF
prefix=$NPM_GLOBAL_DIR
EOF
chown node:node /home/node/.npmrc 2>/dev/null || true
# 注意：append 而非 prepend，避免持久化的 npm shim 屏蔽 /app/node_modules/.bin 中 SDK 自带的 claude CLI（见上方第 28-33 行注释）
export PATH="$PATH:$NPM_GLOBAL_DIR/bin"

# Materialize the canonical Skill manifest resolved by the host. Each selected
# Skill is mounted read-only below /workspace/effective-skills. Completely
# rebuilding the directory prevents a real Skill directory created by an
# earlier Agent run from surviving a container restart.
mkdir -p /home/node/.claude/skills
find /home/node/.claude/skills -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
if [ -d /workspace/effective-skills ]; then
  for skill in /workspace/effective-skills/*/; do
    if [ -f "${skill}SKILL.md" ]; then
      name=$(basename "$skill")
      ln -sfn "$skill" "/home/node/.claude/skills/$name"
    fi
  done
fi
chown -R node:node /home/node/.claude/skills 2>/dev/null || true

# Compile TypeScript (agent-runner source may be hot-mounted from host)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
ln -s /app/prompts /tmp/prompts
chmod -R a-w /tmp/dist

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits. It also stops the managed
# Chromium process so no browser child survives a cancelled run.
CHROMIUM_PID=
cleanup() {
  if [ -n "$CHROMIUM_PID" ] && kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    kill "$CHROMIUM_PID" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      kill -0 "$CHROMIUM_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHROMIUM_PID" 2>/dev/null; then
      kill -KILL "$CHROMIUM_PID" 2>/dev/null || true
    fi
    wait "$CHROMIUM_PID" 2>/dev/null || true
  fi
  chmod -R a+rwX /home/node/.claude 2>/dev/null || true
  chmod -R a+rwX /workspace/group 2>/dev/null || true
}
trap cleanup EXIT

# Start one deterministic browser for this task container. Binding to loopback
# keeps the raw Chrome DevTools Protocol private to the container; a future Web
# browser panel must proxy the authenticated agent-browser dashboard/stream,
# never publish this port directly.
HAPPYCLAW_CHROMIUM_CDP_HOST="${HAPPYCLAW_CHROMIUM_CDP_HOST:-127.0.0.1}"
HAPPYCLAW_CHROMIUM_CDP_PORT="${HAPPYCLAW_CHROMIUM_CDP_PORT:-9222}"
CHROMIUM_PROFILE_DIR=/tmp/happyclaw-chromium-profile
CHROMIUM_LOG=/tmp/happyclaw-chromium.log
mkdir -p "$CHROMIUM_PROFILE_DIR"
chown -R node:node "$CHROMIUM_PROFILE_DIR"

# agent-browser reads this value when its daemon starts, so it attaches to the
# managed browser instead of creating another Chromium with a random CDP port.
export AGENT_BROWSER_CDP="$HAPPYCLAW_CHROMIUM_CDP_PORT"

HOME=/home/node setpriv --reuid=node --regid=node --init-groups -- \
  "${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/bin/chromium}" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address="$HAPPYCLAW_CHROMIUM_CDP_HOST" \
  --remote-debugging-port="$HAPPYCLAW_CHROMIUM_CDP_PORT" \
  --user-data-dir="$CHROMIUM_PROFILE_DIR" \
  about:blank >"$CHROMIUM_LOG" 2>&1 &
CHROMIUM_PID=$!

CHROMIUM_READY=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if curl --noproxy '*' -fsS \
    "http://127.0.0.1:${HAPPYCLAW_CHROMIUM_CDP_PORT}/json/version" \
    >/dev/null 2>&1; then
    CHROMIUM_READY=true
    break
  fi
  if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [ "$CHROMIUM_READY" != true ]; then
  echo "Chromium failed to listen on container-local CDP port ${HAPPYCLAW_CHROMIUM_CDP_PORT}" >&2
  cat "$CHROMIUM_LOG" >&2 2>/dev/null || true
  exit 1
fi

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Drop privileges and execute agent-runner as node user
runuser -u node -- node /tmp/dist/index.js < /tmp/input.json
