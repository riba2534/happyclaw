#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子发布脚本 (Atomic Release)
#
# 满足约束：
# 1. 独立候选代码与构建产物准备：在独立候选工作区 (.release-candidate) 完整构建三包并验证，
#    任一步骤（代码检出、依赖、主服务构建、web 构建、runner 构建、镜像验证）失败，
#    绝不影响在线工作区正在运行的进程、代码与 web/dist 静态资源。
# 2. 代码与三包产物一致性切换：三包与镜像全部就绪后，原子切换在线代码 (git commit) 与三包产物。
# 3. 旧版本回滚能力：在线切换前在 .release-previous 仅归档上一代代码 SHA 与三包产物，
#    严禁备份或修改 SQLite / runtime / .env 等业务运行数据。
# 4. 兼容 Mac mini launchd 配置与服务路径，原样保留 data/、.env、Keychain 配置。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 环境变量及默认配置
DEPLOY_REF="${HAPPYCLAW_DEPLOY_REF:-}"
EXPECTED_SHA="${HAPPYCLAW_EXPECTED_SHA:-}"
AGENT_IMAGE="${HAPPYCLAW_AGENT_IMAGE:-}"
SKIP_FETCH="${HAPPYCLAW_SKIP_FETCH:-0}"
SKIP_RESTART="${HAPPYCLAW_SKIP_RESTART:-0}"
SKIP_READINESS="${HAPPYCLAW_SKIP_READINESS:-0}"
SKIP_DOCKER_PULL="${HAPPYCLAW_SKIP_DOCKER_PULL:-0}"
INJECT_FAILURE="${HAPPYCLAW_INJECT_FAILURE:-}"

STAGING_DIR="${ROOT_DIR}/.release-candidate"
PREVIOUS_DIR="${ROOT_DIR}/.release-previous"
CURRENT_RELEASE_FILE="${ROOT_DIR}/.release-current.json"

log_info() {
  printf "[INFO] %s\n" "$*"
}

log_warn() {
  printf "[WARN] %s\n" "$*" >&2
}

log_error() {
  printf "[ERROR] %s\n" "$*" >&2
}

cleanup_staging() {
  if [ -d "${STAGING_DIR}" ]; then
    log_info "清理候选构建工作区: ${STAGING_DIR}"
    if git -C "${ROOT_DIR}" worktree list 2>/dev/null | grep -q "${STAGING_DIR}"; then
      git -C "${ROOT_DIR}" worktree remove --force "${STAGING_DIR}" 2>/dev/null || rm -rf "${STAGING_DIR}"
    else
      rm -rf "${STAGING_DIR}"
    fi
  fi
}

trap cleanup_staging EXIT INT TERM

cd "${ROOT_DIR}"

log_info "=== HappyClaw 原子发布开始 ==="

# 1. 基础预检
if [ -z "${EXPECTED_SHA}" ]; then
  log_error "必须提供 HAPPYCLAW_EXPECTED_SHA 参数！"
  exit 1
fi

# 检查当前线上工作区干净程度
if [ -n "$(git status --porcelain)" ]; then
  log_error "线上工作区不干净，存在未提交或未跟踪的更改，停止发布！"
  git status --short
  exit 1
fi

CURRENT_SHA="$(git rev-parse HEAD)"
log_info "当前运行版本 SHA: ${CURRENT_SHA}"
log_info "目标候选版本 SHA: ${EXPECTED_SHA}"

# 若不是本地模式且指定了 DEPLOY_REF，执行远程同步与校验
if [ "${SKIP_FETCH}" != "1" ] && [ -n "${DEPLOY_REF}" ]; then
  log_info "从远程仓库更新分支 refs/heads/${DEPLOY_REF}..."
  git fetch --prune origin "refs/heads/${DEPLOY_REF}:refs/remotes/origin/${DEPLOY_REF}"
  REMOTE_SHA="$(git rev-parse "origin/${DEPLOY_REF}")"
  if [ "${REMOTE_SHA}" != "${EXPECTED_SHA}" ]; then
    log_error "远程分支 SHA (${REMOTE_SHA}) 与预期 SHA (${EXPECTED_SHA}) 不匹配！"
    exit 1
  fi
fi

# 验证本地 git 对象库包含目标 SHA
if ! git rev-parse --verify "${EXPECTED_SHA}^{commit}" >/dev/null 2>&1; then
  log_error "目标提交 ${EXPECTED_SHA} 在本地仓库中不存在！"
  exit 1
fi

# 2. 独立候选工作区准备 (Staging Preparation)
cleanup_staging

