// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The cards themselves are DelegatedTaskCards.test.tsx's; here only where
// they appear: in a multi-task workspace, never in a single-task one.
const cards = vi.hoisted(() => vi.fn());
vi.mock('./DelegatedTaskCards', () => ({
  DelegatedTaskCards: (props: { groupJid: string; sessionId: string }) => {
    cards(props);
    return <section data-testid="delegated-tasks" />;
  },
}));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (index: number) => [...storage.keys()][index] ?? null,
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
} satisfies Storage);

const { MessageList } = await import('./MessageList');
import type { WorkMode } from '../../work-items';

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

async function render(workMode?: WorkMode) {
  if (root) await act(async () => root?.unmount());
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MessageList
        messages={[
          {
            id: 'm1',
            chat_jid: 'web:alpha#agent:main',
            sender: 'user-1',
            sender_name: '我',
            content: '把文档整理一下',
            timestamp: '2026-11-01T01:00:00.000Z',
            is_from_me: false,
          },
        ]}
        loading={false}
        hasMore={false}
        onLoadMore={() => undefined}
        groupJid="web:alpha"
        agentId="main"
        workMode={workMode}
      />,
    );
  });
}

describe('the transcript and the work mode', () => {
  test('a multi-task session lists the tasks it delegated', async () => {
    await render('multi');
    expect(
      document.querySelectorAll('[data-testid="delegated-tasks"]'),
    ).toHaveLength(1);
    expect(cards).toHaveBeenCalledWith(
      expect.objectContaining({ groupJid: 'web:alpha', sessionId: 'main' }),
    );
  });

  test('a single-task session shows nothing new', async () => {
    await render('single');
    await render(undefined);
    expect(
      document.querySelector('[data-testid="delegated-tasks"]'),
    ).toBeNull();
    expect(cards).not.toHaveBeenCalled();
  });
});
