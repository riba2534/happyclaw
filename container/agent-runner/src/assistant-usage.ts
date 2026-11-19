import type { ResultUsagePayload } from './result-usage.js';

interface TokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

type InputTokens = Pick<
  TokenSnapshot,
  'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>;

const TOKEN_FIELDS = [
  'inputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'outputTokens',
  'reasoningTokens',
] as const;

/** Present final input fields only: missing is different from an explicit zero. */
function reportedInputTokens(
  usage: Record<string, unknown>,
): Partial<InputTokens> {
  const result: Partial<InputTokens> = {};
  for (const [field, snake] of [
    ['inputTokens', 'input_tokens'],
    ['cacheReadInputTokens', 'cache_read_input_tokens'],
    ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
  ] as const) {
    const values = [usage[snake], usage[field]].filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0,
    );
    if (values.length) result[field] = Math.max(...values);
  }
  return result;
}

export interface CollectedAssistantUsage extends TokenSnapshot {
  id: string;
  model: string;
  /** Size of the selected raw snapshot, before combining its input fields. */
  total: number;
  /** Subagent task ID (SDK 0.3.292+); selects the sidechain transcript. */
  agentId?: string;
  /**
   * The snapshot carries a stop_reason. On a transcript line the call has
   * ended. Claude Code 2.1.296 sets one on a live message only on its
   * non-streaming fallback, which yields the message before counting the
   * call, so it proves nothing about modelUsage there.
   */
  stopped?: boolean;
  /** Input fields explicitly reported by ended Codex assistant snapshots. */
  finalInputTokens?: Partial<InputTokens>;
}

/**
 * Loads final assistant usage snapshots for message IDs from a source of
 * truth (the session transcript, or a subagent's sidechain transcript when
 * `agentId` is given). Returns a map keyed by message ID; missing IDs are
 * simply absent. Must not throw.
 */
export type TranscriptUsageLoader = (
  ids: string[],
  agentId?: string,
) => Map<string, CollectedAssistantUsage>;

export type UsageFlushBoundary = 'result' | 'interrupt' | 'query-end';

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

interface TurnContentFootprint {
  thinkingChars: number;
  otherChars: number;
  seen: Set<string>;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return ['claude', 'sonnet', 'haiku', 'opus'].some((part) =>
    lower.includes(part),
  );
}

/** Kaboo's round-half-up proportional carve, preserving output+reasoning. */
export function splitClaudeOutputTokens(
  thinkingChars: number,
  otherChars: number,
  outputTokens: number,
): number {
  if (outputTokens <= 0 || thinkingChars <= 0) return 0;
  const denominator = thinkingChars + otherChars;
  if (denominator <= 0) return 0;
  return Math.min(
    outputTokens,
    Math.floor(
      (outputTokens * thinkingChars + Math.floor(denominator / 2)) /
        denominator,
    ),
  );
}

function snapshotTotal(value: TokenSnapshot): number {
  return (
    value.inputTokens +
    value.outputTokens +
    value.cacheReadInputTokens +
    value.cacheCreationInputTokens +
    value.reasoningTokens
  );
}

function deductOverlap(tokens: TokenSnapshot, remaining: TokenSnapshot): void {
  for (const field of TOKEN_FIELDS) {
    const taken = Math.min(tokens[field], remaining[field]);
    tokens[field] -= taken;
    remaining[field] -= taken;
  }
  // SDK cumulative output includes thinking that per-message events can split out.
  const thinking = Math.min(tokens.reasoningTokens, remaining.outputTokens);
  tokens.reasoningTokens -= thinking;
  remaining.outputTokens -= thinking;
}

/** Snake_case API usage or the camelCase variant some proxies emit. */
function parseUsageTokens(usage: Record<string, unknown>): TokenSnapshot {
  return {
    inputTokens: Math.max(
      nonNegative(usage.input_tokens),
      nonNegative(usage.inputTokens),
    ),
    outputTokens: Math.max(
      nonNegative(usage.output_tokens),
      nonNegative(usage.outputTokens),
    ),
    cacheReadInputTokens: Math.max(
      nonNegative(usage.cache_read_input_tokens),
      nonNegative(usage.cacheReadInputTokens),
    ),
    cacheCreationInputTokens: Math.max(
      nonNegative(usage.cache_creation_input_tokens),
      nonNegative(usage.cacheCreationInputTokens),
    ),
    reasoningTokens: Math.max(
      nonNegative(usage.reasoning_output_tokens),
      nonNegative(usage.reasoningOutputTokens),
      nonNegative(usage.reasoningTokens),
    ),
  };
}

