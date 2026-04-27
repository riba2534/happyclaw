// Claude Code Plugins management routes (per-user)
//
// Plugins are loaded by the agent-runner via SDK `options.plugins`, populated
// from the user's v2 plugins.json + the shared catalog at spawn time. This
// route module mutates the per-user v2 config and triggers materialize; the
// spawn path reads the runtime tree.
//
// See plan v3 and src/plugin-utils.ts for the data model.

import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUserPluginRuntimePath,
  readUserPluginsV2,
  writeUserPluginsV2,
  parsePluginFullId,
  type UserPluginsV2,
} from '../plugin-utils.js';
import { checkPluginDependencies } from '../plugin-dependency-check.js';
import {
  scanHostMarketplaces,
  isScanInFlight,
} from '../plugin-importer.js';
import {
  readCatalogIndex,
  type CatalogIndex,
  type CatalogPluginEntry,
  type SnapshotMeta,
} from '../plugin-catalog.js';
import { materializeUserRuntime } from '../plugin-materializer.js';
import {
  buildCommandIndex,
  invalidateUserCommandIndex,
} from '../plugin-command-index.js';

const pluginsRoutes = new Hono<{ Variables: Variables }>();

// --- Helpers ---

/** Sanity-check a marketplace / plugin name to prevent path traversal. */
function validateNameSegment(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';
}

// --- Routes ---

// GET / — return the catalog's full plugin set, annotated with the current
// user's enabled state per plugin (mcp-style projection). The UI's list +
// toggle flow needs to see plugins even when not yet enabled, and disabled
// refs must remain visible so users can re-enable them. v2 entries that
// reference plugins no longer in the catalog (after a marketplace removal /
// before a scan) are still listed with a `missing from catalog` warning so
// users can clean them up.
pluginsRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const isAdmin = authUser.role === 'admin';
  const v2 = readUserPluginsV2(authUser.id);
  const catalog = readCatalogIndex();
  // Dependency warnings are workspace-agnostic in this view — a user's plugin
  // is shared across all their workspaces (admin home container, docker sub-
  // workspaces, etc). Reporting `host` just because the viewer is admin would
  // mask real missing-binary risk in their docker workspaces. Stay conservative:
  // always report Docker-runtime warnings here; a future change will move to
  // per-workspace accuracy once the UI has workspace context.
  const depCheckRuntime: 'docker' | 'host' = 'docker';

  type PluginRow = {
    name: string;
    fullId: string;
    enabled: boolean;
    snapshot?: string;
    activeSnapshot?: string;
    version?: string;
    description?: string;
    warnings: { missing: string[]; note: string };
  };
  type MarketplaceRow = {
    name: string;
    syncedAt: string;
    version?: string;
    hostSourcePath?: string;
    plugins: PluginRow[];
  };

  const byMarketplace = new Map<string, MarketplaceRow>();

  function ensureMarketplaceRow(name: string, fallbackSyncedAt: string): MarketplaceRow {
    const existing = byMarketplace.get(name);
    if (existing) return existing;
    const mpCat = catalog.marketplaces[name];
    const row: MarketplaceRow = {
      name,
      syncedAt: mpCat?.lastImportedAt ?? fallbackSyncedAt,
      version: mpCat?.version,
      ...(isAdmin && mpCat?.sourcePath
        ? { hostSourcePath: mpCat.sourcePath }
        : {}),
      plugins: [],
    };
    byMarketplace.set(name, row);
    return row;
  }

  // 1. Walk catalog: every plugin in the shared catalog must appear, regardless
  //    of whether the user has enabled it. Annotate with the user's enabled
  //    state if a v2 ref exists.
  for (const [fullId, catEntry] of Object.entries(catalog.plugins)) {
    if (
      !validateNameSegment(catEntry.marketplace) ||
      !validateNameSegment(catEntry.plugin)
    ) {
      continue;
    }
    const userRef = v2?.enabled[fullId];
    const isEnabled = userRef?.enabled === true;
    // Snapshot to display: user pin if they have a ref (enabled or not),
    // otherwise the catalog's active snapshot (the default the toggle would
    // pin).
    const refSnapshot =
      userRef && validateNameSegment(userRef.snapshot)
        ? userRef.snapshot
        : catEntry.activeSnapshot;
    const snapMeta = catEntry.snapshots[refSnapshot];

    // Dependency check looks at the user's materialized runtime tree if it
    // exists (i.e. the plugin has been enabled at least once). Catalog-only
    // plugins skip the check — there is nothing to load until the user enables.
    let deps: { missing: string[]; note: string } = { missing: [], note: '' };
    if (
      isEnabled &&
      userRef &&
      validateNameSegment(userRef.snapshot) &&
      validateNameSegment(userRef.marketplace) &&
      validateNameSegment(userRef.plugin)
    ) {
      const runtimeDir = getUserPluginRuntimePath(
        authUser.id,
        userRef.snapshot,
        userRef.marketplace,
        userRef.plugin,
      );
      try {
        if ((await fs.stat(runtimeDir)).isDirectory()) {
          deps = checkPluginDependencies(runtimeDir, fullId, {
            runtime: depCheckRuntime,
          });
        }
      } catch {
        /* missing runtime tree, no deps to report */
      }
    }

    const pluginRow: PluginRow = {
      name: catEntry.plugin,
      fullId,
      enabled: isEnabled,
      snapshot: refSnapshot,
      activeSnapshot: catEntry.activeSnapshot,
      version: snapMeta?.version,
      description: snapMeta?.description,
      warnings: deps,
    };
    const mpRow = ensureMarketplaceRow(
      catEntry.marketplace,
      userRef?.enabledAt ?? new Date(0).toISOString(),
    );
    mpRow.plugins.push(pluginRow);
  }

  // 2. Surface v2 refs whose catalog entry has vanished (catalog scan dropped
  //    the marketplace, or the user enabled it via a stale path). These must
  //    remain visible so the user can disable / clean them up.
  if (v2) {
    for (const [fullId, ref] of Object.entries(v2.enabled)) {
      if (catalog.plugins[fullId]) continue;
      if (
        !validateNameSegment(ref.marketplace) ||
        !validateNameSegment(ref.plugin) ||
        !validateNameSegment(ref.snapshot)
      ) {
        continue;
      }
      const pluginRow: PluginRow = {
        name: ref.plugin,
        fullId,
        enabled: ref.enabled === true,
        snapshot: ref.snapshot,
        warnings: {
          missing: [],
          note: 'missing from catalog; please scan or remove',
        },
      };
      const mpRow = ensureMarketplaceRow(ref.marketplace, ref.enabledAt);
      mpRow.plugins.push(pluginRow);
    }
  }

  const marketplaces = Array.from(byMarketplace.values());

  return c.json({ marketplaces });
});

