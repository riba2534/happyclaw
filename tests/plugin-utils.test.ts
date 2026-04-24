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
  readUserPluginsFile,
  writeUserPluginsFile,
  parsePluginFullId,
  getUserPluginsCacheDir,
  getPluginCacheDir,
  CONTAINER_PLUGINS_PATH,
} = pluginUtils;

function seedFakePlugin(
  userId: string,
  marketplace: string,
  pluginName: string,
): string {
  const pluginDir = getPluginCacheDir(userId, marketplace, pluginName);
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  return pluginDir;
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

describe('readUserPluginsFile', () => {
  test('returns empty config when plugins.json is missing', () => {
    const config = readUserPluginsFile('alice');
    expect(config).toEqual({ marketplaces: {}, enabled: {} });
  });

  test('round-trips via writeUserPluginsFile', () => {
    const input = {
      marketplaces: {
        'openai-codex': {
          hostSourcePath: '/host/path',
          syncedAt: '2026-04-24T00:00:00Z',
          version: '1.0.3',
        },
      },
      enabled: { 'codex@openai-codex': true },
    };
    writeUserPluginsFile('alice', input);
    expect(readUserPluginsFile('alice')).toEqual(input);
  });

  test('tolerates corrupt JSON (returns empty config)', () => {
    const file = path.join(tmpDataDir, 'plugins', 'alice', 'plugins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'this is not json');
    expect(readUserPluginsFile('alice')).toEqual({ marketplaces: {}, enabled: {} });
  });
});

describe('loadUserPlugins', () => {
  test('returns [] when userId is empty', () => {
    expect(loadUserPlugins('', { runtime: 'docker' })).toEqual([]);
    expect(loadUserPlugins('', { runtime: 'host' })).toEqual([]);
  });

  test('returns [] when no plugins.json exists', () => {
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });

  test('returns [] when no plugins are enabled', () => {
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: { 'codex@openai-codex': false },
    });
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });

  test('skips enabled plugins whose cache dir is missing (stale config)', () => {
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: { 'codex@openai-codex': true },
    });
    // No seedFakePlugin call → manifest missing → should skip
    expect(loadUserPlugins('alice', { runtime: 'host' })).toEqual([]);
  });

  test('docker mode returns container-internal paths', () => {
    seedFakePlugin('alice', 'openai-codex', 'codex');
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: { 'codex@openai-codex': true },
    });
    const result = loadUserPlugins('alice', { runtime: 'docker' });
    expect(result).toEqual([
      {
        type: 'local',
        path: `${CONTAINER_PLUGINS_PATH}/openai-codex/codex`,
      },
    ]);
  });

  test('host mode returns absolute DATA_DIR paths', () => {
    seedFakePlugin('alice', 'openai-codex', 'codex');
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: { 'codex@openai-codex': true },
    });
    const result = loadUserPlugins('alice', { runtime: 'host' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('local');
    expect(result[0].path).toBe(
      path.join(getUserPluginsCacheDir('alice'), 'openai-codex', 'codex'),
    );
    expect(path.isAbsolute(result[0].path)).toBe(true);
  });

  test('mixes enabled/disabled plugins correctly', () => {
    seedFakePlugin('alice', 'openai-codex', 'codex');
    seedFakePlugin('alice', 'anthropic-tools', 'formatter');
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: {
        'codex@openai-codex': true,
        'formatter@anthropic-tools': false,
      },
    });
    const result = loadUserPlugins('alice', { runtime: 'docker' });
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('openai-codex/codex');
  });

  test('per-user isolation: alice config does not leak to bob', () => {
    seedFakePlugin('alice', 'openai-codex', 'codex');
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: { 'codex@openai-codex': true },
    });
    expect(loadUserPlugins('alice', { runtime: 'host' })).toHaveLength(1);
    expect(loadUserPlugins('bob', { runtime: 'host' })).toHaveLength(0);
  });

  test('skips malformed plugin ids', () => {
    writeUserPluginsFile('alice', {
      marketplaces: {},
      enabled: {
        'malformed-no-at-sign': true,
        '@bad-empty-plugin': true,
        'empty-marketplace@': true,
      },
    });
    expect(loadUserPlugins('alice', { runtime: 'docker' })).toEqual([]);
  });
});
