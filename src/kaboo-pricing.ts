/**
 * Deterministic usage pricing aligned with Kaboo's built-in model_pricing
 * seeds. Prices are USD per million tokens. The SDK-reported dollar cost is
 * intentionally not part of this module's input or output contract.
 *
 * Source of truth:
 * - kaboo/backend/migrations/000002_seed_pricing.up.sql
 * - kaboo/backend/migrations/000030_anthropic_reasoning_shadow_pricing.up.sql
 * - kaboo/backend/migrations/000034_seed_2026_model_prices.up.sql
 * - kaboo/backend/biz/service/pricing.go
 */

export interface KabooTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export interface KabooModelPricing {
  pattern: string;
  displayName: string;
  family: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheCreationPricePerMTok: number;
  reasoningPricePerMTok: number;
}

export interface KabooModelTokenUsage extends Omit<
  KabooTokenUsage,
  'reasoningTokens'
> {
  reasoningTokens?: number;
}

export interface KabooPricedModelUsage extends KabooTokenUsage {
  model: string;
  pricing: KabooModelPricing;
  unroundedCostUSD: number;
  costCents: number;
  costUSD: number;
}

export interface KabooPricedUsage {
  usage: KabooTokenUsage;
  models: KabooPricedModelUsage[];
  unroundedCostUSD: number;
  costCents: number;
  costUSD: number;
}

/** Kaboo's unmatched-model fallback is intentionally Claude Sonnet-class. */
export const KABOO_SONNET_FALLBACK: KabooModelPricing = Object.freeze({
  pattern: '',
  displayName: 'Claude Sonnet fallback',
  family: 'anthropic',
  inputPricePerMTok: 3,
  outputPricePerMTok: 15,
  cacheReadPricePerMTok: 0.3,
  cacheCreationPricePerMTok: 3.75,
  reasoningPricePerMTok: 15,
});

const price = (
  pattern: string,
  displayName: string,
  family: string,
  inputPricePerMTok: number,
  outputPricePerMTok: number,
  cacheReadPricePerMTok: number,
  cacheCreationPricePerMTok: number,
  reasoningPricePerMTok: number,
): KabooModelPricing => ({
  pattern,
  displayName,
  family,
  inputPricePerMTok,
  outputPricePerMTok,
  cacheReadPricePerMTok,
  cacheCreationPricePerMTok,
  reasoningPricePerMTok,
});

/**
 * Kaboo's complete built-in Claude pricing after migrations 000002, 000030
 * and 000034. Other providers intentionally use Kaboo's Sonnet-class fallback
 * until their tables can be versioned and verified independently.
 */
export const KABOO_MODEL_PRICING: readonly KabooModelPricing[] = Object.freeze([
  // Anthropic legacy/broad rules. Migration 000030 prices reasoning as output;
  // migration 000034 prices cache writes at 1.25x input.
  price(
    'claude-3-5-sonnet%',
    'Claude 3.5 Sonnet',
    'anthropic',
    3,
    15,
    0.3,
    3.75,
    15,
  ),
  price(
    'claude-3-5-haiku%',
    'Claude 3.5 Haiku',
    'anthropic',
    0.8,
    4,
    0.08,
    1,
    4,
  ),
  price('claude-3-opus%', 'Claude 3 Opus', 'anthropic', 15, 75, 1.5, 18.75, 75),
  price(
    'claude-sonnet-4%',
    'Claude Sonnet 4',
    'anthropic',
    3,
    15,
    0.3,
    3.75,
    15,
  ),
  price('claude-opus-4%', 'Claude Opus 4', 'anthropic', 15, 75, 1.5, 18.75, 75),
  price('claude-haiku-4%', 'Claude Haiku 4', 'anthropic', 1, 5, 0.1, 1.25, 5),

  // 2026 Claude generations. Longest matching pattern overrides broad rules.
  price(
    'claude-opus-4-5%',
    'Claude Opus 4.5',
    'anthropic',
    5,
    25,
    0.5,
    6.25,
    25,
  ),
  price(
    'claude-opus-4-6%',
    'Claude Opus 4.6',
    'anthropic',
    5,
    25,
    0.5,
    6.25,
    25,
  ),
  price(
    'claude-opus-4-7%',
    'Claude Opus 4.7',
    'anthropic',
    5,
    25,
    0.5,
    6.25,
    25,
  ),
  price(
    'claude-opus-4-8%',
    'Claude Opus 4.8',
    'anthropic',
    5,
    25,
    0.5,
    6.25,
    25,
  ),
  price(
    'claude-sonnet-4-5%',
    'Claude Sonnet 4.5',
    'anthropic',
    3,
    15,
    0.3,
    3.75,
    15,
  ),
  price(
    'claude-sonnet-4-6%',
    'Claude Sonnet 4.6',
    'anthropic',
    3,
    15,
    0.3,
    3.75,
    15,
  ),
  price(
    'claude-haiku-4-5%',
    'Claude Haiku 4.5',
    'anthropic',
    1,
    5,
    0.1,
    1.25,
    5,
  ),
  // Claude 5 generation. Fable 5.1 keeps Fable 5's $10/$50 in/out but cuts
  // cache reads 75% to $0.25/MTok; cache writes follow the 1.25x-input rule
  // and reasoning is billed as output.
  price('claude-fable-5%', 'Claude Fable 5', 'anthropic', 10, 50, 1, 12.5, 50),
  price(
    'claude-fable-5-1%',
    'Claude Fable 5.1',
    'anthropic',
    10,
    50,
    0.25,
    12.5,
    50,
  ),
  price('claude-opus-5%', 'Claude Opus 5', 'anthropic', 5, 25, 0.5, 6.25, 25),
  price('claude-opus-5-5%', 'Claude Opus 5.5', 'anthropic', 4, 20, 0.2, 5, 20),
  price(
    'claude-sonnet-5%',
    'Claude Sonnet 5',
    'anthropic',
    2,
    10,
    0.2,
    2.5,
    10,
  ),
  price(
    'claude-sonnet-5-5%',
    'Claude Sonnet 5.5',
    'anthropic',
    2,
    10,
    0.1,
    2.5,
    10,
  ),
]);