// PATCH /enabled/:pluginFullId — toggle a plugin on/off.
//
// Read-modify-write the v2 plugins.json (mcp pattern), then trigger
// materialize so the runtime tree exists before the next agent spawn.
// Body: { enabled: boolean, snapshot?: string }
//
// snapshot omitted → take catalog's activeSnapshot for the plugin. Snapshot
// must already exist in the catalog (importer must have imported it once);
// otherwise we 404 rather than write a dangling reference.
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
  const explicitSnapshot = (body as { snapshot?: unknown }).snapshot;
  if (typeof enabled !== 'boolean') {
    return c.json({ error: '`enabled` must be boolean' }, 400);
  }
  if (
    explicitSnapshot !== undefined &&
    (typeof explicitSnapshot !== 'string' ||
      !validateNameSegment(explicitSnapshot))
  ) {
    return c.json({ error: 'Invalid `snapshot` id' }, 400);
  }

  const v2 =
    readUserPluginsV2(authUser.id) ??
    ({ schemaVersion: 1, enabled: {} } as UserPluginsV2);

  if (enabled) {
    const catalog = readCatalogIndex();
    const catalogEntry = catalog.plugins[fullId];
    if (!catalogEntry) {
      return c.json(
        {
          error: `Plugin "${fullId}" not in catalog; run a host scan first`,
        },
        404,
      );
    }
    const snapshotId = explicitSnapshot ?? catalogEntry.activeSnapshot;
    if (!snapshotId || !catalogEntry.snapshots[snapshotId]) {
      return c.json(
        {
          error: `Snapshot "${snapshotId}" not found in catalog for ${fullId}`,
        },
        404,
      );
    }
    v2.enabled[fullId] = {
      enabled: true,
      marketplace: parsed.marketplaceName,
      plugin: parsed.pluginName,
      snapshot: snapshotId,
      enabledAt: new Date().toISOString(),
    };
    writeUserPluginsV2(authUser.id, v2);

    // Invalidate AFTER materialize so a concurrent GET /commands cannot
    // pin an empty index built between writeUserPluginsV2 and the runtime
    // tree being created (codex review #8).
    let materializeWarnings: string[] = [];
    try {
      const report = materializeUserRuntime(authUser.id);
      materializeWarnings = report.warnings;
    } catch (err) {
      materializeWarnings = [err instanceof Error ? err.message : String(err)];
    }
    invalidateUserCommandIndex(authUser.id);

    return c.json({
      success: true,
      fullId,
      enabled,
      snapshot: snapshotId,
      materializeWarnings,
    });
  }

  // Disable: drop the entry rather than leaving it as `enabled: false` so the
  // mapping stays small + the materializer/cleanup don't reason about
  // tombstones.
  delete v2.enabled[fullId];
  writeUserPluginsV2(authUser.id, v2);

  // Invalidate AFTER materialize for the same race-window reason as enable.
  let materializeWarnings: string[] = [];
  try {
    const report = materializeUserRuntime(authUser.id);
    materializeWarnings = report.warnings;
  } catch (err) {
    materializeWarnings = [err instanceof Error ? err.message : String(err)];
  }
  invalidateUserCommandIndex(authUser.id);

  return c.json({
    success: true,
    fullId,
    enabled,
    materializeWarnings,
  });
});

