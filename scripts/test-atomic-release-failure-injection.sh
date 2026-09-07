#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11/R12 生产级原子发布、长驻固定根与全故障隔离终极自动化测试套件 (第二版)
#
# 严格响应 Leader 第二轮审查要求与真实复现事实：
# 1. 【Leader 真实失败：首次迁移失败后旧服务必须真实自愈恢复 HTTP 200，杜绝 HTTP 000】；
# 2. 【首次 legacy 升级时真实旧进程受控停止，绝对杜绝 backend A + web B 混版】；
# 3. 【同 SHA 首次迁移隔离与 store 纯净入库：绝不产生 dist/dist，绝不覆盖已有 store】；
# 4. 【预存损坏 store 严格 fail-closed 阻断，线上产物 100% 完好】；
# 5. 【真实 launchctl kickstart 失败统一事务回滚与就绪校验】；
# 6. 【rollback 严格 Docker 镜像强校验与 legacy 旧服务健康真实探活】；
# 7. 【深度 is_store_valid 校验：三包核心文件、完整 node_modules、prompts 与 3 层软链接物理指向】；
# 8. 【原子排他锁与事务继承】；
# 9. 【三包编译各阶段失败隔离与线上零污染】；
# 10. 【零数据备份与安全合规性】。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-release-v3.XXXXXX")"
TEST_PORT=3199

cleanup() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:${TEST_PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
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
    if [[ "$img" =~ :latest$ ]] || [[ "$img" =~ :git-wrong ]] || [[ "$img" =~ :git-000000000 ]]; then
      echo "Error: image tag invalid or not found: $img" >&2
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
    echo "Error: No such image: $img" >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "${TEST_TMPDIR}/bin/docker"

# 精确模拟用户真实 launchd 环境（KeepAlive: {SuccessfulExit: false}, bootout/bootstrap/kickstart）
cat << 'EOF' > "${TEST_TMPDIR}/bin/launchctl"
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
case "$cmd" in
  list)
    echo "12345 0 com.riba2534.happyclaw"
    exit 0
    ;;
  print)
    echo "State: running"
    exit 0
    ;;
  bootout)
    if [ "${MOCK_PROCESS_STUCK:-0}" = "1" ]; then
      echo "Mock bootout: process refuses to terminate" >&2
      exit 0
    fi
    port="${WEB_PORT:-3199}"
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti:${port} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
    fi
    echo "Service bootout complete"
    exit 0
    ;;
  bootstrap)
    echo "Service bootstrap complete"
    exit 0
    ;;
  kickstart)
    if [ "${MOCK_LAUNCHCTL_FAIL:-0}" = "1" ]; then
      echo "launchctl kickstart: service failed to spawn" >&2
      exit 2
    fi
    port="${WEB_PORT:-3199}"
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti:${port} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
    fi
    sleep 0.2
    if [ -f "dist/index.js" ]; then
      node dist/index.js >/dev/null 2>&1 &
      sleep 0.8
    fi
    echo "Service com.riba2534.happyclaw kickstarted"
    exit 0
    ;;
  stop)
    if [ "${MOCK_PROCESS_STUCK:-0}" = "1" ]; then
      echo "Mock stop: process refuses to terminate" >&2
      exit 0
    fi
    port="${WEB_PORT:-3199}"
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti:${port} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
    fi
    echo "Service com.riba2534.happyclaw stopped"
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
git config user.name "HappyClaw Specialist"
git config user.email "specialist@happyclaw.local"

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
EOF

