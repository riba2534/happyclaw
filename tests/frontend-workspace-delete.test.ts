import { describe, expect, it } from 'vitest';
import {
  workspaceDeleteBindingNames,
  workspaceDeleteDialogMessage,
} from '../web/src/utils/workspace-delete';
import type { DeleteWorkspaceState } from '../web/src/hooks/useDeleteWorkspace';

function state(
  overrides: Partial<DeleteWorkspaceState> = {},
): DeleteWorkspaceState {
  return {
    open: true,
    jid: 'web:reports',
    name: '报告工作区',
    checking: false,
    impact: {
      has_channel_bindings: true,
      channel_binding_count: 2,
      bound_sessions: [
        {
          sessionId: 'session-1',
          sessionName: '调研会话',
          imGroups: [{ jid: 'feishu:one', name: '飞书调研群' }],
        },
        {
          sessionId: 'session-2',
          sessionName: '账单会话',
          imGroups: [{ jid: 'qq:two', name: 'QQ 账单群' }],
        },
      ],
      // Duplicate source proves the dialog lists channels, not every thread.
      bound_thread_contexts: [
        {
          jid: 'feishu:one',
          name: '飞书调研群',
          context_id: 'thread-1',
        },
      ],
    },
    ...overrides,
  };
}

describe('workspace deletion confirmation', () => {
  it('deduplicates channel names across session and thread bindings', () => {
    expect(workspaceDeleteBindingNames(state())).toEqual([
      '飞书调研群',
      'QQ 账单群',
    ]);
  });

  it('explains automatic rerouting before destructive deletion', () => {
    const message = workspaceDeleteDialogMessage(state());
    expect(message).toContain('仍绑定 2 个消息渠道');
    expect(message).toContain('• 飞书调研群');
    expect(message).toContain('• QQ 账单群');
    expect(message).toContain('解除这些渠道的绑定');
    expect(message).toContain('此操作无法撤销');
  });

  it('keeps the ordinary confirmation concise when no binding exists', () => {
    const message = workspaceDeleteDialogMessage(
      state({
        impact: {
          has_channel_bindings: false,
          channel_binding_count: 0,
          bound_sessions: [],
          bound_thread_contexts: [],
        },
      }),
    );
    expect(message).toContain('工作区文件、会话和运行数据将被永久删除');
    expect(message).not.toContain('解除路由');
  });
});
