/**
 * plugin-expander-crash-safety-sentinel.test.ts
 *
 * Regression tests for crash-safety sentinel handling (round-14 review).
 * Covers:
 *
 *   P1-1: inline `!` is non-idempotent (git commit / file write / API call).
 *         Before this fix, the messages table only persisted the original
 *         slash command, so a crash after exec but before lastCommittedCursor
 *         advanced caused recovery to re-read the same DB row, re-call
 *         expandMessagesIfNeeded → re-expand → re-execute inline.
 *
 *         Fix: after a successful inline expansion, persist the rendered
 *         prompt back onto `messages.attachments` as a `plugin_expansion`
 *         sentinel. Recovery's expandMessagesIfNeeded checks the sentinel
 *         FIRST and reuses the stored prompt verbatim — inline never runs
 *         again. Failed inlines (any single failure in the batch) skip
 *         persistence so recovery legitimately retries.
 *
 *   P2-2: web reply fast-path always called advanceNextPullCursorOnly even
 *         when no earlier same-chat message was pending. After a clean
 *         restart, `lastCommittedCursor` (the recovery anchor) still
 *         pointed before the reply row → recovery re-broadcast the reply.
 *
 *         Fix: mirror the cold-start cursor logic — when no earlier
 *         pending exists, fully commit (setLastAgentTimestamp); otherwise
 *         hold lastCommittedCursor (advanceNextPullCursorOnly).
 *
 * Coverage:
 *   - Direct unit on the persistence helpers in plugin-expander-sentinel.ts
 *   - Behavioral test of expandMessagesIfNeeded recovery short-circuit
 *   - Failure-path test asserting persist callback is NOT invoked when any
 *     inline fails
 *   - Web reply fast-path cursor decision parity test (pure shadow of the
 *     production branch since handleWebUserMessage requires DB+queue+ws)
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
const core = await import('../src/plugin-expander-core.js');
const sentinel = await import('../src/plugin-expander-sentinel.js');

const { writeUserPluginsV2, getUserPluginRuntimePath } = pluginUtils;
const { _resetCommandIndexCacheForTests } = cmdIndex;
const { expandPluginSlashCommandIfNeeded, expandMessagesIfNeeded } = core;
const {
  readPluginExpansionFromAttachments,
  writePluginExpansionToAttachments,
  PLUGIN_EXPANSION_ATTACHMENT_TYPE,
} = sentinel;

// --- Test seam helpers (cribbed from plugin-expander-core.test.ts) ---------

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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-r14-'));
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

// ─── P1-1 unit: attachments JSON serialize / deserialize round-trip ────────

describe('readPluginExpansionFromAttachments / writePluginExpansionToAttachments — #22 round-14 P1-1', () => {
  test('write then read returns the same sentinel', () => {
    const sentinel = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: 'Rendered prompt body',
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const json = writePluginExpansionToAttachments(undefined, sentinel);
    const read = readPluginExpansionFromAttachments(json);
    expect(read).not.toBeNull();
    expect(read!.prompt).toBe('Rendered prompt body');
    expect(read!.expandedAt).toBe('2026-04-27T00:00:00.000Z');
    expect(read!.type).toBe(PLUGIN_EXPANSION_ATTACHMENT_TYPE);
  });

  test('write preserves existing image attachments alongside sentinel', () => {
    const existing = JSON.stringify([
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    const sentinel = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: 'p',
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const out = writePluginExpansionToAttachments(existing, sentinel);
    const arr = JSON.parse(out) as Array<{ type: string; [k: string]: unknown }>;
    expect(arr.length).toBe(2);
    expect(arr.find((a) => a.type === 'image')).toBeTruthy();
    expect(arr.find((a) => a.type === PLUGIN_EXPANSION_ATTACHMENT_TYPE)).toBeTruthy();
  });

  test('writing twice replaces the prior sentinel (no duplicates)', () => {
    const s1 = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: 'first',
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const s2 = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: 'second',
      expandedAt: '2026-04-27T00:01:00.000Z',
    };
    const a = writePluginExpansionToAttachments(undefined, s1);
    const b = writePluginExpansionToAttachments(a, s2);
    const arr = JSON.parse(b) as unknown[];
    expect(arr.length).toBe(1);
    const read = readPluginExpansionFromAttachments(b);
    expect(read!.prompt).toBe('second');
  });

  test('read tolerates undefined / empty / non-JSON / non-array', () => {
    expect(readPluginExpansionFromAttachments(undefined)).toBeNull();
    expect(readPluginExpansionFromAttachments('')).toBeNull();
    expect(readPluginExpansionFromAttachments('not-json')).toBeNull();
    expect(readPluginExpansionFromAttachments('{"foo":1}')).toBeNull();
  });

  test('read ignores malformed sentinel (missing prompt)', () => {
    const bad = JSON.stringify([
      { type: PLUGIN_EXPANSION_ATTACHMENT_TYPE, expanded: true },
    ]);
    expect(readPluginExpansionFromAttachments(bad)).toBeNull();
  });

  test('read ignores sentinel where expanded !== true', () => {
    const bad = JSON.stringify([
      {
        type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
        expanded: false,
        prompt: 'x',
        expandedAt: 't',
      },
    ]);
    expect(readPluginExpansionFromAttachments(bad)).toBeNull();
  });

  test('write recovers from corrupt prior JSON (drops it, keeps only the new sentinel)', () => {
    const sentinel = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: 'p',
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const out = writePluginExpansionToAttachments('garbage{{', sentinel);
    const arr = JSON.parse(out) as unknown[];
    expect(arr.length).toBe(1);
    expect(readPluginExpansionFromAttachments(out)).not.toBeNull();
  });
});

// ─── P1-1 behavior: expandMessagesIfNeeded recovery short-circuit ──────────

describe('expandMessagesIfNeeded — #22 round-14 P1-1 crash-safe recovery', () => {
  function seedInlineCmd(): void {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'commit',
          content:
            '---\ndescription: side-effecty\ndisable-model-invocation: true\n---\n\n' +
            'Result:\n!`git-commit-side-effect`\nEnd.\n',
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
  }

  test('first run: inline executes, persistExpansion is invoked with the rendered prompt', async () => {
    seedInlineCmd();
    const execHost = vi.fn(async () => ({
      ok: true,
      stdout: 'committed-abc123',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const persistExpansion = vi.fn();
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/commit',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    expect(execHost).toHaveBeenCalledTimes(1);
    expect(persistExpansion).toHaveBeenCalledTimes(1);
    const [msgId, chatJid, sentinel] = persistExpansion.mock.calls[0];
    expect(msgId).toBe('msg-1');
    expect(chatJid).toBe('web:home-alice');
    expect(sentinel.type).toBe(PLUGIN_EXPANSION_ATTACHMENT_TYPE);
    expect(sentinel.prompt).toContain('committed-abc123');
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toContain('committed-abc123');
  });

  test('recovery: message with persisted sentinel skips expand and inline does NOT re-run', async () => {
    seedInlineCmd();
    const execHost = vi.fn(); // MUST NOT be called
    const persistExpansion = vi.fn();
    const persistedPrompt = 'PERSISTED PROMPT — already executed inline once';
    const sentinelArr = [
      {
        type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
        expanded: true,
        prompt: persistedPrompt,
        expandedAt: '2026-04-27T00:00:00.000Z',
      },
    ];
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/commit',
        timestamp: '2026-04-27T00:00:00.000Z',
        attachments: JSON.stringify(sentinelArr),
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    // Critical: inline did NOT run again on recovery.
    expect(execHost).not.toHaveBeenCalled();
    // And we did NOT re-write the sentinel either (idempotency):
    expect(persistExpansion).not.toHaveBeenCalled();
    // The persisted prompt is forwarded verbatim to the agent.
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toBe(persistedPrompt);
  });

  test('recovery + image attachments: sentinel co-exists with images, both preserved', async () => {
    seedInlineCmd();
    const execHost = vi.fn();
    const persistExpansion = vi.fn();
    const persistedPrompt = 'PERSISTED';
    const arr = [
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      {
        type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
        expanded: true,
        prompt: persistedPrompt,
        expandedAt: '2026-04-27T00:00:00.000Z',
      },
    ];
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/commit',
        timestamp: '2026-04-27T00:00:00.000Z',
        attachments: JSON.stringify(arr),
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    expect(execHost).not.toHaveBeenCalled();
    expect(toSend[0].content).toBe(persistedPrompt);
    // Original attachments string is preserved on the toSend message so
    // collectMessageImages still sees the image entry downstream.
    expect(toSend[0].attachments).toBe(JSON.stringify(arr));
  });

  test('failure path: any inline failure → persistExpansion NOT called, recovery legitimately retries', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'commit',
          content:
            '---\ndescription: s\ndisable-model-invocation: true\n---\n\n' +
            '!`exit 17`\n',
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
      exitCode: 17,
      signal: null,
      timedOut: false,
    }));
    const persistExpansion = vi.fn();
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/commit',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    // Inline ran once (failed) — but persistence skipped so recovery retries.
    expect(execHost).toHaveBeenCalledTimes(1);
    expect(persistExpansion).not.toHaveBeenCalled();
    // The prompt still reaches the agent on this run (with failure marker).
    expect(toSend[0].content).toContain('inline command failed');
  });

  test('mixed batch (1 success + 1 failure) → only the success is persisted', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'good',
          content:
            '---\ndescription: g\ndisable-model-invocation: true\n---\n\n' +
            '!`echo ok`\n',
        },
        {
          name: 'bad',
          content:
            '---\ndescription: b\ndisable-model-invocation: true\n---\n\n' +
            '!`echo bad`\n',
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
    let callIdx = 0;
    const execHost = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          ok: true,
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        };
      }
      return {
        ok: false,
        stdout: '',
        stderr: 'oops',
        exitCode: 1,
        signal: null,
        timedOut: false,
      };
    });
    const persistExpansion = vi.fn();
    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/good',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
      {
        id: 'm2',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/bad',
        timestamp: '2026-04-27T00:00:01.000Z',
      },
    ];
    await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    // Only one persisted — for the success.
    expect(persistExpansion).toHaveBeenCalledTimes(1);
    const [msgId] = persistExpansion.mock.calls[0];
    expect(msgId).toBe('m1');
  });

  test('persist callback throwing does not abort the batch', async () => {
    seedInlineCmd();
    const execHost = vi.fn(async () => ({
      ok: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const persistExpansion = vi.fn(() => {
      throw new Error('disk full');
    });
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/commit',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistExpansion,
    );
    // Persistence failed but the batch still produced a usable expanded prompt.
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toContain('ok');
  });

  test('expansion with no inline commands → persistExpansion NOT called (nothing to make idempotent)', async () => {
    // Body-only expansion is already idempotent — there is no side effect
    // to protect. Persisting would just bloat the row for no benefit.
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'pure',
          content:
            '---\ndescription: pure\ndisable-model-invocation: true\n---\n\n' +
            'Just text. No inline.\n',
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
    const persistExpansion = vi.fn();
    const messages = [
      {
        id: 'msg-1',
        chat_jid: 'web:home-alice',
        sender: 'alice',
        sender_name: 'Alice',
        content: '/pure',
        timestamp: '2026-04-27T00:00:00.000Z',
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHost(),
      undefined,
      persistExpansion,
    );
    expect(persistExpansion).not.toHaveBeenCalled();
    expect(toSend[0].content).toContain('Just text. No inline.');
  });
});

// ─── P1-1 expansion result: inlineExecuted flag semantics ──────────────────

describe('ExpansionResult.inlineExecuted — #22 round-14 P1-1 success-flag', () => {
  test('all inlines succeed → inlineExecuted=true', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'two',
          content:
            '---\ndescription: t\ndisable-model-invocation: true\n---\n\n' +
            '!`echo a`\n!`echo b`\n',
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
      stdout: 'x',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/two', {
      execHost: execHost as any,
      execDocker: (() => {}) as any,
    });
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.inlineExecuted).toBe(true);
  });

  test('any inline fails → inlineExecuted=false (persistence is suppressed downstream)', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'two',
          content:
            '---\ndescription: t\ndisable-model-invocation: true\n---\n\n' +
            '!`echo a`\n!`exit 1`\n',
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
    let callIdx = 0;
    const execHost = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          ok: true,
          stdout: 'a',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
        };
      }
      return {
        ok: false,
        stdout: '',
        stderr: 'fail',
        exitCode: 1,
        signal: null,
        timedOut: false,
      };
    });
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/two', {
      execHost: execHost as any,
      execDocker: (() => {}) as any,
    });
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.inlineExecuted).toBe(false);
  });

  test('no inline at all → inlineExecuted=false (nothing to make idempotent)', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'pure',
          content:
            '---\ndescription: p\ndisable-model-invocation: true\n---\n\n' +
            'Body without inline.\n',
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
    const r = await expandPluginSlashCommandIfNeeded(ctxHost(), '/pure');
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.inlineExecuted).toBe(false);
  });
});

// ─── P2-2: web reply fast-path cursor decision logic ───────────────────────

/**
 * Shadow of the cursor decision in src/web.ts handleWebUserMessage and
 * handleAgentConversationMessage after the fix. Mirrors the production
 * `if (hasEarlierPendingMessages) advanceNextPullCursorOnly else
 * setLastAgentTimestamp` branch.
 *
 * Reaching the production handlers requires DB + queue + ws server, so
 * we test the decision predicate with the same inputs production sees.
 */
