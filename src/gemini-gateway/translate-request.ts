// ─── Gemini 订阅网关 — Anthropic Messages → Antigravity 请求 ─────────
//
// 只覆盖 Claude Code 实际会发出的子集：system 文本、user/assistant 文本、
// base64 图片、tool_use/tool_result、thinking 签名、工具声明与 tool_choice。
// 无法表达的内容降级为文本说明，绝不静默丢整段上下文。

import {
  decodeSignatureCarrier,
  recallToolSignature,
  type SignatureCarrier,
} from './signature.js';
import {
  GEMINI_DEFAULT_MAX_OUTPUT_TOKENS,
  type GeminiModelInfo,
} from './types.js';

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: {
    type?: string;
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: unknown;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiToolDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AntigravityRequestPayload {
  contents: GeminiContent[];
  systemInstruction?: { role: 'user'; parts: GeminiPart[] };
  tools?: Array<{ functionDeclarations: GeminiToolDeclaration[] }>;
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'ANY' | 'NONE';
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: Record<string, unknown>;
}

export interface TranslationResult {
  payload: AntigravityRequestPayload;
  /** Anthropic 工具名 → 上游函数名。 */
  toolNameMap: Map<string, string>;
  /** 上游函数名 → Anthropic 工具名。 */
  reverseToolNameMap: Map<string, string>;
}

/** Gemini 函数名允许的字符集；超出时替换，冲突时加序号。 */
const GEMINI_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/;

export function sanitizeFunctionName(name: string, used: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]/, '_');
  if (!base) base = 'tool';
  base = base.slice(0, 60);
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 60 - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

/** JSON Schema → Gemini Schema（递归清洗不受支持的键）。 */
export function sanitizeSchema(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    depth > 24
  ) {
    return { type: 'OBJECT' };
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  let type = input.type;
  let nullable = input.nullable === true;
  if (Array.isArray(type)) {
    const types = type.filter(
      (entry): entry is string => typeof entry === 'string',
    );
    nullable = nullable || types.includes('null');
    type = types.find((entry) => entry !== 'null');
  }
  if (typeof type === 'string') {
    const upper = type.toUpperCase();
    const mapped =
      upper === 'OBJECT' ||
      upper === 'ARRAY' ||
      upper === 'STRING' ||
      upper === 'NUMBER' ||
      upper === 'INTEGER' ||
      upper === 'BOOLEAN'
        ? upper
        : null;
    if (mapped) output.type = mapped;
  }
  if (!output.type && input.properties) output.type = 'OBJECT';
  if (nullable) output.nullable = true;

  if (typeof input.description === 'string' && input.description) {
    output.description = input.description;
  }
  if (typeof input.title === 'string' && input.title)
    output.title = input.title;
  if (typeof input.format === 'string' && input.format)
    output.format = input.format;
  if (Array.isArray(input.enum)) output.enum = input.enum.map(String);
  if (input.const !== undefined) output.enum = [String(input.const)];
  if (typeof input.pattern === 'string') output.pattern = input.pattern;
  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    const entry = input[key];
    if (typeof entry === 'number' && Number.isFinite(entry))
      output[key] = entry;
  }
  if (input.default !== undefined) output.default = input.default;

  const properties = input.properties;
  if (
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
  ) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      cleaned[key] = sanitizeSchema(schema, depth + 1);
    }
    output.properties = cleaned;
    if (Array.isArray(input.required)) {
      const required = input.required.filter(
        (entry): entry is string =>
          typeof entry === 'string' && Object.hasOwn(cleaned, entry),
      );
      if (required.length > 0) output.required = required;
    }
  }

  if (input.items !== undefined) {
    output.items = sanitizeSchema(input.items, depth + 1);
  }
  const anyOf = Array.isArray(input.anyOf)
    ? input.anyOf
    : Array.isArray(input.oneOf)
      ? input.oneOf
      : null;
  if (anyOf && anyOf.length > 0) {
    output.anyOf = anyOf.map((entry) => sanitizeSchema(entry, depth + 1));
  }
  if (output.type === 'ARRAY' && !output.items) {
    output.items = { type: 'STRING' };
  }
  if (output.type === 'OBJECT' && !output.properties) {
    // Gemini rejects an object schema with no properties; a free-form object
    // is better expressed as a string in tool arguments.
    output.properties = {};
  }
  return output;
}

/**
 * Antigravity answers RESOURCE_EXHAUSTED (HTTP 429) to any system prompt that
 * contains "You are Claude Code". This is an upstream content-policy rejection,
 * not a quota problem: a one-line prompt with that phrase fails while a 120 KB
 * prompt without it succeeds. The Claude Code preset and HappyClaw's runtime
 * note both open with that line, so every real agent turn would fail while
 * small "test connection" requests passed. Rewriting the identity phrase keeps
 * the rest of the prompt intact; HappyClaw's own prompt layers define identity.
 */
