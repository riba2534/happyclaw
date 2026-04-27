/**
 * plugin-expander-round11-bugs.test.ts
 *
 * Regression tests for codex review round-11 PR2.b bugs (#20):
 *
 *   P1-1: sendPluginExpanderReply must fan out to IM when the source chat is
 *         an IM channel — without IM delivery, /codex:status conflicts /
 *         no-active-runner notices silently disappear on Feishu/TG/QQ.
 *
 *   P2-2: agent conversation cold-start must use the latest sender as plugin
 *         runtime owner on the admin-shared web:main workspace, mirroring
 *         the active-IPC path. Without this, a second admin starting a new
 *         agent conv would expand against the first admin's plugin runtime.
 *
 *   P2-3: advanceNextPullCursorOnly must compare lex (timestamp, id) — same
 *         timestamp + later id already-processed must not regress to the
 *         earlier id (would replay an already-handled reply).
 *
 *   P2-4: web main + agent conversation paths must NOT eager-execute inline
 *         `!` commands. Eager exec + sendMessage('no_active') fallback +
 *         cold-start re-expansion = double-execution.
 *
 * Pure helpers and shadow implementations isolate the specific algorithm
 * changes; integration smoke is provided by typecheck + existing 343-test
 * baseline (zero regressions required).
 */

import { describe, expect, test } from 'vitest';

interface MessageCursor {
  timestamp: string;
  id: string;
}

// ─── P2-3: advanceNextPullCursorOnly must compare (timestamp, id) lex ───────

/**
 * Shadow of the production `advanceNextPullCursorOnly` in src/index.ts after
 * the round-11 fix. Identical algorithm — lifted here so tests don't need to
 * spin up the whole module-level state of the main process.
 */
function advanceNextPullCursorOnly(
  state: Record<string, MessageCursor>,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state[jid];
  let target = candidate;
  if (current) {
    if (current.timestamp > candidate.timestamp) {
      target = current;
    } else if (current.timestamp === candidate.timestamp) {
      target = current.id > candidate.id ? current : candidate;
    }
  }
  state[jid] = target;
}

/**
 * The pre-fix buggy implementation, kept for direct comparison so a future
 * developer can see the exact behavior change at a glance.
 */
function advanceNextPullCursorOnly_buggy(
  state: Record<string, MessageCursor>,
  jid: string,
  candidate: MessageCursor,
): void {
  const current = state[jid];
  const target =
    current && current.timestamp > candidate.timestamp ? current : candidate;
  state[jid] = target;
}

describe('advanceNextPullCursorOnly — #20 P2-3 same-timestamp id tie-break', () => {
  test('same timestamp, candidate id < current id → keep current (avoid regression)', () => {
    const state: Record<string, MessageCursor> = {};
    const jid = 'web:home-alice';
    // getMessagesSince orders by (timestamp, id), so id "m2" was processed
    // AFTER "m1" even though their timestamps are identical.
    state[jid] = { timestamp: '2026-04-26T10:00:00Z', id: 'm2' };

    // Now an earlier id ("m1") tries to advance. Pre-fix code only compared
    // timestamps (equal → fell through to `candidate`) and would regress to m1.
    advanceNextPullCursorOnly(state, jid, {
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm1',
    });
    expect(state[jid]).toEqual({ timestamp: '2026-04-26T10:00:00Z', id: 'm2' });
  });

  test('same timestamp, candidate id > current id → advance', () => {
    const state: Record<string, MessageCursor> = {};
    const jid = 'feishu:room';
    state[jid] = { timestamp: '2026-04-26T10:00:00Z', id: 'm1' };

    advanceNextPullCursorOnly(state, jid, {
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm2',
    });
    expect(state[jid]).toEqual({ timestamp: '2026-04-26T10:00:00Z', id: 'm2' });
  });

  test('candidate timestamp strictly greater → advance regardless of id', () => {
    const state: Record<string, MessageCursor> = {};
    const jid = 'web:main';
    state[jid] = { timestamp: '2026-04-26T10:00:00Z', id: 'zzzz-late-id' };

    advanceNextPullCursorOnly(state, jid, {
      timestamp: '2026-04-26T10:00:01Z',
      id: 'a-early-id',
    });
    // Even though candidate.id < current.id, candidate.timestamp wins.
    expect(state[jid]).toEqual({
      timestamp: '2026-04-26T10:00:01Z',
      id: 'a-early-id',
    });
  });

  test('candidate timestamp strictly less → keep current', () => {
    const state: Record<string, MessageCursor> = {};
    const jid = 'web:main';
    state[jid] = { timestamp: '2026-04-26T10:00:01Z', id: 'm1' };

    advanceNextPullCursorOnly(state, jid, {
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm2',
    });
    expect(state[jid]).toEqual({ timestamp: '2026-04-26T10:00:01Z', id: 'm1' });
  });

  test('empty state → set candidate', () => {
    const state: Record<string, MessageCursor> = {};
    advanceNextPullCursorOnly(state, 'web:main', {
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm1',
    });
    expect(state['web:main']).toEqual({
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm1',
    });
  });

  test('regression demo: pre-fix buggy variant DOES regress on same-timestamp earlier id', () => {
    const state: Record<string, MessageCursor> = {};
    const jid = 'web:main';
    state[jid] = { timestamp: '2026-04-26T10:00:00Z', id: 'm2' };
    advanceNextPullCursorOnly_buggy(state, jid, {
      timestamp: '2026-04-26T10:00:00Z',
      id: 'm1',
    });
    expect(state[jid]).toEqual({ timestamp: '2026-04-26T10:00:00Z', id: 'm1' });
  });
});

