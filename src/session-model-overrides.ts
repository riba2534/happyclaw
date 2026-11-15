/**
 * What a conversation chose in the chat composer, as a runner launch sees it.
 *
 * Every model configuration offers a list of models, and a conversation may
 * pin one of them; a ChatGPT subscription offers its account catalog instead
 * and also lets the conversation pick a reasoning effort. The choice is stored
 * when it is made (session_model_selections) but can go stale before the next
 * launch: the list or the catalog moves, the plan changes, the person who
 * chose loses a permission. Everything here re-checks it against the world as
 * it is now, and degrades to the configuration's own default instead of
 * failing the turn.
 */
import { logger } from './logger.js';
import {
  getSession,
  getSessionModel,
  getSessionModelSelectionDetail,
  getUserById,
} from './db.js';
import {
  normalizeCodexEffort,
  resolveCodexModel,
} from './codex-gateway/convert-request.js';
import {
  clampCodexEffortWithCatalog,
  codexPickableEfforts,
  resolveCodexDefaultEffort,
  resolveCodexSessionChoice,
} from './codex-gateway/model-catalog.js';
import { listCodexModelsForProvider } from './codex-gateway/model-catalog-sync.js';
import {
  isModelEffort,
  resolveModelCapabilities,
  splitOneMillionSuffix,
  type ModelCapabilitySource,
  type ModelEffort,
  type ResolvedModelCapabilities,
} from './model-providers.js';
import { hasPermission } from './permissions.js';
import {
  findProviderModel,
  providerModels,
  type UnifiedProvider,
} from './runtime-config.js';

type ChatGptProvider = Pick<
  UnifiedProvider,
  'id' | 'anthropicModel' | 'codexOAuthCredentials'
>;

/** A configuration of any kind, with what it offers to pick from. */
type ModelConfiguration = ChatGptProvider &
  Pick<UnifiedProvider, 'anthropicBaseUrl' | 'models' | 'customEnv'>;

/**
 * What `model` of a configuration takes: the connection's entry (declared
 * window and efforts), else the registry, else its family. A model nothing is
 * known about, and a pass-through relay (no model), take no effort.
 */
function connectionModelCapabilities(
  provider: Pick<
    UnifiedProvider,
    'anthropicBaseUrl' | 'anthropicModel' | 'models'
  >,
  model: string,
): ResolvedModelCapabilities {
  const id = splitOneMillionSuffix(model).model;
  return resolveModelCapabilities(
    findProviderModel(provider, id) ?? { id: id || model },
  );
}

/** Whether the connection's list has `model`, named with or without `[1m]`. */
function offersModel(provider: ModelConfiguration, model: string): boolean {
  return !!findProviderModel(provider, splitOneMillionSuffix(model).model);
}

/**
 * The efforts `model` of a connection takes: a ChatGPT subscription's from
 * its account catalog, any other's from its capabilities. A name saved with
 * `[1m]` is the same model.
 */
export function modelEffortsFor(
  provider: ModelConfiguration,
  model: string,
): readonly string[] {
  if (!model) return [];
  if (provider.codexOAuthCredentials) {
    const id = splitOneMillionSuffix(model).model;
    return (
      listCodexModelsForProvider(provider).models.find(
        (entry) => entry.value === id,
      )?.efforts ?? []
    );
  }
  return connectionModelCapabilities(provider, model).efforts;
}

/**
 * Whether `model` takes `effort`. A model whose efforts nothing declares or
 * knows takes any effort Claude Code has: it is tried as picked. A ChatGPT
 * model's catalog always decides.
 */
function modelTakesEffort(
  provider: ModelConfiguration,
  model: string,
  effort: string,
): boolean {
  if (!isModelEffort(effort)) return false;
  if (provider.codexOAuthCredentials || !model) {
    return modelEffortsFor(provider, model).includes(effort);
  }
  const { efforts, effortsSource } = connectionModelCapabilities(
    provider,
    model,
  );
  return effortsSource === 'none' || efforts.includes(effort);
}

