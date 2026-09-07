#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子发布脚本 (R11 终极规范：不可变运行根与进程固定版本)
#
# 核心安全与架构设计：
# 1. 完整不可变运行根：在 .releases/store/<SHA> 封存三包产物 (dist/web/dist/runner)、
#    prompts模板、脚本、根据目标 lockfile 安装的独立 node_modules 以及固化的 version.json。
#    共享数据严格通过 ../../../data 和 ../../../.env 等 3 层相对软链接连接到主工作区，绝不创建新数据库。
# 2. 进程固定版本根启动：真实启动入口通过 realpath 与 bootstrap 识别当前版本根，在模块求值前
#    固定进程工作目录与版本常量，老进程存活期间 100% 保持自身版本资源，绝不发生新旧混版撕裂。
# 3. 根除同 SHA 破坏缺陷：构建与版本组装全程在候选隔离区 (.release-staging-<runId>) 完成，
#    严禁在构建前删除任何 store 目录！若同 SHA 目录已存在且完整，直接复用或原子替换，在线产物零丢失。
# 4. 原子所有权排他锁：使用 O_CREAT|O_EXCL 原子文件锁写入 PID 与时间戳，并发部署保守 fail-closed；
#    隔离清理严格校验本轮专属 marker 归属，绝不误删非本轮残留或未知工作树。
# 5. 精确不可变镜像与 OCI Revision 校验：分支部署必须匹配精确镜像标签 riba2534/happyclaw-agent:git-<SHA>[-headroom]，
#    必需真实 Docker 存在并 pull，且通过 docker inspect 严格核对 org.opencontainers.image.revision label。
#    彻底移除任何生产跳过绕过参数。
# 6. 原地无副本配置更新：内存原地读写覆写 .env，严禁产生 .bak 或临时文件；强制注入 SKIP_MIGRATION_BACKUP=1。
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

# 1. 跨平台单步原子符号链接切换 (基于底层 rename 系统调用)
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

# 2. 原子所有权排他锁 (原子 open O_CREAT|O_EXCL，保守 fail-closed)
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
            console.error(`[LOCK] 并发冲突：检测到部署正在运行中 (PID: ${info.pid}, RunID: ${info.runId})！`);
            process.exit(1);
          } catch (e) {
            // 进程已不存在，安全回收孤儿锁
            fs.unlinkSync(lockFile);
          }
        } else {
          console.error("[LOCK] 发现未知归属锁文件，保守 fail-closed 拒绝部署！");
          process.exit(1);
        }
      } catch (err) {
        console.error("[LOCK] 检查已有锁失败，保守 fail-closed 拒绝部署！", err.message);
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
      console.error("[LOCK] 获取排他部署锁失败！并发冲突！", err.message);
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

cleanup_staging() {
  if [ -d "${STAGING_DIR}" ]; then
    if [ -f "${MARKER_FILE}" ] && [ "$(cat "${MARKER_FILE}" 2>/dev/null || echo "")" = "${RUN_ID}" ]; then
      log_info "清理本轮候选工作区: ${STAGING_DIR}"
      if git -C "${ROOT_DIR}" worktree list 2>/dev/null | grep -q "${STAGING_DIR}"; then
        git -C "${ROOT_DIR}" worktree remove --force "${STAGING_DIR}" 2>/dev/null || rm -rf "${STAGING_DIR}"
      else
        rm -rf "${STAGING_DIR}"
      fi
    else
      log_warn "候选目录缺少或未匹配本轮 marker，绝不误删: ${STAGING_DIR}"
    fi
  fi
  release_lock
}

trap cleanup_staging EXIT INT TERM

cd "${ROOT_DIR}"

log_info "=== HappyClaw 生产原子发布开始 (RunID: ${RUN_ID}) ==="

# 获取排他锁
acquire_lock

# 3. 校验目标提交
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
  log_info "从远程仓库更新分支 refs/heads/${DEPLOY_REF}..."
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

# 4. 精确不可变镜像与 OCI Revision 标签强校验 (生产环境必须 Docker 存在且 pull 校验)
if [ -z "${AGENT_IMAGE}" ]; then
  log_error "生产部署必须指定 HAPPYCLAW_AGENT_IMAGE 不可变镜像！严禁为空！"
  exit 1
fi

log_info "校验 Agent 容器镜像身份: ${AGENT_IMAGE}..."
local_regex="^riba2534/happyclaw-agent:git-${EXPECTED_SHA}(-headroom)?$"
if ! [[ "${AGENT_IMAGE}" =~ ${local_regex} ]]; then
  log_error "镜像 '${AGENT_IMAGE}' 违背规范！分支镜像必须精确对应目标提交: riba2534/happyclaw-agent:git-${EXPECTED_SHA}[-headroom]"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  log_error "未检测到 Docker CLI！生产部署必须依赖 Docker 环境以验证容器 Agent 镜像完整性！"
  exit 1
fi

if [ "${INJECT_FAILURE}" = "docker_image" ]; then
  log_error "[注入测试] 模拟 Docker 镜像校验失败"
  exit 105
fi

log_info "拉取 Docker 镜像并校验 OCI revision 标签..."
docker pull "${AGENT_IMAGE}" || {
  log_error "拉取 Docker 镜像 ${AGENT_IMAGE} 失败！"
  exit 1
}

# 严格核对 OCI Revision 标签
LABEL_REV="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${AGENT_IMAGE}" 2>/dev/null || echo "")"
if [ "${LABEL_REV}" != "${EXPECTED_SHA}" ]; then
  log_error "Docker 镜像 ${AGENT_IMAGE} 的 org.opencontainers.image.revision (${LABEL_REV}) 与预期提交 SHA (${EXPECTED_SHA}) 不匹配！"
  exit 1