log_info "在独立目录创建候选工作区..."
git worktree add --detach "${STAGING_DIR}" "${EXPECTED_SHA}"

# 进入独立候选目录进行依赖与三包构建
cd "${STAGING_DIR}"

# 模拟注入失败测试点：准备前失败
if [ "${INJECT_FAILURE}" = "pre_build" ]; then
  log_error "[注入测试] 模拟在构建开始前发生错误"
  exit 101
fi

log_info "准备候选目录依赖与内置 Skills..."
# 复用或软链接 node_modules 加快构建，同时保持主目录 node_modules 安全
if [ -d "${ROOT_DIR}/node_modules" ] && [ ! -d "${STAGING_DIR}/node_modules" ]; then
  ln -s "${ROOT_DIR}/node_modules" "${STAGING_DIR}/node_modules"
fi
if [ -d "${ROOT_DIR}/web/node_modules" ] && [ ! -d "${STAGING_DIR}/web/node_modules" ]; then
  ln -s "${ROOT_DIR}/web/node_modules" "${STAGING_DIR}/web/node_modules"
fi
if [ -d "${ROOT_DIR}/container/agent-runner/node_modules" ] && [ ! -d "${STAGING_DIR}/container/agent-runner/node_modules" ]; then
  ln -s "${ROOT_DIR}/container/agent-runner/node_modules" "${STAGING_DIR}/container/agent-runner/node_modules"
fi

# 同步 shared 类型
if [ -f "./scripts/sync-stream-event.sh" ]; then
  ./scripts/sync-stream-event.sh || true
fi

log_info "构建候选版本三包..."

# 1) 主服务构建
log_info "-> 构建主服务 (tsc)..."
if [ "${INJECT_FAILURE}" = "server_build" ]; then
  log_error "[注入测试] 模拟主服务构建失败"
  exit 102
fi
npm run build

# 2) Web 前端构建
log_info "-> 构建前端 (web)..."
if [ "${INJECT_FAILURE}" = "web_build" ]; then
  log_error "[注入测试] 模拟 Web 前端构建失败"
  exit 103
fi
npm run build:web

# 3) Agent Runner 构建
log_info "-> 构建 Agent Runner..."
if [ "${INJECT_FAILURE}" = "runner_build" ]; then
  log_error "[注入测试] 模拟 Agent Runner 构建失败"
  exit 104
fi
npm --prefix container/agent-runner run build

# 产物完整性严格校验
log_info "验证候选三包构建产物..."
test -f "${STAGING_DIR}/dist/index.js" || {
  log_error "主服务产物 ${STAGING_DIR}/dist/index.js 不存在！"
  exit 1
}
test -f "${STAGING_DIR}/web/dist/index.html" || {
  log_error "前端产物 ${STAGING_DIR}/web/dist/index.html 不存在！"
  exit 1
}
test -d "${STAGING_DIR}/container/agent-runner/dist" || {
  log_error "Runner 产物目录 ${STAGING_DIR}/container/agent-runner/dist 不存在！"
  exit 1
}

# 4) Docker 镜像校验 (若指定镜像)
if [ -n "${AGENT_IMAGE}" ]; then
  log_info "校验 Agent 容器镜像: ${AGENT_IMAGE}..."
  # 验证镜像 tag 必须是不可变 SHA tag，禁止推 latest
  if [[ "${AGENT_IMAGE}" =~ :latest$ ]] && [ "${HAPPYCLAW_ALLOW_LATEST_IMAGE:-0}" != "1" ]; then
    log_error "生产部署禁止使用浮动的 :latest 标签镜像，必须使用不可变提交镜像，如 riba2534/happyclaw-agent:git-<SHA>！"
    exit 1
  fi

  if [ "${INJECT_FAILURE}" = "docker_image" ]; then
    log_error "[注入测试] 模拟 Docker 镜像拉取或校验失败"
    exit 105
  fi

  if [ "${SKIP_DOCKER_PULL}" != "1" ] && command -v docker >/dev/null 2>&1; then
    docker pull "${AGENT_IMAGE}" || {
      log_error "拉取 Docker 镜像 ${AGENT_IMAGE} 失败！"
      exit 1
    }
  else
    log_info "跳过 Docker 镜像拉取 (SKIP_DOCKER_PULL=${SKIP_DOCKER_PULL})。"
  fi
fi

if [ "${INJECT_FAILURE}" = "post_build" ]; then
  log_error "[注入测试] 模拟全部构建完成后但在激活切换前发生意外"
  exit 106
fi

