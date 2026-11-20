/**
 * A conversation's model choice, as every writer makes it: the chat picker
 * (PUT model-selection), a new session that names a model, an automation's
 * run sessions, the sessions a session or a team group derives, and the IM
 * `/model` command.
 *
 * A choice is checked once, when it is made, against the connection's list
 * (a ChatGPT subscription: its catalog) and the chooser's permissions; a
 * launch re-checks the stored record against the world as it is then and
 * falls back to the default instead of failing (session-model-overrides).
 * Saving retires exactly the runners the change affects, so the next message
 * of the conversation starts on the new choice.
 */
import { resolveAgentSdkEffort } from './agent-effort.js';
import { updateLiveSessionEffort } from './codex-gateway/runner-tokens.js';
import { maybeRefreshCodexProviderCatalog } from './codex-gateway/model-catalog-sync.js';
import {
  resolveModelBinding,
  summarizeModelBinding,
} from './container-runner.js';
import {
  getSessionModelSelectionDetail,
  peekAgentProfileForWorkspace,
  setSessionModelSelection,
  storedModelName,
  type SessionModelSelectionDetail,
} from './db.js';
import { hasPermission } from './permissions.js';
import {
  getProviders,
  providerHasCredentials,
  type UnifiedProvider,
} from './runtime-config.js';
import {
  buildCodexSelectionView,
  chatGptDefaultModel,
  listConnectionModels,
  readStoredChoice,
  readStoredConnectionChoice,
  resolveAgentLaunchModel,
  validateSessionChoice,
  type CodexSelectionView,
  type SessionChoiceRejectionCode,
} from './session-model-overrides.js';
import type { RegisteredGroup } from './types.js';
import { getWebDeps } from './web-context.js';

/** Who makes a choice: what they may pick depends on their permissions. */
export type SessionModelChooser = Parameters<typeof hasPermission>[0];

/** A conversation's choice; no connection follows the default. */
export interface SessionModelChoice {
  modelConfigId: string | null;
  /** A model of the connection; null runs the connection's own. */
  model: string | null;
  /** A reasoning effort; null follows the Agent or the model default. */
  effort: string | null;
}

export type SessionModelChoiceRejectionCode =
  | SessionChoiceRejectionCode
  | 'MODEL_CONFIG_NOT_FOUND'
  | 'MODEL_CONFIG_NO_CREDENTIALS'
  | 'MODEL_CONFIG_REQUIRED';

export interface SessionModelChoiceRejection {
  error: string;
  code: SessionModelChoiceRejectionCode;
}

/** The runner control a save needs; the GroupQueue in production. */
export interface SessionRunnerControl {
  drainRunnersForModelSelection(
    groupJids: readonly string[],
    targetProviderId: string | null,
  ): number;
}

/**
 * The model a pick without a model runs on `provider`: the Agent's, when the
 * pick is on the Agent's own connection and it still offers that model.
 */
function agentModelOn(
  provider: UnifiedProvider,
  profile: { model_config_id: string | null; model: string | null } | undefined,
  groupFolder: string,
): string | undefined {
  if (profile?.model_config_id !== provider.id) return undefined;
  return resolveAgentLaunchModel(provider, profile.model, {
    groupFolder,
    warn: false,
  });
}

function workspaceProfile(group: RegisteredGroup) {
  return peekAgentProfileForWorkspace(group.folder, group.created_by);
}

// ─── What a chooser is shown ──────────────────────────────────────────

/**
 * Every saved connection a conversation of `group` may pick, without secrets,
 * and what a conversation that picks nothing runs on, resolved exactly as a
 * launch resolves it.
 */
