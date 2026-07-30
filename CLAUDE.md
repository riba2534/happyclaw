# HappyClaw — 工程协作指南

本文档描述当前代码的工程约束和导航入口，供人类与 AI 协作者共同使用。

## 1. 文档与代码真相源

- 产品介绍、安装和常用操作：`README.md`
- 路由族与主要 Web API：`docs/API.md`
- 权限边界：`docs/ACL-MATRIX.md`
- 运行时 Prompt：`container/agent-runner/prompts/`
- 数据库 Schema：`src/db.ts` 中的 `CURRENT_SCHEMA_VERSION` 与建表/迁移代码
- Web 路由：`web/src/App.tsx`
- 系统设置及默认值：`src/runtime-config.ts`
- 渠道能力与会话路由：`src/im-channel-capabilities.ts`、`src/channel-mount-service.ts`
- StreamEvent：`shared/stream-event.ts`

`docs/agent-first-architecture-plan.md` 和
`docs/claude-code-plugin-automation-design.md` 是历史设计记录，不作为当前接口或数据结构的真相源。

## 2. 产品模型

HappyClaw 是基于 Claude Agent SDK 的自托管、多用户 Agent 工作台，支持 Web 与飞书、
Telegram、QQ、钉钉、微信、Discord、WhatsApp。

当前产品层级：

```text
Agent Profile（身份、四段 Prompt、能力策略）
└── Workspace（文件目录、执行模式、环境变量、渠道群聊绑定）
    ├── Main Session
    ├── Runtime Session（独立 Claude 上下文，可绑定私聊）
    ├── Native Context Session（飞书话题等原生线程）
    └── Scheduled Run（group 或 isolated）
```

重要命名边界：

- `agent_profiles` 是产品级 Agent。
- `registered_groups` 是当前兼容层中的工作区和渠道路由记录。
- `agents` 表及 `/api/groups/:jid/agents` 是历史命名，实际表示工作区内的运行会话，
  不是产品级 Agent Profile。
- 同一个 Workspace 内的会话共享工作区文件目录，但拥有独立 Claude Session；
  工作区文件隔离与对话上下文隔离是两件事。

## 3. 主要模块

### 3.1 主服务

| 文件/目录                          | 职责                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `src/index.ts`                     | 启动、消息消费、渠道路由、IPC、调度与 Agent 运行编排   |
| `src/web.ts`                       | Hono 应用、路由挂载、Cookie 认证、WebSocket 与静态资源 |
| `src/db.ts`                        | SQLite Schema、迁移和持久化访问器                      |
| `src/group-queue.ts`               | Session 串行、Runner 生命周期、重试与容量控制          |
| `src/container-runner.ts`          | Host/Container Runner、挂载、环境与能力快照            |
| `src/task-scheduler.ts`            | Cron、interval、once 调度和重启恢复                    |
| `src/channel-mount-service.ts`     | 工作区/会话绑定和原生线程路由                          |
| `src/channel-reliability-store.ts` | Inbox、Turn、Outbox、Streaming Card 的持久状态机       |
| `src/im-manager.ts`                | 多用户、多账号渠道连接池                               |
| `src/agent-capability-preview.ts`  | Agent 最终上下文和能力预览                             |
| `src/claude-context-resolver.ts`   | Claude 上下文、Skills 与来源解析                       |

渠道实现位于：

- `src/feishu.ts`
- `src/telegram.ts`
- `src/qq.ts`
- `src/dingtalk.ts`
- `src/wechat.ts`
- `src/discord.ts`
- `src/whatsapp.ts`

HTTP 路由位于 `src/routes/`，完整模块索引见 `docs/API.md`。

### 3.2 Web

Web 位于 `web/`，使用 React 19、Vite、Tailwind CSS 4、React Router、Zustand 和
Radix UI。路由以 `web/src/App.tsx` 为准：

| 路径                      | 用途                                  |
| ------------------------- | ------------------------------------- |
| `/setup`                  | 首个管理员初始化                      |
| `/setup/providers`        | Provider 引导                         |
| `/setup/channels`         | 用户渠道引导                          |
| `/login`、`/register`     | 登录和注册                            |
| `/chat/:groupFolder?`     | 工作台与会话                          |
| `/agent-profiles`         | Agent 管理                            |
| `/capabilities/:section?` | Skills、MCP、Plugins                  |
| `/tasks`                  | 定时任务                              |
| `/usage`、`/billing`      | 用量与计费                            |
| `/memory`                 | 记忆管理                              |
| `/settings`               | 账户和系统设置                        |
| `/monitor`                | 运行状态，需要 `manage_system_config` |
| `/users`                  | 用户、邀请和审计管理                  |

