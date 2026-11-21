/**
 * Canonical source. Build step copies this file to:
 *   - src/model-providers.ts
 *   - web/src/lib/model-providers.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 */

/**
 * What the server and the Web agree on about model connections: the vendor
 * presets a connection can start from, the models a connection offers, how a
 * vendor's model list is read, and how an upstream failure is classified.
 * Everything here is data or a pure function.
 *
 * The preset catalog, the model list parsing and the error classification are
 * adapted from cindy (https://github.com/makecindy/cindy, Apache-2.0, commit
 * 7be4c57d7b: packages/model-providers/catalog/providers.json,
 * packages/model-providers/src/modelDiscovery.ts and
 * apps/desktop/src/shared/providerErrors.ts). Modified for HappyClaw: only the
 * Anthropic Messages endpoints Claude Code can use are kept, and the copy is
 * HappyClaw's own. See THIRD_PARTY_NOTICES.md.
 */

// ─── Models of a connection ────────────────────────────────────

/** Reasoning efforts Claude Code accepts as CLAUDE_CODE_EFFORT_LEVEL. */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export function isModelEffort(value: unknown): value is ModelEffort {
  return (
    typeof value === 'string' &&
    (MODEL_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * One model a connection offers. `id` is the upstream model name exactly as
 * the gateway spells it, never with Claude Code's `[1m]` suffix: whether the
 * suffix is sent follows from `contextWindow` at launch.
 */
export interface ProviderModelEntry {
  id: string;
  /** The vendor's name for the model, when its list gives one. */
  displayName?: string;
  /** Context window in tokens, when the user, the vendor or a preset says. */
  contextWindow?: number;
  /**
   * Efforts the user or the vendor declared. Absent: unknown, and the
   * registry decides. Empty: the model takes no effort, so HappyClaw passes
   * none; thinking stays as `thinks` says.
   */
  efforts?: ModelEffort[];
  /** The effort this model runs at when neither the Agent nor the chat picks. */
  defaultEffort?: ModelEffort;
  /**
   * Whether the vendor says the model reasons (magpie's `reasoning`). Only an
   * explicit `false` on a model that takes no effort turns thinking off at
   * launch; absent (unknown) and `true` keep it on. An admin who unticks
   * every effort only stops HappyClaw passing one.
   */
  thinks?: boolean;
  /** The longest reply the vendor declares for the model, in tokens. */
  maxOutputTokens?: number;
  /** Who serves the model behind a gateway (magpie's provider, `owned_by`). */
  vendor?: string;
  /**
   * When a catalog sync first found the model gone from the upstream list.
   * The model stays until an admin removes it; it is cleared when it returns.
   */
  upstreamMissingSince?: string;
  /**
   * What the last catalog sync wrote for the fields an admin may override, so
   * the next sync can tell an admin's value (kept) from its own (updated).
   */
  synced?: { contextWindow?: number; efforts?: ModelEffort[] };
}

export const MAX_PROVIDER_MODELS = 100;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 200;
export const MIN_CONTEXT_WINDOW = 1_000;
export const MAX_CONTEXT_WINDOW = 10_000_000;
export const MAX_MODEL_DISPLAY_NAME_LENGTH = 200;
export const MAX_MODEL_VENDOR_LENGTH = 100;
export const MAX_OUTPUT_TOKENS_LIMIT = 10_000_000;

/**
 * The alias magpie lists a model under for Claude Code's own model discovery
 * (a request with `anthropic-version` and a `claude-cli/` or `claude-code/`
 * agent). It names a row of that one list, not a model: another request may
 * number the models differently, so a connection never keeps one.
 */
const MAGPIE_ALIAS_RE = /^anthropic\/magpie-\d+$/i;

export function isMagpieAliasModelId(id: string): boolean {
  return MAGPIE_ALIAS_RE.test(splitOneMillionSuffix(id).model);
}

const ONE_MILLION_SUFFIX = '[1m]';
const ONE_MILLION_SUFFIX_RE = /(?:\[1m\])+$/i;

/**
 * The window of a model Claude Code does not recognize, without `[1m]`
 * (kept on 2.1.323+ by keepsTwoHundredKWindow).
 */
export const CLAUDE_CODE_DEFAULT_CONTEXT = 200_000;
/** The window `[1m]` gives a model. */
export const ONE_MILLION_CONTEXT = 1_000_000;

/**
 * Splits Claude Code's `[1m]` switch off a model name. The suffix is not part
 * of the model: Claude Code strips it before the request and only raises its
 * context ceiling to 1M.
 */
export function splitOneMillionSuffix(id: string): {
  model: string;
  oneMillion: boolean;
} {
  const trimmed = id.trim();
  return {
    model: trimmed.replace(ONE_MILLION_SUFFIX_RE, '').trim(),
    oneMillion: ONE_MILLION_SUFFIX_RE.test(trimmed),
  };
}

export function withOneMillionSuffix(
  model: string,
  oneMillion: boolean,
): string {
  const base = splitOneMillionSuffix(model).model;
  return oneMillion && base ? `${base}${ONE_MILLION_SUFFIX}` : base;
}

/** Whether `id` can be handed to Claude Code as a model name. */
export function isValidModelId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_PROVIDER_MODEL_ID_LENGTH &&
    // No whitespace or control characters: the id lands in an env file.
    !/[\s\u0000-\u001f\u007f]/.test(id)
  );
}

/** A token count within [min, max] from untrusted input, or undefined. */
function normalizeTokenCount(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const number =
    typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
  const floored = Math.floor(number);
  return floored >= min && floored <= max ? floored : undefined;
}

/** A context window from untrusted input, or undefined when it is not one. */
export function normalizeContextWindow(value: unknown): number | undefined {
  return normalizeTokenCount(value, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
}

/**
 * Efforts from untrusted input, deduplicated in the low → max order. An
 * empty list is a declaration (the model takes none) and stays empty; a list
 * naming only efforts Claude Code has no level for says nothing and reads as
 * unknown, like a missing one.
 */
export function normalizeEfforts(value: unknown): ModelEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const set = new Set(value.filter(isModelEffort));
  const efforts = MODEL_EFFORTS.filter((effort) => set.has(effort));
  return efforts.length ? efforts : undefined;
}

/** A positive token count from untrusted input, or undefined. */
function normalizeMaxOutputTokens(value: unknown): number | undefined {
  return normalizeTokenCount(value, 1, MAX_OUTPUT_TOKENS_LIMIT);
}

/** A short label from untrusted input: trimmed, single line, capped. */
function normalizeLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return label ? label.slice(0, max) : undefined;
}

/** ISO time from untrusted input, or undefined. */
export function normalizeIsoTime(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/**
 * The metadata fields of one model entry from untrusted input: everything
 * but the id, the window and the efforts the caller reads itself.
 */
function normalizeEntryMetadata(
  record: Record<string, unknown>,
): Pick<
  ProviderModelEntry,
  | 'displayName'
  | 'thinks'
  | 'maxOutputTokens'
  | 'vendor'
  | 'upstreamMissingSince'
  | 'synced'
> {
  const out: ReturnType<typeof normalizeEntryMetadata> = {};
  const displayName = normalizeLabel(
    record.displayName,
    MAX_MODEL_DISPLAY_NAME_LENGTH,
  );
  if (displayName) out.displayName = displayName;
  if (typeof record.thinks === 'boolean') out.thinks = record.thinks;
  const maxOutputTokens = normalizeMaxOutputTokens(record.maxOutputTokens);
  if (maxOutputTokens) out.maxOutputTokens = maxOutputTokens;
  const vendor = normalizeLabel(record.vendor, MAX_MODEL_VENDOR_LENGTH);
  if (vendor) out.vendor = vendor;
  const missing = normalizeIsoTime(record.upstreamMissingSince);
  if (missing) out.upstreamMissingSince = missing;
  if (record.synced && typeof record.synced === 'object') {
    const synced = record.synced as Record<string, unknown>;
    const contextWindow = normalizeContextWindow(synced.contextWindow);
    const efforts = normalizeEfforts(synced.efforts);
    if (contextWindow || efforts) {
      out.synced = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(efforts ? { efforts } : {}),
      };
    }
  }
  return out;
}

/**
 * Reads a model list from untrusted input (a request body, a stored file):
 * trims ids, drops invalid and duplicate ones, keeps only known fields, caps
 * the length. Returns null when the input is not a list at all.
 *
 * Lists saved before the context window was a field spelled 1M as a `[1m]`
 * suffix on the id and the default effort as `effort`; both are read into
 * the current fields. `hidden` is no longer a thing: every model a
 * connection keeps is offered.
 */
export function normalizeProviderModels(
  input: unknown,
  options: { max?: number } = {},
): ProviderModelEntry[] | null {
  if (!Array.isArray(input)) return null;
  const max = options.max ?? MAX_PROVIDER_MODELS;
  const out: ProviderModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= max) break;
    const record =
      typeof raw === 'string'
        ? { id: raw }
        : raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : null;
    if (!record || typeof record.id !== 'string') continue;
    const { model: id, oneMillion } = splitOneMillionSuffix(record.id);
    if (!isValidModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const entry: ProviderModelEntry = { id };
    const contextWindow =
      normalizeContextWindow(record.contextWindow) ??
      (oneMillion ? ONE_MILLION_CONTEXT : undefined);
    if (contextWindow) entry.contextWindow = contextWindow;
    const efforts = normalizeEfforts(record.efforts);
    if (efforts) entry.efforts = efforts;
    const defaultEffort = isModelEffort(record.defaultEffort)
      ? record.defaultEffort
      : isModelEffort(record.effort)
        ? record.effort
        : undefined;
    // A model declared to take no effort has no default one either.
    if (defaultEffort && efforts?.length !== 0) {
      entry.defaultEffort = defaultEffort;
    }
    Object.assign(entry, normalizeEntryMetadata(record));
    out.push(entry);
  }
  return out;
}

/** The fields a catalog sync owns, which the admin's edits never carry. */
const SYNC_OWNED_FIELDS = [
  'displayName',
  'maxOutputTokens',
  'vendor',
  'thinks',
  'upstreamMissingSince',
  'synced',
] as const satisfies readonly (keyof ProviderModelEntry)[];

