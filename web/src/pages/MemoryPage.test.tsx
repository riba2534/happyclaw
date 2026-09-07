// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../api/client', () => ({
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

const { MemoryPage } = await import('./MemoryPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  id: 'memory-1',
  workspaceJid: 'workspace:alpha',
  kind: 'decision',
  title: '使用 SQLite 作为 canonical store',
  content: 'Workspace Memory v2 以 SQLite 为唯一真相源。',
  canonicalKey: 'memory-store',
  status: 'active',
  importance: 0.9,
  confidence: 1,
  validFrom: null,
  validUntil: null,
  expiresAt: null,
  revision: 2,
  createdAt: '2026-07-28T08:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
  provenance: {
    sourceType: 'agent_runtime',
    sourceId: 'message-9',
    sessionId: 'session-42',
    observedAt: '2026-07-28T08:30:00.000Z',
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
});

function configureGetMock() {
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
            interaction_mode: 'assistant',
            can_modify: true,
            updated_at: '2026-07-28T09:00:00.000Z',
            agent_profile: {
              id: 'agent-1',
              name: 'Alpha Agent',
              version: 1,
            },
          },
        ],
      };
    }
    if (
      path ===
      '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
    ) {
      return {
        storeRevision: 8,
        items: [item],
        nextCursor: null,
      };
    }
    if (path === '/api/memory/workspaces/workspace%3Aalpha/items/memory-1') {
      return { storeRevision: 8, item };
    }
    if (
      path ===
      '/api/memory/workspaces/workspace%3Aalpha/items/memory-1/versions?limit=20'
    ) {
      return {
        storeRevision: 8,
        itemId: item.id,
        versions: [
          {
            workspaceJid: item.workspaceJid,
            revision: 2,
            changeType: 'update',
            status: 'active',
            kind: item.kind,
            title: item.title,
            content: item.content,
            canonicalKey: item.canonicalKey,
            importance: item.importance,
            confidence: item.confidence,
            validFrom: null,
            validUntil: null,
            expiresAt: null,
            createdAt: item.updatedAt,
            actor: { type: 'web_user', id: 'admin-user' },
            provenance: item.provenance,
          },
        ],
        nextCursor: 'versions-page-2',
      };
    }
    if (
      path ===
      '/api/memory/workspaces/workspace%3Aalpha/items/memory-1/versions?limit=20&cursor=versions-page-2'
    ) {
      return {
        storeRevision: 8,
        itemId: item.id,
        versions: [
          {
            workspaceJid: item.workspaceJid,
            revision: 1,
            changeType: 'create',
            status: 'active',
            kind: item.kind,
            title: item.title,
            content: item.content,
            canonicalKey: item.canonicalKey,
            importance: item.importance,
            confidence: item.confidence,
            validFrom: null,
            validUntil: null,
            expiresAt: null,
            createdAt: item.createdAt,
            actor: { type: 'web_user', id: 'admin-user' },
            provenance: {
              ...item.provenance,
              sourceType: 'web_user',
              sessionId: null,
            },
          },
        ],
        nextCursor: null,
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const alphaWorkspace = {
  jid: 'workspace:alpha',
  folder: 'alpha-folder',
  name: 'Alpha Workspace',
  status: 'active',
  is_home: true,
  interaction_mode: 'assistant',
  can_modify: true,
  updated_at: '2026-07-28T09:00:00.000Z',
  agent_profile: {
    id: 'agent-1',
    name: 'Alpha Agent',
    version: 1,
  },
};

const betaWorkspace = {
  ...alphaWorkspace,
  jid: 'workspace:beta',
  folder: 'beta-folder',
  name: 'Beta Workspace',
  is_home: false,
  agent_profile: {
    id: 'agent-2',
    name: 'Beta Agent',
    version: 1,
  },
};

function memoryItem(
  id: string,
  workspaceJid: string,
  title: string,
  content = `${title} 的内容`,
) {
  return {
    ...item,
    id,
    workspaceJid,
    title,
    content,
    provenance: { ...item.provenance },
  };
}

async function renderPage(options?: {
  configure?: boolean;
  initialEntry?: string;
  waitForText?: string | false;
}) {
  if (options?.configure !== false) configureGetMock();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [
      { path: '/memory', element: <MemoryPage /> },
      { path: '/other', element: <div>Other page</div> },
    ],
    {
      initialEntries: [
        options?.initialEntry || '/memory?workspace=workspace%3Aalpha',
      ],
    },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
  if (options?.waitForText !== false) {
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        options?.waitForText || item.title,
      ),
    );
  }
  return router;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(
    container!.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeDefined();
  return button!;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('Workspace Memory v2 page', () => {
  test('is workspace-first and loads memory by workspace JID', async () => {
    await renderPage();

    expect(container!.textContent).toContain('Workspace Memory');
    expect(container!.textContent).toContain(
      'Workspace Memory 与 Session 历史彼此独立',
    );
    expect(container!.textContent).toContain('事实');
    expect(container!.textContent).toContain('决策');
    expect(container!.textContent).toContain('经验');
    expect(container!.textContent).toContain('待跟进');
    expect(container!.textContent).not.toContain('日期记忆');
    expect(container!.textContent).not.toContain('记忆源');
    expect(container!.textContent).not.toContain('宿主机配置');

    const collectionCalls = mocks.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.includes('/api/memory/workspaces/'));
    expect(collectionCalls).toContain(
      '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100',
    );
    expect(
      collectionCalls.every((path) => !path.includes('alpha-folder')),
    ).toBe(true);
  });

  test('shows provenance and versions, and preserves the draft on CAS conflict', async () => {
    await renderPage();

    await act(async () => {
      buttonWithText(item.title).click();
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain('修订记录'),
    );
    expect(container!.textContent).toContain('Session session-42');
    expect(container!.textContent).toContain('Agent Runtime');
    expect(container!.textContent).toContain('Revision 2');
    expect(container!.textContent).toContain('更新');

    await act(async () => {
      buttonWithText('加载更多修订').click();
    });
    await vi.waitFor(() => expect(container!.textContent).toContain('创建'));
    expect(container!.textContent).toContain('Web 用户');
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/memory/workspaces/workspace%3Aalpha/items/memory-1/versions?limit=20&cursor=versions-page-2',
    );

    mocks.patch.mockRejectedValueOnce({
      status: 409,
      message: 'revision conflict',
      body: {
        error: 'revision_conflict',
        currentRevision: 3,
        storeRevision: 9,
      },
    });
    const textarea =
      container!.querySelector<HTMLTextAreaElement>('#memory-content');
    expect(textarea).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, '我的本地 CAS 草稿');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonWithText('保存 revision').click();
    });

    await vi.waitFor(() =>
      expect(container!.textContent).toContain(
        '保存冲突：这条记忆已被其他会话更新',
      ),
    );
    expect(container!.textContent).toContain('当前服务端 revision 3');
    expect(container!.textContent).toContain('store revision 9');
    expect(textarea!.value).toBe('我的本地 CAS 草稿');
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/workspace%3Aalpha/items/memory-1',
      expect.objectContaining({
        expectedRevision: 2,
        content: '我的本地 CAS 草稿',
      }),
    );
  });

  test('blocks SPA and document navigation while an edit is dirty', async () => {
    const router = await renderPage();
    await act(async () => {
      buttonWithText(item.title).click();
    });
    const textarea =
      container!.querySelector<HTMLTextAreaElement>('#memory-content')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, '尚未保存的工作区记忆');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    const confirm = vi.mocked(window.confirm);
    confirm.mockReturnValueOnce(false);
    await act(async () => {
      await router.navigate('/other');
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/memory');
    expect(container!.textContent).not.toContain('Other page');

    confirm.mockReturnValueOnce(true);
    await act(async () => {
      await router.navigate('/other');
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe('/other');
    expect(container!.textContent).toContain('Other page');
  });

  test('refreshes the visible search results and reruns search after save', async () => {
    let currentItem = memoryItem(
      'memory-search',
      alphaWorkspace.jid,
      '搜索旧结果',
      '旧内容',
    );
    let searchCalls = 0;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return {
          storeRevision: currentItem.revision,
          items: [currentItem],
          nextCursor: null,
        };
      }
      if (
        path.startsWith(
          '/api/memory/workspaces/workspace%3Aalpha/items/search?q=SQLite',
        )
      ) {
        searchCalls += 1;
        return {
          storeRevision: currentItem.revision,
          hits: [{ item: currentItem, rank: 1, snippet: currentItem.content }],
        };
      }
      if (path.endsWith('/items/memory-search')) {
        return { storeRevision: currentItem.revision, item: currentItem };
      }
      if (path.endsWith('/items/memory-search/versions?limit=20')) {
        return {
          storeRevision: currentItem.revision,
          itemId: currentItem.id,
          versions: [],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await renderPage({
      configure: false,
      waitForText: currentItem.title,
    });
    const search = container!.querySelector<HTMLInputElement>(
      '[aria-label="搜索当前工作区的记忆"]',
    )!;
    const inputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      inputValueSetter?.call(search, 'SQLite');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() => expect(searchCalls).toBe(1));

    currentItem = { ...currentItem, title: '刷新后的搜索结果', revision: 3 };
    await act(async () => {
      buttonWithText('刷新').click();
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain('刷新后的搜索结果'),
    );
    expect(searchCalls).toBe(2);

    await act(async () => {
      buttonWithText('刷新后的搜索结果').click();
    });
    const content =
      container!.querySelector<HTMLTextAreaElement>('#memory-content')!;
    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      textareaValueSetter?.call(content, '保存后的最新内容');
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mocks.patch.mockImplementationOnce(async () => {
      currentItem = {
        ...currentItem,
        content: '保存后的最新内容',
        revision: 4,
      };
      return { storeRevision: 4, item: currentItem };
    });
    await act(async () => {
      buttonWithText('保存 revision').click();
    });
    await vi.waitFor(() => expect(searchCalls).toBe(3));
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/workspace%3Aalpha/items/memory-search',
      expect.objectContaining({ content: '保存后的最新内容' }),
    );
  });

  test('ignores a previous workspace collection response that resolves after switching', async () => {
    const alphaItems = deferred<{
      storeRevision: number;
      items: Array<ReturnType<typeof memoryItem>>;
      nextCursor: null;
    }>();
    const alphaItem = memoryItem(
      'memory-alpha',
      alphaWorkspace.jid,
      'Alpha 独有记忆',
    );
    const betaItem = memoryItem(
      'memory-beta',
      betaWorkspace.jid,
      'Beta 当前记忆',
    );

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace, betaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return alphaItems.promise;
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Abeta/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 3,
          items: [betaItem],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const router = await renderPage({
      configure: false,
      waitForText: false,
    });
    await vi.waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith(
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100',
      ),
    );

    await act(async () => {
      await router.navigate('/memory?workspace=workspace%3Abeta');
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(betaItem.title),
    );

    await act(async () => {
      alphaItems.resolve({
        storeRevision: 99,
        items: [alphaItem],
        nextCursor: null,
      });
      await alphaItems.promise;
    });

    expect(container!.textContent).toContain(betaItem.title);
    expect(container!.textContent).not.toContain(alphaItem.title);
    expect(container!.textContent).toContain('Store revision 3');
    expect(container!.textContent).not.toContain('Store revision 99');
  });

  test('ignores stale detail and versions after a newer item is selected', async () => {
    const firstItem = memoryItem(
      'memory-first',
      alphaWorkspace.jid,
      '第一条记忆',
      '第一条详情，不应晚到覆盖',
    );
    const secondItem = memoryItem(
      'memory-second',
      alphaWorkspace.jid,
      '第二条记忆',
      '第二条详情，应保持可见',
    );
    const firstDetail = deferred<{
      storeRevision: number;
      item: ReturnType<typeof memoryItem>;
    }>();
    const firstVersions = deferred<{
      storeRevision: number;
      itemId: string;
      versions: never[];
      nextCursor: null;
    }>();

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 4,
          items: [firstItem, secondItem],
          nextCursor: null,
        };
      }
      if (path.endsWith('/items/memory-first')) {
        return firstDetail.promise;
      }
      if (path.endsWith('/items/memory-first/versions?limit=20')) {
        return firstVersions.promise;
      }
      if (path.endsWith('/items/memory-second')) {
        return { storeRevision: 5, item: secondItem };
      }
      if (path.endsWith('/items/memory-second/versions?limit=20')) {
        return {
          storeRevision: 5,
          itemId: secondItem.id,
          versions: [],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await renderPage({
      configure: false,
      waitForText: firstItem.title,
    });
    await act(async () => {
      buttonWithText(firstItem.title).click();
    });
    await vi.waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith(
        '/api/memory/workspaces/workspace%3Aalpha/items/memory-first',
      ),
    );

    await act(async () => {
      buttonWithText(secondItem.title).click();
    });
    await vi.waitFor(() =>
      expect(
        container!.querySelector<HTMLTextAreaElement>('#memory-content')?.value,
      ).toBe(secondItem.content),
    );

    await act(async () => {
      firstDetail.resolve({ storeRevision: 90, item: firstItem });
      firstVersions.resolve({
        storeRevision: 90,
        itemId: firstItem.id,
        versions: [],
        nextCursor: null,
      });
      await Promise.all([firstDetail.promise, firstVersions.promise]);
    });

    expect(
      container!.querySelector<HTMLTextAreaElement>('#memory-content')?.value,
    ).toBe(secondItem.content);
    expect(container!.textContent).toContain(secondItem.title);
    expect(container!.textContent).not.toContain('Store revision 90');
  });

  test('does not apply a save completion after switching workspaces', async () => {
    const alphaItem = memoryItem(
      'memory-alpha',
      alphaWorkspace.jid,
      'Alpha 待更新记忆',
      'Alpha 原始内容',
    );
    const betaItem = memoryItem(
      'memory-beta',
      betaWorkspace.jid,
      'Beta 切换后记忆',
    );
    const pendingSave = deferred<{
      storeRevision: number;
      item: ReturnType<typeof memoryItem>;
    }>();

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace, betaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 8,
          items: [alphaItem],
          nextCursor: null,
        };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Abeta/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 2,
          items: [betaItem],
          nextCursor: null,
        };
      }
      if (path.endsWith('/items/memory-alpha')) {
        return { storeRevision: 8, item: alphaItem };
      }
      if (path.endsWith('/items/memory-alpha/versions?limit=20')) {
        return {
          storeRevision: 8,
          itemId: alphaItem.id,
          versions: [],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    mocks.patch.mockReturnValue(pendingSave.promise);

    const router = await renderPage({
      configure: false,
      waitForText: alphaItem.title,
    });
    await act(async () => {
      buttonWithText(alphaItem.title).click();
    });
    await vi.waitFor(() =>
      expect(
        container!.querySelector<HTMLTextAreaElement>('#memory-content')?.value,
      ).toBe(alphaItem.content),
    );

    const textarea =
      container!.querySelector<HTMLTextAreaElement>('#memory-content')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'Alpha 已提交但响应未完成');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonWithText('保存 revision').click();
    });
    await vi.waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));

    await act(async () => {
      await router.navigate('/memory?workspace=workspace%3Abeta');
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(betaItem.title),
    );
    const alphaCollectionCallsBeforeResolve = mocks.get.mock.calls.filter(
      ([path]) =>
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100',
    ).length;

    await act(async () => {
      pendingSave.resolve({
        storeRevision: 100,
        item: {
          ...alphaItem,
          content: 'Alpha 已保存',
          revision: 3,
        },
      });
      await pendingSave.promise;
    });

    expect(container!.textContent).toContain(betaItem.title);
    expect(container!.textContent).not.toContain('Alpha 已保存');
    expect(container!.textContent).toContain('Store revision 2');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(
      mocks.get.mock.calls.filter(
        ([path]) =>
          path ===
          '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100',
      ),
    ).toHaveLength(alphaCollectionCallsBeforeResolve);
  });

  test('does not apply a create completion after switching workspaces', async () => {
    const betaItem = memoryItem(
      'memory-beta',
      betaWorkspace.jid,
      'Beta 创建期间切换',
    );
    const createdAlphaItem = memoryItem(
      'memory-created-alpha',
      alphaWorkspace.jid,
      'Alpha 延迟创建结果',
    );
    const pendingCreate = deferred<{
      storeRevision: number;
      item: ReturnType<typeof memoryItem>;
    }>();

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace, betaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return { storeRevision: 1, items: [], nextCursor: null };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Abeta/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 2,
          items: [betaItem],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    mocks.post.mockReturnValue(pendingCreate.promise);

    const router = await renderPage({
      configure: false,
      waitForText: '这个工作区还没有记忆',
    });
    await act(async () => {
      buttonWithText('新建记忆').click();
    });
    const createContent = document.querySelector<HTMLTextAreaElement>(
      '#create-memory-content',
    );
    await vi.waitFor(() => expect(createContent).not.toBeNull());
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(createContent, 'Alpha 延迟创建内容');
      createContent!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === '创建')
        ?.click();
    });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));

    await act(async () => {
      await router.navigate('/memory?workspace=workspace%3Abeta');
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(betaItem.title),
    );

    await act(async () => {
      pendingCreate.resolve({
        storeRevision: 50,
        item: createdAlphaItem,
      });
      await pendingCreate.promise;
    });

    expect(container!.textContent).toContain(betaItem.title);
    expect(container!.textContent).not.toContain(createdAlphaItem.title);
    expect(container!.textContent).toContain('Store revision 2');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  test('does not apply a forget completion after switching workspaces', async () => {
    const alphaItem = memoryItem(
      'memory-alpha',
      alphaWorkspace.jid,
      'Alpha 延迟忘记记忆',
    );
    const betaItem = memoryItem(
      'memory-beta',
      betaWorkspace.jid,
      'Beta 忘记期间切换',
    );
    const pendingForget = deferred<{
      storeRevision: number;
      item: ReturnType<typeof memoryItem>;
    }>();

    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') {
        return { workspaces: [alphaWorkspace, betaWorkspace] };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Aalpha/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 8,
          items: [alphaItem],
          nextCursor: null,
        };
      }
      if (
        path ===
        '/api/memory/workspaces/workspace%3Abeta/items?status=active&limit=100'
      ) {
        return {
          storeRevision: 2,
          items: [betaItem],
          nextCursor: null,
        };
      }
      if (path.endsWith('/items/memory-alpha')) {
        return { storeRevision: 8, item: alphaItem };
      }
      if (path.endsWith('/items/memory-alpha/versions?limit=20')) {
        return {
          storeRevision: 8,
          itemId: alphaItem.id,
          versions: [],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    mocks.apiFetch.mockReturnValue(pendingForget.promise);

    const router = await renderPage({
      configure: false,
      waitForText: alphaItem.title,
    });
    await act(async () => {
      buttonWithText(alphaItem.title).click();
    });
    await vi.waitFor(() =>
      expect(
        container!.querySelector<HTMLTextAreaElement>('#memory-content')?.value,
      ).toBe(alphaItem.content),
    );
    await act(async () => {
      Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === '忘记')
        ?.click();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('忘记这条工作区记忆？'),
    );
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('确认忘记'))
        ?.click();
    });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      await router.navigate('/memory?workspace=workspace%3Abeta');
    });
    await vi.waitFor(() =>
      expect(container!.textContent).toContain(betaItem.title),
    );

    await act(async () => {
      pendingForget.resolve({
        storeRevision: 9,
        item: { ...alphaItem, status: 'deleted', revision: 3 },
      });
      await pendingForget.promise;
    });

    expect(container!.textContent).toContain(betaItem.title);
    expect(container!.textContent).toContain('Store revision 2');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
