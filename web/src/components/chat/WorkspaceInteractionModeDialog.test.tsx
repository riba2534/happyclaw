// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn() },
  onSave: vi.fn(async () => true),
  onSaveVisibility: vi.fn(async () => true),
  onSaveWorkMode: vi.fn(async () => true),
  onClose: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: mocks.api }));
vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ groups: {} }),
}));
vi.mock('@/stores/agent-profiles', () => {
  const state = {
    profiles: [{ id: 'main', name: '主智能体', is_default: true }],
    loadProfiles: vi.fn(async () => undefined),
    setWorkspaceAgentProfile: vi.fn(async () => undefined),
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
  await import('./WorkspaceInteractionModeDialog');
const { useWorkItemsStore } = await import('../../stores/work-items');
import type { WorkMode } from '../../work-items';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'web:alpha';
const NOTICE = '已派出的任务会继续完成并汇报，之后不再派新任务。';
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useWorkItemsStore.setState({ items: {}, requested: {} });
  vi.clearAllMocks();
});

function openItems(...items: { origin: string; status: string }[]) {
  mocks.api.get.mockResolvedValue({
    items: items.map((item, index) => ({
      id: `wi-${index}`,
      workspaceJid: WS,
      ...item,
    })),
  });
}

async function render(currentWorkMode: WorkMode, groupJid = WS) {
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <WorkspaceInteractionModeDialog
        open
        groupJid={groupJid}
        workspaceName="调研"
        currentMode="assistant"
        currentVisibility="activity"
        currentWorkMode={currentWorkMode}
        onClose={mocks.onClose}
        onSave={mocks.onSave}
        onSaveVisibility={mocks.onSaveVisibility}
        onSaveWorkMode={mocks.onSaveWorkMode}
      />,
    );
  });
}

const radio = (value: WorkMode) =>
  document.querySelector<HTMLInputElement>(
    `input[name="workspace-work-mode"][value="${value}"]`,
  );
const choose = (value: WorkMode) => act(async () => radio(value)!.click());
const save = () =>
  act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '保存更改')!
      .click(),
  );

describe('workspace settings: 工作方式', () => {
  test('switches to multi-task on save, without touching the reply mode', async () => {
    openItems();
    await render('single');
    expect(radio('single')?.checked).toBe(true);
    expect(document.body.textContent).toContain(
      '较大的任务交给后台 Worker 处理，对话不会被卡住，完成后由 Agent 汇报结果。',
    );
    // A single-task workspace has nothing delegated to look up.
    expect(mocks.api.get).not.toHaveBeenCalled();

    await choose('multi');
    await save();
    expect(mocks.onSaveWorkMode).toHaveBeenCalledWith('multi');
    expect(mocks.onSave).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('已切换为多任务');
    expect(mocks.onClose).toHaveBeenCalled();
  });

  test('leaving multi-task with tasks still out says they will finish', async () => {
    openItems(
      { origin: 'delegated', status: 'open' },
      { origin: 'team', status: 'open' },
    );
    await render('multi');
    expect(mocks.api.get).toHaveBeenCalledWith(
      `/api/workspaces/${encodeURIComponent(WS)}/work-items?status=open`,
    );
    expect(document.body.textContent).not.toContain(NOTICE);

    await choose('single');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(NOTICE);
    await save();
    expect(mocks.onSaveWorkMode).toHaveBeenCalledWith('single');
  });

  test('no notice when nothing delegated is still open', async () => {
    openItems({ origin: 'team', status: 'open' });
    await render('multi');
    await choose('single');
    expect(document.body.textContent).not.toContain(NOTICE);
  });

  test('a failed save keeps the dialog open', async () => {
    openItems();
    mocks.onSaveWorkMode.mockResolvedValueOnce(false);
    await render('single');
    await choose('multi');
    await save();
    expect(mocks.toastError).toHaveBeenCalledWith('工作方式保存失败，请重试');
    expect(mocks.onClose).not.toHaveBeenCalled();
  });

  test('only a Web workspace has a work mode', async () => {
    await render('single', 'feishu:oc_1');
    expect(radio('single')).toBeNull();
  });
});
