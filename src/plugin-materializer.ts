/**
 * plugin-materializer.ts
 *
 * Build per-user runtime trees for enabled plugins:
 *   data/plugins/runtime/{userId}/snapshots/{snapshotId}/{mp}/{plugin}/
 *
 * Snapshots are versioned (NOT replaced in place):
 *   - enabling a new version writes a new {snapshotId}/ tree
 *   - the previous tree is left on disk so any agent that already mounted it
 *     keeps working — GC removes it later when no plugins.json ref AND no
 *     active runner reference holds it
 *
 * Materialize strategy per plugin:
 *   1. target = runtime/{userId}/snapshots/{snapshotId}/{mp}/{plugin}
 *      marker = runtime/{userId}/snapshots/{snapshotId}/@happyclaw-runtime-markers/{mp}/{plugin}.json
 *   2. if target has plugin.json AND marker exists/validates → skip (already
 *      isolated-inode)
 *   3. else copyTreeIsolated catalog → tmp:
 *        - per-file fs.copyFileSync(..., COPYFILE_FICLONE) — kernel reflinks
 *          on APFS / btrfs / xfs (initial near-zero copy; COW allocates fresh
 *          blocks on write); plain byte copy elsewhere
 *        - skip symlinks (defensive; importer also skips)
 *      Then place tmp via:
 *        - new install         → rename(tmp → target)
 *        - partial leftover    → rmSync(target); rename(tmp → target)
 *        - legacy hard-link    → rename(target → backup); rename(tmp → target);
 *                                rmSync(backup). Failure rolls back via
 *                                rename(backup → target). Avoids the rmSync
 *                                window that would yank plugin files out from
 *                                under a live host agent (codex review).
 *      Finally write the marker at the snapshot-level sibling path so the
 *      next materialize can prove this tree is isolated-inode without
 *      polluting the plugin root visible to the SDK loader.
 *
 * The independent-inode property is load-bearing: host-mode agents run with
 * bypassPermissions and the SDK hands them runtime absolute paths; any
 * plugin/hook/script write through that path must NOT mutate the shared
 * immutable catalog snapshot. Hard-links broke that contract (codex P1).
 *
 * Symlinks are NEVER used — they would expose the catalog's host path in
 * any logs / inside containers, defeating the read-only mount boundary.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { isValidNameSegment } from './plugin-manifest.js';
import { getSnapshotPath, type CatalogPluginEntry } from './plugin-catalog.js';
import {
  getUserRuntimeRoot as getUserRuntimeRootFromUtils,
  readUserPluginsV2,
  getUserPluginSecrets,
} from './plugin-utils.js';

/**
 * Filename prefix for per-plugin runtime markers. Placed at snapshot-root
 * level (NOT inside plugin root) so:
 *   1. SDK plugin loader reading plugin root never sees this file
 *   2. plugin contents can't accidentally or maliciously contain a same-named
 *      file that would impersonate the marker and skip the migration check
 *
 * `@` is rejected by NAME_SEGMENT_RE (/^[\w.-]+$/), so this directory name
 * can never collide with a marketplace / plugin / snapshot segment.
 */
const MARKER_DIRNAME = '@happyclaw-runtime-markers';

/**
 * Bumped only on a *semantic* change to the materialize strategy (e.g. swap
 * out the copy primitive). Don't bump for cosmetic refactors — the bump
 * triggers re-materialize for every existing user.
 */
const RUNTIME_MARKER_VERSION = 2;

interface RuntimeMarker {
  materializerVersion: number;
  copyMode: 'copyfile_ficlone';
  isolatedInodes: true;
  builtAt: string;
}

export interface MaterializeReport {
  /** Snapshots already on disk and validated; no work done. */
  reused: number;
  /** Snapshots newly built into runtime/. */
  built: number;
  /** Snapshot dirs removed by cleanupOrphanRuntime. */
  cleaned: number;
  /** Non-fatal issues (missing catalog snapshot, materialize failures, etc). */
  warnings: string[];
}

