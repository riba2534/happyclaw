// ─── ChatGPT/Codex 订阅网关 — Hono 子应用 ──────────────────────────
//
// 挂载在主服务 CODEX_GATEWAY_ROUTE 下，只处理 Claude Agent SDK 会发出的
// POST {route}/v1/messages。鉴权用 provider 的 gateway token（SDK 把裸
// token 当 ANTHROPIC_API_KEY 发送，落在 x-api-key 头），不是真实 ChatGPT
// token —— 真实 token 只在网关进程内部持有，不会下发给 Runner/容器。

import { Hono } from 'hono';

import { logger } from '../logger.js';
import { getProviderById } from '../runtime-config.js';
import type { ReadableStreamReadResult } from 'node:stream/web';
import {
  anthropicToResponses,
  resolveCodexModel,
  type AnthropicRequestSubset,
} from './convert-request.js';
import { clampCodexEffortWithCatalog } from './model-catalog.js';
import { getResolvedCodexCatalog } from './model-catalog-sync.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
  CodexUpstreamError,
  type AnthropicStreamEvent,
} from './convert-response.js';
import { CodexGatewayAuthError, resolveCodexAccess } from './token-manager.js';
import { CODEX_BACKEND_RESPONSES_URL } from './types.js';

export const codexGatewayApp = new Hono();

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

// ─── 网关 token 维度的固定窗口限流 ─────────────────────────────────
// 网关 token 存在于每个 Runner 环境里（ANTHROPIC_AUTH_TOKEN），被提示注入
// 或攻陷的 Agent 可以拿它直接消耗订阅。限流 + 成功请求日志给管理员留出
// 发现与轮换的信号窗口。
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const rateLimitCounters = new Map<
  string,
  { windowStart: number; count: number }
>();

function isRateLimited(gatewayToken: string): boolean {
  const now = Date.now();
  const counter = rateLimitCounters.get(gatewayToken);
  if (!counter || now - counter.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitCounters.set(gatewayToken, { windowStart: now, count: 1 });
    if (rateLimitCounters.size > 1024) {
      // token 数量有界（= provider 数），这里只清理过期窗口防极端堆积。
      for (const [key, entry] of rateLimitCounters) {
        if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
          rateLimitCounters.delete(key);
        }
      }
    }
    return false;
  }
  counter.count += 1;
  return counter.count > RATE_LIMIT_MAX_REQUESTS;
}

/** 成功代理请求的轻量审计日志：只记模型与 token 用量，不记消息内容。 */
function logGatewaySuccess(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  },
): void {
  logger.info(
    {
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    },
    'Codex gateway: request proxied',
  );
}

function extractGatewayToken(headers: Headers): string | null {
  const apiKey = headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return null;
}

interface UpstreamSseLine {
  event?: string;
  data?: string;
}

/** 逐行解析上游 SSE 文本为 (event, data) 对；data 以 JSON.parse 消费。 */
async function* iterateUpstreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: UpstreamSseLine = {};

  const flush = function* (): Generator<Record<string, unknown>> {
    if (current.data === undefined) return;
    try {
      yield JSON.parse(current.data) as Record<string, unknown>;
    } catch (err) {
      logger.warn(
        { err },
        'Codex gateway: failed to parse upstream SSE data line',
      );
    }
    current = {};
  };

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new Error('Upstream Codex stream stalled'));
        }, 60_000);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      const { value, done } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed === '') {
          yield* flush();
          continue;
        }
        if (trimmed.startsWith('event:')) {
          current.event = trimmed.slice('event:'.length).trim();
        } else if (trimmed.startsWith('data:')) {
          const chunk = trimmed.slice('data:'.length).trim();
          current.data =
            current.data === undefined ? chunk : `${current.data}\n${chunk}`;
        }
      }
    }
    // SSE 规范：EOF 时未被空行终止的最后一行也要分发。上游可能不发结尾
    // 空行——丢掉它会把成功的 response.completed 误判成断流失败。
    const trailing = buffer.replace(/\r$/, '');
    if (trailing.startsWith('data:')) {
      const chunk = trailing.slice('data:'.length).trim();
      current.data =
        current.data === undefined ? chunk : `${current.data}\n${chunk}`;
    } else if (trailing.startsWith('event:')) {
      current.event = trailing.slice('event:'.length).trim();
    }
    buffer = '';
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