function buildModelChoices(
  group: RegisteredGroup,
  chooser: SessionModelChooser,
) {
  const providers = getProviders();
  const profile = workspaceProfile(group);
  const canExceedCeiling = hasPermission(chooser, 'manage_system_config');
  const agentEffort = resolveAgentSdkEffort(profile?.runtime_policy);

  const binding = resolveModelBinding(
    { modelConfigId: profile?.model_config_id, model: profile?.model },
    { groupFolder: group.folder, agentId: null },
    { includeSession: false },
  );
  const summary = summarizeModelBinding(
    binding,
    group.folder,
    null,
    agentEffort,
  );

  const codexViews = new Map<string, CodexSelectionView>();
  const options = providers.map((provider) => {
    const option = {
      id: provider.id,
      name: provider.name,
      kind:
        provider.runner === 'agy'
          ? ('agy' as const)
          : provider.codexOAuthCredentials
            ? ('codex' as const)
            : provider.type,
      runner:
        provider.runner === 'agy' ? ('agy' as const) : ('claude' as const),
      model: provider.anthropicModel,
      // A configuration without a credential (e.g. an old copy that lost its
      // key) would fail every turn; the picker shows it but cannot pick it.
      usable: providerHasCredentials(provider),
    };
    if (!provider.codexOAuthCredentials) {
      return { ...option, models: listConnectionModels(provider) };
    }
    // The list is the account's own once its catalog has been fetched; ask for
    // a fresher one without making the picker wait for it.
    maybeRefreshCodexProviderCatalog(provider.id, {
      accountId: provider.codexOAuthCredentials.accountId,
    });
    const codex = buildCodexSelectionView(provider, {
      canExceedCeiling,
      agentEffort,
    });
    codexViews.set(provider.id, codex);
    return { ...option, codex };
  });

  // A ChatGPT default runs at the effort its gateway resolves: the Agent's,
  // else the one inherited with the connection.
  const defaultCodexView = summary.provider?.codexOAuthCredentials
    ? !agentEffort && binding.inheritedEffort
      ? buildCodexSelectionView(summary.provider, {
          canExceedCeiling,
          agentEffort: binding.inheritedEffort,
        })
      : codexViews.get(summary.provider.id)
    : undefined;

  return {
    providers,
    profile,
    canExceedCeiling,
    codexViews,
    default: {
      source: summary.source,
      modelConfigId: summary.modelConfigId,
      // A set binding whose connection is gone: runs fail until it is fixed.
      connectionMissing: summary.connectionMissing,
      model: summary.model,
      effort: defaultCodexView
        ? (defaultCodexView.models.find(
            (entry) => entry.value === summary.model,
          )?.defaultEffort ?? defaultCodexView.defaultEffort)
        : summary.effort,
    },
    options,
  };
}

export type SessionModelOptions = Pick<
  ReturnType<typeof buildModelChoices>,
  'default' | 'options'
>;

/**
 * What a conversation of `group` may pick and what it runs without a pick,
 * before any conversation exists (a new session's picker, an automation).
 */
export function buildSessionModelOptions(
  group: RegisteredGroup,
  chooser: SessionModelChooser,
): SessionModelOptions {
  const choices = buildModelChoices(group, chooser);
  return { default: choices.default, options: choices.options };
}

/** One conversation's picker: its choice as it holds today, and the options. */
export function buildSessionModelSelectionView(
  group: RegisteredGroup,
  agentId: string,
  chooser: SessionModelChooser,
) {
  const choices = buildModelChoices(group, chooser);
  const { providers, profile, canExceedCeiling, codexViews } = choices;
  const stored = getSessionModelSelectionDetail(group.folder, agentId);
  const selectedProvider = stored
    ? providers.find((provider) => provider.id === stored.modelConfigId)
    : undefined;
  const selectedModelConfigId = selectedProvider?.id ?? null;
  const view = selectedModelConfigId
    ? codexViews.get(selectedModelConfigId)
    : undefined;
  // A stored model or effort the list, the catalog or the chooser's permission
  // no longer backs reads as unset, exactly as a runner launch would treat it.
  const selected =
    stored && view
      ? readStoredChoice(view, stored, canExceedCeiling)
      : stored && selectedProvider
        ? readStoredConnectionChoice(
            selectedProvider,
            stored,
            agentModelOn(selectedProvider, profile, group.folder),
          )
        : { model: null, effort: null };
  return {
    selectedModelConfigId,
    selectedModel: selected.model,
    selectedEffort: selected.effort,
    default: choices.default,
    options: choices.options,
  };
}