/**
 * Caller-supplied predicate that returns `true` if a runtime snapshot is still
 * mounted by a live agent process. `cleanupOrphanRuntime` treats those as
 * pinned and leaves them on disk so a running agent never has its plugin tree
 * yanked out from under it. Default (when undefined) is "no active refs", i.e.
 * orphan cleanup runs unguarded.
 *
 * The wiring lives in PR2 — a periodic GC tick + group-queue graceful
 * shutdown will register a lookup against active container metadata and call
 * `cleanupOrphanRuntime` explicitly. PR1 keeps the hook here so the interface
 * is stable.
 */
export type ActiveRuntimeRefCheck = (
  userId: string,
  snapshotId: string,
) => boolean;

export interface MaterializeOptions {
  /**
   * Reserved for forward compatibility. `materializeUserRuntime` no longer
   * runs cleanup in-line, so this field is currently unused — passing it has
   * no effect. It stays in the type so PR2 can re-introduce optional inline
   * GC without churning every caller signature.
   */
  isSnapshotInUse?: ActiveRuntimeRefCheck;
  /** Force rebuilding the isolated runtime tree even if marker already exists. */
  force?: boolean;
}

/** runtime/ root for a user (caller mounts this whole dir into Docker). */
export function getUserRuntimeRoot(userId: string): string {
  return getUserRuntimeRootFromUtils(userId);
}

/** runtime/{userId}/snapshots/{snapshotId}/. */
export function getUserSnapshotsDir(userId: string): string {
  return path.join(getUserRuntimeRoot(userId), 'snapshots');
}

export function getUserSnapshotDir(userId: string, snapshotId: string): string {
  if (!isValidNameSegment(snapshotId)) {
    throw new Error(`Invalid snapshot id: ${snapshotId}`);
  }
  return path.join(getUserSnapshotsDir(userId), snapshotId);
}

/** runtime/{userId}/snapshots/{snapshotId}/{mp}/{plugin}/. */
export function getUserPluginRuntimeDir(
  userId: string,
  snapshotId: string,
  marketplace: string,
  plugin: string,
): string {
  if (!isValidNameSegment(marketplace) || !isValidNameSegment(plugin)) {
    throw new Error(`Invalid name segment: ${marketplace}/${plugin}`);
  }
  return path.join(getUserSnapshotDir(userId, snapshotId), marketplace, plugin);
}

/**
 * Build (or refresh) the user's runtime tree from their plugins.json (v2).
 * Idempotent — re-running with no config changes is a fast no-op (each plugin
 * hits the "target exists" branch).
 *
 * Cleanup of orphan snapshots is intentionally NOT invoked here. Removing
 * runtime trees on every materialize would race with live agents that mounted
 * an older snapshot: a disable-toggle or version bump from one process can
 * delete /workspace/plugins/snapshots/<old> while another container is still
 * reading from it. GC is the responsibility of `cleanupOrphanRuntime`, which
 * PR2 will wire to a periodic timer + graceful shutdown of group-queue
 * (both have visibility into which snapshots are pinned by an active runner).
 *
 * Until that wiring lands, snapshot directories accumulate after
 * enable/disable churn. copyTreeIsolated keeps the disk cost low on
 * filesystems that support reflink (APFS / btrfs / xfs — initial near-zero
 * copy; COW allocates fresh blocks on write); other filesystems fall back to
 * a plain byte copy. In every case runtime files have an inode independent
 * from the catalog. Admins can call `cleanupOrphanRuntime(userId)` directly
 * when they need to reclaim space.
 */