// POST /materialize — full re-materialize for the current user. Manual
// recovery path for the UI when the runtime tree is suspected drifted (rare,
// but cheap because materialize is idempotent on no-op).
pluginsRoutes.post('/materialize', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  try {
    const report = materializeUserRuntime(authUser.id);
    // The command index can hold an empty result cached from a build that ran
    // while the runtime tree was missing (first enable before materialize, or
    // post-GC). Drop it so the next /commands fetch re-reads the freshly
    // materialized tree. Mirrors PATCH /enabled and DELETE /marketplaces.
    invalidateUserCommandIndex(authUser.id);
    return c.json({ success: true, report });
  } catch (err) {
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// DELETE /marketplaces/:name — cascade-clear all enabled[*@name] from v2
// plugins.json. Re-materialize so orphan runtime trees can be cleaned up by
// the next GC pass.
pluginsRoutes.delete('/marketplaces/:name', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const name = c.req.param('name');
  if (!validateNameSegment(name)) {
    return c.json({ error: 'Invalid marketplace name' }, 400);
  }

  const v2 = readUserPluginsV2(authUser.id);
  const removedEnabled: string[] = [];
  if (v2) {
    for (const [id, ref] of Object.entries(v2.enabled)) {
      if (ref.marketplace === name) {
        removedEnabled.push(id);
        delete v2.enabled[id];
      }
    }
    if (removedEnabled.length > 0) {
      writeUserPluginsV2(authUser.id, v2);
      // Invalidate AFTER materialize for the same race-window reason as
      // PATCH /enabled (codex review #8): a concurrent GET /commands
      // could otherwise pin an empty index between writeUserPluginsV2
      // and the cascade materialize completing.
      try {
        materializeUserRuntime(authUser.id);
      } catch {
        // best-effort; user can hit POST /materialize manually
      }
      invalidateUserCommandIndex(authUser.id);
    }
  }

  return c.json({
    success: true,
    marketplace: name,
    removedEnabled,
  });
});

// GET /commands — list slash commands contributed by the user's enabled
// plugins. Drops `body` (full markdown can be megabytes for some plugins)
// and `frontmatter` (raw map) — UI only needs description / argument hint /
// DMI flag for display. The full entry is reachable via the index in-process
// (PR2.b expander).
pluginsRoutes.get('/commands', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const idx = await buildCommandIndex(authUser.id);
  const commands = idx.entries.map((e) => ({
    fullId: e.fullId,
    marketplace: e.marketplace,
    plugin: e.plugin,
    snapshot: e.snapshot,
    commandName: e.commandName,
    description: e.description,
    argumentHint: e.argumentHint,
    disableModelInvocation: e.disableModelInvocation,
  }));
  return c.json({ commands, conflicts: idx.conflicts });
});

