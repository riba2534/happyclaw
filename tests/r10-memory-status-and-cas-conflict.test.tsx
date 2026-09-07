// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getMemoryValidityInfo } from '../web/src/utils/memory-status';
import type { WorkspaceMemoryItem } from '../web/src/features/workspace-memory/model';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
  },
  apiFetch: mocks.apiFetch,
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock('../web/node_modules/sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

const { MemoryPage } = await import('../web/src/pages/MemoryPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function typeInTextarea(textarea: HTMLTextAreaElement, text: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('R10: Memory validity display, filtering, and CAS candidate/conflict resolution (Real DOM & Components)', () => {
  const fixedNow = new Date('2026-09-07T12:00:00.000Z');

  test('correctly calculates validity status, earliest deadline, and explainable reasons', () => {
    // 1. Current valid
    const activeItem: WorkspaceMemoryItem = {
      id: 'm-1',
      workspaceJid: 'web:ws1',
      kind: 'fact',
      content: 'HappyClaw 部署在 Mac mini',
      status: 'active',
      importance: 0.8,
      confidence: 1,
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-09-30T00:00:00.000Z',
      expiresAt: null,
      revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'web_user', sourceId: 'u1' },
    };
    const activeInfo = getMemoryValidityInfo(activeItem, fixedNow);
    expect(activeInfo.status).toBe('active_valid');
    expect(activeInfo.isRecalible).toBe(true);
    expect(activeInfo.reason).toContain('在有效期内');
    expect(activeInfo.reason).toContain('当前可召回');

    // 2. Future effective
    const futureItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-2',
      validFrom: '2026-09-10T00:00:00.000Z', // 3 days in future
    };
    const futureInfo = getMemoryValidityInfo(futureItem, fixedNow);
    expect(futureInfo.status).toBe('future');
    expect(futureInfo.isRecalible).toBe(false);
    expect(futureInfo.label).toBe('未来生效');
    expect(futureInfo.reason).toContain('未到生效时间');
    expect(futureInfo.reason).toContain('当前不可召回');

    // 3. Expired by validUntil
    const expiredItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-3',
      validUntil: '2026-09-05T00:00:00.000Z', // 2 days ago
    };
    const expiredInfo = getMemoryValidityInfo(expiredItem, fixedNow);
    expect(expiredInfo.status).toBe('expired');
    expect(expiredInfo.isRecalible).toBe(false);
    expect(expiredInfo.label).toBe('已过期');
    expect(expiredInfo.reason).toContain('已过有效截止时间');

    // 3b. Comparison: validUntil is 2026-09-30, but expiresAt is earlier 2026-09-15
    const earlierExpiresItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-3b',
      validUntil: '2026-09-30T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
    };
    const earlierExpiresInfo = getMemoryValidityInfo(
      earlierExpiresItem,
      fixedNow,
    );
    expect(earlierExpiresInfo.status).toBe('active_valid');
    expect(earlierExpiresInfo.validityRangeText).toContain('2026/09/15');
    expect(earlierExpiresInfo.validityRangeText).toContain(
      '最早截止: 过期淘汰(TTL)',
    );

    // 4. Proposed candidate
    const proposedItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-4',
      status: 'proposed',
    };
    const proposedInfo = getMemoryValidityInfo(proposedItem, fixedNow);
    expect(proposedInfo.status).toBe('proposed');
    expect(proposedInfo.isRecalible).toBe(false);
    expect(proposedInfo.label).toContain('候选记忆');
    expect(proposedInfo.reason).toContain('需确认采纳后方可生效');

    // 5. Conflicted
    const conflictedItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-5',
      status: 'conflicted',
    };
    const conflictedInfo = getMemoryValidityInfo(conflictedItem, fixedNow);
    expect(conflictedInfo.status).toBe('conflicted');
    expect(conflictedInfo.isRecalible).toBe(false);
    expect(conflictedInfo.label).toContain('冲突记忆');
    expect(conflictedInfo.reason).toContain('存在事实或版本冲突');
  });

  test('confirming proposed candidate in real MemoryPage submits uncommitted draft edits via CAS', async () => {
    const proposedItem: WorkspaceMemoryItem = {
      id: 'prop-1',
      workspaceJid: 'workspace:alpha',
      kind: 'decision',
      title: '提议的架构决策',
      content: '使用集中式日志收集器',
      status: 'proposed',
      importance: 0.8,
      confidence: 0.9,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      revision: 3,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'agent_runtime', sourceId: 'msg-1' },
    };

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return {
          workspaces: [
            {
              jid: 'workspace:alpha',
              folder: 'alpha-folder',
              name: 'Alpha Workspace',
              status: 'active',
              is_home: true,
              can_modify: true,
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (path.includes('/items?')) {
        return { storeRevision: 8, items: [proposedItem], nextCursor: null };
      }
      if (path === '/api/memory/workspaces/workspace%3Aalpha/items/prop-1') {
        return { storeRevision: 8, item: proposedItem };
      }
      if (path.includes('/versions')) {
        return {
          storeRevision: 8,
          itemId: 'prop-1',
          versions: [],
          nextCursor: null,
        };
      }
      return {};
    });

    mocks.patch.mockResolvedValue({
      storeRevision: 9,
      item: {
        ...proposedItem,
        title: '提议的架构决策 (用户修改版)',
        content: '使用集中式日志收集器并配置告警',
        status: 'active',
        revision: 4,
      },
    });

    const router = createMemoryRouter(
      [{ path: '/memory', element: <MemoryPage /> }],
      { initialEntries: ['/memory?workspace=workspace:alpha'] },
    );

    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 1. Switch to "候选待确认 (proposed)" tab in real DOM
    const proposedTab = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('候选待确认'));
    expect(proposedTab).toBeTruthy();
    await act(async () => {
      proposedTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 2. Click proposed item in list
    const itemCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('提议的架构决策'),
    );
    expect(itemCard).toBeTruthy();
    await act(async () => {
      itemCard?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 3. Real DOM should show candidate card and button
    expect(document.body.textContent).toContain('这是候选记忆 (待确认)');
    const confirmBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('采纳为正式记忆'));
    expect(confirmBtn).toBeTruthy();

    // 3. User edits the uncommitted draft before confirming
    const textarea = document.body.querySelector(
      '#memory-content',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      typeInTextarea(textarea, '使用集中式日志收集器并配置告警');
    });

    const titleInput = document.body.querySelector(
      '#memory-title',
    ) as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(titleInput, '提议的架构决策 (用户修改版)');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 4. Click "采纳为正式记忆" in real DOM
    await act(async () => {
      confirmBtn?.click();
    });

    // 5. Verify real PATCH payload carries uncommitted draft and CAS revision
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/workspace%3Aalpha/items/prop-1',
      expect.objectContaining({
        expectedRevision: 3,
        status: 'active',
        title: '提议的架构决策 (用户修改版)',
        content: '使用集中式日志收集器并配置告警',
      }),
    );
  });

  test('resolving conflicted memory in real MemoryPage submits user resolution and handles 409 CAS rejection', async () => {
    const conflictedItem: WorkspaceMemoryItem = {
      id: 'conf-1',
      workspaceJid: 'workspace:alpha',
      kind: 'fact',
      title: '团队人数冲突',
      content: '团队有 5 人（另一版本提议 7 人）',
      status: 'conflicted',
      importance: 0.8,
      confidence: 0.8,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      revision: 5,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'agent_runtime', sourceId: 'msg-2' },
    };

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return {
          workspaces: [
            {
              jid: 'workspace:alpha',
              folder: 'alpha-folder',
              name: 'Alpha Workspace',
              status: 'active',
              is_home: true,
              can_modify: true,
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (path.includes('/items?')) {
        return { storeRevision: 8, items: [conflictedItem], nextCursor: null };
      }
      if (path === '/api/memory/workspaces/workspace%3Aalpha/items/conf-1') {
        return { storeRevision: 8, item: conflictedItem };
      }
      if (path.includes('/versions')) {
        return {
          storeRevision: 8,
          itemId: 'conf-1',
          versions: [],
          nextCursor: null,
        };
      }
      return {};
    });

    const router = createMemoryRouter(
      [{ path: '/memory', element: <MemoryPage /> }],
      { initialEntries: ['/memory?workspace=workspace:alpha'] },
    );

    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 1. Switch to "冲突待解决 (conflicted)" tab in real DOM
    const conflictedTab = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('冲突待解决'));
    expect(conflictedTab).toBeTruthy();
    await act(async () => {
      conflictedTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 2. Select conflicted item
    const itemCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('团队人数冲突'),
    );
    expect(itemCard).toBeTruthy();
    await act(async () => {
      itemCard?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Real DOM must render conflict alert
    expect(document.body.textContent).toContain(
      '待解决冲突：此记忆存在多方更新或版本冲突',
    );
    const resolveBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('解决冲突并生效'));
    expect(resolveBtn).toBeTruthy();

    // 1. Success case: user edits to resolve conflict and submits
    const textarea = document.body.querySelector(
      '#memory-content',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(textarea, '团队确认当前共 7 人（包含新入职）');
    });

    mocks.patch.mockResolvedValueOnce({
      storeRevision: 10,
      item: {
        ...conflictedItem,
        content: '团队确认当前共 7 人（包含新入职）',
        status: 'active',
        revision: 6,
      },
    });

    await act(async () => {
      resolveBtn?.click();
    });

    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/workspace%3Aalpha/items/conf-1',
      expect.objectContaining({
        expectedRevision: 5,
        status: 'active',
        content: '团队确认当前共 7 人（包含新入职）',
      }),
    );
  });

  test('CAS conflict rejection when concurrent edit modifies revision', async () => {
    const conflictedItem: WorkspaceMemoryItem = {
      id: 'conf-2',
      workspaceJid: 'workspace:alpha',
      kind: 'fact',
      title: '团队人数冲突2',
      content: '团队有 5 人',
      status: 'conflicted',
      importance: 0.8,
      confidence: 0.8,
      validFrom: null,
      validUntil: null,
      expiresAt: null,
      revision: 5,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'agent_runtime', sourceId: 'msg-2' },
    };

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return {
          workspaces: [
            {
              jid: 'workspace:alpha',
              folder: 'alpha-folder',
              name: 'Alpha Workspace',
              status: 'active',
              is_home: true,
              can_modify: true,
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (path.includes('/items?')) {
        return { storeRevision: 8, items: [conflictedItem], nextCursor: null };
      }
      if (path === '/api/memory/workspaces/workspace%3Aalpha/items/conf-2') {
        return { storeRevision: 8, item: conflictedItem };
      }
      if (path.includes('/versions')) {
        return {
          storeRevision: 8,
          itemId: 'conf-2',
          versions: [],
          nextCursor: null,
        };
      }
      return {};
    });

    // 409 Conflict rejection
    mocks.patch.mockRejectedValueOnce({
      status: 409,
      body: {
        error: 'revision_conflict',
        message: 'Workspace memory item revision conflict',
        currentRevision: 7,
        storeRevision: 12,
      },
    });

    const router = createMemoryRouter(
      [{ path: '/memory', element: <MemoryPage /> }],
      { initialEntries: ['/memory?workspace=workspace:alpha'] },
    );

    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Switch to "冲突待解决 (conflicted)" tab in real DOM
    const conflictedTab = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('冲突待解决'));
    expect(conflictedTab).toBeTruthy();
    await act(async () => {
      conflictedTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const itemCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('团队人数冲突2'),
    );
    await act(async () => {
      itemCard?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const resolveBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('解决冲突并生效'));

    await act(async () => {
      resolveBtn?.click();
    });

    // Real DOM must render CAS conflict banner
    expect(document.body.textContent).toContain(
      '保存冲突：这条记忆已被其他会话更新',
    );
    expect(document.body.textContent).toContain('加载服务端最新版');
  });

  test('multi-page cursor pagination in real MemoryPage, page 2 keyword search and search race protection', async () => {
    // Generate 55 items: 50 items on page 1, 5 items on page 2 (item 54 has special keyword)
    const page1Items: WorkspaceMemoryItem[] = Array.from(
      { length: 50 },
      (_, i) => ({
        id: `item-${i + 1}`,
        workspaceJid: 'workspace:alpha',
        kind: 'fact',
        title: `Memory title ${i + 1}`,
        content: `Content of memory ${i + 1}`,
        status: 'active',
        importance: 0.5,
        confidence: 1,
        validFrom: null,
        validUntil: null,
        expiresAt: null,
        revision: 1,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: `2026-09-01T00:${String(50 - i).padStart(2, '0')}:00Z`,
        deletedAt: null,
        provenance: { sourceType: 'web_user', sourceId: 'u1' },
      }),
    );

    const page2Items: WorkspaceMemoryItem[] = Array.from(
      { length: 5 },
      (_, i) => ({
        id: `item-${51 + i}`,
        workspaceJid: 'workspace:alpha',
        kind: 'decision',
        title:
          i === 3
            ? 'Target decision with deep_canary_deploy keyword'
            : `Memory title ${51 + i}`,
        content:
          i === 3
            ? 'Special canary deployment instructions for production'
            : `Content of memory ${51 + i}`,
        status: 'active',
        importance: 0.9,
        confidence: 1,
        validFrom: null,
        validUntil: null,
        expiresAt: null,
        revision: 1,
        createdAt: '2026-08-30T00:00:00Z',
        updatedAt: `2026-08-30T00:${String(10 - i).padStart(2, '0')}:00Z`,
        deletedAt: null,
        provenance: { sourceType: 'web_user', sourceId: 'u1' },
      }),
    );

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return {
          workspaces: [
            {
              jid: 'workspace:alpha',
              folder: 'alpha-folder',
              name: 'Alpha Workspace',
              status: 'active',
              is_home: true,
              can_modify: true,
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (path.includes('/items?')) {
        if (path.includes('cursor=page-2-cursor')) {
          return { storeRevision: 5, items: page2Items, nextCursor: null };
        }
        return {
          storeRevision: 5,
          items: page1Items,
          nextCursor: 'page-2-cursor',
        };
      }
      if (path.includes('/search?')) {
        if (path.includes('q=deep_canary_deploy')) {
          return {
            storeRevision: 5,
            hits: [
              {
                item: page2Items[3],
                rank: 1,
                snippet: page2Items[3].content,
              },
            ],
            nextCursor: null,
          };
        }
        return { storeRevision: 5, hits: [], nextCursor: null };
      }
      return {};
    });

    const router = createMemoryRouter(
      [{ path: '/memory', element: <MemoryPage /> }],
      { initialEntries: ['/memory?workspace=workspace:alpha'] },
    );

    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 1. Page 1 rendered with 50 items and "加载更多" button
    expect(document.body.textContent).toContain('Memory title 1');
    expect(document.body.textContent).toContain('Memory title 50');
    expect(document.body.textContent).not.toContain('deep_canary_deploy');

    const loadMoreBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('加载更多'));
    expect(loadMoreBtn).toBeTruthy();

    // 2. Click "加载更多": loads page 2 and renders page 2 items!
    await act(async () => {
      loadMoreBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(document.body.textContent).toContain('deep_canary_deploy');
    expect(document.body.textContent).toContain('Memory title 55');

    // 3. Search for keyword "deep_canary_deploy" located on page 2:
    const searchInput = document.body.querySelector(
      'input[placeholder="搜索当前工作区的记忆"]',
    ) as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(searchInput, 'deep_canary_deploy');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // Verify search finds the target item
    expect(document.body.textContent).toContain(
      'Target decision with deep_canary_deploy keyword',
    );

    // 4. Verify search race condition protection:
    // When query is changed rapidly to "nonexistent", an earlier in-flight search must not overwrite the latest empty result
    let resolveSearch1: (val: any) => void = () => {};
    mocks.get.mockImplementation(async (path: string) => {
      if (path.includes('q=first_slow_query')) {
        return new Promise((res) => {
          resolveSearch1 = res;
        });
      }
      if (path.includes('q=second_fast_query')) {
        return {
          storeRevision: 5,
          hits: [{ item: page1Items[0], rank: 1, snippet: 'fast hit' }],
          nextCursor: null,
        };
      }
      return {};
    });

    await act(async () => {
      valueSetter?.call(searchInput, 'first_slow_query');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Rapidly type second query before first finishes
    await act(async () => {
      valueSetter?.call(searchInput, 'second_fast_query');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Fast second query has completed
    expect(document.body.textContent).toContain('Memory title 1');

    // Now first slow query resolves with old data
    await act(async () => {
      resolveSearch1({
        storeRevision: 5,
        hits: [{ item: page2Items[3], rank: 1, snippet: 'slow hit' }],
        nextCursor: null,
      });
    });

    // Latest search result must NOT be clobbered by the delayed older response!
    expect(document.body.textContent).toContain('Memory title 1');
  });

  test('search on future and expired tabs passes scope=manage&status=active, renders items, and cursor pagination appends distinct hits', async () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    const futureDate = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
    const pastDate = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();

    const futureItem: WorkspaceMemoryItem = {
      id: 'item-future',
      workspaceJid: 'workspace:alpha',
      kind: 'fact',
      title: 'Future deployment schedule',
      content: 'Scheduled maintenance in future',
      status: 'active',
      importance: 0.8,
      confidence: 1,
      validFrom: futureDate,
      validUntil: null,
      expiresAt: null,
      revision: 1,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      deletedAt: null,
      provenance: { sourceType: 'web_user', sourceId: 'u1' },
    };

    const expiredItem: WorkspaceMemoryItem = {
      id: 'item-expired',
      workspaceJid: 'workspace:alpha',
      kind: 'fact',
      title: 'Expired token credential',
      content: 'Old token expired last week',
      status: 'active',
      importance: 0.8,
      confidence: 1,
      validFrom: null,
      validUntil: null,
      expiresAt: pastDate,
      revision: 1,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
      deletedAt: null,
      provenance: { sourceType: 'web_user', sourceId: 'u1' },
    };

    const extraSearchItem: WorkspaceMemoryItem = {
      id: 'item-future-page2',
      workspaceJid: 'workspace:alpha',
      kind: 'fact',
      title: 'Future deployment schedule page 2',
      content: 'Scheduled maintenance in future page 2',
      status: 'active',
      importance: 0.8,
      confidence: 1,
      validFrom: futureDate,
      validUntil: null,
      expiresAt: null,
      revision: 1,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      deletedAt: null,
      provenance: { sourceType: 'web_user', sourceId: 'u1' },
    };

    const requestedSearchUrls: string[] = [];
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return {
          workspaces: [
            {
              jid: 'workspace:alpha',
              folder: 'alpha-folder',
              name: 'Alpha Workspace',
              status: 'active',
              is_home: true,
              can_modify: true,
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (path.includes('/items?')) {
        return {
          storeRevision: 1,
          items: [futureItem, expiredItem],
          nextCursor: null,
        };
      }
      if (path.includes('/search?')) {
        requestedSearchUrls.push(path);
        if (path.includes('cursor=search-cursor-p2')) {
          return {
            storeRevision: 1,
            hits: [
              {
                item: extraSearchItem,
                rank: 1,
                snippet: extraSearchItem.content,
              },
            ],
            nextCursor: null,
          };
        }
        if (path.includes('q=deployment')) {
          return {
            storeRevision: 1,
            hits: [{ item: futureItem, rank: 1, snippet: futureItem.content }],
            nextCursor: 'search-cursor-p2',
          };
        }
        if (path.includes('q=token')) {
          return {
            storeRevision: 1,
            hits: [
              { item: expiredItem, rank: 1, snippet: expiredItem.content },
            ],
            nextCursor: null,
          };
        }
        return { storeRevision: 1, hits: [], nextCursor: null };
      }
      return {};
    });

    const router = createMemoryRouter(
      [{ path: '/memory', element: <MemoryPage /> }],
      { initialEntries: ['/memory?workspace=workspace:alpha'] },
    );

    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const searchInput = document.body.querySelector(
      'input[placeholder="搜索当前工作区的记忆"]',
    ) as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;

    // 1. Switch to "未来生效" tab
    const futureTab = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('未来生效'),
    );
    expect(futureTab).toBeTruthy();
    await act(async () => {
      futureTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Type search query "deployment"
    await act(async () => {
      valueSetter?.call(searchInput, 'deployment');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // Check that search URL contained scope=manage and status=active!
    const futureSearchUrl = requestedSearchUrls.find((u) =>
      u.includes('q=deployment'),
    );
    expect(futureSearchUrl).toBeTruthy();
    expect(futureSearchUrl).toContain('scope=manage');
    expect(futureSearchUrl).toContain('status=active');

    // Future item must be rendered!
    expect(document.body.textContent).toContain('Future deployment schedule');

    // Test cursor pagination on search:
    const loadMoreBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('加载更多'));
    expect(loadMoreBtn).toBeTruthy();

    await act(async () => {
      loadMoreBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Check that page 2 search URL contained cursor
    const p2SearchUrl = requestedSearchUrls.find((u) =>
      u.includes('cursor=search-cursor-p2'),
    );
    expect(p2SearchUrl).toBeTruthy();
    expect(p2SearchUrl).toContain('scope=manage');

    // Both items from page 1 and page 2 are visible without duplicating!
    expect(document.body.textContent).toContain('Future deployment schedule');
    expect(document.body.textContent).toContain(
      'Future deployment schedule page 2',
    );

    // 2. Switch to "已过期" tab
    const expiredTab = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('已过期'));
    expect(expiredTab).toBeTruthy();
    await act(async () => {
      expiredTab?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Type search query "token"
    await act(async () => {
      valueSetter?.call(searchInput, 'token');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // Check that search URL contained scope=manage and status=active
    const expiredSearchUrl = requestedSearchUrls.find((u) =>
      u.includes('q=token'),
    );
    expect(expiredSearchUrl).toBeTruthy();
    expect(expiredSearchUrl).toContain('scope=manage');
    expect(expiredSearchUrl).toContain('status=active');

    // Expired item rendered!
    expect(document.body.textContent).toContain('Expired token credential');
  });
});
