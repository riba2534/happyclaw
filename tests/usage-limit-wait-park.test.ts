/**
 * Waiting out a usage limit, run from index.ts against the real database:
 * parking a failed input with the backlog behind it, both conversation loops
 * keeping a waiting lane parked until new input arrives, and every way out
 * of a wait (break, cancel, send now, a discarded lane, a restart, and the
 * stale retry_wait sweep).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { parseChannelAddress } from '../src/channel-address.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
import { getChannelType } from '../src/im-channel.js';
import { createConversationLoop } from './helpers/conversation-loop.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// The static imports above load config, so the data root is made in the
// hoisted mock factory rather than at module top level.
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wait-park-'));
  for (const dir of ['db', 'groups']) {
    fs.mkdirSync(path.join(paths.root, dir), { recursive: true });
  }
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DATA_DIR: paths.root,
    STORE_DIR: path.join(paths.root, 'db'),
    GROUPS_DIR: path.join(paths.root, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');
const wait = await import('../src/usage-limit-wait.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

// A Home session migrated from the old main session (source_kind
// legacy_main): its lane is an ordinary session lane.
const LANE_SESSION = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const LANE = `web:park-lane#agent:${LANE_SESSION}`;
const EMPTY_CURSOR = { timestamp: '', id: '', sequence: 0 };

function inbound(id: string, minute: number): void {
  db.ensureChatExists(LANE);
  db.storeMessageDirect(
    id,
    LANE,
    'owner',
    'Owner',
    `message ${id}`,
    `2026-10-29T08:${String(minute).padStart(2, '0')}:00.000Z`,
    false,
  );
}

/** What parking and releasing a lane's inputs read from index.ts scope. */
function parkGlobals(): Record<string, any> {
  return {
    crypto,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    EMPTY_CURSOR,
    lastCommittedCursor: {} as Record<string, unknown>,
    getMessagesSince: db.getMessagesSince,
    setMessageFollowUp: db.setMessageFollowUp,
    claimNextQueuedFollowUpBatch: db.claimNextQueuedFollowUpBatch,
    releaseQueuedFollowUpBatch: db.releaseQueuedFollowUpBatch,
    getUsageLimitWait: store.getUsageLimitWait,
    endUsageLimitWait: wait.endUsageLimitWait,
    formatUsageLimitWaitNotice: wait.formatUsageLimitWaitNotice,
    formatUsageLimitResumeTime: wait.formatUsageLimitResumeTime,
    armUsageLimitResume: vi.fn(),
    broadcastFollowUpUpdate: vi.fn(),
    broadcastFollowUpBatchUpdate: vi.fn(),
    broadcastUsageLimitWait: vi.fn(),
    deliverTerminalFailureNotice: vi.fn(async () => {}),
    withdrawQueuedInputsOutsideAudience: vi.fn(),
    withdrawQueuedInputsOfEndedRuns: vi.fn(),
    enqueueReleasedFollowUp: vi.fn(),
  };
}

const PARK_FUNCTIONS = [
  'usageLimitParkedMessageIds',
  'parkInputForUsageLimitWait',
  'releaseQueuedFollowUpsToColdReader',
  'releaseUsageLimitWaitForNewInput',
];

function harness() {
  const globals = parkGlobals();
  const runtime = createRuntimeSourceHarness(globals);
  for (const name of PARK_FUNCTIONS) runtime.install(name);
  return { g: globals, runtime };
}