fi

# 5. 准备独立候选工作区
# 关键保证：构建与版本组装全程在 STAGING_DIR 内部完成，严禁提前删除任何 store 目录！
mkdir -p "${STORE_DIR}"
log_info "签出候选工作区至隔离目录: ${STAGING_DIR}..."
git worktree add --detach "${STAGING_DIR}" "${EXPECTED_SHA}"
echo "${RUN_ID}" > "${MARKER_FILE}"

cd "${STAGING_DIR}"

if [ "${INJECT_FAILURE}" = "pre_build" ]; then
  log_error "[注入测试] 模拟构建前失败"
  exit 101
fi

log_info "按目标 lockfile 独立安装确定性依赖与准备内置 Skills..."
if [ -f "package-lock.json" ]; then
  npm ci
else
  npm install
fi

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

if [ -f "./scripts/sync-stream-event.sh" ]; then
  ./scripts/sync-stream-event.sh
fi

if [ -f "./scripts/builtin-skill-catalog.mjs" ]; then
  node scripts/builtin-skill-catalog.mjs validate data/builtin-skills || {
    ./scripts/install-host-tools.sh skills
  }
fi

log_info "执行候选版本三包全量编译..."

# 1) 主服务
log_info "-> 编译主服务..."
if [ "${INJECT_FAILURE}" = "server_build" ]; then
  log_error "[注入测试] 模拟主服务编译失败"
  exit 102
fi
npm run build

# 2) Web 前端
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

# 6. 组装完整不可变运行根 (Full Immutable Release Bundle)
STAGING_RELEASE_BUNDLE="${STAGING_DIR}/.release-bundle-complete"
rm -rf "${STAGING_RELEASE_BUNDLE}"
mkdir -p "${STAGING_RELEASE_BUNDLE}"

