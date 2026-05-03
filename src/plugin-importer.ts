/**
 * plugin-importer.ts
 *
 * Scan host marketplaces (default `~/.claude/plugins/marketplaces`, override via
 * SystemSettings.externalClaudeDir) and import each plugin into the immutable
 * catalog snapshot tree.
 *
 * Properties guaranteed:
 * - **Single concurrent scan per process**: a module-level mutex serializes
 *   admin UI / startup / hourly timer triggers. Concurrent callers receive
 *   the in-flight Promise's result so no scan is dropped.
 * - **Immutable snapshots**: each snapshot dir is named by its content hash
 *   (sha256, excludes `.git/`, `.DS_Store`, `node_modules`). If a snapshot
 *   with that hash already exists on disk, the import is a no-op (counted
 *   as `snapshotsSkipped`). New snapshots are written to a tmp dir and then
 *   atomically `rename(2)`-d into `versions/{hash}/`.
 * - **Atomic index update**: `index.json` is rewritten under the same mutex
 *   via plugin-catalog.writeCatalogIndex (tmp + rename).
 * - **Path safety**: every name segment is validated against
 *   `NAME_SEGMENT_RE`; malformed names are skipped with a warning.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { getEffectiveExternalDir } from './runtime-config.js';
import {
  isValidNameSegment,
  readMarketplaceManifest,
  readPluginManifest,
  scanPluginAssets,
} from './plugin-manifest.js';
import {
  buildFullId,
  getCatalogPluginDir,
  getCatalogRoot,
  getCatalogSnapshotDir,
  readCatalogIndex,
  writeCatalogIndex,
  type CatalogIndex,
  type CatalogPluginEntry,
  type SnapshotMeta,
} from './plugin-catalog.js';

export interface ImportReport {
  marketplacesScanned: number;
  pluginsScanned: number;
  snapshotsCreated: number;
  /** Hash already present on disk → no copy needed. */
  snapshotsSkipped: number;
  warnings: string[];
}

export interface ScanOptions {
  source?:
    | { type: 'host-claude-dir' }
    | { type: 'directory'; path: string };
}

/** Names excluded from content hash + copy (caches / VCS / OS metadata). */
const HASH_EXCLUDES: ReadonlySet<string> = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
]);

// --- Module-level scan mutex --------------------------------------------------

let inFlight: Promise<ImportReport> | null = null;

/**
 * Public entry point. Concurrent callers (startup hook, hourly timer, admin
 * UI button) all share a single in-flight scan; the mutex keeps catalog
 * index writes serialized so two scanners never race.
 */
export async function scanHostMarketplaces(
  opts: ScanOptions = {},
): Promise<ImportReport> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await runScan(opts);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Visible for tests / status endpoints — true while a scan is running. */
export function isScanInFlight(): boolean {
  return inFlight !== null;
}

// --- Internal scan implementation --------------------------------------------

