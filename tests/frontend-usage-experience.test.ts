import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../web/src/api/client', () => ({
  api: { get: apiMock.get },
}));

import {
  DEFAULT_QUERY,
  buildUsageQueryParams,
  normalizeUsageResponse,
  useUsageStore,
  type UsageQuery,
} from '../web/src/stores/usage';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function enhancedResponse(days: number, inputTokens: number) {
  const from = days === 30 ? '2026-06-17' : '2026-07-10';
  return {
    window: {
      from,
      to: '2026-07-16',
      days,
      timezone: 'Asia/Shanghai',
    },
    generatedAt: '2026-07-16T02:30:00.000Z',
    scope: {
      userId: null,
      model: null,
      agentId: null,
      groupFolder: null,
      source: null,
    },
    summary: {
      inputTokens,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      totalTokens: inputTokens + 9,
      providerEstimatedCostUSD: 1,
      billedCostUSD: 0,
      runCount: 1,
      modelCallCount: 1,
      activeDays: 1,
    },
    breakdown: [
      {
        date: '2026-07-16',
        model: 'model-a',
        user_id: 'user-a',
        agent_id: 'agent-a',
        group_folder: 'workspace-a',
        source: 'agent',
        input_tokens: inputTokens,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        provider_estimated_cost_usd: 1,
        billed_cost_usd: 0,
        run_count: 1,
        model_call_count: 1,
      },
    ],
    daily: [
      {
        date: '2026-07-16',
        input_tokens: inputTokens,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        provider_estimated_cost_usd: 1,
        billed_cost_usd: 0,
        run_count: 1,
        model_call_count: 1,
      },
    ],
    attributions: {
      models: [],
      agents: [],
      workspaces: [],
      sources: [],
    },
    billing: {
      enabled: false,
      applicable: false,
      providerCostSemantics: 'kaboo-utc-30m-rounded-estimate',
      billedCostSemantics: 'actual-charge',
    },
  };
}

describe('usage analytics frontend contract', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    useUsageStore.getState().reset();
  });

  test('trims the legacy inclusive off-by-one bucket and recomputes visible KPIs', () => {
    const normalized = normalizeUsageResponse(
      {
        days: 7,
        summary: {
          totalInputTokens: 1_010,
          totalOutputTokens: 12,
          totalCostUSD: 12,
          totalMessages: 3,
        },
        breakdown: [
          {
            date: '2026-07-09',
            model: 'legacy',
            input_tokens: 1_000,
            output_tokens: 10,
            cost_usd: 10,
            request_count: 1,
          },
          {
            date: '2026-07-10',
            model: 'legacy',
            input_tokens: 4,
            output_tokens: 1,
            cost_usd: 1,
            request_count: 1,
          },
          {
            date: '2026-07-16',
            model: 'legacy',
            input_tokens: 6,
            output_tokens: 1,
            cost_usd: 1,
            request_count: 1,
          },
        ],
      },
      DEFAULT_QUERY,
      new Date('2026-07-16T12:00:00+08:00'),
    );

    expect(normalized.window).toMatchObject({
      from: '2026-07-10',
      to: '2026-07-16',
      days: 7,
    });
    expect(normalized.breakdown.map((row) => row.date)).toEqual([
      '2026-07-10',
      '2026-07-16',
    ]);
    expect(normalized.summary).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      providerEstimatedCostUSD: 2,
      runCount: 2,
    });
  });

  test('takes windowed KPIs from the server summary without the row breakdown', async () => {
    const raw = enhancedResponse(7, 10);
    const normalized = normalizeUsageResponse(
      { ...raw, breakdown: [] },
      DEFAULT_QUERY,
      new Date('2026-07-16T12:00:00+08:00'),
    );
    expect(normalized.summary).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      totalTokens: 19,
      providerEstimatedCostUSD: 1,
      activeDays: 1,
    });

    apiMock.get.mockResolvedValue({ ...raw, breakdown: [] });
    await useUsageStore.getState().loadStats(DEFAULT_QUERY);
    expect(apiMock.get.mock.calls[0][0]).toContain('breakdown=none');
    expect(useUsageStore.getState().summary?.totalTokens).toBe(19);
  });

  test('keeps four token classes mutually exclusive and trusts de-duplicated run totals', () => {
    const raw = enhancedResponse(7, 10);
    raw.summary.runCount = 1;
    raw.summary.modelCallCount = 2;
    raw.breakdown.push({
      ...raw.breakdown[0],
      model: 'model-b',
      input_tokens: 5,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      provider_estimated_cost_usd: 0,
    });
    const normalized = normalizeUsageResponse(
      raw,
      DEFAULT_QUERY,
      new Date('2026-07-16T12:00:00+08:00'),
    );

    expect(normalized.summary.runCount).toBe(1);
    expect(normalized.summary.modelCallCount).toBe(2);
    expect(normalized.summary.totalTokens).toBe(
      normalized.summary.inputTokens +
        normalized.summary.cacheReadTokens +
        normalized.summary.cacheCreationTokens +
        normalized.summary.outputTokens,
    );
    expect(normalized.daily[0].runCount).toBe(1);
  });

  test('ignores a slower response after a newer filter request completes', async () => {
    const older = deferred<ReturnType<typeof enhancedResponse>>();
    const newer = deferred<ReturnType<typeof enhancedResponse>>();
    apiMock.get.mockImplementation((url: string) =>
      url.includes('days=30') ? newer.promise : older.promise,
    );
    const sevenDays: UsageQuery = { ...DEFAULT_QUERY };
    const thirtyDays: UsageQuery = { ...DEFAULT_QUERY, days: 30 };
    useUsageStore.getState().ensureOwner('owner-a');

    const olderRequest = useUsageStore.getState().loadStats(sevenDays);
    const newerRequest = useUsageStore.getState().loadStats(thirtyDays);
    newer.resolve(enhancedResponse(30, 30));
    await newerRequest;
    older.resolve(enhancedResponse(7, 7));
    await olderRequest;

    expect(useUsageStore.getState().window?.days).toBe(30);
    expect(useUsageStore.getState().summary?.inputTokens).toBe(30);
    expect(useUsageStore.getState().lastQueryKey).toContain('days=30');
  });

  test('reset invalidates in-flight responses and clears account-owned data', async () => {
    const pending = deferred<ReturnType<typeof enhancedResponse>>();
    apiMock.get.mockReturnValue(pending.promise);
    useUsageStore.getState().ensureOwner('owner-a');
    const request = useUsageStore.getState().loadStats(DEFAULT_QUERY);
    useUsageStore.getState().reset('owner-b');
    pending.resolve(enhancedResponse(7, 99));
    await request;

    expect(useUsageStore.getState()).toMatchObject({
      ownerUserId: 'owner-b',
      summary: null,
      breakdown: [],
      error: null,
    });
  });

  test('serializes every supported filter into a shareable query', () => {
    const params = buildUsageQueryParams({
      days: 30,
      userId: 'user/a',
      model: 'model long/name',
      agentId: 'agent-1',
      groupFolder: 'workspace folder',
      source: 'task',
    });
    expect(Object.fromEntries(params)).toEqual({
      days: '30',
      userId: 'user/a',
      model: 'model long/name',
      agentId: 'agent-1',
      groupFolder: 'workspace folder',
      source: 'task',
    });
  });

  test('keeps the main Agent filter key separate from its display name', () => {
    const response = enhancedResponse(7, 10);
    const normalized = normalizeUsageResponse(
      {
        ...response,
        attributions: {
          ...response.attributions,
          agents: [
            {
              key: '__main__',
              name: 'HappyClaw',
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 3,
              cacheCreationTokens: 4,
              totalTokens: 19,
              providerEstimatedCostUSD: 1,
              billedCostUSD: 0,
              runCount: 1,
              modelCallCount: 1,
            },
          ],
        },
      },
      DEFAULT_QUERY,
    );
    expect(normalized.attributions.agents[0]).toMatchObject({
      key: '__main__',
      name: 'HappyClaw',
    });
    expect(
      buildUsageQueryParams({ ...DEFAULT_QUERY, agentId: '__main__' }).get(
        'agentId',
      ),
    ).toBe('__main__');
  });
});

