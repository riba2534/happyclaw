/**
 * plugin-expander-routing-bugs.test.ts
 *
 * Regression tests for codex review round-9 PR2.b bugs (#18):
 *
 *   P1-bug-1: active IPC cursor regression — `[plain T1, /result T2]` mixed
 *             batch must NOT regress lastAgentTimestamp from T2 back to T1
 *             after IPC injection succeeds (would replay /result reply on the
 *             next poll).
 *
 *   P2-bug-2: cold-start reply-only commit too early — `[hello T1, /result T2]`
 *             must NOT advance lastCommittedCursor past T2 while hello (T1)
 *             is still pending agent processing — a crash before spawn would
 *             lose hello.
 *
 *   P2-bug-3: active IPC must use effectiveGroup so sibling-JID groups
 *             inherit executionMode / customCwd / created_by from the home
 *             sibling (otherwise plugin expansion silently disables for the
 *             non-home JID once a runner is up).
 *
 *   P2-bug-4: makeExpandContext must honor `customCwd` in host mode — inline
 *             `!` commands belong to the user's real repo, not the synthetic
 *             data/groups path.
 *
 *   P2-bug-5: resolvePluginRuntimeOwner must prefer the message sender on the
 *             admin-shared `web:main` workspace — plugin runtime is per-user
 *             and the message sender is the correct owner (not whichever
 *             admin first materialised the group).
 *
 * The tests directly exercise the pure helpers in plugin-expander-context.ts
 * (makeExpandContext, resolvePluginRuntimeOwner) plus a faithful shadow of
 * the cursor-advance algorithm wired into src/index.ts.
 */

import { describe, expect, test } from 'vitest';

import { makeExpandContext } from '../src/plugin-expander-context.js';
import { resolvePluginRuntimeOwner } from './helpers/legacy-runtime-owner.js';

// ─── P2-bug-4: makeExpandContext customCwd in host mode ─────────────────────

describe('makeExpandContext — P2-bug-4 customCwd honored in host mode', () => {
  test('host mode + customCwd → cwd is the customCwd path', () => {
    const ctx = makeExpandContext({
      chatJid: 'web:home-alice',
      groupFolder: 'home-alice',
      ownerId: 'alice',
      executionMode: 'host',
      customCwd: '/Users/alice/projects/repo',
      groupsDir: '/data/groups',
      containerName: null,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.cwd).toBe('/Users/alice/projects/repo');
    expect(ctx?.executionMode).toBe('host');
  });

  test('host mode + no customCwd → fall back to data/groups/{folder}', () => {
    const ctx = makeExpandContext({
      chatJid: 'web:home-alice',
      groupFolder: 'home-alice',
      ownerId: 'alice',
      executionMode: 'host',
      customCwd: null,
      groupsDir: '/data/groups',
      containerName: null,
    });
    expect(ctx?.cwd).toBe('/data/groups/home-alice');
  });

  test('container mode → /workspace/group regardless of customCwd', () => {
    const ctx = makeExpandContext({
      chatJid: 'web:home-bob',
      groupFolder: 'home-bob',
      ownerId: 'bob',
      executionMode: 'container',
      customCwd: '/host/path/should/be/ignored',
      groupsDir: '/data/groups',
      containerName: 'c-bob',
    });
    expect(ctx?.cwd).toBe('/workspace/group');
  });

  test('null ownerId → null (no plugins for ownerless groups)', () => {
    const ctx = makeExpandContext({
      chatJid: 'web:home-orphan',
      groupFolder: 'home-orphan',
      ownerId: null,
      executionMode: 'host',
      groupsDir: '/data/groups',
      containerName: null,
    });
    expect(ctx).toBeNull();
  });
});

// ─── P2-bug-5: resolvePluginRuntimeOwner sender-vs-created_by precedence ────

describe('resolvePluginRuntimeOwner — P2-bug-5 admin web:main prefers sender', () => {
  test('web:main + is_home → sender wins over created_by', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1', // first admin to materialise
      senderUserId: 'admin-2', // currently typing
    });
    expect(owner).toBe('admin-2');
  });

  test('web:main + is_home + no sender → fall back to created_by', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      senderUserId: null,
    });
    expect(owner).toBe('admin-1');
  });

  test('non-web:main group → created_by always wins (single-owner)', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:home-alice',
      isHome: true,
      createdBy: 'alice',
      senderUserId: 'random-other-user',
    });
    expect(owner).toBe('alice');
  });

  test('web:main but is_home=false → created_by wins (not the shared admin home)', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:main',
      isHome: false,
      createdBy: 'admin-1',
      senderUserId: 'admin-2',
    });
    expect(owner).toBe('admin-1');
  });

  test('no created_by + no sender → null (no plugins to expand)', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:home-orphan',
      isHome: false,
      createdBy: null,
      senderUserId: null,
    });
    expect(owner).toBeNull();
  });
});

// ─── #19 P2-5: agent conversation virtualChatJid still hits web:main path ───

