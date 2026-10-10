import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUsageAnalytics,
  getUsageAttributions,
  getUsageDataVersion,
  getUsageDateWindow,
  getUserById,
  getUsageModelsForFilters,
  getUsageRecordsPage,
  getUsageUsers,
  type UsageQueryFilters,
} from '../db.js';
import type { AuthUser } from '../types.js';
import { isBillingEnabled } from '../billing.js';
import { VersionedTtlCache } from '../versioned-ttl-cache.js';

const usage = new Hono<{ Variables: Variables }>();
usage.use('*', authMiddleware);

function resolveUserId(
  user: AuthUser,
  requestedUserId?: string,
): string | undefined {
  return user.role === 'admin' ? requestedUserId || undefined : user.id;
}

function parseDays(raw?: string): number {
  return Math.min(Math.max(parseInt(raw || '7', 10) || 7, 1), 365);
}

function isDate(value?: string): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function queryContext(
  c: any,
  user: AuthUser,
): {
  window: ReturnType<typeof getUsageDateWindow>;
  filters: UsageQueryFilters;
} {
  const days = parseDays(c.req.query('days'));
  const defaultWindow = getUsageDateWindow(days);
  const requestedFrom = c.req.query('from');
  const requestedTo = c.req.query('to');
  if (Boolean(requestedFrom) !== Boolean(requestedTo)) {
    throw new HTTPException(400, {
      message: 'from and to must be provided together',
    });
  }
  if (requestedFrom && !isDate(requestedFrom)) {
    throw new HTTPException(400, {
      message: 'Invalid from date; expected YYYY-MM-DD',
    });
  }
  if (requestedTo && !isDate(requestedTo)) {
    throw new HTTPException(400, {
      message: 'Invalid to date; expected YYYY-MM-DD',
    });
  }
  const from = isDate(requestedFrom) ? requestedFrom : defaultWindow.from;
  const to = isDate(requestedTo) ? requestedTo : defaultWindow.to;
  if (from > to) {
    throw new HTTPException(400, { message: 'from must be on or before to' });
  }
  const explicitDays =
    requestedFrom || requestedTo
      ? Math.floor(
          (new Date(`${to}T00:00:00.000Z`).getTime() -
            new Date(`${from}T00:00:00.000Z`).getTime()) /
            86_400_000,
        ) + 1
      : defaultWindow.days;
  if (explicitDays > 365) {
    throw new HTTPException(400, {
      message: 'Usage date range cannot exceed 365 days',
    });
  }
  const window = { ...defaultWindow, from, to, days: explicitDays };
  return {
    window,
    filters: {
      from,
      to,
      userId: resolveUserId(user, c.req.query('userId') || undefined),
      model: c.req.query('model') || undefined,
      agentId: c.req.query('agentId') || undefined,
      groupFolder: c.req.query('groupFolder') || undefined,
      source: c.req.query('source') || undefined,
    },
  };
}

// Usage pages re-request identical windows (stats + filters on every visit
// and filter change); each run of the aggregates took 0.1-0.5s of
// synchronous SQLite work at 50k records. Results are keyed by the effective
// filters, which already carry the member's own userId, and are reused only
// while usage_records is unchanged. Breakdown rows dominate the size (a
// 90-day window can be ~30k rows, ~9MB), so the cache holds at most
// MAX_CACHED_BREAKDOWN_ROWS of them in total; larger results are recomputed.
const MAX_CACHED_BREAKDOWN_ROWS = 20_000;
const analyticsCache = new VersionedTtlCache<
  ReturnType<typeof getUsageAnalytics>
>({
  maxEntries: 16,
  maxAgeMs: 60_000,
  staleGraceMs: 0,
  maxWeight: MAX_CACHED_BREAKDOWN_ROWS,
  weigh: (data) => data.breakdown.length,
});
const attributionsCache = new VersionedTtlCache<
  ReturnType<typeof getUsageAttributions>
>({ maxEntries: 32, maxAgeMs: 60_000, staleGraceMs: 0 });

/** Test hook: drop cached aggregates. */
export function clearUsageAnalyticsCache(): void {
  analyticsCache.clear();
  attributionsCache.clear();
}

/**
 * `breakdown=none` skips the per-(date, model, user, agent, workspace,
 * source) rows, the bulk of the payload (9MB for 90 days of 50k records).
 * They stay included by default because older clients derive summary token
 * totals from them.
 */
function wantsBreakdown(c: any): boolean {
  const raw = (c.req.query('breakdown') || '').trim().toLowerCase();
  return !(raw === 'none' || raw === '0' || raw === 'false');
}

function cachedAnalytics(
  filters: UsageQueryFilters,
  includeBreakdown: boolean,
): ReturnType<typeof getUsageAnalytics> {
  const version = getUsageDataVersion();
  const key = JSON.stringify([filters, includeBreakdown]);
  const cached = analyticsCache.get(key, version);
  if (cached) return cached;
  const data = getUsageAnalytics(filters, { includeBreakdown });
  analyticsCache.set(key, version, data);
  return data;
}