interface CursorState {
  lastAgent: { timestamp: string; id: string } | null;
  lastCommitted: { timestamp: string; id: string } | null;
}

function chooseCursorAdvancer(
  state: CursorState,
  hasEarlierPending: boolean,
  candidate: { timestamp: string; id: string },
): CursorState {
  // Mirrors web.ts: when no earlier pending exists (i.e. this reply IS the
  // only outstanding work for the chat), commit both cursors. Otherwise
  // bump only the next-pull cursor and let recovery surface the earlier
  // pending message via lastCommittedCursor.
  if (hasEarlierPending) {
    return { ...state, lastAgent: candidate };
  }
  return { lastAgent: candidate, lastCommitted: candidate };
}

describe('web reply fast-path cursor decision — #22 round-14 P2-2', () => {
  test('no earlier pending → fully commit (lastCommitted advances)', () => {
    const before: CursorState = { lastAgent: null, lastCommitted: null };
    const candidate = {
      timestamp: '2026-04-27T00:00:00.000Z',
      id: 'reply-1',
    };
    const after = chooseCursorAdvancer(before, false, candidate);
    expect(after.lastAgent).toEqual(candidate);
    expect(after.lastCommitted).toEqual(candidate);
  });

  test('earlier pending exists → only next-pull advances (lastCommitted stays put)', () => {
    const before: CursorState = {
      lastAgent: null,
      lastCommitted: { timestamp: '2026-04-26T00:00:00.000Z', id: 'old' },
    };
    const candidate = {
      timestamp: '2026-04-27T00:00:00.000Z',
      id: 'reply-1',
    };
    const after = chooseCursorAdvancer(before, true, candidate);
    expect(after.lastAgent).toEqual(candidate);
    // lastCommitted preserved so recovery still pulls the earlier message.
    expect(after.lastCommitted).toEqual({
      timestamp: '2026-04-26T00:00:00.000Z',
      id: 'old',
    });
  });

  test('regression demo: pre-fix behavior (always advanceNextPullCursorOnly) leaves stale lastCommitted', () => {
    // Pre-fix: lastCommitted never advances on the reply path → recovery
    // re-reads the row and broadcasts the reply again. Demonstrates why the
    // fix needs the no-earlier-pending shortcut.
    const before: CursorState = { lastAgent: null, lastCommitted: null };
    const candidate = {
      timestamp: '2026-04-27T00:00:00.000Z',
      id: 'reply-1',
    };
    // pre-fix: always next-pull only, regardless of earlier-pending status
    const buggy = { ...before, lastAgent: candidate };
    expect(buggy.lastCommitted).toBeNull(); // recovery would replay the reply
    // post-fix with no earlier pending: lastCommitted advances
    const fixed = chooseCursorAdvancer(before, false, candidate);
    expect(fixed.lastCommitted).toEqual(candidate);
  });
});

