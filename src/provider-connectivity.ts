// 模型连接的「测试连接」与「获取模型列表」：用与 Runner 相同的认证头和自定义
// Header 直接调用上游——第三方端点和 Anthropic API Key 发一次很小的
// POST /v1/messages 或读模型列表，订阅只做不计费的账号检查——在保存前就暴露
// 端点、密钥、认证方式和模型名的配置错误，而不是等到真实对话里才失败。
// 结果只回传状态码、耗时、错误分类和脱敏后的错误摘要，绝不回传密钥。

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { CLAUDE_OAUTH_BETA, CLAUDE_OAUTH_USAGE_URL } from './claude-oauth.js';
import {
  classifyProviderError,
  parseModelList,
  splitOneMillionSuffix,
  type DiscoveredModel,
  type ProviderErrorCode,
  type ProviderTestRecord,
} from './model-providers.js';
import type { ProviderAuthMode } from './runtime-config.js';

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_EXCERPT = 300;
/** Model list bodies past this are cut; no vendor lists that many models. */
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
/** Model probed when a pass-through relay leaves the provider model empty. */
export const PASS_THROUGH_PROBE_MODEL = 'claude-haiku-5-5';
/** Where official API keys are checked: Claude Code's default endpoint. */
export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

/**
 * What a Claude subscription offers. Claude Code resolves these family
 * aliases to the newest model the account may use, so the list needs no
 * request and never goes stale.
 */
export const CLAUDE_SUBSCRIPTION_MODELS: readonly DiscoveredModel[] = [
  { id: 'opus', name: 'Claude Opus' },
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'haiku', name: 'Claude Haiku' },
  { id: 'fable', name: 'Claude Fable' },
];

type FetchOptions = { timeoutMs?: number; fetchImpl?: typeof fetch };

export interface ProviderConnectivityInput {
  baseUrl: string;
  token: string;
  authMode: ProviderAuthMode;
  model: string;
  customHeaders?: string;
}

export interface ProviderConnectivityProbe {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  /** Redacted upstream error excerpt; absent on success. */
  message?: string;
  /** What to check next, in the admin's language. */
  hint?: string;
  /** Why the request failed; absent on success. */
  code?: ProviderErrorCode;
}

function claudeCodeUserAgent(): string {
  // Some coding-plan endpoints only admit coding agents, so probe with the
  // same User-Agent family the bundled Claude Code sends.
  try {
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json') as {
      claudeCodeVersion?: string;
    };
    if (pkg.claudeCodeVersion) {
      return `claude-cli/${pkg.claudeCodeVersion} (external, sdk-ts)`;
    }
  } catch {
    // Fall through to a version-less agent string.
  }
  return 'claude-cli (external, sdk-ts)';
}

/** `Name: value` lines, as Claude Code reads ANTHROPIC_CUSTOM_HEADERS. */
export function parseCustomHeaders(
  raw: string | undefined,
): [string, string][] {
  if (!raw) return [];
  const headers: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) headers.push([name, value]);
  }
  return headers;
}

/** Custom header values can carry credentials of their own. */
function customHeaderValues(raw: string | undefined): string[] {
  return parseCustomHeaders(raw).map(([, value]) => value);
}

