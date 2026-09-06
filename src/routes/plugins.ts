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

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUserPluginRuntimePath,
  readUserPluginsV2,
  writeUserPluginsV2,
  parsePluginFullId,
  getUserPluginSecretKeys,
  setUserPluginSecret,
  type UserPluginsV2,
} from '../plugin-utils.js';
import { checkPluginDependencies } from '../plugin-dependency-check.js';
import { getUserHomeGroup, recordAuthAuditLog } from '../db.js';
import {
  mutateCapabilityAroundRuntimeQuiesce,
  repairCapabilityRuntimeSafetyBlock,
  type CapabilityMutationImpact,
} from '../capability-runtime-mutation.js';
import {
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import { scanHostMarketplaces, isScanInFlight } from '../plugin-importer.js';
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
import { logger } from '../logger.js';

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
  // Choose dep-check runtime based on the viewer's home group executionMode:
  //   admin (host home)                     → check host PATH
  //   member (container home, home-{userId}) → check docker image PATH
  // The home is where the plugin will run in the common path; reporting the
  // wrong runtime produces false "缺少 X" badges (admin sees docker missing
  // even though the binary exists on host, or vice versa). Sub-workspaces
  // with a divergent execution mode are a future per-workspace concern once
  // the UI carries workspace context.
  let homeExecutionMode: 'host' | 'container' | undefined;
  try {
    homeExecutionMode = getUserHomeGroup(authUser.id)?.executionMode;
  } catch {
    /* db lookup failure → fall back to conservative docker view */
  }
  const depCheckRuntime: 'docker' | 'host' =
    homeExecutionMode === 'host' ? 'host' : 'docker';

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

  function ensureMarketplaceRow(
    name: string,
    fallbackSyncedAt: string,
  ): MarketplaceRow {
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

  return withCapabilityScopeLocks(
    [userCapabilityLockKey(authUser.id)],
    async () => {
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

        let materializeWarnings: string[] = [];
        try {
          const report = materializeUserRuntime(authUser.id);
          materializeWarnings = report.warnings;
        } catch (err) {
          materializeWarnings = [
            err instanceof Error ? err.message : String(err),
          ];
        }
        invalidateUserCommandIndex(authUser.id);

        try {
          recordAuthAuditLog({
            event_type: 'plugin_state_changed',
            username: authUser.username,
            actor_username: authUser.username,
            ip_address: c.req.header('x-forwarded-for') || null,
            user_agent: c.req.header('user-agent') || null,
            details: {
              action: 'enable',
              targetId: fullId,
              scope: `user:${authUser.id}`,
              snapshotId,
              runtimeResult: { success: true },
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr },
            'Failed to record plugin enable audit log',
          );
        }

        return c.json({
          success: true,
          fullId,
          enabled,
          snapshot: snapshotId,
          materializeWarnings,
        });
      }

      // Disable: drop the entry rather than leaving it as `enabled: false`
      delete v2.enabled[fullId];
      writeUserPluginsV2(authUser.id, v2);

      let materializeWarnings: string[] = [];
      try {
        const report = materializeUserRuntime(authUser.id);
        materializeWarnings = report.warnings;
      } catch (err) {
        materializeWarnings = [
          err instanceof Error ? err.message : String(err),
        ];
      }
      invalidateUserCommandIndex(authUser.id);

      try {
        recordAuthAuditLog({
          event_type: 'plugin_state_changed',
          username: authUser.username,
          actor_username: authUser.username,
          ip_address: c.req.header('x-forwarded-for') || null,
          user_agent: c.req.header('user-agent') || null,
          details: {
            action: 'disable',
            targetId: fullId,
            scope: `user:${authUser.id}`,
            runtimeResult: { success: true },
          },
        });
      } catch (auditErr) {
        logger.warn(
          { err: auditErr },
          'Failed to record plugin disable audit log',
        );
      }

      return c.json({
        success: true,
        fullId,
        enabled,
        materializeWarnings,
      });
    },
  );
});