/**
 * A list an admin submitted, with what the vendor and the catalog sync said
 * about each model carried over from the current list when the submitted
 * entry leaves it out: the Web edits windows and efforts, and a client that
 * does not know a field must not erase it.
 */
export function carrySyncedModelFields(
  submitted: readonly ProviderModelEntry[],
  current: readonly ProviderModelEntry[],
): ProviderModelEntry[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  return submitted.map((entry) => {
    const previous = byId.get(entry.id);
    if (!previous) return entry;
    const next: ProviderModelEntry = { ...entry };
    for (const field of SYNC_OWNED_FIELDS) {
      if (next[field] === undefined && previous[field] !== undefined) {
        (next as unknown as Record<string, unknown>)[field] = previous[field];
      }
    }
    return next;
  });
}

/**
 * The models a connection offers. A connection saved before it had a list
 * offers its one model; a pass-through connection (no model) offers none and
 * lets the client pick. The connection's own model is always in the list.
 */
export function effectiveProviderModels(provider: {
  anthropicModel: string;
  models?: readonly ProviderModelEntry[] | null;
}): ProviderModelEntry[] {
  const models = normalizeProviderModels(provider.models ?? []) ?? [];
  const { model: defaultModel, oneMillion } = splitOneMillionSuffix(
    provider.anthropicModel,
  );
  if (!defaultModel) return models;
  if (models.some((entry) => entry.id === defaultModel)) return models;
  return [
    oneMillion
      ? { id: defaultModel, contextWindow: ONE_MILLION_CONTEXT }
      : { id: defaultModel },
    ...models,
  ];
}

/** The entry for `id` (with or without `[1m]`), if the list has it. */
export function findModelEntry(
  models: readonly ProviderModelEntry[],
  id: string,
): ProviderModelEntry | undefined {
  const { model } = splitOneMillionSuffix(id);
  return models.find((entry) => entry.id === model);
}

/**
 * The entry a discovered model is added as: its window, efforts (an empty
 * list included), name, longest reply and vendor come along. Null for an id
 * a connection cannot keep (invalid, or a magpie discovery alias).
 */
export function discoveredModelEntry(
  raw: DiscoveredModel | string,
): ProviderModelEntry | null {
  const item: DiscoveredModel = typeof raw === 'string' ? { id: raw } : raw;
  const { model: id, oneMillion } = splitOneMillionSuffix(item.id);
  if (!isValidModelId(id) || isMagpieAliasModelId(id)) return null;
  const entry: ProviderModelEntry = { id };
  const displayName = normalizeLabel(item.name, MAX_MODEL_DISPLAY_NAME_LENGTH);
  if (displayName && displayName !== id) entry.displayName = displayName;
  const contextWindow =
    normalizeContextWindow(item.contextWindow) ??
    (oneMillion ? ONE_MILLION_CONTEXT : undefined);
  if (contextWindow) entry.contextWindow = contextWindow;
  const efforts = normalizeEfforts(item.efforts);
  if (efforts) entry.efforts = efforts;
  if (
    isModelEffort(item.defaultEffort) &&
    efforts?.includes(item.defaultEffort)
  ) {
    entry.defaultEffort = item.defaultEffort;
  }
  // Whether it reasons matters only to a model that takes no effort.
  if (typeof item.thinks === 'boolean' && efforts?.length === 0) {
    entry.thinks = item.thinks;
  }
  const maxOutputTokens = normalizeMaxOutputTokens(item.maxOutputTokens);
  if (maxOutputTokens) entry.maxOutputTokens = maxOutputTokens;
  const vendor = normalizeLabel(item.vendor, MAX_MODEL_VENDOR_LENGTH);
  if (vendor) entry.vendor = vendor;
  return entry;
}

/**
 * Adds the newly discovered models to a list without touching what is there.
 * What the vendor says about a model comes along; existing entries keep what
 * the user set.
 */
export function mergeDiscoveredModels(
  existing: readonly ProviderModelEntry[],
  discovered: readonly (DiscoveredModel | string)[],
): { models: ProviderModelEntry[]; added: string[] } {
  const known = new Set(existing.map((entry) => entry.id));
  const additions: ProviderModelEntry[] = [];
  for (const raw of discovered) {
    const entry = discoveredModelEntry(raw);
    if (!entry || known.has(entry.id)) continue;
    known.add(entry.id);
    additions.push(entry);
  }
  const room = Math.max(0, MAX_PROVIDER_MODELS - existing.length);
  const kept = additions.slice(0, room);
  return {
    models: [...existing, ...kept],
    added: kept.map((entry) => entry.id),
  };
}

// ─── Roles: which model Claude Code uses for what ──────────────

/**
 * Which of a connection's models Claude Code uses besides the one a turn runs
 * on. Every role names a model of the same connection, since one Claude Code
 * process talks to one endpoint with one credential, so the names are the
 * gateway's own. An absent role follows the model the turn runs on.
 */
export interface ConnectionModelRoles {
  /** Sub-agents (Task): CLAUDE_CODE_SUBAGENT_MODEL. */
  subagent?: string;
  /** Background calls (titles, summaries, WebFetch): the haiku tier. */
  smallFast?: string;
  /** `model: "opus"` in a Task, and Claude Code's opus tier. */
  opus?: string;
  /** `model: "sonnet"` in a Task, and Claude Code's sonnet tier. */
  sonnet?: string;
}

export const CONNECTION_MODEL_ROLES = [
  'subagent',
  'smallFast',
  'opus',
  'sonnet',
] as const satisfies readonly (keyof ConnectionModelRoles)[];

/**
 * Roles from untrusted input. A role that names a model the connection does
 * not offer is dropped (it then follows the turn's model) rather than sent to
 * a gateway that would refuse it.
 */
export function normalizeConnectionModelRoles(
  input: unknown,
  models: readonly ProviderModelEntry[],
): ConnectionModelRoles {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const roles: ConnectionModelRoles = {};
  for (const role of CONNECTION_MODEL_ROLES) {
    const value = record[role];
    if (typeof value !== 'string' || !value.trim()) continue;
    const entry = findModelEntry(models, value);
    if (entry) roles[role] = entry.id;
  }
  return roles;
}

// ─── Context window and Claude Code's `[1m]` switch ────────────

/**
 * The model name Claude Code is given for a model with this window. Claude
 * Code caps a model it does not know at 200K and only lowers that with
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW, so anything above 200K needs `[1m]` to
 * lift the ceiling first; the compact window then brings it back down.
 */
export function launchModelName(
  id: string,
  contextWindow: number | null | undefined,
): string {
  const { model } = splitOneMillionSuffix(id);
  return withOneMillionSuffix(
    model,
    !!contextWindow && contextWindow > CLAUDE_CODE_DEFAULT_CONTEXT,
  );
}

/**
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW for a model with this window, or null when
 * Claude Code's own ceiling already matches (200K plain, 1M with `[1m]`) or
 * the window is unknown, in which case nothing is injected.
 */
export function autoCompactWindowFor(
  contextWindow: number | null | undefined,
): number | null {
  if (!contextWindow) return null;
  if (contextWindow === CLAUDE_CODE_DEFAULT_CONTEXT) return null;
  if (contextWindow >= ONE_MILLION_CONTEXT) return null;
  return contextWindow;
}

/**
 * A Claude model id as Claude Code names one (`claude-<family>-<version>`,
 * `claude-3-…`), under any provider prefix (`anthropic/…`, `anthropic.…`).
 */
const CLAUDE_MODEL_NAME_RE = /(?:^|[/.])claude-(?:[a-z]+-)?\d/i;

/**
 * Whether a third-party launch of `launchModel` (as launchModelName names it)
 * needs CLAUDE_CODE_DISABLE_1M_CONTEXT=1 to keep the 200K window Claude Code
 * assumed before 2.1.323 (see CLAUDE.md §5): a model without `[1m]` that
 * declares its window or that Claude Code does not know by name.
 */
export function keepsTwoHundredKWindow(
  launchModel: string,
  contextWindow: number | null | undefined,
): boolean {
  const { model, oneMillion } = splitOneMillionSuffix(launchModel);
  if (!model || oneMillion) return false;
  if (contextWindow) return true;
  return (
    !CLAUDE_MODEL_NAME_RE.test(model) &&
    !Object.hasOwn(CLAUDE_CODE_ALIASES, model.toLowerCase())
  );
}

/** Keys the launch derives from the models and roles; not free env. */
export const CONNECTION_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const;

/**
 * What a new third-party connection's environment starts with. The user may
 * change or delete each; a key that is not in the saved environment is not
 * injected.
 */
