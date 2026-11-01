import { LEGACY_MAIN_SESSION_KEY_PREFIX } from '../../src/legacy-main-session-checks.js';

/** The session a workspace's main session became in v88, and its address. */
export function formerMainSession(
  db: { getRouterState(key: string): string | undefined },
  workspaceJid: string,
): { id: string; jid: string } {
  const id = db.getRouterState(
    `${LEGACY_MAIN_SESSION_KEY_PREFIX}${workspaceJid}`,
  );
  if (!id) throw new Error(`${workspaceJid} has no former main session`);
  return { id, jid: `${workspaceJid}#agent:${id}` };
}
