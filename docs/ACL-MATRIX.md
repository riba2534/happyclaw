# HappyClaw 权限矩阵

本文档描述当前授权边界。具体中间件和条件分支以代码为准：

- Cookie 与 Permission Middleware：`src/web-context.ts`
- 资源级工作区判断：`canAccessGroup()`、`canModifyGroup()`、`canDeleteGroup()`
- IM Owner 命令：`src/im-command-utils.ts`
- 渠道响应对象：`src/im-audience-policy.ts`
- 路由实现：`src/routes/` 与 `src/web.ts`

## 1. 权限层次

| 层次     | 代码入口                     | 含义                                   |
| -------- | ---------------------------- | -------------------------------------- |
| Public   | 无 `authMiddleware`          | 无需登录                               |
| Login    | `authMiddleware`             | 有效登录 Session                       |
| Access   | `canAccessGroup`             | 当前用户可以查看和使用工作区           |
| Modify   | `canModifyGroup`             | 当前用户是工作区 owner                 |
| Delete   | `canDeleteGroup`             | 当前用户是 owner 且不是 Home Workspace |
| Host     | `hasHostExecutionPermission` | admin 角色                             |
| System   | `systemConfigMiddleware`     | `manage_system_config`                 |
| Users    | `usersManageMiddleware`      | `manage_users`                         |
| Invites  | `inviteManageMiddleware`     | `manage_invites`                       |
| Audit    | `auditViewMiddleware`        | `view_audit_log`                       |
| Billing  | Billing Middleware           | `manage_billing`                       |
| IM Owner | `owner_im_id` 比对           | 当前渠道原生 sender 是记录的主人       |
| View     | `canViewGroup`               | Access，或访客持有该工作区的有效授权   |

核心原则：

- admin 不自动绕过工作区所有权。Home、Web Workspace 和 IM Chat 均按
  `created_by` 隔离。
- Host 是额外边界：有工作区权限不代表可以执行 Host 操作。
- 非 owner 的用户即使拥有系统级 Permission，也不能读取或修改其他用户工作区中的
  Secret、环境变量和运行能力。
- 查不到资源和无权访问资源通常都返回 `404`，避免跨用户枚举。

## 2. Public 接口

| 路由                                 | 方法 | 附加条件               |
| ------------------------------------ | ---- | ---------------------- |
| `/api/auth/status`                   | GET  | 无                     |
| `/api/auth/setup`                    | POST | 仅用户表为空           |
| `/api/auth/login`                    | POST | 登录限流               |
| `/api/auth/register/status`          | GET  | 无                     |
| `/api/auth/register`                 | POST | 注册策略、邀请码、限流 |
| `/api/auth/avatars/:filename`        | GET  | 仅允许受管头像路径     |
| `/api/config/appearance/public`      | GET  | 只返回公开外观         |
| `/api/config/brand-assets/:filename` | GET  | 仅允许受管品牌资源名   |
| `/api/health`                        | GET  | 不返回敏感运行详情     |

`/ws` 不是 Public。Upgrade 时必须同时通过 Cookie Session 与 Origin 校验。

内嵌 ChatGPT/Codex 网关 `/gateway/chatgpt/v1/messages`（含 `/count_tokens`）不使用
Cookie Session，也不是 Public：只接受当前存活 Runner 或宿主机一次性查询的临时网关
token（Runner/查询退出即吊销），并拒绝带 `Forwarded`、`X-Forwarded-*`、`X-Real-IP`
或来自非回环、非私网地址的请求。Provider 落盘的网关标识不是可用凭据。

## 3. 当前用户资源

以下资源以登录用户 ID 为作用域，不接受客户端指定其他 owner：

