import { type ChannelTurnRuntime } from './channel-turn-runtime.js';
import {
  getUncertainChannelOutboxForTurn,
  getFailedChannelOutboxForTurn,
  getDeliveredChannelOutboxForTurn,
} from './channel-reliability-store.js';
import { channelTurnScope } from './channel-turn-registry.js';
import { type ActiveChannelOutboxScope } from './channel-outbox-runtime-scope.js';
import { hasUnfinishedProactiveOutput } from './turn-outcome.js';
import { publishesFrameworkAnswer } from './workspace-interaction-runtime.js';
import { applyPendingCapabilityMutations } from './skill-install-service.js';
import { logger } from './logger.js';
import type { ContainerOutput } from './agent-runtime-contracts.js';
import type { InteractionMode } from './types.js';

export interface TurnSettlementContext {
  chatJid: string;
  agentId?: string;
  folder: string;
  interactionMode?: InteractionMode;
  lastProcessedId: string;
  runtimes: Map<string, ChannelTurnRuntime>;
  outboxScopesByInput: Map<string, ActiveChannelOutboxScope>;
  nonTerminalDeliveryAckByInput: Map<string, boolean>;
  physicalDeliveryAckByInput: Map<string, boolean>;
  clearProcessingIndicator: (inputId: string) => Promise<void>;
  markOutputSettled: (result: ContainerOutput) => void;
  deliverManualReconciliationNotice: (options: {
    logicalChatJid: string;
    scopeKey: string;
    targetJid: string;
    runtime: ChannelTurnRuntime;
    agentId?: string;
    presentation: 'native' | 'default';
    route: any;
  }) => Promise<boolean>;
  deliverDefinitiveFailureNotice: (options: {
    logicalChatJid: string;
    scopeKey: string;
    targetJid: string;
    runtime: ChannelTurnRuntime;
    agentId?: string;
    partial: boolean;
    presentation: 'native' | 'default';
    route: any;
  }) => Promise<boolean>;
  onDefinitiveFailureSettled?: () => void;
  onNeedsManualReconciliation?: () => void;
}

/**
 * Unified channel turn settlement for both Main and Agent (Runtime) sessions.
 * Enforces atomic receipt clearing, proactive output invariants, uncertain/failed
 * fencing, and applies pending capability mutations at the turn boundary.
 */
