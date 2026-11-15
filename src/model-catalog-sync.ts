/**
 * Keeping a gateway connection's model list in step with the gateway.
 *
 * Every third-party connection is checked once for a gateway: its model list
 * says magpie when its rows carry `magpie_label`. A magpie connection's list
 * is then synced every few hours and whenever its detail opens: what the
 * gateway says about a listed model (name, reply limit, vendor) is always
 * taken, its window and efforts only while the admin has not changed them,
 * a model the gateway stopped listing is marked and kept, and new models
 * are only noted unless the connection adds them by itself.
 *
 * A sync changes model metadata only. Like an edit of a model's window or
 * efforts, it stops no runner and clears no session: the next launch reads
 * the list as it is.
 */
import { logger } from './logger.js';
import { discoverEndpointModels } from './provider-connectivity.js';
import {
  discoveredModelEntry,
  effectiveProviderModels,
  findPresetsByBaseUrl,
  getModelPreset,
  MAX_PROVIDER_MODELS,
  MODEL_EFFORTS,
  modelsUrlFor,
  type DiscoveredModel,
  type ModelEffort,
  type ProviderErrorCode,
  type ProviderGateway,
  type ProviderModelEntry,
} from './model-providers.js';
import {
  getProviderById,
  getProviders,
  isCodexGatewayProvider,
  providerHasCredentials,
  providerToolSearchEnabled,
  recordProviderCatalog,
  type ProviderAuthMode,
  type ProviderCatalogState,
  type UnifiedProvider,
} from './runtime-config.js';

export const CATALOG_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The first scheduled pass waits for startup to settle. */
const CATALOG_SYNC_STARTUP_DELAY_MS = 2 * 60 * 1000;
/** How often the schedule looks for connections that are due. */
const CATALOG_SYNC_TICK_MS = 15 * 60 * 1000;
/** A detail opened again this soon reads what the last sync found. */
const CATALOG_SYNC_RECENT_MS = 60 * 1000;
const CATALOG_BACKOFF_BASE_MS = 15 * 60 * 1000;
const CATALOG_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** Upstream ids remembered to tell a new model from a known one. */
const MAX_KNOWN_IDS = 500;

// ─── The list merge ───────────────────────────────────────────

export interface CatalogMerge {
  models: ProviderModelEntry[];
  /** Upstream models that appeared and joined the list by themselves. */
  added: string[];
  /** Upstream models the list does not have, still to be picked. */
  newModels: ProviderModelEntry[];
  /** Listed models the gateway no longer offers. */
  missing: string[];
  /** Every id the gateway listed this time. */
  knownIds: string[];
}

