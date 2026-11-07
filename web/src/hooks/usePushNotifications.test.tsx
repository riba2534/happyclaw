// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  support: 'supported' as 'supported' | 'needs-install' | 'unsupported',
  fetchVapidPublicKey: vi.fn(),
  ensurePushRegistration: vi.fn(),
  registerSubscription: vi.fn(),
  unregisterSubscription: vi.fn(),
  post: vi.fn(),
  userId: 'alice' as string | undefined,
}));

vi.mock('../utils/webPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/webPush')>()),
  getPushSupport: () => mocks.support,
  fetchVapidPublicKey: mocks.fetchVapidPublicKey,
  ensurePushRegistration: mocks.ensurePushRegistration,
  registerSubscription: mocks.registerSubscription,
  unregisterSubscription: mocks.unregisterSubscription,
}));
vi.mock('../api/client', () => ({ api: { post: mocks.post } }));
vi.mock('../stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
  },
}));

import {
  usePushNotifications,
  type PushNotificationsApi,
} from './usePushNotifications';
import {
  forgetPushOwner,
  isPushSubscribed,
  ownsPushSubscription,
  rememberPushOwner,
  setPushSubscribed,
} from '../utils/webPush';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let current: PushNotificationsApi;

function Probe() {
  current = usePushNotifications();
  return null;
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await flush();
}

function pushManager(subscription: unknown = null) {
  return {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => subscription ?? makeSubscription()),
  };
}

function makeSubscription() {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({}),
    unsubscribe: vi.fn(async () => true),
  };
}

function stubNotification(
  permission: NotificationPermission,
  requestPermission = vi.fn(async () => permission),
) {
  const stub = { permission, requestPermission };
  vi.stubGlobal('Notification', stub);
  return stub;
}