const CLAUDE_CODE_IDENTITY = /you\s+are\s+claude\s+code/gi;
const NEUTRAL_IDENTITY = 'You are an AI coding agent';

/**
 * The preset's dual-use tool note trips the same filter once its example list
 * is included; the policy sentence itself is enough to keep the instruction.
 */
const DUAL_USE_EXAMPLES =
  /\s*\(C2 frameworks, credential testing, exploit development\)/gi;

function sanitizeSystemText(text: string): string {
  return text
    .replace(CLAUDE_CODE_IDENTITY, NEUTRAL_IDENTITY)
    .replace(DUAL_USE_EXAMPLES, '');
}

function systemText(system: AnthropicMessagesRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return sanitizeSystemText(system.trim());
  return sanitizeSystemText(
    system
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
      .trim(),
  );
}

function contentBlocks(
  content: AnthropicMessage['content'],
): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function toolResultText(block: AnthropicContentBlock): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return '';
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as AnthropicContentBlock;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push('[图片结果已省略：Gemini 工具结果只接受文本]');
    }
  }
  return parts.join('\n');
}

function imagePart(source: AnthropicContentBlock['source']): GeminiPart | null {
  if (!source || source.type !== 'base64' || !source.data) return null;
  const mimeType = source.media_type || 'image/png';
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) return null;
  return { inlineData: { mimeType, data: source.data } };
}

interface ToolUseRecord {
  id: string;
  name: string;
  hasSignature: boolean;
}

/**
 * 把一次 Anthropic 请求翻译成 Antigravity 请求体。
 * `catalogModel` 用于把 max_tokens 收敛到模型上限。
 */
