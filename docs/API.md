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
| `/api/groups`                      | `src/routes/turn-traces.ts`      | 回合的思考摘要与执行轨迹      |
| `/api/groups`                      | `src/routes/workspace-config.ts` | 项目 Skills/MCP               |
| `/api/groups`                      | `src/routes/git-review.ts`       | 代码改动与会话 worktree       |
| `/api/workspaces`                  | `src/routes/workspaces.ts`       | Agent-first 工作区投影        |
| `/api/agent-profiles`              | `src/routes/agent-profiles.ts`   | 产品级 Agent                  |
| `/api/channel-accounts`            | `src/routes/channel-accounts.ts` | 多渠道账号                    |
| `/api/config`                      | `src/routes/config.ts`           | Provider、系统与兼容渠道配置  |
| `/api/config`                      | `src/routes/brand-assets.ts`     | 品牌资源上传、删除与公开读取  |
| `/api/automations`                 | `src/routes/automations.ts`      | 自动化和运行记录              |
| `/api/tasks`                       | `src/routes/tasks.ts`            | 已废弃，一律 410              |
| `/api/memory`                      | `src/routes/memory.ts`           | Workspace Memory v2           |
| `/api/skills`                      | `src/routes/skills.ts`           | 用户 Skills                   |
| `/api/mcp-servers`                 | `src/routes/mcp-servers.ts`      | 用户/系统 MCP                 |
| `/api/plugins`                     | `src/routes/plugins.ts`          | Plugin Catalog 与用户启用状态 |
| `/api/usage`                       | `src/routes/usage.ts`            | Token 用量                    |
| `/api/billing`                     | `src/routes/billing.ts`          | 订阅、余额和计费管理          |
| `/api/admin`                       | `src/routes/admin.ts`            | 用户、邀请和审计              |
| `/api/guests`                      | `src/routes/guests.ts`           | 只读访客账号与工作区授权      |
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

`POST /api/auth/login` 的失败次数按三个桶计数，任一超限返回 429：用户名+IP
（`maxLoginAttempts`/`loginLockoutMinutes`）、用户名（4 倍/1 小时）、客户端 IP
（6 倍/同一窗口，IPv6 按 /64 合并；loopback 与未知地址不计）。客户端 IP 取自
`getClientIp`，部署在反向代理后需设置 `TRUST_PROXY=true`。用户名超过 64 字符直接按无效凭据返回 401。

`POST /api/auth/avatar` 接受 jpg、png、gif、webp（≤3MB），以文件头识别真实格式；
服务端按最长边 256px 缩小（不放大）、按 EXIF 校正方向、去除元数据，统一存为 WebP。
动图缩放后不超过 512KB 时保留动画，否则取首帧。无法解码或超过 4000 万像素的内容返回 400。
每次上传生成新文件名，`GET /api/auth/avatars/:filename` 以 `immutable` 缓存返回；
此前上传的头像按原文件提供，所有者下次上传时才会被替换。

会话 Cookie 在 HTTPS 下名为 `__Host-happyclaw_session`，HTTP 下名为
`happyclaw_session`；每次下发会话都会同时让另一个名称过期。`POST /api/auth/logout`
让两个名称都过期，并删除该请求在两个名称下携带、且属于同一用户的全部会话；
其他设备的会话不受影响。

## 访客账号

active 的 admin 可以为自己创建只读访客（`role=guest`），并授权其查看自己拥有的部分
`web:*` 工作区（含 Home）；member 只有在系统设置 `allowMemberGuests` 开启时可以
创建。所有路由只作用于调用者自己的访客；其他用户的访客和不属于调用者的工作区 JID
一律按不存在处理。访客自身调用这些路由返回 403。

- `GET /api/guests`：`{ guests, grantable_workspaces, can_create, max_guests }`。
  每个访客含 `id`、`username`、`display_name`、`status`（`active`/`disabled`）、
  `created_at`、`last_login_at` 和已授权的 `workspaces[{ jid, name, is_home }]`；
  `grantable_workspaces` 是调用者自己的工作区；`can_create` 表示调用者现在能否新建。
- `POST /api/guests`：`{ username, password, display_name?, workspace_jids[] }`，
  用户名/密码规则与普通账号相同；成功 201 `{ guest }`，工作区无效 400，
  member 未开放 403，已有 `max_guests`（20）个未删除的访客或用户名已存在 409。
- `PATCH /api/guests/:id`：`display_name`、`status`、`workspace_jids`（整体替换）、
  `password` 任选；授权变更对下一次请求立即生效，状态或密码变更同时注销访客的会话。
  被管理员通过用户管理禁用的访客（列表里 `disabled_by_admin: true`）返回 403，
  owner 只能删除它。
- `DELETE /api/guests/:id`：标记删除并清除授权、置顶和会话。

`allowMemberGuests` 关闭后，member 仍可列出、编辑和删除自己的访客，但这些访客无法
登录、请求或接收广播。

访客能看什么、能调用哪些路由见 [ACL 权限矩阵](ACL-MATRIX.md) 的“访客”一节。
管理员用户管理（`/api/admin/users`）能列出、禁用、删除和重置访客（列表带
`guest_owner_username`，支持 `role=guest` 过滤），但不能创建访客或改变访客角色；
邀请码和注册永远不会产生访客。

## 工作区、消息和运行控制

- `GET|POST /api/groups`；`POST` 的响应带 `warnings`，`custom_cwd` 与同一用户的其他
  宿主机工作区目录相同时为
  `[{"code": "shared_custom_cwd", "message": "…", "workspaces": [{"jid", "name"}]}]`，
  不阻止创建
- `PATCH|DELETE /api/groups/:jid`
- `PATCH /api/groups/:jid/agent-profile`
- `POST /api/groups/:jid/stop`
- `POST /api/groups/:jid/interrupt`
- `POST /api/groups/:jid/reset-session`
- `GET|PUT /api/groups/:jid/model-selection`，聊天输入框的会话级模型与推理档位选择
- `GET /api/groups/:jid/context-usage`，会话当前的上下文占用（输入框旁的圆环）
- `POST /api/groups/:jid/clear-history`，重建工作区内容：永久清除聊天、
  Runtime Session、子对话、`data/groups/{folder}` 工作目录、会话 worktree 目录及
  Workspace Memory（含版本历史和 Home Owner Profile）；自动化保留，重建期间暂停，
  排队或运行中的运行记为已终止，绑定已删会话的自动化保持暂停；保留工作区外壳、
  `data/extra/`、自动化运行历史、worktree 分支和宿主机模式的自定义工作目录
- `POST /api/groups/:jid/reset-owner`，admin break-glass
- `GET /api/groups/:jid/messages`
- `GET /api/groups/:jid/turn-traces/:turnId`，已结算回合的思考摘要、执行轨迹与有序步骤
- `DELETE /api/groups/:jid/messages/:messageId`
- `GET /api/groups/:jid/messages/:messageId/attachments/:index/original`
- `GET|PUT /api/groups/:jid/env`
- `GET|PUT /api/groups/:jid/mcp`，仅兼容旧客户端
- `POST /api/messages`
- `GET /api/follow-ups`
- `POST /api/follow-ups/:messageId/action`

当一次运行可用的全部连接都撞了用量上限、且上游给出了重置时刻时，输入不会失败：
该会话（lane）待处理的输入被放回 durable 队列（`delivery_status: 'queued'`，照常可
编辑、排序、取消），在重置时刻后 60 秒加 0–30 秒抖动自动继续。同一会话最多连续等待
3 次、单次不超过 7 天，超出则按原方式失败；新消息、`send_now`（`promote`）立即结束
等待并与排队输入合批，`/break`、取消最后一条排队输入、停止、`/clear`、`/fresh`、删除
工作区或会话取消等待。来源是 IM 的输入在开始等待时收到一条说明（同一输入只发一次）。
自动化的输入与其他输入一样留在队列里等待，运行保持 `queued`。