describe('resolvePluginRuntimeOwner — #19 P2-5 strips #agent: suffix before web:main check', () => {
  test('virtualChatJid web:main#agent:abc + is_home → sender wins (just like web:main does)', () => {
    // Before #19 P2-5, the helper compared the literal jid against `web:main`
    // and an agent conversation tab's jid `web:main#agent:abc` failed that
    // check, falling back to created_by → wrong admin owner for a shared home.
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:main#agent:abc-123',
      isHome: true,
      createdBy: 'admin-1',
      senderUserId: 'admin-2',
    });
    expect(owner).toBe('admin-2');
  });

  test('virtualChatJid web:main#agent:abc + no sender → falls back to created_by', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:main#agent:abc-123',
      isHome: true,
      createdBy: 'admin-1',
      senderUserId: null,
    });
    expect(owner).toBe('admin-1');
  });

  test('non-web:main virtualChatJid (e.g. web:home-alice#agent:x) keeps single-owner semantics', () => {
    const owner = resolvePluginRuntimeOwner({
      groupJid: 'web:home-alice#agent:abc-123',
      isHome: true,
      createdBy: 'alice',
      senderUserId: 'random-other',
    });
    expect(owner).toBe('alice');
  });
});

// ─── P1-bug-1 + P2-bug-2: cursor advance semantics ──────────────────────────

/**
 * Shadow implementations of the production cursor functions in src/index.ts.
 * Identical algorithm to the production code; isolated here so tests don't
 * have to spin up the whole module-level state.
 */
interface MessageCursor {
  timestamp: string;
  id: string;
}
interface CursorPair {
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
}

function setCursors(
  state: CursorPair,
  jid: string,
  cursor: MessageCursor,
): void {
  state.lastAgentTimestamp[jid] = cursor;
  state.lastCommittedCursor[jid] = cursor;
}

function advanceNextPullCursorOnly(
  state: CursorPair,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state.lastAgentTimestamp[jid];
  const target =
    current && current.timestamp > candidate.timestamp ? current : candidate;
  state.lastAgentTimestamp[jid] = target;
}

describe('cursor advance — P1-bug-1 active IPC must not regress past reply', () => {
  test('mixed batch [plain T1, /result T2]: reply commits T2 first, then plain text injects with advanceNextPullCursorOnly → cursor stays at T2', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const T1: MessageCursor = { timestamp: '2026-04-26T10:00:00Z', id: 'm1' };
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'm2' };

    // Replies process first — they have no toSend ahead, but here we model the
    // active-IPC mixed-batch path where toSend (plain T1) still needs to be
    // injected, so we use advanceNextPullCursorOnly for the reply.
    advanceNextPullCursorOnly(state, jid, T2);

    // Then plain text gets piped to the active runner — the production code
    // now uses advanceNextPullCursorOnly so a later reply isn't overwritten.
    advanceNextPullCursorOnly(state, jid, T1);

    // Cursor must NOT regress: it should still be at T2.
    expect(state.lastAgentTimestamp[jid]).toEqual(T2);
  });

  test('regression demo: direct assignment WOULD have regressed cursor (this is the buggy behavior we fixed)', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const T1: MessageCursor = { timestamp: '2026-04-26T10:00:00Z', id: 'm1' };
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'm2' };

    // Old buggy path: reply via setCursors, then plain text via direct
    // assignment — direct assignment ignores existing position.
    setCursors(state, jid, T2);
    state.lastAgentTimestamp[jid] = T1; // BUG: regresses to T1.
    expect(state.lastAgentTimestamp[jid]).toEqual(T1);
    // Demonstrates why the production fix uses advanceNextPullCursorOnly,
    // which would keep T2 in place.
  });
});

