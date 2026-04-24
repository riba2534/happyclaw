// Claude Code Plugins management routes (per-user)
//
// Plugins are loaded by the agent-runner via SDK `options.plugins`, populated
// from data/plugins/{userId}/plugins.json at spawn time. This route module
// only mutates the per-user config + cache; the spawn path reads it.
//
// See plan v3 and src/plugin-utils.ts for the data model.

import { Hono } from 'hono';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUserPluginsCacheDir,
  getUserPluginsFile,
  getPluginCacheDir,
  readUserPluginsFile,
  writeUserPluginsFile,
  parsePluginFullId,
  type UserPluginConfig,
} from '../plugin-utils.js';
import { checkPluginDependencies } from '../plugin-dependency-check.js';
import { getEffectiveExternalDir } from '../runtime-config.js';

interface HostPluginInfo {
  name: string;
  version?: string;
  description?: string;
  sourcePath: string; // absolute path on host
}

interface HostMarketplaceInfo {
  name: string;
  sourcePath: string;
  plugins: HostPluginInfo[];
  /** true if this marketplace has been synced to the current user's cache. */
  synced: boolean;
}

const pluginsRoutes = new Hono<{ Variables: Variables }>();

// --- Helpers ---

/**
 * Resolve the host-side marketplaces directory. Defaults to ~/.claude/plugins/
 * marketplaces but can be redirected via SystemSettings.externalClaudeDir, so
 * HappyClaw deployments that don't use the process user's home directory still
 * find the right catalog.
 */
function hostMarketplacesRoot(): string {
  return path.join(getEffectiveExternalDir(), 'plugins', 'marketplaces');
}

/** Sanity-check a marketplace / plugin name to prevent path traversal. */
function validateNameSegment(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';
}

/** Read plugin.json metadata. Returns null for missing/malformed. */
async function readPluginManifest(
  pluginDir: string,
): Promise<HostPluginInfo | null> {
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const name = typeof parsed.name === 'string' ? parsed.name : null;
    if (!name) return null;
    return {
      name,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
      sourcePath: pluginDir,
    };
  } catch {
    return null;
  }
}

/** List plugins under a marketplace directory (looks in plugins/ subdir). */
async function listMarketplacePlugins(
  marketplaceDir: string,
): Promise<HostPluginInfo[]> {
  const pluginsRoot = path.join(marketplaceDir, 'plugins');
  let entries: string[];
  try {
    entries = await fs.readdir(pluginsRoot);
  } catch {
    return [];
  }

  const result: HostPluginInfo[] = [];
  for (const entry of entries) {
    if (!validateNameSegment(entry)) continue;
    const pluginDir = path.join(pluginsRoot, entry);
    const stat = await fs.stat(pluginDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    const info = await readPluginManifest(pluginDir);
    if (info) result.push(info);
  }
  return result;
}

// --- Routes ---

// GET / — return current user's plugin config + synced marketplace summary.
pluginsRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const isAdmin = authUser.role === 'admin';
  const config = readUserPluginsFile(authUser.id);
  // Dependency warnings are workspace-agnostic in this view — a user's plugin
  // is shared across all their workspaces (admin home container, docker sub-
  // workspaces, etc). Reporting `host` just because the viewer is admin would
  // mask real missing-binary risk in their docker workspaces. Stay conservative:
  // always report Docker-runtime warnings here; v4 will move to per-workspace
  // accuracy once the UI has workspace context.
  const depCheckRuntime: 'docker' | 'host' = 'docker';

  // Enrich with a resolved `plugins` list per marketplace (from cache manifests).
  // hostSourcePath is an absolute path on the server and a potential info leak
  // for non-admin roles; expose it only to admins.
  const marketplaces: Array<{
    name: string;
    syncedAt: string;
    version?: string;
    hostSourcePath?: string;
    plugins: Array<{
      name: string;
      fullId: string;
      enabled: boolean;
      version?: string;
      description?: string;
      warnings: { missing: string[]; note: string };
    }>;
  }> = [];

  for (const [mpName, meta] of Object.entries(config.marketplaces)) {
    if (!validateNameSegment(mpName)) continue;
    const cacheMpDir = path.join(getUserPluginsCacheDir(authUser.id), mpName);
    let pluginEntries: string[] = [];
    try {
      pluginEntries = await fs.readdir(cacheMpDir);
    } catch {
      // cache dir missing → treat as empty
    }

    const plugins: (typeof marketplaces)[0]['plugins'] = [];
    for (const pluginName of pluginEntries) {
      if (!validateNameSegment(pluginName)) continue;
      const pluginDir = path.join(cacheMpDir, pluginName);
      const stat = await fs.stat(pluginDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      const manifest = await readPluginManifest(pluginDir);
      if (!manifest) continue;
      const fullId = `${pluginName}@${mpName}`;
      const deps = checkPluginDependencies(pluginDir, fullId, {
        runtime: depCheckRuntime,
      });
      plugins.push({
        name: pluginName,
        fullId,
        enabled: config.enabled[fullId] === true,
        version: manifest.version,
        description: manifest.description,
        warnings: deps,
      });
    }

    marketplaces.push({
      name: mpName,
      syncedAt: meta.syncedAt,
      version: meta.version,
      ...(isAdmin ? { hostSourcePath: meta.hostSourcePath } : {}),
      plugins,
    });
  }

  return c.json({ marketplaces });
});

