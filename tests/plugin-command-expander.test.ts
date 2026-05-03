/**
 * plugin-command-expander.test.ts
 *
 * Behavior coverage for src/plugin-command-expander.ts:
 *   - Slash detection / non-plugin commands → miss
 *   - DMI=false → miss (SDK handles)
 *   - Conflict → reply with namespaced suggestions
 *   - Docker mode + no active container + inline command → reply
 *   - Inline `!` template execution: stdout splice + frontmatter wrap
 *   - Body-path placeholder substitution: ${CLAUDE_PLUGIN_ROOT}, $ARGUMENTS, $1/$2
 *   - Fenced ```bash``` blocks pass through verbatim
 *   - Failure modes: spawn error / non-zero exit → `<!-- inline command failed -->`
 *   - $ARGUMENTS env semantics — single string, includes quotes literally
 *   - expandMessagesIfNeeded batch helper splits into toSend / replies correctly
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
  GROUPS_DIR: '/tmp/unused',
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
const expander = await import('../src/plugin-command-expander.js');

const { writeUserPluginsV2, getUserPluginRuntimePath } = pluginUtils;
const { _resetCommandIndexCacheForTests } = cmdIndex;
const {
  expandPluginSlashCommandIfNeeded,
  expandMessagesIfNeeded,
  whitespaceSplit,
} = expander;

// --- Test seam helpers -----------------------------------------------------

interface SeedCmd {
  name: string;
  content: string;
}

function seedPlugin(opts: {
  userId: string;
  marketplace: string;
  plugin: string;
  snapshot: string;
  commands: SeedCmd[];
}): void {
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
}

function enable(opts: {
  userId: string;
  fullId: string;
  marketplace: string;
  plugin: string;
  snapshot: string;
}): void {
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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-expand-'));
  _resetCommandIndexCacheForTests();
});

afterEach(() => {
  if (tmpDataDir && fs.existsSync(tmpDataDir)) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
  _resetCommandIndexCacheForTests();
});

const ctxHost = (userId = 'alice') => ({
  userId,
  groupJid: 'web:home-alice',
  groupFolder: 'home-alice',
  cwd: '/data/groups/home-alice',
  executionMode: 'host' as const,
  containerName: null,
});

const ctxDocker = (userId = 'alice', containerName: string | null = 'c-1') => ({
  userId,
  groupJid: 'web:home-alice',
  groupFolder: 'home-alice',
  cwd: '/workspace/group',
  executionMode: 'container' as const,
  containerName,
});

// --- Slash detection / miss --------------------------------------------- //

describe('expandPluginSlashCommandIfNeeded — miss paths', () => {
  test('non-slash message → miss', async () => {
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), 'hello world');
    expect(r.kind).toBe('miss');
  });

  test('slash but no plugin commands enabled → miss', async () => {
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/codex status');
    expect(r.kind).toBe('miss');
  });

  test('plugin command exists but DMI=false → miss (SDK handles)', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\ndescription: Review code\ndisable-model-invocation: false\n---\n\nReview body.\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/review');
    expect(r.kind).toBe('miss');
  });

  test('slash with non-existent token → miss', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\ndescription: r\ndisable-model-invocation: true\n---\n\nbody\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(
      ctxHost(),
      '/totally-unknown',
    );
    expect(r.kind).toBe('miss');
  });
});

// --- Conflict path ------------------------------------------------------- //

describe('expandPluginSlashCommandIfNeeded — conflict', () => {
  test('two plugins shipping the same short name → reply with namespaced suggestions', async () => {
    // Seed two plugins, both contributing /result. Both DMI to ensure
    // command index registers them (built-in `status` would be filtered for
    // short alias, so we use a non-builtin name `result` instead).
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 's1',
      commands: [
        {
          name: 'result',
          content:
            '---\ndescription: r1\ndisable-model-invocation: true\n---\n\nbody1\n',
        },
      ],
    });
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp2',
      plugin: 'codexlite',
      snapshot: 's2',
      commands: [
        {
          name: 'result',
          content:
            '---\ndescription: r2\ndisable-model-invocation: true\n---\n\nbody2\n',
        },
      ],
    });
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 's1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'codexlite@mp2': {
          enabled: true,
          marketplace: 'mp2',
          plugin: 'codexlite',
          snapshot: 's2',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/result');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('/codex:result');
    expect(r.text).toContain('/codexlite:result');
  });
});

// --- Body-path placeholder substitution --------------------------------- //

describe('expandPluginSlashCommandIfNeeded — body path (no inline)', () => {
  test('substitutes ${CLAUDE_PLUGIN_ROOT}, $ARGUMENTS, $1/$2 outside fences', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\n' +
            'description: Review\n' +
            'disable-model-invocation: true\n' +
            '---\n\n' +
            'Plugin path: ${CLAUDE_PLUGIN_ROOT}\n' +
            'Arguments: $ARGUMENTS\n' +
            'First positional: $1, second: $2\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(
      ctxHost(),
      '/review --base main feature',
    );
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.prompt).toContain('Plugin path: ');
    expect(r.prompt).toMatch(/Plugin path: .*plugins.runtime.alice.snapshots.sha.mp.codex/);
    expect(r.prompt).toContain('Arguments: --base main feature');
    expect(r.prompt).toContain('First positional: --base, second: main');
    // Frontmatter summary appears before body.
    expect(r.prompt).toContain('Command: /review');
    expect(r.prompt).toContain('Plugin: codex@mp');
  });

  test('docker mode pluginRoot uses /workspace/plugins prefix without userId', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\ndescription: r\ndisable-model-invocation: true\n---\n\n' +
            'Path: ${CLAUDE_PLUGIN_ROOT}\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxDocker(), '/review');
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.prompt).toContain('Path: /workspace/plugins/snapshots/sha/mp/codex');
    expect(r.prompt).not.toContain('alice');
  });

  test('fenced ```bash``` block keeps placeholders verbatim', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\ndescription: r\ndisable-model-invocation: true\n---\n\n' +
            'Outside fence: ${CLAUDE_PLUGIN_ROOT}\n' +
            '```bash\n' +
            'echo ${CLAUDE_PLUGIN_ROOT}/script.mjs\n' +
            'echo $ARGUMENTS\n' +
            'echo $1\n' +
            '```\n' +
            'After fence: $ARGUMENTS\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/review hello');
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    // Outside fence: ${CLAUDE_PLUGIN_ROOT} → plugin root path
    expect(r.prompt).toMatch(/Outside fence: .*snapshots.sha.mp.codex/);
    // Inside fence: kept verbatim — no substitution
    expect(r.prompt).toContain('echo ${CLAUDE_PLUGIN_ROOT}/script.mjs');
    expect(r.prompt).toContain('echo $ARGUMENTS');
    expect(r.prompt).toContain('echo $1');
    // After fence resumes substitution
    expect(r.prompt).toContain('After fence: hello');
  });
});

// --- Inline `!` template execution -------------------------------------- //

describe('expandPluginSlashCommandIfNeeded — inline path', () => {
  test('host: executes inline command, splices stdout, drops trailing newlines', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: status\ndisable-model-invocation: true\n---\n\n' +
            'Status output:\n' +
            '!`echo hello`\n' +
            'End.\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });

    const execHost = vi.fn(async () => ({
      ok: true,
      stdout: 'INLINE_RESULT\n\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const execDocker = vi.fn();
    const r = await expandPluginSlashCommandIfNeeded(
      ctxHost(),
      '/inspect',
      { execHost: execHost as any, execDocker: execDocker as any },
    );
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(execHost).toHaveBeenCalledTimes(1);
    expect(execDocker).not.toHaveBeenCalled();

    // The inline line is replaced with stdout (trailing \n stripped).
    expect(r.prompt).toContain('INLINE_RESULT');
    expect(r.prompt).not.toContain('!`echo hello`');
    // Surrounding lines remain.
    expect(r.prompt).toContain('Status output:');
    expect(r.prompt).toContain('End.');
  });

  test('docker: executes via docker exec when container present', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            '!`node ${CLAUDE_PLUGIN_ROOT}/script.mjs "$ARGUMENTS"`\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });

    const execDocker = vi.fn(async () => ({
      ok: true,
      stdout: 'DOCKER_OUT',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const execHost = vi.fn();

    const r = await expandPluginSlashCommandIfNeeded(
      ctxDocker('alice', 'happyclaw-c-abc'),
      '/inspect --base "main branch"',
      { execHost: execHost as any, execDocker: execDocker as any },
    );
    expect(r.kind).toBe('expanded');
    expect(execHost).not.toHaveBeenCalled();
    expect(execDocker).toHaveBeenCalledTimes(1);

    const [container, rawCmd, posArgs, env] = execDocker.mock.calls[0];
    expect(container).toBe('happyclaw-c-abc');
    expect(rawCmd).toBe('node ${CLAUDE_PLUGIN_ROOT}/script.mjs "$ARGUMENTS"');
    // posArgs are whitespace-split — quotes preserved literally.
    expect(posArgs).toEqual(['--base', '"main', 'branch"']);
    // $ARGUMENTS env preserves the original argstring verbatim.
    expect(env.ARGUMENTS).toBe('--base "main branch"');
    expect(env.CLAUDE_PLUGIN_ROOT).toBe(
      '/workspace/plugins/snapshots/sha/mp/codex',
    );
  });

  test('docker mode + no active container + has inline → reply', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            '!`echo hello`\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const execHost = vi.fn();
    const execDocker = vi.fn();
    const r = await expandPluginSlashCommandIfNeeded(
      ctxDocker('alice', null), // no container
      '/inspect',
      { execHost: execHost as any, execDocker: execDocker as any },
    );
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.text).toContain('请先发起对话');
    expect(execHost).not.toHaveBeenCalled();
    expect(execDocker).not.toHaveBeenCalled();
  });

  test('inline command failure → splices `<!-- inline command failed -->` marker', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            '!`exit 9`\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const execHost = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: 'boom',
      exitCode: 9,
      signal: null,
      timedOut: false,
    }));
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/inspect', {
      execHost: execHost as any,
      execDocker: (() => {}) as any,
    });
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.prompt).toContain('<!-- inline command failed: exit code 9 -->');
    expect(r.prompt).not.toContain('!`exit 9`');
  });

  test('inline command timeout → marker mentions "timed out"', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            '!`sleep 999`\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const execHost = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: 'SIGTERM' as NodeJS.Signals,
      timedOut: true,
    }));
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/inspect', {
      execHost: execHost as any,
      execDocker: (() => {}) as any,
    });
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.prompt).toContain('<!-- inline command failed: timed out');
  });

  test('inline `!` inside fenced block is not executed', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            'Plain prefix.\n' +
            '```bash\n' +
            '!`echo INSIDE_FENCE`\n' +
            '```\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const execHost = vi.fn();
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/inspect', {
      execHost: execHost as any,
      execDocker: (() => {}) as any,
    });
    expect(execHost).not.toHaveBeenCalled();
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    // Fence content stays verbatim — including the `!` line.
    expect(r.prompt).toContain('!`echo INSIDE_FENCE`');
  });
});

// --- #19 P2-3 regression: inline stdout never re-substituted ----------- //

describe('inline output is opaque — placeholders inside captured stdout pass through verbatim (#19 P2-3)', () => {
  test('plugin prints literal $1 / $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} → splice keeps them as-is', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'inspect',
          // Body has the inline `!` line plus surrounding free text that DOES
          // contain placeholders — those should still get substituted. Only
          // the captured stdout from the `!` execution must stay verbatim.
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            'Free text: $1 -> [posarg-substituted-here]\n' +
            '!`shellprint`\n' +
            'After: $ARGUMENTS -> [args-substituted-here]\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });

    // The inline command's stdout deliberately contains the same placeholder
    // tokens we substitute in free text. The fix guarantees the splice path
    // does not re-scan stdout.
    const execHost = vi.fn(async () => ({
      ok: true,
      stdout:
        '# captured shell snippet\n' +
        'echo "first arg is $1"\n' +
        'echo "raw args: $ARGUMENTS"\n' +
        'echo "root: ${CLAUDE_PLUGIN_ROOT}"\n',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const r = await expandPluginSlashCommandIfNeeded(
      ctxHost(),
      '/inspect alpha beta',
      { execHost: execHost as any, execDocker: (() => {}) as any },
    );
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;

    // Free-text placeholders DID substitute (free text uses applyPlaceholders).
    expect(r.prompt).toContain('Free text: alpha -> [posarg-substituted-here]');
    expect(r.prompt).toContain(
      'After: alpha beta -> [args-substituted-here]',
    );

    // Captured stdout MUST contain the literal placeholder tokens — never
    // rewritten. Before #19 P2-3 these would have been mangled to the values
    // of posArgs[0] / rawArgs / pluginRoot.
    expect(r.prompt).toContain('echo "first arg is $1"');
    expect(r.prompt).toContain('echo "raw args: $ARGUMENTS"');
    expect(r.prompt).toContain('echo "root: ${CLAUDE_PLUGIN_ROOT}"');
  });
});

// --- Frontmatter rendering --------------------------------------------- //

describe('frontmatter summary', () => {
  test('includes description / argument-hint / disable-model-invocation', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'review',
          content:
            '---\n' +
            'description: Run a Codex code review\n' +
            "argument-hint: '[--wait|--bg]'\n" +
            'disable-model-invocation: true\n' +
            'allowed-tools: Read, Glob, Grep\n' +
            '---\n\nbody\n',
        },
      ],
    });
    enable({
      userId: 'alice',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/review --bg');
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.prompt).toContain('description: Run a Codex code review');
    expect(r.prompt).toContain('argument-hint: [--wait|--bg]');
    expect(r.prompt).toContain('disable-model-invocation: true');
    expect(r.prompt).toContain('Arguments: --bg');
  });
});

// --- whitespaceSplit ---------------------------------------------------- //

describe('whitespaceSplit', () => {
  test('splits on whitespace, drops empties', () => {
    expect(whitespaceSplit('--base main')).toEqual(['--base', 'main']);
    expect(whitespaceSplit('  a   b  ')).toEqual(['a', 'b']);
    expect(whitespaceSplit('')).toEqual([]);
  });

  test('quotes are preserved as literals (no shell-like parsing)', () => {
    expect(whitespaceSplit('--base "main branch"')).toEqual([
      '--base',
      '"main',
      'branch"',
    ]);
  });
});

// --- expandMessagesIfNeeded batch helper ------------------------------- //

describe('expandMessagesIfNeeded — batch', () => {
  test('mixed batch: miss + expanded + reply → toSend gets miss + expanded; replies has reply', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp1',
      plugin: 'codex',
      snapshot: 's1',
      commands: [
        {
          name: 'result',
          content:
            '---\ndescription: r1\ndisable-model-invocation: true\n---\n\nbody1\n',
        },
      ],
    });
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp2',
      plugin: 'codexlite',
      snapshot: 's2',
      commands: [
        {
          name: 'result',
          content:
            '---\ndescription: r2\ndisable-model-invocation: true\n---\n\nbody2\n',
        },
      ],
    });
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp3',
      plugin: 'review',
      snapshot: 's3',
      commands: [
        {
          name: 'review',
          content:
            '---\ndescription: r\ndisable-model-invocation: true\n---\n\nReview body $ARGUMENTS\n',
        },
      ],
    });
    writeUserPluginsV2('alice', {
      schemaVersion: 1,
      enabled: {
        'codex@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'codex',
          snapshot: 's1',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'codexlite@mp2': {
          enabled: true,
          marketplace: 'mp2',
          plugin: 'codexlite',
          snapshot: 's2',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
        'review@mp3': {
          enabled: true,
          marketplace: 'mp3',
          plugin: 'review',
          snapshot: 's3',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'plain text — should pass through',
        timestamp: '2026-04-26T10:00:00Z',
      },
      {
        id: 'm2',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/review --base main',
        timestamp: '2026-04-26T10:00:01Z',
      },
      {
        id: 'm3',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/result',
        timestamp: '2026-04-26T10:00:02Z',
      },
    ];

    const out = await expandMessagesIfNeeded(messages, ctxHost());

    // Plain text + expanded /review go through; conflict /result becomes reply.
    expect(out.toSend).toHaveLength(2);
    expect(out.toSend[0].id).toBe('m1');
    expect(out.toSend[0].content).toBe('plain text — should pass through');
    expect(out.toSend[1].id).toBe('m2');
    expect(out.toSend[1].content).toContain('Review body --base main');
    expect(out.toSend[1].content).toContain('Command: /review');

    expect(out.replies).toHaveLength(1);
    expect(out.replies[0].originalMsg.id).toBe('m3');
    expect(out.replies[0].text).toContain('/codex:result');
    expect(out.replies[0].text).toContain('/codexlite:result');
  });

  test('empty messages → empty toSend + empty replies', async () => {
    const out = await expandMessagesIfNeeded([], ctxHost());
    expect(out.toSend).toEqual([]);
    expect(out.replies).toEqual([]);
  });
});
