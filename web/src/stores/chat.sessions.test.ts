import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiGetMock, apiPostMock, apiPatchMock, apiDeleteMock, notifyMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(
      async (_url?: string): Promise<unknown> => ({
        agents: [],
      }),
    ),
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

const snapshots = await import('../utils/messageSnapshotCache');
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
  source_kind: 'sdk_final' as const,
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

describe('a session whose history is not loaded', () => {
  const at = (minute: number) =>
    `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const row = (id: string, minute: number) => ({
    ...reply(id, 's3'),
    content: id,
    timestamp: at(minute),
  });
  /** GET …/messages answers newest first, as the server does. */
  const page = (rows: ReturnType<typeof row>[], hasMore = false) => ({
    messages: [...rows].reverse(),
    hasMore,
  });
  /** The next GET answers when the test says so. */
  const deferGet = () => {
    let answer!: (value: unknown) => void;
    apiGetMock.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    return (value: unknown) => answer(value);
  };
  const ids = () =>
    useChatStore.getState().agentMessages.s3?.map((message) => message.id);

  beforeEach(() => {
    useChatStore.setState({
      agents: { [JID]: [session('s1'), session('s2'), session('s3')] },
      currentGroup: JID,
      activeAgentTab: { [JID]: 's1' },
    });
  });

  it('stays not loaded when a message arrives in the background, and opening it loads the whole history', async () => {
    useChatStore.getState().handleWsNewMessage(JID, row('m3', 3), 's3');
    const state = useChatStore.getState();
    expect(state.agentMessages.s3).toBeUndefined();
    expect(snapshots.saveAgentMessageSnapshot).not.toHaveBeenCalled();
    // Its row still shows the message, and it counts as unread.
    expect(
      state.agents[JID].find((s) => s.id === 's3')?.latest_message?.content,
    ).toBe('m3');
    expect(state.unreadReplies[JID]).toBe(1);

    apiGetMock.mockResolvedValueOnce(
      page([row('m1', 1), row('m2', 2), row('m3', 3)], true),
    );
    await useChatStore.getState().loadAgentMessages(JID, 's3');
    expect(ids()).toEqual(['m1', 'm2', 'm3']);
    expect(useChatStore.getState().agentHasMore.s3).toBe(true);
    expect(snapshots.saveAgentMessageSnapshot).toHaveBeenLastCalledWith(
      JID,
      's3',
      expect.arrayContaining([expect.objectContaining({ id: 'm1' })]),
      true,
    );
  });

  it('keeps what is announced while its history loads, once and in order', async () => {
    const answer = deferGet();
    const loading = useChatStore.getState().loadAgentMessages(JID, 's3');
    // m2 is in the page too; m4 came after the page was read.
    useChatStore.getState().handleWsNewMessage(JID, row('m4', 4), 's3');
    useChatStore.getState().handleWsNewMessage(JID, row('m2', 2), 's3');
    expect(useChatStore.getState().agentMessages.s3).toBeUndefined();
    answer(page([row('m1', 1), row('m2', 2), row('m3', 3)]));
    await loading;
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4']);

    // That load is over: the next one starts from what the server says.
    apiGetMock.mockResolvedValueOnce(page([row('m1', 1)]));
    await useChatStore.getState().loadAgentMessages(JID, 's3');
    expect(ids()).toEqual(['m1']);
  });

  it('a send answered while its history loads joins it', async () => {
    const answer = deferGet();
    const loading = useChatStore.getState().loadAgentMessages(JID, 's3');
    apiPostMock.mockResolvedValueOnce({
      success: true,
      messageId: 'sent-3',
      timestamp: at(5),
      disposition: 'queued',
    });
    await useChatStore.getState().sendAgentMessage(JID, 's3', 'sent-3');
    expect(useChatStore.getState().agentMessages.s3).toBeUndefined();
    answer(page([row('m1', 1)]));
    await loading;
    expect(ids()).toEqual(['m1', 'sent-3']);
  });

  it('a message deleted while its history loads stays deleted', async () => {
    const answer = deferGet();
    const loading = useChatStore.getState().loadAgentMessages(JID, 's3');
    useChatStore.getState().handleWsNewMessage(JID, row('m4', 4), 's3');
    await useChatStore.getState().handleMessageDeleted(`${JID}#agent:s3`, 'm4');
    answer(page([row('m1', 1)]));
    await loading;
    expect(ids()).toEqual(['m1']);
  });

  it('refreshing it loads its history instead of only the newest page, unless a load is under way', async () => {
    apiGetMock.mockResolvedValueOnce(page([row('m1', 1), row('m2', 2)], true));
    await useChatStore.getState().refreshAgentMessages(JID, 's4');
    expect(apiGetMock.mock.calls[0][0]).not.toMatch(/after/);
    expect(useChatStore.getState().agentMessages.s4).toHaveLength(2);
    expect(useChatStore.getState().agentHasMore.s4).toBe(true);

    const answer = deferGet();
    const loading = useChatStore.getState().loadAgentMessages(JID, 's3');
    await useChatStore.getState().refreshAgentMessages(JID, 's3');
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    answer(page([row('m1', 1)]));
    await loading;
    expect(ids()).toEqual(['m1']);
  });

  it('a refresh that lands after its list was let go does not rebuild it', async () => {
    useChatStore.setState({ agentMessages: { s3: [row('m1', 1)] } });
    const answer = deferGet();
    const refreshing = useChatStore.getState().refreshAgentMessages(JID, 's3');
    useChatStore.setState({ agentMessages: {} });
    answer({ messages: [row('m2', 2)] });
    await refreshing;
    expect(useChatStore.getState().agentMessages.s3).toBeUndefined();
    expect(snapshots.saveAgentMessageSnapshot).not.toHaveBeenCalled();
  });

  it('a row announced during the load lands as the shown list last had it', async () => {
    // Shown from its snapshot while the page loads.
    useChatStore.setState({ agentMessages: { s3: [row('m1', 1)] } });
    const answer = deferGet();
    const loading = useChatStore.getState().loadAgentMessages(JID, 's3');
    const queued = {
      ...row('q1', 2),
      is_from_me: false,
      delivery_status: 'queued' as const,
    };
    useChatStore.getState().handleWsNewMessage(JID, queued, 's3');
    useChatStore.getState().handleFollowUpUpdate(`${JID}#agent:s3`, [], {
      id: 'q1',
      delivery_status: 'released',
      delivery_updated_at: at(3),
    });
    answer(page([row('m1', 1)]));
    await loading;
    expect(
      useChatStore.getState().agentMessages.s3?.find((m) => m.id === 'q1')
        ?.delivery_status,
    ).toBe('released');
  });
});
