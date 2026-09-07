// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'default' }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: any) => {
    console.log('MOCK USEVIRTUALIZER CALLED WITH COUNT:', options?.count);
    return {
      getVirtualItems: () =>
        Array.from({ length: options.count || 0 }, (_, index) => ({
          index,
          start: index * 48,
          size: 48,
          key: index,
        })),
      getTotalSize: () => (options.count || 0) * 48,
      scrollToIndex: vi.fn(),
    };
  },
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

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/agents')) {
        return {
          agents: [
            {
              id: 'agent-alpha',
              name: 'Alpha Agent',
              status: 'idle',
              kind: 'conversation',
              created_at: '2026-09-01T00:00:00Z',
            },
            {
              id: 'agent-beta',
              name: 'Beta Agent',
              status: 'idle',
              kind: 'conversation',
              created_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      return {};
    }),
    post: vi.fn(async () => ({ success: true })),
    patch: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
  },
}));

import { useChatStore } from '../web/src/stores/chat';
import { useFileStore } from '../web/src/stores/files';
import { ChatView } from '../web/src/components/chat/ChatView';

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

function typeInTextarea(textarea: HTMLTextAreaElement, text: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

const WS_JID = 'web:ws-integrated';
const AGENT_ALPHA = 'agent-alpha';
const AGENT_BETA = 'agent-beta';

beforeEach(() => {
  storageMap.clear();
  useChatStore.setState({
    groups: {
      [WS_JID]: {
        jid: WS_JID,
        name: 'Integrated Test Workspace',
        folder: 'flow-integrated',
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
          id: AGENT_ALPHA,
          name: 'Alpha Agent',
          status: 'idle',
          kind: 'conversation',
          created_at: '2026-09-01T00:00:00Z',
        },
        {
          id: AGENT_BETA,
          name: 'Beta Agent',
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

  useFileStore.setState({
    uploadFiles: vi.fn(async () => true),
    cancelUpload: vi.fn(),
    uploading: false,
    uploadProgress: null,
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

describe('R04: Real ChatView and Zustand store integration test', () => {
  test('Main -> Alpha -> Beta circular switching preserves drafts in real store and restores accurately', async () => {
    // Mount ChatView at initial route (Main conversation)
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid={WS_JID} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    // Wait for initial loadAgents and effects to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    console.log(
      'SIDEBAR TEXT:',
      container?.querySelector('[data-hc-session-sidebar]')?.textContent,
    );

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea()).toBeTruthy();
    expect(textarea().value).toBe('');

    const clickSession = async (name: string) => {
      const allBtns = Array.from(container?.querySelectorAll('button') ?? []);
      const btn = allBtns.find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // 1. Type in Main
    await act(async () => {
      typeInTextarea(textarea(), 'Draft in Main Workspace');
    });

    // 2. Switch to Agent Alpha by clicking Session row in sidebar
    await clickSession('Alpha Agent');

    // Verify Main draft saved to real store at WS_JID::main
    const storeStateAfterMain = useChatStore.getState();
    expect(storeStateAfterMain.drafts[`${WS_JID}::main`]).toBe(
      'Draft in Main Workspace',
    );
    expect(textarea().value).toBe('');

    // Type in Alpha
    await act(async () => {
      typeInTextarea(textarea(), 'Draft in Alpha Sub-Agent');
    });

    // 3. Switch to Agent Beta by clicking Session row
    await clickSession('Beta Agent');

    expect(useChatStore.getState().drafts[`${WS_JID}::${AGENT_ALPHA}`]).toBe(
      'Draft in Alpha Sub-Agent',
    );
    expect(textarea().value).toBe('');

    // Type in Beta
    await act(async () => {
      typeInTextarea(textarea(), 'Draft in Beta Sub-Agent');
    });

    // 4. Switch back to Main
    await clickSession('Integrated Test Workspace 对话');
    expect(textarea().value).toBe('Draft in Main Workspace');

    // 5. Switch back to Alpha: Alpha draft restored!
    await clickSession('Alpha Agent');
    expect(textarea().value).toBe('Draft in Alpha Sub-Agent');

    // 6. Switch back to Beta: Beta draft restored!
    await clickSession('Beta Agent');
    expect(textarea().value).toBe('Draft in Beta Sub-Agent');
  });

  test('legacy key migration in real store and permanent tombstone prevents ghost resurrection', async () => {
    // Pre-populate old legacy key in store
    useChatStore.setState({
      drafts: {
        [WS_JID]: 'Old legacy text from previous version',
      },
    });

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea()).toBeTruthy();
    expect(textarea().value).toBe('Old legacy text from previous version');
    // Store should have migrated to key with ::main and deleted old key
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe(
      'Old legacy text from previous version',
    );
    expect(useChatStore.getState().drafts[WS_JID]).toBeUndefined();

    // Mock sending message in store
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValueOnce(
      true,
    );

    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });

    // Sent message clears store draft
    expect(textarea().value).toBe('');
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBeUndefined();
    expect(useChatStore.getState().drafts[WS_JID]).toBeUndefined();

    const clickSession = async (name: string) => {
      const btn = Array.from(
        container?.querySelectorAll('[data-hc-session-sidebar] button') ?? [],
      ).find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // Switch to Alpha and switch back to Main
    await clickSession('Alpha Agent');
    await clickSession('Integrated Test Workspace 对话');

    // Legacy draft must NOT resurrect!
    expect(textarea().value).toBe('');
    expect(useChatStore.getState().drafts[WS_JID]).toBeUndefined();
  });

  test('A sends -> switch B -> back to A type Draft 2 -> late send success does NOT wipe store or DOM upon reload', async () => {
    let resolveSendMain: (ok: boolean) => void = () => {};
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSendMain = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    const clickSession = async (name: string) => {
      const btn = Array.from(
        container?.querySelectorAll('[data-hc-session-sidebar] button') ?? [],
      ).find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // 1. In Main, type Message 1 and click send
    await act(async () => {
      typeInTextarea(textarea(), 'Message 1 from Main');
    });

    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });

    // 2. While send is pending, switch to Alpha
    await clickSession('Alpha Agent');
    expect(textarea().value).toBe('');

    // 3. Switch back to Main and type Draft 2, wait 350ms for debounce save
    await clickSession('Integrated Test Workspace 对话');
    await act(async () => {
      typeInTextarea(textarea(), 'Draft 2 typed after returning to Main');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // Verify Draft 2 is safely persisted in real store
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe(
      'Draft 2 typed after returning to Main',
    );

    // 4. Earlier send from step 1 now resolves successfully
    await act(async () => {
      resolveSendMain(true);
    });

    // CRITICAL: store draft must NOT be cleared by the old send!
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe(
      'Draft 2 typed after returning to Main',
    );
    expect(textarea().value).toBe('Draft 2 typed after returning to Main');

    // 5. Simulate page refresh / unmount-remount: Draft 2 must be restored!
    await act(async () => {
      root?.unmount();
      root = createRoot(container!);
    });

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const reloadedTextarea = container?.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    expect(reloadedTextarea.value).toBe(
      'Draft 2 typed after returning to Main',
    );
  });

  test('A sends -> switch B -> back to A type Draft 3 -> switch B -> send fails: old failure does NOT overwrite new draft', async () => {
    let rejectSendMain: (ok: boolean) => void = () => {};
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          rejectSendMain = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    const clickSession = async (name: string) => {
      const btn = Array.from(
        container?.querySelectorAll('[data-hc-session-sidebar] button') ?? [],
      ).find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // 1. Send Message A
    await act(async () => {
      typeInTextarea(textarea(), 'Message A');
    });
    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });

    // 2. Switch B
    await clickSession('Alpha Agent');

    // 3. Back to Main, type Draft 3 and wait 350ms
    await clickSession('Integrated Test Workspace 对话');
    await act(async () => {
      typeInTextarea(textarea(), 'Draft 3 in Main');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe(
      'Draft 3 in Main',
    );

    // 4. Switch to Beta
    await clickSession('Beta Agent');

    // 5. Earlier Message A fails!
    await act(async () => {
      rejectSendMain(false);
    });

    // 6. Switch back to Main: Draft 3 must still be preserved, NOT overwritten by old 'Message A'!
    await clickSession('Integrated Test Workspace 对话');
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe(
      'Draft 3 in Main',
    );
    expect(textarea().value).toBe('Draft 3 in Main');
  });

  test('clearing textarea and quickly unmounting cleans store reliably and prevents ghost resurrection', async () => {
    // Seed draft in store
    useChatStore
      .getState()
      .saveDraft(`${WS_JID}::main`, 'Existing draft to delete');

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea().value).toBe('Existing draft to delete');

    // User empties the textarea and unmounts immediately (before 300ms debounce fires)
    await act(async () => {
      typeInTextarea(textarea(), '');
    });

    // Immediately unmount component
    await act(async () => {
      root?.unmount();
      root = createRoot(container!);
    });

    // Store draft must be reliably cleared via contentRef without waiting for timer!
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBeUndefined();

    // Remount: must be completely empty, no resurrection!
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const newTextarea = container?.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    expect(newTextarea.value).toBe('');
  });

  test('ABA Scenario: A sends X -> switch B -> switch A -> edit to Y then back to X -> switch B -> old send X succeeds: store draft X is NOT deleted and restores on reload', async () => {
    let resolveSendMain: (ok: boolean) => void = () => {};
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSendMain = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    const clickSession = async (name: string) => {
      const btn = Array.from(
        container?.querySelectorAll('[data-hc-session-sidebar] button') ?? [],
      ).find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // 1. A sends text 'X'
    await act(async () => {
      typeInTextarea(textarea(), 'X');
    });
    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });

    // 2. Switch B
    await clickSession('Alpha Agent');

    // 3. Switch A
    await clickSession('Integrated Test Workspace 对话');

    // 4. Edit to Y and wait debounce
    await act(async () => {
      typeInTextarea(textarea(), 'Y');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe('Y');

    // 5. Edit back to X (identical text as original send!) and wait debounce
    await act(async () => {
      typeInTextarea(textarea(), 'X');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe('X');

    // 6. Switch B
    await clickSession('Alpha Agent');

    // 7. Old send of X succeeds now!
    await act(async () => {
      resolveSendMain(true);
    });

    // CAS protection check: store revision is higher, so clearDraftIfRevision failed to delete the new 'X'!
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBe('X');

    // 8. Refresh / remount simulation
    await act(async () => {
      root?.unmount();
      root = createRoot(container!);
    });
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    // Check Main conversation draft
    await clickSession('Integrated Test Workspace 对话');

    const reloadedTextarea = container?.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    expect(reloadedTextarea.value).toBe('X');
  });

  test('Empty Scenario: A sends X -> switch B -> switch A -> delete all text to empty -> switch B -> old send X fails: does NOT resurrect X into store or DOM', async () => {
    let rejectSendMain: (ok: boolean) => void = () => {};
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          rejectSendMain = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const textarea = () =>
      container?.querySelector('textarea') as HTMLTextAreaElement;
    const clickSession = async (name: string) => {
      const btn = Array.from(
        container?.querySelectorAll('[data-hc-session-sidebar] button') ?? [],
      ).find((b) => b.textContent?.includes(name));
      expect(btn).toBeTruthy();
      await act(async () => {
        btn?.click();
      });
    };

    // 1. A sends text 'X'
    await act(async () => {
      typeInTextarea(textarea(), 'X');
    });
    const sendBtn = () =>
      container?.querySelector('button[title="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn().click();
    });

    // 2. Switch B
    await clickSession('Alpha Agent');

    // 3. Switch A
    await clickSession('Integrated Test Workspace 对话');

    // 4. Delete all text (empty) and wait debounce to persist deletion
    await act(async () => {
      typeInTextarea(textarea(), '');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBeUndefined();

    // 5. Switch B
    await clickSession('Alpha Agent');

    // 6. Old send of X fails now!
    await act(async () => {
      rejectSendMain(false);
    });

    // CAS protection check: store revision is higher, so saveDraftIfRevision refused to save old X!
    expect(useChatStore.getState().drafts[`${WS_JID}::main`]).toBeUndefined();

    // 7. Switch back to A: still empty!
    await clickSession('Integrated Test Workspace 对话');
    expect(textarea().value).toBe('');

    // 8. Refresh / remount simulation: still empty!
    await act(async () => {
      root?.unmount();
      root = createRoot(container!);
    });
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-integrated`]}>
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

    const reloadedTextarea = container?.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    expect(reloadedTextarea.value).toBe('');
  });
});
