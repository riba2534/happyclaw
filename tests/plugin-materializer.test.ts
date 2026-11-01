import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDataDir: string;

vi.mock('../src/config.js', () => ({
  get DATA_DIR() {
    return tmpDataDir;
  },
}));

const materializer = await import('../src/plugin-materializer.js');
const catalog = await import('../src/plugin-catalog.js');
const utils = await import('../src/plugin-utils.js');

const {
  materializeUserRuntime,
  cleanupOrphanRuntime,
  getUserRuntimeRoot,
  getUserSnapshotsDir,
  getUserPluginRuntimeDir,
} = materializer;

const { writeCatalogIndex, getCatalogSnapshotDir } = catalog;
const { writeUserPluginsV2 } = utils;

const USER = 'alice';

/** Create a fully-formed catalog snapshot on disk + register it in the index. */
function seedCatalogSnapshot(opts: {
  marketplace: string;
  plugin: string;
  snapshot: string;
  /** Extra files to drop alongside .claude-plugin/plugin.json. */
  files?: Record<string, string>;
}): string {
  const dir = getCatalogSnapshotDir(
    opts.marketplace,
    opts.plugin,
    opts.snapshot,
  );
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: opts.plugin, version: '1.0.0' }),
  );
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  // Register so consumers (loadUserPlugins / migrate) can find it. Direct
  // disk-only setup is not enough — getSnapshotPath checks the index.
  const idx = catalog.readCatalogIndex();
  const fullId = `${opts.plugin}@${opts.marketplace}`;
  idx.marketplaces[opts.marketplace] ??= {
    name: opts.marketplace,
    sourcePath: '/host/fake',
    lastImportedAt: '2026-04-26T00:00:00.000Z',
  };
  const entry = idx.plugins[fullId] ?? {
    marketplace: opts.marketplace,
    plugin: opts.plugin,
    fullId,
    activeSnapshot: opts.snapshot,
    snapshots: {},
  };
  entry.snapshots[opts.snapshot] = {
    contentHash: opts.snapshot,
    importedAt: '2026-04-26T00:00:00.000Z',
    sourcePath: '/host/fake',
    assetCounts: {
      commands: 0,
      agents: 0,
      skills: 0,
      hooks: 0,
      mcpServers: 0,
    },
  };
  if (!entry.activeSnapshot) entry.activeSnapshot = opts.snapshot;
  idx.plugins[fullId] = entry;
  writeCatalogIndex(idx);

  return dir;
}

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mat-'));
});

