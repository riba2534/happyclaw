import { describe, expect, test, vi } from 'vitest';
import {
  NO_SESSION_DELETE_IMPACT,
  runSessionDelete,
  sessionDeleteImpactFromError,
  sessionDeleteMessage,
  sessionDeletePath,
  type SessionDeleteImpact,
  type SessionDeleteOptions,
  type SessionDeleteResult,
} from './session-delete';

const chats: SessionDeleteImpact = {
  ...NO_SESSION_DELETE_IMPACT,
  linkedImGroups: [{ jid: 'feishu:oc_1', name: '研发群' }],
};

/** The server's answers, in turn; and what it was asked each time. */
function server(...answers: SessionDeleteResult[]) {
  const asked: SessionDeleteOptions[] = [];
  const remove = vi.fn(async (options: SessionDeleteOptions) => {
    asked.push({ ...options });
    return answers.shift() ?? false;
  });
  return { remove, asked };
}

describe('deleting a session', () => {
  test('one with nothing bound is confirmed, then deleted as is', async () => {
    const { remove, asked } = server(true);
    const ask = vi.fn(async () => ({ rebindTo: null }));
    const outcome = await runSessionDelete({
      known: NO_SESSION_DELETE_IMPACT,
      ask,
      confirmWorktree: vi.fn(),
      remove,
    });
    expect(outcome).toBe('deleted');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([{}]);
  });

  test('nothing is deleted when the confirmation is cancelled', async () => {
    const { remove } = server(true);
    const outcome = await runSessionDelete({
      known: chats,
      ask: async () => null,
      confirmWorktree: vi.fn(),
      remove,
    });
    expect(outcome).toBe('cancelled');
    expect(remove).not.toHaveBeenCalled();
  });

  test('a refusal listing what the user was shown is confirmed with the rebind target', async () => {
    const { remove, asked } = server({ bindings: chats }, true);
    const ask = vi.fn(async () => ({ rebindTo: 'other-session' }));
    const outcome = await runSessionDelete({
      known: chats,
      ask,
      confirmWorktree: vi.fn(),
      remove,
    });
    expect(outcome).toBe('deleted');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([
      {},
      { confirmBindings: true, rebindTo: 'other-session' },
    ]);
  });

  test('a refusal listing more than the user saw asks again, with the server list', async () => {
    const { remove, asked } = server({ bindings: chats }, true);
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ rebindTo: null })
      .mockResolvedValueOnce({ rebindTo: 'other-session' });
    const outcome = await runSessionDelete({
      known: NO_SESSION_DELETE_IMPACT,
      ask,
      confirmWorktree: vi.fn(),
      remove,
    });
    expect(outcome).toBe('deleted');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenLastCalledWith(chats);
    expect(asked[1]).toEqual({
      confirmBindings: true,
      rebindTo: 'other-session',
    });
  });

  test('a topic or an automation alone is confirmed without a rebind target', async () => {
    const topic: SessionDeleteImpact = {
      ...NO_SESSION_DELETE_IMPACT,
      threadBindings: [{ jid: 'feishu:oc_t', name: '话题群', contextId: 't1' }],
      automations: [{ id: 'a1', name: '日报' }],
    };
    const { remove, asked } = server({ bindings: topic }, true);
    await runSessionDelete({
      known: {
        ...topic,
        threadBindings: [{ jid: '', name: '', contextId: 't1' }],
      },
      ask: async () => ({ rebindTo: 'ignored' }),
      confirmWorktree: vi.fn(),
      remove,
    });
    expect(asked[1]).toEqual({ confirmBindings: true, rebindTo: null });
  });

  test('a worktree with changes asks once more, then the delete goes through', async () => {
    const dirty = [
      { sessionId: 's1', branch: 'happyclaw/s1', changedFiles: 2 },
    ];
    const { remove, asked } = server(
      { bindings: chats },
      { worktreesDirty: dirty },
      true,
    );
    const confirmWorktree = vi.fn(async () => true);
    const outcome = await runSessionDelete({
      known: chats,
      ask: async () => ({ rebindTo: null }),
      confirmWorktree,
      remove,
    });
    expect(outcome).toBe('deleted');
    expect(confirmWorktree).toHaveBeenCalledWith(dirty);
    expect(asked.at(-1)).toEqual({
      confirmBindings: true,
      rebindTo: null,
      forceWorktree: true,
    });
  });

  test('gives up when the server refuses a confirmed delete again', async () => {
    const { remove } = server({ bindings: chats }, { bindings: chats });
    expect(
      await runSessionDelete({
        known: chats,
        ask: async () => ({ rebindTo: null }),
        confirmWorktree: vi.fn(),
        remove,
      }),
    ).toBe('failed');
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('the delete request and its refusal', () => {
  test('carries the confirmation, the rebind target and the worktree consent', () => {
    expect(sessionDeletePath('web:a', 's1')).toBe(
      '/api/groups/web%3Aa/sessions/s1',
    );
    expect(
      sessionDeletePath('web:a', 's1', {
        confirmBindings: true,
        rebindTo: 's2',
        forceWorktree: true,
      }),
    ).toBe(
      '/api/groups/web%3Aa/sessions/s1?confirm_bindings=true&rebind_to=s2&force_worktree=true',
    );
    // No rebind without the confirmation it belongs to.
    expect(sessionDeletePath('web:a', 's1', { rebindTo: 's2' })).toBe(
      '/api/groups/web%3Aa/sessions/s1',
    );
  });

  test('reads the bindings of a 409 session_has_bindings, and nothing else', () => {
    expect(
      sessionDeleteImpactFromError({
        status: 409,
        body: {
          code: 'session_has_bindings',
          linked_im_groups: [{ jid: 'feishu:oc_1', name: '研发群' }],
          thread_bindings: [
            { jid: 'feishu:oc_t', name: '话题群', context_id: 't1' },
          ],
          automations: [{ id: 'a1', name: '日报' }],
        },
      }),
    ).toEqual({
      linkedImGroups: [{ jid: 'feishu:oc_1', name: '研发群' }],
      threadBindings: [{ jid: 'feishu:oc_t', name: '话题群', contextId: 't1' }],
      automations: [{ id: 'a1', name: '日报' }],
    });
    expect(
      sessionDeleteImpactFromError({
        status: 409,
        body: { code: 'WORKTREE_DIRTY' },
      }),
    ).toBeNull();
    expect(sessionDeleteImpactFromError({ status: 404 })).toBeNull();
  });
});

describe('the delete confirmation', () => {
  test('says only that the history goes when nothing is bound', () => {
    expect(sessionDeleteMessage(NO_SESSION_DELETE_IMPACT)).toBe(
      '删除后会话的聊天记录将无法恢复。',
    );
  });

  test('lists the chats and automations, and says what happens to each', () => {
    const message = sessionDeleteMessage({
      linkedImGroups: [{ jid: 'feishu:oc_1', name: '研发群' }],
      threadBindings: [{ jid: '', name: '', contextId: 't1' }],
      automations: [{ id: 'a1', name: '日报' }],
    });
    expect(message).toContain('· 研发群\n删除后这些聊天将不再收到回复。');
    expect(message).toContain('删除后，该话题下次发言会开启新的上下文。');
    expect(message).toContain('· 日报\n绑定此会话的自动化会暂停。');
    expect(message.endsWith('删除后会话的聊天记录将无法恢复。')).toBe(true);
  });
});
