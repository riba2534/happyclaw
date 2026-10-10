/** Runs with no stream update for this long and no live query are dead. */
export const STALE_STREAMING_STATE_MS = 30 * 60 * 1000;

/**
 * Drop stream projections of runs that ended without a terminal event.
 * Entries of live runs stay however quiet they are (long sub-agents, #241),
 * and an accumulated full text without a snapshot or live run is an orphan.
 * Returns the number of removed entries.
 */
export function sweepStaleStreamingEntries(
  snapshots: Map<string, { updatedAt: number }>,
  fullTexts: Map<string, string>,
  activeRuns: { has(jid: string): boolean },
  now: number,
  staleMs: number = STALE_STREAMING_STATE_MS,
): number {
  let removed = 0;
  for (const [jid, snap] of snapshots) {
    if (activeRuns.has(jid) || now - snap.updatedAt <= staleMs) continue;
    snapshots.delete(jid);
    fullTexts.delete(jid);
    removed += 1;
  }
  for (const jid of [...fullTexts.keys()]) {
    if (snapshots.has(jid) || activeRuns.has(jid)) continue;
    fullTexts.delete(jid);
    removed += 1;
  }
  return removed;
}
