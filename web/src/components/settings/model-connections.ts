import {
  PROVIDER_ERROR_COPY,
  getModelPreset,
  splitOneMillionSuffix,
  type CatalogSyncResult,
  type DiscoveredModel,
  type ModelPreset,
  type ProviderErrorCode,
  type ProviderGateway,
  type ProviderTestRecord,
} from '@/lib/model-providers';
import { api } from '../../api/client';
import { formatSessionTime } from '../../lib/session-presentation';
import { confirmDialog } from '../../stores/confirm';
import type { UnifiedProviderPublic } from './types';

/**
 * What the Web knows about a model connection beyond its stored fields: the
 * kind the UI names it by, the status its last test left, and the requests
 * the wizard and the detail view share.
 */

export const PROVIDERS_API = '/api/config/claude/providers';

export type ConnectionKind =
  | 'claude_subscription'
  | 'anthropic_api'
  | 'chatgpt'
  | 'agy'
  | 'preset'
  | 'custom';

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  claude_subscription: 'Claude 订阅',
  anthropic_api: 'Anthropic API Key',
  chatgpt: 'ChatGPT 订阅',
  agy: 'Antigravity 订阅 (AGY)',
  preset: '厂商预设',
  custom: '自定义地址',
};

type KindFields = Pick<
  UnifiedProviderPublic,
  | 'type'
  | 'runner'
  | 'hasCodexOAuthCredentials'
  | 'claudeAuthKind'
  | 'hasAnthropicApiKey'
  | 'hasClaudeOAuthCredentials'
  | 'hasClaudeCodeOauthToken'
  | 'presetId'
>;

export function connectionKind(provider: KindFields): ConnectionKind {
  if (provider.runner === 'agy') return 'agy';
  if (provider.hasCodexOAuthCredentials) return 'chatgpt';
  if (provider.type === 'official') {
    const apiKey =
      provider.claudeAuthKind === 'api_key' ||
      (!provider.claudeAuthKind &&
        provider.hasAnthropicApiKey &&
        !provider.hasClaudeOAuthCredentials &&
        !provider.hasClaudeCodeOauthToken);
    return apiKey ? 'anthropic_api' : 'claude_subscription';
  }
  return getModelPreset(provider.presetId) ? 'preset' : 'custom';
}

/** Kinds that talk to an Anthropic-compatible address with a key. */
export function isThirdPartyKind(kind: ConnectionKind | null): boolean {
  return kind === 'preset' || kind === 'custom';
}

/** The label a row shows for its kind: a preset is named by its vendor. */
export function connectionKindLabel(provider: KindFields): string {
  const kind = connectionKind(provider);
  return kind === 'preset'
    ? (getModelPreset(provider.presetId)?.name ?? CONNECTION_KIND_LABELS.preset)
    : CONNECTION_KIND_LABELS[kind];
}

// ─── Status ────────────────────────────────────────────────────

export interface ConnectionStatus {
  tone: 'success' | 'error' | 'muted';
  label: string;
  /** The next step, for a failure. */
  hint?: string;
}

export function errorCopy(code: ProviderErrorCode | null | undefined) {
  return PROVIDER_ERROR_COPY[code ?? 'UNKNOWN'] ?? PROVIDER_ERROR_COPY.UNKNOWN;
}

/**
 * Configured is not connected: only a passed test says 已连接. A refused
 * login outranks an older passed test.
 */
export function connectionStatus(
  provider: Pick<
    UnifiedProviderPublic,
    'lastTest' | 'claudeOAuthNeedsReLogin' | 'codexOAuthNeedsReauth'
  >,
): ConnectionStatus {
  if (provider.claudeOAuthNeedsReLogin || provider.codexOAuthNeedsReauth) {
    return {
      tone: 'error',
      label: '需重新登录',
      hint: '登录已失效，打开连接重新登录。',
    };
  }
  const test = provider.lastTest;
  if (!test) return { tone: 'muted', label: '未验证' };
  if (test.ok) {
    const when = formatSessionTime(test.at);
    return { tone: 'success', label: when ? `已连接 · ${when}` : '已连接' };
  }
  const copy = errorCopy(test.code);
  return { tone: 'error', label: `失败 · ${copy.title}`, hint: copy.hint };
}

/**
 * Discovered models as a connection takes them. On an official connection a
 * window above 200K is the billed 1M opt-in, so the vendor's window is left
 * out and only a deliberate pick declares one.
 */
