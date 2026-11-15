// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../api/client', () => ({ api: { get } }));

const { emulatePointer } = await import('../../ui/overlay-test-utils');
const { WorkspaceRowMenu } = await import('./WorkspaceTree');
const { useAuthStore } = await import('../../../stores/auth');
const { forgetWorkspaceModelOptions } =
  await import('../../../lib/session-model-choice');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const group = {
  jid: 'web:dev',
  name: 'Dev',
  folder: 'dev',
  can_modify: true,
} as never;

let root: Root | null = null;

beforeEach(() => {
  emulatePointer('desktop');
  get.mockImplementation(async (path: string) =>
    path.endsWith('/model-options')
      ? {
          default: { source: 'agent', modelConfigId: 'glm', model: 'glm-5.3' },
          options: [
            {
              id: 'glm',
              name: 'GLM',
              kind: 'third_party',
              model: 'glm-5.3',
              usable: true,
              models: [{ id: 'glm-5.3', efforts: [], defaultEffort: null }],
            },
          ],
        }
      : { available: true },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  get.mockReset();
  forgetWorkspaceModelOptions();
  vi.restoreAllMocks();
});

async function openMenu(role: 'member' | 'admin') {
  useAuthStore.setState({
    user: { id: 'u1', username: 'owner', role },
  } as never);
  const onCreateSession = vi.fn(async () => true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <WorkspaceRowMenu
        group={group}
        isHome={false}
        displayName="Dev"
        actions={{ onCreateSession, onClearHistory: vi.fn() }}
      />,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Dev的更多操作"]',
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  return onCreateSession;
}

const items = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );

async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .filter((candidate) => candidate.textContent?.trim() === label)
    .at(0)!;
  await act(async () => item.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the new-session dialog in the workspace menu', () => {
  test('anyone who may add a session gets it with a name and a model', async () => {
    const onCreateSession = await openMenu('member');
    expect(items()).toContain('新建会话…');
    // Worktrees stay a host feature.
    expect(items()).not.toContain('新建独立 worktree 会话…');

    await choose('新建会话…');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(
      dialog.querySelector('select[aria-label="模型连接"]'),
    ).not.toBeNull();
    expect(dialog.querySelector('#new-session-worktree')).toBeNull();
    expect(get).not.toHaveBeenCalledWith(
      '/api/groups/web%3Adev/git/worktree-support',
    );

    const create = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '创建',
    )!;
    await act(async () => create.click());
    expect(onCreateSession).toHaveBeenCalledWith(
      group,
      expect.objectContaining({ name: '', worktree: false }),
    );
  });

  test('an admin keeps the worktree item, which offers the worktree', async () => {
    await openMenu('admin');
    expect(items()).toEqual(
      expect.arrayContaining(['新建会话…', '新建独立 worktree 会话…']),
    );
    await choose('新建独立 worktree 会话…');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('#new-session-worktree')).not.toBeNull();
    expect(
      dialog.querySelector('select[aria-label="模型连接"]'),
    ).not.toBeNull();
  });
});
