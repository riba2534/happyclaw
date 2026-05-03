/**
 * plugin-expander-round17-bugs.test.ts
 *
 * Regression tests for codex review round-17 PR2.b bugs (#27):
 *
 *   P1-1: src/index.ts processGroupMessages early-return path
 *         When `expandMessagesIfNeeded` converts the entire batch to
 *         plugin replies (`toSend.length === 0`), the function returns
 *         before reaching the runner-spawn finally block at line ~3532
 *         that calls `activeImReplyRoutes.delete(folder)`. The IM-route
 *         entry set at line 2669 stayed in the map. The next IPC
 *         `send_message` / `send_file` event for that folder mirrored to
 *         the wrong IM chat (the previous batch's source).
 *         Fix: clear `activeImReplyRoutes[folder]` in the early-return
 *         branch so the cleanup is symmetric with the spawn path.
 *
 *   P2-2: src/web.ts handleWebUserMessage / handleAgentConversationMessage
 *         The reply fast-path (no earlier pending) committed cursor by
 *         calling `setLastAgentTimestamp` (= `setCursors`) which directly
 *         overwrites BOTH cursors with no max-merge. When two messages
 *         shared the same millisecond timestamp and the cursor had already
 *         been advanced to the larger UUID, the smaller-UUID reply commit
 *         regressed the cursor → already-processed messages re-polled →
 *         reply re-fired.
 *         Fix: route the no-earlier-pending commit through `advanceCursors`
 *         instead — same-timestamp lex (timestamp, id) max-merge keeps the
 *         cursor at whichever (timestamp, id) is largest.
 *
 * Coverage:
 *   - P1-1: shadow of the early-return cleanup, asserts the routes map is
 *     cleared before the function returns (mirrors finally-block cleanup
 *     at index.ts:3532).
 *   - P2-2: shadow of the reply fast-path cursor commit, asserting that
 *     a smaller-UUID candidate at the same timestamp does not regress an
 *     already-committed larger-UUID cursor.
 */

import { describe, expect, test } from 'vitest';

// ─── P1-1: reply-only early return must clear activeImReplyRoutes ──────────

interface MessageLike {
  id: string;
  content: string;
}

interface ExpandResult {
  toSend: MessageLike[];
  replies: Array<{ originalMsg: MessageLike; text: string }>;
}

/**
 * Shadow of the post-fix expansion block in
 * src/index.ts processGroupMessages around line 2693-2740. Captures the
 * bug surface: when `toSend` is empty, the function early-returns; the
 * map cleanup must happen before that return.
 *
 * Pre-fix this returned without clearing → caller's stale
 * `activeImReplyRoutes[folder]` leaked into the next batch.
 */
function processBatch(args: {
  folder: string;
  expand: () => ExpandResult;
  routes: Map<string, string | null>;
  imSource: string | null;
  sendReply: (text: string, target: string | null) => void;
}): { earlyReturned: boolean } {
  args.routes.set(args.folder, args.imSource);

  const { toSend, replies } = args.expand();
  for (const r of replies) {
    args.sendReply(r.text, args.imSource);
  }
  if (toSend.length === 0) {
    // POST-FIX (#27 round-17 P1-1): mirror the runner-spawn finally
    // block's cleanup. Without this, stale entry leaks across batches.
    args.routes.delete(args.folder);
    return { earlyReturned: true };
  }
  // Spawn path: runner finally block (line ~3532) eventually clears the
  // route. Not modeled here — the bug is exclusively about the early-
  // return path.
  return { earlyReturned: false };
}

/** Pre-fix variant for direct contrast. */
function processBatch_buggy(args: {
  folder: string;
  expand: () => ExpandResult;
  routes: Map<string, string | null>;
  imSource: string | null;
  sendReply: (text: string, target: string | null) => void;
}): { earlyReturned: boolean } {
  args.routes.set(args.folder, args.imSource);
  const { toSend, replies } = args.expand();
  for (const r of replies) {
    args.sendReply(r.text, args.imSource);
  }
  if (toSend.length === 0) {
    // PRE-FIX: returned without clearing — stale route persists.
    return { earlyReturned: true };
  }
  return { earlyReturned: false };
}

