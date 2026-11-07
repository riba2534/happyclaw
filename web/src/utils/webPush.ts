import { api } from '../api/client';
import { isIOSDevice, isStandaloneMode, withBasePath } from './url';

/**
 * Web Push in the page: the push worker (public/push-sw.js), this browser's
 * subscription and the server's record of it. The worker only shows
 * notifications; see src/web-push.ts for when the server sends one.
 */

/** Worker -> page: route to `path` (the page's router, no reload). */
export const PUSH_NAVIGATE_MESSAGE = 'happyclaw:navigate';
/** Query parameter a window opened by a notification reads its route from. */
export const PUSH_OPEN_PARAM = 'push_open';
/** A subscription is re-registered with the server this often. */
export const PUSH_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export type PushSupport = 'supported' | 'needs-install' | 'unsupported';

/**
 * iOS has Web Push only for apps added to the Home Screen: in Safari proper
 * the Push API is absent, which is what `needs-install` reports.
 */
export function getPushSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'unsupported';
  }
  if (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  ) {
    return 'supported';
  }
  return isIOSDevice() && !isStandaloneMode() ? 'needs-install' : 'unsupported';
}

export function pushScriptUrl(): string {
  return new URL(withBasePath('/push-sw.js'), window.location.origin).href;
}

/** VAPID public key (URL-safe base64) -> the bytes `subscribe` takes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// ─── Subscribed on this device ─────────────────────────────────────────

let subscribedHere = false;

/**
 * Whether this browser holds a live push subscription. While it does, a page
 * that goes to the background leaves the notification to the push: showing
 * one from the page as well would be a second banner for the same reply.
 */
export function isPushSubscribed(): boolean {
  return subscribedHere;
}

export function setPushSubscribed(value: boolean): void {
  subscribedHere = value;
}

// ─── Worker registration ───────────────────────────────────────────────

/**
 * The registration running the push worker. A registration of the retired
 * Workbox worker (/sw.js) is not one: it is cleaned up, never reused.
 */
export function isPushRegistration(
  registration: Pick<
    ServiceWorkerRegistration,
    'active' | 'waiting' | 'installing'
  >,
  scriptUrl: string,
): boolean {
  return [
    registration.active,
    registration.waiting,
    registration.installing,
  ].some((worker) => worker?.scriptURL === scriptUrl);
}

export async function findPushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const scriptUrl = pushScriptUrl();
  const registrations = await navigator.serviceWorker.getRegistrations();
  return (
    registrations.find((registration) =>
      isPushRegistration(registration, scriptUrl),
    ) ?? null
  );
}

const ACTIVATION_TIMEOUT_MS = 10_000;

function whenActive(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return Promise.resolve();
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error('push worker missing'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('push worker activation timed out')),
      ACTIVATION_TIMEOUT_MS,
    );
    const check = () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve();
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('push worker was discarded'));
      }
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

/** Register the push worker (idempotent) and wait until it is active. */
export async function ensurePushRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(pushScriptUrl());
  await whenActive(registration);
  return registration;
}

// ─── Whose subscription this is ────────────────────────────────────────

/**
 * The account that opted in with this browser's subscription. A browser is
 * shared by whoever signs in on it: the next account must never inherit a
 * subscription it did not ask for, even when the server has already dropped
 * the row (the session that registered it ended).
 */
const OWNER_KEY = 'happyclaw:push-owner';

function readOwner(): { userId: string; endpoint: string } | null {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(OWNER_KEY) ?? 'null',
    ) as {
      userId?: unknown;
      endpoint?: unknown;
    } | null;
    return typeof parsed?.userId === 'string' &&
      typeof parsed.endpoint === 'string'
      ? { userId: parsed.userId, endpoint: parsed.endpoint }
      : null;
  } catch {
    return null;
  }
}

export function rememberPushOwner(userId: string, endpoint: string): void {
  try {
    window.localStorage.setItem(
      OWNER_KEY,
      JSON.stringify({ userId, endpoint }),
    );
  } catch {
    // Without storage the subscription is dropped at the next check.
  }
}

export function forgetPushOwner(): void {
  try {
    window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // nothing to forget
  }
}