function sameEfforts(
  a: readonly ModelEffort[] | undefined,
  b: readonly ModelEffort[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((effort, i) => effort === b[i]);
}

/** A field the sync owns outright: the gateway's value, or none. */
function mirror<K extends keyof ProviderModelEntry>(
  entry: ProviderModelEntry,
  key: K,
  value: ProviderModelEntry[K] | undefined,
): void {
  if (value === undefined) delete entry[key];
  else entry[key] = value;
}

/**
 * Merge what the gateway lists now into a connection's model list. A
 * listed model takes the gateway's name, reply limit and vendor; its window
 * and efforts only while they are unset or still what the last sync wrote
 * (`synced`), so an admin's own value stays. A listed model the gateway
 * dropped is marked with the time it was first found gone. Models that
 * appeared since the last sync are new: with `autoAdd` they join the list
 * while there is room, otherwise they wait in `newModels`, with those still
 * waiting from before. Pure; `previous` is the connection's catalog state.
 */
export function mergeCatalogModels(input: {
  models: readonly ProviderModelEntry[];
  discovered: readonly DiscoveredModel[];
  previous: ProviderCatalogState | undefined;
  autoAdd: boolean;
  now: string;
}): CatalogMerge {
  const upstream = new Map<string, ProviderModelEntry>();
  for (const item of input.discovered) {
    const entry = discoveredModelEntry(item);
    if (entry && !upstream.has(entry.id)) upstream.set(entry.id, entry);
  }
  const missing: string[] = [];
  const models = input.models.map((current) => {
    const found = upstream.get(current.id);
    const next: ProviderModelEntry = { ...current };
    if (!found) {
      next.upstreamMissingSince = current.upstreamMissingSince ?? input.now;
      missing.push(current.id);
      return next;
    }
    delete next.upstreamMissingSince;
    mirror(next, 'displayName', found.displayName);
    mirror(next, 'maxOutputTokens', found.maxOutputTokens);
    mirror(next, 'vendor', found.vendor);
    mirror(next, 'thinks', found.thinks);
    const synced = current.synced ?? {};
    if (
      current.contextWindow === undefined ||
      current.contextWindow === synced.contextWindow
    ) {
      mirror(next, 'contextWindow', found.contextWindow);
    }
    if (
      current.efforts === undefined ||
      sameEfforts(current.efforts, synced.efforts) ||
      // Never synced: every effort is what the add wizard fills in, unverified,
      // for a model it knows nothing about (an earlier release read magpie's
      // empty levels as unknown), not an admin's choice.
      (current.synced === undefined &&
        sameEfforts(current.efforts, MODEL_EFFORTS))
    ) {
      mirror(next, 'efforts', found.efforts);
      if (next.defaultEffort && !next.efforts?.includes(next.defaultEffort)) {
        delete next.defaultEffort;
      }
    }
    const record: NonNullable<ProviderModelEntry['synced']> = {
      ...(found.contextWindow ? { contextWindow: found.contextWindow } : {}),
      ...(found.efforts ? { efforts: found.efforts } : {}),
    };
    if (Object.keys(record).length > 0) next.synced = record;
    else delete next.synced;
    return next;
  });

  const listed = new Set(models.map((entry) => entry.id));
  const known = new Set(input.previous?.knownIds ?? []);
  // The first sync of a connection learns the list; nothing on it is new.
  const firstSync = input.previous?.knownIds === undefined;
  const waiting = new Set(
    (input.previous?.newModels ?? []).map((entry) => entry.id),
  );
  const added: string[] = [];
  const newModels: ProviderModelEntry[] = [];
  for (const entry of upstream.values()) {
    if (listed.has(entry.id)) continue;
    const appeared = !firstSync && !known.has(entry.id);
    if (!appeared && !waiting.has(entry.id)) continue;
    const synced = {
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.efforts ? { efforts: entry.efforts } : {}),
    };
    const withSync =
      Object.keys(synced).length > 0 ? { ...entry, synced } : entry;
    if (input.autoAdd && appeared && models.length < MAX_PROVIDER_MODELS) {
      models.push(withSync);
      listed.add(entry.id);
      added.push(entry.id);
    } else {
      newModels.push(withSync);
    }
  }
  return {
    models,
    added,
    newModels,
    missing,
    knownIds: [...upstream.keys()].slice(0, MAX_KNOWN_IDS),
  };
}

// ─── Reading a saved connection's list ────────────────────────

/** How a saved third-party connection reaches its endpoint, as it runs. */
export interface StoredConnectionAccess {
  baseUrl: string;
  credential: string;
  authMode: ProviderAuthMode;
  explicitAuthMode: boolean;
  customHeaders?: string;
}

/**
 * The endpoint, key and header a saved third-party connection's runner
 * uses: an explicit header style, else the one the runtime infers (a key
 * stored as an API key, or a bare token behind a custom endpoint, goes as
 * x-api-key; `Bearer …` as Authorization). Null when it cannot be reached.
 */
export function storedConnectionAccess(
  provider: UnifiedProvider,
): StoredConnectionAccess | null {
  if (provider.type !== 'third_party' || isCodexGatewayProvider(provider)) {
    return null;
  }
  const credential = provider.anthropicAuthToken || provider.anthropicApiKey;
  if (!provider.anthropicBaseUrl || !credential) return null;
  const apiKeyOnly = !provider.anthropicAuthToken && !!provider.anthropicApiKey;
  const explicit =
    provider.anthropicAuthMode ?? (apiKeyOnly ? 'x-api-key' : undefined);
  return {
    baseUrl: provider.anthropicBaseUrl,
    credential,
    authMode:
      explicit ?? (/^Bearer\s/i.test(credential) ? 'bearer' : 'x-api-key'),
    explicitAuthMode: !!explicit,
    customHeaders: provider.customEnv.ANTHROPIC_CUSTOM_HEADERS,
  };
}