describe('processGroupMessages early-return clears activeImReplyRoutes — #27 round-17 P1-1', () => {
  test('reply-only batch (toSend empty) clears the IM route entry before returning', () => {
    const routes = new Map<string, string | null>();
    const folder = 'home-alice';
    const replies: string[] = [];
    const imSource = 'feishu:chat-123';

    const result = processBatch({
      folder,
      imSource,
      routes,
      sendReply: (t) => replies.push(t),
      expand: () => ({
        toSend: [],
        replies: [
          {
            originalMsg: { id: 'm1', content: '/help' },
            text: 'Available commands: ...',
          },
        ],
      }),
    });

    expect(result.earlyReturned).toBe(true);
    expect(replies).toEqual(['Available commands: ...']);
    // Critical: route map must NOT retain the entry after early return.
    expect(routes.has(folder)).toBe(false);
  });

  test('next batch on same folder starts with a clean routes map', () => {
    // Simulates two consecutive reply-only batches. Pre-fix the first batch's
    // imSource leaked into the second. Post-fix each batch sets-then-clears.
    const routes = new Map<string, string | null>();
    const folder = 'home-alice';

    processBatch({
      folder,
      imSource: 'feishu:chat-A',
      routes,
      sendReply: () => {},
      expand: () => ({
        toSend: [],
        replies: [{ originalMsg: { id: 'm1', content: '/foo' }, text: 'a' }],
      }),
    });
    expect(routes.get(folder)).toBeUndefined();

    processBatch({
      folder,
      imSource: 'feishu:chat-B',
      routes,
      sendReply: () => {},
      expand: () => ({
        toSend: [],
        replies: [{ originalMsg: { id: 'm2', content: '/bar' }, text: 'b' }],
      }),
    });
    // After the second batch returns, the route is cleared. If a runaway
    // IPC send_message arrives later, there is no stale chat-A/chat-B entry
    // to misroute it to.
    expect(routes.has(folder)).toBe(false);
  });

  test('regression demo: pre-fix variant leaves the route entry hanging', () => {
    const routes = new Map<string, string | null>();
    const folder = 'home-alice';

    processBatch_buggy({
      folder,
      imSource: 'feishu:chat-stale',
      routes,
      sendReply: () => {},
      expand: () => ({
        toSend: [],
        replies: [{ originalMsg: { id: 'm1', content: '/help' }, text: 'r' }],
      }),
    });

    // Pre-fix: stale entry remains. A subsequent IPC send_message for this
    // folder would look up `feishu:chat-stale` and broadcast there even
    // though the originating IM chat has long since moved on.
    expect(routes.get(folder)).toBe('feishu:chat-stale');
  });

  test('non-empty toSend (mixed batch) takes the spawn path — early-return cleanup not exercised', () => {
    const routes = new Map<string, string | null>();
    const folder = 'home-alice';

    const result = processBatch({
      folder,
      imSource: 'feishu:chat-1',
      routes,
      sendReply: () => {},
      expand: () => ({
        toSend: [{ id: 'm2', content: 'plain text' }],
        replies: [{ originalMsg: { id: 'm1', content: '/foo' }, text: 'r' }],
      }),
    });

    expect(result.earlyReturned).toBe(false);
    // Spawn path keeps the route in place; the runner finally block (not
    // modeled in this shadow) is responsible for cleanup. The point of
    // this test is only that the P1-1 fix didn't accidentally clear on
    // the non-empty path too.
    expect(routes.get(folder)).toBe('feishu:chat-1');
  });
});

// ─── P2-2: reply fast-path commit must lex max-merge, not overwrite ────────

interface MessageCursor {
  timestamp: string;
  id: string;
}

interface CursorPair {
  lastAgentTimestamp: Record<string, MessageCursor>;
  lastCommittedCursor: Record<string, MessageCursor>;
}

function isCursorAfter(
  candidate: MessageCursor,
  base: MessageCursor,
): boolean {
  if (candidate.timestamp > base.timestamp) return true;
  if (candidate.timestamp < base.timestamp) return false;
  return candidate.id > base.id;
}