function resolveUserSecretsInTree(targetDir: string, userId: string): void {
  const secrets = getUserPluginSecrets(userId);

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.env')) {
      const envPath = path.join(targetDir, entry.name);
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        let modified = false;
        const replaced = content.replace(
          /\$\{([A-Za-z0-9_]+)\}/g,
          (match, varName) => {
            if (Object.prototype.hasOwnProperty.call(secrets, varName)) {
              modified = true;
              return secrets[varName];
            }
            return match;
          },
        );
        if (modified) {
          fs.writeFileSync(envPath, replaced, 'utf-8');
        }
      } catch {}
    }
  }

  const mcpPath = path.join(targetDir, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf-8');
      let modified = false;
      const replaced = raw.replace(
        /\$\{([A-Za-z0-9_]+)\}/g,
        (match, varName) => {
          if (Object.prototype.hasOwnProperty.call(secrets, varName)) {
            modified = true;
            return secrets[varName];
          }
          return match;
        },
      );
      if (modified) {
        fs.writeFileSync(mcpPath, replaced, 'utf-8');
      }
    } catch {}
  }
}

export function materializeUserRuntime(
  userId: string,
  options: MaterializeOptions = {},
): MaterializeReport {
  const report: MaterializeReport = {
    reused: 0,
    built: 0,
    cleaned: 0,
    warnings: [],
  };

  if (!userId || !isValidNameSegment(userId)) {
    report.warnings.push(`Invalid userId: ${userId}`);
    return report;
  }

  const config = readUserPluginsV2(userId);
  if (!config) {
    // No v2 config → nothing to materialize. Orphan snapshots (if any) are
    // left in place; explicit GC is the caller's responsibility now.
    return report;
  }

  // Pre-create the snapshots root so individual plugin dirs can mkdir under it.
  fs.mkdirSync(getUserSnapshotsDir(userId), { recursive: true });

  for (const [fullId, ref] of Object.entries(config.enabled)) {
    if (!ref || ref.enabled !== true) continue;
    if (
      !isValidNameSegment(ref.marketplace) ||
      !isValidNameSegment(ref.plugin) ||
      !isValidNameSegment(ref.snapshot)
    ) {
      report.warnings.push(
        `Skipped invalid enabled entry "${fullId}" (bad name segment)`,
      );
      continue;
    }

    const target = getUserPluginRuntimeDir(
      userId,
      ref.snapshot,
      ref.marketplace,
      ref.plugin,
    );

    // Already materialized AND tree was built with the isolated-inode
    // strategy → skip.
    const isolatedAlready =
      !options.force &&
      hasManifest(target) &&
      hasIsolatedRuntimeMarker(
        userId,
        ref.snapshot,
        ref.marketplace,
        ref.plugin,
      );
    if (isolatedAlready) {
      report.reused += 1;
      continue;
    }

    const sourceDir = getSnapshotPath(
      ref.marketplace,
      ref.plugin,
      ref.snapshot,
    );
    if (!sourceDir) {
      report.warnings.push(
        `Catalog snapshot missing for ${fullId} @ ${ref.snapshot}`,
      );
      continue;
    }

    // Three placement strategies. buildSnapshot builds tmp first either way,
    // so a failure before the swap leaves the original target untouched.
    const isLegacy = hasManifest(target); // and !isolatedAlready (above)
    const isPartial = !isLegacy && fs.existsSync(target);

    try {
      buildSnapshot(sourceDir, target, { isLegacy, isPartial });
      if (!hasManifest(target)) {
        report.warnings.push(
          `Built snapshot at ${target} is missing .claude-plugin/plugin.json`,
        );
        continue;
      }
      resolveUserSecretsInTree(target, userId);
      writeIsolatedRuntimeMarker(
        userId,
        ref.snapshot,
        ref.marketplace,
        ref.plugin,
      );
      report.built += 1;
    } catch (err) {
      report.warnings.push(
        `Materialize failed for ${fullId}: ${describe(err)}`,
      );
      logger.warn(
        { userId, fullId, snapshot: ref.snapshot, err },
        'plugin-materializer: materialize failed',
      );
    }
  }

  return report;
}