// PATCH /enabled/:pluginFullId — toggle a plugin on/off
pluginsRoutes.patch('/enabled/:pluginFullId', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const fullId = c.req.param('pluginFullId');
  const parsed = parsePluginFullId(fullId);
  if (!parsed) {
    return c.json(
      { error: 'Invalid plugin id; expected "<plugin>@<marketplace>"' },
      400,
    );
  }
  if (
    !validateNameSegment(parsed.pluginName) ||
    !validateNameSegment(parsed.marketplaceName)
  ) {
    return c.json({ error: 'Invalid plugin or marketplace name' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') {
    return c.json({ error: '`enabled` must be boolean' }, 400);
  }

  const config = readUserPluginsFile(authUser.id);

  // Validate plugin exists in cache before enabling; disabling is always OK
  if (enabled) {
    const manifestPath = path.join(
      getPluginCacheDir(authUser.id, parsed.marketplaceName, parsed.pluginName),
      '.claude-plugin',
      'plugin.json',
    );
    if (!fsSync.existsSync(manifestPath)) {
      return c.json(
        {
          error: `Plugin not found in cache; sync marketplace "${parsed.marketplaceName}" first`,
        },
        404,
      );
    }
  }

  config.enabled[fullId] = enabled;
  writeUserPluginsFile(authUser.id, config);

  return c.json({ success: true, fullId, enabled });
});

// GET /available-on-host — list marketplaces + plugins present on host fs.
// Admin-only: exposes absolute host paths and the set of plugins installed
// on the server machine, both of which member roles shouldn't see.
pluginsRoutes.get('/available-on-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can browse host plugin marketplaces' }, 403);
  }
  const config = readUserPluginsFile(authUser.id);
  const syncedSet = new Set(Object.keys(config.marketplaces));

  const root = hostMarketplacesRoot();
  let mpDirs: string[] = [];
  try {
    mpDirs = await fs.readdir(root);
  } catch {
    return c.json({ marketplaces: [], hostRoot: root });
  }

  const marketplaces: HostMarketplaceInfo[] = [];
  for (const name of mpDirs) {
    if (!validateNameSegment(name)) continue;
    const mpDir = path.join(root, name);
    const stat = await fs.stat(mpDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const plugins = await listMarketplacePlugins(mpDir);
    if (plugins.length === 0) continue;

    marketplaces.push({
      name,
      sourcePath: mpDir,
      plugins,
      synced: syncedSet.has(name),
    });
  }

  return c.json({ marketplaces, hostRoot: root });
});

