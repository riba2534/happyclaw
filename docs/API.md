# HappyClaw Web API

本文档记录当前公开路由族和主要端点。请求/响应 Schema 以对应的
`src/routes/*.ts`、`src/schemas.ts` 和前端 API 调用为准。

## 约定

- API 默认前缀为 `/api`，WebSocket 为 `/ws`。
- 除明确标记 Public 的接口外，均需要有效的 HappyClaw Cookie Session。
- 资源接口还会执行 owner、角色、Permission、Host 执行权限等检查，见
  [ACL 权限矩阵](ACL-MATRIX.md)。
- 其他用户的资源通常以 `404` 返回，避免泄漏资源是否存在。
- Secret 写入后加密保存；读取 API 只返回脱敏值或“是否已配置”状态。

## 路由模块

| 前缀                               | 实现                             | 用途                          |
| ---------------------------------- | -------------------------------- | ----------------------------- |
| `/api/auth`                        | `src/routes/auth.ts`             | 初始化、登录、账户、设备      |
| `/api/groups`                      | `src/routes/groups.ts`           | 工作区兼容模型、消息和环境    |
| `/api/groups`                      | `src/routes/files.ts`            | 工作区文件                    |
| `/api/groups`                      | `src/routes/agents.ts`           | Runtime Session 与渠道绑定    |
| `/api/groups`                      | `src/routes/workspace-config.ts` | 项目 Skills/MCP               |
| `/api/workspaces`                  | `src/routes/workspaces.ts`       | Agent-first 工作区投影        |
| `/api/agent-profiles`              | `src/routes/agent-profiles.ts`   | 产品级 Agent                  |
| `/api/channel-accounts`            | `src/routes/channel-accounts.ts` | 多渠道账号                    |
| `/api/config`                      | `src/routes/config.ts`           | Provider、系统与兼容渠道配置  |
| `/api/tasks`                       | `src/routes/tasks.ts`            | 定时任务和运行                |
| `/api/memory`                      | `src/routes/memory.ts`           | 记忆                          |
| `/api/skills`                      | `src/routes/skills.ts`           | 用户 Skills                   |
| `/api/mcp-servers`                 | `src/routes/mcp-servers.ts`      | 用户/系统 MCP                 |
| `/api/plugins`                     | `src/routes/plugins.ts`          | Plugin Catalog 与用户启用状态 |
| `/api/usage`                       | `src/routes/usage.ts`            | Token 用量                    |
| `/api/billing`                     | `src/routes/billing.ts`          | 订阅、余额和计费管理          |
| `/api/admin`                       | `src/routes/admin.ts`            | 用户、邀请和审计              |
| `/api/bug-report`                  | `src/routes/bug-report.ts`       | 脱敏问题报告                  |
| `/api/browse`                      | `src/routes/browse.ts`           | Host 目录选择                 |
| `/api`                             | `src/routes/monitor.ts`          | 健康、状态和 Docker 构建      |
| `/api/messages`、`/api/follow-ups` | `src/web.ts`                     | 消息发送和 Follow-up          |

## 认证

Public：

- `GET /api/auth/status`
- `POST /api/auth/setup`，仅用户表为空时可用
- `POST /api/auth/login`
- `GET /api/auth/register/status`
- `POST /api/auth/register`
- `GET /api/auth/avatars/:filename`

登录后：

- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/auth/profile`
- `PUT /api/auth/password`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:id`
- `POST /api/auth/avatar`

## 工作区、消息和运行控制

- `GET|POST /api/groups`
- `PATCH|DELETE /api/groups/:jid`
- `PATCH /api/groups/:jid/agent-profile`
- `POST /api/groups/:jid/stop`
- `POST /api/groups/:jid/interrupt`
- `POST /api/groups/:jid/reset-session`
- `POST /api/groups/:jid/clear-history`
- `POST /api/groups/:jid/reset-owner`，admin break-glass
- `GET /api/groups/:jid/messages`
- `DELETE /api/groups/:jid/messages/:messageId`
- `GET|PUT /api/groups/:jid/env`
- `GET|PUT /api/groups/:jid/mcp`，仅兼容旧客户端
- `POST /api/messages`
- `GET /api/follow-ups`
- `POST /api/follow-ups/:messageId/action`

