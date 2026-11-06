// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../api/client', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
    get: (...args: unknown[]) => get(...args),
  },
}));

import {
  closeDeliveredPushNotifications,
  findPushRegistration,
  getPushSupport,
  isPushRegistration,
  isPushSubscribed,
  isSafeAppPath,
  pushScriptUrl,
  registerSubscription,
  setPushSubscribed,
  syncExistingSubscription,
  takePushOpenRoute,
  urlBase64ToUint8Array,
} from './webPush';

const SCRIPT = () => pushScriptUrl();

function fakeRegistration(
  scriptURL: string | null,
  subscription: unknown = null,
  notifications: Array<{ close: () => void }> = [],
) {
  return {
    active: scriptURL ? { scriptURL } : null,
    waiting: null,
    installing: null,
    pushManager: { getSubscription: vi.fn(async () => subscription) },
    getNotifications: vi.fn(async () => notifications),
  } as unknown as ServiceWorkerRegistration;
}

function stubBrowser(options: {
  registrations?: ServiceWorkerRegistration[];
  permission?: NotificationPermission;
  pushManager?: boolean;
}) {
  const container = {
    getRegistrations: vi.fn(async () => options.registrations ?? []),
  };
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: container,
    userAgent: 'Mozilla/5.0',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  });
  if (options.pushManager !== false) vi.stubGlobal('PushManager', class {});
  else delete (window as unknown as Record<string, unknown>).PushManager;
  vi.stubGlobal('Notification', {
    permission: options.permission ?? 'default',
  });
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: options.pushManager === false ? undefined : class {},
  });
  if (options.pushManager === false) {
    delete (window as unknown as Record<string, unknown>).PushManager;
  }
  return container;
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  setPushSubscribed(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPushSupport', () => {
  test('supported with the worker, push and notification APIs', () => {
    stubBrowser({});
    expect(getPushSupport()).toBe('supported');
  });

  test('iOS outside a Home Screen app has no Push API: install it first', () => {
    stubBrowser({ pushManager: false });
    vi.stubGlobal('navigator', {
      serviceWorker: {},
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: false,
    });
    expect(getPushSupport()).toBe('needs-install');
  });

  test('iOS Home Screen app without the Push API is unsupported', () => {
    stubBrowser({ pushManager: false });
    vi.stubGlobal('navigator', {
      serviceWorker: {},
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
    });
    expect(getPushSupport()).toBe('unsupported');
  });

  test('a desktop browser without push is unsupported', () => {
    stubBrowser({ pushManager: false });
    expect(getPushSupport()).toBe('unsupported');
  });
});

describe('urlBase64ToUint8Array', () => {
  test('decodes URL-safe base64 without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
    expect(Array.from(urlBase64ToUint8Array('AQI'))).toEqual([1, 2]);
  });
});

describe('isPushRegistration / findPushRegistration', () => {
  test('recognizes the push worker, not the retired Workbox worker', () => {
    const legacy = fakeRegistration(`${window.location.origin}/sw.js`);
    const push = fakeRegistration(SCRIPT());
    expect(isPushRegistration(push, SCRIPT())).toBe(true);
    expect(isPushRegistration(legacy, SCRIPT())).toBe(false);
  });

  test('finds the registration running it among others', async () => {
    const legacy = fakeRegistration(`${window.location.origin}/sw.js`);
    const push = fakeRegistration(SCRIPT());
    stubBrowser({ registrations: [legacy, push] });
    expect(await findPushRegistration()).toBe(push);
    stubBrowser({ registrations: [legacy] });
    expect(await findPushRegistration()).toBeNull();
  });
});

describe('syncExistingSubscription', () => {
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: 'k', auth: 'a' },
    }),
  };

  test('re-registers an existing subscription with the server', async () => {
    stubBrowser({
      permission: 'granted',
      registrations: [fakeRegistration(SCRIPT(), subscription)],
    });
    expect(await syncExistingSubscription()).toBe(true);
    expect(isPushSubscribed()).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/push/subscribe', {
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: 'k', auth: 'a' },
    });
  });

  test('never creates a subscription or asks for a permission', async () => {
    const registration = fakeRegistration(SCRIPT(), null);
    (registration.pushManager as unknown as Record<string, unknown>).subscribe =
      vi.fn();
    stubBrowser({ permission: 'granted', registrations: [registration] });
    expect(await syncExistingSubscription()).toBe(false);
    expect(isPushSubscribed()).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();

    const request = vi.fn();
    stubBrowser({
      permission: 'default',
      registrations: [fakeRegistration(SCRIPT(), subscription)],
    });
    (Notification as unknown as Record<string, unknown>).requestPermission =
      request;
    expect(await syncExistingSubscription()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  test('a revoked permission clears the subscribed flag', async () => {
    setPushSubscribed(true);
    stubBrowser({
      permission: 'denied',
      registrations: [fakeRegistration(SCRIPT(), subscription)],
    });
    expect(await syncExistingSubscription()).toBe(false);
    expect(isPushSubscribed()).toBe(false);
  });

  test('registerSubscription sends the endpoint and keys only', async () => {
    await registerSubscription({
      toJSON: () => ({
        endpoint: 'e',
        keys: { p256dh: 'k', auth: 'a' },
        expirationTime: null,
      }),
    } as unknown as PushSubscription);
    expect(post).toHaveBeenCalledWith('/api/push/subscribe', {
      endpoint: 'e',
      keys: { p256dh: 'k', auth: 'a' },
    });
  });
});

describe('closeDeliveredPushNotifications', () => {
  test('closes what the worker showed', async () => {
    const close = vi.fn();
    stubBrowser({
      registrations: [fakeRegistration(SCRIPT(), null, [{ close }, { close }])],
    });
    await closeDeliveredPushNotifications();
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('does nothing without a push registration', async () => {
    stubBrowser({ registrations: [] });
    await expect(closeDeliveredPushNotifications()).resolves.toBeUndefined();
  });
});

describe('routes from notifications', () => {
  test.each([
    ['/chat', true],
    ['/chat/ws?agent=a1', true],
    ['/settings', true],
    ['//evil.example/x', false],
    ['https://evil.example', false],
    ['chat', false],
    ['/a b', false],
    ['/a\\b', false],
    ['', false],
    [null, false],
    [`/${'x'.repeat(600)}`, false],
  ])('isSafeAppPath(%j) is %s', (value, expected) => {
    expect(isSafeAppPath(value)).toBe(expected);
  });

  test('takePushOpenRoute reads and strips the parameter', () => {
    expect(takePushOpenRoute('https://hc.example/app/')).toBeNull();
    expect(
      takePushOpenRoute(
        'https://hc.example/app/?push_open=%2Fchat%2Fws%3Fagent%3Da1&x=1#/chat',
      ),
    ).toEqual({
      path: '/chat/ws?agent=a1',
      cleanedHref: 'https://hc.example/app/?x=1#/chat',
    });
    // Dropped even when it names another origin.
    expect(
      takePushOpenRoute('https://hc.example/?push_open=%2F%2Fevil.example'),
    ).toEqual({ path: null, cleanedHref: 'https://hc.example/' });
  });
});
