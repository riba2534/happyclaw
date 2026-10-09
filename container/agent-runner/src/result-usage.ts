/**
 * Claude Agent SDK result usage reconciliation.
 *
 * Scopes in Agent SDK 0.3.296 / Claude Code 2.1.296 (verified against a mock
 * provider):
 * - `usage` covers only the current turn's main agent loop;
 * - `modelUsage` and `total_cost_usd` are cumulative for the session: they
 *   grow across the turns of one streaming query and a resumed query starts
 *   from the totals the transcript saved, so its first result already
 *   carries every earlier turn;
 * - `modelUsage` is the only field that also covers subagents and internal
 *   calls (session titles, compaction, WebFetch summaries, subagent progress
 *   summaries).
 *
 * Per-message assistant usage stays the primary, Kaboo-compatible ledger.
 * This reconciler turns each result's cumulative modelUsage into a delta
 * against a baseline, subtracts what the per-message events already
 * accounted, and reports the remainder as a separate internal usage event.
 * The baseline is persisted per session so a resumed process does not bill
 * the restored history again.
 */

export interface SdkResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface SdkModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  costUSD?: number;
}

export interface ResultUsagePayload {
  eventId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
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
      reasoningTokens: number;
      costUSD: number;
    }
  >;
}

export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  costUSD: number;
}

/** On-disk resume baseline, one file per Claude session. */
export interface PersistedUsageBaseline {
  version: 1;
  sessionId: string;
  updatedAt: string;
  totalCostUSD: number;
  modelUsage: Record<string, ModelUsageTotals>;
}

/** Tokens that were not billed by a per-message event. */
export type ResidualUsage = Pick<
  ResultUsagePayload,
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheCreationInputTokens'
  | 'reasoningTokens'
> & { modelUsage: NonNullable<ResultUsagePayload['modelUsage']> };

export interface ReconciledResultUsage {
  residual?: ResidualUsage;
  /** total_cost_usd growth since the baseline; 0 when it is not trusted. */
  costUSD: number;
  /** Why no modelUsage delta was trusted for this result, if so. */
  baselineReset?: 'initial_resume' | 'decrease';
}

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningTokens',
] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function emptyTotals(): ModelUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
  };
}

function snapshot(value: SdkModelUsage | undefined): ModelUsageTotals {
  return {
    inputTokens: nonNegative(value?.inputTokens),
    outputTokens: nonNegative(value?.outputTokens),
    cacheReadInputTokens: nonNegative(value?.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegative(value?.cacheCreationInputTokens),
    reasoningTokens: nonNegative(value?.reasoningTokens),
    costUSD: nonNegative(value?.costUSD),
  };
}

function hasTokens(value: ModelUsageTotals): boolean {
  return TOKEN_FIELDS.some((field) => value[field] > 0);
}

/** Bare model name for matching `claude-x[1m]` / `Claude-X` spellings. */
function modelMatchKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/(\[1m\])+$/, '');
}

export function isPersistedUsageBaseline(
  value: unknown,
  sessionId: string,
): value is PersistedUsageBaseline {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PersistedUsageBaseline>;
  return (
    record.version === 1 &&
    record.sessionId === sessionId &&
    !!record.modelUsage &&
    typeof record.modelUsage === 'object'
  );
}

export class ResultUsageReconciler {
  private readonly baseline = new Map<string, ModelUsageTotals>();
  private baselineCostUSD = 0;
  private baselineTrusted: boolean;
  /** Per-message tokens billed since the last reconciled result. */
  private readonly accounted = new Map<string, ModelUsageTotals>();

  /**
   * @param options.baseline the persisted totals of the session being
   *   resumed, if any.
   * @param options.resumed whether this query resumes a session. A resumed
   *   query without a baseline cannot tell restored history from new spend,
   *   so its first result only establishes the baseline.
   */
  constructor(options?: {
    baseline?: PersistedUsageBaseline | null;
    resumed?: boolean;
  }) {
    const baseline = options?.baseline;
    if (baseline) {
      for (const [model, value] of Object.entries(baseline.modelUsage)) {
        this.baseline.set(model, snapshot(value));
      }
      this.baselineCostUSD = nonNegative(baseline.totalCostUSD);
    }
    this.baselineTrusted = !options?.resumed || !!baseline;
  }

