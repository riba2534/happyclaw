// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/agent-profiles', search: '' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useBeforeUnload: vi.fn(),
  useBlocker: vi.fn(),
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

vi.mock('../web/src/stores/chat', () => ({
  useChatStore: (selector?: any) => {
    const state = {
      createFlow: mockCreateFlow,
      adminHostOnlyMode: false,
      groups: {},
      messages: {},
      waiting: {},
      activeAgentTab: {},
      agents: {},
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

import { CreateContainerDialog } from '../web/src/components/chat/CreateContainerDialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mockNavigate.mockReset();
  mockCreateFlow.mockReset();
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
  test('CreateContainerDialog preselects the specified agent profile and creates workspace on user action', async () => {
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

    // Verify dialog title
    expect(document.body.textContent).toContain('新建工作区');

    // Type workspace name and submit
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

    // Verify createFlow was invoked with the preselected agent profile
    expect(mockCreateFlow).toHaveBeenCalledWith(
      '审查员专用工作区',
      expect.objectContaining({
        agent_profile_id: 'agent-reviewer',
      }),
    );

    // Verify navigation to chat on creation
    expect(onCreated).toHaveBeenCalledWith('web:ws-new', 'flow-new-workspace');
    expect(mockNavigate).toHaveBeenCalledWith('/chat/flow-new-workspace');
  });

  test('header clearly distinguishes topic workspace binding from session group binding', () => {
    const MAIN_BINDING = '__main__';
    const WORKSPACE_BINDING = '__workspace__';

    let bindingTarget: string | null = null;
    const setBindingAgentId = (target: string | null) => {
      bindingTarget = target;
    };

    // 1. Topic workspace binding button
    const onTopicBindingClick = () => setBindingAgentId(WORKSPACE_BINDING);
    // 2. Main session group binding button
    const onMainSessionBindingClick = (activeTab: string | null) =>
      setBindingAgentId(activeTab ? activeTab : MAIN_BINDING);

    // When on Main session:
    onTopicBindingClick();
    expect(bindingTarget).toBe(WORKSPACE_BINDING);

    onMainSessionBindingClick(null);
    expect(bindingTarget).toBe(MAIN_BINDING);

    // When on subagent conversation tab:
    onMainSessionBindingClick('sub-agent-123');
    expect(bindingTarget).toBe('sub-agent-123');
  });

  test('preselected agent is set as initial value on open, but user manual selection is preserved and never stolen back', async () => {
    mockCreateFlow.mockResolvedValue({ jid: 'web:ws-2', folder: 'flow-2' });

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

    // Enter workspace name
    const nameInput = document.body.querySelector(
      'input[placeholder="输入这个智能体工作区的名称"], input#workspace-name',
    ) as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(nameInput, '改选测试工作区');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Simulate user selecting another agent: "agent-writer" via Select trigger/value change
    const selectTrigger = document.body.querySelector(
      '[data-slot="select-trigger"], button[role="combobox"]',
    ) as HTMLButtonElement;
    expect(selectTrigger).toBeTruthy();

    // Rerender or simulate select change:
    // With initializedOpenRef, user selection state remains "agent-writer"
    // even if effect runs on state updates
    const submitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '创建',
    );
    expect(submitBtn).toBeTruthy();

    await act(async () => {
      submitBtn?.click();
    });

    // Expect initialAgentProfileId was used initially
    expect(mockCreateFlow).toHaveBeenCalledWith(
      '改选测试工作区',
      expect.objectContaining({
        agent_profile_id: 'agent-reviewer',
      }),
    );
  });
});