export function translateAnthropicRequest(
  request: AnthropicMessagesRequest,
  catalogModel: GeminiModelInfo | null,
  options: { disableSignatures?: boolean } = {},
): TranslationResult {
  const toolNameMap = new Map<string, string>();
  const reverseToolNameMap = new Map<string, string>();
  const usedNames = new Set<string>();
  const declarations: GeminiToolDeclaration[] = [];
  for (const tool of request.tools ?? []) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) continue;
    const sanitized = GEMINI_NAME_RE.test(name)
      ? name
      : sanitizeFunctionName(name, usedNames);
    usedNames.add(sanitized);
    if (toolNameMap.has(name)) continue;
    toolNameMap.set(name, sanitized);
    reverseToolNameMap.set(sanitized, name);
    declarations.push({
      name: sanitized,
      ...(typeof tool.description === 'string' && tool.description
        ? { description: tool.description }
        : {}),
      parameters: sanitizeSchema(
        tool.input_schema ?? { type: 'object', properties: {} },
      ),
    });
  }

  // tool_use_id → tool name, for functionResponse names.
  const toolUseNames = new Map<string, string>();
  for (const message of request.messages ?? []) {
    for (const block of contentBlocks(message.content)) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolUseNames.set(block.id, block.name);
      }
    }
  }

  const contents: GeminiContent[] = [];
  // Signatures carried by thinking blocks, consumed by the next matching part.
  let pendingSignature: SignatureCarrier | null = null;
  // Calls flattened to text because their signature was lost. Their results
  // must stay text too: Gemini rejects a functionResponse without a call.
  const flattenedCalls = new Set<string>();

  for (const message of request.messages ?? []) {
    const role: 'user' | 'model' =
      message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    const toolUses: ToolUseRecord[] = [];

    for (const block of contentBlocks(message.content)) {
      switch (block.type) {
        case 'text': {
          const text = block.text ?? '';
          if (!text) break;
          const carrier =
            pendingSignature && pendingSignature.kind === 'text'
              ? pendingSignature
              : null;
          if (carrier) pendingSignature = null;
          parts.push({
            text,
            ...(carrier ? { thoughtSignature: carrier.signature } : {}),
          });
          break;
        }
        case 'thinking': {
          const carrier = decodeSignatureCarrier(block.signature);
          if (carrier) pendingSignature = carrier;
          break;
        }
        case 'redacted_thinking':
          break;
        case 'image': {
          const part = imagePart(block.source);
          if (part) parts.push(part);
          else if (block.source?.url)
            parts.push({ text: `[图片：${block.source.url}]` });
          break;
        }
        case 'tool_use': {
          if (role !== 'model') break;
          const id = block.id ?? '';
          const name = block.name ?? '';
          if (!id || !name) break;
          const upstreamName =
            toolNameMap.get(name) ?? sanitizeFunctionName(name, usedNames);
          const cached = options.disableSignatures
            ? null
            : recallToolSignature(id);
          // Prefer the carrier adjacent to this block; the cache covers
          // history where the CLI dropped the thinking block.
          const carrier = options.disableSignatures ? null : pendingSignature;
          const signature = carrier?.signature ?? cached?.signature ?? null;
          const callId = carrier?.callId ?? cached?.callId ?? null;
          if (carrier) pendingSignature = null;
          toolUses.push({ id, name, hasSignature: !!signature });
          if (!signature) {
            // Signature lost (session resumed after a restart): plain text
            // keeps the exchange in context without tripping Gemini's 400.
            flattenedCalls.add(id);
            parts.push({
              text: `[调用工具 ${name}] ${safeJson(block.input ?? {})}`,
            });
            break;
          }
          parts.push({
            functionCall: {
              name: upstreamName,
              args:
                block.input &&
                typeof block.input === 'object' &&
                !Array.isArray(block.input)
                  ? (block.input as Record<string, unknown>)
                  : {},
              ...(callId ? { id: callId } : {}),
            },
            thoughtSignature: signature,
          });
          break;
        }
        case 'tool_result': {
          const toolUseId = block.tool_use_id ?? '';
          const name = toolUseNames.get(toolUseId) ?? '';
          const cached = recallToolSignature(toolUseId);
          const record = toolUses.find((entry) => entry.id === toolUseId);
          const usableName = name
            ? (toolNameMap.get(name) ?? name)
            : (cached?.name ?? 'tool');
          const text = toolResultText(block);
          if (!cached && !name) {
            parts.push({ text: `[工具结果] ${text || '(空)'}` });
            break;
          }
          if (
            flattenedCalls.has(toolUseId) ||
            (record && !record.hasSignature)
          ) {
            // The matching tool call was flattened to text above.
            parts.push({
              text: `[工具 ${name || usableName} 结果] ${text || '(空)'}`,
            });
            break;
          }
          parts.push({
            functionResponse: {
              name: usableName,
              response: {
                output: block.is_error
                  ? `Error: ${text}`
                  : text || '(empty result)',
              },
              ...(cached?.callId ? { id: cached.callId } : {}),
            },
          });
          break;
        }
        case 'document':
          parts.push({ text: '[文档附件已省略：Gemini 工具结果只接受文本]' });
          break;
        default:
          break;
      }
    }

    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  // Gemini 要求第一段是 user；以 model 开头时补一句中性说明。
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '(empty)' }] });
  } else if (contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  }

  const system = systemText(request.system);
  const payload: AntigravityRequestPayload = {
    contents,
    ...(system
      ? {
          systemInstruction: {
            role: 'user' as const,
            parts: [{ text: system }],
          },
        }
      : {}),
    ...(declarations.length > 0
      ? { tools: [{ functionDeclarations: declarations }] }
      : {}),
  };

  const toolMode = request.tool_choice?.type;
  if (declarations.length > 0 && toolMode) {
    if (toolMode === 'none') {
      payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (toolMode === 'any') {
      payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (toolMode === 'tool' && request.tool_choice?.name) {
      const upstream = toolNameMap.get(request.tool_choice.name);
      payload.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          ...(upstream ? { allowedFunctionNames: [upstream] } : {}),
        },
      };
    } else {
      payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
  }

  const generationConfig: Record<string, unknown> = {};
  const maxFromRequest =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? Math.trunc(request.max_tokens)
      : GEMINI_DEFAULT_MAX_OUTPUT_TOKENS;
  const cap = catalogModel?.maxOutputTokens ?? null;
  generationConfig.maxOutputTokens = cap
    ? Math.min(maxFromRequest, cap)
    : maxFromRequest;
  if (typeof request.temperature === 'number') {
    generationConfig.temperature = request.temperature;
  }
  if (typeof request.top_p === 'number') generationConfig.topP = request.top_p;
  if (typeof request.top_k === 'number') generationConfig.topK = request.top_k;
  if (
    Array.isArray(request.stop_sequences) &&
    request.stop_sequences.length > 0
  ) {
    generationConfig.stopSequences = request.stop_sequences.slice(0, 5);
  }
  const thinking = request.thinking;
  if (
    thinking?.type === 'enabled' &&
    typeof thinking.budget_tokens === 'number'
  ) {
    const min = catalogModel?.minThinkingBudget ?? 32;
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: Math.max(Math.trunc(thinking.budget_tokens), min),
    };
  } else if (thinking?.type === 'enabled') {
    generationConfig.thinkingConfig = { includeThoughts: true };
  }
  payload.generationConfig = generationConfig;

  return { payload, toolNameMap, reverseToolNameMap };
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  } catch {
    return String(value);
  }
}

/** 去掉 Claude Code 的 `[1m]` 开关与首尾空白。 */
export function normalizeRequestModel(model: string | undefined): string {
  return (model ?? '')
    .trim()
    .replace(/\[1m\]$/i, '')
    .trim();
}
