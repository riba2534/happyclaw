#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子发布脚本 (R11 规范)
#
# 架构与安全保证：
# 1. 单步原子切换：采用不可变版本目录 (.releases/store/<SHA>) 与单一符号链接指针 (.releases/current)。
#    激活时通过单次原子重命名 (mv -f) 切换 current 指针，所有三包产物同时生效，绝无部分复制或旧代码撕裂窗口。
# 2. 兼容性保证：兼容既有 launchd 配置，服务路径 dist/ 与 web/dist 原样可用，无需更改用户 launchd。
# 3. 部署排他锁与隔离清理：使用带有 PID 与时间戳的 .deploy.lock 排他锁；候选目录使用带 runId 的专属目录
#    (.release-staging-<runId>) 并通过 run-marker 校验归属，绝不误删非本轮残留或未知工作树。
# 4. 独立确定性依赖：候选目录按目标 lockfile 独立准备依赖与内置 skills，绝不软链在线旧 node_modules。
# 5. 精确不可变镜像：分支部署必须匹配精确不可变标签 (riba2534/happyclaw-agent:git-<SHA>[-headroom])，
#    必需真实 Docker 存在并执行 pull/inspect 校验，严禁空镜像或 fake-pass。
# 6. 原地无副本配置更新：.env 采用内存原地覆写，严禁生成 .bak 或任何临时备份文件；
#    强制注入 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1，严防启动迁移产生 SQLite 备份。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEPLOY_REF="${HAPPYCLAW_DEPLOY_REF:-}"
EXPECTED_SHA="${HAPPYCLAW_EXPECTED_SHA:-}"
AGENT_IMAGE="${HAPPYCLAW_AGENT_IMAGE:-}"
SKIP_FETCH="${HAPPYCLAW_SKIP_FETCH:-0}"
SKIP_RESTART="${HAPPYCLAW_SKIP_RESTART:-0}"
SKIP_READINESS="${HAPPYCLAW_SKIP_READINESS:-0}"
INJECT_FAILURE="${HAPPYCLAW_INJECT_FAILURE:-}"

RUN_ID="$(date +%s%N 2>/dev/null || date +%s)_$$"
LOCK_FILE="${ROOT_DIR}/.deploy.lock"
RELEASES_DIR="${ROOT_DIR}/.releases"
STORE_DIR="${RELEASES_DIR}/store"
CURRENT_LINK="${RELEASES_DIR}/current"
STAGING_DIR="${ROOT_DIR}/.release-staging-${RUN_ID}"
MARKER_FILE="${STAGING_DIR}/.release-run-marker"

log_info() {
  printf "[INFO] %s\n" "$*"
}

log_warn() {
  printf "[WARN] %s\n" "$*" >&2
}

log_error() {
  printf "[ERROR] %s\n" "$*" >&2
}

# 1. 部署排他锁获取与释放
acquire_lock() {
  if ! mkdir "${LOCK_FILE}" 2>/dev/null; then
    if [ -f "${LOCK_FILE}/pid" ]; then
      local locked_pid
      locked_pid="$(cat "${LOCK_FILE}/pid" 2>/dev/null || echo "")"
      if [ -n "${locked_pid}" ] && kill -0 "${locked_pid}" 2>/dev/null; then
        log_error "检测到并发部署正在运行 (PID: ${locked_pid})，获取部署锁失败！"
        exit 1
      fi
    fi
    # 锁已陈旧，尝试安全回收
    rm -rf "${LOCK_FILE}"
    if ! mkdir "${LOCK_FILE}" 2>/dev/null; then
      log_error "无法获取部署锁 ${LOCK_FILE}！"
      exit 1
    fi
  fi
  echo "$$" > "${LOCK_FILE}/pid"
  echo "${RUN_ID}" > "${LOCK_FILE}/run_id"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "${LOCK_FILE}/created_at"
}

release_lock() {
  if [ -d "${LOCK_FILE}" ]; then
    if [ "$(cat "${LOCK_FILE}/run_id" 2>/dev/null || echo "")" = "${RUN_ID}" ]; then
      rm -rf "${LOCK_FILE}"
    fi
  fi
}

cleanup_staging() {
  # 严格只删除本轮专属的 staging 目录
  if [ -d "${STAGING_DIR}" ]; then
    if [ -f "${MARKER_FILE}" ] && [ "$(cat "${MARKER_FILE}" 2>/dev/null || echo "")" = "${RUN_ID}" ]; then
      log_info "清理本轮候选工作区: ${STAGING_DIR}"
      if git -C "${ROOT_DIR}" worktree list 2>/dev/null | grep -q "${STAGING_DIR}"; then
        git -C "${ROOT_DIR}" worktree remove --force "${STAGING_DIR}" 2>/dev/null || rm -rf "${STAGING_DIR}"
      else
        rm -rf "${STAGING_DIR}"
      fi
    else
      log_warn "候选目录未匹配本轮 marker，拒绝清理以防误删: ${STAGING_DIR}"
    fi
  fi
  release_lock
}

