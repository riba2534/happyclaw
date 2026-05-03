/**
 * plugin-catalog.ts
 *
 * Catalog index: a single JSON file `data/plugins/catalog/index.json` plus an
 * immutable on-disk snapshot tree at
 * `data/plugins/catalog/marketplaces/{mp}/plugins/{plugin}/versions/{contentHash}/`.
 *
 * Catalog snapshots are write-once: imports always rename a fresh tmp dir into
 * `versions/{contentHash}/` and never overwrite an existing one. The index
 * tracks the active snapshot per plugin so user enable refs keep working
 * after re-imports.
 *
 * Path traversal is guarded by validating every name segment against
 * `NAME_SEGMENT_RE` before touching the filesystem.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { isValidNameSegment } from './plugin-manifest.js';

export interface SnapshotMeta {
  contentHash: string;
  version?: string;
  description?: string;
  importedAt: string;
  /** Absolute host path the snapshot was imported from (admin-only data). */
  sourcePath: string;
  /** Best-effort asset counts (commands/agents/skills/hooks/mcp). */
  assetCounts: {
    commands: number;
    agents: number;
    skills: number;
    hooks: number;
    mcpServers: number;
  };
}

export interface CatalogPluginEntry {
  marketplace: string;
  plugin: string;
  /** "<plugin>@<marketplace>", canonical id used by user enable refs. */
  fullId: string;
  /** snapshot id (== contentHash) currently treated as latest. */
  activeSnapshot: string;
  snapshots: Record<string, SnapshotMeta>;
}

export interface CatalogIndex {
  schemaVersion: 1;
  /** ISO timestamp of last successful scan. */
  lastScanAt: string | null;
  marketplaces: Record<
    string,
    {
      name: string;
      version?: string;
      description?: string;
      owner?: string;
      sourcePath: string;
      lastImportedAt: string;
    }
  >;
  /** Keyed by fullId ("<plugin>@<marketplace>"). */
  plugins: Record<string, CatalogPluginEntry>;
}

const EMPTY_INDEX: CatalogIndex = {
  schemaVersion: 1,
  lastScanAt: null,
  marketplaces: {},
  plugins: {},
};

export function getCatalogRoot(): string {
  return path.join(DATA_DIR, 'plugins', 'catalog');
}

export function getCatalogIndexFile(): string {
  return path.join(getCatalogRoot(), 'index.json');
}

export function getCatalogMarketplaceDir(marketplace: string): string {
  if (!isValidNameSegment(marketplace)) {
    throw new Error(`Invalid marketplace name segment: ${marketplace}`);
  }
  return path.join(getCatalogRoot(), 'marketplaces', marketplace);
}

export function getCatalogPluginDir(marketplace: string, plugin: string): string {
  if (!isValidNameSegment(plugin)) {
    throw new Error(`Invalid plugin name segment: ${plugin}`);
  }
  return path.join(getCatalogMarketplaceDir(marketplace), 'plugins', plugin);
}

export function getCatalogSnapshotDir(
  marketplace: string,
  plugin: string,
  contentHash: string,
): string {
  if (!isValidNameSegment(contentHash)) {
    throw new Error(`Invalid snapshot id: ${contentHash}`);
  }
  return path.join(
    getCatalogPluginDir(marketplace, plugin),
    'versions',
    contentHash,
  );
}

export function buildFullId(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}

/** Load the catalog index, returning EMPTY_INDEX on missing/malformed file. */
export function readCatalogIndex(): CatalogIndex {
  const file = getCatalogIndexFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ file, err }, 'plugin-catalog: index read failed');
    }
    return cloneEmpty();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { file, err },
      'plugin-catalog: index JSON parse failed, treating as empty',
    );
    return cloneEmpty();
  }
  const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (rec.schemaVersion !== 1) {
    logger.warn(
      { file, version: rec.schemaVersion },
      'plugin-catalog: unknown schemaVersion, treating as empty',
    );
    return cloneEmpty();
  }
  const out = cloneEmpty();
  out.lastScanAt =
    typeof rec.lastScanAt === 'string' ? rec.lastScanAt : null;
  if (rec.marketplaces && typeof rec.marketplaces === 'object') {
    out.marketplaces = rec.marketplaces as CatalogIndex['marketplaces'];
  }
  if (rec.plugins && typeof rec.plugins === 'object') {
    out.plugins = rec.plugins as CatalogIndex['plugins'];
  }
  return out;
}

function cloneEmpty(): CatalogIndex {
  return JSON.parse(JSON.stringify(EMPTY_INDEX));
}

/**
 * Atomic write: serialize → `.tmp` sibling → rename. Same fs guarantees
 * rename(2) atomicity, so concurrent readers never see a half-written index.
 * Caller must hold the scan mutex when this changes plugin/marketplace shape.
 */
export function writeCatalogIndex(idx: CatalogIndex): void {
  const file = getCatalogIndexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const content = JSON.stringify(idx, null, 2) + '\n';
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

export function listCatalog(): CatalogPluginEntry[] {
  const idx = readCatalogIndex();
  return Object.values(idx.plugins);
}

/**
 * Resolve the on-disk snapshot directory. Returns null if the snapshot id is
 * unknown to the index OR if the directory has been removed from disk.
 */
export function getSnapshotPath(
  marketplace: string,
  plugin: string,
  snapshotId: string,
): string | null {
  if (
    !isValidNameSegment(marketplace) ||
    !isValidNameSegment(plugin) ||
    !isValidNameSegment(snapshotId)
  ) {
    return null;
  }
  const dir = getCatalogSnapshotDir(marketplace, plugin, snapshotId);
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}
