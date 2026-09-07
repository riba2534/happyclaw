# HappyClaw Mac mini 生产部署

本仓库的生产实例运行在用户的 Mac mini 上。代码目录为
`/Users/riba2534/airepo/happyclaw`，服务由用户级 launchd 单元
`com.riba2534.happyclaw` 管理，监听 `*:3000`。部署只能更新 Git 跟踪的代码、构建产物和
Agent 镜像；`data/`、本机环境变量、Keychain、渠道凭据及 launchd 配置必须原样保留。

## 1. 连接与前置条件

在部署机的私有 SSH 配置中维护 `macmini` 别名。主机地址、端口和密钥属于运维配置，
不得提交到仓库。下面的命令都假定 `ssh macmini` 已能免交互登录。

部署前必须满足：

- 目标提交已经推送到远程分支，且本地测试、类型检查和生产构建通过。
- 若 `container/` 或 Agent Runner 发生变化：已合入 `main` 时等待 `latest` 发布；部署尚未
  合入的远程分支时，用 GitHub Actions 的 `workflow_dispatch` 在该精确 ref 上构建，并使用
  `riba2534/happyclaw-agent:git-<完整提交 SHA>`。分支构建只发布不可变提交标签，不得推进
  公共 `latest`；Mac mini 不做本地镜像构建。
- 明确记录本次远程分支名和预期提交 SHA，不使用浮动的本地工作树作为部署来源。

连接并设置本次部署参数：

```bash
ssh macmini
cd /Users/riba2534/airepo/happyclaw
export HAPPYCLAW_DEPLOY_REF='codex/replace-with-remote-branch'
export HAPPYCLAW_EXPECTED_SHA='replace-with-full-commit-sha'
export HAPPYCLAW_PUBLIC_URL_PRIMARY='https://claw.riba2534.cn'
export HAPPYCLAW_PUBLIC_URL_SECONDARY='https://claw.home.riba2534.cn:23333'
export HAPPYCLAW_AGENT_IMAGE="riba2534/happyclaw-agent:git-${HAPPYCLAW_EXPECTED_SHA}"
# 分支不可变镜像会自动派生同 SHA 的 `-headroom` 能力标签；只有实际配置
# headroom MCP 时 Docker 才按需拉取它。
```

## 2. 只读预检与目标校验

远程工作树不干净时立即停止，不要 stash、覆盖或删除未知文件：

```bash
test -z "$(git status --porcelain)" || {
  git status --short
  echo 'Remote worktree is not clean; deployment stopped.' >&2
  exit 1
}

export HAPPYCLAW_PREVIOUS_SHA="$(git rev-parse HEAD)"
printf 'Rollback commit: %s\n' "$HAPPYCLAW_PREVIOUS_SHA"
git fetch --prune origin \
  "refs/heads/${HAPPYCLAW_DEPLOY_REF}:refs/remotes/origin/${HAPPYCLAW_DEPLOY_REF}"
test "$(git rev-parse "origin/$HAPPYCLAW_DEPLOY_REF")" = "$HAPPYCLAW_EXPECTED_SHA"
```

所有者已明确选择不保留部署备份。部署期间不得运行 `make backup`，不得创建 SQLite
快照、完整运行数据归档或 `.env` 备份副本，除非所有者在未来明确撤销该策略。禁止运行
`make reset-init`、`git clean`、`git reset --hard`，也不要用带 `--delete` 的 rsync 同步
生产目录。Mac mini 的现有 `.env` 必须原地配置
`HAPPYCLAW_SKIP_MIGRATION_BACKUP=1`；它只关闭启动时的 schema 迁移快照，其他安装默认仍会
在迁移前创建并校验快照。

## 3. 原子构建与切换 (R11)