// ─── P2-2 hasEarlierPendingMessages predicate semantics ────────────────────

/**
 * Shadow of the predicate wired into WebDeps.hasEarlierPendingMessages
 * (defined inline in src/index.ts where it has access to lastCommittedCursor
 * and getMessagesSince). The production fn returns true iff getMessagesSince
 * has any row strictly before `candidate` in (timestamp, id) lex order.
 */
function hasEarlierPendingMessagesShadow(
  pending: Array<{ timestamp: string; id: string }>,
  candidate: { timestamp: string; id: string },
): boolean {
  for (const m of pending) {
    if (m.timestamp < candidate.timestamp) return true;
    if (m.timestamp === candidate.timestamp && m.id < candidate.id) {
      return true;
    }
  }
  return false;
}

describe('hasEarlierPendingMessages predicate — #22 round-14 P2-2', () => {
  test('empty pending → false', () => {
    expect(
      hasEarlierPendingMessagesShadow([], {
        timestamp: '2026-04-27T00:00:00.000Z',
        id: 'a',
      }),
    ).toBe(false);
  });

  test('only candidate itself in pending → false (not strictly earlier)', () => {
    const c = { timestamp: '2026-04-27T00:00:00.000Z', id: 'a' };
    expect(hasEarlierPendingMessagesShadow([c], c)).toBe(false);
  });

  test('a strictly earlier timestamp → true', () => {
    expect(
      hasEarlierPendingMessagesShadow(
        [{ timestamp: '2026-04-26T00:00:00.000Z', id: 'old' }],
        { timestamp: '2026-04-27T00:00:00.000Z', id: 'a' },
      ),
    ).toBe(true);
  });

  test('same timestamp with smaller id → true (lex tie-break)', () => {
    expect(
      hasEarlierPendingMessagesShadow(
        [{ timestamp: '2026-04-27T00:00:00.000Z', id: 'a' }],
        { timestamp: '2026-04-27T00:00:00.000Z', id: 'b' },
      ),
    ).toBe(true);
  });

  test('same timestamp with larger id → false', () => {
    expect(
      hasEarlierPendingMessagesShadow(
        [{ timestamp: '2026-04-27T00:00:00.000Z', id: 'z' }],
        { timestamp: '2026-04-27T00:00:00.000Z', id: 'a' },
      ),
    ).toBe(false);
  });

  test('mixed batch with one earlier message → true', () => {
    expect(
      hasEarlierPendingMessagesShadow(
        [
          { timestamp: '2026-04-27T00:00:00.000Z', id: 'me' },
          { timestamp: '2026-04-26T00:00:00.000Z', id: 'old' },
          { timestamp: '2026-04-28T00:00:00.000Z', id: 'future' },
        ],
        { timestamp: '2026-04-27T00:00:00.000Z', id: 'me' },
      ),
    ).toBe(true);
  });
});
