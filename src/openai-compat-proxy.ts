/**
 * Lightweight Anthropic-to-OpenAI format adapter.
 *
 * Starts an HTTP server on a random local port that accepts incoming requests
 * in Anthropic Messages API format, converts them to OpenAI Chat Completions
 * format, forwards to the configured endpoint, and converts the response back.
 *
 * Supports: text messages, basic tool calls, streaming (SSE).
 *
 * Limitations:
 *  - Image content blocks are not forwarded (text only).
 *  - Complex nested tool result content is flattened to plain text.
 *  - Only the /v1/messages endpoint is proxied; other paths return 404.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from './logger.js';

// ─── Anthropic request/response types ────────────────────────────

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | TextBlock[];
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicSystemBlock {
  type: string;
  text: string;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

// ─── OpenAI types (minimal, for what we produce/consume) ─────────

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

// ─── Conversion helpers ───────────────────────────────────────────

function contentToText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function buildOpenAIMessages(
  system: AnthropicRequest['system'] | undefined,
  messages: AnthropicMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  if (system) {
    const text =
      typeof system === 'string'
        ? system
        : system
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (text) out.push({ role: 'system', content: text });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const textBlocks = msg.content.filter((b): b is TextBlock => b.type === 'text');
    const toolUseBlocks = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const toolResultBlocks = msg.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');

    if (toolResultBlocks.length > 0) {
      // Each tool result becomes a separate "tool" role message
      for (const block of toolResultBlocks) {
        const resultText =
          typeof block.content === 'string'
            ? block.content
            : contentToText(block.content ?? []);
        out.push({
          role: 'tool',
          content: resultText,
          tool_call_id: block.tool_use_id,
        });
      }
    } else if (textBlocks.length > 0 || toolUseBlocks.length > 0) {
      const oaiMsg: OpenAIMessage = {
        role: msg.role,
        content: textBlocks.map((b) => b.text).join('') || null,
      };
      if (toolUseBlocks.length > 0) {
        oaiMsg.tool_calls = toolUseBlocks.map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        }));
      }
      out.push(oaiMsg);
    }
  }

  return out;
}

function convertTools(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function buildOpenAIRequest(
  req: AnthropicRequest,
  modelOverride?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelOverride ?? req.model,
    messages: buildOpenAIMessages(req.system, req.messages),
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop_sequences?.length) body.stop = req.stop_sequences;
  if (req.tools?.length) {
    body.tools = convertTools(req.tools);
    if (req.tool_choice) {
      if (req.tool_choice.type === 'auto') body.tool_choice = 'auto';
      else if (req.tool_choice.type === 'any') body.tool_choice = 'required';
      else if (req.tool_choice.type === 'tool' && req.tool_choice.name) {
        body.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
      }
    }
  }
  return body;
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function convertOpenAIResponse(resp: OpenAIResponse, model: string): Record<string, unknown> {
  const choice = resp.choices[0];
  if (!choice) throw new Error('No choices in OpenAI response');

  const content: ContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls?.length) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  return {
    id: `msg_openai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ─── SSE stream conversion ────────────────────────────────────────

async function pipeAnthropicStream(
  openaiStream: ReadableStream<Uint8Array>,
  res: ServerResponse,
  model: string,
): Promise<void> {
  const msgId = `msg_openai_${Date.now()}`;
  const write = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  write('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  write('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  const reader = openaiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === '[DONE]') break;
        try {
          const chunk = JSON.parse(raw) as {
            choices?: Array<{ delta?: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason?: string | null }>;
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            write('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta.content },
            });
          }
        } catch {
          // malformed chunk, skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  write('content_block_stop', { type: 'content_block_stop', index: 0 });
  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  write('message_stop', { type: 'message_stop' });
}

// ─── Proxy server ─────────────────────────────────────────────────

export interface OpenAICompatProxyOptions {
  /** Base URL of the OpenAI-compatible endpoint, e.g. "https://models.inference.ai.azure.com" */
  baseUrl: string;
  /** API key / bearer token for the target service */
  apiKey: string;
  /** Override model name sent to the OpenAI endpoint */
  model?: string;
}

export interface OpenAICompatProxyHandle {
  port: number;
  close(): Promise<void>;
}

// ─── Proxy registry (one proxy per openai_compatible provider) ───

const _registry = new Map<string, OpenAICompatProxyHandle>();

/**
 * Return the port for a running proxy instance, starting one if needed.
 * Proxies are keyed by provider ID and reused across agent sessions.
 */
export async function getOrStartOpenAIProxy(opts: {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
}): Promise<number> {
  const existing = _registry.get(opts.providerId);
  if (existing) return existing.port;

  const handle = await startOpenAICompatProxy({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
  });
  _registry.set(opts.providerId, handle);
  logger.info(
    { providerId: opts.providerId, port: handle.port, baseUrl: opts.baseUrl },
    'OpenAI-compat proxy started for provider',
  );
  return handle.port;
}

/**
 * Stop and remove the proxy for a given provider ID.
 * Called when the provider is deleted or disabled.
 */
export async function stopOpenAIProxy(providerId: string): Promise<void> {
  const handle = _registry.get(providerId);
  if (!handle) return;
  _registry.delete(providerId);
  await handle.close().catch(() => {/* best-effort */});
}

/**
 * Start a local Anthropic→OpenAI proxy server.
 * Returns the port it's listening on and a close() handle.
 */
export function startOpenAICompatProxy(
  options: OpenAICompatProxyOptions,
): Promise<OpenAICompatProxyHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse): void => {
        void handleRequest(req, res, options);
      },
    );

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      logger.info(
        { port: addr.port, targetUrl: options.baseUrl },
        'OpenAI-compat proxy listening',
      );
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });

    server.on('error', reject);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAICompatProxyOptions,
): Promise<void> {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404);
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'Not found' } }));
    return;
  }

  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let anthropicReq: AnthropicRequest;
  try {
    anthropicReq = JSON.parse(rawBody) as AnthropicRequest;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
    return;
  }

  const openaiBody = buildOpenAIRequest(anthropicReq, options.model);
  const targetUrl = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;

  logger.debug(
    { targetUrl, model: openaiBody.model, stream: openaiBody.stream },
    'Proxying Anthropic request to OpenAI endpoint',
  );

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        'User-Agent': 'happyclaw-openai-compat-proxy/1.0',
      },
      body: JSON.stringify(openaiBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upstream fetch failed';
    logger.warn({ err, targetUrl }, 'OpenAI proxy: upstream request failed');
    res.writeHead(502);
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
    return;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.warn(
      { status: response.status, targetUrl, body: errText.slice(0, 200) },
      'OpenAI proxy: upstream returned error',
    );
    res.writeHead(response.status);
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText || `Upstream error ${response.status}` } }));
    return;
  }

  if (anthropicReq.stream && response.body) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    try {
      await pipeAnthropicStream(response.body, res, anthropicReq.model);
    } catch (err) {
      logger.warn({ err }, 'OpenAI proxy: error during stream pipe');
    }
    res.end();
    return;
  }

  // Non-streaming
  let openaiResp: OpenAIResponse;
  try {
    openaiResp = (await response.json()) as OpenAIResponse;
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Failed to parse upstream response' } }));
    return;
  }

  try {
    const anthropicResp = convertOpenAIResponse(openaiResp, anthropicReq.model);
    res.writeHead(200);
    res.end(JSON.stringify(anthropicResp));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Conversion error';
    res.writeHead(500);
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
  }
}
