import { Hono } from 'hono';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  getUserFeedbackStats,
  getUserFeedbackList,
  getUserFeedbackById,
} from '../db.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';

const app = new Hono<{
  Variables: {
    user: User;
  };
}>();

app.use('*', authMiddleware);
app.use('*', requirePermission('view_audit_log'));

app.get('/stats', (c) => {
  try {
    const stats = getUserFeedbackStats();
    return c.json(stats);
  } catch (err) {
    logger.error({ err }, 'Failed to get feedback stats');
    return c.json({ error: 'Failed to get feedback stats' }, 500);
  }
});

app.get('/list', (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
    const rawType = c.req.query('feedbackType');
    const feedbackType =
      rawType === 'like' || rawType === 'dislike' ? rawType : undefined;

    const result = getUserFeedbackList({ page, pageSize, feedbackType });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, 'Failed to get feedback list');
    return c.json({ error: 'Failed to get feedback list' }, 500);
  }
});

app.get('/:id', (c) => {
  try {
    const id = c.req.param('id');
    const feedback = getUserFeedbackById(id);

    if (!feedback) {
      return c.json({ error: 'Feedback not found' }, 404);
    }

    return c.json(feedback);
  } catch (err) {
    logger.error({ err }, 'Failed to get feedback detail');
    return c.json({ error: 'Failed to get feedback detail' }, 500);
  }
});

export default app;