  /** Record a per-message usage event that was (or will be) emitted. */
  recordAccounted(modelUsage: ResultUsagePayload['modelUsage']): void {
    for (const [model, value] of Object.entries(modelUsage ?? {})) {
      const current = this.accounted.get(model) ?? emptyTotals();
      for (const field of TOKEN_FIELDS) {
        current[field] += nonNegative(value[field]);
      }
      this.accounted.set(model, current);
    }
  }

  /**
   * Apply one SDK result and return the usage that no per-message event
   * accounted for. With modelUsage this is the internal-call remainder;
   * without it (some compatible providers) the per-turn root `usage` is the
   * only authority and is compared directly, never differenced.
   */
  applyResult(input: {
    usage?: SdkResultUsage;
    totalCostUSD?: number;
    modelUsage?: Record<string, SdkModelUsage>;
    fallbackModelKey: string;
  }): ReconciledResultUsage {
    const accounted = new Map(this.accounted);
    this.accounted.clear();
    const models = Object.entries(input.modelUsage ?? {});
    if (models.length === 0) {
      return this.applyRootUsage(input, accounted);
    }

    const totalCostUSD = nonNegative(input.totalCostUSD);
    const currentByModel = new Map(
      models.map(([model, value]) => [model, snapshot(value)] as const),
    );
    let baselineReset: ReconciledResultUsage['baselineReset'];
    if (!this.baselineTrusted) {
      baselineReset = 'initial_resume';
    } else {
      for (const [model, current] of currentByModel) {
        const previous = this.baseline.get(model);
        if (
          previous &&
          (TOKEN_FIELDS.some((field) => current[field] < previous[field]) ||
            current.costUSD < previous.costUSD)
        ) {
          // A cumulative counter only shrinks when the restored totals are
          // older than our baseline (a stale sidecar, or a CLI that lost its
          // totals). Re-baseline instead of billing the whole cumulative
          // value: per-message events remain the lower bound.
          baselineReset = 'decrease';
          break;
        }
      }
    }
    const costUSD =
      baselineReset || totalCostUSD < this.baselineCostUSD
        ? 0
        : totalCostUSD - this.baselineCostUSD;

    const residual = baselineReset
      ? undefined
      : this.residualFor(currentByModel, accounted);
    this.baseline.clear();
    for (const [model, current] of currentByModel) {
      this.baseline.set(model, current);
    }
    this.baselineCostUSD = totalCostUSD;
    this.baselineTrusted = true;
    return {
      ...(residual ? { residual } : {}),
      costUSD,
      ...(baselineReset ? { baselineReset } : {}),
    };
  }

  /** Persistable form of the current baseline. */
  toBaseline(sessionId: string): PersistedUsageBaseline {
    return {
      version: 1,
      sessionId,
      updatedAt: new Date().toISOString(),
      totalCostUSD: this.baselineCostUSD,
      modelUsage: Object.fromEntries(
        [...this.baseline].map(([model, value]) => [model, { ...value }]),
      ),
    };
  }

  get hasBaseline(): boolean {
    return this.baseline.size > 0;
  }

