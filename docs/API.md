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
| `/api/config`                      | `src/routes/brand-assets.ts`     | 品牌资源上传、删除与公开读取  |
| `/api/tasks`                       | `src/routes/tasks.ts`            | 定时任务和运行                |
| `/api/memory`                      | `src/routes/memory.ts`           | Workspace Memory v2           |
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
- `POST /api/groups/:jid/clear-history`，重建工作区内容：永久清除聊天、
  Runtime Session、子对话、工作目录及 Workspace Memory（含版本历史和
  Home Owner Profile），关联定时任务停止并移入回收站；保留工作区外壳、
  `data/extra/` 和任务运行历史
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

Home Workspace 固定归属当前用户的内置 HappyClaw。尝试通过
`PATCH /api/groups/:jid/agent-profile` 将 Home 迁移到自定义 Agent 时返回：

```json
{
  "error": "Home Workspace 始终属于内置 HappyClaw，不能迁移到自定义智能体",
  "code": "HOME_WORKSPACE_AGENT_IMMUTABLE"
}
```

HTTP 状态为 409；请求不会停止现有 Runner，也不会修改绑定。

创建 Docker 工作区时，当前有效的管理员可以在 `POST /api/groups` 中提交
`additional_mounts`（最多 8 项）：

```json
{
  "name": "数据分析",
  "execution_mode": "container",
  "additional_mounts": [
    {
      "host_path": "/srv/datasets",
      "container_path": "datasets",
      "readonly": true
    }
  ]
}
```

`host_path` 是 HappyClaw/Docker 守护进程所在服务器上的绝对目录，不是浏览器
所在设备的目录；`container_path` 是 `/workspace/extra/` 下的相对路径。来源目录
必须通过 `config/mount-allowlist.json`，目标不能重复、嵌套、穿越或覆盖运行时
保留目录。普通用户、停用管理员和 host 模式请求都会被拒绝。权限、allowlist、
真实路径与目录类型会在每次容器启动前重新校验，因此管理员被降权、目录被删除、
符号链接被替换或策略收紧后，旧配置不会继续生效。管理界面使用
`GET /api/browse/directories?purpose=mount` 浏览服务器目录；未配置有效 allowlist
时该入口 fail-closed。

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

`POST /api/agent-profiles` 只创建隔离的 AgentProfile。它不会隐式创建 Workspace、
Session 或 Memory，也不会绑定/复制 Home Workspace。用户必须在创建 Workspace 时
显式选择它，或通过上面的非 Home Workspace 迁移接口建立归属。内置 HappyClaw 的
代码级平台身份不存放在这些可编辑的 Prompt 字段中，自定义 Agent 不会继承。

## Agent-first 工作区投影

- `GET /api/workspaces`
- `GET /api/workspaces/mounts`
- `GET /api/workspaces/:jid`
- `GET /api/workspaces/:jid/runtime-sessions`
- `GET /api/workspaces/:jid/channel-mounts`

这些接口是 `registered_groups` 兼容存储之上的只读产品投影。

### HappyClaw Owner Profile

- `GET /api/workspaces/:jid/owner-profile`
- `PATCH /api/workspaces/:jid/owner-profile`

只允许该用户不可删除的 Home Workspace、内置默认 HappyClaw AgentProfile 和实际
owner。无权访问、自定义 Agent 或非 Home 目标统一返回 404。

PATCH 使用 action 联合类型：

```json
{
  "action": "set",
  "preferredAddress": "小何",
  "expectedRevision": 0,
  "idempotencyKey": "owner-address-first-set"
}
```

首次设置的 `expectedRevision` 可省略或为 `0`；已有/已清空值必须先 GET，并携带返回
的当前 `revision`。修改成功会在同一事务中完成 onboarding。清空不会重置冷启动：

```json
{
  "action": "clear",
  "expectedRevision": 3,
  "idempotencyKey": "owner-address-clear-3"
}
```

owner 明确拒绝首次设置时可提交
`{"action":"skip","expectedOnboardingRevision":1}`。CAS 过期或从未设置却执行 clear
返回 409 `revision_conflict`；重复 idempotency key 对应不同请求返回 409。

称呼底层复用保留的 Workspace Memory revision/provenance/audit/outbox，但不属于
通用 Memory API：`happyclaw.owner.preferred_address` 不能通过通用接口创建、更新或
忘记，也不会出现在通用读取、搜索、versions 或 Runtime snapshot 中。

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
- `GET|PUT /api/config/host-integration`，仅 admin；包含
  `adminHostOnlyMode`。从 `false` 切到 `true` 时会停稳管理员工作区运行器，并把
  active admin 拥有的工作区和定时任务持久迁移为 Host；普通成员数据不变
- `GET /api/config/external-resources`
- `GET /api/config/external-resources/rule`
- `GET|PUT /api/config/registration`
- `GET|PUT /api/config/appearance`
- `GET /api/config/appearance/public`，Public
- `POST|DELETE /api/config/appearance/avatar`
- `POST|DELETE /api/config/appearance/brand-icon`，仅 admin
- `POST|DELETE /api/config/appearance/brand-banner`，仅 admin
- `GET /api/config/brand-assets/:filename`，Public；只接受服务端生成的品牌资源文件名

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

