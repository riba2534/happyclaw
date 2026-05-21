import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildNodeCandidates,
  resolveBinaryOnPath,
  resolveNodeBinary,
} from '../src/node-resolver.js';

const HOME = '/home/test';

function ctx(overrides: {
  env?: Record<string, string | undefined>;
  execPath?: string;
  argv0?: string;
  homeDir?: string;
  isExecutable: (filePath: string) => boolean;
}) {
  return {
    env: {},
    execPath: undefined,
    argv0: undefined,
    homeDir: HOME,
    ...overrides,
  };
}

describe('buildNodeCandidates', () => {
  test('process.execPath comes first when it has a Node basename', () => {
    const candidates = buildNodeCandidates(
      ctx({
        execPath: '/custom/node',
        env: { NVM_BIN: '/nvm/bin', PATH: '/usr/bin' },
        isExecutable: () => false,
      }),
    );
    expect(candidates[0]).toBe('/custom/node');
  });

  test('filters process execPath and argv0 to Node binary basenames', () => {
    const accepted = buildNodeCandidates(
      ctx({
        execPath: '/usr/bin/nodejs',
        argv0: 'C:\\Program Files\\nodejs\\node.exe',
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(accepted[0]).toBe('/usr/bin/nodejs');
    expect(accepted[1]).toBe('C:\\Program Files\\nodejs\\node.exe');

    const rejected = buildNodeCandidates(
      ctx({
        execPath: '/opt/homebrew/bin/bun',
        argv0: '/tmp/node-wrapper',
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(rejected).not.toContain('/opt/homebrew/bin/bun');
    expect(rejected).not.toContain('/tmp/node-wrapper');
  });

  test('NVM_BIN / FNM_MULTISHELL_PATH / VOLTA_HOME are joined with node', () => {
    const candidates = buildNodeCandidates(
      ctx({
        env: {
          NVM_BIN: '/nvm/bin',
          FNM_MULTISHELL_PATH: '/fnm/shell',
          VOLTA_HOME: '/volta',
        },
        isExecutable: () => false,
      }),
    );
    expect(candidates).toContain('/nvm/bin/node');
    expect(candidates).toContain('/fnm/shell/bin/node');
    expect(candidates).toContain(path.join('/volta', 'bin', 'node'));
  });

  test('skips env-derived candidates when env vars are missing', () => {
    const candidates = buildNodeCandidates(
      ctx({
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(candidates.every((c) => !c.includes('/nvm/'))).toBe(true);
    expect(candidates.every((c) => !c.includes('/fnm/shell/'))).toBe(true);
    expect(candidates.every((c) => !c.includes('/volta/'))).toBe(true);
  });

  test('includes hardcoded fallbacks regardless of env', () => {
    const candidates = buildNodeCandidates(
      ctx({
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(candidates).toContain('/opt/homebrew/bin/node');
    expect(candidates).toContain('/usr/local/bin/node');
    expect(candidates).toContain('/usr/bin/node');
  });

  test('includes fnm aliases default path under HOME', () => {
    const candidates = buildNodeCandidates(
      ctx({
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(candidates).toContain(
      path.join(
        HOME,
        '.local',
        'share',
        'fnm',
        'aliases',
        'default',
        'bin',
        'node',
      ),
    );
  });

  test('does not include the non-existent NVM "current" symlink path', () => {
    // NVM does not maintain a "current" symlink (unlike fnm). The original
    // PR #539 had this entry but it would never match in practice.
    const candidates = buildNodeCandidates(
      ctx({
        env: {},
        isExecutable: () => false,
      }),
    );
    expect(
      candidates.every((c) => !c.endsWith('/.nvm/versions/node/current/bin/node')),
    ).toBe(true);
  });

  test('filters out null and empty candidates', () => {
    const candidates = buildNodeCandidates(
      ctx({
        env: { PATH: '' },
        execPath: '',
        isExecutable: () => false,
      }),
    );
    expect(candidates.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
  });
});

describe('resolveBinaryOnPath', () => {
  test('returns first executable match in PATH order', () => {
    const exec = new Set(['/opt/bin/node']);
    const result = resolveBinaryOnPath(
      'node',
      '/no-here:/opt/bin:/usr/bin',
      (p) => exec.has(p),
    );
    expect(result).toBe('/opt/bin/node');
  });

  test('returns null when nothing matches', () => {
    const result = resolveBinaryOnPath(
      'node',
      '/a:/b:/c',
      () => false,
    );
    expect(result).toBeNull();
  });

  test('returns null when PATH is undefined or empty', () => {
    expect(resolveBinaryOnPath('node', undefined, () => true)).toBeNull();
    expect(resolveBinaryOnPath('node', '', () => true)).toBeNull();
  });

  test('skips empty segments without crashing', () => {
    const exec = new Set(['/usr/bin/node']);
    const result = resolveBinaryOnPath(
      'node',
      '::/usr/bin::',
      (p) => exec.has(p),
    );
    expect(result).toBe('/usr/bin/node');
  });
});

describe('resolveNodeBinary', () => {
  test('returns process.execPath when it is executable (highest priority)', () => {
    const result = resolveNodeBinary(
      ctx({
        execPath: '/parent/node',
        env: { NVM_BIN: '/nvm/bin', PATH: '/usr/bin' },
        isExecutable: () => true, // everything executable, must pick first
      }),
    );
    expect(result).toBe('/parent/node');
  });

  test('falls back to argv0 when execPath is missing', () => {
    const exec = new Set(['/argv0/node']);
    const result = resolveNodeBinary(
      ctx({
        argv0: '/argv0/node',
        env: {},
        isExecutable: (p) => exec.has(p),
      }),
    );
    expect(result).toBe('/argv0/node');
  });

  test('does not choose Bun-like execPath or argv0 even when executable', () => {
    const exec = new Set(['/opt/homebrew/bin/bun', '/nvm/bin/node']);
    const result = resolveNodeBinary(
      ctx({
        execPath: '/opt/homebrew/bin/bun',
        argv0: '/opt/homebrew/bin/bun',
        env: { NVM_BIN: '/nvm/bin' },
        isExecutable: (p) => exec.has(p),
      }),
    );
    expect(result).toBe('/nvm/bin/node');
  });

  test('falls back to NVM_BIN/node when execPath and argv0 are missing', () => {
    const exec = new Set(['/nvm/bin/node']);
    const result = resolveNodeBinary(
      ctx({
        env: { NVM_BIN: '/nvm/bin' },
        isExecutable: (p) => exec.has(p),
      }),
    );
    expect(result).toBe('/nvm/bin/node');
  });

  test('resolves via PATH when env-specific candidates miss', () => {
    const exec = new Set(['/usr/local/bin/node']);
    const result = resolveNodeBinary(
      ctx({
        env: { PATH: '/no-here:/usr/local/bin' },
        isExecutable: (p) => exec.has(p),
      }),
    );
    expect(result).toBe('/usr/local/bin/node');
  });

  test('falls back to hardcoded /opt/homebrew/bin/node', () => {
    const exec = new Set(['/opt/homebrew/bin/node']);
    const result = resolveNodeBinary(
      ctx({
        env: {},
        isExecutable: (p) => exec.has(p),
      }),
    );
    expect(result).toBe('/opt/homebrew/bin/node');
  });

  test('returns literal "node" when nothing matches (final fallback)', () => {
    const result = resolveNodeBinary(
      ctx({
        env: { PATH: '/a:/b' },
        execPath: '/no-here/node',
        isExecutable: () => false,
      }),
    );
    expect(result).toBe('node');
  });
});
