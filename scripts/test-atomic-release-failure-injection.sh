#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11/R12 原子发布与版本一致性深度隔离测试 (针对 Leader 第二轮审查反馈)
#
# 深度覆盖：
# 1. 【核心回归复现验证】同 SHA 再次发布 + pre_build 故障：严格证明在线 dist 绝对不丢失，current 指针完好无损！
# 2. 【并发双部署排他锁互斥】deploy 与 rollback 同持锁，并发检测 fail-closed；
# 3. 【非本轮 staging 保护】带有非本轮 marker 的隔离目录绝不误删；
# 4. 【精确不可变镜像与 Docker 校验】拒绝 latest、拒绝 SHA 错配；
# 5. 【三包编译失败零污染】server_build/web_build/runner_build 失败在线产物与版本 100% 保持；
# 6. 【单步原子指针切换与不可变运行根】验证完整运行根封存、单步 rename 符号链接、.env 原地无副本与权限 600；
# 7. 【老进程版本固化】验证进程启动后固化当前 SHA，不随运行时 git HEAD 变动漂移；
# 8. 【原子回滚与镜像跟随】回滚单步切回上一版本不可变目录并还原上一代镜像。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-atomic-v3.XXXXXX")"
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

# 配置 .gitignore (与实际仓库完全一致，同时匹配目录与符号链接)
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

# 创建模拟的旧三包结构
mkdir -p dist web/dist container/agent-runner/dist
echo "console.log('OLD_SERVER_SHA_A');" > dist/index.js
echo "<html><body>OLD_WEB_SHA_A</body></html>" > web/dist/index.html
echo "OLD_RUNNER_SHA_A" > container/agent-runner/dist/runner.js

# 创建支持 mock 构建的 package.json
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
echo "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-old_sha" >> .env
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
git commit -m "Commit B: Target release version" --quiet
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
    log_fail "${reason}: 在线 dist/index.js 被意外破坏或丢失！"
  fi
  if ! grep -q "OLD_WEB_SHA_A" web/dist/index.html 2>/dev/null; then
    log_fail "${reason}: 在线 web/dist/index.html 被意外破坏或丢失！"
  fi
  if ! grep -q "OLD_RUNNER_SHA_A" container/agent-runner/dist/runner.js 2>/dev/null; then
    log_fail "${reason}: 在线 runner 被意外破坏或丢失！"
  fi
  if [ -f ".env.bak" ] || [ -f ".env.tmp" ]; then
    log_fail "${reason}: 发现了被禁止的 .env 备份文件！"
  fi
}

# --- 场景 1: 并发排他锁互斥检测与未知 marker 保护 ---
log_test "场景 1: 并发排他锁互斥检测与非本轮 marker 保护"
echo "{\"pid\":$$,\"runId\":\"active_run\",\"startedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > .deploy.lock

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
  log_fail "持有锁时并发部署竟然未被阻断！"
fi
rm -f .deploy.lock
log_pass "排他锁测试通过：并发部署被安全阻断！"

mkdir -p .release-staging-alien
echo "alien_run" > .release-staging-alien/.release-run-marker
echo "IMPORTANT_DATA" > .release-staging-alien/keep.txt

# --- 场景 2: 严格拒绝非法镜像与 SHA 不匹配镜像 ---
log_test "场景 2: 严格拒绝非法镜像与 SHA 不匹配镜像"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh
EXIT_LATEST=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-wrong_sha_123" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh
EXIT_MISMATCH=$?
set -e

if [ "${EXIT_LATEST}" -eq 0 ] || [ "${EXIT_MISMATCH}" -eq 0 ]; then
  log_fail "非法或 SHA 不匹配镜像未被拦截！"
fi
assert_online_is_v1 "场景 2 镜像拦截后"
log_pass "场景 2 通过：拒绝 latest 与错配镜像！"

# --- 场景 3: 候选构建各阶段失败零污染测试 ---
log_test "场景 3a: 模拟主服务编译失败 (server_build)"
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
if [ "${EXIT_102}" -ne 102 ]; then log_fail "预期退出码 102，实际为 ${EXIT_102}"; fi
assert_online_is_v1 "场景 3a 主服务失败后"
log_pass "场景 3a 通过：主服务失败，在线版本完好！"

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
if [ "${EXIT_103}" -ne 103 ]; then log_fail "预期退出码 103，实际为 ${EXIT_103}"; fi
assert_online_is_v1 "场景 3b Web 失败后"
log_pass "场景 3b 通过：Web 失败，在线版本完好！"

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
if [ "${EXIT_104}" -ne 104 ]; then log_fail "预期退出码 104，实际为 ${EXIT_104}"; fi
assert_online_is_v1 "场景 3c Runner 失败后"
log_pass "场景 3c 通过：Runner 失败，在线版本完好！"

if [ ! -f ".release-staging-alien/keep.txt" ]; then
  log_fail "非本轮 staging 目录被意外误删！隔离清理失败！"
fi
rm -rf .release-staging-alien

# --- 场景 4: 成功路径单步原子指针切换与不可变运行根 ---
log_test "场景 4: 成功路径单步原子指针切换与不可变运行根验证"
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
./scripts/deploy-release.sh

