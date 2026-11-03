import { describe, expect, test, vi } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  ownerImIdFromPersistedSender,
} from '../src/agent-builder-turn-auth.js';
import { getChannelType } from '../src/im-channel.js';
import { skillMutationTurnRejection } from '../src/skill-ipc-authorization.js';
import {
  followupInputItem,
  readTeamInput,
  withTeamInputAttachment,
} from '../src/team-gate.js';
import type { WorkItem } from '../src/work-items.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const OWNER = 'owner-1';
const FOLDER = 'mt-ws';
const LANE = 'web:mt-ws#agent:main-1';
const GROUP = 'feishu:oc_group';

interface Input {
  content: string;
  sender: string | null;
  source_jid: string | null;
  is_from_me: number;
  source_kind: string | null;
  automation_run_id: string | null;
}

function webInput(sender: string, extra: Partial<Input> = {}): Input {
  return {
    content: 'x',
    sender,
    source_jid: LANE,
    is_from_me: 0,
    source_kind: null,
    automation_run_id: null,
    ...extra,
  };
}

/** index.ts's ownerTurnOf over a real turn registry. */
function host(inputs: Record<string, Input>) {
  const registry = new AgentBuilderTurnRegistry();
  const globals: Record<string, unknown> = {
    activeAgentBuilderTurns: registry,
    agentBuilderTurnScope,
    skillMutationTurnRejection,
    getAgentBuilderInputMessage: (_chatJid: string, messageId: string) =>
      inputs[messageId] ?? null,
    registeredGroups: {},
    getRegisteredGroup: () => undefined,
    getJidsByFolder: () => ['web:mt-ws'],
    getChannelType,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('ownerTurnRejection');
  harness.install('ownerTurnOf');
  const scope = agentBuilderTurnScope(FOLDER, 'main-1');
  const batch = (ids: string[], runtimeTurnId: string) =>
    ids.map((messageId) => ({
      chatJid: LANE,
      messageId,
      runtimeTurnId,
      automationRunId: null,
    }));
  const ownerTurnOf = (inputTurnId: string | null, owner = OWNER) =>
    (
      globals.ownerTurnOf as (
        ...args: unknown[]
      ) => { input: { chatJid: string; messageId: string } | null } | null
    )(FOLDER, owner ? { created_by: owner } : undefined, 'main-1', inputTurnId);
  return { registry, scope, batch, ownerTurnOf };
}

describe('the owner turn of a delegation tool (ownerTurnOf)', () => {
  test("the owner's own turn: the last input of the batch inputTurnId names", () => {
    const { registry, scope, batch, ownerTurnOf } = host({
      a: webInput(OWNER),
      b: webInput(OWNER),
      c: webInput(OWNER),
    });
    registry.startBatch(scope, batch(['a', 'b'], 'turn-1'));
    registry.enqueueBatch(scope, batch(['c'], 'turn-2'));
    expect(ownerTurnOf('turn-1')).toEqual({
      input: { chatJid: LANE, messageId: 'b' },
    });
    // A batch already piped to the runner answers for itself.
    expect(ownerTurnOf('turn-2')).toEqual({
      input: { chatJid: LANE, messageId: 'c' },
    });
    // No inputTurnId: the owner's turn, but no input to answer to; never
    // the batch executing now.
    expect(ownerTurnOf(null)).toEqual({ input: null });
    // A request that outlived its turn names no delivered batch.
    expect(ownerTurnOf('turn-gone')).toBeNull();
    // A workspace without an owner has no owner turn.
    expect(ownerTurnOf('turn-1', '')).toBeNull();
  });

  test('any input not typed by the owner refuses, as for install_skill', () => {
    for (const other of [
      webInput('someone-else'),
      webInput(OWNER, { source_kind: 'work_item_input' }),
      webInput(OWNER, { source_kind: 'automation_prompt' }),
      webInput(OWNER, { is_from_me: 1 }),
    ]) {
      const { registry, scope, batch, ownerTurnOf } = host({
        a: webInput(OWNER),
        b: other,
      });
      registry.startBatch(scope, batch(['a', 'b'], 'turn-1'));
      expect(ownerTurnOf('turn-1')).toBeNull();
      expect(ownerTurnOf(null)).toBeNull();
    }
    // Queued behind the turn counts too, as for install_skill.
    const { registry, scope, batch, ownerTurnOf } = host({
      a: webInput(OWNER),
      b: webInput('someone-else'),
    });
    registry.startBatch(scope, batch(['a'], 'turn-1'));
    registry.enqueueBatch(scope, batch(['b'], 'turn-2'));
    expect(ownerTurnOf('turn-1')).toBeNull();
  });
});

describe("a delegated item's report waiting in a group session's queue", () => {
  function sender(item: Record<string, unknown>) {
    const globals: Record<string, unknown> = {
      getChannelType,
      readTeamInput,
      ownerImIdFromPersistedSender,
    };
    createRuntimeSourceHarness(globals).install('queuedInputImSender');
    return (globals.queuedInputImSender as (item: unknown) => unknown)(item);
  }
  const context = {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: null,
    sourceJid: GROUP,
    chat: { id: 'oc_group' },
    message: { id: 'om_ask' },
  };

  test("is nobody's message: an audience change never withdraws it", () => {
    expect(
      sender({
        source_jid: GROUP,
        source_kind: 'work_item_input',
        sender: 'happyclaw-team',
        channel_context: context,
        attachments: withTeamInputAttachment(null, {
          type: 'team_input',
          tag: 'work_report',
          attrs: [['state', 'ready']],
          facts: { workItemId: 'w1' },
        }),
      }),
    ).toBeNull();
  });

  test("a team follow-up copy is still its sender's message", () => {
    expect(
      sender({
        source_jid: GROUP,
        source_kind: 'work_item_input',
        sender: 'happyclaw-team',
        channel_context: context,
        attachments: withTeamInputAttachment(
          null,
          followupInputItem({
            item: { id: 'w1', seq: 1 } as WorkItem,
            triggerMessageId: 'om_member',
            listed: false,
            addressed: true,
            senderImId: 'ou_member',
          }),
        ),
      }),
    ).toEqual({ imId: 'ou_member' });
    // And an ordinary group message is its sender's.
    expect(
      sender({
        source_jid: GROUP,
        source_kind: null,
        sender: 'ou_member',
        channel_context: context,
      }),
    ).toEqual({ imId: 'ou_member' });
  });
});

describe("a delegated worker's finished turn (settleDelegatedWorkerTurn)", () => {
  function host(
    pending: { queued?: number; stored?: string[] },
    output: Record<string, unknown> = {},
  ) {
    const failDelegatedWorkerRun = vi.fn();
    const globals: Record<string, unknown> = {
      listQueuedFollowUps: () => Array.from({ length: pending.queued ?? 0 }),
      getMessagesSince: (_lane: string, cursor: unknown) => {
        expect(cursor).toEqual({ timestamp: 't', id: 'last' });
        return (pending.stored ?? []).map((id) => ({ id }));
      },
      lastCommittedCursor: { [LANE]: { timestamp: 't', id: 'last' } },
      EMPTY_CURSOR: { timestamp: '', id: '' },
      failDelegatedWorkerRun,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('ipcReceiptMessageIds');
    harness.install('settleDelegatedWorkerTurn');
    (globals.settleDelegatedWorkerTurn as (...args: unknown[]) => void)(
      LANE,
      'worker-1',
      output,
    );
    return failDelegatedWorkerRun;
  }

  test('with nothing left for the lane, the worker ended without a result', () => {
    expect(host({})).toHaveBeenCalledWith('worker-1', null);
  });

  test('a queued input or a batch piped past the cursor is not the end', () => {
    expect(host({ queued: 1 })).not.toHaveBeenCalled();
    expect(host({ stored: ['followup-2'] })).not.toHaveBeenCalled();
  });

  test('the follow-up a warm runner answered this turn counts as answered', () => {
    // Its IPC receipt is acknowledged after this runs: the input is still
    // past the committed cursor.
    const receipts = {
      ipcReceipts: [
        {
          deliveryId: 'd-1',
          chatJid: LANE,
          cursor: { timestamp: 't2', id: 'followup-1' },
          coveredCursors: [
            { timestamp: 't1', id: 'followup-0' },
            { timestamp: 't2', id: 'followup-1' },
          ],
        },
      ],
    };
    expect(
      host({ stored: ['followup-0', 'followup-1'] }, receipts),
    ).toHaveBeenCalledWith('worker-1', null);
    // One piped behind it is not.
    expect(
      host({ stored: ['followup-1', 'followup-2'] }, receipts),
    ).not.toHaveBeenCalled();
  });
});

describe('a stop of the delegating session (breakLane)', () => {
  /** breakLane and what releases the reports it keeps. */
  function host(input: {
    activeRunId: string | null;
    queued: { id: string; chat_jid: string }[];
  }) {
    const released: unknown[][] = [];
    const globals: Record<string, unknown> = {
      crypto: { randomUUID: () => 'uuid-1' },
      cancelQueuedFollowUpsAtCutoff: vi.fn(() => []),
      isDelegatedReportInput: (item: { id: string }) =>
        item.id.startsWith('work-report-'),
      listQueuedFollowUps: () => input.queued,
      releaseQueuedFollowUpBatch: (items: unknown[], runId: string) => {
        released.push([items, runId]);
        return true;
      },
      broadcastFollowUpBatchUpdate: vi.fn(),
      enqueueReleasedFollowUp: vi.fn(),
      moveMessagesToIngestTail: vi.fn(),
      cancelAutomationInputs: vi.fn(),
      broadcastFollowUpUpdate: vi.fn(),
      getChannelType,
      clearStandaloneProcessingIndicator: vi.fn(),
      closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
      channelTurnScopeForInput: vi.fn(),
      endUsageLimitWait: vi.fn(),
      interruptActiveSessionRun: vi.fn(() => ({
        activeRunId: input.activeRunId,
        interrupted: input.activeRunId !== null,
      })),
      queue: { stopArmedRetry: vi.fn(() => false) },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('releaseKeptReports');
    harness.install('requeueKeptReportsAfterReset');
    return { globals, released };
  }
  const report = { id: 'work-report-w1-7', chat_jid: LANE };
  const typed = { id: 'in-9', chat_jid: LANE };

  test('with no query left in the lane, the kept reports run now', () => {
    const { globals, released } = host({
      activeRunId: null,
      queued: [typed, report],
    });
    (globals.breakLane as (...args: unknown[]) => unknown)(LANE, 'stop');
    expect(released).toEqual([[[report], 'recovery:uuid-1']]);
    expect(globals.enqueueReleasedFollowUp).toHaveBeenCalledWith(report);
  });

  test('a query the stop ends dispatches them itself', () => {
    const { globals, released } = host({
      activeRunId: 'run-1',
      queued: [report],
    });
    (globals.breakLane as (...args: unknown[]) => unknown)(LANE, 'stop');
    expect(released).toEqual([]);
  });

  test('after /clear or /fresh they move past the new cursor and run', () => {
    const { globals, released } = host({
      activeRunId: null,
      queued: [typed, report],
    });
    (globals.requeueKeptReportsAfterReset as (lane: string) => void)(LANE);
    expect(globals.moveMessagesToIngestTail).toHaveBeenCalledWith(LANE, [
      report.id,
    ]);
    expect(released).toEqual([[[report], 'recovery:uuid-1']]);
  });

  test('keeps the queued reports of delegated items', () => {
    const keep = () => true;
    const cancelQueuedFollowUpsAtCutoff = vi.fn(() => []);
    const globals: Record<string, unknown> = {
      listQueuedFollowUps: () => [],
      cancelQueuedFollowUpsAtCutoff,
      isDelegatedReportInput: keep,
      cancelAutomationInputs: vi.fn(),
      broadcastFollowUpUpdate: vi.fn(),
      getChannelType,
      clearStandaloneProcessingIndicator: vi.fn(),
      closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
      channelTurnScopeForInput: vi.fn(),
      endUsageLimitWait: vi.fn(),
      interruptActiveSessionRun: vi.fn(() => ({
        activeRunId: null,
        interrupted: false,
      })),
      queue: { stopArmedRetry: vi.fn(() => false) },
      settleCancelledFollowUp: vi.fn(),
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('releaseKeptReports');
    harness.install('cancelQueuedInputsOfLane');
    (globals.breakLane as (...args: unknown[]) => unknown)(LANE, 'stop');
    (globals.cancelQueuedInputsOfLane as (lane: string) => void)(LANE);
    expect(cancelQueuedFollowUpsAtCutoff).toHaveBeenCalledTimes(2);
    for (const call of cancelQueuedFollowUpsAtCutoff.mock
      .calls as unknown[][]) {
      expect(call[0]).toBe(LANE);
      expect(call[2]).toBe(keep);
    }
  });
});
