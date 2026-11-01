import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiGetMock, apiPostMock, apiPatchMock, apiDeleteMock, notifyMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(async (): Promise<unknown> => ({ agents: [] })),
    apiPostMock: vi.fn(),
    apiPatchMock: vi.fn(),
    apiDeleteMock: vi.fn(),
    notifyMock: vi.fn(),
  }));

vi.mock('../api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  },
  computeUploadTimeoutMs: vi.fn(() => 120_000),
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
  useAuthStore: {
    getState: () => ({
      user: { id: 'u1', username: 'owner', display_name: '主人' },
    }),
  },
}));

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: notifyMock,
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('./chat');
const initialState = useChatStore.getState();

const JID = 'web:sessions';
const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  prompt: '',
  status: 'idle' as const,
  kind: 'conversation' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const reply = (id: string, agentId: string) => ({
  id,
  chat_jid: `${JID}#agent:${agentId}`,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '完成了。',
  timestamp: '2026-01-01T00:01:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(
    {
      ...initialState,
      groups: {
        [JID]: {
          name: '会话测试',
          folder: 'sessions',
          added_at: '2026-01-01T00:00:00.000Z',
          interaction_mode: 'assistant',
        },
      },
      agents: { [JID]: [session('s1'), session('s2')] },
      agentMessages: { s1: [], s2: [] },
    },
    true,
  );
});

describe('pinning a session', () => {
  it('asks the server for this user, and keeps the time it pinned it at', async () => {
    apiPatchMock.mockResolvedValueOnce({
      success: true,
      pinned_at: '2026-02-01T00:00:00.000Z',
    });
    expect(await useChatStore.getState().pinSession(JID, 's2', true)).toBe(
      true,
    );
    expect(apiPatchMock).toHaveBeenCalledWith(
      '/api/groups/web%3Asessions/sessions/s2',
      { pinned: true },
    );
    const pinned = useChatStore.getState().agents[JID];
    expect(pinned.find((s) => s.id === 's2')?.pinned_at).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(pinned.find((s) => s.id === 's1')?.pinned_at).toBeUndefined();

    apiPatchMock.mockResolvedValueOnce({ success: true, pinned_at: null });
    await useChatStore.getState().pinSession(JID, 's2', false);
    expect(apiPatchMock).toHaveBeenLastCalledWith(
      '/api/groups/web%3Asessions/sessions/s2',
      { pinned: false },
    );
    expect(
      useChatStore.getState().agents[JID].find((s) => s.id === 's2')?.pinned_at,
    ).toBeNull();
  });

  it('leaves the list as it was when the server refuses', async () => {
    apiPatchMock.mockRejectedValueOnce({ status: 403, message: 'denied' });
    expect(await useChatStore.getState().pinSession(JID, 's1', true)).toBe(
      false,
    );
    expect(
      useChatStore.getState().agents[JID].find((s) => s.id === 's1')?.pinned_at,
    ).toBeUndefined();
  });
});

describe('deleting a session', () => {
  it('hands back the bindings a refused delete lists, keeping the session', async () => {
    apiDeleteMock.mockRejectedValueOnce({
      status: 409,
      body: {
        code: 'session_has_bindings',
        linked_im_groups: [{ jid: 'feishu:oc_1', name: '研发群' }],
        thread_bindings: [],
        automations: [],
      },
    });
    const result = await useChatStore.getState().deleteAgentAction(JID, 's1');
    expect(result).toEqual({
      bindings: {
        linkedImGroups: [{ jid: 'feishu:oc_1', name: '研发群' }],
        threadBindings: [],
        automations: [],
      },
    });
    expect(useChatStore.getState().agents[JID].map((s) => s.id)).toEqual([
      's1',
      's2',
    ]);
  });

  it('confirmed with a rebind target: deletes, closes it and reloads the list', async () => {
    useChatStore.setState({ activeAgentTab: { [JID]: 's1' } });
    apiDeleteMock.mockResolvedValueOnce({ success: true });
    const result = await useChatStore
      .getState()
      .deleteAgentAction(JID, 's1', { confirmBindings: true, rebindTo: 's2' });
    expect(result).toBe(true);
    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/groups/web%3Asessions/sessions/s1?confirm_bindings=true&rebind_to=s2',
    );
    const state = useChatStore.getState();
    expect(state.activeAgentTab[JID]).toBeUndefined();
    expect(state.agentMessages.s1).toBeUndefined();
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/groups/web%3Asessions/agents',
    );
  });
});

describe('every conversation is a session', () => {
  it('ignores a message or stream event that names no session', () => {
    const before = useChatStore.getState();
    useChatStore
      .getState()
      .handleWsNewMessage(JID, { ...reply('m1', 's1'), chat_jid: JID });
    useChatStore
      .getState()
      .handleStreamEvent(JID, { eventType: 'text_delta', text: 'x' });
    const after = useChatStore.getState();
    expect(after.agentMessages).toBe(before.agentMessages);
    expect(after.agentStreaming).toBe(before.agentStreaming);
  });

  it('counts a finished reply of a session not in view as unread, and notifies', () => {
    useChatStore.setState({
      currentGroup: JID,
      activeAgentTab: { [JID]: 's1' },
    });
    useChatStore.getState().handleWsNewMessage(JID, reply('m1', 's2'), 's2');
    expect(useChatStore.getState().unreadReplies[JID]).toBe(1);
    expect(notifyMock).toHaveBeenCalledWith('会话测试', '完成了。');

    // The same frame again counts nothing; a reply in view counts nothing.
    useChatStore.getState().handleWsNewMessage(JID, reply('m1', 's2'), 's2');
    useChatStore.getState().handleWsNewMessage(JID, reply('m2', 's1'), 's1');
    expect(useChatStore.getState().unreadReplies[JID]).toBe(1);
  });

  it('shows a sent message at once, from the server answer', async () => {
    apiPostMock.mockResolvedValueOnce({
      success: true,
      messageId: 'sent-1',
      timestamp: '2026-01-01T00:02:00.000Z',
      ingestSequence: 7,
      disposition: 'queued',
    });
    expect(
      await useChatStore.getState().sendAgentMessage(JID, 's1', '你好'),
    ).toBe(true);
    expect(apiPostMock.mock.calls[0][1]).toMatchObject({
      chatJid: JID,
      agentId: 's1',
      content: '你好',
    });
    const [sent] = useChatStore.getState().agentMessages.s1;
    expect(sent).toMatchObject({
      id: 'sent-1',
      chat_jid: `${JID}#agent:s1`,
      sender: 'u1',
      content: '你好',
      ingest_sequence: 7,
      delivery_status: 'queued',
    });
    expect(useChatStore.getState().agentWaiting.s1).toBe(true);
  });
});