`model-selection` 以 `agentId`（GET 查询参数、PUT 请求体）区分 Runtime Session，
缺省表示主会话。GET 返回当前选择、默认值的解析来源和全部已保存模型配置（不含凭据）；
`default.source` 按与运行时相同的函数解析，取值 `agent`（智能体自己的绑定）、
`workspace_env`（工作区自带 Provider 环境变量）、`owner_main`（工作区所有者的主智能体）、
`system_main`（系统主 HappyClaw：最早创建的 admin 的主智能体）、`none`；未设置的一步
跳过，已设置但连接已删除或没有凭据时 `default.connectionMissing` 为 true，本轮失败并提示
重新选择（不改用别的连接）；`none` 时同样失败，提示为主 HappyClaw 选择模型。`default.model` 是不选择时实际运行的模型（不带 `[1m]`；
`workspace_env`、`none` 与直通中转为 `null`），`default.effort` 是不选择时运行的推理
等级（该模型不支持档位时为 `null`）。
PUT 的 `modelConfigId` 为 `null` 时恢复默认。会话选择的（配置, 模型）优先于智能体
绑定；切换后该会话的暖 Runner 在当前轮次结束后退出，下一条消息使用新选择。

每个配置都可以在配置内选择具体模型。选项带 `usable`（有凭据才可选）；ChatGPT 订阅以外
的选项带 `models[]`：`id`、`efforts`（可选档位，空数组表示不能选）、`defaultEffort`
（不选档位时运行的档位：智能体显式档位且该模型支持时用它，否则模型默认档位，没有则
`null`）、`contextWindow`（未知为 `null`）、`effortsSource`（`declared` 连接里声明、
`registry` 能力表、`family` 同系列推断、`none`）。全部模型都会列出。直通中转没有默认
模型时 `model` 为空字符串。

ChatGPT 订阅配置（`kind: "codex"`）不带 `models`，而是带 `codex`，并且还能选择推理
档位：`defaultModel`（配置自己的模型）、`defaultEffort`（不选档位时实际使用的档位，
Agent 显式档位优先，其次是配置档位，按模型目录钳制）、`source`（`live` 为该账号自己
的目录，其余为兜底目录）、`needsReauth`，以及
`models[]`（`value`、`label`、`efforts`、`defaultEffort`）。`codex.models` 来自该账号
的实时目录并按套餐过滤，同步读取、后台刷新，不等待网络；`efforts` 按 low 到 ultra
排序，只含当前用户可以选择的档位。

响应顶层另有 `selectedModel` 与 `selectedEffort`（所有类型）：已存的模型若已不在配置
的模型列表（ChatGPT 为账号目录）中，或档位不被所运行的模型（ChatGPT 为目录或当前用户
权限）支持，按未选择返回，与 Runner 启动时的处理一致。

PUT 可以携带 `model`、`effort`，请求整体替换该会话的选择：只写 `modelConfigId`
会清掉之前的模型和档位，换配置也不会继承旧配置的模型。`model` 最长 200 个字符，
必须在所选配置的模型列表内，ChatGPT 订阅则必须在该账号当前目录内；`effort` 必须在
（所选或配置默认的）模型的 `efforts` 内，否则 ChatGPT 以外返回 `EFFORT_NOT_SUPPORTED`；
两者都要同时给出 `modelConfigId`。否则返回 400 与 `code`：
`MODEL_NOT_IN_CONNECTION`、`EFFORT_NOT_SUPPORTED`、`MODEL_UNAVAILABLE`、
`EFFORT_UNSUPPORTED`、`EFFORT_RESTRICTED`、`MODEL_CONFIG_REQUIRED`。推理等级按会话
档位 → 智能体显式档位 → 模型默认档位解析，只取所运行模型支持的档位，不支持档位的
模型不写 `CLAUDE_CODE_EFFORT_LEVEL`；没有默认 `max`。会话档位写入
`CLAUDE_CODE_EFFORT_LEVEL`（Claude Code 让它优先于 Runner 为智能体传的 SDK `effort`），
不改动交给 Runner 的智能体配置。ChatGPT 以外只改档位时退出暖 Runner（下一条消息
重启），但保留 SDK 会话。高于 `max` 的档位（目前是
`ultra`）只允许具备 `manage_system_config` 的用户选择，GET 不列出，PUT 返回
`EFFORT_RESTRICTED`，Runner 启动时若选择者已失去该权限则回到默认档；放宽只需改
`CODEX_SESSION_EFFORT_CEILING`。响应附带 `drained`（被退出的暖 Runner 数）与
`liveUpdated`（被就地改档的存活网关授权数）。

`context-usage` 以 `agentId` 查询参数区分 Runtime Session，访问检查同
`model-selection` 的 GET，返回
`{ usedTokens, contextWindow, percentage, model, updatedAt }`，没运行过、刚清除
（`/clear`、`/fresh`、重置会话）或刚压缩上下文时全部为 `null`。数据在宿主侧从会话
当前 SDK 会话的 transcript 读取：`usedTokens` 是最后一次主线程请求的 input + cache
read + cache creation（不含子代理请求），`model` 是该请求的上游模型，`updatedAt` 是
那次回复写入的时间；`contextWindow` 依次取 Claude Code 本进程上报的窗口（同一模型）、
模型条目的上下文长度（声明、能力表或同系列推断）、官方连接下模型自己的窗口，
其余为 200K；用量超过该窗口时改用模型窗口，仍超过则
`percentage` 记为 100。`percentage` 保留一位小数。
每个回合完成后，以及会话被清除时，工作区的 Web 会话收到 WebSocket 消息
`{ type: 'context_usage', chatJid, agentId?, usedTokens, contextWindow, percentage, model, updatedAt }`。

Runner 启动时，选中的模型取代配置的默认模型成为 `ANTHROPIC_MODEL`。第三方端点的模型
环境由 `buildConnectionModelEnv` 按本轮模型生成：上下文长度大于 200K 时模型名加 `[1m]`
（Claude Code 的开关，请求前剥掉，只把上下文上限抬到 1M），小于 1M 且不等于 200K 时
写 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 压回实际长度，未知时两者都不写；opus/sonnet/haiku
档与 `CLAUDE_CODE_SUBAGENT_MODEL` 取连接的 `roles`，未设置时跟随本轮模型。官方连接只在
模型条目声明了大于 200K 的上下文时加 `[1m]`（可能按长上下文计费）。已选模型被移出列表
后，按配置默认模型运行并记录告警，不让本轮失败。

换配置或换模型（包括取消选择回到默认模型）会让下一条消息在新的底层会话上开始，并带
上最近的对话记录：每种配置都记录会话运行的模型，一个底层会话只在一个模型上运行；
记录这一信息之前就存在的会话视为运行在配置默认模型上。只改档位或只改上下文长度不会
重置，存活 Runner 的下一个上游请求就使用新档位。
选择的（配置, 模型, 档位）都没变时不退出任何 Runner，按名字选中配置的默认模型也不算
变化；已经在所选配置上运行的暖 Runner 只在不涉及模型时保留，即新旧选择都没有指定
模型，且之前未选择时也没有运行智能体绑定的模型。

`POST /api/messages` 可以携带 Web 附件和 Runtime Session 标识。`/clear` 与
`/fresh` 会进入与 `reset-session` 相同的 owner 级破坏性检查。`/fresh` 会开启
新的 SDK 窗口并写入零摘要交接说明，不删除库中的旧历史，也不关闭 auto-compact。

Web 客户端每次发送带一个 `clientMessageId`（UUID）；超时或网关错误后重发同一内容时
沿用它。服务端按 `(用户, chatJid, clientMessageId)` 去重 24 小时：同一 id 且内容、
附件、目标会话和 `followUpBehavior` 都相同的重复请求返回第一次的结果并带
`deduplicated: true`，不再入库、入队或计费；同一 id 内容不同返回 409。消息落库后
处理失败时返回 500 并带 `stored: true` 与 `messageId`。新消息的 WS 广播带上
`client_message_id`，客户端据此确认送达。不带 id 的请求行为不变。

`GET /api/groups/:jid/messages` 返回的图片附件是降采样缩略图，并带
`hasOriginal` 标记；原图由
`GET /api/groups/:jid/messages/:messageId/attachments/:index/original`
按需返回，`:index` 是附件在存储数组中的下标。存储的附件本身不变，Agent 仍然
接收原分辨率图片。两个路由共用同一套工作区访问与 Host 执行权限检查，Runtime
Session 消息使用 `{workspaceJid}#agent:{sessionId}` 作为 `:jid`。

`POST /api/groups` 和 `PATCH /api/groups/:jid` 接受 `interaction_mode`
（`assistant` 或 `proactive`），两者的响应体都会回显当前值。该字段存放在
Workspace↔AgentProfile 绑定行上，因此：仅 `web:` 前缀工作区可修改，否则 403；
工作区没有 AgentProfile 绑定时返回 409 `WORKSPACE_AGENT_PROFILE_MISSING`。
它与 `execution_mode` 共享同一道 quiesce 边界，暖 Runner 只能观察到旧契约或新
契约；停机失败返回 503 并带 `persisted` 标记。

