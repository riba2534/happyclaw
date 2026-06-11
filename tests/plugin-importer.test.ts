import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDataDir: string;
let tmpHostDir: string;

vi.mock('../src/config.js', () => ({
  get DATA_DIR() {
    return tmpDataDir;
  },
}));

vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => tmpHostDir,
}));

const importer = await import('../src/plugin-importer.js');
const catalog = await import('../src/plugin-catalog.js');
const { scanHostMarketplaces, hashDirectoryContents } = importer;
const { readCatalogIndex, getCatalogSnapshotDir } = catalog;

/** Seed a marketplace under an arbitrary container `baseDir`. */
function seedMarketplaceAt(opts: {
  baseDir: string;
  marketplace: string;
  plugin: string;
  pluginManifest: Record<string, unknown>;
  marketplaceManifest?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  const mpDir = path.join(opts.baseDir, opts.marketplace);
  const pluginDir = path.join(mpDir, 'plugins', opts.plugin);
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(opts.pluginManifest),
  );
  if (opts.marketplaceManifest) {
    fs.mkdirSync(path.join(mpDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(mpDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(opts.marketplaceManifest),
    );
  }
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const full = path.join(pluginDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return { mpDir, pluginDir };
}

/** Seed a marketplace under the conventional `<host>/plugins/marketplaces/`. */
function seedHostPlugin(opts: {
  marketplace: string;
  plugin: string;
  pluginManifest: Record<string, unknown>;
  marketplaceManifest?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  const { pluginDir } = seedMarketplaceAt({
    ...opts,
    baseDir: path.join(tmpHostDir, 'plugins', 'marketplaces'),
  });
  return pluginDir;
}

/** Ensure an empty `<host>/plugins/marketplaces/` exists (no clones). */
function seedEmptyMarketplacesRoot(): void {
  fs.mkdirSync(path.join(tmpHostDir, 'plugins', 'marketplaces'), {
    recursive: true,
  });
}

/** Write `<host>/plugins/known_marketplaces.json` (Claude Code's registry). */
function seedKnownMarketplaces(entries: Record<string, unknown>): void {
  seedKnownMarketplacesRaw(JSON.stringify(entries));
}

function seedKnownMarketplacesRaw(raw: string): void {
  const file = path.join(tmpHostDir, 'plugins', 'known_marketplaces.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
}

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-imp-data-'));
  tmpHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-imp-host-'));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpHostDir, { recursive: true, force: true });
});

describe('hashDirectoryContents', () => {
  test('produces stable hash + ignores .git/.DS_Store/node_modules', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-b-'));
    try {
      fs.writeFileSync(path.join(a, 'one.md'), 'hello');
      fs.mkdirSync(path.join(a, 'sub'));
      fs.writeFileSync(path.join(a, 'sub', 'two.md'), 'world');

      // b has same payload + extra excluded files
      fs.writeFileSync(path.join(b, 'one.md'), 'hello');
      fs.mkdirSync(path.join(b, 'sub'));
      fs.writeFileSync(path.join(b, 'sub', 'two.md'), 'world');
      fs.mkdirSync(path.join(b, '.git'));
      fs.writeFileSync(path.join(b, '.git', 'HEAD'), 'ref: refs/heads/main');
      fs.writeFileSync(path.join(b, '.DS_Store'), 'mac junk');
      fs.mkdirSync(path.join(b, 'node_modules', 'foo'), { recursive: true });
      fs.writeFileSync(path.join(b, 'node_modules', 'foo', 'pkg.js'), 'x');

      expect(await hashDirectoryContents(a)).toBe(await hashDirectoryContents(b));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('hash differs when content changes', async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-c-'));
    try {
      fs.writeFileSync(path.join(a, 'one.md'), 'first');
      const h1 = await hashDirectoryContents(a);
      fs.writeFileSync(path.join(a, 'one.md'), 'second');
      const h2 = await hashDirectoryContents(a);
      expect(h1).not.toBe(h2);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
    }
  });

  test('stream hash matches the legacy readFileSync algorithm byte-for-byte', async () => {
    // CRITICAL: hashDirectoryContents output is the snapshotId. If the new
    // streaming algorithm diverges from the old readFileSync algorithm by
    // even a single byte, every existing user's plugin snapshot would be
    // identified as a new version → catalog mass rebuild. This test pins
    // byte-equivalence between the two implementations across realistic
    // plugin shapes (small text, medium binary, large binary).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-compat-'));
    try {
      fs.writeFileSync(path.join(dir, 'small.md'), 'hello');
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'medium.txt'), Buffer.alloc(64 * 1024, 0x42));
      fs.writeFileSync(path.join(dir, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 0xab));

      // Legacy algorithm reproduced inline. Mirrors src/plugin-importer.ts
      // pre-stream behaviour, including HASH_EXCLUDES and the
      // lstatSync + skip-symlink directory walk (statSync would follow
      // symlinks and silently diverge from the production algorithm).
      function legacyHash(rootDir: string): string {
        const hash = crypto.createHash('sha256');
        const entries: { rel: string; abs: string }[] = [];
        function walk(prefix: string) {
          const names = fs.readdirSync(path.join(rootDir, prefix));
          for (const name of names) {
            if (name === '.git' || name === '.DS_Store' || name === 'node_modules') continue;
            const rel = prefix ? `${prefix}/${name}` : name;
            const abs = path.join(rootDir, rel);
            const stat = fs.lstatSync(abs);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) walk(rel);
            else if (stat.isFile()) entries.push({ rel, abs });
          }
        }
        walk('');
        entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        for (const e of entries) {
          hash.update(e.rel);
          hash.update('\0');
          hash.update(fs.readFileSync(e.abs));
          hash.update('\0');
        }
        return hash.digest('hex');
      }

      const expected = legacyHash(dir);
      const actual = await hashDirectoryContents(dir);
      expect(actual).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hashes large files through the stream path', async () => {
    // 8MB triggers the multi-chunk read path: with the stream's
    // highWaterMark = 64KB, this file produces 128 chunks, exercising
    // the per-chunk hash.update loop without slowing CI on smaller
    // boxes. Production plugins with much larger embedded resources
    // hit the same code path with more iterations.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-stream-'));
    try {
      fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 0xcd));
      const h = await hashDirectoryContents(dir);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects (does not crash) when the stream emits a string chunk', async () => {
    // Defensive guard: hashDirectoryContents pins chunks to Buffer by
    // setting highWaterMark and not passing encoding. If a future caller
    // flips the encoding upstream and a string chunk reaches the 'data'
    // handler, the implementation calls stream.destroy(err) so the
    // 'error' listener rejects the outer Promise. A naive `throw` from
    // the listener would surface as uncaughtException and crash the
    // host process — this test pins that behaviour so the safety
    // contract can't regress silently.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'one.txt'), 'data');
      const spy = vi
        .spyOn(fs, 'createReadStream')
        .mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((..._args: unknown[]) =>
            Readable.from(['this-should-be-a-buffer-but-isnt'])) as any,
        );
      try {
        await expect(hashDirectoryContents(dir)).rejects.toThrow(
          /string chunk/i,
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scanHostMarketplaces', () => {
  test('imports plugin into immutable snapshot dir', async () => {
    seedHostPlugin({
      marketplace: 'openai-codex',
      plugin: 'codex',
      marketplaceManifest: {
        name: 'openai-codex',
        owner: { name: 'OpenAI' },
        metadata: { version: '1.0.3', description: 'codex marketplace' },
      },
      pluginManifest: {
        name: 'codex',
        version: '1.0.3',
        description: 'codex plugin',
      },
      files: {
        'commands/status.md': 'status body',
        'commands/cancel.md': 'cancel body',
      },
    });

    const report = await scanHostMarketplaces();
    expect(report.marketplacesScanned).toBe(1);
    expect(report.pluginsScanned).toBe(1);
    expect(report.snapshotsCreated).toBe(1);
    expect(report.snapshotsSkipped).toBe(0);

    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins)).toEqual(['codex@openai-codex']);
    const entry = idx.plugins['codex@openai-codex'];
    const snapshotId = entry.activeSnapshot;
    expect(snapshotId.startsWith('sha256-')).toBe(true);
    expect(entry.snapshots[snapshotId].assetCounts.commands).toBe(2);

    const snapshotDir = getCatalogSnapshotDir(
      'openai-codex',
      'codex',
      snapshotId,
    );
    expect(
      fs.existsSync(
        path.join(snapshotDir, '.claude-plugin', 'plugin.json'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(snapshotDir, 'commands', 'status.md')),
    ).toBe(true);

    // No leftover .tmp directories at the versions/ level.
    const versionsDir = path.dirname(snapshotDir);
    const leftovers = fs
      .readdirSync(versionsDir)
      .filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('second identical scan skips snapshot creation', async () => {
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'body' },
    });
    const r1 = await scanHostMarketplaces();
    expect(r1.snapshotsCreated).toBe(1);
    expect(r1.snapshotsSkipped).toBe(0);

    const r2 = await scanHostMarketplaces();
    expect(r2.snapshotsCreated).toBe(0);
    expect(r2.snapshotsSkipped).toBe(1);
  });

  test('content change creates a new snapshot dir without overwriting old', async () => {
    const pluginDir = seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'first' },
    });
    const r1 = await scanHostMarketplaces();
    const idx1 = readCatalogIndex();
    const snap1 = idx1.plugins['p1@mp1'].activeSnapshot;

    fs.writeFileSync(path.join(pluginDir, 'commands', 'run.md'), 'second');
    const r2 = await scanHostMarketplaces();
    expect(r2.snapshotsCreated).toBe(1);
    const idx2 = readCatalogIndex();
    const snap2 = idx2.plugins['p1@mp1'].activeSnapshot;
    expect(snap1).not.toBe(snap2);

    // Old snapshot must still exist (immutable).
    expect(
      fs.existsSync(getCatalogSnapshotDir('mp1', 'p1', snap1)),
    ).toBe(true);
    expect(
      fs.existsSync(getCatalogSnapshotDir('mp1', 'p1', snap2)),
    ).toBe(true);
    expect(Object.keys(idx2.plugins['p1@mp1'].snapshots).sort()).toEqual(
      [snap1, snap2].sort(),
    );
  });

  test('rollback to a previously-imported hash re-pins activeSnapshot to that hash', async () => {
    // Plan: scan v1 → bump file → scan v2 → revert file → scan again. The
    // last scan finds an already-on-disk snapshot (skip path), but
    // activeSnapshot must follow the most recently observed content rather
    // than staying stuck on v2.
    const pluginDir = seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'v1' },
    });
    await scanHostMarketplaces();
    const v1Snap = readCatalogIndex().plugins['p1@mp1'].activeSnapshot;

    fs.writeFileSync(path.join(pluginDir, 'commands', 'run.md'), 'v2');
    await scanHostMarketplaces();
    const v2Snap = readCatalogIndex().plugins['p1@mp1'].activeSnapshot;
    expect(v2Snap).not.toBe(v1Snap);

    // Revert file to v1 contents — the v1 snapshot dir is already on disk so
    // the importer hits the skip path. activeSnapshot must still flip back
    // to the v1 hash.
    fs.writeFileSync(path.join(pluginDir, 'commands', 'run.md'), 'v1');
    const report = await scanHostMarketplaces();
    expect(report.snapshotsSkipped).toBe(1);
    expect(report.snapshotsCreated).toBe(0);

    const finalIdx = readCatalogIndex();
    expect(finalIdx.plugins['p1@mp1'].activeSnapshot).toBe(v1Snap);
    // Both versions remain navigable.
    expect(Object.keys(finalIdx.plugins['p1@mp1'].snapshots).sort()).toEqual(
      [v1Snap, v2Snap].sort(),
    );
  });

  test('skips invalid name segments and missing manifests with warnings', async () => {
    // Invalid marketplace name segment (contains space)
    const badMpDir = path.join(
      tmpHostDir,
      'plugins',
      'marketplaces',
      'bad name',
    );
    fs.mkdirSync(path.join(badMpDir, 'plugins', 'x'), { recursive: true });

    // Valid marketplace, but plugin without manifest. No marketplace.json
    // entry classifying the plugin → treated as orphan inline → warns.
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'noManifest',
      pluginManifest: {} as Record<string, unknown>,
    });
    fs.rmSync(
      path.join(
        tmpHostDir,
        'plugins',
        'marketplaces',
        'mp1',
        'plugins',
        'noManifest',
        '.claude-plugin',
      ),
      { recursive: true, force: true },
    );

    const r = await scanHostMarketplaces();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(
      r.warnings.some((w) => w.includes('bad name')),
    ).toBe(true);
    expect(
      r.warnings.some((w) =>
        w.includes('noManifest') && w.includes('plugin.json'),
      ),
    ).toBe(true);
  });

  test('silently skips placeholder dirs declared in marketplace.json (any source kind)', async () => {
    // Claude Code's CLI lays out one host dir per declared plugin
    // (LICENSE/README) and only populates `.claude-plugin/plugin.json`
    // after `/plugin install`. Until then the dir is a placeholder — not a
    // broken plugin. Importer must skip silently for all source kinds
    // (inline / url / git-subdir) when the entry is declared in
    // marketplace.json.
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'inline-ok',
      pluginManifest: { name: 'inline-ok', version: '1.0.0' },
      marketplaceManifest: {
        name: 'mp1',
        plugins: [
          { name: 'inline-ok', source: './plugins/inline-ok' },
          { name: 'inline-placeholder', source: './plugins/inline-placeholder' },
          { name: 'remote-url', source: { source: 'url', url: 'https://x' } },
          {
            name: 'remote-subdir',
            source: { source: 'git-subdir', url: 'https://x', path: 'a' },
          },
        ],
      },
    });
    for (const name of ['inline-placeholder', 'remote-url', 'remote-subdir']) {
      fs.mkdirSync(
        path.join(tmpHostDir, 'plugins', 'marketplaces', 'mp1', 'plugins', name),
        { recursive: true },
      );
    }

    const r = await scanHostMarketplaces();

    expect(r.pluginsScanned).toBe(1);
    for (const name of ['inline-placeholder', 'remote-url', 'remote-subdir']) {
      expect(
        r.warnings.some((w) => w.includes(name)),
      ).toBe(false);
    }

    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins)).toEqual(['inline-ok@mp1']);
  });

  test('warns on undeclared orphan dirs (no marketplace.json entry)', async () => {
    // Plugin dir present on disk but missing from marketplace.json's
    // plugins[]. This is a real authoring/cleanup bug worth surfacing.
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'declared-ok',
      pluginManifest: { name: 'declared-ok', version: '1.0.0' },
      marketplaceManifest: {
        name: 'mp1',
        plugins: [{ name: 'declared-ok', source: './plugins/declared-ok' }],
      },
    });
    // Orphan dir
    fs.mkdirSync(
      path.join(tmpHostDir, 'plugins', 'marketplaces', 'mp1', 'plugins', 'orphan'),
      { recursive: true },
    );

    const r = await scanHostMarketplaces();
    expect(
      r.warnings.some(
        (w) => w.includes('orphan') && w.includes('plugin.json'),
      ),
    ).toBe(true);
  });

  test('concurrent calls share the same in-flight Promise', async () => {
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'body' },
    });
    const [a, b] = await Promise.all([
      scanHostMarketplaces(),
      scanHostMarketplaces(),
    ]);
    expect(a).toBe(b);
    expect(a.snapshotsCreated + a.snapshotsSkipped).toBe(1);
  });

  test('missing host root produces a warning, not a throw', async () => {
    // tmpHostDir exists but has no plugins/marketplaces subdir AND no
    // known_marketplaces.json — nothing to scan, but must warn not throw.
    const r = await scanHostMarketplaces();
    expect(r.marketplacesScanned).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('discovers a directory-source marketplace via known_marketplaces.json', async () => {
    // wx-cli style: the marketplace lives OUTSIDE plugins/marketplaces/ and is
    // registered only by its installLocation in known_marketplaces.json. A
    // readdir of marketplaces/ alone (old behaviour) could never find it.
    seedEmptyMarketplacesRoot();
    const { mpDir } = seedMarketplaceAt({
      baseDir: path.join(tmpHostDir, 'external'),
      marketplace: 'wx-cli',
      plugin: 'wx-cli',
      pluginManifest: { name: 'wx-cli', version: '0.2.0' },
      files: { 'commands/send.md': 'send body' },
    });
    seedKnownMarketplaces({
      'wx-cli': {
        source: { source: 'directory', path: mpDir },
        installLocation: mpDir,
      },
    });

    const report = await scanHostMarketplaces();
    expect(report.marketplacesScanned).toBe(1);
    expect(report.pluginsScanned).toBe(1);
    expect(report.snapshotsCreated).toBe(1);

    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins)).toEqual(['wx-cli@wx-cli']);
    expect(idx.marketplaces['wx-cli'].sourcePath).toBe(mpDir);
  });

  test('unions marketplaces/ clones with known_marketplaces.json directory sources', async () => {
    // (a) a github-style clone physically under marketplaces/
    seedHostPlugin({
      marketplace: 'official',
      plugin: 'p-official',
      pluginManifest: { name: 'p-official', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    // (b) a directory-source marketplace registered elsewhere
    const { mpDir } = seedMarketplaceAt({
      baseDir: path.join(tmpHostDir, 'external'),
      marketplace: 'local-dir',
      plugin: 'p-local',
      pluginManifest: { name: 'p-local', version: '1.0.0' },
      files: { 'commands/b.md': 'b' },
    });
    seedKnownMarketplaces({ 'local-dir': { installLocation: mpDir } });

    const report = await scanHostMarketplaces();
    expect(report.marketplacesScanned).toBe(2);
    expect(report.pluginsScanned).toBe(2);

    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins).sort()).toEqual(
      ['p-local@local-dir', 'p-official@official'].sort(),
    );
  });

  test('dedupes a marketplace present in both marketplaces/ and known_marketplaces.json', async () => {
    // github sources appear in BOTH: a physical clone under marketplaces/ AND
    // a known_marketplaces.json entry whose installLocation points at that same
    // dir. Must scan/import once — never double-count or double-import.
    seedHostPlugin({
      marketplace: 'official',
      plugin: 'codex',
      pluginManifest: { name: 'codex', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    const physicalDir = path.join(
      tmpHostDir,
      'plugins',
      'marketplaces',
      'official',
    );
    seedKnownMarketplaces({
      official: {
        source: { source: 'github', repo: 'x/official' },
        installLocation: physicalDir,
      },
    });

    const report = await scanHostMarketplaces();
    expect(report.marketplacesScanned).toBe(1);
    expect(report.pluginsScanned).toBe(1);
    expect(report.snapshotsCreated).toBe(1);

    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins)).toEqual(['codex@official']);
    // Single marketplace row too — not just a single plugin key.
    expect(Object.keys(idx.marketplaces)).toEqual(['official']);
  });

  test('falls back to marketplaces/ only when known_marketplaces.json is absent', async () => {
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'body' },
    });
    // No seedKnownMarketplaces() → registry file absent. Must not warn or crash.
    const report = await scanHostMarketplaces();
    expect(report.marketplacesScanned).toBe(1);
    expect(report.pluginsScanned).toBe(1);
    expect(
      report.warnings.some((w) => w.includes('known_marketplaces')),
    ).toBe(false);
  });

  test('malformed known_marketplaces.json warns but does not block marketplaces/ scan', async () => {
    seedHostPlugin({
      marketplace: 'mp1',
      plugin: 'p1',
      pluginManifest: { name: 'p1', version: '1.0.0' },
      files: { 'commands/run.md': 'body' },
    });
    seedKnownMarketplacesRaw('{ not valid json');

    const report = await scanHostMarketplaces();
    // marketplaces/ clone still imported despite the bad registry file.
    expect(report.pluginsScanned).toBe(1);
    expect(
      report.warnings.some((w) => w.includes('known_marketplaces.json')),
    ).toBe(true);
  });

  test('resolves a relative installLocation against the plugins dir', async () => {
    // Defensive: CC normally writes absolute paths, but guard the relative
    // case (CC issue #23978). 'rel-mp' resolves to <host>/plugins/rel-mp.
    seedEmptyMarketplacesRoot();
    const { mpDir } = seedMarketplaceAt({
      baseDir: path.join(tmpHostDir, 'plugins'),
      marketplace: 'rel-mp',
      plugin: 'p-rel',
      pluginManifest: { name: 'p-rel', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    seedKnownMarketplaces({ 'rel-mp': { installLocation: 'rel-mp' } });

    const report = await scanHostMarketplaces();
    expect(report.pluginsScanned).toBe(1);
    const idx = readCatalogIndex();
    expect(Object.keys(idx.plugins)).toEqual(['p-rel@rel-mp']);
    expect(idx.marketplaces['rel-mp'].sourcePath).toBe(mpDir);
  });

  test('skips registry entries with missing/empty/non-string installLocation or non-object value', async () => {
    // Exercises every per-entry guard in readKnownMarketplaces: a missing
    // installLocation, empty string, non-string, null entry and primitive
    // entry must all be skipped (no throw) while valid entries still import.
    // The empty-string case is load-bearing: without the `length === 0` guard,
    // '' would resolve to the plugins base dir itself and pollute the catalog.
    seedHostPlugin({
      marketplace: 'clone',
      plugin: 'p-clone',
      pluginManifest: { name: 'p-clone', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    const { mpDir } = seedMarketplaceAt({
      baseDir: path.join(tmpHostDir, 'external'),
      marketplace: 'good',
      plugin: 'p-good',
      pluginManifest: { name: 'p-good', version: '1.0.0' },
      files: { 'commands/b.md': 'b' },
    });
    seedKnownMarketplaces({
      good: { installLocation: mpDir },
      noLoc: { source: { source: 'github', repo: 'x/y' } },
      emptyLoc: { installLocation: '' },
      numLoc: { installLocation: 123 },
      nullEntry: null,
      strEntry: 'oops',
    });

    const report = await scanHostMarketplaces();
    // Only the clone + 'good' import; the five malformed entries are skipped.
    expect(report.marketplacesScanned).toBe(2);
    expect(report.pluginsScanned).toBe(2);
    const idx = readCatalogIndex();
    expect(Object.keys(idx.marketplaces).sort()).toEqual(['clone', 'good']);
  });

  test('skips a stale installLocation (deleted dir or a regular file) without throwing', async () => {
    // The directory-source feature's most likely real-world failure mode: a
    // registry entry whose installLocation was removed, or now points at a
    // file. readKnownMarketplaces does not stat — runScan's statSync (throw →
    // continue) and !isDirectory() guards must absorb both, no bogus count.
    seedHostPlugin({
      marketplace: 'clone',
      plugin: 'p-clone',
      pluginManifest: { name: 'p-clone', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    const ghostDir = path.join(tmpHostDir, 'external', 'ghost'); // never created
    const filePath = path.join(tmpHostDir, 'external', 'not-a-dir');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'i am a file');
    seedKnownMarketplaces({
      ghost: { installLocation: ghostDir },
      fileMp: { installLocation: filePath },
    });

    const report = await scanHostMarketplaces();
    // Both stale entries skipped; only the marketplaces/ clone imports.
    expect(report.marketplacesScanned).toBe(1);
    expect(report.pluginsScanned).toBe(1);
    const idx = readCatalogIndex();
    expect(Object.keys(idx.marketplaces)).toEqual(['clone']);
  });

  test('rejects an array-shaped known_marketplaces.json without polluting the catalog', async () => {
    // `typeof [] === 'object'`, so without the Array.isArray guard an array
    // registry would be iterated as marketplaces named "0", "1", …
    seedHostPlugin({
      marketplace: 'clone',
      plugin: 'p-clone',
      pluginManifest: { name: 'p-clone', version: '1.0.0' },
      files: { 'commands/a.md': 'a' },
    });
    const { mpDir } = seedMarketplaceAt({
      baseDir: path.join(tmpHostDir, 'external'),
      marketplace: 'arr',
      plugin: 'p-arr',
      pluginManifest: { name: 'p-arr', version: '1.0.0' },
    });
    seedKnownMarketplacesRaw(JSON.stringify([{ installLocation: mpDir }]));

    const report = await scanHostMarketplaces();
    // Array registry ignored; only the marketplaces/ clone imports.
    expect(report.pluginsScanned).toBe(1);
    const idx = readCatalogIndex();
    expect(Object.keys(idx.marketplaces)).toEqual(['clone']);
    expect(idx.marketplaces['0']).toBeUndefined();
  });
});
