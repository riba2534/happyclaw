// @vitest-environment happy-dom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    send: vi.fn(() => true),
    syncExisting: vi.fn(async () => true),
    closeDelivered: vi.fn(async () => {}),
    syncAppBadge: vi.fn(),
    store: null as null | {
      (selector: (s: any) => unknown): unknown;
      getState: () => any;
      setState: (partial: any) => void;
    },
  };
});

vi.mock('../api/ws', () => ({
  wsManager: {
    send: mocks.send,
    on: (type: string, handler: () => void) => {
      if (!mocks.handlers.has(type)) mocks.handlers.set(type, new Set());
      mocks.handlers.get(type)!.add(handler);
      return () => mocks.handlers.get(type)!.delete(handler);
    },
  },
}));
vi.mock('../stores/chat', async () => {
  const { create } = await import('zustand');
  const useChatStore = create(() => ({
    currentGroup: null as string | null,
    activeAgentTab: {} as Record<string, string>,
    unreadReplies: {} as Record<string, number>,
  }));
  mocks.store = useChatStore as never;
  return { useChatStore };
});
vi.mock('../utils/appBadge', () => ({ syncAppBadge: mocks.syncAppBadge }));
vi.mock('../stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'alice' } }) },
}));
vi.mock('../utils/webPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/webPush')>()),
  getPushSupport: () => 'supported',
  syncExistingSubscription: mocks.syncExisting,
  closeDeliveredPushNotifications: mocks.closeDelivered,
}));

import {
  PRESENCE_REFRESH_MS,
  computePresence,
  useWebPushLifecycle,
} from './useWebPushLifecycle';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let location!: ReturnType<typeof useLocation>;
let worker: EventTarget & { startMessages: () => void };

function Probe({
  enabled,
  children,
}: {
  enabled: boolean;
  children?: ReactNode;
}) {
  useWebPushLifecycle({ enabled });
  location = useLocation();
  return <>{children}</>;
}

/** A page whose effect replaces the URL first, as route restore can. */
function ReplacesUrlFirst() {
  useEffect(() => {
    window.history.replaceState(null, '', '/chat/restored');
  }, []);
  return null;
}

async function mount(entry = '/chat/ws', enabled = true, children?: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <Probe enabled={enabled}>{children}</Probe>
      </MemoryRouter>,
    );
  });
}

const presenceSent = () =>
  mocks.send.mock.calls
    .map((call) => (call as unknown[])[0] as { type: string })
    .filter((message) => message.type === 'presence');

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  mocks.send.mockClear();
  mocks.syncExisting.mockClear();
  mocks.closeDelivered.mockClear();
  mocks.syncAppBadge.mockClear();
  mocks.handlers.clear();
  mocks.store!.setState({
    currentGroup: 'web:ws',
    activeAgentTab: { 'web:ws': 'a1' },
    unreadReplies: {},
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  worker = Object.assign(new EventTarget(), { startMessages: vi.fn() });
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: worker });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('computePresence', () => {
  test('names the open conversation only on the chat route', () => {
    const base = { visible: true, currentGroup: 'web:ws', agentId: 'a1' };
    expect(computePresence({ ...base, pathname: '/chat/ws' })).toEqual({
      type: 'presence',
      visible: true,
      chatJid: 'web:ws',
      agentId: 'a1',
    });
    // The store keeps the workspace after leaving the chat page.
    expect(computePresence({ ...base, pathname: '/settings' })).toMatchObject({
      chatJid: null,
      agentId: null,
    });
    expect(
      computePresence({ ...base, pathname: '/chat', currentGroup: null }),
    ).toMatchObject({ chatJid: null, agentId: null });
    expect(
      computePresence({ ...base, pathname: '/chat/ws', visible: false }),
    ).toMatchObject({ visible: false });
  });
});

