// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api: { get } }));

const { NewSessionDialog } = await import('./NewSessionDialog');

const MODEL_OPTIONS = {
  default: {
    source: 'agent',
    modelConfigId: 'glm',
    connectionMissing: false,
    model: 'glm-5.3',
    effort: null,
  },
  options: [
    {
      id: 'glm',
      name: 'GLM',
      kind: 'third_party',
      model: 'glm-5.3',
      usable: true,
      models: [
        { id: 'glm-5.3', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'glm-4.6', efforts: [], defaultEffort: null },
      ],
    },
  ],
};

/** The workspace's worktree support, and its model options. */
function answer(support: Record<string, unknown>) {
  get.mockImplementation(async (path: string) =>
    path.endsWith('/model-options') ? MODEL_OPTIONS : support,
  );
}

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

function select(label: string): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
}

async function pick(label: string, value: string) {
  const element = select(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** What the dialog asked to create, without its error reporter. */
function requested(onCreate: ReturnType<typeof vi.fn>) {
  const { onError, ...options } = onCreate.mock.calls[0][0] as {
    onError?: unknown;
  };
  expect(onError).toBeTypeOf('function');
  return options;
}

function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
}

describe('NewSessionDialog', () => {
  test('offers a worktree when the workspace supports one', async () => {
    answer({ available: true });
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
    // The default model is not sent.
    expect(requested(onCreate)).toEqual({ name: '', worktree: true });
    expect(onClose).toHaveBeenCalled();
  });

  test('Enter that confirms an IME candidate does not create the session', async () => {
    answer({ available: true });
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
    answer({
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
    expect(requested(onCreate)).toEqual({ name: '', worktree: false });
    // A session that was not created keeps the dialog open.
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a picked model goes with the session', async () => {
    answer({ available: true });
    const onCreate = vi.fn(async () => true);
    await render(
      <NewSessionDialog
        open
        groupJid="web:dev"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );
    expect(get).toHaveBeenCalledWith('/api/groups/web%3Adev/model-options');
    expect(select('模型连接')!.value).toBe('');
    expect(document.body.textContent).toContain('GLM · glm-5.3');

    await pick('模型连接', 'glm');
    await pick('连接中的模型', 'glm-4.6');
    await act(async () => button('创建').click());
    expect(requested(onCreate)).toEqual({
      name: '',
      worktree: true,
      model: { modelConfigId: 'glm', model: 'glm-4.6', effort: null },
    });
  });

  test('a refused choice stays in the dialog with the reason', async () => {
    answer({ available: true });
    const onCreate = vi.fn(
      async (options: { onError?: (message: string) => void }) => {
        options.onError?.('这个模型不支持所选的推理等级');
        return false;
      },
    );
    const onClose = vi.fn();
    await render(
      <NewSessionDialog
        open
        groupJid="web:dev"
        onClose={onClose}
        onCreate={onCreate}
      />,
    );
    await pick('模型连接', 'glm');
    await pick('推理等级', 'high');
    await act(async () => button('创建').click());
    expect(onClose).not.toHaveBeenCalled();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('这个模型不支持所选的推理等级');
    // The choice is kept to be corrected, and changing it clears the reason.
    expect(select('推理等级')!.value).toBe('high');
    await pick('推理等级', 'low');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test('without the worktree option: a name and a model only', async () => {
    answer({ available: true });
    const onCreate = vi.fn(async () => true);
    await render(
      <NewSessionDialog
        open
        groupJid="web:dev"
        offerWorktree={false}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );
    expect(checkbox()).toBeNull();
    expect(get).not.toHaveBeenCalledWith(
      '/api/groups/web%3Adev/git/worktree-support',
    );
    expect(button('创建').disabled).toBe(false);
    await pick('模型连接', 'glm');
    await act(async () => button('创建').click());
    expect(requested(onCreate)).toEqual({
      name: '',
      worktree: false,
      model: { modelConfigId: 'glm', model: null, effort: null },
    });
  });
});
