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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-automation-rt-'));

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
const runtime = await import('../src/automation-runtime.js');
const ledger = await import('../src/automation-run-ledger.js');
const { selectChannelReplyBatch, resolveBatchChannelReplySource } =
  await import('../src/channel-reply-source.js');
const { AgentBuilderTurnRegistry, agentBuilderTurnScope } =
  await import('../src/agent-builder-turn-auth.js');
const webContext = await import('../src/web-context.js');
const { executeSessionReset } = await import('../src/commands.js');

import type {
  AutomationRunOutcome,
  AutomationService,
} from '../src/automation-contract.js';
import type { Automation, AutomationRun } from '../src/automation.js';
import type { NewMessage } from '../src/types.js';

const OWNER = 'owner-1';
const WORKSPACE = 'web:auto-ws';
const SESSION_ID = 'auto-session';
/** The session bound automations of this file run in. */
const SESSION = `${WORKSPACE}#agent:${SESSION_ID}`;
const FOLDER = 'auto-ws';
const TOPIC_ROUTE = 'feishu:oc_group#thread:omt_topic#root:om_root';

function automation(overrides: Partial<Automation> = {}): Automation {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    workspaceJid: WORKSPACE,
    workspaceFolder: FOLDER,
    createdBy: OWNER,
    name: '日报',
    prompt: '汇总今天的提交',
    stopWhen: null,
    schedule: { kind: 'manual' },
    endAt: null,
    sessionMode: 'bound',
    targetSessionJid: SESSION,
    deliveryRouteJid: null,
    silentWhenIdle: false,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: null,
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function run(id: string): AutomationRun {
  const now = new Date().toISOString();
  return {
    id,
    automationId: 'auto-1',
    trigger: 'manual',
    status: 'queued',
    sessionJid: SESSION,
    inputMessageId: null,
    scheduledFor: now,
    firedAt: now,
    finishedAt: null,
    resultText: null,
    error: null,
    preCheck: null,
    silenced: false,
    readAt: null,
    createdAt: now,
  };
}

/** A fake core: records what the runtime reports. */
function fakeService(silenced = new Set<string>()) {
  const started: string[] = [];
  const settled: Array<[string, AutomationRunOutcome]> = [];
  const service = {
    runSink: {
      onRunInputStarted: (runId: string) => started.push(runId),
      onRunInputSettled: (runId: string, outcome: AutomationRunOutcome) =>
        settled.push([runId, outcome]),
      isRunSilenced: (runId: string) => silenced.has(runId),
    },
    handleIpc: vi.fn(
      async (_actor: unknown, request: { requestId: string }) => ({
        requestId: request.requestId,
        success: true,
      }),
    ),
    onSessionDeleted: vi.fn(),
  } as unknown as AutomationService;
  return { service, started, settled };
}

function hooks(overrides: Partial<runtime.AutomationRuntimeHooks> = {}) {
  return {
    getGroup: (jid: string) => db.getRegisteredGroup(jid),
    admitInput: vi.fn(() => 'started' as const),
    wake: vi.fn(),
    broadcastNewMessage: vi.fn(),
    routeSessionOf: vi.fn(() => null),
    listSessionImRoutes: vi.fn(() => []),
    isInputPending: vi.fn(() => true),
    cancelInput: vi.fn(async () => {}),
    sendImText: vi.fn(async () => true),
    postSessionMessage: vi.fn(async () => {}),
    broadcastAutomationEvent: vi.fn(),
    ...overrides,
  } satisfies runtime.AutomationRuntimeHooks;
}

let runSeq = 0;
const nextRunId = () => `run-${++runSeq}`;

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Auto WS',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
  });
  db.createAgent({
    id: SESSION_ID,
    group_folder: FOLDER,
    chat_jid: WORKSPACE,
    name: 'Bound session',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  webContext.setWebDeps({
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  ledger.setAutomationRuntimeService(null);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

async function inject(
  deps: ReturnType<typeof runtime.createAutomationRuntimeDeps>,
  runId: string,
  sessionJid = SESSION,
  deliveryRouteJid: string | null = null,
) {
  return deps.injectAutomationInput({
    automation: automation(),
    run: run(runId),
    sessionJid,
    deliveryRouteJid,
    displayContent: '汇总今天的提交',
    contextSuffix: '\n[自动化运行上下文]\n- 本次运行 id: ' + runId,
  });
}

describe('injecting an automation run input', () => {
  test('stores the prompt for display and the run context for replay', async () => {
    const h = hooks();
    const deps = runtime.createAutomationRuntimeDeps(h);
    const runId = nextRunId();
    const { inputMessageId } = await inject(deps, runId, SESSION, TOPIC_ROUTE);

    const [row] = db
      .getMessagesSince(SESSION, { timestamp: '', id: '' })
      .filter((message) => message.id === inputMessageId);
    expect(row).toMatchObject({
      source_kind: 'automation_prompt',
      automation_run_id: runId,
      sender: 'automation',
      sender_name: '日报',
      content: '汇总今天的提交',
      source_jid: TOPIC_ROUTE,
    });
    // The agent sees the stored suffix after the prompt; replay reads the
    // same row, so it sees the same text.
    const [agentView] = runtime.withAutomationRunContext([row]);
    expect(agentView.content).toBe(
      `汇总今天的提交\n\n[自动化运行上下文]\n- 本次运行 id: ${runId}`,
    );
    // Replies follow the input's own route (a Feishu topic here).
    expect(resolveBatchChannelReplySource([row])).toBe(TOPIC_ROUTE);

    // The Web sees the automation, never the hidden context.
    const broadcast = h.broadcastNewMessage.mock.calls[0][1] as NewMessage;
    expect(broadcast.automation).toEqual({
      id: 'auto-1',
      name: '日报',
      runId,
    });
    expect(broadcast.attachments).toBeUndefined();
    expect(JSON.stringify(broadcast)).not.toContain('自动化运行上下文');
    expect(h.wake).toHaveBeenCalledWith(
      expect.objectContaining({ laneJid: SESSION, agentId: SESSION_ID }),
    );
  });

  test('a busy session queues the input and does not wake it', async () => {
    const h = hooks({ admitInput: vi.fn(() => 'queued' as const) });
    const deps = runtime.createAutomationRuntimeDeps(h);
    await inject(deps, nextRunId());
    expect(h.admitInput).toHaveBeenCalledWith(
      expect.objectContaining({ laneJid: SESSION, sourceJid: SESSION }),
    );
    expect(h.wake).not.toHaveBeenCalled();
  });

  test('a Runtime Session input lands in its lane and wakes that session', async () => {
    const h = hooks();
    const deps = runtime.createAutomationRuntimeDeps(h);
    const { sessionJid } = await deps.createAutomationSession({
      automation: automation({ sessionMode: 'fresh' }),
      title: '日报 · 10月30日',
    });
    const agentId = sessionJid.split('#agent:')[1];
    expect(db.getAgent(agentId)).toMatchObject({
      kind: 'conversation',
      source_kind: 'automation',
      automation_id: 'auto-1',
      name: '日报 · 10月30日',
    });
    expect(deps.sessionExists(sessionJid)).toBe(true);

    const runId = nextRunId();
    const { inputMessageId } = await inject(
      deps,
      runId,
      sessionJid,
      TOPIC_ROUTE,
    );
    const rows = db.getMessagesSince(sessionJid, { timestamp: '', id: '' });
    expect(rows.map((message) => message.id)).toEqual([inputMessageId]);
    expect(h.wake).toHaveBeenCalledWith(
      expect.objectContaining({ laneJid: sessionJid, agentId }),
    );
    expect(resolveBatchChannelReplySource(rows)).toBe(TOPIC_ROUTE);

    // Archiving keeps the history and the session addressable.
    await deps.archiveAutomationSession(sessionJid);
    expect(db.getAgent(agentId)?.status).toBe('completed');
    expect(deps.sessionExists(sessionJid)).toBe(true);
  });

  test('a workspace JID is no session: nothing is injected into it', async () => {
    const h = hooks();
    const deps = runtime.createAutomationRuntimeDeps(h);
    expect(runtime.resolveAutomationSession(WORKSPACE, h.getGroup)).toBeNull();
    expect(deps.sessionExists(WORKSPACE)).toBe(false);
    await expect(inject(deps, nextRunId(), WORKSPACE)).rejects.toThrow(
      '自动化的目标会话不存在',
    );
    expect(db.getMessagesSince(WORKSPACE, { timestamp: '', id: '' })).toEqual(
      [],
    );
    expect(h.wake).not.toHaveBeenCalled();
  });

  test('re-injecting a run is idempotent', async () => {
    const deps = runtime.createAutomationRuntimeDeps(hooks());
    const runId = nextRunId();
    const first = await inject(deps, runId);
    const second = await inject(deps, runId);
    expect(second.inputMessageId).toBe(first.inputMessageId);
    expect(
      db
        .getMessagesSince(SESSION, { timestamp: '', id: '' })
        .filter((message) => message.automation_run_id === runId),
    ).toHaveLength(1);
  });
});

describe('an automation input is a turn of its own', () => {
  const user = (id: string): NewMessage => ({
    id,
    chat_jid: SESSION,
    source_jid: SESSION,
    sender: OWNER,
    sender_name: 'Owner',
    content: id,
    timestamp: '2026-10-30T00:00:00.000Z',
  });
  const input = (id: string, runId: string): NewMessage => ({
    ...user(id),
    sender: 'automation',
    source_kind: 'automation_prompt',
    automation_run_id: runId,
  });

  test('never batches with user messages or another run', () => {
    expect(
      selectChannelReplyBatch([user('u1'), user('u2'), input('a1', 'r1')]),
    ).toHaveLength(2);
    expect(
      selectChannelReplyBatch([input('a1', 'r1'), user('u1')]).map(
        (message) => message.id,
      ),
    ).toEqual(['a1']);
    expect(
      selectChannelReplyBatch([input('a1', 'r1'), input('a2', 'r2')]).map(
        (message) => message.id,
      ),
    ).toEqual(['a1']);
  });

  test('waits in the visible queue behind user messages and is claimed alone', async () => {
    const lane = 'web:auto-queue';
    db.ensureChatExists(lane);
    const store = (id: string, meta?: Record<string, unknown>) =>
      db.storeMessageDirect(
        id,
        lane,
        OWNER,
        'Owner',
        id,
        new Date().toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'active-run',
            ...meta,
          },
        },
      );
    store('q-u1');
    store('q-auto', {
      sourceKind: 'automation_prompt',
      automationRunId: 'r-q',
    });
    store('q-u2');
    expect(db.listQueuedFollowUps(lane).map((item) => item.id)).toEqual([
      'q-u1',
      'q-auto',
      'q-u2',
    ]);
    expect(
      db.claimNextQueuedFollowUpBatch(lane, 'next-1').map((item) => item.id),
    ).toEqual(['q-u1']);
    expect(
      db.claimNextQueuedFollowUpBatch(lane, 'next-2').map((item) => item.id),
    ).toEqual(['q-auto']);
    expect(
      db.claimNextQueuedFollowUpBatch(lane, 'next-3').map((item) => item.id),
    ).toEqual(['q-u2']);
  });
});

describe('run lifecycle reports', () => {
  test('each run starts once and settles once, whatever reports it', () => {
    const { service, started, settled } = fakeService();
    ledger.setAutomationRuntimeService(service);
    const tracker = new ledger.AutomationTurnTracker();
    const runId = nextRunId();
    const message = {
      source_kind: 'automation_prompt',
      automation_run_id: runId,
    };
    tracker.remember('turn-1', [message]);
    tracker.remember('turn-1', [message]);
    expect(started).toEqual([runId]);

    tracker.settle('turn-1', { status: 'success', resultText: '完成' });
    tracker.settle('turn-1', { status: 'failed', error: 'late' });
    tracker.settleAll({ status: 'interrupted', error: 'gone' });
    ledger.settleAutomationRun(runId, { status: 'cancelled', reason: 'break' });
    expect(settled).toEqual([
      [runId, { status: 'success', resultText: '完成' }],
    ]);
    expect(tracker.wasSettled('turn-1')).toBe(true);
    expect(ledger.isAutomationRunLive(runId)).toBe(false);
  });

  test('a parked input is forgotten, not settled', () => {
    const { service, settled } = fakeService();
    ledger.setAutomationRuntimeService(service);
    const tracker = new ledger.AutomationTurnTracker();
    const runId = nextRunId();
    tracker.remember('turn-p', [{ automation_run_id: runId }]);
    tracker.forget('turn-p');
    tracker.settleAll({ status: 'interrupted', error: 'gone' });
    expect(settled).toEqual([]);
  });

  test('/break cancels queued automation inputs as break', () => {
    const { service, settled } = fakeService();
    ledger.setAutomationRuntimeService(service);
    const runId = nextRunId();
    ledger.cancelAutomationInputs(
      [{ automation_run_id: runId }, { source_kind: null }],
      'break',
    );
    expect(settled).toEqual([
      [runId, { status: 'cancelled', reason: 'break' }],
    ]);
  });

  test('/clear and /fresh end every run waiting or executing in the lane', async () => {
    const { service, settled } = fakeService();
    ledger.setAutomationRuntimeService(service);
    const deps = runtime.createAutomationRuntimeDeps(hooks());
    const cleared = nextRunId();
    await inject(deps, cleared);

    await executeSessionReset(
      WORKSPACE,
      FOLDER,
      {
        queue: { stopGroup: vi.fn(async () => {}) },
        sessions: {},
        broadcast: vi.fn(),
        setLastAgentTimestamp: vi.fn(),
      },
      SESSION_ID,
    );
    expect(settled).toContainEqual([
      cleared,
      { status: 'cancelled', reason: 'clear' },
    ]);
    // Earlier runs injected into this lane end with it; nothing else does.
    expect(settled.every(([, outcome]) => outcome.status === 'cancelled')).toBe(
      true,
    );

    const fresh = nextRunId();
    await inject(deps, fresh);
    await executeSessionReset(
      WORKSPACE,
      FOLDER,
      {
        queue: { stopGroup: vi.fn(async () => {}) },
        sessions: {},
        broadcast: vi.fn(),
        setLastAgentTimestamp: vi.fn(),
      },
      SESSION_ID,
      { mode: 'fresh' },
    );
    expect(settled.at(-1)).toEqual([
      fresh,
      { status: 'cancelled', reason: 'fresh' },
    ]);
  });

  test('a quiet run holds its IM route until the agent escalates it', () => {
    const silenced = new Set<string>();
    const { service, settled } = fakeService(silenced);
    ledger.setAutomationRuntimeService(service);
    const tracker = new ledger.AutomationTurnTracker();
    const runId = nextRunId();
    silenced.add(runId);
    const inputs = [{ automation_run_id: runId }];
    tracker.remember('turn-q', inputs);
    expect(tracker.holdReplyRoute('turn-q', inputs, TOPIC_ROUTE)).toBeNull();
    // Still quiet at the final answer: nothing goes to IM.
    expect(tracker.takeEscalatedRoute('turn-q')).toBeNull();
    // The agent escalated: the final answer owes the held route, once.
    silenced.delete(runId);
    expect(tracker.takeEscalatedRoute('turn-q')).toBe(TOPIC_ROUTE);
    expect(tracker.takeEscalatedRoute('turn-q')).toBeNull();
    tracker.recordResult('turn-q', '发现 2 个新失败');
    tracker.settleSuccess('turn-q');
    expect(settled).toEqual([
      [runId, { status: 'success', resultText: '发现 2 个新失败' }],
    ]);

    // A Web-only run and ordinary turns are never held.
    silenced.add(runId);
    expect(tracker.holdReplyRoute('turn-w', inputs, null)).toBeNull();
    expect(
      tracker.holdReplyRoute('turn-u', [{ source_kind: null }], TOPIC_ROUTE),
    ).toBe(TOPIC_ROUTE);
  });

  test('the reply card of an automation turn carries the automation name', () => {
    const tracker = new ledger.AutomationTurnTracker();
    const runId = nextRunId();
    tracker.remember('delivery-7', [
      {
        id: `automation-run-${runId}`,
        source_kind: 'automation_prompt',
        automation_run_id: runId,
        attachments: JSON.stringify([
          {
            type: 'automation_run_context',
            automationId: 'auto-1',
            automationName: '日报',
            runId,
            text: '',
          },
        ]),
      },
    ]);
    expect(ledger.automationCardTitle('delivery-7')).toBe('日报');
    expect(ledger.automationCardTitle(`automation-run-${runId}`)).toBe('日报');
    expect(ledger.automationCardTitle('other-input')).toBeUndefined();
  });
});

describe('who is calling an automation tool', () => {
  const TOPIC_SESSION = `${WORKSPACE}#agent:topic-session`;
  const owner = {
    content: '每天早上提醒我看报表',
    sender: `feishu:ou_owner`,
    source_jid: TOPIC_ROUTE,
    is_from_me: 0,
    source_kind: null,
    automation_run_id: null,
  };
  const member = { ...owner, sender: 'feishu:ou_member' };

  function derive(
    inputs: Record<string, Record<string, unknown>>,
    isOwnerTurn: boolean,
    automationRunId: string | null = null,
  ) {
    const registry = new AgentBuilderTurnRegistry();
    const scope = agentBuilderTurnScope(FOLDER, 'topic-session');
    registry.startBatch(
      scope,
      Object.keys(inputs).map((messageId) => ({
        chatJid: TOPIC_SESSION,
        messageId,
        runtimeTurnId: 'delivery-1',
        automationRunId,
      })),
    );
    return runtime.deriveAutomationActor({
      workspaceJid: WORKSPACE,
      sessionJid: TOPIC_SESSION,
      owner: { id: OWNER, role: 'member', status: 'active' },
      turns: registry.activeBatch(scope),
      loadInput: (_jid, id) => (inputs[id] as never) ?? null,
      isOwnerTurn: () => isOwnerTurn,
    });
  }

  test('the owner in a Feishu topic session creates automations bound to that topic', () => {
    expect(derive({ m1: owner }, true)).toEqual({
      kind: 'owner_turn',
      userId: OWNER,
      isAdmin: false,
      workspaceJid: WORKSPACE,
      sessionJid: TOPIC_SESSION,
      sourceRouteJid: TOPIC_ROUTE,
    });
  });

  test('a group member turn may only list', () => {
    expect(derive({ m1: member }, false)).toEqual({
      kind: 'other_turn',
      workspaceJid: WORKSPACE,
      sessionJid: TOPIC_SESSION,
    });
  });

  test('an automation run acts only as its own automation', () => {
    const runInput = {
      ...owner,
      sender: 'automation',
      source_kind: 'automation_prompt',
      automation_run_id: 'run-x',
      attachments: JSON.stringify([
        {
          type: 'automation_run_context',
          automationId: 'auto-9',
          automationName: '巡检',
          runId: 'run-x',
          text: '',
        },
      ]),
    };
    expect(derive({ a1: runInput }, true)).toEqual({
      kind: 'automation_run',
      workspaceJid: WORKSPACE,
      sessionJid: TOPIC_SESSION,
      automationId: 'auto-9',
      runId: 'run-x',
    });
    // A run never shares its turn; a mixed batch cannot act as either.
    expect(derive({ a1: runInput, m1: owner }, true).kind).toBe('other_turn');
  });

  test('old task tools are refused with a pointer to the automation tools', async () => {
    expect(runtime.isLegacyTaskIpcType('schedule_task')).toBe(true);
    expect(runtime.isLegacyTaskIpcType('automation_create')).toBe(false);
    expect(runtime.isAutomationIpcType('automation_create')).toBe(true);
    expect(runtime.LEGACY_TASK_IPC_ERROR).toContain('automation_create');

    const { service } = fakeService();
    ledger.setAutomationRuntimeService(service);
    const actor = {
      kind: 'other_turn',
      workspaceJid: WORKSPACE,
      sessionJid: SESSION,
    } as const;
    await expect(
      runtime.handleAutomationIpc(
        { type: 'automation_list', requestId: 'r1', timestamp: '' },
        () => actor,
      ),
    ).resolves.toEqual({ requestId: 'r1', success: true });
    expect(service.handleIpc).toHaveBeenCalledWith(actor, expect.anything());
  });
});
