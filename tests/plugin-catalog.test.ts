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

const catalog = await import('../src/plugin-catalog.js');
const {
  buildFullId,
  getCatalogIndexFile,
  getCatalogPluginDir,
  getCatalogRoot,
  getCatalogSnapshotDir,
  getSnapshotPath,
  listCatalog,
  readCatalogIndex,
  writeCatalogIndex,
} = catalog;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cat-'));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('catalog paths', () => {
  test('all derive from DATA_DIR/plugins/catalog', () => {
    const root = getCatalogRoot();
    expect(root).toBe(path.join(tmpDataDir, 'plugins', 'catalog'));
    expect(getCatalogIndexFile()).toBe(path.join(root, 'index.json'));
    expect(getCatalogPluginDir('mp-x', 'plugin-y')).toBe(
      path.join(root, 'marketplaces', 'mp-x', 'plugins', 'plugin-y'),
    );
    expect(getCatalogSnapshotDir('mp-x', 'plugin-y', 'sha256-abc')).toBe(
      path.join(
        root,
        'marketplaces',
        'mp-x',
        'plugins',
        'plugin-y',
        'versions',
        'sha256-abc',
      ),
    );
  });

  test('rejects path-traversal in name segments', () => {
    expect(() => getCatalogPluginDir('..', 'plugin')).toThrow();
    expect(() => getCatalogPluginDir('mp', '../escape')).toThrow();
    expect(() => getCatalogSnapshotDir('mp', 'p', '..')).toThrow();
    expect(() => getCatalogSnapshotDir('mp', 'p', 'has/slash')).toThrow();
  });
});

describe('buildFullId', () => {
  test('joins plugin@marketplace', () => {
    expect(buildFullId('codex', 'openai-codex')).toBe('codex@openai-codex');
  });
});

describe('readCatalogIndex / writeCatalogIndex', () => {
  test('round-trips an index, atomic rename leaves no .tmp', () => {
    const idx = readCatalogIndex();
    expect(idx.plugins).toEqual({});
    expect(idx.lastScanAt).toBeNull();

    idx.lastScanAt = '2026-04-26T00:00:00.000Z';
    idx.marketplaces['mp1'] = {
      name: 'mp1',
      sourcePath: '/host/path',
      lastImportedAt: '2026-04-26T00:00:00.000Z',
    };
    idx.plugins['p1@mp1'] = {
      marketplace: 'mp1',
      plugin: 'p1',
      fullId: 'p1@mp1',
      activeSnapshot: 'sha256-aaa',
      snapshots: {
        'sha256-aaa': {
          contentHash: 'sha256-aaa',
          importedAt: '2026-04-26T00:00:00.000Z',
          sourcePath: '/host/path/plugins/p1',
          assetCounts: {
            commands: 0,
            agents: 0,
            skills: 0,
            hooks: 0,
            mcpServers: 0,
          },
        },
      },
    };
    writeCatalogIndex(idx);

    const loaded = readCatalogIndex();
    expect(loaded).toEqual(idx);

    // No leftover tmp files.
    const indexDir = path.dirname(getCatalogIndexFile());
    const leftovers = fs.readdirSync(indexDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('returns empty index on malformed JSON without throwing', () => {
    const file = getCatalogIndexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json');
    const idx = readCatalogIndex();
    expect(idx.plugins).toEqual({});
    expect(idx.lastScanAt).toBeNull();
  });

  test('returns empty index on unknown schemaVersion', () => {
    const file = getCatalogIndexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 99, plugins: { stale: {} } }),
    );
    const idx = readCatalogIndex();
    expect(idx.plugins).toEqual({});
  });
});

describe('listCatalog', () => {
  test('returns entries from disk index', () => {
    expect(listCatalog()).toEqual([]);
    const idx = readCatalogIndex();
    idx.plugins['codex@openai-codex'] = {
      marketplace: 'openai-codex',
      plugin: 'codex',
      fullId: 'codex@openai-codex',
      activeSnapshot: 'sha256-aaa',
      snapshots: {},
    };
    writeCatalogIndex(idx);
    expect(listCatalog()).toHaveLength(1);
    expect(listCatalog()[0].fullId).toBe('codex@openai-codex');
  });
});

describe('getSnapshotPath', () => {
  test('returns directory when present', () => {
    const dir = getCatalogSnapshotDir('mp', 'p', 'sha256-abc');
    fs.mkdirSync(dir, { recursive: true });
    expect(getSnapshotPath('mp', 'p', 'sha256-abc')).toBe(dir);
  });

  test('returns null when missing or invalid', () => {
    expect(getSnapshotPath('mp', 'p', 'sha256-zzz')).toBeNull();
    expect(getSnapshotPath('..', 'p', 'sha256-abc')).toBeNull();
    expect(getSnapshotPath('mp', '..', 'sha256-abc')).toBeNull();
  });
});
