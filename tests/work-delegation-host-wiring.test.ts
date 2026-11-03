import { describe, expect, test } from 'vitest';

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

/** index.ts's ownerTurnInputOf over a real turn registry. */
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
  harness.install('ownerTurnInputOf');
  const scope = agentBuilderTurnScope(FOLDER, 'main-1');
  const batch = (ids: string[], runtimeTurnId: string) =>
    ids.map((messageId) => ({
      chatJid: LANE,
      messageId,
      runtimeTurnId,
      automationRunId: null,
    }));
  const ownerTurnInputOf = (inputTurnId: string | null, owner = OWNER) =>
    (
      globals.ownerTurnInputOf as (
        ...args: unknown[]
      ) => { chatJid: string; messageId: string } | null
    )(FOLDER, owner ? { created_by: owner } : undefined, 'main-1', inputTurnId);
  return { registry, scope, batch, ownerTurnInputOf };
}

describe('the input a delegating turn answers (ownerTurnInputOf)', () => {
  test("the owner's own turn: the last input of the batch inputTurnId names", () => {
    const { registry, scope, batch, ownerTurnInputOf } = host({
      a: webInput(OWNER),
      b: webInput(OWNER),
      c: webInput(OWNER),
    });
    registry.startBatch(scope, batch(['a', 'b'], 'turn-1'));
    registry.enqueueBatch(scope, batch(['c'], 'turn-2'));
    expect(ownerTurnInputOf('turn-1')).toEqual({
      chatJid: LANE,
      messageId: 'b',
    });
    // A batch already piped to the runner answers for itself.
    expect(ownerTurnInputOf('turn-2')).toEqual({
      chatJid: LANE,
      messageId: 'c',
    });
    // No inputTurnId: the batch executing now.
    expect(ownerTurnInputOf(null)).toEqual({ chatJid: LANE, messageId: 'b' });
    // A request that outlived its turn names no delivered batch.
    expect(ownerTurnInputOf('turn-gone')).toBeNull();
    // A workspace without an owner has no owner turn.
    expect(ownerTurnInputOf('turn-1', '')).toBeNull();
  });

  test('any input not typed by the owner refuses, as for install_skill', () => {
    for (const other of [
      webInput('someone-else'),
      webInput(OWNER, { source_kind: 'work_item_input' }),
      webInput(OWNER, { source_kind: 'automation_prompt' }),
      webInput(OWNER, { is_from_me: 1 }),
    ]) {
      const { registry, scope, batch, ownerTurnInputOf } = host({
        a: webInput(OWNER),
        b: other,
      });
      registry.startBatch(scope, batch(['a', 'b'], 'turn-1'));
      expect(ownerTurnInputOf('turn-1')).toBeNull();
    }
    // Queued behind the turn counts too, as for install_skill.
    const { registry, scope, batch, ownerTurnInputOf } = host({
      a: webInput(OWNER),
      b: webInput('someone-else'),
    });
    registry.startBatch(scope, batch(['a'], 'turn-1'));
    registry.enqueueBatch(scope, batch(['b'], 'turn-2'));
    expect(ownerTurnInputOf('turn-1')).toBeNull();
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