async function runScan(opts: ScanOptions): Promise<ImportReport> {
  const root = resolveScanRoot(opts);
  const report: ImportReport = {
    marketplacesScanned: 0,
    pluginsScanned: 0,
    snapshotsCreated: 0,
    snapshotsSkipped: 0,
    warnings: [],
  };

  // Ensure catalog root exists so writes don't have to mkdir each time.
  fs.mkdirSync(getCatalogRoot(), { recursive: true });

  let mpEntries: string[];
  try {
    mpEntries = fs.readdirSync(root);
  } catch (err) {
    const msg = `Marketplace root not readable at ${root}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.warn({ root, err }, 'plugin-importer: marketplace root unreadable');
    report.warnings.push(msg);
    return report;
  }

  const idx = readCatalogIndex();

  for (const mpName of mpEntries) {
    if (!isValidNameSegment(mpName)) {
      report.warnings.push(`Skipped invalid marketplace name: ${mpName}`);
      continue;
    }
    const mpDir = path.join(root, mpName);
    let mpStat: fs.Stats;
    try {
      mpStat = fs.statSync(mpDir);
    } catch {
      continue;
    }
    if (!mpStat.isDirectory()) continue;

    const mpManifest = readMarketplaceManifest(mpDir);
    // We accept marketplaces without manifest (fall back to dir name) so an
    // in-development marketplace is still importable.
    const mpDisplay = mpManifest?.name ?? mpName;
    if (mpManifest && mpManifest.name !== mpName) {
      report.warnings.push(
        `Marketplace "${mpName}" has manifest name "${mpManifest.name}"; using directory name`,
      );
    }
    report.marketplacesScanned += 1;

    idx.marketplaces[mpName] = {
      name: mpDisplay,
      version: mpManifest?.version,
      description: mpManifest?.description,
      owner: mpManifest?.owner,
      sourcePath: mpDir,
      lastImportedAt: new Date().toISOString(),
    };

    const pluginsRoot = path.join(mpDir, 'plugins');
    let pluginEntries: string[];
    try {
      pluginEntries = fs.readdirSync(pluginsRoot);
    } catch {
      // marketplace without `plugins/` is malformed but not fatal
      report.warnings.push(
        `Marketplace "${mpName}" has no plugins/ directory`,
      );
      continue;
    }

    for (const pluginName of pluginEntries) {
      if (!isValidNameSegment(pluginName)) {
        report.warnings.push(
          `Skipped invalid plugin name in "${mpName}": ${pluginName}`,
        );
        continue;
      }
      const pluginDir = path.join(pluginsRoot, pluginName);
      let pStat: fs.Stats;
      try {
        pStat = fs.statSync(pluginDir);
      } catch {
        continue;
      }
      if (!pStat.isDirectory()) continue;

      const manifest = readPluginManifest(pluginDir);
      if (!manifest) {
        // A directory without `.claude-plugin/plugin.json` is a placeholder,
        // not a broken plugin. Claude Code's CLI lays out one host dir per
        // entry in marketplace.json (with LICENSE/README) regardless of
        // source kind, and only populates the manifest on `/plugin install`.
        //
        // - Declared in marketplace.json (any source: inline / url / git-
        //   subdir): expected pre-install state → silent skip.
        // - Not declared: orphan dir from a marketplace.json edit / partial
        //   uninstall → warn so the user can clean up.
        // - No marketplace.json at all (in-development marketplace): we
        //   can't tell, so fall back to warning (the historical behaviour).
        const declared = mpManifest?.pluginSources?.[pluginName];
        if (declared !== undefined) {
          logger.debug(
            { marketplace: mpName, plugin: pluginName, declared },
            'plugin-importer: skipping placeholder dir (declared in marketplace.json, no local manifest)',
          );
        } else {
          report.warnings.push(
            `Plugin "${pluginName}" in "${mpName}" missing valid .claude-plugin/plugin.json`,
          );
        }
        continue;
      }
      if (manifest.name !== pluginName) {
        report.warnings.push(
          `Plugin "${pluginName}" has manifest name "${manifest.name}"; using directory name`,
        );
      }
      report.pluginsScanned += 1;

      try {
        await importPluginSnapshot({
          marketplace: mpName,
          plugin: pluginName,
          pluginDir,
          manifest,
          idx,
          report,
        });
      } catch (err) {
        report.warnings.push(
          `Failed to import "${pluginName}@${mpName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        logger.warn(
          { marketplace: mpName, plugin: pluginName, err },
          'plugin-importer: import failed',
        );
      }
    }
  }

  idx.lastScanAt = new Date().toISOString();
  writeCatalogIndex(idx);
  logger.info(
    {
      marketplaces: report.marketplacesScanned,
      plugins: report.pluginsScanned,
      created: report.snapshotsCreated,
      skipped: report.snapshotsSkipped,
      warnings: report.warnings.length,
    },
    'plugin-importer: scan complete',
  );
  return report;
}

function resolveScanRoot(opts: ScanOptions): string {
  if (opts.source && opts.source.type === 'directory') {
    return opts.source.path;
  }
  return path.join(getEffectiveExternalDir(), 'plugins', 'marketplaces');
}

interface ImportPluginArgs {
  marketplace: string;
  plugin: string;
  pluginDir: string;
  manifest: { name: string; version?: string; description?: string };
  idx: CatalogIndex;
  report: ImportReport;
}

/**
 * Import one plugin: hash sources, see if catalog already has that snapshot,
 * if not copy to a tmp dir then atomic-rename into `versions/{hash}/`.
 */
