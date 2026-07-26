export interface ClientActiveRun {
  chatJid: string;
  runId: string;
  startedAt: string;
  phase: 'preparing' | 'running';
}

export type ClientActiveRuns = Record<string, ClientActiveRun>;

export interface RuntimeQueryStatus {
  queryInFlight?: boolean;
  queryId?: string | null;
}

/** Only exact attempts can restore waiting because only they have a terminal. */
export function hasExactQueryAttempt(status: RuntimeQueryStatus): boolean {
  return status.queryInFlight === true && !!status.queryId;
}

/** A start for the same runtime JID supersedes its older attempt. */
export function applyRunStarted(
  current: ClientActiveRuns,
  run: ClientActiveRun,
): ClientActiveRuns {
  return { ...current, [run.chatJid]: run };
}

/** Remove only the attempt named by the terminal event. */
export function applyRunFinished(
  current: ClientActiveRuns,
  chatJid: string,
  runId: string,
): { runs: ClientActiveRuns; applied: boolean } {
  if (current[chatJid]?.runId !== runId) {
    return { runs: current, applied: false };
  }
  const runs = { ...current };
  delete runs[chatJid];
  return { runs, applied: true };
}

/** Reconnect snapshots are authoritative for server-owned query attempts. */
export function runsFromAuthoritativeSnapshot(
  runs: ClientActiveRun[],
): ClientActiveRuns {
  return Object.fromEntries(
    runs
      .filter(
        (run): run is ClientActiveRun =>
          typeof run?.chatJid === 'string' &&
          run.chatJid.length > 0 &&
          typeof run.runId === 'string' &&
          run.runId.length > 0,
      )
      .map((run) => [run.chatJid, run]),
  );
}

/**
 * Live stream payloads are owned by an exact query attempt. Unowned legacy
 * payloads are fail-closed because they have no matching terminal boundary.
 */
export function shouldApplyRunScopedPayload(
  current: ClientActiveRuns,
  chatJid: string,
  runId?: string,
): boolean {
  return !!runId && current[chatJid]?.runId === runId;
}

/**
 * Split queued chat JIDs into main-conversation and conversation-Agent wait
 * keys.
 *
 * A queued message sits behind a busy runner and has no run identity yet, so
 * it can never enter `activeRuns` — nothing would ever deliver its terminal.
 * It still has to show a wait state, otherwise reloading mid-queue presents an
 * idle composer and invites the user to send the same message twice.
 */
export function waitKeysForQueuedChats(queuedChatJids: string[]): {
  waiting: string[];
  agentWaiting: string[];
} {
  const waiting: string[] = [];
  const agentWaiting: string[] = [];
  const marker = '#agent:';
  for (const jid of queuedChatJids) {
    const markerIndex = jid.indexOf(marker);
    if (markerIndex >= 0) {
      agentWaiting.push(jid.slice(markerIndex + marker.length));
    } else {
      waiting.push(jid);
    }
  }
  return { waiting, agentWaiting };
}

/** A reconnect replacement must discard the prior attempt's local stream. */
export function shouldDiscardStreamForAuthoritativeRun(
  previous: ClientActiveRuns,
  authoritative: ClientActiveRuns,
  chatJid: string,
): boolean {
  const next = authoritative[chatJid];
  if (!next) return true;
  return previous[chatJid]?.runId !== next.runId;
}
