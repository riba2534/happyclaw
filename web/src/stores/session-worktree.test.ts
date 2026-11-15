import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../api/client', () => ({ api, apiFetch: vi.fn() }));

vi.mock('../api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
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
const { useFileStore, workspaceFilesUrl, listWorkspaceFiles } =
  await import('./files');

const JID = 'web:dev';
const dirtyError = (body: Record<string, unknown>) => ({
  status: 409,
  message: 'dirty',
  body: { code: 'WORKTREE_DIRTY', ...body },
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useFileStore.getState().setFileScopeSession(JID, null);
  useChatStore.setState({ agents: {}, error: null, clearing: {} });
});

describe('session worktrees in the chat store', () => {
  it('asks for a worktree and keeps it when the WS event added the session first', async () => {
    api.post.mockImplementation(async () => {
      // The broadcast lands before the HTTP response.
      useChatStore.setState({
        agents: {
          [JID]: [
            {
              id: 's1',
              name: '新对话',
              prompt: '',
              status: 'idle',
              kind: 'conversation',
              created_at: '',
            },
          ],
        },
      });
      return {
        session: {
          id: 's1',
          name: '新对话',
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_at: '',
          worktree: {
            branch: 'happyclaw/s1',
            base_commit: 'abc',
            status: 'active',
            broken_reason: null,
          },
        },
      };
    });
    await useChatStore
      .getState()
      .createConversation(JID, '', undefined, { worktree: true });
    expect(api.post).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/sessions`,
      {
        name: '',
        description: undefined,
        worktree: true,
      },
    );
    expect(useChatStore.getState().agents[JID][0].worktree?.branch).toBe(
      'happyclaw/s1',
    );
  });

  it('sends a picked model with the session, and nothing for the default', async () => {
    const created = {
      session: {
        id: 's2',
        name: '新对话',
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_at: '',
      },
    };
    api.post.mockResolvedValue(created);
    await useChatStore.getState().createConversation(JID, '', undefined, {
      model: { modelConfigId: 'glm', model: 'glm-4.6', effort: 'high' },
    });
    expect(api.post).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/sessions`,
      {
        name: '',
        description: undefined,
        modelConfigId: 'glm',
        model: 'glm-4.6',
        effort: 'high',
      },
    );
    // A connection without a model or an effort names both as null.
    await useChatStore.getState().createConversation(JID, '', undefined, {
      model: { modelConfigId: 'glm', model: null, effort: null },
    });
    expect(api.post.mock.lastCall?.[1]).toStrictEqual({
      name: '',
      description: undefined,
      modelConfigId: 'glm',
      model: null,
      effort: null,
    });
    await useChatStore
      .getState()
      .createConversation(JID, '', undefined, { model: null });
    expect(api.post.mock.lastCall?.[1]).toStrictEqual({
      name: '',
      description: undefined,
    });
  });

  it('a refused model keeps the reason the server gives and creates nothing', async () => {
    api.post.mockRejectedValue({
      status: 400,
      message: '所选模型已不在该模型配置的模型列表里',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    const created = await useChatStore
      .getState()
      .createConversation(JID, '', undefined, {
        model: { modelConfigId: 'glm', model: 'gone', effort: null },
      });
    expect(created).toBeNull();
    expect(useChatStore.getState().error).toBe(
      '所选模型已不在该模型配置的模型列表里',
    );
    expect(useChatStore.getState().agents[JID]).toBeUndefined();
  });

  it('takes the worktree branch from agent_status and keeps it on later updates', () => {
    const worktree = {
      branch: 'happyclaw/s9',
      base_commit: 'abc',
      status: 'active' as const,
      broken_reason: null,
    };
    // Another tab created the session: this tab only sees the broadcast.
    useChatStore
      .getState()
      .handleAgentStatus(
        JID,
        's9',
        'idle',
        '新对话',
        '',
        undefined,
        'conversation',
        undefined,
        worktree,
      );
    expect(useChatStore.getState().agents[JID][0].worktree).toEqual(worktree);
    useChatStore
      .getState()
      .handleAgentStatus(
        JID,
        's9',
        'running',
        '新对话',
        '',
        undefined,
        'conversation',
      );
    expect(useChatStore.getState().agents[JID][0].worktree).toEqual(worktree);
  });

  it('reports uncommitted worktree changes instead of failing a session delete', async () => {
    api.delete.mockRejectedValueOnce(
      dirtyError({
        dirty_worktrees: [
          { session_id: 's1', branch: 'happyclaw/s1', changed_files: 3 },
        ],
      }),
    );
    await expect(
      useChatStore.getState().deleteAgentAction(JID, 's1'),
    ).resolves.toEqual({
      worktreesDirty: [
        { sessionId: 's1', branch: 'happyclaw/s1', changedFiles: 3 },
      ],
    });
    expect(useChatStore.getState().error).toBeNull();

    api.delete.mockResolvedValueOnce({ success: true });
    await expect(
      useChatStore
        .getState()
        .deleteAgentAction(JID, 's1', { forceWorktree: true }),
    ).resolves.toBe(true);
    expect(api.delete).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/sessions/s1?force_worktree=true`,
    );
  });

  it('reports uncommitted worktree changes instead of failing a rebuild', async () => {
    api.post.mockRejectedValueOnce(
      dirtyError({
        dirty_worktrees: [
          { session_id: 's1', branch: 'happyclaw/s1', changed_files: 2 },
        ],
      }),
    );
    await expect(useChatStore.getState().clearHistory(JID)).resolves.toEqual({
      worktreesDirty: [
        { sessionId: 's1', branch: 'happyclaw/s1', changedFiles: 2 },
      ],
    });
    expect(useChatStore.getState().clearing[JID]).toBeUndefined();

    api.post.mockRejectedValueOnce({ status: 500, message: 'boom' });
    await expect(
      useChatStore
        .getState()
        .clearHistory(JID, { confirmedWorktrees: ['s1', 's2'] }),
    ).resolves.toBe(false);
    expect(api.post).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/clear-history?force_worktrees=true&confirmed_worktrees=s1%2Cs2`,
    );
  });
});

describe('file scope of a worktree session', () => {
  it('sends the session to every file endpoint and lists from the root again', async () => {
    api.get.mockResolvedValue({ files: [], currentPath: '' });
    await useFileStore.getState().loadFiles(JID, 'src');
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/files?path=src`,
    );

    useFileStore.getState().setFileScopeSession(JID, 's1');
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/files?agentId=s1`,
    );
    expect(workspaceFilesUrl(JID, 'files/download/eA')).toBe(
      `/api/groups/${encodeURIComponent(JID)}/files/download/eA?agentId=s1`,
    );

    useFileStore.getState().setFileScopeSession(JID, null);
    expect(workspaceFilesUrl(JID, 'directories')).toBe(
      `/api/groups/${encodeURIComponent(JID)}/directories`,
    );
  });

  it('drops a listing that finishes after the scope changed', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    api.get.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    const stale = useFileStore.getState().loadFiles(JID, '');
    api.get.mockResolvedValueOnce({
      files: [{ name: 'worktree.txt' }],
      currentPath: '',
    });
    useFileStore.getState().setFileScopeSession(JID, 's2');
    await vi.waitFor(() =>
      expect(useFileStore.getState().files[JID]?.[0]?.name).toBe(
        'worktree.txt',
      ),
    );
    resolveOld({ files: [{ name: 'main.txt' }], currentPath: '' });
    await stale;
    expect(useFileStore.getState().files[JID]?.[0]?.name).toBe('worktree.txt');
    // The @ picker lists through the same scope.
    api.get.mockResolvedValueOnce({ files: [], currentPath: 'lib' });
    await listWorkspaceFiles(JID, 'lib');
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/files?path=lib&agentId=s2`,
    );
  });
});
