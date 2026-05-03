/**
 * plugin-command-index.test.ts
 *
 * Behavior coverage for src/plugin-command-index.ts:
 *   - YAML frontmatter parsing (well-formed, malformed, missing)
 *   - Alias generation: every command file produces a short + namespaced key
 *   - Built-in command shadowing: short alias dropped when name collides with
 *     a hardcoded built-in command
 *   - Hit / miss / conflict resolution
 *   - Multi-plugin (short-name) and multi-marketplace (namespaced) conflicts
 *   - Cache invalidation forces a re-read on next build
 */

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

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const pluginUtils = await import('../src/plugin-utils.js');
const cmdIndex = await import('../src/plugin-command-index.js');

const {
  writeUserPluginsV2,
  getUserPluginRuntimePath,
} = pluginUtils;
const {
  buildCommandIndex,
  resolveCommand,
  invalidateUserCommandIndex,
  indexEntries,
  isBuiltinCommandName,
  _resetCommandIndexCacheForTests,
} = cmdIndex;

interface SeedCmd {
  name: string;
  /** Raw markdown content of the command file (frontmatter + body). */
  content: string;
}

function seedPluginRuntime(opts: {
  userId: string;
  marketplace: string;
  plugin: string;
  snapshot: string;
  commands: SeedCmd[];
}): string {
  const dir = getUserPluginRuntimePath(
    opts.userId,
    opts.snapshot,
    opts.marketplace,
    opts.plugin,
  );
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: opts.plugin, version: '1.0.0' }),
  );
  const cmdsDir = path.join(dir, 'commands');
  fs.mkdirSync(cmdsDir, { recursive: true });
  for (const c of opts.commands) {
    fs.writeFileSync(path.join(cmdsDir, `${c.name}.md`), c.content);
  }
  return dir;
}

function enable(opts: {
  userId: string;
  fullId: string;
  marketplace: string;
  plugin: string;
  snapshot: string;
}) {
  writeUserPluginsV2(opts.userId, {
    schemaVersion: 1,
    enabled: {
      [opts.fullId]: {
        enabled: true,
        marketplace: opts.marketplace,
        plugin: opts.plugin,
        snapshot: opts.snapshot,
        enabledAt: '2026-04-26T00:00:00.000Z',
      },
    },
  });
}

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cmd-index-'));
  _resetCommandIndexCacheForTests();
});

afterEach(() => {
  if (tmpDataDir && fs.existsSync(tmpDataDir)) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
  _resetCommandIndexCacheForTests();
});

describe('isBuiltinCommandName', () => {
  test('covers all 17 builtin command names', () => {
    for (const name of [
      'clear', 'list', 'ls', 'status', 'recall', 'rc', 'where',
      'unbind', 'bind', 'new', 'require_mention', 'owner_mention',
      'sw', 'spawn', 'allow', 'disallow', 'allowlist',
    ]) {
      expect(isBuiltinCommandName(name)).toBe(true);
    }
  });

  test('returns false for non-builtin names', () => {
    expect(isBuiltinCommandName('codex')).toBe(false);
    expect(isBuiltinCommandName('review')).toBe(false);
    expect(isBuiltinCommandName('result')).toBe(false);
    expect(isBuiltinCommandName('')).toBe(false);
  });
});