describe('parking an input that waits for a usage-limit reset', () => {
  test('the failed batch and the backlog behind it wait in the durable queue; new input brings them back', () => {
    const { g } = harness();
    inbound('m1', 1);
    inbound('m2', 2);
    inbound('m3', 3);
    // m1 was answered; m2 hit the wall; m3 was still waiting behind it.
    g.lastCommittedCursor[LANE] = db.getMessageCursor(LANE, 'm1');
    store.reserveUsageLimitWait({
      scopeKey: LANE,
      inputKey: 'm2',
      resetAt: '2026-10-29T09:00:00.000Z',
      resumeAt: '2026-10-29T09:01:10.000Z',
      maxWaits: 3,
    });

    const note = g.parkInputForUsageLimitWait({
      laneJid: LANE,
      agentId: LANE_SESSION,
      inputId: 'm2',
      messageIds: g.usageLimitParkedMessageIds(LANE, {}, [{ id: 'm2' }]),
      replySourceImJid: 'feishu:oc_park',
      turnScope: 'park-scope',
      presentation: 'default',
    });

    expect(note).toMatch(/^额度用尽，预计 .+ 自动继续$/);
    expect(
      db
        .listQueuedFollowUps(LANE)
        .map((item) => [item.id, item.delivery_run_id]),
    ).toEqual([
      // "Send now" needs a run id to name; the parked input carries its own.
      ['m2', 'usage-limit:m2'],
      ['m3', 'usage-limit:m2'],
    ]);
    expect(db.getMessagesSince(LANE, g.lastCommittedCursor[LANE])).toHaveLength(
      0,
    );
    expect(g.armUsageLimitResume).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: LANE, waitCount: 1 }),
    );
    expect(g.broadcastFollowUpUpdate).toHaveBeenCalledWith(LANE);
    expect(g.broadcastUsageLimitWait).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ resumeAt: '2026-10-29T09:01:10.000Z' }),
    );
    // One channel notice, keyed by the input so later waits stay quiet.
    expect(g.deliverTerminalFailureNotice).toHaveBeenCalledTimes(1);
    expect(g.deliverTerminalFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'feishu:oc_park',
        originalInputTurnId: 'm2',
        noticeKey: 'usage-limit-wait',
        text: expect.stringContaining('自动继续'),
      }),
    );

    // Nothing pending: the retry after the failed run finds no input.
    expect(g.releaseUsageLimitWaitForNewInput(LANE)).toBe(true);
    expect(
      db
        .getMessagesSince(LANE, g.lastCommittedCursor[LANE])
        .map((message) => message.id),
    ).toEqual(['m2', 'm3']);
    expect(store.getUsageLimitWait(LANE)).toMatchObject({
      state: 'resumed',
      waitCount: 1,
    });
    // The caller reads the batch itself; nothing else is scheduled.
    expect(g.enqueueReleasedFollowUp).not.toHaveBeenCalled();
    // A second new input finds no wait to end.
    expect(g.releaseUsageLimitWaitForNewInput(LANE)).toBe(false);
  });

  test('a Web input gets no channel notice', () => {
    const { g } = harness();
    const lane = LANE;
    inbound('w1', 20);
    g.lastCommittedCursor[lane] = EMPTY_CURSOR;
    store.reserveUsageLimitWait({
      scopeKey: lane,
      inputKey: 'w1',
      resetAt: '2026-10-29T09:00:00.000Z',
      resumeAt: '2026-10-29T09:01:00.000Z',
      maxWaits: 3,
    });
    g.parkInputForUsageLimitWait({
      laneJid: lane,
      agentId: LANE_SESSION,
      inputId: 'w1',
      messageIds: ['w1'],
      replySourceImJid: null,
      turnScope: 'park-scope',
      presentation: 'default',
    });
    expect(g.deliverTerminalFailureNotice).not.toHaveBeenCalled();
  });
});

/** Lanes whose parked inputs these tests read back; one per test. */
let laneSeq = 0;
let clock = Date.parse('2026-10-29T10:00:00.000Z');
const LATER = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * One lane run from index.ts against the real database: the main or a
 * Session conversation loop from its group lookup to the batch it admits,
 * plus the helpers that park and release that lane's inputs.
 */
