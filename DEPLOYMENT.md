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
- Mac mini 的安全 IPC 结果发布依赖 `/usr/bin/python3` 的原生目录相对系统调用。
  在切换前检查 `open`、`rename` 和 `unlink` 均支持 `dir_fd`；能力缺失时不得降级为
  路径写入或继续部署。

连接并设置本次部署参数：

```bash
ssh macmini
cd /Users/riba2534/airepo/happyclaw
export HAPPYCLAW_DEPLOY_REF='codex/replace-with-remote-branch'
export HAPPYCLAW_EXPECTED_SHA='replace-with-full-commit-sha'
export HAPPYCLAW_PUBLIC_URL='https://claw.home.riba2534.cn:23333'
export HAPPYCLAW_AGENT_IMAGE='riba2534/happyclaw-agent:latest'
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

/usr/bin/python3 -I -S -c 'import os; assert all(f in os.supports_dir_fd for f in (os.open, os.rename, os.unlink)), "Secure IPC dir_fd support unavailable"'

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

## 3. 构建与切换

使用远程分支的精确提交，以 detached HEAD 部署，避免意外推进 Mac mini 上的 `main`：

```bash
git switch --detach "$HAPPYCLAW_EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$HAPPYCLAW_EXPECTED_SHA"

if grep -q '^HAPPYCLAW_SKIP_MIGRATION_BACKUP=' .env 2>/dev/null; then
  sed -i '' 's/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/HAPPYCLAW_SKIP_MIGRATION_BACKUP=1/' .env
else
  printf '\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n' >> .env
fi
chmod 600 .env

/bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
/bin/zsh -lic "docker pull '$HAPPYCLAW_AGENT_IMAGE'"
```

若本次使用不可变分支镜像，只原地更新现有 `.env` 中的 `CONTAINER_IMAGE`；不得创建
备份副本、覆盖其他环境变量或把 `.env` 提交到 Git：

```bash
if grep -q '^CONTAINER_IMAGE=' .env 2>/dev/null; then
  sed -i '' "s|^CONTAINER_IMAGE=.*$|CONTAINER_IMAGE=$HAPPYCLAW_AGENT_IMAGE|" .env
else
  printf '\nCONTAINER_IMAGE=%s\n' "$HAPPYCLAW_AGENT_IMAGE" >> .env
fi
chmod 600 .env
```

构建失败时不要重启服务；旧进程仍在使用此前的 `dist/`。修复分支后重新从预检开始。

## 4. 重启与生产验证

```bash
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'HappyClaw did not become healthy.' >&2
    exit 1
  fi
  sleep 2
done

