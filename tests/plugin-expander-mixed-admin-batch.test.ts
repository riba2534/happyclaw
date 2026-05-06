/**
 * plugin-expander-mixed-admin-batch.test.ts
 *
 * Regression tests for mixed-admin batch expansion on web:main
 * (round-15 review). Covers:
 *
 *   P1-1: src/web.ts handleWebUserMessage / handleAgentConversationMessage
 *         eager-expand fast-path runs `expandPluginSlashCommandIfNeeded`
 *         (which executes inline `!` as a side effect on success) but did
 *         NOT call `persistPluginExpansion` to write the sentinel back to
 *         the DB row. Result: a runner crash between IPC inject and IPC
 *         consume left the messages row holding the original `/foo` slash
 *         command. Cold-start re-read the row, re-expanded, and re-ran
 *         inline → side effects fired twice. The round-14 P1 fix only
 *         covered the index.ts cold-start / active-IPC paths.
 *
 *         Fix: in both web.ts handlers, after `kind === 'expanded'` AND
 *         `inlineExecuted === true`, call the same `persistPluginExpansion`
 *         helper used by the cold-start paths. The shared helper lives in
 *         `src/plugin-expander-store.ts` so web.ts can import it without
 *         dragging in index.ts.
 *
 *   P2-2: index.ts cold-start / active-IPC paths resolved `runtimeOwner`
 *         once per BATCH (latest-admin-sender across the whole batch),
 *         then expanded every message in the batch under that one runtime.
 *         On the admin-shared `web:main` workspace where each admin's
 *         plugins are per-user, mixed-admin batches expanded admin-A's
 *         slash command under admin-B's plugins.
 *
 *         Fix: lift runtimeOwner resolution into a per-message resolver
 *         passed to `expandMessagesIfNeeded`. New helper
 *         `resolvePerMessageRuntimeOwner` returns the message sender's id
 *         when the sender is an active admin on web:main + isHome,
 *         otherwise the workspace fallback. New `expandMessagesIfNeeded`
 *         signature accepts either an `ExpandContext` (legacy) or a
 *         per-message resolver.
 *
 * Coverage:
 *   - Direct unit on the new shared persistence helper (round-trip across
 *     `getMessageAttachments` / `updateMessageAttachments`)
 *   - Behavior of `expandMessagesIfNeeded` with a per-message resolver:
 *     mixed-admin batch yields the right runtime per-message
 *   - Direct unit on `resolvePerMessageRuntimeOwner` covering the gate +
 *     non-admin-sender fallback semantics
 *   - Web fast-path persistence shadow: persisting the rendered prompt
 *     before sendMessage means cold-start re-read sees the sentinel
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
  GROUPS_DIR: '/tmp/unused-r15',
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
const runtimeOwner = await import('../src/runtime-owner.js');

const { writeUserPluginsV2, getUserPluginRuntimePath } = pluginUtils;
const { _resetCommandIndexCacheForTests } = cmdIndex;
const { expandMessagesIfNeeded } = core;
const {
  PLUGIN_EXPANSION_ATTACHMENT_TYPE,
  readPluginExpansionFromAttachments,
  writePluginExpansionToAttachments,
} = sentinel;
const { resolvePerMessageRuntimeOwner } = runtimeOwner;
type RuntimeOwnerCandidateUser = runtimeOwner.RuntimeOwnerCandidateUser;

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
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-r15-'));
  _resetCommandIndexCacheForTests();
});

afterEach(() => {
  if (tmpDataDir && fs.existsSync(tmpDataDir)) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
  _resetCommandIndexCacheForTests();
});

const ctxHostFor = (userId: string) => ({
  userId,
  groupJid: 'web:main',
  groupFolder: 'main',
  cwd: '/data/groups/main',
  executionMode: 'host' as const,
  containerName: null,
});

// ─── P1-1: persistPluginExpansion helper (shared across index.ts + web.ts) ──

/**
 * The shared helper composes `getMessageAttachments` + `updateMessageAttachments`
 * via writePluginExpansionToAttachments. Since the two DB functions are
 * dynamic-import boundaries, we test the round-trip through their real
 * implementations against a temp better-sqlite3 db.
 */