export const CONNECTION_ENV_PREFILL: Readonly<Record<string, string>> = {
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_NO_FLICKER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

export interface ConnectionModelEnvInput {
  /** The model this turn runs on (with or without `[1m]`); '' for none. */
  model: string;
  models: readonly ProviderModelEntry[];
  roles?: ConnectionModelRoles | null;
  /** The same-turn fallback model the launch is handed, if any. */
  fallbackModel?: string | null;
  /** The models the launch's custom sub-agents name, if any. */
  subagentModels?: readonly string[];
}

/**
 * The model environment of one launch on a third-party endpoint: the turn's
 * model with `[1m]` when its window needs it, each tier and the sub-agent
 * model from the roles or else the turn's model, the compact window and the
 * 200K ceiling (keepsTwoHundredKWindow) of the turn's model, which apply to
 * the whole launch, and the longest reply they all declare
 * (maxOutputTokensFor).
 * A pass-through connection (no model) only gets the roles it names.
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS and CLAUDE_CODE_DISABLE_1M_CONTEXT are not
 * CONNECTION_MODEL_ENV_KEYS: a value in the connection's own env replaces
 * them.
 */
export function buildConnectionModelEnv(
  input: ConnectionModelEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {};
  const roles = input.roles ?? {};
  const named = (id: string | undefined): string | undefined =>
    id ? launchModelName(id, windowOf(input.models, id)) : undefined;
  const model = input.model.trim();
  const declared = model ? windowOf(input.models, model) : null;
  const current = model ? launchModelName(model, declared) : undefined;
  if (current) env.ANTHROPIC_MODEL = current;
  const opus = named(roles.opus) ?? current;
  const sonnet = named(roles.sonnet) ?? current;
  const haiku = named(roles.smallFast) ?? current;
  const subagent = named(roles.subagent) ?? current;
  if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
  if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  if (subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent;
  if (current) {
    const window = autoCompactWindowFor(declared);
    if (window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window);
    if (keepsTwoHundredKWindow(current, declared)) {
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
    }
  }
  const maxOutput = maxOutputTokensFor(
    input.models,
    input.model,
    roles,
    input.fallbackModel,
    input.subagentModels,
  );
  if (maxOutput) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutput);
  return env;
}

/** What Claude Code allows itself for a model it does not know. */
const CLAUDE_CODE_DEFAULT_MAX_OUTPUT = 32_000;
/** The most CLAUDE_CODE_MAX_OUTPUT_TOKENS raises a reply to. */
const CLAUDE_CODE_MAX_OUTPUT_CEILING = 128_000;

/**
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS for a launch on `model` with `roles`, the
 * same-turn `fallbackModel` and the models its custom sub-agents name, or
 * null to leave Claude Code's own limit. The launch may answer with the
 * turn's model, any role's (each tier and the sub-agent fall back to the
 * turn's model), the fallback or a custom sub-agent's, so the value is the
 * smallest reply every one of them declares, capped at 128K. Nothing is
 * written unless all of them declare one and it lifts the reply above
 * Claude Code's 32K default: a model that declares nothing (a fallback the
 * list does not have included) might refuse a longer request.
 */
export function maxOutputTokensFor(
  models: readonly ProviderModelEntry[],
  model: string,
  roles: ConnectionModelRoles | null | undefined,
  fallbackModel?: string | null,
  subagentModels: readonly string[] = [],
): number | null {
  const current = splitOneMillionSuffix(model).model;
  if (!current) return null;
  const used = new Set<string>([current]);
  for (const role of CONNECTION_MODEL_ROLES) {
    const id = roles?.[role];
    if (id) used.add(splitOneMillionSuffix(id).model);
  }
  for (const id of subagentModels) used.add(splitOneMillionSuffix(id).model);
  const fallback = fallbackModel && splitOneMillionSuffix(fallbackModel).model;
  if (fallback) used.add(fallback);
  let smallest = Infinity;
  for (const id of used) {
    const declared = findModelEntry(models, id)?.maxOutputTokens;
    if (!declared) return null;
    smallest = Math.min(smallest, declared);
  }
  const value = Math.min(smallest, CLAUDE_CODE_MAX_OUTPUT_CEILING);
  return value > CLAUDE_CODE_DEFAULT_MAX_OUTPUT ? value : null;
}

/**
 * The context window a launch of `id` assumes: the window declared on the
 * connection's entry, else 1M for a name still carrying `[1m]` (a choice
 * saved before the window was a field), else unknown. A registry window is
 * only a suggestion for the add flow: it never turns on `[1m]` by itself,
 * since a gateway may serve less and 1M may be billed as long context.
 */
export function windowOf(
  models: readonly ProviderModelEntry[],
  id: string,
): number | null {
  const { model, oneMillion } = splitOneMillionSuffix(id);
  const known = resolveModelCapabilities(
    findModelEntry(models, model) ?? { id: model },
  ).contextWindow;
  return known ?? (oneMillion ? ONE_MILLION_CONTEXT : null);
}

// ─── Connection tests ──────────────────────────────────────────

/** The outcome of the last connection test, kept with the connection. */
export interface ProviderTestRecord {
  ok: boolean;
  /** Null when the test passed. */
  code: ProviderErrorCode | null;
  /** HTTP status of the failing request; null for network errors. */
  status: number | null;
  /** The model the test ran on; null for account checks (subscriptions). */
  model: string | null;
  latencyMs: number | null;
  /** ISO time the test finished. */
  at: string;
}

/** A model a vendor's list endpoint returned. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  /** Efforts the vendor declares; absent when it says nothing, [] for none. */
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort;
  /** The vendor's boolean `reasoning` (see ProviderModelEntry.thinks). */
  thinks?: boolean;
  maxOutputTokens?: number;
  /** Who serves the model: magpie's provider name, else `owned_by`. */
  vendor?: string;
  /** magpie's `magpie_label`: only magpie lists carry one. */
  magpieLabel?: string;
}

/** Gateways HappyClaw knows by more than their address. */
export type ProviderGateway = 'magpie';

/** Whether a model list came from magpie: only magpie labels its rows. */
export function isMagpieModelList(
  models: readonly Pick<DiscoveredModel, 'magpieLabel'>[],
): boolean {
  return models.some((model) => model.magpieLabel !== undefined);
}

/** A connection's tool search setting; `default` follows the gateway. */
export type ToolSearchSetting = 'on' | 'off' | 'default';

/**
 * Whether Claude Code defers tool definitions behind its tool search
 * (ENABLE_TOOL_SEARCH). On by default for magpie, which serves it for every
 * model; off by default elsewhere, where a gateway may not.
 */
export function toolSearchEnabled(
  setting: ToolSearchSetting | null | undefined,
  gateway: ProviderGateway | null | undefined,
): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return gateway === 'magpie';
}

/** The last failed catalog check or sync of a connection. */
export interface ProviderCatalogError {
  code: ProviderErrorCode;
  message: string;
  at: string;
}

/** A magpie connection's catalog as the API shows it. */
export interface ProviderCatalogPublic {
  /** New upstream models join the list by themselves. */
  autoAdd: boolean;
  syncedAt: string | null;
  /** The last failed sync; cleared by a successful one. */
  error: ProviderCatalogError | null;
  /** Upstream models the list does not have yet. */
  newModels: ProviderModelEntry[];
}

/** What one catalog sync of a connection found. */
export type CatalogSyncResult =
  | {
      ok: true;
      gateway: ProviderGateway | null;
      /** Models auto-add put on the list. */
      added: string[];
      newModels: string[];
      missing: string[];
      /** Nothing was read: synced moments ago, or a checked non-gateway. */
      skipped?: 'recent' | 'checked';
    }
  | { ok: false; code: ProviderErrorCode; message: string };

// ─── Presets ───────────────────────────────────────────────────

export interface ModelPresetModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

/**
 * A vendor's Anthropic-compatible endpoint. Every preset takes its key as
 * `Authorization: Bearer`; the server still falls back to `x-api-key` when a
 * key is refused, and records whichever the endpoint accepted.
 */
