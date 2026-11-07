// @vitest-environment happy-dom

/**
 * A notification tapped while no HappyClaw window is open: the push worker
 * opens a window, the real routes take it in (with BrowserRouter, as on
 * desktop Chrome and Android), and the shell routes to the conversation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./api/ws', () => ({
  wsManager: { send: vi.fn(() => true), on: () => () => {} },
}));
vi.mock('./stores/chat', async () => {
  const { create } = await import('zustand');
  return {
    useChatStore: create(() => ({
      currentGroup: null,
      activeAgentTab: {},
      unreadReplies: {},
    })),
  };
});
vi.mock('./utils/appBadge', () => ({ syncAppBadge: vi.fn() }));
// The shell is reduced to the part under test: its Web Push lifecycle.
vi.mock('./components/layout/AppLayout', async () => {
  const { useWebPushLifecycle } = await import('./hooks/useWebPushLifecycle');
  return {
    AppLayout: () => {
      useWebPushLifecycle({ enabled: true });
      return <Outlet />;
    },
  };
});
vi.mock('./pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));

import { createAppRouter } from './App';
import { useAuthStore, type UserPublic } from './stores/auth';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Next to this file, whichever directory vitest runs from. (The test
// environment's URL global does not resolve file: URLs, hence the string.)
const workerSource = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../public/push-sw.js',
  ),
  'utf-8',
);

/** The URL the push worker opens for a tap on `path` with no window open. */
async function urlOpenedByWorker(path: string): Promise<string> {
  const listeners = new Map<string, (event: unknown) => void>();
  const openWindow = vi.fn(async () => null);
  new Function('self', workerSource)({
    addEventListener: (type: string, fn: (event: unknown) => void) =>
      listeners.set(type, fn),
    skipWaiting: () => {},
    registration: {
      scope: `${window.location.origin}/`,
      getNotifications: async () => [],
    },
    clients: { matchAll: async () => [], openWindow },
    navigator: {},
  });
  const waits: Promise<unknown>[] = [];
  listeners.get('notificationclick')!({
    notification: { close: () => {}, data: { path } },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  expect(openWindow).toHaveBeenCalledTimes(1);
  return (openWindow.mock.calls[0] as unknown[])[0] as string;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  useAuthStore.setState({
    authenticated: true,
    checking: false,
    initialized: true,
    user: {
      id: 'alice',
      role: 'member',
      permissions: [],
      must_change_password: false,
    } as unknown as UserPublic,
  });
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: Object.assign(new EventTarget(), { startMessages() {} }),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('opening a conversation from a notification', () => {
  test('a window the worker opens lands on the conversation', async () => {
    const opened = new URL(await urlOpenedByWorker('/chat/ws?agent=a1'));
    expect(opened.origin).toBe(window.location.origin);
    window.history.replaceState(null, '', opened.pathname + opened.search);

    const router = createAppRouter(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RouterProvider router={router} />);
    });
    for (
      let i = 0;
      i < 50 && router.state.location.pathname !== '/chat/ws';
      i += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(router.state.location.pathname).toBe('/chat/ws');
    expect(router.state.location.search).toBe('?agent=a1');
    expect(window.location.search).toBe('?agent=a1');
  });
});
