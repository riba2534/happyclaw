---
name: post-test-cleanup
description: 测试完成后的扫尾清理流程。在向某个工作区发送测试指令（如长篇文章生成、耗时任务）后，用此流程彻底清除测试痕迹，防止测试消息残留在会话上下文中持续消耗 token 额度。
---

# 测试后扫尾清理流程

## 何时使用

- 向某个工作区发送了耗时测试指令（如"写一篇5000字综述"）后
- 测试完成或中断后，需要清除测试痕迹
- 发现某工作区残留测试消息影响 AI 上下文时

## 完整清理步骤

### 第一步：停止残留容器

```bash
# 查看当前运行的容器
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}"

# 确认目标容器的 folder（容器名格式：happyclaw-{folder}-{timestamp}）
ls data/ipc/

# 发送中断信号（优雅停止）
touch data/ipc/{folder}/input/_interrupt
sleep 5

# 若容器仍在运行，发送关闭信号
touch data/ipc/{folder}/input/_close
sleep 10

# 确认容器已停止
docker ps --format "{{.Names}}" | grep {folder关键字}
```

### 第二步：查找测试消息

```python3
python3 -c "
import sqlite3
conn = sqlite3.connect('data/db/messages.db')
cur = conn.cursor()

# 先找到 folder 对应的 JID
cur.execute(\"SELECT jid, folder, name FROM registered_groups WHERE folder = '{folder}'\")
print('Group:', cur.fetchall())

# 查看最近消息，定位测试消息范围
cur.execute(\"\"\"
    SELECT id, content, is_from_me, timestamp
    FROM messages
    WHERE chat_jid = '{jid}'
    ORDER BY timestamp DESC LIMIT 20
\"\"\")
for r in cur.fetchall():
    print(f'id={r[0]} from_me={r[2]} | {str(r[1])[:80]}')
conn.close()
"
```

### 第三步：删除测试消息

```python3
python3 -c "
import sqlite3
conn = sqlite3.connect('data/db/messages.db')
cur = conn.cursor()

# 将需要删除的消息 ID 填入列表
test_ids = [
    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    # ...
]

placeholders = ','.join(['?' for _ in test_ids])
cur.execute(f'DELETE FROM messages WHERE id IN ({placeholders})', test_ids)
print(f'Deleted {cur.rowcount} messages')
conn.commit()
conn.close()
"
```

### 第四步：重置 Claude 会话（关键：清除 token 上下文）

```python3
python3 -c "
import sqlite3, uuid
conn = sqlite3.connect('data/db/messages.db')
cur = conn.cursor()

# 生成新 session ID，下次启动时以空上下文开始
new_id = str(uuid.uuid4())
cur.execute(\"UPDATE sessions SET session_id = ? WHERE group_folder = '{folder}'\", (new_id,))
print(f'Session reset: {cur.rowcount} rows, new ID: {new_id}')
conn.commit()
conn.close()
"
```

### 第五步：确认代码无意外修改

```bash
git status
git diff --stat
# 应显示 "nothing to commit, working tree clean"
```

## 注意事项

- **必须重置 session**：仅删除 DB 消息不够，Claude session 文件中仍保存着历史上下文，下次激活时依然消耗 token
- **容器名与 folder 的对应关系**：容器名格式为 `happyclaw-{folder}-{timestamp}`，可通过 `ls data/ipc/` 查看所有 folder
- **删除消息前仔细核对**：通过 `is_from_me` 和内容确认，避免误删正常业务消息
- **data/ 目录的修改不影响 git**：SQLite 和 IPC 文件均在 `data/` 下，不纳入版本控制

## 快速检查清单

- [ ] 无残留测试容器在运行（`docker ps`）
- [ ] 测试消息已从 DB 删除
- [ ] Claude session ID 已重置为新 UUID
- [ ] `git status` 显示工作区干净
