import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-usage-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
}));

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.USAGE_TEST_USER || 'user-a',
      username: process.env.USAGE_TEST_USER || 'user-a',
      role: process.env.USAGE_TEST_ROLE || 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const { usage, clearUsageAnalyticsCache } =
  await import('../src/routes/usage.js');

const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

function seed(eventId: string, userId: string, model: string): void {
  db.recordUsageEventBatch({
    eventId,
    userId,
    groupFolder: `workspace-${userId}`,
    agentId: `agent-${userId}`,
    source: 'custom-agent',
    createdAt: `${today}T12:00:00.000Z`,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
    providerEstimatedCostUSD: 0.2,
    billedCostUSD: 0.1,
    models: [
      {
        model,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        providerEstimatedCostUSD: 0.2,
        billedCostUSD: 0.1,
      },
    ],
  });
}

beforeAll(() => {
  db.initDatabase();
  seed('event-user-a', 'user-a', 'private-model-a');
  seed('event-user-b', 'user-b', 'private-model-b');
  db.recordUsageEventBatch({
    eventId: 'main-agent-event',
    userId: 'main-user',
    groupFolder: 'main-workspace',
    agentId: null,
    source: 'main-agent',
    createdAt: `${today}T12:00:00.000Z`,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    providerEstimatedCostUSD: 0,
    billedCostUSD: 0,
    models: [
      {
        model: 'main-model',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        providerEstimatedCostUSD: 0,
        billedCostUSD: 0,
      },
    ],
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/api/usage contract and isolation', () => {
  test('member stats ignore a requested foreign user and expose precise aliases', async () => {
    process.env.USAGE_TEST_USER = 'user-a';
    process.env.USAGE_TEST_ROLE = 'member';
    const response = await usage.request(
      `/stats?from=${today}&to=${today}&userId=user-b`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.window).toMatchObject({ from: today, to: today, days: 1 });
    expect(body.scope.userId).toBe('user-a');
    expect(body.billing).toMatchObject({ enabled: true, applicable: true });
    expect(body.summary).toMatchObject({
      runCount: 1,
      modelCallCount: 1,
      totalMessages: 1,
      totalTokens: 18,
      providerEstimatedCostUSD: 0.2,
      billedCostUSD: 0.1,
    });
    expect(body.breakdown).toHaveLength(1);
    expect(body.breakdown[0].model).toBe('private-model-a');
  });

  test('member model options never expose another user models', async () => {
    process.env.USAGE_TEST_USER = 'user-a';
    process.env.USAGE_TEST_ROLE = 'member';
    const response = await usage.request(
      `/models?from=${today}&to=${today}&userId=user-b&role=admin`,
    );
    expect(await response.json()).toEqual({ models: ['private-model-a'] });
  });

  test('member filter options and user picker remain self-scoped', async () => {
    process.env.USAGE_TEST_USER = 'user-a';
    process.env.USAGE_TEST_ROLE = 'member';

    const filters = await usage.request(
      `/filters?from=${today}&to=${today}&userId=user-b`,
    );
    const filterBody = await filters.json();
    expect(filterBody.models).toEqual([
      expect.objectContaining({ key: 'private-model-a' }),
    ]);
    expect(filterBody.agents).toEqual([
      expect.objectContaining({ key: 'agent-user-a' }),
    ]);
    expect(filterBody.workspaces).toEqual([
      expect.objectContaining({ key: 'workspace-user-a' }),
    ]);
    expect(JSON.stringify(filterBody)).not.toContain('user-b');

    const users = await usage.request('/users');
    expect(await users.json()).toEqual({
      users: [{ id: 'user-a', username: 'user-a' }],
    });
  });

  test('member cannot use a foreign workspace or agent filter as an oracle', async () => {
    process.env.USAGE_TEST_USER = 'user-a';
    process.env.USAGE_TEST_ROLE = 'member';

    const response = await usage.request(
      `/stats?from=${today}&to=${today}&userId=user-b&groupFolder=workspace-user-b&agentId=agent-user-b`,
    );
    const body = await response.json();
    expect(body.scope).toMatchObject({
      userId: 'user-a',
      groupFolder: 'workspace-user-b',
      agentId: 'agent-user-b',
    });
    expect(body.summary).toMatchObject({
      totalTokens: 0,
      runCount: 0,
      modelCallCount: 0,
    });
    expect(body.breakdown).toEqual([]);
    expect(body.daily).toEqual([]);
  });

  test('main HappyClaw attribution has a filterable stable sentinel', async () => {
    process.env.USAGE_TEST_USER = 'main-user';
    process.env.USAGE_TEST_ROLE = 'member';
    const stats = await usage.request(
      `/stats?from=${today}&to=${today}&agentId=__main__`,
    );
    const body = await stats.json();
    expect(body.summary.runCount).toBe(1);
    expect(body.attributions.agents).toEqual([
      expect.objectContaining({ key: '__main__', name: 'HappyClaw' }),
    ]);
  });

  test('admin can aggregate all users and filter attribution dimensions', async () => {
    process.env.USAGE_TEST_USER = 'admin';
    process.env.USAGE_TEST_ROLE = 'admin';
    const response = await usage.request(`/stats?from=${today}&to=${today}`);
    const body = await response.json();
    expect(body.summary).toMatchObject({ runCount: 3, modelCallCount: 3 });
    expect(body.billing.applicable).toBe(true);
    expect(body.attributions.models.map((item: any) => item.key)).toEqual([
      'private-model-a',
      'private-model-b',
      'main-model',
    ]);
  });

  test('admin can deliberately scope every usage endpoint to another user', async () => {
    process.env.USAGE_TEST_USER = 'admin';
    process.env.USAGE_TEST_ROLE = 'admin';
    const query = `from=${today}&to=${today}&userId=user-b`;

    const stats = await usage.request(`/stats?${query}`);
    const statsBody = await stats.json();
    expect(statsBody.scope.userId).toBe('user-b');
    expect(statsBody.summary.runCount).toBe(1);
    expect(statsBody.breakdown).toEqual([
      expect.objectContaining({
        user_id: 'user-b',
        model: 'private-model-b',
      }),
    ]);

    const models = await usage.request(`/models?${query}`);
    expect(await models.json()).toEqual({ models: ['private-model-b'] });

    const records = await usage.request(`/records?${query}`);
    const recordsBody = await records.json();
    expect(recordsBody.total).toBe(1);
    expect(recordsBody.records).toEqual([
      expect.objectContaining({
        userId: 'user-b',
        model: 'private-model-b',
      }),
    ]);
  });

  test('admin self scope marks billed cost as not applicable', async () => {
    process.env.USAGE_TEST_USER = 'admin';
    process.env.USAGE_TEST_ROLE = 'admin';
    const response = await usage.request(
      `/stats?from=${today}&to=${today}&userId=admin`,
    );
    expect((await response.json()).billing).toMatchObject({
      enabled: true,
      applicable: false,
    });
  });

  test('records and CSV ignore a member-supplied foreign userId', async () => {
    process.env.USAGE_TEST_USER = 'user-a';
    process.env.USAGE_TEST_ROLE = 'member';
    const records = await usage.request(
      `/records?from=${today}&to=${today}&userId=user-b&page=1&pageSize=1`,
    );
    const recordsBody = await records.json();
    expect(recordsBody).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1,
    });
    expect(recordsBody.records).toEqual([
      expect.objectContaining({
        userId: 'user-a',
        model: 'private-model-a',
      }),
    ]);

    const csv = await usage.request(
      `/export.csv?from=${today}&to=${today}&userId=user-b`,
    );
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('private-model-a');
    expect(text).not.toContain('private-model-b');
  });

  test('rejects invalid or reversed explicit date ranges', async () => {
    expect((await usage.request('/stats?from=2026-02-30')).status).toBe(400);
    expect(
      (await usage.request('/stats?from=2026-07-16&to=2026-07-10')).status,
    ).toBe(400);
    expect(
      (await usage.request('/stats?from=2025-01-01&to=2026-07-16')).status,
    ).toBe(400);
  });

  test('CSV export does not silently truncate at the JSON page limit', async () => {
    for (let index = 0; index < 501; index++) {
      seed(`bulk-${index}`, 'bulk-user', 'bulk-model');
    }
    process.env.USAGE_TEST_USER = 'bulk-user';
    process.env.USAGE_TEST_ROLE = 'member';
    const csv = await usage.request(`/export.csv?from=${today}&to=${today}`);
    const lines = (await csv.text()).split('\r\n');
    expect(lines).toHaveLength(502);
  });

  test('CSV export neutralizes spreadsheet formulas', async () => {
    seed('formula-event', 'formula-user', '=HYPERLINK("https://invalid")');
    process.env.USAGE_TEST_USER = 'formula-user';
    process.env.USAGE_TEST_ROLE = 'member';
    const csv = await usage.request(`/export.csv?from=${today}&to=${today}`);
    expect(await csv.text()).toContain(`"'=HYPERLINK(""https://invalid"")"`);
  });
});

