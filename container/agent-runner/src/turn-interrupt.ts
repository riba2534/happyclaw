/**
 * Interrupting the active SDK turn.
 *
 * The host interrupts a query through the `_interrupt` IPC sentinel and says
 * whether the user stopped the turn or steered it; the runner also stops a
 * turn on its own (usage limit, model switch, model limit, a sub-agent's
 * provider error, shutdown). Only an explicit stop guarantees the turn's
 * sub-agents end with it. Background shells, monitors and MCP tasks (a dev
 * server, a log watcher) are never stopped and never hold the query open.
 */
import fs from 'fs';
import path from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Why the host interrupted the turn. `stop`: `/break`, the Web or Feishu stop
 * button, a Feishu recall. `steer`: `/steer`, 「发送」 and every interrupt
 * that does not say why (hosts that predate the reason file).
 */
export type InterruptReason = 'stop' | 'steer';

/** Query-bound interrupt; its content is the host query id. */
const INTERRUPT_SENTINEL = '_interrupt';
/**
 * Written by the host just before `_interrupt` for an explicit stop, as
 * `{"queryId":"<the _interrupt content>","reason":"stop"}`. It is a separate
 * file so `_interrupt` keeps the content runners that predate it compare.
 */
const INTERRUPT_REASON_SENTINEL = '_interrupt_reason';

/** How long an explicit stop waits for its sub-agents to end before closing. */
export const SUB_AGENT_STOP_CLOSE_DELAY_MS = 3_000;

/**
 * An `_interrupt` read empty may still be being written (hosts that predate
 * the atomic rename write it in place, and the watch fires on creation). It
 * is read again on a later event and only taken as the legacy interrupt
 * without a query id once it has stayed empty this long.
 */
const EMPTY_SENTINEL_SETTLE_MS = 1_000;
let emptySentinelSince = 0;

/** The trimmed `_interrupt` content, null when there is none. */
function readSentinel(inputDir: string): string | null {
  try {
    return fs
      .readFileSync(path.join(inputDir, INTERRUPT_SENTINEL), 'utf8')
      .trim();
  } catch {
    return null;
  }
}

/** The reason the host wrote for this interrupt, null when it wrote none. */
function readReasonSentinel(
  inputDir: string,
  queryRunId: string,
): { reason: InterruptReason; withdrawDeliveryIds: string[] } | null {
  try {
    const written = JSON.parse(
      fs.readFileSync(path.join(inputDir, INTERRUPT_REASON_SENTINEL), 'utf8'),
    ) as { queryId?: unknown; reason?: unknown; withdrawDeliveryIds?: unknown };
    if (written?.queryId !== queryRunId) return null;
    return {
      reason: written.reason === 'stop' ? 'stop' : 'steer',
      withdrawDeliveryIds: Array.isArray(written.withdrawDeliveryIds)
        ? written.withdrawDeliveryIds.filter(
            (id): id is string => typeof id === 'string',
          )
        : [],
    };
  } catch {
    return null;
  }
}

function readReason(
  inputDir: string,
  queryRunId: string,
): InterruptReason | null {
  return readReasonSentinel(inputDir, queryRunId)?.reason ?? null;
}

function unlinkSentinel(inputDir: string, name: string): void {
  try {
    fs.unlinkSync(path.join(inputDir, name));
  } catch {
    /* ignore */
  }
}

/**
 * Consume a pending `_interrupt` and its reason. Null when none is pending
 * yet. A reason file written for another query is left alone.
 */
export function consumeInterruptSentinel(inputDir: string): {
  queryRunId: string;
  reason: InterruptReason;
  /** Later accepted inputs the host withdrew with this stop (`/break`). */
  withdrawDeliveryIds?: string[];
} | null {
  const queryRunId = readSentinel(inputDir);
  if (queryRunId === null) {
    emptySentinelSince = 0;
    return null;
  }
  if (!queryRunId) {
    const now = Date.now();
    emptySentinelSince ||= now;
    if (now - emptySentinelSince < EMPTY_SENTINEL_SETTLE_MS) return null;
  }
  emptySentinelSince = 0;
  unlinkSentinel(inputDir, INTERRUPT_SENTINEL);
  const written = readReasonSentinel(inputDir, queryRunId);
  if (written) unlinkSentinel(inputDir, INTERRUPT_REASON_SENTINEL);
  return {
    queryRunId,
    reason: written?.reason ?? 'steer',
    ...(written?.withdrawDeliveryIds.length
      ? { withdrawDeliveryIds: written.withdrawDeliveryIds }
      : {}),
  };
}

