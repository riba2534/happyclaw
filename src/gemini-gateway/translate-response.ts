// ─── Gemini 订阅网关 — Antigravity 响应 → Anthropic Messages ──────
//
// 上游是 SSE 的 `data: {"response":{...}}` 分片（没有 [DONE]）。这里把它
// 翻译成 Anthropic 的 message_start / content_block_* / message_delta /
// message_stop 事件序列，同一套事件再折叠成非流式响应。
//
// 函数调用的 thoughtSignature 必须原样带回历史，因此作为 thinking 块的
// signature 载体发出（见 signature.ts）。

import {
  encodeSignatureCarrier,
  geminiToolUseId,
  rememberToolSignature,
} from './signature.js';
import { sanitizeFunctionName } from './translate-request.js';

export interface AnthropicStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type AnthropicMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface AnthropicMessagePayload {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicMessageBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

interface GeminiFunctionCall {
  name?: string;
  args?: unknown;
  id?: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  responseId?: string;
  modelVersion?: string;
}

interface GeminiChunk {
  response?: GeminiResponseBody;
  error?: { code?: number; message?: string; status?: string };
}

type BlockKind = 'text' | 'thinking' | 'tool_use';

interface OpenBlock {
  index: number;
  kind: BlockKind;
  signature: string | null;
}

const STOP_REASON_MAP: Record<string, string> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  MALFORMED_FUNCTION_CALL: 'tool_use',
  SAFETY: 'end_turn',
  RECITATION: 'end_turn',
  BLOCKLIST: 'end_turn',
  PROHIBITED_CONTENT: 'end_turn',
  SPII: 'end_turn',
  OTHER: 'end_turn',
};

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

export interface TranslatorOptions {
  model: string;
  messageId: string;
  reverseToolNameMap: Map<string, string>;
  /** 事件出口；SSE 模式直接写网络，非流式模式收集后折叠。 */
  onEvent: (event: AnthropicStreamEvent) => void;
}

/**
 * 状态机：逐块接收上游分片，产出 Anthropic 事件。
 * 调用方在 HTTP 流结束时必须调用 `finalize()`。
 */
export class GeminiStreamTranslator {
  private readonly model: string;
  private readonly messageId: string;
  private readonly reverseToolNameMap: Map<string, string>;
  private readonly onEvent: (event: AnthropicStreamEvent) => void;

  private started = false;
  private finished = false;
  private nextBlockIndex = 0;
  private open: OpenBlock | null = null;
  private sawToolUse = false;
  private finishReason: string | null = null;
  private blockedReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private toolSequence = 0;

  constructor(options: TranslatorOptions) {
    this.model = options.model;
    this.messageId = options.messageId;
    this.reverseToolNameMap = options.reverseToolNameMap;
    this.onEvent = options.onEvent;
  }

  ingest(chunk: unknown): void {
    if (this.finished) return;
    const parsed = chunk as GeminiChunk | null;
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.error) {
      const message =
        typeof parsed.error.message === 'string'
          ? parsed.error.message
          : 'Gemini upstream error';
      this.emitError(message.slice(0, 600));
      return;
    }

    const body = parsed.response;
    if (!body) return;
    this.ensureStarted();

    if (typeof body.responseId === 'string' && body.responseId) {
      // Keep upstream correlation id only for logs; the Anthropic id is stable.
    }

    const usage = body.usageMetadata;
    if (usage) {
      this.inputTokens =
        numberOrZero(usage.promptTokenCount) || this.inputTokens;
      this.cacheReadTokens =
        numberOrZero(usage.cachedContentTokenCount) || this.cacheReadTokens;
      this.outputTokens =
        numberOrZero(usage.candidatesTokenCount) +
        numberOrZero(usage.thoughtsTokenCount);
    }

    const blockReason = body.promptFeedback?.blockReason;
    if (typeof blockReason === 'string' && blockReason) {
      this.blockedReason = blockReason;
    }