describe('/api/usage payload and caching', () => {
  test('breakdown=none drops only the breakdown rows', async () => {
    process.env.USAGE_TEST_USER = 'admin-user';
    process.env.USAGE_TEST_ROLE = 'admin';
    clearUsageAnalyticsCache();
    const full = await (
      await usage.request(`/stats?from=${today}&to=${today}`)
    ).json();
    const light = await (
      await usage.request(`/stats?from=${today}&to=${today}&breakdown=none`)
    ).json();
    expect(full.breakdown.length).toBeGreaterThan(0);
    expect(light.breakdown).toEqual([]);
    const { generatedAt: _a, breakdown: _b, ...fullRest } = full;
    const { generatedAt: _c, breakdown: _d, ...lightRest } = light;
    expect(lightRest).toEqual(fullRest);
  });

  test('filters return exactly the stats attributions', async () => {
    process.env.USAGE_TEST_USER = 'admin-user';
    process.env.USAGE_TEST_ROLE = 'admin';
    clearUsageAnalyticsCache();
    const filters = await (
      await usage.request(`/filters?from=${today}&to=${today}`)
    ).json();
    const stats = await (
      await usage.request(`/stats?from=${today}&to=${today}`)
    ).json();
    expect({
      models: filters.models,
      agents: filters.agents,
      workspaces: filters.workspaces,
      sources: filters.sources,
    }).toEqual(stats.attributions);
    expect(db.getUsageAttributions({ from: today, to: today })).toEqual(
      db.getUsageAnalytics({ from: today, to: today }).attributions,
    );
  });

  test('cached aggregates are recomputed as soon as usage changes', async () => {
    process.env.USAGE_TEST_USER = 'cache-user';
    process.env.USAGE_TEST_ROLE = 'member';
    clearUsageAnalyticsCache();
    seed('cache-event-1', 'cache-user', 'cache-model');
    const first = await (
      await usage.request(`/stats?from=${today}&to=${today}&breakdown=none`)
    ).json();
    expect(first.summary.runCount).toBe(1);
    const again = await (
      await usage.request(`/stats?from=${today}&to=${today}&breakdown=none`)
    ).json();
    expect(again.summary).toEqual(first.summary);
    seed('cache-event-2', 'cache-user', 'cache-model');
    const after = await (
      await usage.request(`/stats?from=${today}&to=${today}&breakdown=none`)
    ).json();
    expect(after.summary.runCount).toBe(2);
    const filtersAfter = await (
      await usage.request(`/filters?from=${today}&to=${today}`)
    ).json();
    expect(filtersAfter.models[0].runCount).toBe(2);
  });
});

describe('usage records ordering', () => {
  test('pages stay newest-first by created_at across usage dates', () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const [eventId, createdAt] of [
      ['order-old', `${ymd(yesterday)}T08:00:00.000Z`],
      ['order-new', `${today}T13:00:00.000Z`],
      ['order-mid', `${today}T12:30:00.000Z`],
    ] as const) {
      db.recordUsageEventBatch({
        eventId,
        userId: 'order-user',
        groupFolder: 'order-ws',
        agentId: null,
        source: 'main-agent',
        createdAt,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        providerEstimatedCostUSD: 0,
        billedCostUSD: 0,
        models: [
          {
            model: 'order-model',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            providerEstimatedCostUSD: 0,
            billedCostUSD: 0,
          },
        ],
      });
    }
    const page = db.getUsageRecordsPage(
      { from: ymd(yesterday), to: today, userId: 'order-user' },
      1,
      10,
    );
    const created = page.records.map((r) => String(r.createdAt));
    expect(created).toEqual([...created].sort().reverse());
    expect(page.records.map((r) => r.eventId)).toEqual([
      'order-new',
      'order-mid',
      'order-old',
    ]);
  });
});
