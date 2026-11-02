/**
 * Automation inputs whose run ended, inputs answered without the agent, the
 * cancel and pending checks, and the exact-turn rule of automation tools —
 * all run from index.ts source with explicit dependencies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-automation-ended-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    STORE_DIR: path.join(root, 'store'),
    GROUPS_DIR: path.join(root, 'groups'),
    DATA_DIR: root,
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const ledger = await import('../src/automation-run-ledger.js');
const runtime = await import('../src/automation-runtime.js');
const { AgentBuilderTurnRegistry, agentBuilderTurnScope } =
  await import('../src/agent-builder-turn-auth.js');
const { resolveFeishuMessageAnchor, parseFeishuRouteTarget } =
  await import('../src/feishu.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type { AutomationRunOutcome } from '../src/automation-contract.js';
import type { NewMessage } from '../src/types.js';

const WORKSPACE = 'web:ended';
const SESSION_ID = 'ended-session';
const LANE = `${WORKSPACE}#agent:${SESSION_ID}`;
const FOLDER = 'ended';

/** A fake core whose run table is `live`. */
function core(live: Set<string>, silenced = new Set<string>()) {
  const settled: Array<[string, AutomationRunOutcome]> = [];
  ledger.setAutomationRuntimeService({
    runSink: {
      onRunInputStarted: () => {},
      onRunInputSettled: (runId: string, outcome: AutomationRunOutcome) => {
        live.delete(runId);
        settled.push([runId, outcome]);
      },
      isRunSilenced: (runId: string) => silenced.has(runId),
      isRunLive: (runId: string) => live.has(runId),
    },
  } as unknown as Parameters<typeof ledger.setAutomationRuntimeService>[0]);
  return settled;
}

const QUEUED = {
  deliveryMode: 'queue',
  deliveryStatus: 'queued',
  deliveryRunId: 'active',
};

let seq = 0;
function storeInput(
  runId: string | null,
  meta: Record<string, unknown> = {},
): NewMessage {
  const id = runId ? `automation-run-${runId}` : `user-${++seq}`;
  db.ensureChatExists(LANE);
  db.storeMessageDirect(
    id,
    LANE,
    runId ? 'automation' : 'owner',
    runId ? '日报' : 'Owner',
    'prompt',
    new Date(Date.now() + ++seq).toISOString(),
    false,
    {
      meta: runId
        ? { sourceKind: 'automation_prompt', automationRunId: runId, ...meta }
        : meta,
    },
  );
  return db
    .getMessagesSince(LANE, { timestamp: '', id: '' })
    .concat(db.listQueuedFollowUps(LANE) as never[])
    .find((message) => message.id === id)!;
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Ended',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: 'owner-1',
  });
});

beforeEach(() => {
  ledger.setAutomationRuntimeService(null);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('an input whose run is no longer live is consumed, not executed', () => {
  function dropHarness() {
    const completeOutOfBandMessage = vi.fn();
    const globals: Record<string, unknown> = { completeOutOfBandMessage };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('dropNonReplayableInputs');
    return {
      drop: globals.dropNonReplayableInputs as (
        lane: string,
        messages: NewMessage[],
      ) => NewMessage[],
      completeOutOfBandMessage,
    };
  }

  test('a run the core ended (cancel, delete, billing, restart) never reaches a runner', () => {
    const live = new Set(['r-live']);
    core(live);
    const user = storeInput(null);
    const ended = storeInput('r-ended');
    const running = storeInput('r-live');
    const { drop, completeOutOfBandMessage } = dropHarness();
    expect(drop(LANE, [user, ended, running]).map((m) => m.id)).toEqual([
      user.id,
      running.id,
    ]);
    expect(completeOutOfBandMessage).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ id: ended.id }),
    );
  });

  test('queued inputs of ended runs leave the queue before a claim', () => {
    const live = new Set<string>();
    core(live);
    const user = storeInput(null, QUEUED);
    const ended = storeInput('r-q-ended', QUEUED);
    const globals: Record<string, unknown> = {
      listQueuedAutomationFollowUps: db.listQueuedAutomationFollowUps,
      withdrawQueuedFollowUp: db.withdrawQueuedFollowUp,
      settleCancelledFollowUp: vi.fn(),
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('withdrawQueuedInputsOfEndedRuns');
    (globals.withdrawQueuedInputsOfEndedRuns as (jid: string) => void)(LANE);
    expect(db.listQueuedFollowUps(LANE).map((item) => item.id)).toEqual([
      user.id,
    ]);
    expect(globals.settleCancelledFollowUp).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ id: ended.id }),
      expect.any(String),
    );
  });
});

