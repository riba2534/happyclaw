// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet, store } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  store: {
    groups: {
      'web:home': {
        name: '我的工作区',
        folder: 'home',
        added_at: '2026-01-01T00:00:00.000Z',
        is_my_home: true,
      },
    },
    loadGroups: vi.fn(async () => undefined),
    loadAgents: vi.fn(async () => undefined),
    loadAvailableImGroups: vi.fn(async () => []),
    syncAvailableImGroups: vi.fn(async () => []),
  },
}));
vi.mock('../../../api/client', () => ({ api: { get: apiGet } }));
vi.mock('../../../stores/chat', () => ({
  useChatStore: (select: (state: typeof store) => unknown) => select(store),
}));

const { useImBindings } = await import('./useImBindings');

describe('the bindings page', () => {
  test('offers only the sessions a chat can be bound to', async () => {
    apiGet.mockResolvedValue({
      sessions: [
        {
          id: 'talk',
          name: '日常',
          kind: 'conversation',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'router',
          name: '团队路由',
          kind: 'conversation',
          source_kind: 'team_router',
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'topic',
          name: '话题',
          kind: 'conversation',
          source_kind: 'feishu_thread',
          created_at: '2026-01-03T00:00:00.000Z',
        },
      ],
    });
    let result!: ReturnType<typeof useImBindings>;
    function Probe() {
      result = useImBindings();
      return null;
    }
    await act(async () => {
      createRoot(document.createElement('div')).render(<Probe />);
    });
    await act(async () => await new Promise((resolve) => setTimeout(resolve)));
    expect(
      result.targets
        .filter((target) => target.type === 'session')
        .map((target) => target.sessionId),
    ).toEqual(['talk']);
  });
});