afterEach(() => {
  if (tmpDataDir && fs.existsSync(tmpDataDir)) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

describe('paths', () => {
  test('getUserRuntimeRoot is per-user under data/plugins/runtime', () => {
    expect(getUserRuntimeRoot(USER)).toBe(
      path.join(tmpDataDir, 'plugins', 'runtime', USER),
    );
  });

  test('getUserPluginRuntimeDir nests under snapshots/{snapshotId}/{mp}/{plugin}', () => {
    expect(getUserPluginRuntimeDir(USER, 'sha256-abc', 'mp1', 'p1')).toBe(
      path.join(
        tmpDataDir,
        'plugins',
        'runtime',
        USER,
        'snapshots',
        'sha256-abc',
        'mp1',
        'p1',
      ),
    );
  });

  test('rejects path traversal in name segments', () => {
    expect(() =>
      getUserPluginRuntimeDir(USER, 'sha256-abc', '..', 'p'),
    ).toThrow();
    expect(() =>
      getUserPluginRuntimeDir(USER, 'sha256-abc', 'mp', '../escape'),
    ).toThrow();
  });
});

describe('materializeUserRuntime', () => {
  test('no-op when user has no v2 config', () => {
    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(0);
    expect(r.reused).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  test('builds runtime tree from catalog snapshot with isolated inodes', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
      files: { 'commands/hello.md': '# hi' },
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(1);
    expect(r.reused).toBe(0);

    const rtDir = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    expect(
      fs.existsSync(path.join(rtDir, '.claude-plugin', 'plugin.json')),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(rtDir, 'commands', 'hello.md'), 'utf-8'),
    ).toBe('# hi');

    // Critical safety contract: independent (dev, ino) tuple from catalog.
    // Hard-links would share the inode and let host-mode bypass-permissions
    // writes through runtime corrupt the immutable catalog snapshot.
    const sStat = fs.statSync(
      path.join(
        getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa'),
        'commands',
        'hello.md',
      ),
    );
    const dStat = fs.statSync(path.join(rtDir, 'commands', 'hello.md'));
    expect([dStat.dev, dStat.ino]).not.toEqual([sStat.dev, sStat.ino]);

    // Marker is at sibling path (snapshot root), NOT inside plugin root.
    expect(fs.existsSync(path.join(rtDir, '@happyclaw-runtime-markers'))).toBe(
      false,
    );
    const markerPath = path.join(
      getUserSnapshotsDir(USER),
      'sha256-aaa',
      '@happyclaw-runtime-markers',
      'mp1',
      'p1.json',
    );
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(marker.isolatedInodes).toBe(true);
    expect(marker.copyMode).toBe('copyfile_ficlone');
    expect(marker.materializerVersion).toBe(2);
  });

  test('idempotent — re-running with same config reuses existing tree', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const first = materializeUserRuntime(USER);
    expect(first.built).toBe(1);

    const second = materializeUserRuntime(USER);
    expect(second.built).toBe(0);
    expect(second.reused).toBe(1);
  });

  test('skips entry when catalog snapshot dir is missing', () => {
    // Only register in index; no on-disk snapshot tree.
    const idx = catalog.readCatalogIndex();
    idx.plugins['ghost@mp1'] = {
      marketplace: 'mp1',
      plugin: 'ghost',
      fullId: 'ghost@mp1',
      activeSnapshot: 'sha256-zzz',
      snapshots: {},
    };
    writeCatalogIndex(idx);

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'ghost@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'ghost',
          snapshot: 'sha256-zzz',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(0);
    expect(r.warnings.some((w) => w.includes('Catalog snapshot missing'))).toBe(
      true,
    );
  });

  test('legacy hard-link runtime is migrated with rename + backup rollback', () => {
    if (process.platform === 'win32') return; // hardlink test flaky on Windows
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
      files: { 'commands/hello.md': '# original' },
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    // Fabricate a legacy hard-link runtime tree (no marker).
    const rtDir = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    const catalogDir = getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa');
    fs.mkdirSync(path.join(rtDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(rtDir, 'commands'), { recursive: true });
    fs.linkSync(
      path.join(catalogDir, '.claude-plugin', 'plugin.json'),
      path.join(rtDir, '.claude-plugin', 'plugin.json'),
    );
    fs.linkSync(
      path.join(catalogDir, 'commands', 'hello.md'),
      path.join(rtDir, 'commands', 'hello.md'),
    );

    // Confirm bad starting state (shared inode).
    const c0 = fs.statSync(path.join(catalogDir, 'commands', 'hello.md'));
    const r0 = fs.statSync(path.join(rtDir, 'commands', 'hello.md'));
    expect([r0.dev, r0.ino]).toEqual([c0.dev, c0.ino]);

    // Trigger migration.
    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(1);
    expect(r.reused).toBe(0);

    // Inode now isolated.
    const c1 = fs.statSync(path.join(catalogDir, 'commands', 'hello.md'));
    const r1 = fs.statSync(path.join(rtDir, 'commands', 'hello.md'));
    expect([r1.dev, r1.ino]).not.toEqual([c1.dev, c1.ino]);

    // Marker present at sibling path.
    const markerPath = path.join(
      getUserSnapshotsDir(USER),
      'sha256-aaa',
      '@happyclaw-runtime-markers',
      'mp1',
      'p1.json',
    );
    expect(fs.existsSync(markerPath)).toBe(true);

    // No legacy backup left around.
    const parent = path.dirname(rtDir);
    const leftovers = fs
      .readdirSync(parent)
      .filter((n) => n.includes('.legacy-bak@'));
    expect(leftovers).toEqual([]);

    // Idempotent: next materialize is a no-op.
    const r2 = materializeUserRuntime(USER);
    expect(r2.reused).toBe(1);
    expect(r2.built).toBe(0);

    // P1 closed: writing through runtime no longer mutates catalog.
    fs.writeFileSync(path.join(rtDir, 'commands', 'hello.md'), '# tampered');
    expect(
      fs.readFileSync(path.join(catalogDir, 'commands', 'hello.md'), 'utf-8'),
    ).toBe('# original');
  });

  test('writing through runtime path does not corrupt catalog snapshot', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
      files: { 'commands/hello.md': '# original' },
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    const rtFile = path.join(
      getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1'),
      'commands',
      'hello.md',
    );
    fs.writeFileSync(rtFile, '# tampered by agent');

    const catalogFile = path.join(
      getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa'),
      'commands',
      'hello.md',
    );
    expect(fs.readFileSync(catalogFile, 'utf-8')).toBe('# original');
  });

  test('symlinks in catalog snapshot are skipped during materialize', () => {
    if (process.platform === 'win32') return;
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
      files: { 'commands/real.md': '# real' },
    });
    const catalogDir = getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa');
    fs.symlinkSync('real.md', path.join(catalogDir, 'commands', 'evil.md'));

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    const rtDir = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    expect(fs.existsSync(path.join(rtDir, 'commands', 'real.md'))).toBe(true);
    expect(fs.existsSync(path.join(rtDir, 'commands', 'evil.md'))).toBe(false);
  });

  test('corrupt marker is treated as missing and triggers re-materialize', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const r1 = materializeUserRuntime(USER);
    expect(r1.built).toBe(1);

    // Corrupt the marker.
    const markerPath = path.join(
      getUserSnapshotsDir(USER),
      'sha256-aaa',
      '@happyclaw-runtime-markers',
      'mp1',
      'p1.json',
    );
    fs.writeFileSync(markerPath, '{"materializerVersion":999}', 'utf-8');

    // Next materialize should rebuild (treats corrupt marker as missing).
    const r2 = materializeUserRuntime(USER);
    expect(r2.built).toBe(1);
    expect(r2.reused).toBe(0);
  });

  test('partial leftover dir without manifest is wiped before rebuild', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    // Write a stale partial tree at the target path (no manifest).
    const target = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'stale.txt'), 'leftover');

    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(1);
    // Stale file gone; manifest now in place
    expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false);
    expect(
      fs.existsSync(path.join(target, '.claude-plugin', 'plugin.json')),
    ).toBe(true);
  });
});

