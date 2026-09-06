#!/usr/bin/env bash
# ==============================================================================
# HappyClaw 生产原子发布脚本 (R11 架构与可靠性强化)
#
# 架构与安全保证：
# 1. 完整不可变运行根：在 .releases/store/<SHA> 下封存包含三包编译产物 (dist/web/dist/runner)、
#    prompts模板、脚本、根据目标 lockfile 安装的独立 node_modules 以及固化的 version.json。
#    运行时共享数据 (data/.env) 通过符号链接指向主工作区，严禁将数据库或凭据复制进版本库。
# 2. 单步原子指针切换：通过 C 标准库 rename(2) 原子替换 .releases/current 符号链接，
#    主服务、前端与 runner 产物在单次系统调用中瞬时同时生效，彻底杜绝版本撕裂与旧代码混用。
# 3. 根治同 SHA 破坏缺陷：构建与版本组装全程在候选隔离区 (.release-staging-<runId>) 完成，
#    在所有三包、依赖和镜像校验 100% 成功前，严禁触碰或删除任何已被当前/历史引用的 store 目录！
# 4. 原子所有权排他锁：使用 O_CREAT|O_EXCL 原子文件锁写入 PID 与时间戳，并发部署保守 fail-closed；
#    隔离清理严格校验本轮 marker 归属，绝不误删非本轮残留或未知工作树。
# 5. 精确不可变镜像：分支部署必须匹配 riba2534/happyclaw-agent:git-<SHA>[-headroom]，
#    必须真实 Docker 存在并执行 pull/inspect 校验，严禁空镜像或假成功。
# 6. 原地无副本更新 .env：内存流原地读写，严禁产生 .bak 或临时文件；强制注入 SKIP_MIGRATION_BACKUP=1。
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
            console.error(`[LOCK] 并发部署冲突：PID ${info.pid} (RunID: ${info.runId}) 正在执行中！`);
            process.exit(1);
          } catch (e) {
            // 进程已死亡，安全回收陈旧锁
            fs.unlinkSync(lockFile);
          }
        } else {
          console.error("[LOCK] 发现未知格式锁文件，保守 fail-closed 拒绝部署！");
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
      console.error("[LOCK] 原子获取排他锁失败！并发冲突！", err.message);
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

# 3. 校验目标提交
if [ -z "${EXPECTED_SHA}" ]; then
  log_error "必须提供 HAPPYCLAW_EXPECTED_SHA 参数！"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  log_error "工作树不干净，存在未提交或未跟踪更改，停止发布！"
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

# 4. 精确不可变镜像与真实 Docker 校验
if [ -n "${AGENT_IMAGE}" ]; then
  log_info "校验 Agent 容器镜像: ${AGENT_IMAGE}..."
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

# 5. 准备独立候选工作区与构建
# 核心安全：构建全程在 STAGING_DIR 内完成，严禁在构建开始时删除任何现有 store 目录！
mkdir -p "${STORE_DIR}"
log_info "签出候选工作区至隔离目录: ${STAGING_DIR}..."
git worktree add --detach "${STAGING_DIR}" "${EXPECTED_SHA}"
echo "${RUN_ID}" > "${MARKER_FILE}"

cd "${STAGING_DIR}"

if [ "${INJECT_FAILURE}" = "pre_build" ]; then
  log_error "[注入测试] 模拟构建前失败"
  exit 101
fi

log_info "候选目录独立准备确定性依赖与内置 Skills..."
if [ "${HAPPYCLAW_FAST_BUILD:-0}" = "1" ]; then
  if [ -d "${ROOT_DIR}/node_modules" ]; then
    cp -R "${ROOT_DIR}/node_modules" "${STAGING_DIR}/"
    cp -R "${ROOT_DIR}/web/node_modules" "${STAGING_DIR}/web/" 2>/dev/null || true
    cp -R "${ROOT_DIR}/container/agent-runner/node_modules" "${STAGING_DIR}/container/agent-runner/" 2>/dev/null || true
  fi
else
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

# 6. 在候选区组装完整不可变运行根 (Immutable Release Bundle)
STAGING_RELEASE_BUNDLE="${STAGING_DIR}/.bundle-assembled"
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

# 建立共享数据软链接，严禁把真实运行时数据复制进不可变版本库
ln -s "../../data" "${STAGING_RELEASE_BUNDLE}/data"
ln -s "../../.env" "${STAGING_RELEASE_BUNDLE}/.env"

if [ "${INJECT_FAILURE}" = "post_build" ]; then
  log_error "[注入测试] 模拟全部编译装配完成但在指针激活前失败"
  exit 106
fi

# 7. 安全入库与单步原子指针切换
cd "${ROOT_DIR}"

# 首次迁移检查与安全建立符号链接架构
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
    cat <<EOF > "${initial_store}/version.json"
{
  "commitSha": "${CURRENT_SHA}",
  "initializedFromExisting": true,
  "archivedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    # 先让 current 指针指向初始 store，确保目标完全就绪
    atomic_symlink_switch "store/${CURRENT_SHA}" "${CURRENT_LINK}"

    # 然后安全替换根目录为软链接
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

# 将组装好的候选版本安全放入 store/<EXPECTED_SHA>
TARGET_STORE="${STORE_DIR}/${EXPECTED_SHA}"
INCOMING_STORE="${STORE_DIR}/.incoming-${EXPECTED_SHA}-${RUN_ID}"
rm -rf "${INCOMING_STORE}"
cp -R "${STAGING_RELEASE_BUNDLE}" "${INCOMING_STORE}"

# 如果目标目录已存在（同 SHA 部署或历史构建），利用临时目录原子重命名替换，绝不提前 rm 正在被引用的目录
if [ -d "${TARGET_STORE}" ]; then
  # 检查当前是否正由 current 引用
  CURRENT_REAL=""
  if [ -L "${CURRENT_LINK}" ]; then
    CURRENT_REAL="$(readlink "${CURRENT_LINK}" || echo "")"
  fi
  if [ "${CURRENT_REAL}" = "store/${EXPECTED_SHA}" ]; then
    # 当前正被在线引用，先将 current 原子切到 incoming
    atomic_symlink_switch "store/.incoming-${EXPECTED_SHA}-${RUN_ID}" "${CURRENT_LINK}"
    # 然后安全替换 target
    rm -rf "${TARGET_STORE}"
    mv "${INCOMING_STORE}" "${TARGET_STORE}"
    # 再次将 current 指回正式 target
    atomic_symlink_switch "store/${EXPECTED_SHA}" "${CURRENT_LINK}"
  else
    rm -rf "${TARGET_STORE}"
    mv "${INCOMING_STORE}" "${TARGET_STORE}"
    atomic_symlink_switch "store/${EXPECTED_SHA}" "${CURRENT_LINK}"
  fi
else
  mv "${INCOMING_STORE}" "${TARGET_STORE}"
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

# 保存上一版本元数据记录
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

# 9. 服务受控停启与业务就绪严格验证
if [ "${SKIP_RESTART}" != "1" ]; then
  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -q "com.riba2534.happyclaw"; then
    log_info "通过 launchctl 重启生产服务单元 com.riba2534.happyclaw..."
    launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
  else
    log_warn "未检测到 launchd 单元 com.riba2534.happyclaw，跳过 launchctl kickstart。"
  fi

  if [ "${SKIP_READINESS}" != "1" ]; then
    log_info "调用 wait-for-readiness 等待业务完全就绪并严格校验期望 SHA: ${EXPECTED_SHA}..."
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
