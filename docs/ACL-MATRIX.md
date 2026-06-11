# ACL 权限矩阵

Issue #518 follow-up。记录所有 Web API / WebSocket / IM 操作的权限级别。

## 权限级别

| 级别 | 函数 / 中间件 | 含义 |
|------|--------------|------|
| Login | `authMiddleware` | 已登录即可 |
| Access | `canAccessGroup(user, group)` | owner 或 `group_members` 成员 |
| Modify | `canModifyGroup(user, group)` | 仅 owner（`created_by`） |
| Delete | `canDeleteGroup(user, group)` | 仅 owner，且非 home group |
| ManageMembers | `canManageGroupMembers(user, group)` | 仅 owner，且非 home group |
| SystemConfig | `systemConfigMiddleware` | `manage_system_config` 权限 |
| ManageUsers | `usersManageMiddleware` | `manage_users` 权限 |
| ManageInvites | `inviteManageMiddleware` | `manage_invites` 权限 |
| ViewAudit | `auditViewMiddleware` | `view_audit_log` 权限 |
| Admin | `user.role === 'admin'` | 仅管理员角色 |
| HostPerm | `hasHostExecutionPermission(user)` | 仅 admin（宿主机操作） |
| Public | 无 | 无需认证 |

> **补充说明**：所有涉及 host 执行模式的群组操作，在基础 ACL 检查之上，还会额外检查 `isHostExecutionGroup(group) && hasHostExecutionPermission(user)`，非 admin 无法操作 host 模式群组。下表中标注 `+HostPerm` 表示此额外检查。

## HTTP 路由

### 认证（`src/routes/auth.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/auth/status` | GET | Public | 返回系统初始化状态 |
| `/api/auth/setup` | POST | Public | 仅用户表为空时可用 |
| `/api/auth/login` | POST | Public | 频率限制 |
| `/api/auth/register` | POST | Public | 受注册开关/邀请码控制 |
| `/api/auth/logout` | POST | Login | |
| `/api/auth/me` | GET | Login | |
| `/api/auth/profile` | PUT | Login | 修改自己的资料 |
| `/api/auth/password` | PUT | Login | 修改自己的密码 |
| `/api/auth/sessions` | GET | Login | 列出自己的会话 |
| `/api/auth/sessions/:id` | DELETE | Login | 撤销自己的会话 |
| `/api/auth/avatar` | POST | Login | 上传头像 |

### 群组（`src/routes/groups.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups` | GET | Login | `buildGroupsPayload` 内部过滤，用 `canAccessGroup` |
| `/api/groups` | POST | Login | 创建群组；host 模式需 HostPerm；`init_source_path`/`init_git_url` 需 admin |
| `/api/groups/:jid` | PATCH | Access(仅 pin) / Modify(其他) +HostPerm | pin/unpin 只需 Access；rename/skills/execution_mode 需 Modify |
| `/api/groups/:jid` | DELETE | Delete +HostPerm | home group 不可删 |
| `/api/groups/:jid/reset-owner` | POST | **Admin** | break-glass：清 `owner_im_id`+`sender_allowlist`、`owner_mentioned`→`when_mentioned`。解 owner 离群死锁；下一位用户 `/owner_mention` 或 DM 自动认领接手 |
| `/api/groups/:jid/stop` | POST | Access | **P2 待改**：需 queue 追踪 query initiator 后收紧为"仅 owner 或发起者" |
| `/api/groups/:jid/interrupt` | POST | Access | **P2 待改**：同上 |
| `/api/groups/:jid/reset-session` | POST | Modify +HostPerm | |
| `/api/groups/:jid/clear-history` | POST | Modify +HostPerm | |
| `/api/groups/:jid/messages` | GET | Access +HostPerm | home 群组合并同 folder 下的 sibling JID |
| `/api/groups/:jid/messages/:messageId` | DELETE | Access | admin 可删任意消息；非 admin 只能删自己的非 AI 消息 |
| `/api/groups/:jid/env` | GET | Access + `manage_group_env` | 非 admin 且无权限则隐藏 `customEnv` |
| `/api/groups/:jid/env` | PUT | Access + `manage_group_env` +HostPerm | |
| `/api/groups/:jid/members` | GET | Access | |
| `/api/groups/:jid/members/search` | GET | ManageMembers | |
| `/api/groups/:jid/members` | POST | ManageMembers | home group 不可添加成员 |
| `/api/groups/:jid/members/:userId` | DELETE | ManageMembers / 自退 | 自己退出不需要 ManageMembers；owner 不可被移除 |
| `/api/groups/:jid/mcp` | GET | Access | **Dead code**：`setRegisteredGroup` 在 `db.ts:2588` 硬编码 `mcp_mode='inherit'` / `selected_mcps=null`，前端实际走 `workspace-config/mcp-servers` |
| `/api/groups/:jid/mcp` | PUT | Access | **Dead code**：同上，PUT 写不进 DB，保留仅为不破坏旧调用 |