describe('buildCommandIndex — YAML frontmatter parsing', () => {
  test('parses well-formed frontmatter (description / argument-hint / DMI)', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'openai-codex',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
      commands: [
        {
          name: 'review',
          content:
            '---\n' +
            'description: Run a Codex code review against local git state\n' +
            "argument-hint: '[--wait|--background]'\n" +
            'disable-model-invocation: true\n' +
            'allowed-tools: Read, Glob, Grep\n' +
            '---\n\n' +
            'Run a Codex review.\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@openai-codex',
      marketplace: 'openai-codex',
      plugin: 'codex',
      snapshot: 'sha256-aaa',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.entries).toHaveLength(1);
    const e = idx.entries[0];
    expect(e.fullId).toBe('codex@openai-codex');
    expect(e.marketplace).toBe('openai-codex');
    expect(e.plugin).toBe('codex');
    expect(e.snapshot).toBe('sha256-aaa');
    expect(e.commandName).toBe('review');
    expect(e.description).toBe(
      'Run a Codex code review against local git state',
    );
    expect(e.argumentHint).toBe('[--wait|--background]');
    expect(e.disableModelInvocation).toBe(true);
    expect(e.frontmatter['allowed-tools']).toBe('Read, Glob, Grep');
    expect(e.body).toContain('Run a Codex review.');
    // Body preserves whatever follows the closing `---` delimiter — does not
    // strip a leading blank line if the source had one.
    expect(e.body.endsWith('Run a Codex review.\n')).toBe(true);
    expect(e.commandFile.endsWith('/commands/review.md')).toBe(true);
  });

  test('malformed YAML frontmatter degrades to empty frontmatter + body keeps full text after delimiters', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
      commands: [
        {
          name: 'broken',
          // ': : :' is invalid YAML mapping
          content:
            '---\n: : :\n: invalid yaml ::\n---\n\nbody text\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'p1@mp1',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.entries).toHaveLength(1);
    const e = idx.entries[0];
    expect(e.frontmatter).toEqual({});
    expect(e.description).toBeUndefined();
    expect(e.disableModelInvocation).toBe(false);
    expect(e.body).toContain('body text');
  });

  test('missing frontmatter → frontmatter={} body=full content', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
      commands: [
        {
          name: 'plain',
          content: 'just markdown body, no frontmatter\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'p1@mp1',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.entries).toHaveLength(1);
    const e = idx.entries[0];
    expect(e.frontmatter).toEqual({});
    expect(e.disableModelInvocation).toBe(false);
    expect(e.body).toBe('just markdown body, no frontmatter\n');
  });
});

describe('buildCommandIndex — alias generation', () => {
  test('commands/foo.md → registers /foo + /plugin:foo', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [
        { name: 'foo', content: '---\ndescription: x\n---\n\nbody\n' },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.byShort.get('foo')).toHaveLength(1);
    expect(idx.byNamespaced.get('codex:foo')).toHaveLength(1);
    expect(idx.conflicts).toEqual([]);
  });

  test('built-in command name (status) is NOT registered as short alias; namespaced still works', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'openai-codex',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [
        {
          name: 'status',
          content: '---\ndisable-model-invocation: true\n---\n\nstatus body\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@openai-codex',
      marketplace: 'openai-codex',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.byShort.has('status')).toBe(false);
    expect(idx.byNamespaced.get('codex:status')).toHaveLength(1);
    expect(idx.conflicts).toEqual([]);
  });

  test('every other built-in name is also blocked from short registry', async () => {
    // Test a couple representative ones that plugins might genuinely ship
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
      commands: [
        { name: 'list', content: 'a\n' },
        { name: 'clear', content: 'b\n' },
        { name: 'recall', content: 'c\n' },
        { name: 'review', content: 'd\n' }, // not a builtin → short registers
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'p1@mp1',
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.byShort.has('list')).toBe(false);
    expect(idx.byShort.has('clear')).toBe(false);
    expect(idx.byShort.has('recall')).toBe(false);
    expect(idx.byShort.get('review')).toHaveLength(1);
    expect(idx.byNamespaced.get('p1:list')).toHaveLength(1);
    expect(idx.byNamespaced.get('p1:clear')).toHaveLength(1);
    expect(idx.byNamespaced.get('p1:recall')).toHaveLength(1);
    expect(idx.byNamespaced.get('p1:review')).toHaveLength(1);
  });
});

describe('resolveCommand — hit / miss / conflict', () => {
  test('miss: nothing enabled', async () => {
    const idx = await buildCommandIndex('alice');
    expect(resolveCommand(idx, '/foo')).toEqual({ kind: 'miss' });
    expect(resolveCommand(idx, 'foo')).toEqual({ kind: 'miss' });
  });

  test('hit: single plugin single command, both bare and namespaced', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [
        {
          name: 'review',
          content: '---\ndescription: r\n---\n\nbody\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    const byShort = resolveCommand(idx, '/review');
    const byNamespaced = resolveCommand(idx, '/codex:review');
    expect(byShort.kind).toBe('hit');
    expect(byNamespaced.kind).toBe('hit');
    if (byShort.kind === 'hit' && byNamespaced.kind === 'hit') {
      expect(byShort.entry.commandFile).toBe(byNamespaced.entry.commandFile);
      expect(byShort.entry.description).toBe('r');
    }
  });

  test('miss for unknown namespaced command', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'review', content: 'x\n' }],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(resolveCommand(idx, '/codex:nope').kind).toBe('miss');
    expect(resolveCommand(idx, '/other:review').kind).toBe('miss');
  });

  test('short-name conflict: 2 plugins each ship `/list-mine` → byShort >1 → conflict', async () => {
    // Use a non-builtin short name so it actually registers
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp-a',
      plugin: 'pa',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'a\n' }],
    });
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp-b',
      plugin: 'pb',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'b\n' }],
    });
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'pa@mp-a': {
          enabled: true,
          marketplace: 'mp-a',
          plugin: 'pa',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'pb@mp-b': {
          enabled: true,
          marketplace: 'mp-b',
          plugin: 'pb',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.byShort.get('foo')).toHaveLength(2);
    expect(idx.conflicts).toContain('foo');
    // Namespaced is unique because plugin names differ
    expect(idx.byNamespaced.get('pa:foo')).toHaveLength(1);
    expect(idx.byNamespaced.get('pb:foo')).toHaveLength(1);

    const r = resolveCommand(idx, '/foo');
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') {
      expect(r.key).toBe('foo');
      expect(r.candidates).toHaveLength(2);
      const fullIds = r.candidates.map((c) => c.fullId).sort();
      expect(fullIds).toEqual(['pa@mp-a', 'pb@mp-b']);
    }
    // Resolving via namespaced path bypasses the conflict
    expect(resolveCommand(idx, '/pa:foo').kind).toBe('hit');
    expect(resolveCommand(idx, '/pb:foo').kind).toBe('hit');
  });

  test('namespaced conflict: 2 marketplaces each ship same plugin@name with same command', async () => {
    // codex@mp-a + codex@mp-b both define commands/status.md →
    // byNamespaced["codex:status"] has 2 entries → conflict.
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp-a',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'review', content: 'a\n' }],
    });
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp-b',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'review', content: 'b\n' }],
    });
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@mp-a': {
          enabled: true,
          marketplace: 'mp-a',
          plugin: 'codex',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'codex@mp-b': {
          enabled: true,
          marketplace: 'mp-b',
          plugin: 'codex',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.byNamespaced.get('codex:review')).toHaveLength(2);
    expect(idx.byShort.get('review')).toHaveLength(2);
    expect(idx.conflicts).toContain('codex:review');
    expect(idx.conflicts).toContain('review');

    const namespaced = resolveCommand(idx, '/codex:review');
    expect(namespaced.kind).toBe('conflict');
    if (namespaced.kind === 'conflict') {
      expect(namespaced.key).toBe('codex:review');
      expect(namespaced.candidates).toHaveLength(2);
    }
  });

  test('disabled plugin refs are excluded from the index', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'x\n' }],
    });
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: false,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.entries).toHaveLength(0);
  });

  test('refs whose runtime is unmaterialized are skipped (not crash)', async () => {
    // No seedPluginRuntime call → runtime dir absent
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 'snap1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const idx = await buildCommandIndex('alice');
    expect(idx.entries).toHaveLength(0);
  });
});

