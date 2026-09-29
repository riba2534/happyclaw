import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { clampCodexEffortWithCatalog } from '../src/codex-gateway/model-catalog.js';
import {
  getResolvedCodexCatalog,
  initCodexCatalogSync,
  maybeRefreshCodexCatalog,
  parseUpstreamModelCatalog,
  refreshCodexCatalog,
  resetCodexCatalogSyncForTests,
  setCodexCatalogDiskCachePathForTests,
} from '../src/codex-gateway/model-catalog-sync.js';

/** 永不 resolve 的 fetch 桩：init 的后台刷新不触发真实网络、不产生迟到回调。 */
function neverSettleFetch(): Promise<Response> {
  return new Promise<Response>(() => {});
}

// 按真实上游 codex-rs/models-manager/models.json 的结构裁剪的 fixture。
const UPSTREAM_PAYLOAD = {
  models: [
    {
      slug: 'gpt-6-sol',
      display_name: 'GPT-6-Sol',
      description: 'Workhorse model for coding and everyday work.',
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Greater depth' },
        { effort: 'xhigh', description: 'Extra high' },
        { effort: 'max', description: 'Maximum' },
        { effort: 'ultra', description: 'Maximum with delegation' },
      ],
    },
    {
      slug: 'gpt-9-aurora',
      display_name: 'GPT-9 Aurora',
      description: 'Future flagship model.',
      visibility: 'list',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
        { effort: 'medium', description: 'Balanced' },
      ],
    },
    {
      slug: 'gpt-daybreak-red-latest',
      display_name: 'Daybreak Red',
      description: 'Cyber-permissive variant.',
      visibility: 'hide',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses' },
      ],
    },
    {
      slug: 'gpt-no-efforts',
      display_name: 'No Efforts',
      visibility: 'list',
      supported_reasoning_levels: [],
    },
  ],
};

function mockFetchWith(payload: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status }),
  ) as unknown as typeof fetch;
}