codexGatewayApp.post('/v1/messages', async (c) => {
  const gatewayToken = extractGatewayToken(c.req.raw.headers);
  if (!gatewayToken) {
    return c.json(
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'Missing API key' },
      },
      401,
    );
  }

  if (isRateLimited(gatewayToken)) {
    logger.warn('Codex gateway: rate limit exceeded for gateway token');
    return c.json(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Codex gateway rate limit exceeded, retry later',
        },
      },
      429,
    );
  }

  let access;
  try {
    access = await resolveCodexAccess(gatewayToken);
  } catch (err) {
    const message =
      err instanceof CodexGatewayAuthError
        ? err.message
        : 'Codex authentication failed';
    logger.warn({ err }, 'Codex gateway: auth failed');
    return c.json(
      { type: 'error', error: { type: 'authentication_error', message } },
      401,
    );
  }

  const provider = getProviderById(access.providerId);
  const targetModel = resolveCodexModel(
    undefined,
    provider?.anthropicModel || '',
  );
  const configuredEffort = provider?.customEnv?.CODEX_REASONING_EFFORT;

  let anthropicRequest: AnthropicRequestSubset;
  let wantsStream = true;
  try {
    const raw = (await c.req.json()) as AnthropicRequestSubset & {
      stream?: boolean;
    };
    anthropicRequest = raw;
    wantsStream = raw.stream !== false;
  } catch {
    return c.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
      },
      400,
    );
  }

  const requestModel = resolveCodexModel(anthropicRequest.model, targetModel);
  const responsesRequest = anthropicToResponses(anthropicRequest, {
    targetModel: requestModel,
    // 目录钳制：存量配置里被上游移除的 effort 档（如 minimal）或模型不支持
    // 的档位在请求侧归位，避免上游 400；与前端切模型归位逻辑语义一致。
    // 目录用解析后的实时目录（上游同步结果优先，baked-in 兜底）。
    reasoningEffort: clampCodexEffortWithCatalog(
      getResolvedCodexCatalog().models,
      requestModel,
      configuredEffort,
    ),
    requestTools: !!anthropicRequest.tools?.length,
  });

  const controller = new AbortController();
  const FETCH_TIMEOUT_MS = 30_000;
  const fetchTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), {
    once: true,
  });

  let upstream: Response;
  try {
    upstream = await fetch(CODEX_BACKEND_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(access.accountId ? { 'chatgpt-account-id': access.accountId } : {}),
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify(responsesRequest),
      signal: controller.signal,
    });
    clearTimeout(fetchTimeout);
  } catch (err) {
    clearTimeout(fetchTimeout);
    logger.warn({ err }, 'Codex gateway: upstream request failed');
    return c.json(
      {
        type: 'error',
        error: { type: 'api_error', message: 'Upstream Codex request failed' },
      },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    // 上游错误体可能回显请求片段（会话内容），截断后再进日志。
    const detail = (await upstream.text().catch(() => '')).slice(0, 512);
    logger.warn(
      { status: upstream.status, detail },
      'Codex gateway: upstream rejected request',
    );
    return c.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream Codex backend returned ${upstream.status}`,
        },
      },
      upstream.status >= 400 && upstream.status < 600
        ? (upstream.status as any)
        : 502,
    );
  }

  const converter = new ResponsesToAnthropicConverter(responsesRequest.model);

  if (!wantsStream) {
    const events: Record<string, unknown>[] = [];
    // 非流式聚合需要一个整体上限：60s 只是块间超时，慢滴上游可以无限
    // 拖住请求和 events 数组。上限对齐 Anthropic SDK 客户端默认 10 分钟。
    const AGGREGATE_DEADLINE_MS = 600_000;
    const deadline = setTimeout(
      () => controller.abort(),
      AGGREGATE_DEADLINE_MS,
    );
    try {
      for await (const event of iterateUpstreamEvents(upstream.body)) {
        events.push(event);
      }
      const aggregated = aggregateResponsesStream(
        events,
        responsesRequest.model,
      );
      logGatewaySuccess(responsesRequest.model, aggregated.usage);
      return c.json({
        id: aggregated.id,
        type: 'message',
        role: 'assistant',
        model: aggregated.model,
        content: aggregated.content,
        stop_reason: aggregated.stopReason,
        stop_sequence: null,
        usage: aggregated.usage,
      });
    } catch (err) {
      controller.abort();
      if (err instanceof CodexUpstreamError) {
        logger.warn(
          { code: err.code, errorType: err.errorType },
          'Codex gateway: upstream reported failure',
        );
        return c.json(
          {
            type: 'error',
            error: { type: err.errorType, message: err.message },
          },
          err.status as 400 | 429 | 502,
        );
      }
      const timedOut = err instanceof Error && err.name === 'AbortError';
      logger.warn({ err }, 'Codex gateway: upstream stream failed');
      return c.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: timedOut
              ? 'Upstream Codex stream timed out'
              : 'Upstream Codex stream failed',
          },
        },
        timedOut ? 504 : 502,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controllerStream) {
      const encoder = new TextEncoder();
      try {
        for await (const upstreamEvent of iterateUpstreamEvents(
          upstream.body!,
        )) {
          for (const outEvent of converter.handleEvent(upstreamEvent)) {
            controllerStream.enqueue(encoder.encode(sseEncode(outEvent)));
          }
        }
        for (const outEvent of converter.finish()) {
          controllerStream.enqueue(encoder.encode(sseEncode(outEvent)));
        }
        const failure = converter.getFailure();
        if (failure) {
          logger.warn(
            { code: failure.code, errorType: failure.type },
            'Codex gateway: upstream reported failure',
          );
        } else {
          logGatewaySuccess(responsesRequest.model, converter.getUsage());
        }
      } catch (err) {
        logger.warn({ err }, 'Codex gateway: stream translation failed');
        controllerStream.enqueue(
          encoder.encode(
            sseEncode({
              event: 'error',
              data: {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'Codex gateway stream failed',
                },
              },
            }),
          ),
        );
      } finally {
        controllerStream.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