const TOKEN_FIELDS: readonly (keyof KabooTokenUsage)[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningTokens',
];

/** Token counts are int64 in Kaboo; JS inputs are clamped to safe integers. */
export function normalizeKabooTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

export function normalizeKabooTokenUsage(
  usage: Partial<KabooTokenUsage>,
): KabooTokenUsage {
  return {
    inputTokens: normalizeKabooTokenCount(usage.inputTokens),
    outputTokens: normalizeKabooTokenCount(usage.outputTokens),
    cacheReadInputTokens: normalizeKabooTokenCount(usage.cacheReadInputTokens),
    cacheCreationInputTokens: normalizeKabooTokenCount(
      usage.cacheCreationInputTokens,
    ),
    reasoningTokens: normalizeKabooTokenCount(usage.reasoningTokens),
  };
}

/** Kaboo matching: case-insensitive substring, trailing '%' ignored, longest wins. */
export function matchKabooModelPricing(
  modelName: string,
): KabooModelPricing | undefined {
  const lower = String(modelName || '').toLowerCase();
  let matched: KabooModelPricing | undefined;
  let bestLength = 0;
  for (const candidate of KABOO_MODEL_PRICING) {
    const pattern = candidate.pattern.toLowerCase().replace(/%+$/, '');
    if (pattern.length > bestLength && lower.includes(pattern)) {
      matched = candidate;
      bestLength = pattern.length;
    }
  }
  return matched;
}

/** Return the five-category model cost before applying any rounding boundary. */
export function estimateKabooModelCostUSD(
  modelName: string,
  rawUsage: Partial<KabooTokenUsage>,
): number {
  const usage = normalizeKabooTokenUsage(rawUsage);
  const pricing = matchKabooModelPricing(modelName) ?? KABOO_SONNET_FALLBACK;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPricePerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPricePerMTok +
    (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPricePerMTok +
    (usage.cacheCreationInputTokens / 1_000_000) *
      pricing.cacheCreationPricePerMTok +
    (usage.reasoningTokens / 1_000_000) * pricing.reasoningPricePerMTok
  );
}

export function estimateKabooModelCostCents(
  modelName: string,
  rawUsage: Partial<KabooTokenUsage>,
): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round(estimateKabooModelCostUSD(modelName, rawUsage) * 100),
  );
}

/** Convert only after cent rounding so storage and billing share one boundary. */
export function kabooCostCentsToUSD(costCents: number): number {
  const normalized = normalizeKabooTokenCount(costCents);
  return normalized / 100;
}

/**
 * Price one logical event. Claude SDK modelUsage is the normal token source of
 * truth: when present, the event root is rebuilt from its sanitized model rows.
 * The result-level root is used only when modelUsage is absent, in which case
 * it is attributed to `unknown`. Thus event, model, quota and billing ledgers
 * always share the exact same token basis without truncating valid model rows.
 */
export function priceKabooUsageByModel(
  rootUsage: Partial<KabooTokenUsage>,
  rawModelUsage?: Record<string, KabooModelTokenUsage>,
): KabooPricedUsage {
  const merged = new Map<string, KabooTokenUsage>();
  for (const [rawModel, rawTokens] of Object.entries(rawModelUsage || {})) {
    const model = rawModel.trim() || 'unknown';
    const current = merged.get(model) ?? normalizeKabooTokenUsage({});
    const next = normalizeKabooTokenUsage(rawTokens);
    for (const field of TOKEN_FIELDS) {
      current[field] = normalizeKabooTokenCount(current[field] + next[field]);
    }
    merged.set(model, current);
  }

  if (merged.size === 0) {
    merged.set('unknown', normalizeKabooTokenUsage(rootUsage));
  }
  const names = [...merged.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const reconciled = names.map((model) => ({
    model,
    usage: { ...merged.get(model)! },
  }));
  const usage = normalizeKabooTokenUsage({});
  for (const row of reconciled) {
    for (const field of TOKEN_FIELDS) {
      usage[field] = normalizeKabooTokenCount(usage[field] + row.usage[field]);
    }
  }

  const models = reconciled.map<KabooPricedModelUsage>((row) => {
    const pricing = matchKabooModelPricing(row.model) ?? KABOO_SONNET_FALLBACK;
    const unroundedCostUSD = estimateKabooModelCostUSD(row.model, row.usage);
    const costCents = estimateKabooModelCostCents(row.model, row.usage);
    return {
      model: row.model,
      ...row.usage,
      pricing,
      unroundedCostUSD,
      costCents,
      costUSD: kabooCostCentsToUSD(costCents),
    };
  });
  const unroundedCostUSD = models.reduce(
    (sum, model) => sum + model.unroundedCostUSD,
    0,
  );
  const costCents = normalizeKabooTokenCount(
    models.reduce((sum, model) => sum + model.costCents, 0),
  );
  return {
    usage,
    models,
    unroundedCostUSD,
    costCents,
    costUSD: kabooCostCentsToUSD(costCents),
  };
}