// ─── Making a choice ──────────────────────────────────────────────────

/**
 * Check a choice `chooser` submits for a conversation of `group`. A
 * connection must exist and hold a credential; a model and an effort need a
 * connection and are confirmed by it (validateSessionChoice). No connection
 * is the default and always valid.
 */
export function checkSessionModelChoice(
  group: RegisteredGroup,
  requested: {
    modelConfigId?: string | null;
    model?: string | null;
    effort?: string | null;
  },
  chooser: SessionModelChooser,
):
  | { ok: true; choice: SessionModelChoice }
  | { ok: false; rejection: SessionModelChoiceRejection } {
  const modelConfigId = requested.modelConfigId || null;
  const requestedModel = requested.model?.trim() || null;
  const requestedEffort = requested.effort?.trim() || null;
  if (!modelConfigId) {
    if (requestedModel || requestedEffort) {
      return {
        ok: false,
        rejection: {
          error: '选择模型或推理档位时需要同时指定模型配置',
          code: 'MODEL_CONFIG_REQUIRED',
        },
      };
    }
    return {
      ok: true,
      choice: { modelConfigId: null, model: null, effort: null },
    };
  }
  const target = getProviders().find(
    (provider) => provider.id === modelConfigId,
  );
  if (!target) {
    return {
      ok: false,
      rejection: {
        error: '模型配置不存在',
        code: 'MODEL_CONFIG_NOT_FOUND',
      },
    };
  }
  if (!providerHasCredentials(target)) {
    return {
      ok: false,
      rejection: {
        error: '该模型配置缺少凭据，请先在模型配置中补全密钥或完成授权',
        code: 'MODEL_CONFIG_NO_CREDENTIALS',
      },
    };
  }
  if (!requestedModel && !requestedEffort) {
    return { ok: true, choice: { modelConfigId, model: null, effort: null } };
  }
  const checked = validateSessionChoice(
    target,
    { model: requestedModel, effort: requestedEffort },
    chooser,
    agentModelOn(target, workspaceProfile(group), group.folder),
  );
  if (!checked.ok) return { ok: false, rejection: checked.rejection };
  return {
    ok: true,
    choice: { modelConfigId, model: checked.model, effort: checked.effort },
  };
}

/**
 * What the runners of a conversation must do about a change of its choice.
 *
 * A different configuration or model starts a new SDK session on the next
 * message, so the warm runner is retired (one already on the chosen
 * configuration is spared only when no model is involved: neither choice
 * names one, and a conversation that had picked nothing did not run the
 * Agent's). A different effort on a ChatGPT subscription needs no restart at
 * all: the gateway reads it per request, so the live runners of the chosen
 * configuration are pointed at it and keep running. Elsewhere Claude Code
 * takes its effort at start, so the runner is retired but the SDK session
 * kept. Choosing nothing new does nothing.
 */
