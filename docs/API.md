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

任何 active 的 admin/member 都可以为自己创建只读访客（`role=guest`），并授权其查看
自己拥有的部分 `web:*` 工作区（含 Home）。所有路由只作用于调用者自己的访客；
其他用户的访客和不属于调用者的工作区 JID 一律按不存在处理。访客自身调用这些路由
返回 403。

- `GET /api/guests`：`{ guests, grantable_workspaces }`。每个访客含 `id`、
  `username`、`display_name`、`status`（`active`/`disabled`）、`created_at`、
  `last_login_at` 和已授权的 `workspaces[{ jid, name, is_home }]`；
  `grantable_workspaces` 是调用者自己的工作区。
- `POST /api/guests`：`{ username, password, display_name?, workspace_jids[] }`，
  用户名/密码规则与普通账号相同；成功 201 `{ guest }`，工作区无效 400，
  用户名已存在 409。
- `PATCH /api/guests/:id`：`display_name`、`status`、`workspace_jids`（整体替换）、
  `password` 任选；授权变更对下一次请求立即生效，状态或密码变更同时注销访客的会话。
- `DELETE /api/guests/:id`：标记删除并清除授权、置顶和会话。

访客能看什么、能调用哪些路由见 [ACL 权限矩阵](ACL-MATRIX.md) 的“访客”一节。
管理员用户管理（`/api/admin/users`）能列出、禁用、删除和重置访客（列表带
`guest_owner_username`，支持 `role=guest` 过滤），但不能创建访客或改变访客角色；
邀请码和注册永远不会产生访客。

## 工作区、消息和运行控制

- `GET|POST /api/groups`
- `PATCH|DELETE /api/groups/:jid`
- `PATCH /api/groups/:jid/agent-profile`
- `POST /api/groups/:jid/stop`
- `POST /api/groups/:jid/interrupt`
- `POST /api/groups/:jid/reset-session`
- `GET|PUT /api/groups/:jid/model-selection`，聊天输入框的会话级模型与推理档位选择
- `POST /api/groups/:jid/clear-history`，重建工作区内容：永久清除聊天、
  Runtime Session、子对话、工作目录及 Workspace Memory（含版本历史和
  Home Owner Profile），关联定时任务停止并移入回收站；保留工作区外壳、
  `data/extra/` 和任务运行历史
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

`model-selection` 以 `agentId`（GET 查询参数、PUT 请求体）区分 Runtime Session，
缺省表示主会话。GET 返回当前选择、默认值的解析来源和全部已保存模型配置（不含凭据）；
`default.source` 取值 `agent`（智能体绑定）、`workspace_env`（工作区自带 Provider
环境变量）、`default`（`PUT /api/config/claude/default` 设置的全局默认）、`single`
（唯一启用的配置）、`pool`（已启用配置间自动轮换）、`none`，顺序与运行时解析一致；
PUT 的 `modelConfigId` 为 `null` 时恢复默认。会话选择优先于智能体绑定的模型配置，
可以选择未启用的配置；切换后该会话的暖 Runner 在当前轮次结束后退出，下一条消息
使用新配置。

ChatGPT 订阅配置（`kind: "codex"`）还可以在配置内选择具体模型与推理档位。GET 为
这类选项增加 `codex`：`defaultModel`（配置自己的模型）、`defaultEffort`（不选档位时
实际使用的档位，Agent 显式档位优先，其次是配置档位，按模型目录钳制）、`source`
（`live` 为该账号自己的目录，其余为兜底目录）、`needsReauth`，以及
`models[]`（`value`、`label`、`efforts`、`defaultEffort`）。`models` 来自该账号的
实时目录并按套餐过滤，同步读取、后台刷新，不等待网络；`efforts` 按 low 到 ultra
排序，只含当前用户可以选择的档位。响应顶层另有 `selectedModel`、`selectedEffort`：
已存的选择若不再被目录或当前用户权限支持，按未选择返回，与 Runner 启动时的处理
一致。其他类型的选项形状不变，旧客户端不受影响。