export interface ModelPreset {
  id: string;
  name: string;
  nameEn: string;
  /** Only orders the list; every preset stays available everywhere. */
  region: 'cn' | 'global' | 'any';
  baseUrl: string;
  /** Model list endpoint, when it is not `<baseUrl>/v1/models`. */
  modelsUrl?: string;
  /** Where the vendor hands out keys. */
  keyUrl?: string;
  docsUrl?: string;
  /**
   * Models known to work; all of them are offered by a new connection. Empty
   * for a gateway whose models come from its own list.
   */
  models: readonly ModelPresetModel[];
  /**
   * The address is where the user runs the gateway, not the vendor's: the
   * preset stays with a connection whose address was changed.
   */
  editableBaseUrl?: boolean;
  /** The gateway a connection made from this preset is. */
  gateway?: ProviderGateway;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'magpie',
    name: 'Magpie',
    nameEn: 'Magpie',
    region: 'any',
    baseUrl: 'http://127.0.0.1:3425',
    docsUrl: 'https://usemagpie.ai/docs/integrate',
    models: [],
    editableBaseUrl: true,
    gateway: 'magpie',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    region: 'global',
    baseUrl: 'https://openrouter.ai/api',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl:
      'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    models: [
      { id: 'z-ai/glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
      { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_048_576,
      },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen3.8 27B', contextWindow: 1_000_000 },
      {
        id: 'qwen/qwen3.8-2.4t-a95b',
        name: 'Qwen3.8 2.4T A95B',
        contextWindow: 1_048_576,
      },
      {
        id: 'qwen/qwen3.8-flash',
        name: 'Qwen3.8 Flash',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    region: 'any',
    baseUrl: 'https://api.deepseek.com/anthropic',
    modelsUrl: 'https://api.deepseek.com/models',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/guides/anthropic_api',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek V4.1 Flash',
        contextWindow: 1_048_576,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'zhipu-glm-cn',
    name: '智谱 GLM（中国大陆）',
    nameEn: 'Zhipu GLM (China)',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
    ],
  },
  {
    id: 'zhipu-glm-global',
    name: 'Z.ai GLM (Global)',
    nameEn: 'Z.ai GLM (Global)',
    region: 'global',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
    ],
  },
  {
    id: 'moonshot-kimi-cn',
    name: 'Kimi (Moonshot 中国大陆)',
    nameEn: 'Kimi (Moonshot China)',
    region: 'cn',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs/guide/agent-support',
    models: [
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576 },
      {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
    ],
  },
  {
    id: 'moonshot-kimi-global',
    name: 'Kimi (Moonshot Global)',
    nameEn: 'Kimi (Moonshot Global)',
    region: 'global',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    docsUrl: 'https://platform.moonshot.ai/docs/guide/agent-support',
    models: [
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576 },
      {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
    ],
  },
  {
    id: 'moonshot-kimi-code',
    name: 'Kimi Code（编程计划包月）',
    nameEn: 'Kimi Code (coding plan)',
    region: 'any',
    baseUrl: 'https://api.kimi.com/coding',
    keyUrl: 'https://www.kimi.com/code/console',
    docsUrl: 'https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents',
    models: [
      { id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 262_144 },
      {
        id: 'k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi K2.8 Preview',
        contextWindow: 1_048_576,
      },
      {
        id: 'kimi-for-coding-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'k3', name: 'Kimi K3', contextWindow: 262_144 },
      { id: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262_144 },
    ],
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax（中国大陆）',
    nameEn: 'MiniMax (China)',
    region: 'cn',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    keyUrl:
      'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl:
      'https://platform.minimaxi.com/docs/api-reference/responses-create',
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        contextWindow: 1_000_000,
      },
      { id: 'MiniMax-M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2', contextWindow: 204_800 },
    ],
  },
  {
    id: 'minimax-global',
    name: 'MiniMax (Global)',
    nameEn: 'MiniMax (Global)',
    region: 'global',
    baseUrl: 'https://api.minimax.io/anthropic',
    keyUrl:
      'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/responses-create',
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        contextWindow: 1_000_000,
      },
      { id: 'MiniMax-M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2', contextWindow: 204_800 },
    ],
  },
  {
    id: 'aliyun-bailian-coding',
    name: '阿里云百炼 Coding Plan（包月）',
    nameEn: 'Alibaba Cloud Bailian Coding Plan',
    region: 'cn',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    modelsUrl: 'https://coding.dashscope.aliyuncs.com/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/coding-plan',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', contextWindow: 983_616 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 229_376 },
      { id: 'glm-5', name: 'GLM-5', contextWindow: 169_984 },
      { id: 'MiniMax-M2.5', contextWindow: 196_608 },
      {
        id: 'qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        contextWindow: 204_800,
      },
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3-Coder-Plus',
        contextWindow: 997_952,
      },
    ],
  },
  {
    id: 'aliyun-bailian-token-plan-cn',
    name: '阿里云百炼 Token Plan（个人版）',
    nameEn: 'Alibaba Cloud Bailian Token Plan (Personal)',
    region: 'cn',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    modelsUrl:
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
    docsUrl:
      'https://help.aliyun.com/zh/model-studio/token-plan-personal-overview',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 983_616 },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 983_616 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', contextWindow: 983_616 },
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_000_000,
      },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
    ],
  },
  {
    id: 'aliyun-bailian-token-plan-team-cn',
    name: '阿里云百炼 Token Plan（团队版）',
    nameEn: 'Alibaba Cloud Bailian Token Plan (Team)',
    region: 'cn',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    modelsUrl:
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-team-overview',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 983_616 },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 983_616 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', contextWindow: 983_616 },
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        contextWindow: 1_000_000,
      },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 229_376 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 229_376 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 229_376 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 169_984 },
      { id: 'glm-5', name: 'GLM-5', contextWindow: 169_984 },
      { id: 'MiniMax-M2.5', contextWindow: 196_608 },
    ],
  },
  {
    id: 'longcat',
    name: 'LongCat',
    nameEn: 'LongCat',
    region: 'any',
    baseUrl: 'https://api.longcat.chat/anthropic',
    modelsUrl: 'https://api.longcat.chat/openai/v1/models',
    keyUrl: 'https://longcat.chat/platform/api_keys',
    docsUrl: 'https://longcat.chat/platform/docs/zh/',
    models: [
      { id: 'LongCat-2.0', name: 'LongCat 2.0', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'zhipu-coding-plan-cn',
    name: '智谱 GLM Coding Plan（中国大陆）',
    nameEn: 'Zhipu GLM Coding Plan (China)',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
    models: [
      { id: 'glm-5.3[1m]', name: 'GLM-5.3 (1M)', contextWindow: 1_000_000 },
      {
        id: 'glm-5.3-flash[1m]',
        name: 'GLM-5.3-Flash (1M)',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'zai-coding-plan-global',
    name: 'Z.ai GLM Coding Plan (Global)',
    nameEn: 'Z.ai GLM Coding Plan (Global)',
    region: 'global',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/overview',
    models: [
      { id: 'glm-5.3[1m]', name: 'GLM-5.3 (1M)', contextWindow: 1_000_000 },
      {
        id: 'glm-5.3-flash[1m]',
        name: 'GLM-5.3-Flash (1M)',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'xiaomi-mimo-api-cn',
    name: '小米 MiMo API（按量）',
    nameEn: 'Xiaomi MiMo API (pay as you go)',
    region: 'cn',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/',
    docsUrl:
      'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', contextWindow: 1_048_576 },
      {
        id: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        contextWindow: 1_048_576,
      },
      {
        id: 'mimo-v2.6-pro-ultraspeed',
        name: 'MiMo-V2.6-Pro-UltraSpeed',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'xiaomi-mimo-token-plan-cn',
    name: '小米 MiMo Token Plan（包月）',
    nameEn: 'Xiaomi MiMo Token Plan',
    region: 'cn',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/token-plan',
    docsUrl:
      'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', contextWindow: 1_048_576 },
      {
        id: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'volcengine-agent-plan',
    name: '火山方舟 Agent Plan',
    nameEn: 'Volcengine Ark Agent Plan',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    keyUrl: 'https://console.volcengine.com/ark/',
    docsUrl: 'https://docs.volcengine.com/docs/82379/2373738',
    models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
  },
  {
    id: 'volcengine-coding-plan',
    name: '火山方舟 Coding Plan',
    nameEn: 'Volcengine Ark Coding Plan',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    keyUrl: 'https://console.volcengine.com/ark/',
    docsUrl: 'https://www.volcengine.com/docs/82379/1925114',
    models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
  },
  {
    id: 'tencentcloud-coding-plan',
    name: '腾讯云 Coding Plan',
    nameEn: 'Tencent Cloud Coding Plan',
    region: 'cn',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
    keyUrl: 'https://console.cloud.tencent.com/',
    docsUrl: 'https://cloud.tencent.com/document/product/1823/130092',
    models: [
      { id: 'tc-code-latest', name: 'Tencent Code Latest' },
      { id: 'glm-5', name: 'GLM-5' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    nameEn: 'OpenCode Go',
    region: 'global',
    baseUrl: 'https://opencode.ai/zen/go',
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    keyUrl: 'https://opencode.ai/auth',
    docsUrl: 'https://opencode.ai/docs/go/',
    models: [
      { id: 'minimax-m3', name: 'MiniMax M3' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
    ],
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    nameEn: 'Vercel AI Gateway',
    region: 'global',
    baseUrl: 'https://ai-gateway.vercel.sh',
    modelsUrl: 'https://ai-gateway.vercel.sh/v1/models',
    keyUrl:
      'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys',
    docsUrl: 'https://vercel.com/docs/ai-gateway/coding-agents',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Vercel)' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4 (Vercel)' },
      { id: 'xai/grok-4.5', name: 'Grok 4.5 (Vercel)' },
    ],
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 Step Plan',
    nameEn: 'StepFun Step Plan',
    region: 'cn',
    baseUrl: 'https://api.stepfun.com/step_plan',
    models: [{ id: 'step-3.7-flash' }],
  },
];

export function getModelPreset(
  id: string | null | undefined,
): ModelPreset | null {
  if (!id) return null;
  return MODEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The entry a preset model is offered as, with its known window. */
export function presetModelEntry(model: ModelPresetModel): ProviderModelEntry {
  const { model: id, oneMillion } = splitOneMillionSuffix(model.id);
  const contextWindow =
    normalizeContextWindow(model.contextWindow) ??
    (oneMillion ? ONE_MILLION_CONTEXT : undefined);
  return contextWindow ? { id, contextWindow } : { id };
}

/** Presets listed for a region first, the rest after, each in catalog order. */
export function sortPresetsForRegion(
  region: 'cn' | 'global',
): readonly ModelPreset[] {
  const rank = (preset: ModelPreset) =>
    preset.region === region ? 0 : preset.region === 'any' ? 1 : 2;
  return [...MODEL_PRESETS].sort((a, b) => rank(a) - rank(b));
}

// ─── Endpoints ─────────────────────────────────────────────────

/**
 * The comparable form of a base URL: lower-case scheme and host, no query,
 * fragment or trailing slash. Returns '' for anything that is not an
 * http(s) URL.
 */
export function normalizeProviderBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * Presets whose endpoint is exactly this URL. Several presets may share one
 * endpoint (a vendor's pay-as-you-go and plan keys), so this is a list; a
 * caller suggests a preset only when exactly one matches.
 */
export function findPresetsByBaseUrl(raw: string): ModelPreset[] {
  const normalized = normalizeProviderBaseUrl(raw);
  if (!normalized) return [];
  return MODEL_PRESETS.filter(
    (preset) => normalizeProviderBaseUrl(preset.baseUrl) === normalized,
  );
}

/**
 * Whether `preset` still speaks for a connection at `baseUrl`: a vendor's
 * only at its own endpoint, a gateway's wherever the user runs it.
 */
export function presetAppliesAt(preset: ModelPreset, baseUrl: string): boolean {
  return (
    !!preset.editableBaseUrl ||
    normalizeProviderBaseUrl(baseUrl) ===
      normalizeProviderBaseUrl(preset.baseUrl)
  );
}

/**
 * Where a connection's models are listed: the preset's own endpoint when the
 * connection still uses the preset's address, else `/models` after a
 * versioned path, else `/v1/models`. A connection on another address never
 * sends its key to the preset vendor.
 */
export function modelsUrlFor(
  baseUrl: string,
  preset?: Pick<ModelPreset, 'baseUrl' | 'modelsUrl'> | null,
): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (!normalized) return '';
  if (
    preset?.modelsUrl &&
    normalizeProviderBaseUrl(preset.baseUrl) === normalized
  ) {
    return preset.modelsUrl;
  }
  return /\/v\d+$/i.test(normalized)
    ? `${normalized}/models`
    : `${normalized}/v1/models`;
}

/** Warn about endpoint paths Claude Code would turn into `/v1/v1/messages`. */
export function describeBaseUrlProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '请输入完整的 http(s):// 地址';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '只支持 http(s) 地址';
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(path) || /\/v1$/i.test(path)) {
    return 'Claude Code 会自动追加 /v1/messages，端点通常不应以 /v1 或 /v1/messages 结尾';
  }
  return null;
}

// ─── Model list responses ──────────────────────────────────────

const MAX_DISCOVERED_MODELS = 500;

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 && Number.isSafeInteger(floored) ? floored : undefined;
}

/**
 * Reads a vendor's "list models" response: `{data: [...]}` (OpenAI and
 * Anthropic), `{models: [...]}`, or a bare array of objects or strings. Ids
 * come from `id`, `slug`, `model_id` or `model_name`; the display name and
 * context window are read when present. Returns null when the shape is not a
 * list at all, so a caller can tell "no models" from "not a model list".
 */
export function parseModelList(json: unknown): DiscoveredModel[] | null {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data as unknown[])
        : Array.isArray((json as { models?: unknown }).models)
          ? ((json as { models: unknown[] }).models as unknown[])
          : null
      : null;
  if (!list) return null;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= MAX_DISCOVERED_MODELS) break;
    const record =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : null;
    const rawId =
      typeof item === 'string'
        ? item
        : record
          ? [record.id, record.slug, record.model_id, record.model_name].find(
              (value): value is string => typeof value === 'string',
            )
          : undefined;
    const id = rawId?.trim();
    if (!id || !isValidModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const model: DiscoveredModel = { id };
    const name = [record?.display_name, record?.name].find(
      (value): value is string => typeof value === 'string' && !!value.trim(),
    );
    if (name && name.trim() !== id) model.name = name.trim();
    const contextWindow = record
      ? [
          record.context_length,
          record.context_window,
          record.max_context_length,
          record.max_input_tokens,
        ]
          .map(positiveInteger)
          .find((value) => value !== undefined)
      : undefined;
    if (contextWindow) model.contextWindow = contextWindow;
    if (record) {
      const declared = declaredEfforts(record);
      if (declared.efforts) model.efforts = declared.efforts;
      if (declared.defaultEffort) model.defaultEffort = declared.defaultEffort;
      // Only an explicit boolean counts; a reasoning object is efforts.
      if (typeof record.reasoning === 'boolean')
        model.thinks = record.reasoning;
      const topProvider =
        record.top_provider && typeof record.top_provider === 'object'
          ? (record.top_provider as Record<string, unknown>)
          : undefined;
      const maxOutputTokens = [
        record.max_output_tokens,
        record.max_completion_tokens,
        record.output_token_limit,
        record.outputTokenLimit,
        topProvider?.max_completion_tokens,
      ]
        .map(positiveInteger)
        .find((value) => value !== undefined);
      if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
      const magpieLabel =
        typeof record.magpie_label === 'string'
          ? record.magpie_label.trim()
          : undefined;
      if (magpieLabel !== undefined) model.magpieLabel = magpieLabel;
      const vendor = listedVendor(record, model.name ?? id, magpieLabel);
      if (vendor) model.vendor = vendor;
    }
    out.push(model);
  }
  return out;
}

/**
 * Who serves a listed model. magpie names it after the model in its label
 * (`GLM-5 · Relay A`, unless the user turned the suffix off) and, for another
 * magpie, in `magpie_by`; any list may say `owned_by` (a provider id).
 */
function listedVendor(
  record: Record<string, unknown>,
  name: string,
  magpieLabel: string | undefined,
): string | undefined {
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const prefix = `${name} · `;
  if (magpieLabel?.startsWith(prefix) && magpieLabel.length > prefix.length) {
    return magpieLabel.slice(prefix.length).trim();
  }
  return text(record.magpie_by) ?? text(record.owned_by);
}

/** `minimal` and `none` have no Claude Code level; `ultra` is Codex-only. */
function vendorEffort(value: unknown): ModelEffort | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? [
            (value as Record<string, unknown>).effort,
            (value as Record<string, unknown>).id,
            (value as Record<string, unknown>).value,
          ].find((item): item is string => typeof item === 'string')
        : undefined;
  const effort = raw?.trim().toLowerCase();
  return isModelEffort(effort) ? effort : undefined;
}

