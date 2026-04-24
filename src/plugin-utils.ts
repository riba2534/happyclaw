/**
 * Shared plugin loading utilities for Claude Code plugins.
 *
 * Plugins are loaded via SDK `options.plugins: SdkPluginConfig[]`, which the
 * SDK converts into `--plugin-dir <path>` arguments passed to the spawned
 * claude CLI. Per-user plugin configs live in data/plugins/{userId}/plugins.json
 * and plugin directories are copied (not symlinked) into
 * data/plugins/{userId}/cache/{marketplace}/{plugin}/.
 *
 * See: plan v3 — HappyClaw 支持 Claude Code Plugins
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Name-segment whitelist for marketplace / plugin names. Enforced in
 * parsePluginFullId so downstream `path.join()` can never receive `..` or
 * slashes that would escape the per-user cache directory.
 */
const NAME_SEGMENT_RE = /^[\w.-]+$/;

function isValidNameSegment(s: string): boolean {
  return NAME_SEGMENT_RE.test(s) && s !== '.' && s !== '..';
}

export interface UserPluginConfig {
  /** Synced marketplace records (metadata only; actual files in cache dir). */
  marketplaces: Record<string, PluginMarketplaceEntry>;
  /** Plugin full id ("plugin-name@marketplace-name") → enabled flag. */
  enabled: Record<string, boolean>;
}

export interface PluginMarketplaceEntry {
  /** Absolute path on the host this was copied from, for sync staleness detection. */
  hostSourcePath: string;
  /** ISO timestamp of last sync-host operation. */
  syncedAt: string;
  /** Marketplace version (from metadata.version), informational only. */
  version?: string;
}

/** SDK's SdkPluginConfig shape (duplicated to avoid importing SDK in non-runner code). */
export type SdkPluginConfig = { type: 'local'; path: string };

/** Container-internal path where plugins cache is mounted in Docker mode. */
export const CONTAINER_PLUGINS_PATH = '/workspace/plugins';

export function getUserPluginsFile(userId: string): string {
  return path.join(DATA_DIR, 'plugins', userId, 'plugins.json');
}

export function getUserPluginsCacheDir(userId: string): string {
  return path.join(DATA_DIR, 'plugins', userId, 'cache');
}

export function getPluginCacheDir(
  userId: string,
  marketplaceName: string,
  pluginName: string,
): string {
  return path.join(getUserPluginsCacheDir(userId), marketplaceName, pluginName);
}

export function readUserPluginsFile(userId: string): UserPluginConfig {
  const file = getUserPluginsFile(userId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // Missing file is the normal "user has no plugins yet" path; anything else
    // is worth logging so disk/permission issues don't vanish silently.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ userId, file, err }, 'readUserPluginsFile: read failed');
    }
    return { marketplaces: {}, enabled: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ userId, file, err }, 'readUserPluginsFile: JSON parse failed, returning empty config');
    return { marketplaces: {}, enabled: {} };
  }

  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return {
    marketplaces:
      record.marketplaces && typeof record.marketplaces === 'object'
        ? (record.marketplaces as UserPluginConfig['marketplaces'])
        : {},
    enabled:
      record.enabled && typeof record.enabled === 'object'
        ? (record.enabled as UserPluginConfig['enabled'])
        : {},
  };
}

/**
 * Atomic write: serialize to a `.tmp` sibling, then rename into place.
 * rename(2) is atomic on the same filesystem, so readers never observe a
 * half-written plugins.json even under concurrent writes or a crash.
 */
export function writeUserPluginsFile(userId: string, config: UserPluginConfig): void {
  const file = getUserPluginsFile(userId);
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

/**
 * Load enabled plugins for a user, returning SdkPluginConfig[] ready to pass
 * to SDK `options.plugins`.
 *
 * Runtime-specific path conversion:
 *   - Docker: '/workspace/plugins/<marketplace>/<plugin>' (container-internal;
 *     container-runner must mount DATA_DIR/plugins/{userId}/cache → /workspace/plugins)
 *   - Host:   absolute DATA_DIR path
 *
 * A plugin is included only if:
 *   - enabled[fullId] === true
 *   - the plugin directory exists on disk with .claude-plugin/plugin.json
 *     (so stale configs don't inject dangling paths)
 *
 * Returns [] for missing userId, missing config, or zero enabled plugins.
 */
export function loadUserPlugins(
  userId: string,
  options: { runtime: 'docker' | 'host' },
): SdkPluginConfig[] {
  if (!userId) return [];

  const config = readUserPluginsFile(userId);
  const enabledIds = Object.keys(config.enabled).filter(
    (id) => config.enabled[id] === true,
  );
  if (enabledIds.length === 0) return [];

  const cacheDir = getUserPluginsCacheDir(userId);
  const basePath = options.runtime === 'docker' ? CONTAINER_PLUGINS_PATH : cacheDir;

  const result: SdkPluginConfig[] = [];
  for (const fullId of enabledIds) {
    const parsed = parsePluginFullId(fullId);
    if (!parsed) continue;

    // Validate against host cache (plugin.json must exist) even for docker
    // mode, because the host copy is what container mounts from.
    const manifestPath = path.join(
      cacheDir,
      parsed.marketplaceName,
      parsed.pluginName,
      '.claude-plugin',
      'plugin.json',
    );
    if (!fs.existsSync(manifestPath)) continue;

    const pluginPath = path.join(
      basePath,
      parsed.marketplaceName,
      parsed.pluginName,
    );
    result.push({ type: 'local' as const, path: pluginPath });
  }

  return result;
}
