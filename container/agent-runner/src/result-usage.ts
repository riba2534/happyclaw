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
  version: 2;
  sessionId: string;
  updatedAt: string;
  totalCostUSD: number;
  modelUsage: Record<string, ModelUsageTotals>;
  /**
   * Per-message usage already billed but not yet covered by a reconciled
   * cumulative modelUsage (see ResultUsageReconciler.pending).
   */
  pendingUsage?: PersistedPendingUsage[];
}

export interface PersistedPendingUsage extends ModelUsageTotals {
  model: string;
  idleResults: number;
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
  /**
   * Pending per-message usage given up without coverage: a completed call
   * after MAX_PENDING_IDLE_RESULTS results (Claude Code never counted it,
   * or a gateway labels it under a model modelUsage never reports), a
   * running one after MAX_RUNNING_PENDING_MS.
   */
  droppedPending?: Record<string, ModelUsageTotals>;
}

/**
 * Consecutive results a completed call's pending entry may go uncovered
 * before it is dropped. Claude Code counts such a call by the next result.
 */
export const MAX_PENDING_IDLE_RESULTS = 16;

/**
 * How long a possibly running call stays pending. A background subagent
 * call can span any number of main results, so it is aged by time: one API
 * call (10 minute default request timeout) never lasts an hour.
 */
export const MAX_RUNNING_PENDING_MS = 60 * 60 * 1000;

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

function tokensOnly(value: SdkModelUsage | undefined): ModelUsageTotals {
  return { ...snapshot(value), costUSD: 0 };
}

function hasTokens(value: ModelUsageTotals): boolean {
  return TOKEN_FIELDS.some((field) => value[field] > 0);
}

function addTokens(target: ModelUsageTotals, source: ModelUsageTotals): void {
  for (const field of TOKEN_FIELDS) target[field] += source[field];
}

/**
 * Take `source` out of `target` field by field and leave in `source` what
 * `target` could not cover. modelUsage outputTokens already include
 * thinking, while per-message events carve thinking out into
 * reasoningTokens. Returns whether anything was taken.
 */
function consume(target: ModelUsageTotals, source: ModelUsageTotals): boolean {
  let took = false;
  const subtract = (field: TokenField, amount: number): number => {
    const taken = Math.min(Math.max(0, target[field]), amount);
    if (taken > 0) took = true;
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
  return took;
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
    record.version === 2 &&
    record.sessionId === sessionId &&
    !!record.modelUsage &&
    typeof record.modelUsage === 'object' &&
    (record.pendingUsage === undefined ||
      (Array.isArray(record.pendingUsage) &&
        record.pendingUsage.every(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            typeof entry.model === 'string' &&
            entry.model.length > 0,
        )))
  );
}

/** One billed per-message event (or its uncovered part). */
interface PendingUsage {
  model: string;
  tokens: ModelUsageTotals;
  /**
   * Claude Code counted the call before it emitted the next result, so a
   * reset baseline already holds it.
   */
  final: boolean;
  /**
   * The call has ended, so Claude Code has counted it or is about to; only
   * the result being reconciled may predate that. A call flushed with only
   * its placeholder output may still be running (a background subagent)
   * and reach modelUsage in any later result.
   */
  completed: boolean;
  /** Consecutive results that covered none of it (completed calls). */
  idleResults: number;
  /** When it was recorded (running calls age by time). */
  recordedAt: number;
  /** Recorded since the previous result. */
  fresh: boolean;
}

/**
 * Merge entries that behave identically from here on. Running entries are
 * bucketed per minute and keep their earliest time, so a merge brings an
 * expiry forward by at most a minute.
 */
function coalesce(entries: PendingUsage[]): PendingUsage[] {
  const merged = new Map<string, PendingUsage>();
  for (const entry of entries) {
    if (!hasTokens(entry.tokens)) continue;
    const age = entry.completed
      ? `c${entry.idleResults}`
      : `r${Math.floor(entry.recordedAt / 60_000)}`;
    const key = `${entry.final}\0${age}\0${entry.fresh}\0${entry.model}`;
    const existing = merged.get(key);
    if (existing) {
      addTokens(existing.tokens, entry.tokens);
      existing.recordedAt = Math.min(existing.recordedAt, entry.recordedAt);
    } else merged.set(key, { ...entry, tokens: { ...entry.tokens } });
  }
  return [...merged.values()];
}

export class ResultUsageReconciler {
  private readonly baseline = new Map<string, ModelUsageTotals>();
  private baselineCostUSD = 0;
  private baselineTrusted: boolean;
  /**
   * Per-message tokens already billed that no reconciled cumulative
   * modelUsage covers yet. Claude Code adds an API call to modelUsage only
   * once the call ends, while the runner bills a message as soon as it is
   * flushed: a subagent call can straddle the main result, and a call flushed
   * before close() reaches only the next process's restored totals. Whatever
   * a result's delta does not consume is therefore carried to the next one
   * (and persisted), never silently dropped.
   */
  private pending: PendingUsage[] = [];
  private readonly now: () => number;