`/groups`、`/skills`、`/mcp-servers` 和 `/plugins` 是兼容重定向，不应新增独立页面。

### 3.3 Agent Runner

`container/agent-runner/` 同时服务 Host 和 Container 两种执行模式：

- stdin 接收 `ContainerInput`。
- stdout 使用 `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` 输出结构化结果。
- 后续消息、工具请求和关闭控制通过独立 IPC 目录传递。
- `container/agent-runner/prompts/` 中的 Prompt 在启动时加载。
- HappyClaw MCP 工具由 `container/agent-runner/src/mcp-tools.ts` 注册。
- `shared/stream-event.ts` 同步到主服务、Web 和 Runner。

不要在文档中维护固定的 MCP 工具数量或 StreamEvent 数量；它们会随能力演进变化，
应直接查看类型与注册代码。

## 4. 执行和并发

| 模式      | 行为                                                          | 容量边界                                             |
| --------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Host      | Runner 作为宿主机 Node 进程运行，`customCwd` 直接作为工作目录 | 同一 Session 串行；不同 Session 不设置应用层并发上限 |
| Container | Runner 在非 root Docker 容器运行，通过只读/读写挂载访问资源   | 受 `maxConcurrentContainers` 和用户计费配额限制      |

共同约束：

- 同一序列化键内的消息保持顺序。
- 不同飞书话题、不同 Runtime Session 使用不同序列化键，可以并发。
- 普通消息与定时任务使用明确的队列状态；失败采用有界指数退避。
- `CONTAINER_TIMEOUT` 控制单次运行上限，`IDLE_TIMEOUT` 控制暖 Runner 的空闲保留时间。
- Script 任务与其他任务共用 `CONTAINER_TIMEOUT`，不设置独立并发池或超时配置。
- 服务重启时，错过的周期任务记为 `missed` 并推进计划；一次性任务仍会补跑。

Host 模式没有 `maxConcurrentHostProcesses`。旧客户端提交该字段时后端仅为兼容而忽略，
不得重新把它实现为全局 Host 并发池。

## 5. Agent Prompt 与能力

自定义 Agent 使用四段 Prompt：

- `IDENTITY`：身份、使命和边界。
- `SOUL`：稳定价值观、判断原则和表达风格，可为空。
- `AGENTS`：工作流、输入输出、默认值、分支和失败处理。
- `TOOLS`：Skill、MCP 和工具的选择方式与限制，可为空。

运行时能力不是简单拼接文本：

1. `claude-context-resolver` 解析 managed 或 `host_claude` 上下文。
2. Effective Skill/MCP Resolver 生成精确清单与 hash。
3. Container 模式逐个只读挂载选中的 Skill。
4. Host 模式也使用同步后的 Session `.claude` 目录和相同能力清单。
5. Plugin 使用用户版本化 runtime snapshot，通过 SDK `options.plugins` 注入。
6. PromptPlan 和 ContextBudget 记录最终上下文来源与预算。

规则：

- Agent 工具权限保持开放；不要虚构只读或受限工具模式。
- 宿主机 Skills 由 `runtime_policy.skills.host` 独立选择，不能通过
  `host_claude` 开关隐式获得。
- 工作区 `CLAUDE.md`、项目 `.claude/skills` 和项目 MCP 属于项目上下文层。
- 禁用、删除或缺失的精确选择能力必须让配置失败，不得静默替换。
- Prompt 或能力身份变化后必须失效旧的暖 Runner。

内置 Skills 由 `scripts/install-host-tools.sh` 固定版本下载到
`data/builtin-skills/`，并由 `scripts/builtin-skill-catalog.mjs` 校验清单和 payload hash。
仓库不再维护或注入另一套容器内未治理 Skills。

## 6. 渠道、账号和上下文

### 6.1 多账号