// ─── P1-1: sendPluginExpanderReply IM fan-out ───────────────────────────────

/**
 * Pure routing helper that mirrors the per-callsite IM-target computation
 * inserted in src/index.ts at the three sendPluginExpanderReply call sites.
 * Returns the IM jid the reply should also be delivered to (or null if the
 * reply should stay web-only).
 */
function computeImRouteForReply(args: {
  chatJid: string; // group jid (could be IM, web, or virtual)
  originalSourceJid: string | undefined;
  fallbackImJid: string | null; // batch-level / agent-level persisted jid
  isIm: (jid: string | undefined | null) => boolean;
}): string | null {
  // Case 1: chatJid is itself an IM channel (e.g. feishu:room) — reply directly.
  if (args.isIm(args.chatJid)) return args.chatJid;
  // Case 2: per-message source_jid (preferred — keeps mixed batches per-user routed).
  if (args.isIm(args.originalSourceJid)) return args.originalSourceJid!;
  // Case 3: fallback (batch-level replySourceImJid or agent.last_im_jid).
  return args.fallbackImJid;
}

const isIm = (jid: string | undefined | null): boolean => {
  if (!jid) return false;
  // Mirror channel-prefixes.ts coverage for the channels we route to.
  return /^(feishu|telegram|qq|dingtalk|wechat|discord):/.test(jid);
};