### 消息（`src/web.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/messages` | POST | Access +HostPerm | 普通消息走 Access；`/clear` 命令**已收紧为 Modify**（与 `reset-session` 对齐，destructive 操作必须 owner） |

### Sub-Agent（`src/routes/agents.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups/:jid/agents` | GET | Access | 读类，共享成员可见 |
| `/api/groups/:jid/agents` | POST | **Modify** | 创建对话**已收紧为 owner-only**（与 workspace-config 一致）；非成员 404、非 owner 成员 403 |
| `/api/groups/:jid/agents/:agentId` | PATCH | **Modify** | 重命名，同上 |
| `/api/groups/:jid/agents/:agentId` | DELETE | **Modify** | 同上；有 IM 绑定时仍拒绝删除 |
| `/api/groups/:jid/im-groups` | GET | Access | 列出可绑定的 IM 群组 |
| `/api/groups/:jid/agents/:agentId/im-binding` | PUT | **Modify** (工作区) + Access (imGroup) | 工作区侧**已随 CRUD 收紧为 owner-only**；imGroup 侧保留 Access |
| `/api/groups/:jid/agents/:agentId/im-binding/:imJid` | DELETE | **Modify** + Access | 同上；thread_map unbind 会 `deleteAgent` owner 的 topic agents，必须 owner |
| `/api/groups/:jid/im-binding` | PUT | **Modify** + Access | 绑定 IM 群到主对话，owner-only |
| `/api/groups/:jid/im-binding/:imJid` | DELETE | **Modify** + Access | owner-only |
| `/api/groups/:jid/im-binding` | PUT | Access (双向) | 绑定 IM 到工作区主对话 |
| `/api/groups/:jid/im-binding/:imJid` | DELETE | Access (双向) | |

### 文件（`src/routes/files.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups/:jid/files` | GET | Access +HostPerm | |
| `/api/groups/:jid/files` | POST | Access +HostPerm | 上传 |
| `/api/groups/:jid/files/open-directory` | POST | Access + **HostPerm(硬性)** | 打开本地目录必须 admin |
| `/api/groups/:jid/files/download/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/preview/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/content/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/content/:path` | PUT | Access +HostPerm | |
| `/api/groups/:jid/files/:path` | DELETE | Access +HostPerm | |
| `/api/groups/:jid/directories` | POST | Access +HostPerm | |

### 记忆（`src/routes/memory.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/memory/sources` | GET | Login | 内部按 `created_by` 过滤 folder |
| `/api/memory/search` | GET | Login | 同上 |
| `/api/memory/file` | GET | Login | `resolveMemoryPath` 内部做 userId 校验 |
| `/api/memory/file` | PUT | Login | 同上 + 系统路径写保护 |
| `/api/memory/global` | GET | Login | 读自己的 user-global |
| `/api/memory/global` | PUT | Login | 写自己的 user-global |