- 每个用户可以为同一 Provider 创建多个 `channel_accounts`。
- 每个渠道 JID 和 mount 都携带 `channel_account_id`，发送时使用绑定账号的机器人身份。
- 账号可以设置默认工作区；恢复默认绑定时先解析账号归属，不能跨用户或跨账号回退。
- 同一工作区可以绑定多个机器人账号和多个群聊。

### 6.2 绑定边界

- 工作区绑定只接受群聊。
- Runtime Session 绑定只接受私聊。
- Web 是控制面和公共入口，不改变已经由原生 IM 首次占有的 Session 渠道身份。
- 一个逻辑 Session 的首个原生消息渠道通过 `setSessionChannelOwnerOnce()` 持久化；
  后续从 Web 继续对话仍沿用该原生渠道上下文和交付目标。
- 文件和图片投递必须使用当前 Turn 的 `ChannelTurnContext`，不能从“最近一条群消息”
  猜测目标。

### 6.3 飞书会话语义

触发方式与响应对象互相独立：

- `activation_mode=always`：无需 @。
- `activation_mode=when_mentioned`：需要 @ 才激活。
- `activation_mode=disabled`：暂停响应。
- `audience_mode=everyone`：允许所有成员。
- `audience_mode=owner_only`：只允许已记录的主人。

普通飞书群：

- `always` 使用整个群共享的主上下文。
- `when_mentioned` 中，首次 @ 消息作为根建立飞书话题和独立 Runtime Session；
  后续在该话题内无需再次 @。

飞书话题群：

- 每个原生话题拥有独立 Runtime Session。
- `always` 与 `when_mentioned` 只决定话题是否需要首次激活，不合并不同话题上下文。

原生上下文映射持久化在 `im_context_bindings`。工作区群聊挂载使用
`channel_mounts`，Agent/会话挂载使用 `agent_channel_mounts`；兼容字段仍双写，
迁移期间不得只更新其中一侧。

### 6.4 IM 命令

当前命令由 `src/index.ts` 的 `handleCommand()` 分发：

- 只读：`/list`、`/ls`、`/status`、`/where`、`/recall`、`/rc`、`/allowlist`
- 变更：`/clear`、`/bind`、`/unbind`、`/new`、`/sw`、`/spawn`
- Owner：`/owner_mention`、`/release_owner`、`/allow`、`/disallow`
- 激活：`/require_mention`

破坏性命令受 `OWNER_REQUIRED_IM_COMMANDS` 和渠道原生 sender ID 约束。
响应对象策略不能因服务重启、同步聊天或恢复绑定而回退成默认值。

## 7. 数据与目录

运行时数据默认位于 `data/`，不进入 Git：

```text
data/
├── db/messages.db
├── config/
├── groups/{folder}/
├── sessions/{folder}/.claude/
├── sessions/{folder}/agents/{sessionId}/.claude/
├── ipc/{folder}/
├── ipc/{folder}/agents/{sessionId}/
├── memory/
├── skills/{userId}/
├── builtin-skills/
├── mcp-servers/{userId}/
├── plugins/
├── agent-profile-runtime/
├── env/
└── extra/
```

主要数据库当前 Schema 版本以 `src/db.ts` 的 `CURRENT_SCHEMA_VERSION` 为准。
不要在文档中复制版本号；迁移必须同时具备备份、前向升级和拒绝降级保护。

核心表族：

- 用户与认证：`users`、`user_sessions`、`invite_codes`、`auth_audit_log`
- 工作区与会话：`registered_groups`、`sessions`、`workspaces`、
  `workspace_runtime_sessions`
- Agent：`agent_profiles`、`agent_profile_prompt_versions`、
  `agent_builder_drafts`、`workspace_agent_profiles`、`agents`
- 渠道：`channel_accounts`、`channel_mounts`、`agent_channel_mounts`、
  `im_context_bindings`
- 消息与调度：`chats`、`messages`、`scheduled_tasks`、`task_runs`、
  `task_run_logs`
- 用量与计费：`usage_records`、`usage_events`、`usage_daily_summary` 及
  `billing_*`、订阅、余额和兑换码相关表

Channel Reliability 的 Inbox/Turn/Outbox/Card 表由
`src/channel-reliability-store.ts` 在同一数据库连接上创建。

## 8. 认证与权限

