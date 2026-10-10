import type { ResultUsagePayload } from './result-usage.js';

interface TokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export interface CollectedAssistantUsage extends TokenSnapshot {
  id: string;
  model: string;
  total: number;
  /** Subagent task ID (SDK 0.3.292+); selects the sidechain transcript. */
  agentId?: string;
  /**
   * The snapshot carries a stop_reason: Claude Code sets it on the message
   * in the same step that adds the call to modelUsage.
   */
  final?: boolean;
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
  const final =
    typeof message.stop_reason === 'string' && message.stop_reason !== '';
  return {
    ...value,
    total: snapshotTotal(value),
    ...(agentId ? { agentId } : {}),
    ...(final ? { final } : {}),
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
  >;
  /**
   * The call's final usage was known when it was flushed (message_delta, or
   * a stop_reason on the live or transcript message), so Claude Code has
   * already counted it. Otherwise it may still be running.
   */
  final: boolean;
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
 * transcript. Every flushed entry therefore takes the field-wise maximum of
 * the live snapshot, the observed message_delta usage and the transcript.
 */
export class AssistantUsageCollector {
  private readonly bestById = new Map<string, CollectedAssistantUsage>();
  private readonly flushedIds = new Set<string>();
  /** Final usage from stream events, keyed by Anthropic message ID. */
  private readonly streamFinalById = new Map<string, TokenSnapshot>();
  /** Open streamed message per `parent_tool_use_id` scope. */
  private readonly streamIdByScope = new Map<string, string>();
  /** Message IDs whose API call was seen ending before they were flushed. */
  private readonly finalIds = new Set<string>();
  private readonly contentById = new Map<string, TurnContentFootprint>();

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
    const current = parseAssistantUsage(sdkMessage);
    if (!current || this.flushedIds.has(current.id)) return;
    if (current.final) this.finalIds.add(current.id);
    const previous = this.bestById.get(current.id);
    if (!previous || current.total > previous.total) {
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
      }
    }
    if (!id || this.flushedIds.has(id)) return;
    if (!usage || typeof usage !== 'object') return;
    const tokens = parseUsageTokens(usage as Record<string, unknown>);
    const previous = this.streamFinalById.get(id);
    this.streamFinalById.set(
      id,
      previous ? maxTokens(previous, tokens) : tokens,
    );
  }

  drain(
    _sessionId: string | undefined,
    transcriptLoader?: TranscriptUsageLoader,
  ): AssistantUsageBatch | undefined {
    const entry = [...this.bestById.values()].find(
      (entry) => !this.flushedIds.has(entry.id),
    );
    if (!entry) return undefined;
    // The live snapshot carries message_start's placeholder output count
    // (and an all-zero snapshot on providers that report usage only at
    // completion), so merge the final numbers from message_delta and from
    // the main or sidechain transcript before the reasoning split below.
    const transcriptHit = transcriptLoader?.([entry.id], entry.agentId).get(
      entry.id,
    );
    const merged = maxTokens(
      entry,
      this.streamFinalById.get(entry.id),
      transcriptHit,
    );
    const effective: CollectedAssistantUsage = {
      ...entry,
      ...merged,
      total: snapshotTotal(merged),
    };
    const final = this.finalIds.has(entry.id) || transcriptHit?.final === true;
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
      this.streamFinalById.delete(entry.id);
      this.finalIds.delete(entry.id);
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

    // Match Kaboo's cross-file/fork key exactly: Anthropic message IDs (or the
    // UUID fallback parsed above) survive copy-history and must deduplicate even
    // when a fork gets a different SDK session ID.
    return {
      eventId: `claude-code:${entry.id}`,
      tokens: { ...root, modelUsage },
      final,
    };
  }
}
