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
 *   2. if target exists with .claude-plugin/plugin.json → skip
 *   3. else hard-link the catalog snapshot tree (same fs, zero-copy)
 *      cross-fs fallback (EXDEV / EPERM on hard-link) → fs.cpSync(recursive)
 *      both write to a `.tmp-` sibling first, then rename(2) into place
 *
 * Symlinks are NEVER used — they would expose the catalog's host path in
 * any logs / inside containers, defeating the read-only mount boundary.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { isValidNameSegment } from './plugin-manifest.js';
import {
  getSnapshotPath,
  type CatalogPluginEntry,
} from './plugin-catalog.js';
import {
  getUserRuntimeRoot as getUserRuntimeRootFromUtils,
  readUserPluginsV2,
  type UserPluginsV2,
} from './plugin-utils.js';

export interface MaterializeReport {
  /** Snapshots already on disk and validated; no work done. */
  reused: number;
  /** Snapshots newly built into runtime/. */
  built: number;
  /** Snapshot dirs removed by cleanupOrphanRuntime. */
  cleaned: number;
  /** Non-fatal issues (missing catalog snapshot, copy fallback, etc). */
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
 * enable/disable churn. Hard-link materialization keeps the disk cost low
 * (one inode shared with the catalog), and admins can call
 * `cleanupOrphanRuntime(userId)` directly when they need to reclaim space.
 */
export function materializeUserRuntime(
  userId: string,
  // The options bag is currently unused; see MaterializeOptions. Keeping the
  // parameter avoids a breaking-change ripple through call sites that already
  // pass `{ isSnapshotInUse }`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: MaterializeOptions = {},
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

    // Already materialized → skip. We treat a manifest-bearing target as
    // authoritative; partial trees from a crashed run get cleaned up below.
    if (hasManifest(target)) {
      report.reused += 1;
      continue;
    }

    // Stale partial directory (no manifest) — wipe before re-materializing so
    // a previous half-copy doesn't leak into the rebuilt tree.
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        report.warnings.push(
          `Could not remove partial target ${target}: ${describe(err)}`,
        );
        continue;
      }
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

    try {
      buildSnapshot(sourceDir, target, report);
      if (!hasManifest(target)) {
        report.warnings.push(
          `Built snapshot at ${target} is missing .claude-plugin/plugin.json`,
        );
        continue;
      }
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
  const out: MaterializeReport =
    report ?? { reused: 0, built: 0, cleaned: 0, warnings: [] };

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
      out.warnings.push(
        `Cleanup of ${dir} failed: ${describe(err)}`,
      );
      logger.warn(
        { userId, snapshot: name, err },
        'plugin-materializer: cleanup failed',
      );
    }
  }

  return out;
}

// --- Internals ---------------------------------------------------------------

/**
 * Build target tree from sourceDir. Strategy:
 *   1. mkdir parent
 *   2. copy into a `.tmp-` sibling: try recursive hard-links first, fall back
 *      to fs.cpSync(recursive) on EXDEV / EPERM (cross-device or fs that
 *      doesn't allow hard links)
 *   3. rename(2) tmp → target (atomic on the same fs)
 *
 * Failures clean up the tmp dir before re-throwing so we never leave stray
 * partial trees.
 */
function buildSnapshot(
  sourceDir: string,
  target: string,
  report: MaterializeReport,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;

  let usedFallback = false;
  try {
    try {
      hardLinkTree(sourceDir, tmp);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOSYS') {
        // Cross-device or fs without hard-link support → wipe partial tmp and
        // copy the bytes instead. Slower but guaranteed-correct.
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* nothing to clean */
        }
        fs.cpSync(sourceDir, tmp, { recursive: true, dereference: false });
        usedFallback = true;
      } else {
        throw err;
      }
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  if (usedFallback) {
    report.warnings.push(
      `Cross-device fallback (fs.cp) used for ${target}`,
    );
  }
}

/**
 * Recursively hard-link every regular file under `src` to a mirrored path
 * under `dst`. Skips symlinks (we don't follow them and don't want to copy
 * dangling refs into runtime).
 */
function hardLinkTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const sAbs = path.join(src, ent.name);
    const dAbs = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      hardLinkTree(sAbs, dAbs);
      continue;
    }
    if (ent.isFile()) {
      fs.linkSync(sAbs, dAbs);
    }
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

/** Helper for callers that want to enumerate a user's catalog refs. */
export function listEnabledRefs(userId: string): UserPluginsV2['enabled'] {
  const cfg = readUserPluginsV2(userId);
  return cfg ? cfg.enabled : {};
}

/** Re-export for callers wiring up admin tooling that need catalog metadata. */
export type { CatalogPluginEntry };