/**
 * Shadow of the post-fix `advanceCursors` from src/index.ts. Identical
 * algorithm to the round-16 fix — never regress past the existing position,
 * lex (timestamp, id) compare. Re-asserted here because the round-17 fix
 * changes the web reply fast-path to call `advanceCursors` instead of the
 * bare-overwrite `setCursors`.
 */
function advanceCursors(
  state: CursorPair,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state.lastAgentTimestamp[jid];
  const target =
    current && isCursorAfter(current, candidate) ? current : candidate;
  state.lastAgentTimestamp[jid] = target;
  state.lastCommittedCursor[jid] = target;
}

/** Pre-fix `setCursors` — direct overwrite, no max-merge. Buggy on the reply
 * fast-path because a smaller-UUID reply at the same millisecond regressed
 * an already-larger committed cursor. */
function setCursors(
  state: CursorPair,
  jid: string,
  cursor: MessageCursor,
): void {
  state.lastAgentTimestamp[jid] = cursor;
  state.lastCommittedCursor[jid] = cursor;
}

describe('web reply fast-path commit cursor — #27 round-17 P2-2', () => {
  test('post-fix: same timestamp, candidate id < current id → cursor stays at current', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const T = '2026-04-26T10:00:00.000Z';
    // Suppose the global poller already advanced cursor to (T, m-zzz) via
    // the agent processing an earlier neighbor in the same millisecond.
    setCursors(state, jid, { timestamp: T, id: 'm-zzz' });
    // Now the web reply fast-path commits its own reply cursor for
    // (T, m-aaa) — a UUID that happens to sort before m-zzz. With the fix
    // (`advanceCursors`), the lex max-merge keeps the cursor at m-zzz so
    // the next poll does not re-read messages already past.
    advanceCursors(state, jid, { timestamp: T, id: 'm-aaa' });

    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: T,
      id: 'm-zzz',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: T,
      id: 'm-zzz',
    });
  });

  test('post-fix: same timestamp, candidate id > current id → cursor advances', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const T = '2026-04-26T10:00:00.000Z';
    setCursors(state, jid, { timestamp: T, id: 'm-aaa' });
    advanceCursors(state, jid, { timestamp: T, id: 'm-zzz' });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: T,
      id: 'm-zzz',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: T,
      id: 'm-zzz',
    });
  });

  test('post-fix: empty cursor → first commit wins (no current to compare against)', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const candidate = { timestamp: '2026-04-26T10:00:00.000Z', id: 'reply-1' };
    advanceCursors(state, jid, candidate);
    expect(state.lastAgentTimestamp[jid]).toEqual(candidate);
    expect(state.lastCommittedCursor[jid]).toEqual(candidate);
  });

  test('regression demo: pre-fix setCursors REGRESSES the cursor on smaller-UUID same-ms commit', () => {
    // Direct contrast so the failure mode is visible. With the bug, the
    // reply at (T, m-aaa) overwrites cursor (T, m-zzz) → next poll starts
    // from m-aaa and re-reads everything in (m-aaa, m-zzz] → reply re-fires.
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    const T = '2026-04-26T10:00:00.000Z';
    setCursors(state, jid, { timestamp: T, id: 'm-zzz' });
    setCursors(state, jid, { timestamp: T, id: 'm-aaa' });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: T,
      id: 'm-aaa',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: T,
      id: 'm-aaa',
    });
  });

  test('strictly later timestamp commits regardless of id ordering', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    setCursors(state, jid, {
      timestamp: '2026-04-26T10:00:00.000Z',
      id: 'zzzz',
    });
    advanceCursors(state, jid, {
      timestamp: '2026-04-26T10:00:01.000Z',
      id: 'aaaa',
    });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01.000Z',
      id: 'aaaa',
    });
  });

  test('strictly earlier timestamp does not regress even if id is larger', () => {
    const state: CursorPair = {
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
    };
    const jid = 'web:home-alice';
    setCursors(state, jid, {
      timestamp: '2026-04-26T10:00:01.000Z',
      id: 'aaaa',
    });
    advanceCursors(state, jid, {
      timestamp: '2026-04-26T10:00:00.000Z',
      id: 'zzzz',
    });
    expect(state.lastAgentTimestamp[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01.000Z',
      id: 'aaaa',
    });
    expect(state.lastCommittedCursor[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01.000Z',
      id: 'aaaa',
    });
  });
});