function lane() {
  const chatJid = `web:wait-lane-${++laneSeq}`;
  const agentId = 'wait-session';
  const jid = `${chatJid}#agent:${agentId}`;
  const loop = createConversationLoop({
    chatJid,
    agentId,
    folder: `wait-lane-${laneSeq}`,
    globals: {
      ...parkGlobals(),
      getMessagesSinceBounded: db.getMessagesSinceBounded,
    },
  });
  const { globals: g, harness: runtime } = loop;
  for (const name of PARK_FUNCTIONS) runtime.install(name);

  const store_ = (id: string, meta?: Record<string, unknown>) => {
    db.ensureChatExists(jid);
    clock += 60_000;
    db.storeMessageDirect(
      id,
      jid,
      'owner',
      'Owner',
      `message ${id}`,
      new Date(clock).toISOString(),
      false,
      meta ? { meta } : undefined,
    );
  };
  return {
    g,
    runtime,
    jid,
    chatJid,
    agentId,
    inbound: (id: string) => store_(id),
    automationInput: (id: string) =>
      store_(id, { sourceKind: 'automation_prompt', automationRunId: 'run-1' }),
    /** The input `id` and everything before it were answered. */
    answeredThrough(id: string) {
      const cursor = db.getMessageCursor(jid, id);
      g.lastAgentTimestamp[jid] = cursor;
      g.lastCommittedCursor[jid] = cursor;
    },
    /** `inputId` hit a usage wall the run decided to wait out. */
    park(inputId: string) {
      store.reserveUsageLimitWait({
        scopeKey: jid,
        inputKey: inputId,
        resetAt: LATER(),
        resumeAt: LATER(),
        maxWaits: 3,
      });
      return g.parkInputForUsageLimitWait({
        laneJid: jid,
        agentId,
        inputId,
        messageIds: g.usageLimitParkedMessageIds(jid, {}, [{ id: inputId }]),
        replySourceImJid: null,
        turnScope: 'wait-scope',
        presentation: 'default',
      });
    },
    queued: () =>
      db
        .listQueuedFollowUps(jid)
        .map((item) => [item.id, item.delivery_run_id]),
    /** One scheduler round: the ids the turn would take, or null. */
    async round(): Promise<string[] | null> {
      const batch = await loop.round();
      return batch ? batch.map((message) => message.id) : null;
    },
  };
}

afterEach(() => wait.bindUsageLimitWaitHost(null));

describe('the session loop honours a waiting lane', () => {
  test.each(['agent'] as const)(
    '%s: parked input stays put; an automation input joins it; new input brings the user inputs back',
    async () => {
      const l = lane();
      l.inbound('m1');
      l.inbound('m2');
      l.inbound('m3');
      l.answeredThrough('m1');
      l.park('m2');
      // The retry after the failed run finds nothing to run.
      expect(await l.round()).toBeNull();

      l.automationInput('t1');
      expect(await l.round()).toBeNull();
      expect(l.queued()).toEqual([
        ['m2', 'usage-limit:m2'],
        ['m3', 'usage-limit:m2'],
        ['t1', 'usage-limit:m2'],
      ]);
      expect(l.g.broadcastFollowUpUpdate).toHaveBeenCalledWith(l.jid);
      expect(store.getUsageLimitWait(l.jid)?.state).toBe('waiting');

      l.inbound('m4');
      const batch = await l.round();
      // The automation input is a turn of its own: it never joins the
      // released user messages and stays queued for the next turn.
      expect(batch).toEqual(['m2', 'm3', 'm4']);
      expect(l.queued()).toEqual([['t1', 'usage-limit:m2']]);
      expect(store.getUsageLimitWait(l.jid)).toMatchObject({
        state: 'resumed',
        waitCount: 1,
      });
    },
  );
});