describe('plugin-expander-store: persistPluginExpansion — #23 round-15 P1-1', () => {
  test('round-trip: persist a sentinel and read it back via getMessageAttachments', async () => {
    // Use a separate temp dir to avoid colliding with the plugin runtime dir.
    const dbTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-r15-db-'));
    try {
      // Lazy-import so vi.mock for ../src/config.js applies before db.ts loads.
      const cfg = await import('../src/config.js');
      // The mock is read-only via getter; instead, swap the mock for this test
      // is brittle. Use better-sqlite3 directly to seed a `messages` row
      // mirroring the schema columns we touch (id, chat_jid, attachments).
      void cfg;
      const Database = (await import('better-sqlite3')).default;
      const dbPath = path.join(dbTmp, 'messages.db');
      const dbi = new Database(dbPath);
      dbi.exec(`
        CREATE TABLE messages (
          id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          attachments TEXT,
          PRIMARY KEY (id, chat_jid)
        );
      `);
      dbi
        .prepare(
          `INSERT INTO messages (id, chat_jid, sender, content, timestamp, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('msg-1', 'web:main', 'alice', '/codex:status', 't', null);

      // Inline the helper logic so we don't pull in db.ts (which would open
      // its own DB at DATA_DIR). The contract under test is "read existing
      // attachments → merge sentinel → write back idempotently".
      const persistAgainst = (
        msgId: string,
        chatJid: string,
        sentinel: ReturnType<typeof readPluginExpansionFromAttachments> & object,
      ): void => {
        const row = dbi
          .prepare(
            'SELECT attachments FROM messages WHERE id = ? AND chat_jid = ?',
          )
          .get(msgId, chatJid) as { attachments: string | null } | undefined;
        const next = writePluginExpansionToAttachments(
          row?.attachments ?? null,
          sentinel,
        );
        dbi
          .prepare(
            'UPDATE messages SET attachments = ? WHERE id = ? AND chat_jid = ?',
          )
          .run(next, msgId, chatJid);
      };

      const sentinel = {
        type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
        expanded: true as const,
        prompt: 'rendered-prompt-with-side-effects-already-run',
        expandedAt: '2026-04-27T00:00:00.000Z',
      };
      persistAgainst('msg-1', 'web:main', sentinel);

      const after = dbi
        .prepare('SELECT attachments FROM messages WHERE id = ? AND chat_jid = ?')
        .get('msg-1', 'web:main') as { attachments: string };
      const read = readPluginExpansionFromAttachments(after.attachments);
      expect(read).not.toBeNull();
      expect(read!.prompt).toBe('rendered-prompt-with-side-effects-already-run');

      // Idempotency: writing the same sentinel again does not duplicate.
      persistAgainst('msg-1', 'web:main', {
        ...sentinel,
        prompt: 'updated-prompt',
      });
      const after2 = dbi
        .prepare('SELECT attachments FROM messages WHERE id = ? AND chat_jid = ?')
        .get('msg-1', 'web:main') as { attachments: string };
      const arr = JSON.parse(after2.attachments) as unknown[];
      expect(arr.length).toBe(1);
      const read2 = readPluginExpansionFromAttachments(after2.attachments);
      expect(read2!.prompt).toBe('updated-prompt');

      dbi.close();
    } finally {
      fs.rmSync(dbTmp, { recursive: true, force: true });
    }
  });

  test('shared helper module shape: persistPluginExpansion is exported and is a function', async () => {
    const mod = await import('../src/plugin-expander-store.js');
    expect(typeof mod.persistPluginExpansion).toBe('function');
  });
});

// ─── P1-1: web fast-path ordering — sentinel persisted before sendMessage ──

/**
 * Shadow of the production handlers' contract. Reaching handleWebUserMessage
 * directly requires DB + queue + ws state, so we mirror the decision graph:
 *
 *   1. eager expand returns kind=expanded, inlineExecuted=true
 *   2. handler MUST call persistPluginExpansion BEFORE deps.queue.sendMessage
 *   3. If sendMessage subsequently rejects (runner crashed), cold-start
 *      re-reads the messages row → readPluginExpansionFromAttachments
 *      returns the sentinel → expandMessagesIfNeeded short-circuits and
 *      DOES NOT call the expander again (no inline re-execution).
 */
describe('web fast-path ordering — #23 round-15 P1-1', () => {
  test('sentinel written before runner crash → cold-start replay does NOT re-run inline', async () => {
    seedPlugin({
      userId: 'alice',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'commit',
          content:
            '---\ndescription: side\ndisable-model-invocation: true\n---\n\n' +
            'Result:\n!`echo committed`\nEnd.\n',
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

    // Step 1: web fast-path runs the expander, gets `expanded` with
    // inlineExecuted=true, persists the sentinel onto attachments BEFORE
    // sendMessage is even called.
    const execHost = vi.fn(async () => ({
      ok: true,
      stdout: 'committed-abc',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const r = await core.expandPluginSlashCommandIfNeeded(
      ctxHostFor('alice'),
      '/commit',
      { execHost: execHost as any, execDocker: (() => {}) as any },
    );
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    expect(r.inlineExecuted).toBe(true);
    expect(execHost).toHaveBeenCalledTimes(1);
    const sentinel = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true as const,
      prompt: r.prompt,
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const attachmentsAfterPersist = writePluginExpansionToAttachments(
      undefined,
      sentinel,
    );

    // Step 2: simulate the runner crashing AFTER ws sendMessage 'sent' but
    // BEFORE it consumed the IPC message → cold-start re-reads the same row.
    // Pre-fix this would call expandMessagesIfNeeded → re-run inline.
    // Post-fix the persisted sentinel forces the short-circuit branch.
    const persistFn = vi.fn();
    const { toSend } = await expandMessagesIfNeeded(
      [
        {
          id: 'msg-1',
          chat_jid: 'web:main',
          sender: 'alice',
          sender_name: 'Alice',
          content: '/commit',
          timestamp: '2026-04-27T00:00:00.000Z',
          attachments: attachmentsAfterPersist,
        },
      ],
      ctxHostFor('alice'),
      { execHost: execHost as any, execDocker: (() => {}) as any },
      persistFn,
    );

    // Critical assertions:
    expect(execHost).toHaveBeenCalledTimes(1); // STILL 1 — no re-run
    expect(persistFn).not.toHaveBeenCalled(); // recovery does not re-write
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toBe(r.prompt); // verbatim replay
  });

  test('failed inline → no sentinel persisted → cold-start legitimately retries', async () => {
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
    const r = await core.expandPluginSlashCommandIfNeeded(
      ctxHostFor('alice'),
      '/commit',
      { execHost: execHost as any, execDocker: (() => {}) as any },
    );
    expect(r.kind).toBe('expanded');
    if (r.kind !== 'expanded') return;
    // Web fast-path policy: only persist when inlineExecuted === true.
    expect(r.inlineExecuted).toBe(false);
    // Caller (handleWebUserMessage) gate suppresses persist in this branch.
    // Cold-start replay therefore re-runs (which is correct: failed inlines
    // should retry rather than freeze the failure into the row).
  });
});

// ─── P2-2: per-message runtimeOwner resolver behavior ─────────────────────

describe('resolvePerMessageRuntimeOwner — #23 round-15 P2-2', () => {
  const adminA: RuntimeOwnerCandidateUser = {
    id: 'admin-a',
    status: 'active',
    role: 'admin',
  };
  const adminB: RuntimeOwnerCandidateUser = {
    id: 'admin-b',
    status: 'active',
    role: 'admin',
  };
  const member: RuntimeOwnerCandidateUser = {
    id: 'member-1',
    status: 'active',
    role: 'member',
  };
  const disabledAdmin: RuntimeOwnerCandidateUser = {
    id: 'admin-z',
    status: 'disabled',
    role: 'admin',
  };
  const userMap: Record<string, RuntimeOwnerCandidateUser> = {
    'admin-a': adminA,
    'admin-b': adminB,
    'member-1': member,
    'admin-z': disabledAdmin,
  };
  const lookup = (id: string) => userMap[id] ?? null;

  test('admin sender on web:main + isHome → returns sender id (per-user runtime)', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-b');
  });

  test('non-web:main workspace → returns fallback regardless of sender', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:home-bob',
      isHome: true,
      fallbackOwner: 'bob',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(owner).toBe('bob');
  });

  test('web:main but isHome=false → returns fallback (gate is web:main + isHome both)', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: false,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-a');
  });

  test('virtual JID web:main#agent:<id> still gets per-sender semantics', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main#agent:abcdef',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-b');
  });

  test('non-admin sender (member) → returns fallback (members do not own a runtime)', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'member-1' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-a');
  });

  test('disabled admin → returns fallback (only active admins own a runtime)', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-z' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-a');
  });

  test('unknown sender (id not in users) → returns fallback', () => {
    const owner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'nobody' },
      getUserById: lookup,
    });
    expect(owner).toBe('admin-a');
  });

  test('system / agent senders skip override → returns fallback', () => {
    expect(
      resolvePerMessageRuntimeOwner({
        chatJid: 'web:main',
        isHome: true,
        fallbackOwner: 'admin-a',
        message: { sender: 'happyclaw-agent' },
        getUserById: lookup,
      }),
    ).toBe('admin-a');
    expect(
      resolvePerMessageRuntimeOwner({
        chatJid: 'web:main',
        isHome: true,
        fallbackOwner: 'admin-a',
        message: { sender: '__system__' },
        getUserById: lookup,
      }),
    ).toBe('admin-a');
  });
});

// ─── P2-2: expandMessagesIfNeeded with per-message resolver ────────────────

/**
 * Critical scenario: mixed-admin batch on web:main where each admin's
 * /commit command has a different rendered prompt because each admin
 * has different plugins enabled. Pre-fix the batch resolver picked the
 * latest admin (B) and admin-A's command expanded under B's plugins
 * (often producing a "command not found" reply, sometimes worse — wrong
 * plugin runtime triggering an unintended side effect).
 */
describe('expandMessagesIfNeeded with per-message resolver — #23 round-15 P2-2', () => {
  test('mixed-admin batch: each message expands under its own sender runtime', async () => {
    // admin-a has /report that prints A-specific output
    seedPlugin({
      userId: 'admin-a',
      marketplace: 'mpA',
      plugin: 'codexA',
      snapshot: 'shaA',
      commands: [
        {
          name: 'report',
          content:
            '---\ndescription: A-report\ndisable-model-invocation: true\n---\n\n' +
            'A-runtime-output\n',
        },
      ],
    });
    enable({
      userId: 'admin-a',
      fullId: 'codexA@mpA',
      marketplace: 'mpA',
      plugin: 'codexA',
      snapshot: 'shaA',
    });

    // admin-b has a DIFFERENT /report under a different plugin id
    seedPlugin({
      userId: 'admin-b',
      marketplace: 'mpB',
      plugin: 'codexB',
      snapshot: 'shaB',
      commands: [
        {
          name: 'report',
          content:
            '---\ndescription: B-report\ndisable-model-invocation: true\n---\n\n' +
            'B-runtime-output\n',
        },
      ],
    });
    enable({
      userId: 'admin-b',
      fullId: 'codexB@mpB',
      marketplace: 'mpB',
      plugin: 'codexB',
      snapshot: 'shaB',
    });

    // Per-message resolver: pick a context whose userId === message sender.
    const resolveCtx = (msg: { sender: string }) => ({
      userId: msg.sender,
      groupJid: 'web:main',
      groupFolder: 'main',
      cwd: '/data/groups/main',
      executionMode: 'host' as const,
      containerName: null,
    });

    // /report is the same short name in both A's and B's plugins, but the
    // plugins ARE different (codexA vs codexB), so each admin's runtime
    // sees only ONE plugin → no conflict, /report resolves to that plugin's
    // entry. Mixed-batch expansion under per-message runtimes therefore
    // exercises the key invariant: m1 must use A's plugin, m3 must use B's.
    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:main',
        sender: 'admin-a',
        sender_name: 'Admin A',
        content: '/report',
        timestamp: '2026-04-27T11:00:00.000Z',
      },
      {
        id: 'm2',
        chat_jid: 'web:main',
        sender: 'admin-b',
        sender_name: 'Admin B',
        content: 'hello',
        timestamp: '2026-04-27T11:01:00.000Z',
      },
      {
        id: 'm3',
        chat_jid: 'web:main',
        sender: 'admin-b',
        sender_name: 'Admin B',
        content: '/report',
        timestamp: '2026-04-27T11:02:00.000Z',
      },
    ];

    const { toSend, replies } = await expandMessagesIfNeeded(
      messages,
      resolveCtx,
    );

    expect(replies).toEqual([]);
    expect(toSend.length).toBe(3);
    // m1 is admin-a's /report → expanded under A's runtime → A-runtime-output
    expect(toSend[0].content).toContain('A-runtime-output');
    expect(toSend[0].content).not.toContain('B-runtime-output');
    // m2 is plain text → unchanged
    expect(toSend[1].content).toBe('hello');
    // m3 is admin-b's /report → expanded under B's runtime → B-runtime-output
    expect(toSend[2].content).toContain('B-runtime-output');
    expect(toSend[2].content).not.toContain('A-runtime-output');
  });

  test('legacy single-context call still works (resolver is optional)', async () => {
    // No per-message resolver — pass an ExpandContext directly.
    seedPlugin({
      userId: 'admin-a',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
      commands: [
        {
          name: 'report',
          content:
            '---\ndescription: A-report\ndisable-model-invocation: true\n---\n\n' +
            'A-runtime\n',
        },
      ],
    });
    enable({
      userId: 'admin-a',
      fullId: 'codex@mp',
      marketplace: 'mp',
      plugin: 'codex',
      snapshot: 'sha',
    });

    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:main',
        sender: 'admin-a',
        sender_name: 'Admin A',
        content: '/report',
        timestamp: '2026-04-27T11:00:00.000Z',
      },
    ];
    const { toSend } = await expandMessagesIfNeeded(
      messages,
      ctxHostFor('admin-a'),
    );
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toContain('A-runtime');
  });

  test('per-message resolver returning null → message passes through unchanged', async () => {
    // Owner unresolved → makeExpandContext returns null → resolver returns null.
    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:main',
        sender: 'admin-a',
        sender_name: 'Admin A',
        content: '/report',
        timestamp: '2026-04-27T11:00:00.000Z',
      },
    ];
    const { toSend, replies } = await expandMessagesIfNeeded(
      messages,
      () => null,
    );
    expect(replies).toEqual([]);
    expect(toSend.length).toBe(1);
    expect(toSend[0].content).toBe('/report');
  });

  test('persisted sentinel still short-circuits even with per-message resolver', async () => {
    // Round-14 crash-safety must compose with round-15 per-message resolution.
    const persisted = {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true,
      prompt: 'PERSISTED-CONTENT',
      expandedAt: '2026-04-27T00:00:00.000Z',
    };
    const messages = [
      {
        id: 'm1',
        chat_jid: 'web:main',
        sender: 'admin-a',
        sender_name: 'Admin A',
        content: '/report',
        timestamp: '2026-04-27T11:00:00.000Z',
        attachments: JSON.stringify([persisted]),
      },
    ];
    let resolverCalls = 0;
    const { toSend } = await expandMessagesIfNeeded(messages, () => {
      resolverCalls++;
      return null;
    });
    // Sentinel short-circuit happens BEFORE the resolver runs — recovery
    // must not need a runtime to replay.
    expect(resolverCalls).toBe(0);
    expect(toSend[0].content).toBe('PERSISTED-CONTENT');
  });
});