为了防止原地并发构建中前端改写旧服务静态资源、后端或 Runner 编译失败导致混用前后端版本，生产环境采用**独立候选准备 + 原子切换**机制。
所有三包（主服务 `dist/`、前端 `web/dist/`、Agent Runner `container/agent-runner/dist/`）及不可变镜像就绪前，在线运行版本、代码与静态资源分毫不动。

在部署机上配置迁移免备份选项：

```bash
if grep -q '^HAPPYCLAW_SKIP_MIGRATION_BACKUP=' .env 2>/dev/null; then
  sed -i '' 's/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/HAPPYCLAW_SKIP_MIGRATION_BACKUP=1/' .env
else
  printf '\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n' >> .env
fi
chmod 600 .env
```

### 3.1 首次生产引导 (Bootstrap from Legacy Baseline)

当生产工作树处于旧基线版本（如 `7175c0d`），`scripts/` 目录下尚未引入 `deploy-release.sh` 等发布脚本时，**绝对禁止直接拷贝脚本到生产工作树**（会产生未跟踪文件触发干净检查拒签，且会导致后续 `git switch` 产生检出覆盖冲突），也**绝对禁止提前切分支**（会导致无法正确捕获真实的旧版本 SHA 封存）。

必须通过仓库外的临时引导目录执行首次引导部署：

```bash
# 1. 确保远程分支已 fetch (工作树保持在旧 SHA，不切分支，100% 干净)
git fetch --prune origin \
  "refs/heads/${HAPPYCLAW_DEPLOY_REF}:refs/remotes/origin/${HAPPYCLAW_DEPLOY_REF}"
test "$(git rev-parse "origin/$HAPPYCLAW_DEPLOY_REF")" = "$HAPPYCLAW_EXPECTED_SHA"

# 2. 从目标分支提取发布脚本到工作树外的临时引导目录
BOOTSTRAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/happyclaw-bootstrap.XXXXXX")"
git archive "origin/${HAPPYCLAW_DEPLOY_REF}" scripts | tar -x -C "${BOOTSTRAP_DIR}"

# 3. 指定生产工作树根目录并执行首次原子发布
HAPPYCLAW_ROOT_DIR="$(pwd)" "${BOOTSTRAP_DIR}/scripts/deploy-release.sh"

# 4. 清理临时引导目录
rm -rf "${BOOTSTRAP_DIR}"
```

首次引导流程会自动识别当前旧版本 SHA，在隔离区完成候选版本构建校验后，受控停止旧服务、将旧版完整运行时资产封存入 `.releases/store/<旧SHA>`，建立软链接并无缝切到目标版本。首次引导完成后，发布工具已正式纳入 Git 跟踪，后续部署可直接按 3.2 节运行。

### 3.2 日常原子发布 (Subsequent Releases)

首次引导完成后，生产目录已具备版本化结构和发布工具，后续发布直接执行：

```bash
./scripts/deploy-release.sh
```

`deploy-release.sh` 执行的原子发布流程：

1. **工作树干净预检**：校验当前目录无未提交更改，记录旧版本 `ACTIVE_PREVIOUS_SHA`；
2. **目标不可变运行库检查与复用**：若 `.releases/store/<SHA>` 已存在且完整，直接安全复用（零删除、零断链）；若存在但损坏直接 fail-closed 阻断；
3. **独立候选准备 (.release-staging-<runId>)**：在隔离 worktree 中签出 `HAPPYCLAW_EXPECTED_SHA`，隔离执行三包全量构建 `npm run build:all` 并封存不可变运行根；
4. **不可变镜像强校验**：分支构建必须匹配 `riba2534/happyclaw-agent:git-<SHA>[-headroom]`，必须通过 Docker pull 及 inspect 校验 revision、架构与 ID；
5. **失败零污染防护**：任一步构建或校验失败，脚本立即退出并清理候选目录，线上正运行的代码与 `web/dist` 绝不受任何影响；
6. **首次平滑迁移保护（若当前为旧环境）**：严格在候选版本准备完毕后，受控停止存量旧服务，将当前在线旧代码封存入 `.releases/store/<PREVIOUS_SHA>`（包含旧版全部运行资产与 3 层相对数据软链接），原子切换软链接，绝不造成新旧混版；任何迁移失败原样恢复原物理目录；用户的现有 launchd 单元名 `com.riba2534.happyclaw` 及其配置保持原样，无需变更；
7. **全流程激活事务保护**：单步原子重命名切换 `.releases/current` 指针至不可变目标根，原地无副本更新 `.env` 中的 `CONTAINER_IMAGE`；在激活与重启就绪阶段设置统一错误 trap 保护，任何命令非 0 失败自动安全回滚至上一版本代码与配置，并以非 0 退出码明确报警。

