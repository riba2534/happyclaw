/**
 * user_feedback 表语义测试（PR #558）。
 *
 * SQL 与 src/db.ts 中的 v40 迁移 / storeUserFeedback 保持一致（db.ts 的
 * migration 内联在 initDatabase 单例中，无法直接导入——修改 db.ts 中的
 * user_feedback SQL 时需同步更新此处副本）。
 *
 * 验证三个关键不变量：
 * 1. v39（无 UNIQUE、user_id 可空）→ v40 重建迁移，每键保留最新一条
 * 2. upsert：同一用户对同一消息改票时原地更新（统计天然只按最新）
 * 3. 匿名反馈 user_id 归一为 ''，UNIQUE 约束实际生效（SQLite NULL 互不相等）
 */
import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

const CREATE_V40 = `
  CREATE TABLE user_feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT,
    feedback_type TEXT NOT NULL,
    user_message TEXT,
    ai_response TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, message_id)
  );
  CREATE INDEX idx_feedback_message ON user_feedback(message_id);
  CREATE INDEX idx_feedback_user ON user_feedback(user_id);
  CREATE INDEX idx_feedback_created ON user_feedback(created_at);
`;

const UPSERT = `
  INSERT INTO user_feedback (
    id, message_id, chat_jid, user_id, username, feedback_type,
    user_message, ai_response, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, message_id) DO UPDATE SET
    feedback_type = excluded.feedback_type,
    username = excluded.username,
    user_message = excluded.user_message,
    ai_response = excluded.ai_response,
    created_at = excluded.created_at
`;

function upsert(
  db: Database.Database,
  p: { id: string; messageId: string; userId?: string; feedbackType: string; createdAt: string },
): void {
  db.prepare(UPSERT).run(
    p.id,
    p.messageId,
    'feishu:oc_test',
    p.userId ?? '',
    null,
    p.feedbackType,
    null,
    null,
    p.createdAt,
  );
}

describe('v39 → v40 migration rebuild', () => {
  test('dedupes legacy rows keeping the newest per (user_id, message_id), NULL → empty string', () => {
    const db = new Database(':memory:');
    // WIP v39 旧表：无 UNIQUE、user_id 可空，含重复与 NULL 数据
    db.exec(`
      CREATE TABLE user_feedback (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
        user_id TEXT, username TEXT, feedback_type TEXT NOT NULL,
        user_message TEXT, ai_response TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_feedback_message ON user_feedback(message_id);
      CREATE INDEX idx_feedback_user ON user_feedback(user_id);
      CREATE INDEX idx_feedback_created ON user_feedback(created_at);
      INSERT INTO user_feedback VALUES
        ('a','m1','c1','u1',NULL,'like',NULL,NULL,'2026-06-01T00:00:00Z'),
        ('b','m1','c1','u1',NULL,'dislike',NULL,NULL,'2026-06-02T00:00:00Z'),
        ('c','m2','c1',NULL,NULL,'like',NULL,NULL,'2026-06-03T00:00:00Z'),
        ('d','m2','c1',NULL,NULL,'like',NULL,NULL,'2026-06-04T00:00:00Z');
    `);

    // v40 迁移（与 src/db.ts initDatabase 中的 SQL 一致）
    db.exec(`
      DROP INDEX IF EXISTS idx_feedback_message;
      DROP INDEX IF EXISTS idx_feedback_user;
      DROP INDEX IF EXISTS idx_feedback_created;
      ALTER TABLE user_feedback RENAME TO user_feedback_v39;
    `);
    db.exec(CREATE_V40);
    db.exec(`
      INSERT OR IGNORE INTO user_feedback
        (id, message_id, chat_jid, user_id, username, feedback_type, user_message, ai_response, created_at)
      SELECT id, message_id, chat_jid, COALESCE(user_id, ''), username, feedback_type, user_message, ai_response, created_at
      FROM user_feedback_v39
      ORDER BY created_at DESC;
      DROP TABLE user_feedback_v39;
    `);

    const rows = db
      .prepare('SELECT message_id, user_id, feedback_type, created_at FROM user_feedback ORDER BY message_id')
      .all() as Array<{ message_id: string; user_id: string; feedback_type: string; created_at: string }>;
    expect(rows).toHaveLength(2);
    // m1：保留最新的 dislike
    expect(rows[0]).toMatchObject({ message_id: 'm1', user_id: 'u1', feedback_type: 'dislike' });
    // m2：匿名 NULL 归一为 ''，去重保留最新
    expect(rows[1]).toMatchObject({ message_id: 'm2', user_id: '', created_at: '2026-06-04T00:00:00Z' });
    db.close();
  });
});

describe('storeUserFeedback upsert semantics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(CREATE_V40);
  });

  test('switching vote updates in place — stats only ever see the latest', () => {
    upsert(db, { id: 'x1', messageId: 'm1', userId: 'u1', feedbackType: 'like', createdAt: '2026-06-10T00:00:00Z' });
    upsert(db, { id: 'x2', messageId: 'm1', userId: 'u1', feedbackType: 'dislike', createdAt: '2026-06-10T00:01:00Z' });

    const rows = db.prepare("SELECT id, feedback_type, created_at FROM user_feedback WHERE message_id='m1'").all() as Array<{
      id: string;
      feedback_type: string;
      created_at: string;
    }>;
    expect(rows).toHaveLength(1);
    // 原地更新：保留首次插入的行 id，类型与时间为最新
    expect(rows[0]).toMatchObject({ id: 'x1', feedback_type: 'dislike', created_at: '2026-06-10T00:01:00Z' });

    const byType = db
      .prepare('SELECT feedback_type, COUNT(*) as count FROM user_feedback GROUP BY feedback_type')
      .all() as Array<{ feedback_type: string; count: number }>;
    expect(byType).toEqual([{ feedback_type: 'dislike', count: 1 }]);
  });

  test('different users vote independently on the same message', () => {
    upsert(db, { id: 'x1', messageId: 'm1', userId: 'u1', feedbackType: 'like', createdAt: '2026-06-10T00:00:00Z' });
    upsert(db, { id: 'x2', messageId: 'm1', userId: 'u2', feedbackType: 'dislike', createdAt: '2026-06-10T00:01:00Z' });
    const count = db.prepare('SELECT COUNT(*) as c FROM user_feedback').get() as { c: number };
    expect(count.c).toBe(2);
  });

  test('anonymous feedback (empty user_id) also dedupes per message', () => {
    upsert(db, { id: 'x1', messageId: 'm1', feedbackType: 'like', createdAt: '2026-06-10T00:00:00Z' });
    upsert(db, { id: 'x2', messageId: 'm1', feedbackType: 'dislike', createdAt: '2026-06-10T00:01:00Z' });
    const rows = db.prepare('SELECT feedback_type FROM user_feedback').all() as Array<{ feedback_type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].feedback_type).toBe('dislike');
  });

  test('same user voting on different messages keeps separate rows', () => {
    upsert(db, { id: 'x1', messageId: 'm1', userId: 'u1', feedbackType: 'like', createdAt: '2026-06-10T00:00:00Z' });
    upsert(db, { id: 'x2', messageId: 'm2', userId: 'u1', feedbackType: 'like', createdAt: '2026-06-10T00:01:00Z' });
    const count = db.prepare('SELECT COUNT(*) as c FROM user_feedback').get() as { c: number };
    expect(count.c).toBe(2);
  });
});