| 路由族                                              | 权限                                          |
| --------------------------------------------------- | --------------------------------------------- |
| `/api/auth/me`、profile、password、sessions、avatar | Login，仅本人                                 |
| `/api/agent-profiles/*`                             | Login，仅本人 Agent                           |
| `/api/channel-accounts/*`                           | Login，仅本人渠道账号                         |
| `/api/skills/*`                                     | Login，仅本人用户 Skills                      |
| 用户级 `/api/mcp-servers/*`                         | Login，仅本人配置                             |
| Workspace Memory v2                                 | Login + Workspace owner ACL，见 4.5           |
| HappyClaw Owner Profile                             | Home actual owner + runtime exact-turn gate   |
| `/api/usage/*`                                      | Login；普通用户只见本人，管理视图再按角色过滤 |
| `/api/billing/my/*`                                 | Login，仅本人                                 |

产品级 Agent 删除前必须先迁移其工作区（`migrate-and-delete` 一次性迁移并归档，
目标也必须是本人的 active Agent）。复制、导入不授予宿主机资源：非 admin 得到的
Agent 不含宿主机上下文与宿主机 Skills。渠道账号删除、登出或断开时必须清理/更新
自身连接和绑定，不能影响其他用户或其他账号。飞书扫码建应用的注册
（`/api/channel-accounts/feishu/registrations/*`）同样只对发起者可见，他人读取或
取消返回 404，成功后只为发起者建号。

## 4. 工作区 ACL

### 4.1 Access

`canAccessGroup()` 对所有角色使用同一规则：

- Home Workspace：仅 `created_by`。
- Web Workspace：仅创建者。
- IM Chat：优先使用自身 `created_by`；旧记录没有 owner 时，只允许通过同 folder
  的 Home Workspace 解析 owner；解析失败默认拒绝。

需要 Access 的典型操作：

- 列表中的工作区投影
- 读取消息与文件，以及回合的思考摘要与执行轨迹
  （`GET /api/groups/:jid/turn-traces/:turnId`，主动模式工作区另按下述过程可见性过滤）
- 查看会话当前使用的模型配置与上下文占用（`GET /api/groups/:jid/context-usage`）
- 发送普通消息
- 查看 Runtime Session、绑定和项目能力
- 读取代码改动（`GET /api/groups/:jid/git/status|diff`）、worktree 可用性和同目录
  运行提示（`workdir/peers`，看不到的工作区只计数不具名）
- 打开 Web 终端前的资源检查

Home 的 AgentProfile 归属也是系统不变量：只能绑定同一 owner 的 `is_default`
HappyClaw。路由在进入 Runtime quiesce 前拒绝迁移，数据库绑定函数再次校验；启动
backfill 会修复旧数据中的错误 Home 绑定。

Host Workspace 在 Access 之外还要求 admin。

### 4.2 Modify

`canModifyGroup()` 是 owner-only。需要 Modify 的典型操作：

- 重命名、切换 Agent、修改执行方式
- 修改回复模式与过程可见性（`PATCH /api/groups/:jid` 的 `interaction_mode`、
  `process_visibility`，仅 `web:` 工作区；后者不重启运行时）
- stop、interrupt、reset-session、clear-history
- 切换会话模型与推理档位（`PUT /api/groups/:jid/model-selection`）；其中高于 `max` 的
  推理档位（目前是 `ultra`）另需 `manage_system_config`
- 创建、修改、删除 Runtime Session
- 为新会话创建独立 worktree（另需 Host 权限）；删除会话、工作区或 clear-history 时
  移除 worktree、保留分支，有未提交改动须带 `force_worktree(s)=true` 确认
- 写入工作区 Skills/MCP
- 修改群聊绑定、激活方式、响应对象和 owner
- `/clear`、`/fresh` 的 HTTP 与 WebSocket 分支

Pin 是当前用户自己的偏好，只要求 Access，不修改共享工作区状态。

### 4.3 Delete

Home Workspace 永远不可删除。其他工作区必须通过 Modify，删除过程会：

1. 暂停相关序列化键。
2. 停止工作区、Runtime Session 和虚拟任务 Runner。
3. 删除数据库、文件和绑定状态。
4. 仅在提交成功后丢弃被暂停的旧工作；失败则恢复。

