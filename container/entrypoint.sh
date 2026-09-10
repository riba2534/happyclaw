#!/bin/bash
set -e

# Default to owner-only creation. Rootless mode switches to 0007 after its
# owner-root/group-node bridge is ready; no mode grants access to "other".
umask 0077

now_ms() {
  date +%s%3N
}

HAPPYCLAW_ENTRYPOINT_STARTED_MS="$(now_ms)"
export HAPPYCLAW_ENTRYPOINT_STARTED_MS
happyclaw_startup_metric() {
  local phase="$1" current elapsed
  current="$(now_ms)"
  elapsed=$((current - HAPPYCLAW_ENTRYPOINT_STARTED_MS))
  printf '[happyclaw:startup] phase=%s elapsed_ms=%s\n' \
    "$phase" "$elapsed" >&2
}

# Read this root-owned launch contract before sourcing the per-session env
# file. Workspace configuration may not switch production into hot-compile
# mode; developers opt in explicitly with docker -e.
HAPPYCLAW_TRUSTED_AGENT_RUNNER_MODE="${HAPPYCLAW_AGENT_RUNNER_MODE:-image}"
HAPPYCLAW_TRUSTED_REQUIRE_BUNDLED_CLAUDE="${HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE:-1}"
happyclaw_startup_metric entrypoint_start

# This root-owned helper accepts no runtime-configurable path.
# shellcheck source=session-permissions.sh
source /app/session-permissions.sh
happyclaw_configure_node_identity

# Prepare only explicit writable roots. Direct mode touches roots and performs
# a separate one-time legacy migration below; rootless defers to its verified
# bridge; host-root/Desktop preserve owner-only modes.
happyclaw_prepare_mounted_paths
happyclaw_migrate_direct_managed_paths

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
# Host uid may differ from container node user, causing git to refuse operations.
# 使用通配符 '*' 因为挂载路径动态（extra mounts、customCwd），无法枚举具体目录。
runuser -u node -- env HOME=/home/node /usr/bin/git \
  config --global --add safe.directory '*'

