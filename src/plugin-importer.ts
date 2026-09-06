/**
 * plugin-importer.ts
 *
 * Scan host marketplaces and import each plugin into the immutable catalog
 * snapshot tree. The set of marketplaces is the UNION of:
 *   - physical subdirs of `<externalDir>/plugins/marketplaces/` (where Claude
 *     Code clones github-source marketplaces), and
 *   - every `installLocation` registered in
 *     `<externalDir>/plugins/known_marketplaces.json` — the only place a
 *     `directory`-source marketplace (referenced in place, never copied into
 *     marketplaces/) is recorded.
 * `<externalDir>` defaults to `~/.claude`, overridable via
 * SystemSettings.externalClaudeDir.
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
  source?: { type: 'host-claude-dir' } | { type: 'directory'; path: string };
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
  const report: ImportReport = {
    marketplacesScanned: 0,
    pluginsScanned: 0,
    snapshotsCreated: 0,
    snapshotsSkipped: 0,
    warnings: [],
  };

  // Ensure catalog root exists so writes don't have to mkdir each time.
  fs.mkdirSync(getCatalogRoot(), { recursive: true });
  // Sweep stale .tmp-* directories left behind by SIGKILLed importers.
  // Cheap one-shot per scan; runtime sweep happens in plugin-utils.materialize.
  sweepStaleTmpDirs(getCatalogRoot(), report);

  const marketplaces = resolveMarketplaceDirs(opts, report);

  const idx = readCatalogIndex();

  for (const { name: mpName, dir: mpDir } of marketplaces) {
    if (!isValidNameSegment(mpName)) {
      report.warnings.push(`Skipped invalid marketplace name: ${mpName}`);
      continue;
    }
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
      report.warnings.push(`Marketplace "${mpName}" has no plugins/ directory`);
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

/** A marketplace root directory resolved for scanning. */
interface ResolvedMarketplace {
  name: string;
  /** Path to the marketplace root directory. */
  dir: string;
}

/**
 * Resolve the set of marketplace directories to scan, as the union of two
 * sources (deduped by name; the known-registry entry wins on collision —
 * github entries resolve to the same dir as the physical clone anyway):
 *
 *   (a) physical subdirectories of `<externalDir>/plugins/marketplaces/`, and
 *   (b) every `installLocation` in `<externalDir>/plugins/known_marketplaces
 *       .json`. This is the ONLY place a `directory`-source marketplace
 *       appears: Claude Code references it in place (never copying into
 *       marketplaces/), so a readdir of marketplaces/ alone can never discover
 *       it. `installLocation` points at the real on-disk dir for github AND
 *       directory sources, so it is a uniform anchor regardless of `source`
 *       shape.
 *
 * Non-fatal problems (unreadable marketplaces/ root, malformed
 * known_marketplaces.json) push a warning onto `report` so a partial host
 * layout is visible in the scan result rather than failing silently.
 */
function resolveMarketplaceDirs(
  opts: ScanOptions,
  report: ImportReport,
): ResolvedMarketplace[] {
  // Legacy explicit-directory source: treat the given path as a container root
  // whose subdirectories are marketplaces. Restricted to test/fixture use in production.
  if (opts.source && opts.source.type === 'directory') {
    const rawPath = opts.source.path;
    const isFixture =
      rawPath.includes('fixture') ||
      rawPath.includes('test') ||
      rawPath.includes('tmp') ||
      (process.env.HAPPYCLAW_REVIEW_FIXTURE_ROOT &&
        rawPath.startsWith(process.env.HAPPYCLAW_REVIEW_FIXTURE_ROOT));
    if (!isFixture && process.env.NODE_ENV === 'production') {
      report.warnings.push(
        `Local plugin directory scan is restricted to test fixtures; rejected: ${rawPath}`,
      );
      return [];
    }
    return readMarketplacesRoot(opts.source.path, report);
  }

  const pluginsBase = path.join(getEffectiveExternalDir(), 'plugins');
  const byName = new Map<string, ResolvedMarketplace>();

  // (a) physical marketplaces/ subdirs (github-source clones live here).
  for (const mp of readMarketplacesRoot(
    path.join(pluginsBase, 'marketplaces'),
    report,
  )) {
    byName.set(mp.name, mp);
  }

  // (b) known_marketplaces.json installLocation entries (directory sources
  // only appear here). Registry wins on name collision.
  for (const mp of readKnownMarketplaces(pluginsBase, report)) {
    byName.set(mp.name, mp);
  }

  return [...byName.values()];
}

