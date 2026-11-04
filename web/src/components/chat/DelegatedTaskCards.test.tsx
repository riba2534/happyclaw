// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { DelegatedTaskCards } = await import('./DelegatedTaskCards');
const { useWorkItemsStore } = await import('../../stores/work-items');
const { useConfirmStore } = await import('../../stores/confirm');
const { useAuthStore } = await import('../../stores/auth');
import type { WorkItemView } from '../../work-items';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'web:alpha';

function item(
  seq: number,
  overrides: Partial<WorkItemView> = {},
): WorkItemView {
  return {
    id: `wi-${seq}`,
    seq,
    workspaceJid: WS,
    workspaceFolder: 'alpha',
    workspaceName: 'Alpha',
    channelJid: `${WS}#agent:main`,
    channelName: null,
    agentId: `worker-${seq}`,
    title: `任务 ${seq}`,
    sourceMessageId: `delegate:${seq}`,
    sourceRouteJid: `${WS}#agent:main`,
    origin: 'delegated',
    originAgentId: 'main',
    originInputId: 'in-1',
    originSessionName: '主会话',
    status: 'open',
    outcome: null,
    stage: 'working',
    lastReport: null,
    lastSummary: null,
    attention: null,
    approvedAt: null,
    createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: '2026-11-01T02:00:00.000Z',
    endedAt: null,
    ...overrides,
  } as WorkItemView;
}

const ended = (
  seq: number,
  outcome: WorkItemView['outcome'],
  endedAt = '2026-11-01T05:00:00.000Z',
) =>
  item(seq, {
    status: 'ended',
    stage: 'ended',
    outcome,
    endedAt,
    updatedAt: endedAt,
  });

let root: Root | null = null;

function setUser(role: 'member' | 'guest') {
  useAuthStore.setState({
    user: { id: 'u', role, permissions: [] },
  } as never);
}

async function render(items: WorkItemView[], personWroteAt = 0) {
  useWorkItemsStore.setState({
    items: Object.fromEntries(items.map((entry) => [entry.id, entry])),
    // Fetched already: the cards read what the store holds.
    requested: { [WS]: 'recent' },
    busy: {},
  });
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <DelegatedTaskCards
          groupJid={WS}
          sessionId="main"
          personWroteAt={personWroteAt}
        />
      </MemoryRouter>,
    );
  });
}

const section = () => document.querySelector('[data-testid="delegated-tasks"]');
const rows = () => [...document.querySelectorAll('[role="listitem"]')];
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;

beforeEach(() => setUser('member'));

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('delegated task cards', () => {
  test('each task shows its number, title, status and latest summary', async () => {
    await render([
      item(1, { lastSummary: '已读完接口定义，正在补示例。' }),
      item(2, { stage: 'answer', attention: '要不要覆盖旧文档？' }),
      ended(3, 'completed'),
      ended(4, 'failed'),
      ended(5, 'stopped'),
      item(6, { origin: 'team', originAgentId: null }),
      item(7, { originAgentId: 'other' }),
    ]);
    expect(section()?.getAttribute('aria-label')).toBe('后台任务');
    expect(section()?.textContent).toContain('2 个进行中');
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^#1 任务 1进行中已读完接口定义/),
      expect.stringMatching(/^#2 任务 2等你回答要不要覆盖旧文档？/),
      expect.stringMatching(/^#3 任务 3已完成/),
      expect.stringMatching(/^#4 任务 4失败/),
      expect.stringMatching(/^#5 任务 5已停止/),
    ]);
  });

  test('ended tasks go once the person writes again; open ones stay', async () => {
    await render(
      [item(1), ended(2, 'completed', '2026-11-01T05:00:00.000Z')],
      Date.parse('2026-11-01T06:00:00.000Z'),
    );
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^#1 任务 1进行中/),
    ]);
  });

  test('nothing renders when the session delegated nothing', async () => {
    await render([item(6, { origin: 'team', originAgentId: null })]);
    expect(section()).toBeNull();
  });

  test('stopping asks first and posts only once confirmed', async () => {
    api.post.mockResolvedValue({ item: ended(1, 'stopped') });
    api.get.mockResolvedValue({ item: ended(1, 'stopped'), events: [] });
    await render([item(1), ended(2, 'completed')]);
    // An ended task has nothing to stop.
    expect(button('停止', rows()[1])).toBeUndefined();

    await act(async () => button('停止', rows()[0])!.click());
    expect(useConfirmStore.getState().pending).toMatchObject({
      title: '停止 #1 任务 1？',
      variant: 'danger',
    });
    await act(async () => useConfirmStore.getState().settle(false));
    expect(api.post).not.toHaveBeenCalled();

    await act(async () => button('停止', rows()[0])!.click());
    await act(async () => useConfirmStore.getState().settle(true));
    expect(api.post).toHaveBeenCalledWith('/api/work-items/wi-1/stop');
    expect(rows()[0].textContent).toContain('已停止');
  });

  test('a guest reads the tasks and has no stop', async () => {
    setUser('guest');
    await render([item(1)]);
    expect(rows()[0].textContent).toContain('进行中');
    expect(button('查看', rows()[0])).toBeDefined();
    expect(button('停止')).toBeUndefined();
  });
});