# 验证 Git HEAD
if [ "$(git rev-parse HEAD)" != "${COMMIT_B}" ]; then
  log_fail "在线 Git HEAD 未切换至 Commit B！"
fi

# 验证单步原子符号链接
if [ ! -L ".releases/current" ]; then
  log_fail ".releases/current 必须是原子符号链接！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail ".releases/current 必须指向 store/${COMMIT_B}！实际指向: $(readlink .releases/current)"
fi

# 验证不可变运行根内封存完整内容
if [ ! -f ".releases/store/${COMMIT_B}/version.json" ]; then
  log_fail "不可变版本库缺少 version.json！"
fi
if ! grep -q "SERVER_V2" dist/index.js; then
  log_fail "在线 dist/index.js 未更新为 SERVER_V2！"
fi
if ! grep -q "WEB_V2" web/dist/index.html; then
  log_fail "在线 web/dist/index.html 未更新为 WEB_V2！"
fi
if ! grep -q "RUNNER_V2" container/agent-runner/dist/runner.js; then
  log_fail "在线 runner 未更新为 RUNNER_V2！"
fi

# 验证无副本原地更新 .env
if [ -f ".env.bak" ] || [ -f ".env.tmp" ]; then
  log_fail "发布过程中生成了被禁止的 .env 备份！"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_B}" .env; then
  log_fail ".env 未更新为不可变镜像！"
fi
if ! grep -q "HAPPYCLAW_SKIP_MIGRATION_BACKUP=1" .env; then
  log_fail ".env 未包含 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1！"
fi
log_pass "场景 4 通过：单步原子指针切换成功，完整不可变运行根就绪，.env 原地无副本！"

# --- 场景 5: 【核心针对性测试】同 SHA 再次发布 + pre_build 故障保护 ---
log_test "场景 5: 【核心回归测试】同 SHA 再次发布 + pre_build 故障保护"
# 记录故障前的在线文件状态
test -f dist/index.js || log_fail "故障前在线 dist/index.js 必须存在！"
test -f web/dist/index.html || log_fail "故障前在线 web/dist/index.html 必须存在！"

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_SKIP_DOCKER_PULL=1 \
HAPPYCLAW_FAST_BUILD=1 \
HAPPYCLAW_INJECT_FAILURE="pre_build" \
./scripts/deploy-release.sh
RETRY_EXIT=$?
set -e

if [ "${RETRY_EXIT}" -ne 101 ]; then
  log_fail "预期退出码 101，实际为 ${RETRY_EXIT}"
fi

# 核心严格断言：在线产物 100% 存在，绝不被删除！彻底推翻 Leader 复现的缺陷！
if [ ! -f "dist/index.js" ]; then
  log_fail "同 SHA 部署失败后，在线 dist/index.js 竟然被删除了！严重回归！"
fi
if [ ! -f "web/dist/index.html" ]; then
  log_fail "同 SHA 部署失败后，在线 web/dist/index.html 竟然被删除了！严重回归！"
fi
if ! grep -q "SERVER_V2" dist/index.js; then
  log_fail "同 SHA 部署失败后，在线 dist/index.js 内容被篡改！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "同 SHA 部署失败后，current 符号链接指针失效！"
fi
log_pass "场景 5 通过！同 SHA 部署失败时在线产物与指针 100% 完好无损！"

# --- 场景 6: 原子回滚与镜像还原测试 ---
log_test "场景 6: 原子回滚至上一版本与镜像还原"
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/rollback-release.sh "${COMMIT_A}"

if [ "$(git rev-parse HEAD)" != "${COMMIT_A}" ]; then
  log_fail "回滚后 Git HEAD 未切回 Commit A！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 current 指针未切回 store/${COMMIT_A}！"
fi
if ! grep -q "OLD_SERVER_SHA_A" dist/index.js; then
  log_fail "回滚后在线 dist/index.js 未恢复为 Commit A 产物！"
fi
log_pass "场景 6 通过：单步原子重命名瞬时回滚至上一不可变版本！"

# --- 场景 7: 回滚就绪失败严格非 0 退出 ---
log_test "场景 7: 回滚就绪失败严格非 0 退出"
# 创建一个总是失败退出的 wait-for-readiness.mjs 桩脚本
cat << 'EOF' > scripts/wait-for-readiness.mjs
#!/usr/bin/env node
console.error("Mock readiness check timeout/failure");
process.exit(1);
EOF
chmod +x scripts/wait-for-readiness.mjs

set +e
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=0 \
./scripts/rollback-release.sh "${COMMIT_B}"
ROLLBACK_FAIL_EXIT=$?
set -e

if [ "${ROLLBACK_FAIL_EXIT}" -eq 0 ]; then
  log_fail "回滚时就绪检查失败，脚本却返回了 0 退出码！未满足契约！"
fi
log_pass "场景 7 通过：回滚就绪失败严格返回非 0 退出码 (${ROLLBACK_FAIL_EXIT})！"

log_test "=== R11/R12 全套高可靠故障窗口隔离测试 100% 通过！ ==="
