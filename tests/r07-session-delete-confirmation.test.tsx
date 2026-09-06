// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const toastCalls: Array<{
  type: 'error' | 'success';
  msg: string;
  opts?: any;
}> = [];

vi.mock('sonner', () => ({
  toast: {
    error: (msg: string, opts?: any) => {
      toastCalls.push({ type: 'error', msg, opts });
    },
    success: (msg: string, opts?: any) => {
      toastCalls.push({ type: 'success', msg, opts });
    },
    warning: vi.fn(),
  },
}));

vi.mock('../web/node_modules/sonner', () => ({
  toast: {
    error: (msg: string, opts?: any) => {
      toastCalls.push({ type: 'error', msg, opts });
    },
    success: (msg: string, opts?: any) => {
      toastCalls.push({ type: 'success', msg, opts });
    },
    warning: vi.fn(),
  },
}));

vi.mock('../web/src/hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'default' }),
}));

vi.mock('../web/src/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'light',
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('../web/src/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
}));

vi.mock('../web/src/hooks/useHaptic', () => ({
  successTap: () => {},
}));

const mockDeleteAgentAction = vi.fn(async () => true);

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/agents')) {
        return {
          agents: [
            {
              id: 'session-bound-1',
              name: '飞书同步会话',
              status: 'idle',
              kind: 'conversation',
              created_at: '2026-09-01T00:00:00Z',
              linked_im_groups: [
                {
                  jid: 'oc_feishu_test_group',
                  name: '研发告警群',
                  platform: 'feishu',
                },
              ],
            },
            {
              id: 'session-unbound-1',
              name: '分析调研会话',
              status: 'idle',
              kind: 'conversation',
              created_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      if (url.includes('/im-groups')) {
        return { imGroups: [] };
      }
      return {};
    }),
    post: vi.fn(async () => ({ success: true })),
    patch: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: any) => ({
    getVirtualItems: () =>
      Array.from({ length: options?.count || 0 }, (_, index) => ({
        index,
        start: index * 48,
        size: 48,
        key: index,
      })),
    getTotalSize: () => (options?.count || 0) * 48,
    scrollToIndex: vi.fn(),
  }),
}));

import { useChatStore } from '../web/src/stores/chat';
const { ChatView } = await import('../web/src/components/chat/ChatView');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.getBoundingClientRect = () => ({
  width: 1200,
  height: 800,
  top: 0,
  left: 0,
  bottom: 800,
  right: 1200,
  x: 0,
  y: 0,
  toJSON: () => {},
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  value: 800,
});

const storageMap = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => storageMap.set(key, val),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  },
  configurable: true,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const WS_JID = 'web:ws-r07';