/** The effort and thinking a launch on one model runs Claude Code with. */
export interface LaunchReasoning {
  /** Null: HappyClaw passes no effort (Claude Code may still use its own). */
  effort: ModelEffort | null;
  /** The model is declared to take no effort and not to reason. */
  thinkingDisabled: boolean;
}

/**
 * How a launch on `model` reasons. A model with known efforts runs at the
 * first of `picks` (most specific first) it takes, else its default. A model
 * declared to take none gets no effort, and thinking off only when it is
 * also declared not to reason (`thinks: false`). A model nothing is known
 * about runs at the first pick
 * that is an effort at all, as picked, and gets none without one.
 */
export function resolveLaunchReasoning(
  provider: ModelConfiguration,
  model: string,
  picks: ReadonlyArray<string | null | undefined>,
): LaunchReasoning {
  if (!model) return { effort: null, thinkingDisabled: false };
  const { efforts, defaultEffort, effortsSource, thinkingDisabled } =
    connectionModelCapabilities(provider, model);
  if (effortsSource === 'none') {
    return {
      effort:
        picks.find((pick): pick is ModelEffort => isModelEffort(pick)) ?? null,
      thinkingDisabled: false,
    };
  }
  for (const pick of picks) {
    if (isModelEffort(pick) && efforts.includes(pick)) {
      return { effort: pick, thinkingDisabled };
    }
  }
  return { effort: defaultEffort, thinkingDisabled };
}

/**
 * A conversation's stored choice within a configuration that is not a
 * ChatGPT subscription, as it holds today: a model the list no longer offers
 * and an effort the model does not take read as unset.
 */
function checkConnectionChoice(
  provider: ModelConfiguration,
  stored: { model: string | null; effort: string | null },
  /** What runs without a model pick: the Agent's model on its connection. */
  unpickedModel: string = provider.anthropicModel,
): {
  model: string | null;
  effort: string | null;
  staleModel: boolean;
  staleEffort: boolean;
} {
  const model =
    stored.model && offersModel(provider, stored.model) ? stored.model : null;
  const effort =
    stored.effort &&
    modelTakesEffort(provider, model ?? unpickedModel, stored.effort)
      ? stored.effort
      : null;
  return {
    model,
    effort,
    staleModel: !!stored.model && !model,
    staleEffort: !!stored.effort && !effort,
  };
}

/** The picker's reading of what a conversation stored for `provider`. */
export function readStoredConnectionChoice(
  provider: ModelConfiguration,
  stored: { model: string | null; effort: string | null },
  unpickedModel?: string,
): { model: string | null; effort: string | null } {
  const { model, effort } = checkConnectionChoice(
    provider,
    stored,
    unpickedModel,
  );
  // The picker lists ids; a name saved with `[1m]` is that id.
  return { model: model && splitOneMillionSuffix(model).model, effort };
}

export interface SessionLaunchOverrides {
  /** Upstream model to run on instead of the configuration's own. */
  model?: string;
  /** Reasoning effort to apply, handed to the gateway out of band. */
  effort?: string;
}

/**
 * Whether the person who made a choice may pick efforts above the ceiling,
 * judged by what they may do now rather than when they chose.
 */
export function canChooseBeyondEffortCeiling(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  const user = getUserById(userId);
  return (
    !!user &&
    user.status === 'active' &&
    hasPermission(user, 'manage_system_config')
  );
}

/** The model a ChatGPT configuration runs when nothing else is chosen. */
export function chatGptDefaultModel(
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(undefined, provider.anthropicModel);
}

/**
 * The model and effort this conversation runs on within `provider`, or nothing
 * when it chose none or the choice is gone stale.
 */