自定义 AgentProfile 创建后默认不拥有 Workspace，因此也没有可访问的 Session 或
Workspace Memory。只有 owner 显式新建/迁移非 Home Workspace 才建立归属；迁移时
Memory 随 Workspace 保留，不跨 Workspace 复制。

### 4.3.1 过程可见性与回合轨迹

主动模式工作区的 `process_visibility` 同时约束实时广播和已存轨迹：

| 级别       | 实时 WebSocket 过程事件     | `turn-traces` 与 `has_trace`                              |
| ---------- | --------------------------- | --------------------------------------------------------- |
| `hidden`   | 运行生命周期与进展          | 只有进展步骤；没有进展的回合 404，其消息不带 `has_trace`  |
| `activity` | 再加工具、任务、todo 等结构 | 可读，`thinking` 为空，`steps` 中的思考步骤没有文本与标题 |
| `full`     | 再加推理摘要与过程说明      | 完整                                                      |

模型自己产出的文字（`text_delta`、工具结果文本、子 Agent 的提示词与回答）在任何级别
都不会广播，也不会写入轨迹。例外有两个。一是进展：Web 回合里 Agent 用
`send_message(delivery_role=progress)` 发给用户的话，作为带 `progress` 的
`commentary` 在每个级别广播并写入轨迹（IM 回合的进展是一条独立消息，不经过这里）。
二是 `full` 级别的过程说明（不带 `progress` 的 `commentary`）：主 Agent 在调用工具前
写下的那段话，仅在确有工具调用跟在后面时才由宿主放行，只广播给 Web、不写入轨迹；回合
结尾的文字、未发送的回复和紧接着 `send_message` 调用的文字不放行（宿主逐个调用判断，
不向前看，详见 `docs/API.md`）。
工具结果事件上的 `toolIsError`（SDK 的 `is_error`，布尔）在任何级别都放行；
`toolResultFacts`（工具做了什么的数字，如增删行数）只在 Assistant 模式下发，主动模式在
任何级别都剥掉。

过滤读取**当前**级别和**当前**模式，而不是回合运行时的：一个回合可能按 Assistant 契约
记录（工作区当时还是 Assistant 模式，或渠道挂载的 `interaction_mode_override` 为
`assistant` 的消息由 Assistant Runner 处理），之后在主动模式工作区里读取。所以主动模式
工作区读取 `turn-traces` 时，无论回合怎么记录，`steps` 都不含进展以外的 text 步骤、发言
工具 `send_message` 的步骤，tool/task 步骤也都没有 `resultPreview`（工具输出、子 Agent
的回答、权限拒绝的原因；工作区记忆写入工具的回执除外）和 `resultFacts`，只留下调用的
输入摘要和成败状态；`trace` 里“工具结果”“Task 启动”两类行没有 `detail`（工具输出、
子 Agent 的提示词）。Assistant
模式工作区与 fire-and-forget 的 Spawn Agent 不受该设置影响。轨迹的读取权限与消息
列表相同：只有能读取该聊天历史的用户可读；admin 没有跨 owner bypass，无权限与不存在
都返回 404。

### 4.4 环境变量

`GET|PUT /api/groups/:jid/env`：

- 必须 Access。
- Host Workspace 必须 admin。
- 非 admin 必须同时是 owner 且拥有 `manage_group_env`。
- admin 仍需先通过工作区 Access，不能借 admin 角色读取其他用户工作区。

### 4.5 Workspace Memory v2

`/api/memory/workspaces/:workspaceJid/items*` 先要求 Login，再按 URL 中的
Workspace JID 执行资源级授权：

| 操作                             | 权限                                               |
| -------------------------------- | -------------------------------------------------- |
| GET 列表、搜索、详情、versions   | `canAccessGroup()`，当前用户必须是 Workspace owner |
| POST、PATCH、DELETE              | `canModifyGroup()`，当前用户必须是 Workspace owner |
| POST `.../confirm`、`.../reject` | `canModifyGroup()`，当前用户必须是 Workspace owner |