/**
 * Field-wise maximum. Every source reports the same API call: the live
 * assistant message carries message_start's placeholder output count, while
 * message_delta and the persisted transcript carry the final one.
 */
function maxTokens(
  base: TokenSnapshot,
  ...others: Array<TokenSnapshot | undefined>
): TokenSnapshot {
  const result = { ...base };
  for (const other of others) {
    if (!other) continue;
    result.inputTokens = Math.max(result.inputTokens, other.inputTokens);
    result.outputTokens = Math.max(result.outputTokens, other.outputTokens);
    result.cacheReadInputTokens = Math.max(
      result.cacheReadInputTokens,
      other.cacheReadInputTokens,
    );
    result.cacheCreationInputTokens = Math.max(
      result.cacheCreationInputTokens,
      other.cacheCreationInputTokens,
    );
    result.reasoningTokens = Math.max(
      result.reasoningTokens,
      other.reasoningTokens,
    );
  }
  return result;
}

export function parseAssistantUsage(
  sdkMessage: Record<string, unknown>,
  codex = false,
): CollectedAssistantUsage | undefined {
  if (sdkMessage.type !== 'assistant') return undefined;
  const message = sdkMessage.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!message || !usage) return undefined;
  const id = String(message.id || sdkMessage.uuid || '').trim();
  if (!id) return undefined;
  const value = {
    id,
    model: String(message.model || 'unknown').trim() || 'unknown',
    // Official Anthropic transcript objects use snake_case. Some Agent SDK
    // compatible providers expose the same live object in camelCase and only
    // serialize it to snake_case on disk. Accept both so a valid turn cannot
    // be persisted as a misleading zero-token event.
    ...parseUsageTokens(usage),
  };
  const agentId =
    typeof sdkMessage.agent_id === 'string' && sdkMessage.agent_id.trim()
      ? sdkMessage.agent_id.trim()
      : typeof sdkMessage.agentId === 'string' && sdkMessage.agentId.trim()
        ? sdkMessage.agentId.trim()
        : undefined;
  const stopped =
    typeof message.stop_reason === 'string' && message.stop_reason !== '';
  return {
    ...value,
    total: snapshotTotal(value),
    ...(agentId ? { agentId } : {}),
    ...(stopped ? { stopped } : {}),
    ...(codex && stopped
      ? { finalInputTokens: reportedInputTokens(usage) }
      : {}),
  };
}

/**
 * Keep provisional fields independently. Only an explicit terminal field can
 * lower an input field; output only grows, so the estimate snapshot's
 * placeholder output never replaces the ended snapshot's real count.
 */
export function mergeCodexAssistantUsage(
  previous: CollectedAssistantUsage | undefined,
  current: CollectedAssistantUsage,
): CollectedAssistantUsage {
  if (!previous) return current;
  const best = current.total > previous.total ? current : previous;
  const tokens = {} as TokenSnapshot;
  for (const field of TOKEN_FIELDS)
    tokens[field] = Math.max(current[field], previous[field]);
  return {
    ...best,
    ...tokens,
    agentId: best.agentId ?? current.agentId ?? previous.agentId,
    stopped: current.stopped || previous.stopped,
    finalInputTokens: {
      ...previous.finalInputTokens,
      ...current.finalInputTokens,
    },
  };
}

/**
 * How long one streamed API call spent producing its output: from its
 * message_start to the message_delta that carried its stop_reason. Prefill
 * happens before message_start and tool runs happen between calls, so
 * output tokens over this time is the model's generation speed. Absent for a
 * call that was not streamed or never finished.
 */
export interface StreamGeneration {
  streamOutputTokens?: number;
  streamMs?: number;
}