export function resolveSessionLaunchOverrides(
  groupFolder: string,
  agentId: string | null | undefined,
  provider: ModelConfiguration,
  options: { warn?: boolean; unpickedModel?: string } = {},
): SessionLaunchOverrides {
  const detail = getSessionModelSelectionDetail(groupFolder, agentId);
  if (
    !detail ||
    detail.modelConfigId !== provider.id ||
    (!detail.model && !detail.effort)
  ) {
    return {};
  }
  if (!provider.codexOAuthCredentials) {
    const choice = checkConnectionChoice(
      provider,
      detail,
      options.unpickedModel,
    );
    if (choice.staleModel && options.warn !== false) {
      logger.warn(
        {
          groupFolder,
          agentId: agentId || null,
          providerId: provider.id,
          model: detail.model,
        },
        'Conversation model is no longer offered by its configuration; following the configuration default',
      );
    }
    if (choice.staleEffort && options.warn !== false) {
      logger.warn(
        {
          groupFolder,
          agentId: agentId || null,
          providerId: provider.id,
          effort: detail.effort,
        },
        'Conversation effort is not taken by the model it runs; following the Agent or the model default',
      );
    }
    return {
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
    };
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: detail.model,
    effort: detail.effort,
    canExceedCeiling: canChooseBeyondEffortCeiling(detail.updatedBy),
    strict: false,
    authoritative: source === 'live',
  });
  if (choice.problems.length > 0 && options.warn !== false) {
    logger.warn(
      {
        groupFolder,
        agentId: agentId || null,
        providerId: provider.id,
        problems: choice.problems,
      },
      'Conversation model or effort is no longer valid; following the configuration default',
    );
  }
  return {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
  };
}

/**
 * The model an Agent's binding names within `provider`, or nothing when it
 * names none or the configuration no longer offers it: the Agent then runs
 * the configuration's default instead of failing the turn. A ChatGPT model is
 * judged like a stored conversation choice, against the account catalog.
 */
export function resolveAgentLaunchModel(
  provider: ModelConfiguration,
  agentModel: string | null | undefined,
  context: {
    groupFolder: string;
    agentId?: string | null;
    warn?: boolean;
  },
): string | undefined {
  if (!agentModel) return undefined;
  let model: string | null;
  if (provider.codexOAuthCredentials) {
    const { models, source } = listCodexModelsForProvider(provider);
    model = resolveCodexSessionChoice({
      catalog: models,
      defaultModel: chatGptDefaultModel(provider),
      model: agentModel,
      canExceedCeiling: false,
      strict: false,
      authoritative: source === 'live',
    }).model;
  } else {
    model = offersModel(provider, agentModel) ? agentModel : null;
  }
  if (!model && context.warn !== false) {
    logger.warn(
      {
        groupFolder: context.groupFolder,
        agentId: context.agentId || null,
        providerId: provider.id,
        model: agentModel,
      },
      'Agent model is no longer offered by its configuration; following the configuration default',
    );
  }
  return model ?? undefined;
}

/**
 * Whether a launch on `effectiveModel` changes the model under a Session that
 * still has an SDK session to resume. Encrypted reasoning only verifies for the
 * model that issued it, so such a session cannot simply continue; sessions of
 * every other configuration follow the same rule, so one SDK session always
 * runs on one model.
 *
 * A session from before models were tracked ran on the configuration's own
 * model; one without an SDK session has nothing to carry over.
 */
export function sessionModelHasChanged(
  groupFolder: string,
  agentId: string | null | undefined,
  effectiveModel: string,
  providerDefaultModel: string,
): boolean {
  // `[1m]` only widens the context window Claude Code works with; the
  // upstream model, and so the session's reasoning, stays the same.
  const upstream = (model: string) => splitOneMillionSuffix(model).model;
  const recorded = getSessionModel(groupFolder, agentId);
  if (recorded) return upstream(recorded) !== upstream(effectiveModel);
  return (
    !!getSession(groupFolder, agentId) &&
    upstream(providerDefaultModel) !== upstream(effectiveModel)
  );
}

/**
 * The model a ChatGPT launch resolves to. Claude model names (a pool's
 * fallback tier, the SDK's own defaults) are served by the configuration's
 * model, exactly as the gateway maps them.
 */
export function chatGptLaunchModel(
  requestedModel: string | undefined,
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(requestedModel, provider.anthropicModel);
}

// ─── What the chat composer is shown ───────────────────────────────────

