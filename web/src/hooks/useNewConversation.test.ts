import { describe, expect, test, vi } from 'vitest';

import type { AgentInfo, GroupInfo } from '../types';

vi.mock('../stores/chat', () => ({ useChatStore: { getState: vi.fn() } }));
vi.mock('../stores/shell', () => ({ useShellStore: vi.fn() }));
vi.mock('./useSessionActions', () => ({ useSessionActions: vi.fn() }));

const { newConversationWorkspace, reusableEmptySession } =
  await import('./useNewConversation');

const group = (folder: string, over: Partial<GroupInfo> = {}): GroupInfo => ({
  name: folder,
  folder,
  added_at: '2026-01-01T00:00:00.000Z',
  interaction_mode: 'assistant',
  can_modify: true,
  ...over,
});

const groups: Record<string, GroupInfo> = {
  'web:home': group('home', { is_my_home: true }),
  'web:work': group('work'),
  'web:shared': group('shared', { can_modify: false }),
};

const session = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('where a new conversation goes', () => {
  test('the workspace open in the chat, or a named one', () => {
    expect(newConversationWorkspace(groups, 'current', 'work')).toBe(
      'web:work',
    );
    expect(newConversationWorkspace(groups, { jid: 'web:work' }, null)).toBe(
      'web:work',
    );
  });

  test('Home when asked for, when none is open, or when the user may not write there', () => {
    expect(newConversationWorkspace(groups, 'home', 'work')).toBe('web:home');
    expect(newConversationWorkspace(groups, 'current', null)).toBe('web:home');
    expect(newConversationWorkspace(groups, 'current', 'shared')).toBe(
      'web:home',
    );
    expect(newConversationWorkspace(groups, { jid: 'web:gone' }, null)).toBe(
      'web:home',
    );
  });
});

describe('reusing a session nobody has written in', () => {
  const written = session('written', {
    latest_message: { content: '你好', timestamp: '2026-01-01T00:01:00.000Z' },
  });

  test('only one with no message, of its own or loaded, that only the Web uses', () => {
    const sessions = [
      written,
      session('loaded'),
      session('automation', { automation_id: 'a1' }),
      session('topic', { source_kind: 'feishu_thread' }),
      session('chat', {
        linked_im_groups: [{ jid: 'feishu:oc_1', name: '研发群' }],
      }),
      session('spawn', { kind: 'spawn' }),
    ];
    expect(
      reusableEmptySession(sessions, undefined, { loaded: [{}] }),
    ).toBeNull();
    expect(
      reusableEmptySession([...sessions, session('blank')], undefined, {
        loaded: [{}],
      })?.id,
    ).toBe('blank');
  });

  test('the open one first', () => {
    const sessions = [session('first'), session('open')];
    expect(reusableEmptySession(sessions, 'open', {})?.id).toBe('open');
    expect(reusableEmptySession(sessions, 'written', {})?.id).toBe('first');
  });
});
