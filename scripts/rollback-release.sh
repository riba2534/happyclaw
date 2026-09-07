#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子回滚脚本 (R11 规范：不可变运行根、事务锁继承与全事务错误阻断)
#
# 架构与安全保证：
# 1. 持有相同部署排他锁，支持父子事务继承锁 (HAPPYCLAW_LOCK_RUN_ID)，防止回滚与并发发布冲突；
# 2. 单步原子重命名将 .releases/current 指针切回目标不可变版本根 (.releases/store/<SHA>)；
# 3. 严格镜像强校验：无论 store 是否存在，均对目标不可变 Agent 镜像执行完整的拉取、OCI revision
#    及架构核对；镜像元数据缺失或不匹配直接阻断；
# 4. 严格错误阻断与事务回退：若重启或业务就绪验证失败，自动回退至回滚前的版本并严格非 0 退出；
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

ACTIVATION_IN_PROGRESS=0
ACTIVATION_SUCCESS=0
ROLLBACK_IN_PROGRESS=0

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

# 2. 原子所有权排他锁 (原子 open O_CREAT|O_EXCL，保守 fail-closed，支持事务继承)
acquire_lock() {
  node -e '
    const fs = require("fs");
    const lockFile = process.argv[1];
    const pid = Number(process.argv[2]);
    const runId = process.argv[3];
    const inheritedRunId = process.env.HAPPYCLAW_LOCK_RUN_ID;

    if (inheritedRunId) {
      if (fs.existsSync(lockFile)) {
        try {
          const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
          if (info.runId === inheritedRunId) {
            process.exit(0);
          }
        } catch {}
      }
      console.error(`[LOCK] 声明继承锁 ${inheritedRunId} 但锁文件不匹配，fail-closed 拒绝！`);
      process.exit(1);
    }

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
            if (e.code === "ESRCH") {
              fs.unlinkSync(lockFile);
            } else {
              console.error(`[LOCK] 进程探测异常 (PID: ${info.pid}, code: ${e.code})，保守 fail-closed！`);
              process.exit(1);
            }
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
    const inheritedRunId = process.env.HAPPYCLAW_LOCK_RUN_ID;
    if (inheritedRunId) {
      process.exit(0);
    }
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

# 统一退出处理与回退
handle_exit() {
  local exit_code=$?
  if [ "${ACTIVATION_IN_PROGRESS}" -eq 1 ] && [ "${ACTIVATION_SUCCESS}" -eq 0 ] && [ "${ROLLBACK_IN_PROGRESS}" -eq 0 ]; then
    ROLLBACK_IN_PROGRESS=1
    log_error "回滚流程在激活或验证阶段发生故障（退出码: ${exit_code}），执行自愈回退事务..."
    set +e
    if [ -n "${CURRENT_ACTIVE_SHA}" ] && [ -d "${STORE_DIR}/${CURRENT_ACTIVE_SHA}" ]; then
      atomic_symlink_switch "store/${CURRENT_ACTIVE_SHA}" "${CURRENT_LINK}"
      git switch --detach "${CURRENT_ACTIVE_SHA}" 2>/dev/null || true
      if [ -n "${CURRENT_ACTIVE_IMAGE}" ]; then
        update_env_file "${CURRENT_ACTIVE_IMAGE}"
      fi
      if command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "com.riba2534.happyclaw"; then
        launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw" 2>/dev/null || true
      fi
    fi
  fi
  release_lock
  if [ "${exit_code}" -ne 0 ]; then
    exit "${exit_code}"
  fi
}

trap handle_exit EXIT INT TERM

cd "${ROOT_DIR}"

log_info "=== HappyClaw 原子回滚流程开始 ==="

acquire_lock

# 记录当前在线版本，便于自愈回退
get_active_release_sha() {
  if [ -L "${CURRENT_LINK}" ]; then
    local link_target
    link_target="$(readlink "${CURRENT_LINK}" 2>/dev/null || true)"
    local base
    base="$(basename "${link_target}")"
    if [ -n "${base}" ] && [ "${base}" != "current" ]; then
      echo "${base}"
      return
    fi
  fi
  git rev-parse HEAD
}

get_active_release_image() {
  if [ -f "${CURRENT_LINK}/version.json" ]; then
    local img
    img="$(node -e "try { const v = JSON.parse(require('fs').readFileSync('${CURRENT_LINK}/version.json','utf8')); process.stdout.write(v.agentImage || ''); } catch {}")"
    if [ -n "${img}" ]; then
      echo "${img}"
      return
    fi
  fi
  if [ -f "${ROOT_DIR}/.env" ]; then
    local img_env
    img_env="$(grep '^CONTAINER_IMAGE=' "${ROOT_DIR}/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"'\'' ' || true)"
    if [ -n "${img_env}" ]; then
      echo "${img_env}"
      return
    fi
  fi
  echo ""
}

CURRENT_ACTIVE_SHA="$(get_active_release_sha)"
CURRENT_ACTIVE_IMAGE="$(get_active_release_image)"

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

# 校验不可变 store 完整性辅助函数
is_store_valid() {
  local store_path="$1"
  local expected_sha="$2"
  test -f "${store_path}/dist/index.js" || return 1
  test -f "${store_path}/web/dist/index.html" || return 1
  test -d "${store_path}/container/agent-runner/dist" || return 1
  test -f "${store_path}/version.json" || return 1
  local sha
  sha="$(node -e "try { const v = JSON.parse(require('fs').readFileSync('${store_path}/version.json','utf8')); process.stdout.write(v.commitSha || ''); } catch {}")"
  test "${sha}" = "${expected_sha}" || return 1
  test -L "${store_path}/data" || return 1
  test -L "${store_path}/.env" || return 1
  test -L "${store_path}/config" || return 1
  return 0
}

# 3. 读取目标回滚版本的镜像身份
PREVIOUS_IMAGE="${HAPPYCLAW_AGENT_IMAGE:-}"
if [ -z "${PREVIOUS_IMAGE}" ] && [ -f "${TARGET_STORE_DIR}/version.json" ]; then
  PREVIOUS_IMAGE="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${TARGET_STORE_DIR}/version.json','utf8')); process.stdout.write(m.agentImage || ''); } catch {}")"