describe('a prepared batch whose run ended meanwhile', () => {
  function prepared(messages: NewMessage[], runtimeIds: string[]) {
    const runtimes = new Map(
      runtimeIds.map((id) => [
        id,
        {
          cancel: vi.fn(() => true),
          retry: vi.fn(() => true),
          dispose: vi.fn(),
        },
      ]),
    );
    const commitBatch = vi.fn();
    const globals: Record<string, unknown> = {
      queue: { enqueueMessageCheck: vi.fn() },
      logger: { warn: vi.fn() },
      completeOutOfBandMessage: vi.fn(),
      completeOutOfBandMessages: vi.fn(),
      getUncertainChannelOutboxForTurn: () => undefined,
      getFailedChannelOutboxForTurn: () => undefined,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('settleInterruptedChannelTurn');
    harness.install('runnableBatchInputs');
    const runnable = (
      globals.runnableBatchInputs as (...args: unknown[]) => NewMessage[] | null
    )(LANE, messages, runtimes, commitBatch);
    return { runnable, runtimes, commitBatch, globals };
  }

  test('only ended inputs: every turn is cancelled and the batch is consumed', () => {
    core(new Set());
    const ended = storeInput('r-batch-all');
    const run = prepared([ended], [ended.id]);
    expect(run.runnable).toBeNull();
    expect(run.commitBatch).toHaveBeenCalledTimes(1);
    expect(run.runtimes.size).toBe(0);
  });

  test('mixed: the earlier user input runs and the batch commits as one', () => {
    core(new Set());
    const user = storeInput(null);
    const ended = storeInput('r-batch-mixed');
    const run = prepared([user, ended], [ended.id]);
    // The prompt is built from these; the batch's turn keeps running and
    // its normal commit moves the cursor past both inputs.
    expect(run.runnable).toEqual([user]);
    expect(run.commitBatch).not.toHaveBeenCalled();
    expect(run.runtimes.size).toBe(1);
    // Nothing moves the pull cursor on its own, so U1 is never skipped.
    expect(run.globals.completeOutOfBandMessage).not.toHaveBeenCalled();
    expect(run.globals.completeOutOfBandMessages).not.toHaveBeenCalled();
  });

  test('nothing ended: the batch starts as prepared', () => {
    core(new Set(['r-batch-live']));
    const live = storeInput('r-batch-live');
    const messages = [live];
    const run = prepared(messages, [live.id]);
    expect(run.runnable).toBe(messages);
    expect(run.commitBatch).not.toHaveBeenCalled();
  });
});

describe('an input answered without the agent settles its run', () => {
  function pluginHarness(original: Record<string, unknown> | null) {
    const deliverPluginExpanderReply = vi.fn(async () => ({
      messageId: 'sys',
      acknowledged: true,
    }));
    const globals: Record<string, unknown> = {
      getAgentBuilderInputMessage: () => original,
      deliverPluginExpanderReply,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('sendPluginExpanderReply');
    const send = globals.sendPluginExpanderReply as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return { send, deliverPluginExpanderReply };
  }

  test('a plugin command reply is the run result; a quiet run keeps it on the Web', async () => {
    const live = new Set(['r-plugin']);
    const settled = core(live, new Set(['r-plugin']));
    const { send, deliverPluginExpanderReply } = pluginHarness({
      source_kind: 'automation_prompt',
      automation_run_id: 'r-plugin',
    });
    await send(LANE, '日报：无新提交', {
      originalMessageId: 'automation-run-r-plugin',
      groupFolder: FOLDER,
      imRouteJid: 'feishu:oc_group',
    });
    expect(deliverPluginExpanderReply).toHaveBeenCalledWith(
      LANE,
      '日报：无新提交',
      expect.objectContaining({ imRouteJid: null }),
    );
    expect(settled).toEqual([
      ['r-plugin', { status: 'success', resultText: '日报：无新提交' }],
    ]);
  });

  test('an ordinary reply keeps its route and settles nothing', async () => {
    const settled = core(new Set());
    const { send, deliverPluginExpanderReply } = pluginHarness({
      source_kind: null,
      automation_run_id: null,
    });
    await send(LANE, 'ok', {
      originalMessageId: 'user-1',
      groupFolder: FOLDER,
      imRouteJid: 'feishu:oc_group',
    });
    expect(deliverPluginExpanderReply).toHaveBeenCalledWith(
      LANE,
      'ok',
      expect.objectContaining({ imRouteJid: 'feishu:oc_group' }),
    );
    expect(settled).toEqual([]);
  });

  test.each([
    ['skip_terminal', 'completed', { status: 'success', resultText: null }],
    ['skip_terminal', 'failed', { status: 'failed' }],
    ['skip_terminal', 'interrupted', { status: 'interrupted' }],
    ['skip_terminal', 'cancelled', { status: 'cancelled' }],
    ['manual_reconciliation', 'interrupted', { status: 'interrupted' }],
  ] as const)(
    'a channel turn that is %s after %s settles the run of its input like that',
    async (disposition, openedStatus, outcome) => {
      const runId = `r-${disposition}-${openedStatus}`;
      const settled = core(new Set([runId]));
      const tracker = new ledger.AutomationTurnTracker();
      tracker.remember('input-d', [{ automation_run_id: runId }]);
      const globals: Record<string, unknown> = {
        agentChannelTurnRuntime: {
          executionDisposition: disposition,
          openedStatus,
          dispose: vi.fn(),
        },
        agentStreamingAddress: {
          provider: 'feishu',
          externalChatId: 'oc_group',
        },
        agentStreamingAccountId: 'account-1',
        replySourceImJid: 'feishu:oc_group',
        interactionMode: 'assistant',
        deliverChannelManualReconciliationNotice: vi.fn(async () => true),
        channelTurnScope: (folder: string) => folder,
        clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
        updateAgentStatus: vi.fn(),
        agent: { kind: 'conversation' },
        agentId: SESSION_ID,
        logger: { info: vi.fn() },
        effectiveGroup: { folder: FOLDER },
        chatJid: WORKSPACE,
        virtualChatJid: LANE,
        lastProcessed: { id: 'input-d', timestamp: '' },
        advanceCursors: vi.fn(),
        automationTurns: tracker,
      };
      const harness = createRuntimeSourceHarness(globals);
      harness.installTail(
        'channelTurnDisposition',
        'processAgentConversation',
        "agentChannelTurnRuntime &&\n    agentChannelTurnRuntime.executionDisposition !== 'execute'",
      );
      await expect(
        (globals.channelTurnDisposition as () => Promise<boolean>)(),
      ).resolves.toBe(true);
      expect(settled).toEqual([[runId, expect.objectContaining(outcome)]]);
    },
  );
});

describe('cancelling and checking an automation input', () => {
  const SCOPE = agentBuilderTurnScope(FOLDER, SESSION_ID);
  function laneHarness(overrides: Record<string, unknown> = {}) {
    const registry = new AgentBuilderTurnRegistry();
    const queue = {
      interruptQuery: vi.fn(() => true),
      closeStdin: vi.fn(),
      activeQueryExclusivelyCoversMessage: vi.fn(() => false),
    };
    const globals: Record<string, unknown> = {
      getQueuedFollowUp: db.getQueuedFollowUp,
      withdrawQueuedFollowUp: db.withdrawQueuedFollowUp,
      settleCancelledFollowUp: vi.fn(),
      activeAgentBuilderTurns: registry,
      agentBuilderTurnScope,
      getAgent: (id: string) =>
        id === SESSION_ID ? { id, group_folder: FOLDER } : undefined,
      queue,
      getAgentBuilderInputMessage: db.getAgentBuilderInputMessage,
      getMessageCursor: db.getMessageCursor,
      completeOutOfBandMessage: vi.fn(),
      lastCommittedCursor: {},
      EMPTY_CURSOR: { timestamp: '', id: '', sequence: 0 },
      ...overrides,
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'isCursorAfter',
      'cancelAutomationLaneInput',
      'promoteNextDeliveredBatch',
      'isAutomationLaneInputPending',
    ]) {
      harness.install(name);
    }
    return {
      globals,
      registry,
      queue,
      cancel: globals.cancelAutomationLaneInput as (
        lane: string,
        id: string,
      ) => Promise<void>,
      pending: globals.isAutomationLaneInputPending as (
        lane: string,
        id: string,
      ) => boolean,
      promote: globals.promoteNextDeliveredBatch as (
        scope: string,
        lane: string,
        completed: Array<{ chatJid: string; messageId: string }>,
      ) => void,
    };
  }

  test('an input being promoted is withdrawn before the runner can receive it', async () => {
    core(new Set(['r-promoting']));
    for (const item of db.listQueuedFollowUps(LANE)) {
      db.withdrawQueuedFollowUp(LANE, item.id, new Date().toISOString());
    }
    const input = storeInput('r-promoting', QUEUED);
    db.claimNextQueuedFollowUpBatch(LANE, 'reserved');
    expect(db.getQueuedFollowUp(LANE, input.id)?.delivery_status).toBe(
      'promoting',
    );
    const lane = laneHarness();
    await lane.cancel(LANE, input.id);
    // The injection re-reads the queue row right before IPC: gone.
    expect(db.getQueuedFollowUp(LANE, input.id)).toBeNull();
    expect(lane.queue.interruptQuery).not.toHaveBeenCalled();
  });

  test("an input in the run's own executing batch is steered away", async () => {
    core(new Set(['r-executing']));
    const input = storeInput('r-executing');
    const lane = laneHarness();
    lane.registry.startBatch(SCOPE, [
      {
        chatJid: LANE,
        messageId: input.id,
        runtimeTurnId: input.id,
        automationRunId: 'r-executing',
      },
    ]);
    await lane.cancel(LANE, input.id);
    expect(lane.queue.interruptQuery).toHaveBeenCalledWith(LANE);
    expect(lane.queue.closeStdin).not.toHaveBeenCalled();
  });

  test('a run piped behind a user turn waits; once its batch is active it is steered away', async () => {
    // The scheduler records the run cancelled before it withdraws the input.
    const live = new Set<string>();
    const settled = core(live);
    const input = storeInput('r-piped');
    const lane = laneHarness();
    lane.registry.startBatch(SCOPE, [
      { chatJid: LANE, messageId: 'user-turn', runtimeTurnId: 'user-turn' },
    ]);
    lane.registry.enqueueBatch(SCOPE, [
      {
        chatJid: LANE,
        messageId: input.id,
        runtimeTurnId: 'delivery-2',
        automationRunId: 'r-piped',
      },
    ]);
    await lane.cancel(LANE, input.id);
    // The user's turn keeps running.
    expect(lane.queue.interruptQuery).not.toHaveBeenCalled();
    expect(lane.queue.closeStdin).not.toHaveBeenCalled();

    // The user's turn settles; the run's batch becomes the active one.
    lane.promote(SCOPE, LANE, [{ chatJid: LANE, messageId: 'user-turn' }]);
    expect(lane.queue.interruptQuery).toHaveBeenCalledTimes(1);
    expect(lane.queue.interruptQuery).toHaveBeenCalledWith(LANE);
    expect(lane.registry.activeBatch(SCOPE).map((t) => t.messageId)).toEqual([
      input.id,
    ]);
    // The run stays cancelled: nothing here settled it again.
    expect(settled).toEqual([]);
    expect(ledger.isAutomationRunLive('r-piped')).toBe(false);
  });

  test('a live piped batch becoming active is not interrupted', () => {
    core(new Set(['r-piped-live']));
    const lane = laneHarness();
    lane.registry.startBatch(SCOPE, [
      { chatJid: LANE, messageId: 'user-turn', runtimeTurnId: 'user-turn' },
    ]);
    lane.registry.enqueueBatch(SCOPE, [
      {
        chatJid: LANE,
        messageId: 'automation-run-r-piped-live',
        runtimeTurnId: 'delivery-2',
        automationRunId: 'r-piped-live',
      },
    ]);
    lane.promote(SCOPE, LANE, [{ chatJid: LANE, messageId: 'user-turn' }]);
    expect(lane.queue.interruptQuery).not.toHaveBeenCalled();
  });

  test('an input nobody read yet is left to the next read, which drops it', async () => {
    core(new Set());
    const input = storeInput('r-unread');
    const lane = laneHarness();
    await lane.cancel(LANE, input.id);
    expect(lane.queue.interruptQuery).not.toHaveBeenCalled();
    expect(lane.queue.closeStdin).not.toHaveBeenCalled();
  });

  test('pending is one row read against the committed cursor', () => {
    core(new Set(['r-pending', 'r-done']));
    const done = storeInput('r-done');
    const waiting = storeInput('r-pending');
    const lane = laneHarness({
      lastCommittedCursor: { [LANE]: db.getMessageCursor(LANE, done.id) },
      getMessagesSince: () => {
        throw new Error('no lane scan');
      },
    });
    expect(lane.pending(LANE, waiting.id)).toBe(true);
    expect(lane.pending(LANE, done.id)).toBe(false);
    expect(lane.pending(LANE, 'automation-run-missing')).toBe(false);
  });
});

describe('where a run delivers', () => {
  const TOPIC = 'feishu:oc_topics#thread:omt_1#root:om_root';
  function deps(routes: Record<string, string>, bindings: string[]) {
    return runtime.createAutomationRuntimeDeps({
      getGroup: () => undefined,
      admitInput: () => 'started',
      wake: vi.fn(),
      broadcastNewMessage: vi.fn(),
      routeSessionOf: (jid) => routes[jid] ?? null,
      listSessionImRoutes: () => bindings,
      isInputPending: () => true,
      cancelInput: vi.fn(async () => {}),
      sendImText: vi.fn(async () => true),
      postSessionMessage: vi.fn(async () => {}),
      broadcastAutomationEvent: vi.fn(),
    });
  }
  const automation = { workspaceJid: 'web:ws' } as never;

  test('the creating route while it still routes to the session', () => {
    expect(
      deps({ [TOPIC]: 'web:ws#agent:s1' }, []).resolveDeliveryRoute({
        automation,
        sessionJid: 'web:ws#agent:s1',
        preferredRouteJid: TOPIC,
      }),
    ).toBe(TOPIC);
  });

  test('after an unbind or rebind, never the old chat', () => {
    expect(
      deps({ [TOPIC]: 'web:other#agent:x' }, [
        'feishu:oc_new',
      ]).resolveDeliveryRoute({
        automation,
        sessionJid: 'web:ws#agent:s1',
        preferredRouteJid: TOPIC,
      }),
    ).toBe('feishu:oc_new');
    expect(
      deps({}, ['feishu:oc_a', 'feishu:oc_b']).resolveDeliveryRoute({
        automation,
        sessionJid: 'web:ws',
        preferredRouteJid: 'feishu:oc_gone',
      }),
    ).toBeNull();
  });

  test('a fresh/persistent notice may use any session of the workspace', () => {
    expect(
      deps({ 'feishu:oc_a': 'web:ws' }, []).resolveDeliveryRoute({
        automation,
        sessionJid: null,
        preferredRouteJid: 'feishu:oc_a',
      }),
    ).toBe('feishu:oc_a');
  });

  test('run sessions are listed newest first, archived ones included', () => {
    const create = (id: string, at: string, status: 'idle' | 'completed') =>
      db.createAgent({
        id,
        group_folder: FOLDER,
        chat_jid: LANE,
        name: id,
        prompt: '',
        status,
        kind: 'conversation',
        created_by: 'owner-1',
        created_at: at,
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
        source_kind: 'automation',
        automation_id: 'auto-list',
      });
    create('s-old', '2026-10-01T00:00:00.000Z', 'completed');
    create('s-new', '2026-10-02T00:00:00.000Z', 'idle');
    expect(deps({}, []).listAutomationSessions('auto-list')).toEqual([
      { sessionJid: `${LANE}#agent:s-new`, archived: false },
      { sessionJid: `${LANE}#agent:s-old`, archived: true },
    ]);
  });
});

describe('reply anchors of automation inputs', () => {
  test('a card for an automation input in a plain Feishu group quotes nothing', () => {
    expect(
      resolveFeishuMessageAnchor({
        target: parseFeishuRouteTarget('oc_group'),
        chatType: 'group',
        lastMessageId: 'om_unrelated_user_message',
        // `automation-run-…` is not a Feishu message id: no anchor.
        inputMessageId: null,
      }),
    ).toBeUndefined();
    expect(
      resolveFeishuMessageAnchor({
        target: parseFeishuRouteTarget('oc_dm'),
        chatType: 'p2p',
        lastMessageId: 'om_unrelated_user_message',
        inputMessageId: null,
      }),
    ).toBeUndefined();
  });
});

describe('an automation run session releases its runner', () => {
  test.each([
    ['automation', 'success', true],
    ['automation', 'failed', true],
    ['automation', 'interrupted', true],
    ['manual', 'failed', false],
  ] as const)(
    'a %s session after a %s run: closed %s',
    (sourceKind, status, closed) => {
      const runId = `r-close-${sourceKind}-${status}`;
      core(new Set([runId]));
      const queue = { closeStdin: vi.fn() };
      const globals: Record<string, unknown> = {
        agent: { source_kind: sourceKind },
        queue,
        virtualJid: 'web:ws#agent:s1',
        AutomationTurnTracker: ledger.AutomationTurnTracker,
      };
      createRuntimeSourceHarness(globals).install(
        'automationTurns',
        'processAgentConversation',
      );
      const tracker = globals.automationTurns as InstanceType<
        typeof ledger.AutomationTurnTracker
      >;
      tracker.remember('t1', [{ automation_run_id: runId }]);
      tracker.settle(
        't1',
        status === 'success'
          ? { status, resultText: null }
          : { status, error: 'x' },
      );
      expect(queue.closeStdin).toHaveBeenCalledTimes(closed ? 1 : 0);
    },
  );
});

describe('script automations', () => {
  test('a script is stopped after CONTAINER_TIMEOUT without output, as set now', () => {
    const settings = { containerTimeout: 1_234 };
    const globals: Record<string, unknown> = {
      getSystemSettings: () => settings,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.installCallArgument(
      'automationCoreOptions',
      'main',
      'createAutomationCore',
      1,
    );
    const options = globals.automationCoreOptions as {
      scriptIdleTimeoutMs: () => number;
    };
    expect(options.scriptIdleTimeoutMs()).toBe(1_234);
    settings.containerTimeout = 5_678;
    expect(options.scriptIdleTimeoutMs()).toBe(5_678);
  });
});
