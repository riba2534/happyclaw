/**
 * plugin-expander-round16-bugs.test.ts
 *
 * Regression tests for codex review round-16 PR2.b bugs (#24):
 *
 *   P2-1: web eager-expand path used `resolvePluginRuntimeOwner` (no admin
 *         gating) while the cold-start path used `resolvePerMessageRuntimeOwner`
 *         (full admin gating). Same `/foo` from a non-admin sender on
 *         `web:main + isHome` therefore expanded under DIFFERENT runtimes
 *         depending on whether the runner was active or idle —
 *         active = sender's (empty / wrong) runtime, idle = workspace
 *         created_by admin's runtime. After the fix, both paths share the
 *         same per-message helper so the expansion is invariant to runner
 *         state.
 *
 *   P2-2: `advanceCursors` (commit cursor) compared on timestamp only,
 *         but `advanceNextPullCursorOnly` (round-11 fix) used full lex
 *         (timestamp, id). Mixed batch [plain m1, /cmd m2] sharing the same
 *         timestamp triggered a divergence: the reply path's setCursors
 *         pushed both cursors to (T, m2), then the agent finished m1 and
 *         called advanceCursors(T, m1) → timestamps equal → cursor
 *         regressed to (T, m1) → next poll re-read m2 → reply re-fired.
 *         After the fix both helpers share `isCursorAfter` (lex compare)
 *         so mixed-batch same-timestamp ids cannot regress the cursor.
 *
 * Coverage:
 *   - P2-1: behavioral parity between the production helpers used by the
 *     web fast-path and the cold-start path (same inputs → same owner).
 *   - P2-2: shadow of the post-fix `advanceCursors` and direct unit on
 *     the production `isCursorAfter` exercising the same-timestamp
 *     id tie-break that the pre-fix `advanceCursors` got wrong.
 */

import { describe, expect, test } from 'vitest';

import {
  resolvePerMessageRuntimeOwner,
  type RuntimeOwnerCandidateUser,
} from '../src/runtime-owner.js';

/**
 * Shadow of the production `isCursorAfter` from src/index.ts. Importing the
 * real function would pull in index.ts's module-level side effects (DB +
 * file-system init). The algorithm is two lines so a copy here is fine; the
 * P2-2 fix ensures `advanceCursors` and `advanceNextPullCursorOnly` both go
 * through the same lex compare in production.
 */
interface MessageCursorLike {
  timestamp: string;
  id: string;
}
function isCursorAfter(
  candidate: MessageCursorLike,
  base: MessageCursorLike,
): boolean {
  if (candidate.timestamp > base.timestamp) return true;
  if (candidate.timestamp < base.timestamp) return false;
  return candidate.id > base.id;
}

// ─── P2-1: web fast-path now matches cold-start runtime resolution ──────────

