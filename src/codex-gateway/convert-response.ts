// ─── ChatGPT/Codex 订阅 — Responses SSE → Anthropic SSE 流翻译 ────
//
// 纯逻辑状态机，可独立单测。上游（chatgpt.com/backend-api/codex/responses）
// 强制流式返回 OpenAI Responses 事件；本模块把事件流逐条翻译成
// Anthropic Messages SSE（message_start/content_block_*/message_delta/message_stop），
// 供 Claude Agent SDK 直接消费。
//
// 关键映射：
// - response.created → message_start（input_tokens 此时未知，completed 时补全）
// - reasoning summary/text delta → thinking 块（无 signature；历史不回传上游，无校验风险）
// - output_text.delta → text 块（惰性开启，节省 block 序号）
// - function_call item → tool_use 块，arguments 经 input_json_delta 下发
// - response.completed → usage 映射 + message_delta(stop_reason) + message_stop
// - 上游断流/失败 → finish() 产出 error 事件（不伪装成成功的 end_turn）

import { encodeReasoningSignature } from './reasoning-signature.js';

type Json = Record<string, unknown>;

export interface AnthropicStreamEvent {
  event: string;
  data: Json;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'rate_limit_error'
  | 'api_error';

export interface CodexUpstreamFailure {
  type: AnthropicErrorType;
  code: string | null;
  message: string;
}

const RATE_LIMIT_CODES = new Set([
  'rate_limit_exceeded',
  'usage_limit_reached',
  'insufficient_quota',
]);

const HTTP_STATUS_BY_ERROR_TYPE: Readonly<Record<AnthropicErrorType, number>> =
  {
    invalid_request_error: 400,
    rate_limit_error: 429,
    api_error: 502,
  };

/**
 * 把上游失败翻译成 Anthropic 错误类型。类型决定客户端是否重试：SDK 对
 * api_error 会反复重试，而 invalid_prompt（上游安全策略拒绝）重试同一请求
 * 并不会改变判定，必须以 invalid_request_error 暴露真实原因。
 */
export function describeUpstreamFailure(raw: Json): CodexUpstreamFailure {
  // response.failed 的详情在 response.error 下；裸 error 事件在 error 下，
  // 少数旧形态直接放在顶层 code/message。
  const response = (raw.response ?? {}) as Json;
  const nested = (response.error ?? raw.error ?? {}) as Json;
  const code = asString(nested.code) ?? asString(raw.code);
  const upstreamType = asString(nested.type) ?? '';
  const detail =
    asString(nested.message) ??
    asString(raw.message) ??
    'Upstream Codex request failed';

  let type: AnthropicErrorType = 'api_error';
  if (
    (code && RATE_LIMIT_CODES.has(code)) ||
    upstreamType.includes('rate_limit')
  ) {
    type = 'rate_limit_error';
  } else if (upstreamType === 'invalid_request_error') {
    type = 'invalid_request_error';
  }

  const message =
    code === 'invalid_prompt'
      ? `Codex 上游安全策略拒绝了本次请求（invalid_prompt）：${detail}`
      : code
        ? `Codex upstream error (${code}): ${detail}`
        : detail;
  return { type, code, message };
}

export class CodexUpstreamError extends Error {
  readonly errorType: AnthropicErrorType;
  readonly code: string | null;
  readonly status: number;

  constructor(failure: CodexUpstreamFailure) {
    super(failure.message);
    this.name = 'CodexUpstreamError';
    this.errorType = failure.type;
    this.code = failure.code;
    this.status = HTTP_STATUS_BY_ERROR_TYPE[failure.type];
  }
}

export class ResponsesToAnthropicConverter {
  private model: string;
  private blockIndex = 0;
  private activeTextBlockIndex: number | null = null;
  private thinkingBlockIndexes = new Map<string, number>();
  private fallbackThinkingIndex: number | null = null;
  private toolBlocks = new Map<
    string,
    { index: number; argumentsSeen: string }
  >();
  private hasToolUse = false;
  private usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  } = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  private messageStarted = false;
  private finished = false;
  private messageId = '';
  private failure: CodexUpstreamFailure | null = null;