// POST /deactivate-immediately/:pluginFullId — 立即停用并重启受影响会话
//
// 复用 capability-runtime-mutation 领域能力治理：
// 1. withCapabilityScopeLocks 用户能力锁串行化
// 2. repairCapabilityRuntimeSafetyBlock 修复历史残留 safety block
// 3. mutateCapabilityAroundRuntimeQuiesce 原子 pause -> forceStop -> commit -> post-stop quiesce
// 4. 支持重试：即使 v2 已删除但运行时残留或 block，重试路径仍能幂等推进并解除安全门禁
pluginsRoutes.post(
  '/deactivate-immediately/:pluginFullId',
  authMiddleware,
  async (c) => {
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

    return withCapabilityScopeLocks(
      [userCapabilityLockKey(authUser.id)],
      async () => {
        const impact: CapabilityMutationImpact = {
          kind: 'plugins',
          ownerUserId: authUser.id,
          pluginFullId: fullId,
        };

        // 修复可能残留的 safety block
        await repairCapabilityRuntimeSafetyBlock(
          impact,
          `Plugin ${fullId} immediate deactivation cleanup`,
        );

        const v2 =
          readUserPluginsV2(authUser.id) ??
          ({ schemaVersion: 1, enabled: {} } as UserPluginsV2);
        const existingRef = v2.enabled[fullId];
        const snapshotId = existingRef?.snapshot;

        // 如果未启用且此前无该插件记录，且没有 safety block，属于正常未启用状态
        if (!existingRef) {
          // 允许幂等执行运行时停用以防遗漏 runner
        }

        let materializeWarnings: string[] = [];

        const performCommit = () => {
          if (v2.enabled[fullId]) {
            delete v2.enabled[fullId];
            writeUserPluginsV2(authUser.id, v2);
          }

          try {
            const report = materializeUserRuntime(authUser.id, { force: true });
            materializeWarnings = report.warnings;
          } catch (err) {
            materializeWarnings = [
              err instanceof Error ? err.message : String(err),
            ];
          }
          invalidateUserCommandIndex(authUser.id);
          return materializeWarnings;
        };

        let invalidatedRuntimeJids = 0;
        try {
          const result = await mutateCapabilityAroundRuntimeQuiesce(
            impact,
            `Immediate deactivation of plugin ${fullId} for user ${authUser.id}`,
            performCommit,
          );
          invalidatedRuntimeJids = result.invalidatedRuntimeJids;
        } catch (err) {
          logger.error(
            { err, userId: authUser.id, fullId },
            'Failed during immediate plugin deactivation mutation',
          );

          try {
            recordAuthAuditLog({
              event_type: 'plugin_deactivated_immediately',
              username: authUser.username,
              actor_username: authUser.username,
              ip_address: c.req.header('x-forwarded-for') || null,
              user_agent: c.req.header('user-agent') || null,
              details: {
                action: 'deactivate_immediately',
                targetId: fullId,
                scope: `user:${authUser.id}`,
                snapshotId,
                runtimeResult: {
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                },
              },
            });
          } catch {}

          return c.json(
            {
              error: `Immediate deactivation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              fullId,
            },
            503,
          );
        }

        // 成功审计记录
        try {
          recordAuthAuditLog({
            event_type: 'plugin_deactivated_immediately',
            username: authUser.username,
            actor_username: authUser.username,
            ip_address: c.req.header('x-forwarded-for') || null,
            user_agent: c.req.header('user-agent') || null,
            details: {
              action: 'deactivate_immediately',
              targetId: fullId,
              scope: `user:${authUser.id}`,
              snapshotId,
              stoppedSessions: invalidatedRuntimeJids,
              runtimeResult: {
                success: true,
                invalidatedRuntimeJids,
              },
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr },
            'Failed to record audit log for immediate plugin deactivation',
          );
        }

        return c.json({
          success: true,
          fullId,
          stoppedSessionsCount: invalidatedRuntimeJids,
          materializeWarnings,
        });
      },
    );
  },
);

// --- User Secret Management Routes ---

// GET /secrets — 获取当前用户已配置的插件 Secret 键名列表（脱敏，严禁返回明文凭据值）
pluginsRoutes.get('/secrets', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const keys = getUserPluginSecretKeys(authUser.id);
  return c.json({ keys });
});

// PUT /secrets/:key — 配置/更新当前用户的某个 Secret
pluginsRoutes.put('/secrets/:key', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    return c.json({ error: 'Invalid secret key format' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const value = (body as { value?: unknown }).value;
  if (typeof value !== 'string') {
    return c.json({ error: 'value must be a string' }, 400);
  }
  if (value.length > 4096) {
    return c.json({ error: 'value exceeds maximum length (4096)' }, 400);
  }

  return withCapabilityScopeLocks(
    [userCapabilityLockKey(authUser.id)],
    async () => {
      const impact: CapabilityMutationImpact = {
        kind: 'plugins',
        ownerUserId: authUser.id,
      };

      await repairCapabilityRuntimeSafetyBlock(
        impact,
        `Plugin secret ${key} update cleanup`,
      );

      let invalidatedRuntimeJids = 0;
      try {
        const mutationResult = await mutateCapabilityAroundRuntimeQuiesce(
          impact,
          `Plugin secret ${key} updated for user ${authUser.id}`,
          async () => {
            setUserPluginSecret(authUser.id, key, value);
            const report = materializeUserRuntime(authUser.id, { force: true });
            invalidateUserCommandIndex(authUser.id);
            return report;
          },
        );
        invalidatedRuntimeJids = mutationResult.invalidatedRuntimeJids;
      } catch (err) {
        logger.error(
          { err, userId: authUser.id, key },
          'Failed to update plugin secret with quiesce',
        );
        return c.json(
          {
            error: `Failed to update plugin secret: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          503,
        );
      }

      try {
        recordAuthAuditLog({
          event_type: 'mcp_credential_updated',
          username: authUser.username,
          actor_username: authUser.username,
          ip_address: c.req.header('x-forwarded-for') || null,
          user_agent: c.req.header('user-agent') || null,
          details: {
            action: 'set_user_plugin_secret',
            targetId: key,
            scope: `user:${authUser.id}`,
            sanitizedChanges: { key },
            runtimeResult: {
              success: true,
              invalidatedRuntimeJids,
            },
          },
        });
      } catch {}

      return c.json({
        success: true,
        key,
        invalidated_runtime_jids: invalidatedRuntimeJids,
      });
    },
  );
});

// DELETE /secrets/:key — 撤回当前用户的某个 Secret
pluginsRoutes.delete('/secrets/:key', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    return c.json({ error: 'Invalid secret key format' }, 400);
  }

  return withCapabilityScopeLocks(
    [userCapabilityLockKey(authUser.id)],
    async () => {
      const impact: CapabilityMutationImpact = {
        kind: 'plugins',
        ownerUserId: authUser.id,
      };

      await repairCapabilityRuntimeSafetyBlock(
        impact,
        `Plugin secret ${key} revocation cleanup`,
      );

      let invalidatedRuntimeJids = 0;
      try {
        const mutationResult = await mutateCapabilityAroundRuntimeQuiesce(
          impact,
          `Plugin secret ${key} revoked for user ${authUser.id}`,
          async () => {
            setUserPluginSecret(authUser.id, key, undefined);
            const report = materializeUserRuntime(authUser.id, { force: true });
            invalidateUserCommandIndex(authUser.id);
            return report;
          },
        );
        invalidatedRuntimeJids = mutationResult.invalidatedRuntimeJids;
      } catch (err) {
        logger.error(
          { err, userId: authUser.id, key },
          'Failed to revoke plugin secret with quiesce',
        );
        return c.json(
          {
            error: `Failed to revoke plugin secret: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          503,
        );
      }

      try {
        recordAuthAuditLog({
          event_type: 'mcp_credential_updated',
          username: authUser.username,
          actor_username: authUser.username,
          ip_address: c.req.header('x-forwarded-for') || null,
          user_agent: c.req.header('user-agent') || null,
          details: {
            action: 'revoke_user_plugin_secret',
            targetId: key,
            scope: `user:${authUser.id}`,
            sanitizedChanges: { key },
            runtimeResult: {
              success: true,
              invalidatedRuntimeJids,
            },
          },
        });
      } catch {}

      return c.json({
        success: true,
        key,
        invalidated_runtime_jids: invalidatedRuntimeJids,
      });
    },
  );
});

// POST /materialize — full re-materialize for the current user.
pluginsRoutes.post('/materialize', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  return withCapabilityScopeLocks(
    [userCapabilityLockKey(authUser.id)],
    async () => {
      try {
        const report = materializeUserRuntime(authUser.id, { force: true });
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
    },
  );
});

/**
 * DELETE /marketplaces/:name
 *
 * @semantics per-caller only, never touches the immutable catalog.
 * Cascade-clears `enabled.*@{name}` from the caller's v2 plugins.json
 * under the user capability lock, and quiesces live runners.
 */
pluginsRoutes.delete('/marketplaces/:name', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const name = c.req.param('name');
  if (!validateNameSegment(name)) {
    return c.json({ error: 'Invalid marketplace name' }, 400);
  }

  return withCapabilityScopeLocks(
    [userCapabilityLockKey(authUser.id)],
    async () => {
      const v2 = readUserPluginsV2(authUser.id);
      const removedEnabled: string[] = [];
      let invalidatedRuntimeJids = 0;

      if (v2) {
        for (const [id, ref] of Object.entries(v2.enabled)) {
          if (ref.marketplace === name) {
            removedEnabled.push(id);
            delete v2.enabled[id];
          }
        }
        if (removedEnabled.length > 0) {
          const impact: CapabilityMutationImpact = {
            kind: 'plugins',
            ownerUserId: authUser.id,
          };
          await repairCapabilityRuntimeSafetyBlock(
            impact,
            `Cascade disable for marketplace ${name} cleanup`,
          );

          try {
            const mutationResult = await mutateCapabilityAroundRuntimeQuiesce(
              impact,
              `Marketplace ${name} unenabled for user ${authUser.id}`,
              async () => {
                writeUserPluginsV2(authUser.id, v2);
                const report = materializeUserRuntime(authUser.id, {
                  force: true,
                });
                invalidateUserCommandIndex(authUser.id);
                return report;
              },
            );
            invalidatedRuntimeJids = mutationResult.invalidatedRuntimeJids;
          } catch (err) {
            logger.error(
              { err, userId: authUser.id, marketplace: name },
              'Failed during cascade marketplace unenable quiesce',
            );
            return c.json(
              {
                error: `Cascade disable failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
              503,
            );
          }

          try {
            recordAuthAuditLog({
              event_type: 'plugin_state_changed',
              username: authUser.username,
              actor_username: authUser.username,
              ip_address: c.req.header('x-forwarded-for') || null,
              user_agent: c.req.header('user-agent') || null,
              details: {
                action: 'cascade_disable',
                marketplace: name,
                removedEnabled,
                scope: `user:${authUser.id}`,
                runtimeResult: {
                  success: true,
                  invalidatedRuntimeJids,
                },
              },
            });
          } catch {}

          logger.info(
            {
              event: 'plugin_marketplace_unenabled',
              userId: authUser.id,
              marketplace: name,
              removedEnabled,
            },
            'plugin marketplace dropped from caller refs (catalog NOT touched)',
          );
        }
      }

      return c.json({
        success: true,
        marketplace: name,
        removedEnabled,
        invalidated_runtime_jids: invalidatedRuntimeJids,
      });
    },
  );
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
// scanning copies into the shared catalog from `getEffectiveExternalDir()/
// plugins/marketplaces/*` AND from any `installLocation` registered in
// `known_marketplaces.json` (covers directory-source marketplaces living
// outside marketplaces/). Those are paths the host admin has themselves
// registered in Claude Code, so they're within the existing trust boundary —
// but member roles still must not influence what becomes available system-wide.
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