fi
if [ -z "${PREVIOUS_IMAGE}" ] && [ -f "${PREVIOUS_DIR}/meta.json" ]; then
  PREVIOUS_IMAGE="$(node -e "try { const m = JSON.parse(require('fs').readFileSync('${PREVIOUS_DIR}/meta.json','utf8')); if (m.previousSha === '${TARGET_SHA}' || m.currentSha === '${TARGET_SHA}') process.stdout.write(m.previousImage || m.agentImage || ''); } catch {}")"
fi

if [ -z "${PREVIOUS_IMAGE}" ]; then
  log_error "目标回滚版本 ${TARGET_SHA} 的 Agent 镜像元数据缺失！拒绝盲目回滚！"
  exit 1
fi

# 关键：无论 store 是否存在，均对目标镜像做与 deploy 完全相同的严格校验
log_info "校验回滚目标不可变 Agent 镜像身份: ${PREVIOUS_IMAGE}..."
local_regex="^riba2534/happyclaw-agent:git-${TARGET_SHA}(-headroom)?$"
if ! [[ "${PREVIOUS_IMAGE}" =~ ${local_regex} ]]; then
  log_error "镜像 '${PREVIOUS_IMAGE}' 违背规范！回滚镜像必须精确对应目标提交: riba2534/happyclaw-agent:git-${TARGET_SHA}[-headroom]"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  log_error "未检测到 Docker CLI！回滚必须验证容器 Agent 镜像完整性！"
  exit 1
fi

log_info "拉取 Docker 镜像并校验 OCI revision 标签..."
docker pull "${PREVIOUS_IMAGE}" || {
  log_error "拉取 Docker 镜像 ${PREVIOUS_IMAGE} 失败！"
  exit 1
}

LABEL_REV="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${PREVIOUS_IMAGE}" 2>/dev/null || echo "")"
if [ "${LABEL_REV}" != "${TARGET_SHA}" ]; then
  log_error "Docker 镜像 ${PREVIOUS_IMAGE} 的 org.opencontainers.image.revision (${LABEL_REV}) 与目标提交 SHA (${TARGET_SHA}) 不匹配！"
  exit 1
fi

