// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { choose, combobox } from '../settings/test-helpers';

const mocks = vi.hoisted(() => ({
  groups: {} as Record<string, unknown>,
  setWorkspaceAgentProfile: vi.fn(async () => undefined),
  onSave: vi.fn(async () => true),
  onClose: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ groups: mocks.groups }),
}));
vi.mock('@/stores/agent-profiles', () => {
  const state = {
    profiles: [
      { id: 'main', name: 'Default Agent', is_default: true },
      { id: 'coder', name: '代码助手', is_default: false },
    ],
    loadProfiles: vi.fn(async () => undefined),
    setWorkspaceAgentProfile: mocks.setWorkspaceAgentProfile,
  };
  return {
    useAgentProfilesStore: (selector: (value: unknown) => unknown) =>
      selector(state),
  };
});
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { WorkspaceInteractionModeDialog } =
  await import('../chat/WorkspaceInteractionModeDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  vi.clearAllMocks();
});

async function renderDialog(groupJid: string) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkspaceInteractionModeDialog
        open
        groupJid={groupJid}
        workspaceName="调研"
        currentMode="assistant"
        currentVisibility="activity"
        currentWorkMode="single"
        onClose={mocks.onClose}
        onSave={mocks.onSave}
        onSaveVisibility={mocks.onSave}
        onSaveWorkMode={mocks.onSave}
      />,
    );
  });
}

function saveButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === '保存更改',
  )!;
}

describe('changing the Agent of a Workspace', () => {
  test('applies the chosen Agent on save through the migration endpoint', async () => {
    mocks.groups = {
      'web:research': { agent_profile_id: 'main', is_home: false },
    };
    await renderDialog('web:research');
    expect(combobox('工作区所属智能体').textContent).toContain('HappyClaw');

    await choose(combobox('工作区所属智能体'), '代码助手');
    expect(document.body.textContent).toContain('正在进行的对话会被中断');
    expect(mocks.setWorkspaceAgentProfile).not.toHaveBeenCalled();

    await act(async () => saveButton().click());
    expect(mocks.setWorkspaceAgentProfile).toHaveBeenCalledWith(
      'web:research',
      'coder',
    );
    expect(mocks.onSave).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已更换工作区智能体');
    expect(mocks.onClose).toHaveBeenCalled();
  });

  test('keeps the dialog open when the change is refused', async () => {
    mocks.groups = {
      'web:research': { agent_profile_id: 'main', is_home: false },
    };
    mocks.setWorkspaceAgentProfile.mockRejectedValueOnce({
      status: 409,
      message: '该智能体配置已失效',
    });
    await renderDialog('web:research');
    await choose(combobox('工作区所属智能体'), '代码助手');
    await act(async () => saveButton().click());
    expect(mocks.toastError).toHaveBeenCalledWith(
      '更换智能体失败：该智能体配置已失效',
    );
    expect(mocks.onClose).not.toHaveBeenCalled();
  });

  test('the Home Workspace stays with HappyClaw', async () => {
    mocks.groups = { 'web:home': { agent_profile_id: 'main', is_home: true } };
    await renderDialog('web:home');
    expect(document.body.textContent).toContain(
      'Home 工作区固定使用内置 HappyClaw，不能更换。',
    );
    expect(
      document.querySelector('[aria-label="工作区所属智能体"]'),
    ).toBeNull();
  });
});
