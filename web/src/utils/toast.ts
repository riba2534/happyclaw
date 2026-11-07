import { toast } from 'sonner';
import { isPushSubscribed } from './webPush';

const BACKGROUND_TASK_NOTICE_TTL_MS = 15_000;
const OWNER_KEY = 'happyclaw:bg-task-notice-owner';
const OWNER_STALE_MS = 120_000;
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let ownerTrackingBound = false;
let lastBackgroundTaskNotice: { taskId: string; at: number } | null = null;

const BODY_MAX_CHARS = 120;
/** Set once a page-constructed Notification has thrown (Android Chrome). */
let pageNotificationsUnsupported = false;

/** Shows a notice through the app's sonner Toaster. */
export function showToast(
  title: string,
  body?: string,
  durationMs = 5000,
  link?: { text: string; url: string },
): void {
  toast(title, {
    description:
      body && body.length > BODY_MAX_CHARS
        ? body.slice(0, BODY_MAX_CHARS) + '…'
        : body,
    duration: durationMs,
    action: link && {
      label: link.text,
      onClick: () => window.open(link.url, '_blank', 'noopener,noreferrer'),
    },
  });
}

export interface PageNotificationOptions {
  /**
   * The server sends this event as a Web Push (a reply announced with
   * `web_push`). Only then does a subscribed device leave it to the push;
   * everything else the server does not push still notifies from the page.
   */
  pushCovered?: boolean;
}

/**
 * Send a browser Notification when the page is in the background.
 * Only fires if permission was already granted — never prompts the user
 * from a passive event handler. Permission should be requested via a
 * user-initiated action (e.g. a settings toggle).
 */
export function notifyIfHidden(
  title: string,
  body?: string,
  options: PageNotificationOptions = {},
): void {
  if (!document.hidden) return;
  // This device is subscribed to Web Push and the server pushes this event:
  // a second notification from the page would repeat it.
  if (options.pushCovered && isPushSubscribed()) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    // Android Chrome only allows notifications from a service worker and
    // throws "Illegal constructor" here; callers go on to update state, and
    // the page stops offering a permission it cannot use.
    pageNotificationsUnsupported = true;
  }
}

function claimOwnershipIfVisible(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return true;
  if (document.visibilityState !== 'visible') return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus())
    return false;
  try {
    window.localStorage.setItem(
      OWNER_KEY,
      JSON.stringify({ tabId: TAB_ID, at: Date.now() }),
    );
  } catch {
    // Fall back to single-tab behavior if storage becomes unavailable mid-session.
  }
  return true;
}

function bindOwnerTracking(): void {
  if (
    ownerTrackingBound ||
    typeof window === 'undefined' ||
    typeof document === 'undefined'
  )
    return;
  ownerTrackingBound = true;

  claimOwnershipIfVisible();
  window.addEventListener('focus', claimOwnershipIfVisible);
  document.addEventListener('visibilitychange', claimOwnershipIfVisible);
}

function isNoticeOwner(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return true;
  bindOwnerTracking();

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(OWNER_KEY);
  } catch {
    return true;
  }
  if (!raw) return claimOwnershipIfVisible();

  try {
    const parsed = JSON.parse(raw) as { tabId?: unknown; at?: unknown };
    const ownerTabId = typeof parsed.tabId === 'string' ? parsed.tabId : '';
    const ownerAt = typeof parsed.at === 'number' ? parsed.at : 0;
    if (!ownerTabId) return claimOwnershipIfVisible();
    if (Date.now() - ownerAt > OWNER_STALE_MS) {
      return claimOwnershipIfVisible();
    }
    return ownerTabId === TAB_ID;
  } catch {
    return claimOwnershipIfVisible();
  }
}

/** One-time prompt to request desktop notification permission. */
let notificationPromptShown = false;

export function showNotificationPromptToast(): void {
  if (notificationPromptShown || pageNotificationsUnsupported) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  notificationPromptShown = true;

  toast('开启桌面通知，对话完成时提醒你', {
    duration: 12000,
    action: {
      label: '开启',
      onClick: () => void Notification.requestPermission(),
    },
  });
}

export function shouldEmitBackgroundTaskNotice(taskId: string): boolean {
  const now = Date.now();
  if (
    lastBackgroundTaskNotice &&
    lastBackgroundTaskNotice.taskId === taskId &&
    now - lastBackgroundTaskNotice.at < BACKGROUND_TASK_NOTICE_TTL_MS
  ) {
    return false;
  }

  if (!isNoticeOwner()) return false;

  lastBackgroundTaskNotice = { taskId, at: now };
  return true;
}
