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

// Must import after vi.mock so the module-scope path.join uses the mocked DATA_DIR.
const pluginUtils = await import('../src/plugin-utils.js');
const {
  loadUserPlugins,
  readUserPluginsV2,
  writeUserPluginsV2,
  parsePluginFullId,
  getUserPluginRuntimePath,
  getUserPluginsFileV2,
  CONTAINER_PLUGINS_PATH,
} = pluginUtils;

function seedRuntimeManifest(
  userId: string,
  snapshotId: string,
  marketplace: string,
  pluginName: string,
): string {
  const dir = getUserPluginRuntimePath(userId, snapshotId, marketplace, pluginName);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  return dir;
}

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-plugin-utils-'));
});

afterEach(() => {
  if (tmpDataDir && fs.existsSync(tmpDataDir)) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

describe('parsePluginFullId', () => {
  test('splits <plugin>@<marketplace> correctly', () => {
    expect(parsePluginFullId('codex@openai-codex')).toEqual({
      pluginName: 'codex',
      marketplaceName: 'openai-codex',
    });
  });

  test('returns null for missing @', () => {
    expect(parsePluginFullId('codex')).toBeNull();
  });

  test('returns null for empty marketplace after @', () => {
    expect(parsePluginFullId('codex@')).toBeNull();
  });

  test('returns null for empty plugin before @', () => {
    expect(parsePluginFullId('@openai-codex')).toBeNull();
  });

  test('rejects names containing @ after whitelist (no path-escape risk)', () => {
    // Split is still on last @, but both segments must match [\w.-]+.
    // A plugin name containing @ fails the whitelist → null.
    expect(parsePluginFullId('my@weird@marketplace')).toBeNull();
  });

  test('rejects names with path separators or dot-dot', () => {
    expect(parsePluginFullId('../evil@mp')).toBeNull();
    expect(parsePluginFullId('plugin@..')).toBeNull();
    expect(parsePluginFullId('plugin@mp/with/slash')).toBeNull();
    expect(parsePluginFullId('.@mp')).toBeNull();
  });
});

describe('readUserPluginsV2 / writeUserPluginsV2', () => {
  test('returns null when v2 plugins.json is missing', () => {
    expect(readUserPluginsV2('alice')).toBeNull();
  });

  test('round-trips via writeUserPluginsV2', () => {
    const input = {
      schemaVersion: 1 as const,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    };
    writeUserPluginsV2('alice', input);
    expect(readUserPluginsV2('alice')).toEqual(input);
  });

  test('tolerates corrupt JSON (returns empty enabled map)', () => {
    const file = getUserPluginsFileV2('alice');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'this is not json');
    expect(readUserPluginsV2('alice')).toEqual({
      schemaVersion: 1,
      enabled: {},
    });
  });

  test('returns null for unknown schemaVersion (no auto-overwrite)', () => {
    const file = getUserPluginsFileV2('alice');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 99, enabled: {} }),
    );
    expect(readUserPluginsV2('alice')).toBeNull();
  });
});

describe('loadUserPlugins', () => {
  test('returns [] when userId is empty', () => {
    expect(loadUserPlugins('', { runtime: 'docker' })).toEqual([]);
    expect(loadUserPlugins('', { runtime: 'host' })).toEqual([]);
  });

  test('returns [] when no v2 plugins.json exists', () => {
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });

  test('returns [] when no plugins are enabled', () => {
    writeUserPluginsV2('alice', { schemaVersion: 1, enabled: {} });
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });

  test('skips enabled plugins whose runtime dir is missing (stale config)', () => {
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    // No seedRuntimeManifest call → manifest missing → should skip
    expect(loadUserPlugins('alice', { runtime: 'host' })).toEqual([]);
  });

  test('docker mode returns container-internal paths', () => {
    seedRuntimeManifest('alice', 'sha256-aaa', 'openai-codex', 'codex');
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    const result = loadUserPlugins('alice', { runtime: 'docker' });
    expect(result).toEqual([
      {
        type: 'local',
        path: `${CONTAINER_PLUGINS_PATH}/snapshots/sha256-aaa/openai-codex/codex`,
      },
    ]);
  });

  test('host mode returns absolute DATA_DIR paths', () => {
    seedRuntimeManifest('alice', 'sha256-aaa', 'openai-codex', 'codex');
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    const result = loadUserPlugins('alice', { runtime: 'host' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('local');
    expect(result[0].path).toBe(
      getUserPluginRuntimePath('alice', 'sha256-aaa', 'openai-codex', 'codex'),
    );
    expect(path.isAbsolute(result[0].path)).toBe(true);
  });

  test('mixes enabled/disabled plugins correctly', () => {
    seedRuntimeManifest('alice', 'sha256-aaa', 'openai-codex', 'codex');
    seedRuntimeManifest('alice', 'sha256-bbb', 'anthropic-tools', 'formatter');
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'formatter@anthropic-tools': {
          enabled: false,
          marketplace: 'anthropic-tools',
          plugin: 'formatter',
          snapshot: 'sha256-bbb',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    const result = loadUserPlugins('alice', { runtime: 'docker' });
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('openai-codex/codex');
  });

  test('per-user isolation: alice config does not leak to bob', () => {
    seedRuntimeManifest('alice', 'sha256-aaa', 'openai-codex', 'codex');
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@openai-codex': {
          enabled: true,
          marketplace: 'openai-codex',
          plugin: 'codex',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    expect(loadUserPlugins('alice', { runtime: 'host' })).toHaveLength(1);
    expect(loadUserPlugins('bob', { runtime: 'host' })).toHaveLength(0);
  });

  test('skips refs with invalid name segments', () => {
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'p@mp': {
          enabled: true,
          marketplace: '..',
          plugin: 'p',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });
});