describe('presence', () => {
  test('is reported on mount, with the open conversation', async () => {
    await mount('/chat/ws');
    expect(presenceSent().at(-1)).toEqual({
      type: 'presence',
      visible: true,
      chatJid: 'web:ws',
      agentId: 'a1',
    });
  });

  test('follows the open session and the route', async () => {
    await mount('/chat/ws');
    await act(async () => {
      mocks.store!.setState({ activeAgentTab: { 'web:ws': 'a2' } });
    });
    expect(presenceSent().at(-1)).toMatchObject({
      chatJid: 'web:ws',
      agentId: 'a2',
    });
  });

  test('says nowhere off the chat route', async () => {
    await mount('/settings');
    expect(presenceSent().at(-1)).toMatchObject({
      visible: true,
      chatJid: null,
      agentId: null,
    });
  });

  test('goes hidden with the page, and is repeated while visible', async () => {
    vi.useFakeTimers();
    await mount('/chat/ws');
    mocks.send.mockClear();

    act(() => setVisibility('hidden'));
    expect(presenceSent().at(-1)).toMatchObject({ visible: false });

    mocks.send.mockClear();
    act(() => void vi.advanceTimersByTime(PRESENCE_REFRESH_MS * 2));
    expect(presenceSent()).toHaveLength(0);

    act(() => setVisibility('visible'));
    mocks.send.mockClear();
    act(() => void vi.advanceTimersByTime(PRESENCE_REFRESH_MS));
    expect(presenceSent()).toHaveLength(1);
    expect(presenceSent()[0]).toMatchObject({ visible: true });
  });

  test('is sent again on a new socket', async () => {
    await mount('/chat/ws');
    mocks.send.mockClear();
    act(() => mocks.handlers.get('connected')?.forEach((handler) => handler()));
    expect(presenceSent()).toHaveLength(1);
  });

  test('a guest page reports nothing and syncs nothing', async () => {
    await mount('/chat/ws', false);
    act(() => setVisibility('visible'));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.syncExisting).not.toHaveBeenCalled();
    expect(worker.startMessages).not.toHaveBeenCalled();
  });
});

describe('coming to the front', () => {
  test('re-registers the subscription, closes notifications and fixes the badge', async () => {
    mocks.store!.setState({ unreadReplies: { 'web:ws': 2, 'web:other': 1 } });
    await mount('/chat/ws');
    await act(async () => {});
    expect(mocks.syncExisting).toHaveBeenCalledTimes(1);
    // Only a subscription this account opted in with is kept.
    expect(mocks.syncExisting).toHaveBeenCalledWith('alice');
    expect(mocks.closeDelivered).toHaveBeenCalledTimes(1);
    // After the worker's badge, the in-page unread count is the badge again.
    expect(mocks.syncAppBadge).toHaveBeenLastCalledWith(3);

    act(() => setVisibility('hidden'));
    expect(mocks.syncExisting).toHaveBeenCalledTimes(1);
    mocks.syncAppBadge.mockClear();
    mocks.store!.setState({ unreadReplies: {} });
    await act(async () => setVisibility('visible'));
    expect(mocks.syncExisting).toHaveBeenCalledTimes(2);
    expect(mocks.closeDelivered).toHaveBeenCalledTimes(2);
    expect(mocks.syncAppBadge).toHaveBeenLastCalledWith(0);
  });
});

describe('a tapped notification', () => {
  const post = (data: unknown) =>
    act(
      () =>
        void worker.dispatchEvent(
          Object.assign(new Event('message'), { data }),
        ),
    );

  test("the worker's message routes in place", async () => {
    await mount('/chat/ws');
    expect(worker.startMessages).toHaveBeenCalled();
    post({ type: 'happyclaw:navigate', path: '/chat/other?agent=a9' });
    expect(location.pathname).toBe('/chat/other');
    expect(location.search).toBe('?agent=a9');
  });

  test.each([
    { type: 'happyclaw:navigate', path: '//evil.example' },
    { type: 'happyclaw:navigate', path: 'https://evil.example' },
    { type: 'happyclaw:navigate' },
    { type: 'something-else', path: '/settings' },
    null,
  ])('ignores %j', async (data) => {
    await mount('/chat/ws');
    post(data);
    expect(location.pathname).toBe('/chat/ws');
  });

  test('a window opened by one reads ?push_open= once and cleans the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/?push_open=%2Fchat%2Fws%3Fagent%3Da1&keep=1',
    );
    await mount('/chat');
    expect(location.pathname).toBe('/chat/ws');
    expect(location.search).toBe('?agent=a1');
    expect(window.location.search).toBe('?keep=1');
  });

  test('?push_open= is read before an effect below can replace the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/chat?push_open=%2Fchat%2Fws%3Fagent%3Da1',
    );
    await mount('/chat', true, <ReplacesUrlFirst />);
    expect(location.pathname).toBe('/chat/ws');
    expect(location.search).toBe('?agent=a1');
  });

  test('an unsafe ?push_open= is dropped without routing', async () => {
    window.history.replaceState(null, '', '/?push_open=%2F%2Fevil.example');
    await mount('/chat');
    expect(location.pathname).toBe('/chat');
    expect(window.location.search).toBe('');
  });
});