describe('usage page product and accessibility surface', () => {
  test('lazy-loads the Recharts route instead of importing it into the main bundle', () => {
    const app = read('web/src/App.tsx');
    expect(app).not.toContain("import { UsagePage } from './pages/UsagePage'");
    expect(app).toMatch(
      /const UsagePage = lazy\(\(\) =>[\s\S]*import\('\.\/pages\/UsagePage'\)/,
    );
    expect(app).toMatch(/path="\/usage"[\s\S]*<Suspense/);
    expect(app).toContain('fallback={<UsageRouteFallback />}');
    expect(app).toContain('正在加载用量分析');
  });

  test('exposes trustworthy metric names, states, filters, and accessible controls', () => {
    const page = read('web/src/pages/UsagePage.tsx');
    const auth = read('web/src/stores/auth.ts');
    expect(page).toMatch(/统计范围：|时区：|更新时间：/);
    expect(page).toMatch(
      /总 Token|智能体运行次数|模型估算费用 \(USD\)|平均每次成本/,
    );
    expect(page).toMatch(/普通输入|缓存读取|缓存写入|输出/);
    expect(page).toMatch(/统计用户|模型|智能体|工作区|来源/);
    expect(page).toMatch(/aria-busy=|aria-pressed=|role="alert"/);
    expect(page).toMatch(/用量数据加载失败|重试加载/);
    expect(page).toMatch(/当前筛选没有用量数据|开始一次对话/);
    expect(page).toContain('min-h-11');
    expect(page).toContain('overflow-x-auto');
    expect(page).toContain('导出 CSV');
    expect(page).toContain('账单扣费：不适用（未启用计费）');
    expect(page).toMatch(/visibleBilling\?\.applicable \?\? billingEnabled/);
    expect(page).toMatch(/exportError\.status === 404/);
    expect(page).toMatch(/exportError\.status === 413/);
    expect(page).toMatch(
      /Promise\.all\(\[loadStats\(query\), loadFilters\(query\)\]\)/,
    );
    expect(page).not.toMatch(/PieChart|<Pie|模型用量分布/);
    // Signing in or out resets the usage cache through the user-scope
    // registry, so auth never has to download the usage store to clear it.
    expect(auth).toContain('resetUserScopedStores()');
    expect(read('web/src/stores/usage.ts')).toContain(
      'registerUserScopedReset(() => useUsageStore.getState().reset())',
    );
  });
});