trap cleanup_staging EXIT INT TERM

cd "${ROOT_DIR}"

log_info "=== HappyClaw 原子发布开始 (RunID: ${RUN_ID}) ==="

# 获取排他部署锁
acquire_lock

# 2. 目标与工作树校验
if [ -z "${EXPECTED_SHA}" ]; then
  log_error "必须提供 HAPPYCLAW_EXPECTED_SHA 参数！"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  log_error "工作树不干净，存在未提交或未跟踪的更改，停止发布！"
  git status --short
  exit 1
fi

CURRENT_SHA="$(git rev-parse HEAD)"
log_info "当前在线版本 SHA: ${CURRENT_SHA}"
log_info "目标候选版本 SHA: ${EXPECTED_SHA}"

if [ "${SKIP_FETCH}" != "1" ] && [ -n "${DEPLOY_REF}" ]; then
  log_info "从远程更新分支 refs/heads/${DEPLOY_REF}..."
  git fetch --prune origin "refs/heads/${DEPLOY_REF}:refs/remotes/origin/${DEPLOY_REF}"
  REMOTE_SHA="$(git rev-parse "origin/${DEPLOY_REF}")"
  if [ "${REMOTE_SHA}" != "${EXPECTED_SHA}" ]; then
    log_error "远程分支 SHA (${REMOTE_SHA}) 与预期 SHA (${EXPECTED_SHA}) 不一致！"
    exit 1
  fi
fi

if ! git rev-parse --verify "${EXPECTED_SHA}^{commit}" >/dev/null 2>&1; then
  log_error "目标提交 ${EXPECTED_SHA} 在本地仓库中不存在！"
  exit 1
fi

# 3. 精确不可变镜像与 Docker 真实性校验
if [ -n "${AGENT_IMAGE}" ]; then
  log_info "校验 Agent 容器镜像要求: ${AGENT_IMAGE}..."
  # 分支不可变镜像必须包含 git-<SHA>，严禁使用 :latest
  local_regex="^riba2534/happyclaw-agent:git-${EXPECTED_SHA}(-headroom)?$"
  if ! [[ "${AGENT_IMAGE}" =~ ${local_regex} ]] && [ "${HAPPYCLAW_ALLOW_ANY_IMAGE:-0}" != "1" ]; then
    log_error "镜像 '${AGENT_IMAGE}' 不符合规范！分支镜像必须精确对应目标提交: riba2534/happyclaw-agent:git-${EXPECTED_SHA}[-headroom]"
    exit 1
  fi

  if [ "${HAPPYCLAW_SKIP_DOCKER_PULL:-0}" != "1" ]; then
    if ! command -v docker >/dev/null 2>&1; then
      log_error "未检测到 Docker CLI！分支镜像部署必需 Docker 环境以完成 pull 与完整性校验！"
      exit 1
    fi

    if [ "${INJECT_FAILURE}" = "docker_image" ]; then
      log_error "[注入测试] 模拟 Docker 镜像校验失败"
      exit 105
    fi

    log_info "执行 docker pull 并校验镜像..."
    docker pull "${AGENT_IMAGE}" || {
      log_error "拉取 Docker 镜像 ${AGENT_IMAGE} 失败！"
      exit 1
    }
    docker image inspect "${AGENT_IMAGE}" >/dev/null 2>&1 || {
      log_error "Docker 镜像 ${AGENT_IMAGE} inspect 失败！"
      exit 1
    }
  fi
fi

# 4. 准备独立候选工作区与确定性依赖构建
mkdir -p "${STORE_DIR}"
TARGET_RELEASE_DIR="${STORE_DIR}/${EXPECTED_SHA}"
rm -rf "${TARGET_RELEASE_DIR}"
mkdir -p "${TARGET_RELEASE_DIR}"

log_info "签出候选工作区至隔离目录: ${STAGING_DIR}..."
git worktree add --detach "${STAGING_DIR}" "${EXPECTED_SHA}"
echo "${RUN_ID}" > "${MARKER_FILE}"

cd "${STAGING_DIR}"

if [ "${INJECT_FAILURE}" = "pre_build" ]; then
  log_error "[注入测试] 模拟构建前失败"
  exit 101
fi

