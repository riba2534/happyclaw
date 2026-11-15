// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Automation, AutomationRun } from '../web/src/lib/automation';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  handlers: new Map<string, Set<(data: unknown) => void>>(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  apiFetch: vi.fn(),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    on: (type: string, handler: (data: unknown) => void) => {
      if (!mocks.handlers.has(type)) mocks.handlers.set(type, new Set());
      mocks.handlers.get(type)!.add(handler);
      return () => mocks.handlers.get(type)?.delete(handler);
    },
    send: vi.fn(),
    connect: vi.fn(),
    isConnected: () => true,
  },
}));

vi.mock('../web/src/hooks/useMediaQuery', () => ({
  // A desktop window driven by a mouse.
  useMediaQuery: (query: string) => query.includes('min-width: 1024px'),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { AutomationsPage } = await import('../web/src/pages/AutomationsPage');
const { AutomationFormHost } =
  await import('../web/src/components/automations/AutomationFormHost');
const { ConfirmHost } =
  await import('../web/src/components/common/ConfirmHost');
const { TooltipProvider } = await import('../web/src/components/ui/tooltip');
const { useAutomationSubscription, useAutomationsStore } =
  await import('../web/src/stores/automations');
const { useChatStore } = await import('../web/src/stores/chat');
const { useAuthStore } = await import('../web/src/stores/auth');
const { forgetWorkspaceModelOptions } =
  await import('../web/src/lib/session-model-choice');

const MODEL_OPTIONS = {
  default: {
    source: 'agent',
    modelConfigId: 'glm',
    connectionMissing: false,
    model: 'glm-5.3',
    effort: null,
  },
  options: [
    {
      id: 'glm',
      name: 'GLM',
      kind: 'third_party',
      model: 'glm-5.3',
      usable: true,
      models: [
        {
          id: 'glm-5.3',
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          display_name: 'GLM 5.3',
        },
      ],
    },
  ],
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    workspaceJid: 'web:home',
    workspaceFolder: 'home',
    workspaceName: '主工作区',
    createdBy: 'u1',
    name: '日报',
    prompt: '写日报',
    stopWhen: '本月结束',
    schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: 'UTC' },
    endAt: null,
    sessionMode: 'fresh',
    targetSessionJid: null,
    deliveryRouteJid: null,
    silentWhenIdle: true,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: '2026-10-31T09:00:00.000Z',
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 3,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    unreadRuns: 0,
    lastRunStatus: null,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    trigger: 'schedule',
    status: 'success',
    sessionJid: 'web:home#agent:s1',
    inputMessageId: null,
    scheduledFor: '2026-10-30T09:00:00.000Z',
    firedAt: '2026-10-30T09:00:00.000Z',
    finishedAt: '2026-10-30T09:01:05.000Z',
    resultText: '今天一切正常',
    error: null,
    preCheck: null,
    silenced: false,
    readAt: null,
    createdAt: '2026-10-30T09:00:00.000Z',
    ...overrides,
  };
}

let list: Automation[] = [];
let runsById: Record<string, AutomationRun[]> = {};
/** The workspace's model options; null answers 403. */
let modelOptions: unknown = MODEL_OPTIONS;
let root: Root | null = null;
let container: HTMLDivElement;

function emit(type: string, data: unknown) {
  mocks.handlers.get(type)?.forEach((handler) => handler(data));
}

function Subscribed() {
  useAutomationSubscription();
  return null;
}

async function flush() {
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Poll until `check` passes: lazy chunks (dialogs) load asynchronously. */
async function waitFor(check: () => void, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
}

async function render(path = '/automations') {
  const router = createMemoryRouter(
    [
      {
        path: '/automations/:automationId?',
        element: (
          <TooltipProvider>
            <Subscribed />
            <AutomationsPage />
            <AutomationFormHost />
            <ConfirmHost />
          </TooltipProvider>
        ),
      },
      { path: '/chat/:folder', element: <p>chat page</p> },
    ],
    { initialEntries: [path] },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router} />));
  await flush();
  return router;
}