export async function settleChannelTurnOutput(
  result: ContainerOutput,
  ctx: TurnSettlementContext,
): Promise<boolean> {
  if (!result.inputTurnCompleted) return false;
  let allCompleted = true;
  const inputIds = result.ipcReceipts?.length
    ? result.ipcReceipts.map(
        (receipt: { deliveryId: string }) => receipt.deliveryId,
      )
    : [result.inputTurnId ?? ctx.lastProcessedId];

  for (const inputId of inputIds) {
    const runtime = ctx.runtimes.get(inputId);
    const mode = ctx.interactionMode ?? 'assistant';
    const unfinishedProactiveOutput = hasUnfinishedProactiveOutput({
      interactionMode: mode,
      nonTerminalDelivered:
        ctx.nonTerminalDeliveryAckByInput.get(inputId) === true,
      finalDelivered: ctx.physicalDeliveryAckByInput.get(inputId) === true,
    });

    if (!runtime) {
      if (unfinishedProactiveOutput) {
        allCompleted = false;
        logger.error(
          { chatJid: ctx.chatJid, agentId: ctx.agentId, inputTurnId: inputId },
          'Refusing to settle Proactive input after progress/separate output without final',
        );
        continue;
      }
      await ctx.clearProcessingIndicator(inputId);
      continue;
    }

    const uncertainDelivery = getUncertainChannelOutboxForTurn(runtime.runId);
    if (uncertainDelivery) {
      ctx.onNeedsManualReconciliation?.();
      const interrupted = runtime.interrupt(
        `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
      );
      const exactScope = ctx.outboxScopesByInput.get(inputId);
      const notified = exactScope?.chatId
        ? await ctx.deliverManualReconciliationNotice({
            logicalChatJid: ctx.chatJid,
            scopeKey: channelTurnScope(ctx.folder, ctx.agentId),
            targetJid: exactScope.sourceJid,
            runtime,
            agentId: ctx.agentId,
            presentation:
              ctx.interactionMode === 'proactive' ? 'native' : 'default',
            route: { ...exactScope, chatId: exactScope.chatId },
          })
        : false;
      if (interrupted && notified) {
        await ctx.clearProcessingIndicator(inputId);
        runtime.dispose();
        ctx.runtimes.delete(inputId);
      } else {
        allCompleted = false;
      }
      continue;
    }

    const failedDelivery = getFailedChannelOutboxForTurn(runtime.runId);
    if (failedDelivery) {
      const partialFailure = Boolean(
        getDeliveredChannelOutboxForTurn(runtime.runId),
      );
      const failed = runtime.fail(
        partialFailure
          ? `Channel delivery was partial before ${failedDelivery.id} was definitively rejected`
          : `Channel delivery ${failedDelivery.id} was definitively rejected`,
      );
      const exactScope = ctx.outboxScopesByInput.get(inputId);
      const notified = exactScope?.chatId
        ? await ctx.deliverDefinitiveFailureNotice({
            logicalChatJid: ctx.chatJid,
            scopeKey: channelTurnScope(ctx.folder, ctx.agentId),
            targetJid: exactScope.sourceJid,
            runtime,
            agentId: ctx.agentId,
            partial: partialFailure,
            presentation:
              ctx.interactionMode === 'proactive' ? 'native' : 'default',
            route: { ...exactScope, chatId: exactScope.chatId },
          })
        : true;
      if (failed && notified) {
        ctx.onDefinitiveFailureSettled?.();
        await ctx.clearProcessingIndicator(inputId);
        runtime.dispose();
        ctx.runtimes.delete(inputId);
      } else {
        allCompleted = false;
      }
      continue;
    }

    if (unfinishedProactiveOutput) {
      allCompleted = false;
      logger.error(
        {
          chatJid: ctx.chatJid,
          agentId: ctx.agentId,
          inputTurnId: inputId,
          runId: runtime.runId,
        },
        'Refusing to complete Proactive channel input without final delivery ACK',
      );
      continue;
    }

    const utteranceDelivered =
      ctx.physicalDeliveryAckByInput.get(inputId) === true;
    if (publishesFrameworkAnswer(mode) && !utteranceDelivered) {
      allCompleted = false;
      logger.error(
        {
          chatJid: ctx.chatJid,
          agentId: ctx.agentId,
          inputTurnId: inputId,
          runId: runtime.runId,
        },
        'Refusing to complete channel input without exact physical delivery ACK',
      );
      continue;
    }

    const completed =
      runtime.markFinalizing() &&
      runtime.complete({
        cursorCommitted: true,
        sentReply: utteranceDelivered,
        silent: !utteranceDelivered,
        inputTurnId: inputId,
      });

    if (completed) {
      await ctx.clearProcessingIndicator(inputId);
      runtime.dispose();
      ctx.runtimes.delete(inputId);
    } else {
      allCompleted = false;
      logger.error(
        {
          chatJid: ctx.chatJid,
          agentId: ctx.agentId,
          inputTurnId: inputId,
          runId: runtime.runId,
          durabilityFailure: runtime.hasDurabilityFailure,
          lostFence: runtime.hasLostFence,
        },
        'Completed input could not terminalize its channel turn ledger',
      );
    }
  }

  if (allCompleted) {
    ctx.markOutputSettled(result);
    void applyPendingCapabilityMutations({ groupFolder: ctx.folder }).catch(
      (err) =>
        logger.error(
          { err, groupFolder: ctx.folder },
          'Failed to apply pending capability mutations at turn settlement boundary',
        ),
    );
  }

  return allCompleted;
}
