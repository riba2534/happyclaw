/*
 * HappyClaw's Web Push worker. It does two things and nothing else:
 *
 *   push              show the notification, then set the app badge
 *   notificationclick focus an open window on the conversation, or open one
 *
 * It never handles `fetch` and never touches Cache Storage: HappyClaw has no
 * offline mode, and the pages and API always come from the network. The
 * retired Workbox worker at /sw.js stays as it is; it only cleans up.
 *
 * The payload is built by src/web-push.ts (buildPushPayload):
 *   { title, body, tag, path, kind }
 * `path` is an in-app route such as /chat/<workspace>?agent=<session>.
 */

/** Page message asking the app to route to `path`; see utils/webPush.ts. */
const NAVIGATE_MESSAGE = 'happyclaw:navigate';
/** Query parameter a freshly opened window reads its target route from. */
const OPEN_PARAM = 'push_open';

self.addEventListener('install', () => {
  self.skipWaiting();
});

function parsePayload(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const text = (value, fallback) =>
    typeof value === 'string' && value ? value : fallback;
  return {
    title: text(data && data.title, 'HappyClaw'),
    body: text(data && data.body, '收到新消息'),
    tag: text(data && data.tag, 'happyclaw'),
    path: safePath(data && data.path),
  };
}

/** An in-app absolute path, or the chat home. Never another origin. */
function safePath(path) {
  return typeof path === 'string' &&
    path.length <= 512 &&
    /^\/(?!\/)[^\\\s]*$/.test(path)
    ? path
    : '/chat';
}

function iconUrl(name) {
  return new URL('icons/' + name, self.registration.scope).href;
}

/**
 * The app badge counts the notifications still on screen, one per
 * conversation (they share a tag). The page closes them, and clears the
 * badge, when it comes to the front.
 */
async function updateBadge() {
  const nav = self.navigator;
  if (!nav || !nav.setAppBadge) return;
  try {
    const shown = await self.registration.getNotifications();
    if (shown.length > 0) {
      await nav.setAppBadge(shown.length);
    } else if (nav.clearAppBadge) {
      await nav.clearAppBadge();
    }
  } catch {
    // The badge is a convenience; a refusal is not an error.
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePayload(event);
  event.waitUntil(
    (async () => {
      // Every push must show a notification (userVisibleOnly); the server
      // already decided this one is worth showing.
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        renotify: true,
        icon: iconUrl('icon-192.png'),
        badge: iconUrl('icon-96.png'),
        data: { path: payload.path },
      });
      await updateBadge();
    })(),
  );
});

async function openConversation(path) {
  const scope = self.registration.scope;
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing =
    windows.find((client) => client.url.startsWith(scope)) || null;
  if (existing) {
    // The page routes in place, which keeps its live streams. Post first: a
    // frozen page handles the message when it resumes.
    existing.postMessage({ type: NAVIGATE_MESSAGE, path });
    try {
      await existing.focus();
    } catch {
      // Some platforms refuse; the message still reaches the page.
    }
    return;
  }
  // The chat route, not the scope root: the root redirects to /chat and that
  // redirect drops the query (HashRouter on iOS keeps it, BrowserRouter not).
  const target = new URL('chat', scope);
  target.searchParams.set(OPEN_PARAM, path);
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const path = safePath(data && data.path);
  event.waitUntil(openConversation(path).then(updateBadge));
});
