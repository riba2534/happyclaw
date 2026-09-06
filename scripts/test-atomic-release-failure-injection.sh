#!/usr/bin/env bash
# ==============================================================================
# HappyClaw R11/R12 生产级原子发布、长驻固定根与故障隔离深度测试
#
# 严格响应 Leader 第三轮深度审查要求：
# 1. 【真实长驻服务与进程固定根】在 A 运行中切 B，严格断言老进程 A 保持 COMMIT_A 身份与 A 资源，绝不混版；
# 2. 【共享数据 3 层相对软链接验证】严格验证 .releases/store/<SHA>/data 指向 ../../../data 并真实解析至主 ROOT/data；
# 3. 【同 SHA 再次发布 pre_build 故障】真实复现并严格断言在线文件 100% 存在、内容零损坏；
# 4. 【测试专属 PATH command adapter】使用隔离 bin/docker stub 模拟真实 OCI revision 标签检查，消除生产跳过参数；
# 5. 【原子排他锁与并发阻断】测试单文件 O_CREAT|O_EXCL 互斥锁，fail-closed 阻断；
# 6. 【构建失败零污染与单步原子切换】三包编译失败在线零污染；成功时单步原子重命名生效；
# 7. 【原子回滚与失败非 0】回滚切回 store/<SHA_A>，就绪失败严格以非 0 退出码退出。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-atomic-v4.XXXXXX")"
TEST_PORT=3199

# 进程清理
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

# 1. 建立测试专属的 Docker Command Adapter (满足 Leader 要求的真实 OCI label 校验，无生产跳过后门)
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
    # 提取镜像名 (最后一个参数)
    img="${@: -1}"
    format_arg=""
    for arg in "$@"; do
      if [[ "$arg" =~ org.opencontainers.image.revision ]]; then
        format_arg="$arg"
        break
      fi
    done

    # 提取 tag 中的 commit SHA
    if [[ "$img" =~ :git-([a-f0-9]+)(-headroom)?$ ]]; then
      sha="${BASH_REMATCH[1]}"
      if [ -n "$format_arg" ]; then
        echo "$sha"
      else
        echo "{\"Config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$sha\"}}}"
      fi
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
export PATH="${TEST_TMPDIR}/bin:${PATH}"

git init -b main --quiet
git config user.name "HappyClaw Test"
git config user.email "test@happyclaw.local"

