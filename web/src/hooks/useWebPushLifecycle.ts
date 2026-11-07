import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { wsManager } from '../api/ws';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import { syncAppBadge } from '../utils/appBadge';
import {
  PUSH_NAVIGATE_MESSAGE,
  PUSH_SYNC_INTERVAL_MS,
  closeDeliveredPushNotifications,
  getPushSupport,
  isSafeAppPath,
  syncExistingSubscription,
  takePushOpenRoute,
} from '../utils/webPush';

/** While visible, a page repeats its presence this often (server TTL: 60 s). */
export const PRESENCE_REFRESH_MS = 25_000;

export interface PresenceInput {
  visible: boolean;
  pathname: string;
  currentGroup: string | null;
  agentId: string | null;
}

/**
 * What the page tells the server about itself. The server holds back a push
 * for a conversation a visible page has open, so the conversation counts only
 * on the chat route: the store keeps `currentGroup` after leaving it.
 */
export function computePresence(input: PresenceInput) {
  const onChat = input.pathname.startsWith('/chat') && !!input.currentGroup;
  return {
    type: 'presence' as const,
    visible: input.visible,
    chatJid: onChat ? input.currentGroup : null,
    agentId: onChat ? input.agentId : null,
  };
}

function totalUnread(): number {
  return Object.values(useChatStore.getState().unreadReplies).reduce(
    (sum, n) => sum + n,
    0,
  );
}

/**
 * Everything the signed-in shell does for Web Push, none of which asks for a
 * permission or registers the worker (Settings does that, on a tap):
 *
 *  - presence: tells the server whether this page is visible and which
 *    conversation it shows, so a reply you are reading is not also pushed;
 *  - keeps this browser's existing subscription registered with the server;
 *  - on coming to the front, closes the notifications the worker showed and
 *    re-applies the in-page unread count to the app badge (the worker sets
 *    the badge while the app is closed);
 *  - routes in place when a notification is tapped, whether the worker posts
 *    a message to this page or opened it with `?push_open=`.
 */
export function useWebPushLifecycle({ enabled }: { enabled: boolean }): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const currentGroup = useChatStore((s) => s.currentGroup);
  const agentId = useChatStore((s) =>
    s.currentGroup ? (s.activeAgentTab[s.currentGroup] ?? null) : null,
  );

  const latest = useRef({ pathname, currentGroup, agentId, navigate });
  latest.current = { pathname, currentGroup, agentId, navigate };

  const sendPresence = useRef(() => {
    const { pathname, currentGroup, agentId } = latest.current;
    wsManager.send(
      computePresence({
        visible: document.visibilityState === 'visible',
        pathname,
        currentGroup,
        agentId,
      }),
    );
  }).current;

  // Presence: on every change of what is shown …
  useEffect(() => {
    if (enabled) sendPresence();
  }, [enabled, pathname, currentGroup, agentId, sendPresence]);

  // … of whether it is visible, on a new socket, and while visible.
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = wsManager.on('connected', sendPresence);
    document.addEventListener('visibilitychange', sendPresence);
    window.addEventListener('pageshow', sendPresence);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') sendPresence();
    }, PRESENCE_REFRESH_MS);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', sendPresence);
      window.removeEventListener('pageshow', sendPresence);
      window.clearInterval(timer);
    };
  }, [enabled, sendPresence]);

  // The subscription, and the notifications on screen.
  useEffect(() => {
    if (!enabled || getPushSupport() !== 'supported') return;
    const sync = () => {
      void syncExistingSubscription(useAuthStore.getState().user?.id).catch(
        () => {},
      );
    };
    const comeToFront = () => {
      if (document.visibilityState !== 'visible') return;
      sync();
      void closeDeliveredPushNotifications()
        .then(() => syncAppBadge(totalUnread()))
        .catch(() => {});
    };
    comeToFront();
    document.addEventListener('visibilitychange', comeToFront);
    window.addEventListener('pageshow', comeToFront);
    window.addEventListener('online', sync);
    const timer = window.setInterval(sync, PUSH_SYNC_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', comeToFront);
      window.removeEventListener('pageshow', comeToFront);
      window.removeEventListener('online', sync);
      window.clearInterval(timer);
    };
  }, [enabled]);

  // A tapped notification.
  useEffect(() => {
    if (!enabled) return;
    const opened = takePushOpenRoute();
    if (opened) {
      window.history.replaceState(window.history.state, '', opened.cleanedHref);
      if (opened.path) latest.current.navigate(opened.path, { replace: true });
    }
    if (!('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type === PUSH_NAVIGATE_MESSAGE && isSafeAppPath(data.path)) {
        latest.current.navigate(data.path);
      }
    };
    container.addEventListener('message', onMessage);
    // addEventListener does not start the message queue by itself.
    container.startMessages?.();
    return () => container.removeEventListener('message', onMessage);
  }, [enabled]);
}
