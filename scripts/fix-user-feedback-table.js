#!/usr/bin/env node

/**
 * 修复 user_feedback 表的外键约束问题
 *
 * 问题：原表定义了外键约束 FOREIGN KEY (message_id) REFERENCES messages(id)
 * 但 messages 表的主键是复合主键 (id, chat_jid)，导致外键不匹配
 *
 * 解决：删除旧表，重新创建不带外键约束的表
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'db', 'messages.db');

console.log('正在修复 user_feedback 表...');
console.log('数据库路径:', dbPath);

const db = new Database(dbPath);

try {
  // 检查表是否存在
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_feedback'")
    .get();

  if (tableExists) {
    console.log('发现 user_feedback 表，正在删除...');
    db.exec('DROP TABLE IF EXISTS user_feedback');
    console.log('✓ 旧表已删除');
  } else {
    console.log('user_feedback 表不存在，无需删除');
  }

  // 重新创建表（不带外键约束）
  console.log('正在创建新的 user_feedback 表...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      feedback_type TEXT NOT NULL,
      user_message TEXT,
      ai_response TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_message ON user_feedback(message_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_user ON user_feedback(user_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON user_feedback(created_at);
  `);
  console.log('✓ 新表创建成功');

  // 更新 schema 版本
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', '39');
  console.log('✓ Schema 版本已更新到 v39');

  console.log('\n修复完成！现在可以重新启动服务了。');
} catch (err) {
  console.error('修复失败:', err);
  process.exit(1);
} finally {
  db.close();
}