  private residualFor(
    currentByModel: Map<string, ModelUsageTotals>,
    accounted: Map<string, ModelUsageTotals>,
  ): ResidualUsage | undefined {
    const remaining = new Map<string, ModelUsageTotals>();
    for (const [model, current] of currentByModel) {
      const previous = this.baseline.get(model) ?? emptyTotals();
      const delta = emptyTotals();
      for (const field of TOKEN_FIELDS) {
        delta[field] = current[field] - previous[field];
      }
      delta.costUSD = current.costUSD - previous.costUSD;
      remaining.set(model, delta);
    }

    // modelUsage outputTokens already include thinking, while per-message
    // events carve thinking out into reasoningTokens.
    const consume = (
      target: ModelUsageTotals,
      source: ModelUsageTotals,
    ): void => {
      const subtract = (field: TokenField, amount: number): number => {
        const taken = Math.min(target[field], amount);
        target[field] -= taken;
        return amount - taken;
      };
      for (const field of [
        'inputTokens',
        'cacheReadInputTokens',
        'cacheCreationInputTokens',
      ] as const) {
        source[field] = subtract(field, source[field]);
      }
      source.outputTokens = subtract(
        'outputTokens',
        source.outputTokens + source.reasoningTokens,
      );
      source.reasoningTokens = 0;
    };

    const byMatchKey = new Map<string, string>();
    for (const model of remaining.keys()) {
      byMatchKey.set(modelMatchKey(model), model);
    }
    const unmatched: ModelUsageTotals[] = [];
    for (const [model, value] of accounted) {
      const source = { ...value };
      const target =
        remaining.get(model) ??
        remaining.get(byMatchKey.get(modelMatchKey(model)) ?? '');
      if (target) consume(target, source);
      if (hasTokens(source)) unmatched.push(source);
    }
    // A proxy may answer under another model ID than the one modelUsage is
    // keyed by. Never bill those tokens twice: take them out of the largest
    // remaining buckets.
    for (const source of unmatched) {
      const targets = [...remaining.values()].sort(
        (left, right) =>
          right.inputTokens +
          right.outputTokens -
          (left.inputTokens + left.outputTokens),
      );
      for (const target of targets) {
        consume(target, source);
        if (!hasTokens(source)) break;
      }
    }

    const residual: ResidualUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      modelUsage: {},
    };
    for (const [model, value] of remaining) {
      const tokens = emptyTotals();
      for (const field of TOKEN_FIELDS) {
        tokens[field] = Math.max(0, value[field]);
      }
      if (!hasTokens(tokens)) continue;
      residual.modelUsage[model] = {
        ...tokens,
        costUSD: Math.max(0, value.costUSD),
      };
      for (const field of TOKEN_FIELDS) residual[field] += tokens[field];
    }
    return Object.keys(residual.modelUsage).length > 0 ? residual : undefined;
  }

  private applyRootUsage(
    input: { usage?: SdkResultUsage; fallbackModelKey: string },
    accounted: Map<string, ModelUsageTotals>,
  ): ReconciledResultUsage {
    if (!input.usage) return { costUSD: 0 };
    // Root usage is per turn, so it is compared with what this turn already
    // accounted rather than differenced against the previous result.
    const root = {
      ...emptyTotals(),
      inputTokens: nonNegative(input.usage.input_tokens),
      outputTokens: nonNegative(input.usage.output_tokens),
      cacheReadInputTokens: nonNegative(input.usage.cache_read_input_tokens),
      cacheCreationInputTokens: nonNegative(
        input.usage.cache_creation_input_tokens,
      ),
      reasoningTokens: nonNegative(input.usage.reasoning_output_tokens),
    };
    const remaining = new Map([[input.fallbackModelKey || 'default', root]]);
    const residual = this.residualForRoot(remaining, accounted);
    return { ...(residual ? { residual } : {}), costUSD: 0 };
  }

  private residualForRoot(
    remaining: Map<string, ModelUsageTotals>,
    accounted: Map<string, ModelUsageTotals>,
  ): ResidualUsage | undefined {
    const [model, root] = [...remaining][0];
    for (const value of accounted.values()) {
      root.inputTokens -= value.inputTokens;
      root.cacheReadInputTokens -= value.cacheReadInputTokens;
      root.cacheCreationInputTokens -= value.cacheCreationInputTokens;
      root.outputTokens -= value.outputTokens + value.reasoningTokens;
    }
    const tokens = emptyTotals();
    for (const field of TOKEN_FIELDS) tokens[field] = Math.max(0, root[field]);
    if (!hasTokens(tokens)) return undefined;
    return {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadInputTokens: tokens.cacheReadInputTokens,
      cacheCreationInputTokens: tokens.cacheCreationInputTokens,
      reasoningTokens: tokens.reasoningTokens,
      modelUsage: { [model]: tokens },
    };
  }
}