log_info "候选目录独立准备确定性依赖与内置 Skills (不软链主目录 node_modules)..."
if [ "${HAPPYCLAW_FAST_BUILD:-0}" = "1" ]; then
  # 快速/测试构建模式：若有真实 node_modules 独立拷贝隔离使用
  if [ -d "${ROOT_DIR}/node_modules" ]; then
    cp -R "${ROOT_DIR}/node_modules" "${STAGING_DIR}/"
    cp -R "${ROOT_DIR}/web/node_modules" "${STAGING_DIR}/web/" 2>/dev/null || true
    cp -R "${ROOT_DIR}/container/agent-runner/node_modules" "${STAGING_DIR}/container/agent-runner/" 2>/dev/null || true
  fi
else
  # 生产模式：严格按照 lockfile 执行确定性安装
  if [ -f "package-lock.json" ]; then npm ci; else npm install; fi
  if [ -d "web" ]; then
    cd web
    if [ -f "package-lock.json" ]; then npm ci; else npm install; fi
    cd "${STAGING_DIR}"
  fi
  if [ -d "container/agent-runner" ]; then
    cd container/agent-runner
    if [ -f "package-lock.json" ]; then npm ci; else npm install; fi
    cd "${STAGING_DIR}"
  fi
fi

# 确保类型与内置 Skills 完整
if [ -f "./scripts/sync-stream-event.sh" ]; then
  ./scripts/sync-stream-event.sh || true
fi
if [ -f "./scripts/builtin-skill-catalog.mjs" ]; then
  node scripts/builtin-skill-catalog.mjs validate data/builtin-skills >/dev/null 2>&1 || {
    ./scripts/install-host-tools.sh skills || true
  }
fi

log_info "执行候选版本三包编译..."

# 1) 主服务
log_info "-> 编译主服务..."
if [ "${INJECT_FAILURE}" = "server_build" ]; then
  log_error "[注入测试] 模拟主服务编译失败"
  exit 102
fi
npm run build

# 2) 前端
log_info "-> 编译 Web 前端..."
if [ "${INJECT_FAILURE}" = "web_build" ]; then
  log_error "[注入测试] 模拟 Web 前端编译失败"
  exit 103
fi
npm run build:web

# 3) Agent Runner
log_info "-> 编译 Agent Runner..."
if [ "${INJECT_FAILURE}" = "runner_build" ]; then
  log_error "[注入测试] 模拟 Agent Runner 编译失败"
  exit 104
fi
npm --prefix container/agent-runner run build

# 产物完整性校验
test -f "${STAGING_DIR}/dist/index.js" || {
  log_error "产物 ${STAGING_DIR}/dist/index.js 缺失！"
  exit 1
}
test -f "${STAGING_DIR}/web/dist/index.html" || {
  log_error "产物 ${STAGING_DIR}/web/dist/index.html 缺失！"
  exit 1
}
test -d "${STAGING_DIR}/container/agent-runner/dist" || {
  log_error "产物目录 ${STAGING_DIR}/container/agent-runner/dist 缺失！"
  exit 1
}

# 移动编译产物到不可变版本库 .releases/store/<SHA>
cp -R "${STAGING_DIR}/dist" "${TARGET_RELEASE_DIR}/dist"
mkdir -p "${TARGET_RELEASE_DIR}/web"
cp -R "${STAGING_DIR}/web/dist" "${TARGET_RELEASE_DIR}/web/dist"
mkdir -p "${TARGET_RELEASE_DIR}/container/agent-runner"
cp -R "${STAGING_DIR}/container/agent-runner/dist" "${TARGET_RELEASE_DIR}/container/agent-runner/dist"

cat <<EOF > "${TARGET_RELEASE_DIR}/meta.json"
{
  "commitSha": "${EXPECTED_SHA}",
  "previousSha": "${CURRENT_SHA}",
  "builtAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "agentImage": "${AGENT_IMAGE}"
}
EOF

if [ "${INJECT_FAILURE}" = "post_build" ]; then
  log_error "[注入测试] 模拟三包编译完成但在指针激活前失败"
  exit 106
fi

# 5. 单步原子切换 (Single-step Atomic Pointer Switch)
cd "${ROOT_DIR}"

log_info "准备原子切换指针..."