    for (const candidate of body.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        this.handlePart(part);
      }
      if (
        typeof candidate.finishReason === 'string' &&
        candidate.finishReason
      ) {
        this.finishReason = candidate.finishReason;
      }
    }
  }

  finalize(): void {
    if (this.finished) return;
    this.ensureStarted();
    if (this.open) this.closeBlock();
    if (this.blockedReason && this.nextBlockIndex === 0) {
      this.startBlock('text');
      this.textDelta(`[Gemini 拒绝了这次请求：${this.blockedReason}]`);
      this.closeBlock();
    }
    this.finished = true;
    let stopReason = STOP_REASON_MAP[this.finishReason ?? 'STOP'] ?? 'end_turn';
    if (this.sawToolUse) stopReason = 'tool_use';
    this.onEvent({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          output_tokens: this.outputTokens,
          input_tokens: this.inputTokens,
          cache_read_input_tokens: this.cacheReadTokens,
        },
      },
    });
    this.onEvent({ event: 'message_stop', data: { type: 'message_stop' } });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.onEvent({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    });
  }

  private handlePart(part: GeminiPart): void {
    if (!part || typeof part !== 'object') return;

    if (part.functionCall) {
      this.handleFunctionCall(part);
      return;
    }
    if (typeof part.text === 'string') {
      if (part.thought === true) {
        this.ensureBlock('thinking');
        if (part.thoughtSignature) this.open!.signature = part.thoughtSignature;
        if (part.text) this.thinkingDelta(part.text);
      } else {
        this.ensureBlock('text');
        if (part.text) this.textDelta(part.text);
      }
    }
  }

  private handleFunctionCall(part: GeminiPart): void {
    const call = part.functionCall!;
    const upstreamName =
      typeof call.name === 'string' && call.name ? call.name : 'unknown_tool';
    const name =
      this.reverseToolNameMap.get(upstreamName) ??
      sanitizeFunctionName(upstreamName, new Set());
    // A finished text/thinking block must be closed before the tool block.
    if (this.open) this.closeBlock();

    const callId =
      typeof call.id === 'string' && call.id
        ? call.id
        : `call_${this.toolSequence}`;
    this.toolSequence += 1;
    const toolUseId = geminiToolUseId(callId, upstreamName);

    if (part.thoughtSignature) {
      // Carrier thinking block so the signature survives the next request.
      this.startBlock('thinking');
      this.onEvent({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.open!.index,
          delta: {
            type: 'signature_delta',
            signature: encodeSignatureCarrier({
              signature: part.thoughtSignature,
              kind: 'tool',
              callId,
            }),
          },
        },
      });
      this.closeBlock();
      rememberToolSignature(toolUseId, {
        signature: part.thoughtSignature,
        callId,
        name: upstreamName,
      });
    }

    // Tool blocks are opened here: startBlock() skips the wire event because
    // the block shape (id/name) is only known at this point.
    this.startBlock('tool_use');
    this.onEvent({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: this.open!.index,
        content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
      },
    });
    this.onEvent({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.open!.index,
        delta: {
          type: 'input_json_delta',
          partial_json: safeJsonStringify(call.args ?? {}),
        },
      },
    });
    this.closeBlock();
    this.sawToolUse = true;
  }

  private ensureBlock(kind: BlockKind): void {
    if (this.open?.kind === kind) return;
    if (this.open) this.closeBlock();
    this.startBlock(kind);
  }

  private startBlock(kind: BlockKind): void {
    const index = this.nextBlockIndex;
    this.nextBlockIndex += 1;
    this.open = { index, kind, signature: null };
    if (kind === 'tool_use') return; // emitted by handleFunctionCall
    const contentBlock =
      kind === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' };
    this.onEvent({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: contentBlock },
    });
  }

  private textDelta(text: string): void {
    if (!this.open || this.open.kind !== 'text') return;
    this.onEvent({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.open.index,
        delta: { type: 'text_delta', text },
      },
    });
  }

  private thinkingDelta(text: string): void {
    if (!this.open || this.open.kind !== 'thinking') return;
    this.onEvent({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.open.index,
        delta: { type: 'thinking_delta', thinking: text },
      },
    });
  }

  private closeBlock(): void {
    const block = this.open;
    if (!block) return;
    if (block.kind === 'thinking' && block.signature) {
      this.onEvent({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: block.index,
          delta: {
            type: 'signature_delta',
            signature: encodeSignatureCarrier({
              signature: block.signature,
              kind: 'text',
            }),
          },
        },
      });
    }
    this.onEvent({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: block.index },
    });
    this.open = null;
  }

  private emitError(message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.onEvent({
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'api_error', message },
      },
    });
  }
}

