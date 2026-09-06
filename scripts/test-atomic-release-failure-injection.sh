#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11 原子发布失败注入与全套激活隔离验证测试
#
# 验证内容：
# 1. 模拟旧在线版本 (VERSION_OLD)；
# 2. 注入各类失败点（主服务构建失败、Web 构建失败、Runner 构建失败、Docker 镜像非法/失败）；
# 3. 严格断言任一步失败在线模拟版本与静态资源 100% 不变；
# 4. 验证成功路径：所有构建通过后，三包产物与代码全套原子激活，并保留 rollback 归档；
# 5. 验证绝对没有创建或备份 SQLite/runtime/.env 数据。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-atomic-test.XXXXXX")"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT INT TERM

log_test() {
  printf "\n\033[1;34m[TEST]\033[0m %s\n" "$*"
}

log_pass() {
  printf "\033[1;32m[PASS]\033[0m %s\n" "$*"
}

log_fail() {
  printf "\033[1;31m[FAIL]\033[0m %s\n" "$*" >&2
  exit 1
}

# 创建隔离的测试 Git 仓库
mkdir -p "${TEST_TMPDIR}/repo"
cd "${TEST_TMPDIR}/repo"

git init -b main --quiet
git config user.name "HappyClaw Test"
git config user.email "test@happyclaw.local"

