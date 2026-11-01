// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';

import type { AgentInfo } from '../types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { toast, store, confirm, automations } = vi.hoisted(() => ({
  toast: { error: vi.fn(), warning: vi.fn() },
  store: {
    createConversation: vi.fn(),
    deleteAgentAction: vi.fn(),
    error: null as string | null,
    agents: {} as Record<string, unknown[]>,
  },
  confirm: { confirmDialog: vi.fn(), confirmSelectDialog: vi.fn() },
  automations: { automations: [] as unknown[] },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('../stores/chat', () => ({
  useChatStore: Object.assign(
    (select: (state: typeof store) => unknown) => select(store),
    { getState: () => store },
  ),
}));
vi.mock('../stores/confirm', () => confirm);
vi.mock('../stores/automations', () => ({
  useAutomationsStore: { getState: () => automations },
}));

const { useSessionActions } = await import('./useSessionActions');

/** The hook as a component would use it. */
async function renderActions() {
  let actions!: ReturnType<typeof useSessionActions>;
  function Probe() {
    actions = useSessionActions();
    return null;
  }
  await act(async () => {
    createRoot(document.createElement('div')).render(<Probe />);
  });
  return actions;
}

const session = (worktree: AgentInfo['worktree']): AgentInfo =>
  ({ id: 's1', name: '新对话', worktree }) as AgentInfo;

describe('creating a session with its own worktree', () => {
  test('says which .worktreeinclude files were left out, without blocking', async () => {
    store.createConversation.mockResolvedValueOnce(
      session({
        branch: 'happyclaw/s1',
        base_commit: 'abc',
        status: 'active',
        broken_reason: null,
        include_incomplete: {
          reason: 'size_limit',
          copied_files: 3,
          skipped_files: ['data/huge.bin'],
        },
      }),
    );
    const actions = await renderActions();
    let created: AgentInfo | null = null;
    await act(async () => {
      created = await actions.createSession('web:ws', { worktree: true });
    });

    expect(created).toMatchObject({ id: 's1' });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      '部分 .worktreeinclude 文件没有复制到新 worktree',
      {
        description: expect.stringContaining('未复制的文件包括：data/huge.bin'),
      },
    );
  });

  test('a complete copy or a plain session shows nothing', async () => {
    toast.warning.mockClear();
    store.createConversation
      .mockResolvedValueOnce(
        session({
          branch: 'happyclaw/s1',
          base_commit: 'abc',
          status: 'active',
          broken_reason: null,
          include_incomplete: null,
        }),
      )
      .mockResolvedValueOnce(session(null));
    const actions = await renderActions();
    await act(async () => {
      await actions.createSession('web:ws', { worktree: true });
    });
    await act(async () => {
      await actions.createSession('web:ws');
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('creating a session twice at once', () => {
  test('the same request from two places makes one session; another request makes its own', async () => {
    store.createConversation.mockReset();
    let finish!: (created: AgentInfo) => void;
    store.createConversation
      .mockImplementationOnce(
        () => new Promise<AgentInfo>((resolve) => (finish = resolve)),
      )
      .mockResolvedValueOnce(session(null));
    const entry = await renderActions();
    const sidebar = await renderActions();
    let first!: Promise<AgentInfo | null>;
    let second!: Promise<AgentInfo | null>;
    let worktree!: Promise<AgentInfo | null>;
    await act(async () => {
      first = entry.createSession('web:ws');
      second = sidebar.createSession('web:ws');
      worktree = sidebar.createSession('web:ws', { worktree: true });
    });
    await act(async () => finish(session(null)));
    expect(await first).toBe(await second);
    await worktree;
    expect(store.createConversation).toHaveBeenCalledTimes(2);
    expect(store.createConversation.mock.calls[1][3]).toEqual({
      worktree: true,
    });

    // Once it is made, a new request makes a new one.
    store.createConversation.mockResolvedValueOnce(session(null));
    await act(async () => {
      await entry.createSession('web:ws');
    });
    expect(store.createConversation).toHaveBeenCalledTimes(3);
  });
});

describe('deleting a session', () => {
  const flush = () => act(async () => await new Promise((r) => setTimeout(r)));

  test('one bound to chats lists them and offers the other sessions to move them to', async () => {
    store.agents = {
      'web:ws': [
        {
          id: 's1',
          name: '要删除的会话',
          kind: 'conversation',
          created_at: '2026-01-01T00:00:00.000Z',
          linked_im_groups: [{ jid: 'feishu:oc_1', name: '研发群' }],
        },
        {
          id: 's2',
          name: '较早的会话',
          kind: 'conversation',
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 's3',
          name: '最近的会话',
          kind: 'conversation',
          created_at: '2026-01-03T00:00:00.000Z',
        },
      ],
    };
    automations.automations = [
      {
        id: 'auto-1',
        name: '日报',
        sessionMode: 'bound',
        targetSessionJid: 'web:ws#agent:s1',
      },
    ];
    confirm.confirmSelectDialog.mockResolvedValueOnce('s3');
    store.deleteAgentAction
      .mockResolvedValueOnce({
        bindings: {
          linkedImGroups: [{ jid: 'feishu:oc_1', name: '研发群' }],
          threadBindings: [],
          automations: [{ id: 'auto-1', name: '日报' }],
        },
      })
      .mockResolvedValueOnce(true);

    const actions = await renderActions();
    actions.deleteSession('web:ws', 's1');
    await flush();

    expect(confirm.confirmDialog).not.toHaveBeenCalled();
    const [options] = confirm.confirmSelectDialog.mock.calls[0];
    expect(options).toMatchObject({
      title: '删除会话',
      confirmText: '删除',
      variant: 'danger',
    });
    expect(options.message).toContain('· 研发群');
    expect(options.message).toContain('删除后这些聊天将不再收到回复。');
    expect(options.message).toContain('· 日报');
    expect(options.select.label).toBe('改绑到');
    expect(options.select.defaultValue).toBe('');
    expect(
      options.select.options.map((o: { label: string }) => o.label),
    ).toEqual(['不改绑', '最近的会话', '较早的会话']);
    // Shown everything the server listed: confirmed with the pick at once.
    expect(store.deleteAgentAction.mock.calls).toEqual([
      ['web:ws', 's1', {}],
      ['web:ws', 's1', { confirmBindings: true, rebindTo: 's3' }],
    ]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('one with nothing bound asks plainly and deletes', async () => {
    store.agents = {
      'web:ws': [
        {
          id: 's1',
          name: '空会话',
          kind: 'conversation',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    automations.automations = [];
    confirm.confirmDialog.mockResolvedValueOnce(true);
    store.deleteAgentAction.mockReset().mockResolvedValueOnce(true);
    const actions = await renderActions();
    actions.deleteSession('web:ws', 's1');
    await flush();
    expect(confirm.confirmDialog).toHaveBeenCalledWith({
      title: '删除会话',
      message: '删除后会话的聊天记录将无法恢复。',
      confirmText: '删除',
      variant: 'danger',
    });
    expect(store.deleteAgentAction.mock.calls).toEqual([['web:ws', 's1', {}]]);
  });
});