- Cookie 会话使用 HMAC 签名，密钥来自环境变量、持久文件或首次自动生成。
- `canAccessGroup`、`canModifyGroup` 和 `canDeleteGroup` 不提供 admin 全局旁路；
  工作区和渠道资源按 `created_by` 隔离。
- Host 工作区额外要求 admin 角色。
- 系统配置、用户、邀请、审计和计费使用独立 Permission Middleware。
- 敏感写操作必须先停止或暂停相关 Runner，并在提交失败时恢复队列。
- API 返回资源不存在时通常使用 404 隐藏其他用户资源是否存在。

完整边界见 `docs/ACL-MATRIX.md`。

## 9. 配置

系统设置优先级为：

```text
Web 持久设置 > 环境变量 > 代码默认值
```

常用环境变量：

| 变量                        | 默认值                            | 说明                              |
| --------------------------- | --------------------------------- | --------------------------------- |
| `WEB_PORT`                  | `3000`                            | HTTP、WebSocket 端口              |
| `WEB_SESSION_SECRET`        | 自动生成并持久化                  | Cookie 签名                       |
| `CONTAINER_IMAGE`           | `riba2534/happyclaw-agent:latest` | GitHub Actions 发布的 Runner 镜像 |
| `CONTAINER_TIMEOUT`         | `1800000`                         | 默认运行超时                      |
| `IDLE_TIMEOUT`              | `1800000`                         | 暖 Runner 空闲时间                |
| `MAX_CONCURRENT_CONTAINERS` | `20`                              | Docker 并发                       |
| `MAX_FILE_SIZE_MB`          | `50`                              | Web/IM 入站文件上限               |
| `CORS_ALLOWED_ORIGINS`      | 仅 localhost                      | WebSocket Origin 白名单           |
| `TRUST_PROXY`               | `false`                           | 是否信任反向代理来源头            |
| `TZ`                        | 系统时区                          | 调度时区                          |

Provider 和渠道账号应优先通过 Web 配置。Legacy `/api/config/user-im/*` 只用于兼容，
新功能统一使用 `/api/channel-accounts`。

## 10. 开发与验证

```bash
make install
make dev
make start
make typecheck
make test
make build
npm run self-test
```

约束：

- 只使用 Node.js/npm，不使用 Bun。
- 三个 Node 项目分别位于根目录、`web/`、`container/agent-runner/`，均使用
  `npm ci` 和已提交 lockfile。
- 修改共享类型后运行 `make sync-types`；`make typecheck` 会检查副本一致性。
- 修改 Prompt 后确保 `scripts/check-agent-runner-prompts.sh` 通过。
- 修改文档后运行 `npm run docs:check`。
- SDK/CLI 升级必须显式执行 `make update-sdk`，验证后提交 package.json 与 lockfile。
- 容器以非 root 用户执行 Agent；修改 Dockerfile 或 entrypoint 后需要重建镜像。
- 停止服务只能杀监听进程：`lsof -ti:PORT -sTCP:LISTEN | xargs kill`。
- 不要使用会杀死连接方或 Docker 网络代理的宽泛端口 kill 命令。

### 常见修改入口

| 任务             | 入口                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| 新增 Web 设置    | `src/runtime-config.ts`、`src/schemas.ts`、`web/src/components/settings/`    |
| 新增 HTTP API    | 对应 `src/routes/*.ts`，同步 `docs/API.md` 和 ACL                            |
| 新增 MCP 工具    | `container/agent-runner/src/mcp-tools.ts` 与 `src/index.ts` IPC              |
| 新增渠道         | 渠道工厂、`src/im-manager.ts`、`src/channel-prefixes.ts`、渠道账号 Schema/UI |
| 新增 StreamEvent | `shared/stream-event.ts` 后运行 `make sync-types`                            |
| 修改数据库       | `src/db.ts` 新 migration、升级 `CURRENT_SCHEMA_VERSION`、补迁移测试          |
| 修改 Agent 能力  | Resolver、Capability Preview、Runner 三侧同时验证                            |

### 提交前门槛

```bash
npm run format:changed
npm run docs:check
make typecheck
make test
make build
git diff --check
```

真实 Provider 测试使用 `npm run test:real-model`，会产生真实请求和可能的费用，
不要把凭据、Endpoint、模型名或未脱敏回复写入日志。
