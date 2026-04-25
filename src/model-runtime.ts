import {
  ensureConversationRuntimeState,
  getLatestSessionTokenUsage,
  getProviderPool,
  getRuntimeNativeSession,
  LEGACY_CLAUDE_AUTH_GENERATION,
  LEGACY_CLAUDE_MODEL_KEY,
  LEGACY_CLAUDE_PROVIDER_ID,
  listProviderPoolModelOptions,
  modelKeyForBinding,
  setRuntimeNativeSession,
} from './db.js';
import { providerPoolManager } from './provider-pool.js';
import type {
  ConversationRuntimeState,
  ModelBinding,
  RuntimeNativeSession,
  RuntimeSessionKey,
} from './types.js';
import {
  getBalancingConfig,
  getContainerEnvConfig,
  getEnabledProvidersForPool,
  type UnifiedProvider,
} from './runtime-config.js';
import { logger } from './logger.js';

const DEFAULT_CODEX_NATIVE_RESUME_MAX_INPUT_TOKENS = 800_000;

function codexNativeResumeMaxInputTokens(): number {
  const raw = process.env.HAPPYCLAW_CODEX_NATIVE_RESUME_MAX_INPUT_TOKENS;
  if (!raw) return DEFAULT_CODEX_NATIVE_RESUME_MAX_INPUT_TOKENS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CODEX_NATIVE_RESUME_MAX_INPUT_TOKENS;
}

function shouldUseNativeSession(
  binding: ModelBinding,
  nativeSession: RuntimeNativeSession | undefined,
): boolean {
  if (!nativeSession?.native_session_id) return false;
  if (binding.runtime !== 'codex') return true;

  const maxInputTokens = codexNativeResumeMaxInputTokens();
  const usage = getLatestSessionTokenUsage(nativeSession.native_session_id);
  if (!usage || usage.inputTokens <= maxInputTokens) return true;

  logger.warn(
    {
      sessionId: nativeSession.native_session_id,
      inputTokens: usage.inputTokens,
      maxInputTokens,
      messageId: usage.message_id,
    },
    'Skipping Codex native resume because session context is too large',
  );
  return false;
}

export interface RuntimeResolution {
  state: ConversationRuntimeState;
  binding: ModelBinding;
  modelKey: string;
  modelOverride: string | null;
  providerId: string;
  authProfileGeneration: number;
  authProfileFingerprint: string | null;
  sessionKey: RuntimeSessionKey;
  nativeSession?: RuntimeNativeSession;
  availability:
    | { ok: true }
    | { ok: false; code: string; message: string };
}

function activeBindingFromState(state: ConversationRuntimeState): ModelBinding {
  return {
    runtime: state.active_runtime ?? state.runtime,
    provider_family: state.active_provider_family ?? state.provider_family,
    provider_pool_id: state.active_provider_pool_id ?? state.provider_pool_id,
    selected_model:
      state.active_model_kind === 'provider_default'
        ? null
        : state.active_selected_model ?? state.selected_model,
    model_kind: state.active_model_kind ?? state.model_kind,
    resolved_model: state.active_resolved_model ?? state.resolved_model,
  };
}

function modelOverrideForRunner(binding: ModelBinding): string | null {
  if (
    binding.model_kind === 'provider_default' ||
    binding.model_kind === 'runtime_default'
  ) {
    return null;
  }
  return binding.resolved_model || binding.selected_model || null;
}

function validateAvailability(
  binding: ModelBinding,
): RuntimeResolution['availability'] {
  const pool = getProviderPool(binding.provider_pool_id);
  if (!pool) {
    return {
      ok: false,
      code: 'pool_not_found',
      message: `模型池 ${binding.provider_pool_id} 不存在，请使用 /model list 查看可用模型。`,
    };
  }
  if (!pool.enabled) {
    return {
      ok: false,
      code: 'pool_disabled',
      message: `模型池 ${binding.provider_pool_id} 已禁用，请切换到可用模型。`,
    };
  }
  if (
    binding.runtime === 'codex' &&
    getEnabledProvidersForPool(binding.provider_pool_id).length === 0
  ) {
    return {
      ok: false,
      code: 'no_provider',
      message: `模型池 ${binding.provider_pool_id} 没有启用的鉴权供应商，请先配置对应账号池。`,
    };
  }
  if (binding.selected_model) {
    const option = listProviderPoolModelOptions(
      binding.provider_pool_id,
      true,
    ).find(
      (item) =>
        item.model_id === binding.selected_model &&
        item.model_kind === binding.model_kind,
    );
    if (!option) {
      return {
        ok: false,
        code: 'model_not_configured',
        message: `模型 ${binding.selected_model} 未配置，请先在模型目录中添加后再切换。`,
      };
    }
    if (option.status === 'hidden' || option.status === 'unsupported') {
      return {
        ok: false,
        code: `model_${option.status}`,
        message: `模型 ${binding.selected_model} 当前不可用，请切换到其他模型。`,
      };
    }
  }
  return { ok: true };
}