/**
 * List the immediate subdirectories of a marketplaces container `root` as
 * candidate marketplaces. Names are NOT validated here — the caller's main
 * loop validates each `name` against `isValidNameSegment` and warns, matching
 * the historical behaviour. An unreadable `root` (e.g. a host with no
 * plugins/marketplaces dir) yields a warning + empty list rather than throwing.
 */
function readMarketplacesRoot(
  root: string,
  report: ImportReport,
): ResolvedMarketplace[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    const msg = `Marketplace root not readable at ${root}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.warn({ root, err }, 'plugin-importer: marketplace root unreadable');
    report.warnings.push(msg);
    return [];
  }
  return entries.map((name) => ({ name, dir: path.join(root, name) }));
}

/**
 * Read Claude Code's `<pluginsBase>/known_marketplaces.json` and return one
 * entry per registered marketplace, anchored on its `installLocation` (the
 * real on-disk path). Non-throwing: a missing file is normal (returns []); a
 * malformed file warns and returns []. Names are validated by the caller.
 */
function readKnownMarketplaces(
  pluginsBase: string,
  report: ImportReport,
): ResolvedMarketplace[] {
  const file = path.join(pluginsBase, 'known_marketplaces.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    // No registry file (or unreadable). Normal on hosts that only have
    // marketplaces/ clones — not worth a warning.
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = `known_marketplaces.json parse failed at ${file}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.warn(
      { file, err },
      'plugin-importer: known_marketplaces.json parse failed',
    );
    report.warnings.push(msg);
    return [];
  }
  // Reject arrays too (`typeof [] === 'object'`): a CC registry is always an
  // object map. An array would otherwise fall through to Object.entries() and
  // be iterated as bogus marketplaces named "0", "1", … (numeric keys pass
  // isValidNameSegment).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const out: ResolvedMarketplace[] = [];
  for (const [name, rawEntry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const loc = (rawEntry as Record<string, unknown>).installLocation;
    if (typeof loc !== 'string' || loc.length === 0) continue;
    // installLocation is documented as absolute; resolve defensively against
    // the plugins dir if a relative path ever slips through (CC issue #23978).
    const dir = path.isAbsolute(loc) ? loc : path.resolve(pluginsBase, loc);
    out.push({ name, dir });
  }
  return out;
}

interface ImportPluginArgs {
  marketplace: string;
  plugin: string;
  pluginDir: string;
  manifest: { name: string; version?: string; description?: string };
  idx: CatalogIndex;
  report: ImportReport;
}

const SENSITIVE_KEY_RE =
  /(token|key|secret|pass(word)?|auth|cred(ential)?|api[-_]?key|access[-_]?key|sentinel|private)/i;

const PLACEHOLDER_VALUE_RE =
  /^(your[-_]?(api[-_]?key|token|secret|password|key|here)|placeholder|xxx+|<.+>|replace[-_]?me|change[-_]?me|example|dummy|\$\{.*\}|secret:\/\/.*)$/i;

function isExampleConfigFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.example') ||
    lower.endsWith('.sample') ||
    lower.endsWith('.template') ||
    lower.includes('.example.') ||
    lower.includes('.sample.')
  );
}

function isPlaintextCredentialCandidate(key: string, value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length < 3) return false;
  if (PLACEHOLDER_VALUE_RE.test(trimmed)) return false;
  if (SENSITIVE_KEY_RE.test(key)) return true;
  if (
    /^(sk-[a-zA-Z0-9_-]{10,}|gh[pousr]_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9a-zA-Z-]{10,})/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

