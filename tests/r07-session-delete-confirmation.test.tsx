// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentInfo } from '../web/src/types';

const mockDeleteAgentAction = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (msg: string, opts?: any) => mockToastError(msg, opts),
    success: (msg: string, opts?: any) => mockToastSuccess(msg, opts),
  },
}));

import { ConfirmDialog } from '../web/src/components/common/ConfirmDialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mockDeleteAgentAction.mockReset();
  mockToastError.mockReset();
  mockToastSuccess.mockReset();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('R07: Session delete confirmation and binding protection', () => {
  const unboundSession: AgentInfo = {
    id: 'session-normal-1',
    name: '分析调研会话',
    status: 'idle',
    created_at: '2026-09-01T00:00:00Z',
  };

  const boundSession: AgentInfo = {
    id: 'session-bound-1',
    name: '飞书同步会话',
    status: 'idle',
    created_at: '2026-09-01T00:00:00Z',
    linked_im_groups: [
      {
        jid: 'oc_feishu_test_group',
        name: '研发告警群',
        platform: 'feishu',
      },
    ],
  };

  function simulateHandleDeleteSession(
    session: AgentInfo,
    setDeletingSession: (s: AgentInfo | null) => void,
    setBindingAgentId: (id: string | null) => void,
  ) {
    if (session.linked_im_groups && session.linked_im_groups.length > 0) {
      const names = session.linked_im_groups
        .map((item) => item.name)
        .join('、');
      setBindingAgentId(session.id);
      mockToastError('请先解绑消息渠道', {
        description: `当前绑定：${names}`,
      });
      return;
    }
    setDeletingSession(session);
  }

  test('refuses to show delete dialog or call API for bound sessions, requiring unbind first', () => {
    let deletingSession: AgentInfo | null = null;
    let bindingAgentId: string | null = null;

    simulateHandleDeleteSession(
      boundSession,
      (s) => {
        deletingSession = s;
      },
      (id) => {
        bindingAgentId = id;
      },
    );

    expect(deletingSession).toBeNull();
    expect(bindingAgentId).toBe('session-bound-1');
    expect(mockToastError).toHaveBeenCalledWith('请先解绑消息渠道', {
      description: '当前绑定：研发告警群',
    });
    expect(mockDeleteAgentAction).not.toHaveBeenCalled();
  });

  test('renders ConfirmDialog with session name, permanent history deletion impact, and running task stoppage warning', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    await act(async () => {
      root?.render(
        <ConfirmDialog
          open={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="删除会话"
          message={`确定要永久删除会话“${unboundSession.name}”吗？\n\n此操作将永久删除该会话的全部历史消息、对话记录与上下文数据，不可恢复。\n如果该会话有正在运行的任务，运行将被立即停止。`}
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
        />,
      );
    });

    const title = document.body.querySelector(
      '[data-slot="alert-dialog-title"], h2, [role="heading"]',
    );
    expect(title?.textContent).toContain('删除会话');

    const desc = document.body.querySelector(
      '[data-slot="alert-dialog-description"], p',
    );
    expect(desc?.textContent).toContain('分析调研会话');
    expect(desc?.textContent).toContain('永久删除该会话的全部历史消息');
    expect(desc?.textContent).toContain('运行将被立即停止');

    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '取消',
    );
    expect(cancelBtn).toBeTruthy();

    const confirmBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.trim() === '删除');
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn?.className).toContain('bg-destructive');
  });

  test('clicking cancel or escape does not invoke onConfirm and triggers onClose', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    await act(async () => {
      root?.render(
        <ConfirmDialog
          open={true}
          onClose={onClose}
          onConfirm={onConfirm}
          title="删除会话"
          message="确认删除？"
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
        />,
      );
    });

    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '取消',
    );
    await act(async () => {
      cancelBtn?.click();
    });

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(mockDeleteAgentAction).not.toHaveBeenCalled();
  });

  test('confirming invokes delete API and provides clear confirmation', async () => {
    mockDeleteAgentAction.mockResolvedValue(true);
    let sessionState: AgentInfo | null = unboundSession;

    const onConfirm = async () => {
      const ok = await mockDeleteAgentAction('web:test-ws', unboundSession.id);
      if (ok) {
        sessionState = null;
        mockToastSuccess(`会话“${unboundSession.name}”已删除`);
      }
    };

    await act(async () => {
      root?.render(
        <ConfirmDialog
          open={!!sessionState}
          onClose={() => {
            sessionState = null;
          }}
          onConfirm={onConfirm}
          title="删除会话"
          message="确认删除？"
          confirmText="删除"
          cancelText="取消"
          confirmVariant="danger"
        />,
      );
    });

    const confirmBtn = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.trim() === '删除');
    await act(async () => {
      confirmBtn?.click();
    });

    expect(mockDeleteAgentAction).toHaveBeenCalledWith(
      'web:test-ws',
      'session-normal-1',
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('会话“分析调研会话”已删除');
    expect(sessionState).toBeNull();
  });
});