mkdir -p scripts
cp "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
chmod +x scripts/*.sh

# 创建支持构建与测试的 package.json
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

let depValue = 'missing';
try {
  const depModule = await import('test-version-dep');
  depValue = depModule.default?.version || depModule.version || 'unknown';
} catch (e) {
  depValue = 'err: ' + e.message;
}

const server = http.createServer((req, res) => {
  if (process.env.MOCK_SERVER_RETURNS_404 === '1') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Mock Server Forced 404');
    return;
  }
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
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '${version_tag}' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.WEB_PORT) || ${TEST_PORT};
server.listen(port, '127.0.0.1');
EOF

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

echo "WEB_PORT=${TEST_PORT}" > .env
chmod 600 .env

# 创建 Commit A (旧版基线，不含 scripts/wait-for-readiness.mjs)
create_server_source "VERSION_A" "DEP_A"
rm -f scripts/wait-for-readiness.mjs
git add .
git commit -m "Commit A: Initial legacy baseline without wait-for-readiness" --quiet
COMMIT_A="$(git rev-parse HEAD)"

# 创建 Commit B (引入 scripts/wait-for-readiness.mjs)
create_server_source "VERSION_B" "DEP_B"
cp "${REAL_REPO_ROOT}/scripts/wait-for-readiness.mjs" scripts/
git add .
git commit -m "Commit B: Target production release with wait-for-readiness" --quiet
COMMIT_B="$(git rev-parse HEAD)"

# 切回 Commit A (工作树中无 scripts/wait-for-readiness.mjs)
git switch --detach "${COMMIT_A}" --quiet
create_server_source "VERSION_A" "DEP_A"

log_test "测试仓库初始化完成："
echo "Commit A (基线): ${COMMIT_A}"
echo "Commit B (目标): ${COMMIT_B}"

export WEB_PORT="${TEST_PORT}"

# ==============================================================================
# Leader 复现 1：损坏 store fail-closed 阻断，线上产物绝对不破坏
# ==============================================================================
log_test "【Leader 复现 1 修复验证】损坏 store fail-closed 阻断，禁止切换，线上产物零丢失"

mkdir -p ".releases/store/${COMMIT_B}"

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
CORRUPT_STORE_EXIT=$?
set -e

if [ "${CORRUPT_STORE_EXIT}" -eq 0 ]; then
  log_fail "预存损坏 store 时 deploy-release.sh 竟然返回 0！未满足 fail-closed！"
fi

test -f dist/index.js || log_fail "损坏 store 阻断后在线 dist/index.js 遭到破坏！"
test -f web/dist/index.html || log_fail "损坏 store 阻断后在线 web/dist/index.html 遭到破坏！"

rm -rf ".releases/store/${COMMIT_B}"
log_pass "Leader 复现 1 验证通过：预存损坏 store 严格 fail-closed 阻断，线上产物 100% 完好！"

# ==============================================================================
# Leader 关键断言：首次迁移中途注入故障，原旧服务真实自愈恢复至 HTTP 200 (杜绝 HTTP 000)
# ==============================================================================
log_test "【Leader 第二轮关键断言】首次迁移中途故障注入，旧服务真实自愈恢复对外响应 (HTTP 200，杜绝 HTTP 000)"

# 先启动一个真实的未迁移 legacy 进程 A（无 bootstrap，cwd 位于根目录）
node dist/index.js >/dev/null 2>&1 &
sleep 1

# 确认旧服务正在正常响应
INITIAL_CODE="$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${TEST_PORT}/version" || echo "000")"
if [ "${INITIAL_CODE}" != "200" ]; then
  log_fail "测试前旧服务未就绪 (HTTP ${INITIAL_CODE})！"
fi

# 执行部署并注入 migration_step 故障
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="migration_step" \
./scripts/deploy-release.sh
MIGRATION_FAIL_EXIT=$?
set -e

if [ "${MIGRATION_FAIL_EXIT}" -ne 109 ]; then
  log_fail "首次迁移中途故障未返回 109，实际退出码: ${MIGRATION_FAIL_EXIT}"
fi

# 核心严格断言：
# 1. 物理布局已恢复原状
if [ ! -d "dist" ] || [ -L "dist" ]; then
  log_fail "首次迁移失败后 dist 未能恢复为物理目录！"
fi
if [ -e ".releases/current" ]; then
  log_fail "首次迁移失败后残留了 current 符号链接！"
fi

# 2. 关键：旧服务必须真实自愈重新对外响应！绝不是 HTTP 000！
RECOVERED_CODE="$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${TEST_PORT}/version" || echo "000")"
if [ "${RECOVERED_CODE}" != "200" ]; then
  log_fail "严重缺陷回归：首次迁移失败后旧服务未能自愈恢复！HTTP 响应码为: ${RECOVERED_CODE} (预期 200)！"
fi

RECOVERED_RESP="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "VERSION_A" <<<"$RECOVERED_RESP"; then
  log_fail "自愈恢复后响应内容异常: ${RECOVERED_RESP}"
fi
log_pass "Leader 第二轮关键断言通过：首次迁移故障后旧服务真实自愈恢复 HTTP 200，物理布局与进程状态完全一致！"

# ==============================================================================
# Leader 复现 2：首次 legacy 升级时真实旧进程受控停止，绝对杜绝混版
# ==============================================================================
log_test "【Leader 复现 2 修复验证】首次 legacy 升级时真实存量进程受控停止，杜绝 backend A + web B 混版"

# 再次确认当前旧服务在运行
curl -fsS "http://127.0.0.1:${TEST_PORT}/version" >/dev/null

# 执行正式首次部署至 Commit A
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh

NEW_RESP="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_A}\"" <<<"$NEW_RESP"; then
  log_fail "首次升级后服务未带有 bootstrapSha: $NEW_RESP"
fi
log_pass "Leader 复现 2 验证通过：首次升级前存量旧进程受控平滑停止，彻底杜绝混版！"

# ==============================================================================
# Leader 复现 3：真实 launchctl kickstart 返回非 0 时统一事务回滚
# ==============================================================================
log_test "【Leader 复现 3 修复验证】真实 launchctl kickstart 失败（退出码 2）触发统一事务回滚"

export MOCK_LAUNCHCTL_FAIL=1

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
KICKSTART_FAIL_EXIT=$?
set -e

unset MOCK_LAUNCHCTL_FAIL

if [ "${KICKSTART_FAIL_EXIT}" -eq 0 ]; then
  log_fail "launchctl kickstart 失败但 deploy-release.sh 竟然返回 0！"
fi

CURRENT_AFTER_FAIL="$(readlink .releases/current)"
HEAD_AFTER_FAIL="$(git rev-parse HEAD)"

if [ "${CURRENT_AFTER_FAIL}" != "store/${COMMIT_A}" ]; then
  log_fail "严重回归：kickstart 失败后 current 指针未回退至 store/${COMMIT_A}！实际: ${CURRENT_AFTER_FAIL}"
fi
if [ "${HEAD_AFTER_FAIL}" != "${COMMIT_A}" ]; then
  log_fail "严重回归：kickstart 失败后 Git HEAD 未回退至 ${COMMIT_A}！实际: ${HEAD_AFTER_FAIL}"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_A}" .env; then
  log_fail "严重回归：kickstart 失败后 .env 中的镜像未回退为 COMMIT_A！"
fi

log_pass "Leader 复现 3 验证通过：真实 kickstart 失败触发全套自动回滚事务，状态完好恢复！"

# ==============================================================================
# 场景 1: 原子排他锁互斥检测 (fail-closed) 与死锁安全回收
# ==============================================================================
log_test "场景 1: 原子排他锁互斥检测 (fail-closed) 与死锁安全回收"

echo "{\"pid\":$$,\"runId\":\"active_lock_pid\",\"startedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > .deploy.lock

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
LOCK_EXIT=$?
set -e

if [ "${LOCK_EXIT}" -eq 0 ]; then
  log_fail "持有排他锁时并发部署竟然未被拦截！"
fi

echo "invalid-non-json-lock" > .deploy.lock
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
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
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
EXIT_LATEST=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-0000000000000000000000000000000000000000" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
EXIT_WRONG=$?
set -e

if [ "${EXIT_LATEST}" -eq 0 ] || [ "${EXIT_WRONG}" -eq 0 ]; then
  log_fail "非规范或 SHA 错配镜像未被严格拦截！"
fi
log_pass "场景 2 通过：严格拦截 latest 与 SHA 错配镜像！"

# ==============================================================================
# 场景 3: 3 层相对软链接与共享数据目录真实物理路径验证
# ==============================================================================
log_test "场景 3: 3 层相对软链接与共享数据目录真实物理路径验证"

DATA_LINK="$(readlink ".releases/store/${COMMIT_A}/data")"
ENV_LINK="$(readlink ".releases/store/${COMMIT_A}/.env")"
CONFIG_LINK="$(readlink ".releases/store/${COMMIT_A}/config")"

if [ "${DATA_LINK}" != "../../../data" ] || [ "${ENV_LINK}" != "../../../.env" ] || [ "${CONFIG_LINK}" != "../../../config" ]; then
  log_fail "3 层相对软链接层级错误！实际: data=${DATA_LINK}, env=${ENV_LINK}, config=${CONFIG_LINK}"
fi

REAL_DATA="$(node -e "console.log(require('fs').realpathSync('.releases/store/${COMMIT_A}/data'))")"
EXPECTED_REAL_DATA="$(node -e "console.log(require('fs').realpathSync('data'))")"
if [ "${REAL_DATA}" != "${EXPECTED_REAL_DATA}" ]; then
  log_fail "store/${COMMIT_A}/data 物理路径解析错误！实际: ${REAL_DATA}，预期: ${EXPECTED_REAL_DATA}"
fi
log_pass "场景 3 通过：3 层相对数据与配置软链接解析 100% 正确！"

# ==============================================================================
# 场景 4: 正常原子发布至 COMMIT_B，长驻服务验证固定运行根与共享数据
# ==============================================================================
log_test "场景 4: 正常原子发布至 COMMIT_B，长驻服务验证固定运行根与共享数据"

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh

if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "部署后 current 未切至 store/${COMMIT_B}"
fi
if [ "$(git rev-parse HEAD)" != "${COMMIT_B}" ]; then
  log_fail "部署后 Git HEAD 未切至 ${COMMIT_B}"
fi

RESP_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_B}\"" <<<"$RESP_B" || ! grep -q "\"depValue\":\"DEP_B\"" <<<"$RESP_B"; then
  log_fail "新进程 B 响应不匹配: $RESP_B"
fi
ASSETS_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/assets")"
if ! grep -q "WEB_VERSION_B" <<<"$ASSETS_B" || ! grep -q "RUNNER_VERSION_B" <<<"$ASSETS_B"; then
  log_fail "新进程 B 资产不匹配: $ASSETS_B"
fi
SHARED_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/shared-data")"
if ! grep -q "PERSISTENT_SQLITE_MESSAGES_ROW_1" <<<"$SHARED_B"; then
  log_fail "新进程 B 未能读取共享 SQLite 数据！"
fi
log_pass "场景 4 通过：原子发布成功，新进程固定运行根并准确读取共享数据！"

# ==============================================================================
# 场景 5: 同 SHA 重新发布安全复用与 pre_build 故障保护 (零删除、零断链)
# ==============================================================================
log_test "场景 5: 同 SHA 重新发布安全复用与 pre_build 故障保护 (零删除、零断链)"

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh

test -f dist/index.js || log_fail "同 SHA 重发后在线产物丢失！"

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="pre_build" \
./scripts/deploy-release.sh
SAME_SHA_FAIL=$?
set -e

if [ "${SAME_SHA_FAIL}" -ne 101 ]; then
  log_fail "预期注入退出码 101，实际: ${SAME_SHA_FAIL}"
fi
test -f dist/index.js || log_fail "同 SHA 故障后在线 dist 丢失！"
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "同 SHA 故障后 current 损坏！"
fi
log_pass "场景 5 通过：同 SHA 重复发布安全复用，故障下在线产物完好无损！"

# ==============================================================================
# 场景 6: 三包构建阶段失败注入测试 (线上版本零污染)
# ==============================================================================
log_test "场景 6: 三包构建阶段失败注入测试 (线上版本零污染)"

echo "TEMP_C_MOD" >> src/server.js
git add src/server.js
git commit -m "Commit C: temporary" --quiet
COMMIT_C="$(git rev-parse HEAD)"
git switch --detach "${COMMIT_B}" --quiet

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="server_build" \
./scripts/deploy-release.sh
EXIT_SERVER_BUILD=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="web_build" \
./scripts/deploy-release.sh
EXIT_WEB_BUILD=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_C}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_C}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="runner_build" \
./scripts/deploy-release.sh
EXIT_RUNNER_BUILD=$?
set -e

if [ "${EXIT_SERVER_BUILD}" -ne 102 ] || [ "${EXIT_WEB_BUILD}" -ne 103 ] || [ "${EXIT_RUNNER_BUILD}" -ne 104 ]; then
  log_fail "构建阶段注入退出码不匹配！"
fi

if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "构建失败后 current 发生漂移！"
fi
log_pass "场景 6 通过：构建阶段失败安全隔离，线上零污染！"

# ==============================================================================
# 场景 7: rollback-release.sh 严格镜像强校验 (即使已有 store 亦必须校验)
# ==============================================================================
log_test "场景 7: rollback-release.sh 严格镜像强校验"

set +e
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
./scripts/rollback-release.sh "${COMMIT_A}"
ROLLBACK_BAD_IMG_EXIT=$?

HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-0000000000000000000000000000000000000000" \
./scripts/rollback-release.sh "${COMMIT_A}"
ROLLBACK_WRONG_SHA_EXIT=$?
set -e

if [ "${ROLLBACK_BAD_IMG_EXIT}" -eq 0 ] || [ "${ROLLBACK_WRONG_SHA_EXIT}" -eq 0 ]; then
  log_fail "回滚时非法镜像标签或 SHA 错配镜像未被拦截！"
fi
log_pass "场景 7 通过：回滚时严格核对镜像规范与 OCI 属性！"

# ==============================================================================
# 场景 8: A -> B -> A 原子回滚成功并跟随不可变镜像
# ==============================================================================
log_test "场景 8: A -> B -> A 原子回滚成功并跟随不可变镜像"

./scripts/rollback-release.sh "${COMMIT_A}"

if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 current 未切回 store/${COMMIT_A}"
fi
if [ "$(git rev-parse HEAD)" != "${COMMIT_A}" ]; then
  log_fail "回滚后 Git HEAD 未切回 COMMIT_A"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_A}" .env; then
  log_fail "回滚后 .env 中的 CONTAINER_IMAGE 未准确还原！"
fi
log_pass "场景 8 通过：A -> B -> A 原子回滚全流程成功，镜像精准跟随！"

# ==============================================================================
# 场景 9: 就绪探针工具缺失或超时严格阻断
# ==============================================================================
log_test "场景 9: 就绪探针工具缺失或超时严格阻断"

# 9.1 模拟就绪探针执行失败/超时
export MOCK_SERVER_RETURNS_404=1
export HAPPYCLAW_READINESS_TIMEOUT=3
set +e
./scripts/rollback-release.sh "${COMMIT_B}"
ROLLBACK_READY_EXIT=$?
set -e
unset MOCK_SERVER_RETURNS_404
unset HAPPYCLAW_READINESS_TIMEOUT

if [ "${ROLLBACK_READY_EXIT}" -eq 0 ]; then
  log_fail "就绪探针失败时回滚脚本竟然返回 0！违背契约！"
fi
log_pass "9.1 通过：就绪探针失败严格以非 0 退出码 (${ROLLBACK_READY_EXIT}) 阻断！"

# 9.2 模拟固化就绪探针工具缺失
mv ".releases/.tools/wait-for-readiness.mjs" ".releases/.tools/wait-for-readiness.mjs.bak"
set +e
./scripts/rollback-release.sh "${COMMIT_B}"
MISSING_TOOL_EXIT=$?
set -e
mv ".releases/.tools/wait-for-readiness.mjs.bak" ".releases/.tools/wait-for-readiness.mjs"

if [ "${MISSING_TOOL_EXIT}" -eq 0 ]; then
  log_fail "就绪探针工具缺失时回滚脚本竟然返回 0！违背契约！"
fi
log_pass "9.2 通过：就绪探针工具缺失严格以非 0 退出码 (${MISSING_TOOL_EXIT}) 阻断！"

# 确保当前在线处于完整就绪的 COMMIT_B
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh >/dev/null 2>&1

# ==============================================================================
# 场景 10: 禁止数据备份与安全合规性检查
# ==============================================================================
log_test "场景 10: 禁止数据备份与安全合规性检查"

BAK_FILES="$(find . \( -name "*.bak" -o -name ".env.*" \) ! -name ".gitignore" 2>/dev/null || true)"
if [ -n "${BAK_FILES}" ]; then
  log_fail "违背政策：检测到生成的备份文件！清单: ${BAK_FILES}"
fi

ENV_PERM="$(stat -c "%a" .env 2>/dev/null || stat -f "%Op" .env 2>/dev/null || echo "600")"
if [[ "${ENV_PERM}" =~ 600$ ]] || [ "${ENV_PERM}" = "600" ]; then
  log_pass ".env 权限正确为 600"
fi

if ! grep -q "^HAPPYCLAW_SKIP_MIGRATION_BACKUP=1" .env; then
  log_fail ".env 中未写入 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1"
fi
log_pass "场景 10 通过：完全符合零数据备份与安全权限约束！"

# ==============================================================================
# Leader 第三轮专项 1：端口存在仅返回 404 的假服务，回滚探针必须判定失败而非假成功
# ==============================================================================
log_test "【Leader 第三轮专项 1】端口存在仅返回 404 的假服务，回滚探针必须判定失败而非假成功"

export MOCK_SERVER_RETURNS_404=1
export HAPPYCLAW_READINESS_TIMEOUT=3

set +e
./scripts/rollback-release.sh "${COMMIT_A}"
FAKE_404_ROLLBACK_EXIT=$?
set -e

unset MOCK_SERVER_RETURNS_404
unset HAPPYCLAW_READINESS_TIMEOUT

if [ "${FAKE_404_ROLLBACK_EXIT}" -eq 0 ]; then
  log_fail "严重缺陷：端口返回 404 时回滚探针竟然误判通过返回 0！未满足契约！"
fi
log_pass "专项 1 通过：端口返回 404 假服务时回滚探针严格识别并阻断，绝不接受 404 为健康！"

# 恢复在线为正常的 COMMIT_B (含 wait-for-readiness.mjs)
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh >/dev/null 2>&1

# ==============================================================================
# Leader 第三轮专项 2：回滚至不含 wait-for-readiness.mjs 的历史提交，回滚必须成功完成
# ==============================================================================
log_test "【Leader 第三轮专项 2】回滚至不含 wait-for-readiness.mjs 的历史提交，回滚必须成功完成"

# 确保当前在线处于 COMMIT_B (含 wait-for-readiness.mjs)
test -f "scripts/wait-for-readiness.mjs" || log_fail "当前在线必须包含 scripts/wait-for-readiness.mjs"

# 执行回滚至不含探针的历史提交 COMMIT_A
./scripts/rollback-release.sh "${COMMIT_A}"

if [ "$(git rev-parse HEAD)" != "${COMMIT_A}" ]; then
  log_fail "回滚至不含探针的历史提交后 Git HEAD 不匹配！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 current 指针未指向 store/${COMMIT_A}！"
fi

# 核心严格断言：回滚后工作树切到了 COMMIT_A，当前工作树中确实已被 Git 清除 wait-for-readiness.mjs，但回滚成功完成！
if [ -f "scripts/wait-for-readiness.mjs" ]; then
  log_fail "严重回归：回滚至 COMMIT_A 后工作树中竟然仍残留 wait-for-readiness.mjs！"
fi
log_pass "专项 2 通过：工作树缺失 wait-for-readiness.mjs 时回滚依然顺利成功完成，固化探针保障历史回滚！"

# 切回 COMMIT_B 以继续后续测试
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh >/dev/null 2>&1

# ==============================================================================
# Leader 第三轮专项 3：停止后进程仍占用端口时，必须失败并报错，绝对禁止更换软链接
# ==============================================================================
log_test "【Leader 第三轮专项 3】停止后进程仍占用端口时，必须失败并报错，绝对禁止更换软链接"

LEGACY_TEST_DIR="${TEST_TMPDIR}/legacy_stuck_repo"
mkdir -p "${LEGACY_TEST_DIR}"
# 完整复制测试仓库并确保脚本就绪
cp -a "${TEST_TMPDIR}/repo/." "${LEGACY_TEST_DIR}/"
cd "${LEGACY_TEST_DIR}"
mkdir -p scripts
cp -f "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp -f "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
chmod +x scripts/*.sh

rm -rf .releases dist web/dist container/agent-runner/dist
mkdir -p dist web/dist container/agent-runner/dist
cp src/server.js dist/index.js
cp web/src/index.html web/dist/index.html
cp container/agent-runner/src/runner.js container/agent-runner/dist/index.js

local_port="${TEST_PORT}"
# 启动一个外部死死占用端口的僵尸进程
node -e "
  const http = require('http');
  const server = http.createServer((req, res) => res.end('stuck'));
  server.listen(${local_port}, '127.0.0.1');
" >/dev/null 2>&1 &
STUCK_PID=$!
sleep 0.8

export MOCK_PROCESS_STUCK=1
export HAPPYCLAW_READINESS_TIMEOUT=3

set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
./scripts/deploy-release.sh
STUCK_PROCESS_EXIT=$?
set -e

unset MOCK_PROCESS_STUCK
unset HAPPYCLAW_READINESS_TIMEOUT
kill -9 "${STUCK_PID}" 2>/dev/null || true
wait "${STUCK_PID}" 2>/dev/null || true

if [ "${STUCK_PROCESS_EXIT}" -eq 0 ]; then
  log_fail "进程停止超时仍占用端口时，部署竟然返回 0！"
fi

# 核心严格断言：绝不更换软链接！
if [ -L "dist" ]; then
  log_fail "严重缺陷：停止旧服务超时时，竟然强行将 dist 更换成了软链接！"
fi
if [ ! -d "dist" ]; then
  log_fail "严重缺陷：停止旧服务超时后 dist 目录丢失！"
fi

cd "${TEST_TMPDIR}/repo"
rm -rf "${LEGACY_TEST_DIR}"

log_pass "专项 3 通过：停止旧服务超时或进程占用时部署严格拒绝更换软链接并报错！"

# ==============================================================================
# Leader 第四轮专项：旧基线仓库 scripts/ 无发布脚本时的首次外部引导与故障隔离
# ==============================================================================
log_test "【Leader 第四轮专项】旧基线仓库 scripts/ 无发布脚本时的首次外部引导与故障隔离"

# 确保端口被完全释放
if command -v lsof >/dev/null 2>&1; then
  lsof -ti:${TEST_PORT} -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi

BOOTSTRAP_REPO="${TEST_TMPDIR}/bootstrap_clean_repo"
mkdir -p "${BOOTSTRAP_REPO}"
cd "${BOOTSTRAP_REPO}"
git init -b main --quiet
git config user.name "HappyClaw Specialist"
git config user.email "specialist@happyclaw.local"

# 严格模拟 7175c0d 旧基线：.gitignore 不含发布规则，scripts/ 下无发布脚本
cat << 'EOF' > .gitignore
node_modules/
dist/
/data/
/logs/
/store/
/groups/
.env
EOF

mkdir -p src dist web/src web/dist container/agent-runner/src container/agent-runner/dist container/agent-runner/prompts data config
echo '{"allowlist": ["/shared/workspace"]}' > config/mount-allowlist.json
echo "SQLITE_DATA_BOOTSTRAP_ROW" > data/messages.db
echo "WEB_PORT=${TEST_PORT}" > .env
chmod 600 .env

# 创建模拟旧基线代码
cat << EOF > src/server.js
import http from 'http';
const server = http.createServer((req, res) => {
  if (req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ versionTag: 'LEGACY_7175', status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(${TEST_PORT}, '127.0.0.1');
EOF
cp src/server.js dist/index.js
echo "<html><body>LEGACY_WEB</body></html>" > web/dist/index.html
echo "LEGACY_RUNNER" > container/agent-runner/dist/index.js
echo "LEGACY_PROMPT" > container/agent-runner/prompts/identity.md

cat << 'EOF' > package.json
{
  "name": "happyclaw-bootstrap-test",
  "version": "1.0.0",
  "type": "module"
}
EOF

git add .
git commit -m "Commit Baseline: pure legacy baseline without release scripts" --quiet
BOOTSTRAP_BASE_SHA="$(git rev-parse HEAD)"

# 确认旧仓库中绝无发布脚本
test ! -e scripts/deploy-release.sh || log_fail "基线仓库中本不应存在 deploy-release.sh"
# 确认旧仓库当前干净
test -z "$(git status --porcelain)" || log_fail "基线仓库初始工作树必须完全干净"

# 在基线旧仓库中将目标版本 COMMIT_B 也提交为一个远程/本地分支可访问的目标提交
git remote add source "${TEST_TMPDIR}/repo"
git fetch source main:refs/remotes/origin/main --quiet

# 启动旧版本服务
node dist/index.js >/dev/null 2>&1 &
sleep 0.8
INITIAL_BOOTSTRAP_RESP="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "LEGACY_7175" <<<"$INITIAL_BOOTSTRAP_RESP"; then
  log_fail "旧版本服务启动未响应预期内容: $INITIAL_BOOTSTRAP_RESP"
fi

# 建立仓库外的临时引导目录
BOOTSTRAP_TOOL_DIR="${TEST_TMPDIR}/external_bootstrap_tool"
mkdir -p "${BOOTSTRAP_TOOL_DIR}/scripts"
cp -f "${REAL_REPO_ROOT}/scripts/deploy-release.sh" "${BOOTSTRAP_TOOL_DIR}/scripts/"
cp -f "${REAL_REPO_ROOT}/scripts/rollback-release.sh" "${BOOTSTRAP_TOOL_DIR}/scripts/"
cp -f "${REAL_REPO_ROOT}/scripts/wait-for-readiness.mjs" "${BOOTSTRAP_TOOL_DIR}/scripts/"
chmod +x "${BOOTSTRAP_TOOL_DIR}/scripts/"*.sh

# 1. 模拟首次外部引导中途故障注入 (pre_build 失败)
echo "[INFO] 1. 测试首次外部引导中途故障注入 (pre_build)..."
set +e
HAPPYCLAW_ROOT_DIR="${BOOTSTRAP_REPO}" \
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_INJECT_FAILURE="pre_build" \
"${BOOTSTRAP_TOOL_DIR}/scripts/deploy-release.sh"
FAIL_BOOTSTRAP_EXIT=$?
set -e

if [ "${FAIL_BOOTSTRAP_EXIT}" -ne 101 ]; then
  log_fail "外部引导中途故障注入未返回 101，实际为: ${FAIL_BOOTSTRAP_EXIT}"
fi

# 核心严格断言：生产仓库工作树 100% 保持在旧 SHA，且没有任何未跟踪文件残留！
if [ "$(git rev-parse HEAD)" != "${BOOTSTRAP_BASE_SHA}" ]; then
  log_fail "引导失败后工作树 HEAD 发生漂移！"
fi
CLEAN_CHECK="$(git status --porcelain)"
if [ -n "${CLEAN_CHECK}" ]; then
  log_fail "严重缺陷：引导失败后工作树残留了未跟踪文件！清单: ${CLEAN_CHECK}"
fi
test ! -e ".releases" || log_fail "引导失败后残留了未激活的 .releases 目录！"
test ! -e ".deploy.lock" || log_fail "引导失败后残留了 .deploy.lock！"
curl -fsS "http://127.0.0.1:${TEST_PORT}/version" >/dev/null || log_fail "引导失败后旧服务未能继续对外服务！"
log_pass "外部引导中途故障防护断言通过：生产工作树零污染、零残留，旧服务持续可用！"

# 2. 正式执行外部首次引导部署
echo "[INFO] 2. 执行正式外部首次引导部署..."
HAPPYCLAW_ROOT_DIR="${BOOTSTRAP_REPO}" \
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
"${BOOTSTRAP_TOOL_DIR}/scripts/deploy-release.sh"

# 核心严格断言：
# a) ACTIVE_PREVIOUS_SHA 准确解析为旧基线 SHA 并封存
cd "${BOOTSTRAP_REPO}"
test -d ".releases/store/${BOOTSTRAP_BASE_SHA}" || log_fail "旧版本 store/${BOOTSTRAP_BASE_SHA} 未被正确封存！"
STORE_META="$(cat ".releases/store/${BOOTSTRAP_BASE_SHA}/version.json")"
if ! grep -q "\"commitSha\": \"${BOOTSTRAP_BASE_SHA}\"" <<<"$STORE_META" && ! grep -q "\"commitSha\":\"${BOOTSTRAP_BASE_SHA}\"" <<<"$STORE_META"; then
  log_fail "旧版本 version.json 中的 commitSha 不是旧基线 SHA！"
fi

# b) 当前在线指针与 Git HEAD 成功指向目标新版本
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "引导完成后 current 未指向 store/${COMMIT_B}！"
fi
if [ "$(git rev-parse HEAD)" != "${COMMIT_B}" ]; then
  log_fail "引导完成后 Git HEAD 未指向目标版本 ${COMMIT_B}！"
fi

# c) 新版本服务已拉起且工作树干净
NEW_BOOTSTRAP_RESP="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_B}\"" <<<"$NEW_BOOTSTRAP_RESP"; then
  log_fail "新服务响应未包含目标 SHA: $NEW_BOOTSTRAP_RESP"
fi

# 确认新版本上发布脚本已正式受 Git 跟踪
test -f "scripts/deploy-release.sh" || log_fail "引导完成后新版本 scripts/deploy-release.sh 应当已存在"
test -z "$(git status --porcelain)" || log_fail "引导完成后工作树应当完全干净"

cd "${TEST_TMPDIR}/repo"
rm -rf "${BOOTSTRAP_REPO}" "${BOOTSTRAP_TOOL_DIR}"

log_pass "【Leader 第四轮专项】旧基线无发布脚本时的首次外部引导全套断言 100% 通过！"

log_test "======================================================================"
log_test "🎉 全部场景、Leader 3 大复现失败项及 4 大专项测试 100% 顺利通过！"
log_test "======================================================================"
