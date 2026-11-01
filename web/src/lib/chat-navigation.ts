import { useChatStore } from '../stores/chat';
import { useShellStore } from '../stores/shell';

/**
 * A workspace's chat route: with a session it opens that session, without
 * one it enters the workspace (ChatView opens the session last opened there,
 * else the most recently active one).
 */
export function chatHref(folder: string, sessionId?: string | null): string {
  const base = `/chat/${folder}`;
  return sessionId ? `${base}?agent=${encodeURIComponent(sessionId)}` : base;
}

/** Navigation to an app path; a router `navigate` or a stable wrapper of it. */
export type NavigateToPath = (
  to: string,
  options?: { replace?: boolean },
) => unknown;

/**
 * Enter a workspace (the sidebar row or ⌘K): expand it in the sidebar and
 * let ChatView pick its session.
 */
export function enterWorkspace(
  navigate: NavigateToPath,
  group: { jid: string; folder: string },
) {
  useShellStore.getState().revealWorkspace(group.jid);
  useChatStore.getState().selectGroup(group.jid);
  navigate(chatHref(group.folder));
}

/**
 * Open a specific session of a workspace (ChatView remembers it once it
 * shows it).
 */
export function openWorkspaceSession(
  navigate: NavigateToPath,
  group: { jid: string; folder: string },
  sessionId: string,
  options?: { replace?: boolean },
) {
  useChatStore.getState().selectGroup(group.jid);
  navigate(chatHref(group.folder, sessionId), options);
}

/**
 * Whether the current history entry has one of this app's before it. The
 * router numbers its entries in `history.state.idx` (kept across reloads and
 * by replace navigations), so 0 is the first page of this app in the tab.
 * Back buttons step back when it does (cindy's goBackGuarded), so history
 * never piles up list → chat → list, and replace their page otherwise.
 */
export function hasAppEntryBefore(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}