/**
 * The efforts a list entry declares, in the spellings vendors use
 * (adapted from cindy's modelDiscovery.ts): `reasoning.supported_efforts`,
 * `supported_efforts`, Codex and magpie `supported_reasoning_levels`,
 * magpie's flat `reasoning_levels`, Vercel `reasoning_options`, with
 * `default_effort` / `default_reasoning_level`. An empty list declares that
 * the model takes none; nothing is inferred from a list that does not
 * mention efforts.
 */
function declaredEfforts(record: Record<string, unknown>): {
  efforts?: ModelEffort[];
  defaultEffort?: ModelEffort;
} {
  const reasoning =
    record.reasoning && typeof record.reasoning === 'object'
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const list = [
    reasoning?.supported_efforts,
    record.supported_efforts,
    record.supported_reasoning_levels,
    record.reasoning_levels,
    record.reasoning_options,
  ].find(Array.isArray) as unknown[] | undefined;
  const efforts = normalizeEfforts(list?.map(vendorEffort));
  if (!efforts) return {};
  if (efforts.length === 0) return { efforts };
  const preferred = vendorEffort(
    reasoning?.default_effort ??
      record.default_effort ??
      record.default_reasoning_level,
  );
  return {
    efforts,
    ...(preferred && efforts.includes(preferred)
      ? { defaultEffort: preferred }
      : {}),
  };
}

// ─── Model capabilities ────────────────────────────────────────

/**
 * What a model can do, as far as the picker and the runtime care: its context
 * window and the reasoning efforts it takes. Adapted from cindy's model
 * registry (`catalog/model-registry.json` base models, Apache-2.0); only the
 * efforts Claude Code accepts are kept. Read through
 * `resolveModelCapabilities`, which adds a connection's own declarations and
 * family inference.
 */
export interface ModelCapabilities {
  id: string;
  name?: string;
  contextWindow?: number;
  efforts?: readonly ModelEffort[];
  defaultEffort?: ModelEffort;
}

interface ModelCapabilityEntry extends ModelCapabilities {
  aliases: readonly string[];
}