/** Same URL Claude Code builds: the SDK appends `/v1/messages` to the base. */
export function buildMessagesUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/v1/messages`;
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    // A raw JSON body escapes `/` as `\/`.
    for (const form of new Set([secret, secret.replace(/\//g, '\\/')])) {
      out = out.split(form).join('***');
    }
  }
  // Long opaque tokens that might be echoed back by a gateway.
  out = out.replace(/\b(sk|ak|key|tok)[-_][A-Za-z0-9_-]{12,}\b/gi, '***');
  return out.length > MAX_ERROR_EXCERPT
    ? `${out.slice(0, MAX_ERROR_EXCERPT)}…`
    : out;
}

function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; type?: unknown } | string;
      message?: unknown;
      msg?: unknown;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') {
      return parsed.error.message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.msg === 'string') return parsed.msg;
  } catch {
    // Not JSON; use the raw text.
  }
  return body.trim();
}

export function hintForStatus(
  status: number | null,
  message: string,
  authMode: ProviderAuthMode,
): string | undefined {
  if (status === null) {
    return /abort|timeout/i.test(message)
      ? '请求超时：检查端点是否可达，或网络是否需要代理'
      : '无法连接端点：检查地址、端口和网络连通性';
  }
  if (status === 401 || status === 403) {
    const other = authMode === 'bearer' ? 'x-api-key' : 'Bearer';
    return `认证失败：检查 API 密钥是否正确，或把认证方式切换为 ${other} 再试`;
  }
  if (status === 404) {
    return /model/i.test(message)
      ? '模型不存在：检查模型名称是否为该端点支持的值'
      : '路径不存在：端点通常填到 /anthropic 这一级，不要以 /v1 或 /v1/messages 结尾';
  }
  if (status === 400 && /model/i.test(message)) {
    return '请求被拒绝：检查模型名称是否为该端点支持的值';
  }
  if (status === 429) return '已触发限流或额度用尽，稍后再试';
  if (status >= 500) return '端点服务端错误，稍后再试或联系服务商';
  return undefined;
}

// ─── Upstream requests ─────────────────────────────────────────

interface UpstreamAnswer {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  bodyText: string;
  networkErrorCode?: string;
  errorMessage?: string;
}

async function requestUpstream(
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  },
  options: FetchOptions & { maxBytes?: number },
): Promise<UpstreamAnswer> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await (options.fetchImpl ?? fetch)(url, { ...init, signal });
    const latencyMs = Date.now() - startedAt;
    const bodyText = await readCapped(res, options.maxBytes ?? 64 * 1024);
    return { ok: res.ok, status: res.status, latencyMs, bodyText };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      bodyText: '',
      networkErrorCode: networkErrorCodeOf(err, signal.aborted),
      errorMessage: signal.aborted ? `timeout: ${raw}` : raw,
    };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf-8');
}

function answerProbe(
  answer: UpstreamAnswer,
  secrets: string[],
  model = '',
): ProviderConnectivityProbe {
  if (answer.ok) {
    return {
      model,
      ok: true,
      status: answer.status,
      latencyMs: answer.latencyMs,
    };
  }
  const message = redact(
    answer.errorMessage ?? upstreamMessage(answer.bodyText),
    secrets.map((secret) => secret.replace(/^Bearer\s+/i, '')),
  );
  return {
    model,
    ok: false,
    status: answer.status,
    latencyMs: answer.latencyMs,
    message: message || `HTTP ${answer.status}`,
    code: classifyProviderError({
      status: answer.status ?? undefined,
      bodyText: answer.bodyText,
      networkErrorCode: answer.networkErrorCode,
    }).code,
  };
}

/**
 * The headers Claude Code sends: version, user agent, session, custom,
 * credential. Gateways that route by session (OpenCode Go refuses a request
 * without one) accept Claude Code's own session header, so each probe sends
 * a fresh one rather than any gateway's private header.
 */
function upstreamHeaders(
  credential: string,
  authMode: ProviderAuthMode,
  customHeaders?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'user-agent': claudeCodeUserAgent(),
    'x-claude-code-session-id': randomUUID(),
  };
  for (const [name, value] of parseCustomHeaders(customHeaders)) {
    headers[name.toLowerCase()] = value;
  }
  const token = credential.replace(/^Bearer\s+/i, '');
  if (authMode === 'x-api-key') headers['x-api-key'] = token;
  else headers.authorization = `Bearer ${token}`;
  return headers;
}

/** The code undici or the abort left on a failed fetch. */
function networkErrorCodeOf(err: unknown, aborted: boolean): string {
  if (aborted) return 'TimeoutError';
  const record = err as { cause?: { code?: unknown }; code?: unknown };
  const code = record?.cause?.code ?? record?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.name : 'Error';
}

export async function probeProviderModel(
  input: ProviderConnectivityInput,
  options: FetchOptions = {},
): Promise<ProviderConnectivityProbe> {
  // Claude Code strips the [1m] suffix before calling the API.
  const model =
    splitOneMillionSuffix(input.model).model || PASS_THROUGH_PROBE_MODEL;
  const answer = await requestUpstream(
    buildMessagesUrl(input.baseUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...upstreamHeaders(input.token, input.authMode, input.customHeaders),
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    },
    options,
  );
  const probe = answerProbe(
    answer,
    [input.token, ...customHeaderValues(input.customHeaders)],
    model,
  );
  return probe.ok
    ? probe
    : {
        ...probe,
        hint: hintForStatus(answer.status, probe.message!, input.authMode),
      };
}

/**
 * Probe the provider model and, when Haiku is mapped to a different model
 * (background calls such as titles use it), that model too.
 */
export async function testProviderConnectivity(
  input: ProviderConnectivityInput & { haikuModel?: string },
  options: FetchOptions = {},
): Promise<{ ok: boolean; probes: ProviderConnectivityProbe[] }> {
  const models = [input.model];
  const haiku = input.haikuModel?.trim();
  if (haiku && haiku !== input.model.trim()) models.push(haiku);
  const probes = await Promise.all(
    models.map((model) => probeProviderModel({ ...input, model }, options)),
  );
  return { ok: probes.every((probe) => probe.ok), probes };
}

// ─── Tests of every kind of connection ─────────────────────────

export interface ConnectionTestResult {
  ok: boolean;
  probes: ProviderConnectivityProbe[];
  /** Why the test failed; null when it passed. */
  code: ProviderErrorCode | null;
  /** The auth header style the endpoint accepted, when one was tried. */
  authMode?: ProviderAuthMode;
  record: ProviderTestRecord;
}

/** Summarize probes the way a connection keeps its last test. */
export function connectionTestResult(
  result: { ok: boolean; probes: ProviderConnectivityProbe[] },
  options: { model: string | null; authMode?: ProviderAuthMode },
): ConnectionTestResult {
  const failed = result.probes.find((probe) => !probe.ok);
  const main = result.probes[0];
  const code = result.ok ? null : (failed?.code ?? 'UNKNOWN');
  return {
    ...result,
    code,
    ...(options.authMode ? { authMode: options.authMode } : {}),
    record: {
      ok: result.ok,
      code,
      // A failure without an answer (a timeout) has no status.
      status: failed ? failed.status : (main?.status ?? null),
      model: options.model,
      latencyMs: main?.latencyMs ?? null,
      at: new Date().toISOString(),
    },
  };
}

/** Whether a refusal may only mean the key went in the wrong header. */
function refusedCredential(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Failures an endpoint reports only once it has accepted the credential:
 * it then judged the model or the request itself.
 */
const AFTER_AUTH_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'MODEL_NOT_FOUND',
  'CONTEXT_TOO_LONG',
  'WIRE_INCOMPATIBLE',
]);

/** Whether a probe proves the endpoint took the credential as sent. */
function probeAcceptedCredential(
  probe: ProviderConnectivityProbe | undefined,
): boolean {
  return !!probe && (probe.ok || AFTER_AUTH_CODES.has(probe.code!));
}

/**
 * Run `attempt` with `first`, and once more with the other header style when
 * the endpoint refused the credential and nobody chose a style. A style is
 * reported only when its attempt proves the credential was accepted; a retry
 * that times out, is throttled or fails otherwise proves nothing, so the
 * first answer stands and no style is reported.
 */
export async function withAuthModeFallback<T>(
  first: ProviderAuthMode,
  explicit: boolean,
  attempt: (mode: ProviderAuthMode) => Promise<T>,
  outcome: {
    refused: (result: T) => boolean;
    accepted: (result: T) => boolean;
  },
): Promise<{
  result: T;
  authMode: ProviderAuthMode | undefined;
  bothRefused: boolean;
}> {
  const result = await attempt(first);
  if (explicit || !outcome.refused(result)) {
    return {
      result,
      authMode: outcome.accepted(result) ? first : undefined,
      bothRefused: false,
    };
  }
  const other: ProviderAuthMode = first === 'bearer' ? 'x-api-key' : 'bearer';
  const retry = await attempt(other);
  return outcome.accepted(retry)
    ? { result: retry, authMode: other, bothRefused: false }
    : { result, authMode: undefined, bothRefused: outcome.refused(retry) };
}

/** Third-party endpoint: the runner's own request, header style found by trial. */
export async function testThirdPartyConnection(
  input: ProviderConnectivityInput & {
    haikuModel?: string;
    /** Set when the connection or the request chose a style. */
    explicitAuthMode: boolean;
  },
  run: typeof testProviderConnectivity = testProviderConnectivity,
): Promise<ConnectionTestResult> {
  const { explicitAuthMode, ...probeInput } = input;
  const { result, authMode, bothRefused } = await withAuthModeFallback(
    input.authMode,
    explicitAuthMode,
    (mode) => run({ ...probeInput, authMode: mode }),
    {
      refused: (outcome) => refusedCredential(outcome.probes[0]?.status),
      accepted: (outcome) => probeAcceptedCredential(outcome.probes[0]),
    },
  );
  if (bothRefused && result.probes[0]) {
    result.probes[0].hint =
      '认证失败：两种认证方式都被拒绝，检查 API 密钥是否正确';
  }
  return connectionTestResult(result, {
    model: result.probes[0]?.model ?? null,
    authMode,
  });
}

/** Model ids an official key can run as such; aliases resolve per release. */
function isConcreteClaudeModel(model: string): boolean {
  return /^claude-/i.test(splitOneMillionSuffix(model).model);
}

/**
 * Official API key: a minimal message on the connection's model when it names
 * a concrete Claude model, otherwise the model list, which bills nothing.
 */
export async function testAnthropicApiKey(
  input: { credential: string; authMode: ProviderAuthMode; model: string },
  options: FetchOptions = {},
): Promise<ConnectionTestResult> {
  if (isConcreteClaudeModel(input.model)) {
    const result = await testProviderConnectivity(
      {
        baseUrl: ANTHROPIC_API_ORIGIN,
        token: input.credential,
        authMode: input.authMode,
        model: input.model,
      },
      options,
    );
    return connectionTestResult(result, {
      model: result.probes[0]?.model ?? null,
    });
  }
  const answer = await requestUpstream(
    `${ANTHROPIC_API_ORIGIN}/v1/models?limit=1`,
    {
      method: 'GET',
      headers: upstreamHeaders(input.credential, input.authMode),
    },
    options,
  );
  return connectionTestResult(
    { ok: answer.ok, probes: [answerProbe(answer, [input.credential])] },
    { model: null },
  );
}

/**
 * Claude subscription: read the account's usage, which bills nothing. A
 * grant without the profile scope (a setup-token) is refused for its scope,
 * which still proves the token itself is valid.
 */
export async function checkClaudeAccount(
  accessToken: string,
  options: FetchOptions = {},
): Promise<ConnectionTestResult> {
  const answer = await requestUpstream(
    CLAUDE_OAUTH_USAGE_URL,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'content-type': 'application/json',
      },
    },
    options,
  );
  // Only a refusal that names the missing scope says the token is fine; any
  // other 403 (an organization that disallows OAuth, say) is a failure.
  const scopeOnly =
    answer.status === 403 &&
    /\bscopes?\b|\buser:[a-z_:]+/i.test(upstreamMessage(answer.bodyText));
  return connectionTestResult(
    {
      ok: answer.ok || scopeOnly,
      probes: [
        answerProbe(scopeOnly ? { ...answer, ok: true } : answer, [
          accessToken,
        ]),
      ],
    },
    { model: null },
  );
}

// ─── Model lists ───────────────────────────────────────────────

export type ModelDiscoveryResult =
  | {
      ok: true;
      models: DiscoveredModel[];
      source: 'endpoint' | 'builtin' | 'catalog';
      authMode?: ProviderAuthMode;
    }
  | {
      ok: false;
      code: ProviderErrorCode;
      status: number | null;
      message: string;
    };

/**
 * Read a vendor's model list. A missing list endpoint reads as a wrong
 * address, and a body that is not a model list as UNKNOWN.
 */
export async function discoverEndpointModels(
  input: {
    url: string;
    credential: string;
    authMode: ProviderAuthMode;
    explicitAuthMode: boolean;
    customHeaders?: string;
  },
  options: FetchOptions = {},
): Promise<ModelDiscoveryResult> {
  const { result: answer, authMode } = await withAuthModeFallback(
    input.authMode,
    input.explicitAuthMode,
    (mode) =>
      requestUpstream(
        input.url,
        {
          method: 'GET',
          headers: upstreamHeaders(input.credential, mode, input.customHeaders),
        },
        { ...options, maxBytes: MAX_MODEL_LIST_BYTES },
      ),
    {
      refused: (outcome) => refusedCredential(outcome.status),
      accepted: (outcome) => outcome.ok,
    },
  );
  let models: DiscoveredModel[] | null = null;
  if (answer.ok) {
    try {
      models = parseModelList(JSON.parse(answer.bodyText));
    } catch {
      models = null;
    }
  }
  if (models) return { ok: true, models, source: 'endpoint', authMode };
  if (answer.ok) {
    return {
      ok: false,
      code: 'UNKNOWN',
      status: answer.status,
      message: '返回的内容不是模型列表',
    };
  }
  const probe = answerProbe(answer, [
    input.credential,
    ...customHeaderValues(input.customHeaders),
  ]);
  return {
    ok: false,
    code: answer.status === 404 ? 'ENDPOINT_NOT_FOUND' : probe.code!,
    status: answer.status,
    message: probe.message!,
  };
}

/** Official API key: Anthropic's own list. */
export function discoverAnthropicModels(
  input: { credential: string; authMode: ProviderAuthMode },
  options: FetchOptions = {},
): Promise<ModelDiscoveryResult> {
  return discoverEndpointModels(
    {
      url: `${ANTHROPIC_API_ORIGIN}/v1/models?limit=1000`,
      credential: input.credential,
      authMode: input.authMode,
      explicitAuthMode: true,
    },
    options,
  );
}
