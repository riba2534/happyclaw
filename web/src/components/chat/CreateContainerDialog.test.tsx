// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFlow: vi.fn(async () => ({ jid: 'web:new', folder: 'new' })),
  onCreated: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../../stores/chat', () => {
  const state = {
    createFlow: mocks.createFlow,
    groups: {},
    adminHostOnlyMode: false,
  };
  return {
    useChatStore: (selector: (value: unknown) => unknown) => selector(state),
  };
});
vi.mock('../../stores/auth', () => {
  const state = { user: { role: 'member' } };
  return {
    useAuthStore: (selector: (value: unknown) => unknown) => selector(state),
  };
});
vi.mock('../../stores/agent-profiles', () => {
  const state = {
    profiles: [
      {
        id: 'main',
        name: '主智能体',
        is_default: true,
        identity_prompt: '',
        runtime_policy: { skills: {} },
      },
    ],
    loading: false,
    profilesError: null,
    loadProfiles: vi.fn(async () => undefined),
  };
  return {
    useAgentProfilesStore: (selector: (value: unknown) => unknown) =>
      selector(state),
  };
});
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const { CreateContainerDialog } = await import('./CreateContainerDialog');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function render() {
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <CreateContainerDialog
        open
        onClose={mocks.onClose}
        onCreated={mocks.onCreated}
      />,
    );
  });
}

const workModeRadio = (value: string) =>
  document.querySelector<HTMLInputElement>(
    `input[name="create-workspace-work-mode"][value="${value}"]`,
  )!;
const hint = () =>
  document.querySelector('[data-testid="work-mode-hint"]')?.textContent;

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('#workspace-name')!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function create() {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === '创建',
  )!;
  await act(async () => button.click());
}

describe('creating a workspace: 工作方式', () => {
  test('offers single and multi apart from the reply mode, single first', async () => {
    await render();
    const legends = [...document.querySelectorAll('legend')].map(
      (legend) => legend.textContent,
    );
    expect(legends).toEqual(
      expect.arrayContaining(['工作区回复模式', '工作方式']),
    );
    expect(workModeRadio('single').checked).toBe(true);
    expect(workModeRadio('multi').checked).toBe(false);
    expect(workModeRadio('single').closest('label')?.textContent).toContain(
      '单任务（默认）',
    );
    expect(hint()).toBe('消息按顺序处理，一条处理完再处理下一条。');

    await typeName('调研');
    await create();
    expect(mocks.createFlow).toHaveBeenCalledWith(
      '调研',
      expect.objectContaining({ work_mode: 'single' }),
    );
  });

  test('sends multi when chosen and says what it means', async () => {
    await render();
    await act(async () => workModeRadio('multi').click());
    expect(workModeRadio('multi').checked).toBe(true);
    expect(hint()).toBe(
      '较大的任务交给后台 Worker 处理，对话不会被卡住，完成后由 Agent 汇报结果。',
    );

    await typeName('并行调研');
    await create();
    expect(mocks.createFlow).toHaveBeenCalledWith(
      '并行调研',
      expect.objectContaining({
        work_mode: 'multi',
        interaction_mode: 'assistant',
      }),
    );
  });
});