/** Where a saved connection's models are listed (see modelsUrlFor). */
function storedModelsUrl(provider: UnifiedProvider): string {
  const named = getModelPreset(provider.presetId);
  const matches = findPresetsByBaseUrl(provider.anthropicBaseUrl);
  return modelsUrlFor(
    provider.anthropicBaseUrl,
    named ?? (matches.length === 1 ? matches[0] : null),
  );
}

// ─── Syncing one connection ───────────────────────────────────

export type CatalogSyncResult =
  | {
      ok: true;
      gateway: ProviderGateway | null;
      added: string[];
      newModels: string[];
      missing: string[];
      /** Nothing was read: synced moments ago, or a checked non-gateway. */
      skipped?: 'recent' | 'checked';
    }
  | { ok: false; code: ProviderErrorCode; message: string };

interface SyncOptions {
  now?: number;
}

/** Runners of a connection retire after their turn when its tool search flips. */
let toolSearchChangeListener: ((providerId: string) => void) | null = null;

export function setCatalogToolSearchChangeListener(
  listener: ((providerId: string) => void) | null,
): void {
  toolSearchChangeListener = listener;
}

function backoffMs(failures: number): number {
  return Math.min(
    CATALOG_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    CATALOG_BACKOFF_MAX_MS,
  );
}

/** Keep the outcome and tell runners when the gateway's default flipped. */
function commit(
  provider: UnifiedProvider,
  update: Parameters<typeof recordProviderCatalog>[2],
): UnifiedProvider | null {
  const before = providerToolSearchEnabled(provider);
  const stored = recordProviderCatalog(provider.id, provider, update);
  if (stored && providerToolSearchEnabled(stored) !== before) {
    toolSearchChangeListener?.(provider.id);
  }
  return stored;
}

/**
 * Record a model list read for a saved connection elsewhere (the model
 * discovery route): a magpie list marks the connection, any successful read
 * counts as its gateway check. The list itself is not merged here.
 */
export function noteConnectionModelList(
  provider: UnifiedProvider,
  gateway: ProviderGateway | null,
  now = Date.now(),
): void {
  if (!storedConnectionAccess(provider)) return;
  const newlyMarked = gateway === 'magpie' && provider.gateway !== 'magpie';
  if (!newlyMarked && provider.catalog?.checkedAt) return;
  commit(provider, {
    ...(newlyMarked ? { gateway } : {}),
    catalog: {
      ...(provider.catalog ?? {}),
      checkedAt: new Date(now).toISOString(),
    },
  });
}

/**
 * Check a saved connection for a gateway and, for magpie, sync its list,
 * now: the schedule decides when (catalogSyncDue), an opened detail asks
 * itself. Never throws: a failure is recorded with a backoff for the
 * schedule.
 */
