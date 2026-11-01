// Which session this device opened last: per workspace, so entering a
// workspace without `?agent=` returns to it, and overall, so opening the app
// (`/chat`) does. An entry naming a session that is gone is ignored.

const STORAGE_KEY = 'happyclaw-workspace-last-agent';
const LAST_SESSION_KEY = 'happyclaw-last-session';

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readMap(): Record<string, string> {
  const ls = safeStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function getWorkspaceLastAgent(jid: string): string | null {
  return readMap()[jid] || null;
}

/** The session last opened on this device, by workspace folder. */
export interface LastOpenedSession {
  folder: string;
  sessionId: string;
}

export function getLastOpenedSession(): LastOpenedSession | null {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const parsed = JSON.parse(ls.getItem(LAST_SESSION_KEY) || 'null');
    return parsed &&
      typeof parsed.folder === 'string' &&
      typeof parsed.sessionId === 'string' &&
      parsed.folder &&
      parsed.sessionId
      ? { folder: parsed.folder, sessionId: parsed.sessionId }
      : null;
  } catch {
    return null;
  }
}

/** Remember a session as the one last opened, overall and in its workspace. */
export function rememberOpenedSession(
  workspace: { jid: string; folder: string },
  sessionId: string,
): void {
  writeMap({ ...readMap(), [workspace.jid]: sessionId });
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(
      LAST_SESSION_KEY,
      JSON.stringify({ folder: workspace.folder, sessionId }),
    );
  } catch {
    /* quota exceeded — ignore */
  }
}