describe('Cache invalidation', () => {
  test('build is cached: post-build runtime changes do NOT show until invalidate', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'one\n' }],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const first = await buildCommandIndex('alice');
    expect(first.entries).toHaveLength(1);

    // Add a 2nd command file on disk after caching
    const dir = getUserPluginRuntimePath('alice', 'snap1', 'mp1', 'codex');
    fs.writeFileSync(path.join(dir, 'commands', 'bar.md'), 'two\n');

    const second = await buildCommandIndex('alice');
    expect(second).toBe(first); // identity: cache served
    expect(second.entries).toHaveLength(1);

    invalidateUserCommandIndex('alice');
    const third = await buildCommandIndex('alice');
    expect(third).not.toBe(first);
    expect(third.entries).toHaveLength(2);
    const names = third.entries.map((e) => e.commandName).sort();
    expect(names).toEqual(['bar', 'foo']);
  });

  test('runtime-missing build caches empty index; invalidate restores after materialize', async () => {
    // Repro of the codex P1 / PR2.a bug: enabling a plugin before its runtime
    // tree exists (or after GC) causes buildCommandIndex to return an empty
    // entries list. That empty result gets cached, so /api/plugins/commands
    // keeps returning [] until the cache is dropped. POST /materialize must
    // invalidate, mirroring PATCH /enabled and DELETE /marketplaces.
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    // Runtime dir absent → build returns empty + caches it.
    const empty = await buildCommandIndex('alice');
    expect(empty.entries).toHaveLength(0);

    // Simulate POST /materialize seeding the runtime tree.
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'one\n' }],
    });

    // Without invalidate, the cached empty result is still served.
    const stillCached = await buildCommandIndex('alice');
    expect(stillCached).toBe(empty);
    expect(stillCached.entries).toHaveLength(0);

    // Simulate the materialize handler dropping the cache.
    invalidateUserCommandIndex('alice');

    const fresh = await buildCommandIndex('alice');
    expect(fresh).not.toBe(empty);
    expect(fresh.entries).toHaveLength(1);
    expect(fresh.entries[0].commandName).toBe('foo');
  });

  test('per-user isolation: alice index does not leak to bob', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'x\n' }],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const aliceIdx = await buildCommandIndex('alice');
    const bobIdx = await buildCommandIndex('bob');
    expect(aliceIdx.entries).toHaveLength(1);
    expect(bobIdx.entries).toHaveLength(0);
    expect(aliceIdx).not.toBe(bobIdx);
  });
});