/**
 * Remove runtime snapshot dirs that are NOT referenced by the user's current
 * plugins.json AND not pinned by an active runner.
 *
 * Intended callers (wired in a follow-up PR):
 *   - periodic GC tick (e.g. once per N minutes from the main process)
 *   - group-queue graceful shutdown when an agent terminates
 *   - admin tooling that reclaims runtime/ disk usage on demand
 *
 * `materializeUserRuntime` deliberately does NOT call this function; running
 * cleanup synchronously alongside enable/disable churn races with live agents
 * that mounted the old snapshot. The caller MUST pass an `isSnapshotInUse`
 * predicate covering every active runner before cleanup is safe.
 *
 * Defense in depth: if `isSnapshotInUse` is undefined we still respect the
 * "currently referenced" set, so a freshly-enabled snapshot can never be
 * removed by an unrelated cleanup pass — but unreferenced snapshots WILL be
 * deleted, even if some agent is still using them. Always pass the predicate
 * in production.
 */
export function cleanupOrphanRuntime(
  userId: string,
  isSnapshotInUse?: ActiveRuntimeRefCheck,
  report?: MaterializeReport,
): MaterializeReport {
  const out: MaterializeReport = report ?? {
    reused: 0,
    built: 0,
    cleaned: 0,
    warnings: [],
  };

  if (!userId || !isValidNameSegment(userId)) return out;

  const snapshotsDir = getUserSnapshotsDir(userId);
  let entries: string[];
  try {
    entries = fs.readdirSync(snapshotsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      out.warnings.push(`Cleanup readdir failed: ${describe(err)}`);
    }
    return out;
  }

  const referenced = new Set<string>();
  const config = readUserPluginsV2(userId);
  if (config) {
    for (const ref of Object.values(config.enabled)) {
      if (ref && ref.enabled === true && isValidNameSegment(ref.snapshot)) {
        referenced.add(ref.snapshot);
      }
    }
  }

  for (const name of entries) {
    if (!isValidNameSegment(name)) continue;
    if (referenced.has(name)) continue;
    if (isSnapshotInUse && isSnapshotInUse(userId, name)) continue;

    const dir = path.join(snapshotsDir, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      out.cleaned += 1;
    } catch (err) {
      out.warnings.push(`Cleanup of ${dir} failed: ${describe(err)}`);
      logger.warn(
        { userId, snapshot: name, err },
        'plugin-materializer: cleanup failed',
      );
    }
  }

  return out;
}

// --- Internals ---------------------------------------------------------------

interface BuildPlacement {
  /**
   * `target` already has a manifest but no isolated-inode marker — it was
   * built by the old hard-link materializer. Migrate via rename + backup
   * rollback so a live host agent's plugin path doesn't disappear under it.
   */
  isLegacy: boolean;
  /**
   * `target` exists but has no manifest — partial / crashed run. Safe to
   * `rmSync` before placing tmp; no live agent can be using this incomplete
   * tree.
   */
  isPartial: boolean;
}

/**
 * Build target tree from sourceDir using copyTreeIsolated, then place into
 * `target` according to the placement strategy:
 *   - new install      → rename(tmp → target)
 *   - partial leftover → rmSync(target); rename(tmp → target)
 *   - legacy hard-link → rename(target → backup); rename(tmp → target);
 *                        rmSync(backup). On failure of the second rename we
 *                        rename backup → target to roll back.
 *
 * The whole copy + placement runs inside a single try/catch so any failure
 * (disk full mid-copy, EPERM, source race) cleans tmp before re-throwing.
 * Without this, an exception during copyTreeIsolated would leave a stray
 * `.tmp@...` partial tree (codex review).
 */