# 拷贝发布脚本
mkdir -p scripts
cp "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
chmod +x scripts/*.sh

# 配置 .gitignore，与生产仓库保持完全一致
cat << 'EOF' > .gitignore
dist/
web/dist/
container/agent-runner/dist/
data/
.env
.env.*
.release-candidate/
.release-previous/
.release-current.json
EOF

# 创建模拟的项目文件结构
mkdir -p dist web/dist container/agent-runner/dist
echo "console.log('OLD_SERVER');" > dist/index.js
echo "<html><body>OLD_WEB</body></html>" > web/dist/index.html
echo "OLD_RUNNER" > container/agent-runner/dist/runner.js

# 创建支持测试的 mock package.json
cat << 'EOF' > package.json
{
  "name": "happyclaw-test",
  "version": "1.0.0",
  "scripts": {
    "build": "mkdir -p dist && echo \"console.log('$BUILD_VERSION_SERVER');\" > dist/index.js",
    "build:web": "mkdir -p web/dist && echo \"<html><body>$BUILD_VERSION_WEB</body></html>\" > web/dist/index.html"
  }
}
EOF

mkdir -p web
cat << 'EOF' > web/package.json
{
  "name": "web-test"
}
EOF

mkdir -p container/agent-runner
cat << 'EOF' > container/agent-runner/package.json
{
  "name": "agent-runner-test",
  "scripts": {
    "build": "mkdir -p dist && echo \"$BUILD_VERSION_RUNNER\" > dist/runner.js"
  }
}
EOF

# 创建模拟的 .env 和 data/ 业务数据
echo "PORT=3000" > .env
echo "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-old" >> .env
mkdir -p data/db
echo "MOCK_SQLITE_DATABASE" > data/db/messages.db

git add .
git commit -m "Commit A: Initial online version" --quiet
COMMIT_A="$(git rev-parse HEAD)"

# 创建 Commit B: 目标候选版本
export BUILD_VERSION_SERVER="SERVER_V2"
export BUILD_VERSION_WEB="WEB_V2"
export BUILD_VERSION_RUNNER="RUNNER_V2"

echo "console.log('NEW_SOURCE');" > new_feature.js
git add new_feature.js
git commit -m "Commit B: Next version" --quiet
COMMIT_B="$(git rev-parse HEAD)"

# 切回 Commit A 作为在线状态
git switch --detach "${COMMIT_A}" --quiet

log_test "测试准备就绪："
echo "Commit A (Online): ${COMMIT_A}"
echo "Commit B (Target): ${COMMIT_B}"

assert_online_is_v1() {
  local reason="$1"
  local current_commit="$(git rev-parse HEAD)"
  if [ "${current_commit}" != "${COMMIT_A}" ]; then
    log_fail "${reason}: 在线 commit 发生了变化！当前为 ${current_commit}，预期为 ${COMMIT_A}"
  fi
  if ! grep -q "OLD_SERVER" dist/index.js 2>/dev/null; then
    log_fail "${reason}: 在线 dist/index.js 被意外修改！"
  fi
  if ! grep -q "OLD_WEB" web/dist/index.html 2>/dev/null; then
    log_fail "${reason}: 在线 web/dist/index.html 被意外修改！"
  fi
  if ! grep -q "OLD_RUNNER" container/agent-runner/dist/runner.js 2>/dev/null; then
    log_fail "${reason}: 在线 runner dist 被意外修改！"
  fi
  if [ -d ".release-candidate" ]; then
    log_fail "${reason}: 候选工作区 .release-candidate 未被清理！"
  fi
  if [ -d "data_backup" ] || [ -f "data/db/messages.db.bak" ]; then
    log_fail "${reason}: 意外创建了数据库/数据备份！违反现行不备份政策！"
  fi
}

# --- 场景 1: 模拟主服务构建失败 ---
log_test "场景 1: 模拟在候选构建主服务时失败 (server_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="server_build" \
./scripts/deploy-release.sh
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -ne 102 ]; then
  log_fail "预期退出码 102，实际为 ${EXIT_CODE}"
fi
assert_online_is_v1 "场景 1 失败注入后"
log_pass "场景 1 通过：主服务构建失败时，在线版本与静态资源完全未改变！"

# --- 场景 2: 模拟 Web 构建失败 ---
log_test "场景 2: 模拟在候选构建 Web 前端时失败 (web_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="web_build" \
./scripts/deploy-release.sh
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -ne 103 ]; then
  log_fail "预期退出码 103，实际为 ${EXIT_CODE}"
fi
assert_online_is_v1 "场景 2 失败注入后"
log_pass "场景 2 通过：Web 构建失败时，在线版本与静态资源完全未改变！"

# --- 场景 3: 模拟 Runner 构建失败 ---
log_test "场景 3: 模拟在候选构建 Agent Runner 时失败 (runner_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="runner_build" \
./scripts/deploy-release.sh
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -ne 104 ]; then
  log_fail "预期退出码 104，实际为 ${EXIT_CODE}"
fi
assert_online_is_v1 "场景 3 失败注入后"
log_pass "场景 3 通过：Runner 构建失败时，在线版本与静态资源完全未改变！"

# --- 场景 4: 模拟非法使用 :latest 镜像标签 ---
log_test "场景 4: 模拟非法使用 :latest 镜像标签"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
./scripts/deploy-release.sh
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -eq 0 ]; then
  log_fail "非法使用 :latest 标签却成功了，预期应失败拦截！"
fi
assert_online_is_v1 "场景 4 非法镜像拦截后"
log_pass "场景 4 通过：拦截浮动 latest 镜像标签，在线版本未变！"

# --- 场景 5: 成功路径原子全套激活 ---
log_test "场景 5: 成功路径，三包构建与不可变镜像全套就绪，原子激活"
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
./scripts/deploy-release.sh

# 验证激活状态
CURRENT_HEAD="$(git rev-parse HEAD)"
if [ "${CURRENT_HEAD}" != "${COMMIT_B}" ]; then
  log_fail "在线版本未切换到 Commit B！实际为 ${CURRENT_HEAD}"
fi
if ! grep -q "SERVER_V2" dist/index.js; then
  log_fail "在线 dist/index.js 未更新为 SERVER_V2！"
fi
if ! grep -q "WEB_V2" web/dist/index.html; then
  log_fail "在线 web/dist/index.html 未更新为 WEB_V2！"
fi
if ! grep -q "RUNNER_V2" container/agent-runner/dist/runner.js; then
  log_fail "在线 runner.js 未更新为 RUNNER_V2！"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_B}" .env; then
  log_fail ".env 中的 CONTAINER_IMAGE 未更新为目标镜像！"
fi
if [ ! -f ".release-previous/meta.json" ]; then
  log_fail ".release-previous/meta.json 未记录上一代版本元数据！"
fi
if ! grep -q "${COMMIT_A}" .release-previous/meta.json; then
  log_fail ".release-previous 未正确记录上一版本 Commit A！"
fi
log_pass "场景 5 通过：全套三包产物与代码原子激活成功！"

# --- 场景 6: 回滚测试 ---
log_test "场景 6: 执行回滚脚本，原子回到上一版本"
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/rollback-release.sh

assert_online_is_v1 "回滚后"
log_pass "场景 6 通过：从 .release-previous 成功瞬时回滚至上一版本！"

log_test "=== 全部原子发布与失败注入测试 100% 通过！ ==="
