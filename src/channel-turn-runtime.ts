import crypto from 'node:crypto';

import {
  claimChannelTurnRunById,
  completeChannelTurnRun,
  createChannelTurnRun,
  createStreamingCardRecord,
  finalizeStreamingCardRecord,
  getChannelTurnRun,
  getUncertainChannelOutboxForTurn,
  getStreamingCardRecord,
  heartbeatChannelTurnRun,
  interruptChannelTurnRunWithDeliveredEffect,
  interruptChannelTurnRunById,
  manualReconciliationError,
  markChannelTurnFinalizing,
  retryChannelTurnRun,
  requiresManualReconciliation,
  rollbackUnpublishedStreamingCardReservation,
  resumeWaitingChannelTurn,
  updateStreamingCardRecord,
  waitChannelTurnForUser,
  type ChannelRouteSnapshot,
  type ChannelTurnRunStatus,
  type ClaimedChannelTurnRun,
  type StreamingCardRecord,
} from './channel-reliability-store.js';
import type {
  StreamingCardLifecycle,
  StreamingCardLifecycleEvent,
} from './feishu-streaming-card.js';
import { logger } from './logger.js';

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 12_000;

export interface ChannelTurnRuntimeInput extends ChannelRouteSnapshot {
  externalMessageId: string;
  agentId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  leaseMs?: number;
  heartbeatMs?: number;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function logicalKey(input: ChannelTurnRuntimeInput): string {
  return [
    'channel-turn-v1',
    input.provider,
    input.accountId,
    input.externalMessageId,
    input.agentId ?? 'main',
  ].join(':');
}

/**
 * Owns the fenced lease and durable card projection for one logical input
 * turn. Provider delivery is intentionally outside this class.
 */
export class ChannelTurnRuntime {
  readonly runId: string;
  readonly idempotencyKey: string;
  private initialStatus: ChannelTurnRunStatus = 'queued';

  private readonly input: ChannelTurnRuntimeInput;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private claim: ClaimedChannelTurnRun | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private card: StreamingCardRecord | null = null;
  private terminal = false;
  private durabilityError: Error | null = null;
  private fenceLost = false;
  private manualReconciliationRequired = false;

  private constructor(input: ChannelTurnRuntimeInput) {
    this.input = input;
    this.idempotencyKey = logicalKey(input);
    this.runId = `turn_${digest(this.idempotencyKey)}`;
    this.owner = `happyclaw:${process.pid}:${crypto.randomUUID()}`;
    this.leaseMs = Math.max(5_000, input.leaseMs ?? DEFAULT_LEASE_MS);
    this.heartbeatMs = Math.max(
      1_000,
      Math.min(this.leaseMs / 2, input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS),
    );
  }

  static start(input: ChannelTurnRuntimeInput): ChannelTurnRuntime {
    const runtime = new ChannelTurnRuntime(input);
    const { run } = createChannelTurnRun({
      ...input,
      id: runtime.runId,
      idempotencyKey: runtime.idempotencyKey,
      agentId: input.agentId,
      sessionId: input.sessionId,
      correlationId: input.correlationId ?? input.externalMessageId,
    });
    if (interruptChannelTurnRunWithDeliveredEffect(run.id)) {
      runtime.initialStatus = 'interrupted';
      runtime.manualReconciliationRequired = true;
      runtime.terminal = true;
      logger.warn(
        { runId: run.id, externalMessageId: input.externalMessageId },
        'Suppressed Turn replay because a durable channel delivery already completed',
      );
      return runtime;
    }
    const currentRun = getChannelTurnRun(run.id);
    if (
      currentRun?.status === 'interrupted' &&
      requiresManualReconciliation(currentRun.error)
    ) {
      runtime.initialStatus = 'interrupted';
      runtime.manualReconciliationRequired = true;
      runtime.terminal = true;
      return runtime;
    }
    runtime.claim =
      claimChannelTurnRunById(run.id, runtime.owner, runtime.leaseMs) ?? null;
    runtime.initialStatus =
      runtime.claim?.status ?? getChannelTurnRun(run.id)?.status ?? run.status;
    if (runtime.claim) runtime.startHeartbeat();
    return runtime;
  }

  get isClaimed(): boolean {
    return this.claim !== null && !this.terminal;
  }

  /** Immutable correlation id of the external input owned by this runtime. */
  get inputTurnId(): string {
    return this.input.externalMessageId;
  }

  get hasDurabilityFailure(): boolean {
    return this.durabilityError !== null;
  }

  get hasLostFence(): boolean {
    return this.fenceLost;
  }

