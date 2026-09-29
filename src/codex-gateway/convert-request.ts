// ─── ChatGPT/Codex 订阅 — Anthropic Messages → Responses 请求翻译 ──
//
// 纯函数，可独立单测。翻译规则参考 OpenAI Responses API 公开规范与
// ccproxy-api codex 插件的实战经验：
// - system → instructions
// - tool_use/tool_result → function_call/function_call_output（call_id 原样透传）
// - 上游强制 stream=true + store=false；剔除 metadata/temperature/max_tokens
//   （chatgpt.com backend 对这些参数直接返回 Unsupported parameter）。

import { decodeReasoningSignature } from './reasoning-signature.js';

type Json = Record<string, unknown>;

/** Anthropic Messages 请求中我们关心的字段子集（宽松解析，未知字段丢弃）。 */
export interface AnthropicRequestSubset {
  model?: string;
  system?: string | Array<Json>;
  messages?: Array<Json>;
  tools?: Array<Json>;
  tool_choice?: Json;
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Array<Json>;
  tools?: Array<Json>;
  tool_choice?: Json | 'auto' | 'none' | 'required';
  reasoning?: { effort: string; summary: 'auto' };
  include?: string[];
  store: false;
  stream: true;
}

function contentBlocks(content: unknown): Array<Json> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function systemToInstructions(
  system: AnthropicRequestSubset['system'],
): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = block as Json;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function imageToInputImage(source: Json): Json | null {
  if (source.type !== 'base64' || typeof source.data !== 'string') {
    return null; // URL 型图片源：Codex backend 仅接受 data URL，跳过
  }
  const mediaType =
    typeof source.media_type === 'string' ? source.media_type : 'image/png';
  return {
    type: 'input_image',
    image_url: `data:${mediaType};base64,${source.data}`,
  };
}

function messageToInputItems(message: Json): Array<Json> {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const items: Array<Json> = [];
  const textParts: Array<Json> = [];
  const imageParts: Array<Json> = [];

  const flushTextMessage = (): void => {
    if (textParts.length === 0 && imageParts.length === 0) return;
    const content: Array<Json> = [];
    if (textParts.length > 0) {
      content.push({
        type: role === 'user' ? 'input_text' : 'output_text',
        text: textParts.map((part) => part.text).join(''),
      });
    }
    content.push(...imageParts);
    items.push({ type: 'message', role, content });
    textParts.length = 0;
    imageParts.length = 0;
  };

  for (const rawBlock of contentBlocks(message.content)) {
    switch (rawBlock.type) {
      case 'text': {
        if (typeof rawBlock.text === 'string' && rawBlock.text.length > 0) {
          textParts.push(rawBlock);
        }
        break;
      }
      case 'image': {
        const converted = imageToInputImage((rawBlock.source ?? {}) as Json);
        if (converted) imageParts.push(converted);
        break;
      }
      case 'thinking': {
        // store=false 模式下，上一轮的 reasoning item（encrypted_content）
        // 必须随 function_call 一起回放，否则上游 400。本网关把它编码在
        // thinking.signature 里；非本网关签发的签名一律跳过。
        const signature = decodeReasoningSignature(rawBlock.signature);
        if (!signature) break;
        flushTextMessage();
        const reasoningItem: Json = {
          type: 'reasoning',
          summary: [],
          encrypted_content: signature.encryptedContent,
        };
        if (signature.id) reasoningItem.id = signature.id;
        items.push(reasoningItem);
        break;
      }
      case 'redacted_thinking': {
        break;
      }
      case 'tool_use': {
        flushTextMessage();
        if (typeof rawBlock.name !== 'string' || !rawBlock.name) break;
        items.push({
          type: 'function_call',
          call_id:
            typeof rawBlock.id === 'string' ? rawBlock.id : rawBlock.name,
          name: rawBlock.name,
          arguments: JSON.stringify(rawBlock.input ?? {}),
        });
        break;
      }
      case 'tool_result': {
        flushTextMessage();
        if (typeof rawBlock.tool_use_id !== 'string') break;
        items.push({
          type: 'function_call_output',
          call_id: rawBlock.tool_use_id,
          output: toolResultToText(rawBlock.content),
        });
        break;
      }
      default:
        break;
    }
  }
  flushTextMessage();
  return items;
}