  /**
   * @param options.baseline the persisted totals of the session being
   *   resumed, if any.
   * @param options.resumed whether this query resumes a session. A resumed
   *   query without a baseline cannot tell restored history from new spend,
   *   so its first result only establishes the baseline.
   * @param options.now clock for aging running calls (tests).
   */
  constructor(options?: {
    baseline?: PersistedUsageBaseline | null;
    resumed?: boolean;
    now?: () => number;
  }) {
    this.now = options?.now ?? Date.now;
    const baseline = options?.baseline;
    if (baseline) {
      for (const [model, value] of Object.entries(baseline.modelUsage)) {
        this.baseline.set(model, snapshot(value));
      }
      this.baselineCostUSD = nonNegative(baseline.totalCostUSD);
      // The CLI that could still have counted these calls has exited: the
      // restored totals either include them or never will, so for this
      // process they are final.
      for (const entry of baseline.pendingUsage ?? []) {
        const tokens = tokensOnly(entry);
        if (!hasTokens(tokens)) continue;
        this.pending.push({
          model: entry.model,
          tokens,
          final: true,
          completed: true,
          idleResults: Math.min(
            Math.floor(nonNegative(entry.idleResults)),
            MAX_PENDING_IDLE_RESULTS,
          ),
          recordedAt: this.now(),
          fresh: false,
        });
      }
    }
    this.baselineTrusted = !options?.resumed || !!baseline;
  }

  /**
   * Record a per-message usage event that was (or will be) emitted.
   * `final`: Claude Code counted the call before its next result (a
   * message_delta with a stop_reason was seen). `completed`: the call has
   * ended (implied by `final`). Unknown is treated as still running.
   */
  recordAccounted(
    modelUsage: ResultUsagePayload['modelUsage'],
    options?: { final?: boolean; completed?: boolean },
  ): void {
    const final = options?.final ?? false;
    for (const [model, value] of Object.entries(modelUsage ?? {})) {
      const tokens = tokensOnly(value);
      if (!hasTokens(tokens)) continue;
      this.pending.push({
        model,
        tokens,
        final,
        completed: final || (options?.completed ?? false),
        idleResults: 0,
        recordedAt: this.now(),
        fresh: true,
      });
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
    const models = Object.entries(input.modelUsage ?? {});
    if (models.length === 0) return this.applyRootUsage(input);

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

    let residual: ResidualUsage | undefined;
    const covered = new Set<PendingUsage>();
    if (baselineReset) {
      // The new baseline already holds every final call. Any other call may
      // reach modelUsage only after this result, so it stays pending or its
      // accounting would be billed again; a call the baseline did hold costs
      // at most its own size in later under-billing.
      this.pending = this.pending.filter((entry) => !entry.final);
    } else {
      residual = this.consumePending(currentByModel, covered);
    }
    const droppedPending = this.agePending(covered);
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
      ...(droppedPending ? { droppedPending } : {}),
    };
  }

  /** Persistable form of the current baseline and pending usage. */
  toBaseline(sessionId: string): PersistedUsageBaseline {
    // A later process treats every entry as final, so only the model and
    // age distinguish them.
    const persisted = new Map<string, PersistedPendingUsage>();
    for (const entry of this.pending) {
      const key = `${entry.idleResults}\0${entry.model}`;
      const existing = persisted.get(key);
      if (existing) addTokens(existing, entry.tokens);
      else {
        persisted.set(key, {
          model: entry.model,
          ...entry.tokens,
          idleResults: entry.idleResults,
        });
      }
    }
    return {
      version: 2,
      sessionId,
      updatedAt: new Date().toISOString(),
      totalCostUSD: this.baselineCostUSD,
      modelUsage: Object.fromEntries(
        [...this.baseline].map(([model, value]) => [model, { ...value }]),
      ),
      ...(persisted.size > 0 ? { pendingUsage: [...persisted.values()] } : {}),
    };
  }

  /**
   * Whether the sidecar should be written. A resumed query without a
   * baseline does not know the restored totals yet, so it persists nothing
   * until its first result establishes them.
   */
  get shouldPersist(): boolean {
    return (
      this.baselineTrusted &&
      (this.baseline.size > 0 || this.pending.length > 0)
    );
  }

  /** Pending per-message usage per model (tests, logs). */
  get pendingAccounted(): Record<string, ModelUsageTotals> {
    const byModel: Record<string, ModelUsageTotals> = {};
    for (const entry of this.pending) {
      byModel[entry.model] ??= emptyTotals();
      addTokens(byModel[entry.model], entry.tokens);
    }
    return byModel;
  }

