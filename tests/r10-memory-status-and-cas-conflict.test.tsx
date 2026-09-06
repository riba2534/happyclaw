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

    // 1. Click proposed item in list
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

    // 2. Real DOM should show candidate card and button
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

    // Select conflicted item
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
});