async function importPluginSnapshot(args: ImportPluginArgs): Promise<void> {
  const { marketplace, plugin, pluginDir, manifest, idx, report } = args;

  const contentHash = hashDirectoryContents(pluginDir);
  const snapshotId = `sha256-${contentHash.slice(0, 32)}`;
  const targetDir = getCatalogSnapshotDir(marketplace, plugin, snapshotId);
  const fullId = buildFullId(plugin, marketplace);

  if (fs.existsSync(targetDir)) {
    // Snapshot dir already on disk → idempotent skip. Index may still need
    // to learn about it (e.g. fresh checkout where index.json is gone) so
    // we update metadata below regardless.
    report.snapshotsSkipped += 1;
  } else {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const tmpDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
    try {
      copyDirectoryFiltered(pluginDir, tmpDir);
      verifyManifestPresent(tmpDir);
      // rename(2) is atomic on the same fs. Catalog snapshot is now visible.
      fs.renameSync(tmpDir, targetDir);
      report.snapshotsCreated += 1;
    } catch (err) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  // Refresh the per-plugin index entry. activeSnapshot is always set to the
  // hash this scan observed, even if the snapshot dir was already on disk
  // (skip path) — see the assignment below.
  const existing: CatalogPluginEntry | undefined = idx.plugins[fullId];
  const meta: SnapshotMeta = {
    contentHash: snapshotId,
    version: manifest.version,
    description: manifest.description,
    importedAt: new Date().toISOString(),
    sourcePath: pluginDir,
    assetCounts: scanPluginAssets(pluginDir),
  };

  if (!existing) {
    idx.plugins[fullId] = {
      marketplace,
      plugin,
      fullId,
      activeSnapshot: snapshotId,
      snapshots: { [snapshotId]: meta },
    };
    return;
  }

  existing.snapshots[snapshotId] = meta;
  // activeSnapshot follows "the content most recently observed by a scan",
  // regardless of whether the snapshot dir was newly built or matched an
  // existing hash. This keeps `activeSnapshot` aligned with the host-side
  // source-of-truth: if a user reverts a plugin to an older version on disk,
  // the next scan re-pins active to that older hash. (Without this, scan
  // would silently leave a stale active pointing at a previously-newer hash.)
  existing.activeSnapshot = snapshotId;
}

/**
 * Compute deterministic sha256 of a directory tree, excluding HASH_EXCLUDES.
 * Hash domain: relative file path + null + raw content + null. Symlinks are
 * skipped (hash is content-only; the importer also doesn't copy symlinks).
 */
export function hashDirectoryContents(rootDir: string): string {
  const hash = crypto.createHash('sha256');
  const entries = collectFiles(rootDir, '');
  // Sorted by relative path for determinism across filesystems.
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const e of entries) {
    hash.update(e.rel);
    hash.update('\0');
    hash.update(fs.readFileSync(e.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface FileEntry {
  rel: string;
  abs: string;
}

function collectFiles(root: string, prefix: string): FileEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, prefix));
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const name of names) {
    if (HASH_EXCLUDES.has(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try {
      // lstat so symlinks are detected (and skipped) rather than followed
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push(...collectFiles(root, rel));
      continue;
    }
    if (stat.isFile()) {
      out.push({ rel, abs });
    }
  }
  return out;
}

/**
 * Recursively copy `src` → `dst`, mirroring the `HASH_EXCLUDES` filter so the
 * snapshot directory only contains what the hash covered. We use plain
 * read/write rather than `fs.cp` because the latter treats symlinks
 * inconsistently across Node versions.
 */
function copyDirectoryFiltered(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const names = fs.readdirSync(src);
  for (const name of names) {
    if (HASH_EXCLUDES.has(name)) continue;
    const sAbs = path.join(src, name);
    const dAbs = path.join(dst, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(sAbs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copyDirectoryFiltered(sAbs, dAbs);
    } else if (stat.isFile()) {
      fs.copyFileSync(sAbs, dAbs);
    }
  }
}

function verifyManifestPresent(dir: string): void {
  const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Imported snapshot at ${dir} missing .claude-plugin/plugin.json`,
    );
  }
}

/** Re-export helper used by catalog plugin dir lookups. */
export { getCatalogPluginDir };