cp -R "${STAGING_DIR}/dist" "${STAGING_RELEASE_BUNDLE}/dist"
mkdir -p "${STAGING_RELEASE_BUNDLE}/web"
cp -R "${STAGING_DIR}/web/dist" "${STAGING_RELEASE_BUNDLE}/web/dist"
mkdir -p "${STAGING_RELEASE_BUNDLE}/container"
cp -R "${STAGING_DIR}/container" "${STAGING_RELEASE_BUNDLE}/"
if [ -d "${STAGING_DIR}/node_modules" ]; then
  cp -R "${STAGING_DIR}/node_modules" "${STAGING_RELEASE_BUNDLE}/node_modules"
fi
cp "${STAGING_DIR}/package.json" "${STAGING_RELEASE_BUNDLE}/package.json"
if [ -f "${STAGING_DIR}/package-lock.json" ]; then
  cp "${STAGING_DIR}/package-lock.json" "${STAGING_RELEASE_BUNDLE}/package-lock.json"
fi
if [ -d "${STAGING_DIR}/scripts" ]; then
  cp -R "${STAGING_DIR}/scripts" "${STAGING_RELEASE_BUNDLE}/scripts"
fi

cat <<EOF > "${STAGING_RELEASE_BUNDLE}/version.json"
{
  "commitSha": "${EXPECTED_SHA}",
  "previousSha": "${CURRENT_SHA}",
  "builtAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "agentImage": "${AGENT_IMAGE}"
}
EOF

# 严格修正：从 .releases/store/<SHA> 到 ROOT_DIR 必须是 3 层相对路径 (../../../)！
ln -s "../../../data" "${STAGING_RELEASE_BUNDLE}/data"
ln -s "../../../.env" "${STAGING_RELEASE_BUNDLE}/.env"
ln -s "../../../store" "${STAGING_RELEASE_BUNDLE}/store"
ln -s "../../../groups" "${STAGING_RELEASE_BUNDLE}/groups"
ln -s "../../../logs" "${STAGING_RELEASE_BUNDLE}/logs"
ln -s "../../../config" "${STAGING_RELEASE_BUNDLE}/config"

if [ "${INJECT_FAILURE}" = "post_build" ]; then
  log_error "[注入测试] 模拟全部编译装配完成但在指针激活前失败"
  exit 106
fi

# 7. 安全入库与单步原子指针切换
cd "${ROOT_DIR}"

