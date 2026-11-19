import type { StreamEvent } from './stream-event.types.js';

type Usage = NonNullable<StreamEvent['usage']>;
type LedgerReceipt = {
  eventId: string;
  inserted: boolean;
  providerEstimatedCostUSD: number;
};
/** Streamed calls add up; omitted when no call of the input was timed. */
function sumStreamGeneration(
  base: Usage | undefined,
  next: Usage,
): Pick<Usage, 'streamOutputTokens' | 'streamMs'> {
  const streamMs = (base?.streamMs || 0) + (next.streamMs || 0);
  const streamOutputTokens =
    (base?.streamOutputTokens || 0) + (next.streamOutputTokens || 0);
  return streamMs > 0 && streamOutputTokens > 0
    ? { streamOutputTokens, streamMs }
    : {};
}

type InputState = { usage?: Usage; messageId?: string; completed: boolean };

/** One host invocation owns this bounded projection; billing remains in the ledger. */
export class InputUsageProjection {
  private readonly inputs = new Map<string, InputState>();

  constructor(
    initialInputId: string,
    private readonly maxInputs = 128,
  ) {
    this.admit(initialInputId);
  }

  admit(inputId: string): boolean {
    if (!inputId || this.inputs.has(inputId)) return this.inputs.has(inputId);
    if (this.inputs.size >= this.maxInputs) {
      const retired = [...this.inputs].find(([, state]) => state.completed);
      if (!retired) return false;
      this.inputs.delete(retired[0]);
    }
    this.inputs.set(inputId, { completed: false });
    return true;
  }

  rollback(inputId: string): void {
    this.inputs.delete(inputId);
  }

  complete(inputId: string): void {
    const state = this.inputs.get(inputId);
    if (state) state.completed = true;
  }

  bindMessage(inputId: string, messageId: string): void {
    const state = this.inputs.get(inputId);
    if (state && messageId) state.messageId = messageId;
  }

  messageId(inputId: string | undefined): string | undefined {
    return inputId ? this.inputs.get(inputId)?.messageId : undefined;
  }

  /**
   * The existing persistent event-ID uniqueness gate decides whether this raw
   * event contributes. No replay-ID cache or cumulative payload enters billing.
   */
  record(
    inputId: string | undefined,
    raw: Usage,
    receipt: LedgerReceipt,
  ): Usage | undefined {
    const state = inputId ? this.inputs.get(inputId) : undefined;
    if (!state || !receipt.eventId.trim()) return undefined;
    if (raw.eventId?.trim() && raw.eventId.trim() !== receipt.eventId) {
      return undefined;
    }
    if (receipt.inserted) {
      const next = { ...raw, costUSD: receipt.providerEstimatedCostUSD };
      const base = state.usage;
      const modelUsage = structuredClone(base?.modelUsage || {});
      for (const [model, value] of Object.entries(next.modelUsage || {})) {
        const previous = modelUsage[model];
        modelUsage[model] = previous
          ? {
              inputTokens: previous.inputTokens + value.inputTokens,
              outputTokens: previous.outputTokens + value.outputTokens,
              cacheReadInputTokens:
                previous.cacheReadInputTokens + value.cacheReadInputTokens,
              cacheCreationInputTokens:
                previous.cacheCreationInputTokens +
                value.cacheCreationInputTokens,
              reasoningTokens:
                (previous.reasoningTokens || 0) + (value.reasoningTokens || 0),
              costUSD: previous.costUSD + value.costUSD,
            }
          : { ...value };
      }
      state.usage = {
        inputTokens: (base?.inputTokens || 0) + next.inputTokens,
        outputTokens: (base?.outputTokens || 0) + next.outputTokens,
        cacheReadInputTokens:
          (base?.cacheReadInputTokens || 0) + next.cacheReadInputTokens,
        cacheCreationInputTokens:
          (base?.cacheCreationInputTokens || 0) + next.cacheCreationInputTokens,
        reasoningTokens:
          (base?.reasoningTokens || 0) + (next.reasoningTokens || 0),
        costUSD: (base?.costUSD || 0) + next.costUSD,
        durationMs: (base?.durationMs || 0) + next.durationMs,
        numTurns: (base?.numTurns || 0) + next.numTurns,
        ...sumStreamGeneration(base, next),
        modelUsage: Object.keys(modelUsage).length ? modelUsage : undefined,
      };
    }
    return this.snapshot(inputId);
  }

  snapshot(inputId: string | undefined): Usage | undefined {
    const usage = inputId ? this.inputs.get(inputId)?.usage : undefined;
    return usage ? structuredClone(usage) : undefined;
  }

  event(
    inputId: string | undefined,
    source: StreamEvent,
  ): (StreamEvent & { usageProjection: 'input_total' }) | undefined {
    const usage = this.snapshot(inputId);
    if (!usage || !inputId) return undefined;
    // A display snapshot deliberately has no billable eventId/batch identity.
    return {
      ...source,
      inputTurnId: inputId,
      usageProjection: 'input_total',
      usage,
    };
  }
}