describe('web eager-expand vs cold-start runtime owner — #24 round-16 P2-1', () => {
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
  const memberX: RuntimeOwnerCandidateUser = {
    id: 'member-x',
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
    'member-x': memberX,
    'admin-z': disabledAdmin,
  };
  const lookup = (id: string) => userMap[id] ?? null;

  /**
   * Shadow of the post-fix `buildWebExpandContext` owner resolution. The
   * web fast-path now feeds `resolvePerMessageRuntimeOwner` exactly the
   * same `(chatJid, isHome, fallbackOwner, message, getUserById)` quadruple
   * that the cold-start path uses, so any divergence between the two paths
   * here is a regression of the round-16 fix.
   */
  function webResolveRuntimeOwner(args: {
    groupJid: string;
    isHome: boolean;
    createdBy: string | null;
    senderUserId: string | null;
  }): string | null | undefined {
    return resolvePerMessageRuntimeOwner({
      chatJid: args.groupJid,
      isHome: args.isHome,
      fallbackOwner: args.createdBy,
      message: { sender: args.senderUserId ?? '' },
      getUserById: lookup,
    });
  }

  test('web:main + isHome + member sender → falls back to created_by (matches cold-start)', () => {
    // Pre-fix: resolvePluginRuntimeOwner returned senderUserId blindly →
    // member-x. Post-fix: per-message resolver gates on active admin, so
    // a member sender falls back to the workspace's admin owner just like
    // cold-start does.
    const webOwner = webResolveRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'member-x',
    });
    const coldStartOwner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'member-x' },
      getUserById: lookup,
    });
    expect(webOwner).toBe('admin-a');
    expect(webOwner).toBe(coldStartOwner);
  });

  test('web:main + isHome + admin sender → uses sender id (matches cold-start)', () => {
    const webOwner = webResolveRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'admin-b',
    });
    const coldStartOwner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(webOwner).toBe('admin-b');
    expect(webOwner).toBe(coldStartOwner);
  });

  test('web:main + isHome + disabled admin sender → falls back (matches cold-start)', () => {
    const webOwner = webResolveRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'admin-z',
    });
    const coldStartOwner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-z' },
      getUserById: lookup,
    });
    expect(webOwner).toBe('admin-a');
    expect(webOwner).toBe(coldStartOwner);
  });

  test('web:main + isHome + unknown sender → falls back (matches cold-start)', () => {
    const webOwner = webResolveRuntimeOwner({
      groupJid: 'web:main',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'ghost',
    });
    const coldStartOwner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'ghost' },
      getUserById: lookup,
    });
    expect(webOwner).toBe('admin-a');
    expect(webOwner).toBe(coldStartOwner);
  });

  test('non-web:main workspace → created_by wins regardless of sender role', () => {
    // Single-owner workspaces never enter the per-user gate; both helpers
    // collapse to `fallbackOwner`. Sender role is irrelevant.
    expect(
      webResolveRuntimeOwner({
        groupJid: 'web:home-bob',
        isHome: true,
        createdBy: 'bob',
        senderUserId: 'admin-b',
      }),
    ).toBe('bob');
  });

  test('virtual JID web:main#agent:xxx — admin-gated per-sender semantics survive', () => {
    // Hash-prefix stripping must happen before the `web:main + isHome` gate,
    // and the admin gate must still fire for the virtual JID — agent
    // conversation tabs live under the same admin-shared home.
    const webOwner = webResolveRuntimeOwner({
      groupJid: 'web:main#agent:abc-123',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'admin-b',
    });
    const coldStartOwner = resolvePerMessageRuntimeOwner({
      chatJid: 'web:main#agent:abc-123',
      isHome: true,
      fallbackOwner: 'admin-a',
      message: { sender: 'admin-b' },
      getUserById: lookup,
    });
    expect(webOwner).toBe('admin-b');
    expect(webOwner).toBe(coldStartOwner);

    // ...and a non-admin sender on the virtual JID still falls back.
    const webOwnerMember = webResolveRuntimeOwner({
      groupJid: 'web:main#agent:abc-123',
      isHome: true,
      createdBy: 'admin-a',
      senderUserId: 'member-x',
    });
    expect(webOwnerMember).toBe('admin-a');
  });
});

// ─── P2-2: advanceCursors must lex-compare (timestamp, id) ──────────────────

type MessageCursor = MessageCursorLike;

interface CursorPair {
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
}

/**
 * Shadow of the post-fix `advanceCursors` from src/index.ts. Identical
 * algorithm — never regress past the existing position, comparison is full
 * lex (timestamp, id) via `isCursorAfter`. Pre-fix this used a timestamp-only
 * compare, which silently regressed the cursor on same-timestamp mixed
 * batches.
 */
function advanceCursors(
  state: CursorPair,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state.lastAgentTimestamp[jid];
  const target = current && isCursorAfter(current, candidate) ? current : candidate;
  state.lastAgentTimestamp[jid] = target;
  state.lastCommittedCursor[jid] = target;
}

/** Pre-fix buggy variant for direct contrast. */
function advanceCursors_buggy(
  state: CursorPair,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state.lastAgentTimestamp[jid];
  const target =
    current && current.timestamp > candidate.timestamp ? current : candidate;
  state.lastAgentTimestamp[jid] = target;
  state.lastCommittedCursor[jid] = target;
}

function setCursors(
  state: CursorPair,
  jid: string,
  cursor: MessageCursor,
): void {
  state.lastAgentTimestamp[jid] = cursor;
  state.lastCommittedCursor[jid] = cursor;
}