launchctl print "gui/$(id -u)/com.riba2534.happyclaw" | head -40
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/config/appearance/public
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth/me)" = 401
curl -fsS "$HAPPYCLAW_PUBLIC_URL/api/health"
tail -100 "$HOME/Library/Logs/happyclaw/happyclaw.log"
```

随后从真实公网入口完成与改动相关的真实测试，并分别记录结果：

1. 未登录打开登录页，确认自定义站点名称、图形 Logo 和浏览器标题生效。
2. 注册或登录后确认同一品牌立即进入侧边栏，无需刷新页面。
3. 管理员分别修改站点名称、图形 Logo 和文字 Logo，确认保存中控件禁用，最终页面与
   `/api/config/appearance/public` 一致。
4. 打开模型连接的编辑页，修改一个模型的上下文长度或推理等级后保存，确认列表与对话页
   模型选择器里的档位一致。
5. 发起一个真实 Web Agent 回合；若本次涉及渠道或容器，再完成对应 IM 收发和 Container
   Agent 回合，确认流式输出、文件访问及最终回执正常。
6. 检查生产公网入口的 `/api/health`、TLS 和静态资源加载均成功。

本地通过不等于部署完成；以上生产检查未通过时不得报告完成。

## 5. 回滚

应用代码或构建产物异常、且数据库仍兼容旧代码时，回到第 2 节记录的提交：

```bash
git switch --detach "$HAPPYCLAW_PREVIOUS_SHA"
/bin/zsh -lic 'make install'
/bin/zsh -lic 'npm run build:all'
launchctl kickstart -k "gui/$(id -u)/com.riba2534.happyclaw"
curl -fsS http://127.0.0.1:3000/api/health
```

所有者选择不保留数据备份，因此数据库迁移后不存在数据恢复路径。若迁移导致旧代码
不兼容，应停止继续切换并以前向修复恢复服务，不得自行创建或恢复备份。回滚后重复第 4
节的健康检查与真实功能测试，并明确报告仅发生了代码回滚。

## 6. Office 文件预览（可选）

文件面板把 doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp 在服务端转成 PDF 预览。没有配置转换器
时预览返回「未配置」，其他功能不受影响。配置写在现有 `.env` 里（同第 3 节，原地修改、
不建备份），重启服务后生效：

| 变量                               | 默认值  | 含义                                                                                 |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `OFFICE_PREVIEW_STIRLING_URL`      | 未设置  | Stirling-PDF 兼容服务的完整转换地址（`.../api/v1/convert/file/pdf`）；设置后优先使用 |
| `OFFICE_PREVIEW_STIRLING_KEY_FILE` | 未设置  | 可选，内容作为 `X-API-KEY` 发给该服务；密钥只从文件读取，文件应为 `600`              |
| `OFFICE_PREVIEW_SOFFICE_BIN`       | 未设置  | 本机 LibreOffice `soffice` 的绝对路径；只有显式设置才启用，不搜索 PATH               |
| `OFFICE_PREVIEW_MAX_MB`            | `50`    | 源文件上限；转换结果上限是它的 4 倍                                                  |
| `OFFICE_PREVIEW_TIMEOUT_MS`        | `60000` | 单次转换超时                                                                         |
| `OFFICE_PREVIEW_CACHE_MAX_MB`      | `1024`  | `data/cache/office-preview/` 的总量上限，超出时先淘汰最久未用的                      |

同时最多 2 个转换、8 个排队，再多返回 503。缓存按源文件内容寻址、跨用户共享，可以随时
删除，删除后下次打开重新转换。

本机 LibreOffice 的安全前提：`soffice` 在宿主机上以 HappyClaw 服务的身份运行，解析的是
工作区里的文档，包括 member 的 Container 工作区里由 Agent 或其他人写入的不可信文件。
LibreOffice 的解析漏洞因此会以服务身份执行，能读到服务能读的一切（`data/`、`.env`、
渠道凭据），越过「非 admin 的工作区在容器里运行」这条边界。HappyClaw 只给它最小环境
（`PATH`、指向本次临时目录的 `HOME`/`TMPDIR`、`LANG`/`LC_ALL`），让它在独立进程组里
运行并在超时时整组杀掉，但这不是沙箱。只有所有能预览文件的人都可信时（例如只有所有者
自己使用的实例）才设置 `OFFICE_PREVIEW_SOFFICE_BIN`；Mac mini 上的路径是
`/Applications/LibreOffice.app/Contents/MacOS/soffice`。

多用户部署推荐 Stirling-PDF：把它作为独立容器运行在只有 HappyClaw 能访问的地址上，
配置 `OFFICE_PREVIEW_STIRLING_URL` 和密钥文件，文档在它的容器里解析。两者都设置时使用
Stirling。配置后在文件面板打开一个 docx 确认能预览；第二次打开应立即显示（命中缓存）。

## 7. Web 推送通知（可选）

用户在「设置 → 常规 → 推送通知」为当前设备开启后，Web 来源的回复完成或运行出错时，
如果没有正在看该会话的可见页面，服务端会向这台设备发系统通知。部署侧需要确认：

- 页面必须通过 HTTPS 访问（本机 `localhost` 除外）。HTTP 局域网地址不是安全上下文，浏览器
  不提供推送，设置页无法开启。iPhone 和 iPad 只有添加到主屏幕的应用能收到推送。
- 服务器要能访问推送服务：`fcm.googleapis.com`（Chrome、Edge、Android）、
  `web.push.apple.com`（Safari、主屏幕应用）、`*.push.services.mozilla.com`（Firefox）、
  `*.notify.windows.com`。大陆部署通常要在 `.env` 设置 `HTTPS_PROXY`；推送请求与其他出站
  请求一样遵守 `NO_PROXY`。单次投递最长 10 秒。
- 在 `.env` 设置 `WEB_PUSH_SUBJECT` 为本实例的联系地址（`mailto:ops@example.com` 或
  `https://` 地址），推送服务在出现问题时用它联系部署方；未设置时使用本项目的 GitHub
  地址。修改后重启服务生效。
- 签名密钥在首次使用时生成到 `data/config/web-push-vapid.json`（权限 600）。迁移、恢复时
  随 `data/` 保留；文件损坏时推送会被停用并在日志里报错，删除它会生成新密钥，所有设备都要
  重新开启推送。

验证：在 HTTPS 地址上开启推送后点「发送测试通知」（每个账号每分钟最多 3 次），应在几秒
内收到一条通知；把页面切到后台再发一条消息，回复完成时应收到通知。退出登录会注销这台设备
的推送订阅。