PUT 可以携带 `model`、`effort`，请求整体替换该会话的选择：只写 `modelConfigId`
会清掉之前的模型和档位，换配置也不会继承旧配置的模型。`model` 必须在该账号当前
目录内，`effort` 必须在（所选或配置自己的）模型的 `efforts` 内，且 `model` 与
`effort` 只能用于 ChatGPT 订阅配置，并要同时给出 `modelConfigId`；否则返回 400 与
`code`：`MODEL_UNAVAILABLE`、`EFFORT_UNSUPPORTED`、`EFFORT_RESTRICTED`、
`MODEL_SELECTION_UNSUPPORTED`、`MODEL_CONFIG_REQUIRED`。高于 `max` 的档位（目前是
`ultra`）只允许具备 `manage_system_config` 的用户选择，GET 不列出，PUT 返回
`EFFORT_RESTRICTED`，Runner 启动时若选择者已失去该权限则回到默认档；放宽只需改
`CODEX_SESSION_EFFORT_CEILING`。响应附带 `drained`（被退出的暖 Runner 数）与
`liveUpdated`（被就地改档的存活网关授权数）。

换配置或换模型会让下一条消息在新的底层会话上开始，并带上最近的对话记录（加密推理只对
签发它的模型有效）；只改档位不会，存活 Runner 的下一个上游请求就使用新档位。
选择的 (配置, 模型, 档位) 都没变时不退出任何 Runner。

`POST /api/messages` 可以携带 Web 附件和 Runtime Session 标识。`/clear` 与
`/fresh` 会进入与 `reset-session` 相同的 owner 级破坏性检查。`/fresh` 会开启
新的 SDK 窗口并写入零摘要交接说明，不删除库中的旧历史，也不关闭 auto-compact。

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

