import crypto from 'node:crypto';

import {
  getRecordedUsageEventCost,
  getUsagePricingBucketTotals,
  getUserById,
  recordUsageEventBatch,
  type UsageModelRecordInput,
} from './db.js';
import {
  deductUsageCost,
  getUserEffectivePlan,
  invalidateUserBillingCache,
  isBillingEnabled,
} from './billing.js';
import {
  estimateKabooModelCostCents,
  kabooCostCentsToUSD,
  priceKabooUsageByModel,
} from './kaboo-pricing.js';

export interface UsagePayload {
  eventId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens?: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens?: number;
      costUSD: number;
    }
  >;
}

export interface RecordUsageEventOptions {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string | null;
  source?: string;
  usage: UsagePayload;
  /** Stable runner turn/event ID. Required for strong replay protection. */
  eventId?: string;
  createdAt?: string;
}

function safe(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0;
}

function usageIdentityPayload(usage: UsagePayload): Record<string, unknown> {
  const modelUsage = Object.fromEntries(
    Object.entries(usage.modelUsage || {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([model, value]) => [
        model,
        {
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          cacheReadInputTokens: value.cacheReadInputTokens,
          cacheCreationInputTokens: value.cacheCreationInputTokens,
          reasoningTokens: value.reasoningTokens || 0,
        },
      ]),
  );
  return {
    eventId: usage.eventId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    reasoningTokens: usage.reasoningTokens || 0,
    durationMs: usage.durationMs,
    numTurns: usage.numTurns,
    modelUsage,
  };
}

/**
 * Compatibility fallback for integrations that have not started sending a
 * runner event ID yet. It is deterministic for the same message + payload,
 * but new callers should always pass eventId explicitly.
 */
export function deriveUsageEventId(options: RecordUsageEventOptions): string {
  const explicit = options.eventId || options.usage.eventId;
  if (explicit?.trim()) return explicit.trim();
  return `usage:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        userId: options.userId,
        groupFolder: options.groupFolder,
        agentId: options.agentId || null,
        messageId: options.messageId || null,
        source: options.source || 'agent',
        // SDK dollar estimates are deliberately excluded: they are neither an
        // accounting authority nor part of a logical event's identity.
        usage: usageIdentityPayload(options.usage),
      }),
    )
    .digest('hex')}`;
}

/**
 * The sole application entry point for usage accounting.
 *
 * - one logical run = one eventId
 * - all model rows, analytics and quota ledgers are committed atomically
 * - balance deduction is replay-safe on the same eventId
 * - zero-cost events still count every token category toward token quotas
 */
export function recordUsageEvent(options: RecordUsageEventOptions): {
  eventId: string;
  inserted: boolean;
  providerEstimatedCostUSD: number;
  billedCostUSD: number;
} {
  const eventId = deriveUsageEventId(options);
  const existing = getRecordedUsageEventCost(eventId);
  if (existing) {
    return { eventId, inserted: false, ...existing };
  }
  const usage = options.usage;
  const source = options.source?.trim() || 'agent';
  const createdAt = options.createdAt || new Date().toISOString();
  const priced = priceKabooUsageByModel(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningTokens: usage.reasoningTokens || 0,
    },
    usage.modelUsage,
  );
  const user = getUserById(options.userId);
  const effective = user ? getUserEffectivePlan(options.userId) : null;
  const shouldCharge =
    Boolean(user) &&
    user?.role !== 'admin' &&
    isBillingEnabled() &&
    Boolean(effective);
  const rateMultiplier = shouldCharge
    ? safe(effective?.plan.rate_multiplier ?? 1)
    : 0;
  const models: UsageModelRecordInput[] = priced.models.map((model) => {
    const previous = getUsagePricingBucketTotals({
      userId: options.userId,
      groupFolder: options.groupFolder,
      source,
      model: model.model,
      createdAt,
    });
    const previousCostCents = estimateKabooModelCostCents(
      model.model,
      previous,
    );
    const nextCostCents = estimateKabooModelCostCents(model.model, {
      inputTokens: previous.inputTokens + model.inputTokens,
      outputTokens: previous.outputTokens + model.outputTokens,
      cacheReadInputTokens:
        previous.cacheReadInputTokens + model.cacheReadInputTokens,
      cacheCreationInputTokens:
        previous.cacheCreationInputTokens + model.cacheCreationInputTokens,
      reasoningTokens: previous.reasoningTokens + model.reasoningTokens,
    });
    // Store this event's increment to the raw-model/UTC-half-hour headline.
    // Summing all increments in the bucket equals Kaboo's single rounded cent
    // value, including the sub-cent carry between small API calls.
    const incrementalCostUSD = kabooCostCentsToUSD(
      Math.max(0, nextCostCents - previousCostCents),
    );
    return {
      model: model.model,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheReadInputTokens: model.cacheReadInputTokens,
      cacheCreationInputTokens: model.cacheCreationInputTokens,
      reasoningTokens: model.reasoningTokens,
      providerEstimatedCostUSD: incrementalCostUSD,
      billedCostUSD: incrementalCostUSD * rateMultiplier,
    };
  });
  const providerEstimatedCostUSD = models.reduce(
    (sum, model) => sum + model.providerEstimatedCostUSD,
    0,
  );
  const billedCostUSD = models.reduce(
    (sum, model) => sum + model.billedCostUSD,
    0,
  );

  const result = recordUsageEventBatch({
    eventId,
    userId: options.userId,
    groupFolder: options.groupFolder,
    agentId: options.agentId,
    messageId: options.messageId,
    inputTokens: priced.usage.inputTokens,
    outputTokens: priced.usage.outputTokens,
    cacheReadInputTokens: priced.usage.cacheReadInputTokens,
    cacheCreationInputTokens: priced.usage.cacheCreationInputTokens,
    reasoningTokens: priced.usage.reasoningTokens,
    providerEstimatedCostUSD,
    billedCostUSD,
    durationMs: safe(usage.durationMs),
    numTurns: safe(usage.numTurns),
    source,
    createdAt,
    models,
    trackBillingUsage: Boolean(user),
    chargeBalance: shouldCharge,
  });

  // The batch above always adds tokens to the daily/monthly quota ledgers,
  // even when the event is billed $0 and deductUsageCost below is skipped.
  // Drop the cached quota verdict so the next pre-turn gate sees them.
  if (result.inserted) invalidateUserBillingCache(options.userId);

  // The wallet mutation already committed atomically in recordUsageEventBatch.
  // This compatibility call emits the existing billing audit/access hooks;
  // only run it for a newly inserted event so replays cannot duplicate audits.
  if (result.inserted && shouldCharge && billedCostUSD > 0) {
    deductUsageCost(
      options.userId,
      providerEstimatedCostUSD,
      eventId,
      effective,
    );
  }

  return {
    eventId,
    inserted: result.inserted,
    providerEstimatedCostUSD,
    billedCostUSD,
  };
}