  /**
   * Take pending usage out of this result's modelUsage delta and return the
   * remainder. Completed calls have been counted by Claude Code, so if
   * their own model's delta cannot hold them a gateway most likely
   * reported them under another model ID, and they are taken from the other
   * models instead of being billed again there.
   *
   * Running entries stay with their own model. For them an uncovered
   * remainder is the normal straddle; taking it from another model would
   * leave that model's internal usage unbilled and bill the same tokens
   * under this model, at its price, once the call lands. The cost: a
   * running call that a gateway relabels (Haiku requested, Opus reported)
   * is billed under both names, minus whatever later Opus usage its pending
   * entry absorbs before it expires.
   */
  private consumePending(
    currentByModel: Map<string, ModelUsageTotals>,
    covered: Set<PendingUsage>,
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

    const byMatchKey = new Map<string, string>();
    for (const model of remaining.keys()) {
      byMatchKey.set(modelMatchKey(model), model);
    }
    // This result surely holds the final calls flushed for it; carried
    // entries follow oldest first, and calls that may still run come last,
    // so what stays pending (and ages) is what is least likely covered.
    const rank = (entry: PendingUsage) =>
      entry.final && entry.fresh ? 0 : entry.completed ? 1 : 2;
    const ordered = [...this.pending].sort(
      (left, right) => rank(left) - rank(right),
    );
    const elsewhere: PendingUsage[] = [];
    for (const entry of ordered) {
      const target =
        remaining.get(entry.model) ??
        remaining.get(byMatchKey.get(modelMatchKey(entry.model)) ?? '');
      if (!target) {
        // No modelUsage key matches this label at all.
        elsewhere.push(entry);
        continue;
      }
      if (consume(target, entry.tokens)) covered.add(entry);
      if (entry.completed && hasTokens(entry.tokens)) elsewhere.push(entry);
    }
    // Never bill those tokens twice: take them out of the largest remaining
    // buckets.
    for (const entry of elsewhere) {
      const targets = [...remaining.values()].sort(
        (left, right) =>
          right.inputTokens +
          right.outputTokens -
          (left.inputTokens + left.outputTokens),
      );
      for (const target of targets) {
        if (consume(target, entry.tokens)) covered.add(entry);
        if (!hasTokens(entry.tokens)) break;
      }
    }
    this.pending = this.pending.filter((entry) => hasTokens(entry.tokens));

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

  /**
   * Age pending entries after a result. Completed calls count results that
   * did not cover them (only when `covered` comes from a cumulative
   * modelUsage); running calls expire by time.
   */
  private agePending(
    covered: Set<PendingUsage> | undefined,
  ): Record<string, ModelUsageTotals> | undefined {
    const now = this.now();
    const dropped: Record<string, ModelUsageTotals> = {};
    const survivors: PendingUsage[] = [];
    for (const entry of this.pending) {
      entry.fresh = false;
      let expired: boolean;
      if (entry.completed) {
        if (covered) {
          entry.idleResults = covered.has(entry) ? 0 : entry.idleResults + 1;
        }
        expired = entry.idleResults >= MAX_PENDING_IDLE_RESULTS;
      } else {
        expired = now - entry.recordedAt >= MAX_RUNNING_PENDING_MS;
      }
      if (!expired) {
        survivors.push(entry);
        continue;
      }
      dropped[entry.model] ??= emptyTotals();
      addTokens(dropped[entry.model], entry.tokens);
    }
    this.pending = coalesce(survivors);
    return Object.keys(dropped).length > 0 ? dropped : undefined;
  }

  private applyRootUsage(input: {
    usage?: SdkResultUsage;
    fallbackModelKey: string;
  }): ReconciledResultUsage {
    const model = input.fallbackModelKey || 'default';
    let residual: ResidualUsage | undefined;
    if (input.usage) {
      // Root usage is per turn, so it is compared with what this turn
      // flushed rather than differenced against the previous result.
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
      for (const entry of this.pending) {
        if (!entry.fresh) continue;
        const { tokens } = entry;
        root.inputTokens -= tokens.inputTokens;
        root.cacheReadInputTokens -= tokens.cacheReadInputTokens;
        root.cacheCreationInputTokens -= tokens.cacheCreationInputTokens;
        root.outputTokens -= tokens.outputTokens + tokens.reasoningTokens;
      }
      const tokens = emptyTotals();
      for (const field of TOKEN_FIELDS) {
        tokens[field] = Math.max(0, root[field]);
      }
      if (hasTokens(tokens)) {
        residual = {
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cacheReadInputTokens: tokens.cacheReadInputTokens,
          cacheCreationInputTokens: tokens.cacheCreationInputTokens,
          reasoningTokens: tokens.reasoningTokens,
          modelUsage: { [model]: tokens },
        };
      }
    }
    // Root usage is no cumulative total and covers nothing pending, while a
    // later result's modelUsage includes these calls and the remainder
    // billed here. Everything stays pending; only running calls expire, and
    // silently: without modelUsage nothing can bill them a second time.
    if (residual) {
      this.pending.push({
        model,
        tokens: { ...residual.modelUsage[model] },
        final: true,
        completed: true,
        idleResults: 0,
        recordedAt: this.now(),
        fresh: false,
      });
    }
    this.agePending(undefined);
    return { ...(residual ? { residual } : {}), costUSD: 0 };
  }
}
