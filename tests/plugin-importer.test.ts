import fs from 'fs';
import os from 'os';
import path from 'path';

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

function seedHostPlugin(opts: {
  marketplace: string;
  plugin: string;
  pluginManifest: Record<string, unknown>;
  marketplaceManifest?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  const mpDir = path.join(
    tmpHostDir,
    'plugins',
    'marketplaces',
    opts.marketplace,
  );
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
  return pluginDir;
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
  test('produces stable hash + ignores .git/.DS_Store/node_modules', () => {
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

      expect(hashDirectoryContents(a)).toBe(hashDirectoryContents(b));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('hash differs when content changes', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-c-'));
    try {
      fs.writeFileSync(path.join(a, 'one.md'), 'first');
      const h1 = hashDirectoryContents(a);
      fs.writeFileSync(path.join(a, 'one.md'), 'second');
      const h2 = hashDirectoryContents(a);
      expect(h1).not.toBe(h2);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
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

    // Valid marketplace, but plugin without manifest
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
    // tmpHostDir exists but has no plugins/marketplaces subdir
    const r = await scanHostMarketplaces();
    expect(r.marketplacesScanned).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
