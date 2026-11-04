// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api: { get } }));

const { NewSessionDialog } = await import('./NewSessionDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  get.mockReset();
});

async function render(ui: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(ui);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function checkbox(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('#new-session-worktree')!;
}

function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
}

describe('NewSessionDialog', () => {
  test('offers a worktree when the workspace supports one', async () => {
    get.mockResolvedValue({ available: true });
    const onCreate = vi.fn(async () => true);
    const onClose = vi.fn();
    await render(
      <NewSessionDialog
        open
        groupJid="web:dev"
        onClose={onClose}
        onCreate={onCreate}
      />,
    );
    expect(get).toHaveBeenCalledWith(
      '/api/groups/web%3Adev/git/worktree-support',
    );
    expect(checkbox().disabled).toBe(false);
    expect(checkbox().getAttribute('data-state')).toBe('checked');

    await act(async () => button('创建').click());
    expect(onCreate).toHaveBeenCalledWith({ name: '', worktree: true });
    expect(onClose).toHaveBeenCalled();
  });

  test('Enter that confirms an IME candidate does not create the session', async () => {
    get.mockResolvedValue({ available: true });
    const onCreate = vi.fn(async () => true);
    await render(
      <NewSessionDialog
        open
        groupJid="web:dev"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('#new-session-name')!;
    const enter = (isComposing: boolean) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            isComposing,
          }),
        );
      });
    await enter(true);
    expect(onCreate).not.toHaveBeenCalled();
    await enter(false);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('disables the option with the reason when the workspace cannot have one', async () => {
    get.mockResolvedValue({
      available: false,
      reason: 'not_git_repo',
      message: '工作目录不是 git 仓库',
    });
    const onCreate = vi.fn(async () => false);
    const onClose = vi.fn();
    await render(
      <NewSessionDialog
        open
        groupJid="web:plain"
        onClose={onClose}
        onCreate={onCreate}
      />,
    );
    expect(checkbox().disabled).toBe(true);
    expect(document.body.textContent).toContain('工作目录不是 git 仓库');

    await act(async () => button('创建').click());
    expect(onCreate).toHaveBeenCalledWith({ name: '', worktree: false });
    // A session that was not created keeps the dialog open.
    expect(onClose).not.toHaveBeenCalled();
  });
});