# Source ordinary runtime variables while locally shadowing every root-control
# variable, including stale values persisted before the host-side denylist.
happyclaw_source_runtime_env
HAPPYCLAW_AGENT_RUNNER_MODE="$HAPPYCLAW_TRUSTED_AGENT_RUNNER_MODE"
HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE="$HAPPYCLAW_TRUSTED_REQUIRE_BUNDLED_CLAUDE"
export HAPPYCLAW_AGENT_RUNNER_MODE
export HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE
unset HAPPYCLAW_TRUSTED_AGENT_RUNNER_MODE HAPPYCLAW_TRUSTED_REQUIRE_BUNDLED_CLAUDE

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
/usr/local/bin/node /app/session-generated-paths.mjs --ensure-npm-global
happyclaw_prepare_generated_path npm-global
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
/usr/local/bin/node /app/session-generated-paths.mjs --reset-skills
if [ -d /workspace/effective-skills ]; then
  for skill in /workspace/effective-skills/*/; do
    if [ -f "${skill}SKILL.md" ]; then
      name=$(basename "$skill")
      /usr/local/bin/node /app/session-generated-paths.mjs \
        "--link-skill=$name"
    fi
  done
fi
happyclaw_prepare_generated_path skills

# Production executes an immutable build that cannot be shadowed by the
# backwards-compatible /app/src and /app/prompts host mounts. Development hot
# reload remains available, but only through an explicit root launch option.
case "$HAPPYCLAW_AGENT_RUNNER_MODE" in
  image)
    AGENT_RUNNER_ENTRY=/opt/happyclaw-agent/dist/index.js
    if [ ! -f "$AGENT_RUNNER_ENTRY" ] || \
      [ ! -f /opt/happyclaw-agent/prompts/security-rules.md ]; then
      echo "Immutable Agent runner artifact is incomplete" >&2
      exit 1
    fi
    ;;
  development)
    if [ ! -d /app/src ] || [ ! -d /app/prompts ]; then
      echo "Development Agent runner mode requires /app/src and /app/prompts mounts" >&2
      exit 1
    fi
    happyclaw_startup_metric runner_compile_start
    cd /app && npx tsc --outDir /tmp/dist --incremental false 2>&1 >&2
    happyclaw_prepare_generated_path dist
    ln -s /app/node_modules /tmp/dist/node_modules
    /usr/local/bin/node /app/session-prompts-copy.mjs
    AGENT_RUNNER_ENTRY=/tmp/dist/index.js
    happyclaw_startup_metric runner_compile_done
    ;;
  *)
    echo "HAPPYCLAW_AGENT_RUNNER_MODE must be image or development" >&2
    exit 1
    ;;
esac
export AGENT_RUNNER_ENTRY
happyclaw_startup_metric runner_artifact_ready

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits. It also stops a lazily
# started managed Chromium process so no browser child survives cancellation.
CHROMIUM_PID_FILE=/tmp/happyclaw-chromium.pid
happyclaw_is_managed_chromium() {
  local pid="$1" expected_uid actual_uid
  [ -r "/proc/$pid/status" ] && [ -r "/proc/$pid/cmdline" ] || return 1
  expected_uid="$(id -u node)"
  actual_uid="$(awk '/^Uid:/{print $2; exit}' "/proc/$pid/status")"
  [ "$actual_uid" = "$expected_uid" ] || return 1
  tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq -- \
    '--user-data-dir=/tmp/happyclaw-chromium-profile'
}
cleanup() {
  local cleanup_status=0 chromium_pid=
  happyclaw_stop_session_permission_watcher || cleanup_status=$?
  if [ -f "$CHROMIUM_PID_FILE" ]; then
    read -r chromium_pid < "$CHROMIUM_PID_FILE" || chromium_pid=
  fi
  if [[ "$chromium_pid" =~ ^[1-9][0-9]*$ ]] && \
    kill -0 "$chromium_pid" 2>/dev/null && \
    happyclaw_is_managed_chromium "$chromium_pid"; then
    kill "$chromium_pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      kill -0 "$chromium_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$chromium_pid" 2>/dev/null; then
      kill -KILL "$chromium_pid" 2>/dev/null || true
    fi
    wait "$chromium_pid" 2>/dev/null || true
  fi
  return "$cleanup_status"
}
trap cleanup EXIT

# Rootless bind mounts require a live owner-root/group-node bridge for files
# that applications explicitly create as 0600. Other modes need no watcher.
happyclaw_start_session_permission_watcher
if [ "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" = rootless ]; then
  umask 0007
fi

# Install a root-owned PATH wrapper. It starts one deterministic browser on the
# first agent-browser invocation, then delegates to the real target-architecture
# CLI. Binding to loopback keeps raw CDP private to the container.
HAPPYCLAW_CHROMIUM_CDP_HOST="${HAPPYCLAW_CHROMIUM_CDP_HOST:-127.0.0.1}"
HAPPYCLAW_CHROMIUM_CDP_PORT="${HAPPYCLAW_CHROMIUM_CDP_PORT:-9222}"
export AGENT_BROWSER_CDP="$HAPPYCLAW_CHROMIUM_CDP_PORT"
export HAPPYCLAW_CHROMIUM_CDP_HOST HAPPYCLAW_CHROMIUM_CDP_PORT

AGENT_BROWSER_WRAPPER=/app/node_modules/.bin/agent-browser
# Replace npm's ordinary symlink, never its package target. This makes both
# PATH lookup and callers using the conventional absolute .bin path lazy-safe.
rm -f "$AGENT_BROWSER_WRAPPER"
cat > "$AGENT_BROWSER_WRAPPER" <<'LAZY_AGENT_BROWSER'
#!/bin/bash
set -euo pipefail

HOST="${HAPPYCLAW_CHROMIUM_CDP_HOST:-127.0.0.1}"
PORT="${HAPPYCLAW_CHROMIUM_CDP_PORT:-9222}"
ENDPOINT="http://${HOST}:${PORT}/json/version"
PID_FILE=/tmp/happyclaw-chromium.pid
LOCK_DIR=/tmp/happyclaw-chromium-start.lock
PROFILE_DIR=/tmp/happyclaw-chromium-profile
CHROMIUM_LOG=/tmp/happyclaw-chromium.log
STARTED_MS="$(date +%s%3N)"

metric() {
  local phase="$1" now container_elapsed browser_elapsed
  now="$(date +%s%3N)"
  browser_elapsed=$((now - STARTED_MS))
  if [[ "${HAPPYCLAW_ENTRYPOINT_STARTED_MS:-}" =~ ^[0-9]+$ ]]; then
    container_elapsed=$((now - HAPPYCLAW_ENTRYPOINT_STARTED_MS))
  else
    container_elapsed=-1
  fi
  printf '[happyclaw:startup] phase=%s elapsed_ms=%s browser_elapsed_ms=%s\n' \
    "$phase" "$container_elapsed" "$browser_elapsed" >&2
}

ready() {
  curl --noproxy '*' -fsS "$ENDPOINT" >/dev/null 2>&1
}

ensure_browser() {
  local owns_lock=false chromium_pid=
  cleanup_owned_start() {
    if [ "$owns_lock" = true ]; then
      if [[ "$chromium_pid" =~ ^[1-9][0-9]*$ ]] && \
        kill -0 "$chromium_pid" 2>/dev/null; then
        kill "$chromium_pid" 2>/dev/null || true
        wait "$chromium_pid" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
      rmdir "$LOCK_DIR" 2>/dev/null || true
      owns_lock=false
    fi
  }
  trap cleanup_owned_start EXIT
  trap 'cleanup_owned_start; exit 143' TERM
  trap 'cleanup_owned_start; exit 130' INT
  if ready; then
    trap - EXIT INT TERM
    metric chromium_reused
    return
  fi

  for ((attempt = 0; attempt < 200; attempt++)); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      owns_lock=true
      break
    fi
    if ready; then
      trap - EXIT INT TERM
      metric chromium_reused
      return
    fi
    sleep 0.1
  done
  if [ "$owns_lock" != true ]; then
    # Chromium itself has a 10s readiness deadline below. A lock still present
    # after 20s cannot belong to a healthy starter, so recover the empty stale
    # directory once before failing closed.
    if rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; then
      owns_lock=true
    else
      echo "Timed out waiting for the managed Chromium startup lock" >&2
      exit 1
    fi
  fi

  if ready; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    owns_lock=false
    trap - EXIT INT TERM
    metric chromium_reused
    return
  fi

  mkdir -p "$PROFILE_DIR"
  metric chromium_start
  HOME=/home/node "${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/bin/chromium}" \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --remote-debugging-address="$HOST" \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE_DIR" \
    about:blank >"$CHROMIUM_LOG" 2>&1 &
  chromium_pid=$!
  printf '%s\n' "$chromium_pid" > "$PID_FILE"

  for ((attempt = 0; attempt < 100; attempt++)); do
    if ready; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      owns_lock=false
      trap - EXIT INT TERM
      metric chromium_ready
      return
    fi
    if ! kill -0 "$chromium_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  kill "$chromium_pid" 2>/dev/null || true
  wait "$chromium_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  owns_lock=false
  trap - EXIT INT TERM
  echo "Chromium failed to listen on container-local CDP port ${PORT}" >&2
  exit 1
}

ensure_browser
exec /usr/local/bin/node \
  /app/node_modules/agent-browser/bin/agent-browser.js "$@"
LAZY_AGENT_BROWSER
chmod 0555 "$AGENT_BROWSER_WRAPPER"
export PATH="/app/node_modules/.bin:$PATH"
happyclaw_startup_metric browser_deferred

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json
happyclaw_startup_metric input_buffered

# Drop privileges and execute agent-runner as node user
happyclaw_startup_metric runner_exec
runuser -u node -- node "$AGENT_RUNNER_ENTRY" < /tmp/input.json
runner_status=$?
# EXIT cleanup (permission watcher / Chromium) must not overwrite the runner
# exit code. A successful node 0 plus a failed cleanup previously became
# Docker code 2 and the host retried a finished turn.
trap - EXIT
cleanup || true
exit "$runner_status"