/** 把 Anthropic 事件序列折叠成完整消息（非流式响应）。 */
export function foldAnthropicEvents(
  events: AnthropicStreamEvent[],
  fallback: { model: string; messageId: string },
): AnthropicMessagePayload {
  const message: AnthropicMessagePayload = {
    id: fallback.messageId,
    type: 'message',
    role: 'assistant',
    model: fallback.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
  const toolBuffers = new Map<number, string>();

  for (const { event, data } of events) {
    if (event === 'message_start') {
      const usage = (
        data.message as { usage?: Partial<AnthropicUsage> } | undefined
      )?.usage;
      if (usage) {
        message.usage.input_tokens = numberOrZero(usage.input_tokens);
        message.usage.cache_read_input_tokens = numberOrZero(
          usage.cache_read_input_tokens,
        );
      }
      continue;
    }
    if (event === 'content_block_start') {
      const index = numberOrZero(data.index);
      const block = data.content_block as Record<string, unknown> | undefined;
      const type = typeof block?.type === 'string' ? block.type : 'text';
      if (type === 'tool_use') {
        message.content[index] = {
          type: 'tool_use',
          id: typeof block?.id === 'string' ? block.id : '',
          name: typeof block?.name === 'string' ? block.name : '',
          input: {},
        };
        toolBuffers.set(index, '');
      } else if (type === 'thinking') {
        message.content[index] = { type: 'thinking', thinking: '' };
      } else {
        message.content[index] = { type: 'text', text: '' };
      }
      continue;
    }
    if (event === 'content_block_delta') {
      const index = numberOrZero(data.index);
      const delta = data.delta as Record<string, unknown> | undefined;
      const target = message.content[index];
      if (!delta || !target) continue;
      if (delta.type === 'text_delta' && target.type === 'text') {
        target.text += typeof delta.text === 'string' ? delta.text : '';
      } else if (
        delta.type === 'thinking_delta' &&
        target.type === 'thinking'
      ) {
        target.thinking +=
          typeof delta.thinking === 'string' ? delta.thinking : '';
      } else if (
        delta.type === 'signature_delta' &&
        target.type === 'thinking' &&
        typeof delta.signature === 'string'
      ) {
        target.signature = delta.signature;
      } else if (delta.type === 'input_json_delta') {
        toolBuffers.set(
          index,
          (toolBuffers.get(index) ?? '') +
            (typeof delta.partial_json === 'string' ? delta.partial_json : ''),
        );
      }
      continue;
    }
    if (event === 'message_delta') {
      const delta = data.delta as { stop_reason?: unknown } | undefined;
      if (typeof delta?.stop_reason === 'string') {
        message.stop_reason = delta.stop_reason;
      }
      const usage = data.usage as Partial<AnthropicUsage> | undefined;
      if (usage) {
        message.usage.output_tokens = numberOrZero(usage.output_tokens);
        message.usage.input_tokens =
          numberOrZero(usage.input_tokens) || message.usage.input_tokens;
        message.usage.cache_read_input_tokens =
          numberOrZero(usage.cache_read_input_tokens) ||
          message.usage.cache_read_input_tokens;
      }
    }
  }

  for (const [index, raw] of toolBuffers) {
    const block = message.content[index];
    if (block?.type !== 'tool_use') continue;
    try {
      const parsed: unknown = JSON.parse(raw || '{}');
      block.input =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      block.input = {};
    }
  }
  message.content = message.content.filter(
    (block): block is AnthropicMessageBlock => !!block,
  );
  return message;
}

/** Anthropic 风格的错误体。 */
export function anthropicErrorBody(
  type: string,
  message: string,
): Record<string, unknown> {
  return { type: 'error', error: { type, message } };
}
