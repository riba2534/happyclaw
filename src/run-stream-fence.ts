export interface StreamRunDecision {
  accepted: boolean;
  runId?: string;
}

/**
 * Correlates legacy stream events with the exact GroupQueue run that first
 * emitted their turnId. A late callback from run A therefore keeps A's owner
 * even after run B has started on the same runtime JID.
 */
export class RunStreamFence {
  private readonly activeRuns = new Map<string, string>();
  private readonly turnOwners = new Map<string, Map<string, string>>();

  constructor(private readonly maxTurnsPerJid = 64) {}

  start(jid: string, runId: string): void {
    this.activeRuns.set(jid, runId);
  }

  finish(jid: string, runId: string): boolean {
    if (this.activeRuns.get(jid) !== runId) return false;
    this.activeRuns.delete(jid);
    return true;
  }

  /**
   * Exact runner-originated events never need turnId inference. A legitimate
   * retry may reuse the same durable turnId under a new runId, while a late
   * event from the previous attempt retains its old runId.
   */
  observeExact(jid: string, runId: string, turnId?: string): StreamRunDecision {
    const accepted = this.activeRuns.get(jid) === runId;
    if (accepted && turnId) this.rememberTurnOwner(jid, turnId, runId);
    return { accepted, runId };
  }

  observe(jid: string, turnId?: string): StreamRunDecision {
    const activeRunId = this.activeRuns.get(jid);
    // Exact query projections must be correlated before they can cross the
    // Web boundary. Most runner events are decorated by emit(), but a small
    // number of legacy direct writeOutput() paths can still omit turnId. It is
    // safer to drop those while an exact run is active than to mislabel a late
    // A event as the current B attempt.
    if (!turnId) {
      return activeRunId
        ? { accepted: false, runId: activeRunId }
        : { accepted: true };
    }
    const knownOwner = this.turnOwners.get(jid)?.get(turnId);

    if (knownOwner) {
      return {
        accepted: knownOwner === activeRunId,
        runId: knownOwner,
      };
    }

    // Unowned events remain available for legacy/non-query projections only
    // while no exact lifecycle is active.
    if (!activeRunId) return { accepted: true };

    this.rememberTurnOwner(jid, turnId, activeRunId);
    return { accepted: true, runId: activeRunId };
  }

  private rememberTurnOwner(jid: string, turnId: string, runId: string): void {
    let owners = this.turnOwners.get(jid);
    if (!owners) {
      owners = new Map<string, string>();
      this.turnOwners.set(jid, owners);
    }
    // Refresh insertion order so the most recently proven exact owner is the
    // last one evicted from the bounded compatibility cache.
    owners.delete(turnId);
    owners.set(turnId, runId);
    while (owners.size > this.maxTurnsPerJid) {
      const oldest = owners.keys().next().value as string | undefined;
      if (!oldest) break;
      owners.delete(oldest);
    }
  }
}
