import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  isValidNameSegment,
  readMarketplaceManifest,
  readPluginManifest,
  scanPluginAssets,
} from '../src/plugin-manifest.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-pm-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

describe('isValidNameSegment', () => {
  test('accepts simple names', () => {
    expect(isValidNameSegment('codex')).toBe(true);
    expect(isValidNameSegment('openai-codex')).toBe(true);
    expect(isValidNameSegment('claude.plugin_v2')).toBe(true);
  });

  test('rejects path traversal and special segments', () => {
    expect(isValidNameSegment('.')).toBe(false);
    expect(isValidNameSegment('..')).toBe(false);
    expect(isValidNameSegment('a/b')).toBe(false);
    expect(isValidNameSegment('a\\b')).toBe(false);
    expect(isValidNameSegment('a b')).toBe(false);
    expect(isValidNameSegment('')).toBe(false);
    // @ts-expect-error — non-string defensive case
    expect(isValidNameSegment(null)).toBe(false);
  });
});

describe('readMarketplaceManifest', () => {
  test('returns parsed manifest with metadata.version + owner.name', () => {
    writeJson(path.join(tmp, '.claude-plugin', 'marketplace.json'), {
      name: 'openai-codex',
      owner: { name: 'OpenAI' },
      metadata: { version: '1.0.3', description: 'desc here' },
    });
    expect(readMarketplaceManifest(tmp)).toEqual({
      name: 'openai-codex',
      version: '1.0.3',
      description: 'desc here',
      owner: 'OpenAI',
      pluginSources: {},
    });
  });

  test('classifies plugin sources from plugins[]', () => {
    writeJson(path.join(tmp, '.claude-plugin', 'marketplace.json'), {
      name: 'mixed',
      plugins: [
        { name: 'inline-str', source: './plugins/inline-str' },
        { name: 'inline-default' }, // no source field → inline by convention
        { name: 'remote-url', source: { source: 'url', url: 'https://x' } },
        {
          name: 'remote-subdir',
          source: { source: 'git-subdir', url: 'https://x', path: 'a' },
        },
        { name: 'bad name' }, // invalid → skipped
        'malformed', // non-object → skipped
      ],
    });
    const m = readMarketplaceManifest(tmp);
    expect(m?.pluginSources).toEqual({
      'inline-str': 'inline',
      'inline-default': 'inline',
      'remote-url': 'remote',
      'remote-subdir': 'remote',
    });
  });

  test('returns null for missing manifest', () => {
    expect(readMarketplaceManifest(tmp)).toBeNull();
  });

  test('returns null for malformed JSON without throwing', () => {
    fs.mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude-plugin', 'marketplace.json'),
      '{ not json',
    );
    expect(readMarketplaceManifest(tmp)).toBeNull();
  });

  test('returns null when name field missing', () => {
    writeJson(path.join(tmp, '.claude-plugin', 'marketplace.json'), {
      metadata: { version: '1' },
    });
    expect(readMarketplaceManifest(tmp)).toBeNull();
  });
});

describe('readPluginManifest', () => {
  test('parses minimum manifest', () => {
    writeJson(path.join(tmp, '.claude-plugin', 'plugin.json'), {
      name: 'codex',
      version: '1.0.0',
    });
    expect(readPluginManifest(tmp)).toEqual({
      name: 'codex',
      version: '1.0.0',
      description: undefined,
    });
  });

  test('returns null for malformed JSON', () => {
    fs.mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude-plugin', 'plugin.json'),
      'not-json',
    );
    expect(readPluginManifest(tmp)).toBeNull();
  });
});

describe('scanPluginAssets', () => {
  test('counts commands/agents/skills/hooks/mcp shallowly', () => {
    fs.mkdirSync(path.join(tmp, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'commands', 'status.md'), '');
    fs.writeFileSync(path.join(tmp, 'commands', 'cancel.md'), '');
    // Junk extension ignored
    fs.writeFileSync(path.join(tmp, 'commands', 'README.txt'), '');

    fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'reviewer.md'), '');

    fs.mkdirSync(path.join(tmp, 'skills', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'skills', 'bar'), { recursive: true });

    fs.mkdirSync(path.join(tmp, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hooks', 'hooks.json'), '{}');

    fs.mkdirSync(path.join(tmp, 'mcp-servers'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'mcp-servers', 'one.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'mcp-servers', 'two.json'), '{}');

    expect(scanPluginAssets(tmp)).toEqual({
      commands: 2,
      agents: 1,
      skills: 2,
      hooks: 1,
      mcpServers: 2,
    });
  });

  test('returns zeros for an empty plugin tree', () => {
    expect(scanPluginAssets(tmp)).toEqual({
      commands: 0,
      agents: 0,
      skills: 0,
      hooks: 0,
      mcpServers: 0,
    });
  });
});
