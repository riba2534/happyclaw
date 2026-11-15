/**
 * An automation's model choice: checked like a pick in the chat when it is
 * saved (create, update; never from the agent tools), and given to the run
 * sessions the automation creates. A fresh session starts on it; a persistent
 * session is brought back to it before each run; a bound session, or an
 * automation without a choice, leaves the session's own choice alone.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-model-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

const mocks = vi.hoisted(() => ({
  drainCalls: [] as Array<{ jids: string[]; target: string | null }>,
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  TIMEZONE: 'Asia/Shanghai',
  isDockerAvailable: () => false,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getProviders: () => [
    {
      id: 'official',
      name: 'Claude 官方',
      type: 'official',
      enabled: true,
      anthropicModel: 'opus',
      anthropicApiKey: 'sk-ant-key',
      codexOAuthCredentials: null,
    },
    {
      id: 'glm',
      name: 'GLM',
      type: 'third_party',
      enabled: true,
      anthropicBaseUrl: 'https://glm.example.test',
      anthropicModel: 'glm-5.3',
      anthropicAuthToken: 'glm-token',
      models: [
        { id: 'glm-5.3', contextWindow: 1_000_000, efforts: ['low', 'high'] },
        { id: 'glm-5.3-air', efforts: ['low'] },
      ],
      codexOAuthCredentials: null,
    },
  ],
}));

const db = await import('../src/db.js');
const store = await import('../src/automation-store.js');
const { createAutomationCore } = await import('../src/automation-service.js');
const { AutomationError } = await import('../src/automation-contract.js');
const runtime = await import('../src/automation-runtime.js');
const webContext = await import('../src/web-context.js');
const harness = await import('./automation-harness.js');

import type { AutomationActor } from '../src/automation-contract.js';
import type {
  Automation,
  AutomationModelChoice,
  AutomationRun,
} from '../src/automation.js';
import type { AutomationEngine } from '../src/automation-scheduler.js';

const OWNER = 'model-owner';
const WS = 'web:model-ws';
const FOLDER = 'model-ws';
const HOST_WS = 'web:model-host';
const BOUND_ID = 'model-bound';
const BOUND = `${WS}#agent:${BOUND_ID}`;

const owner: AutomationActor = { kind: 'web', userId: OWNER, isAdmin: false };
const ownerAdmin: AutomationActor = {
  kind: 'web',
  userId: OWNER,
  isAdmin: true,
};
const ownerTurn: AutomationActor = {
  kind: 'owner_turn',
  userId: OWNER,
  isAdmin: false,
  workspaceJid: WS,
  sessionJid: BOUND,
  sourceRouteJid: null,
};

const GLM: AutomationModelChoice = {
  modelConfigId: 'glm',
  model: 'glm-5.3',
  effort: 'high',
};

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  const at = new Date().toISOString();
  db.createUser({
    id: OWNER,
    username: OWNER,
    password_hash: 'test-only',
    display_name: OWNER,
    role: 'member',
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
  harness.seedWorkspace(db, { jid: WS, owner: OWNER });
  harness.seedWorkspace(db, { jid: HOST_WS, owner: OWNER, host: true });
  db.createAgent({
    id: BOUND_ID,
    group_folder: FOLDER,
    chat_jid: WS,
    name: 'Bound session',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: at,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as never);
  webContext.setWebDeps({
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: {
      stopGroup: vi.fn(async () => {}),
      drainRunnersForModelSelection: (
        jids: string[],
        target: string | null,
      ) => {
        mocks.drainCalls.push({ jids: [...jids], target });
        return 1;
      },
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  store.deleteAutomations(store.listAutomations({}).map((a) => a.id));
  db.setSessionModelSelection(FOLDER, BOUND_ID, null);
  mocks.drainCalls.length = 0;
});

function core() {
  const clock = new harness.FakeClock(Date.parse('2026-10-30T00:00:00Z'));
  const fake = harness.createFakeRuntime({
    allowsHostCommands: (jid) => jid === HOST_WS,
  });
  fake.sessions.add(BOUND);
  return createAutomationCore(fake.deps, { now: clock.now }).service;
}

function refusal(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationError);
    const { status, message, code } = error as InstanceType<
      typeof AutomationError
    >;
    return { status, message, code };
  }
  throw new Error('expected an AutomationError');
}

describe('saving an automation model', () => {
  test('a valid choice is stored checked and shows in list and detail', () => {
    const service = core();
    const made = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'persistent' }),
      model: { modelConfigId: 'glm', model: ' glm-5.3[1m] ', effort: ' high ' },
    });
    expect(made.model).toEqual(GLM);
    expect(service.get(owner, made.id).model).toEqual(GLM);
    expect(service.list(owner).find((a) => a.id === made.id)?.model).toEqual(
      GLM,
    );
    expect(store.getAutomation(made.id)?.model).toEqual(GLM);

    // A connection alone is a choice too: its own model, the default effort.
    const plain = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft(),
      model: { modelConfigId: 'official' },
    });
    expect(plain.model).toEqual({
      modelConfigId: 'official',
      model: null,
      effort: null,
    });
    // Guests see no model choice, as anywhere else.
    expect(
      service.get({ kind: 'viewer', workspaceJids: [WS] }, made.id).model,
    ).toBeNull();
  });

  test('a bound session or a script takes no model', () => {
    const service = core();
    expect(
      refusal(() =>
        service.create(owner, {
          workspaceJid: WS,
          ...harness.draft({ sessionMode: 'bound' }),
          targetSessionJid: BOUND,
          model: GLM,
        }),
      ),
    ).toEqual({
      status: 400,
      message: '绑定已有会话的自动化沿用该会话自己的模型，不能另选模型',
      code: 'automation_model_bound_session',
    });
    expect(
      refusal(() =>
        service.create(ownerAdmin, {
          workspaceJid: HOST_WS,
          ...harness.draft({
            sessionMode: 'persistent',
            execution: 'script',
            prompt: '',
            scriptCommand: 'echo hi',
          }),
          model: GLM,
        }),
      ),
    ).toEqual({
      status: 400,
      message: '脚本不调用模型，不能选择模型',
      code: 'automation_model_script',
    });
    expect(store.listAutomations({})).toEqual([]);
  });

  test("a choice the connection does not back is refused with the service's code", () => {
    const service = core();
    const create = (model: Record<string, unknown>) =>
      refusal(() =>
        service.create(owner, {
          workspaceJid: WS,
          ...harness.draft(),
          model: model as never,
        }),
      );
    expect(create({ modelConfigId: 'glm', model: 'glm-9' })).toMatchObject({
      status: 400,
      code: 'MODEL_NOT_IN_CONNECTION',
    });
    // A missing connection is a bad field here, not a hidden resource.
    expect(create({ modelConfigId: 'gone' })).toEqual({
      status: 400,
      message: '模型配置不存在',
      code: 'MODEL_CONFIG_NOT_FOUND',
    });
    expect(
      create({ modelConfigId: 'glm', model: 'glm-5.3-air', effort: 'high' }),
    ).toMatchObject({ status: 400, code: 'EFFORT_NOT_SUPPORTED' });
    expect(create({ modelConfigId: '', model: 'glm-5.3' })).toMatchObject({
      status: 400,
      code: 'MODEL_CONFIG_REQUIRED',
    });
    expect(store.listAutomations({})).toEqual([]);
  });

  test('PATCH: omitted keeps, null clears, an object is checked and set', () => {
    const service = core();
    const made = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'fresh' }),
      model: GLM,
    });
    const renamed = service.update(owner, made.id, made.revision, {
      name: '周报',
    });
    expect(renamed.model).toEqual(GLM);

    const bad = refusal(() =>
      service.update(owner, made.id, renamed.revision, {
        model: { modelConfigId: 'glm', model: 'glm-9' },
      }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'MODEL_NOT_IN_CONNECTION' });
    expect(store.getAutomation(made.id)).toMatchObject({
      model: GLM,
      revision: renamed.revision,
    });

    // A model change is an edit like any other.
    const switched = service.update(owner, made.id, renamed.revision, {
      model: { modelConfigId: 'glm', model: 'glm-5.3-air', effort: 'low' },
    });
    expect(switched.model).toEqual({
      modelConfigId: 'glm',
      model: 'glm-5.3-air',
      effort: 'low',
    });
    expect(switched.revision).toBe(renamed.revision + 1);

    const cleared = service.update(owner, made.id, switched.revision, {
      model: null,
    });
    expect(cleared.model).toBeNull();
    expect(store.getAutomation(made.id)?.model).toBeNull();
  });

  test('moving to a bound session needs the choice cleared', () => {
    const service = core();
    const made = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'persistent' }),
      model: GLM,
    });
    expect(
      refusal(() =>
        service.update(owner, made.id, made.revision, {
          sessionMode: 'bound',
          targetSessionJid: BOUND,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'automation_model_bound_session' });
    expect(store.getAutomation(made.id)?.sessionMode).toBe('persistent');
    const bound = service.update(owner, made.id, made.revision, {
      sessionMode: 'bound',
      targetSessionJid: BOUND,
      model: null,
    });
    expect(bound).toMatchObject({ sessionMode: 'bound', model: null });
  });

  test('the agent tools never change the model', async () => {
    const service = core();
    const made = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'persistent' }),
      model: GLM,
    });
    const result = await service.handleIpc(ownerTurn, {
      type: 'automation_update',
      requestId: 'r1',
      id: made.id,
      expectedRevision: made.revision,
      // A stray field a Runner might send: neither a clear nor a new pick.
      patch: { name: '周报', model: null } as never,
      timestamp: new Date().toISOString(),
    });
    expect(result).toMatchObject({ success: true });
    expect(store.getAutomation(made.id)).toMatchObject({
      name: '周报',
      model: GLM,
    });
  });
});

// ─── Run sessions ──────────────────────────────────────────────────────

function automation(overrides: Partial<Automation> = {}): Automation {
  const now = new Date().toISOString();
  return {
    id: 'model-auto',
    workspaceJid: WS,
    workspaceFolder: FOLDER,
    createdBy: OWNER,
    name: '日报',
    prompt: '汇总今天的提交',
    stopWhen: null,
    schedule: { kind: 'manual' },
    endAt: null,
    sessionMode: 'persistent',
    targetSessionJid: null,
    model: GLM,
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

function run(id: string, sessionJid: string): AutomationRun {
  const now = new Date().toISOString();
  return {
    id,
    automationId: 'model-auto',
    trigger: 'manual',
    status: 'queued',
    sessionJid,
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

function hooks() {
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
  } satisfies runtime.AutomationRuntimeHooks;
}

const agentIdOf = (sessionJid: string) => sessionJid.split('#agent:')[1];
const selectionOf = (sessionJid: string) =>
  db.getSessionModelSelectionDetail(FOLDER, agentIdOf(sessionJid));

let runSeq = 0;
async function inject(
  deps: ReturnType<typeof runtime.createAutomationRuntimeDeps>,
  subject: Automation,
  sessionJid: string,
) {
  return deps.injectAutomationInput({
    automation: subject,
    run: run(`model-run-${++runSeq}`, sessionJid),
    sessionJid,
    deliveryRouteJid: null,
    displayContent: subject.prompt,
    contextSuffix: '',
  });
}

describe('the run sessions of an automation', () => {
  test('a new run session starts on the automation model', async () => {
    const deps = runtime.createAutomationRuntimeDeps(hooks());
    for (const sessionMode of ['fresh', 'persistent'] as const) {
      const { sessionJid } = await deps.createAutomationSession({
        automation: automation({ sessionMode }),
        title: '日报',
      });
      expect(selectionOf(sessionJid)).toEqual({ ...GLM, updatedBy: OWNER });
    }
    // Nothing ran in them yet: no runner to retire.
    expect(mocks.drainCalls).toEqual([]);

    const { sessionJid: unchosen } = await deps.createAutomationSession({
      automation: automation({ sessionMode: 'fresh', model: null }),
      title: '日报',
    });
    expect(selectionOf(unchosen)).toBeNull();
  });

  test('a persistent session is brought back to the automation model before a run', async () => {
    const deps = runtime.createAutomationRuntimeDeps(hooks());
    const { sessionJid } = await deps.createAutomationSession({
      automation: automation({ model: null }),
      title: '日报',
    });
    // The user picked another model in the chat meanwhile.
    db.setSessionModelSelection(
      FOLDER,
      agentIdOf(sessionJid),
      'official',
      'bob',
    );

    await inject(deps, automation(), sessionJid);
    expect(selectionOf(sessionJid)).toEqual({ ...GLM, updatedBy: OWNER });
    expect(mocks.drainCalls).toEqual([{ jids: [sessionJid], target: null }]);

    // Already on it: the record and the runner are left alone.
    db.setSessionModelSelection(FOLDER, agentIdOf(sessionJid), 'glm', 'bob', {
      model: 'glm-5.3',
      effort: 'high',
    });
    mocks.drainCalls.length = 0;
    await inject(deps, automation(), sessionJid);
    expect(selectionOf(sessionJid)).toEqual({ ...GLM, updatedBy: 'bob' });
    expect(mocks.drainCalls).toEqual([]);
  });

  test('without a model, or in a bound session, the session keeps its own choice', async () => {
    const deps = runtime.createAutomationRuntimeDeps(hooks());
    const { sessionJid } = await deps.createAutomationSession({
      automation: automation({ model: null }),
      title: '日报',
    });
    const own = { modelConfigId: 'official', model: null, effort: null };
    db.setSessionModelSelection(
      FOLDER,
      agentIdOf(sessionJid),
      'official',
      'bob',
    );
    await inject(deps, automation({ model: null }), sessionJid);
    expect(selectionOf(sessionJid)).toEqual({ ...own, updatedBy: 'bob' });

    db.setSessionModelSelection(FOLDER, BOUND_ID, 'official', 'bob');
    await inject(
      deps,
      automation({ sessionMode: 'bound', targetSessionJid: BOUND }),
      BOUND,
    );
    expect(selectionOf(BOUND)).toEqual({ ...own, updatedBy: 'bob' });
    expect(mocks.drainCalls).toEqual([]);
  });

  test('every run, scheduled or not, goes through the sync', async () => {
    const h = hooks();
    const clock = new harness.FakeClock(Date.parse('2026-10-30T00:00:00Z'));
    const { service, scheduler } = createAutomationCore(
      runtime.createAutomationRuntimeDeps(h),
      { now: clock.now },
    );
    const engine = scheduler as AutomationEngine;
    const made = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({
        sessionMode: 'persistent',
        schedule: { kind: 'manual' },
      }),
      model: GLM,
    });

    const first = await service.runNow(owner, made.id);
    await engine.idle();
    const sessionJid = store.getAutomation(made.id)!.targetSessionJid!;
    expect(sessionJid).toMatch(`${WS}#agent:`);
    expect(selectionOf(sessionJid)).toEqual({ ...GLM, updatedBy: OWNER });
    expect(mocks.drainCalls).toEqual([]);
    service.runSink.onRunInputSettled(first.id, {
      status: 'success',
      resultText: null,
    });

    db.setSessionModelSelection(
      FOLDER,
      agentIdOf(sessionJid),
      'official',
      'bob',
    );
    await service.runNow(owner, made.id);
    await engine.idle();
    expect(store.getAutomation(made.id)!.targetSessionJid).toBe(sessionJid);
    expect(selectionOf(sessionJid)).toEqual({ ...GLM, updatedBy: OWNER });
    expect(mocks.drainCalls).toEqual([{ jids: [sessionJid], target: null }]);
    await scheduler.stop();
  });
});