const MODEL_CAPABILITY_ENTRIES: readonly ModelCapabilityEntry[] = [
  {
    id: 'openai/gpt-6.1-sol',
    aliases: ['gpt-6.1-sol'],
    name: 'GPT-6.1 Sol',
    contextWindow: 1_050_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-6-sol',
    aliases: ['gpt-6-sol'],
    name: 'GPT-6 Sol',
    contextWindow: 1_050_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-6-luna',
    aliases: ['gpt-6-luna'],
    name: 'GPT-6 Luna',
    contextWindow: 1_050_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-5-5',
    aliases: ['claude-opus-5-5'],
    name: 'Opus 5.5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-sonnet-5-5',
    aliases: ['claude-sonnet-5-5'],
    name: 'Sonnet 5.5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-haiku-5-5',
    aliases: ['claude-haiku-5-5'],
    name: 'Haiku 5.5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-sol',
    aliases: [
      'codex/gpt-5.6-sol',
      'gpt-5.6-sol',
      'openai/gpt-5.6-sol[1m]',
      'xd/codex-gpt-5.6-sol',
      'xd/gpt-5.6-sol',
    ],
    name: 'GPT-5.6-Sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-terra',
    aliases: [
      'codex/gpt-5.6-terra',
      'gpt-5.6-terra',
      'xd/codex-gpt-5.6-terra',
      'xd/gpt-5.6-terra',
    ],
    name: 'GPT-5.6-Terra',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-luna',
    aliases: [
      'codex/gpt-5.6-luna',
      'gpt-5.6-luna',
      'xd/codex-gpt-5.6-luna',
      'xd/gpt-5.6-luna',
    ],
    name: 'GPT-5.6-Luna',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.5',
    aliases: ['codex/gpt-5.5', 'gpt-5.5', 'xd/codex-gpt-5.5', 'xd/gpt-5.5'],
    name: 'GPT-5.5',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.4',
    aliases: ['codex/gpt-5.4', 'gpt-5.4', 'xd/codex-gpt-5.4', 'xd/gpt-5.4'],
    name: 'GPT-5.4',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.4-mini',
    aliases: [
      'codex/gpt-5.4-mini',
      'gpt-5.4-mini',
      'xd/codex-gpt-5.4-mini',
      'xd/gpt-5.4-mini',
    ],
    name: 'GPT-5.4-Mini',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.4-pro',
    aliases: ['gpt-5.4-pro'],
    name: 'GPT-5.4 Pro',
    contextWindow: 1_050_000,
    efforts: ['medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.5-pro',
    aliases: ['gpt-5.5-pro'],
    name: 'GPT-5.5 Pro',
    contextWindow: 1_050_000,
    efforts: ['medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'openai/gpt-5.6-cyber',
    aliases: ['gpt-5.6-cyber'],
    name: 'GPT-5.6 Cyber',
    contextWindow: 400_000,
  },
  {
    id: 'openai/gpt-6-astra',
    aliases: ['gpt-6-astra'],
    name: 'GPT-6 Astra',
    contextWindow: 1_050_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-fable-5-1',
    aliases: ['claude-fable-5-1'],
    name: 'Fable 5.1',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-fable-5',
    aliases: ['claude-fable-5'],
    name: 'Fable 5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-mythos-5',
    aliases: ['claude-mythos-5'],
    name: 'Mythos 5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-5',
    aliases: ['claude-opus-5'],
    name: 'Opus 5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-4-8',
    aliases: ['claude-opus-4-8'],
    name: 'Opus 4.8',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-4-7',
    aliases: ['claude-opus-4-7'],
    name: 'Opus 4.7',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-4-6',
    aliases: ['claude-opus-4-6'],
    name: 'Opus 4.6',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-opus-4-5',
    aliases: ['claude-opus-4-5'],
    name: 'Opus 4.5',
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-sonnet-5',
    aliases: ['claude-sonnet-5'],
    name: 'Sonnet 5',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    aliases: ['claude-sonnet-4-6'],
    name: 'Sonnet 4.6',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    aliases: ['claude-sonnet-4-5'],
    name: 'Sonnet 4.5',
    contextWindow: 200_000,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    aliases: ['claude-haiku-4-5'],
    name: 'Haiku 4.5',
    contextWindow: 200_000,
  },
  {
    id: 'xai/grok-4.7',
    aliases: ['grok-4.7'],
    name: 'Grok 4.7',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'xai/grok-4.7-build-fast',
    aliases: ['grok-4.7-build-fast'],
    name: 'Grok 4.7 Fast',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'xai/grok-4.6',
    aliases: ['grok-4.6'],
    name: 'Grok 4.6',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'xai/grok-4.5',
    aliases: ['grok-4.5'],
    name: 'Grok 4.5',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'xai/grok-4.3',
    aliases: ['grok-4.3'],
    name: 'Grok 4.3',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'xai/grok-build-0.1',
    aliases: ['grok-build-0.1'],
    name: 'Grok Build 0.1',
    contextWindow: 256_000,
  },
  {
    id: 'xai/grok-4.20-multi-agent-0309',
    aliases: ['grok-4.20-multi-agent-0309'],
    name: 'Grok 4.20 Multi-Agent',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'xai/grok-4.20-0309-reasoning',
    aliases: ['grok-4.20-0309-reasoning'],
    name: 'Grok 4.20 Reasoning',
    contextWindow: 1_000_000,
  },
  {
    id: 'xai/grok-4.20-0309-non-reasoning',
    aliases: ['grok-4.20-0309-non-reasoning'],
    name: 'Grok 4.20 Non-Reasoning',
    contextWindow: 1_000_000,
  },
  {
    id: 'xai/grok-4.20',
    aliases: ['grok-4.20'],
    name: 'Grok 4.20 Legacy Alias',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'xai/grok-code-fast',
    aliases: ['grok-code-fast'],
    name: 'Grok Code Fast (Deprecated)',
    contextWindow: 256_000,
  },
  {
    id: 'google/gemini-4-argon',
    aliases: ['gemini-4-argon'],
    name: 'Gemini 4 Argon',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-4-carbon',
    aliases: ['gemini-4-carbon'],
    name: 'Gemini 4 Carbon',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-4-hydrogen',
    aliases: ['gemini-4-hydrogen'],
    name: 'Gemini 4 Hydrogen',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'google/gemini-4-neon',
    aliases: ['gemini-4-neon'],
    name: 'Gemini 4 Neon',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'google/gemini-3.7-flash',
    aliases: ['gemini-3.7-flash'],
    name: 'Gemini 3.7 Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3.6-flash',
    aliases: ['gemini-3.6-flash'],
    name: 'Gemini 3.6 Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3.5-flash',
    aliases: ['gemini-3.5-flash'],
    name: 'Gemini 3.5 Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    aliases: ['gemini-3.1-pro-preview'],
    name: 'Gemini 3.1 Pro',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3-flash-preview',
    aliases: ['gemini-3-flash-preview'],
    name: 'Gemini 3 Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    aliases: ['gemini-3.5-flash-lite'],
    name: 'Gemini 3.5 Flash-Lite',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    aliases: ['gemini-3.1-flash-lite'],
    name: 'Gemini 3.1 Flash-Lite',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'bytedance-seed/seed-2.1-pro',
    aliases: ['seed-2.1-pro'],
    name: 'Seed 2.1 Pro',
    contextWindow: 256_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'qwen/qwen3.8-max',
    aliases: ['qwen3.8-max'],
    name: 'Qwen 3.8 Max',
    contextWindow: 983_616,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'qwen/qwen3.8-max-preview',
    aliases: ['qwen3.8-max-preview'],
    name: 'Qwen 3.8 Max Preview',
    contextWindow: 983_616,
    efforts: ['low', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'qwen/qwen3.7-max',
    aliases: ['qwen3.7-max'],
    name: 'Qwen 3.7 Max',
    contextWindow: 992_000,
  },
  {
    id: 'moonshotai/kimi-k2.7-code',
    aliases: ['kimi-k2.7-code'],
    name: 'Kimi K2.7 Code',
    contextWindow: 262_144,
  },
  {
    id: 'moonshotai/kimi-k2.7-code-highspeed',
    aliases: ['kimi-k2.7-code-highspeed'],
    name: 'Kimi K2.7 Code Highspeed',
    contextWindow: 262_144,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    aliases: ['kimi-k2.6'],
    name: 'Kimi K2.6',
    contextWindow: 262_144,
  },
  {
    id: 'z-ai/glm-5.1',
    aliases: ['glm-5.1'],
    name: 'GLM-5.1',
    contextWindow: 200_000,
  },
  {
    id: 'z-ai/glm-5.2',
    aliases: ['glm-5.2'],
    name: 'GLM-5.2',
    contextWindow: 1_000_000,
    efforts: ['high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'z-ai/glm-5.3',
    aliases: ['glm-5.3'],
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    aliases: ['glm-5.3-flash'],
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'xd/z-ai-glm-5.3-flash',
    aliases: ['z-ai-glm-5.3-flash'],
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    aliases: ['deepseek-v4-pro'],
    name: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    aliases: ['deepseek-v4-flash'],
    name: 'DeepSeek V4 Flash',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'openai/gpt-5.4-nano',
    aliases: ['gpt-5.4-nano'],
    name: 'GPT-5.4-Nano',
    contextWindow: 400_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'minimax/minimax-m3',
    aliases: ['minimax-m3'],
    name: 'MiniMax M3',
    contextWindow: 1_000_000,
  },
  {
    id: 'minimax/minimax-m2.7',
    aliases: ['minimax-m2.7'],
    name: 'MiniMax M2.7',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2.7-highspeed',
    aliases: ['minimax-m2.7-highspeed'],
    name: 'MiniMax M2.7 Highspeed',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2.5',
    aliases: ['minimax-m2.5'],
    name: 'MiniMax M2.5',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2.5-highspeed',
    aliases: ['minimax-m2.5-highspeed'],
    name: 'MiniMax M2.5 Highspeed',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2.1',
    aliases: ['minimax-m2.1'],
    name: 'MiniMax M2.1',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2.1-highspeed',
    aliases: ['minimax-m2.1-highspeed'],
    name: 'MiniMax M2.1 Highspeed',
    contextWindow: 204_800,
  },
  {
    id: 'minimax/minimax-m2',
    aliases: ['minimax-m2'],
    name: 'MiniMax M2',
    contextWindow: 204_800,
  },
  {
    id: 'moonshotai/kimi-k2.8-preview',
    aliases: ['kimi-for-coding', 'kimi-k2.8-preview'],
    name: 'Kimi K2.8 Preview',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'moonshotai/kimi-k3',
    aliases: ['kimi-k3'],
    name: 'Kimi K3',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'qwen/qwen3.6-plus',
    aliases: ['qwen3.6-plus'],
    name: 'Qwen 3.6 Plus',
    contextWindow: 1_048_576,
  },
  {
    id: 'qwen/qwen3.6-plus-api',
    aliases: ['qwen3.6-plus', 'qwen3.6-plus-api'],
    name: 'Qwen 3.6 Plus API',
    contextWindow: 991_808,
  },
  {
    id: 'qwen/qwen3.7-flash',
    aliases: ['qwen3.7-flash'],
    name: 'Qwen 3.7 Flash',
    contextWindow: 991_808,
  },
  {
    id: 'qwen/qwen3.8-flash',
    aliases: ['qwen3.8-flash'],
    name: 'Qwen 3.8 Flash',
    contextWindow: 991_808,
    efforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'qwen/qwen3.7-plus',
    aliases: ['qwen3.7-plus'],
    name: 'Qwen 3.7 Plus',
    contextWindow: 991_808,
  },
  {
    id: 'qwen/qwen3.6-flash',
    aliases: ['qwen3.6-flash'],
    name: 'Qwen 3.6 Flash',
    contextWindow: 991_808,
  },
  {
    id: 'qwen/qwen3.8-27b',
    aliases: ['qwen3.8-27b'],
    name: 'Qwen3.8 27B',
    contextWindow: 991_808,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'tencent/hy3',
    aliases: ['hy3'],
    name: 'Hy3',
    contextWindow: 262_144,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'xd/moonshotai-kimi-k3',
    aliases: ['moonshot/kimi-k3', 'moonshotai-kimi-k3'],
    name: 'Kimi K3',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'moonshotai/kimi-k3.1-pro',
    aliases: ['k3.1-pro', 'kimi-k3.1-pro'],
    name: 'Kimi K3.1 Pro',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'moonshotai/kimi-k3.1-pro-highspeed',
    aliases: ['k3.1-pro-highspeed', 'kimi-k3.1-pro-highspeed'],
    name: 'Kimi K3.1 Pro Highspeed',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'minimax/minimax-m3.1-flash',
    aliases: ['minimax-m3.1-flash'],
    name: 'MiniMax M3.1 Flash',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    aliases: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash'],
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'qwen/qwen3.8-flash-next',
    aliases: ['qwen3.8-flash-next'],
    name: 'Qwen3.8 Flash-Next',
    efforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'xiaomi/mimo-v2.6-pro',
    aliases: ['mimo-v2.6-pro'],
    name: 'MiMo V2.6 Pro',
    contextWindow: 1_000_000,
  },
  {
    id: 'xiaomi/mimo-v2.6-flash',
    aliases: ['mimo-v2.6-flash'],
    name: 'MiMo V2.6 Flash',
    contextWindow: 1_000_000,
  },
  {
    id: 'xiaomi/mimo-v2.6-pro-ultraspeed',
    aliases: ['mimo-v2.6-pro-ultraspeed'],
    name: 'MiMo V2.6 Pro UltraSpeed',
    contextWindow: 1_000_000,
  },
  {
    id: 'meta/muse-wonder-1.0',
    aliases: ['muse-wonder-1.0'],
    name: 'Muse Wonder',
    contextWindow: 1_048_576,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
];

/**
 * Claude Code's own model aliases, as an official connection stores them.
 * `default` lets Claude Code pick; every current Claude model takes the same
 * efforts and window, so it reads like Opus.
 */
const CLAUDE_CODE_ALIASES: Record<string, string> = {
  default: 'claude-opus-5-5',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

let capabilityIndex: Map<string, ModelCapabilityEntry> | null = null;

function capabilityLookup(): Map<string, ModelCapabilityEntry> {
  if (capabilityIndex) return capabilityIndex;
  const index = new Map<string, ModelCapabilityEntry>();
  for (const entry of MODEL_CAPABILITY_ENTRIES) {
    for (const key of [entry.id.toLowerCase(), ...entry.aliases]) {
      // The first entry wins: cindy lists a model before its older aliases.
      if (!index.has(key)) index.set(key, entry);
    }
  }
  capabilityIndex = index;
  return index;
}

/**
 * The capabilities of a model id as a connection stores it: `[1m]` and case
 * are ignored, a vendor prefix (`z-ai/glm-5.2` on OpenRouter) is tried with
 * and without, and Claude Code aliases resolve to the model they stand for.
 * A `[1m]` id always has the 1M window. Null when the model is unknown.
 */
export function modelCapabilities(id: string): ModelCapabilities | null {
  const { model, oneMillion } = splitOneMillionSuffix(id);
  const key = model.toLowerCase();
  if (!key) return null;
  const index = capabilityLookup();
  const found =
    index.get(CLAUDE_CODE_ALIASES[key] ?? key) ??
    (key.includes('/')
      ? index.get(key.slice(key.lastIndexOf('/') + 1))
      : undefined);
  if (!found) {
    return oneMillion
      ? { id: model, contextWindow: ONE_MILLION_CONTEXT }
      : null;
  }
  const { aliases: _aliases, ...capabilities } = found;
  return oneMillion
    ? {
        ...capabilities,
        contextWindow: Math.max(
          capabilities.contextWindow ?? 0,
          ONE_MILLION_CONTEXT,
        ),
      }
    : capabilities;
}

/**
 * The registry entry a model id not in the registry borrows from, following
 * cindy's generation inheritance: for GPT and Gemini a sibling of the same
 * generation (`gpt-6.1-terra` → `gpt-6.1-sol`, `gemini-4-helium` →
 * `gemini-4-argon`), else the same variant of the newest older generation
 * (`gpt-6.1-terra` → `gpt-5.6-terra`, `gemini-3.8-flash` → `gemini-3.7-flash`);
 * for Claude only the same variant of an older generation. Only efforts are
 * inferred.
 */
const familyCache = new Map<string, ModelCapabilities | null>();

const GEMINI_FAMILY_RE =
  /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-lite)?)(?:-preview)?$/;

function inferredFamilyCapabilities(id: string): ModelCapabilities | null {
  const { model } = splitOneMillionSuffix(id);
  if (!familyCache.has(model)) {
    // Bounded: a picker lists at most a few hundred distinct ids.
    if (familyCache.size > 2000) familyCache.clear();
    familyCache.set(model, computeFamilyCapabilities(model));
  }
  return familyCache.get(model) ?? null;
}

function computeFamilyCapabilities(model: string): ModelCapabilities | null {
  const key = model.toLowerCase();
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(bare);
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(bare);
  const gemini = GEMINI_FAMILY_RE.exec(bare);
  const unique = [...new Set(capabilityLookup().values())];
  const version = (value: string) =>
    value.split(/[.-]/).map((part) => Number(part));
  const newer = (a: string, b: string) => {
    const left = version(a);
    const right = version(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  };
  const pick = (
    parse: (entryKey: string) => { version: string; variant: string } | null,
    wanted: { version: string; variant: string },
    allowSibling: boolean,
  ): ModelCapabilityEntry | undefined => {
    const parsed = unique
      .map((entry) => {
        const entryKey = entry.id.toLowerCase();
        const name = entryKey.slice(entryKey.lastIndexOf('/') + 1);
        const info = parse(name);
        return info ? { entry, ...info } : null;
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const sibling = allowSibling
      ? parsed.find((item) => item.version === wanted.version)
      : undefined;
    if (sibling) return sibling.entry;
    return parsed
      .filter(
        (item) =>
          item.variant === wanted.variant &&
          newer(item.version, wanted.version) < 0,
      )
      .sort((a, b) => newer(b.version, a.version))[0]?.entry;
  };
  let found: ModelCapabilityEntry | undefined;
  if (gpt) {
    found = pick(
      (name) => {
        const m = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(name);
        return m ? { version: m[1], variant: m[2] } : null;
      },
      { version: gpt[1], variant: gpt[2] },
      // GPT generations ship every variant with the same efforts.
      true,
    );
  } else if (claude) {
    found = pick(
      (name) => {
        const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(name);
        return m ? { version: m[2], variant: m[1] } : null;
      },
      { version: claude[2], variant: claude[1] },
      // Claude variants differ (haiku takes fewer efforts than opus).
      false,
    );
  } else if (gemini) {
    found = pick(
      (name) => {
        const m = GEMINI_FAMILY_RE.exec(name);
        return m ? { version: m[1], variant: m[2] } : null;
      },
      { version: gemini[1], variant: gemini[2] },
      // Same-generation Gemini siblings share at least the conservative base
      // efforts (argon is listed first for Gemini 4: low/medium/high).
      true,
    );
  }
  if (!found) return null;
  // Only efforts are borrowed: a window decides `[1m]`, so it is never guessed.
  return {
    id: model,
    ...(found.efforts ? { efforts: found.efforts } : {}),
    ...(found.defaultEffort ? { defaultEffort: found.defaultEffort } : {}),
  };
}

/** cindy's order for a model that names no default effort. */
const DEFAULT_EFFORT_PREFERENCE: readonly ModelEffort[] = [
  'medium',
  'high',
  'low',
  'xhigh',
  'max',
];

/** The effort a model with these efforts runs at when nothing is picked. */
export function defaultEffortFor(
  efforts: readonly ModelEffort[],
  preferred?: ModelEffort | null,
): ModelEffort | null {
  if (preferred && efforts.includes(preferred)) return preferred;
  return DEFAULT_EFFORT_PREFERENCE.find((e) => efforts.includes(e)) ?? null;
}

/**
 * Where a model's efforts come from: the user or the vendor declared them
 * (an empty declaration included), the registry knows the model, they are
 * borrowed from its family, or nothing is known (`none`: unknown, not
 * "takes none"). Only `registry` counts as verified in the UI.
 */
export type ModelCapabilitySource = 'declared' | 'registry' | 'family' | 'none';

export interface ResolvedModelCapabilities {
  /** The window launches use: declared on the entry, or null (unknown). */
  contextWindow: number | null;
  /** What the registry knows, offered as the add flow's starting value. */
  suggestedContextWindow: number | null;
  /**
   * The efforts known to work. Empty either because the model is declared
   * to take none (`effortsSource: 'declared'`) or because nothing is known
   * (`effortsSource: 'none'`), in which case any effort may be tried.
   */
  efforts: ModelEffort[];
  defaultEffort: ModelEffort | null;
  effortsSource: ModelCapabilitySource;
  contextSource: ModelCapabilitySource;
  /**
   * The model takes no effort and is declared not to reason
   * (`thinks: false`): a launch turns Claude Code's thinking off.
   */
  thinkingDisabled: boolean;
}

/**
 * Everything the picker and the launch need to know about one model of a
 * connection. Efforts: the entry's own (an empty list too), else the
 * registry's, else the family's. The window is the entry's own only (see
 * windowOf). A model nothing is known about has no default effort and no
 * window, and the launch injects neither.
 */
export function resolveModelCapabilities(
  entry: ProviderModelEntry,
): ResolvedModelCapabilities {
  const registry = modelCapabilities(entry.id);
  const family = registry?.efforts
    ? null
    : inferredFamilyCapabilities(entry.id);
  const declared = Array.isArray(entry.efforts);
  const effortsSource: ModelCapabilitySource = declared
    ? 'declared'
    : registry?.efforts?.length
      ? 'registry'
      : family?.efforts?.length
        ? 'family'
        : 'none';
  const efforts = [
    ...(declared
      ? entry.efforts!
      : (registry?.efforts ?? family?.efforts ?? [])),
  ];
  const contextSource: ModelCapabilitySource = entry.contextWindow
    ? 'declared'
    : 'none';
  const contextWindow = entry.contextWindow ?? null;
  return {
    contextWindow,
    suggestedContextWindow: registry?.contextWindow ?? null,
    efforts,
    defaultEffort: defaultEffortFor(
      efforts,
      entry.defaultEffort ?? registry?.defaultEffort ?? family?.defaultEffort,
    ),
    effortsSource,
    contextSource,
    thinkingDisabled:
      declared && efforts.length === 0 && entry.thinks === false,
  };
}

const PINNED_EFFORT_SUFFIX_RE = /^(.+)-(low|medium|high|xhigh)$/i;

/**
 * When a relay encodes a fixed effort into a model id (e.g.
 * `gemini-4-neon-high`), returns the base model's resolved capabilities and
 * the pinned effort — only when the base model is known (registry or family)
 * and accepts that effort. `-max` is excluded because vendors use it as a
 * model tier name (e.g. `qwen3.8-max`, `kimi-k3-max`).
 */
export function effortSuffixedBaseModel(id: string): {
  baseId: string;
  effort: ModelEffort;
  capabilities: ResolvedModelCapabilities;
} | null {
  const { model } = splitOneMillionSuffix(id);
  const match = PINNED_EFFORT_SUFFIX_RE.exec(model);
  if (!match) return null;
  const baseId = match[1];
  const effort = match[2].toLowerCase() as ModelEffort;
  const capabilities = resolveModelCapabilities({ id: baseId });
  if (
    capabilities.effortsSource === 'none' ||
    !capabilities.efforts.includes(effort)
  ) {
    return null;
  }
  return { baseId, effort, capabilities };
}

// ─── magpie quotas ─────────────────────────────────────────────

/** One usage window of a magpie account (`GET /v1/magpie/quotas`). */
export interface MagpieQuotaWindow {
  name: string;
  /** Percent used, when magpie says. */
  used: number | null;
  /** Percent left; 0 or less is used up. */
  remaining: number | null;
  /** ISO time the window renews, when known. */
  resetsAt: string | null;
  unlimited: boolean;
}

/** One account magpie routes to, with its windows. */
export interface MagpieQuotaAccount {
  /** magpie's provider id: the `<provider>/` of the models it serves. */
  provider: string;
  name: string;
  kind: 'subscription' | 'plan' | 'balance' | 'other';
  plan: string | null;
  user: string | null;
  windows: MagpieQuotaWindow[];
  readAt: string | null;
  /** Why magpie could not read this account's usage. */
  error: string | null;
}

/** What the usage route answers for a magpie connection. */
export interface MagpieQuotasUsage {
  kind: 'magpie_quotas';
  accounts: MagpieQuotaAccount[];
  /** Epoch ms of the read. */
  fetchedAt: number;
  /** Why the read failed; the accounts are then empty. */
  error: string | null;
}

const MAX_MAGPIE_QUOTA_ACCOUNTS = 200;
const MAX_MAGPIE_QUOTA_WINDOWS = 20;

function finitePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function quotaText(value: unknown, max = 200): string | null {
  return normalizeLabel(value, max) ?? null;
}

/**
 * Reads magpie's `/v1/magpie/quotas` answer
 * (`{object: "list", data: [{provider, name, kind, plan, user, windows,
 * readAt, error?}]}`), keeping only well-formed fields. Null when the body
 * is not that list.
 */
export function parseMagpieQuotas(json: unknown): MagpieQuotaAccount[] | null {
  const data =
    json && typeof json === 'object'
      ? (json as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return null;
  const accounts: MagpieQuotaAccount[] = [];
  for (const raw of data.slice(0, MAX_MAGPIE_QUOTA_ACCOUNTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const provider = quotaText(record.provider, MAX_MODEL_VENDOR_LENGTH);
    if (!provider) continue;
    const windows: MagpieQuotaWindow[] = [];
    if (Array.isArray(record.windows)) {
      for (const item of record.windows.slice(0, MAX_MAGPIE_QUOTA_WINDOWS)) {
        if (!item || typeof item !== 'object') continue;
        const window = item as Record<string, unknown>;
        const resetsAt = normalizeIsoTime(window.resetsAt) ?? null;
        windows.push({
          name: quotaText(window.name, 100) ?? '',
          used: finitePercent(window.used),
          remaining: finitePercent(window.remaining),
          resetsAt,
          unlimited: window.unlimited === true,
        });
      }
    }
    const kind =
      record.kind === 'subscription' ||
      record.kind === 'plan' ||
      record.kind === 'balance'
        ? record.kind
        : 'other';
    accounts.push({
      provider,
      name: quotaText(record.name) ?? provider,
      kind,
      plan: quotaText(record.plan),
      user: quotaText(record.user),
      windows,
      readAt: normalizeIsoTime(record.readAt) ?? null,
      error: quotaText(record.error, 300),
    });
  }
  return accounts;
}

/**
 * When a model magpie refused for its usage limit may run again. An account
 * of the provider the model id names (`<provider>/<model>`) serves again once
 * every used-up window (remaining ≤ 0) of it has renewed, so it counts by its
 * latest renewal; the model runs again on the account that comes back first.
 * Null when that cannot be told without guessing: a routing group
 * (`group/…`) or `auto/…` model, an id without a provider, or no account
 * whose used-up windows all name a renewal time.
 */
export function magpieUsageLimitResetAt(
  accounts: readonly MagpieQuotaAccount[],
  model: string,
): number | null {
  const id = splitOneMillionSuffix(model).model;
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  const provider = id.slice(0, slash).toLowerCase();
  if (provider === 'group' || provider === 'auto') return null;
  let earliest: number | null = null;
  for (const account of accounts) {
    if (account.provider.toLowerCase() !== provider || account.error) continue;
    let latest: number | null = null;
    let untold = false;
    for (const window of account.windows) {
      if (window.unlimited || window.remaining === null) continue;
      if (window.remaining > 0) continue;
      const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (!Number.isFinite(at)) {
        // A spent window with no renewal: when this account returns is unknown.
        untold = true;
        break;
      }
      if (latest === null || at > latest) latest = at;
    }
    if (untold || latest === null) continue;
    if (earliest === null || latest < earliest) earliest = latest;
  }
  return earliest;
}

/** magpie's wording for a refusal over a usage limit (fallback.go). */
const MAGPIE_USAGE_LIMIT_RE = /\busage limit reached\b/i;

export function isMagpieUsageLimitMessage(
  text: string | null | undefined,
): boolean {
  return !!text && MAGPIE_USAGE_LIMIT_RE.test(text);
}

// ─── Upstream errors ───────────────────────────────────────────

export const PROVIDER_ERROR_CODES = [
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'MODEL_NOT_FOUND',
  'ENDPOINT_NOT_FOUND',
  'CONTEXT_TOO_LONG',
  'WIRE_INCOMPATIBLE',
  'UPSTREAM_ERROR',
  'UPSTREAM_UNREACHABLE',
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorInput {
  /** HTTP status; absent when the request never got an answer. */
  status?: number;
  /** The error body; only the first few KB are read. */
  bodyText?: string;
  /** A network error code (ECONNREFUSED, ENOTFOUND, TimeoutError, ...). */
  networkErrorCode?: string;
}

export interface ProviderErrorClassification {
  code: ProviderErrorCode;
  /** Whether trying the same request again later may succeed. */
  retryable: boolean;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ABORT_ERR',
  'TimeoutError',
  'AbortError',
]);

const MODEL_NOT_FOUND_RE =
  /model[^\n]{0,80}(not.{0,4}(found|exist)|does not exist|invalid|unknown|unsupported)|model_not_found|invalid model|模型不存在/i;
const CONTEXT_TOO_LONG_RE =
  /prompt is too long|maximum (?:context|prompt) length|context.{0,20}(length|window).{0,40}(exceed|too)|context_length_exceeded|(?:令牌|token)数.{0,6}超(?:出|过)|超出.{0,6}上下文/i;
const WIRE_RE =
  /(unknown|unexpected|unsupported|extra|unrecognized).{0,16}(field|parameter|argument|inputs?|property|request param)|extra inputs are not permitted|invalid_request_error[^\n]{0,120}(field|param)/i;
// A bad credential, said outright. Not a bare 「令牌」 or "token": gateways
// say 令牌 for a valid key that may not use a model, and max_tokens errors
// contain "invalid ... token".
const AUTH_RE =
  /\binvalid[\s:'"_-]{0,3}(?:(?:x-)?api[\s_-]?key|(?:access|auth|authentication|bearer)?[\s_-]?token)\b|authentication_error|\bunauthorized\b|api key not valid|incorrect api key|(?:令牌|密钥)(?:无效|已过期|不存在|错误)|无效的?(?:令牌|密钥)|鉴权失败|认证失败/i;
const QUOTA_RE =
  /insufficient.{0,20}(balance|quota|credit|funds)|credit balance is too low|quota.{0,20}exceed|exceed.{0,20}quota|余额不足|额度.{0,6}(?:不足|用尽|耗尽|用完)|欠费/i;

/**
 * Classifies one failed upstream request. Network errors decide first, then
 * the status, then the wording of the body. An unknown network error stays
 * UNKNOWN rather than sending the user off to check their network.
 */
export function classifyProviderError(
  input: ProviderErrorInput,
): ProviderErrorClassification {
  const { status, networkErrorCode } = input;
  const body = (input.bodyText ?? '').slice(0, 4096);

  if (networkErrorCode) {
    if (TIMEOUT_CODES.has(networkErrorCode)) {
      return { code: 'TIMEOUT', retryable: true };
    }
    if (UNREACHABLE_CODES.has(networkErrorCode)) {
      return { code: 'UPSTREAM_UNREACHABLE', retryable: true };
    }
    return { code: 'UNKNOWN', retryable: false };
  }
  if (status === undefined) return { code: 'UNKNOWN', retryable: false };

  if (status === 401) {
    // Some gateways answer an exhausted key's quota with 401.
    return {
      code: QUOTA_RE.test(body) ? 'QUOTA_EXCEEDED' : 'AUTH_INVALID',
      retryable: false,
    };
  }
  if (status === 402) return { code: 'QUOTA_EXCEEDED', retryable: false };
  if (status === 403) {
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    return {
      code: AUTH_RE.test(body) ? 'AUTH_INVALID' : 'AUTH_FORBIDDEN',
      retryable: false,
    };
  }
  if (status === 429 || status === 529) {
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (status === 404) {
    return {
      code: MODEL_NOT_FOUND_RE.test(body)
        ? 'MODEL_NOT_FOUND'
        : 'ENDPOINT_NOT_FOUND',
      retryable: false,
    };
  }
  if (status === 400 || status === 422) {
    if (MODEL_NOT_FOUND_RE.test(body)) {
      return { code: 'MODEL_NOT_FOUND', retryable: false };
    }
    if (CONTEXT_TOO_LONG_RE.test(body)) {
      return { code: 'CONTEXT_TOO_LONG', retryable: false };
    }
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    if (AUTH_RE.test(body)) return { code: 'AUTH_INVALID', retryable: false };
    if (WIRE_RE.test(body)) {
      return { code: 'WIRE_INCOMPATIBLE', retryable: false };
    }
    return { code: 'UNKNOWN', retryable: false };
  }
  if (status >= 500) return { code: 'UPSTREAM_ERROR', retryable: true };
  return { code: 'UNKNOWN', retryable: false };
}

/** What a user is told about each failure: a title and the next step. */
export const PROVIDER_ERROR_COPY: Record<
  ProviderErrorCode,
  { title: string; hint: string }
> = {
  AUTH_INVALID: {
    title: '密钥无效',
    hint: '检查 API Key 是否完整、未过期，并确认它属于这家服务商。',
  },
  AUTH_FORBIDDEN: {
    title: '没有访问权限',
    hint: '密钥有效，但账号没有开通这个模型或地区。到服务商控制台确认套餐和模型权限。',
  },
  RATE_LIMITED: {
    title: '请求过于频繁',
    hint: '服务商正在限流或过载，稍后再试。',
  },
  QUOTA_EXCEEDED: {
    title: '余额或额度不足',
    hint: '到服务商控制台充值，或查看套餐额度是否用完。',
  },
  MODEL_NOT_FOUND: {
    title: '模型不存在',
    hint: '服务商不认识这个模型名。换一个模型，或重新获取模型列表。',
  },
  ENDPOINT_NOT_FOUND: {
    title: '地址不对',
    hint: '这个地址上没有 Anthropic 兼容接口。核对地址，它通常不以 /v1 结尾。',
  },
  CONTEXT_TOO_LONG: {
    title: '上下文超长',
    hint: '请求超过了模型的上下文上限。',
  },
  WIRE_INCOMPATIBLE: {
    title: '接口不兼容',
    hint: '这个地址不完全兼容 Anthropic Messages 协议，Claude Code 可能无法正常工作。',
  },
  UPSTREAM_ERROR: {
    title: '服务商出错',
    hint: '服务商返回了服务器错误，稍后再试。',
  },
  UPSTREAM_UNREACHABLE: {
    title: '连不上服务商',
    hint: '无法连接这个地址。检查地址拼写，以及服务器能否访问外网。',
  },
  TIMEOUT: {
    title: '连接超时',
    hint: '服务商没有在限定时间内响应，稍后再试。',
  },
  UNKNOWN: {
    title: '未知错误',
    hint: '展开原始信息查看服务商返回的内容。',
  },
};