admin 没有跨 owner bypass。目标 Workspace/item 不存在或授权失败均返回 404，不能据此
枚举其他用户的 Workspace 或 Memory。客户端必须使用 `/api/workspaces` 返回的 JID，
不能用 `folder` 绕过资源解析。

Agent Runtime 的 Workspace Memory MCP 还叠加执行上下文策略：

| 执行上下文                                          | 读取 | 创建、更新、忘记                      |
| --------------------------------------------------- | ---- | ------------------------------------- |
| 顶层 Main/Runtime Session，批次全部是 owner 输入    | 允许 | 按 Workspace ACL                      |
| 同上，批次是 owner 与委托对象的输入（至少一条委托） | 允许 | 直接写入，provenance `delegate:<jid>` |
| 顶层 Main/Runtime Session，含非 owner 输入          | 允许 | 只能创建/修改/忘记 `proposed` 条目    |
| 自动化运行的轮次                                    | 允许 | 只能创建/修改/忘记 `proposed` 条目    |
| Spawn/Task 会话、SDK Task Sub-Agent                 | 允许 | 拒绝                                  |

owner 输入的判定在宿主：Web 输入的 sender 等于 owner 用户 id；IM 输入的发送者 IM id
必须等于该工作区注册中由宿主记录的 owner（claim source 为 `configured`、
`trusted_direct` 或 `auto_feishu`）。委托对象的输入：来源私聊的会话绑定打开了
`delegate_enabled`、绑定指向本工作区与本会话且属于同一 owner，发送者等于从私聊 JID
推出的对方 id，且工作区不是 Host 模式（`src/workspace-delegate-auth.ts`）。写入一律要求 Runner 的 HMAC 写能力；proposed
只有 owner 在 Web 确认后才生效。Sub-Agent 的只读限制由 PreToolUse hook 与主进程
IPC broker 共同执行，不能由模型参数扩大权限。

### 4.6 HappyClaw Owner Profile

`GET|PATCH /api/workspaces/:jid/owner-profile` 只接受当前登录用户自己的 Home
Workspace，且目标必须绑定内置默认 HappyClaw。admin 不具有跨 owner bypass。

Runtime 的权限更严格：

| 上下文                                       | 投影                | 修改                  |
| -------------------------------------------- | ------------------- | --------------------- |
| Home 内置 HappyClaw + actual owner turn      | 允许                | 当前 active turn 允许 |
| Home 内置 HappyClaw + 非 owner 群成员 turn   | 拒绝                | 拒绝                  |
| Home 内置 HappyClaw 普通 Runtime Session     | actual owner 时允许 | 当前 active turn 允许 |
| 自定义 AgentProfile / Scheduled / Task/Spawn | 拒绝                | 拒绝                  |
| SDK Sub-Agent                                | 拒绝                | 拒绝                  |

read-only 投影按 host-issued turn ID 精确匹配当前或已接纳的 queued batch；queued owner
身份不能为其他 turn 授权。set/clear/skip 必须匹配当前 active batch。Web sender 必须
等于内部 owner user ID；IM sender 还必须通过强 owner claim 与 provider 原生 ID
规范化比对。称呼和 onboarding 状态不会注入非 owner turn。

旧 `/api/memory/sources`、`/api/memory/search`、`/api/memory/file` 和
`/api/memory/global` 只要求有效登录，但无论角色均返回 410；它们不提供旧文件读取
或兼容写入能力。

## 5. 工作区与 Session 渠道绑定

写操作统一要求目标工作区 Modify，同时校验 IM Chat 属于同一用户、同一渠道账号，
并验证会话类型：

| 绑定                  | 允许目标 | 路由                                              |
| --------------------- | -------- | ------------------------------------------------- |
| Workspace Mount       | 群聊     | `/api/groups/:jid/im-binding`                     |
| Runtime Session Mount | 私聊     | `/api/groups/:jid/sessions/:sessionId/im-binding` |
| `/agents` 兼容 Mount  | 私聊     | `/api/groups/:jid/agents/:agentId/im-binding`     |