/**
 * What the calls finished since the last result add up to, for the live
 * display only: the ledger still settles at the result. Each call counts
 * once, when the message_delta with its stop_reason arrives.
 */
export interface UsageProgress {
  calls: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  streamOutputTokens: number;
  streamMs: number;
}

function emptyProgress(): UsageProgress {
  return {
    calls: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    streamOutputTokens: 0,
    streamMs: 0,
  };
}

export interface AssistantUsageBatch {
  eventId: string;
  tokens: Pick<
    ResultUsagePayload,
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreationInputTokens'
    | 'reasoningTokens'
    | 'modelUsage'
  > &
    StreamGeneration;
  /**
   * A message_delta with a stop_reason arrived before the flush. Claude
   * Code 2.1.296 adds the call to modelUsage before it yields that event,
   * so every later result includes it.
   */
  final: boolean;
  /**
   * The call has ended (final, a stopped transcript, or a stopped Codex live assistant).
   * A transcript line can reach disk before Claude Code counts the call
   * (non-streaming fallback) or after it emitted the result being
   * reconciled, so only `final` holds for that result.
   */
  completed: boolean;
}

/**
 * Kaboo-compatible Claude usage collector.
 *
 * Claude assistant messages carry the API-call-local usage snapshot and a
 * stable Anthropic message ID. We keep the largest snapshot for a repeated ID
 * (stream/replay duplicates) and flush each ID at most once per query.
 *
 * The live snapshot is not the bill: Claude Code builds each assistant
 * message from message_start, so its output_tokens is a placeholder (often
 * 1) and the real count arrives later in message_delta and in the persisted
 * transcript. By default a flushed entry takes the field-wise maximum of
 * these sources. Only the explicitly selected Codex gateway overrides input
 * fields with final values: its start count is a whole-prompt estimate.
 */
export class AssistantUsageCollector {
  private readonly bestById = new Map<string, CollectedAssistantUsage>();
  private readonly flushedIds = new Set<string>();
  /** Final usage from stream events, keyed by Anthropic message ID. */
  private readonly streamFinalById = new Map<string, TokenSnapshot>();
  /** Open streamed message per `parent_tool_use_id` scope. */
  private readonly streamIdByScope = new Map<string, string>();
  /** Message IDs whose message_delta with a stop_reason was observed. */
  private readonly finalIds = new Set<string>();
  private readonly contentById = new Map<string, TurnContentFootprint>();
  private readonly streamFinalInputById = new Map<
    string,
    Partial<InputTokens>
  >();
  private readonly codexSubagents = new Set<string>();
  // A cumulative result has no message IDs. Its already emitted tokens can
  // cover only children that were pending without a stream at that result.
  private childResiduals: {
    children: Set<string>;
    remaining: TokenSnapshot;
  }[] = [];
  /** message_start and final message_delta arrival times, by message ID. */
  private readonly streamTimingById = new Map<
    string,
    { startedAt: number; stoppedAt?: number }
  >();

  private progress = emptyProgress();
  private readonly progressIds = new Set<string>();
  private progressChanged = false;