export async function syncProviderCatalog(
  providerId: string,
  options: SyncOptions = {},
): Promise<CatalogSyncResult> {
  const provider = getProviderById(providerId);
  const access = provider ? storedConnectionAccess(provider) : null;
  if (!provider || !access) {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: '这个连接没有可同步的模型列表',
    };
  }
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const catalog = provider.catalog ?? {};
  if (provider.gateway !== 'magpie' && catalog.checkedAt) {
    return {
      ok: true,
      gateway: null,
      added: [],
      newModels: [],
      missing: [],
      skipped: 'checked',
    };
  }
  if (
    provider.gateway === 'magpie' &&
    catalog.syncedAt &&
    now - Date.parse(catalog.syncedAt) < CATALOG_SYNC_RECENT_MS
  ) {
    return {
      ok: true,
      gateway: 'magpie',
      added: [],
      newModels: (catalog.newModels ?? []).map((entry) => entry.id),
      missing: (provider.models ?? [])
        .filter((entry) => entry.upstreamMissingSince)
        .map((entry) => entry.id),
      skipped: 'recent',
    };
  }
  const url = storedModelsUrl(provider);
  const result = url
    ? await discoverEndpointModels({
        url,
        credential: access.credential,
        authMode: access.authMode,
        explicitAuthMode: access.explicitAuthMode,
        customHeaders: access.customHeaders,
      })
    : ({
        ok: false,
        code: 'ENDPOINT_NOT_FOUND',
        status: null,
        message: '地址无效',
      } as const);

  if (!result.ok) {
    const failures = (catalog.failures ?? 0) + 1;
    commit(provider, {
      catalog: {
        ...catalog,
        failures,
        retryAt: new Date(now + backoffMs(failures)).toISOString(),
        error: { code: result.code, message: result.message, at },
      },
    });
    logger.warn(
      { providerId, code: result.code, status: result.status, failures },
      'Model catalog sync failed',
    );
    return { ok: false, code: result.code, message: result.message };
  }

  const gateway = result.gateway ?? provider.gateway ?? null;
  const settled: ProviderCatalogState = { ...catalog, checkedAt: at };
  delete settled.failures;
  delete settled.retryAt;
  delete settled.error;
  if (gateway !== 'magpie') {
    commit(provider, { catalog: settled });
    return { ok: true, gateway: null, added: [], newModels: [], missing: [] };
  }

  const merge = mergeCatalogModels({
    // A connection saved before lists existed offers its own model.
    models: effectiveProviderModels(provider),
    discovered: result.models,
    previous: catalog,
    autoAdd: catalog.autoAdd === true,
    now: at,
  });
  const nextCatalog: ProviderCatalogState = {
    ...settled,
    syncedAt: at,
    knownIds: merge.knownIds,
  };
  if (merge.newModels.length > 0) nextCatalog.newModels = merge.newModels;
  else delete nextCatalog.newModels;
  commit(provider, {
    gateway: 'magpie',
    models: merge.models,
    catalog: nextCatalog,
  });
  logger.info(
    {
      providerId,
      added: merge.added.length,
      newModels: merge.newModels.length,
      missing: merge.missing.length,
    },
    'Model catalog synced',
  );
  return {
    ok: true,
    gateway: 'magpie',
    added: merge.added,
    newModels: merge.newModels.map((entry) => entry.id),
    missing: merge.missing,
  };
}

// ─── The schedule ─────────────────────────────────────────────

/** Whether the schedule should read this connection's list now. */
export function catalogSyncDue(
  provider: UnifiedProvider,
  now: number,
): boolean {
  if (!storedConnectionAccess(provider) || !providerHasCredentials(provider)) {
    return false;
  }
  const catalog = provider.catalog ?? {};
  if (catalog.retryAt && Date.parse(catalog.retryAt) > now) return false;
  if (provider.gateway === 'magpie') {
    return (
      !catalog.syncedAt ||
      now - Date.parse(catalog.syncedAt) >= CATALOG_SYNC_INTERVAL_MS
    );
  }
  // Any other connection is checked for a gateway once.
  return !catalog.checkedAt;
}

/** One pass over every connection that is due, one at a time. */
export async function runCatalogSyncPass(
  options: SyncOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  for (const provider of getProviders()) {
    if (!catalogSyncDue(provider, now)) continue;
    try {
      await syncProviderCatalog(provider.id, options);
    } catch (err) {
      logger.warn({ err, providerId: provider.id }, 'Model catalog sync threw');
    }
  }
}

let startTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

async function scheduledPass(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    await runCatalogSyncPass();
  } finally {
    passRunning = false;
  }
}

/** Start the schedule (startWebServer); idempotent, never keeps the process up. */
export function initModelCatalogSync(): void {
  if (startTimer || tickTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    void scheduledPass();
    tickTimer = setInterval(() => void scheduledPass(), CATALOG_SYNC_TICK_MS);
    tickTimer.unref?.();
  }, CATALOG_SYNC_STARTUP_DELAY_MS);
  startTimer.unref?.();
}

export function stopModelCatalogSync(): void {
  if (startTimer) clearTimeout(startTimer);
  if (tickTimer) clearInterval(tickTimer);
  startTimer = null;
  tickTimer = null;
}