function hasClaudeEnvironmentOverride(groupFolder: string): boolean {
  const override = getContainerEnvConfig(groupFolder);
  return !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
}

function poolSentinelProviderId(providerPoolId: string): string {
  return `__pool__:${providerPoolId}`;
}

function selectConcreteProvider(
  binding: ModelBinding,
  groupFolder: string,
): UnifiedProvider | null {
  if (binding.runtime === 'claude' && hasClaudeEnvironmentOverride(groupFolder)) {
    return null;
  }

  const enabledProviders = getEnabledProvidersForPool(
    binding.provider_pool_id,
  ).filter(
    (provider) =>
      provider.runtime === binding.runtime &&
      provider.providerFamily === binding.provider_family,
  );
  if (enabledProviders.length === 0) return null;
  if (enabledProviders.length === 1) return enabledProviders[0];

  providerPoolManager.refreshPoolFromConfig(
    binding.provider_pool_id,
    enabledProviders,
    getBalancingConfig(),
  );
  const selectedProviderId = providerPoolManager.selectProvider(
    binding.provider_pool_id,
  );
  return (
    enabledProviders.find((provider) => provider.id === selectedProviderId) ??
    enabledProviders[0]
  );
}

export function resolveRuntimeForScope(
  groupFolder: string,
  agentId?: string | null,
  updatedBy?: string | null,
): RuntimeResolution {
  const state = ensureConversationRuntimeState(groupFolder, agentId, updatedBy);
  const binding = activeBindingFromState(state);
  const modelKey = modelKeyForBinding(binding) || LEGACY_CLAUDE_MODEL_KEY;
  const selectedProvider = selectConcreteProvider(binding, groupFolder);
  const providerId =
    selectedProvider?.id ??
    (binding.provider_pool_id === 'claude'
      ? LEGACY_CLAUDE_PROVIDER_ID
      : poolSentinelProviderId(binding.provider_pool_id));
  const authProfileGeneration =
    selectedProvider?.authProfileGeneration ?? LEGACY_CLAUDE_AUTH_GENERATION;
  const authProfileFingerprint = selectedProvider
    ? `${selectedProvider.authMode}:${selectedProvider.authProfileGeneration}`
    : null;
  const sessionKey: RuntimeSessionKey = {
    group_folder: groupFolder,
    agent_id: agentId || '',
    ...binding,
    provider_id: providerId,
    auth_profile_generation: authProfileGeneration,
    auth_profile_fingerprint: authProfileFingerprint,
    model_key: modelKey,
  };
  const storedNativeSession = getRuntimeNativeSession(sessionKey);
  const nativeSession = shouldUseNativeSession(binding, storedNativeSession)
    ? storedNativeSession
    : undefined;

  return {
    state,
    binding,
    modelKey,
    modelOverride: modelOverrideForRunner(binding),
    providerId,
    authProfileGeneration,
    authProfileFingerprint,
    sessionKey,
    nativeSession,
    availability: validateAvailability(binding),
  };
}

export function resolveRuntimeForSourceScope(
  sourceGroupFolder: string,
  sessionGroupFolder: string,
  agentId?: string | null,
  updatedBy?: string | null,
): RuntimeResolution {
  const resolved = resolveRuntimeForScope(sourceGroupFolder, agentId, updatedBy);
  const sessionKey: RuntimeSessionKey = {
    ...resolved.sessionKey,
    group_folder: sessionGroupFolder,
  };
  const storedNativeSession = getRuntimeNativeSession(sessionKey);
  const nativeSession = shouldUseNativeSession(
    resolved.binding,
    storedNativeSession,
  )
    ? storedNativeSession
    : undefined;
  return {
    ...resolved,
    sessionKey,
    nativeSession,
  };
}

export function persistRuntimeNativeSession(
  resolution: RuntimeResolution,
  nativeSessionId: string,
  metadata?: Record<string, unknown>,
  anchor?: {
    basedOnMessageId?: string | null;
    basedOnMessageTimestamp?: string | null;
    basedOnTurnId?: string | null;
    inputContextHash?: string | null;
    workspaceInstructionHash?: string | null;
    summaryId?: string | null;
  },
): RuntimeNativeSession {
  return setRuntimeNativeSession({
    ...resolution.sessionKey,
    native_session_id: nativeSessionId,
    native_resume_at: null,
    based_on_message_id: anchor?.basedOnMessageId ?? null,
    based_on_message_timestamp: anchor?.basedOnMessageTimestamp ?? null,
    based_on_turn_id: anchor?.basedOnTurnId ?? null,
    input_context_hash: anchor?.inputContextHash ?? null,
    workspace_instruction_hash: anchor?.workspaceInstructionHash ?? null,
    summary_id: anchor?.summaryId ?? null,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
  });
}