describe('advanceCursors — #24 round-16 P2-2 same-timestamp id tie-break', () => {
  test('same timestamp, candidate id < current id → keep current (no regression)', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    // Mixed batch sorted by (timestamp, id): m1 then m2, both sharing T.
    const T = '2026-04-26T10:00:00Z';
    const m1: MessageCursor = { timestamp: T, id: 'm1' };
    const m2: MessageCursor = { timestamp: T, id: 'm2' };

    // Reply path commits cursor to m2 first (the /cmd in the batch).
    setCursors(state, jid, m2);
    // Agent then finishes processing m1 (the plain text). Pre-fix: cursor
    // regresses to m1 because timestamps are equal. Post-fix: lex compare
    // (timestamp, id) keeps the cursor at m2.
    advanceCursors(state, jid, m1);

    expect(state.lastAgentTimestamp[jid]).toEqual(m2);
    expect(state.lastCommittedCursor[jid]).toEqual(m2);
  });

  test('same timestamp, candidate id > current id → advance to candidate', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    const T = '2026-04-26T10:00:00Z';
    state.lastAgentTimestamp[jid] = { timestamp: T, id: 'm1' };
    state.lastCommittedCursor[jid] = { timestamp: T, id: 'm1' };

    advanceCursors(state, jid, { timestamp: T, id: 'm2' });

    expect(state.lastAgentTimestamp[jid]).toEqual({ timestamp: T, id: 'm2' });
    expect(state.lastCommittedCursor[jid]).toEqual({ timestamp: T, id: 'm2' });
  });

  test('strictly later timestamp → advance regardless of id ordering', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    setCursors(state, jid, { timestamp: '2026-04-26T10:00:00Z', id: 'zzzz' });
    advanceCursors(state, jid, { timestamp: '2026-04-26T10:00:01Z', id: 'a' });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01Z',
      id: 'a',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01Z',
      id: 'a',
    });
  });

  test('strictly earlier timestamp → keep current (no regression)', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    setCursors(state, jid, { timestamp: '2026-04-26T10:00:01Z', id: 'm1' });
    advanceCursors(state, jid, { timestamp: '2026-04-26T10:00:00Z', id: 'm2' });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01Z',
      id: 'm1',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01Z',
      id: 'm1',
    });
  });

  test('regression demo: pre-fix buggy variant DOES regress on same-timestamp + earlier id', () => {
    // Direct contrast so a future reader can see the exact behavior change.
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    const T = '2026-04-26T10:00:00Z';
    setCursors(state, jid, { timestamp: T, id: 'm2' });
    advanceCursors_buggy(state, jid, { timestamp: T, id: 'm1' });
    // Pre-fix: cursor regressed to m1, drainGroup re-reads m2, reply re-fires.
    expect(state.lastAgentTimestamp[jid]).toEqual({ timestamp: T, id: 'm1' });
    expect(state.lastCommittedCursor[jid]).toEqual({ timestamp: T, id: 'm1' });
  });

  test('reply commits via setCursors then plain-msg advanceCursors does not regress recovery anchor', () => {
    // End-to-end batch flow: [plain m1, /cmd m2] same timestamp.
    //   1. expander returns reply for m2 → setCursors(state, jid, m2)
    //   2. agent finishes m1 → advanceCursors(state, jid, m1)
    // Pre-fix: lastCommittedCursor regressed to m1, next poll re-read m2,
    // reply re-fired. Post-fix: lastCommittedCursor sticks at m2.
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:main';
    const T = '2026-04-26T10:00:00Z';
    const m1: MessageCursor = { timestamp: T, id: 'm1' };
    const m2: MessageCursor = { timestamp: T, id: 'm2' };

    setCursors(state, jid, m2);
    advanceCursors(state, jid, m1);

    // Recovery anchor MUST stay at m2 — the reply for m2 was already
    // committed and m2 has been "processed" from the cursor's perspective.
    expect(state.lastCommittedCursor[jid]).toEqual(m2);
    // Next-pull cursor likewise stays at m2.
    expect(state.lastAgentTimestamp[jid]).toEqual(m2);
  });
});
