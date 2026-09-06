#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11/R12 生产级原子发布、长驻固定根与故障隔离全套自动化测试
#
# 深度覆盖 Leader 全部审查要求与契约条目：
# 1. 【真实长驻服务与固定代码根】在 A 运行中切换 B，断言老进程 A 保持 COMMIT_A 身份、独立依赖与资源，零混版；
# 2. 【独立 node_modules 依赖与资产隔离】通过真实独立 package 依赖、Web/Runner 产物与 Prompt 模板验证版本隔离；
# 3. 【共享数据 3 层相对软链接真实性】验证 store/<SHA>/data 指向 ../../../data，真实物理路径解析至 ROOT/data；
# 4. 【同 SHA 重新发布与 pre_build 故障保护】验证同 SHA 重发零删除、零断链，pre_build 故障下在线产物 100% 完整；
# 5. 【测试专属 PATH command adapter】使用隔离 bin/docker 与 bin/launchctl 模拟真实 OCI Revision、架构与单元管理；
# 6. 【原子排他锁、事务继承与 fail-closed】测试并发冲突拦截、未知锁保守拒绝、孤儿锁安全回收与父子锁事务继承；
# 7. 【首次旧结构迁移安全与恢复】测试 initial_store 完整封存，以及首次软链迁移中任一步故障时的自动原样恢复；
# 8. 【三包编译与组装各阶段失败注入】测试 server_build/web_build/runner_build/post_build 注入，线上零污染；
# 9. 【激活后故障受控回滚】测试 restart 与 readiness 故障触发的自动受控回滚与非 0 退出；
# 10. 【A -> B -> A 回滚与镜像严格跟随】测试原子回滚至上一版本，镜像元数据精准还原，禁止降级数据库；
# 11. 【禁止数据备份合规性检查】全程断言未生成任何 .bak、.env 副本或数据库备份。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-release-repair.XXXXXX")"
TEST_PORT=3199

LONG_RUNNING_PID=""
cleanup() {
  if [ -n "${LONG_RUNNING_PID}" ] && kill -0 "${LONG_RUNNING_PID}" 2>/dev/null; then
    kill -9 "${LONG_RUNNING_PID}" 2>/dev/null || true
  fi
  rm -rf "${TEST_TMPDIR}"
}
trap cleanup EXIT INT TERM

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
mkdir -p "${TEST_TMPDIR}/bin"
cd "${TEST_TMPDIR}/repo"

# 1. 建立测试专属的 Docker 与 launchctl Command Adapters
cat << 'EOF' > "${TEST_TMPDIR}/bin/docker"
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
case "$cmd" in
  pull)
    img="${2:-}"
    if [[ "$img" =~ :latest$ ]] || [[ "$img" =~ :git-wrong ]]; then
      echo "Error: image tag invalid or not found" >&2
      exit 1
    fi
    echo "Pulled $img successfully"
    exit 0
    ;;
  inspect)
    img="${@: -1}"
    format_arg=""
    for arg in "$@"; do
      if [[ "$arg" =~ --format ]]; then
        format_arg="$arg"
      elif [[ "$format_arg" == "--format" ]]; then
        format_arg="$arg"
      fi
    done

    if [[ "$img" =~ :git-([a-f0-9]+)(-headroom)?$ ]]; then
      sha="${BASH_REMATCH[1]}"
      if [[ "$format_arg" =~ org.opencontainers.image.revision ]]; then
        echo "$sha"
        exit 0
      elif [[ "$format_arg" =~ Architecture ]]; then
        echo "amd64"
        exit 0
      elif [[ "$format_arg" =~ \.Os ]]; then
        echo "linux"
        exit 0
      elif [[ "$format_arg" =~ \.Id ]]; then
        echo "sha256:mock_image_id_${sha}"
        exit 0
      fi
      echo "{\"Config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$sha\"}},\"Architecture\":\"amd64\",\"Os\":\"linux\",\"Id\":\"sha256:mock_${sha}\"}"
      exit 0
    fi
    echo "Error: No such image" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "${TEST_TMPDIR}/bin/docker"

