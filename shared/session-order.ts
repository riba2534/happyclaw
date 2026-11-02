/**
 * The order of a workspace's sessions, shared by the Web lists and the IM
 * `/list` command so both show the same thing: the sessions the user pinned
 * first, then the rest; inside each group the most recent activity first.
 * No session is special; a session is pinned only because a user pinned it.
 */

export interface OrderableSession {
  id: string;
  created_at: string;
  last_active_at?: string | null;
  /** When the viewing user pinned it; absent or null when not pinned. */
  pinned_at?: string | null;
}

/** The time a session was last active, falling back to its creation. */
export function sessionActivityAt(
  session: Pick<OrderableSession, 'created_at' | 'last_active_at'>,
): string {
  return session.last_active_at || session.created_at;
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareSessionsForList(
  a: OrderableSession,
  b: OrderableSession,
): number {
  const pinnedA = a.pinned_at ? 1 : 0;
  const pinnedB = b.pinned_at ? 1 : 0;
  if (pinnedA !== pinnedB) return pinnedB - pinnedA;
  const activityA = timeOf(sessionActivityAt(a));
  const activityB = timeOf(sessionActivityAt(b));
  if (activityA !== activityB) return activityB - activityA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortSessionsForList<T extends OrderableSession>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort(compareSessionsForList);
}