任务定义不设置每用户数量配额。`prompt` 与 `script_command` 有长度上限，AI 输入
和解析结果、REST 与 MCP `schedule_task` / `update_task` 使用同一组上限，超出即
拒绝。

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

## Workspace Memory v2

Workspace Memory 是 Workspace 范围内、跨 Session 复用的结构化知识。客户端必须先从
`GET /api/workspaces` 的 `workspaces[].jid` 取得 Workspace JID，再把它作为
`:workspaceJid`；不能使用 `folder` 代替。路径参数需要 URL 编码。

### 读取与搜索

- `GET /api/memory/workspaces/:workspaceJid/items`
  - Query：`status`、`kind`、`limit=1..100`、`cursor` 均可选。
  - 返回 `{ storeRevision, items, nextCursor }`。
- `GET /api/memory/workspaces/:workspaceJid/items/search`
  - Query：必填 `q`，可选 `kind`、`limit=1..100`。
  - 返回 `{ storeRevision, hits: [{ item, rank, snippet }] }`。
- `GET /api/memory/workspaces/:workspaceJid/items/:itemId`
  - 返回 `{ storeRevision, item }`。
- `GET /api/memory/workspaces/:workspaceJid/items/:itemId/versions`
  - Query：可选 `limit=1..100`、`cursor`。
  - 返回 `{ storeRevision, itemId, versions, nextCursor }`，按 revision
    从新到旧排列。

`kind` 为 `fact | decision | lesson | open_loop`。`status` 为
`active | proposed | conflicted | superseded | deleted`。Memory item 的主要字段：

```json
{
  "id": "mem_...",
  "workspaceJid": "web:...",
  "kind": "decision",
  "title": "采用 SQLite",
  "content": "Workspace Memory 以 SQLite 为唯一真相源。",
  "canonicalKey": "memory-store",
  "status": "active",
  "importance": 0.9,
  "confidence": 1,
  "validFrom": null,
  "validUntil": null,
  "expiresAt": null,
  "revision": 2,
  "createdAt": "2026-07-28T08:00:00.000Z",
  "updatedAt": "2026-07-28T09:00:00.000Z",
  "deletedAt": null,
  "provenance": {
    "sourceType": "web_user",
    "sourceId": null,
    "sessionId": "session-id",
    "observedAt": "2026-07-28T08:30:00.000Z"
  }
}
```

Version 还包含 `changeType: create | update | forget` 和
`actor: { type, id }`，用于展示修订来源；历史版本不可通过 API 原地修改。

### 创建、编辑与忘记

- `POST /api/memory/workspaces/:workspaceJid/items`
- `PATCH /api/memory/workspaces/:workspaceJid/items/:itemId`
- `DELETE /api/memory/workspaces/:workspaceJid/items/:itemId`

创建请求必须包含 `kind` 和非空 `content`，可以包含 `title`、`canonicalKey`、
`status`、`importance`、`confidence`、有效期字段、`provenance` 和
`idempotencyKey`。Web 客户端不能提交 `sourceType` 或 writer 身份；服务端根据认证
上下文生成它们。示例：

```json
{
  "kind": "lesson",
  "title": "迁移前先验证备份",
  "content": "恢复演练通过后再切换生产数据。",
  "importance": 0.8,
  "provenance": {
    "sessionId": "session-id",
    "observedAt": "2026-07-28T08:30:00.000Z"
  },
  "idempotencyKey": "client-generated-stable-key"
}
```

PATCH 至少包含一个可修改的 Memory 字段，并必须携带当前
`expectedRevision`。DELETE 表示“忘记”：写入 tombstone/修订历史，而不是删除来源
Session；请求体必须包含 `expectedRevision`，可选 `reason`、`provenance` 和
`idempotencyKey`。

```json
{
  "expectedRevision": 2,
  "reason": "Outdated product decision",
  "provenance": {
    "observedAt": "2026-07-28T10:00:00.000Z"
  }
}
```

POST、PATCH 和 DELETE 均返回
`{ storeRevision, item, replayed }`；GET item 返回相同 wrapper，但不含
`replayed`。`replayed` 表示服务端按相同 idempotency key 返回了已有写入结果。

并发编辑使用 compare-and-set。`expectedRevision` 过期时返回：

```json
{
  "error": "revision_conflict",
  "currentRevision": 3,
  "storeRevision": 9
}
```

客户端必须保留用户草稿并让用户显式加载最新版，不能盲目重试覆盖。相同
idempotency key 被不同请求复用时返回 409 `idempotency_conflict`。校验失败返回
400；无权访问和不存在统一返回 404，避免泄露 Workspace 是否存在。

旧的 `/api/memory/sources`、`/api/memory/search`、`/api/memory/file` 和
`/api/memory/global` 已退役并返回 410。旧文件只保留用于显式离线导出/迁移，
Web 和 Runtime 不再把它们当作第二个可写真相源。

完整产品边界与交互约定见
[Workspace Memory v2](workspace-memory-v2.md)。

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
- `POST /api/docker/pull`

Agent 镜像只由 `main` 分支的 GitHub Actions 构建并发布。该接口仅在运行主机上执行
`docker pull` 更新已发布镜像，不在用户机器上编译镜像。

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
- `docker_pull_log`
- `docker_pull_complete`

精确联合类型和字段以 `src/web.ts`、`src/types.ts` 与 `shared/stream-event.ts` 为准。