## 4. 重启与生产业务就绪验证 (R12)

发布脚本在 Mac mini 生产环境下会自动通过 launchd 重启服务单元，并轮询业务就绪探针：

```bash
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"

# 业务就绪探针 (Readiness)：验证 DB、恢复周期、消费者与启用渠道连接已全部就绪
./scripts/wait-for-readiness.mjs --port 3000 --timeout 60

launchctl print "gui/$(id -u)/com.riba2534.happyclaw" | head -40
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/config/appearance/public
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth/me)" = 401
curl -fsS "$HAPPYCLAW_PUBLIC_URL_PRIMARY/api/health"
curl -fsS "$HAPPYCLAW_PUBLIC_URL_PRIMARY/api/health/readiness"
curl -fsS "$HAPPYCLAW_PUBLIC_URL_SECONDARY/api/health"
tail -100 "$HOME/Library/Logs/happyclaw/happyclaw.log"
```

随后从真实公网入口完成与改动相关的真实测试，并分别记录结果：

1. 未登录打开登录页，确认自定义站点名称、图形 Logo 和浏览器标题生效。
2. 注册或登录后确认同一品牌立即进入侧边栏，无需刷新页面。
3. 管理员分别修改站点名称、图形 Logo 和文字 Logo，确认保存中控件禁用，最终页面与
   `/api/config/appearance/public` 一致。
4. 展开负载均衡设置，用键盘访问策略和数字字段；数字只在失焦或 Enter 后保存，快速操作
   不得回滚为旧值。
5. 检查系统监控页面 (`/monitor`)：
   - 检查各启用渠道连接状态；
   - 检查出站队列 (Outbox) 监控卡片，确认年龄计算、异常定位及来源 Bot/群/话题/Session 展示正常；
   - 若存在待确认投递 (uncertain)，可直接在界面上查看路由身份并执行 CAS 裁决。
6. 发起一个真实 Web Agent 回合；若本次涉及渠道或容器，再完成对应 IM 收发和 Container
   Agent 回合，确认流式输出、文件访问及最终回执正常。
7. 检查两个生产公网入口的 `/api/health` 与 `/api/health/readiness`、TLS 和静态资源加载均成功。

本地通过不等于部署完成；以上生产检查未通过时不得报告完成。

## 5. 回滚 (Rollback)

应用代码或构建产物异常、且数据库仍兼容旧代码时，可运行回滚脚本瞬间恢复到上一版本：

```bash
# 一键原子回滚至上一发布版本
./scripts/rollback-release.sh

# 或指定明确的历史 Commit SHA 进行回滚
./scripts/rollback-release.sh "$HAPPYCLAW_PREVIOUS_SHA"
```

回滚脚本会从不可变版本库中快速单步原子切换当前运行指针，还原上一版本不可变镜像并严格拉取/校验镜像完整性，随后通过 launchd 重启服务并严格校验就绪探针。
所有者选择不保留数据备份，因此数据库迁移后不存在数据恢复路径。若迁移导致旧代码
不兼容，应停止继续切换并以前向修复恢复服务，不得自行创建或恢复备份。回滚后重复第 4
节的健康检查与真实功能测试，并明确报告仅发生了代码回滚。