describe('indexEntries (pure)', () => {
  test('records both layers of conflict in `conflicts`', () => {
    const baseEntry = (
      fullId: string,
      marketplace: string,
      plugin: string,
      commandName: string,
    ) =>
      ({
        fullId,
        marketplace,
        plugin,
        snapshot: 's',
        commandName,
        commandFile: '/x.md',
        disableModelInvocation: false,
        frontmatter: {},
        body: '',
      }) as const;

    const idx = indexEntries([
      // Two marketplaces, same plugin name, same command → namespaced conflict
      baseEntry('codex@mp-a', 'mp-a', 'codex', 'review'),
      baseEntry('codex@mp-b', 'mp-b', 'codex', 'review'),
      // Different plugins, same command name → short conflict
      baseEntry('alpha@mp-a', 'mp-a', 'alpha', 'foo'),
      baseEntry('beta@mp-b', 'mp-b', 'beta', 'foo'),
    ]);

    expect(idx.conflicts).toContain('codex:review');
    expect(idx.conflicts).toContain('foo');
    // No duplicates (each conflict key appears once)
    const dedup = new Set(idx.conflicts);
    expect(dedup.size).toBe(idx.conflicts.length);
  });
});

describe('resolveCommand — input forms', () => {
  test('accepts both leading slash and bare token; whitespace-trims', async () => {
    seedPluginRuntime({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
      commands: [{ name: 'foo', content: 'x\n' }],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp1',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 'snap1',
    });

    const idx = await buildCommandIndex('alice');
    expect(resolveCommand(idx, '/foo').kind).toBe('hit');
    expect(resolveCommand(idx, 'foo').kind).toBe('hit');
    expect(resolveCommand(idx, '  /foo  ').kind).toBe('hit');
    expect(resolveCommand(idx, '/codex:foo').kind).toBe('hit');
    expect(resolveCommand(idx, 'codex:foo').kind).toBe('hit');
  });

  test('miss for empty / pure slash / non-string input', async () => {
    const idx = await buildCommandIndex('alice');
    expect(resolveCommand(idx, '').kind).toBe('miss');
    expect(resolveCommand(idx, '/').kind).toBe('miss');
    // @ts-expect-error — runtime input from message channels can be anything
    expect(resolveCommand(idx, undefined).kind).toBe('miss');
    // @ts-expect-error
    expect(resolveCommand(idx, 42).kind).toBe('miss');
  });
});
