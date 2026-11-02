import { describe, expect, test } from 'vitest';

import type { AgentInfo } from '../types';
import { notBindableMessage } from '../utils/im-binding-policy';
import { bindableSessions, isBindableSession } from './session-presentation';

const session = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the sessions a chat can be bound to', () => {
  test('are conversations people talk in, not the ones the host uses itself', () => {
    for (const source of [
      'team_router',
      'work_item',
      'automation',
      'native_thread',
      'feishu_thread',
    ] as const) {
      expect(
        isBindableSession(session('s', { source_kind: source })),
        source,
      ).toBe(false);
    }
    expect(isBindableSession(session('s', { kind: 'spawn' }))).toBe(false);
    for (const source of [
      undefined,
      'manual',
      'auto_im',
      'channel_direct',
      'legacy_main',
    ] as const) {
      expect(
        isBindableSession(session('s', { source_kind: source })),
        source,
      ).toBe(true);
    }
  });

  test('are listed in the session lists’ order', () => {
    const sessions = [
      session('older', { last_active_at: '2026-01-02T00:00:00.000Z' }),
      session('router', { source_kind: 'team_router' }),
      session('newer', { last_active_at: '2026-01-03T00:00:00.000Z' }),
      session('run', { source_kind: 'automation' }),
      session('pinned', { pinned_at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(bindableSessions(sessions).map((s) => s.id)).toEqual([
      'pinned',
      'newer',
      'older',
    ]);
  });
});

describe('a refused bind', () => {
  test('to a session that cannot be bound says so; anything else is left to its caller', () => {
    expect(
      notBindableMessage({
        status: 400,
        message: 'This session cannot be bound to a chat',
        body: { code: 'session_not_bindable' },
      }),
    ).toContain('不能绑定聊天');
    expect(
      notBindableMessage({
        status: 400,
        message: 'x',
        body: { code: 'other' },
      }),
    ).toBeNull();
    expect(notBindableMessage(new Error('Network error'))).toBeNull();
  });
});
