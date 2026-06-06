import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getUserFeedbackByMessageId } from '../db.js';
import type { User } from '../types.js';
import Database from '../sqlite-compat.js';
import path from 'path';
import fs from 'fs';
import { STORE_DIR } from '../config.js';

// 直接访问数据库用于统计查询
const dbPath = path.join(STORE_DIR, 'messages.db');

// 确保数据库目录存在
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

const app = new Hono<{
  Variables: {
    user: User;
  };
}>();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

/**
 * Get user feedback statistics and recent records
 */
app.get('/stats', (c) => {
  try {
    // Total feedback count
    const totalCount = db
      .prepare('SELECT COUNT(*) as count FROM user_feedback')
      .get() as { count: number };

    // Count by type
    const byType = db
      .prepare(
        'SELECT feedback_type, COUNT(*) as count FROM user_feedback GROUP BY feedback_type',
      )
      .all() as Array<{ feedback_type: string; count: number }>;

    // Count by user
    const byUser = db
      .prepare(
        `SELECT user_id, username, COUNT(*) as count
         FROM user_feedback
         WHERE user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all() as Array<{ user_id: string; username: string | null; count: number }>;

    // Count by chat
    const byChat = db
      .prepare(
        `SELECT chat_jid, COUNT(*) as count
         FROM user_feedback
         GROUP BY chat_jid
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all() as Array<{ chat_jid: string; count: number }>;

    // Daily trend (last 30 days)
    const dailyTrend = db
      .prepare(
        `SELECT
           DATE(created_at) as date,
           feedback_type,
           COUNT(*) as count
         FROM user_feedback
         WHERE created_at >= datetime('now', '-30 days')
         GROUP BY DATE(created_at), feedback_type
         ORDER BY date DESC`,
      )
      .all() as Array<{ date: string; feedback_type: string; count: number }>;

    return c.json({
      total: totalCount.count,
      byType,
      byUser,
      byChat,
      dailyTrend,
    });
  } catch (err) {
    console.error('Failed to get feedback stats:', err);
    return c.json({ error: 'Failed to get feedback stats' }, 500);
  }
});

/**
 * Get paginated feedback list
 */
app.get('/list', (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const pageSize = parseInt(c.req.query('pageSize') || '20', 10);
    const feedbackType = c.req.query('feedbackType'); // 'like' | 'dislike' | undefined
    const offset = (page - 1) * pageSize;

    let query = `SELECT
      id, message_id, chat_jid, user_id, username, feedback_type,
      substr(user_message, 1, 100) as user_message_preview,
      substr(ai_response, 1, 100) as ai_response_preview,
      created_at
    FROM user_feedback`;

    const params: any[] = [];

    if (feedbackType) {
      query += ' WHERE feedback_type = ?';
      params.push(feedbackType);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(pageSize, offset);

    const records = db.prepare(query).all(...params) as Array<{
      id: string;
      message_id: string;
      chat_jid: string;
      user_id: string | null;
      username: string | null;
      feedback_type: string;
      user_message_preview: string | null;
      ai_response_preview: string | null;
      created_at: string;
    }>;

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM user_feedback';
    const countParams: any[] = [];
    if (feedbackType) {
      countQuery += ' WHERE feedback_type = ?';
      countParams.push(feedbackType);
    }
    const totalCount = db.prepare(countQuery).get(...countParams) as { count: number };

    return c.json({
      records,
      total: totalCount.count,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount.count / pageSize),
    });
  } catch (err) {
    console.error('Failed to get feedback list:', err);
    return c.json({ error: 'Failed to get feedback list' }, 500);
  }
});

/**
 * Get feedback detail by ID
 */
app.get('/:id', (c) => {
  try {
    const id = c.req.param('id');
    const feedback = db
      .prepare(
        `SELECT * FROM user_feedback WHERE id = ?`,
      )
      .get(id) as {
      id: string;
      message_id: string;
      chat_jid: string;
      user_id: string | null;
      username: string | null;
      feedback_type: string;
      user_message: string | null;
      ai_response: string | null;
      created_at: string;
    } | undefined;

    if (!feedback) {
      return c.json({ error: 'Feedback not found' }, 404);
    }

    return c.json(feedback);
  } catch (err) {
    console.error('Failed to get feedback detail:', err);
    return c.json({ error: 'Failed to get feedback detail' }, 500);
  }
});

export default app;