function detectAndSanitizeCredentials(
  pluginDir: string,
  pluginName: string,
  marketplaceName: string,
  report: ImportReport,
): void {
  const fullId = `${pluginName}@${marketplaceName}`;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.env') && !isExampleConfigFile(name)) {
      const envPath = path.join(pluginDir, name);
      let content = '';
      try {
        content = fs.readFileSync(envPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const sanitizedLines: string[] = [];
      const detectedKeys: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          sanitizedLines.push(line);
          continue;
        }

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) {
          sanitizedLines.push(line);
          continue;
        }

        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }

        if (isPlaintextCredentialCandidate(key, val)) {
          detectedKeys.push(key);
          // 清洗为每用户 Secret 引用 ${KEY}
          sanitizedLines.push(`${key}=\${${key}}`);
        } else {
          sanitizedLines.push(line);
        }
      }

      if (detectedKeys.length > 0) {
        fs.writeFileSync(envPath, sanitizedLines.join('\n'), 'utf-8');
        report.warnings.push(
          `Plugin "${fullId}" credential preflight: detected plaintext credential candidate in "${name}" (${detectedKeys.join(', ')}); sanitized with per-user secret reference for shared catalog.`,
        );
      }
    }
  }

  // 检查 .mcp.json
  const mcpPath = path.join(pluginDir, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf-8');
      const mcpJson = JSON.parse(raw) as Record<string, unknown>;
      const servers = mcpJson.mcpServers as
        | Record<string, Record<string, unknown>>
        | undefined;
      const detectedMcpEntries: string[] = [];

      if (servers && typeof servers === 'object') {
        for (const [srvName, srvDef] of Object.entries(servers)) {
          if (!srvDef || typeof srvDef !== 'object') continue;

          if (srvDef.env && typeof srvDef.env === 'object') {
            const envObj = srvDef.env as Record<string, string>;
            for (const [k, v] of Object.entries(envObj)) {
              if (isPlaintextCredentialCandidate(k, String(v))) {
                detectedMcpEntries.push(`${srvName}.env.${k}`);
                envObj[k] = `\${${k}}`;
              }
            }
          }

          if (srvDef.headers && typeof srvDef.headers === 'object') {
            const headersObj = srvDef.headers as Record<string, string>;
            for (const [k, v] of Object.entries(headersObj)) {
              if (
                SENSITIVE_KEY_RE.test(k) ||
                isPlaintextCredentialCandidate(k, String(v))
              ) {
                detectedMcpEntries.push(`${srvName}.headers.${k}`);
                headersObj[k] = `\${${k}}`;
              }
            }
          }
        }
      }

      if (detectedMcpEntries.length > 0) {
        fs.writeFileSync(mcpPath, JSON.stringify(mcpJson, null, 2), 'utf-8');
        report.warnings.push(
          `Plugin "${fullId}" credential preflight: detected plaintext credential candidate in ".mcp.json" (${detectedMcpEntries.join(', ')}); sanitized with per-user secret reference for shared catalog.`,
        );
      }
    } catch {
      // ignore json parse error
    }
  }
}

/**
 * Import one plugin: hash sources, see if catalog already has that snapshot,
 * if not copy to a tmp dir then atomic-rename into `versions/{hash}/`.
 */
