// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const deleteMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/chat', () => ({
  useChatStore: {
    getState: () => ({ deleteMessage: deleteMessageMock }),
  },
}));

const { MessageContextMenu } = await import('./MessageContextMenu');
const { ConfirmHost } = await import('../common/ConfirmHost');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  deleteMessageMock.mockReset();
  deleteMessageMock.mockResolvedValue(true);
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

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const findButton = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (node) => node.textContent?.trim() === label,
  );

describe('MessageContextMenu deletion semantics', () => {
  test('states that deletion removes persisted history but does not retract active input', async () => {
    await act(async () => {
      root?.render(
        <>
          <MessageContextMenu
            content="sensitive prompt"
            chatJid="web:main#agent:session-1"
            messageId="message-1"
          >
            <button type="button">消息菜单</button>
          </MessageContextMenu>
          <ConfirmHost />
        </>,
      );
    });

    const trigger = findButton('消息菜单');
    await act(async () => {
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();

    const deleteItem = findButton('删除聊天记录');
    expect(deleteItem).toBeDefined();
    await act(async () => {
      deleteItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // ConfirmHost lazy-loads the dialog the first time it is needed.
    await vi.waitFor(
      async () => {
        await flush();
        expect(document.body.textContent).toContain(
          '仅删除持久聊天记录，不会撤回正在处理的模型输入。',
        );
      },
      { timeout: 5000 },
    );
    expect(document.body.textContent).toContain('确认删除记录');
    expect(deleteMessageMock).not.toHaveBeenCalled();

    await act(async () => {
      findButton('确认删除记录')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(deleteMessageMock).toHaveBeenCalledWith(
      'web:main#agent:session-1',
      'message-1',
    );
  });
});
