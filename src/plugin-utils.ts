/**
 * Shared plugin loading utilities for Claude Code plugins.
 *
 * Single on-disk schema (v2):
 *   data/plugins/users/{userId}/plugins.json    — { schemaVersion: 1, enabled: {...} }
 *   data/plugins/runtime/{userId}/snapshots/{snapshotId}/{mp}/{plugin}/...
 *   data/plugins/catalog/...                    — immutable shared snapshots
 *
 * `loadUserPlugins` reads the v2 plugins.json and validates each enabled ref
 * against the user's runtime tree. Missing v2 file → empty result.
 *
 * SDK ingestion: results feed `options.plugins: SdkPluginConfig[]`, which the
 * SDK turns into `--plugin-dir <abs-path>` for the spawned claude CLI.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { isValidNameSegment } from './plugin-manifest.js';

// --- v2 types ----------------------------------------------------------------

export interface UserPluginEnableRefV2 {
  enabled: boolean;
  marketplace: string;
  plugin: string;
  /** Catalog snapshot id this user pinned (== contentHash from importer). */
  snapshot: string;
  /** ISO timestamp of last enable toggle. Informational. */
  enabledAt: string;
}

export interface UserPluginsV2 {
  schemaVersion: 1;
  enabled: Record<string, UserPluginEnableRefV2>;
}

/** SDK's SdkPluginConfig shape (duplicated to avoid importing SDK in non-runner code). */
export type SdkPluginConfig = { type: 'local'; path: string };

/** Container-internal path where the user runtime tree is mounted in Docker mode. */
export const CONTAINER_PLUGINS_PATH = '/workspace/plugins';

// --- v2 paths ----------------------------------------------------------------

export function getUserPluginsFileV2(userId: string): string {
  return path.join(DATA_DIR, 'plugins', 'users', userId, 'plugins.json');
}

export function getUserRuntimeRoot(userId: string): string {
  return path.join(DATA_DIR, 'plugins', 'runtime', userId);
}

export function getUserPluginRuntimePath(
  userId: string,
  snapshotId: string,
  marketplace: string,
  plugin: string,
): string {
  return path.join(
    getUserRuntimeRoot(userId),
    'snapshots',
    snapshotId,
    marketplace,
    plugin,
  );
}

// --- v2 read/write -----------------------------------------------------------

/**
 * Read the v2 plugins.json. Returns null when:
 *   - file is missing (caller treats as no enabled plugins)
 *   - file exists but isn't recognizable v2 (caller should NOT migrate; we
 *     don't auto-overwrite an unknown future schema)
 *
 * Malformed JSON inside an existing v2 file degrades to an empty enabled map
 * and a warning — same convention as readCatalogIndex.
 */
export function readUserPluginsV2(userId: string): UserPluginsV2 | null {
  if (!isValidNameSegment(userId)) return null;
  const file = getUserPluginsFileV2(userId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ userId, file, err }, 'readUserPluginsV2: read failed');
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ userId, file, err }, 'readUserPluginsV2: JSON parse failed');
    return { schemaVersion: 1, enabled: {} };
  }
  const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (rec.schemaVersion !== 1) {
    return null;
  }

  const out: UserPluginsV2 = { schemaVersion: 1, enabled: {} };
  if (rec.enabled && typeof rec.enabled === 'object') {
    for (const [fullId, value] of Object.entries(
      rec.enabled as Record<string, unknown>,
    )) {
      const ref = coerceEnableRef(value);
      if (ref) out.enabled[fullId] = ref;
    }
  }
  return out;
}

function coerceEnableRef(value: unknown): UserPluginEnableRefV2 | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.marketplace !== 'string' || typeof r.plugin !== 'string') {
    return null;
  }
  if (typeof r.snapshot !== 'string') return null;
  if (typeof r.enabled !== 'boolean') return null;
  return {
    enabled: r.enabled,
    marketplace: r.marketplace,
    plugin: r.plugin,
    snapshot: r.snapshot,
    enabledAt:
      typeof r.enabledAt === 'string' ? r.enabledAt : new Date(0).toISOString(),
  };
}

export function writeUserPluginsV2(userId: string, config: UserPluginsV2): void {
  if (!isValidNameSegment(userId)) {
    throw new Error(`Invalid userId: ${userId}`);
  }
  const file = getUserPluginsFileV2(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const content = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

// --- shared utilities --------------------------------------------------------

/**
 * Parse a plugin full id "<plugin-name>@<marketplace-name>" into parts.
 * Returns null for malformed ids.
 */
export function parsePluginFullId(
  fullId: string,
): { pluginName: string; marketplaceName: string } | null {
  const atIdx = fullId.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === fullId.length - 1) return null;
  const pluginName = fullId.slice(0, atIdx);
  const marketplaceName = fullId.slice(atIdx + 1);
  if (!isValidNameSegment(pluginName) || !isValidNameSegment(marketplaceName)) {
    return null;
  }
  return { pluginName, marketplaceName };
}

// --- SDK plugin loader -------------------------------------------------------

/**
 * Load enabled plugins for a user, returning SdkPluginConfig[] ready to pass
 * to SDK `options.plugins`.
 *
 * Reads v2 plugins.json. Missing file → []. Each enabled ref must have a
 * materialized runtime tree (`.claude-plugin/plugin.json` on disk) or it is
 * skipped — stale configs never inject dangling paths into the SDK call.
 *
 * Runtime path conventions:
 *   - Docker: `/workspace/plugins/snapshots/{snapshotId}/{mp}/{plugin}` —
 *     the user's whole runtime root is mounted at /workspace/plugins.
 *   - Host:   absolute DATA_DIR path under runtime/ snapshots.
 */
export function loadUserPlugins(
  userId: string,
  options: { runtime: 'docker' | 'host' },
): SdkPluginConfig[] {
  if (!userId) return [];

  const v2 = readUserPluginsV2(userId);
  if (!v2) return [];

  const result: SdkPluginConfig[] = [];
  for (const [fullId, ref] of Object.entries(v2.enabled)) {
    if (!ref || ref.enabled !== true) continue;
    if (
      !isValidNameSegment(ref.marketplace) ||
      !isValidNameSegment(ref.plugin) ||
      !isValidNameSegment(ref.snapshot)
    ) {
      logger.warn(
        { userId, fullId, ref },
        'loadUserPlugins: skipping enable ref with invalid name segment',
      );
      continue;
    }

    // Validate against the host-side runtime dir; if the materialize step
    // hasn't run yet (or got cleaned up), there's nothing to inject.
    const hostDir = getUserPluginRuntimePath(
      userId,
      ref.snapshot,
      ref.marketplace,
      ref.plugin,
    );
    const manifest = path.join(hostDir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) {
      logger.warn(
        { userId, fullId, hostDir },
        'loadUserPlugins: runtime dir missing or unmaterialized, skipping',
      );
      continue;
    }

    const finalPath =
      options.runtime === 'docker'
        ? `${CONTAINER_PLUGINS_PATH}/snapshots/${ref.snapshot}/${ref.marketplace}/${ref.plugin}`
        : hostDir;
    result.push({ type: 'local', path: finalPath });
  }
  return result;
}