async function importPluginSnapshot(args: ImportPluginArgs): Promise<void> {
  const { marketplace, plugin, pluginDir, manifest, idx, report } = args;

  fs.mkdirSync(getCatalogRoot(), { recursive: true });
  const tmpDir = path.join(
    getCatalogRoot(),
    `.tmp-preflight-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  let snapshotId: string;
  let targetDir: string;
  const fullId = buildFullId(plugin, marketplace);

  try {
    copyDirectoryFiltered(pluginDir, tmpDir);
    verifyManifestPresent(tmpDir);
    detectAndSanitizeCredentials(tmpDir, plugin, marketplace, report);

    const contentHash = await hashDirectoryContents(tmpDir);
    snapshotId = `sha256-${contentHash.slice(0, 32)}`;
    targetDir = getCatalogSnapshotDir(marketplace, plugin, snapshotId);

    if (fs.existsSync(targetDir)) {
      report.snapshotsSkipped += 1;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(tmpDir, targetDir);
      report.snapshotsCreated += 1;
    }
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    throw err;
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
export async function hashDirectoryContents(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const entries = collectFiles(rootDir, '');
  // Sorted by relative path for determinism across filesystems.
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const e of entries) {
    hash.update(e.rel);
    hash.update('\0');
    // Stream the file rather than fs.readFileSync — large hooks/scripts
    // (binaries, embedded assets) shouldn't pull whole files into memory.
    // Byte stream identical to the legacy readFileSync path: each chunk
    // is fed to hash.update() in order, so the resulting digest is
    // byte-for-byte equivalent (verified by the compat regression test).
    await new Promise<void>((resolve, reject) => {
      // Explicit highWaterMark + no encoding => chunks are always Buffer (raw
      // bytes), matching the legacy fs.readFileSync(buffer) path byte-for-byte.
      // If encoding were left to default and a future caller mutated the
      // readable's encoding, hash.update(string) would re-encode through
      // utf-8, breaking binary hashes (codex review hardening).
      const stream = fs.createReadStream(e.abs, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk: Buffer | string) => {
        // Runtime-narrowed: with no encoding set on the stream, Node always
        // emits Buffer chunks. The Buffer | string parameter type is forced
        // by @types/node's ReadStream 'data' event signature; we re-assert
        // Buffer here so hash.update() takes the raw byte path (no utf-8
        // re-encoding). If a future caller flips the encoding, route the
        // failure through `stream.destroy(err)` so the 'error' listener
        // rejects the outer Promise — throwing from a 'data' listener
        // bypasses EventEmitter's error path and surfaces as a process-
        // level uncaughtException instead of a recoverable scan failure.
        if (typeof chunk === 'string') {
          stream.destroy(
            new Error(
              'plugin-importer hash stream got string chunk; expected Buffer',
            ),
          );
          return;
        }
        hash.update(chunk);
      });
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
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

/**
 * 删除 catalog 下因 importer 被 SIGKILL 留下的 `.tmp-` 临时目录。
 *
 * **不是**全树扫描：那会误伤 plugin 内部含 `.tmp-`/`.legacy-bak@` 子串的
 * 文件名（README.tmp-2025.md / scripts/build.tmp-stage.sh / archive.legacy-bak@v1
 * 等）。importer 实际只在 `versions/` 这一级创建临时目录，命名形如
 * `sha256-<hash>.tmp-<pid>-<ms>`，所以扫描限定在 `marketplaces/<mp>/plugins/<plugin>/versions/`
 * 这一级，且仅匹配 importer 真实使用的命名。一次性、廉价。
 */
function sweepStaleTmpDirs(catalogRoot: string, report?: ImportReport): void {
  // importer 命名形态：sha256-<hex>.tmp-<pid>-<ms>
  const TMP_RE = /^sha256-[0-9a-f]+\.tmp-/;
  let removed = 0;
  const marketplacesRoot = path.join(catalogRoot, 'marketplaces');
  let mpEntries: fs.Dirent[];
  try {
    mpEntries = fs.readdirSync(marketplacesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const mpEntry of mpEntries) {
    if (!mpEntry.isDirectory()) continue;
    const pluginsRoot = path.join(marketplacesRoot, mpEntry.name, 'plugins');
    let pluginEntries: fs.Dirent[];
    try {
      pluginEntries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pluginEntry of pluginEntries) {
      if (!pluginEntry.isDirectory()) continue;
      const versionsRoot = path.join(pluginsRoot, pluginEntry.name, 'versions');
      let versionEntries: fs.Dirent[];
      try {
        versionEntries = fs.readdirSync(versionsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const v of versionEntries) {
        if (!v.isDirectory()) continue;
        if (!TMP_RE.test(v.name)) continue;
        try {
          fs.rmSync(path.join(versionsRoot, v.name), {
            recursive: true,
            force: true,
          });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (removed > 0 && report) {
    report.warnings.push(`Swept ${removed} stale .tmp- snapshot dirs`);
  }
}

/** Re-export helper used by catalog plugin dir lookups. */
export { getCatalogPluginDir };