export function discoveredModelsFor(
  kind: ConnectionKind | null,
  models: readonly DiscoveredModel[],
): DiscoveredModel[] {
  if (kind !== 'claude_subscription' && kind !== 'anthropic_api') {
    return [...models];
  }
  return models.map((model) => {
    const copy = { ...model };
    delete copy.contextWindow;
    return copy;
  });
}

// ─── Requests ──────────────────────────────────────────────────

/** The header a third-party key travels in. */
export type ProviderAuthMode = 'bearer' | 'x-api-key';

export const AUTH_MODE_LABELS: Record<ProviderAuthMode, string> = {
  bearer: 'Authorization: Bearer',
  'x-api-key': 'x-api-key',
};

/** How the server picks the header when none is stored. */
export const AUTO_AUTH_MODE_HINT = `先用 ${AUTH_MODE_LABELS.bearer}，被拒绝时改用 ${AUTH_MODE_LABELS['x-api-key']}，并记住成功的那种。`;

/** Fields a not-yet-saved connection is tested or listed with. */
export interface ConnectionDraftBody {
  type: 'official' | 'third_party';
  runner?: 'claude' | 'agy';
  presetId?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCredentialInput?: string;
  /** A relay's environment, e.g. the custom headers its key travels in. */
  customEnv?: Record<string, string>;
}

interface ProviderTestProbe {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  message?: string;
  hint?: string;
}

interface ProviderTestResponse {
  ok: boolean;
  probes: ProviderTestProbe[];
  code?: ProviderErrorCode | null;
  /** The header the endpoint accepted. */
  authMode?: ProviderAuthMode;
  record?: ProviderTestRecord;
}

type DiscoverModelsResponse =
  | {
      ok: true;
      models: DiscoveredModel[];
      source: 'endpoint' | 'builtin' | 'catalog';
      authMode?: ProviderAuthMode;
      /** What the list says the endpoint is; absent on older servers. */
      gateway?: ProviderGateway | null;
    }
  | {
      ok: false;
      code: ProviderErrorCode;
      status: number | null;
      message: string;
    };

/** PATCH a connection's fields; protocol edits stop runners, so allow time. */
export async function updateConnection(
  id: string,
  patch: Record<string, unknown>,
): Promise<UnifiedProviderPublic> {
  return (
    await api.patch<{ provider: UnifiedProviderPublic }>(
      `${PROVIDERS_API}/${encodeURIComponent(id)}`,
      patch,
      120_000,
    )
  ).provider;
}

/** Replace an official connection's credential. */
export function saveConnectionSecrets(
  id: string,
  secrets: Record<string, unknown>,
): Promise<unknown> {
  return api.put(
    `${PROVIDERS_API}/${encodeURIComponent(id)}/secrets`,
    secrets,
    120_000,
  );
}

export function testConnection(
  body:
    | { providerId: string }
    | (ConnectionDraftBody & {
        anthropicModel?: string;
        customEnv?: Record<string, string>;
      }),
): Promise<ProviderTestResponse> {
  return api.post<ProviderTestResponse>(`${PROVIDERS_API}/test`, body, 60_000);
}

export function discoverModels(
  body:
    | { providerId: string }
    | (ConnectionDraftBody & { providerId?: string }),
): Promise<DiscoverModelsResponse> {
  if ('runner' in body && body.runner === 'agy') {
    const query = body.providerId
      ? `?providerId=${encodeURIComponent(body.providerId)}`
      : '';
    return api
      .get<{ models: DiscoveredModel[] }>(`/api/config/agy/models${query}`)
      .then((res) => ({
        ok: true as const,
        models: res.models ?? [],
        source: 'builtin' as const,
      }))
      .catch((err) => ({
        ok: false as const,
        code: 'UNKNOWN' as const,
        status: null,
        message: err instanceof Error ? err.message : '获取 AGY 模型列表失败',
      }));
  }
  return api.post<DiscoverModelsResponse>(
    `${PROVIDERS_API}/discover-models`,
    body,
    // The server may try the other auth header after a refusal.
    45_000,
  );
}

/**
 * Reads a third-party connection's model list again: it tells a magpie
 * gateway from any other endpoint and, for magpie, refreshes what the
 * vendor says about each model and finds the new and the vanished ones.
 */
export function syncConnectionCatalog(id: string): Promise<{
  provider: UnifiedProviderPublic;
  result: CatalogSyncResult;
}> {
  return api.post(
    `${PROVIDERS_API}/${encodeURIComponent(id)}/catalog/sync`,
    undefined,
    45_000,
  );
}

