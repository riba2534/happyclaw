#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子回滚脚本 (R11 终极规范：不可变运行根与严格错误阻断)
#
# 架构与安全保证：
# 1. 持有相同部署排他锁，防止回滚与并发发布冲突；
# 2. 单步原子重命名将 .releases/current 指针切回上一版本不可变根 (.releases/store/<SHA>)；
# 3. 严格镜像跟随：从上一版本不可变元数据准确读取并内存原地覆写还原上一版本不可变 Agent 镜像；
# 4. 严格错误阻断：wait 工具缺失、服务重启或业务就绪验证失败时必须严格以非 0 退出码退出；
# 5. 边界说明：数据库若已不可逆向前迁移，所有者现行政策不保留数据备份，此时禁止降级数据库，
#    必须以前向修复恢复服务。
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RELEASES_DIR="${ROOT_DIR}/.releases"
STORE_DIR="${RELEASES_DIR}/store"
CURRENT_LINK="${RELEASES_DIR}/current"
PREVIOUS_DIR="${ROOT_DIR}/.release-previous"
LOCK_FILE="${ROOT_DIR}/.deploy.lock"

RUN_ID="rollback_$(date +%s%N 2>/dev/null || date +%s)_$$"
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

# 1. 跨平台单步原子符号链接切换
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

# 2. 原子所有权排他锁
acquire_lock() {
  node -e '
    const fs = require("fs");
    const lockFile = process.argv[1];
    const pid = Number(process.argv[2]);
    const runId = process.argv[3];

    if (fs.existsSync(lockFile)) {
      try {
        const raw = fs.readFileSync(lockFile, "utf8");
        const info = JSON.parse(raw);
        if (info.pid && typeof info.pid === "number") {
          try {
            process.kill(info.pid, 0);
            console.error(`[LOCK] 并发冲突：检测到部署正在执行中 (PID: ${info.pid}, RunID: ${info.runId})！`);
            process.exit(1);
          } catch (e) {
            fs.unlinkSync(lockFile);
          }
        } else {
          console.error("[LOCK] 发现未知归属锁文件，保守 fail-closed 拒绝操作！");
          process.exit(1);
        }
      } catch (err) {
        console.error("[LOCK] 检查已有锁失败，保守 fail-closed 拒绝操作！", err.message);
        process.exit(1);
      }
    }

    try {
      const payload = JSON.stringify({ pid, runId, startedAt: new Date().toISOString() });
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      process.exit(0);
    } catch (err) {
      console.error("[LOCK] 获取排他锁失败！并发冲突！", err.message);
      process.exit(1);
    }
  ' "${LOCK_FILE}" "$$" "${RUN_ID}"
}

release_lock() {
  node -e '
    const fs = require("fs");
    const lockFile = process.argv[1];
    const runId = process.argv[2];
    if (fs.existsSync(lockFile)) {
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        if (info.runId === runId) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    }
  ' "${LOCK_FILE}" "${RUN_ID}"
}

trap release_lock EXIT INT TERM

cd "${ROOT_DIR}"

log_info "=== HappyClaw 原子回滚流程开始 ==="

acquire_lock

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

# 3. 检查不可变版本库中是否存在预编译好的完整产物
if [ ! -d "${TARGET_STORE_DIR}/dist" ] || [ ! -d "${TARGET_STORE_DIR}/web/dist" ]; then
  log_warn "不可变版本库 ${TARGET_STORE_DIR} 缺失产物，转入独立候选发布流程重建目标版本..."
  release_lock
  HAPPYCLAW_EXPECTED_SHA="${TARGET_SHA}" \
  HAPPYCLAW_SKIP_RESTART=1 \
  HAPPYCLAW_SKIP_READINESS=1 \
  "${SCRIPT_DIR}/deploy-release.sh"
else
  log_info "从不可变版本库 store/${TARGET_SHA} 单步原子切换当前运行指针..."
  atomic_symlink_switch "store/${TARGET_SHA}" "${CURRENT_LINK}"
  git switch --detach "${TARGET_SHA}"

  # 读取并准确跟随上一版本镜像
  PREVIOUS_IMAGE=""
  if [ -f "${TARGET_STORE_DIR}/version.json" ]; then
    PREVIOUS_IMAGE="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${TARGET_STORE_DIR}/version.json','utf8')); process.stdout.write(m.agentImage || ''); } catch {}")"
  elif [ -f "${PREVIOUS_DIR}/meta.json" ]; then
    PREVIOUS_IMAGE="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${PREVIOUS_DIR}/meta.json','utf8')); process.stdout.write(m.agentImage || ''); } catch {}")"
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

# 4. 服务受控重启与业务就绪严格验证（失败必须以非 0 退出码退出）
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 服务单元 com.riba2534.happyclaw，跳过 launchctl 重启。"
  fi

  if [ "${SKIP_READINESS}" != "1" ]; then
    if [ ! -f "${SCRIPT_DIR}/wait-for-readiness.mjs" ]; then
      log_error "就绪检测工具 ${SCRIPT_DIR}/wait-for-readiness.mjs 缺失！拒绝虚假成功！"
      exit 1
    fi
    log_info "等待回滚后业务就绪探针并严格校验目标 SHA: ${TARGET_SHA}..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" \
      --port "${WEB_PORT:-3000}" \
      --timeout 60 \
      --expected-sha "${TARGET_SHA}" || {
        log_error "回滚后业务就绪探针检查失败！服务未达到就绪状态！"
        exit 1
      }
  fi
fi

log_info "=== 原子回滚成功完成！当前版本: $(git rev-parse HEAD) ==="