describe('a provider failure that waits parks the input', () => {
  function outputRuntime() {
    const l = lane();
    l.inbound('m1');
    l.inbound('m2');
    l.inbound('m3');
    l.answeredThrough('m1');
    const missedMessages = db.getMessagesSince(
      l.jid,
      l.g.lastCommittedCursor[l.jid],
    );
    Object.assign(l.g, {
      chatJid: l.chatJid,
      virtualChatJid: l.jid,
      virtualJid: l.jid,
      agentId: l.agentId,
      group: { name: 'Wait lane' },
      effectiveGroup: { folder: 'wait-lane' },
      lastProcessed: missedMessages[0],
      missedMessages,
      interactionMode: 'assistant',
      replySourceImJid: null,
      steeringTransitions: { shouldSuppressOutput: () => false },
      takeRecallStop: () => undefined,
      agentRecallSuppression: false,
      agentRecalledInputIds: new Set(),
      activateAgentProjectionForInput: vi.fn(async () => {}),
      resolveContainerOutputInputTurnId,
      isProviderQuotaControlOutput: () => false,
      bindRunnerActiveIpcCoverage: vi.fn(),
      resolveProviderFailureClass: () => 'quota',
      rollbackIdleAgentCardReservation: vi.fn(),
      admittedWarmAgentInputs: new Map(),
      clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
      channelTurnScope: (folder: string, agentId?: string) =>
        `${folder}:${agentId ?? ''}`,
      resetIdleTimer: vi.fn(),
      agentProviderFailoverPending: false,
      retryUnfinishedTurn: true,
      parkedForUsageLimitWait: false,
      agentUsageLimitWaitNote: null,
    });
    l.g.queue.markRunnerActivity = vi.fn();
    l.runtime.install('handleAgentOutput', 'processAgentConversation');
    return { ...l, emit: l.g.handleAgentOutput };
  }

  test.each(['agent'] as const)(
    '%s: the failed input and the backlog behind it wait; the run ends without a retry',
    async () => {
      const run = outputRuntime();
      store.reserveUsageLimitWait({
        scopeKey: run.jid,
        inputKey: 'm2',
        resetAt: LATER(),
        resumeAt: LATER(),
        maxWaits: 3,
      });
      await run.emit({
        status: 'error',
        result: null,
        error: 'usage limit',
        inputTurnId: 'm2',
        providerFailure: true,
        providerFailureTerminal: false,
        providerUsageLimitResumeAt: Date.parse(LATER()),
      });

      expect(run.queued()).toEqual([
        ['m2', 'usage-limit:m2'],
        ['m3', 'usage-limit:m2'],
      ]);
      expect(run.g.parkedForUsageLimitWait).toBe(true);
      expect(run.g.agentUsageLimitWaitNote).toMatch(/自动继续$/);
      expect(run.g.armUsageLimitResume).toHaveBeenCalledWith(
        expect.objectContaining({ scopeKey: run.jid }),
      );
      expect(run.g.clearAgentProcessingIndicatorForInput).toHaveBeenCalledWith(
        'm2',
      );

      // The loop's verdict once its runner exits: settled, not retried, even
      // when the turn itself was left unfinished.
      Object.assign(run.g, {
        output: { status: 'error' },
        retryUnfinishedTurn: true,
      });
      run.runtime.installTail(
        'runVerdict',
        'processAgentConversation',
        'parkedForUsageLimitWait',
      );
      expect(run.g.runVerdict()).toBe(true);
      // Without the park the same run asks to be retried.
      Object.assign(run.g, {
        parkedForUsageLimitWait: false,
        retryUnfinishedTurn: true,
      });
      expect(run.g.runVerdict()).toBe(false);
    },
  );
});