/** A model a conversation or an Agent may pick within a configuration. */
export interface ConnectionModelChoice {
  id: string;
  /** The vendor's name for the model, when its list gave one. */
  displayName: string | null;
  /**
   * Efforts the model is known to take. Empty: declared to take none
   * (`effortsSource: 'declared'`), or unknown (`'none'`), in which case any
   * effort may be picked and is tried as is.
   */
  efforts: ModelEffort[];
  /** The effort the model runs at when nothing is picked. */
  defaultEffort: ModelEffort | null;
  contextWindow: number | null;
  /** Where the efforts come from; only `registry` is verified. */
  effortsSource: ModelCapabilitySource;
  /** The longest reply the vendor declares, in tokens. */
  maxOutputTokens: number | null;
  /** Who serves the model behind a gateway. */
  vendor: string | null;
  /** When a catalog sync found the model gone upstream; null while listed. */
  upstreamMissingSince: string | null;
}

/**
 * The models a configuration offers to pick from, with what each takes: its
 * own list, or a ChatGPT subscription's account catalog (verified efforts,
 * window unknown).
 */
export function listConnectionModels(
  provider: ModelConfiguration,
): ConnectionModelChoice[] {
  if (provider.codexOAuthCredentials) {
    return listCodexModelsForProvider(provider).models.map((entry) => {
      const efforts = entry.efforts.filter(isModelEffort);
      return {
        id: entry.value,
        displayName: null,
        efforts,
        defaultEffort:
          isModelEffort(entry.defaultEffort) &&
          efforts.includes(entry.defaultEffort)
            ? entry.defaultEffort
            : null,
        contextWindow: null,
        effortsSource: 'registry',
        maxOutputTokens: null,
        vendor: null,
        upstreamMissingSince: null,
      };
    });
  }
  return providerModels(provider).map((entry) => {
    const capabilities = resolveModelCapabilities(entry);
    return {
      id: entry.id,
      displayName: entry.displayName ?? null,
      efforts: capabilities.efforts,
      defaultEffort: capabilities.defaultEffort,
      contextWindow: capabilities.contextWindow,
      effortsSource: capabilities.effortsSource,
      maxOutputTokens: entry.maxOutputTokens ?? null,
      vendor: entry.vendor ?? null,
      upstreamMissingSince: entry.upstreamMissingSince ?? null,
    };
  });
}

export interface CodexModelChoice {
  /** The upstream model slug. */
  value: string;
  label: string;
  /** Efforts the chooser may pick on this model, low → ultra. */
  efforts: string[];
  /** The effort this model runs at when nothing is picked. */
  defaultEffort: string;
}

/** The models and efforts one ChatGPT login offers a conversation. */
export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** Where the list came from; `live` is the account's own. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

/**
 * The picker's view of one ChatGPT login for one chooser. Efforts above the
 * ceiling are left out unless the chooser may pick them, but a default that
 * sits above it is reported as is: it is what the conversation really runs.
 */
export function buildCodexSelectionView(
  provider: ChatGptProvider &
    Pick<UnifiedProvider, 'customEnv' | 'codexOAuthLastRefreshError'>,
  context: { canExceedCeiling: boolean; agentEffort?: string },
): CodexSelectionView {
  const { models, source } = listCodexModelsForProvider(provider);
  const providerEffort = provider.customEnv?.CODEX_REASONING_EFFORT;
  // Without a pick the conversation runs at the Agent's effort when it has
  // one, else the configuration's, as the gateway resolves it.
  const defaultEffortOn = (model: string): string =>
    context.agentEffort
      ? clampCodexEffortWithCatalog(
          models,
          model,
          normalizeCodexEffort(context.agentEffort),
        )!
      : resolveCodexDefaultEffort(models, model, providerEffort);
  const defaultModel = chatGptDefaultModel(provider);
  return {
    defaultModel,
    defaultEffort: defaultEffortOn(defaultModel),
    source,
    needsReauth:
      provider.codexOAuthLastRefreshError?.kind === 'reauth_required',
    models: models.map((entry) => ({
      value: entry.value,
      label: entry.value,
      efforts: codexPickableEfforts(entry.efforts, context.canExceedCeiling),
      defaultEffort: defaultEffortOn(entry.value),
    })),
  };
}