### 定时任务（`src/routes/tasks.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/tasks` | GET | Login | 内部按 `canAccessGroup` 过滤 |
| `/api/tasks` | POST | Access | 创建任务 |
| `/api/tasks/:id` | PATCH | Access | 更新任务 |
| `/api/tasks/:id` | DELETE | Access | 删除任务 |
| `/api/tasks/:id/run` | POST | Access | 手动触发 |
| `/api/tasks/:id/logs` | GET | Access | 查看执行日志 |
| `/api/tasks/ai` | POST | Access | AI 辅助创建 |
| `/api/tasks/parse` | POST | Login | 解析自然语言 |

### 配置（`src/routes/config.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/config/claude` | GET | SystemConfig | |
| `/api/config/claude/providers` | GET | SystemConfig | |
| `/api/config/claude/providers` | POST | SystemConfig | |
| `/api/config/claude/providers/:id` | PATCH | SystemConfig | |
| `/api/config/claude/providers/:id/secrets` | PUT | SystemConfig | |
| `/api/config/claude/providers/:id` | DELETE | SystemConfig | |
| `/api/config/claude/providers/:id/toggle` | POST | SystemConfig | |
| `/api/config/claude/providers/:id/reset-health` | POST | SystemConfig | |
| `/api/config/claude/providers/health` | GET | SystemConfig | |
| `/api/config/claude/providers/:id/usage` | GET | SystemConfig | |
| `/api/config/claude/balancing` | PUT | SystemConfig | |
| `/api/config/claude/apply` | POST | SystemConfig | |
| `/api/config/claude/oauth/start` | POST | SystemConfig | |
| `/api/config/claude/oauth/callback` | POST | SystemConfig | |
| `/api/config/claude/custom-env` | PUT | SystemConfig | |
| `/api/config/feishu` | GET/PUT | SystemConfig | deprecated，改用 user-im |
| `/api/config/telegram` | GET/PUT | SystemConfig | deprecated，改用 user-im |
| `/api/config/telegram/test` | POST | SystemConfig | |
| `/api/config/registration` | GET/PUT | SystemConfig | |
| `/api/config/appearance` | GET/PUT | SystemConfig | |
| `/api/config/appearance/public` | GET | **Public** | 仅返回 appName/aiName/emoji/color |
| `/api/config/system` | GET/PUT | SystemConfig | |
| `/api/config/external-resources` | GET | SystemConfig + Admin 角色检查 | 非 admin 返回空数据 |
| `/api/config/external-resources/rule` | GET | SystemConfig + Admin 角色检查 | |
| `/api/config/user-im/status` | GET | Login | 返回自己的 IM 连接状态 |
| `/api/config/user-im/feishu` | GET/PUT | Login | 操作自己的配置 |
| `/api/config/user-im/telegram` | GET/PUT | Login | |
| `/api/config/user-im/telegram/test` | POST | Login | |
| `/api/config/user-im/telegram/pairing-code` | POST | Login | |
| `/api/config/user-im/telegram/paired-chats` | GET | Login | 按 `created_by` 过滤 |
| `/api/config/user-im/telegram/paired-chats/:jid` | DELETE | Login + owner 检查 | `created_by === user.id` |
| `/api/config/user-im/qq` | GET/PUT | Login | |
| `/api/config/user-im/qq/test` | POST | Login | |
| `/api/config/user-im/qq/pairing-code` | POST | Login | |
| `/api/config/user-im/qq/paired-chats` | GET | Login | 按 `created_by` 过滤 |
| `/api/config/user-im/qq/paired-chats/:jid` | PUT/DELETE | Login + owner 检查 | |
| `/api/config/user-im/dingtalk` | GET/PUT | Login | |
| `/api/config/user-im/dingtalk/test` | POST | Login | |
| `/api/config/user-im/discord` | GET/PUT | Login | |
| `/api/config/user-im/discord/test` | POST | Login | |
| `/api/config/user-im/wechat` | GET/PUT | Login | |
| `/api/config/user-im/wechat/qrcode` | POST | Login | |
| `/api/config/user-im/wechat/qrcode-status` | GET | Login | |
| `/api/config/user-im/wechat/disconnect` | POST | Login | |
| `/api/config/user-im/whatsapp` | GET/PUT | Login | |
| `/api/config/user-im/whatsapp/logout` | POST | Login | |
| `/api/config/user-im/bindings/:imJid` | PUT | Access | 操作 IM 绑定 |
| `/api/config/user-im/bindings/:imJid/reset-allowlist` | POST | Access + owner 检查 | `created_by === user.id` |

