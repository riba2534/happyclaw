// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api/client', () => ({ api }));
vi.mock('../api/ws', () => ({
  wsManager: { on: vi.fn(() => vi.fn()), connect: vi.fn(), send: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A desktop window: the list beside the detail.
vi.mock('../hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => query === '(min-width: 1024px)',
}));

const { WorkItemsPage } = await import('./WorkItemsPage');
const { useChatStore } = await import('../stores/chat');
const { useWorkItemsStore } = await import('../stores/work-items');
import type { WorkItemView } from '../work-items';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'web:alpha';

function item(
  seq: number,
  title: string,
  overrides: Partial<WorkItemView> = {},
): WorkItemView {
  return {
    id: `wi-${seq}`,
    seq,
    workspaceJid: WS,
    workspaceFolder: 'alpha',
    workspaceName: 'Alpha 工作区',
    channelJid: 'feishu:oc_team',
    channelName: '研发群',
    agentId: `worker-${seq}`,
    title,
    sourceMessageId: `om_${seq}`,
    sourceRouteJid: 'feishu:oc_team',
    origin: 'team',
    originAgentId: null,
    originInputId: null,
    originSessionName: null,
    mandate: {
      strength: 'explicit',
      requesterImId: 'ou_1',
      requesterName: '王小明',
      requesterListed: true,
      requesterIsOwner: false,
      matchedRules: [],
      settingsVersion: 1,
      writable: true,
    },
    status: 'open',
    outcome: null,
    stage: 'working',
    lastReport: null,
    lastSummary: null,
    attention: null,
    attentionMessageId: null,
    approvedAt: null,
    createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: `2026-11-01T0${seq % 10}:00:00.000Z`,
    endedAt: null,
    ...overrides,
  } as WorkItemView;
}

const delegated = (
  seq: number,
  title: string,
  overrides: Partial<WorkItemView> = {},
) =>
  item(seq, title, {
    origin: 'delegated',
    originAgentId: 'main',
    originInputId: 'in-1',
    originSessionName: '需求梳理',
    channelJid: `${WS}#agent:main`,
    channelName: null,
    sourceMessageId: `delegate:${seq}`,
    sourceRouteJid: `${WS}#agent:main`,
    ...overrides,
  });

let served: WorkItemView[] = [];

api.get.mockImplementation(async (path: string) => {
  if (path.includes('/work-decisions')) return { decisions: [] };
  const detail = path.match(/^\/api\/work-items\/([^/?]+)$/);
  if (detail) {
    const found = served.find((entry) => entry.id === detail[1]);
    return {
      item: found,
      events: [
        {
          id: 1,
          workItemId: found?.id,
          kind: 'input',
          state: null,
          text: '把接口文档按模块整理成表格',
          triggerMessageId: 'm-assign',
          createdAt: '2026-11-01T01:00:00.000Z',
        },
      ],
      subscriptions: [],
    };
  }
  const status = new URL(path, 'http://x').searchParams.get('status');
  return { items: served.filter((entry) => entry.status === status) };
});

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useWorkItemsStore.setState({
    items: {},
    decisions: {},
    details: {},
    loaded: false,
  });
});

async function render(route: string, items: WorkItemView[]) {
  served = items;
  useChatStore.setState({
    groups: {
      [WS]: {
        name: 'Alpha 工作区',
        folder: 'alpha',
        added_at: '2026-01-01T00:00:00.000Z',
        interaction_mode: 'assistant',
        can_modify: true,
      },
    },
  });
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/work/:itemId?" element={<WorkItemsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const list = () => document.querySelector('aside[aria-label="工作项列表"]')!;
const viewGroup = () => document.querySelector('[aria-label="工作项来源"]');
const viewButton = (label: string) =>
  [...viewGroup()!.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  )!;
const rowTexts = () =>
  [...list().querySelectorAll('li button')].map((row) => row.textContent);

describe('工作项: delegated tasks list apart from the team', () => {
  const mixed = () => [
    item(12, '修复登录页报错'),
    item(9, '升级依赖', {
      status: 'ended',
      stage: 'ended',
      outcome: 'completed',
      endedAt: '2026-11-01T05:00:00.000Z',
    }),
    delegated(20, '整理接口文档', { lastSummary: '已完成一半' }),
    delegated(21, '补测试', {
      status: 'ended',
      stage: 'ended',
      outcome: 'stopped',
      endedAt: '2026-11-01T06:00:00.000Z',
    }),
  ];

  test('team items first, delegated tasks one switch away', async () => {
    await render('/work', mixed());
    expect(viewButton('团队工作项').getAttribute('aria-pressed')).toBe('true');
    expect(rowTexts()).toEqual([
      expect.stringContaining('#12 修复登录页报错'),
      expect.stringContaining('#9 升级依赖'),
    ]);

    await act(async () => viewButton('派出的任务').click());
    expect(viewButton('派出的任务').getAttribute('aria-pressed')).toBe('true');
    expect(rowTexts()).toEqual([
      expect.stringMatching(
        /#20 整理接口文档.*进行中.*Alpha 工作区 · 需求梳理/,
      ),
      expect.stringMatching(/#21 补测试.*已停止.*Alpha 工作区 · 需求梳理/),
    ]);
    // The desktop opens the first task of the view.
    expect(document.querySelector('main h1')?.textContent).toBe(
      '#20 整理接口文档',
    );
  });

  test('a delegated task says which session sent it', async () => {
    await render('/work/wi-20', mixed());
    expect(viewButton('派出的任务').getAttribute('aria-pressed')).toBe('true');
    const main = document.querySelector('main')!;
    expect(main.textContent).toContain('来源会话需求梳理');
    expect(main.textContent).toContain('把接口文档按模块整理成表格');
    expect(main.textContent).not.toContain('订阅的话题');
    expect(main.textContent).not.toContain('授权依据');
    expect(
      [...main.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Worker 会话',
      ),
    ).toBe(true);
  });

  test('without delegated tasks the page is as before', async () => {
    await render('/work', [item(12, '修复登录页报错')]);
    expect(viewGroup()).toBeNull();
    expect(rowTexts()).toEqual([expect.stringContaining('#12 修复登录页报错')]);
    expect(document.querySelector('main')?.textContent).toContain('授权依据');
  });

  test('only delegated tasks open on their view', async () => {
    await render('/work', [delegated(20, '整理接口文档')]);
    expect(viewButton('派出的任务').getAttribute('aria-pressed')).toBe('true');
    expect(rowTexts()).toEqual([expect.stringContaining('#20 整理接口文档')]);
  });
});