`process_visibility`（`hidden`、`activity` 或 `full`）决定主动模式工作区的 Web
能看到一个回合的多少过程，存放在同一条绑定行上。`GET /api/groups` 的每个 `web:`
工作区都带解析后的有效值（没有绑定行时为 `hidden`）；`POST /api/groups` 可在创建时
指定，缺省 `activity`，此前已存在的工作区保持 `hidden`；`PATCH /api/groups/:jid`
同样接受它，响应回显当前值。权限与 `interaction_mode` 相同（仅 `web:` 前缀工作区、
仅 owner，没有绑定行时 409 `WORKSPACE_AGENT_PROFILE_MISSING`），但它只改变展示：
不经过 quiesce、不重启运行时，正在运行的回合从下一个事件起按新值投影。Assistant
模式的工作区始终展示完整过程，该字段可以设置但没有效果。三个级别对 Web 的投影：

| 级别       | 广播给 Web 的 Runner 事件                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hidden`   | 仅运行生命周期 `status`（`requesting`、`idle`、`interrupted`），即转圈，以及进展（见下）                                                                |
| `activity` | 再加工具、子 Agent 任务、todo、hook、权限拒绝、上下文压缩和其余阶段状态，以及不含文本的 `thinking_start`/`thinking_end`；进展以外不含任何模型产出的文字 |
| `full`     | `activity` 加上主 Agent 与子 Agent 的 `thinking_delta`（推理摘要），以及主 Agent 调用工具前写下的过程说明 `commentary`                                  |

`commentary` 由宿主合成，Runner 不会发这个事件：主 Agent 的文字先被扣住，只有紧接着
调用了工具才作为一条完整的 `commentary`（先于该次调用，带该调用的 `queryRunId`）放行；
没有工具跟在后面的文字（回合结尾、未发送的回复）、紧接着 `send_message` 调用的文字
（即回复本身）、子 Agent 的文字都不会放行。宿主逐个调用判断、不向前看：同一条消息里
夹在文字与 `send_message` 之间的其它工具调用，会让这段文字在那个调用处放行。只有从
消息开头读起的文字才会被扣住，所以中途调高级别时，正在写的那句话的后半截不放行。
它只广播给 Web，不进入 IM 渠道，也不写入 `turn_traces`；重连快照不含它。

进展是主动模式 Agent 用 `send_message(delivery_role=progress)` 发给用户的话，按本轮输入
的来源渠道（绑定回合时记录）分流。IM 回合的进展是一条独立消息，与 `final` 一样经 Turn
Outbox 发出并写入消息；IM 回合的回复路由已不可用（输入被撤回、地址缺少渠道账号）时直接
失败，告诉 Agent 没有送达，不改投 Web。来源未知（没有 `inputTurnId` 或回合已解绑）时按
独立消息投递。Web 回合的进展不成为消息，而是一条带 `progress: true` 的 `commentary`，只由
宿主合成（Runner 事件上的 `progress` 标记会被去掉），在每个级别都广播，并作为 `progress`
步骤写入 `turn_traces`，最终回复送达后由 Web 折叠进该回复的处理过程。重连快照
`stream_snapshot.snapshot.progress` 按顺序带上本轮已发的进展（`{ at, text }`），中途加入的
标签页据此在每个级别重建进展步骤。Web 回合发过进展却没有回复就最终结束（被停止、被引导
转向、出错终止，或因缺少 `final` 被拒绝结单且不再重试）时，宿主写一条简短的结束说明
（`interrupt_partial`）作为本轮回复，进展随本轮轨迹挂在它上面。会重试的失败不写说明，
进展留给下一次尝试：重试发出 `final` 就挂在 `final` 上，否则由最终那一条结束说明带上所有
尝试的进展。

任何级别都不会发送 `text_delta`（含子 Agent 文本）、`usage`、`memory_recall`、
`prompt_suggestion`、`raw_sdk_event`、`notification` 和未知事件类型；`tool_result`
只保留 `toolUseId` 与布尔值 `toolIsError`（调用是否失败；工作区记忆写入工具的回执
另外保留结果文本，按 `toolUseId` 对应到该调用的 `tool_use_start` 识别），工具的 `toolInput`、
`toolResultFacts`（见下）、子 Agent 的提示词与 Workflow 的预览文本都会被剥离。过程事件永远不会进入 IM 渠道的流式卡片。`context_audit` 从不发给 Web，但
在所有模式下都会记录到宿主的运行上下文快照。`activity` 及以上还会广播子 Agent 任务的
`agent_status`，使 Task 标签与任务事件一致。

回合结算时，宿主把该回合的思考摘要、思考耗时、执行轨迹和有序步骤写入 `turn_traces`
（Assistant 模式总是写；主动模式在 `hidden` 级只写进展步骤，没有进展就不写，
`activity` 级不保存思考文本，步骤里的思考也不带文本与标题；思考文本最多 64KB，保留
尾部并以 `…` 开头标记被截断，轨迹最多 200 条，步骤最多 100 条）。`GET /api/groups/:jid/messages` 返回的消息带 `has_trace: true`
表示它是所属回合最后一条 agent 消息且该回合有轨迹，WebSocket `new_message` 在写入
轨迹的同时也带这个标记。主动模式的回复在回合中途发出（`sdk_send_message`），那时轨迹
还没有写入，所以回合结算写入轨迹之后，宿主再广播一条
`{ "type": "message_trace", "chatJid", "messageChatJid", "messageId", "turnId", "agentId"? }`，
告诉客户端哪条消息现在带轨迹（即回合最后一条 agent 消息），客户端据此补上
`has_trace`，无需刷新。`GET /api/groups/:jid/turn-traces/:turnId` 返回：

```json
{
  "turn_id": "…",
  "thinking": "…",
  "thinking_duration_ms": 12400,
  "trace": [
    { "id": "…", "timestamp": 0, "kind": "tool", "title": "工具 Bash" }
  ],
  "steps": [
    {
      "id": "thinking-0",
      "kind": "thinking",
      "at": 1791832926838,
      "endedAt": 1791832927208,
      "status": "done",
      "durationMs": 370,
      "title": "Planning the demo",
      "text": "**Planning the demo**\n\nI will run one shell command first."
    },
    {
      "id": "tool-toolu_bash_1-1",
      "kind": "tool",
      "at": 1791832927520,
      "endedAt": 1791832929663,
      "status": "done",
      "toolUseId": "toolu_bash_1",
      "toolName": "Bash",
      "summary": "command: sleep 2; echo stub-demo-ok",
      "resultPreview": "stub-demo-ok"
    }
  ],
  "steps_dropped": 0,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

`trace` 的行与 Web 实时累积的一致（标题格式相同；工具进度不逐帧追加，只把输入摘要、
技能名更新到该工具自己的“工具 X”行）。

`steps` 是回合内各步骤按发生顺序排成的时间线，每项是 `shared/stream-steps.ts` 的
`StreamingStep`（`kind` 为 `thinking`、`tool`、`task`、`text`；`at`、`endedAt` 为毫秒
时间戳；结算后没有 `running`）。宿主用与 Web 同一套归并器从回合的流事件重建它，所以
结算后的时间线与流式时一致；`tests/turn-steps-web-parity.test.ts` 把同一串事件喂给
Web store 和宿主记录器并逐项比对。只记录主 Agent 的顶层步骤：子 Agent 自己的工具与
文字属于它的 `task` 步骤，不单独成行。回合最后一个工具之后的文字是回复本身，不是步骤；
`text` 步骤是 Assistant 模式里调用工具前写下的说明。思考文本合计超过 64KB 时从最早的
步骤开始截（保留标题与时间），被截掉的文本换成“（已省略较早的思考）”标记，不会读成
一段没有内容的思考；步骤超过 100 条时丢弃最早的，被丢弃的条数写在`steps_dropped`。
`title`、`summary`、`toolName`、`skillName` 等字符串分别限制在 200、400、120、120 个
字符以内，超出的以 `…` 结尾。一个回合若分成多段（后台任务让回复被扣住，后续各段共用第一段
的 turn id），各段的步骤按先后接在一起；后台子 Agent 在前一段启动、后一段才收到
`task_notification` 时仍是同一个步骤。该字段加入之前结算的回合读作 `steps: []`、
`steps_dropped: 0`（不回填），`steps_json` 损坏同样读作空，不会让请求失败。

主 Agent 顶层工具的 `tool_result` 事件除结果文本外还带两个可选字段：`toolIsError`
是 SDK 的 `is_error`（失败但没有任何输出的调用也会发出该事件），`toolResultFacts`
是从 SDK 结构化的 `tool_use_result` 读出的数字与布尔（Read 的行数与总行数，Edit 与
Write 增删的行数及是否新建，Glob 与 Grep 的文件数与匹配数，失败 Bash 的退出码，
WebFetch 的状态码与字节数，WebSearch 的搜索次数，子 Agent 的工具、token 与耗时合计），
从不含路径、文件内容、命令输出等任何字符串；旧版 Runner 不发这两个字段，字段缺失时
按原有的结果文本判断失败。`toolResultFacts` 记在 `steps` 里对应工具步骤的
`resultFacts` 上，`toolIsError` 决定该步骤的 `status` 是否为 `error`。主动模式工作区
不放行工具结果文本，因此 `toolResultFacts` 在任何级别都被剥离、`resultFacts` 不会出现，
`toolIsError` 照常保留。

访问检查与消息列表相同（Runtime Session 的 `:jid` 为
`{workspaceJid}#agent:{sessionId}`）；主动模式工作区按**当前**可见性过滤：`hidden`
返回 404 且消息不带 `has_trace`，`activity` 返回空的 `thinking`，且 `steps` 里的思考
步骤只留状态与时间（无 `text`、`title`），`full` 返回思考步骤全文。主动模式的 `steps`
在任何级别都不含 `text` 步骤（模型的文字，包括 `commentary`，不写入 `turn_traces`），
也不含发言工具 `mcp__happyclaw__send_message` 的步骤（它调用的就是回复本身），tool 与
task 步骤上没有 `resultPreview` 和 `resultFacts`，`trace` 里“工具结果”“Task 启动”行没有
`detail`（工具输出与子 Agent 的提示词）；这些是读取时按**当前**模式去掉的，所以曾按
Assistant 契约记录的回合（工作区后来改成主动模式，或渠道挂载的
`interaction_mode_override` 为 `assistant`）在主动模式工作区里读取时同样没有它们。
Assistant 模式和 fire-and-forget 的 Spawn Agent 不受该设置影响，发言工具在其中与
其他工具一样是一个工具步骤。消息、聊天或工作区被删除时对应的轨迹一并清除，服务启动时
清理孤儿轨迹。

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

文件根与该会话运行时的工作目录一致：宿主机模式的自定义目录、否则
`data/groups/{folder}`。以上接口都接受查询参数 `agentId`（Runtime Session ID，`main`
或缺省为主会话）；会话有独立 worktree 时以 worktree 为根。`agentId` 不属于该工作区时
返回 404。

## 代码改动与会话 worktree

- `GET /api/groups/:jid/git/status?agentId=&scope=working|branch`
- `GET /api/groups/:jid/git/diff?agentId=&path=&orig_path=&scope=working|branch`
- `GET /api/groups/:jid/git/worktree-support`
- `GET /api/groups/:jid/workdir/peers?agentId=`

访问检查与文件接口相同：看不到的工作区返回 404，宿主机工作区需要宿主机执行权限
（403）。git 只对宿主机模式的工作区执行，命令使用参数数组、有超时与输出上限。宿主机上的
只读 git 调用（这里的 status、diff，删除 worktree 前的改动检查，`/fresh` 的工作区快照）
一律关闭 fsmonitor、hooks、textconv、外部 diff 和仓库配置的 filter（clean、smudge、
process），也不取可选锁：Docker 工作区的 `.git/config` 由容器内的 Agent 控制，读取时不
执行其中配置的任何命令。只有用户发起的 `worktree add` 保持 git 默认行为（运行仓库自己的
hook）。HappyClaw 本身不访问网络，但 LFS 或 partial clone 仓库在 `worktree add` 和 diff
时可能按需访问远端。

`git/status` 读取会话的 worktree，或工作目录所在的仓库（`data/groups/{folder}` 只认它
自己的仓库），返回 200：

```json
{
  "state": "ok",
  "root": "/srv/repo",
  "worktree": null,
  "branch": "main",
  "head": "3f2c…",
  "upstream": "origin/main",
  "ahead": 1,
  "behind": 0,
  "files": [
    {
      "path": "src/app.ts",
      "status": "modified",
      "index_status": ".",
      "worktree_status": "M",
      "additions": 12,
      "deletions": 3,
      "binary": false
    },
    {
      "path": "new.txt",
      "orig_path": "old.txt",
      "status": "renamed",
      "index_status": "R",
      "worktree_status": ".",
      "additions": 0,
      "deletions": 0,
      "binary": false
    }
  ],
  "total_files": 2,
  "truncated": false
}
```

`status` 取值 `modified`、`added`、`deleted`、`renamed`、`copied`、`type_changed`、
`untracked`、`conflicted`；`scope` 默认为 `working`（相对 HEAD 的暂存与未暂存合计），
会话拥有独立 worktree 时支持 `scope=branch`（相对审阅基底展示已提交与未提交改动，
并额外返回该基底 `baseCommit` 与领先它的提交数 `baseAhead`）。审阅基底是 worktree 的 `base_commit`
与 HEAD 和默认分支（本地及 `origin`，当前所在分支除外）各 tip 的 merge-base 中最新的一个，
会话分支合入或变基到更新的默认分支后，上游提交不算作会话的改动。未跟踪文件按
行数计入新增，二进制或过大时为 `null`。最多返回 1000 个文件，原始输出上限 2 MB，超出时
`truncated: true`。无法读取时同样返回 200：`{"state": "unavailable", "reason":
"container_mode" | "worktree_broken", "message": "…"}`、`{"state": "not_git_repo",
"message": "工作目录不是 git 仓库"}` 或 `{"state": "error", "error": "…"}`，都带
`worktree`。

`git/diff` 返回单个文件相对 HEAD（或 `scope=branch` 下相对审阅基底）的 unified diff，未跟踪文件与 `/dev/null` 比较：
`{"state": "ok", "path": "src/app.ts", "diff": "diff --git …", "binary": false,
"truncated": false, "untracked": false}`。输出上限 512 KB（`truncated: true`）；二进制
文件 `binary: true`。`path`、`orig_path`（重命名的原路径）必须是仓库内的相对路径：
绝对路径、`..`、NUL 和经符号链接逃出仓库的路径返回 400。

`git/worktree-support` 返回 `{"available": true}`，或
`{"available": false, "reason": "container_mode" | "directory_missing" |
"not_git_repo" | "repo_has_no_commits", "message": "…"}`。

`workdir/peers` 列出与该会话共用工作目录、且正在运行一轮的其他会话（同工作区未用
worktree 的会话、主会话，或自定义目录相同的其他工作区），只提示不限制：
`{"peers": [{"workspace_jid": "web:…", "workspace_name": "Repo", "kind": "main" |
"session" | "task", "session_id": null, "session_name": null}], "hidden_count": 0}`；
调用者看不到的工作区只计入 `hidden_count`。

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

原生话题群绑定到工作区：

- `POST /api/groups/:jid/im-groups/sync`
- `GET /api/groups/:jid/im-groups`
- `PUT /api/groups/:jid/im-binding`
- `DELETE /api/groups/:jid/im-binding/:imJid`

约束：

- `POST /api/groups/:jid/sessions`（及 `/agents`）只接受工作区 `web:*` JID；IM 聊天
  JID 返回 400，IM 聊天应绑定到 Session 而不是在其下创建 Session。
- 请求体可带 `worktree: true`：宿主机模式、工作目录是有提交的 git 仓库时，宿主在
  `data/worktrees/{folder}/{sessionId}` 以当前 HEAD 新建分支 `happyclaw/<短 ID>` 的
  worktree，该会话此后每次运行都以它为工作目录（工作区在仓库子目录时进入同一子目录）。
  不满足条件返回 400 `{"code": "WORKTREE_UNAVAILABLE", "reason": …}`，不创建会话；
  git 失败返回 500 `WORKTREE_CREATE_FAILED`。响应与 `GET` 列表的会话带
  `worktree: {"branch", "base_commit", "status": "active" | "broken", "broken_reason"}`
  或 `null`。worktree 丢失或损坏时该会话运行失败并说明原因，不会回退到主仓库。
  仓库根目录的 `.worktreeinclude` 列出要复制进新 worktree 的被忽略文件（如 `.env`）：只复制
  既匹配它、又被仓库的忽略规则（`.gitignore`、`info/exclude`、`core.excludesFile`）忽略的
  未跟踪文件。该文件超过 64 KB 或匹配列表超过 256 KB（此时一个都不复制）、超过 100 个文件
  或超过单文件 10 MB / 合计 50 MB 时少复制的部分会记 warn 日志，创建响应的
  `worktree.include_incomplete` 为
  `{"reason": "include_file_too_large" | "list_truncated" | "file_limit" | "size_limit", "copied_files", "skipped_files"}`
  （`skipped_files` 是最多 5 个未复制的路径，前两种原因下为空），完整复制时为 `null`（`GET`
  列表不带该字段）。Web 在新建会话后据此弹出不阻塞的提示。
- 删除带 worktree 的会话会移除 worktree 目录、保留分支。可能丢失内容时返回 409
  `{"code": "WORKTREE_DIRTY", "error", "dirty_worktrees": [{"session_id", "branch", "changed_files", "unreadable", "submodules", "embedded_repos", "detached_commits", "operation_in_progress", "hidden_changes"}]}`，
  `error` 逐条写明原因：
  - `changed_files`：未提交改动（含未跟踪文件）；嵌入的仓库或子模块指向的提交有变化也计入。
  - `unreadable`：目录还在但状态读不出（`.git` 丢失、找不到管理目录、git 失败，或嵌套仓库
    扫描超过 50 万个条目 / 10 秒），按有改动处理。
  - `submodules`：初始化过子模块（本地提交存放在 worktree 的管理目录，会随之删除）。
  - `embedded_repos`：worktree 内任意位置（包括被 `.gitignore`、`info/exclude` 或全局
    excludesFile 忽略的目录）有另一个仓库的 `.git`：目录、符号链接，或指向本 worktree
    管理目录 `modules/` 以外的 `.git` 文件；其中的提交和改动只存在 worktree 里。
  - `detached_commits`：HEAD 不在分支上，且 HEAD 提交不能从任何分支或标签到达（在
    detached HEAD 上提交、rebase 停在 edit 等），删除后这些提交不可达。
  - `operation_in_progress`：`"rebase"` | `"merge"` | `"cherry-pick"` | `"revert"` |
    `"bisect"` 进行中时为对应值，否则为 `null`。
  - `hidden_changes`：有 assume-unchanged 的文件，或磁盘上存在的 skip-worktree 文件，
    它们的改动不会出现在状态里（稀疏检出中不在磁盘上的文件不算）。

  检查只读索引、管理目录和文件系统（遍历不跟随符号链接），不会在嵌入的仓库中启动 git；
  其他被 `.gitignore` 忽略的文件不计入改动。带 `?force_worktree=true` 确认后才移除。git
  无法移除 worktree 时只删除它自己的管理目录（`gitdir` 指向该 worktree），不会清理同一
  仓库的其他 worktree。worktree 被标为 `broken` 后，目录恢复时（下次运行或列出会话时重新
  检查）回到 `active`。删除工作区和 `clear-history` 同理（409 相同），确认参数为
  `?force_worktrees=true&confirmed_worktrees=<session_id>,…`，列出调用方在 409 里看到并确认
  的会话；停止 runner 之后会再检查一次，出现列表之外的可能丢失内容的 worktree 时再次返回
  409（列出全部这类 worktree），只带 `force_worktrees=true` 不确认任何 worktree。工作区有
  worktree 会话时 `PATCH` 不能切换到 Docker 执行（409 `WORKTREE_SESSIONS_EXIST`）。最后一个
  worktree 移除后，空的 `data/worktrees/{folder}` 一并删除；启动时删除没有任何 worktree
  记录的空目录，有内容的目录不动。

- 工作区绑定只接受原生话题群（飞书话题群或 Telegram Forum）。
- Runtime Session 绑定接受私聊和普通群，`sessionId=main` 表示该 Workspace 的主会话。
- 话题群使用 `thread_map`，每个原生话题映射独立 Session；普通群的 @ 策略不改变绑定层级。
- `DELETE` 绑定会真正解除路由，不恢复默认工作区或自动创建会话。
- 每条输入的回复回到实际来源渠道；Web 输入不会自动镜像到已绑定 IM。
- 绑定管理 `PUT /api/config/user-im/bindings/:imJid` 使用
  `{target_session_id: "main", target_main_jid: "web:..."}` 选择主会话；
  仅指定 `target_main_jid` 表示话题群的 Workspace 绑定。
- 请求必须携带或解析出正确的 `channel_account_id`，不能跨机器人账号绑定。

## Agent Profiles

- `GET|POST /api/agent-profiles`
- `POST /api/agent-profiles/generate`
- `PATCH|DELETE /api/agent-profiles/:id`
- `POST|DELETE /api/agent-profiles/:id/avatar`
- `POST /api/agent-profiles/:id/refine-prompt`
- `GET /api/agent-profiles/:id/workspaces`
- `POST /api/agent-profiles/:id/effective-capabilities`
- `POST /api/agent-profiles/:id/duplicate`
- `POST /api/agent-profiles/:id/migrate-and-delete`
- `GET /api/agent-profiles/:id/export`
- `POST /api/agent-profiles/import`

`effective-capabilities` 返回 PromptPlan、Skill/MCP Manifest、上下文预算和最近一次
脱敏运行快照，用于对比“配置预期”与“SDK 实际加载”；`model_resolution`
（`source`、`model_config_id`、`model_config_name`、`model`、`effort`、`connection_missing`）
说明运行实际用的连接与模型。请求体可带未保存的 `model_config_id`、`model`，与未保存
的 `runtime_policy` 一样按它们计算；绑定的连接已删除时 `connection_missing` 为 true。
`source` 按固定顺序取 `session`（会话手选，仅指定 `workspace_jid` 时看该
工作区主会话）、`agent`（智能体绑定）、`workspace_env`、`owner_main`（所有者的主智能体）、
`system_main`（系统主 HappyClaw）或 `none`。`GET /api/agent-profiles` 另返回
`model_configs[]`（每个连接 `{ id, name, type, model, usable, models }`，`models` 形状同
`model-selection`）和 `inherited_model`（`owner_main`、`system_main` 各为
`{ model_config_id, model, effort }` 或 `null`；`system_main_profile_id` 只在调用者拥有
系统主 HappyClaw 时给出，否则为 `null`），供表单显示「跟随主智能体」。保存绑定或档位时
档位必须是所绑定模型支持的。

`GET /:id/workspaces` 的每个工作区带 `active_conversations`：该工作区运行时中正在
执行或有排队输入的个数，即一次会重启 Runner 的保存会中断的对话数；只在等待输入的
暖 Runner 不计入。

名称在同一用户的 active 智能体（含内置 HappyClaw）之间唯一，按 NFKC 折叠后不区分
大小写比较；创建、导入和改名冲突返回 409 与 `code: AGENT_NAME_TAKEN`，已有的重名
不受影响。四段 Prompt 每段最多 20000 个字符；超限返回 400 与
`code: PROMPT_TOO_LONG`、`field`（如 `soul_prompt`）和 `max`，名称不合法（含零宽
空格、软连字符等不可见字符）返回 `code: INVALID_NAME`；比较名称时也会去掉这类字符。
唯一性在数据库层的创建与改名里检查，Agent Builder 准备和发布草稿同样受约束。

`runtime_policy.mcp.ids` 的引用可带 `system:`/`user:` 前缀，前缀不计入 id 的 128 字符
上限。

每个 profile 的 `runtime_policy.skills.host` 都是显式值（schema v84 起），宿主机
Skills 不再随有效上下文来源隐式继承。

`duplicate` 新建「<名称> 副本」（重名时为「副本 2」「副本 3」…），复制四段 Prompt、
`prompt_mode`、`runtime_policy`、模型绑定、头像 Emoji/背景色与上传的头像文件（复制为
新文件），不复制工作区和渠道挂载；内置 HappyClaw 返回 400。校验与创建相同；非
admin 复制时去掉宿主机上下文与宿主机 Skills，响应 `stripped` 列出
`host_context`/`host_skills`。

`migrate-and-delete` 接受 `{target_agent_profile_id}`，在两个智能体的锁和工作区
Runner 停止期间，用一个事务把该智能体的全部工作区迁到目标并归档它：归档被拒绝
（例如仍有渠道挂载）时整体回滚并返回 409，提交前停不下 Runner 返回 503
`persisted: false`；成功返回 `{success, migrated_workspaces, invalidated_runtime_jids}`。

`export` 返回 `{format: "happyclaw-agent", version: 1, exported_at, agent}`，`agent`
含名称、头像 Emoji/背景色、四段 Prompt、`prompt_mode` 与 `runtime_policy`；Skills 用
目录名、MCP 用 `system:`/`user:` 前缀名引用，不含模型配置、上传头像、宿主机路径或
凭据。`import` 接受 `{data, name?, drop_missing?, confirm_host_grants?}`：格式或
版本不对返回 400
（`INVALID_AGENT_EXPORT`、`UNSUPPORTED_AGENT_EXPORT_VERSION`）；引用了本账号没有的
Skills/MCP 时返回 409 `AGENT_IMPORT_MISSING_REFERENCES` 与 `missing`，带
`drop_missing: true` 重发会去掉这些引用后创建（去掉后为空的“所选”改为不使用）；非
admin 导入时去掉宿主机上下文与宿主机 Skills；admin 导入会授予它们的文件时返回 409
`AGENT_IMPORT_HOST_GRANTS` 与 `grants`，确认后带 `confirm_host_grants: true` 重发。
成功返回 201
`{profile, stripped, dropped}`。

`GET /api/agent-profiles` 的每个 profile 带 `model_config_id` 与 `model`（该配置内
的模型，`null` 表示配置的默认模型）；`model_configs[]` 的每项带 `models[]`（`id`、
`hidden`），即可以绑定的模型，隐藏模型也在其中，ChatGPT 订阅配置为账号目录中的模型
（均不隐藏）。创建与 PATCH 接受 `model`（最长 200 个字符，`null` 清除）：它需要一个
模型配置（请求中的 `model_config_id`，PATCH 时也可以是已有的配置），并且必须在该
配置的列表（ChatGPT 为目录）中，否则返回 400 与 `code: MODEL_NOT_IN_CONNECTION`。
更换或清除 `model_config_id` 会清除 `model`，除非同一请求指定了新模型。改模型与改
配置一样提升 profile 版本并停止相关工作区的 Runner，下一条消息在新的底层会话上开始
并带上最近的对话记录。运行时，只有智能体的绑定决定了所用配置时才使用它的模型；会话
自己选择了配置时（即使是同一配置且未选模型）运行会话的选择。配置不再提供该模型时，
按配置默认模型运行并记录告警。

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

这些接口是 `registered_groups` 兼容存储之上的只读产品投影。mount 读模型带
`delegate_capable`（结构上可识别对方的私聊、绑定到单个会话）、`delegate_enabled` 和
`delegate_host_workspace`（绑定的工作区是 Host 模式，不能开启）。

- `PUT /api/workspaces/:jid/channel-mounts/:channelJid/delegate`，body
  `{ "enabled": boolean }`

工作区主人（对工作区和该聊天都 `canModifyGroup`）打开或关闭「允许对方管理此工作区」。
只接受 Docker 工作区上私聊的会话绑定：群聊、话题、无法从 JID 识别对方的会话（飞书私聊
不支持）或 Host 工作区（`code: DELEGATE_HOST_WORKSPACE`）开启时返回 400；其他用户、
访客或路径不匹配返回 404；绑定已变化返回 409。换绑、解绑或工作区切到 Host 会清除该开关。
`GET /api/groups/:jid/im-groups` 的条目同样返回 `mount_workspace_jid`、
`delegate_capable`、`delegate_enabled` 和 `delegate_host_workspace`。

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

项目能力以工作区的项目根为准，运行时、能力预览和这些接口一致：宿主机模式的自定义目录
（会话有独立 worktree 时为 worktree），否则 `data/groups/{folder}`。宿主机自定义目录
工作区因此会加载该目录 `.mcp.json` 和 `.claude/settings.json`、`.claude/settings.local.json`
中声明的 MCP，以及从该目录向上到 git 根的 `.claude/skills`；它们属于项目上下文层
（CLAUDE.md §5），与系统、用户 MCP 叠加。

`workspace-config/skills/install` 的 `package` 规则与 `POST /api/skills/install`
相同：URL 形式只接受 github.com 仓库或 tree 链接，其他主机返回 400。

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
- `POST /api/channel-accounts/feishu/registrations`
- `GET|DELETE /api/channel-accounts/feishu/registrations/:registrationId`

飞书账号凭证可带 `domain`（`feishu` 或 `lark`，缺省 `feishu`），连接、测试连接和
开发者后台链接都按它选择飞书或 Lark 的域名；公开账号在 `options.domain` 返回品牌。
`ownerOpenId` 只能由服务端写入。

`feishu/registrations` 扫码一键创建飞书/Lark 应用（OAuth device-code 注册，
PersonalAgent 应用）。`POST` 请求体 `{ name?, brand? }`，向飞书申请注册码，返回 201
`{ registration }`，其中包含 `qr_data_url`（只在这次响应中返回）、`verification_url`、
`user_code`、`expires_at`、`interval`；上游失败返回 502，同一用户进行中的注册超过 3 个
返回 429 `too_many_registrations`。服务端按飞书给出的间隔在后台轮询（`slow_down` 时
加长，租户为 Lark 时切到 Lark 域名），`GET` 只读内存状态，不会触发对飞书的请求。
`status` 取值 `pending`、`creating`、`success`、`expired`、`denied`、`error`；
成功时用与 `POST /api/channel-accounts` 相同的创建路径建号并连接，返回 `account_id`、
`account` 和 `event_console_url`（该应用的事件订阅页：PersonalAgent 应用默认只订阅
`im.message.receive_v1`）。App Secret 与 device code 从不返回或写入日志。`DELETE`
取消并删除注册，正在建号时返回 409 `registration_completing`。注册只存在于进程内存，
按用户隔离（他人 404），过期上限 15 分钟，结束后保留 10 分钟。

账号严格按 `owner_user_id` 隔离。同一 Provider 可以有多个账号。兼容字段
`default_workspace_jid` 不能替代渠道会话的显式绑定；连接、发现和配对不自动选择 Session。
层级和渠道规则见[业务模型](BUSINESS-MODEL.md)。

## Provider 与系统配置

Provider（模型连接：一份凭据和一个端点，提供一组模型）：

- `GET /api/config/claude`
- `GET|POST /api/config/claude/providers`；设置页只添加和维护连接，没有全局默认、
  启用开关和自动池，选哪个模型属于智能体和会话。公开 Provider 带 `models`
  （`{ id, contextWindow?, efforts?, defaultEffort? }[]`：`id` 是上游原名，从不带
  `[1m]`；连接自己的模型 `anthropicModel` 总在其中；ChatGPT 订阅为 `[]`，模型取自
  其目录）、`roles`（`{ subagent?, smallFast?, opus?, sonnet? }`，各自是本连接的一个
  模型，未设置时跟随本轮模型）、`presetId`（起步的厂商预设，只在地址仍是该预设的地址
  时保留，否则为 `null`）和 `lastTest`（最近一次测试
  `{ ok, code, status, model, latencyMs, at }`，未测过为 `null`；端点、认证方式、
  凭据、`ANTHROPIC_CUSTOM_HEADERS` 或轻量后台模型变更后清空）。
  创建请求可带 `models`、`roles`（指向不在列表里的模型时丢弃）、`presetId`（未知预设
  400），`models` 不含 `anthropicModel` 时把它加在最前，超过 100 个模型返回 400；模型名
  不能含空白，带 `[1m]` 的旧写法按 1M 上下文读入。`customEnv` 只注入非空值，新连接由
  Web 预填 `API_TIMEOUT_MS`、`CLAUDE_CODE_NO_FLICKER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`；
  含 `CONNECTION_MODEL_ENV_KEYS` 里的键（模型、各档、子代理、压缩窗口、推理等级）返回
  400 `{ error, code: 'RESERVED_ENV_KEY' }`。旧连接的这些键在读取时一次性迁移为
  `roles`、上下文长度和默认档位。`enabled`、`weight` 被忽略。
  每种类型创建时都必须带凭据，否则 400 `{ error: '新建模型配置需要凭据' }`。
  可用 `claudeCredentialInput` 提交官方
  凭据原文（`.credentials.json` 内容或 setup-token），由服务端解析，格式无效时
  返回 400；官方 Provider 同一时刻只保留 OAuth、setup-token、API Key 中的一种
- `PATCH|DELETE /api/config/claude/providers/:id`，第三方 Provider 的 PATCH
  可同时携带 `anthropicAuthToken` / `clearAnthropicAuthToken`，与其他字段在同一
  请求内提交；删除 ChatGPT 订阅型 Provider 后在后台尽力吊销其 refresh token，
  吊销结果不影响响应。PATCH 的 `models` 是完整的新列表（未列出的即移除），
  `presetId: null` 清除预设，`anthropicAuthMode: null` 清除认证方式、回到按令牌
  推断（测试时也重新尝试两种方式）；改名称、预设、模型的上下文长度或档位、`roles`
  或新增模型时不停 Runner、不清会话，在下次启动 Runner 时生效；端点、凭据、认证方式（含清除）、环境变量、默认模型变更或移除模型时停
  Runner；改 `anthropicModel` 仍按协议字段处理，未带
  `models` 时旧默认模型保留在列表中（列表已满 100 个时返回 400）；只改默认模型时
  只清除跑在旧默认模型上或没有记录模型的会话，选了该连接其他模型的会话保留，只改
  上下文长度不清会话。移除仍被智能体使用的模型返回 409
  `{ error, code: 'MODEL_IN_USE', agents: [{ id, name }] }`；会话里选了被移除模型的
  在下次运行时回到连接的默认模型
- `PUT /api/config/claude/providers/:id/secrets`，同样接受
  `claudeCredentialInput`；凭据变更只排空该 Provider 的 Runner
- `POST /api/config/claude/providers/:id/duplicate`，服务端连同加密密钥复制为
  停用的新 Provider；OAuth 授权的 Provider 拒绝复制
- `POST /api/config/claude/providers/test`，测试任意类型的连接。请求体为
  `providerId`（未填字段回退到已保存的连接与凭据）或草稿：`type`、`presetId`、
  `anthropicBaseUrl`、`anthropicAuthToken`、`anthropicAuthMode`、`anthropicApiKey`、
  `claudeCredentialInput`、`anthropicModel`、`customEnv`，均可选（缺省 `type` 视为
  `third_party`；预设草稿可不带地址，按预设地址与其第一个模型测试；
  `claudeCredentialInput` 只用于测试，从不保存）。第三方端点发一次最小
  `/v1/messages`（另测不同的 Haiku 映射），未指定认证方式时 Bearer 被 401/403
  拒绝会改用 `x-api-key` 再试一次；官方 API Key 在默认模型是具体的 `claude-*`
  模型时发一次最小消息，否则读 `GET /v1/models`（不计费）；Claude 订阅
  （OAuth、setup-token）只做不计费的账号检查，已保存的授权到期时先续期，粘贴的
  已过期授权不续期、返回 `UNKNOWN`；ChatGPT 订阅拉取一次实时模型目录。响应为
  `{ ok, probes, code, authMode?, record }`，每个 probe 为
  `{ model, ok, status, latencyMs, message?, hint?, code? }`：`code` 为
  `ProviderErrorCode`（通过为 `null`）；`authMode` 只在那次请求证明凭据被接受时
  返回（2xx，或只会在认证通过后出现的 `MODEL_NOT_FOUND`、`CONTEXT_TOO_LONG`、
  `WIRE_INCOMPATIBLE`），换用另一种方式后超时、限流或报其他错时沿用第一次的结果、
  不返回 `authMode`；订阅的账号检查只有 403 明确指出缺少 scope 时才算通过；`record` 即 `ProviderTestRecord`，账号
  检查的 `model` 为 `null`、其 probe 的 `model` 为空串。`message` 是脱敏且不超过
  300 字的上游摘录，密钥（含 JSON 转义形式）与自定义请求头的值都会被替换；日志只记
  上游 origin。带 `providerId` 且测试的
  正是已保存的连接（草稿未改端点、凭据、认证方式或环境变量）时，`record` 存为该
  连接的 `lastTest`（审计 `test_provider`，不停 Runner、不清会话）；没有认证方式
  的旧连接同时记下端点接受的方式，与原先推断的不同时只排空该连接的 Runner。
  与 `discover-models` 共用每用户每分钟 10 次的限额，超出返回 429
- `POST /api/config/claude/providers/discover-models`，获取连接的模型列表，
  请求体同上（不含 `anthropicModel`；`customEnv` 只用于草稿，其
  `ANTHROPIC_CUSTOM_HEADERS` 随请求发送，已保存的连接用自己的环境变量）。第三方端点读
  `modelsUrlFor(地址, 预设)`（自定义地址恰好匹配一个预设时用该预设的列表地址），
  认证方式回退同测试；官方 API Key 读 `https://api.anthropic.com/v1/models`；
  Claude 订阅不发请求，返回内置别名；ChatGPT 订阅返回其模型目录。成功为
  `{ ok: true, models, source, authMode? }`，`models` 为
  `{ id, name?, contextWindow?, efforts?, defaultEffort? }[]`（档位取自上游声明的
  `supported_reasoning_levels`、`supported_efforts` 等字段，`minimal`/`ultra` 丢弃），`source` 为 `endpoint`、`builtin` 或
  `catalog`；失败仍为 200
  `{ ok: false, code, status, message }`：列表地址 404 为 `ENDPOINT_NOT_FOUND`，
  返回内容不是模型列表为 `UNKNOWN`
- `GET /api/config/claude/providers/:id/impact`，返回
  `{ activeRunners, stoppedRunners }`：正在使用该连接的 Runner 数，以及修改其
  协议字段（端点、密钥、认证方式、默认模型、环境变量）时实际会停掉的 Runner 数
  （连接是系统主 HappyClaw 的连接、有会话记录、被智能体绑定或被会话选用时为全部存活
  Runner，否则为 0）
- `GET /api/config/claude/providers/:id/usage`，读不到用量时以 `status`
  区分 `unsupported`（setup-token、仅推理权限或非 OAuth 凭据，见
  `unsupportedReason`）与 `needs_relogin`（刷新授权被拒）；ChatGPT 订阅型
  Provider 不调用上游，返回网关记下的最近一次 `x-codex-*` 用量快照：
  `kind: 'codex_rate_limits'`、`observedAt`（毫秒，未见过为 `null`）、
  `activeLimit`、`rateLimitReachedType` 与 `limits[]`；每个限额族含
  `limitId`、`limitName`、`primary`/`secondary` 窗口（`usedPercent` 0–100、
  `windowMinutes`、`resetsAt` epoch 秒）和 `credits`（`hasCredits`、
  `unlimited`、`balance`），服务重启后为空
- `POST /api/config/claude/apply`
- `POST /api/config/claude/oauth/start`，可选 `targetProviderId`（必须是已有的
  官方 Provider）与 `profile`（`full` 默认，或 `setup_token`）；流程绑定发起用户
- `POST /api/config/claude/oauth/callback`，`code` 接受裸授权码、回调页显示的
  `code#state` 或回调页完整 URL；网络错误、429 与 5xx 返回 502 并保留流程以便重试
- `POST /api/config/codex/oauth/start`，启动 ChatGPT/Codex 订阅 OAuth
  PKCE 流程，返回 `authorizeUrl` 与 `state`；可选 `targetProviderId`
  用于对已有 Provider 重新授权
- `POST /api/config/codex/oauth/callback`，用 `{ state, code }`（`code`
  接受 `localhost:1455` / `127.0.0.1:1455` 回调页完整 URL、其 query 或裸授权码）
  换取 token，创建或更新 ChatGPT 订阅型 Provider，成功返回公开 Provider；其
  `anthropicBaseUrl` 落盘为内嵌网关占位值。新建时写入目录默认模型与
  `CODEX_REASONING_EFFORT`；回调带 `error=`（400），或 token 请求可证明未到达
  服务器（DNS、拒绝连接、连接超时、TLS 握手失败，502）时返回
  `{ error, retryable: true }` 并保留挂起流程；请求可能已到达 token 端点时
  （响应超时、连接中断、5xx 等，502）或授权码被拒（400）返回
  `{ error, retryable: false }`，授权码不会再次发送，需重新发起登录；目标
  Provider 不存在返回 404。换账号或由其他类型转换时会停稳运行器并清除该
  Provider 的会话，停稳失败返回 503 `{ error, applied, provider? }`；换成另一个
  ChatGPT 账号时后台尽力吊销旧 refresh token，不影响响应
- 内嵌网关（不在 `/api` 下）：`POST /gateway/chatgpt/v1/messages` 与
  `POST /gateway/chatgpt/v1/messages/count_tokens`（本地估算），只接受存活 Runner
  的临时 token，并拒绝带反代转发头或非回环/私网来源的请求
- `GET /api/config/codex/model-catalog[?providerId=]`，返回 Codex 模型目录
  `{ models, defaultModel, defaultEffort, source, fetchedAt, providerId?,
planType? }`。`models` 条目为 `{ value, label, efforts, defaultEffort?,
useResponsesLite, supportsVerbosity, defaultVerbosity, contextWindow?,
minimalClientVersion?, availableInPlans?, serviceTiers }`（字段取自官方
  `models.json`；条目内 `defaultEffort` 是 per-model 默认推理档，可能缺省；
  顶层 `defaultModel` 同官方默认（目前 `gpt-6.1-sol`），`defaultEffort` 是该
  模型的目录默认档，与新建 Provider 写入的值一致；
  `serviceTiers` 含 `priority` 才可用 Fast）。全局目录由
  `src/codex-gateway/model-catalog-sync.ts` 从上游 openai/codex 仓库
  `codex-rs/models-manager/models.json` 同步（`source` 为
  `upstream`/`disk-cache`/`builtin`），baked-in 目录
  （`src/codex-gateway/model-catalog.ts`）作离线兜底，并剔除
  `minimal_client_version` 高于网关客户端版本的模型。带 `providerId`
  （必须是已登录 ChatGPT 的 Provider，否则 404）时改用该账号的实时目录
  `GET chatgpt.com/backend-api/codex/models?client_version=`（`source` 为
  `live`，内存缓存 1 小时，首次请求等待一次拉取，失败回落全局目录），
  并按该账号 `planType` 过滤 `availableInPlans`；`defaultModel` 不在结果中时
  取第一项。供设置页模型/推理力度下拉使用
- `PUT /api/config/claude/custom-env`

第三方 Provider 的 `anthropicAuthMode` 为 `bearer`（`Authorization: Bearer`，
等同 `ANTHROPIC_AUTH_TOKEN`）或 `x-api-key`（等同 `ANTHROPIC_API_KEY`）；旧配置
为 `null`，沿用原推断规则。`customEnv` 写入时会拒绝危险变量、由专用字段管理的
变量以及非法的数值或推理档位，而不是静默丢弃。

系统：

- `GET|PUT /api/config/system`
- `GET|PUT /api/config/host-integration`，仅 admin；包含
  `adminHostOnlyMode`。从 `false` 切到 `true` 时会停稳管理员工作区运行器，并把
  active admin 拥有的工作区持久迁移为 Host；普通成员数据不变
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

## 自动化

- `GET|POST /api/automations`（`?workspace=<jid>` 过滤）
- `GET|PATCH|DELETE /api/automations/:id`（DELETE 带 `?sessions=keep|archive|delete`）
- `POST /api/automations/:id/pause`、`/resume`
- `POST /api/automations/:id/run`，立即运行（202）
- `GET /api/automations/:id/runs?limit=50`
- `POST /api/automations/:id/runs/:runId/cancel`
- `POST /api/automations/:id/runs/read`
- `GET /api/automations/for-session?jid=<sessionJid>`，绑定到该会话的自动化

只返回当前用户创建的自动化，其他人的一律 404，没有管理员旁路；宿主机工作区要求
管理员。PATCH 必须带 `expectedRevision`，过期返回 409。草稿校验、Cron 语法和权限
由 `src/automation-service.ts` 统一处理，REST 与 Agent 工具返回同样的中文错误。
状态变化通过 WS `automation_changed` / `automation_run_updated` 只推给所有者。

旧的 `/api/tasks*` 全部返回 410，提示改用 `/api/automations`。

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

`POST /api/skills/install` 的 `package` 接受 `owner/repo`、`owner/repo@skill`
等包名，或 `https://github.com/<owner>/<repo>`、
`https://github.com/<owner>/<repo>/tree/<ref>/<path>` 形式的 GitHub URL。URL
按解析出的 owner、repo、ref 和路径重建后交给 `skills add`；其他主机、非默认端口、
凭据、查询串、片段和 blob 链接在启动安装进程前返回 400。其他 Git 主机改用
`POST /api/skills/import/git`。`skills add` 子进程继承服务进程的
`HTTPS_PROXY`/`NO_PROXY`。Agent 的 `install_skill` 工具与 reinstall 使用同一规则。

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

`canonicalKey` 规范化后（忽略大小写、全半角和空格/`_`/`-`）已被另一条 active 条目
使用时（Agent 提议还包括另一条 proposed 条目），创建或改 key 返回 409：

```json
{
  "error": "memory_duplicate",
  "message": "An active memory already uses this canonical key: ...",
  "existing": {
    "id": "wmi_...",
    "kind": "fact",
    "title": "部署流程",
    "status": "active",
    "revision": 3
  }
}
```

### 待确认的记忆

群聊成员的轮次和自动化运行写入的记忆以 `status: "proposed"` 保存，不参与召回、目录和
搜索；`GET .../items?status=proposed` 列出它们。owner 的回答：

- `POST /api/memory/workspaces/:workspaceJid/items/:itemId/confirm`
- `POST /api/memory/workspaces/:workspaceJid/items/:itemId/reject`

请求体 `{ expectedRevision, idempotencyKey?, reason?, provenance? }`（`reason` 只用于
reject），返回 `{ storeRevision, item, replayed }`。confirm 把条目改为 active，
reject 写入 tombstone；审计事件分别记为 `confirm`、`reject`。带相同
`idempotencyKey` 重发返回已有结果（`replayed: true`）。owner 用 PATCH 编辑一条提议
也会把它变为 active；创建和 PATCH 都不接受 `status: "proposed"`（400）。条目已不是
proposed 时
返回 409 `not_proposed`，revision 过期返回 409 `revision_conflict`，确认时同一
canonical key 已有 active 条目返回 409 `memory_duplicate`。

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

- `GET /api/usage/stats`：`breakdown=none` 时不返回逐行明细（`breakdown`
  为空数组），汇总、按日数据和归因不变；默认仍返回明细以兼容旧客户端
- `GET /api/usage/models`
- `GET /api/usage/filters`：只计算归因列表
- `GET /api/usage/records`
- `GET /api/usage/export.csv`
- `GET /api/usage/users`
- `GET /api/usage/cache`：与 `/stats` 相同的筛选参数，返回提示缓存命中率
  `{ window, semantics: 'anthropic', summary, daily[], models[], connections[] }`；
  每行含 `inputTokens`、`cacheCreationTokens`、`cacheReadTokens` 和
  `hitRate = cacheRead ÷ (input + cacheCreation + cacheRead)`（无提示 Token 时为
  `null`）。`daily[].date`、`models[].model`、`connections[]` 的 `connectionId`
  （未记录连接时为 `null`）与 `name`（连接已删除时为 `null`）。按 Anthropic 用量语义
  计算（input 不含缓存）；网关把缓存计入 input 时命中率偏低

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
- `GET /api/status/groups`：只返回队列运行状态，供聊天页恢复运行态；可见范围与
  `/api/status` 相同，不做 Docker 与版本探测
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
- `stream_snapshot`，连接建立时推送进行中回合的快照（含推理文本尾部、推理计时、
  活动工具、子 Agent 状态、轨迹，以及主动模式 Web 回合已发的进展 `progress`）
- `active_run_snapshot`，连接建立时推送；`usageLimitWaits[]`
  （`{ chatJid, agentId?, resumeAt, waitCount }`）列出正在等待用量重置的会话
- `usage_limit_wait`，`{ chatJid, agentId?, resumeAt, waitCount? }`：会话开始等待
  用量重置；`resumeAt: null` 表示等待结束
- `agent_status`
- `terminal_output`
- `terminal_started`
- `terminal_stopped`
- `terminal_error`
- `docker_pull_log`
- `docker_pull_complete`

精确联合类型和字段以 `src/web.ts`、`src/types.ts` 与 `shared/stream-event.ts` 为准。