// --- Catalog routes ---
//
// The catalog is a host-wide immutable snapshot store fed by `scanHostMarketplaces()`.
// Read access is open to any logged-in user (UI shows what's available to enable);
// scan triggers and snapshot source paths are admin-only because both expose host
// filesystem layout / supply-chain surface.

/** Strip `sourcePath` from snapshots when the viewer isn't admin. */
function projectSnapshotForRole(
  meta: SnapshotMeta,
  isAdmin: boolean,
): Omit<SnapshotMeta, 'sourcePath'> & { sourcePath?: string } {
  if (isAdmin) return meta;
  const { sourcePath: _omitted, ...rest } = meta;
  return rest;
}

function projectPluginForRole(
  entry: CatalogPluginEntry,
  isAdmin: boolean,
): CatalogPluginEntry {
  const snapshots: CatalogPluginEntry['snapshots'] = {};
  for (const [id, meta] of Object.entries(entry.snapshots)) {
    snapshots[id] = projectSnapshotForRole(meta, isAdmin) as SnapshotMeta;
  }
  return { ...entry, snapshots };
}

function projectIndexForRole(
  idx: CatalogIndex,
  isAdmin: boolean,
): CatalogIndex {
  if (isAdmin) return idx;
  const marketplaces: CatalogIndex['marketplaces'] = {};
  for (const [name, mp] of Object.entries(idx.marketplaces)) {
    const { sourcePath: _omitted, ...rest } = mp;
    marketplaces[name] = rest as CatalogIndex['marketplaces'][string];
  }
  const plugins: CatalogIndex['plugins'] = {};
  for (const [id, plugin] of Object.entries(idx.plugins)) {
    plugins[id] = projectPluginForRole(plugin, false);
  }
  return { ...idx, marketplaces, plugins };
}

// GET /catalog — list all imported marketplaces + plugins from the catalog index
pluginsRoutes.get('/catalog', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const isAdmin = authUser.role === 'admin';
  const idx = readCatalogIndex();
  return c.json({
    catalog: projectIndexForRole(idx, isAdmin),
    scanning: isScanInFlight(),
  });
});

// GET /catalog/marketplaces/:mp — single marketplace + its plugins
pluginsRoutes.get('/catalog/marketplaces/:mp', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const isAdmin = authUser.role === 'admin';
  const mp = c.req.param('mp');
  if (!validateNameSegment(mp)) {
    return c.json({ error: 'Invalid marketplace name' }, 400);
  }
  const idx = readCatalogIndex();
  const meta = idx.marketplaces[mp];
  if (!meta) {
    return c.json({ error: `Marketplace "${mp}" not in catalog` }, 404);
  }
  const projected = projectIndexForRole(idx, isAdmin);
  const plugins = Object.values(projected.plugins).filter(
    (p) => p.marketplace === mp,
  );
  return c.json({
    marketplace: projected.marketplaces[mp],
    plugins,
  });
});

// POST /catalog/scan — trigger an immediate host scan + import. Admin-only:
// scanning hits arbitrary host paths under `getEffectiveExternalDir()/plugins/
// marketplaces/*` and copies them into the shared catalog. Member roles must
// not influence what plugins become available system-wide.
pluginsRoutes.post('/catalog/scan', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can trigger catalog scan' }, 403);
  }
  // Concurrent callers (UI button, hourly timer, startup) all share the same
  // in-flight Promise via the importer's mutex; this just surfaces it.
  const report = await scanHostMarketplaces();
  return c.json({ report });
});

export default pluginsRoutes;