/** The picker's validated reading of what a conversation stored. */
export function readStoredChoice(
  view: CodexSelectionView,
  stored: { model: string | null; effort: string | null },
  canExceedCeiling: boolean,
): { model: string | null; effort: string | null } {
  const { model, effort } = resolveCodexSessionChoice({
    catalog: view.models.map(({ value, label, efforts }) => ({
      value,
      label,
      efforts,
    })),
    defaultModel: view.defaultModel,
    model: stored.model,
    effort: stored.effort,
    canExceedCeiling,
    strict: false,
    authoritative: view.source === 'live',
  });
  return { model, effort };
}

// ─── Making a choice ───────────────────────────────────────────────────

export type SessionChoiceRejectionCode =
  | 'MODEL_SELECTION_UNSUPPORTED'
  | 'MODEL_NOT_IN_CONNECTION'
  | 'EFFORT_NOT_SUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'EFFORT_UNSUPPORTED'
  | 'EFFORT_RESTRICTED';

export interface SessionChoiceRejection {
  error: string;
  code: SessionChoiceRejectionCode;
}

/**
 * Check a model and effort a chooser submits for `provider`. Unlike a stored
 * choice, a new one must be confirmed by the configuration's model list (a
 * ChatGPT subscription: its catalog). A model whose efforts are unknown
 * takes any effort Claude Code has; one declared to take none takes none.
 * Efforts above the ceiling, which only a ChatGPT subscription offers, need
 * the chooser's `manage_system_config`.
 */
export function validateSessionChoice(
  provider: ModelConfiguration,
  requested: { model?: string | null; effort?: string | null },
  chooser: Parameters<typeof hasPermission>[0],
  /** What runs without a model pick: the Agent's model on its connection. */
  unpickedModel: string = provider.anthropicModel,
):
  | { ok: true; model: string | null; effort: string | null }
  | { ok: false; rejection: SessionChoiceRejection } {
  if (!provider.codexOAuthCredentials) {
    const model = requested.model?.trim() || null;
    const effort = requested.effort?.trim() || null;
    if (model && !offersModel(provider, model)) {
      return {
        ok: false,
        rejection: {
          error: `模型 ${model} 不在该模型配置的模型列表中，请刷新后重新选择`,
          code: 'MODEL_NOT_IN_CONNECTION',
        },
      };
    }
    const runs = model ?? unpickedModel;
    if (effort && !modelTakesEffort(provider, runs, effort)) {
      return {
        ok: false,
        rejection: {
          error: runs
            ? `模型 ${runs} 不支持推理档位 ${effort}`
            : '未指定模型时不能选择推理档位',
          code: 'EFFORT_NOT_SUPPORTED',
        },
      };
    }
    return {
      ok: true,
      model: model && splitOneMillionSuffix(model).model,
      effort,
    };
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: requested.model,
    effort: requested.effort,
    canExceedCeiling: hasPermission(chooser, 'manage_system_config'),
    strict: true,
    authoritative: source === 'live',
  });
  const problem = choice.problems[0];
  if (!problem) return { ok: true, model: choice.model, effort: choice.effort };
  switch (problem.kind) {
    case 'model_unavailable':
      return {
        ok: false,
        rejection: {
          error: `该账号当前不可使用模型 ${problem.model}，请刷新后重新选择`,
          code: 'MODEL_UNAVAILABLE',
        },
      };
    case 'effort_unsupported':
      return {
        ok: false,
        rejection: {
          error: `模型 ${problem.model} 不支持推理档位 ${problem.effort}`,
          code: 'EFFORT_UNSUPPORTED',
        },
      };
    case 'effort_restricted':
      return {
        ok: false,
        rejection: {
          error: `推理档位 ${problem.effort} 仅限具备系统配置权限的用户选择`,
          code: 'EFFORT_RESTRICTED',
        },
      };
  }
}
