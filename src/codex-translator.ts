/**
 * Anthropic Messages ↔ ChatGPT Codex Responses translation.
 *
 * The Claude Agent SDK only speaks Anthropic JSON/SSE. Codex is reached
 * through Responses (`/responses`) with top-level function_call items.
 * This module is the substrate for later Grok (and similar) facades.
 */

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';
export const CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';

export interface AnthropicToolSpec {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: string;
  content: unknown;
}

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: unknown;
  messages?: AnthropicMessage[];
  tools?: AnthropicToolSpec[];
}

export interface CodexCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  idToken?: string;
  email?: string;
  planType?: string;
}

export interface CodexResponsesRequest {
  model: string;
  input: Array<Record<string, unknown>>;
  stream: true;
  store: false;
  reasoning: { effort: 'medium'; summary: 'auto' };
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: 'auto';
}

export interface TranslatedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TranslatedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CodexTranslateResult {
  text: string;
  toolUses: TranslatedToolUse[];
  usage: TranslatedUsage;
  error: string | null;
  sse: string;
}

export function parseCodexCredential(secret: string): CodexCredential {
  try {
    const parsed = JSON.parse(secret) as Partial<CodexCredential>;
    if (parsed && typeof parsed === 'object' && parsed.accessToken) {
      return {
        accessToken: String(parsed.accessToken),
        refreshToken: String(parsed.refreshToken || ''),
        accountId: String(parsed.accountId || ''),
        idToken: parsed.idToken ? String(parsed.idToken) : undefined,
        email: parsed.email ? String(parsed.email) : undefined,
        planType: parsed.planType ? String(parsed.planType) : undefined,
      };
    }
  } catch {
    // fall through: treat the whole string as a bare access token
  }
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('codex credential is missing access_token');
  }
  return { accessToken: trimmed, refreshToken: '', accountId: '' };
}

export function flattenAnthropicText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as { type?: unknown }).type === 'text' &&
      typeof (raw as { text?: unknown }).text === 'string'
    ) {
      parts.push((raw as { text: string }).text);
    }
  }
  return parts.join('\n');
}

export function flattenSystemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts: string[] = [];
  for (const raw of system) {
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as { type?: unknown }).type === 'text' &&
      typeof (raw as { text?: unknown }).text === 'string' &&
      (raw as { text: string }).text
    ) {
      parts.push((raw as { text: string }).text);
    }
  }
  return parts.join('\n');
}

export function stripThinkingBlocks(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.filter((raw) => {
      if (raw && typeof raw === 'object') {
        return (raw as { type?: unknown }).type !== 'thinking';
      }
      return true;
    });
  }
  return content;
}

export function codexToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(content ?? '');
  } catch {
    return '';
  }
}

function toolUseArguments(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return JSON.stringify(input);
  }
  if (typeof input === 'string') return input;
  return '';
}

export function dropOrphanFunctionCallOutputs(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const callIds = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call' && typeof item.call_id === 'string') {
      callIds.add(item.call_id);
    }
  }
  return items.filter((item) => {
    if (item.type !== 'function_call_output') return true;
    return typeof item.call_id === 'string' && callIds.has(item.call_id);
  });
}

function convertBlocks(
  role: string,
  textBlockType: string,
  blocks: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
): void {
  let parts: Array<Record<string, unknown>> = [];
  const flush = () => {
    if (parts.length === 0) return;
    items.push({ type: 'message', role, content: parts });
    parts = [];
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.trim()) {
          parts.push({ type: textBlockType, text });
        }
        break;
      }
      case 'tool_result': {
        flush();
        const callId =
          typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (callId) {
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: codexToolResultText(block.content),
          });
        }
        break;
      }
      case 'tool_use': {
        flush();
        const callId = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : '';
        if (callId) {
          items.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: toolUseArguments(block.input),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  flush();
}

export function anthropicToCodexRequest(
  req: AnthropicMessagesRequest,
): CodexResponsesRequest {
  let instructions = flattenSystemText(req.system);
  const items: Array<Record<string, unknown>> = [];

  for (const message of req.messages ?? []) {
    const role = message.role;
    if (role !== 'assistant' && role !== 'user') {
      const extra = flattenAnthropicText(message.content);
      if (extra.trim()) {
        instructions = [instructions, extra].filter(Boolean).join('\n');
      }
      continue;
    }
    const textBlockType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof message.content === 'string') {
      if (message.content.trim()) {
        items.push({
          type: 'message',
          role,
          content: [{ type: textBlockType, text: message.content }],
        });
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      const blocks = message.content.filter(
        (raw): raw is Record<string, unknown> =>
          !!raw && typeof raw === 'object',
      );
      convertBlocks(role, textBlockType, blocks, items);
    }
  }

  const filtered = dropOrphanFunctionCallOutputs(items);
  if (filtered.length === 0) {
    filtered.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '(continue)' }],
    });
  }

  const body: CodexResponsesRequest = {
    model: req.model?.trim() || CODEX_DEFAULT_MODEL,
    input: filtered,
    stream: true,
    store: false,
    reasoning: { effort: 'medium', summary: 'auto' },
  };
  if (instructions.trim()) body.instructions = instructions.trim();
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
      strict: false,
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function estimateInputTokens(payload: unknown): number {
  try {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return Math.max(1, Math.ceil(raw.length / 4));
  } catch {
    return 1;
  }
}

