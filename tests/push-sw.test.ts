import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'web/public/push-sw.js'),
  'utf-8',
);

type Listener = (event: any) => void;

interface FakeWindow {
  url: string;
  postMessage: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

/** Run the worker against a fake ServiceWorkerGlobalScope. */
function loadWorker(
  options: { windows?: FakeWindow[]; badge?: boolean; shown?: number } = {},
) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: any }> = [];
  const openWindow = vi.fn(async () => null);
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});
  let onScreen = options.shown ?? 0;
  const scope = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    registration: {
      scope: 'https://hc.example/app/',
      showNotification: vi.fn(async (title: string, opts: any) => {
        shown.push({ title, options: opts });
        onScreen += 1;
      }),
      getNotifications: vi.fn(async () => new Array(onScreen).fill({})),
    },
    clients: {
      matchAll: vi.fn(async () => options.windows ?? []),
      openWindow,
    },
    navigator: options.badge === false ? {} : { setAppBadge, clearAppBadge },
  };
  new Function('self', source)(scope);
  return {
    scope,
    listeners,
    shown,
    openWindow,
    setAppBadge,
    clearAppBadge,
    closeOne: () => (onScreen -= 1),
  };
}

function pushEvent(payload: unknown) {
  const waits: Promise<unknown>[] = [];
  return {
    event: {
      data: {
        json: () => {
          if (payload instanceof Error) throw payload;
          return payload;
        },
      },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    },
    settled: () => Promise.all(waits),
  };
}

function clickEvent(data: unknown) {
  const waits: Promise<unknown>[] = [];
  const close = vi.fn();
  return {
    event: {
      notification: { close, data },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    },
    close,
    settled: () => Promise.all(waits),
  };
}

const PAYLOAD = {
  title: 'WS · Chat',
  body: '回复完成',
  tag: 'conv:web:ws#a1',
  path: '/chat/ws?agent=a1',
  kind: 'reply',
};

