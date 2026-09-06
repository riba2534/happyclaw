#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产回滚脚本 (Rollback Release)
#
# 满足约束：
# 1. 精确回到上一代代码提交 SHA 与三包编译产物。
# 2. 严格遵守所有者关于不保留运行数据/数据库备份的现行政策：绝不触碰或还原 SQLite/runtime/.env 数据。
# 3. 兼容 Mac mini launchd 配置与服务路径。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PREVIOUS_DIR="${ROOT_DIR}/.release-previous"
CURRENT_RELEASE_FILE="${ROOT_DIR}/.release-current.json"
TARGET_SHA="${1:-${HAPPYCLAW_ROLLBACK_SHA:-}}"
SKIP_RESTART="${HAPPYCLAW_SKIP_RESTART:-0}"
SKIP_READINESS="${HAPPYCLAW_SKIP_READINESS:-0}"

log_info() {
  printf "[INFO] %s\n" "$*"
}

log_warn() {
  printf "[WARN] %s\n" "$*" >&2
}

log_error() {
  printf "[ERROR] %s\n" "$*" >&2
}

cd "${ROOT_DIR}"

log_info "=== HappyClaw 回滚流程开始 ==="

if [ -z "${TARGET_SHA}" ]; then
  if [ -f "${PREVIOUS_DIR}/meta.json" ]; then
    TARGET_SHA="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${PREVIOUS_DIR}/meta.json','utf8')); process.stdout.write(m.commitSha || ''); } catch {}")"
  fi
fi

if [ -z "${TARGET_SHA}" ]; then
  log_error "未指定回滚目标 SHA，且未在 ${PREVIOUS_DIR}/meta.json 找到可识别的上一版本记录！"
  log_error "用法: $0 <commit-sha>"
  exit 1
fi

log_info "准备回滚至目标代码版本: ${TARGET_SHA}"

# 验证本地 git 对象库包含目标 SHA
if ! git rev-parse --verify "${TARGET_SHA}^{commit}" >/dev/null 2>&1; then
  log_error "目标回滚提交 ${TARGET_SHA} 在本地仓库中不存在！"
  exit 1
fi

# 检查当前工作区是否干净
if [ -n "$(git status --porcelain)" ]; then
  log_error "工作区不干净，存在未提交文件，拒绝回滚！"
  git status --short
  exit 1
fi

# 1. 切换 Git HEAD
log_info "切换代码到 ${TARGET_SHA}..."
git switch --detach "${TARGET_SHA}"

# 2. 产物还原：如果有归档好的产物且归档 SHA 一致，直接还原；否则在本地重新编译
CAN_USE_ARCHIVE=0
if [ -f "${PREVIOUS_DIR}/meta.json" ]; then
  ARCHIVED_SHA="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${PREVIOUS_DIR}/meta.json','utf8')); process.stdout.write(m.commitSha || ''); } catch {}")"
  if [ "${ARCHIVED_SHA}" = "${TARGET_SHA}" ]; then
    CAN_USE_ARCHIVE=1
  fi
fi

if [ "${CAN_USE_ARCHIVE}" = "1" ] && [ -d "${PREVIOUS_DIR}/dist" ] && [ -d "${PREVIOUS_DIR}/web/dist" ]; then
  log_info "从 .release-previous 快速还原三包产物..."
  rm -rf "${ROOT_DIR}/dist"
  cp -R "${PREVIOUS_DIR}/dist" "${ROOT_DIR}/dist"

  rm -rf "${ROOT_DIR}/web/dist"
  mkdir -p "${ROOT_DIR}/web"
  cp -R "${PREVIOUS_DIR}/web/dist" "${ROOT_DIR}/web/dist"

  if [ -d "${PREVIOUS_DIR}/container/agent-runner/dist" ]; then
    rm -rf "${ROOT_DIR}/container/agent-runner/dist"
    mkdir -p "${ROOT_DIR}/container/agent-runner"
    cp -R "${PREVIOUS_DIR}/container/agent-runner/dist" "${ROOT_DIR}/container/agent-runner/dist"
  fi
else
  log_info "归档产物不存在或 SHA 不匹配，执行本地确定性三包构建..."
  npm run build
  npm run build:web
  npm --prefix container/agent-runner run build
fi

# 3. 更新当前发布元数据
cat <<EOF > "${CURRENT_RELEASE_FILE}"
{
  "commitSha": "${TARGET_SHA}",
  "rolledBackAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "action": "rollback"
}
EOF

# 4. 服务重载与验证
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启服务 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 服务单元 com.riba2534.happyclaw，跳过 launchctl 重启。"
  fi

  if [ "${SKIP_READINESS}" != "1" ] && [ -f "${SCRIPT_DIR}/wait-for-readiness.mjs" ]; then
    log_info "等待业务就绪探针 (Readiness)..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" --port "${WEB_PORT:-3000}" --timeout 60 || {
      log_warn "回滚后就绪探针未能在超时内就绪，请手动检查服务日志。"
    }
  fi
fi

log_info "=== 回滚完成！当前版本: $(git rev-parse HEAD) ==="