usage.get('/stats', (c) => {
  const user = c.get('user') as AuthUser;
  const { window, filters } = queryContext(c, user);
  const data = cachedAnalytics(filters, wantsBreakdown(c));
  const summary = {
    ...data.summary,
    // Backwards-compatible aliases. totalMessages now has the precise
    // semantics of logical Agent runs, never per-model database rows.
    totalInputTokens: data.summary.inputTokens,
    totalOutputTokens: data.summary.outputTokens,
    totalCacheReadTokens: data.summary.cacheReadTokens,
    totalCacheCreationTokens: data.summary.cacheCreationTokens,
    totalReasoningTokens: data.summary.reasoningTokens,
    totalCostUSD: data.summary.providerEstimatedCostUSD,
    totalMessages: data.summary.runCount,
    totalActiveDays: data.summary.activeDays,
  };
  const billingEnabled = isBillingEnabled();
  const billingApplicable = (() => {
    if (!billingEnabled) return false;
    if (user.role !== 'admin') return true;
    if (!filters.userId) return true;
    if (filters.userId === user.id) return false;
    return getUserById(filters.userId)?.role === 'member';
  })();
  return c.json({
    window,
    generatedAt: new Date().toISOString(),
    billing: {
      enabled: billingEnabled,
      applicable: billingApplicable,
      providerCostSemantics: 'kaboo-utc-30m-rounded-estimate',
      billedCostSemantics: 'actual-charge',
    },
    scope: {
      userId: filters.userId || null,
      model: filters.model || null,
      agentId: filters.agentId || null,
      groupFolder: filters.groupFolder || null,
      source: filters.source || null,
    },
    summary,
    breakdown: data.breakdown,
    daily: data.daily,
    attributions: data.attributions,
    days: window.days,
    dataRange: {
      from: window.from,
      to: window.to,
      activeDays: data.summary.activeDays,
    },
  });
});

usage.get('/models', (c) => {
  const user = c.get('user') as AuthUser;
  const { filters } = queryContext(c, user);
  return c.json({ models: getUsageModelsForFilters(filters) });
});

usage.get('/filters', (c) => {
  const user = c.get('user') as AuthUser;
  const { window, filters } = queryContext(c, user);
  // Only the attribution lists: the full analytics (summary, daily buckets,
  // breakdown) was recomputed here just to be thrown away.
  const version = getUsageDataVersion();
  const key = JSON.stringify(filters);
  let attributions =
    attributionsCache.get(key, version) ??
    // The page loads /stats with the same filters; reuse its attributions.
    analyticsCache.get(JSON.stringify([filters, false]), version)
      ?.attributions ??
    analyticsCache.get(JSON.stringify([filters, true]), version)?.attributions;
  if (!attributions) {
    attributions = getUsageAttributions(filters);
    attributionsCache.set(key, version, attributions);
  }
  return c.json({ window, ...attributions });
});

usage.get('/records', (c) => {
  const user = c.get('user') as AuthUser;
  const { window, filters } = queryContext(c, user);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(
    Math.max(1, parseInt(c.req.query('pageSize') || '50', 10) || 50),
    500,
  );
  const result = getUsageRecordsPage(filters, page, pageSize);
  return c.json({
    ...result,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
    window,
  });
});

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Spreadsheet applications interpret these prefixes as formulas. Prefixing
  // a quote preserves the visible text and prevents CSV injection.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

usage.get('/export.csv', (c) => {
  const user = c.get('user') as AuthUser;
  const { window, filters } = queryContext(c, user);
  const count = getUsageRecordsPage(filters, 1, 1).total;
  const exportLimit = 10_000;
  if (count > exportLimit) {
    throw new HTTPException(413, {
      message: `Export contains ${count} rows; narrow filters below ${exportLimit} rows`,
    });
  }
  const result = getUsageRecordsPage(filters, 1, Math.max(1, count));
  const columns = [
    'eventId',
    'createdAt',
    'userId',
    'agentId',
    'groupFolder',
    'source',
    'model',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'reasoningTokens',
    'providerEstimatedCostUSD',
    'billedCostUSD',
    'durationMs',
    'numTurns',
    'messageId',
  ];
  const csv = [
    columns.join(','),
    ...result.records.map((row) =>
      columns.map((column) => csvCell(row[column])).join(','),
    ),
  ].join('\r\n');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header(
    'Content-Disposition',
    `attachment; filename="happyclaw-usage-${window.from}-${window.to}.csv"`,
  );
  return c.body(`\uFEFF${csv}`);
});

usage.get('/users', (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ users: [{ id: user.id, username: user.username }] });
  }
  return c.json({ users: getUsageUsers() });
});

export { usage };
