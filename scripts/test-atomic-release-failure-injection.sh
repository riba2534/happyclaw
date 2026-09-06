#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11 原子发布与版本一致性全面隔离验证测试 (R11/Leader Review 规范)
#
# 严格覆盖 Leader review 提出的具体验证项：
# 1. 部署排他锁与隔离清理验证：并发部署检测锁并 fail-closed；带非本轮 marker 的目录绝不误删；
# 2. 精确不可变镜像验证：拒绝 :latest、拒绝 SHA 不匹配镜像、必须 Docker 存在/校验；
# 3. 候选构建失败零污染：主服务失败、Web 失败、Runner 失败，在线软链接指针与内容 100% 保持旧版本；
# 4. 单步原子指针切换：不可变版本目录 (.releases/store/<SHA>) 与单一符号链接指针 (.releases/current)
#    单步原子重命名激活，所有三包产物瞬间同时生效；
# 5. 原地无副本更新 .env：全程无 .bak 或临时副本，强制保持 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1；
# 6. 原子回滚：通过指针切换瞬时回滚，代码与产物完全一致。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-atomic-v2.XXXXXX")"
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

mkdir -p "${TEST_TMPDIR}/repo"
cd "${TEST_TMPDIR}/repo"

git init -b main --quiet
git config user.name "HappyClaw Test"
git config user.email "test@happyclaw.local"

mkdir -p scripts
cp "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
chmod +x scripts/*.sh

# 配置 .gitignore (同时匹配目录与符号链接)
cat << 'EOF' > .gitignore
dist
dist/
web/dist
web/dist/
container/agent-runner/dist
container/agent-runner/dist/
data/
.env
.env.*
.releases/
.releases
.release-staging-*/
.release-candidate/
.release-previous/
.release-current.json
.deploy.lock/
.deploy.lock
EOF

# 创建模拟的旧三包文件结构
mkdir -p dist web/dist container/agent-runner/dist
echo "console.log('OLD_SERVER_SHA_A');" > dist/index.js
echo "<html><body>OLD_WEB_SHA_A</body></html>" > web/dist/index.html
echo "OLD_RUNNER_SHA_A" > container/agent-runner/dist/runner.js

# 创建 mock package.json
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

echo "PORT=3000" > .env
echo "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-old" >> .env
chmod 600 .env

mkdir -p data/db
echo "MOCK_SQLITE_DATABASE" > data/db/messages.db

git add .
git commit -m "Commit A: Initial online version" --quiet
COMMIT_A="$(git rev-parse HEAD)"

# 创建 Commit B 作为目标版本
export BUILD_VERSION_SERVER="SERVER_V2"
export BUILD_VERSION_WEB="WEB_V2"
export BUILD_VERSION_RUNNER="RUNNER_V2"

echo "console.log('NEW_SOURCE_B');" > feature_b.js
git add feature_b.js
git commit -m "Commit B: Next target version" --quiet
COMMIT_B="$(git rev-parse HEAD)"

git switch --detach "${COMMIT_A}" --quiet

log_test "测试准备就绪："
echo "Commit A (Online): ${COMMIT_A}"
echo "Commit B (Target): ${COMMIT_B}"

assert_online_is_v1() {
  local reason="$1"
  local current_commit="$(git rev-parse HEAD)"
  if [ "${current_commit}" != "${COMMIT_A}" ]; then
    log_fail "${reason}: 在线 commit 发生漂移！当前为 ${current_commit}，预期为 ${COMMIT_A}"
  fi
  if ! grep -q "OLD_SERVER_SHA_A" dist/index.js 2>/dev/null; then
    log_fail "${reason}: 在线 dist/index.js 被意外破坏！"
  fi
  if ! grep -q "OLD_WEB_SHA_A" web/dist/index.html 2>/dev/null; then
    log_fail "${reason}: 在线 web/dist/index.html 被意外破坏！"
  fi
  if ! grep -q "OLD_RUNNER_SHA_A" container/agent-runner/dist/runner.js 2>/dev/null; then
    log_fail "${reason}: 在线 runner dist 被意外破坏！"
  fi
  if [ -f ".env.bak" ] || [ -f ".env.tmp" ]; then
    log_fail "${reason}: 发现了被禁止的 .env 备份文件！"
  fi
}

# --- 场景 1: 部署排他锁与隔离清理安全性测试 ---
log_test "场景 1: 部署排他锁互斥检测与非本轮 marker 保护测试"
# 1) 测试排他锁阻止并发部署
mkdir -p .deploy.lock
echo "$$" > .deploy.lock/pid
echo "existing_run_id" > .deploy.lock/run_id

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh
LOCK_EXIT=$?
set -e

if [ "${LOCK_EXIT}" -eq 0 ]; then
  log_fail "持有锁时并发部署竟然成功了，必须 fail-closed 退出！"
fi
rm -rf .deploy.lock
log_pass "排他锁测试通过：并发部署被安全阻断！"

# 2) 模拟未知残留目录，验证非本轮 marker 绝不被删除
mkdir -p .release-staging-alien
echo "alien_run_id" > .release-staging-alien/.release-run-marker
echo "IMPORTANT_UNKNOWN_DATA" > .release-staging-alien/keep_me.txt

# --- 场景 2: 严格拒绝非法与不匹配镜像标签 ---
log_test "场景 2: 严格拒绝非法镜像与 SHA 不匹配镜像"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh
IMG_LATEST_EXIT=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-wrong_sha_123" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh
IMG_MISMATCH_EXIT=$?
set -e

