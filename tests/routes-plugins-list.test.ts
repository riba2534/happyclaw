/**
 * GET /api/plugins returns the catalog's full plugin set, annotated with the
 * current user's enabled state per plugin (mcp-style projection). The UI
 * relies on this to render the list + toggle each row, so:
 *   - catalog plugins with no v2 ref → enabled=false, default snapshot pointer
 *   - v2 ref enabled=true            → enabled=true with the user's pinned snapshot
 *   - v2 ref enabled=false           → still listed with enabled=false (re-enable path)
 *   - v2 ref but plugin gone from catalog → still listed with `missing from catalog` note
 *   - admin-only fields (marketplace sourcePath) are stripped for member viewers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-plugins-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
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

// Authenticated as a fixed test user. The route's authMiddleware lookup is
// stubbed so we don't need to seed sessions / cookies in db. Role can be
// flipped per-test via HAPPYCLAW_TEST_USER_ROLE env var.
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const pluginsRoutesModule = await import('../src/routes/plugins.js');
const catalog = await import('../src/plugin-catalog.js');
const utils = await import('../src/plugin-utils.js');

const pluginsRoutes = pluginsRoutesModule.default;
const { writeCatalogIndex, getCatalogSnapshotDir } = catalog;
const { writeUserPluginsV2 } = utils;

const USER = 'alice';
process.env.HAPPYCLAW_TEST_USER_ID = USER;

function seedCatalogSnapshot(opts: {
  marketplace: string;
  plugin: string;
  snapshot: string;
  version?: string;
  description?: string;
  sourcePath?: string;
}) {
  const dir = getCatalogSnapshotDir(
    opts.marketplace,
    opts.plugin,
    opts.snapshot,
  );
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: opts.plugin,
      version: opts.version ?? '1.0.0',
      description: opts.description,
    }),
  );

  const idx = catalog.readCatalogIndex();
  const fullId = `${opts.plugin}@${opts.marketplace}`;
  idx.marketplaces[opts.marketplace] ??= {
    name: opts.marketplace,
    sourcePath: opts.sourcePath ?? '/host/fake',
    lastImportedAt: '2026-04-26T00:00:00.000Z',
    version: '1.0.0',
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
    sourcePath: opts.sourcePath ?? '/host/fake',
    version: opts.version ?? '1.0.0',
    description: opts.description,
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

beforeEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(tmpDataDir, { recursive: true });
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  }
});

async function getRoot(): Promise<{ status: number; body: any }> {
  const res = await pluginsRoutes.request('/', { method: 'GET' });
  const body = await res.json();
  return { status: res.status, body };
}

describe('GET /api/plugins', () => {
  test('empty catalog + empty user → empty marketplaces', async () => {
    const { status, body } = await getRoot();
    expect(status).toBe(200);
    expect(body.marketplaces).toEqual([]);
  });

  test('catalog plugins with no v2 ref → listed with enabled=false and active snapshot pointer', async () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
      version: '1.2.3',
      description: 'OpenAI Codex helper',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'review',
      snapshot: 'sha256-bbb',
      version: '0.1.0',
    });

    const { status, body } = await getRoot();
    expect(status).toBe(200);
    expect(body.marketplaces).toHaveLength(1);
    const mp = body.marketplaces[0];
    expect(mp.name).toBe('mp1');
    expect(mp.plugins).toHaveLength(2);
    const byId = Object.fromEntries(
      mp.plugins.map((p: any) => [p.fullId, p]),
    );
    expect(byId['codex@mp1']).toMatchObject({
      name: 'codex',
      enabled: false,
      snapshot: 'sha256-aaa',
      activeSnapshot: 'sha256-aaa',
      version: '1.2.3',
      description: 'OpenAI Codex helper',
    });
    expect(byId['review@mp1']).toMatchObject({
      name: 'review',
      enabled: false,
      snapshot: 'sha256-bbb',
      activeSnapshot: 'sha256-bbb',
    });
    expect(byId['codex@mp1'].warnings).toEqual({ missing: [], note: '' });
  });

  test('user enabled one plugin → that row enabled=true, others remain enabled=false', async () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
      version: '1.2.3',
    });
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'review',
      snapshot: 'sha256-bbb',
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const { body } = await getRoot();
    expect(body.marketplaces).toHaveLength(1);
    const byId = Object.fromEntries(
      body.marketplaces[0].plugins.map((p: any) => [p.fullId, p]),
    );
    expect(byId['codex@mp1'].enabled).toBe(true);
    expect(byId['codex@mp1'].snapshot).toBe('sha256-aaa');
    expect(byId['review@mp1'].enabled).toBe(false);
    expect(byId['review@mp1'].snapshot).toBe('sha256-bbb');
  });

  test('disabled v2 ref still listed (so UI can re-enable)', async () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
    });
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: false,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    const { body } = await getRoot();
    expect(body.marketplaces).toHaveLength(1);
    expect(body.marketplaces[0].plugins).toHaveLength(1);
    expect(body.marketplaces[0].plugins[0]).toMatchObject({
      fullId: 'codex@mp1',
      enabled: false,
      snapshot: 'sha256-aaa',
    });
  });

  test('v2 ref to plugin missing from catalog → still listed with `missing from catalog` warning', async () => {
    // No catalog entry. v2 ref points at a plugin we used to know about.
    writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'ghost@removed-mp': {
          enabled: true,
          marketplace: 'removed-mp',
          plugin: 'ghost',
          snapshot: 'sha256-ccc',
          enabledAt: '2026-04-25T00:00:00.000Z',
        },
      },
    });

    const { body } = await getRoot();
    expect(body.marketplaces).toHaveLength(1);
    const mp = body.marketplaces[0];
    expect(mp.name).toBe('removed-mp');
    expect(mp.plugins).toHaveLength(1);
    expect(mp.plugins[0]).toMatchObject({
      fullId: 'ghost@removed-mp',
      enabled: true,
      snapshot: 'sha256-ccc',
    });
    expect(mp.plugins[0].warnings.note).toMatch(/missing from catalog/);
    // No catalog metadata available, so activeSnapshot is absent.
    expect(mp.plugins[0].activeSnapshot).toBeUndefined();
  });

  test('member viewer does not see marketplace hostSourcePath; admin viewer does', async () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
      sourcePath: '/host/secret/path',
    });

    // member (default)
    process.env.HAPPYCLAW_TEST_USER_ROLE = 'member';
    const { body: memberBody } = await getRoot();
    expect(memberBody.marketplaces[0].hostSourcePath).toBeUndefined();

    // admin
    process.env.HAPPYCLAW_TEST_USER_ROLE = 'admin';
    const { body: adminBody } = await getRoot();
    expect(adminBody.marketplaces[0].hostSourcePath).toBe('/host/secret/path');
  });
});
