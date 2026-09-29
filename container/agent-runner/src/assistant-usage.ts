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
}

/**
 * Loads final assistant usage snapshots for message IDs from a source of
 * truth (the session transcript), used to backfill zero-token stream
 * snapshots. Returns a map keyed by message ID; missing IDs are simply
 * absent. Must not throw.
 */
export type TranscriptUsageLoader = (
  ids: string[],
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
  return {
    ...value,
    total:
      value.inputTokens +
      value.outputTokens +
      value.cacheReadInputTokens +
      value.cacheCreationInputTokens +
      value.reasoningTokens,
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
}

/**
 * Kaboo-compatible Claude usage collector.
 *
 * Claude assistant messages carry the API-call-local usage snapshot and a
 * stable Anthropic message ID. We keep the largest snapshot for a repeated ID
 * (stream/replay duplicates) and flush each ID at most once per query.
 */
export class AssistantUsageCollector {
  private readonly bestById = new Map<string, CollectedAssistantUsage>();
  private readonly flushedIds = new Set<string>();
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
    const previous = this.bestById.get(current.id);
    if (!previous || current.total > previous.total) {
      this.bestById.set(current.id, current);
    }
  }

  drain(
    _sessionId: string | undefined,
    transcriptLoader?: TranscriptUsageLoader,
  ): AssistantUsageBatch | undefined {
    const entry = [...this.bestById.values()].find(
      (entry) => !this.flushedIds.has(entry.id),
    );
    if (!entry) return undefined;
    // Compatible providers (Codex gateway, GLM proxy, ...) only reveal usage
    // when the response completes, so every streamed assistant snapshot starts
    // as the all-zero message_start placeholder and the CLI merges the final
    // numbers into the transcript instead of the live SDK message. A zero
    // snapshot therefore must not be trusted as the final bill: backfill from
    // the transcript when available, then keep the merged reasoning split
    // below working on the enriched snapshot.
    const effective =
      entry.total === 0 && transcriptLoader
        ? (transcriptLoader([entry.id]).get(entry.id) ?? entry)
        : entry;
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
    };
  }
}