function convertTools(tools: Array<Json>): Array<Json> {
  return tools
    .filter((tool) => typeof tool.name === 'string')
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: (tool.input_schema ?? {
        type: 'object',
        properties: {},
      }) as Json,
      strict: false,
    }));
}

function convertToolChoice(
  choice: Json | undefined,
): Json | 'auto' | 'required' | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return typeof choice.name === 'string'
        ? { type: 'function', name: choice.name }
        : 'auto';
    default:
      return undefined;
  }
}

export interface AnthropicToResponsesOptions {
  /** provider 配置的目标 Codex 模型（gpt-6-sol 等）。 */
  targetModel: string;
  /** reasoning effort；provider customEnv 可覆盖。 */
  reasoningEffort?: string;
  requestTools?: boolean;
}

/**
 * 归一 reasoning effort：GPT-6 模型目录已移除 minimal 档（实测上游 400），
 * 历史配置里的 minimal 归到 low；未配置时用目录默认 medium。
 */
export function normalizeCodexEffort(effort: string | undefined): string {
  if (!effort) return 'medium';
  return effort === 'minimal' ? 'low' : effort;
}

export function anthropicToResponses(
  request: AnthropicRequestSubset,
  options: AnthropicToResponsesOptions,
): ResponsesRequest {
  const input: Array<Json> = [];
  for (const message of request.messages ?? []) {
    input.push(...messageToInputItems(message));
  }

  const tools = request.tools ? convertTools(request.tools) : undefined;
  const toolChoice = convertToolChoice(request.tool_choice);

  const payload: ResponsesRequest = {
    model: options.targetModel,
    instructions: systemToInstructions(request.system),
    input,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: tools && tools.length > 0 ? toolChoice : undefined,
    reasoning: {
      effort: normalizeCodexEffort(options.reasoningEffort),
      summary: 'auto',
    },
    include: ['reasoning.encrypted_content'],
    store: false,
    stream: true,
  };

  if (!payload.tools) {
    delete payload.tools;
    delete payload.tool_choice;
  }

  return payload;
}

/**
 * 旧目录模型归一：gpt-5.1 系列已从上游目录移除（请求直接 400），
 * 存量 provider 配置里的旧值在请求时映射到 GPT-6 对应档
 * （映射语义对齐官方 gpt-5.4→sol / gpt-5.4-mini→luna 迁移）。
 */
const LEGACY_CODEX_MODELS: Readonly<Record<string, string>> = {
  'gpt-5.1': 'gpt-6-sol',
  'gpt-5.1-codex': 'gpt-6-sol',
  'gpt-5.1-codex-max': 'gpt-6-sol',
  'gpt-5.1-codex-mini': 'gpt-6-luna',
};

export function normalizeLegacyCodexModel(model: string): string {
  return LEGACY_CODEX_MODELS[model] ?? model;
}

/**
 * 模型名重写：SDK 可能硬编码请求 claude-* 系列（haiku 后台任务等），
 * 一律映射到 provider 配置的 Codex 模型，避免上游 404；
 * 旧目录模型（gpt-5.1-*）归一到现役 GPT-6 目录，存量配置无需手动迁移。
 */
export function resolveCodexModel(
  requestModel: string | undefined,
  configuredModel: string,
): string {
  const configured = normalizeLegacyCodexModel(configuredModel || 'gpt-6-sol');
  if (!requestModel) return configured;
  if (/^claude/i.test(requestModel)) {
    return configured;
  }
  return normalizeLegacyCodexModel(requestModel);
}