附加规则：

- `channel_account_id` 必须属于当前用户。
- 账号编码在 JID 中时，必须与数据库记录一致。
- 原生话题容器使用 `thread_map`，不能绑定到一个固定 Session 后吞并所有话题。
- 「允许对方管理此工作区」（`PUT /api/workspaces/:jid/channel-mounts/:channelJid/delegate`）
  只由工作区 owner 切换，只接受 Docker 工作区上私聊的会话绑定（飞书私聊不支持，Host
  工作区 400）；访客与其他用户一律 404，换绑或切到 Host 时清除。
- Unbind 必须原子恢复该 Bot 的默认工作区；无法解析默认目标时保留旧绑定并报错。

## 6. 系统和管理权限

| 路由族/操作                                       | 权限                                               |
| ------------------------------------------------- | -------------------------------------------------- |
| Provider、系统容量、Host 集成、注册策略、系统外观 | `manage_system_config`                             |
| Plugin Catalog 手动扫描                           | admin / `manage_system_config` 路径中的 admin 检查 |
| 系统 MCP 写入                                     | admin                                              |
| 用户创建、禁用、恢复、角色与权限                  | `manage_users`                                     |
| 邀请码                                            | `manage_invites`                                   |
| 审计日志和导出                                    | `view_audit_log`                                   |
| `/api/billing/admin/*`                            | `manage_billing`                                   |
| `/api/docker/pull`、运行监控管理                  | `manage_system_config`                             |
| `/api/status/channel-outbox/*` 人工裁决           | `manage_system_config`                             |
| 系统外观读写（`GET/PUT /api/config/appearance`）  | `manage_system_config`                             |
| 品牌资源上传/删除（图标、横幅头像文件写入）       | admin（`adminRoleMiddleware`）                     |
| `POST /api/groups/:jid/reset-owner`               | admin break-glass，同时仍验证目标资源              |

系统 MCP 默认仅 admin 可用；只有显式设置为 shared 后，普通成员的 Agent 才能进入
有效能力清单。API 不回传 Secret 明文。

模型连接只由 `manage_system_config` 管理，没有个人连接：增改删、凭据、
`POST /api/config/claude/providers/test`、`POST /api/config/claude/providers/discover-models`
和 `GET /api/config/claude/providers/:id/impact` 都在该权限下。测试与获取模型列表共用每个
用户每分钟 10 次的上游请求限额；草稿里的凭据只用于这一次请求，不落盘，上游错误摘录脱敏后
返回，日志只记上游 origin。普通成员通过会话模型选择和智能体绑定使用已有连接，看不到凭据。

## 7. WebSocket

连接建立时把认证用户 ID、角色和 Permission 固定到 Session；每个操作仍重新检查
目标资源。

| 操作                                   | 权限                               |
| -------------------------------------- | ---------------------------------- |
| `send_message`                         | Access；Host 再加 Host             |
| `send_message` 中的 `/clear`、`/fresh` | Modify；Host 再加 Host             |
| Runtime Session 消息                   | Access + Session 属于该 Workspace  |
| `terminal_start`                       | Access；只支持 Container Workspace |
| `terminal_input` / resize / stop       | 必须是当前 WebSocket 已拥有的终端  |
| Docker Build 流                        | 对应系统管理权限                   |

不能仅依赖 `terminal_start` 的历史授权；终端 owner 映射和连接关闭清理是协议的一部分。

## 8. IM 响应对象与激活

渠道消息先执行响应对象检查，再执行 @/话题激活：

| 策略                             | 行为                             |
| -------------------------------- | -------------------------------- |
| `audience_mode=everyone`         | 所有允许成员可以触发             |
| `audience_mode=owner_only`       | 只有 `owner_im_id` 可以触发      |
| `activation_mode=always`         | 无需 @                           |
| `activation_mode=when_mentioned` | 需要首次 @，原生话题激活后可继续 |
| `activation_mode=disabled`       | DM 和群聊都停止响应              |