  constructor(
    private readonly options: { codex?: boolean; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The live totals when a call finished since the last read. */
  takeUsageProgress(): UsageProgress | undefined {
    if (!this.progressChanged) return undefined;
    this.progressChanged = false;
    return { ...this.progress };
  }

  /** Start the live totals afresh: the next calls answer the next input. */
  resetUsageProgress(): void {
    this.progress = emptyProgress();
    this.progressIds.clear();
    this.progressChanged = false;
  }

  private countFinishedCall(id: string): void {
    if (this.progressIds.has(id)) return;
    const tokens = this.streamFinalById.get(id);
    if (!tokens) return;
    this.progressIds.add(id);
    const p = this.progress;
    p.calls += 1;
    p.inputTokens += tokens.inputTokens;
    p.cacheReadInputTokens += tokens.cacheReadInputTokens;
    p.cacheCreationInputTokens += tokens.cacheCreationInputTokens;
    p.outputTokens += tokens.outputTokens;
    const timing = this.streamTimingById.get(id);
    const ms =
      timing?.stoppedAt !== undefined ? timing.stoppedAt - timing.startedAt : 0;
    if (ms > 0 && tokens.outputTokens > 0) {
      p.streamOutputTokens += tokens.outputTokens;
      p.streamMs += ms;
    }
    this.progressChanged = true;
  }

  private collectContent(sdkMessage: Record<string, unknown>): void {
    const message = sdkMessage.message as Record<string, unknown> | undefined;
    const id = String(message?.id || sdkMessage.uuid || '').trim();
    if (!message || !id || this.flushedIds.has(id)) return;
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return;
    const footprint = this.contentById.get(id) || {
      thinkingChars: 0,
      otherChars: 0,
      seen: new Set<string>(),
    };
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const part = raw as Record<string, unknown>;
      const type = String(part.type || '');
      let payload = '';
      let payloadSize = 0;
      let target: 'thinking' | 'other' | undefined;
      if (type === 'thinking' && typeof part.thinking === 'string') {
        payload = part.thinking;
        payloadSize = utf8Length(payload);
        target = 'thinking';
      } else if (type === 'text' && typeof part.text === 'string') {
        payload = part.text;
        payloadSize = utf8Length(payload);
        target = 'other';
      } else if (type === 'tool_use') {
        const name = typeof part.name === 'string' ? part.name : '';
        let input = '';
        try {
          input = JSON.stringify(part.input) || '';
        } catch {
          input = '';
        }
        payload = `${name}\0${input}`;
        // Kaboo uses the separator only for dedup identity, not char weight.
        payloadSize = utf8Length(name) + utf8Length(input);
        target = 'other';
      }
      if (!target || !payload) continue;
      const fingerprint = `${target}\0${payload}`;
      if (footprint.seen.has(fingerprint)) continue;
      footprint.seen.add(fingerprint);
      if (target === 'thinking') footprint.thinkingChars += payloadSize;
      else footprint.otherChars += payloadSize;
    }
    this.contentById.set(id, footprint);
  }

  ingest(sdkMessage: Record<string, unknown>): void {
    this.collectContent(sdkMessage);
    const current = parseAssistantUsage(sdkMessage, this.options.codex);
    if (!current || this.flushedIds.has(current.id)) return;
    const previous = this.bestById.get(current.id);
    if (this.options.codex) {
      if (current.agentId || sdkMessage.parent_tool_use_id)
        this.codexSubagents.add(current.id);
      this.bestById.set(
        current.id,
        mergeCodexAssistantUsage(previous, current),
      );
    } else if (!previous || current.total > previous.total) {
      this.bestById.set(current.id, current);
    }
  }

  /**
   * Record the usage carried by a partial-message stream event. message_delta
   * has no message ID, so it is attributed to the message the same scope
   * (main thread or one subagent) most recently started.
   */
  observeStreamEvent(sdkMessage: Record<string, unknown>): void {
    if (sdkMessage.type !== 'stream_event') return;
    const event = sdkMessage.event as Record<string, unknown> | undefined;
    if (!event) return;
    const scope = String(sdkMessage.parent_tool_use_id ?? '');
    let id: string | undefined;
    let usage: unknown;
    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      id = typeof message?.id === 'string' ? message.id.trim() : undefined;
      if (!id) return;
      this.streamIdByScope.set(scope, id);
      if (scope && this.options.codex && !this.flushedIds.has(id))
        this.codexSubagents.add(id);
      if (!this.flushedIds.has(id) && !this.streamTimingById.has(id)) {
        this.streamTimingById.set(id, { startedAt: this.now() });
      }
      usage = message?.usage;
    } else if (event.type === 'message_delta') {
      id = this.streamIdByScope.get(scope);
      usage = event.usage;
      // Claude Code 2.1.296 adds the call to modelUsage while handling a
      // message_delta with a stop_reason, before it yields the event.
      const delta = event.delta as Record<string, unknown> | undefined;
      const stopReason = delta?.stop_reason;
      if (
        id &&
        !this.flushedIds.has(id) &&
        typeof stopReason === 'string' &&
        stopReason !== ''
      ) {
        this.finalIds.add(id);
        const timing = this.streamTimingById.get(id);
        if (timing && timing.stoppedAt === undefined) {
          timing.stoppedAt = this.now();
        }
      }
    }
    if (!id || this.flushedIds.has(id)) return;
    if (!usage || typeof usage !== 'object') return;
    if (
      this.options.codex &&
      event.type === 'message_delta' &&
      this.finalIds.has(id)
    ) {
      this.streamFinalInputById.set(id, {
        ...this.streamFinalInputById.get(id),
        ...reportedInputTokens(usage as Record<string, unknown>),
      });
    }
    const tokens = parseUsageTokens(usage as Record<string, unknown>);
    const previous = this.streamFinalById.get(id);
    this.streamFinalById.set(
      id,
      previous ? maxTokens(previous, tokens) : tokens,
    );
    if (event.type === 'message_delta' && this.finalIds.has(id)) {
      this.countFinishedCall(id);
    }
  }

