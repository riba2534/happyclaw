# HappyClaw 数据模型事实来源与镜像重建约束

本文档根据 HappyClaw 架构演进与 R13 建议，规范核心领域实体的事实来源（Source of Truth）、兼容镜像投影（Compatibility Mirror）以及一致性重建约束。

---

## 1. 实体事实来源矩阵

| 业务领域               | 规范事实来源 (Primary Source of Truth)    | 历史兼容镜像 (Compatibility Mirror)      | 说明                                                 |
| :--------------------- | :---------------------------------------- | :--------------------------------------- | :--------------------------------------------------- |
| **工作区元数据**       | `workspaces` 表                           | `registered_groups` (`jid LIKE 'web:%'`) | 工作区文件目录、创建人、默认模式以 `workspaces` 为准 |
| **运行时会话**         | `sessions` / `workspace_runtime_sessions` | `agents` 表 (历史投影)                   | 独立上下文及私聊绑定关系                             |
| **渠道群聊挂载**       | `channel_mounts` 表                       | `registered_groups.target_main_jid`      | 渠道群聊与工作区多对多挂载关系                       |
| **渠道私聊/Agent挂载** | `agent_channel_mounts` / `channel_mounts` | `registered_groups.target_agent_id`      | 私聊会话绑定关系                                     |
| **原生线程映射**       | `im_context_bindings` 表                  | 无 (原生专有)                            | 飞书话题/Telegram 论坛等原生线程与会话上下文映射     |

---

## 2. 兼容镜像写入约束与领域命令

为了防止应用层由于直接拼凑 `RegisteredGroup` 写入导致真实关系表与兼容镜像脱节或单侧覆盖，系统对写入入口做出如下严格约束：

1. **写入口收口**：
   - 渠道绑定的建立、变更与解除**必须**调用领域命令：
     - `executeBindChannelToWorkspace(command)`
     - `executeBindChannelToSession(command)`
     - `executeUnbindChannel(channelJid)`
   - 严禁外部路由或连接器直接散乱写入单侧字段。
2. **仓储内原子双写**：
   - `setRegisteredGroup` 在 SQLite 事务内部原子更新 `registered_groups` 并同步调用 `syncChannelMountFromRegisteredGroup` 与 `syncWorkspaceFromRegisteredGroup`，保证在同一事务内完成双写。
3. **运行时缓存一致**：
   - 领域命令在提交成功后，同步更新 `channelMountRuntimePort.getRegisteredGroups()` 内存缓存并清除失败计数，保证内存视图与持久视图无缝一致。

---

## 3. 重建与自愈约束 (Rebuild Constraints)

1. **服务启动期一致性对账**：
   - 服务启动时若检测到版本升级或存在潜在脱节，调用 `syncAllChannelMountsFromRegisteredGroups()` 从持久镜像全量重构 `channel_mounts` 与 `agent_channel_mounts`。
2. **孤儿清理与自愈**：
   - 当引用的 `workspace_jid` 或 `session_id` 被物理删除时，外键级联或清理逻辑原子清除关联的挂载记录与镜像记录，防止幽灵路由。
3. **单向不可逆规则**：
   - 正在进行交互的活跃 Turn/Outbox 记录不得逆向回退到旧状态；重试和恢复流程严格遵循 Fencing 令牌保护。