响应对象和激活方式是独立维度。Legacy `owner_mentioned` 读取时会规范化为
`audience_mode=owner_only + activation_mode=when_mentioned`。

Owner Claim：

- 可信的 1:1 私聊可以从第一条持久化人类消息学习 owner。
- 未认领群聊不会让“第一个发命令的人”自动成为 owner。
- 群聊用 `/owner_mention` 显式认领。
- `/release_owner` 清除 owner 与 allowlist，并把 legacy `owner_mentioned` 降级。
- admin 的 `reset-owner` 是 owner 离群/换号后的 break-glass。

## 9. IM 命令

命令由主进程 `handleCommand()` 处理，不经过 Web Middleware，但使用渠道 sender ID
执行独立 Owner Gate。

| 命令                                           | 权限                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `/status`、`/where`                            | 只读，只描述本聊天自己的绑定                                                  |
| `/list`、`/ls`                                 | 私聊只读；群聊仅 IM Owner（列出 owner 全部工作区和会话）                      |
| `/recall`、`/rc`                               | 私聊只读；群聊仅 IM Owner；带节流；只读取本条消息路由到的 Session             |
| `/allowlist`                                   | 只读                                                                          |
| `/clear`、`/fresh`、`/bind`、`/unbind`、`/new` | IM Owner                                                                      |
| `/sw`、`/spawn`                                | IM Owner                                                                      |
| `/release_owner`                               | IM Owner                                                                      |
| `/owner_mention`                               | 未认领群的 bootstrap，不可被 Owner Gate 锁死                                  |
| `/allow`、`/disallow`                          | Handler 内检查 IM Owner                                                       |
| `/require_mention`                             | Handler 内按当前 owner/策略检查                                               |
| `/steer <消息>`、`/break`（全部 IM 渠道）      | 群聊必须有渠道结构证明的真实 @Bot，并通过当前 audience/激活策略；不要求 owner |
| 飞书 `/clear`、`/fresh [备注]`（运行时控制）   | 群聊必须结构化真实 @Bot 且为 IM Owner（与斜杠 `/clear`、`/fresh` 同一边界）   |
| MCP `fresh_window`                             | 当前会话 Agent 可调用；不走斜杠 owner gate                                    |

飞书群聊中由 `handleCommand()` 处理的通用斜杠命令同样必须结构化真实 @Bot，并通过 audience
检查；它们不受激活闸门（`activation_mode`、`when_mentioned`、`disabled`）约束，
`/require_mention`、`/owner_mention` 还豁免激活与 owner 认领阻断，保证 IM 侧可以
恢复。群里不带 @Bot 的斜杠文本按普通消息处理。

群聊判定：飞书 JID 不编码会话类型。优先采用连接器随消息传入的 `chatType`，首次
收到私聊时持久化 `feishu_chat_mode=p2p`；否则按持久化的 `feishu_chat_mode` 判断，
未知时按群聊处理（fail closed）。私聊中的 owner-required 命令在 owner 未知时认领
发送者；群聊永不自动认领。运行时控制在群聊路由失败时回复目标不存在，只有私聊才由
绑定解析目标，绝不回退到 Workspace 主会话。`/recall` 在话题群中只读取当前话题的
Session，缺少话题元数据时拒绝，不回退到 Workspace 主会话。

不同 Provider 的原生 sender ID namespace 不得混用。例如 QQ C2C 与 Group 使用不同
ID 空间；owner 比对必须使用渠道适配器传入的规范化 ID。

## 10. MCP 与 Agent 侧操作

Agent MCP 调用没有 Cookie，但必须携带由主进程创建的运行上下文：

- `ownerUserId`
- Workspace/Session 身份
- IPC 目录
- 当前 `ChannelTurnContext`
- Agent Profile 和能力 Manifest

消息、图片和文件工具必须限制在授权的 Session 或当前 Turn 路由。跨工作区操作必须
经过主进程 owner 检查；不能根据 Agent 文本参数自行扩大范围。