function applySessionChoiceChange(
  runners: SessionRunnerControl | null,
  group: RegisteredGroup,
  agentId: string,
  workspaceJid: string,
  previous: SessionModelSelectionDetail | null,
  next: SessionModelChoice,
): { drained: number; liveUpdated: number } {
  const providers = getProviders();
  const profile = workspaceProfile(group);
  // The model a configuration actually runs: its pick, else the Agent's on
  // the Agent's own connection, else the connection's own.
  const launchKey = (
    choice: { modelConfigId: string | null; model: string | null } | null,
  ): string => {
    if (!choice?.modelConfigId) return '';
    const provider = providers.find((item) => item.id === choice.modelConfigId);
    const agentModel = provider
      ? agentModelOn(provider, profile, group.folder)
      : undefined;
    const model = !provider
      ? ''
      : provider.codexOAuthCredentials
        ? (choice.model ?? agentModel ?? chatGptDefaultModel(provider))
        : (choice.model ?? agentModel ?? provider.anthropicModel);
    return `${choice.modelConfigId}\u0000${model}`;
  };
  const jids = [`${workspaceJid}#agent:${agentId}`];
  const effortChanged = (previous?.effort ?? null) !== next.effort;
  let drained = 0;
  if (launchKey(previous) !== launchKey(next)) {
    const ranAgentModel =
      !previous && !!profile?.model_config_id && !!profile.model;
    const target =
      previous?.model || next.model || ranAgentModel
        ? null
        : next.modelConfigId;
    drained = runners?.drainRunnersForModelSelection(jids, target) ?? 0;
  } else if (
    effortChanged &&
    !providers.find((item) => item.id === next.modelConfigId)
      ?.codexOAuthCredentials
  ) {
    // Claude Code reads its effort when the runner starts: a new one takes
    // a new runner, on the same SDK session (the model did not change).
    drained = runners?.drainRunnersForModelSelection(jids, null) ?? 0;
  }
  let liveUpdated = 0;
  if (effortChanged) {
    liveUpdated = updateLiveSessionEffort(
      {
        groupFolder: group.folder,
        sessionAgentId: agentId,
        providerId: next.modelConfigId ?? undefined,
      },
      next.effort ?? undefined,
    );
  }
  return { drained, liveUpdated };
}

export interface SessionModelChoiceSaved {
  previous: SessionModelSelectionDetail | null;
  drained: number;
  liveUpdated: number;
}

/**
 * Store a checked choice for one conversation and retire the runners it
 * affects. `runners` defaults to the running service's queue.
 */
export function saveSessionModelChoice(input: {
  group: RegisteredGroup;
  workspaceJid: string;
  agentId: string;
  choice: SessionModelChoice;
  updatedBy: string | null;
  runners?: SessionRunnerControl;
}): SessionModelChoiceSaved {
  const { group, agentId, choice } = input;
  const previous = getSessionModelSelectionDetail(group.folder, agentId);
  setSessionModelSelection(
    group.folder,
    agentId,
    choice.modelConfigId,
    input.updatedBy,
    { model: choice.model, effort: choice.effort },
  );
  const { drained, liveUpdated } = applySessionChoiceChange(
    input.runners ?? getWebDeps()?.queue ?? null,
    group,
    agentId,
    input.workspaceJid,
    previous,
    choice,
  );
  return { previous, drained, liveUpdated };
}

/** Whether a conversation's stored record already is `choice`. */
export function sessionHasModelChoice(
  groupFolder: string,
  agentId: string,
  choice: SessionModelChoice,
): boolean {
  const stored = getSessionModelSelectionDetail(groupFolder, agentId);
  if (!stored) return !choice.modelConfigId;
  return (
    stored.modelConfigId === choice.modelConfigId &&
    stored.model === storedModelName(choice.model) &&
    stored.effort === (choice.effort || null)
  );
}

/**
 * Give a conversation that was just created a choice. It has never run, so
 * there is no runner to retire.
 */
export function setNewSessionModelChoice(
  groupFolder: string,
  agentId: string,
  choice: SessionModelChoice,
  updatedBy: string | null,
): void {
  setSessionModelSelection(
    groupFolder,
    agentId,
    choice.modelConfigId,
    updatedBy,
    { model: choice.model, effort: choice.effort },
  );
}

/**
 * Give a derived conversation (a Worker, a team router or execution session)
 * the record its origin holds, chooser included; nothing when the origin
 * picked nothing. The record is copied as it is: a launch checks it like any
 * stored choice, so one gone stale falls back to the default there.
 */
export function copySessionModelSelection(
  groupFolder: string,
  fromAgentId: string | null | undefined,
  toAgentId: string,
): void {
  if (!fromAgentId) return;
  const stored = getSessionModelSelectionDetail(groupFolder, fromAgentId);
  if (stored) {
    setNewSessionModelChoice(groupFolder, toAgentId, stored, stored.updatedBy);
  }
}