describe('materializeUserRuntime — does NOT auto-cleanup (PR1 codex fix)', () => {
  test('orphan snapshots survive a config flip when materialize is the only call', () => {
    // Regression: pre-fix, materializeUserRuntime invoked cleanupOrphanRuntime
    // unconditionally with no isSnapshotInUse predicate. A second
    // materialize from one process could then delete the runtime tree another
    // live agent had mounted. The new contract is "materialize never deletes";
    // GC happens via an explicit cleanupOrphanRuntime caller in PR2.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-bbb',
    });

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    // Flip the active snapshot and re-materialize. Old aaa MUST stay on disk.
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-bbb',
          enabledAt: '2026-04-26T01:00:00.000Z',
        },
      },
    });
    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(1);
    // Critical: zero deletions, even though aaa is now unreferenced.
    expect(r.cleaned).toBe(0);

    const snapshotsDir = getUserSnapshotsDir(USER);
    expect(fs.readdirSync(snapshotsDir).sort()).toEqual([
      'sha256-aaa',
      'sha256-bbb',
    ]);
  });

  test('isSnapshotInUse option is accepted but no longer triggers cleanup', () => {
    // Forward-compat: the option is reserved (PR2 may re-introduce inline GC
    // behind an explicit opt-in flag), but in PR1 passing it must NOT cause
    // any deletion. Verifies callers that already pass `{ isSnapshotInUse }`
    // don't accidentally lose snapshots.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-bbb',
    });

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-bbb',
          enabledAt: '2026-04-26T01:00:00.000Z',
        },
      },
    });

    const r = materializeUserRuntime(USER, {
      // Even saying "nothing is in use" must not let the materializer delete.
      isSnapshotInUse: () => false,
    });
    expect(r.cleaned).toBe(0);

    expect(fs.readdirSync(getUserSnapshotsDir(USER)).sort()).toEqual([
      'sha256-aaa',
      'sha256-bbb',
    ]);
  });
});

describe('cleanupOrphanRuntime (explicit GC)', () => {
  test('removes snapshots not referenced by current plugins.json', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-bbb',
    });

    // Materialize an old enabled snapshot, then flip the user config to a new one.
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    // Switch to bbb — materialize creates the new dir; explicit cleanup removes aaa
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-bbb',
          enabledAt: '2026-04-26T01:00:00.000Z',
        },
      },
    });
    expect(materializeUserRuntime(USER).built).toBe(1);
    const r = cleanupOrphanRuntime(USER);
    expect(r.cleaned).toBe(1);

    const snapshotsDir = getUserSnapshotsDir(USER);
    expect(fs.readdirSync(snapshotsDir).sort()).toEqual(['sha256-bbb']);
  });

  test('respects isSnapshotInUse hook to keep pinned snapshots alive', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-bbb',
    });

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    // Caller pins aaa as "still in use" → cleanup leaves it alone.
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-bbb',
          enabledAt: '2026-04-26T01:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);
    const r = cleanupOrphanRuntime(USER, (_uid, snap) => snap === 'sha256-aaa');
    expect(r.cleaned).toBe(0);

    const snapshotsDir = getUserSnapshotsDir(USER);
    expect(fs.readdirSync(snapshotsDir).sort()).toEqual([
      'sha256-aaa',
      'sha256-bbb',
    ]);
  });

  test('immutable old snapshots survive a disable toggle', () => {
    // The plan's correctness rule: disabling a plugin must NOT remove the
    // runtime tree that an in-flight agent might still be reading.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });

    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    materializeUserRuntime(USER);

    // Disable: empty enabled map. With a runner-pin hook, the dir must persist.
    writeUserPluginsV2(USER, { schemaVersion: 1, enabled: {} });
    materializeUserRuntime(USER);
    cleanupOrphanRuntime(USER, (_uid, snap) => snap === 'sha256-aaa');

    const rtDir = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    expect(
      fs.existsSync(path.join(rtDir, '.claude-plugin', 'plugin.json')),
    ).toBe(true);
  });

  test('safely no-ops when snapshots dir is missing', () => {
    const r = cleanupOrphanRuntime(USER);
    expect(r.cleaned).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});
