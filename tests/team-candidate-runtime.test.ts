import { afterEach, describe, expect, test, vi } from 'vitest';
import { planTeamCandidateIntake } from '../src/team-candidate-intake.js';
import {
  candidateInputItem,
  readTeamInput,
  withTeamInputAttachment,
} from '../src/team-gate.js';
import {
  DEFAULT_TEAM_CANDIDATE_INTAKE,
  DEFAULT_TEAM_SETTINGS,
  parseTeamSettings,
} from '../src/work-items.js';
import { TeamSettingsBodySchema } from '../src/schemas.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const LANE = 'web:ws#agent:router';
const CHAT = 'feishu:oc_team';
const settings = {
  ...DEFAULT_TEAM_SETTINGS,
  enabled: true,
  candidateIntake: { ...DEFAULT_TEAM_CANDIDATE_INTAKE, enabled: true },
};
function candidate(content: string, age = 0, id = 'om_1') {
  const header = candidateInputItem({
    triggerMessageId: id,
    strength: 'inferred',
    listed: false,
    addressed: false,
    senderImId: 'ou_member',
    settings,
    threadItems: [],
  });
  header.facts!.receivedAt = Date.now() - age;
  return {
    id,
    chat_jid: LANE,
    source_jid: CHAT,
    content,
    sender: 'ou_member',
    sender_name: '成员',
    timestamp: new Date(Date.now() - age).toISOString(),
    attachments: withTeamInputAttachment(null, header),
  };
}
function host() {
  const wake = vi.fn();
  const withdraw = vi.fn();
  const complete = vi.fn();
  const timers = new Map();
  const globals = {
    readTeamInput,
    planTeamCandidateIntake,
    resolveTeamGroup: vi.fn(() => ({
      workspaceJid: 'web:ws',
      routerAgentId: 'router',
      settings,
    })),
    channelConversationJid: (jid: string) => jid,
    laneJidOf: (jid: string, id: string) => `${jid}#agent:${id}`,
    teamCandidateTimers: timers,
    setTimeout,
    clearTimeout,
    Date,
    shuttingDown: false,
    listQueuedFollowUps: vi.fn(() => []),
    dispatchNextQueuedFollowUp: vi.fn(),
    buildOnAgentMessage: () => wake,
    withdrawQueuedInput: withdraw,
    completeOutOfBandMessages: complete,
    updateMessageAttachments: vi.fn(),
    runImmediateTransaction: (action: () => unknown) => action(),
    withTeamInputAttachment,
    logger: { debug: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('prepareTeamCandidateInputs');
  return {
    ...globals,
    wake,
    withdraw,
    complete,
    prepare: harness.globals.prepareTeamCandidateInputs as (
      lane: string,
      messages: ReturnType<typeof candidate>[],
    ) => unknown,
  };
}
afterEach(() => vi.useRealTimers());

describe('host intake before cold and warm model delivery', () => {
  test('replaces a lane timer and wakes once after the final fragment', async () => {
    vi.useFakeTimers();
    const h = host();
    const first = candidate('刚才那个客户诉求');
    expect(h.prepare(LANE, [first])).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    const second = candidate('谁去跟进一下', 0, 'om_2');
    expect(h.prepare(LANE, [first, second])).toBeNull();
    await vi.advanceTimersByTimeAsync(5999);
    expect(h.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.prepare(LANE, [first, second])).toEqual([first, second]);
    expect(h.complete).not.toHaveBeenCalled();
  });
  test('consumes ordinary chatter without waking a model for that input', () => {
    vi.useFakeTimers();
    const h = host();
    const row = candidate('午饭吃什么', 9000);
    expect(h.prepare(LANE, [row])).toBeNull();
    expect(h.complete).toHaveBeenCalledWith(LANE, [row]);
    expect(h.withdraw).not.toHaveBeenCalled();
  });
  test('queued chatter is withdrawn, never leaked into warm delivery', () => {
    vi.useFakeTimers();
    const h = host();
    const row = { ...candidate('收到', 9000), delivery_status: 'queued' };
    expect(h.prepare(LANE, [row])).toBeNull();
    expect(h.withdraw).toHaveBeenCalledWith(LANE, row.id);
    expect(h.complete).not.toHaveBeenCalled();
  });
  test('another lane cannot inherit a group policy and old inputs do not wait on restart', () => {
    const h = host();
    const row = candidate('请跟进客户诉求', 9000);
    expect(h.prepare('web:other#agent:router', [row])).toEqual([row]);
    expect(h.prepare(LANE, [row])).toEqual([row]);
  });
});

describe('per-group intake configuration', () => {
  test('old groups preserve their exact defaults and enabled options round-trip', () => {
    expect(parseTeamSettings(JSON.stringify(DEFAULT_TEAM_SETTINGS))).toEqual(
      DEFAULT_TEAM_SETTINGS,
    );
    expect(parseTeamSettings(JSON.stringify(settings))).toEqual(settings);
    expect(TeamSettingsBodySchema.safeParse({ settings }).success).toBe(true);
    expect(
      TeamSettingsBodySchema.safeParse({
        settings: {
          ...settings,
          candidateIntake: {
            ...settings.candidateIntake,
            quietMs: 7000,
            maxWaitMs: 3000,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('every runtime delivery path consults intake', () => {
  test('warm queued promotion releases its reservation while a batch is waiting', async () => {
    const queue = {
      reserveNextQuery: vi.fn(() => 'reservation'),
      releaseQueryReservation: vi.fn(),
    };
    const claim = vi.fn();
    const globals = {
      queue,
      withdrawQueuedInputsOutsideAudience: vi.fn(),
      withdrawQueuedInputsOfEndedRuns: vi.fn(),
      listQueuedFollowUps: () => [candidate('跟进')],
      prepareTeamCandidateInputs: vi.fn(() => null),
      claimNextQueuedFollowUpBatch: claim,
    };
    const h = createRuntimeSourceHarness(globals);
    h.install('dispatchNextQueuedFollowUp');
    await (
      h.globals.dispatchNextQueuedFollowUp as (jid: string) => Promise<void>
    )(LANE);
    expect(claim).not.toHaveBeenCalled();
    expect(queue.releaseQueryReservation).toHaveBeenCalledWith(
      LANE,
      'reservation',
    );
  });
  test('the IM wake path does not start a Runner while the intake window is open', () => {
    const queue = { enqueueTask: vi.fn(), sendMessage: vi.fn() };
    const messages = [candidate('跟进')];
    const globals = {
      queue,
      shuttingDown: false,
      registeredGroups: { 'web:ws': { folder: 'ws' } },
      getAgent: () => ({ chat_jid: 'web:ws' }),
      lastAgentTimestamp: {},
      EMPTY_CURSOR: {},
      getMessagesSince: () => messages,
      dropNonReplayableInputs: (_jid: string, rows: unknown[]) => rows,
      prepareTeamCandidateInputs: vi.fn(() => null),
    };
    const h = createRuntimeSourceHarness(globals);
    h.install('buildOnAgentMessage');
    (
      h.globals.buildOnAgentMessage as () => (
        jid: string,
        agentId: string,
      ) => void
    )()('web:ws', 'router');
    expect(queue.enqueueTask).not.toHaveBeenCalled();
    expect(queue.sendMessage).not.toHaveBeenCalled();
    expect(globals.prepareTeamCandidateInputs).toHaveBeenCalledWith(
      LANE,
      messages,
    );
  });
  test('cold restart recovery waits before constructing an Agent query', async () => {
    const messages = [candidate('跟进')];
    const globals = {
      getAgent: () => ({ kind: 'conversation', chat_jid: 'web:ws' }),
      registeredGroups: { 'web:ws': { folder: 'ws' } },
      resolveEffectiveGroup: (group: unknown) => ({ effectiveGroup: group }),
      agentBuilderTurnScope: () => 'scope',
      lastAgentTimestamp: {},
      EMPTY_CURSOR: {},
      getMessagesSinceBounded: () => ({ messages, truncated: false }),
      releaseUsageLimitWaitForNewInput: () => false,
      getUsageLimitWait: () => null,
      dropNonReplayableInputs: (_jid: string, rows: unknown[]) => rows,
      prepareTeamCandidateInputs: vi.fn(() => null),
    };
    const h = createRuntimeSourceHarness(globals);
    h.install('processAgentConversation');
    expect(
      await (
        h.globals.processAgentConversation as (
          jid: string,
          agentId: string,
        ) => Promise<boolean>
      )('web:ws', 'router'),
    ).toBe(true);
    expect(globals.prepareTeamCandidateInputs).toHaveBeenCalledWith(
      LANE,
      messages,
    );
  });
});