describe('push-sw.js', () => {
  test('only listens to install, push and notificationclick', () => {
    const { listeners } = loadWorker();
    expect([...listeners.keys()].sort()).toEqual([
      'install',
      'notificationclick',
      'push',
    ]);
    expect(source).not.toMatch(/\bcaches\b|cache\.put|addAll|['"]fetch['"]/);
    listeners.get('install')!({});
  });

  describe('push', () => {
    let worker: ReturnType<typeof loadWorker>;
    beforeEach(() => {
      worker = loadWorker();
    });

    test('shows the notification, one per conversation tag, with its route', async () => {
      const { event, settled } = pushEvent(PAYLOAD);
      worker.listeners.get('push')!(event);
      await settled();
      expect(worker.shown).toHaveLength(1);
      expect(worker.shown[0].title).toBe('WS · Chat');
      expect(worker.shown[0].options).toMatchObject({
        body: '回复完成',
        tag: 'conv:web:ws#a1',
        renotify: true,
        data: { path: '/chat/ws?agent=a1' },
        icon: 'https://hc.example/app/icons/icon-192.png',
      });
    });

    test('sets the app badge to the notifications on screen', async () => {
      worker = loadWorker({ shown: 2 });
      const { event, settled } = pushEvent(PAYLOAD);
      worker.listeners.get('push')!(event);
      await settled();
      expect(worker.setAppBadge).toHaveBeenCalledWith(3);
    });

    test('still shows a notification for a payload it cannot read', async () => {
      for (const payload of [new Error('not json'), null, { title: 5 }]) {
        worker = loadWorker();
        const { event, settled } = pushEvent(payload);
        worker.listeners.get('push')!(event);
        await settled();
        expect(worker.shown).toHaveLength(1);
        expect(worker.shown[0].title).toBe('HappyClaw');
        expect(worker.shown[0].options.data.path).toBe('/chat');
      }
    });

    test('never carries a route to another origin', async () => {
      for (const path of [
        '//evil.example/x',
        'https://evil.example',
        '/a b',
        '\\x',
        '',
      ]) {
        worker = loadWorker();
        const { event, settled } = pushEvent({ ...PAYLOAD, path });
        worker.listeners.get('push')!(event);
        await settled();
        expect(worker.shown[0].options.data.path, path).toBe('/chat');
      }
    });

    test('works where the badge API is missing', async () => {
      worker = loadWorker({ badge: false });
      const { event, settled } = pushEvent(PAYLOAD);
      worker.listeners.get('push')!(event);
      await expect(settled()).resolves.toBeDefined();
      expect(worker.shown).toHaveLength(1);
    });
  });

  describe('notificationclick', () => {
    const open = (path = '/chat/ws?agent=a1') => ({ path });

    test('routes an open window in place and focuses it', async () => {
      const win: FakeWindow = {
        url: 'https://hc.example/app/chat/other',
        postMessage: vi.fn(),
        focus: vi.fn(async () => {}),
      };
      const worker = loadWorker({ windows: [win] });
      const { event, close, settled } = clickEvent(open());
      worker.listeners.get('notificationclick')!(event);
      await settled();
      expect(close).toHaveBeenCalled();
      expect(win.postMessage).toHaveBeenCalledWith({
        type: 'happyclaw:navigate',
        path: '/chat/ws?agent=a1',
      });
      expect(win.focus).toHaveBeenCalled();
      expect(worker.openWindow).not.toHaveBeenCalled();
    });

    test('ignores windows outside its scope', async () => {
      const win: FakeWindow = {
        url: 'https://hc.example/other-app/',
        postMessage: vi.fn(),
        focus: vi.fn(async () => {}),
      };
      const worker = loadWorker({ windows: [win] });
      const { event, settled } = clickEvent(open());
      worker.listeners.get('notificationclick')!(event);
      await settled();
      expect(win.postMessage).not.toHaveBeenCalled();
      expect(worker.openWindow).toHaveBeenCalledTimes(1);
    });

    test('opens a window carrying the route when none is open', async () => {
      const worker = loadWorker();
      const { event, settled } = clickEvent(open());
      worker.listeners.get('notificationclick')!(event);
      await settled();
      expect(worker.openWindow).toHaveBeenCalledTimes(1);
      const url = new URL(
        (worker.openWindow.mock.calls[0] as unknown[])[0] as string,
      );
      // The chat route itself: the root's redirect would drop the query.
      expect(url.origin + url.pathname).toBe('https://hc.example/app/chat');
      expect(url.searchParams.get('push_open')).toBe('/chat/ws?agent=a1');
    });

    test('a window that refuses focus still gets the route', async () => {
      const win: FakeWindow = {
        url: 'https://hc.example/app/',
        postMessage: vi.fn(),
        focus: vi.fn(async () => {
          throw new Error('refused');
        }),
      };
      const worker = loadWorker({ windows: [win] });
      const { event, settled } = clickEvent(open());
      worker.listeners.get('notificationclick')!(event);
      await expect(settled()).resolves.toBeDefined();
      expect(win.postMessage).toHaveBeenCalled();
    });

    test('a click without a usable route goes to the chat home', async () => {
      const worker = loadWorker();
      const { event, settled } = clickEvent(undefined);
      worker.listeners.get('notificationclick')!(event);
      await settled();
      const url = new URL(
        (worker.openWindow.mock.calls[0] as unknown[])[0] as string,
      );
      expect(url.searchParams.get('push_open')).toBe('/chat');
    });

    test('updates the badge after the notification closed', async () => {
      const worker = loadWorker({ shown: 1 });
      const { event, settled } = clickEvent(open());
      // The click closes its notification before the badge is counted.
      event.notification.close = vi.fn(() => worker.closeOne());
      worker.listeners.get('notificationclick')!(event);
      await settled();
      expect(worker.clearAppBadge).toHaveBeenCalled();
      expect(worker.setAppBadge).not.toHaveBeenCalled();
    });
  });
});
