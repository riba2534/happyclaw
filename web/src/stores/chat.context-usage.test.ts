import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: { get: apiGetMock, post: apiPostMock, patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('./files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('./auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('./chat');

const usage = (usedTokens: number) => ({
  usedTokens,
  contextWindow: 200_000,
  percentage: (usedTokens / 200_000) * 100,
});

/** A context divider as the server pushes it after /clear or /fresh. */
const divider = (content: string) => ({
  id: `divider-${content}`,
  chat_jid: 'web:g1',
  sender: '__system__',
  sender_name: 'system',
  content,
  timestamp: new Date().toISOString(),
  is_from_me: true,
});

const stored = () => useChatStore.getState().contextUsage;

describe('context usage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    useChatStore.setState({ contextUsage: {} });
  });

  it('loads each session under its own key', async () => {
    apiGetMock.mockResolvedValueOnce(usage(20_000));
    apiGetMock.mockResolvedValueOnce(usage(90_000));
    await useChatStore.getState().loadContextUsage('web:g1', 'a0');
    await useChatStore.getState().loadContextUsage('web:g1', 'a1');

    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/groups/web%3Ag1/context-usage?agentId=a0',
      '/api/groups/web%3Ag1/context-usage?agentId=a1',
    ]);
    expect(stored()['web:g1#agent:a0']?.usedTokens).toBe(20_000);
    expect(stored()['web:g1#agent:a1']?.usedTokens).toBe(90_000);
  });

  it('stores nothing-ran-yet as null', async () => {
    apiGetMock.mockResolvedValueOnce({
      usedTokens: null,
      contextWindow: null,
      percentage: null,
      model: null,
      updatedAt: null,
    });
    await useChatStore.getState().loadContextUsage('web:g1', 'a1');
    expect(stored()).toEqual({ 'web:g1#agent:a1': null });
  });

  it('a push replaces the value; a reply that started before it does not', async () => {
    let answer!: (value: unknown) => void;
    apiGetMock.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const loading = useChatStore.getState().loadContextUsage('web:g1', 'a1');
    useChatStore.getState().setContextUsage('web:g1', 'a1', {
      ...usage(60_000),
      // Other fields of the WS frame are dropped.
      ...{ type: 'context_usage', chatJid: 'web:g1', model: 'opus' },
    });
    answer(usage(20_000));
    await loading;

    expect(stored()['web:g1#agent:a1']).toEqual(usage(60_000));
  });

  it('a reset or a context divider from anywhere empties it until the next turn', async () => {
    useChatStore.getState().setContextUsage('web:g1', 'a0', usage(60_000));
    useChatStore.getState().setContextUsage('web:g1', 'a1', usage(80_000));

    apiPostMock.mockResolvedValueOnce({ success: true, dividerMessageId: 'd' });
    apiGetMock.mockResolvedValue({ messages: [], hasMore: false });
    await useChatStore.getState().resetSession('web:g1', 'a1');
    expect(stored()['web:g1#agent:a1']).toBeNull();
    expect(stored()['web:g1#agent:a0']?.usedTokens).toBe(60_000);

    // /clear from IM, or /fresh by the agent: the divider comes over WS.
    useChatStore.getState().setContextUsage('web:g1', 'a1', usage(80_000));
    useChatStore
      .getState()
      .handleWsNewMessage('web:g1', divider('context_fresh_window'), 'a1');
    expect(stored()['web:g1#agent:a1']).toBeNull();
    expect(stored()['web:g1#agent:a0']?.usedTokens).toBe(60_000);
    useChatStore
      .getState()
      .handleWsNewMessage('web:g1', divider('context_reset'), 'a0');
    expect(stored()['web:g1#agent:a0']).toBeNull();
  });
});
