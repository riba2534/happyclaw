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

核心原则：

- admin 不自动绕过工作区所有权。Home、Web Workspace 和 IM Chat 均按
  `created_by` 隔离。
- Host 是额外边界：有工作区权限不代表可以执行 Host 操作。
- 非 owner 的用户即使拥有系统级 Permission，也不能读取或修改其他用户工作区中的
  Secret、环境变量和运行能力。
- 查不到资源和无权访问资源通常都返回 `404`，避免跨用户枚举。

## 2. Public 接口

| 路由                            | 方法 | 附加条件               |
| ------------------------------- | ---- | ---------------------- |
| `/api/auth/status`              | GET  | 无                     |
| `/api/auth/setup`               | POST | 仅用户表为空           |
| `/api/auth/login`               | POST | 登录限流               |
| `/api/auth/register/status`     | GET  | 无                     |
| `/api/auth/register`            | POST | 注册策略、邀请码、限流 |
| `/api/auth/avatars/:filename`   | GET  | 仅允许受管头像路径     |
| `/api/config/appearance/public` | GET  | 只返回公开外观         |
| `/api/health`                   | GET  | 不返回敏感运行详情     |

`/ws` 不是 Public。Upgrade 时必须同时通过 Cookie Session 与 Origin 校验。

## 3. 当前用户资源

以下资源以登录用户 ID 为作用域，不接受客户端指定其他 owner：

| 路由族                                              | 权限                                          |
| --------------------------------------------------- | --------------------------------------------- |
| `/api/auth/me`、profile、password、sessions、avatar | Login，仅本人                                 |
| `/api/agent-profiles/*`                             | Login，仅本人 Agent                           |
| `/api/channel-accounts/*`                           | Login，仅本人渠道账号                         |
| `/api/skills/*`                                     | Login，仅本人用户 Skills                      |
| 用户级 `/api/mcp-servers/*`                         | Login，仅本人配置                             |
| `/api/memory/*`                                     | Login，仅本人可访问记忆                       |
| `/api/usage/*`                                      | Login；普通用户只见本人，管理视图再按角色过滤 |
| `/api/billing/my/*`                                 | Login，仅本人                                 |

产品级 Agent 删除前必须先迁移其工作区。渠道账号删除、登出或断开时必须清理/更新
自身连接和绑定，不能影响其他用户或其他账号。

## 4. 工作区 ACL

### 4.1 Access

`canAccessGroup()` 对所有角色使用同一规则：

- Home Workspace：仅 `created_by`。
- Web Workspace：仅创建者。
- IM Chat：优先使用自身 `created_by`；旧记录没有 owner 时，只允许通过同 folder
  的 Home Workspace 解析 owner；解析失败默认拒绝。

需要 Access 的典型操作：

- 列表中的工作区投影
- 读取消息与文件
- 发送普通消息
- 查看 Runtime Session、绑定和项目能力
- 打开 Web 终端前的资源检查

Host Workspace 在 Access 之外还要求 admin。

### 4.2 Modify

`canModifyGroup()` 是 owner-only。需要 Modify 的典型操作：

- 重命名、切换 Agent、修改执行方式
- stop、interrupt、reset-session、clear-history
- 创建、修改、删除 Runtime Session
- 写入工作区 Skills/MCP
- 修改群聊绑定、激活方式、响应对象和 owner
- `/clear` 的 HTTP 与 WebSocket 分支

Pin 是当前用户自己的偏好，只要求 Access，不修改共享工作区状态。

### 4.3 Delete

Home Workspace 永远不可删除。其他工作区必须通过 Modify，删除过程会：

1. 暂停相关序列化键。
2. 停止工作区、Runtime Session 和虚拟任务 Runner。
3. 删除数据库、文件和绑定状态。
4. 仅在提交成功后丢弃被暂停的旧工作；失败则恢复。

### 4.4 环境变量

`GET|PUT /api/groups/:jid/env`：

- 必须 Access。
- Host Workspace 必须 admin。
- 非 admin 必须同时是 owner 且拥有 `manage_group_env`。
- admin 仍需先通过工作区 Access，不能借 admin 角色读取其他用户工作区。

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
| `/api/docker/build`、运行监控管理                 | `manage_system_config`                             |
| `/api/status/channel-outbox/*` 人工裁决           | `manage_system_config`                             |
| `POST /api/groups/:jid/reset-owner`               | admin break-glass，同时仍验证目标资源              |

系统 MCP 默认仅 admin 可用；只有显式设置为 shared 后，普通成员的 Agent 才能进入
有效能力清单。API 不回传 Secret 明文。

## 7. WebSocket

连接建立时把认证用户 ID、角色和 Permission 固定到 Session；每个操作仍重新检查
目标资源。

| 操作                             | 权限                               |
| -------------------------------- | ---------------------------------- |
| `send_message`                   | Access；Host 再加 Host             |
| `send_message` 中的 `/clear`     | Modify；Host 再加 Host             |
| Runtime Session 消息             | Access + Session 属于该 Workspace  |
| `terminal_start`                 | Access；只支持 Container Workspace |
| `terminal_input` / resize / stop | 必须是当前 WebSocket 已拥有的终端  |
| Docker Build 流                  | 对应系统管理权限                   |

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

| 命令                                 | 权限                                         |
| ------------------------------------ | -------------------------------------------- |
| `/list`、`/ls`、`/status`、`/where`  | 只读                                         |
| `/recall`、`/rc`                     | 只读，带节流                                 |
| `/allowlist`                         | 只读                                         |
| `/clear`、`/bind`、`/unbind`、`/new` | IM Owner                                     |
| `/sw`、`/spawn`                      | IM Owner                                     |
| `/release_owner`                     | IM Owner                                     |
| `/owner_mention`                     | 未认领群的 bootstrap，不可被 Owner Gate 锁死 |
| `/allow`、`/disallow`                | Handler 内检查 IM Owner                      |
| `/require_mention`                   | Handler 内按当前 owner/策略检查              |

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

定时任务：

- Agent 任务继承创建者、Workspace 和 Agent 身份。
- Script 任务仅允许 admin 的 Host Workspace。
- `group` 模式注入主 Session；`isolated` 使用独立 Session、IPC 和运行记录。
- 立即运行使用 idempotency key；取消只影响对应 Run。

定时任务的 IPC/MCP 面授权与 Web 面同源，均为 `canAccessGroup`，**admin 不提供
全局旁路**：

- 判定实现在 `src/task-acl.ts`，覆盖 `schedule_task`、`pause_task`、
  `resume_task`、`cancel_task`、`update_task`、`run_task_now`、`stop_task_run`、
  `restore_task`、`list_task_runs` 以及 `list_tasks` 的可见性过滤。
- 允许两条路径：目标是 Agent 自身工作区目录；或该工作区属主同样拥有目标群组。
- `isAdminHome` 只保留为能力判定（Script 任务、Host 执行模式），不参与工作区范围
  判定。原因：admin Home Agent 是会接触不可信内容的 LLM，而任务 `prompt` 会被按
  计划重放、以 Bot 身份在目标会话发言、并计费到目标工作区。
- 任务 `prompt` 属于用户内容，因此 `list_tasks` 不允许跨租户枚举。

## 11. 修改 ACL 的验证要求

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