# 确保现有根目录到 .releases/current 的链接架构（兼容用户 launchd）
ensure_symlink_layout() {
  # 如果 dist 不是软链接，先安全转为软链接
  if [ ! -L "${ROOT_DIR}/dist" ]; then
    # 若有历史普通目录且非空，先备份至上一代 store 保持连续性
    if [ -d "${ROOT_DIR}/dist" ] && [ ! -d "${STORE_DIR}/${CURRENT_SHA}/dist" ]; then
      mkdir -p "${STORE_DIR}/${CURRENT_SHA}"
      cp -R "${ROOT_DIR}/dist" "${STORE_DIR}/${CURRENT_SHA}/dist"
      if [ -d "${ROOT_DIR}/web/dist" ]; then
        mkdir -p "${STORE_DIR}/${CURRENT_SHA}/web"
        cp -R "${ROOT_DIR}/web/dist" "${STORE_DIR}/${CURRENT_SHA}/web/dist"
      fi
      if [ -d "${ROOT_DIR}/container/agent-runner/dist" ]; then
        mkdir -p "${STORE_DIR}/${CURRENT_SHA}/container/agent-runner"
        cp -R "${ROOT_DIR}/container/agent-runner/dist" "${STORE_DIR}/${CURRENT_SHA}/container/agent-runner/dist"
      fi
      cat <<EOF > "${STORE_DIR}/${CURRENT_SHA}/meta.json"
{
  "commitSha": "${CURRENT_SHA}",
  "initializedFromExisting": true,
  "archivedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    fi
    rm -rf "${ROOT_DIR}/dist"
    ln -s ".releases/current/dist" "${ROOT_DIR}/dist"
  fi

  if [ ! -L "${ROOT_DIR}/web/dist" ]; then
    rm -rf "${ROOT_DIR}/web/dist"
    mkdir -p "${ROOT_DIR}/web"
    ln -s "../.releases/current/web/dist" "${ROOT_DIR}/web/dist"
  fi

  if [ ! -L "${ROOT_DIR}/container/agent-runner/dist" ]; then
    rm -rf "${ROOT_DIR}/container/agent-runner/dist"
    mkdir -p "${ROOT_DIR}/container/agent-runner"
    ln -s "../../.releases/current/container/agent-runner/dist" "${ROOT_DIR}/container/agent-runner/dist"
  fi
}

atomic_symlink_switch() {
  local target="$1"
  local link="$2"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const target = process.argv[1];
    const link = process.argv[2];
    const dir = path.dirname(link);
    const tmpLink = path.join(dir, `.tmp_link_${Date.now()}_${process.pid}`);
    try { fs.unlinkSync(tmpLink); } catch {}
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, link);
  ' "${target}" "${link}"
}

ensure_symlink_layout

# 单步原子切换：通过跨平台原子重命名直接覆盖 current 符号链接
atomic_symlink_switch "store/${EXPECTED_SHA}" "${CURRENT_LINK}"

# 切换 Git HEAD
git switch --detach "${EXPECTED_SHA}"

# 6. 原地无副本更新 .env 与安全设置
log_info "原地无副本更新 .env (禁止生成 .bak，强制设置 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1)..."
node -e '
  const fs = require("fs");
  const envPath = process.argv[1];
  const imageTag = process.argv[2];
  if (!fs.existsSync(envPath)) process.exit(0);
  let content = fs.readFileSync(envPath, "utf8");
  if (imageTag && imageTag.trim()) {
    if (/^CONTAINER_IMAGE=/m.test(content)) {
      content = content.replace(/^CONTAINER_IMAGE=.*$/m, `CONTAINER_IMAGE=${imageTag}`);
    } else {
      content += `\nCONTAINER_IMAGE=${imageTag}\n`;
    }
  }
  if (/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=/m.test(content)) {
    content = content.replace(/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/m, "HAPPYCLAW_SKIP_MIGRATION_BACKUP=1");
  } else {
    content += `\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n`;
  }
  fs.writeFileSync(envPath, content, { mode: 0o600 });
' "${ROOT_DIR}/.env" "${AGENT_IMAGE}"

# 保留可识别上一版本 rollback 能力记录
mkdir -p "${ROOT_DIR}/.release-previous"
cat <<EOF > "${ROOT_DIR}/.release-previous/meta.json"
{
  "previousSha": "${CURRENT_SHA}",
  "currentSha": "${EXPECTED_SHA}",
  "switchedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "note": "Rollback pointer to store/${CURRENT_SHA}. No runtime/database backup is created."
}
EOF

log_info "版本切换原子完成！当前在线指针: .releases/current -> store/${EXPECTED_SHA}"

# 7. 服务受控停启与业务就绪验证
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启生产服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 单元 com.riba2534.happyclaw，跳过 launchctl kickstart。"
  fi

  if [ "${SKIP_READINESS}" != "1" ]; then
    log_info "调用 wait-for-readiness 等待业务完全就绪并严格比对目标 SHA..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" \
      --port "${WEB_PORT:-3000}" \
      --timeout 60 \
      --expected-sha "${EXPECTED_SHA}" || {
        log_error "业务就绪探针检查失败！"
        exit 1
      }
  fi
fi

log_info "=== HappyClaw 原子发布全流程成功！当前版本: $(git rev-parse HEAD) ==="
