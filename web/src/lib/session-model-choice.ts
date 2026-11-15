import { api } from '../api/client';
import { effortLabel } from '../components/settings/model-connections';
import { registerUserScopedReset } from '../stores/user-scope';

// A model choice made before any conversation exists: a new session's, or
// the one an automation gives the sessions its runs go to. The options come
// from GET /api/groups/:jid/model-options, the same `default` and `options`
// the chat's model picker reads. The types here are this module's own and
// read only what it needs, so fields the server adds pass through harmlessly.

/** A picked connection, and optionally a model of it and an effort. */
export interface ModelChoice {
  modelConfigId: string;
  /** A model of the connection; null runs the connection's own. */
  model: string | null;
  /** A reasoning effort; null follows the default. */
  effort: string | null;
}

/** What a conversation that picks nothing runs on. */
export interface ModelOptionsDefault {
  source: 'agent' | 'owner_main' | 'system_main' | 'workspace_env' | 'none';
  modelConfigId: string | null;
  /** The bound connection is deleted or has no credential: runs fail. */
  connectionMissing?: boolean;
  model?: string | null;
  effort?: string | null;
}

/** One model of a non-ChatGPT connection. */
export interface ConnectionModelEntry {
  id: string;
  /**
   * Empty: the model takes none, unless `effortsSource` is `none`, which
   * means nothing is known and every effort may be picked, unverified.
   */
  efforts?: string[];
  defaultEffort?: string | null;
  effortsSource?: string;
  displayName?: string | null;
  display_name?: string | null;
}

/** One model a ChatGPT login may run. */
export interface CodexModelEntry {
  value: string;
  label?: string;
  efforts?: string[];
  defaultEffort?: string | null;
}

export interface ModelConnectionOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  /** The connection's own model; '' lets a relay decide. */
  model: string;
  /** False when the connection holds no credential and would fail. */
  usable?: boolean;
  models?: ConnectionModelEntry[];
  codex?: {
    defaultModel: string;
    defaultEffort?: string | null;
    needsReauth?: boolean;
    models: CodexModelEntry[];
  };
}

export interface WorkspaceModelOptions {
  default: ModelOptionsDefault;
  options: ModelConnectionOption[];
}

/** A model as a choice lists it. */
export interface ChoiceModel {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  /** Nothing is known about its efforts: all are offered, none verified. */
  effortsUnverified: boolean;
}

/** Every effort a model nothing is known about may be given. */
const UNVERIFIED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// ─── Loading ──────────────────────────────────────────────────────────

const loaded = new Map<string, Promise<WorkspaceModelOptions>>();

/**
 * The model options of a workspace, one request per workspace however many
 * rows ask. `refresh` asks again (a picker opening wants the connections as
 * they are now) and keeps the answer for the rows. A failed request is not
 * kept, so the next caller tries again.
 */