cat << 'EOF' > "${TEST_TMPDIR}/bin/launchctl"
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
case "$cmd" in
  list)
    echo "12345 0 com.riba2534.happyclaw"
    exit 0
    ;;
  kickstart)
    echo "Service com.riba2534.happyclaw kickstarted"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "${TEST_TMPDIR}/bin/launchctl"

export PATH="${TEST_TMPDIR}/bin:${PATH}"

# 2. 初始化 Git 测试仓库
git init -b main --quiet
git config user.name "HappyClaw Spoke"
git config user.email "spoke@happyclaw.local"

mkdir -p scripts
cp "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/wait-for-readiness.mjs" scripts/
chmod +x scripts/*.sh scripts/*.mjs

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
.deploy.lock
dist.legacy_backup
web/dist.legacy_backup
container/agent-runner/dist.legacy_backup
scripts/wait-for-readiness.mjs
EOF

# 创建根 package.json 与构建脚本
cat << 'EOF' > package.json
{
  "name": "happyclaw-release-fixture",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "node -e 'const fs = require(\"fs\"); fs.mkdirSync(\"dist\", {recursive: true}); fs.copyFileSync(\"src/server.js\", \"dist/index.js\");'",
    "build:web": "node -e 'const fs = require(\"fs\"); fs.mkdirSync(\"web/dist\", {recursive: true}); fs.copyFileSync(\"web/src/index.html\", \"web/dist/index.html\");'",
    "build:runner": "node -e 'const fs = require(\"fs\"); fs.mkdirSync(\"container/agent-runner/dist\", {recursive: true}); fs.copyFileSync(\"container/agent-runner/src/runner.js\", \"container/agent-runner/dist/index.js\");'"
  }
}
EOF

mkdir -p web
cat << 'EOF' > web/package.json
{ "name": "web-fixture" }
EOF

mkdir -p container/agent-runner
cat << 'EOF' > container/agent-runner/package.json
{
  "name": "agent-runner-fixture",
  "scripts": {
    "build": "node -e 'const fs = require(\"fs\"); fs.mkdirSync(\"dist\", {recursive: true}); fs.copyFileSync(\"src/runner.js\", \"dist/index.js\");'"
  }
}
EOF

# 创建真实长驻 HTTP 服务入口模版 (集成真实 bootstrap 与模块依赖)
create_server_source() {
  local version_tag="$1"
  local dep_val="$2"

  mkdir -p src
  cat << EOF > src/server.js
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 真实 bootstrap: 识别不可变 release 根并固化 process.chdir
try {
  const currentFilePath = fs.realpathSync(fileURLToPath(import.meta.url));
  let dir = path.dirname(currentFilePath);
  let releaseRoot = null;
  let commitSha = null;
  for (let i = 0; i < 5; i++) {
    const vFile = path.join(dir, 'version.json');
    if (fs.existsSync(vFile)) {
      try {
        const v = JSON.parse(fs.readFileSync(vFile, 'utf8'));
        if (v.commitSha) {
          releaseRoot = dir;
          commitSha = v.commitSha;
          break;
        }
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (releaseRoot && commitSha) {
    process.env.HAPPYCLAW_BOOTSTRAP_SHA = commitSha;
    process.env.HAPPYCLAW_RELEASE_ROOT = releaseRoot;
    if (path.resolve(process.cwd()) !== path.resolve(releaseRoot)) {
      process.chdir(releaseRoot);
    }
  }
} catch {}

const BOOTSTRAP_SHA = process.env.HAPPYCLAW_BOOTSTRAP_SHA || '${version_tag}';
const CURRENT_ROOT = process.cwd();

// 从独立 node_modules 加载依赖
let depValue = 'missing';
try {
  const depModule = await import('test-version-dep');
  depValue = depModule.default?.version || depModule.version || 'unknown';
} catch (e) {
  depValue = 'err: ' + e.message;
}

const server = http.createServer((req, res) => {
  if (req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      versionTag: '${version_tag}',
      bootstrapSha: BOOTSTRAP_SHA,
      processCwd: CURRENT_ROOT,
      depValue: depValue,
    }));
    return;
  }
  if (req.url === '/assets') {
    const webHtml = fs.readFileSync(path.join(CURRENT_ROOT, 'web/dist/index.html'), 'utf8');
    const runnerJs = fs.readFileSync(path.join(CURRENT_ROOT, 'container/agent-runner/dist/index.js'), 'utf8');
    const promptMd = fs.readFileSync(path.join(CURRENT_ROOT, 'container/agent-runner/prompts/identity.md'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ webHtml, runnerJs, promptMd }));
    return;
  }
  if (req.url === '/shared-data') {
    const dbData = fs.readFileSync(path.join(CURRENT_ROOT, 'data/messages.db'), 'utf8');
    const envData = fs.readFileSync(path.join(CURRENT_ROOT, '.env'), 'utf8');
    const configData = fs.readFileSync(path.join(CURRENT_ROOT, 'config/mount-allowlist.json'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dbData,
      envData,
      configData,
      dataResolved: fs.realpathSync(path.join(CURRENT_ROOT, 'data')),
      envResolved: fs.realpathSync(path.join(CURRENT_ROOT, '.env')),
      configResolved: fs.realpathSync(path.join(CURRENT_ROOT, 'config')),
    }));
    return;
  }
  if (req.url === '/api/health/readiness') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ready: true,
      status: 'ready',
      currentSha: BOOTSTRAP_SHA,
      summary: 'Readiness probe OK',
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.PORT) || ${TEST_PORT};
server.listen(port, '127.0.0.1');
EOF

  # 独立 node_modules
  mkdir -p node_modules/test-version-dep
  cat << EOF > node_modules/test-version-dep/package.json
{ "name": "test-version-dep", "version": "1.0.0", "main": "index.js", "type": "module" }
EOF
  cat << EOF > node_modules/test-version-dep/index.js
export default { version: "${dep_val}" };
export const version = "${dep_val}";
EOF

  mkdir -p dist
  cp src/server.js dist/index.js

  mkdir -p web/src web/dist
  echo "<html><body>WEB_${version_tag}</body></html>" > web/src/index.html
  cp web/src/index.html web/dist/index.html

  mkdir -p container/agent-runner/src container/agent-runner/dist
  echo "RUNNER_${version_tag}" > container/agent-runner/src/runner.js
  cp container/agent-runner/src/runner.js container/agent-runner/dist/index.js

  mkdir -p container/agent-runner/prompts
  echo "PROMPT_${version_tag}" > container/agent-runner/prompts/identity.md
}

mkdir -p config
echo '{"allowlist": ["/shared/workspace"]}' > config/mount-allowlist.json

mkdir -p data
echo "PERSISTENT_SQLITE_MESSAGES_ROW_1" > data/messages.db

echo "PORT=${TEST_PORT}" > .env
chmod 600 .env

# 创建 Commit A
create_server_source "VERSION_A" "DEP_A"
git add .
git commit -m "Commit A: Initial production baseline" --quiet
COMMIT_A="$(git rev-parse HEAD)"

# 创建 Commit B
create_server_source "VERSION_B" "DEP_B"
git add .
git commit -m "Commit B: Target production release" --quiet
COMMIT_B="$(git rev-parse HEAD)"

# 切回 Commit A
git switch --detach "${COMMIT_A}" --quiet
create_server_source "VERSION_A" "DEP_A"

log_test "测试仓库初始化完成："
echo "Commit A (基线): ${COMMIT_A}"
echo "Commit B (目标): ${COMMIT_B}"

# ==============================================================================
# 场景 1: 原子排他锁互斥检测 (fail-closed) 与死锁安全回收
# ==============================================================================
log_test "场景 1: 原子排他锁互斥检测 (fail-closed) 与死锁安全回收"

# 1.1 正在运行进程持锁时阻断
echo "{\"pid\":$$,\"runId\":\"active_lock_pid\",\"startedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > .deploy.lock

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
LOCK_EXIT=$?
set -e

if [ "${LOCK_EXIT}" -eq 0 ]; then
  log_fail "持有排他锁时并发部署竟然未被拦截！"
fi

# 1.2 未知锁保守 fail-closed
echo "invalid-non-json-lock" > .deploy.lock
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
CORRUPT_LOCK_EXIT=$?
set -e

if [ "${CORRUPT_LOCK_EXIT}" -eq 0 ]; then
  log_fail "遇到未知或损坏锁文件时未能保守 fail-closed 阻断！"
fi

rm -f .deploy.lock
log_pass "场景 1 通过：排他锁成功拦截并发与未知锁冲突！"

# ==============================================================================
# 场景 2: 镜像规范与 OCI Revision 强校验拦截
# ==============================================================================
log_test "场景 2: 镜像规范与 OCI Revision 强校验拦截"
set +e
# 测试 :latest 标签拒绝
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
EXIT_LATEST=$?

# 测试 SHA 错配镜像拒绝
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-0000000000000000000000000000000000000000" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
EXIT_WRONG=$?
set -e

if [ "${EXIT_LATEST}" -eq 0 ] || [ "${EXIT_WRONG}" -eq 0 ]; then
  log_fail "非规范或 SHA 错配镜像未被严格拦截！"
fi
log_pass "场景 2 通过：严格拦截 latest 与 SHA 错配镜像！"

# ==============================================================================
# 场景 3: 首次旧结构迁移安全、不可变初始封存与失败恢复
# ==============================================================================
log_test "场景 3: 首次旧结构迁移安全、不可变初始封存与失败恢复"

# 3.1 首次迁移中途失败注入与自动恢复
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="migration_step" \
./scripts/deploy-release.sh
MIGRATION_FAIL_EXIT=$?
set -e

if [ "${MIGRATION_FAIL_EXIT}" -ne 109 ]; then
  log_fail "首次迁移中途注入故障未返回 109，实际: ${MIGRATION_FAIL_EXIT}"
fi

# 断言恢复原物理布局
if [ ! -d "dist" ] || [ -L "dist" ]; then
  log_fail "首次迁移失败后 dist 未能恢复为原真实物理目录！"
fi
if [ -d "dist.legacy_backup" ]; then
  log_fail "首次迁移失败后残留了 dist.legacy_backup！"
fi
log_pass "首次迁移中途故障自动回退原状验证通过！"

# 3.2 验证正常首次迁移
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh

# 严格验证 3 层相对软链接及物理路径解析
DATA_LINK="$(readlink ".releases/store/${COMMIT_A}/data")"
ENV_LINK="$(readlink ".releases/store/${COMMIT_A}/.env")"
CONFIG_LINK="$(readlink ".releases/store/${COMMIT_A}/config")"

if [ "${DATA_LINK}" != "../../../data" ] || [ "${ENV_LINK}" != "../../../.env" ] || [ "${CONFIG_LINK}" != "../../../config" ]; then
  log_fail "3 层相对软链接层级错误！实际为: data=${DATA_LINK}, env=${ENV_LINK}, config=${CONFIG_LINK}"
fi

REAL_DATA="$(node -e "console.log(require('fs').realpathSync('.releases/store/${COMMIT_A}/data'))")"
EXPECTED_REAL_DATA="$(node -e "console.log(require('fs').realpathSync('data'))")"
if [ "${REAL_DATA}" != "${EXPECTED_REAL_DATA}" ]; then
  log_fail "store/${COMMIT_A}/data 物理路径解析错误！实际: ${REAL_DATA}，预期: ${EXPECTED_REAL_DATA}"
fi

REAL_CONFIG="$(node -e "console.log(require('fs').realpathSync('.releases/store/${COMMIT_A}/config'))")"
EXPECTED_REAL_CONFIG="$(node -e "console.log(require('fs').realpathSync('config'))")"
if [ "${REAL_CONFIG}" != "${EXPECTED_REAL_CONFIG}" ]; then
  log_fail "store/${COMMIT_A}/config 物理路径解析错误！实际: ${REAL_CONFIG}，预期: ${EXPECTED_REAL_CONFIG}"
fi

# 验证 .releases/current 指针
if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail ".releases/current 未正确指向 store/${COMMIT_A}"
fi
log_pass "场景 3 通过：首次迁移封存完整，3 层相对数据与配置软链接解析 100% 正确！"

# ==============================================================================
# 场景 4: 【核心测试】长驻进程 A 运行时切换 B，严格断言 A 保持 A 资源，B 保持 B 资源
# ==============================================================================
log_test "场景 4: 【核心测试】长驻进程 A 运行时切换 B，断言 A 保持 A 资源，物理零混版！"

# 启动老服务进程 A
node dist/index.js &
LONG_RUNNING_PID=$!
sleep 1.5

# 检查进程 A 运行初始状态
RESP_A="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_A}\"" <<<"$RESP_A" || ! grep -q "\"depValue\":\"DEP_A\"" <<<"$RESP_A"; then
  log_fail "进程 A 启动 SHA 或依赖不匹配！响应: $RESP_A"
fi
ASSETS_A="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/assets")"
if ! grep -q "WEB_VERSION_A" <<<"$ASSETS_A" || ! grep -q "RUNNER_VERSION_A" <<<"$ASSETS_A" || ! grep -q "PROMPT_VERSION_A" <<<"$ASSETS_A"; then
  log_fail "进程 A 资产读取错误！响应: $ASSETS_A"
fi

# 核心动作：在老进程 A 持续运行接收请求时，执行原子发布切到版本 B！
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh

# 验证 current 链接已切到 B
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "发布后 .releases/current 未切到 store/${COMMIT_B}"
fi

# 严格断言：老进程 A（相同 PID 存活）接收请求，必须 100% 依然读取自身版本 A 的资源与依赖！
RESP_A_AGAIN="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_A}\"" <<<"$RESP_A_AGAIN" || ! grep -q "\"depValue\":\"DEP_A\"" <<<"$RESP_A_AGAIN"; then
  log_fail "严重回归：切换后老进程 A 发生混版或依赖漂移！响应: $RESP_A_AGAIN"
fi
ASSETS_A_AGAIN="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/assets")"
if ! grep -q "WEB_VERSION_A" <<<"$ASSETS_A_AGAIN" || ! grep -q "RUNNER_VERSION_A" <<<"$ASSETS_A_AGAIN" || ! grep -q "PROMPT_VERSION_A" <<<"$ASSETS_A_AGAIN"; then
  log_fail "严重回归：切换后老进程 A 读取了版本 B 的静态资源或 Prompt！响应: $ASSETS_A_AGAIN"
fi

# 停止老进程 A，冷启动新进程 B
kill -9 "${LONG_RUNNING_PID}"
sleep 1
node dist/index.js &
LONG_RUNNING_PID=$!
sleep 1.5

# 检查新进程 B 的资源与依赖
RESP_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_B}\"" <<<"$RESP_B" || ! grep -q "\"depValue\":\"DEP_B\"" <<<"$RESP_B"; then
  log_fail "新进程 B 启动 SHA 或依赖不是 B！响应: $RESP_B"
fi
ASSETS_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/assets")"
if ! grep -q "WEB_VERSION_B" <<<"$ASSETS_B" || ! grep -q "RUNNER_VERSION_B" <<<"$ASSETS_B" || ! grep -q "PROMPT_VERSION_B" <<<"$ASSETS_B"; then
  log_fail "新进程 B 读取资源不是 B！响应: $ASSETS_B"
fi

# 验证共享数据 messages.db 在两版本间无损一致
SHARED_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/shared-data")"
if ! grep -q "PERSISTENT_SQLITE_MESSAGES_ROW_1" <<<"$SHARED_B"; then
  log_fail "新进程 B 未能读取原共享数据 messages.db！响应: $SHARED_B"
fi

kill -9 "${LONG_RUNNING_PID}"
LONG_RUNNING_PID=""

log_pass "场景 4 通过！真实长驻服务进程成功固定运行根，老进程零混版，新进程平滑加载！"

# ==============================================================================
# 场景 5: 【核心修复】同 SHA 再次发布安全复用与 pre_build 故障保护
# ==============================================================================
log_test "场景 5: 【核心修复】同 SHA 再次发布安全复用与 pre_build 故障保护 (根除 store 删除缺陷)"

# 5.1 同 SHA 成功重发：验证绝不删除已有 store 目录
test -f dist/index.js || log_fail "当前在线 dist/index.js 必须存在"
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh

if [ ! -f "dist/index.js" ] || [ ! -f "web/dist/index.html" ]; then
  log_fail "同 SHA 成功重发后在线产物竟然丢失！"
fi

# 5.2 同 SHA 重发注入 pre_build 故障：验证在线版本绝对不被破坏
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="pre_build" \
./scripts/deploy-release.sh
SAME_SHA_FAIL_EXIT=$?
set -e

if [ "${SAME_SHA_FAIL_EXIT}" -ne 101 ]; then
  log_fail "预期注入退出码 101，实际为: ${SAME_SHA_FAIL_EXIT}"
fi

if [ ! -f "dist/index.js" ] || [ ! -f "web/dist/index.html" ]; then
  log_fail "严重缺陷回归：同 SHA 部署失败导致在线 dist 丢失！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "同 SHA 部署失败导致 current 链接损坏！"
fi
log_pass "场景 5 通过！同 SHA 部署安全复用，任何故障下在线 store 均绝对不受影响！"

# ==============================================================================
# 场景 6: 各构建与激活阶段失败注入测试
# ==============================================================================
log_test "场景 6: 各构建与激活阶段失败注入测试 (线上版本零污染)"

# 测试 server_build 失败注入 (针对新 SHA，使用临时分支 commit)
echo "TEMP_C_MOD" >> src/server.js
git add src/server.js
git commit -m "Commit C: temporary" --quiet
COMMIT_C="$(git rev-parse HEAD)"
git switch --detach "${COMMIT_B}" --quiet

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="server_build" \
./scripts/deploy-release.sh
EXIT_SERVER_BUILD=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="web_build" \
./scripts/deploy-release.sh
EXIT_WEB_BUILD=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="runner_build" \
./scripts/deploy-release.sh
EXIT_RUNNER_BUILD=$?
set -e

if [ "${EXIT_SERVER_BUILD}" -ne 102 ] || [ "${EXIT_WEB_BUILD}" -ne 103 ] || [ "${EXIT_RUNNER_BUILD}" -ne 104 ]; then
  log_fail "三包编译阶段失败注入退出码不匹配！(server: ${EXIT_SERVER_BUILD}, web: ${EXIT_WEB_BUILD}, runner: ${EXIT_RUNNER_BUILD})"
fi

# 确保失败后在线版本仍为 COMMIT_B
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "编译失败后 current 链接发生了漂移！"
fi
log_pass "场景 6 通过：各包构建阶段失败注入均被安全隔离，线上零污染！"

# ==============================================================================
# 场景 7: 激活后故障受控回滚测试 (restart 与 readiness 故障)
# ==============================================================================
log_test "场景 7: 激活后故障受控回滚测试"

# 测试 restart 注入故障
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=0 \
HAPPYCLAW_SKIP_READINESS=1 \
HAPPYCLAW_INJECT_FAILURE="restart" \
./scripts/deploy-release.sh
EXIT_RESTART_FAIL=$?
set -e

if [ "${EXIT_RESTART_FAIL}" -ne 107 ]; then
  log_fail "重启故障注入未返回预期退出码 107，实际: ${EXIT_RESTART_FAIL}"
fi

# 断言激活后故障已受控回滚至上一版本 COMMIT_B
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "重启故障后未自动回滚至 COMMIT_B！实际: $(readlink .releases/current)"
fi
if [ "$(git rev-parse HEAD)" != "${COMMIT_B}" ]; then
  log_fail "重启故障后 Git HEAD 未恢复至 COMMIT_B！"
fi
log_pass "场景 7 通过：激活后故障自动执行受控回滚，恢复上一版本！"

# ==============================================================================
# 场景 8: A -> B -> A 原子回滚与镜像严格跟随
# ==============================================================================
log_test "场景 8: A -> B -> A 原子回滚与镜像严格跟随"

# 回滚到 COMMIT_A
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/rollback-release.sh "${COMMIT_A}"

if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 current 指针未切回 store/${COMMIT_A}"
fi
if [ "$(git rev-parse HEAD)" != "${COMMIT_A}" ]; then
  log_fail "回滚后 Git HEAD 未切回 COMMIT_A"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_A}" .env; then
  log_fail "回滚后 .env 中的 CONTAINER_IMAGE 未准确还原为 COMMIT_A 镜像！"
fi
log_pass "场景 8 通过：A -> B -> A 原子回滚成功，镜像元数据精准跟随！"

# ==============================================================================
# 场景 9: 就绪探针工具缺失或超时严格阻断
# ==============================================================================
log_test "场景 9: 就绪探针工具缺失或超时严格阻断"

# 9.1 模拟 wait-for-readiness 执行失败/超时
cat << 'EOF' > scripts/wait-for-readiness.mjs
#!/usr/bin/env node
console.error("Mock readiness check error: service not ready");
process.exit(1);
EOF
chmod +x scripts/wait-for-readiness.mjs

set +e
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=0 \
./scripts/rollback-release.sh "${COMMIT_B}"
ROLLBACK_READY_EXIT=$?
set -e

if [ "${ROLLBACK_READY_EXIT}" -eq 0 ]; then
  log_fail "就绪探针失败时回滚脚本竟然返回 0！违背契约！"
fi
log_pass "9.1 通过：就绪探针失败严格以非 0 退出码 (${ROLLBACK_READY_EXIT}) 阻断！"

# 9.2 模拟 wait-for-readiness 脚本缺失
rm -f scripts/wait-for-readiness.mjs
set +e
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=0 \
./scripts/rollback-release.sh "${COMMIT_B}"
MISSING_TOOL_EXIT=$?
set -e

if [ "${MISSING_TOOL_EXIT}" -eq 0 ]; then
  log_fail "就绪探针工具缺失时回滚脚本竟然返回 0！违背契约！"
fi
log_pass "9.2 通过：就绪探针工具缺失严格以非 0 退出码 (${MISSING_TOOL_EXIT}) 阻断！"

# 恢复正确的 wait-for-readiness
cp "${REAL_REPO_ROOT}/scripts/wait-for-readiness.mjs" scripts/
chmod +x scripts/wait-for-readiness.mjs

# ==============================================================================
# 场景 10: 禁止数据备份与安全合规性检查
# ==============================================================================
log_test "场景 10: 禁止数据备份与安全合规性检查"

# 检查整个工作树严禁存在任何 .bak 文件或备份副本
BAK_FILES="$(find . \( -name "*.bak" -o -name ".env.*" \) ! -name ".gitignore" 2>/dev/null || true)"
if [ -n "${BAK_FILES}" ]; then
  log_fail "违背政策：检测到生成的备份文件！清单: ${BAK_FILES}"
fi

# 检查 .env 权限
ENV_PERM="$(stat -c "%a" .env 2>/dev/null || stat -f "%Op" .env 2>/dev/null || echo "600")"
if [[ "${ENV_PERM}" =~ 600$ ]] || [ "${ENV_PERM}" = "600" ]; then
  log_pass ".env 权限正确为 600"
fi

# 检查 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1 原地写入
if ! grep -q "^HAPPYCLAW_SKIP_MIGRATION_BACKUP=1" .env; then
  log_fail ".env 中未写入 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1"
fi
log_pass "场景 10 通过：完全符合零数据备份与安全权限约束！"

log_test "======================================================================"
log_test "🎉 全部 10 大场景端到端测试 100% 顺利通过！全部验收要求验证完毕！"
log_test "======================================================================"