describe('Codex model catalog upstream sync', () => {
  afterEach(() => {
    resetCodexCatalogSyncForTests();
    setCodexCatalogDiskCachePathForTests(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('parses upstream payload: keeps list-visible models with efforts', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries.map((entry) => entry.value)).toEqual([
      'gpt-6-sol',
      'gpt-9-aurora',
    ]);
    const sol = entries[0];
    expect(sol.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  test('keeps curated label for known slugs, derives label for new models', () => {
    const entries = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    expect(entries[0].label).toBe('gpt-6-sol（主力编码）');
    expect(entries[1].label).toBe('gpt-9-aurora（GPT-9 Aurora）');
  });

  test('rejects malformed payloads', () => {
    expect(() => parseUpstreamModelCatalog(null)).toThrow();
    expect(() => parseUpstreamModelCatalog({})).toThrow();
    expect(() => parseUpstreamModelCatalog({ models: [] })).toThrow();
    expect(() =>
      parseUpstreamModelCatalog({
        models: [
          {
            slug: 'a',
            visibility: 'hide',
            supported_reasoning_levels: [{ effort: 'low' }],
          },
        ],
      }),
    ).toThrow();
  });

  test('refresh applies upstream catalog and reports upstream source', async () => {
    const fetchImpl = mockFetchWith(UPSTREAM_PAYLOAD);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(true);
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('upstream');
    expect(resolved.models.map((entry) => entry.value)).toContain(
      'gpt-9-aurora',
    );
  });

  test('failed refresh keeps the current catalog', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = mockFetchWith({ error: 'rate limited' }, 429);
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
  });

  test('concurrent refreshes share a single upstream fetch (single-flight)', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const first = refreshCodexCatalog({ fetchImpl });
    const second = refreshCodexCatalog({ fetchImpl });
    resolveFetch(
      new Response(JSON.stringify(UPSTREAM_PAYLOAD), { status: 200 }),
    );
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('init loads disk cache synchronously and stays builtin on corruption', () => {
    // null 磁盘路径（测试环境禁写）→ init 后应停留在 baked-in 兜底
    setCodexCatalogDiskCachePathForTests(null);
    initCodexCatalogSync({ fetchImpl: neverSettleFetch });
    const resolved = getResolvedCodexCatalog();
    expect(resolved.source).toBe('builtin');
    expect(resolved.models.length).toBeGreaterThan(0);
  });

  test('clampCodexEffortWithCatalog honors resolved catalog efforts', () => {
    const catalog = parseUpstreamModelCatalog(UPSTREAM_PAYLOAD);
    // 上游目录里 gpt-6-sol 支持 ultra → 透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-6-sol', 'ultra')).toBe(
      'ultra',
    );
    // 新模型 gpt-9-aurora 只有 low/medium 且无上游默认档 → high 归位第一个档
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-9-aurora', 'high')).toBe(
      'low',
    );
    // 目录外模型透传
    expect(clampCodexEffortWithCatalog(catalog, 'gpt-8-future', 'ultra')).toBe(
      'ultra',
    );
  });

  test('filters upstream efforts through the known whitelist', () => {
    const entries = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'm-junk-only',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'minimal' },
            { effort: 'turbo-junk' },
          ],
        },
        {
          slug: 'm-mixed',
          visibility: 'list',
          display_name: 'Mixed',
          supported_reasoning_levels: [
            { effort: 'junk' },
            { effort: 'low' },
            { effort: 'medium' },
          ],
        },
      ],
    });
    // 全部档位都不在白名单里的模型被跳过；混合档位只保留已知档
    expect(entries.map((entry) => entry.value)).toEqual(['m-mixed']);
    expect(entries[0].efforts).toEqual(['low', 'medium']);
  });

  test('captures per-model default effort and uses it as clamp fallback', () => {
    const catalog = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'm-default-low',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        {
          // 默认档不在 supported 列表里 → 视为无效，不落 defaultEffort
          slug: 'm-broken-default',
          visibility: 'list',
          default_reasoning_level: 'ultra',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
      ],
    });
    expect(catalog[0].defaultEffort).toBe('low');
    expect(catalog[1].defaultEffort).toBeUndefined();
    // 支持的档位透传
    expect(clampCodexEffortWithCatalog(catalog, 'm-default-low', 'high')).toBe(
      'high',
    );
    // 不支持的档位归位该模型自己的默认档（而非全局 medium）
    expect(clampCodexEffortWithCatalog(catalog, 'm-default-low', 'ultra')).toBe(
      'low',
    );
    // 无有效默认档时归位第一个档位
    expect(
      clampCodexEffortWithCatalog(catalog, 'm-broken-default', 'ultra'),
    ).toBe('low');
  });

  test('dedupes duplicate slugs (first wins) and derives slug-only labels', () => {
    const entries = parseUpstreamModelCatalog({
      models: [
        {
          slug: 'dup',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
        {
          slug: 'dup',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'medium' }],
        },
        {
          slug: 'bare-slug',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }],
        },
      ],
    });
    expect(entries.map((entry) => entry.value)).toEqual(['dup', 'bare-slug']);
    expect(entries[0].efforts).toEqual(['low']);
    expect(entries[1].label).toBe('bare-slug');
  });

  test('rejects oversized upstream body and keeps current catalog', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    ) as unknown as typeof fetch;
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
  });

  test('rejects when content-length header exceeds the cap', async () => {
    const before = getResolvedCodexCatalog();
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const ok = await refreshCodexCatalog({ fetchImpl });
    expect(ok).toBe(false);
    expect(getResolvedCodexCatalog()).toBe(before);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects catalogs with more than the entry cap', () => {
    const models = Array.from({ length: 201 }, (_, i) => ({
      slug: `m-${i}`,
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }],
    }));
    expect(() => parseUpstreamModelCatalog({ models })).toThrow();
  });

  test('disk cache round-trips through a temp file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    const cachePath = path.join(dir, 'catalog.json');
    try {
      setCodexCatalogDiskCachePathForTests(cachePath);
      const ok = await refreshCodexCatalog({
        fetchImpl: mockFetchWith(UPSTREAM_PAYLOAD),
      });
      expect(ok).toBe(true);
      // 内存态回 builtin（路径覆写也被 reset 清掉），再从磁盘恢复
      resetCodexCatalogSyncForTests();
      setCodexCatalogDiskCachePathForTests(cachePath);
      initCodexCatalogSync({ fetchImpl: neverSettleFetch });
      const resolved = getResolvedCodexCatalog();
      expect(resolved.source).toBe('disk-cache');
      expect(resolved.models.map((entry) => entry.value)).toContain(
        'gpt-9-aurora',
      );
      expect(resolved.fetchedAt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores disk cache entries with invalid labels', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
    const cachePath = path.join(dir, 'catalog.json');
    try {
      writeFileSync(
        cachePath,
        JSON.stringify({
          models: [{ value: 'x', label: 42, efforts: ['low'] }],
        }),
      );
      setCodexCatalogDiskCachePathForTests(cachePath);
      initCodexCatalogSync({ fetchImpl: neverSettleFetch });
      expect(getResolvedCodexCatalog().source).toBe('builtin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed refresh retries after 5-minute backoff instead of 6h', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response('nope', { status: 429 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const ok = await refreshCodexCatalog();
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 刚失败：5 分钟内路由触发也不重试
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 失败退避是 5 分钟，到点即重试
    vi.advanceTimersByTime(1 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('successful refresh keeps the full 6h TTL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(UPSTREAM_PAYLOAD), { status: 200 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const ok = await refreshCodexCatalog();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 成功后连失败退避窗口（5min）过去也不重试，必须满 6h TTL
    vi.advanceTimersByTime(5 * 60 * 1000);
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60 * 60 * 1000); // 累计 5h05m < 6h
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1 * 60 * 60 * 1000); // 累计 6h05m > 6h
    maybeRefreshCodexCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