function buildSnapshot(
  sourceDir: string,
  target: string,
  placement: BuildPlacement,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // `.tmp@` prefix uses `@` which NAME_SEGMENT_RE rejects, so this can never
  // be mistaken for a plugin dir by any future scanner.
  const tmp = `${target}.tmp@${process.pid}-${Date.now()}`;
  try {
    copyTreeIsolated(sourceDir, tmp);

    if (placement.isLegacy) {
      // `.legacy-bak@` prefix likewise non-NAME_SEGMENT — safe sibling.
      const backup = `${target}.legacy-bak@${process.pid}-${Date.now()}`;
      fs.renameSync(target, backup);
      try {
        fs.renameSync(tmp, target);
      } catch (err) {
        // Roll the original tree back so live host agents see something at
        // the path. NB: between rename(target→backup) and rollback complete,
        // an agent reading by path can briefly hit ENOENT — this is shorter
        // than rmSync(target) but not zero.
        try {
          fs.renameSync(backup, target);
        } catch {
          /* rollback failed; backup retained for manual recovery */
        }
        throw err;
      }
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (gcErr) {
        // Backup is the legacy hard-link tree — still capable of writing
        // through to catalog if any path references it. The new SDK loader
        // doesn't (path contains `@` which NAME_SEGMENT_RE rejects), so
        // residual risk is low but not zero. Log so an operator can clean
        // up manually.
        logger.warn(
          { backup, err: gcErr },
          'plugin-materializer: legacy backup rmSync failed; retained for manual cleanup (NOT referenced by loader)',
        );
      }
    } else if (placement.isPartial) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tmp, target);
    } else {
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/**
 * Recursively copy every regular file under `src` to a mirrored path under
 * `dst`, with COPYFILE_FICLONE so the kernel reflinks on filesystems that
 * support it (APFS / btrfs / xfs — initial near-zero copy; COW allocates
 * fresh blocks on write). Skips symlinks defensively — catalog importer
 * already skips them at src/plugin-importer.ts:387,418, but a future
 * upstream slip must not propagate symlinks into runtime. Critical: every
 * dst file ends up with an independent inode from src so a host-mode
 * bypassPermissions write through dst cannot mutate the shared catalog
 * (codex P1).
 */
function copyTreeIsolated(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const sAbs = path.join(src, ent.name);
    const dAbs = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      copyTreeIsolated(sAbs, dAbs);
      continue;
    }
    if (ent.isFile()) {
      // FICLONE (NOT FICLONE_FORCE): try reflink, fall back to plain copy
      // when the filesystem doesn't support it. FORCE would throw on ext4.
      fs.copyFileSync(sAbs, dAbs, fs.constants.COPYFILE_FICLONE);
    }
  }
}

/** runtime/{userId}/snapshots/{snapshotId}/@happyclaw-runtime-markers/{mp}/{plugin}.json */
function getRuntimeMarkerPath(
  userId: string,
  snapshotId: string,
  marketplace: string,
  plugin: string,
): string {
  // marketplace / plugin segments are validated by callers (plugin name
  // segments arrive via materializeUserRuntime's per-entry isValidNameSegment
  // gate); snapshotId is validated by getUserSnapshotDir.
  return path.join(
    getUserSnapshotDir(userId, snapshotId),
    MARKER_DIRNAME,
    marketplace,
    `${plugin}.json`,
  );
}

function writeIsolatedRuntimeMarker(
  userId: string,
  snapshotId: string,
  marketplace: string,
  plugin: string,
): void {
  const file = getRuntimeMarkerPath(userId, snapshotId, marketplace, plugin);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const marker: RuntimeMarker = {
    materializerVersion: RUNTIME_MARKER_VERSION,
    copyMode: 'copyfile_ficlone',
    isolatedInodes: true,
    builtAt: new Date().toISOString(),
  };
  // Atomic rename so concurrent readers never see a half-written marker
  // (write the JSON body to a sibling tmp first, then rename into place).
  const tmp = `${file}.tmp@${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(marker) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function hasIsolatedRuntimeMarker(
  userId: string,
  snapshotId: string,
  marketplace: string,
  plugin: string,
): boolean {
  try {
    const raw = fs.readFileSync(
      getRuntimeMarkerPath(userId, snapshotId, marketplace, plugin),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as Partial<RuntimeMarker>;
    return (
      parsed.materializerVersion === RUNTIME_MARKER_VERSION &&
      parsed.copyMode === 'copyfile_ficlone' &&
      parsed.isolatedInodes === true
    );
  } catch {
    return false;
  }
}

function hasManifest(dir: string): boolean {
  const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
  try {
    return fs.statSync(manifest).isFile();
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-export for callers wiring up admin tooling that need catalog metadata. */
export type { CatalogPluginEntry };
