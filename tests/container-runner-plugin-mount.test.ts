/**
 * buildVolumeMounts must always mount the user's runtime/ root at
 * /workspace/plugins for any docker-mode container, so loadUserPlugins(docker)
 * paths shaped like /workspace/plugins/snapshots/<id>/<mp>/<plugin> resolve
 * inside the container. The runtime root is created on demand and re-
 * materialized on every spawn — there is no v1 cache fallback.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Several src modules (runtime-config.ts, etc.) capture DATA_DIR at module
// load via top-level `path.join(DATA_DIR, ...)`. We need a real path *before*
// any of those modules import. Stash one in process.env so the mock factory
// (which is hoisted above this file's body and runs before our `await
// import(...)` lines) can read a stable value.
const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cr-mount-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  // The captured fs/path bindings inside this factory must use the SAME
  // shared tmp dir. We can't reach `tmpDataDir` here (hoisted above its
  // initializer), so route through env.
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const containerRunner = await import('../src/container-runner.js');
const catalog = await import('../src/plugin-catalog.js');
const utils = await import('../src/plugin-utils.js');
const materializer = await import('../src/plugin-materializer.js');

const { buildVolumeMounts, prepareHostPlugins } = containerRunner;
const { writeCatalogIndex, getCatalogSnapshotDir } = catalog;
const { CONTAINER_PLUGINS_PATH } = utils;
const { getUserRuntimeRoot, getUserPluginRuntimeDir } = materializer;

const USER = 'alice';

function seedCatalogSnapshot(opts: {
  marketplace: string;
  plugin: string;
  snapshot: string;
}): void {
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
}

function fakeGroup(folder: string, ownerId: string) {
  return {
    name: folder,
    folder,
    added_at: '2026-04-26T00:00:00.000Z',
    created_by: ownerId,
    is_home: false,
  };
}

beforeEach(() => {
  // tmpDataDir is fixed for the file (top-level captures in runtime-config
  // can't be relocated mid-run). Wipe its contents between tests so each
  // test starts from a clean state.
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(tmpDataDir, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  }
});

describe('buildVolumeMounts — Claude Code plugins runtime mount', () => {
  test('v2 user is materialized and mounted at runtime/', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    utils.writeUserPluginsV2(USER, {
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

    const mounts = buildVolumeMounts(fakeGroup('grp-x', USER) as any, false, true);

    const pluginMount = mounts.find(
      (m) => m.containerPath === CONTAINER_PLUGINS_PATH,
    );
    expect(pluginMount).toBeTruthy();
    expect(pluginMount!.hostPath).toBe(getUserRuntimeRoot(USER));
    expect(pluginMount!.readonly).toBe(true);

    const expectedManifest = path.join(
      getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1'),
      '.claude-plugin',
      'plugin.json',
    );
    expect(fs.existsSync(expectedManifest)).toBe(true);
  });

  test('user with no plugin config still mounts an empty runtime root', () => {
    // The runtime root is created on demand so the bind-mount target exists
    // even for users who haven't enabled anything yet. The mount is a no-op
    // for the CLI (no .claude-plugin/plugin.json under it), but still present.
    const mounts = buildVolumeMounts(fakeGroup('grp-x', USER) as any, false, true);
    const pluginMount = mounts.find(
      (m) => m.containerPath === CONTAINER_PLUGINS_PATH,
    );
    expect(pluginMount).toBeTruthy();
    expect(pluginMount!.hostPath).toBe(getUserRuntimeRoot(USER));
    expect(fs.existsSync(getUserRuntimeRoot(USER))).toBe(true);
  });
});

describe('prepareHostPlugins — host-mode pre-spawn materialize', () => {
  test('materializes runtime/ on demand when v2 config exists but tree is missing', () => {
    // Reproduces the bug fixed in this task: v2 config is present but
    // runtime/{userId}/snapshots/... has not been built yet (first enable, or
    // after orphan GC). Without pre-spawn materialize, loadUserPlugins(host)
    // would skip every entry (manifest existsSync check fails) and the host
    // agent would silently start with 0 plugins.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-host-aaa',
    });
    utils.writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-host-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    // Sanity: runtime/ tree is NOT yet built — this is the broken state.
    const expectedManifest = path.join(
      getUserPluginRuntimeDir(USER, 'sha256-host-aaa', 'mp1', 'p1'),
      '.claude-plugin',
      'plugin.json',
    );
    expect(fs.existsSync(expectedManifest)).toBe(false);

    const plugins = prepareHostPlugins(USER);

    // After prepareHostPlugins: runtime/ is materialized AND we got a host
    // SdkPluginConfig pointing at the absolute on-disk path.
    expect(fs.existsSync(expectedManifest)).toBe(true);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].type).toBe('local');
    expect(plugins[0].path).toBe(
      getUserPluginRuntimeDir(USER, 'sha256-host-aaa', 'mp1', 'p1'),
    );
  });

  test('returns empty array for falsy ownerId (admin without created_by)', () => {
    // Defensive: legacy groups without created_by should not throw and should
    // produce no plugins. Mirrors the `group.created_by ? ... : []` ternary
    // the old inline code carried.
    expect(prepareHostPlugins(null)).toEqual([]);
    expect(prepareHostPlugins(undefined)).toEqual([]);
    expect(prepareHostPlugins('')).toEqual([]);
  });

  test('returns empty array when v2 config is absent', () => {
    // No v2 config → nothing to materialize, nothing to load. materialize is
    // a no-op in this case (returns empty report) and loadUserPlugins returns
    // []. The function must not throw.
    expect(prepareHostPlugins(USER)).toEqual([]);
  });
});