  constructor(model: string) {
    this.model = model;
  }

  /** 处理一条上游 Responses SSE 事件，返回 0..n 条 Anthropic SSE 事件。 */
  handleEvent(raw: Json): AnthropicStreamEvent[] {
    const type = asString(raw.type) ?? '';
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        return this.ensureMessageStarted(raw);
      case 'response.output_item.added':
        return this.handleOutputItemAdded(raw);
      case 'response.output_item.done':
        return this.handleOutputItemDone(raw);
      case 'response.output_text.delta':
        return this.handleTextDelta(raw);
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.handleThinkingDelta(raw, asString(raw.delta) ?? '');
      case 'response.completed':
        return this.handleCompleted(raw, 'end_turn');
      case 'response.incomplete':
        return this.handleCompleted(raw, 'max_tokens');
      case 'response.failed':
      case 'error':
        return this.handleFailure(raw);
      default:
        // content_part.*、reasoning_summary_part.*、response.output_text.done 等事件
        // 的信息由 output_item.done 与 completed 覆盖，无需单独处理。
        return [];
    }
  }

  /**
   * 上游流结束（可能非正常 completed）时调用，确保 Anthropic 流完整收尾。
   */
  finish(): AnthropicStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [
      {
        event: 'error',
        data: {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Upstream Codex stream ended before completion',
          },
        },
      },
    ];
  }

  private ensureMessageStarted(raw: Json): AnthropicStreamEvent[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    const response = (raw.response ?? {}) as Json;
    this.model = asString(response.model) ?? this.model;
    this.messageId = asString(response.id) ?? `msg_${Date.now().toString(36)}`;
    return [
      {
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
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      { event: 'ping', data: { type: 'ping' } },
    ];
  }

  private nextBlockIndex(): number {
    return this.blockIndex++;
  }

  private handleOutputItemAdded(raw: Json): AnthropicStreamEvent[] {
    this.ensureMessageStarted(raw);
    const item = (raw.item ?? {}) as Json;
    const itemType = asString(item.type) ?? '';
    const itemId = asString(item.id) ?? '';

    if (itemType === 'reasoning') {
      const index = this.nextBlockIndex();
      if (itemId) {
        this.thinkingBlockIndexes.set(itemId, index);
      } else {
        this.fallbackThinkingIndex = index;
      }
      return [
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
      ];
    }

    if (itemType === 'function_call') {
      const index = this.nextBlockIndex();
      this.hasToolUse = true;
      if (itemId) {
        this.toolBlocks.set(itemId, {
          index,
          argumentsSeen: asString(item.arguments) ?? '',
        });
      }
      return [
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: asString(item.call_id) ?? itemId,
              name: asString(item.name) ?? 'unknown',
              input: {},
            },
          },
        },
      ];
    }

    return [];
  }

  private handleOutputItemDone(raw: Json): AnthropicStreamEvent[] {
    const item = (raw.item ?? {}) as Json;
    const itemType = asString(item.type) ?? '';
    const itemId = asString(item.id) ?? '';
    const events: AnthropicStreamEvent[] = [];

    if (itemType === 'function_call') {
      const block = this.toolBlocks.get(itemId);
      if (block) {
        const fullArguments = asString(item.arguments) ?? '';
        // 若上游只发了 item.done（无 delta 事件），这里一次性补发完整参数。
        if (fullArguments && fullArguments !== block.argumentsSeen) {
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: block.index,
              delta: {
                type: 'input_json_delta',
                partial_json: fullArguments,
              },
            },
          });
        }
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: block.index },
        });
        this.toolBlocks.delete(itemId);
      }
      return events;
    }

    if (itemType === 'reasoning') {
      const index = this.takeThinkingIndex(itemId);
      if (index !== null) {
        // store=false 模式下工具循环需要回放 reasoning item；把
        // encrypted_content 编码进 signature，SDK 会原样带回下一轮请求。
        const encrypted = asString(item.encrypted_content);
        if (encrypted) {
          const signature = encodeReasoningSignature({
            id: itemId || null,
            encryptedContent: encrypted,
          });
          if (signature) {
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index,
                delta: { type: 'signature_delta', signature },
              },
            });
          }
        }
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index },
        });
      }
      return events;
    }

    if (itemType === 'message') {
      // message item done 晚于全部 text delta；text block 若仍开启则关闭。
      events.push(...this.closeActiveTextBlock());
    }
    return events;
  }

  private handleTextDelta(raw: Json): AnthropicStreamEvent[] {
    const delta = asString(raw.delta);
    if (delta === null) return [];
    const events: AnthropicStreamEvent[] = [];
    if (this.activeTextBlockIndex === null) {
      this.activeTextBlockIndex = this.nextBlockIndex();
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.activeTextBlockIndex,
          content_block: { type: 'text', text: '' },
        },
      });
    }
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.activeTextBlockIndex,
        delta: { type: 'text_delta', text: delta },
      },
    });
    return events;
  }

  private handleThinkingDelta(
    raw: Json,
    delta: string,
  ): AnthropicStreamEvent[] {
    if (!delta) return [];
    this.ensureMessageStarted(raw);
    const itemId = asString(raw.item_id) ?? '';
    const index =
      this.thinkingBlockIndexes.get(itemId) ?? this.fallbackThinkingIndex;
    if (index === null) return [];
    return [
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: delta },
        },
      },
    ];
  }

  private takeThinkingIndex(itemId: string): number | null {
    const mapped = this.thinkingBlockIndexes.get(itemId);
    if (mapped !== undefined) {
      this.thinkingBlockIndexes.delete(itemId);
      return mapped;
    }
    const fallback = this.fallbackThinkingIndex;
    this.fallbackThinkingIndex = null;
    return fallback;
  }

  private closeActiveTextBlock(): AnthropicStreamEvent[] {
    if (this.activeTextBlockIndex === null) return [];
    const events: AnthropicStreamEvent[] = [
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: this.activeTextBlockIndex },
      },
    ];
    this.activeTextBlockIndex = null;
    return events;
  }

  private closeAllBlocks(): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    events.push(...this.closeActiveTextBlock());
    for (const [, block] of this.toolBlocks) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: block.index },
      });
    }
    this.toolBlocks.clear();
    for (const [, index] of this.thinkingBlockIndexes) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index },
      });
    }
    this.thinkingBlockIndexes.clear();
    if (this.fallbackThinkingIndex !== null) {
      events.push({
        event: 'content_block_stop',
        data: {
          type: 'content_block_stop',
          index: this.fallbackThinkingIndex,
        },
      });
      this.fallbackThinkingIndex = null;
    }
    return events;
  }

  private handleCompleted(
    raw: Json,
    fallbackStopReason: 'end_turn' | 'max_tokens',
  ): AnthropicStreamEvent[] {
    this.ensureMessageStarted(raw);
    if (this.finished) return [];
    this.finished = true;

    const response = (raw.response ?? {}) as Json;
    const usage = (response.usage ?? {}) as Json;
    const inputDetails = (usage.input_tokens_details ?? {}) as Json;
    this.usage = {
      input_tokens:
        typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens:
        typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cache_read_input_tokens:
        typeof inputDetails.cached_tokens === 'number'
          ? inputDetails.cached_tokens
          : 0,
    };

    const events = this.closeAllBlocks();
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: this.hasToolUse ? 'tool_use' : fallbackStopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.usage.output_tokens,
          input_tokens: this.usage.input_tokens,
          cache_read_input_tokens: this.usage.cache_read_input_tokens,
        },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }

  private handleFailure(raw: Json): AnthropicStreamEvent[] {
    this.ensureMessageStarted(raw);
    if (this.finished) return [];
    this.finished = true;
    this.failure = describeUpstreamFailure(raw);
    return [
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: this.failure.type, message: this.failure.message },
        },
      },
    ];
  }

  /** 上游明确报告的失败（response.failed / error 事件）；断流不算。 */
  getFailure(): CodexUpstreamFailure | null {
    return this.failure ? { ...this.failure } : null;
  }

  getUsage(): {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  } {
    return { ...this.usage };
  }
}

