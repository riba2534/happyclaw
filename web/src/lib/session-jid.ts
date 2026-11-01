// A session's JID: `<workspace>#agent:<id>`. A workspace JID is no
// conversation's address.

const MARKER = '#agent:';

export function sessionJidOf(workspaceJid: string, sessionId: string): string {
  return `${workspaceJid}${MARKER}${sessionId}`;
}

/** The session id in a session JID; null for a JID that names none. */
export function sessionIdOf(sessionJid: string): string | null {
  const marker = sessionJid.indexOf(MARKER);
  return marker === -1 ? null : sessionJid.slice(marker + MARKER.length);
}

/** Whether a JID addresses one of the workspace's sessions. */
export function isSessionOf(jid: string, workspaceJid: string): boolean {
  return jid.startsWith(`${workspaceJid}${MARKER}`);
}

export function workspaceJidOf(sessionJid: string): string {
  const marker = sessionJid.indexOf(MARKER);
  return marker === -1 ? sessionJid : sessionJid.slice(0, marker);
}
