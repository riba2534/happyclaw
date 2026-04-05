/** Lightweight toast notification — no external dependencies. */

const MAX_TOASTS = 5;
let container: HTMLDivElement | null = null;
const BACKGROUND_TASK_NOTICE_TTL_MS = 15_000;
const OWNER_KEY = 'happyclaw:bg-task-notice-owner';
const OWNER_STALE_MS = 120_000;
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let ownerTrackingBound = false;
let lastBackgroundTaskNotice: { taskId: string; at: number } | null = null;

function getContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
  document.body.appendChild(container);
  return container;
}

export function showToast(
  title: string,
  body?: string,
  durationMs = 5000,
  link?: { text: string; url: string },
): void {
  const c = getContainer();

  // Evict oldest toasts when at capacity
  while (c.childElementCount >= MAX_TOASTS && c.firstChild) {
    c.removeChild(c.firstChild);
  }

  const el = document.createElement('div');
  el.style.cssText =
    'pointer-events:auto;max-width:360px;padding:12px 16px;border-radius:8px;' +
    'background:#1a1a2e;color:#e0e0e0;box-shadow:0 4px 12px rgba(0,0,0,0.3);' +
    'font-size:14px;line-height:1.4;opacity:0;transform:translateX(40px);' +
    'transition:opacity 0.3s,transform 0.3s;';

  const titleEl = document.createElement('div');
  titleEl.style.fontWeight = '600';
  titleEl.textContent = title;
  el.appendChild(titleEl);

  if (body) {
    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'margin-top:4px;font-size:13px;opacity:0.85;';
    bodyEl.textContent = body.length > 120 ? body.slice(0, 120) + '…' : body;
    el.appendChild(bodyEl);
  }

  if (link) {
    const linkEl = document.createElement('a');
    linkEl.href = link.url;
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
    linkEl.textContent = link.text;
    linkEl.style.cssText =
      'display:inline-block;margin-top:6px;font-size:13px;color:#5eead4;' +
      'text-decoration:underline;cursor:pointer;';
    el.appendChild(linkEl);
  }

  c.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(0)';
  });

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(40px)';
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

/**
 * Send a browser Notification when the page is in the background.
 * Only fires if permission was already granted — never prompts the user
 * from a passive event handler. Permission should be requested via a
 * user-initiated action (e.g. a settings toggle).
 */
export function notifyIfHidden(title: string, body?: string): void {
  if (!document.hidden) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

function claimOwnershipIfVisible(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  try {
    window.localStorage.setItem(OWNER_KEY, JSON.stringify({ tabId: TAB_ID, at: Date.now() }));
  } catch {
    // Fall back to single-tab behavior if storage becomes unavailable mid-session.
  }
  return true;
}

function bindOwnerTracking(): void {
  if (ownerTrackingBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  ownerTrackingBound = true;

  claimOwnershipIfVisible();
  window.addEventListener('focus', claimOwnershipIfVisible);
  document.addEventListener('visibilitychange', claimOwnershipIfVisible);
}

function isNoticeOwner(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
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
  if (notificationPromptShown) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  notificationPromptShown = true;

  const c = getContainer();
  while (c.childElementCount >= MAX_TOASTS && c.firstChild) {
    c.removeChild(c.firstChild);
  }

  const el = document.createElement('div');
  el.style.cssText =
    'pointer-events:auto;max-width:360px;padding:12px 16px;border-radius:8px;' +
    'background:#1a1a2e;color:#e0e0e0;box-shadow:0 4px 12px rgba(0,0,0,0.3);' +
    'font-size:14px;line-height:1.4;opacity:0;transform:translateX(40px);' +
    'transition:opacity 0.3s,transform 0.3s;display:flex;align-items:center;gap:12px;';

  const textEl = document.createElement('span');
  textEl.style.flex = '1';
  textEl.textContent = '开启桌面通知，对话完成时提醒你';
  el.appendChild(textEl);

  const btn = document.createElement('button');
  btn.textContent = '开启';
  btn.style.cssText =
    'flex-shrink:0;padding:4px 10px;border-radius:5px;border:none;' +
    'background:#5eead4;color:#0f172a;font-size:13px;font-weight:600;cursor:pointer;';
  btn.addEventListener('click', () => {
    Notification.requestPermission();
    el.style.opacity = '0';
    el.style.transform = 'translateX(40px)';
    setTimeout(() => el.remove(), 300);
  });
  el.appendChild(btn);

  c.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(0)';
  });

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(40px)';
    setTimeout(() => el.remove(), 300);
  }, 12000);
}

export function shouldEmitBackgroundTaskNotice(taskId: string): boolean {
  const now = Date.now();
  if (
    lastBackgroundTaskNotice
    && lastBackgroundTaskNotice.taskId === taskId
    && now - lastBackgroundTaskNotice.at < BACKGROUND_TASK_NOTICE_TTL_MS
  ) {
    return false;
  }

  if (!isNoticeOwner()) return false;

  lastBackgroundTaskNotice = { taskId, at: now };
  return true;
}