beforeEach(() => {
  mocks.support = 'supported';
  mocks.fetchVapidPublicKey.mockReset().mockResolvedValue('AQID');
  mocks.registerSubscription.mockReset().mockResolvedValue(undefined);
  mocks.unregisterSubscription.mockReset().mockResolvedValue(undefined);
  mocks.ensurePushRegistration.mockReset();
  mocks.post.mockReset();
  mocks.userId = 'alice';
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  forgetPushOwner();
  setPushSubscribed(false);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe('usePushNotifications', () => {
  test('reports a browser without push, and iOS outside the Home Screen', async () => {
    stubNotification('default');
    mocks.support = 'unsupported';
    await mount();
    expect(current.status).toBe('unsupported');
    expect(mocks.ensurePushRegistration).not.toHaveBeenCalled();

    act(() => root?.unmount());
    mocks.support = 'needs-install';
    await mount();
    expect(current.status).toBe('needs-install');
  });

  test('opening Settings asks for no permission and is off until enabled', async () => {
    const notification = stubNotification('default');
    const manager = pushManager();
    mocks.ensurePushRegistration.mockResolvedValue({ pushManager: manager });
    await mount();
    expect(current.status).toBe('off');
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(mocks.registerSubscription).not.toHaveBeenCalled();
  });

  test('is unavailable when the server has no push identity', async () => {
    stubNotification('default');
    mocks.fetchVapidPublicKey.mockResolvedValue(null);
    await mount();
    expect(current.status).toBe('unavailable');
    expect(mocks.ensurePushRegistration).not.toHaveBeenCalled();
  });

  test('shows a denied permission, and an existing subscription as on', async () => {
    stubNotification('denied');
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(),
    });
    await mount();
    expect(current.status).toBe('denied');

    act(() => root?.unmount());
    stubNotification('granted');
    rememberPushOwner('alice', ENDPOINT);
    const subscription = makeSubscription();
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(subscription),
    });
    await mount();
    expect(current.status).toBe('on');
    expect(isPushSubscribed()).toBe(true);
    expect(mocks.registerSubscription).toHaveBeenCalledWith(subscription);
  });

  test("another account's subscription in this browser is dropped, not shown as on", async () => {
    stubNotification('granted');
    rememberPushOwner('bob', ENDPOINT);
    const subscription = makeSubscription();
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(subscription),
    });
    await mount();
    expect(current.status).toBe('off');
    expect(isPushSubscribed()).toBe(false);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.registerSubscription).not.toHaveBeenCalled();
  });

  test('a subscription the server says another account holds is dropped', async () => {
    stubNotification('granted');
    rememberPushOwner('alice', ENDPOINT);
    const subscription = makeSubscription();
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(subscription),
    });
    mocks.registerSubscription.mockRejectedValueOnce({
      status: 409,
      message: 'conflict',
    });
    await mount();
    expect(current.status).toBe('off');
    expect(isPushSubscribed()).toBe(false);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(ownsPushSubscription('alice', ENDPOINT)).toBe(false);
  });

  test('enable subscribes synchronously inside the tap, before any await', async () => {
    stubNotification('default');
    const manager = pushManager();
    mocks.ensurePushRegistration.mockResolvedValue({ pushManager: manager });
    await mount();

    let pending!: Promise<void>;
    act(() => {
      pending = current.enable();
    });
    // iOS ends the user gesture at the first await: subscribe must already
    // have been called in this very tick.
    expect(manager.subscribe).toHaveBeenCalledTimes(1);
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    await act(async () => {
      await pending;
    });
    expect(mocks.registerSubscription).toHaveBeenCalledTimes(1);
    expect(current.status).toBe('on');
    expect(current.error).toBeNull();
    expect(isPushSubscribed()).toBe(true);
    // This browser now knows whose subscription it holds.
    expect(ownsPushSubscription('alice', ENDPOINT)).toBe(true);
  });

  test('enable with an endpoint another account holds asks to opt in again', async () => {
    stubNotification('granted');
    const subscription = makeSubscription();
    const manager = pushManager();
    manager.subscribe.mockResolvedValue(subscription);
    mocks.ensurePushRegistration.mockResolvedValue({ pushManager: manager });
    await mount();
    mocks.registerSubscription.mockRejectedValueOnce({
      status: 409,
      message: 'conflict',
    });
    await act(async () => {
      await current.enable();
    });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(current.status).toBe('off');
    expect(current.error).toMatch(/另一个账号/);
    expect(isPushSubscribed()).toBe(false);
    expect(ownsPushSubscription('alice', ENDPOINT)).toBe(false);
  });

  test('a denied prompt ends as denied; another failure is reported', async () => {
    const notification = stubNotification('default');
    const manager = pushManager();
    mocks.ensurePushRegistration.mockResolvedValue({ pushManager: manager });
    await mount();

    manager.subscribe.mockImplementationOnce(async () => {
      notification.permission = 'denied';
      throw new Error('NotAllowedError');
    });
    await act(async () => {
      await current.enable();
    });
    expect(current.status).toBe('denied');
    expect(mocks.registerSubscription).not.toHaveBeenCalled();

    notification.permission = 'granted';
    manager.subscribe.mockRejectedValueOnce(new Error('push service error'));
    await act(async () => {
      await current.enable();
    });
    expect(current.error).toBe('push service error');
    expect(current.status).not.toBe('on');
  });

  test('a browser that wants the permission requested first gets it, then subscribes', async () => {
    const notification = stubNotification(
      'default',
      vi.fn(async () => 'granted' as NotificationPermission),
    );
    const manager = pushManager();
    mocks.ensurePushRegistration.mockResolvedValue({ pushManager: manager });
    await mount();

    manager.subscribe.mockRejectedValueOnce(new Error('NotAllowedError'));
    await act(async () => {
      await current.enable();
    });
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(manager.subscribe).toHaveBeenCalledTimes(2);
    expect(current.status).toBe('on');
  });

  test('disable removes the server record and the browser subscription', async () => {
    stubNotification('granted');
    rememberPushOwner('alice', ENDPOINT);
    const subscription = makeSubscription();
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(subscription),
    });
    await mount();
    expect(current.status).toBe('on');

    await act(async () => {
      await current.disable();
    });
    expect(mocks.unregisterSubscription).toHaveBeenCalledWith(
      subscription.endpoint,
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(current.status).toBe('off');
    expect(isPushSubscribed()).toBe(false);
    expect(current.error).toBeNull();
    expect(ownsPushSubscription('alice', ENDPOINT)).toBe(false);
  });

  test('disable still turns it off here when the server cannot be reached', async () => {
    stubNotification('granted');
    rememberPushOwner('alice', ENDPOINT);
    const subscription = makeSubscription();
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(subscription),
    });
    await mount();
    mocks.unregisterSubscription.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await current.disable();
    });
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(current.status).toBe('off');
    expect(current.error).toMatch(/已在本机关闭/);
  });

  test('sendTest reports whether a notification went out', async () => {
    stubNotification('granted');
    mocks.ensurePushRegistration.mockResolvedValue({
      pushManager: pushManager(makeSubscription()),
    });
    await mount();

    mocks.post.mockResolvedValueOnce({ success: true });
    await act(async () => {
      await current.sendTest();
    });
    expect(mocks.post).toHaveBeenCalledWith('/api/push/test');
    expect(current.testResult).toBe('sent');

    mocks.post.mockResolvedValueOnce({ success: false });
    await act(async () => {
      await current.sendTest();
    });
    expect(current.testResult).toBe('failed');
  });
});
