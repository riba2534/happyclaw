import type { AgentInfo } from '../types';
import { compareSessionsForList } from './session-order';

// Which session opening the app or entering a workspace shows. Every session
// is alike: the choice is the one last opened, else the most recently active.

type EntrySession = Pick<
  AgentInfo,
  'id' | 'kind' | 'created_at' | 'last_active_at'
>;

/** What entering a workspace does. */
export type WorkspaceEntry =
  | { kind: 'open'; sessionId: string }
  | { kind: 'create' }
  | { kind: 'empty' };

/** A session as the activity order sees it: without its pin. */
function unpinned({ id, created_at, last_active_at }: EntrySession) {
  return { id, created_at, last_active_at };
}

/** The most recently active conversation (pins aside), if there is one. */
export function mostRecentSession<T extends EntrySession>(
  sessions: readonly T[],
): T | null {
  let recent: T | null = null;
  for (const session of sessions) {
    if (session.kind !== 'conversation') continue;
    if (
      !recent ||
      compareSessionsForList(unpinned(session), unpinned(recent)) < 0
    ) {
      recent = session;
    }
  }
  return recent;
}

/**
 * Entering a workspace: the session last opened there, else the most
 * recently active one; with none, a new one when the viewer may create it
 * (and creating is not held back), otherwise the empty state.
 */
export function resolveWorkspaceEntry(
  sessions: readonly EntrySession[],
  remembered: string | null,
  canCreate: boolean,
): WorkspaceEntry {
  const target =
    (remembered &&
      sessions.find((s) => s.id === remembered && s.kind === 'conversation')) ||
    mostRecentSession(sessions);
  if (target) return { kind: 'open', sessionId: target.id };
  return canCreate ? { kind: 'create' } : { kind: 'empty' };
}

/** What opening the app (`/chat`) shows. */
export type Landing =
  | { kind: 'open'; jid: string; sessionId: string }
  | { kind: 'create'; jid: string }
  | { kind: 'none' };

/**
 * Opening the app: the session last opened on this device while it still
 * exists, else Home's most recently active session, else a new one in Home.
 * `sessionsOf` answers for workspaces whose sessions the caller loaded.
 */
export function resolveLanding({
  last,
  homeJid,
  sessionsOf,
}: {
  /** The last opened session, its workspace resolved (null when gone). */
  last: { jid: string; sessionId: string } | null;
  homeJid: string | null;
  sessionsOf: (jid: string) => readonly EntrySession[];
}): Landing {
  if (
    last &&
    sessionsOf(last.jid).some(
      (session) =>
        session.id === last.sessionId && session.kind === 'conversation',
    )
  ) {
    return { kind: 'open', jid: last.jid, sessionId: last.sessionId };
  }
  if (!homeJid) return { kind: 'none' };
  const recent = mostRecentSession(sessionsOf(homeJid));
  return recent
    ? { kind: 'open', jid: homeJid, sessionId: recent.id }
    : { kind: 'create', jid: homeJid };
}