### 管理（`src/routes/admin.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/admin/users` | GET | ManageUsers | |
| `/api/admin/users` | POST | ManageUsers | 非 admin 不可创建 admin 用户 |
| `/api/admin/users/:id` | PATCH | ManageUsers | 非 admin 不可管理 admin 用户 |
| `/api/admin/users/:id` | DELETE | ManageUsers | 不可删自己；不可删最后一个 admin |
| `/api/admin/users/:id/restore` | POST | ManageUsers | |
| `/api/admin/users/:id/sessions` | DELETE | ManageUsers | |
| `/api/admin/permission-templates` | GET | Login + (`manage_users` \| `manage_invites`) | |
| `/api/admin/invites` | GET | ManageInvites | |
| `/api/admin/invites` | POST | ManageInvites | |
| `/api/admin/invites/:code` | DELETE | ManageInvites | |
| `/api/admin/audit-log` | GET | ViewAudit | |
| `/api/admin/audit-log/export` | GET | ViewAudit | |

### 监控（`src/routes/monitor.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/health` | GET | **Public** | 健康检查 |
| `/api/status` | GET | Login | 非 admin 只能看自己 `canAccessGroup` 的群组 |
| `/api/docker/build` | POST | SystemConfig | 构建 Docker 镜像 |
| `/api/docker/status` | GET | SystemConfig | |

### Skills（`src/routes/skills.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/skills` | GET | Login | |
| `/api/skills/search` | GET | Login | |
| `/api/skills/search/detail` | GET | Login | |
| `/api/skills/:id` | GET | Login | |
| `/api/skills/:id` | PATCH | Login | |
| `/api/skills/user-all` | DELETE | Login | |
| `/api/skills/:id` | DELETE | Login | |
| `/api/skills/install` | POST | Login | |
| `/api/skills/:id/reinstall` | POST | Login | |

### MCP Servers（`src/routes/mcp-servers.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/mcp-servers` | GET | Login | per-user 数据 |
| `/api/mcp-servers` | POST | Login | |
| `/api/mcp-servers/:id` | PATCH | Login | |
| `/api/mcp-servers/:id` | DELETE | Login | |
| `/api/mcp-servers/sync-host` | POST | Login | |

### Plugins（`src/routes/plugins.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/plugins` | GET | Login | admin 可见额外信息 |
| `/api/plugins/enabled/:pluginFullId` | PATCH | Login | |
| `/api/plugins/materialize` | POST | Login | |
| `/api/plugins/marketplaces/:name` | DELETE | Login | 仅删自己的 enabled refs |
| `/api/plugins/commands` | GET | Login | |
| `/api/plugins/catalog` | GET | Login | admin 可见额外信息 |
| `/api/plugins/catalog/marketplaces/:mp` | GET | Login | admin 可见额外信息 |
| `/api/plugins/catalog/scan` | POST | **Admin 角色检查** | `role !== 'admin'` → 403 |

### 用量统计（`src/routes/usage.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/usage/*` | ALL | Login | 全局 `authMiddleware` |

### 目录浏览（`src/routes/browse.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/browse/directories` | GET/POST | Login | 受 mount-allowlist 白名单约束 |

## WebSocket 操作

WebSocket 连接建立时从 Cookie 解析会话，验证通过后缓存 `session.user_id` 和 `session.role`。

