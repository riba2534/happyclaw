import { describe, expect, it, vi } from 'vitest';

import type { Message, QueuedFollowUp } from '../web/src/stores/chat';
import { syncFollowUpContent } from '../web/src/lib/message-timeline';

vi.mock('../web/src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: vi.fn(),
  saveAgentMessageSnapshot: vi.fn(),
}));

const { useChatStore } = await import('../web/src/stores/chat');

const queued = (id: string, content: string): Message => ({
  id,
  chat_jid: 'web:main',
  sender: 'user',
  sender_name: 'User',
  content,
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: false,
  delivery_status: 'queued',
});

const item = (id: string, content: string): QueuedFollowUp => ({
  id,
  chat_jid: 'web:main',
  sender: 'user',
  sender_name: 'User',
  content,
  timestamp: '2026-10-10T00:00:00.000Z',
  delivery_mode: 'queue',
  delivery_status: 'queued',
  delivery_priority: 0,
});

describe('edited follow-ups', () => {
  it('copies queue content onto matching rows and keeps identity otherwise', () => {
    const rows = [queued('a', 'old'), queued('b', 'same')];
    const synced = syncFollowUpContent(rows, [
      item('a', 'new'),
      item('b', 'same'),
    ]);
    expect(synced.map((m) => m.content)).toEqual(['new', 'same']);
    expect(synced[1]).toBe(rows[1]);
    expect(syncFollowUpContent(rows, [item('b', 'same')])).toBe(rows);
  });

  it('a released row shows the edited text, not the original', () => {
    useChatStore.setState({
      messages: { 'web:main': [queued('m1', '最后给出一个命令示例')] },
      followUps: {},
    });
    const state = useChatStore.getState();
    state.handleFollowUpUpdate('web:main', [
      item('m1', '最后给出一个命令示例（简短）'),
    ]);
    state.handleFollowUpUpdate('web:main', [], {
      id: 'm1',
      delivery_status: 'released',
      delivery_updated_at: '2026-10-10T00:00:05.000Z',
    });
    const [row] = useChatStore.getState().messages['web:main'];
    expect(row.content).toBe('最后给出一个命令示例（简短）');
    expect(row.delivery_status).toBe('released');
  });
});