// ─── 非流式聚合：Codex backend 强制 stream=true，客户端若要非流式
// ─── 响应，由网关聚合完整事件后组装 Anthropic Messages JSON。 ──────

export interface AggregatedAnthropicMessage {
  id: string;
  model: string;
  content: Array<Json>;
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * 用与流式完全相同的翻译逻辑（converter → Anthropic SSE 事件）聚合出
 * 完整消息：逐块拼装 text/thinking/tool_use 内容与 stop_reason。
 * 上游失败或断流未到 response.completed 时抛错（事件流含 error），
 * 由网关转换为 502，绝不返回截断的部分内容冒充成功。
 */
export function aggregateResponsesStream(
  events: Array<Json>,
  fallbackModel: string,
): AggregatedAnthropicMessage {
  const converter = new ResponsesToAnthropicConverter(fallbackModel);
  const anthropicEvents: AnthropicStreamEvent[] = [];
  for (const event of events) {
    anthropicEvents.push(...converter.handleEvent(event));
  }
  anthropicEvents.push(...converter.finish());
  if (anthropicEvents.some(({ event }) => event === 'error')) {
    throw new CodexUpstreamError(
      converter.getFailure() ?? {
        type: 'api_error',
        code: null,
        message: 'Upstream Codex stream ended before completion',
      },
    );
  }

  let id = `msg_${Date.now().toString(36)}`;
  let model = fallbackModel;
  let stopReason: AggregatedAnthropicMessage['stopReason'] = 'end_turn';
  const blocks = new Map<number, { block: Json; jsonParts: string[] }>();

  for (const { event, data } of anthropicEvents) {
    switch (event) {
      case 'message_start': {
        const message = (data.message ?? {}) as Json;
        if (typeof message.id === 'string' && message.id) id = message.id;
        if (typeof message.model === 'string' && message.model) {
          model = message.model;
        }
        break;
      }
      case 'content_block_start': {
        const index = typeof data.index === 'number' ? data.index : blocks.size;
        const contentBlock = (data.content_block ?? {}) as Json;
        const type = asString(contentBlock.type);
        const block: Json = { type };
        if (type === 'text') block.text = '';
        if (type === 'thinking') {
          block.thinking = '';
          block.signature = '';
        }
        if (type === 'tool_use') {
          if (typeof contentBlock.id === 'string') block.id = contentBlock.id;
          if (typeof contentBlock.name === 'string') {
            block.name = contentBlock.name;
          }
          block.input = {};
        }
        blocks.set(index, { block, jsonParts: [] });
        break;
      }
      case 'content_block_delta': {
        const acc =
          typeof data.index === 'number' ? blocks.get(data.index) : undefined;
        if (!acc) break;
        const delta = (data.delta ?? {}) as Json;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          acc.block.text = `${asString(acc.block.text) ?? ''}${delta.text}`;
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          acc.block.thinking = `${asString(acc.block.thinking) ?? ''}${delta.thinking}`;
        } else if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        ) {
          acc.block.signature = delta.signature;
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          acc.jsonParts.push(delta.partial_json);
        }
        break;
      }
      case 'message_delta': {
        const delta = (data.delta ?? {}) as Json;
        if (
          delta.stop_reason === 'tool_use' ||
          delta.stop_reason === 'max_tokens' ||
          delta.stop_reason === 'end_turn'
        ) {
          stopReason = delta.stop_reason;
        }
        break;
      }
      default:
        break;
    }
  }

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => {
      if (acc.block.type === 'tool_use' && acc.jsonParts.length > 0) {
        try {
          acc.block.input = JSON.parse(acc.jsonParts.join('')) as Json;
        } catch {
          acc.block.input = {};
        }
      }
      return acc.block;
    })
    .filter((block) => {
      // 丢弃上游断流留下的空块；空 thinking 但有签名的保留（回放仍需签名）。
      if (block.type === 'text') return asString(block.text) !== '';
      if (block.type === 'thinking') {
        return asString(block.thinking) !== '' || asString(block.signature);
      }
      return true;
    });

  return { id, model, content, stopReason, usage: converter.getUsage() };
}