export function loadWorkspaceModelOptions(
  workspaceJid: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<WorkspaceModelOptions> {
  const cached = refresh ? undefined : loaded.get(workspaceJid);
  if (cached) return cached;
  const request = api
    .get<Partial<WorkspaceModelOptions> | null>(
      `/api/groups/${encodeURIComponent(workspaceJid)}/model-options`,
    )
    .then(
      (data): WorkspaceModelOptions => ({
        // An answer without a default reads as one that resolves nothing.
        default: data?.default ?? { source: 'none', modelConfigId: null },
        options: Array.isArray(data?.options) ? data.options : [],
      }),
    );
  loaded.set(workspaceJid, request);
  request.catch(() => {
    if (loaded.get(workspaceJid) === request) loaded.delete(workspaceJid);
  });
  return request;
}

/** Drops every kept answer (signing in or out, tests). */
export function forgetWorkspaceModelOptions(): void {
  loaded.clear();
}

// The options are the signed-in user's: the next one on this device must
// not be shown them.
registerUserScopedReset(forgetWorkspaceModelOptions);

// ─── Reading options ──────────────────────────────────────────────────

/** Why a connection is listed but cannot be chosen ('' when it can). */
export function connectionUnavailableReason(
  option: ModelConnectionOption,
): string {
  if (option.usable === false) return '缺少凭据';
  if (option.codex?.needsReauth) return '需重新登录';
  return '';
}

/** The model a pick without a model runs on the connection. */
export function connectionOwnModel(option: ModelConnectionOption): string {
  return option.codex ? option.codex.defaultModel : option.model;
}

/** Every model the connection offers, as the model control lists them. */
export function connectionModels(option: ModelConnectionOption): ChoiceModel[] {
  if (option.codex) {
    return option.codex.models.map((entry) => ({
      id: entry.value,
      label: entry.label || entry.value,
      efforts: entry.efforts ?? [],
      defaultEffort: entry.defaultEffort || null,
      effortsUnverified: false,
    }));
  }
  return (option.models ?? []).map((entry) => {
    const unknown = !entry.efforts?.length && entry.effortsSource === 'none';
    return {
      id: entry.id,
      label: entry.displayName || entry.display_name || entry.id,
      efforts: unknown ? UNVERIFIED_EFFORTS : (entry.efforts ?? []),
      defaultEffort: entry.defaultEffort ?? null,
      effortsUnverified: unknown,
    };
  });
}

/**
 * The efforts the model a choice runs takes (none: no effort control), and
 * the level it runs at when none is picked.
 */
export function choiceEfforts(
  option: ModelConnectionOption,
  model: string | null,
): { efforts: string[]; defaultEffort: string | null; unverified: boolean } {
  const id = model ?? connectionOwnModel(option);
  const entry = connectionModels(option).find((item) => item.id === id);
  if (!entry?.efforts.length) {
    return { efforts: [], defaultEffort: null, unverified: false };
  }
  const defaultEffort =
    entry.defaultEffort ??
    (option.codex && !model ? (option.codex.defaultEffort ?? null) : null);
  return {
    efforts: entry.efforts,
    defaultEffort,
    unverified: entry.effortsUnverified,
  };
}

/** How a model of the connection is named: its display name, else its id. */
export function modelDisplayName(
  option: ModelConnectionOption | undefined,
  model: string,
): string {
  return (
    (option &&
      connectionModels(option).find((entry) => entry.id === model)?.label) ||
    model
  );
}

/** The default cannot run: nothing resolves, or its connection is unusable. */
export function defaultUnusable(options: WorkspaceModelOptions): boolean {
  const { source, connectionMissing, modelConfigId } = options.default;
  if (connectionMissing || source === 'none') return true;
  return (
    source !== 'workspace_env' &&
    !options.options.some((option) => option.id === modelConfigId)
  );
}

/**
 * What following the default runs: connection, model and effort, or why it
 * cannot run.
 */
export function describeDefaultChoice(options: WorkspaceModelOptions): string {
  const { source, modelConfigId, model, effort, connectionMissing } =
    options.default;
  if (connectionMissing) return '连接不可用，绑定的连接已删除或缺少凭据';
  if (source === 'workspace_env') return '使用工作区自带的 Provider 环境变量';
  const named = options.options.find((option) => option.id === modelConfigId);
  if (source === 'none' || !named) {
    return options.options.some(
      (option) => !connectionUnavailableReason(option),
    )
      ? '未选择模型，运行会失败；请选择连接'
      : '还没有可用的模型，运行会失败';
  }
  // A ChatGPT connection is named by the model it runs, as the chat's picker
  // names it.
  const parts = named.codex
    ? [modelDisplayName(named, model || named.codex.defaultModel)]
    : [named.name, model ? modelDisplayName(named, model) : null];
  if (effort) parts.push(effortLabel(effort));
  return parts.filter(Boolean).join(' · ');
}

/**
 * A choice in a line: `连接 · 模型 · 档位`. Without the options (not loaded,
 * or no access) it falls back to the ids it holds.
 */
export function describeModelChoice(
  choice: ModelChoice,
  options: WorkspaceModelOptions | null,
): string {
  const option = options?.options.find(
    (item) => item.id === choice.modelConfigId,
  );
  return [
    option?.name ?? choice.modelConfigId,
    choice.model ? modelDisplayName(option, choice.model) : '连接默认模型',
    choice.effort ? effortLabel(choice.effort) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
