// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';

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

const { formatResumeTime, useUsageLimitWaits } =
  await import('../web/src/stores/usage-limit-waits');
const { isMessageVisibleInTimeline, syncFollowUpContent } =
  await import('../web/src/lib/message-timeline');
const { RunStatusBar } =
  await import('../web/src/components/chat/RunStatusBar');

describe('usage-limit waits on the Web', () => {
  test('messages and reconnect snapshots keep one wait per Session', () => {
    const store = useUsageLimitWaits.getState();
    store.apply({
      chatJid: 'web:ws',
      agentId: 's1',
      resumeAt: '2026-10-29T09:01:00.000Z',
      waitCount: 2,
    });
    expect(useUsageLimitWaits.getState().waits['web:ws#agent:s1']).toEqual({
      resumeAt: '2026-10-29T09:01:00.000Z',
      waitCount: 2,
    });
    store.apply({ chatJid: 'web:ws', agentId: 's1', resumeAt: null });
    expect(useUsageLimitWaits.getState().waits).toEqual({});

    // Every input waits in a session: a workspace JID alone names none.
    store.apply({ chatJid: 'web:ws', resumeAt: '2026-10-29T09:00:00.000Z' });
    expect(useUsageLimitWaits.getState().waits).toEqual({});

    store.apply({
      chatJid: 'web:a',
      agentId: 's1',
      resumeAt: '2026-10-29T09:00:00.000Z',
    });
    store.replace([
      {
        chatJid: 'web:b',
        agentId: 's2',
        resumeAt: '2026-10-29T10:00:00.000Z',
        waitCount: 1,
      },
    ]);
    expect(Object.keys(useUsageLimitWaits.getState().waits)).toEqual([
      'web:b#agent:s2',
    ]);
  });

  test('the resume time reads HH:MM today and names the day otherwise', () => {
    const now = new Date(2026, 9, 29, 8, 0);
    expect(
      formatResumeTime(new Date(2026, 9, 29, 17, 5).toISOString(), now),
    ).toBe('17:05');
    expect(
      formatResumeTime(new Date(2026, 9, 31, 9, 0).toISOString(), now),
    ).toBe('10月31日 09:00');
  });

  test('the status bar says when a waiting Session goes on', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
    useUsageLimitWaits.setState({
      waits: {
        'web:main#agent:s1': {
          resumeAt: resumeAt.toISOString(),
          waitCount: 1,
        },
      },
    });
    const render = async (agentId: string) => {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(async () =>
        root.render(<RunStatusBar groupJid="web:main" agentId={agentId} />),
      );
      const text = container.textContent ?? '';
      const status = container.querySelector('[role="status"]');
      await act(async () => root.unmount());
      return { text, status };
    };
    const waiting = await render('s1');
    expect(waiting.text).toContain(
      `额度用尽，预计 ${formatResumeTime(resumeAt.toISOString())} 自动继续`,
    );
    expect(waiting.status).not.toBeNull();
    // Another Session shows nothing.
    expect((await render('s2')).text).toBe('');
  });

  test('an input moved back into the queue leaves the transcript', () => {
    const row = {
      id: 'm1',
      timestamp: '2026-10-29T08:00:00.000Z',
      is_from_me: false,
      delivery_status: null,
      content: 'hello',
    };
    const [synced] = syncFollowUpContent(
      [row],
      [{ id: 'm1', content: 'hello', delivery_status: 'queued' }],
    );
    expect(synced.delivery_status).toBe('queued');
    expect(isMessageVisibleInTimeline(synced)).toBe(false);
    expect(isMessageVisibleInTimeline(row)).toBe(true);
  });
});
