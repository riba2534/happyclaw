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
  const dir = getCatalogSnapshotDir(opts.marketplace, opts.plugin, opts.snapshot);
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
    expect(
      getUserPluginRuntimeDir(USER, 'sha256-abc', 'mp1', 'p1'),
    ).toBe(
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
    expect(() => getUserPluginRuntimeDir(USER, 'sha256-abc', '..', 'p')).toThrow();
    expect(() => getUserPluginRuntimeDir(USER, 'sha256-abc', 'mp', '../escape')).toThrow();
  });
});

describe('materializeUserRuntime', () => {
  test('no-op when user has no v2 config', () => {
    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(0);
    expect(r.reused).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  test('builds runtime tree from catalog snapshot via hard links', () => {
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
    expect(fs.existsSync(path.join(rtDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.readFileSync(path.join(rtDir, 'commands', 'hello.md'), 'utf-8')).toBe('# hi');

    // Confirm hard-link semantics — same inode means same FS, no extra copy.
    const srcInode = fs.statSync(
      path.join(getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa'), 'commands', 'hello.md'),
    ).ino;
    const dstInode = fs.statSync(path.join(rtDir, 'commands', 'hello.md')).ino;
    expect(dstInode).toBe(srcInode);
  });

  test('idempotent — re-running with same config reuses existing tree', () => {
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
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
    expect(r.warnings.some((w) => w.includes('Catalog snapshot missing'))).toBe(true);
  });

  test('cross-fs fallback: cpSync used when hard-link fails', async () => {
    // Stub fs.linkSync to raise EXDEV the first time it's called per build,
    // forcing the cpSync fallback. Keep the original around so cleanup still works.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
      files: { 'commands/hi.md': 'hello' },
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

    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      const e = new Error('cross-device') as NodeJS.ErrnoException;
      e.code = 'EXDEV';
      throw e;
    });

    const r = materializeUserRuntime(USER);
    expect(r.built).toBe(1);
    expect(r.warnings.some((w) => w.includes('Cross-device fallback'))).toBe(true);

    const rtDir = getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1');
    // Bytes copied over → file content correct
    expect(fs.readFileSync(path.join(rtDir, 'commands', 'hi.md'), 'utf-8')).toBe('hello');
    // Inodes differ when cpSync was used (separate file allocation)
    const srcInode = fs.statSync(
      path.join(getCatalogSnapshotDir('mp1', 'p1', 'sha256-aaa'), 'commands', 'hi.md'),
    ).ino;
    const dstInode = fs.statSync(path.join(rtDir, 'commands', 'hi.md')).ino;
    expect(dstInode).not.toBe(srcInode);

    linkSpy.mockRestore();
  });

  test('partial leftover dir without manifest is wiped before rebuild', () => {
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
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
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-bbb' });

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
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-bbb' });

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
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-bbb' });

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
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-bbb' });

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
    const r = cleanupOrphanRuntime(
      USER,
      (_uid, snap) => snap === 'sha256-aaa',
    );
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
    seedCatalogSnapshot({ marketplace: 'mp1', plugin: 'p1', snapshot: 'sha256-aaa' });

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
    expect(fs.existsSync(path.join(rtDir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  test('safely no-ops when snapshots dir is missing', () => {
    const r = cleanupOrphanRuntime(USER);
    expect(r.cleaned).toBe(0);
    expect(r.warnings).toEqual([]);
  });
});