beforeEach(() => {
  mockDeleteAgentAction.mockClear();
  toastCalls.length = 0;
  storageMap.clear();

  useChatStore.setState({
    deleteAgentAction: mockDeleteAgentAction,
    groups: {
      [WS_JID]: {
        jid: WS_JID,
        name: 'R07 Workspace',
        folder: 'flow-r07',
        added_at: '2026-09-01T00:00:00Z',
        execution_mode: 'container',
        can_modify: true,
      } as any,
    },
    messages: {
      [WS_JID]: [],
    },
    agents: {
      [WS_JID]: [
        {
          id: 'session-bound-1',
          name: '飞书同步会话',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-09-01T00:00:00Z',
          linked_im_groups: [
            {
              jid: 'oc_feishu_test_group',
              name: '研发告警群',
              platform: 'feishu',
            },
          ],
        },
        {
          id: 'session-unbound-1',
          name: '分析调研会话',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
    },
    activeAgentTab: {
      [WS_JID]: null,
    },
    drafts: {},
    followUps: {},
  });

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

describe('R07: Session delete confirmation and binding protection (Real ChatView DOM)', () => {
  test('bound session delete click intercepts via toast, refusing dialog and delete API', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-r07`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid={WS_JID} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Find more options button for the bound session: '飞书同步会话'
    const moreBtn = container?.querySelector(
      'button[title="飞书同步会话的更多操作"]',
    ) as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();

    // Open dropdown menu via pointerdown + click
    await act(async () => {
      moreBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Click "删除" menu item in dropdown
    const deleteMenuItem = Array.from(
      document.body.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes('删除')) as HTMLElement;
    expect(deleteMenuItem).toBeTruthy();

    await act(async () => {
      deleteMenuItem.click();
    });

    // Interception: channels must be unbound first -> binding dialog opened, delete confirm dialog NOT opened, API NOT called
    expect(mockDeleteAgentAction).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('此操作将永久删除该会话');
    expect(document.body.textContent).toContain('会话绑定 — 飞书同步会话');
  });

  test('unbound session delete click opens ConfirmDialog with permanent history impact and stoppage warning', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-r07`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid={WS_JID} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Find more options button for unbound session: '分析调研会话'
    const moreBtn = container?.querySelector(
      'button[title="分析调研会话的更多操作"]',
    ) as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();

    await act(async () => {
      moreBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteMenuItem = Array.from(
      document.body.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes('删除')) as HTMLElement;
    expect(deleteMenuItem).toBeTruthy();

    await act(async () => {
      deleteMenuItem.click();
    });

    // Confirm dialog must be opened with session name, history deletion, and task stoppage warning
    const desc = document.body.querySelector(
      '[data-slot="alert-dialog-description"]',
    );
    expect(desc?.textContent).toContain('确定要永久删除会话“分析调研会话”吗？');
    expect(desc?.textContent).toContain('永久删除该会话的全部历史消息');
    expect(desc?.textContent).toContain('运行将被立即停止');

    // Confirm button has destructive styling
    const confirmBtn = Array.from(
      document.body.querySelectorAll(
        '[data-slot="alert-dialog-action"], button',
      ),
    ).find((b) => b.textContent?.trim() === '删除');
    expect(confirmBtn?.className).toContain('bg-destructive');

    // Cancel button exists and closes dialog without calling delete API
    const cancelBtn = Array.from(
      document.body.querySelectorAll(
        '[data-slot="alert-dialog-cancel"], button',
      ),
    ).find((b) => b.textContent?.trim() === '取消');
    expect(cancelBtn).toBeTruthy();

    await act(async () => {
      cancelBtn?.click();
    });

    // Dialog closed, no API invoked
    expect(mockDeleteAgentAction).not.toHaveBeenCalled();
  });

  test('Escape key closes delete dialog and does not invoke API', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-r07`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid={WS_JID} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const moreBtn = container?.querySelector(
      'button[title="分析调研会话的更多操作"]',
    ) as HTMLButtonElement;
    await act(async () => {
      moreBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteMenuItem = Array.from(
      document.body.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes('删除')) as HTMLElement;
    await act(async () => {
      deleteMenuItem.click();
    });

    // Trigger Escape key
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(mockDeleteAgentAction).not.toHaveBeenCalled();
  });

  test('confirming delete invokes deleteAgentAction API with correct workspace and session IDs', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-r07`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid={WS_JID} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const moreBtn = container?.querySelector(
      'button[title="分析调研会话的更多操作"]',
    ) as HTMLButtonElement;
    await act(async () => {
      moreBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteMenuItem = Array.from(
      document.body.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes('删除')) as HTMLElement;
    await act(async () => {
      deleteMenuItem.click();
    });

    const confirmBtn = Array.from(
      document.body.querySelectorAll(
        '[data-slot="alert-dialog-action"], button',
      ),
    ).find((b) => b.textContent?.trim() === '删除');

    await act(async () => {
      confirmBtn?.click();
    });

    expect(mockDeleteAgentAction).toHaveBeenCalledWith(
      WS_JID,
      'session-unbound-1',
    );
  });
});
