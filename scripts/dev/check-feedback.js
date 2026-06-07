#!/usr/bin/env node

/**
 * 查看 user_feedback 表的最新数据
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data', 'db', 'messages.db');
const db = new Database(dbPath);

console.log('=== User Feedback 数据统计 ===\n');

// 总数
const total = db.prepare('SELECT COUNT(*) as count FROM user_feedback').get();
console.log(`总记录数: ${total.count}\n`);

// 按类型统计
const byType = db.prepare('SELECT feedback_type, COUNT(*) as count FROM user_feedback GROUP BY feedback_type').all();
console.log('按类型统计:');
byType.forEach(row => {
  console.log(`  ${row.feedback_type}: ${row.count}`);
});

console.log('\n=== 最新 5 条反馈记录 ===\n');

const latest = db.prepare(`
  SELECT
    id,
    message_id,
    chat_jid,
    user_id,
    username,
    feedback_type,
    CASE
      WHEN user_message IS NULL THEN '[空]'
      WHEN LENGTH(user_message) = 0 THEN '[空字符串]'
      ELSE SUBSTR(user_message, 1, 50) || '...'
    END as user_msg,
    CASE
      WHEN ai_response IS NULL THEN '[空]'
      WHEN LENGTH(ai_response) = 0 THEN '[空字符串]'
      ELSE SUBSTR(ai_response, 1, 50) || '...'
    END as ai_resp,
    created_at
  FROM user_feedback
  ORDER BY created_at DESC
  LIMIT 5
`).all();

latest.forEach((row, i) => {
  console.log(`记录 ${i + 1}:`);
  console.log(`  ID: ${row.id}`);
  console.log(`  Message ID: ${row.message_id}`);
  console.log(`  Chat JID: ${row.chat_jid}`);
  console.log(`  User ID: ${row.user_id || '[空]'}`);
  console.log(`  Username: ${row.username || '[空]'}`);
  console.log(`  Feedback Type: ${row.feedback_type}`);
  console.log(`  User Message: ${row.user_msg}`);
  console.log(`  AI Response: ${row.ai_resp}`);
  console.log(`  Created At: ${row.created_at}`);
  console.log('');
});

// 检查对应的消息是否存在
console.log('=== 检查消息是否存在于 messages 表 ===\n');

const messageIds = latest.map(r => r.message_id);
for (const msgId of messageIds) {
  const msg = db.prepare('SELECT id, chat_jid, is_from_me FROM messages WHERE id = ? LIMIT 1').get(msgId);
  if (msg) {
    console.log(`✓ ${msgId} 存在 (chat_jid: ${msg.chat_jid}, is_from_me: ${msg.is_from_me})`);
  } else {
    console.log(`✗ ${msgId} 不存在`);
  }
}

db.close();