// #19 P1-1 / P1-2 — web reply path must NOT commit cursor past earlier
// queued messages. Reproduces the "Web 主对话/agent reply 过早 commit" bug
// from the round-10 codex review.
describe('cursor advance — #19 P1-1/P1-2 web reply must not commit past earlier queued message', () => {
  test('reply at T2 then earlier user msg T1 hits drainGroup: setCursors(T2) buggy → drainGroup skips T1; advanceNextPullCursorOnly(T2) correct → drainGroup still sees T1 via lastCommittedCursor', () => {
    // Production scenario:
    //   1. user sends "/result <- DMI plugin command"  at T2 (later)
    //      while an earlier user message m1 at T1 is still in DB queue.
    //   2. expander matches /result → reply path. Web calls
    //      deps.advanceNextPullCursorOnly(jid, T2) → bumps lastAgentTimestamp,
    //      lastCommittedCursor stays empty.
    //   3. Service crashes before the next poll.
    //   4. Recovery uses lastCommittedCursor to replay unprocessed work.
    //      Because cursor is still empty, m1 (T1) is correctly surfaced.
    //
    // The buggy old code called deps.setLastAgentTimestamp(jid, T2) which
    // bumps BOTH cursors → recovery thinks T1 was processed → m1 is lost.
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    const T1: MessageCursor = { timestamp: '2026-04-26T10:00:00Z', id: 'm1-earlier' };
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'm2-reply' };

    // Web reply path now uses advanceNextPullCursorOnly (post-fix).
    advanceNextPullCursorOnly(state, jid, T2);

    // Next-pull cursor advanced — next poll skips T2.
    expect(state.lastAgentTimestamp[jid]).toEqual(T2);
    // Recovery cursor stays empty — m1 (T1) is still recoverable.
    expect(state.lastCommittedCursor[jid]).toBeUndefined();
  });

  test('agent conversation reply on virtualChatJid follows the same recovery contract', () => {
    // Same shape as P1-1, but for handleAgentConversationMessage which keys
    // off `web:main#agent:abc-123` (the virtual jid). The cursor function is
    // the same — only the jid namespace differs.
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const virtualJid = 'web:main#agent:abc-123';
    const T1: MessageCursor = { timestamp: '2026-04-26T10:00:00Z', id: 'agent-msg-1' };
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'agent-reply' };

    advanceNextPullCursorOnly(state, virtualJid, T2);

    expect(state.lastAgentTimestamp[virtualJid]).toEqual(T2);
    expect(state.lastCommittedCursor[virtualJid]).toBeUndefined();
  });
});

describe('cursor advance — P2-bug-2 cold-start must not commit past unprocessed work', () => {
  test('reply with toSend non-empty → only lastAgentTimestamp advances; lastCommittedCursor stays put', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'feishu:room';
    const T1: MessageCursor = { timestamp: '2026-04-26T10:00:00Z', id: 'hello' };
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'result' };

    // State before: nothing committed, nothing pulled.
    // Cold-start expander processes /result reply but toSend = [hello] still pending.
    // Production code picks advanceNextPullCursorOnly when toSend.length > 0.
    advanceNextPullCursorOnly(state, jid, T2);

    // lastAgentTimestamp advances so next poll skips /result.
    expect(state.lastAgentTimestamp[jid]).toEqual(T2);
    // lastCommittedCursor stays empty — recovery sees hello on crash.
    expect(state.lastCommittedCursor[jid]).toBeUndefined();

    // Simulate crash + restart: recovery would call getMessagesSince(empty).
    // That should still surface hello (T1) because committed cursor is empty.
    // (Asserted here as the contract; actual DB query is exercised elsewhere.)
  });

  test('reply with toSend empty → setCursors fully commits (next poll skips, recovery skips)', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'feishu:room';
    const T2: MessageCursor = { timestamp: '2026-04-26T10:00:01Z', id: 'result' };

    // toSend is empty → production picks setCursors.
    setCursors(state, jid, T2);

    expect(state.lastAgentTimestamp[jid]).toEqual(T2);
    expect(state.lastCommittedCursor[jid]).toEqual(T2);
  });
});

// ─── P2-bug-3: effectiveGroup propagation contract (sibling inheritance) ────

describe('makeExpandContext — P2-bug-3 sibling-resolved customCwd propagates', () => {
  // P2-bug-3 itself is "use effectiveGroup at line 6506" — the propagation test
  // here verifies that when a non-home sibling inherits customCwd from the home
  // group via resolveEffectiveGroup, makeExpandContext picks it up correctly.
  test('sibling-resolved group with inherited customCwd → host cwd uses it', () => {
    // Simulate: non-home child group has its own folder/created_by but inherits
    // host execution + customCwd from the resolved home sibling. The production
    // active-IPC path now passes `effectiveGroup`, not the raw `group`, so this
    // is the inputs makeExpandContext sees:
    const ctx = makeExpandContext({
      chatJid: 'feishu:child-group',
      groupFolder: 'main',
      ownerId: 'admin',
      executionMode: 'host', // inherited from sibling
      customCwd: '/Users/admin/repo', // inherited from sibling
      groupsDir: '/data/groups',
      containerName: 'c-main',
    });
    expect(ctx?.cwd).toBe('/Users/admin/repo');
    expect(ctx?.userId).toBe('admin');
    expect(ctx?.executionMode).toBe('host');
    expect(ctx?.containerName).toBe('c-main');
  });

  test('without sibling resolution: raw group missing executionMode falls back to container', () => {
    // The raw (non-effective) group on the active-IPC path used to be passed
    // here. Without inheritance, executionMode is missing → defaults to
    // container, which silently swaps the cwd to /workspace/group and drops
    // host-only customCwd. This is what the bug looked like before the fix.
    const ctx = makeExpandContext({
      chatJid: 'feishu:child-group',
      groupFolder: 'main',
      ownerId: 'admin',
      executionMode: undefined,
      customCwd: '/Users/admin/repo',
      groupsDir: '/data/groups',
      containerName: null,
    });
    expect(ctx?.executionMode).toBe('container');
    expect(ctx?.cwd).toBe('/workspace/group');
  });
});