IMAGE_ARCH="$(docker inspect --format '{{ .Architecture }}' "${PREVIOUS_IMAGE}" 2>/dev/null || echo "")"
IMAGE_OS="$(docker inspect --format '{{ .Os }}' "${PREVIOUS_IMAGE}" 2>/dev/null || echo "")"
if [ "${IMAGE_OS}" != "linux" ] || { [ "${IMAGE_ARCH}" != "amd64" ] && [ "${IMAGE_ARCH}" != "arm64" ]; }; then
  log_error "Docker 镜像 ${PREVIOUS_IMAGE} 操作系统/架构 (${IMAGE_OS}/${IMAGE_ARCH}) 不符合要求（必须为 linux/amd64 或 linux/arm64）！"
  exit 1
fi

IMAGE_ID="$(docker inspect --format '{{ .Id }}' "${PREVIOUS_IMAGE}" 2>/dev/null || echo "")"
if [ -z "${IMAGE_ID}" ]; then
  log_error "无法获取 Docker 镜像 ${PREVIOUS_IMAGE} 的 ID / Digest！"
  exit 1
fi

# 检查不可变版本库中是否存在预编译好的完整产物，若缺失则委托构建入库
if [ ! -d "${TARGET_STORE_DIR}" ] || ! is_store_valid "${TARGET_STORE_DIR}" "${TARGET_SHA}"; then
  log_warn "不可变版本库 ${TARGET_STORE_DIR} 缺失完整产物，转入独立候选发布流程重建目标版本..."
  HAPPYCLAW_EXPECTED_SHA="${TARGET_SHA}" \
  HAPPYCLAW_AGENT_IMAGE="${PREVIOUS_IMAGE}" \
  HAPPYCLAW_LOCK_RUN_ID="${RUN_ID}" \
  HAPPYCLAW_BUILD_ONLY=1 \
  "${SCRIPT_DIR}/deploy-release.sh"
fi

# 再次验证目标 store 合法性
if ! is_store_valid "${TARGET_STORE_DIR}" "${TARGET_SHA}"; then
  log_error "回滚目标不可变运行库 ${TARGET_STORE_DIR} 校验失败！拒绝切换！"
  exit 1
fi

update_env_file() {
  local image_tag="$1"
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
    if (/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=/m.test(content)) {
      content = content.replace(/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/m, "HAPPYCLAW_SKIP_MIGRATION_BACKUP=1");
    } else {
      content += `\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n`;
    }
    fs.writeFileSync(envPath, content, { mode: 0o600 });
  ' "${ROOT_DIR}/.env" "${image_tag}"
}

# 进入激活事务保护阶段
ACTIVATION_IN_PROGRESS=1

log_info "从不可变版本库 store/${TARGET_SHA} 单步原子切换当前运行指针..."
atomic_symlink_switch "store/${TARGET_SHA}" "${CURRENT_LINK}"
git switch --detach "${TARGET_SHA}"

log_info "还原目标版本不可变镜像: ${PREVIOUS_IMAGE}..."
update_env_file "${PREVIOUS_IMAGE}"

# 4. 服务受控重启与业务就绪严格验证（失败必须以非 0 退出码退出）
if command -v launchctl >/dev/null 2>&1; then
  if launchctl list 2>/dev/null | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_error "未检测到运行中的 launchd 服务单元 com.riba2534.happyclaw！"
    exit 1
  fi
else
  log_error "未检测到 launchctl 命令！回滚必须在 launchd 托管环境执行！"
  exit 1
fi

if [ ! -f "${SCRIPT_DIR}/wait-for-readiness.mjs" ]; then
  log_error "就绪检测工具 ${SCRIPT_DIR}/wait-for-readiness.mjs 缺失！拒绝虚假成功！"
  exit 1
fi

log_info "等待回滚后业务就绪探针并严格校验目标 SHA: ${TARGET_SHA}..."
node "${SCRIPT_DIR}/wait-for-readiness.mjs" \
  --port "${WEB_PORT:-3000}" \
  --timeout 60 \
  --expected-sha "${TARGET_SHA}"

ACTIVATION_SUCCESS=1
log_info "=== 原子回滚成功完成！当前版本: $(git rev-parse HEAD) ==="
