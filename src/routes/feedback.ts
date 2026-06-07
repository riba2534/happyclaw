import { Hono } from 'hono';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  getUserFeedbackStats,
  getUserFeedbackList,
  getUserFeedbackById,
} from '../db.js';
import type { User } from '../types.js';

const app = new Hono<{
  Variables: {
    user: User;
  };
}>();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// Require view_audit_log permission for all feedback routes
// (feedback data contains user information and should be protected)
app.use('*', requirePermission('view_audit_log'));

/**
 * Get user feedback statistics and recent records
 */
app.get('/stats', (c) => {
  try {
    const stats = getUserFeedbackStats();
    return c.json(stats);
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
    const feedbackType = c.req.query('feedbackType') as
      | 'like'
      | 'dislike'
      | undefined;

    const result = getUserFeedbackList({
      page,
      pageSize,
      feedbackType,
    });

    return c.json(result);
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
    const feedback = getUserFeedbackById(id);

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
