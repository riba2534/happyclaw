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
chown -R node:node /workspace/group /workspace/global /workspace/memory /workspace/ipc 2>/dev/null || true

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
# Discover and link skills (builtin → project → user, higher priority overwrites)
# Only remove entries that conflict with mounted skills (non-symlink with same name),
# preserving any skills the agent created directly in .claude/skills/.
mkdir -p /home/node/.claude/skills
for dir in /opt/builtin-skills /workspace/external-skills /workspace/project-skills /workspace/user-skills; do
  if [ -d "$dir" ]; then
    for skill in "$dir"/*/; do
      if [ -d "$skill" ]; then
        name=$(basename "$skill")
        target="/home/node/.claude/skills/$name"
        # Remove conflicting non-symlink entry (e.g. real directory from a failed agent edit)
        if [ -e "$target" ] && [ ! -L "$target" ]; then
          rm -rf "$target" 2>/dev/null || true
        fi
        ln -sfn "$skill" "$target" 2>/dev/null || true
      fi
    done
  fi
done
chown -R node:node /home/node/.claude/skills 2>/dev/null || true

# Compile TypeScript (agent-runner source may be hot-mounted from host)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
ln -s /app/prompts /tmp/prompts
chmod -R a-w /tmp/dist

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits.
cleanup() {
  chmod -R a+rwX /home/node/.claude 2>/dev/null || true
  chmod -R a+rwX /workspace/group 2>/dev/null || true
}
trap cleanup EXIT

# Drop privileges and execute agent-runner as node user
runuser -u node -- node /tmp/dist/index.js < /tmp/input.json
