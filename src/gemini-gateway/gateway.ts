// ─── Gemini 订阅网关 — Hono 子应用 ────────────────────────────────
//
// 挂载在主服务 GEMINI_GATEWAY_ROUTE 下，处理 Claude Agent SDK 发出的
// POST {route}/v1/messages 与 {route}/v1/messages/count_tokens。
//
// 鉴权：Runner 环境里的 ANTHROPIC_API_KEY 就是 provider 的
// anthropicAuthToken（随机生成、加密随连接保存）。网关用 timing-safe 比较
// 把它映射回 provider，因此不存在第二套令牌体系；Google 的 access/refresh
// token 只在主服务进程内使用，从不下发给 Runner 或容器。
//
// 请求必须来自本机回环或私网，且不带反向代理转发头（与 Codex 网关一致）。

import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { logger } from '../logger.js';
import {
  getProviderById,
  setProviderGeminiOAuthRefreshErrorIfCurrent,
} from '../runtime-config.js';
import { rejectNonLocalGatewaySource } from '../codex-gateway/source-guard.js';
import {
  GeminiGatewayAuthError,
  GeminiReauthRequiredError,
  GeminiRefreshUnavailableError,
  findGeminiProviderByGatewayIdentifier,
  resolveGeminiAccess,
  type GeminiAccess,
} from './token-manager.js';
import {
  normalizeRequestModel,
  translateAnthropicRequest,
  type AnthropicMessagesRequest,
} from './translate-request.js';
import {
  GeminiStreamTranslator,
  foldAnthropicEvents,
  type AnthropicStreamEvent,
} from './translate-response.js';
import {
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  GEMINI_DEFAULT_MODEL,
  GEMINI_REQUEST_USER_AGENT,
  type GeminiModelInfo,
} from './types.js';

interface GeminiGatewayEnv {
  Bindings: {
    /** Set by @hono/node-server; absent bindings fail the source check. */
    incoming?: { socket?: { remoteAddress?: string } };
  };
  Variables: { geminiProviderId: string };
}

export const geminiGatewayApp = new Hono<GeminiGatewayEnv>();

/** Upstream must answer with headers within this window. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 180_000;
/** Silence allowed between upstream stream chunks (long reasoning is normal). */
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Downstream keepalive so Claude Code's idle watchdog sees traffic. */
const STREAM_KEEPALIVE_INTERVAL_MS = 15_000;
const PING_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n';

const requestBodyLimit = bodyLimit({
  maxSize: 32 * 1024 * 1024,
  onError: (c) =>
    c.json(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Payload too large' },
      },
      413,
    ),
});

function errorResponse(
  c: Context<GeminiGatewayEnv>,
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.json(
    { type: 'error', error: { type, message } },
    (status >= 400 && status < 600 ? status : 502) as ContentfulStatusCode,
    headers,
  );
}

function sseEncode(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
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

/**
 * Resolve the provider from the runner's credential. Runs before the body is
 * read so an unauthenticated caller cannot make the service allocate buffers.
 */
async function authenticateRunner(
  c: Context<GeminiGatewayEnv>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const reason = rejectNonLocalGatewaySource(
    c.req.raw.headers,
    c.env?.incoming?.socket?.remoteAddress,
  );
  if (reason) {
    return errorResponse(c, 403, 'permission_error', reason);
  }
  const identifier = extractGatewayToken(c.req.raw.headers);
  const provider = identifier
    ? findGeminiProviderByGatewayIdentifier(identifier)
    : null;
  if (!provider) {
    return errorResponse(
      c,
      401,
      'authentication_error',
      'Invalid or missing Gemini gateway credential',
    );
  }
  c.set('geminiProviderId', provider.id);
  await next();
}

function isAnthropicMessagesRequest(
  value: unknown,
): value is AnthropicMessagesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.messages);
}

function catalogEntryFor(
  providerId: string,
  model: string,
): GeminiModelInfo | null {
  const provider = getProviderById(providerId);
  const entry = provider?.geminiModels?.find((item) => item.id === model);
  return entry ?? null;
}

interface UpstreamCall {
  response: Response;
  abort: AbortController;
}

function buildUpstreamBody(
  payload: ReturnType<typeof translateAnthropicRequest>['payload'],
  model: string,
  projectId: string | null,
): Record<string, unknown> {
  return {
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    ...(projectId ? { project: projectId } : {}),
    request: payload,
  };
}