const text = () => document.body.textContent ?? '';
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    typeof name === 'string'
      ? item.textContent?.trim() === name ||
        item.getAttribute('aria-label') === name
      : name.test(item.textContent ?? '') ||
        name.test(item.getAttribute('aria-label') ?? ''),
  );
const cell = (name: string) =>
  [...container.querySelectorAll('li')].find((li) =>
    li
      .querySelector('button[aria-current], button')
      ?.textContent?.includes(name),
  );

beforeEach(() => {
  list = [];
  runsById = {};
  modelOptions = MODEL_OPTIONS;
  forgetWorkspaceModelOptions();
  mocks.handlers.clear();
  for (const fn of [mocks.get, mocks.post, mocks.patch, mocks.delete])
    fn.mockReset();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/api/automations') return { automations: list };
    if (path.endsWith('/model-options')) {
      if (!modelOptions) throw { status: 403, message: 'Forbidden' };
      return modelOptions;
    }
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    const found = list.find((item) => item.id === id);
    if (!found) throw { status: 404, message: 'not found' };
    return { automation: found, runs: runsById[id] ?? [] };
  });
  mocks.post.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  useAutomationsStore.setState({
    automations: [],
    runs: {},
    loaded: false,
    loading: false,
    error: null,
    runBusy: {},
    formRequest: null,
  });
  useChatStore.setState({
    groups: {
      'web:home': {
        name: '主工作区',
        folder: 'home',
        added_at: '2026-01-01T00:00:00Z',
        interaction_mode: 'assistant',
        is_my_home: true,
        can_modify: true,
        execution_mode: 'container',
      },
    },
    agents: {
      'web:home': [
        {
          id: 's1',
          name: '周报会话',
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    },
    loadAgents: vi.fn(async () => undefined),
  } as never);
  useAuthStore.setState({
    user: { id: 'u1', username: 'owner', role: 'member' },
  } as never);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('automations page', () => {
  test('lists by workspace with subtitles, badges and unread dots', async () => {
    list = [
      automation({
        id: 'a1',
        name: '日报',
        unreadRuns: 1,
        lastRunStatus: 'failed',
      }),
      automation({
        id: 'a2',
        name: '巡检',
        status: 'paused',
        unreadRuns: 2,
        lastRunStatus: 'success',
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      automation({
        id: 'a3',
        name: '一次提醒',
        schedule: { kind: 'once', runAt: '2099-01-01T00:00:00Z' },
        lastRunStatus: 'queued',
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
    ];
    // a1 is shown in detail and reads its runs; the others stay unread.
    await render('/automations/a3');

    expect(
      container.querySelector('section[aria-label="主工作区"]'),
    ).not.toBeNull();
    const pausedCell = cell('巡检')!;
    expect(pausedCell.textContent).toContain('已暂停');
    expect(
      pausedCell.querySelector('[data-tone]')?.getAttribute('data-tone'),
    ).toBe('success');
    expect(
      cell('日报')!.querySelector('[data-tone]')?.getAttribute('data-tone'),
    ).toBe('error');
    const onceCell = cell('一次提醒')!;
    expect(onceCell.textContent).toContain('单次');
    expect(onceCell.textContent).toContain('排队中');

    // The filter keeps only paused ones.
    await act(async () => button('已暂停')!.click());
    expect(cell('巡检')).toBeDefined();
    expect(cell('日报')).toBeUndefined();
  });

  test('opening a detail marks its runs read and shows its runs', async () => {
    list = [automation({ unreadRuns: 1, lastRunStatus: 'success' })];
    runsById = {
      a1: [
        run({
          preCheck: {
            decision: 'run',
            exitCode: 0,
            timedOut: false,
            stdout: '3 new items',
            stderr: '',
          },
        }),
      ],
    };
    const router = await render('/automations/a1');

    expect(mocks.post).toHaveBeenCalledWith(
      '/api/automations/a1/runs/read',
      {},
    );
    expect(cell('日报')!.querySelector('[data-tone]')).toBeNull();
    expect(text()).toContain('每天 09:00 · AI 任务 · 每次新建');
    expect(text()).toContain('本月结束');
    expect(text()).toContain('最近运行 · 1');
    expect(text()).toContain('用时 1 分 5 秒');
    expect(text()).toContain('今天一切正常');
    expect(text()).toContain('前置检查通过 · 退出码 0');

    await act(async () => button(/打开会话/)!.click());
    expect(router.state.location.pathname).toBe('/chat/home');
    expect(router.state.location.search).toBe('?agent=s1');
  });

  test('a read-only guest sees the detail without any action', async () => {
    useAuthStore.setState({
      user: { id: 'g1', username: 'guest', role: 'guest' },
    } as never);
    list = [automation({ unreadRuns: 1, lastRunStatus: 'success' })];
    runsById = { a1: [run({ status: 'running', finishedAt: null })] };
    await render('/automations/a1');

    expect(text()).toContain('最近运行 · 1');
    for (const name of [
      '新建',
      '立即运行',
      '编辑',
      '更多操作',
      '暂停自动化',
      /终止/,
    ]) {
      expect([String(name), button(name)]).toEqual([String(name), undefined]);
    }
    expect(container.querySelector('[role="switch"]')).toBeNull();
    // Opening the detail does not try to mark runs read.
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test('WS run updates and changes refresh the list live', async () => {
    list = [automation()];
    await render('/automations/a1');
    expect(text()).toContain('最近运行 · 0');

    // A run starts: the cell shows it at once, the detail lists it.
    list = [automation({ lastRunStatus: 'running' })];
    runsById = { a1: [run({ status: 'running', finishedAt: null })] };
    await act(async () =>
      emit('automation_run_updated', {
        automationId: 'a1',
        run: run({ status: 'running', finishedAt: null }),
      }),
    );
    expect(cell('日报')!.textContent).toContain('运行中');
    expect(text()).toContain('最近运行 · 1');

    // Another tab paused it.
    list = [automation({ status: 'paused' })];
    await act(async () =>
      emit('automation_changed', {
        automationId: 'a1',
        workspaceJid: 'web:home',
      }),
    );
    await waitFor(() => expect(cell('日报')!.textContent).toContain('已暂停'));

    // And deleted it.
    await act(async () =>
      emit('automation_changed', { automationId: 'a1', deleted: true }),
    );
    expect(cell('日报')).toBeUndefined();
  });

  test.each([
    ['保留会话', 'keep', '删除自动化'],
    ['归档会话', 'archive', '删除自动化'],
    ['删除会话', 'delete', '删除自动化和会话'],
  ])(
    'delete asks what to do with its sessions: %s',
    async (label, value, confirmText) => {
      list = [automation()];
      await render('/automations/a1');
      const more = button('更多操作')!;
      await act(async () => {
        more.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => el.textContent?.includes('删除自动化'),
      ) as HTMLElement;
      await act(async () => item.click());
      await waitFor(() => expect(text()).toContain('删除自动化「日报」？'));
      expect(text()).toContain('删除后未来的触发会停止');
      const radio = [...document.querySelectorAll('[role="radio"]')].find(
        (el) => el.closest('label')?.textContent?.includes(label),
      ) as HTMLElement;
      await act(async () => radio.click());
      if (value === 'delete') expect(text()).toContain('此操作不可撤销');
      const confirm = [...document.querySelectorAll('button')].find(
        (el) => el.textContent?.trim() === confirmText,
      )!;
      await act(async () => confirm.click());
      await flush();

      expect(mocks.delete).toHaveBeenCalledWith(
        `/api/automations/a1?sessions=${value}`,
      );
      expect(cell('日报')).toBeUndefined();
    },
  );

  test('cancelling the delete dialog keeps the automation', async () => {
    list = [automation()];
    await render('/automations/a1');
    const { confirmChoiceDialog } = await import('../web/src/stores/confirm');
    let result: unknown = 'pending';
    await act(async () => {
      void confirmChoiceDialog({
        title: 't',
        message: 'm',
        defaultChoice: 'keep',
        choices: [{ value: 'keep', label: '保留会话' }],
      }).then((value) => (result = value));
    });
    await waitFor(() => expect(button('取消')).toBeDefined());
    await act(async () => button('取消')!.click());
    await flush();
    expect(result).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  test('立即运行 posts once while a request is in flight', async () => {
    list = [automation()];
    let resolveRun: (value: unknown) => void = () => undefined;
    mocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith('/run'))
        return new Promise((resolve) => (resolveRun = resolve));
      return undefined;
    });
    await render('/automations/a1');
    const detailButton = button('立即运行')!;
    await act(async () => detailButton.click());
    await act(async () => button('立即运行「日报」')!.click());
    expect(
      mocks.post.mock.calls.filter(([path]) => String(path).endsWith('/run')),
    ).toHaveLength(1);
    // The store guards too, for callers without a disabled button.
    await act(async () => {
      void useAutomationsStore.getState().runNow('a1');
    });
    expect(
      mocks.post.mock.calls.filter(([path]) => String(path).endsWith('/run')),
    ).toHaveLength(1);
    await act(async () => resolveRun({ run: run({ status: 'queued' }) }));
    await flush();
    expect(cell('日报')!.textContent).toContain('排队中');
  });

  test('the list and the detail name the model the runs use', async () => {
    list = [
      automation({
        id: 'a1',
        name: '日报',
        model: { modelConfigId: 'glm', model: 'glm-5.3', effort: 'high' },
      }),
      automation({
        id: 'a2',
        name: '巡检',
        sessionMode: 'persistent',
        model: { modelConfigId: 'glm', model: null, effort: null },
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      automation({
        id: 'a3',
        name: '提醒',
        model: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
    ];
    await render('/automations/a1');
    await waitFor(() =>
      expect(
        cell('日报')!.querySelector('[data-testid="automation-model"]')
          ?.textContent,
      ).toBe('GLM · GLM 5.3 · 高'),
    );
    expect(
      cell('巡检')!.querySelector('[data-testid="automation-model"]')
        ?.textContent,
    ).toBe('GLM · 连接默认模型');
    // Following the default adds nothing.
    expect(
      cell('提醒')!.querySelector('[data-testid="automation-model"]'),
    ).toBeNull();
    const detail = [
      ...container.querySelectorAll('dd[data-testid="automation-model"]'),
    ];
    expect(detail.map((item) => item.textContent)).toEqual([
      'GLM · GLM 5.3 · 高',
    ]);
    // One request for the workspace, however many rows ask.
    expect(
      mocks.get.mock.calls.filter(([path]) =>
        String(path).endsWith('/model-options'),
      ),
    ).toEqual([['/api/groups/web%3Ahome/model-options']]);
  });

  test('without the options the model is named by its ids', async () => {
    modelOptions = null;
    list = [
      automation({
        model: { modelConfigId: 'glm', model: 'glm-5.3', effort: 'high' },
      }),
    ];
    await render('/automations/a1');
    await waitFor(() =>
      expect(
        container.querySelector('dd[data-testid="automation-model"]')
          ?.textContent,
      ).toBe('glm · glm-5.3 · 高'),
    );
  });

  test('a guest sees no model choice', async () => {
    useAuthStore.setState({
      user: { id: 'g1', username: 'guest', role: 'guest' },
    } as never);
    list = [
      automation({
        model: { modelConfigId: 'glm', model: 'glm-5.3', effort: 'high' },
      }),
    ];
    await render('/automations/a1');
    expect(
      container.querySelector('[data-testid="automation-model"]'),
    ).toBeNull();
    expect(
      mocks.get.mock.calls.some(([path]) =>
        String(path).endsWith('/model-options'),
      ),
    ).toBe(false);
  });
});
