import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { canAccessGroup } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getTokenUsageStats,
  getTokenUsageSummary,
  getAllRegisteredGroups,
  getAllChats,
} from '../db.js';
import type { AuthUser } from '../types.js';

const usage = new Hono<{ Variables: Variables }>();

usage.use('*', authMiddleware);

/**
 * Get the list of chat JIDs that the user can access.
 * Admin sees all; member sees only their accessible groups.
 */
function getAccessibleChatJids(user: AuthUser): string[] | undefined {
  // Admin sees all stats (no filter)
  if (user.role === 'admin') return undefined;

  const groups = getAllRegisteredGroups();
  const chats = getAllChats();
  const accessibleJids: string[] = [];

  for (const chat of chats) {
    const group = groups[chat.jid];
    if (
      group &&
      canAccessGroup(
        { id: user.id, role: user.role },
        { ...group, jid: chat.jid },
      )
    ) {
      accessibleJids.push(chat.jid);
    }
  }

  return accessibleJids;
}

/**
 * GET /api/usage/stats?days=7
 * Returns aggregated token usage statistics.
 * Admin: all stats. Member: only accessible workspaces.
 */
usage.get('/stats', (c) => {
  const user = c.get('user') as AuthUser;
  const daysParam = c.req.query('days');
  const days = daysParam
    ? Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365)
    : 7;

  const chatJids = getAccessibleChatJids(user);

  // If non-admin has no accessible groups, return empty stats
  if (chatJids && chatJids.length === 0) {
    return c.json({
      summary: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUSD: 0,
        totalMessages: 0,
        totalActiveDays: 0,
      },
      breakdown: [],
      days,
    });
  }

  const summary = getTokenUsageSummary(days, chatJids);
  const breakdown = getTokenUsageStats(days, chatJids);

  return c.json({ summary, breakdown, days });
});

export { usage };
