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
  function host(pending: { queued?: number; stored?: number }) {
    const failDelegatedWorkerRun = vi.fn();
    const globals: Record<string, unknown> = {
      listQueuedFollowUps: () => Array.from({ length: pending.queued ?? 0 }),
      getMessagesSince: (_lane: string, cursor: unknown) => {
        expect(cursor).toEqual({ timestamp: 't', id: 'last' });
        return Array.from({ length: pending.stored ?? 0 });
      },
      lastCommittedCursor: { [LANE]: { timestamp: 't', id: 'last' } },
      EMPTY_CURSOR: { timestamp: '', id: '' },
      failDelegatedWorkerRun,
    };
    createRuntimeSourceHarness(globals).install('settleDelegatedWorkerTurn');
    (globals.settleDelegatedWorkerTurn as (...args: unknown[]) => void)(
      LANE,
      'worker-1',
    );
    return failDelegatedWorkerRun;
  }

  test('with nothing left for the lane, the worker ended without a result', () => {
    expect(host({})).toHaveBeenCalledWith('worker-1', null);
  });

  test('a queued input or a batch piped past the cursor is not the end', () => {
    expect(host({ queued: 1 })).not.toHaveBeenCalled();
    expect(host({ stored: 1 })).not.toHaveBeenCalled();
  });
});

describe('a stop of the delegating session (breakLane)', () => {
  test('keeps the queued reports of delegated items', () => {
    const keep = () => true;
    const cancelQueuedFollowUpsAtCutoff = vi.fn(() => []);
    const globals: Record<string, unknown> = {
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