  drain(
    _sessionId: string | undefined,
    transcriptLoader?: TranscriptUsageLoader,
    boundary: UsageFlushBoundary = 'result',
    deferred?: ReadonlySet<string>,
  ): AssistantUsageBatch | undefined {
    for (const entry of this.bestById.values()) {
      if (this.flushedIds.has(entry.id) || deferred?.has(entry.id)) continue;
      const batch = this.flushIfReady(entry, boundary, transcriptLoader);
      if (batch) return batch;
    }
  }

  *settleCumulativeChildren(
    deferred: ReadonlySet<string>,
    transcriptLoader: TranscriptUsageLoader | undefined,
    remaining: TokenSnapshot | undefined,
  ): Iterable<AssistantUsageBatch> {
    // Later children can use fewer past results. Give them first claim on
    // this delta so an older child can still use its earlier coverage.
    for (const id of [...deferred].reverse()) {
      const entry = this.bestById.get(id);
      if (!entry || this.flushedIds.has(id)) continue;
      const batch = this.flushIfReady(
        entry,
        'result',
        transcriptLoader,
        remaining,
      );
      if (batch) yield batch;
    }
  }

  childrenWithResiduals(): Set<string> | undefined {
    if (!this.childResiduals.length) return undefined;
    // Insertion order is the first result that could have included each child.
    const result = new Set<string>();
    for (const credit of this.childResiduals) {
      for (const id of credit.children) result.add(id);
    }
    return result;
  }

  /**
   * Keep a shared upper bound on what the SDK may already have billed.
   * Do not claim a child ID until we actually settle its own usage.
   *
   * A child with stream events never shares a residual. This relies on its
   * message_delta with a stop_reason arriving before the result that counts
   * it (Claude Code adds the call to modelUsage while handling that event),
   * so the child settles as `final` and the reconciler covers it as pending
   * usage. A delta arriving after that result would bill the child twice:
   * once in the result's residual, once when it settles.
   */
  recordChildResidual(residual: TokenSnapshot): void {
    const children = new Set(
      [...this.codexSubagents].filter((id) => !this.streamFinalById.has(id)),
    );
    if (!children.size || snapshotTotal(residual) === 0) return;
    const last = this.childResiduals.at(-1);
    if (
      last &&
      last.children.size === children.size &&
      [...children].every((id) => last.children.has(id))
    ) {
      for (const field of TOKEN_FIELDS)
        last.remaining[field] += residual[field];
    } else {
      this.childResiduals.push({ children, remaining: { ...residual } });
    }
  }

  private deductChildResiduals(
    id: string,
    tokens: TokenSnapshot,
    currentResidual?: TokenSnapshot,
  ): boolean {
    const total = snapshotTotal(tokens);
    if (currentResidual) deductOverlap(tokens, currentResidual);
    this.childResiduals = this.childResiduals.filter((credit) => {
      if (!credit.children.delete(id)) return true;
      deductOverlap(tokens, credit.remaining);
      return credit.children.size > 0 && snapshotTotal(credit.remaining) > 0;
    });
    return total > 0 && snapshotTotal(tokens) === 0;
  }