  get executionDisposition():
    | 'execute'
    | 'defer'
    | 'skip_terminal'
    | 'manual_reconciliation' {
    if (this.isClaimed) return 'execute';
    if (this.manualReconciliationRequired) return 'manual_reconciliation';
    return ['completed', 'failed', 'interrupted', 'cancelled'].includes(
      this.initialStatus,
    )
      ? 'skip_terminal'
      : 'defer';
  }

  /**
   * Reserve the sole card record for this run before provider creation. If a
   * previous process already reserved it, callers must not create another
   * active card for the same logical input.
   */
  reserveStreamingCard(): StreamingCardLifecycle | undefined {
    if (!this.isClaimed) return undefined;
    const cardId = `stream_${digest(`${this.runId}:primary`)}`;
    const created = createStreamingCardRecord({
      ...this.input,
      id: cardId,
      turnRunId: this.runId,
      status: 'creating',
      snapshot: { text: '', thinking: '', state: 'idle', backendMode: 'v1' },
    });
    if (!created.created) {
      logger.warn(
        { runId: this.runId, cardId, status: created.card.status },
        'Streaming card already reserved; suppressing duplicate active card',
      );
      return undefined;
    }
    this.card = created.card;
    return { onEvent: (event) => this.onCardEvent(event) };
  }

  /**
   * Undo only the local pre-provider reservation. Callers may retry the Turn
   * only when this returns true; any provider-visible or stale state is
   * deliberately preserved for reconciliation.
   */
  rollbackUnpublishedStreamingCardReservation(): boolean {
    if (!this.claim || this.terminal || !this.card) return false;
    const rolledBack = rollbackUnpublishedStreamingCardReservation(
      this.claim,
      this.card,
    );
    if (rolledBack) {
      this.card = null;
      return true;
    }
    const current = getStreamingCardRecord(this.card.id);
    logger.error(
      {
        runId: this.runId,
        cardId: this.card.id,
        expectedRevision: this.card.revision,
        actualRevision: current?.revision,
        status: current?.status,
        hasMessageId: Boolean(current?.messageId),
        hasCardId: Boolean(current?.cardId),
      },
      'Refused to roll back a streaming card which may have reached the provider',
    );
    return false;
  }

  markFinalizing(): boolean {
    if (!this.claim || this.terminal) return false;
    if (markChannelTurnFinalizing(this.claim)) return true;
    if (getChannelTurnRun(this.runId)?.status === 'finalizing') return true;
    this.fenceLost = true;
    return false;
  }

  complete(result?: unknown): boolean {
    const uncertainDelivery = getUncertainChannelOutboxForTurn(this.runId);
    if (uncertainDelivery) {
      logger.error(
        {
          runId: this.runId,
          outboxItemId: uncertainDelivery.id,
          outboxKind: uncertainDelivery.kind,
        },
        'Refusing to complete channel turn while a provider side effect is uncertain',
      );
      return false;
    }
    if (this.durabilityError) {
      logger.error(
        { err: this.durabilityError, runId: this.runId },
        'Refusing to complete channel turn after durable lifecycle failure',
      );
      return false;
    }
    return this.finish('completed', result);
  }