| 操作 | ACL | 备注 |
|------|-----|------|
| `send_message` | Access +HostPerm | 对目标群组做 `canAccessGroup` |
| `send_message` + `/clear` | **Modify** +HostPerm | 已收紧为 owner-only（与 HTTP `/clear` + `reset-session` 对齐） |
| `send_message` + `/sw` | Access +HostPerm | spawn 并行任务，复用 send_message ACL |
| `terminal_start` | Access | `canAccessGroup`；host 模式直接拒绝（不支持终端） |
| `terminal_input` | 无额外检查 | 依赖 `terminal_start` 时的 ACL |
| `terminal_resize` | 无额外检查 | 同上 |
| `terminal_stop` | 无额外检查 | 同上 |

## IM 斜杠命令

IM 命令通过 `handleCommand()` 在主进程 `src/index.ts` 中处理，**不经过 Web 认证中间件**。

**Owner gate**：`OWNER_REQUIRED_IM_COMMANDS`（`src/im-command-utils.ts`）覆盖 destructive 命令，通过 `senderImId === group.owner_im_id` 比对（裸 ID 格式，与 feishu/dingtalk/telegram/qq 的 `onCommand` 现网一致）。

**DM 自动认领**：未认领 owner 的群组若是 1:1 私聊（`isDirectMessageJid()` 判定），在 owner-required 命令到达时自动把发送者认领为 owner，省去单人 DM 先发 `/owner_mention` 的冗余。群聊永不自动认领（`isDirectMessageJid` 对群组返回 false，首个发命令者不能静默夺权）。Feishu 由 DM owner-learn 路径自动设 owner，不走此分支。

| 命令 | ACL | 备注 |
|------|-----|------|
| `/clear` | **Owner** | senderImId 必须等于 `group.owner_im_id`；未认领的 DM 自动认领发送者 |
| `/bind` | **Owner** | 同上 |
| `/unbind` | **Owner** | 同上 |
| `/new` | **Owner** | 同上 |
| `/sw`、`/spawn` | **Owner** | 同上 |
| `/list`、`/ls` | 无 | 读类，群成员可见 |
| `/status` | 无 | 读类 |
| `/recall`、`/rc` | 无 | 读类（带 60s 节流） |
| `/where` | 无 | 读类 |
| `/owner_mention` | **bootstrap** | **必须开放**——未认领 owner 的群通过此命令 self-claim |
| `/release_owner` | **Owner** | 当前 owner 释放身份后清空 `owner_im_id` **和 `sender_allowlist`**（避免新 owner 被旧白名单锁死），并把 `owner_mentioned` 模式降级为 `when_mentioned`（否则清 owner 后 bot 全群沉默）；下一位用户可通过 `/owner_mention` 重新认领 |
| `/require_mention` | 内置 owner 检查 | 仅 `activation_mode === 'owner_mentioned'` 时限制；本 PR 不改 |
| `/allow` | 内置 owner 检查 | handler 内部检查 `senderImId === group.owner_im_id` |
| `/disallow` | 内置 owner 检查 | 同上 |
| `/allowlist` | 无 | 读类 |

**Telegram/QQ sender 透传**：本 PR 补 `onCommand` 现场传递裸 ID（`String(ctx.from.id)` / `userOpenId` / `memberOpenId`），与 feishu/dingtalk 的现有 `onCommand` 格式一致。不与 `messages.sender_id` 的 `tg:` / `qq:` 前缀混淆——后者是 DB 存储格式，不影响 `owner_im_id` 比对。

**QQ owner_im_id namespace（C2C vs Group 隔离）**：QQ Bot API v2 的 C2C event 给的是 `author.user_openid`，Group event 给的是 `author.member_openid`，**协议层面两者是不同的 ID namespace 不互通**——同一个用户在 DM 和群里的 ID 不一样。为避免 owner 在 DM 认领的 `owner_im_id` 与群里发命令时的 sender 比对失败，`src/qq.ts` 的 `onCommand` 现场对 senderImId 加 namespace 前缀：C2C 传 `c2c:${userOpenId}`，Group 传 `group:${memberOpenId}`。这样 DM 与群聊各自认领独立的 owner 记录，互不干扰。`messages.sender_id` 的存储格式（裸 `qq:${userOpenId}` / `qq:${memberOpenId}`）不变——前缀化只发生在 `onCommand` 调用现场，影响 `owner_im_id` 比对路径。