async function callUpstream(
  access: GeminiAccess,
  body: Record<string, unknown>,
  stream: boolean,
  clientSignal: AbortSignal,
): Promise<UpstreamCall> {
  const abort = new AbortController();
  const signal = AbortSignal.any([clientSignal, abort.signal]);
  const timeout = setTimeout(() => abort.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
  const path = stream
    ? `${GEMINI_API_VERSION}:streamGenerateContent?alt=sse`
    : `${GEMINI_API_VERSION}:generateContent`;
  try {
    const response = await fetch(`${GEMINI_API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': GEMINI_REQUEST_USER_AGENT,
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    return { response, abort };
  } finally {
    clearTimeout(timeout);
  }
}

interface UpstreamFailure {
  status: number;
  type: string;
  message: string;
  headers: Record<string, string>;
}

function upstreamErrorHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
    headers['Retry-After'] = retryAfter;
  }
  return headers;
}

function describeGoogleError(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    const status = (error as Record<string, unknown>).status;
    const parts: string[] = [];
    if (typeof status === 'string' && status) parts.push(status);
    if (typeof message === 'string' && message) parts.push(message);
    if (parts.length > 0) return parts.join(': ').slice(0, 500);
  }
  return '';
}

async function readFailureBody(response: Response): Promise<unknown> {
  const raw = await response.text().catch(() => '');
  const bounded = raw.length > 64 * 1024 ? raw.slice(0, 64 * 1024) : raw;
  try {
    return JSON.parse(bounded);
  } catch {
    return bounded ? { raw: bounded.slice(0, 500) } : null;
  }
}

/** Gemini rejects a replayed functionCall whose thoughtSignature it can no longer verify. */
function isSignatureRejection(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const text = JSON.stringify(body ?? '');
  return /thought[_ ]?signature/i.test(text);
}

function classifyUpstreamFailure(
  status: number,
  body: unknown,
  response: Response,
): UpstreamFailure {
  const detail = describeGoogleError(body);
  const headers = upstreamErrorHeaders(response);
  if (status === 401 || status === 403) {
    return {
      status: 401,
      type: 'authentication_error',
      message:
        'Google 账号授权已失效，请在「模型配置」中重新登录 Gemini 订阅账号。',
      headers: { ...headers, 'x-should-retry': 'false' },
    };
  }
  if (status === 429) {
    return {
      status: 429,
      type: 'rate_limit_error',
      message: `Gemini 上游额度已用尽或触发限流${detail ? `（${detail}）` : ''}，请稍后重试。`,
      headers,
    };
  }
  if (status === 400 || status === 404) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: `Gemini 上游拒绝了该请求${detail ? `：${detail}` : ''}`,
      headers: { ...headers, 'x-should-retry': 'false' },
    };
  }
  return {
    status: 502,
    type: 'api_error',
    message: `Gemini 上游错误${detail ? `：${detail}` : `（HTTP ${status}）`}`,
    headers,
  };
}

/** Access resolution failures, mapped to Anthropic error shapes. */
function accessFailure(c: Context<GeminiGatewayEnv>, err: unknown): Response {
  if (err instanceof GeminiReauthRequiredError) {
    return errorResponse(c, 401, 'authentication_error', err.message, {
      'x-should-retry': 'false',
    });
  }
  if (err instanceof GeminiRefreshUnavailableError) {
    return errorResponse(c, 503, 'overloaded_error', err.message, {
      'Retry-After': String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))),
    });
  }
  if (err instanceof GeminiGatewayAuthError) {
    return errorResponse(c, 401, 'authentication_error', err.message);
  }
  logger.error({ err }, 'Gemini gateway: resolving access failed');
  return errorResponse(c, 500, 'api_error', 'Gemini 网关内部错误');
}

geminiGatewayApp.post(
  '/v1/messages/count_tokens',
  authenticateRunner,
  requestBodyLimit,
  async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(
        c,
        400,
        'invalid_request_error',
        'Invalid JSON body',
      );
    }
    if (!isAnthropicMessagesRequest(raw)) {
      return errorResponse(
        c,
        400,
        'invalid_request_error',
        'messages must be an array',
      );
    }
    // The Antigravity API has no token counter; a conservative local estimate
    // keeps Claude Code's context accounting working (about 4 chars/token).
    let characters = 0;
    try {
      characters = JSON.stringify(raw.messages).length;
      if (typeof raw.system === 'string') characters += raw.system.length;
    } catch {
      characters = 0;
    }
    return c.json({ input_tokens: Math.max(1, Math.ceil(characters / 4)) });
  },
);

geminiGatewayApp.post(
  '/v1/messages',
  authenticateRunner,
  requestBodyLimit,
  async (c) => {
    const providerId = c.get('geminiProviderId');
    const startedAt = Date.now();
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(
        c,
        400,
        'invalid_request_error',
        'Invalid JSON body',
      );
    }
    if (!isAnthropicMessagesRequest(raw)) {
      return errorResponse(
        c,
        400,
        'invalid_request_error',
        'messages must be an array',
      );
    }
    const request = raw;
    const provider = getProviderById(providerId);
    if (!provider) {
      return errorResponse(c, 401, 'authentication_error', 'Gemini 连接不存在');
    }
    const requestedModel = normalizeRequestModel(request.model);
    const providerModel = normalizeRequestModel(provider.anthropicModel);
    const catalog = provider.geminiModels ?? [];
    // An empty catalog means "not fetched yet"; otherwise only a listed model
    // can be sent upstream, so a stale session or a Claude Code background
    // call (claude-haiku-*) falls back to the connection's own model.
    const known = (id: string): boolean =>
      !!id &&
      (catalog.length === 0 || catalog.some((entry) => entry.id === id));
    const fallbackModel =
      (known(providerModel) ? providerModel : '') ||
      catalog[0]?.id ||
      GEMINI_DEFAULT_MODEL;
    const model =
      known(requestedModel) && !/^claude[-._]/i.test(requestedModel)
        ? requestedModel
        : fallbackModel;
    const stream = request.stream !== false;

    let access: GeminiAccess;
    try {
      access = await resolveGeminiAccess(providerId);
    } catch (err) {
      return accessFailure(c, err);
    }
    if (!access.credentials.projectId) {
      return errorResponse(
        c,
        400,
        'invalid_request_error',
        'Gemini 连接缺少项目 ID，请重新登录 Google 账号。',
        { 'x-should-retry': 'false' },
      );
    }

    const catalogModel = catalogEntryFor(providerId, model);
    let translated = translateAnthropicRequest(request, catalogModel);
    let upstreamBody = buildUpstreamBody(
      translated.payload,
      model,
      access.credentials.projectId,
    );

    const sendUpstream = async (): Promise<UpstreamCall> =>
      callUpstream(access, upstreamBody, stream, c.req.raw.signal);

    let call: UpstreamCall;
    let bufferedFailure: { body: unknown } | null = null;
    try {
      call = await sendUpstream();
      // A signature Google can no longer verify (another account, an older
      // session) would poison the whole conversation. Replay that history as
      // plain text once; only tool results already in the transcript change.
      if (!call.response.ok) {
        const probe = await readFailureBody(call.response);
        if (isSignatureRejection(call.response.status, probe)) {
          logger.warn(
            { providerId, model },
            'Gemini gateway: upstream rejected a replayed thought signature; retrying without signatures',
          );
          translated = translateAnthropicRequest(request, catalogModel, {
            disableSignatures: true,
          });
          upstreamBody = buildUpstreamBody(
            translated.payload,
            model,
            access.credentials.projectId,
          );
          call = await sendUpstream();
        } else {
          bufferedFailure = { body: probe };
        }
      }
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return errorResponse(
        c,
        aborted ? 504 : 502,
        aborted ? 'timeout_error' : 'api_error',
        aborted ? 'Gemini 上游响应超时' : 'Gemini 上游连接失败，请稍后重试',
      );
    }

    if (!call.response.ok) {
      const body = bufferedFailure
        ? bufferedFailure.body
        : await readFailureBody(call.response);
      const failure = classifyUpstreamFailure(
        call.response.status,
        body,
        call.response,
      );
      // A 401 means the access token may have expired early: refresh once and
      // retry the same request before telling the user to log in again.
      if (call.response.status === 401) {
        try {
          const refreshed = await resolveGeminiAccess(providerId, {
            forceRefresh: true,
          });
          const retry = await callUpstream(
            refreshed,
            upstreamBody,
            stream,
            c.req.raw.signal,
          );
          if (retry.response.ok) {
            call = retry;
          } else {
            const retryBody = await readFailureBody(retry.response);
            const retryFailure = classifyUpstreamFailure(
              retry.response.status,
              retryBody,
              retry.response,
            );
            if (retry.response.status === 401) {
              setProviderGeminiOAuthRefreshErrorIfCurrent(
                providerId,
                refreshed.credentials,
                {
                  kind: 'reauth_required',
                  message: 'Google access token 被上游拒绝',
                  at: new Date().toISOString(),
                },
              );
            }
            logger.warn(
              {
                providerId,
                model,
                status: retry.response.status,
                detail: describeGoogleError(retryBody),
              },
              'Gemini gateway: upstream request failed after refresh',
            );
            return errorResponse(
              c,
              retryFailure.status,
              retryFailure.type,
              retryFailure.message,
              retryFailure.headers,
            );
          }
        } catch (err) {
          return accessFailure(c, err);
        }
      } else {
        logger.warn(
          {
            providerId,
            model,
            status: call.response.status,
            detail: describeGoogleError(body),
          },
          'Gemini gateway: upstream request failed',
        );
        return errorResponse(
          c,
          failure.status,
          failure.type,
          failure.message,
          failure.headers,
        );
      }
    }

    const messageId = `msg_gemini_${randomBytes(12).toString('hex')}`;
    const usage: Record<string, number> = {};

    if (!stream) {
      const events: AnthropicStreamEvent[] = [];
      const translator = new GeminiStreamTranslator({
        model,
        messageId,
        reverseToolNameMap: translated.reverseToolNameMap,
        onEvent: (event) => events.push(event),
      });
      try {
        const body = (await call.response.json()) as Record<string, unknown>;
        if (body && typeof body === 'object' && body.response) {
          translator.ingest(body);
        } else if (body && typeof body === 'object') {
          translator.ingest({ response: body });
        }
        translator.finalize();
      } catch (err) {
        logger.warn(
          { err, providerId, model },
          'Gemini gateway: bad upstream JSON',
        );
        return errorResponse(
          c,
          502,
          'api_error',
          'Gemini 上游返回了无法解析的响应',
        );
      }
      const message = foldAnthropicEvents(events, { model, messageId });
      usage.input_tokens = message.usage.input_tokens;
      usage.output_tokens = message.usage.output_tokens;
      logger.info(
        {
          providerId,
          model,
          stream: false,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          durationMs: Date.now() - startedAt,
        },
        'Gemini gateway: request proxied',
      );
      return c.json(message);
    }

    const reader = call.response.body?.getReader();
    if (!reader) {
      return errorResponse(c, 502, 'api_error', 'Gemini 上游没有返回响应体');
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const abort = call.abort;
    const idleTimer = { handle: null as ReturnType<typeof setTimeout> | null };
    let clientGone = false;
    const onClientAbort = () => {
      clientGone = true;
      abort.abort();
    };
    c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });
    if (c.req.raw.signal.aborted) onClientAbort();

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        let lastWrite = Date.now();
        const emit = (event: AnthropicStreamEvent): void => {
          if (closed) return;
          lastWrite = Date.now();
          controller.enqueue(encoder.encode(sseEncode(event)));
        };
        const translator = new GeminiStreamTranslator({
          model,
          messageId,
          reverseToolNameMap: translated.reverseToolNameMap,
          onEvent: emit,
        });
        const pingTimer = setInterval(() => {
          if (closed) return;
          if (Date.now() - lastWrite < STREAM_KEEPALIVE_INTERVAL_MS) return;
          lastWrite = Date.now();
          try {
            controller.enqueue(encoder.encode(PING_FRAME));
          } catch {
            /* client already gone */
          }
        }, 5_000);
        const armIdle = () => {
          if (idleTimer.handle) clearTimeout(idleTimer.handle);
          idleTimer.handle = setTimeout(() => {
            abort.abort();
          }, UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
        };
        let buffer = '';
        const ingestLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') return;
          try {
            translator.ingest(JSON.parse(data));
          } catch {
            // Ignore a malformed frame; the stream either recovers or ends.
          }
        };
        try {
          armIdle();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              for (const line of frame.split('\n')) ingestLine(line);
              boundary = buffer.indexOf('\n\n');
            }
          }
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) ingestLine(line);
          }
          translator.finalize();
        } catch (err) {
          if (!clientGone) {
            logger.warn(
              { err, providerId, model },
              'Gemini gateway: upstream stream interrupted',
            );
            emit({
              event: 'error',
              data: {
                type: 'error',
                error: {
                  type: 'api_error',
                  message: 'Gemini 上游流中断，请重试。',
                },
              },
            });
          }
        } finally {
          clearInterval(pingTimer);
          if (idleTimer.handle) clearTimeout(idleTimer.handle);
          c.req.raw.signal.removeEventListener('abort', onClientAbort);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already cancelled */
          }
          logger.info(
            {
              providerId,
              model,
              stream: true,
              durationMs: Date.now() - startedAt,
            },
            'Gemini gateway: stream finished',
          );
        }
      },
      cancel() {
        clientGone = true;
        abort.abort();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);