if [ "${IMG_LATEST_EXIT}" -eq 0 ] || [ "${IMG_MISMATCH_EXIT}" -eq 0 ]; then
  log_fail "非法或不匹配镜像标签未被拦截！"
fi
assert_online_is_v1 "场景 2 镜像拦截后"
log_pass "场景 2 通过：严格拒绝 latest 与 SHA 不匹配镜像，在线状态零污染！"

# --- 场景 3: 候选构建失败零污染防护 ---
log_test "场景 3: 模拟主服务编译失败 (server_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
HAPPYCLAW_INJECT_FAILURE="server_build" \
./scripts/deploy-release.sh
EXIT_102=$?
set -e

if [ "${EXIT_102}" -ne 102 ]; then
  log_fail "预期退出码 102，实际为 ${EXIT_102}"
fi
assert_online_is_v1 "场景 3 主服务构建失败后"
log_pass "场景 3 通过：主服务构建失败，在线版本与静态资源完全不受影响！"

log_test "场景 3b: 模拟 Web 前端编译失败 (web_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
HAPPYCLAW_INJECT_FAILURE="web_build" \
./scripts/deploy-release.sh
EXIT_103=$?
set -e

if [ "${EXIT_103}" -ne 103 ]; then
  log_fail "预期退出码 103，实际为 ${EXIT_103}"
fi
assert_online_is_v1 "场景 3b Web 构建失败后"
log_pass "场景 3b 通过：Web 构建失败，在线版本与静态资源完全不受影响！"

log_test "场景 3c: 模拟 Agent Runner 编译失败 (runner_build)"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
HAPPYCLAW_INJECT_FAILURE="runner_build" \
./scripts/deploy-release.sh
EXIT_104=$?
set -e

if [ "${EXIT_104}" -ne 104 ]; then
  log_fail "预期退出码 104，实际为 ${EXIT_104}"
fi
assert_online_is_v1 "场景 3c Runner 构建失败后"
log_pass "场景 3c 通过：Runner 构建失败，在线版本完全不受影响！"

# 验证非本轮目录保持完好
if [ ! -f ".release-staging-alien/keep_me.txt" ]; then
  log_fail "非本轮 staging 目录被意外误删！隔离清理失败！"
fi
rm -rf .release-staging-alien

# --- 场景 4: 成功路径单步原子指针切换与无副本 .env ---
log_test "场景 4: 成功路径单步原子指针切换与无备份 .env 更新"
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh

# 1) 验证 Git HEAD
CURRENT_HEAD="$(git rev-parse HEAD)"
if [ "${CURRENT_HEAD}" != "${COMMIT_B}" ]; then
  log_fail "在线 Git HEAD 未切换至 Commit B！当前为 ${CURRENT_HEAD}"
fi

# 2) 验证不可变版本库与单一原子符号链接指针
if [ ! -L ".releases/current" ]; then
  log_fail ".releases/current 必须是原子符号链接指针！"
fi
CURRENT_TARGET="$(readlink .releases/current)"
if [ "${CURRENT_TARGET}" != "store/${COMMIT_B}" ]; then
  log_fail ".releases/current 必须指向 store/${COMMIT_B}，实际指向: ${CURRENT_TARGET}"
fi

# 3) 验证在线产物瞬间一致性
if ! grep -q "SERVER_V2" dist/index.js; then
  log_fail "在线 dist/index.js 未更新至 SERVER_V2！"
fi
if ! grep -q "WEB_V2" web/dist/index.html; then
  log_fail "在线 web/dist/index.html 未更新至 WEB_V2！"
fi
if ! grep -q "RUNNER_V2" container/agent-runner/dist/runner.js; then
  log_fail "在线 runner 未更新至 RUNNER_V2！"
fi

# 4) 验证 .env 无副本原地更新且包含 SKIP 迁移备份
if [ -f ".env.bak" ] || [ -f ".env.tmp" ]; then
  log_fail "发布过程中生成了被严禁的 .env 备份文件！"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_B}" .env; then
  log_fail ".env 未更新为目标不可变镜像！"
fi
if ! grep -q "HAPPYCLAW_SKIP_MIGRATION_BACKUP=1" .env; then
  log_fail ".env 未强制配置 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1！"
fi
ENV_PERM="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo '')"
if [ "${ENV_PERM}" != "600" ]; then
  log_fail ".env 权限非 600 (实际: ${ENV_PERM})"
fi

log_pass "场景 4 通过：单步原子指针切换成功，三包同时生效，.env 原地无副本更新！"

# --- 场景 5: 原子回滚测试 ---
log_test "场景 5: 执行回滚脚本，单步原子指针切换回上一版本"
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/rollback-release.sh "${COMMIT_A}"

CURRENT_HEAD="$(git rev-parse HEAD)"
if [ "${CURRENT_HEAD}" != "${COMMIT_A}" ]; then
  log_fail "回滚后 Git HEAD 未恢复至 Commit A！实际为: ${CURRENT_HEAD}"
fi
CURRENT_TARGET="$(readlink .releases/current)"
if [ "${CURRENT_TARGET}" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 .releases/current 未原子切换回 store/${COMMIT_A}！实际为: ${CURRENT_TARGET}"
fi
assert_online_is_v1 "回滚后"
log_pass "场景 5 通过：单步原子指针瞬间回滚成功，三包产物与代码严格一致！"

log_test "=== R11 全套原子发布与故障窗口隔离测试 100% 通过！ ==="