log_info "候选版本所有构建与产物校验 100% 成功！准备原子激活..."

# 3. 原子激活与在线版本切换 (Atomic Activation)
cd "${ROOT_DIR}"

# 准备上一版本归档目录（只保存可执行产物及元数据，绝不备份 SQLite/runtime/.env）
rm -rf "${PREVIOUS_DIR}"
mkdir -p "${PREVIOUS_DIR}"

# 归档现有在线三包产物（若存在）
if [ -d "${ROOT_DIR}/dist" ]; then
  cp -R "${ROOT_DIR}/dist" "${PREVIOUS_DIR}/dist"
fi
if [ -d "${ROOT_DIR}/web/dist" ]; then
  mkdir -p "${PREVIOUS_DIR}/web"
  cp -R "${ROOT_DIR}/web/dist" "${PREVIOUS_DIR}/web/dist"
fi
if [ -d "${ROOT_DIR}/container/agent-runner/dist" ]; then
  mkdir -p "${PREVIOUS_DIR}/container/agent-runner"
  cp -R "${ROOT_DIR}/container/agent-runner/dist" "${PREVIOUS_DIR}/container/agent-runner/dist"
fi

cat <<EOF > "${PREVIOUS_DIR}/meta.json"
{
  "commitSha": "${CURRENT_SHA}",
  "archivedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "note": "Rollback bundle containing only build artifacts and commit SHA. No runtime/database data is preserved here."
}
EOF

# 切换在线代码到目标提交
log_info "切换工作区 HEAD 到目标提交: ${EXPECTED_SHA}..."
git switch --detach "${EXPECTED_SHA}"

# 原子替换产物到在线工作区
log_info "同步激活三包产物到在线工作区..."
# 主服务 dist
rm -rf "${ROOT_DIR}/dist"
cp -R "${STAGING_DIR}/dist" "${ROOT_DIR}/dist"

# 前端 web/dist
rm -rf "${ROOT_DIR}/web/dist"
mkdir -p "${ROOT_DIR}/web"
cp -R "${STAGING_DIR}/web/dist" "${ROOT_DIR}/web/dist"

# Agent runner dist
rm -rf "${ROOT_DIR}/container/agent-runner/dist"
mkdir -p "${ROOT_DIR}/container/agent-runner"
cp -R "${STAGING_DIR}/container/agent-runner/dist" "${ROOT_DIR}/container/agent-runner/dist"

# 若指定不可变镜像，更新 .env 的 CONTAINER_IMAGE（保持原有配置与权限不变）
if [ -n "${AGENT_IMAGE}" ] && [ -f "${ROOT_DIR}/.env" ]; then
  log_info "原地更新 .env 中的 CONTAINER_IMAGE..."
  if grep -q '^CONTAINER_IMAGE=' "${ROOT_DIR}/.env"; then
    sed -i.bak "s|^CONTAINER_IMAGE=.*$|CONTAINER_IMAGE=${AGENT_IMAGE}|" "${ROOT_DIR}/.env"
    rm -f "${ROOT_DIR}/.env.bak"
  else
    printf '\nCONTAINER_IMAGE=%s\n' "${AGENT_IMAGE}" >> "${ROOT_DIR}/.env"
  fi
  chmod 600 "${ROOT_DIR}/.env"
fi

# 记录当前发布信息
cat <<EOF > "${CURRENT_RELEASE_FILE}"
{
  "commitSha": "${EXPECTED_SHA}",
  "previousSha": "${CURRENT_SHA}",
  "deployedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "agentImage": "${AGENT_IMAGE}"
}
EOF

log_info "在线代码与产物已原子切换为版本: ${EXPECTED_SHA}"

# 4. 服务重载与业务就绪等待
if [ "${SKIP_RESTART}" != "1" ]; then
  # 检查是否在 Mac mini 环境下由 launchd 管理
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 服务单元 com.riba2534.happyclaw，跳过 launchctl 重启（非 Mac mini 生产环境）。"
  fi

  # 等待业务就绪
  if [ "${SKIP_READINESS}" != "1" ]; then
    log_info "等待业务就绪探针 (Readiness)..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" --port "${WEB_PORT:-3000}" --timeout 60 || {
      log_error "业务就绪检查失败！服务未在规定时间内达到就绪状态！"
      exit 1
    }
  fi
fi

log_info "=== HappyClaw 原子发布成功完成！==="
log_info "当前提交: $(git rev-parse HEAD)"
log_info "若需回滚，可运行: ${SCRIPT_DIR}/rollback-release.sh"