describe('sendPluginExpanderReply IM routing — #20 P1-1 fan out to IM', () => {
  test('IM-direct chat (feishu:room) → reply also goes to feishu:room', () => {
    const route = computeImRouteForReply({
      chatJid: 'feishu:room-1',
      originalSourceJid: 'feishu:room-1',
      fallbackImJid: null,
      isIm,
    });
    expect(route).toBe('feishu:room-1');
  });

  test('Web-routed message that originated on Telegram → reply routes back to Telegram source', () => {
    const route = computeImRouteForReply({
      chatJid: 'web:home-alice', // user is reading on web
      originalSourceJid: 'telegram:123', // but this message came from TG
      fallbackImJid: null,
      isIm,
    });
    expect(route).toBe('telegram:123');
  });

  test('Pure web message (no IM source) → no IM fan-out (null)', () => {
    const route = computeImRouteForReply({
      chatJid: 'web:home-alice',
      originalSourceJid: undefined, // web messages have no source_jid
      fallbackImJid: null,
      isIm,
    });
    expect(route).toBeNull();
  });

  test('Web message + persisted agent.last_im_jid fallback → routes to last_im_jid', () => {
    // Agent conversation cold-start path: missedMessages may be all web
    // (e.g. user resumed from web after restart) but agent.last_im_jid
    // remembers the IM channel where the agent was originally bound.
    const route = computeImRouteForReply({
      chatJid: 'web:main#agent:abc-123',
      originalSourceJid: undefined,
      fallbackImJid: 'feishu:room-9',
      isIm,
    });
    expect(route).toBe('feishu:room-9');
  });

  test('Per-message source_jid wins over fallback (mixed batch)', () => {
    // Plain user msg arrived from QQ; previous batch's persisted last_im_jid
    // was Telegram. We should prefer this message's actual source_jid so the
    // reply lands in the chat that asked the slash command.
    const route = computeImRouteForReply({
      chatJid: 'web:home-alice',
      originalSourceJid: 'qq:99',
      fallbackImJid: 'telegram:1',
      isIm,
    });
    expect(route).toBe('qq:99');
  });

  test('non-IM source_jid (web-on-web reroute, theoretically) → fall through to fallback', () => {
    const route = computeImRouteForReply({
      chatJid: 'web:home-alice',
      originalSourceJid: 'web:home-alice', // not an IM prefix
      fallbackImJid: 'feishu:room-x',
      isIm,
    });
    expect(route).toBe('feishu:room-x');
  });
});

// ─── P2-2: agent conv cold-start sender override on admin-shared web:main ───

/**
 * Shadow of the runtime-owner resolution inserted into the agent-conversation
 * cold-start path. Mirrors the logic at src/index.ts ~line 5640 after the
 * round-11 fix and the active-IPC path at ~line 6620.
 */
interface MockUser {
  id: string;
  status: 'active' | 'disabled';
  role: 'admin' | 'member';
}
function resolveAgentConvColdStartOwner(args: {
  chatJid: string;
  isHome: boolean;
  createdBy: string | null | undefined;
  missedMessages: Array<{ sender: string }>;
  getUserById: (id: string) => MockUser | null;
}): string | null | undefined {
  let runtimeOwner: string | null | undefined = args.createdBy;
  if (args.chatJid === 'web:main' && args.isHome) {
    for (let i = args.missedMessages.length - 1; i >= 0; i--) {
      const sender = args.missedMessages[i]?.sender;
      if (!sender || sender === 'happyclaw-agent' || sender === '__system__')
        continue;
      const senderUser = args.getUserById(sender);
      if (senderUser?.status === 'active' && senderUser.role === 'admin') {
        runtimeOwner = senderUser.id;
        break;
      }
    }
  }
  return runtimeOwner;
}