/** Whether `userId` opted in with this subscription in this browser. */
export function ownsPushSubscription(
  userId: string | null | undefined,
  endpoint: string,
): boolean {
  const owner = readOwner();
  return !!userId && owner?.userId === userId && owner.endpoint === endpoint;
}

// ─── Server record ─────────────────────────────────────────────────────

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const { publicKey } = await api.get<{ publicKey: string }>(
      '/api/push/vapid-public-key',
    );
    return publicKey || null;
  } catch {
    return null;
  }
}

export async function registerSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const { endpoint, keys } = subscription.toJSON();
  await api.post('/api/push/subscribe', { endpoint, keys });
}

/**
 * The server refused the subscription because another account registered
 * it (and dropped that account's row): this browser has to unsubscribe.
 */
export function isSubscriptionConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { status?: unknown }).status === 409
  );
}

export async function unregisterSubscription(endpoint: string): Promise<void> {
  await api.post('/api/push/unsubscribe', { endpoint });
}

/** Unsubscribe in this browser only; the server row is not ours to touch. */
export async function dropSubscription(
  subscription: PushSubscription,
): Promise<void> {
  setPushSubscribed(false);
  forgetPushOwner();
  await subscription.unsubscribe().catch(() => false);
}

/**
 * Re-register this browser's existing subscription with the server (it may
 * have restarted or lost the row). Never creates a subscription, never asks
 * for a permission, and never registers the worker. A subscription `userId`
 * did not opt in with here, or one the server says another account holds,
 * is unsubscribed instead. Returns whether this browser is subscribed.
 */
export async function syncExistingSubscription(
  userId: string | null | undefined,
): Promise<boolean> {
  if (getPushSupport() !== 'supported') return false;
  if (Notification.permission !== 'granted') {
    setPushSubscribed(false);
    return false;
  }
  const registration = await findPushRegistration();
  const subscription = registration?.active
    ? await registration.pushManager.getSubscription()
    : null;
  if (!subscription) {
    setPushSubscribed(false);
    return false;
  }
  if (!ownsPushSubscription(userId, subscription.endpoint)) {
    await dropSubscription(subscription);
    return false;
  }
  setPushSubscribed(true);
  try {
    await registerSubscription(subscription);
  } catch (err) {
    if (!isSubscriptionConflict(err)) throw err;
    await dropSubscription(subscription);
    return false;
  }
  return true;
}

const RELEASE_TIMEOUT_MS = 3000;

/**
 * Signing out: remove this browser's subscription from the server and from
 * the push service, so nothing of this account reaches the device any more.
 * Never throws and gives up after a few seconds: signing out must go on.
 */
export async function releasePushSubscription(
  timeoutMs = RELEASE_TIMEOUT_MS,
): Promise<void> {
  const release = async () => {
    if (getPushSupport() !== 'supported') return;
    const registration = await findPushRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await unregisterSubscription(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe().catch(() => false);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      release(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Best effort; the server also drops the row with the session.
  } finally {
    clearTimeout(timer);
    setPushSubscribed(false);
    forgetPushOwner();
  }
}

// ─── Notifications on screen ───────────────────────────────────────────

/**
 * Close the notifications the worker showed. The app is in front, so they
 * are seen; the worker's badge counts what is still on screen.
 */
export async function closeDeliveredPushNotifications(): Promise<void> {
  if (getPushSupport() !== 'supported') return;
  const registration = await findPushRegistration();
  if (!registration) return;
  const shown = await registration.getNotifications();
  for (const notification of shown) notification.close();
}

// ─── Opening a conversation from a notification ────────────────────────

/** An in-app absolute path: not protocol-relative, no other origin. */
export function isSafeAppPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 512 &&
    /^\/(?!\/)[^\\\s]*$/.test(path)
  );
}

/**
 * The route a window opened by a notification asked for (`?push_open=`),
 * and the same URL without that parameter. `path` is null when the value is
 * not an in-app path; the parameter is dropped either way. Null when the
 * URL carries no such parameter.
 */
export function takePushOpenRoute(
  href: string = window.location.href,
): { path: string | null; cleanedHref: string } | null {
  const url = new URL(href);
  const value = url.searchParams.get(PUSH_OPEN_PARAM);
  if (value === null) return null;
  url.searchParams.delete(PUSH_OPEN_PARAM);
  return { path: isSafeAppPath(value) ? value : null, cleanedHref: url.href };
}