describe('every way out of a wait reaches it', () => {
  /** Globals a cancelled queued input settles through. */
  function cancelling(l: ReturnType<typeof lane>) {
    Object.assign(l.g, {
      getChannelType,
      parseChannelAddress,
      registeredGroups: {},
      cancelQueuedFollowUp: db.cancelQueuedFollowUp,
      cancelQueuedFollowUpsAtCutoff: db.cancelQueuedFollowUpsAtCutoff,
      listQueuedFollowUps: db.listQueuedFollowUps,
    });
    for (const name of [
      'channelTurnScopeForInput',
      'closeRetryWaitTurnsForWithdrawnInputs',
      'settleCancelledFollowUp',
      'cancelFollowUp',
      'cancelQueuedInputsOfLane',
    ]) {
      l.runtime.install(name);
    }
  }

  function parkedLane() {
    const l = lane();
    l.inbound('m1');
    l.inbound('m2');
    l.answeredThrough('m1');
    l.inbound('m3');
    l.park('m2');
    expect(l.queued().map(([id]) => id)).toEqual(['m2', 'm3']);
    return l;
  }

  test('/break cancels the parked inputs and forgets the wait', async () => {
    const l = parkedLane();
    cancelling(l);
    Object.assign(l.g, {
      learnFeishuDirectChat: vi.fn(),
      resolveRuntimeControlTarget: () => l.jid,
      interruptActiveSessionRun: () => ({
        activeRunId: null,
        interrupted: false,
      }),
    });
    l.runtime.install('handleSessionBreak');
    await expect(
      l.g.handleSessionBreak({
        sourceJid: 'feishu:oc_break',
        senderImId: 'ou_owner',
      }),
    ).resolves.toBe('Current task stopped.');
    expect(l.queued()).toEqual([]);
    expect(store.getUsageLimitWait(l.jid)).toBeNull();
  });

  test('cancelling the parked inputs one by one ends the wait with the last', () => {
    const l = parkedLane();
    cancelling(l);
    expect(l.g.cancelFollowUp(l.jid, 'm2')).toMatchObject({ ok: true });
    expect(store.getUsageLimitWait(l.jid)?.state).toBe('waiting');
    expect(l.g.cancelFollowUp(l.jid, 'm3')).toMatchObject({ ok: true });
    expect(store.getUsageLimitWait(l.jid)).toBeNull();
  });

  test('send now ends the wait and hands the lane to the cold reader', () => {
    const l = parkedLane();
    Object.assign(l.g, {
      queue: { getActiveQueryId: () => null },
      prioritizeQueuedFollowUp: db.prioritizeQueuedFollowUp,
      dispatchQueuedFollowUpFamily: vi.fn(),
    });
    l.runtime.install('promoteFollowUp');
    expect(l.g.promoteFollowUp(l.jid, 'm3', 'usage-limit:m2')).toMatchObject({
      ok: true,
      message: '已结束等待，正在重新发送。',
    });
    expect(l.queued()).toEqual([]);
    expect(store.getUsageLimitWait(l.jid)?.state).toBe('resumed');
    expect(l.g.enqueueReleasedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ chat_jid: l.jid }),
    );
    expect(l.g.dispatchQueuedFollowUpFamily).not.toHaveBeenCalled();
  });

  test('a discarded lane takes its parked inputs along', () => {
    const l = parkedLane();
    cancelling(l);
    // main() binds the wait host and the queue's discard hook.
    l.runtime.installCallArgument(
      'usageLimitWaitHost',
      'main',
      'bindUsageLimitWaitHost',
      0,
    );
    l.runtime.installCallArgument(
      'onLaneDiscarded',
      'main',
      'queue.setOnLaneDiscarded',
      0,
    );
    wait.bindUsageLimitWaitHost(l.g.usageLimitWaitHost);
    l.g.onLaneDiscarded(l.jid);
    expect(l.queued()).toEqual([]);
    expect(store.getUsageLimitWait(l.jid)).toBeNull();
    expect(l.g.broadcastUsageLimitWait).toHaveBeenCalledWith(l.jid, null);
  });

  test('a restart re-arms waiting lanes and releases every other queue', () => {
    const waiting = parkedLane();
    const other = lane();
    other.inbound('o1');
    db.setMessageFollowUp(other.jid, 'o1', { mode: 'queue', status: 'queued' });
    const g = waiting.g;
    g.getQueuedFollowUpChatJids = db.getQueuedFollowUpChatJids;
    g.rearmUsageLimitWaitsAfterRestart = wait.rearmUsageLimitWaitsAfterRestart;
    waiting.runtime.install('recoverDurableFollowUps');
    // The exact set main() hands over, computed now.
    waiting.runtime.installCallArgument(
      'restartWaitingLanes',
      'main',
      'recoverDurableFollowUps',
      0,
    );
    expect(g.restartWaitingLanes.has(waiting.jid)).toBe(true);
    g.recoverDurableFollowUps(g.restartWaitingLanes);
    expect(waiting.queued().map(([id]) => id)).toEqual(['m2', 'm3']);
    expect(db.listQueuedFollowUps(other.jid)).toEqual([]);
    expect(g.enqueueReleasedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
    );
  });

  test('the stale retry_wait sweep keeps every input a wait still holds', () => {
    // Ids of their own: other lanes in this file still wait with m2 and m3.
    const l = lane();
    l.inbound('s1');
    l.inbound('s2');
    l.answeredThrough('s1');
    l.inbound('s3');
    l.park('s2');
    l.inbound('s4'); // arrived during the wait, not read yet
    const unrelated = lane();
    unrelated.inbound('u1');
    const cancelStaleRetryWaitChannelTurns = vi.fn(() => 0);
    Object.assign(l.g, {
      cancelStaleRetryWaitChannelTurns,
      listPendingUsageLimitWaits: wait.listPendingUsageLimitWaits,
      listQueuedFollowUps: db.listQueuedFollowUps,
    });
    l.runtime.install('CHANNEL_RETRY_WAIT_TURN_MAX_AGE_MS');
    l.runtime.install('runStaleRetryWaitTurnSweep', 'main');
    l.g.runStaleRetryWaitTurnSweep();
    const [{ keepCorrelationIds }] = cancelStaleRetryWaitChannelTurns.mock
      .calls[0] as unknown as [{ keepCorrelationIds: string[] }];
    // The parked input, the backlog parked with it, and input not read yet.
    expect(keepCorrelationIds).toEqual(
      expect.arrayContaining(['s2', 's3', 's4']),
    );
    // Answered input and lanes that wait for nothing are swept as before.
    expect(keepCorrelationIds).not.toContain('s1');
    expect(keepCorrelationIds).not.toContain('u1');
  });
});