  fail(error: unknown): boolean {
    return this.finish(
      'failed',
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }

  cancel(reason: string): boolean {
    return this.finish('cancelled', undefined, reason);
  }

  /**
   * Fence a turn whose external side effects require manual reconciliation.
   * Unlike retry/cancel, this invalidates the live lease token immediately.
   */
  interrupt(reason: string): boolean {
    if (this.terminal) return true;
    const interrupted = interruptChannelTurnRunById(
      this.runId,
      manualReconciliationError(reason),
    );
    if (interrupted) {
      this.terminal = true;
      this.claim = null;
      this.stopHeartbeat();
    } else {
      const status = getChannelTurnRun(this.runId)?.status;
      if (status === 'interrupted') {
        this.terminal = true;
        this.claim = null;
        this.stopHeartbeat();
        return true;
      }
    }
    return interrupted;
  }

  /** Keep this deterministic run replayable on the queue's next attempt. */
  retry(error: unknown, availableAt = new Date().toISOString()): boolean {
    if (this.terminal) return false;
    this.resumeFromUser();
    if (!this.claim) {
      this.fenceLost = true;
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    const retried = retryChannelTurnRun(this.claim, {
      availableAt,
      error: message,
    });
    if (!retried) {
      this.fenceLost = true;
      logger.error(
        { runId: this.runId, leaseToken: this.claim.leaseToken },
        'Failed to release channel turn into retry_wait',
      );
      return false;
    }
    this.claim = null;
    this.stopHeartbeat();
    return true;
  }

  dispose(): void {
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const claim = this.claim;
      if (!claim || this.terminal) return;
      if (!heartbeatChannelTurnRun(claim, this.leaseMs)) {
        logger.warn(
          { runId: this.runId, leaseToken: claim.leaseToken },
          'Channel turn heartbeat lost its fence',
        );
        this.fenceLost = true;
        this.claim = null;
        this.stopHeartbeat();
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private waitForUser(snapshot: unknown): void {
    if (!this.claim || this.terminal) return;
    if (waitChannelTurnForUser(this.claim, snapshot)) {
      this.claim = null;
      this.stopHeartbeat();
    }
  }

  private resumeFromUser(): void {
    if (this.claim || this.terminal) return;
    const run = getChannelTurnRun(this.runId);
    if (!run || run.status !== 'waiting_user') return;
    if (!resumeWaitingChannelTurn(run.id, run.revision)) return;
    this.claim =
      claimChannelTurnRunById(run.id, this.owner, this.leaseMs) ?? null;
    if (this.claim) this.startHeartbeat();
  }

  private finish(
    status: 'completed' | 'failed' | 'cancelled',
    result?: unknown,
    error?: string,
  ): boolean {
    if (this.terminal) return true;
    this.resumeFromUser();
    if (!this.claim) return false;
    const completed = completeChannelTurnRun(this.claim, {
      status,
      result,
      error: error ?? null,
    });
    if (completed) {
      this.terminal = true;
      this.claim = null;
      this.stopHeartbeat();
    } else {
      this.fenceLost = true;
      logger.error(
        { runId: this.runId, leaseToken: this.claim.leaseToken, status },
        'Channel turn terminal transition lost its lease fence',
      );
    }
    return completed;
  }

  private onCardEvent(event: StreamingCardLifecycleEvent): void {
    try {
      if (event.status === 'waiting_user') this.waitForUser(event.snapshot);
      if (event.status === 'running') this.resumeFromUser();

      const cardId = `stream_${digest(`${this.runId}:primary`)}`;
      let current = this.card ?? getStreamingCardRecord(cardId);
      if (!current) {
        throw new Error(
          `Streaming card lifecycle record disappeared: ${cardId}`,
        );
      }

      const terminal =
        event.status === 'completed' ||
        event.status === 'aborted' ||
        event.status === 'failed';
      const persistedStatus =
        event.status === 'completed'
          ? 'completed'
          : event.status === 'aborted'
            ? 'aborted'
            : event.status === 'failed'
              ? 'failed'
              : event.status === 'creating'
                ? 'creating'
                : 'streaming';

      let next: StreamingCardRecord | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        next = terminal
          ? finalizeStreamingCardRecord(current.id, current.revision, {
              status: persistedStatus as 'completed' | 'aborted' | 'failed',
              version: event.version,
              snapshot: event.snapshot,
              error: event.error ?? null,
            })
          : updateStreamingCardRecord(current.id, current.revision, {
              status: persistedStatus,
              messageId: event.messageId,
              cardId: event.cardId,
              version: event.version,
              snapshot: event.snapshot,
              error: event.error ?? null,
            });
        if (next) break;
        const reloaded = getStreamingCardRecord(current.id);
        if (!reloaded) {
          throw new Error(
            `Streaming card lifecycle record disappeared: ${current.id}`,
          );
        }
        if (['completed', 'aborted', 'failed'].includes(reloaded.status)) {
          if (reloaded.status === persistedStatus) {
            next = reloaded;
            break;
          }
          throw new Error(
            `Streaming card lifecycle lost terminal fence: ${reloaded.status} != ${persistedStatus}`,
          );
        }
        logger.warn(
          {
            runId: this.runId,
            cardId: current.id,
            expectedRevision: current.revision,
            actualRevision: reloaded.revision,
            attempt: attempt + 1,
          },
          'Retrying streaming card lifecycle after revision conflict',
        );
        current = reloaded;
      }
      if (!next) {
        throw new Error(
          `Streaming card lifecycle CAS retry exhausted: ${current.id}`,
        );
      }
      this.card = next;

      // Card projection and Agent execution are separate state machines. A
      // compact/overflow partial can close a provider card while the same
      // logical input is still running. Only the host's exact
      // inputTurnCompleted + physical delivery ACK may finalize the Turn.
    } catch (error) {
      this.durabilityError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        { err: this.durabilityError, runId: this.runId, status: event.status },
        'Streaming card durable lifecycle failed',
      );
      throw this.durabilityError;
    }
  }
}