自动化：

- 每次运行都是真实会话里的一轮：绑定已有会话（默认当前会话）、每次新建或持续会话。
- 脚本和前置检查仅允许 admin 的 Host Workspace。
- `adminHostOnlyMode` 仅允许 admin 配置；开启后 active admin 拥有的 Workspace
  强制使用 Host，所有 Container 写入入口都会拒绝。member 始终保留 Container 隔离。

自动化的 Agent 工具（`automation_*`）不接收任何 JID。主进程从 IPC 目录和正在执行的
批次推出调用者（`src/automation-runtime.ts` 的 `deriveAutomationActor`），**admin
不提供全局旁路**：

- 批次是某次自动化运行的输入：只能暂停、完成、删除、通知或静默它自己的自动化。
- 批次完全来自工作区主人（与 `install_skill` 同一条主人轮次规则）：可以创建和修改，
  新建的自动化绑定当前会话和这条输入的来源路由（例如飞书话题）。
- 批次全部来自主人或主人在私聊绑定上指定的委托对象（至少一条委托）：`delegate_turn`，
  可列出、创建、修改、暂停、恢复、删除、立即运行本工作区的自动化；新建的归属主人。
  不能设置或修改脚本与前置检查，不能操作带有它们的自动化，Host 工作区一律拒绝。
  安装 Skill、Agent Builder、Owner Profile 不接受委托对象。
- 其他轮次（群成员、混合批次）只能列出。
- 旧的 `schedule_task` 等请求一律返回错误，提示改用自动化工具。

## 11. 访客（只读）

访客（`role=guest`）属于一个 owner（`users.guest_owner_id`），只能查看 owner 在
`guest_workspace_grants` 中授权的、owner 自己的工作区。owner 必须 active，并且能持有
访客（`canOwnGuests`）：admin 总是可以，member 只在系统设置 `allowMemberGuests`
开启时可以（默认关闭）。每个 owner 最多 20 个未删除的访客。实现见
`src/guest-access.ts` 与 `src/middleware/guest-guard.ts`。

- `canAccessGroup`、`canModifyGroup`、`canDeleteGroup` 对访客永远为 false，语义
  不变。读取路径单独使用 `canViewGroup` = Access ∨ 有效授权。有效授权要求：授权行
  存在；访客 active；owner active 且能持有访客；工作区 `created_by` 仍是授权 owner。
  IM 行与 `#agent:` 虚拟 JID 先解析到所属 `web:*` 工作区再判断。
- 全局 Guard 挂在 `/api/*` 所有路由之前（`authMiddleware` 再查一次）：访客请求只放行
  `GUEST_ROUTE_ALLOWLIST` 中的 (方法, 路径)，其余一律 403
  `Guest accounts are read-only`，新路由默认拒绝。每次访客请求都重新读取 owner
  状态，owner 被禁用/删除或 `allowMemberGuests` 关闭（member owner）后立即 403，
  登录也失败；owner 被禁用/删除时同时注销其访客的会话。
- 放行清单：Public 登录相关接口、`GET /api/auth/me`、`POST /api/auth/logout`、
  `PUT /api/auth/password`、`GET/DELETE /api/auth/sessions[/:id]`；
  `GET /api/groups`、`GET /api/groups/:jid/{messages,agents,sessions}`、消息附件原图、
  `GET /api/groups/:jid/turn-traces/:turnId`、`GET /api/follow-ups`、
  `GET /api/workspaces[/:jid]`；`GET /api/groups/:jid/files` 与
  `files/{download,preview,content}/:path`；Workspace Memory 的列表、搜索、条目和版本；
  `GET /api/automations[/:id[/runs]]`。放行的处理器仍按 `canViewGroup` 判断，
  未授权返回 404。