/**
 * Translate a Codex Responses SSE stream into Anthropic Messages SSE.
 * Failed or truncated upstream streams set `error` and do not emit a
 * successful message_stop / end_turn.
 */
export function translateCodexSse(
  model: string,
  lines: string[],
): CodexTranslateResult {
  const chunks: string[] = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        model,
        role: 'assistant',
        content: [],
        usage: { input_tokens: 0 },
      },
    }),
  ];

  const argStream = new Map<string, string>();
  let nextBlockIndex = 0;
  let textBlockIndex = -1;
  let thinkingBlockIndex = -1;
  let haveUsage = false;
  let error: string | null = null;
  const result: CodexTranslateResult = {
    text: '',
    toolUses: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    error: null,
    sse: '',
  };

  const closeThinking = () => {
    if (thinkingBlockIndex < 0) return;
    chunks.push(
      sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      }),
    );
    thinkingBlockIndex = -1;
  };
  const closeText = () => {
    if (textBlockIndex < 0) return;
    chunks.push(
      sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex,
      }),
    );
    textBlockIndex = -1;
  };

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let ev: {
      type?: string;
      delta?: string;
      arguments?: string;
      item_id?: string;
      item?: {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: string;
      };
      response?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
        error?: { message?: string };
      };
    };
    try {
      ev = JSON.parse(data) as typeof ev;
    } catch {
      continue;
    }

    if (ev.type === 'response.function_call_arguments.delta') {
      const id = ev.item_id || '';
      argStream.set(id, (argStream.get(id) || '') + (ev.delta || ''));
      continue;
    }
    if (ev.type === 'response.function_call_arguments.done') {
      if (ev.item_id) argStream.set(ev.item_id, ev.arguments || '');
      continue;
    }
    if (ev.type === 'response.reasoning_summary_text.delta') {
      if (thinkingBlockIndex < 0) {
        thinkingBlockIndex = nextBlockIndex++;
        chunks.push(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: thinkingBlockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }),
        );
      }
      chunks.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: ev.delta || '' },
        }),
      );
      continue;
    }

    switch (ev.type) {
      case 'response.output_text.delta': {
        result.text += ev.delta || '';
        closeThinking();
        if (textBlockIndex < 0) {
          textBlockIndex = nextBlockIndex++;
          chunks.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        chunks.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: ev.delta || '' },
          }),
        );
        break;
      }
      case 'response.output_item.done': {
        if (ev.item?.type === 'function_call') {
          const tool: TranslatedToolUse = {
            id: ev.item.call_id || '',
            name: ev.item.name || '',
            input: {},
          };
          let args = ev.item.arguments || '';
          if (!args && ev.item.call_id) {
            args = argStream.get(ev.item.call_id) || '';
          }
          if (args) {
            try {
              const parsed = JSON.parse(args) as unknown;
              if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
              ) {
                tool.input = parsed as Record<string, unknown>;
              }
            } catch {
              tool.input = {};
            }
          }
          result.toolUses.push(tool);
          closeThinking();
          closeText();
          const idx = nextBlockIndex++;
          chunks.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: idx,
              content_block: {
                type: 'tool_use',
                id: tool.id,
                name: tool.name,
                input: {},
              },
            }),
          );
          chunks.push(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: idx,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(tool.input),
              },
            }),
          );
          chunks.push(
            sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: idx,
            }),
          );
        }
        break;
      }
      case 'response.completed': {
        if (ev.response?.usage && !haveUsage) {
          haveUsage = true;
          result.usage.inputTokens = ev.response.usage.input_tokens || 0;
          result.usage.outputTokens = ev.response.usage.output_tokens || 0;
          result.usage.cacheReadTokens =
            ev.response.usage.input_tokens_details?.cached_tokens || 0;
        }
        if (ev.response?.error?.message) {
          error = ev.response.error.message;
        }
        break;
      }
      default:
        break;
    }
  }

  result.error = error;
  if (error) {
    chunks.push(
      sseEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: error },
      }),
    );
    result.sse = chunks.join('');
    return result;
  }

  closeThinking();
  closeText();
  chunks.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: result.toolUses.length > 0 ? 'tool_use' : 'end_turn',
      },
      usage: { output_tokens: result.usage.outputTokens },
    }),
  );
  chunks.push(sseEvent('message_stop', { type: 'message_stop' }));
  result.sse = chunks.join('');
  return result;
}

export function anthropicErrorSse(message: string): string {
  return sseEvent('error', {
    type: 'error',
    error: { type: 'api_error', message },
  });
}

export function anthropicErrorJson(message: string): Record<string, unknown> {
  return {
    type: 'error',
    error: { type: 'api_error', message },
  };
}

export function anthropicMessageJson(
  model: string,
  translated: CodexTranslateResult,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (translated.text) {
    content.push({ type: 'text', text: translated.text });
  }
  for (const tool of translated.toolUses) {
    content.push({
      type: 'tool_use',
      id: tool.id,
      name: tool.name,
      input: tool.input,
    });
  }
  return {
    id: `msg_codex_${Date.now().toString(16)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: translated.toolUses.length > 0 ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: translated.usage.inputTokens,
      output_tokens: translated.usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: translated.usage.cacheReadTokens,
    },
  };
}
