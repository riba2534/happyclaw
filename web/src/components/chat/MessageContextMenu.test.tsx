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

const { MessageContextMenu, quoteForComposer } =
  await import('./MessageContextMenu');
const { useShellStore } = await import('../../stores/shell');
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

describe('quoteForComposer', () => {
  test('puts each line behind a quote marker and leaves a line to type on', () => {
    expect(quoteForComposer('**第一行**\n\n第二行')).toBe(
      '> 第一行\n>\n> 第二行\n\n',
    );
  });

  test('ends a long message in an ellipsis', () => {
    const quoted = quoteForComposer('字'.repeat(500));
    expect(quoted.startsWith('> ')).toBe(true);
    expect(quoted.endsWith('…\n\n')).toBe(true);
    expect(quoted.length).toBeLessThan(310);
  });

  test('cuts a long message between characters, never inside an emoji', () => {
    const quoted = quoteForComposer(`${'a'.repeat(299)}😀😀 tail`);
    expect(quoted).toBe(`> ${'a'.repeat(299)}😀…\n\n`);
    // No half of a surrogate pair is left behind.
    expect(quoted).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    // Counted in characters, not UTF-16 units: 300 emoji fit whole.
    expect(quoteForComposer('😀'.repeat(300))).toBe(
      `> ${'😀'.repeat(300)}\n\n`,
    );
  });
});

describe('MessageContextMenu quote', () => {
  test('quote fills the composer with the message, not sends it', async () => {
    await act(async () => {
      root?.render(
        <MessageContextMenu content="明天 9 点开会" chatJid="web:main#agent:s">
          <button type="button">消息菜单</button>
        </MessageContextMenu>,
      );
    });
    await act(async () => {
      findButton('消息菜单')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();
    await act(async () => {
      findButton('引用')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(useShellStore.getState().composerDraftRequest?.text).toBe(
      '> 明天 9 点开会\n\n',
    );
  });
});