- 有意不放行的读取：`/api/groups/:jid/git/*`（diff 可能包含被隐藏的点文件）、
  `workdir/peers`（其他工作区的运行）、`model-selection`（owner 的模型连接）、
  `context-usage`（token 用量，只服务于输入框）、`env`、`mcp`、`im-groups`、
  `delete-impact`、工作区的渠道与运行会话挂载、`/api/automations/for-session`、
  `/api/status*`、用量与计费。
- Host：访客对已授权的 Host 工作区（典型是 admin Home）只有读取例外
  （`canViewHostGroup`）；所有执行路径仍要求 admin。Host 工作区的授权只在 owner
  当前仍是 active 的 admin 时有效（条件写在统一的授权 SQL 里，REST、文件和广播共用），
  owner 被降为 member 后立即失效。
- 文件：访客看不到、也无法列出或读取任意层级中以 `.` 开头的条目（`.git`、`.ssh`、
  `.aws`、`.env*`、`.npmrc`、`.claude` 等）、`*.pem`/`*.key`/`*.p12`/`*.pfx`/
  `*.keystore`、`id_rsa*`/`id_dsa*`/`id_ecdsa*`/`id_ed25519*`、`credentials.json`，
  以及 `logs`、`conversations`。名称比较不区分大小写；符号链接按真实路径判断，
  指向文件根之外的一律隐藏；文件根随 `?agentId=` 解析（独立 worktree 会话为其
  worktree）。列表不返回绝对路径。owner 不受影响。
- 自动化：访客在服务里是 `viewer` 调用者，只列出已授权工作区的自动化及其运行记录，
  前置检查命令、脚本命令和前置检查输出一律去掉（REST 与 WebSocket 相同）；所有写
  操作（包括标记已读）403。
- Memory：读取用 `canViewGroup`，写入仍是 Modify。
- WebSocket：访客连接只接收。除 `ping`（回 `pong`）外，任何入站消息（`send_message`、
  `terminal_*` 及未来类型）都在分发前以 `ws_error` 拒绝。广播受众
  （`getGroupAllowedUserIds`）包含持有有效授权的访客，包括 Host 工作区事件、流式思考
  与工具调用、重连快照和自动化事件；访客看到的过程信息与 owner 相同。REST 不给访客
  的数据在广播里也不给：`context_usage` 只发 owner，流式 `usage` 事件（token 与
  费用）不发访客，`new_message` 去掉 `token_usage`/`cost_usd`，`agent_status` 去掉
  `worktree`；REST 的消息历史与会话列表同样去掉这些字段。
- 访客没有 Home、Agent Profile、钱包或订阅；计费管理不能给访客分配套餐或调整余额。
  访客不能创建工作区、会话、自动化、Skills、MCP、Plugins、渠道账号或访客，访客没有
  能触发的轮次，因此也不会写 Workspace Memory。
- 管理员用户管理能禁用、删除、重置访客，但不能把访客改成其他角色或反之；邀请码和
  注册不会产生访客。被用户管理禁用的访客（`disable_reason` 不是
  `disabled_by_owner`），owner 只能查看和删除，`PATCH /api/guests/:id` 返回 403。删除工作区会删除其授权；删除访客会删除授权与置顶。

## 12. 修改 ACL 的验证要求

任何 ACL 修改至少补充以下测试维度：

1. owner 成功。
2. 非 owner 被拒绝。
3. admin 是否应该绕过必须显式测试；默认不绕过。
4. Host/Container 分支。
5. 资源不存在与跨用户资源的返回值。
6. 多渠道账号不能串用凭据或绑定。
7. HTTP、WebSocket、IM、MCP 的同一动作保持一致。
8. 失败路径不留下半写绑定、陈旧 Runner 或已推进游标。

相关现有测试集中在：

- `tests/routes-*-acl.test.ts`
- `tests/owner-gate.test.ts`
- `tests/im-owner-gate.test.ts`
- `tests/im-audience-policy.test.ts`
- `tests/channel-binding-rest-contract.test.ts`
- `tests/channel-account-*.test.ts`
- `tests/mcp-runtime-secret-boundary.test.ts`
- `tests/host-execution-policy.test.ts`