  private flushIfReady(
    entry: CollectedAssistantUsage,
    boundary: UsageFlushBoundary,
    transcriptLoader?: TranscriptUsageLoader,
    currentResidual?: TokenSnapshot,
  ): AssistantUsageBatch | undefined {
    const child = this.codexSubagents.has(entry.id);
    if (boundary === 'query-end' && !child) return undefined;
    const transcriptHit = transcriptLoader?.([entry.id], entry.agentId).get(
      entry.id,
    );
    const final = this.finalIds.has(entry.id);
    const completed =
      final ||
      transcriptHit?.stopped === true ||
      (this.options.codex === true && entry.stopped === true);
    // The parent result can precede a child's terminal data. Keep its ID pending.
    // At query-end a still-unfinished Codex child is deliberately left
    // unsettled and dropped with the collector: once Claude Code counts it,
    // the growth of a later cumulative result (through the resume baseline)
    // bills it as residual usage instead.
    if (child && boundary !== 'interrupt' && !completed) return undefined;
    const merged = maxTokens(
      entry,
      this.streamFinalById.get(entry.id),
      transcriptHit,
    );
    if (this.options.codex) {
      // The gateway's start count is an estimate of the whole prompt; its
      // final input count excludes cache and can legitimately be smaller.
      Object.assign(
        merged,
        entry.finalInputTokens,
        transcriptHit?.finalInputTokens,
        this.streamFinalInputById.get(entry.id),
      );
    }
    const timing = this.streamTimingById.get(entry.id);
    const streamMs =
      timing?.stoppedAt !== undefined ? timing.stoppedAt - timing.startedAt : 0;
    // Output tokens before the reasoning split below: thinking is generated
    // at the same speed as text.
    const generation: StreamGeneration =
      streamMs > 0 && merged.outputTokens > 0
        ? { streamOutputTokens: merged.outputTokens, streamMs }
        : {};
    const effective: CollectedAssistantUsage = {
      ...entry,
      ...merged,
      total: snapshotTotal(merged),
    };
    // One stable Anthropic message ID must remain one ledger event. Aggregating
    // several IDs behind the last ID would make resume/fork transcript replays
    // charge the earlier IDs again when a later new message arrives.
    const entries = [effective];

    const modelUsage: NonNullable<ResultUsagePayload['modelUsage']> = {};
    const root: TokenSnapshot = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    };
    for (const entry of entries) {
      this.flushedIds.add(entry.id);
      this.codexSubagents.delete(entry.id);
      this.streamFinalById.delete(entry.id);
      this.streamFinalInputById.delete(entry.id);
      this.finalIds.delete(entry.id);
      this.streamTimingById.delete(entry.id);
      const model = modelUsage[entry.model] || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        costUSD: 0,
      };
      let outputTokens = entry.outputTokens;
      let reasoningTokens = entry.reasoningTokens;
      if (reasoningTokens === 0 && isAnthropicModel(entry.model)) {
        const footprint = this.contentById.get(entry.id);
        if (footprint) {
          reasoningTokens = splitClaudeOutputTokens(
            footprint.thinkingChars,
            footprint.otherChars,
            outputTokens,
          );
          outputTokens -= reasoningTokens;
        }
      }
      model.inputTokens += entry.inputTokens;
      model.outputTokens += outputTokens;
      model.cacheReadInputTokens += entry.cacheReadInputTokens;
      model.cacheCreationInputTokens += entry.cacheCreationInputTokens;
      model.reasoningTokens += reasoningTokens;
      modelUsage[entry.model] = model;
      root.inputTokens += entry.inputTokens;
      root.outputTokens += outputTokens;
      root.cacheReadInputTokens += entry.cacheReadInputTokens;
      root.cacheCreationInputTokens += entry.cacheCreationInputTokens;
      root.reasoningTokens += reasoningTokens;
    }

    if (child && (currentResidual || this.childResiduals.length)) {
      if (this.deductChildResiduals(entry.id, root, currentResidual))
        return undefined;
      Object.assign(modelUsage[entry.model], root);
    }

    // Match Kaboo's cross-file/fork key exactly: Anthropic message IDs (or the
    // UUID fallback parsed above) survive copy-history and must deduplicate even
    // when a fork gets a different SDK session ID.
    return {
      eventId: `claude-code:${entry.id}`,
      tokens: { ...root, modelUsage, ...generation },
      final,
      completed,
    };
  }
}