| 级别       | 广播给 Web 的 Runner 事件                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hidden`   | 仅运行生命周期 `status`（`requesting`、`idle`、`interrupted`），即转圈                                                                          |
| `activity` | 再加工具、子 Agent 任务、todo、hook、权限拒绝、上下文压缩和其余阶段状态，以及不含文本的 `thinking_start`/`thinking_end`；不含任何模型产出的文字 |
| `full`     | `activity` 加上主 Agent 与子 Agent 的 `thinking_delta`（推理摘要），以及主 Agent 调用工具前写下的过程说明 `commentary`                          |

`commentary` 由宿主合成，Runner 不会发这个事件：主 Agent 的文字先被扣住，只有紧接着
调用了工具才作为一条完整的 `commentary`（先于该次调用，带该调用的 `queryRunId`）放行；
没有工具跟在后面的文字（回合结尾、未发送的回复）、紧接着 `send_message` 调用的文字
（即回复本身）、子 Agent 的文字都不会放行。宿主逐个调用判断、不向前看：同一条消息里
夹在文字与 `send_message` 之间的其它工具调用，会让这段文字在那个调用处放行。只有从
消息开头读起的文字才会被扣住，所以中途调高级别时，正在写的那句话的后半截不放行。
它只广播给 Web，不进入 IM 渠道，也不写入 `turn_traces`；重连快照不含它。

任何级别都不会发送 `text_delta`（含子 Agent 文本）、`usage`、`memory_recall`、
`prompt_suggestion`、`raw_sdk_event`、`notification` 和未知事件类型；`tool_result`
只保留 `toolUseId` 与布尔值 `toolIsError`（调用是否失败），工具的 `toolInput`、
`toolResultFacts`（见下）、子 Agent 的提示词与 Workflow 的预览文本都会被剥离。过程事件永远不会进入 IM 渠道的流式卡片。`context_audit` 从不发给 Web，但
在所有模式下都会记录到宿主的运行上下文快照。`activity` 及以上还会广播子 Agent 任务的
`agent_status`，使 Task 标签与任务事件一致。

回合结算时，宿主把该回合的思考摘要、思考耗时、执行轨迹和有序步骤写入 `turn_traces`
（Assistant 模式总是写；主动模式仅当 `process_visibility` 不是 `hidden` 时写，且
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

账号严格按 `owner_user_id` 隔离。同一 Provider 可以有多个账号。兼容字段
`default_workspace_jid` 不能替代渠道会话的显式绑定；连接、发现和配对不自动选择 Session。
层级和渠道规则见[业务模型](BUSINESS-MODEL.md)。

## Provider 与系统配置

Provider：

- `GET /api/config/claude`
- `GET|POST /api/config/claude/providers`；创建请求可用
  `claudeCredentialInput` 提交官方凭据原文（`.credentials.json` 内容或
  setup-token），由服务端解析，格式无效时返回 400；官方 Provider 同一时刻只保留
  OAuth、setup-token、API Key 中的一种
- `PATCH|DELETE /api/config/claude/providers/:id`，第三方 Provider 的 PATCH
  可同时携带 `anthropicAuthToken` / `clearAnthropicAuthToken`，与其他字段在同一
  请求内提交；删除 ChatGPT 订阅型 Provider 后在后台尽力吊销其 refresh token，
  吊销结果不影响响应
- `PUT /api/config/claude/providers/:id/secrets`，同样接受
  `claudeCredentialInput`；凭据变更只排空该 Provider 的 Runner
- `POST /api/config/claude/providers/:id/toggle`，没有可用凭据的 Provider
  不能启用；全局默认的 Provider 不能禁用
- `PUT /api/config/claude/default`，请求体 `{ modelConfigId: string | null }`：
  设置全局默认模型配置，`null` 取消并回到已启用配置间的自动轮换。没有会话选择、
  智能体绑定和工作区环境变量的运行都使用它，不再参与负载均衡；未启用的配置在
  设为默认时同时启用，没有可用凭据的配置返回 400；删除默认配置会清除默认，
  响应带 `defaultCleared: true`；默认配置被清除凭据时默认同时清除（之后补回凭据
  也不会自动恢复）。`GET /api/config/claude/providers` 返回
  `defaultModelConfigId`（无默认为 `null`）
- `POST /api/config/claude/providers/:id/duplicate`，服务端连同加密密钥复制为
  停用的新 Provider；OAuth 授权的 Provider 拒绝复制
- `POST /api/config/claude/providers/test`，按草稿字段（可选 `providerId`
  回退到已保存的端点与密钥）向第三方端点发送一次最小 `/v1/messages` 请求，
  返回每个模型的状态码、耗时和脱敏错误摘要，不回传密钥；按用户限流
- `POST /api/config/claude/providers/:id/reset-health`
- `GET /api/config/claude/providers/health`
- `GET /api/config/claude/providers/:id/usage`，读不到用量时以 `status`
  区分 `unsupported`（setup-token、仅推理权限或非 OAuth 凭据，见
  `unsupportedReason`）与 `needs_relogin`（刷新授权被拒）；ChatGPT 订阅型
  Provider 不调用上游，返回网关记下的最近一次 `x-codex-*` 用量快照：
  `kind: 'codex_rate_limits'`、`observedAt`（毫秒，未见过为 `null`）、
  `activeLimit`、`rateLimitReachedType` 与 `limits[]`；每个限额族含
  `limitId`、`limitName`、`primary`/`secondary` 窗口（`usedPercent` 0–100、
  `windowMinutes`、`resetsAt` epoch 秒）和 `credits`（`hasCredits`、
  `unlimited`、`balance`），服务重启后为空
- `PUT /api/config/claude/balancing`
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
  活动工具、子 Agent 状态和轨迹）
- `agent_status`
- `terminal_output`
- `terminal_started`
- `terminal_stopped`
- `terminal_error`
- `docker_pull_log`
- `docker_pull_complete`

精确联合类型和字段以 `src/web.ts`、`src/types.ts` 与 `shared/stream-event.ts` 为准。