describe('agent conv cold-start runtime owner — #20 P2-2 sender override', () => {
  const userTable: Record<string, MockUser> = {
    'admin-1': { id: 'admin-1', status: 'active', role: 'admin' },
    'admin-2': { id: 'admin-2', status: 'active', role: 'admin' },
    'admin-disabled': { id: 'admin-disabled', status: 'disabled', role: 'admin' },
    member: { id: 'member', status: 'active', role: 'member' },
  };
  const lookup = (id: string) => userTable[id] ?? null;

  test('web:main + is_home + last admin sender different from created_by → sender wins', () => {
    // admin-1 was the first to materialise web:main (created_by);
    // admin-2 is now starting a new agent conversation. Their per-user
    // plugin runtime must be the one expanded against.
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      missedMessages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('web:main + is_home + only system messages → fall back to created_by', () => {
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      missedMessages: [
        { sender: 'happyclaw-agent' },
        { sender: '__system__' },
      ],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('web:main + is_home + member sender (not admin) → fall back to created_by', () => {
    // The admin-shared override is admin-only; non-admin senders don't claim
    // ownership of the shared workspace (they don't have plugins enabled).
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      missedMessages: [{ sender: 'member' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('web:main + is_home + disabled admin sender → ignored, fall back', () => {
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      missedMessages: [{ sender: 'admin-disabled' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('non-web:main group → no override (single-owner home/member group)', () => {
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:home-alice',
      isHome: true,
      createdBy: 'alice',
      missedMessages: [{ sender: 'random-user' }],
      getUserById: lookup,
    });
    expect(owner).toBe('alice');
  });

  test('web:main but is_home=false → no override', () => {
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: false,
      createdBy: 'admin-1',
      missedMessages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('walks from end → picks the LATEST admin sender (not the first one)', () => {
    const owner = resolveAgentConvColdStartOwner({
      chatJid: 'web:main',
      isHome: true,
      createdBy: 'admin-1',
      missedMessages: [
        { sender: 'admin-2' },
        { sender: '__system__' },
        { sender: 'admin-1' }, // most recent → wins over admin-2
      ],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });
});

// ─── P2-4: web hybrid expand — call expander only when active runner ────────

/**
 * Shadow of the round-12 web path that fixes the round-11 leftover bug.
 *
 * Round-11 mistake (this file's earlier shadow): "call expander, decide whether
 * to use the result". This was wrong because `expandPluginSlashCommandIfNeeded`
 * is NOT a pure parser — it executes inline `!` commands as a side effect during
 * the call. Discarding the returned `expanded.prompt` does not undo the inline
 * exec. So the idle path was: web ran inline once → discarded → cold-start
 * re-read DB original → re-expanded → inline ran a second time.
 *
 * Round-12 fix: skip the expander call entirely when no active runner exists.
 * Cold-start owns expansion uniformly via `expandMessagesIfNeeded` (handles
 * reply/expanded/miss). When an active runner exists, expander runs here
 * (still side-effectful, but cold-start is bypassed because sendMessage='sent'
 * advances the cursor past this message).
 */
type ExpansionResult =
  | { kind: 'miss' }
  | { kind: 'expanded'; prompt: string }
  | { kind: 'reply'; text: string };

interface WebPathOutcome {
  expanderCalled: boolean;
  handledByReplyShortCircuit: boolean;
  sendContent: string;
}

/**
 * Shadow harness: takes a spy-able expander factory so tests can assert
 * whether it was called at all (the critical correctness property).
 */
function webPathRun(args: {
  hasActiveRunner: boolean;
  originalContent: string;
  expander: () => ExpansionResult; // call counted; "called" means inline ran
  spy: { calls: number };
}): WebPathOutcome {
  if (!args.hasActiveRunner) {
    // Idle: do NOT call expander (would run inline `!` as side effect).
    return {
      expanderCalled: false,
      handledByReplyShortCircuit: false,
      sendContent: args.originalContent,
    };
  }
  args.spy.calls += 1;
  const expansion = args.expander();
  if (expansion.kind === 'reply') {
    return {
      expanderCalled: true,
      handledByReplyShortCircuit: true,
      sendContent: '',
    };
  }
  if (expansion.kind === 'expanded') {
    return {
      expanderCalled: true,
      handledByReplyShortCircuit: false,
      sendContent: expansion.prompt,
    };
  }
  return {
    expanderCalled: true,
    handledByReplyShortCircuit: false,
    sendContent: args.originalContent,
  };
}

describe('web path expansion — #20 P2-4 round-12: skip expander when idle', () => {
  test('idle (no active runner) → expander NOT called (no inline side effect)', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: false,
      originalContent: '/codex:status',
      expander: () => ({
        kind: 'expanded',
        prompt: 'expanded with INLINE EXECUTED',
      }),
      spy,
    });
    // The critical assertion the round-11 shadow missed: expander itself
    // must not be invoked on the idle path. Cold-start owns expansion.
    expect(spy.calls).toBe(0);
    expect(result.expanderCalled).toBe(false);
    expect(result.sendContent).toBe('/codex:status');
    expect(result.handledByReplyShortCircuit).toBe(false);
  });

  test('idle path: even if expander would return reply, we still skip — cold-start handles it', () => {
    // Reply for inline DMI commands is generated in the expander after it has
    // ALREADY run inline (`!` exec is unconditional once parsing succeeds).
    // So even the "harmless reply" path triggers the side effect — must skip.
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: false,
      originalContent: '/codex:status',
      expander: () => ({ kind: 'reply', text: '请先发起对话启动工作区后重试。' }),
      spy,
    });
    expect(spy.calls).toBe(0);
    expect(result.expanderCalled).toBe(false);
    expect(result.sendContent).toBe('/codex:status');
  });

  test('active runner + reply → web short-circuits', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: true,
      originalContent: '/codex:status',
      expander: () => ({ kind: 'reply', text: '请先发起对话启动工作区后重试。' }),
      spy,
    });
    expect(spy.calls).toBe(1);
    expect(result.handledByReplyShortCircuit).toBe(true);
  });

  test('active runner + expanded → web pipes expanded prompt to runner', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: true,
      originalContent: '/codex:status',
      expander: () => ({
        kind: 'expanded',
        prompt: 'expanded prompt with INLINE EXECUTED',
      }),
      spy,
    });
    expect(spy.calls).toBe(1);
    expect(result.handledByReplyShortCircuit).toBe(false);
    expect(result.sendContent).toBe('expanded prompt with INLINE EXECUTED');
  });

  test('active runner + miss → pass-through (expander still called for parse)', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: true,
      originalContent: 'hello world',
      expander: () => ({ kind: 'miss' }),
      spy,
    });
    expect(spy.calls).toBe(1);
    expect(result.sendContent).toBe('hello world');
  });

  test('idle path + miss-shaped input → still skip; cold-start handles all kinds uniformly', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: false,
      originalContent: 'hello world',
      expander: () => ({ kind: 'miss' }),
      spy,
    });
    expect(spy.calls).toBe(0);
    expect(result.sendContent).toBe('hello world');
  });

  test('regression demo: round-11 buggy shadow always called expander → idle inline ran AND cold-start re-ran', () => {
    // Round-11 fix called expander unconditionally and then chose between
    // expanded.prompt and originalContent based on hasActiveRunner. Calling
    // the expander runs inline once. Returning original to enqueue path means
    // cold-start re-reads DB original and runs inline a second time.
    const spy = { calls: 0 };
    const buggyRun = (hasActiveRunner: boolean) => {
      spy.calls += 1; // unconditional expander call (round-11 mistake)
      const expansion: ExpansionResult = {
        kind: 'expanded',
        prompt: 'EAGER EXEC OUTPUT',
      };
      if (hasActiveRunner) return expansion.prompt;
      return '/codex:status'; // discard expanded prompt
    };
    const sentToRunner = buggyRun(false);
    expect(spy.calls).toBe(1); // inline `!` ran here
    // ...then cold-start re-reads DB (still original) and expands again =
    // inline `!` ran a SECOND time. The two-stage shadow above prevents this
    // by gating the expander call on hasActiveRunner.
    expect(sentToRunner).toBe('/codex:status');
  });

  test('post-fix idle path: expander not called → cold-start expands DB original exactly once', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: false,
      originalContent: '/codex:status',
      expander: () => {
        throw new Error('expander must not be invoked on idle path');
      },
      spy,
    });
    expect(spy.calls).toBe(0);
    expect(result.sendContent).toBe('/codex:status');
    // Cold-start (modeled separately by expandMessagesIfNeeded tests)
    // sees DB original and expands once. Inline `!` runs exactly once.
  });
});

// ─── P2-4 (agent conv): same idle-skip semantics ────────────────────────────

describe('agent conv path expansion — #20 P2-4 round-12: skip expander when idle', () => {
  test('idle agent conv → expander NOT called', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: false,
      originalContent: '/codex:status',
      expander: () => ({
        kind: 'expanded',
        prompt: 'expanded with INLINE EXECUTED',
      }),
      spy,
    });
    expect(spy.calls).toBe(0);
    expect(result.expanderCalled).toBe(false);
    expect(result.sendContent).toBe('/codex:status');
  });

  test('active agent conv + expanded → expander runs once, prompt piped to runner', () => {
    const spy = { calls: 0 };
    const result = webPathRun({
      hasActiveRunner: true,
      originalContent: '/codex:status',
      expander: () => ({
        kind: 'expanded',
        prompt: 'EAGER EXEC OUTPUT',
      }),
      spy,
    });
    expect(spy.calls).toBe(1);
    expect(result.sendContent).toBe('EAGER EXEC OUTPUT');
  });
});