/**
 * After a steer the runner stops reading IPC while the superseded query
 * winds down. Consume a later stop for that same query, if one arrived;
 * anything else is left for the end of the query to discard.
 */
export function consumeStopAfterSteer(
  inputDir: string,
  queryRunId: string | undefined,
): boolean {
  const written = readSentinel(inputDir);
  if (!written || (queryRunId && written !== queryRunId)) return false;
  if (readReason(inputDir, written) !== 'stop') return false;
  discardInterruptSentinel(inputDir);
  return true;
}

/** Drop an interrupt that is no longer current, with its reason. */
export function discardInterruptSentinel(inputDir: string): void {
  unlinkSentinel(inputDir, INTERRUPT_SENTINEL);
  unlinkSentinel(inputDir, INTERRUPT_REASON_SENTINEL);
}

type StoppableQuery = Pick<Query, 'interrupt' | 'close'>;

/**
 * Stop the active SDK turn without re-running input queued behind it.
 *
 * On interrupt Claude Code at once starts the next message already written
 * to it (verified with 2.1.296, even after the input stream ended), while
 * the runner requeues every later accepted turn for its next query; such a
 * turn would run twice, once unseen in this superseded process. With later
 * turns queued in the CLI the process is closed instead, and an interrupt
 * receipt that still lists queued input closes it as well.
 *
 * Claude Code's interrupt itself kills the running sub-agents, foreground or
 * background, whether the main turn is busy or idle, and leaves background
 * shells alone (verified with 2.1.296). The runner never calls stopTask on
 * top: Claude Code reports a task stopped that way to the main Agent as a new
 * turn, so once the input stream ends it keeps running hidden, billed turns
 * and then waits for every background shell to exit (a dev server never
 * does), holding the runner in the superseded query with IPC polling off.
 * An explicit stop only adds a deadline: a sub-agent still running after it
 * closes the query.
 */
export class ActiveTurnStopper {
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: {
      /** Unsettled sub-agent task ids, shells and monitors excluded. */
      activeSubAgentTaskIds: () => string[];
      isQueryFinished: () => boolean;
      log: (message: string) => void;
    },
  ) {}

  stop(
    activeQuery: StoppableQuery,
    label: string,
    turnsQueuedInCli: number,
    reason?: InterruptReason,
  ): void {
    const { log } = this.deps;
    if (turnsQueuedInCli > 0) {
      log(
        `${label}: closing the query, ${turnsQueuedInCli} later input(s) are queued in Claude Code`,
      );
      activeQuery.close();
      return;
    }
    if (reason === 'stop') this.requireSubAgentsToEnd(activeQuery, label);
    activeQuery
      .interrupt()
      .then((receipt) => {
        if (!receipt?.still_queued?.length) return;
        log(
          `${label}: closing the query, the interrupt left ${receipt.still_queued.length} queued input(s)`,
        );
        activeQuery.close();
      })
      .catch((err: unknown) => log(`${label} interrupt failed: ${err}`));
  }

  /**
   * The explicit-stop deadline: close the query if a sub-agent is still
   * running a few seconds from now. Also used when a stop follows a steer
   * the runner already acted on.
   */
  requireSubAgentsToEnd(activeQuery: StoppableQuery, label: string): void {
    const subAgents = this.deps.activeSubAgentTaskIds().length;
    if (subAgents === 0) return;
    this.deps.log(
      `${label}: ${subAgents} sub-agent(s) must end within ${SUB_AGENT_STOP_CLOSE_DELAY_MS / 1000}s`,
    );
    this.closeIfSubAgentsOutlast(activeQuery, label);
  }

  dispose(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private closeIfSubAgentsOutlast(
    activeQuery: StoppableQuery,
    label: string,
  ): void {
    this.dispose();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.deps.isQueryFinished()) return;
      const remaining = this.deps.activeSubAgentTaskIds().length;
      if (remaining === 0) return;
      this.deps.log(
        `${label}: closing the query, ${remaining} sub-agent(s) still running ${SUB_AGENT_STOP_CLOSE_DELAY_MS / 1000}s after the stop`,
      );
      activeQuery.close();
    }, SUB_AGENT_STOP_CLOSE_DELAY_MS);
    this.closeTimer.unref?.();
  }
}
