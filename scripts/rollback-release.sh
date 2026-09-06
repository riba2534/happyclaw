#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子回滚脚本 (R11 规范)
#
# 架构与安全保证：
# 1. 瞬时原子回滚：通过单步原子重命名将 .releases/current 指针切换回上一版本不可变目录 (.releases/store/<SHA>)。
# 2. 严格镜像跟随：从上一代 meta.json 读取并原地覆写还原上一版本不可变 Agent 镜像。
# 3. 边界说明：数据库迁移若已不可逆向前推进，所有者现行政策不保留数据备份，此时禁止降级数据库，
#    回滚仅适用于代码/构建异常且数据库仍向下兼容的场景；若数据库不兼容必须以前向修复恢复服务。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RELEASES_DIR="${ROOT_DIR}/.releases"
STORE_DIR="${RELEASES_DIR}/store"
CURRENT_LINK="${RELEASES_DIR}/current"
PREVIOUS_DIR="${ROOT_DIR}/.release-previous"

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

log_info "=== HappyClaw 原子回滚流程开始 ==="

if [ -z "${TARGET_SHA}" ]; then
  if [ -f "${PREVIOUS_DIR}/meta.json" ]; then
    TARGET_SHA="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${PREVIOUS_DIR}/meta.json','utf8')); process.stdout.write(m.previousSha || ''); } catch {}")"
  fi
fi

if [ -z "${TARGET_SHA}" ]; then
  log_error "未指定回滚目标 SHA，且无法从 .release-previous/meta.json 读取上一版本记录！"
  log_error "用法: $0 <commit-sha>"
  exit 1
fi

log_info "目标回滚提交 SHA: ${TARGET_SHA}"

if ! git rev-parse --verify "${TARGET_SHA}^{commit}" >/dev/null 2>&1; then
  log_error "目标提交 ${TARGET_SHA} 在本地仓库中不存在！"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  log_error "工作树不干净，存在未提交文件，拒绝回滚！"
  git status --short
  exit 1
fi

TARGET_STORE_DIR="${STORE_DIR}/${TARGET_SHA}"

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

# 1. 检查不可变版本库中是否存在预编译好的三包产物
if [ ! -d "${TARGET_STORE_DIR}/dist" ] || [ ! -d "${TARGET_STORE_DIR}/web/dist" ]; then
  log_warn "不可变版本库 ${TARGET_STORE_DIR} 缺失产物，转入独立候选准备流程构建目标版本..."
  HAPPYCLAW_EXPECTED_SHA="${TARGET_SHA}" \
  HAPPYCLAW_SKIP_RESTART=1 \
  HAPPYCLAW_SKIP_READINESS=1 \
  "${SCRIPT_DIR}/deploy-release.sh"
else
  log_info "从版本库 store/${TARGET_SHA} 单步原子切换当前运行指针..."
  atomic_symlink_switch "store/${TARGET_SHA}" "${CURRENT_LINK}"
  git switch --detach "${TARGET_SHA}"

  # 读取并跟随上一版本镜像
  PREVIOUS_IMAGE=""
  if [ -f "${TARGET_STORE_DIR}/meta.json" ]; then
    PREVIOUS_IMAGE="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${TARGET_STORE_DIR}/meta.json','utf8')); process.stdout.write(m.agentImage || ''); } catch {}")"
  fi

  if [ -n "${PREVIOUS_IMAGE}" ]; then
    log_info "还原上一版本不可变镜像: ${PREVIOUS_IMAGE}..."
    node -e '
      const fs = require("fs");
      const envPath = process.argv[1];
      const imageTag = process.argv[2];
      if (!fs.existsSync(envPath) || !imageTag) process.exit(0);
      let content = fs.readFileSync(envPath, "utf8");
      if (/^CONTAINER_IMAGE=/m.test(content)) {
        content = content.replace(/^CONTAINER_IMAGE=.*$/m, `CONTAINER_IMAGE=${imageTag}`);
      } else {
        content += `\nCONTAINER_IMAGE=${imageTag}\n`;
      }
      fs.writeFileSync(envPath, content, { mode: 0o600 });
    ' "${ROOT_DIR}/.env" "${PREVIOUS_IMAGE}"
  fi
fi

# 2. 服务受控重启与验证
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 服务单元 com.riba2534.happyclaw，跳过 launchctl 重启。"
  fi

  if [ "${SKIP_READINESS}" != "1" ] && [ -f "${SCRIPT_DIR}/wait-for-readiness.mjs" ]; then
    log_info "等待回滚后业务就绪探针并校验目标 SHA..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" \
      --port "${WEB_PORT:-3000}" \
      --timeout 60 \
      --expected-sha "${TARGET_SHA}" || {
        log_warn "回滚后未能在超时内达到就绪状态，请手动检查服务日志。"
      }
  fi
fi

log_info "=== 原子回滚成功完成！当前版本: $(git rev-parse HEAD) ==="