## 已知不一致

### P1 已修复的

- **系统消息渲染**（commit `579123f`）：`__system__` 消息的 if-else 链改为 registry + fallback，修复 `context_reset:` 前缀消息被静默丢弃的 bug；`context_overflow:` 消息路由到 `MessageBubble` 的红色卡片 UI（之前是 dead code）。
- **`resolveSystemMessage()` 单测**（P2 PR）：补回 P1 缺口，覆盖 8 个 case + fallback。

### P2 已修复的（本 PR）

- **Web `/clear` ACL 收紧**：HTTP `POST /api/messages` 与 WS `send_message` 的 `/clear` 分支前 inline `canModifyGroup`，与 `reset-session` 对齐。WS 路径用 `session.user_id/role`（非 `authUser`）。WS `agentId` 校验保留。
- **workspace-config 后端写路由收紧**：mcp-servers + skills 的 POST/PATCH/DELETE 共 6 个写路由通过 `requireWorkspaceOwner()` helper 加 `canModifyGroup` 检查。GET 路由保留 `canAccessGroup`。
- **workspace-config 前端按钮 UX 同步**：`WorkspaceSkillsPanel.tsx` 和 `WorkspaceMcpPanel.tsx` 写按钮按 `group?.member_role === 'owner'` 条件渲染。`canModify` prop 默认 false，避免加载态按钮闪烁。
- **Telegram/QQ `onCommand` sender 透传**：DM/C2C/Group 调用现场补传裸 ID（与 feishu/dingtalk 现有 `onCommand` 格式一致），解锁 IM owner gate 对 Telegram/QQ 通道生效。
- **IM 破坏性命令 owner gate**：`handleCommand` 顶部 `checkImOwnerCommand()` 拦截 `/clear` / `/bind` / `/unbind` / `/new` / `/sw` / `/spawn`，要求 `senderImId === group.owner_im_id`；旧群 `owner_im_id` 为空时提示走 `/owner_mention` 自我认领。`/owner_mention` 排除出 gate（bootstrap 入口）。
- **Owner reclaim path（`/release_owner`）**：补 reclaim 入口便于 owner 主动让位。命令进入 `OWNER_REQUIRED_IM_COMMANDS`，复用 gate 强制"仅当前 owner 自己可释放"，执行时清空 `owner_im_id` **和 `sender_allowlist`**（否则新 owner 被旧白名单锁死、`/allow` 也无法自救），并把 `owner_mentioned` 模式降级为 `when_mentioned`，下一位用户可发 `/owner_mention` 接手。只能由当前 owner 本人调用——owner 离群/换号无人能触发的场景由本 PR 的 admin break-glass `POST /reset-owner` 兜底（见下）。
- **WhatsApp/DingTalk/Discord `onBotAddedToGroup` 隔离**：`connectUserIMChannels` 拆出 `feishuOnBotAddedToGroup`（带 `getFeishuOwnerOpenId`，写入 `owner_im_id` + 锁定白名单）与通用 `onBotAddedToGroup`（不带 owner getter）。前者只给飞书使用，后者用于其他渠道，避免把飞书 open_id 错写进 WhatsApp/DingTalk/Discord 群的 owner 字段。
- **Sub-Agent CRUD + IM-binding 收紧 owner-only**：`src/routes/agents.ts` 的 POST/PATCH/DELETE `/:jid/agents` 及 4 个 IM-binding 写路由（PUT/DELETE `.../im-binding` 的工作区侧）由 `canAccessGroup` 改为两段式（非成员 404 隐藏存在、非 owner 成员 403），与 workspace-config 对齐（imGroup 侧保留 Access）。IM-binding 一并收紧是因为 thread_map unbind 会 `deleteAgent` 掉 owner 的 topic agents（破坏性）。前端 `AgentTabBar` + `TopicSidebar` 加 `canModify` prop（默认 false），非 owner 隐藏 create/rename/delete/bind 入口，仅保留只读 tab 选择。覆盖 `tests/routes-agents-acl.test.ts`（含 IM-binding）。
- **owner 离群死锁的 admin 凌驾路径（`POST /api/groups/:jid/reset-owner`）**：admin-only break-glass，清 `owner_im_id`+`sender_allowlist`、`owner_mentioned`→`when_mentioned`，解 owner 离群/换号导致 owner-only 命令永久锁死。覆盖 `tests/routes-groups-owner-acl.test.ts`。
- **`PATCH /api/groups/:jid` 静默 wipe 根因修复**：该路由原先用显式字段列表重建整行，而 `setRegisteredGroup` 是 `INSERT OR REPLACE`（整行覆盖），导致每次改名/改 activation_mode 都会把 `owner_im_id` / `sender_allowlist` / `conversation_source` / `conversation_nav_mode` / `binding_mode` / `feishu_chat_mode` / `feishu_group_message_type` 静默清空——直接破坏 owner gate 的安全锚点并损坏 feishu_thread 工作区。改为 `...existing` spread，只覆盖本次实际修改的字段。覆盖回归测试。
- **DM 自动认领 owner（非 Feishu）**：新增 `isDirectMessageJid()` 纯函数（覆盖 qq/dingtalk/discord/whatsapp/wechat/telegram 各自 jid 编码 + feishu→false），`handleCommand` 在 owner gate 前对未认领的 DM 自动认领发送者，消除 Telegram/QQ/WeChat/WhatsApp/DingTalk 单人 DM 首次需 `/owner_mention` 的回归。群聊仍走 `/owner_mention`。覆盖 `tests/im-owner-gate.test.ts`。
- **HTTP `/api/messages` 集成测试 + `createAppForTest()` factory**：`src/web.ts` 的 `app` 原先未 export，无法做 route-level 测试。新增 `createAppForTest(webDeps)` factory（镜像 `startWebServer` 的 deps 注入，但不启 HTTP/WS/状态广播定时器，返回已挂全部路由的 `app`）。`tests/routes-messages-acl.test.ts` 覆盖 `POST /api/messages` 的 `/clear` 拦截 ACL：无效 body 400 / 未知群 404 / 非成员 403（Access denied）/ 共享成员 403（owner-only）/ owner 200（真实 reset：`queue.stopGroup` 调用 + `context_reset` divider 落库）。
- **owner 生命周期写操作收敛（`src/group-owner.ts`）**：`owner_im_id` / `sender_allowlist` / `activation_mode` 原散在 9 处手搓 `setRegisteredGroup` + 内存 cache 同步。收敛到 `group-owner.ts` 纯函数子系统：`claimOwner`（设 owner，**不动** activation_mode）/ `releaseOwner`（清 owner+allowlist，`owner_mentioned`→`when_mentioned`）/ `addToAllowlist` / `removeFromAllowlist`，配 `persistGroupUpdate`（把 db 写与 cache sync 绑定为一步，杜绝漏同步导致的陈旧内存态）。`/release_owner`（`index.ts`）与 admin `/reset-owner`（`groups.ts`）现共享 `releaseOwner`，消除两处手抄的「清 owner 必降级 mode」不变量。`buildOnNewChat`（注册时 owner 出生）与 `/require_mention` 的 activation_mode 写入（单站、无跨站不变量）刻意留 inline，仅 persist 走 helper。覆盖 `tests/group-owner.test.ts`（10 例，含两个关键不变量）。

### 待后续 PR 修复的

- **`POST /api/groups/:jid/stop` 和 `interrupt`**：当前为 `canAccessGroup`，共享成员可停止/中断 owner 的容器。直接收紧为 `canModifyGroup` 会导致成员无法中断自己发起的查询（UX 回归）。正确方案：在 queue 层追踪 query initiator，实现"仅 owner 或发起者可操作"的资源级检查（参考删除消息路由的 `canAccessGroup` + sender 检查模式）。
