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

const { useChatStore } = await import('./chat');
const { useGroupsStore } = await import('./groups');
const initialState = useChatStore.getState();

const JID = 'web:alpha';
const group = {
  name: 'Alpha',
  folder: 'alpha',
  added_at: '2026-01-01T00:00:00.000Z',
  interaction_mode: 'assistant' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ ...initialState, groups: { [JID]: group } }, true);
  useGroupsStore.setState({ groups: { [JID]: group } } as never);
});

describe('work mode (工作方式)', () => {
  it('creates a workspace with the chosen mode, single by default', async () => {
    apiPostMock.mockResolvedValue({
      success: true,
      jid: 'web:new',
      group: { ...group, folder: 'new', work_mode: 'multi' },
    });
    await useChatStore
      .getState()
      .createFlow('新工作区', { work_mode: 'multi' });
    expect(apiPostMock).toHaveBeenLastCalledWith(
      '/api/groups',
      expect.objectContaining({ name: '新工作区', work_mode: 'multi' }),
      undefined,
    );
    expect(useChatStore.getState().groups['web:new'].work_mode).toBe('multi');

    await useChatStore.getState().createFlow('另一个');
    expect(apiPostMock).toHaveBeenLastCalledWith(
      '/api/groups',
      expect.objectContaining({ work_mode: 'single' }),
      undefined,
    );
  });

  it('PATCHes the workspace and keeps the mode the server echoes', async () => {
    apiPatchMock.mockResolvedValueOnce({ success: true, work_mode: 'multi' });
    await expect(
      useChatStore.getState().updateWorkMode(JID, 'multi'),
    ).resolves.toBe(true);
    expect(apiPatchMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}`,
      {
        work_mode: 'multi',
      },
    );
    expect(useChatStore.getState().groups[JID].work_mode).toBe('multi');
    expect(useGroupsStore.getState().groups[JID].work_mode).toBe('multi');
  });

  it('reports a failed save and leaves the mode as it was', async () => {
    apiPatchMock.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      useChatStore.getState().updateWorkMode(JID, 'multi'),
    ).resolves.toBe(false);
    expect(useChatStore.getState().groups[JID].work_mode).toBeUndefined();
  });
});
