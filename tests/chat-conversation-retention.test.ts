import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

const {
  apiGetMock,
  apiPostMock,
  apiPatchMock,
  apiDeleteMock,
  deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshotMock,
  notifyIfHiddenMock,
  showToastMock,
  showNotificationPromptToastMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  deleteAgentMessageSnapshotMock: vi.fn(),
  deleteGroupMessageSnapshotsMock: vi.fn(),
  loadAgentMessageSnapshotMock: vi.fn(),
  saveAgentMessageSnapshotMock: vi.fn(),
  notifyIfHiddenMock: vi.fn(),
  showToastMock: vi.fn(),
  showNotificationPromptToastMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: {
    getState: () => ({
      loadFiles: vi.fn(),
    }),
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      user: null,
    }),
  },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: showToastMock,
  notifyIfHidden: notifyIfHiddenMock,
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: showNotificationPromptToastMock,
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshots: deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshot: loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

type ChatStore = (typeof import('../web/src/stores/chat'))['useChatStore'];
let useChatStore: ChatStore;

function page(jid: string): Message[] {
  return [
    {
      id: `${jid}-m1`,
      chat_jid: jid,
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-02T10:00:00.000Z',
      is_from_me: false,
    },
  ];
}

/** Open the main conversation of each workspace in turn, as ChatView does. */
function viewMain(jids: string[]) {
  for (const jid of jids) {
    useChatStore.setState({ currentGroup: jid });
    useChatStore.getState().setActiveAgentTab(jid, null);
  }
}

const workspaces = Array.from({ length: 25 }, (_, i) => `web:w${i}`);

describe('conversation message retention', () => {
  beforeEach(async () => {
    // The viewed-conversation order lives in the module; start each case fresh.
    vi.resetModules();
    ({ useChatStore } = await import('../web/src/stores/chat'));
    useChatStore.setState({
      messages: Object.fromEntries(workspaces.map((jid) => [jid, page(jid)])),
      hasMore: Object.fromEntries(workspaces.map((jid) => [jid, true])),
    });
  });

  it('drops the least recently viewed conversations beyond twenty', () => {
    viewMain(workspaces);
    const { messages, hasMore } = useChatStore.getState();
    for (const jid of workspaces.slice(0, 5)) {
      expect(messages[jid]).toBeUndefined();
      expect(hasMore[jid]).toBeUndefined();
    }
    for (const jid of workspaces.slice(5)) expect(messages[jid]).toBeDefined();
  });

  it('keeps conversations that are running, awaiting a reply or reviewed again', () => {
    useChatStore.setState({
      waiting: { 'web:w0': true },
      activeRuns: {
        'web:w1': {
          chatJid: 'web:w1',
          runId: 'run-1',
          startedAt: '2026-01-02T10:00:00.000Z',
          phase: 'running',
        },
      },
    } as never);
    viewMain(workspaces.slice(0, 20));
    viewMain(['web:w2']);
    viewMain(workspaces.slice(20));
    const { messages } = useChatStore.getState();
    expect(messages['web:w0']).toBeDefined();
    expect(messages['web:w1']).toBeDefined();
    expect(messages['web:w2']).toBeDefined();
    for (const jid of ['web:w3', 'web:w4', 'web:w5', 'web:w6', 'web:w7']) {
      expect(messages[jid]).toBeUndefined();
    }
    expect(messages['web:w8']).toBeDefined();
  });

  it('keeps every session of the open workspace and drops them after leaving it', () => {
    const sessions = Array.from({ length: 25 }, (_, i) => `s${i}`);
    useChatStore.setState({
      currentGroup: 'web:a',
      agentMessages: Object.fromEntries(
        sessions.map((id) => [id, page(`web:a#agent:${id}`)]),
      ),
    });
    for (const id of sessions) {
      useChatStore.getState().setActiveAgentTab('web:a', id);
    }
    expect(Object.keys(useChatStore.getState().agentMessages)).toHaveLength(25);

    viewMain(['web:w0']);
    const { agentMessages } = useChatStore.getState();
    expect(Object.keys(agentMessages)).toHaveLength(19);
    expect(agentMessages.s0).toBeUndefined();
    expect(agentMessages.s5).toBeUndefined();
    expect(agentMessages.s6).toBeDefined();
  });
});