/** A finished test, reduced to what the UI shows. */
export interface TestOutcome {
  ok: boolean;
  code: ProviderErrorCode | null;
  latencyMs: number | null;
  model: string | null;
  /** The upstream's own words for a failure (redacted by the server). */
  message: string | null;
  authMode: ProviderAuthMode | null;
}

export function testOutcome(result: ProviderTestResponse): TestOutcome {
  const failing = result.probes?.find((probe) => !probe.ok);
  const first = result.probes?.[0];
  return {
    ok: result.ok,
    code: result.ok
      ? null
      : (result.code ?? result.record?.code ?? ('UNKNOWN' as const)),
    latencyMs: result.record?.latencyMs ?? first?.latencyMs ?? null,
    model: result.record?.model ?? first?.model ?? null,
    message: failing?.message ?? null,
    authMode: result.authMode ?? null,
  };
}

/**
 * Asks before an edit that stops runners: an address, a key, a removed
 * model or the environment. Says how many live runners the edit stops (the
 * server counts every one it quiesces, not only this connection's) and
 * whether conversations start a new SDK session. A new address alone keeps
 * them.
 */
export async function confirmProtocolChange(
  provider: {
    id: string;
    name: string;
  },
  { keepsSessions = false }: { keepsSessions?: boolean } = {},
): Promise<boolean> {
  let stoppedRunners: number | null = null;
  try {
    const impact = await api.get<{
      activeRunners: number;
      stoppedRunners: number;
    }>(`${PROVIDERS_API}/${encodeURIComponent(provider.id)}/impact`);
    if (typeof impact?.stoppedRunners === 'number') {
      stoppedRunners = impact.stoppedRunners;
    }
  } catch {
    // The edit is still allowed; the dialog says the count is unknown.
  }
  const runners =
    stoppedRunners === null
      ? '无法读取会被停止的运行中会话数。'
      : stoppedRunners > 0
        ? `保存会停止 ${stoppedRunners} 个运行中的会话。`
        : '';
  return confirmDialog({
    title: `修改连接「${provider.name}」`,
    message: keepsSessions
      ? `${runners}使用这个连接的对话保留各自的 SDK 会话，下一条消息从新地址继续。`
      : `${runners}使用这个连接的对话，下一条消息会开启新的 SDK 会话，聊天记录保留。`,
    confirmText: '保存修改',
  });
}

/** The `{ code, ... }` body a refused request answered with, if any. */
function errorBody(err: unknown): Record<string, unknown> | null {
  const body = (err as { body?: unknown } | null)?.body;
  return body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : null;
}

/** Agents named by a 409 MODEL_IN_USE answer, if that is what this is. */
export function modelInUseAgents(err: unknown): string[] | null {
  const body = errorBody(err);
  if (body?.code !== 'MODEL_IN_USE' || !Array.isArray(body.agents)) return null;
  return body.agents
    .map((agent) =>
      agent && typeof agent === 'object'
        ? (agent as { name?: unknown }).name
        : null,
    )
    .filter((name): name is string => typeof name === 'string');
}

/** Copy for a connection write the server refused for a known reason. */
export function connectionWriteErrorMessage(err: unknown): string | null {
  return errorBody(err)?.code === 'MAGPIE_MODELS_REQUIRED'
    ? 'magpie 连接至少要有一个模型：magpie 没有默认模型。'
    : null;
}

/** Copy for a model or effort pick the server refused, else null. */
export function modelBindingErrorMessage(err: unknown): string | null {
  switch (errorBody(err)?.code) {
    case 'MODEL_NOT_IN_CONNECTION':
      return '所选模型已不在该模型配置的模型列表里，请重新选择模型';
    case 'EFFORT_NOT_SUPPORTED':
      return '这个模型不支持所选的推理等级，请重新选择';
    default:
      return null;
  }
}

// ─── Reasoning effort ───

/** Reasoning efforts as the composer and the connection settings name them. */
const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极限',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

// ─── Model names ───────────────────────────────────────────────

/** A preset's display name for one of its models, matched without `[1m]`. */
export function presetModelName(
  preset: ModelPreset | null,
  id: string,
): string | undefined {
  if (!preset) return undefined;
  const base = splitOneMillionSuffix(id).model;
  return preset.models.find(
    (model) => splitOneMillionSuffix(model.id).model === base,
  )?.name;
}
