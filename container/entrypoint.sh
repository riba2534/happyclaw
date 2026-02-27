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

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# Discover and link skills
mkdir -p /home/node/.claude/skills
[ -d /workspace/project-skills ] && ln -sf /workspace/project-skills/* /home/node/.claude/skills/ 2>/dev/null || true
[ -d /workspace/user-skills ] && ln -sf /workspace/user-skills/* /home/node/.claude/skills/ 2>/dev/null || true
chown -R node:node /home/node/.claude/skills 2>/dev/null || true

# Compile TypeScript (agent-runner source may be hot-mounted from host)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Drop privileges and execute agent-runner as node user
exec runuser -u node -- node /tmp/dist/index.js < /tmp/input.json
