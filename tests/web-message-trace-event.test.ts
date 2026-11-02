import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../web/src/stores/chat';

vi.mock('../web/src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  computeUploadTimeoutMs: vi.fn(() => 8000),
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
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

const { saveAgentMessageSnapshotMock } = vi.hoisted(() => ({
  saveAgentMessageSnapshotMock: vi.fn(async () => undefined),
}));
vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:home';
const SESSION = `${JID}#agent:s1`;

const utterance = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  chat_jid: SESSION,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '你好。',
  timestamp: '2026-10-12T03:23:01.000Z',
  is_from_me: true,
  source_kind: 'sdk_send_message',
  turn_id: 'turn-1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ ...initialState, agentMessages: {} }, true);
});

describe('a trace stored after its message was announced', () => {
  it('marks the message of a session, and only that one', () => {
    useChatStore.setState({
      agentMessages: {
        s1: [utterance('m1'), utterance('m2', { turn_id: 'turn-2' })],
      },
    });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    const [first, second] = useChatStore.getState().agentMessages.s1;
    expect(first.has_trace).toBe(true);
    expect(second.has_trace).toBeUndefined();
  });

  it('marks a message of a Runtime Session and keeps its stored snapshot in step', () => {
    useChatStore.setState({
      agentMessages: { s1: [utterance('m1')] },
      agentHasMore: { s1: true },
    });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    expect(useChatStore.getState().agentMessages.s1[0].has_trace).toBe(true);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledTimes(1);
    expect(saveAgentMessageSnapshotMock).toHaveBeenCalledWith(
      JID,
      's1',
      [expect.objectContaining({ id: 'm1', has_trace: true })],
      true,
    );
  });

  it('matches the whole composite key: the same id in another chat is left alone', () => {
    useChatStore.setState({
      agentMessages: {
        s1: [utterance('m1')],
        s2: [utterance('m1', { chat_jid: `${JID}#agent:s2` })],
      },
    });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    expect(
      useChatStore.getState().agentMessages.s2[0].has_trace,
    ).toBeUndefined();
    expect(useChatStore.getState().agentMessages.s1[0].has_trace).toBe(true);
  });

  it('keeps a mark that arrives before its message, and applies it when the message does', () => {
    // A message with attachments is announced after its thumbnails are made, so
    // the trace notice can overtake it.
    useChatStore.setState({ agentMessages: { s1: [] } });
    useChatStore.getState().handleMessageTrace(SESSION, 'late');
    useChatStore
      .getState()
      .handleWsNewMessage(JID, utterance('late') as never, 's1');
    const arrived = useChatStore
      .getState()
      .agentMessages.s1.find((message) => message.id === 'late');
    expect(arrived?.has_trace).toBe(true);
    // Spent: a later message with that id is not marked again.
    useChatStore.setState({ agentMessages: { s1: [] } });
    useChatStore
      .getState()
      .handleWsNewMessage(JID, utterance('late') as never, 's1');
    expect(
      useChatStore.getState().agentMessages.s1[0]?.has_trace,
    ).toBeUndefined();
  });

  it('does not keep a mark for a message it already has', () => {
    useChatStore.setState({ agentMessages: { s1: [utterance('m1')] } });
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    useChatStore.setState({ agentMessages: { s1: [] } });
    // Had the mark been kept, this arrival would be marked a second time.
    useChatStore
      .getState()
      .handleWsNewMessage(JID, utterance('m1') as never, 's1');
    expect(
      useChatStore.getState().agentMessages.s1[0]?.has_trace,
    ).toBeUndefined();
  });

  it('ignores a message this tab never loaded, and one already marked', () => {
    useChatStore.setState({
      agentMessages: { s1: [utterance('m1', { has_trace: true })] },
    });
    const before = useChatStore.getState().agentMessages;
    useChatStore.getState().handleMessageTrace(SESSION, 'm1');
    useChatStore.getState().handleMessageTrace(SESSION, 'nope');
    expect(useChatStore.getState().agentMessages).toBe(before);
    expect(saveAgentMessageSnapshotMock).not.toHaveBeenCalled();
  });
});