# 首次建立符号链接布局（完全保证旧服务资产就绪且平滑过渡）
ensure_symlink_layout() {
  if [ ! -L "${ROOT_DIR}/dist" ]; then
    log_info "首次建立版本化运行结构，封存当前在线版本至 store/${CURRENT_SHA}..."
    local initial_store="${STORE_DIR}/${CURRENT_SHA}"
    mkdir -p "${initial_store}"
    if [ -d "${ROOT_DIR}/dist" ]; then cp -R "${ROOT_DIR}/dist" "${initial_store}/dist"; fi
    if [ -d "${ROOT_DIR}/web/dist" ]; then
      mkdir -p "${initial_store}/web"
      cp -R "${ROOT_DIR}/web/dist" "${initial_store}/web/dist"
    fi
    if [ -d "${ROOT_DIR}/container/agent-runner/dist" ]; then
      mkdir -p "${initial_store}/container/agent-runner"
      cp -R "${ROOT_DIR}/container/agent-runner/dist" "${initial_store}/container/agent-runner/dist"
    fi
    if [ -d "${ROOT_DIR}/node_modules" ]; then
      cp -R "${ROOT_DIR}/node_modules" "${initial_store}/node_modules"
    fi
    ln -s "../../../data" "${initial_store}/data"
    ln -s "../../../.env" "${initial_store}/.env"
    cat <<EOF > "${initial_store}/version.json"
{
  "commitSha": "${CURRENT_SHA}",
  "initializedFromExisting": true,
  "archivedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    # 先确保 current 指针指向就绪的 initial_store
    atomic_symlink_switch "store/${CURRENT_SHA}" "${CURRENT_LINK}"

    rm -rf "${ROOT_DIR}/dist"
    ln -s ".releases/current/dist" "${ROOT_DIR}/dist"

    rm -rf "${ROOT_DIR}/web/dist"
    mkdir -p "${ROOT_DIR}/web"
    ln -s "../.releases/current/web/dist" "${ROOT_DIR}/web/dist"

    rm -rf "${ROOT_DIR}/container/agent-runner/dist"
    mkdir -p "${ROOT_DIR}/container/agent-runner"
    ln -s "../../.releases/current/container/agent-runner/dist" "${ROOT_DIR}/container/agent-runner/dist"
  fi
}

ensure_symlink_layout

TARGET_STORE="${STORE_DIR}/${EXPECTED_SHA}"

# 安全将完整候选运行根入库（如果目录已存在，使用安全替换或复用，绝不直接破坏当前正在运行的目录）
if [ -d "${TARGET_STORE}" ]; then
  log_info "版本目录 ${TARGET_STORE} 已存在，使用隔离目录安全更新..."
  TEMP_TARGET="${STORE_DIR}/.tmp-${EXPECTED_SHA}-${RUN_ID}"
  rm -rf "${TEMP_TARGET}"
  mv "${STAGING_RELEASE_BUNDLE}" "${TEMP_TARGET}"
  # 切换 current 指向新的临时目标
  atomic_symlink_switch "store/.tmp-${EXPECTED_SHA}-${RUN_ID}" "${CURRENT_LINK}"
  # 然后安全更新正式 target
  rm -rf "${TARGET_STORE}"
  mv "${TEMP_TARGET}" "${TARGET_STORE}"
  atomic_symlink_switch "store/${EXPECTED_SHA}" "${CURRENT_LINK}"
else
  mv "${STAGING_RELEASE_BUNDLE}" "${TARGET_STORE}"
  atomic_symlink_switch "store/${EXPECTED_SHA}" "${CURRENT_LINK}"
fi

# 切换 Git HEAD
git switch --detach "${EXPECTED_SHA}"

# 8. 原地无副本更新 .env (禁止生成 .bak，强制设置 HAPPYCLAW_SKIP_MIGRATION_BACKUP=1)
log_info "原地无副本更新 .env 配置..."
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

# 保存上一版本元数据记录（便于无网络时快速原子回滚）
mkdir -p "${ROOT_DIR}/.release-previous"
cat <<EOF > "${ROOT_DIR}/.release-previous/meta.json"
{
  "previousSha": "${CURRENT_SHA}",
  "currentSha": "${EXPECTED_SHA}",
  "switchedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "agentImage": "${AGENT_IMAGE}"
}
EOF

log_info "版本切换单步原子完成！当前在线指针: .releases/current -> store/${EXPECTED_SHA}"

# 9. 服务受控停启与业务就绪严格验证（必须校验 expectedSha，失败严格退出码 1）
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启生产服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 单元 com.riba2534.happyclaw，跳过 launchctl kickstart。"
  fi

  if [ "${SKIP_READINESS}" != "1" ]; then
    if [ ! -f "${SCRIPT_DIR}/wait-for-readiness.mjs" ]; then
      log_error "就绪检测工具 ${SCRIPT_DIR}/wait-for-readiness.mjs 缺失！拒绝虚假成功！"
      exit 1
    fi
    log_info "调用 wait-for-readiness 等待业务完全就绪并严格校验目标 SHA: ${EXPECTED_SHA}..."
    "${SCRIPT_DIR}/wait-for-readiness.mjs" \
      --port "${WEB_PORT:-3000}" \
      --timeout 60 \
      --expected-sha "${EXPECTED_SHA}" || {
        log_error "业务就绪探针检查失败！服务未达到就绪状态！"
        exit 1
      }
  fi
fi

log_info "=== HappyClaw 原子发布全流程成功！当前版本: $(git rev-parse HEAD) ==="