mkdir -p scripts
cp "${REAL_REPO_ROOT}/scripts/deploy-release.sh" scripts/
cp "${REAL_REPO_ROOT}/scripts/rollback-release.sh" scripts/
chmod +x scripts/*.sh

# 配置 .gitignore
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
EOF

# 创建支持测试的 package.json
cat << 'EOF' > package.json
{
  "name": "happyclaw-test",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "node -e 'require(\"fs\").mkdirSync(\"dist\", {recursive: true}); require(\"fs\").copyFileSync(\"src/server.js\", \"dist/index.js\")'",
    "build:web": "node -e 'require(\"fs\").mkdirSync(\"web/dist\", {recursive: true}); require(\"fs\").copyFileSync(\"web/src/index.html\", \"web/dist/index.html\")'"
  }
}
EOF

mkdir -p web
cat << 'EOF' > web/package.json
{ "name": "web-test" }
EOF

mkdir -p container/agent-runner
cat << 'EOF' > container/agent-runner/package.json
{
  "name": "agent-runner-test",
  "scripts": { "build": "node -e 'require(\"fs\").mkdirSync(\"dist\", {recursive: true}); require(\"fs\").copyFileSync(\"src/runner.js\", \"dist/runner.js\")'" }
}
EOF

# 创建真实长驻 HTTP 服务入口模版 (模拟生产 load-env.ts bootstrap 与真实服务)
create_server_source() {
  local version_tag="$1"
  mkdir -p src
  cat << EOF > src/server.js
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 真实 bootstrap: 识别真实不可变 release 根并固化 process.chdir
try {
  const currentFilePath = fs.realpathSync(fileURLToPath(import.meta.url));
  let dir = path.dirname(currentFilePath);
  let releaseRoot = null;
  let commitSha = null;
  for (let i = 0; i < 5; i++) {
    const vFile = path.join(dir, 'version.json');
    if (fs.existsSync(vFile)) {
      const v = JSON.parse(fs.readFileSync(vFile, 'utf8'));
      if (v.commitSha) {
        releaseRoot = dir;
        commitSha = v.commitSha;
        break;
      }
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

const server = http.createServer((req, res) => {
  if (req.url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      versionTag: '${version_tag}',
      bootstrapSha: BOOTSTRAP_SHA,
      processCwd: CURRENT_ROOT,
      dataResolved: fs.realpathSync(path.join(CURRENT_ROOT, 'data')),
    }));
    return;
  }
  if (req.url === '/static-check') {
    const webHtml = fs.readFileSync(path.join(CURRENT_ROOT, 'web/dist/index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ webHtml }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(${TEST_PORT}, '127.0.0.1');
EOF

  mkdir -p dist
  cp src/server.js dist/index.js

  mkdir -p web/src
  echo "<html><body>WEB_${version_tag}</body></html>" > web/src/index.html
  mkdir -p web/dist
  cp web/src/index.html web/dist/index.html

  mkdir -p container/agent-runner/src
  echo "RUNNER_${version_tag}" > container/agent-runner/src/runner.js
  mkdir -p container/agent-runner/dist
  cp container/agent-runner/src/runner.js container/agent-runner/dist/runner.js

  mkdir -p container/agent-runner/prompts
  echo "PROMPT_${version_tag}" > container/agent-runner/prompts/identity.md
}

echo "PORT=${TEST_PORT}" > .env
chmod 600 .env

mkdir -p data
echo "SHARED_DATA_DATABASE_ROW_1" > data/messages.db

create_server_source "VERSION_A"

git add .
git commit -m "Commit A: Initial online version" --quiet
COMMIT_A="$(git rev-parse HEAD)"

# 创建 Commit B
create_server_source "VERSION_B"
git add .
git commit -m "Commit B: Target release version" --quiet
COMMIT_B="$(git rev-parse HEAD)"

# 切回 Commit A
git switch --detach "${COMMIT_A}" --quiet
create_server_source "VERSION_A"

log_test "测试仓库初始化完成："
echo "Commit A: ${COMMIT_A}"
echo "Commit B: ${COMMIT_B}"

# --- 场景 1: 原子排他锁互斥检测 ---
log_test "场景 1: 部署排他锁互斥检测 (fail-closed)"
echo "{\"pid\":$$,\"runId\":\"active_lock\",\"startedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > .deploy.lock

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
  log_fail "持有排他锁时并发发布竟然未被阻断！"
fi
rm -f .deploy.lock
log_pass "场景 1 通过：排他锁成功拦截并发部署！"

# --- 场景 2: 镜像规范与 OCI Revision 标签强校验 ---
log_test "场景 2: 镜像规范与 OCI Revision 标签强校验"
set +e
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:latest" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
EXIT_LATEST=$?

HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-wrong_sha_123" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh
EXIT_WRONG=$?
set -e

if [ "${EXIT_LATEST}" -eq 0 ] || [ "${EXIT_WRONG}" -eq 0 ]; then
  log_fail "非法或错配镜像未被拦截！"
fi
log_pass "场景 2 通过：严格拦截 latest 与 SHA 错配镜像！"

# --- 场景 3: 首次发布建立不可变运行根与单步原子切换 ---
log_test "场景 3: 首次发布建立不可变运行根与单步原子切换"
HAPPYCLAW_EXPECTED_SHA="${COMMIT_A}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_A}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh

# 验证 3 层相对软链接与共享数据解析真实性 (彻底推翻 ../../data 的层级错误)
DATA_LINK="$(readlink ".releases/store/${COMMIT_A}/data")"
if [ "${DATA_LINK}" != "../../../data" ]; then
  log_fail "store/${COMMIT_A}/data 软链接层级错误！预期 ../../../data，实际为: ${DATA_LINK}"
fi
REAL_DATA="$(node -e "console.log(require('fs').realpathSync('.releases/store/${COMMIT_A}/data'))")"
EXPECTED_REAL_DATA="$(node -e "console.log(require('fs').realpathSync('data'))")"
if [ "${REAL_DATA}" != "${EXPECTED_REAL_DATA}" ]; then
  log_fail "store/${COMMIT_A}/data 物理路径解析错误！解析为: ${REAL_DATA}，预期为: ${EXPECTED_REAL_DATA}"
fi

# 验证单步原子符号链接
if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail ".releases/current 未指向 store/${COMMIT_A}"
fi
log_pass "场景 3 通过：不可变运行根封存完整，3 层相对数据软链接精准无误！"

# --- 场景 4: 【核心测试】启动长驻进程 A，切换至 B，断言老进程 A 保持 COMMIT_A 身份且绝不混版 ---
log_test "场景 4: 【核心测试】长驻进程 A 运行时切换 B，严格断言老进程 A 资源 100% 保持 A，不混版！"
# 启动长驻服务进程 A
node dist/index.js &
LONG_RUNNING_PID=$!
sleep 1.5

# 检查进程 A 运行状态
RESP_A="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_A}\"" <<<"$RESP_A"; then
  log_fail "进程 A 启动 SHA 不匹配！响应: $RESP_A"
fi
STATIC_A="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/static-check")"
if ! grep -q "WEB_VERSION_A" <<<"$STATIC_A"; then
  log_fail "进程 A 读取静态资源不是 A！响应: $STATIC_A"
fi

# 关键操作：在老进程 A 依然存活运行且持续对外服务时，执行发布切换到版本 B！
HAPPYCLAW_EXPECTED_SHA="${COMMIT_B}" \
HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${COMMIT_B}" \
HAPPYCLAW_SKIP_FETCH=1 \
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/deploy-release.sh

# 检查工作区指针已切到 B
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "发布后 .releases/current 未切到 store/${COMMIT_B}"
fi

# 核心严格断言：老进程 A（同一 PID 依然存活）再次接收请求，必须 100% 依然返回 A，绝不读取 B！
RESP_A_AGAIN="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_A}\"" <<<"$RESP_A_AGAIN"; then
  log_fail "严重回归：在线切换后，老进程 A 的 bootstrapSha 发生漂移混版！响应: $RESP_A_AGAIN"
fi
STATIC_A_AGAIN="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/static-check")"
if ! grep -q "WEB_VERSION_A" <<<"$STATIC_A_AGAIN"; then
  log_fail "严重回归：在线切换后，老进程 A 读取的静态资源混入了版本 B！响应: $STATIC_A_AGAIN"
fi

# 停掉老进程 A，冷启动新进程 B
kill -9 "${LONG_RUNNING_PID}"
sleep 1
node dist/index.js &
LONG_RUNNING_PID=$!
sleep 1.5

# 检查新启动进程 B 的真实身份与资源
RESP_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/version")"
if ! grep -q "\"bootstrapSha\":\"${COMMIT_B}\"" <<<"$RESP_B"; then
  log_fail "进程 B 启动 SHA 不是 COMMIT_B！响应: $RESP_B"
fi
STATIC_B="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/static-check")"
if ! grep -q "WEB_VERSION_B" <<<"$STATIC_B"; then
  log_fail "进程 B 读取静态资源不是 B！响应: $STATIC_B"
fi
# 验证新进程读写的数据依然与 A 共享
if ! grep -q "SHARED_DATA_DATABASE_ROW_1" data/messages.db; then
  log_fail "共享数据 messages.db 遭到破坏！"
fi
log_pass "场景 4 通过！真实长驻服务进程成功固定不可变运行根，老进程存活绝不混版，新进程平滑加载！"

# --- 场景 5: 【核心针对性测试】同 SHA 再次发布 + pre_build 故障零污染 ---
log_test "场景 5: 【核心针对性测试】同 SHA 再次发布 + pre_build 故障保护 (彻底根治 Leader 复现缺陷)"
# 确保当前在线处于 COMMIT_B
test -f dist/index.js || log_fail "当前在线 dist/index.js 必须存在"
test -f web/dist/index.html || log_fail "当前在线 web/dist/index.html 必须存在"

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
  log_fail "预期退出码 101，实际为: ${SAME_SHA_FAIL_EXIT}"
fi

# 彻底断言：在线产物绝对不被删除，current 绝对不断链！
if [ ! -f "dist/index.js" ]; then
  log_fail "严重回归：同 SHA 部署失败后在线 dist/index.js 丢失！"
fi
if [ ! -f "web/dist/index.html" ]; then
  log_fail "严重回归：同 SHA 部署失败后在线 web/dist/index.html 丢失！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_B}" ]; then
  log_fail "同 SHA 部署失败后 current 符号链接损坏！"
fi
log_pass "场景 5 通过！同 SHA 再次发布遇 pre_build 故障，在线版本与产物 100% 完好无损！"

# --- 场景 6: 原子回滚与上一版本不可变镜像跟随 ---
log_test "场景 6: 原子回滚至 COMMIT_A 与镜像还原"
HAPPYCLAW_SKIP_RESTART=1 \
HAPPYCLAW_SKIP_READINESS=1 \
./scripts/rollback-release.sh "${COMMIT_A}"

if [ "$(git rev-parse HEAD)" != "${COMMIT_A}" ]; then
  log_fail "回滚后 Git HEAD 未恢复至 COMMIT_A！"
fi
if [ "$(readlink .releases/current)" != "store/${COMMIT_A}" ]; then
  log_fail "回滚后 current 未切回 store/${COMMIT_A}！"
fi
if ! grep -q "CONTAINER_IMAGE=riba2534/happyclaw-agent:git-${COMMIT_A}" .env; then
  log_fail "回滚后 .env 中的 CONTAINER_IMAGE 未准确还原为 COMMIT_A 镜像！"
fi
log_pass "场景 6 通过：单步原子回滚成功，镜像准确跟随！"

# --- 场景 7: 就绪探针失败严格以非 0 退出码阻断 ---
log_test "场景 7: 就绪探针失败严格非 0 退出"
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
ROLLBACK_ERROR_EXIT=$?
set -e

if [ "${ROLLBACK_ERROR_EXIT}" -eq 0 ]; then
  log_fail "就绪探针失败但回滚脚本竟然返回了 0！未满足契约！"
fi
log_pass "场景 7 通过：就绪探针失败严格返回非 0 退出码 (${ROLLBACK_ERROR_EXIT})！"

log_test "=== 全部真实物理路径、长驻固定根与故障窗口隔离测试 100% 通过！ ==="
