// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const mockProfiles = [
  {
    id: 'agent-reviewer',
    name: '代码审查员',
    identity_prompt: '代码审查助手',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    model_config_id: null,
    is_default: false,
    runtime_policy: {
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    },
  },
  {
    id: 'agent-writer',
    name: '文案撰写员',
    identity_prompt: '文案撰写助手',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    model_config_id: null,
    is_default: false,
    runtime_policy: {
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    },
  },
];

const mockCreateFlow = vi.fn();

vi.mock('../web/src/stores/agent-profiles', () => ({
  useAgentProfilesStore: (selector?: any) => {
    const state = {
      profiles: mockProfiles,
      loading: false,
      profilesError: null,
      loadProfiles: vi.fn(),
      createProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      refreshProfile: vi.fn(),
      loadProfileGovernance: vi.fn(async () => ({ workspaces: [] })),
      governance: { workspaces: [] },
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: (selector?: any) => {
    const state = {
      user: { id: 'test-admin', role: 'admin' },
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/agents')) {
        return { agents: [] };
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
import { CreateContainerDialog } from '../web/src/components/chat/CreateContainerDialog';
import { ChatView } from '../web/src/components/chat/ChatView';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
  mockNavigate.mockReset();
  mockCreateFlow.mockReset();

  useChatStore.setState({
    createFlow: mockCreateFlow,
    adminHostOnlyMode: false,
    groups: {
      'web:ws-r08': {
        jid: 'web:ws-r08',
        name: 'R08 Workspace',
        folder: 'flow-r08',
        added_at: '2026-09-01T00:00:00Z',
        execution_mode: 'container',
        can_modify: true,
      } as any,
    },
    messages: {
      'web:ws-r08': [],
    },
    agents: {
      'web:ws-r08': [],
    },
    activeAgentTab: {
      'web:ws-r08': null,
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

describe('R08: Agent Workspace creation CTA and Channel Binding Layering', () => {
  test('CreateContainerDialog preselects agent and creates workspace on user confirm', async () => {
    mockCreateFlow.mockResolvedValue({
      jid: 'web:ws-new',
      folder: 'flow-new-workspace',
    });
    const onCreated = vi.fn((jid, folder) => {
      mockNavigate(`/chat/${folder}`);
    });

    await act(async () => {
      root?.render(
        <CreateContainerDialog
          open={true}
          onClose={vi.fn()}
          onCreated={onCreated}
          initialAgentProfileId="agent-reviewer"
        />,
      );
    });

    expect(document.body.textContent).toContain('新建工作区');

    const nameInput = document.body.querySelector(
      'input[placeholder="输入这个智能体工作区的名称"], input#workspace-name',
    ) as HTMLInputElement;
    expect(nameInput).toBeTruthy();

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(nameInput, '审查员专用工作区');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '创建',
    );
    expect(submitBtn).toBeTruthy();

    await act(async () => {
      submitBtn?.click();
    });

    expect(mockCreateFlow).toHaveBeenCalledWith(
      '审查员专用工作区',
      expect.objectContaining({
        agent_profile_id: 'agent-reviewer',
      }),
    );

    expect(onCreated).toHaveBeenCalledWith('web:ws-new', 'flow-new-workspace');
    expect(mockNavigate).toHaveBeenCalledWith('/chat/flow-new-workspace');
  });

  test('user manual selection of different agent is preserved and not stolen back on rerender', async () => {
    mockCreateFlow.mockResolvedValue({
      jid: 'web:ws-manual',
      folder: 'flow-manual',
    });

    await act(async () => {
      root?.render(
        <CreateContainerDialog
          open={true}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          initialAgentProfileId="agent-reviewer"
        />,
      );
    });

    // Enter name
    const nameInput = document.body.querySelector(
      'input[placeholder="输入这个智能体工作区的名称"], input#workspace-name',
    ) as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(nameInput, '改选文案助手工作区');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Trigger Select to change to agent-writer
    const selectTrigger = document.body.querySelector(
      '#workspace-agent-profile, [data-slot="select-trigger"]',
    ) as HTMLButtonElement;
    expect(selectTrigger).toBeTruthy();

    await act(async () => {
      selectTrigger.click();
    });

    // In Radix Select, options are rendered in portal
    const writerOption = Array.from(
      document.body.querySelectorAll(
        '[role="option"], [data-slot="select-item"]',
      ),
    ).find((el) => el.textContent?.includes('文案撰写员')) as HTMLElement;

    if (writerOption) {
      await act(async () => {
        writerOption.click();
      });
    }

    // Submit
    const submitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '创建',
    );
    await act(async () => {
      submitBtn?.click();
    });

    // Verify submission preserved the user's manual selection of agent-writer
    expect(mockCreateFlow).toHaveBeenCalledTimes(1);
    expect(mockCreateFlow).toHaveBeenCalledWith(
      '改选文案助手工作区',
      expect.objectContaining({
        agent_profile_id: 'agent-writer',
      }),
    );
  });

  test('header in real ChatView DOM clearly renders both topic workspace binding and session group binding', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/chat/flow-r08`]}>
          <Routes>
            <Route
              path="/chat/:groupFolder"
              element={<ChatView groupJid="web:ws-r08" />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    // Find the two binding buttons in the real ChatView DOM
    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    const topicBindingBtn = buttons.find((b) =>
      b.textContent?.includes('话题群绑定'),
    );
    const sessionBindingBtn = buttons.find((b) =>
      b.textContent?.includes('会话群绑定'),
    );

    expect(topicBindingBtn).toBeTruthy();
    expect(topicBindingBtn?.getAttribute('title')).toBe('管理工作区话题群绑定');

    expect(sessionBindingBtn).toBeTruthy();
    expect(sessionBindingBtn?.getAttribute('title')).toContain('普通群绑定');

    // Click topic binding button -> opens binding dialog for workspace
    await act(async () => {
      topicBindingBtn?.click();
    });

    // Real DOM should now have the ImBindingDialog open in workspace mode
    expect(document.body.textContent).toContain('话题群绑定工作区');
  });
});
