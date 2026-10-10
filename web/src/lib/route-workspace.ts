import { stripBasePath } from '../utils/url';

interface FolderGroup {
  folder: string;
  is_home?: boolean;
}

/**
 * The group a `/chat/:folder` route opens: the Web home workspace with that
 * folder first, then any Web workspace with it, then any group with it.
 */
export function findRouteGroupJid(
  groups: Record<string, FolderGroup>,
  folder: string,
): string | null {
  const entries = Object.entries(groups);
  const entry =
    entries.find(
      ([jid, info]) =>
        info.folder === folder && jid.startsWith('web:') && !!info.is_home,
    ) ||
    entries.find(
      ([jid, info]) => info.folder === folder && jid.startsWith('web:'),
    ) ||
    entries.find(([, info]) => info.folder === folder);
  return entry?.[0] ?? null;
}

/** The workspace folder named by the current `/chat/:folder` URL, if any. */
export function currentRouteChatFolder(): string | null {
  if (typeof window === 'undefined') return null;
  const { hash, pathname } = window.location;
  const route = window.__HAPPYCLAW_HASH_ROUTER__
    ? hash.slice(1).split('?')[0]
    : pathname;
  const match = /^\/chat\/([^/]+)/.exec(stripBasePath(route));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