`POST /api/messages` 可以携带 Web 附件和 Runtime Session 标识。`/clear` 会进入与
`reset-session` 相同的 owner 级破坏性检查。

`POST /api/groups` 和 `PATCH /api/groups/:jid` 接受 `interaction_mode`
（`assistant` 或 `proactive`），两者的响应体都会回显当前值。该字段存放在
Workspace↔AgentProfile 绑定行上，因此：仅 `web:` 前缀工作区可修改，否则 403；
工作区没有 AgentProfile 绑定时返回 409 `WORKSPACE_AGENT_PROFILE_MISSING`。
它与 `execution_mode` 共享同一道 quiesce 边界，暖 Runner 只能观察到旧契约或新
契约；停机失败返回 503 并带 `persisted` 标记。

## 文件

- `GET|POST /api/groups/:jid/files`
- `POST /api/groups/:jid/files/open-directory`
- `GET /api/groups/:jid/files/download/:path`
- `GET /api/groups/:jid/files/preview/:path`
- `GET|PUT /api/groups/:jid/files/content/:path`
- `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

路径必须位于目标工作区允许范围内；系统目录、路径穿越和不安全符号链接会被拒绝。

## Runtime Session 与渠道绑定

推荐使用 `/sessions` 语义：

- `GET|POST /api/groups/:jid/sessions`
- `PATCH|DELETE /api/groups/:jid/sessions/:sessionId`
- `PUT /api/groups/:jid/sessions/:sessionId/im-binding`
- `DELETE /api/groups/:jid/sessions/:sessionId/im-binding/:imJid`

`/agents` 是同一模型的历史兼容别名：

- `GET|POST /api/groups/:jid/agents`
- `PATCH|DELETE /api/groups/:jid/agents/:agentId`
- `PUT /api/groups/:jid/agents/:agentId/im-binding`
- `DELETE /api/groups/:jid/agents/:agentId/im-binding/:imJid`

群聊绑定到工作区：

- `POST /api/groups/:jid/im-groups/sync`
- `GET /api/groups/:jid/im-groups`
- `PUT /api/groups/:jid/im-binding`
- `DELETE /api/groups/:jid/im-binding/:imJid`

约束：

- 工作区绑定只接受群聊。
- Runtime Session 绑定只接受私聊。
- 飞书话题群和需要 @ 激活的普通群使用 `thread_map`，每个原生上下文映射独立
  Runtime Session。
- 请求必须携带或解析出正确的 `channel_account_id`，不能跨机器人账号绑定。

## Agent Profiles

- `GET|POST /api/agent-profiles`
- `POST /api/agent-profiles/generate`
- `PATCH|DELETE /api/agent-profiles/:id`
- `POST|DELETE /api/agent-profiles/:id/avatar`
- `POST /api/agent-profiles/:id/refine-prompt`
- `GET /api/agent-profiles/:id/workspaces`
- `GET /api/agent-profiles/:id/prompt-versions`
- `POST /api/agent-profiles/:id/prompt-versions/:version/restore`
- `POST /api/agent-profiles/:id/effective-capabilities`

`effective-capabilities` 返回 PromptPlan、Skill/MCP Manifest、上下文预算和最近一次
脱敏运行快照，用于对比“配置预期”与“SDK 实际加载”。

## Agent-first 工作区投影

- `GET /api/workspaces`
- `GET /api/workspaces/mounts`
- `GET /api/workspaces/:jid`
- `GET /api/workspaces/:jid/runtime-sessions`
- `GET /api/workspaces/:jid/channel-mounts`

这些接口是 `registered_groups` 兼容存储之上的只读产品投影。

## 工作区项目能力

- `GET /api/groups/:jid/workspace-config/skills`
- `POST /api/groups/:jid/workspace-config/skills/install`
- `PATCH|DELETE /api/groups/:jid/workspace-config/skills/:id`
- `GET|POST /api/groups/:jid/workspace-config/mcp-servers`
- `PATCH|DELETE /api/groups/:jid/workspace-config/mcp-servers/:id`

读操作要求访问工作区，写操作要求工作区 owner。

## 渠道账号

- `GET|POST /api/channel-accounts`
- `GET|PATCH|DELETE /api/channel-accounts/:id`
- `POST /api/channel-accounts/:id/test`
- `POST /api/channel-accounts/:id/toggle`
- `POST /api/channel-accounts/:id/onboarding`
- `GET /api/channel-accounts/:id/onboarding/status`
- `POST /api/channel-accounts/:id/onboarding/verify`
- `POST /api/channel-accounts/:id/pairing-code`
- `GET /api/channel-accounts/:id/paired-chats`
- `DELETE /api/channel-accounts/:id/paired-chats/:jid`
- `POST /api/channel-accounts/:id/disconnect`
- `POST /api/channel-accounts/:id/logout`

账号严格按 `owner_user_id` 隔离。同一 Provider 可以有多个账号，每个账号可以选择
默认工作区。

## Provider 与系统配置

Provider：

- `GET /api/config/claude`
- `GET|POST /api/config/claude/providers`
- `PATCH|DELETE /api/config/claude/providers/:id`
- `PUT /api/config/claude/providers/:id/secrets`
- `POST /api/config/claude/providers/:id/toggle`
- `POST /api/config/claude/providers/:id/reset-health`
- `GET /api/config/claude/providers/health`
- `GET /api/config/claude/providers/:id/usage`
- `PUT /api/config/claude/balancing`
- `POST /api/config/claude/apply`
- `POST /api/config/claude/oauth/start`
- `POST /api/config/claude/oauth/callback`
- `PUT /api/config/claude/custom-env`

系统：

- `GET|PUT /api/config/system`
- `GET|PUT /api/config/host-integration`
- `GET /api/config/external-resources`
- `GET /api/config/external-resources/rule`
- `GET|PUT /api/config/registration`
- `GET|PUT /api/config/appearance`
- `GET /api/config/appearance/public`，Public
- `POST|DELETE /api/config/appearance/avatar`

Legacy 渠道 facade 位于 `/api/config/user-im/*`，涵盖飞书、Telegram、QQ、钉钉、
微信、Discord 和 WhatsApp。它们继续服务旧数据和旧客户端；新 UI 与新功能使用
`/api/channel-accounts`。

系统级 `/api/config/feishu` 和 `/api/config/telegram` 也只保留兼容用途。

## 定时任务

- `GET|POST /api/tasks`
- `PATCH|DELETE /api/tasks/:id`
- `POST /api/tasks/:id/restore`
- `POST /api/tasks/:id/runs`
- `GET /api/tasks/:id/runs`
- `GET /api/tasks/runs/:runId`
- `POST /api/tasks/runs/:runId/cancel`
- `POST /api/tasks/:id/run`，旧立即运行入口
- `GET /api/tasks/:id/logs`，旧日志入口
- `POST /api/tasks/ai`
- `POST /api/tasks/parse`

写入使用 revision 或 idempotency key 防止并发覆盖和重复运行。运行状态与通知状态
分开持久化；通知失败不会重新执行任务主体。

所有创建入口（手工 REST、AI 创建和 MCP `schedule_task`）以及软删恢复都会在同一
原子边界检查 `maxTasksPerUser`；达到上限时返回 409 `TASK_LIMIT_REACHED`
（已软删的不计入）。`prompt` 与 `script_command` 有长度上限，AI 输入和解析结果、
REST 与 MCP `schedule_task` / `update_task` 使用同一组上限，超出即拒绝。

PATCH 修改 `chat_jid` 时会同时更新任务的具体 `delivery_route_jid`。已经物化的 Run
在 `definition_snapshot` 中冻结原投递路由，不会因后续任务编辑而切换目标。

## Skills、MCP 和 Plugins

Skills：

- `GET /api/skills`
- `GET /api/skills/search`
- `GET /api/skills/search/detail`
- `POST /api/skills/import/git`
- `POST /api/skills/import/archive`
- `GET|PATCH|DELETE /api/skills/:id`
- `DELETE /api/skills/user-all`
- `POST /api/skills/install`
- `POST /api/skills/:id/reinstall`

MCP：

- `GET|POST /api/mcp-servers`
- `GET|PATCH|DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`

Plugins：

- `GET /api/plugins`
- `PATCH /api/plugins/enabled/:pluginFullId`
- `POST /api/plugins/materialize`
- `DELETE /api/plugins/marketplaces/:name`，只清理调用者自己的启用引用
- `GET /api/plugins/commands`
- `GET /api/plugins/catalog`
- `GET /api/plugins/catalog/marketplaces/:mp`
- `POST /api/plugins/catalog/scan`，admin

已删除的旧 Plugin 接口不得重新引用：

- `POST /api/plugins/sync-host`
- `GET /api/plugins/available-on-host`

## 记忆

- `GET /api/memory/sources`
- `GET /api/memory/search`
- `GET|PUT /api/memory/file`
- `GET|PUT /api/memory/global`

## 用量与计费

用量：

- `GET /api/usage/stats`
- `GET /api/usage/models`
- `GET /api/usage/filters`
- `GET /api/usage/records`
- `GET /api/usage/export.csv`
- `GET /api/usage/users`

计费用户侧：

- `GET /api/billing/status`
- `GET /api/billing/plans`
- `GET /api/billing/my/subscription`
- `GET /api/billing/my/balance`
- `GET /api/billing/my/usage`
- `GET /api/billing/my/usage/daily`
- `GET /api/billing/my/transactions`
- `GET /api/billing/my/quota`
- `GET /api/billing/my/access`
- `POST /api/billing/my/redeem`
- `PATCH /api/billing/my/auto-renew`
- `POST /api/billing/my/cancel-subscription`

计费管理接口位于 `/api/billing/admin/*`，统一要求 `manage_billing`。

## 管理、监控与问题报告

管理：

- `GET|POST /api/admin/users`
- `PATCH|DELETE /api/admin/users/:id`
- `POST /api/admin/users/:id/restore`
- `DELETE /api/admin/users/:id/sessions`
- `GET /api/admin/permission-templates`
- `GET|POST /api/admin/invites`
- `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET /api/admin/audit-log/export`

监控：

- `GET /api/health`，Public
- `GET /api/status`
- `POST /api/status/groups/:folder/switch-provider`
- `GET /api/status/channel-outbox/uncertain`
- `POST /api/status/channel-outbox/:id/resolve`
- `POST /api/docker/build`

投递结果不确定的 outbox 记录会围栏住整个 Turn，运行时无法自行判定，只能由人工
确认后放行。`resolve` 使用 `expectedRevision` 做 compare-and-set，取值为
`delivered`（需要 `providerMessageId`）或 `failed`；revision 过期返回 409，
调用方必须重新读取后再决定，不能盲目重试。列表不返回 payload。

问题报告：

- `GET /api/bug-report/capabilities`
- `POST /api/bug-report/generate`
- `POST /api/bug-report/submit`

目录浏览：

- `GET|POST /api/browse/directories`

## WebSocket

`/ws` 在 Upgrade 时校验 Cookie Session 和 Origin。

客户端主要操作：

- `send_message`
- `terminal_start`
- `terminal_input`
- `terminal_resize`
- `terminal_stop`

服务端主要事件：

- `new_message`
- `agent_reply`
- `typing`
- `status_update`
- `stream_event`
- `agent_status`
- `terminal_output`
- `terminal_started`
- `terminal_stopped`
- `terminal_error`
- `docker_build_log`
- `docker_build_complete`

精确联合类型和字段以 `src/web.ts`、`src/types.ts` 与 `shared/stream-event.ts` 为准。
