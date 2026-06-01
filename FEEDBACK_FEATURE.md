# 用户反馈功能实现说明

## 功能概述

在现有的飞书卡片反馈按钮（赞/踩）基础上，新增了将用户反馈信息存储到数据库的功能。

## 实现内容

### 1. 数据库变更

#### 新增表：`user_feedback`

```sql
CREATE TABLE user_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  feedback_type TEXT NOT NULL,  -- 'like' 或 'dislike'
  user_message TEXT,             -- 用户的上下文消息
  ai_response TEXT,              -- AI 的回复内容
  created_at TEXT NOT NULL
);
```

**注意**：表中不包含外键约束，因为 `messages` 表使用复合主键 `(id, chat_jid)`，直接引用 `message_id` 会导致外键不匹配错误。通过索引和应用层逻辑保证数据一致性。

#### 索引
- `idx_feedback_message`: 按 message_id 索引
- `idx_feedback_user`: 按 user_id 索引
- `idx_feedback_created`: 按 created_at 索引

#### Schema 版本
- 从 v38 升级到 v39

### 2. 新增数据库函数（`src/db.ts`）

#### `storeUserFeedback(params)`
存储用户反馈信息到数据库。

**参数：**
```typescript
{
  id: string;              // UUID
  messageId: string;       // 被反馈的消息 ID
  chatJid: string;         // 聊天 JID
  userId?: string;         // 用户 ID（飞书 open_id）
  username?: string;       // 用户名
  feedbackType: 'like' | 'dislike';  // 反馈类型
  userMessage?: string;    // 用户的上下文消息
  aiResponse?: string;     // AI 的回复内容
}
```

#### `getUserFeedbackByMessageId(messageId)`
根据消息 ID 查询该消息的所有反馈记录。

#### `getMessageById(messageId)`
根据消息 ID 获取完整的消息详情（包括内容、发送者等）。

#### `getUserMessageBeforeMessage(chatJid, messageId)`
获取某条消息之前的用户消息（用于获取反馈的上下文）。

### 3. 飞书连接处理（`src/feishu.ts`）

修改了 `card.action.trigger` 事件处理器中的 feedback 逻辑：

**原有功能（保留）：**
- 添加 emoji reaction（赞用 MeMeMe，踩用 EMBARRASSED）

**新增功能：**
1. 从事件数据中提取用户信息（`operator.user_id` 和 `operator.name`）
2. 通过 `resolveJidByMessageId` 获取 chatJid
3. 通过 `getMessageById` 获取 AI 回复的完整内容
4. 通过 `getUserMessageBeforeMessage` 获取用户的上下文消息
5. 调用 `storeUserFeedback` 将所有信息存储到数据库
6. 记录日志（成功或失败）

## 数据流程

```
用户点击赞/踩按钮
  ↓
飞书发送 card.action.trigger 事件
  ↓
解析事件数据（action, messageId, operator）
  ↓
添加 emoji reaction（原有功能）
  ↓
获取相关信息：
  - chatJid（通过 resolveJidByMessageId）
  - AI 回复内容（通过 getMessageById）
  - 用户上下文消息（通过 getUserMessageBeforeMessage）
  - 用户信息（从事件数据）
  ↓
存储到 user_feedback 表
  ↓
记录日志
```

## 使用示例

### 查询某条消息的反馈

```typescript
import { getUserFeedbackByMessageId } from './db.js';

const feedbacks = getUserFeedbackByMessageId('om_xxx');
console.log(feedbacks);
// [
//   {
//     id: 'uuid',
//     message_id: 'om_xxx',
//     chat_jid: 'feishu:oc_xxx',
//     user_id: 'ou_xxx',
//     username: '张三',
//     feedback_type: 'like',
//     user_message: '请帮我写一个排序算法',
//     ai_response: '好的，这里是一个快速排序的实现...',
//     created_at: '2026-06-02T10:30:00.000Z'
//   }
// ]
```

## 注意事项

1. **数据库迁移**：首次启动时会自动创建 `user_feedback` 表
2. **向后兼容**：原有的 emoji reaction 功能完全保留
3. **错误处理**：存储失败不会影响 emoji reaction 的添加
4. **隐私考虑**：存储了用户消息内容和 AI 回复，需注意数据隐私保护
5. **无外键约束**：由于 `messages` 表使用复合主键，`user_feedback` 表不使用外键约束，通过应用层逻辑保证数据一致性

## 故障排除

如果遇到 `foreign key mismatch` 错误，运行修复脚本：

```bash
node scripts/fix-user-feedback-table.js
```

该脚本会删除旧表并重新创建正确的表结构（不带外键约束）。

## 后续扩展建议

1. 添加 Web API 端点查询反馈数据
2. 在管理后台展示反馈统计
3. 支持反馈的导出功能
4. 添加反馈的分析和报表功能