// POST /sync-host — copy a marketplace's plugins to the per-user cache.
// Admin-only: copying arbitrary host plugins (which can include executable
// hooks / MCP servers / scripts) is a supply-chain surface that must not be
// open to members. See src/routes/mcp-servers.ts:305 for the analogous gate.
pluginsRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host plugin marketplaces' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const marketplace = (body as { marketplace?: unknown }).marketplace;
  if (typeof marketplace !== 'string' || !validateNameSegment(marketplace)) {
    return c.json({ error: '`marketplace` must be a valid name segment' }, 400);
  }

  const hostMpDir = path.join(hostMarketplacesRoot(), marketplace);
  const stat = await fs.stat(hostMpDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return c.json(
      { error: `Host marketplace "${marketplace}" not found` },
      404,
    );
  }

  const plugins = await listMarketplacePlugins(hostMpDir);
  if (plugins.length === 0) {
    return c.json(
      { error: 'No plugins with valid .claude-plugin/plugin.json found' },
      400,
    );
  }

  const cacheMpDir = path.join(
    getUserPluginsCacheDir(authUser.id),
    marketplace,
  );

  const stats = { copied: [] as string[], skipped: [] as string[], warnings: [] as string[] };

  // Rebuild from scratch to match host state (drop removed plugins)
  try {
    await fs.rm(cacheMpDir, { recursive: true, force: true });
  } catch {
    /* not found, ok */
  }
  await fs.mkdir(cacheMpDir, { recursive: true });

  for (const plugin of plugins) {
    const pluginDirName = path.basename(plugin.sourcePath);

    // Self-containment validation (corresponds to plan P1.2)
    if (plugin.name !== pluginDirName) {
      stats.warnings.push(
        `Plugin "${pluginDirName}" has name mismatch (plugin.json.name="${plugin.name}"); using directory name`,
      );
    }

    const dstDir = path.join(cacheMpDir, pluginDirName);
    try {
      await fs.cp(plugin.sourcePath, dstDir, {
        recursive: true,
        preserveTimestamps: false,
        errorOnExist: false,
        force: true,
      });
      stats.copied.push(pluginDirName);
    } catch (err) {
      stats.skipped.push(pluginDirName);
      stats.warnings.push(
        `Failed to copy "${pluginDirName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Update plugins.json metadata (do not auto-enable; user opts in per plugin)
  const config = readUserPluginsFile(authUser.id);
  // Pick a reasonable version (from marketplace.json metadata, if any)
  let marketplaceVersion: string | undefined;
  try {
    const mpManifest = JSON.parse(
      await fs.readFile(
        path.join(hostMpDir, '.claude-plugin', 'marketplace.json'),
        'utf-8',
      ),
    );
    if (mpManifest?.metadata?.version) {
      marketplaceVersion = String(mpManifest.metadata.version);
    }
  } catch {
    /* marketplace.json missing / malformed, ok */
  }

  config.marketplaces[marketplace] = {
    hostSourcePath: hostMpDir,
    syncedAt: new Date().toISOString(),
    ...(marketplaceVersion ? { version: marketplaceVersion } : {}),
  };
  writeUserPluginsFile(authUser.id, config);

  return c.json({
    marketplace,
    copied: stats.copied,
    skipped: stats.skipped,
    warnings: stats.warnings,
  });
});

// DELETE /marketplaces/:name — remove cache + cascade-clear enabled[*@name]
pluginsRoutes.delete('/marketplaces/:name', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const name = c.req.param('name');
  if (!validateNameSegment(name)) {
    return c.json({ error: 'Invalid marketplace name' }, 400);
  }

  const config = readUserPluginsFile(authUser.id);
  const hadMarketplace = !!config.marketplaces[name];

  // Cascade: drop all enabled entries whose marketplace matches
  const removedEnabled: string[] = [];
  const newEnabled: UserPluginConfig['enabled'] = {};
  for (const [id, flag] of Object.entries(config.enabled)) {
    const parsed = parsePluginFullId(id);
    if (parsed && parsed.marketplaceName === name) {
      removedEnabled.push(id);
    } else {
      newEnabled[id] = flag;
    }
  }

  delete config.marketplaces[name];
  config.enabled = newEnabled;
  writeUserPluginsFile(authUser.id, config);

  // Delete cache directory on disk
  const cacheMpDir = path.join(getUserPluginsCacheDir(authUser.id), name);
  try {
    await fs.rm(cacheMpDir, { recursive: true, force: true });
  } catch {
    /* already gone, ok */
  }

  return c.json({
    success: true,
    marketplace: name,
    hadMarketplace,
    removedEnabled,
  });
});

export default pluginsRoutes;
// Re-export helpers for tests
export { getUserPluginsFile, getUserPluginsCacheDir };
