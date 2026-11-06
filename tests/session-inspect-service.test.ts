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
  path.join(os.tmpdir(), 'happyclaw-session-inspect-'),
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
const store = await import('../src/work-item-store.js');
const waits = await import('../src/runtime-state-store.js');
const service = await import('../src/session-inspect-service.js');
const workService = await import('../src/work-item-service.js');

import type { SessionInspectDeps } from '../src/session-inspect-service.js';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

const HOME = { jid: 'web:home-1', folder: 'home-1' };
const PROJ = { jid: 'web:proj', folder: 'proj' };
const THEIRS = { jid: 'web:theirs', folder: 'theirs' };

const HOME_SELF = 'aaaaaaaa-0000-4000-8000-000000000001';
const HOME_BUILD = 'bbbbbbbb-0000-4000-8000-000000000002';
const PROJ_ONE = 'cccccccc-0000-4000-8000-000000000003';
const PROJ_TWO = 'dddddddd-0000-4000-8000-000000000004';
const THEIR_ONE = 'eeeeeeee-0000-4000-8000-000000000005';
const WORKER = 'ffffffff-0000-4000-8000-000000000006';
const ROUTER = '99999999-0000-4000-8000-000000000007';

const lane = (workspaceJid: string, id: string) =>
  `${workspaceJid}#agent:${id}`;

type Lane = ReturnType<SessionInspectDeps['queueStatus']>['groups'][number];
let lanes: Lane[] = [];
let waiting: string[] = [];
const deps: SessionInspectDeps = {
  queueStatus: () => ({ groups: lanes, waitingGroupJids: waiting }),
  liveActivity: (laneJid) =>
    laneJid === lane(HOME.jid, HOME_BUILD)
      ? {
          activeTools: [
            { name: 'Bash', elapsedSeconds: 12, summary: 'npm test' },
          ],
          activeSubagents: [{ title: 'review', status: 'running', type: 'x' }],
          compacting: false,
          latestProgress: { at: 1_700_000_000_000, text: '跑测试中' },
          updatedAt: 1_700_000_000_000,
        }
      : null,
  now: () => 1_700_000_060_000,
};

function caller(agentId: string, folder: string, ownerTurn = true) {
  return { folder, agentId, ownerTurn: () => ownerTurn };
}
const homeCaller = (ownerTurn = true) =>
  caller(HOME_SELF, HOME.folder, ownerTurn);
const projCaller = (ownerTurn = true) =>
  caller(PROJ_ONE, PROJ.folder, ownerTurn);

function call(
  who: ReturnType<typeof caller>,
  type: 'session_list' | 'session_get',
  args: Record<string, unknown> = {},
) {
  return service.handleSessionInspectIpc(deps, who, { type, ...args });
}

function data(result: ReturnType<typeof call>): any {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.data;
}

function error(result: ReturnType<typeof call>): string {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

function createSession(
  id: string,
  workspace: { jid: string; folder: string },
  name: string,
  extra: Record<string, unknown> = {},
) {
  db.createAgent({
    id,
    group_folder: workspace.folder,
    chat_jid: workspace.jid,
    name,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    ...extra,
  } as never);
}

function say(
  workspaceJid: string,
  agentId: string,
  id: string,
  content: string,
  fromMe: boolean,
  extra: { turnId?: string } = {},
) {
  db.ensureChatExists(lane(workspaceJid, agentId));
  db.storeMessageDirect(
    id,
    lane(workspaceJid, agentId),
    fromMe ? 'happyclaw-agent' : 'user',
    fromMe ? 'HappyClaw' : '主人',
    content,
    new Date().toISOString(),
    fromMe,
    extra.turnId
      ? ({ meta: { turnId: extra.turnId, sourceKind: 'sdk_final' } } as never)
      : undefined,
  );
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of [OWNER, STRANGER]) {
    db.createUser({
      id,
      username: id,
      password_hash: 'hash',
      display_name: id,
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    } as never);
  }
  const group = (
    workspace: { jid: string; folder: string },
    name: string,
    owner: string,
    isHome: boolean,
  ) =>
    db.setRegisteredGroup(workspace.jid, {
      name,
      folder: workspace.folder,
      added_at: now,
      executionMode: 'container',
      created_by: owner,
      is_home: isHome,
    } as never);
  group(HOME, 'Home', OWNER, true);
  group(PROJ, 'Project', OWNER, false);
  group(THEIRS, 'Theirs', STRANGER, true);

  createSession(HOME_SELF, HOME, 'main chat');
  createSession(HOME_BUILD, HOME, 'build');
  createSession(PROJ_ONE, PROJ, 'one');
  createSession(PROJ_TWO, PROJ, 'two');
  createSession(THEIR_ONE, THEIRS, 'secret plans');
  createSession(WORKER, PROJ, 'worker', { source_kind: 'work_item' });
  createSession(ROUTER, PROJ, 'router', { source_kind: 'team_router' });
});

beforeEach(() => {
  lanes = [];
  waiting = [];
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('who the caller is', () => {
  test('the caller comes from the IPC namespace, never the request body', () => {
    const result = data(
      call(projCaller(), 'session_get', {
        session: 'self',
        agentId: HOME_SELF,
        folder: HOME.folder,
        message_limit: 0,
      }),
    );
    expect(result.session).toMatchObject({ id: 'cccccccc', is_self: true });
    expect(result.session.workspace.folder).toBe(PROJ.folder);
  });

  test('team routers and workers (delegated ones too) cannot inspect', () => {
    for (const id of [WORKER, ROUTER]) {
      expect(error(call(caller(id, PROJ.folder), 'session_list'))).toMatch(
        /^unavailable/,
      );
    }
  });

  test('an IPC namespace that is not a session of its folder is refused', () => {
    expect(error(call(caller(PROJ_ONE, HOME.folder), 'session_list'))).toMatch(
      /^unavailable/,
    );
    expect(error(call(caller('nobody', PROJ.folder), 'session_list'))).toMatch(
      /^unavailable/,
    );
  });
});

describe('the team lane', () => {
  test('the host refuses both tools from a team session', () => {
    for (const type of service.SESSION_INSPECT_IPC_TYPES) {
      expect(workService.teamIpcRefusal(type, undefined)).toMatch(/Team-mode/);
    }
    expect(workService.teamIpcRefusal('work_list', undefined)).toBeNull();
  });
});

describe('what a workspace can see', () => {
  test('a non-Home workspace sees only itself, however it asks', () => {
    const own = data(call(projCaller(), 'session_list'));
    expect(own.workspaces).toHaveLength(1);
    expect(own.workspaces[0].workspace.folder).toBe(PROJ.folder);
    const names = own.workspaces[0].sessions.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(['one', 'two']));
    expect(names).not.toContain('main chat');

    expect(
      error(call(projCaller(), 'session_list', { all_workspaces: true })),
    ).toMatch(/^not_found/);
    expect(
      error(call(projCaller(), 'session_list', { workspace: 'Home' })),
    ).toMatch(/^not_found/);
    expect(
      error(call(projCaller(), 'session_get', { session: 'Home/build' })),
    ).toMatch(/^not_found/);
    expect(
      error(call(projCaller(), 'session_get', { session: 'bbbbbbbb' })),
    ).toMatch(/^not_found/);
    // Naming its own workspace is fine.
    expect(
      data(call(projCaller(), 'session_list', { workspace: 'proj' }))
        .workspaces,
    ).toHaveLength(1);
  });

  test("Home sees all of its owner's workspaces and never another user's", () => {
    const all = data(
      call(homeCaller(), 'session_list', { all_workspaces: true }),
    );
    expect(all.workspaces.map((w: any) => w.workspace.folder)).toEqual([
      HOME.folder,
      PROJ.folder,
    ]);
    expect(JSON.stringify(all)).not.toContain('secret plans');

    const missing = error(
      call(homeCaller(), 'session_list', { workspace: 'no-such-workspace' }),
    );
    const theirs = error(
      call(homeCaller(), 'session_list', { workspace: 'theirs' }),
    );
    const theirsByName = error(
      call(homeCaller(), 'session_list', { workspace: 'Theirs' }),
    );
    // A workspace of someone else answers exactly like one that is not there.
    expect(theirs).toBe(missing);
    expect(theirsByName).toBe(missing);
    expect(missing).toMatch(/^not_found/);
    expect(
      error(
        call(homeCaller(), 'session_get', { session: 'theirs/secret plans' }),
      ),
    ).toBe(missing);
    expect(
      error(call(homeCaller(), 'session_get', { session: 'eeeeeeee' })),
    ).toBe(missing);
  });

  test('a bare session id never searches other workspaces', () => {
    expect(
      error(call(homeCaller(), 'session_get', { session: 'cccccccc' })),
    ).toMatch(/^not_found/);
    const addressed = data(
      call(homeCaller(), 'session_get', {
        session: 'proj/cccccccc',
        message_limit: 0,
      }),
    );
    expect(addressed.session).toMatchObject({ id: 'cccccccc', name: 'one' });
    expect(
      data(
        call(homeCaller(), 'session_get', {
          session: 'Project/two',
          message_limit: 0,
        }),
      ).session.id,
    ).toBe('dddddddd');
  });

  test('a session in another workspace of the owner is read with its own messages', () => {
    say(PROJ.jid, PROJ_TWO, 'm1', '请看一下 CI', false);
    say(PROJ.jid, PROJ_TWO, 'm2', '已修复', true);
    const result = data(
      call(homeCaller(), 'session_get', { session: 'proj/two' }),
    );
    expect(result.messages.map((m: any) => m.text)).toEqual([
      '请看一下 CI',
      '已修复',
    ]);
    expect(result.messages[0]).toMatchObject({ role: 'user', sender: '主人' });
    expect(result.messages[1]).toMatchObject({ role: 'agent' });
  });
});

describe('a turn the owner did not start', () => {
  test('is clamped to status fields of its own workspace', () => {
    say(HOME.jid, HOME_BUILD, 'h1', '内部讨论：密钥在这里', false);
    const list = data(call(homeCaller(false), 'session_list'));
    expect(list.clamped).toBeTruthy();
    const sessions = list.workspaces[0].sessions;
    expect(sessions.map((s: any) => s.name)).toContain('build');
    for (const session of sessions) {
      expect(session.latest_message).toBeUndefined();
    }
    expect(JSON.stringify(list)).not.toContain('密钥');

    const other = data(
      call(homeCaller(false), 'session_get', { session: 'build' }),
    );
    expect(other.clamped).toBeTruthy();
    expect(other.messages).toBeUndefined();
    expect(other.traces).toBeUndefined();
    expect(other.session.runtime_state).toBe('idle');
    expect(JSON.stringify(other)).not.toContain('密钥');
  });

  test('cannot go across workspaces, with or without a lookup', () => {
    for (const args of [
      { all_workspaces: true },
      { workspace: 'proj' },
      { workspace: 'no-such-workspace' },
    ]) {
      expect(error(call(homeCaller(false), 'session_list', args))).toMatch(
        /^owner_turn_required/,
      );
    }
    expect(
      error(call(homeCaller(false), 'session_get', { session: 'proj/two' })),
    ).toMatch(/^owner_turn_required/);
    // The clamp is the same answer for a workspace that exists and one that
    // does not, so it cannot be used to probe.
    expect(
      error(call(homeCaller(false), 'session_get', { session: 'theirs/x' })),
    ).toBe(
      error(call(homeCaller(false), 'session_get', { session: 'proj/x' })),
    );
  });

  test('still reads its own status, without live tool inputs', () => {
    lanes = [
      {
        jid: lane(HOME.jid, HOME_BUILD),
        active: true,
        queryInFlight: true,
        queryStartedAt: 1_700_000_000_000,
      },
    ];
    const result = data(
      call(homeCaller(false), 'session_get', { session: 'build' }),
    );
    expect(result.session.runtime_state).toBe('running');
    expect(result.session.activity.tools).toEqual([{ name: 'Bash' }]);
    expect(result.session.activity.latest_progress).toBeUndefined();
    const self = data(
      call(homeCaller(false), 'session_get', { session: 'self' }),
    );
    expect(self.session.is_self).toBe(true);
    expect(self.messages).toBeUndefined();
  });

  test('the turn is judged from the input the request names', () => {
    const seen: Array<string | null> = [];
    const who = {
      folder: HOME.folder,
      agentId: HOME_SELF,
      ownerTurn: (turn: string | null) => {
        seen.push(turn);
        return false;
      },
    };
    call(who, 'session_list', { inputTurnId: 'turn-9' });
    call(who, 'session_list');
    expect(seen).toEqual(['turn-9', null]);
  });
});

describe('runtime state', () => {
  const state = (id: string, workspace = HOME) =>
    data(
      call(homeCaller(), 'session_get', {
        session: `${workspace.folder}/${id}`,
        message_limit: 0,
      }),
    ).session;

  test('an active runner that is not in a query is warm_idle, not running', () => {
    lanes = [
      {
        jid: lane(HOME.jid, HOME_BUILD),
        active: true,
        queryInFlight: false,
        queryStartedAt: null,
      },
    ];
    expect(state('build').runtime_state).toBe('warm_idle');
    lanes = [
      {
        jid: lane(HOME.jid, HOME_BUILD),
        active: true,
        queryInFlight: true,
        queryStartedAt: 1_700_000_000_000,
      },
    ];
    const running = state('build');
    expect(running).toMatchObject({
      runtime_state: 'running',
      started_at: '2023-11-14T22:13:20.000Z',
      elapsed_seconds: 60,
    });
    expect(running.activity.tools[0]).toMatchObject({
      name: 'Bash',
      input: 'npm test',
    });
    expect(running.activity.subagents[0]).toMatchObject({ title: 'review' });
    expect(running.activity.latest_progress.text).toBe('跑测试中');
    lanes = [];
    expect(state('build').runtime_state).toBe('idle');
  });

  test('a session waiting for a container slot reports its position', () => {
    waiting = [lane(PROJ.jid, PROJ_ONE), lane(PROJ.jid, PROJ_TWO)];
    expect(state('two', PROJ)).toMatchObject({
      runtime_state: 'queued_slot',
      queue_position: 2,
    });
    // Waiting while its own runner is active is not waiting for a slot.
    lanes = [
      {
        jid: lane(PROJ.jid, PROJ_TWO),
        active: true,
        queryInFlight: false,
        queryStartedAt: null,
      },
    ];
    expect(state('two', PROJ).runtime_state).toBe('warm_idle');
  });

  test('a lane parked on the usage limit reports when it resumes', () => {
    waits.reserveUsageLimitWait({
      scopeKey: lane(PROJ.jid, PROJ_TWO),
      inputKey: 'in-1',
      resetAt: '2030-01-01T00:00:00.000Z',
      resumeAt: '2030-01-01T00:01:00.000Z',
      maxWaits: 3,
    });
    expect(state('two', PROJ)).toMatchObject({
      runtime_state: 'rate_limited',
      reset_at: '2030-01-01T00:00:00.000Z',
      resume_at: '2030-01-01T00:01:00.000Z',
    });
    waits.clearUsageLimitWait(lane(PROJ.jid, PROJ_TWO));
    expect(state('two', PROJ).runtime_state).toBe('idle');
  });

  test('a work item waiting for a person makes its session waiting_human', () => {
    const item = store.insertWorkItem({
      id: 'wi-1',
      workspaceJid: PROJ.jid,
      workspaceFolder: PROJ.folder,
      channelJid: lane(PROJ.jid, PROJ_ONE),
      agentId: PROJ_TWO,
      title: '修 CI',
      sourceMessageId: 'delegate:1',
      sourceRouteJid: PROJ.jid,
      mandate: {
        strength: 'explicit',
        requesterImId: null,
        requesterName: null,
        requesterListed: true,
        requesterIsOwner: true,
        matchedRules: [],
        settingsVersion: 1,
        writable: true,
      },
      now: new Date().toISOString(),
      delegatedBy: { agentId: PROJ_ONE, inputId: null },
    });
    store.updateWorkItem(
      item.id,
      { lastReport: 'blocked', lastSummary: '缺凭据' },
      new Date().toISOString(),
    );
    expect(state('two', PROJ)).toMatchObject({
      runtime_state: 'waiting_human',
      work_stage: 'blocked',
      work_item: { seq: 1, title: '修 CI' },
    });
    // A running query outranks it.
    lanes = [
      {
        jid: lane(PROJ.jid, PROJ_TWO),
        active: true,
        queryInFlight: true,
        queryStartedAt: 1_700_000_000_000,
      },
    ];
    expect(state('two', PROJ).runtime_state).toBe('running');
    store.updateWorkItem(
      item.id,
      { status: 'ended' },
      new Date().toISOString(),
    );
  });

  test('a failed session reports error unless something live outranks it', () => {
    db.updateAgentStatus(PROJ_TWO, 'error', 'boom');
    expect(state('two', PROJ)).toMatchObject({
      runtime_state: 'error',
      error_summary: 'boom',
    });
    db.updateAgentStatus(PROJ_TWO, 'idle');
  });

  test('queued inputs are counted and "busy" includes them', () => {
    const laneJid = lane(PROJ.jid, PROJ_TWO);
    db.ensureChatExists(laneJid);
    db.storeMessageDirect(
      'q1',
      laneJid,
      'user',
      '主人',
      '稍后处理',
      new Date().toISOString(),
      false,
      {
        meta: {
          deliveryMode: 'queue',
          deliveryStatus: 'queued',
          deliveryRunId: 'run-x',
        },
      } as never,
    );
    expect(state('two', PROJ).queued_inputs).toBe(1);
    const busy = data(call(projCaller(), 'session_list', { state: 'busy' }));
    expect(busy.workspaces[0].sessions.map((s: any) => s.name)).toEqual([
      'two',
    ]);
    expect(busy.workspaces[0].counts.queued_inputs).toBe(1);
  });
});

describe('session_list', () => {
  test('filters by state and folds ended temporary sessions', () => {
    createSession('12121212-0000-4000-8000-000000000008', PROJ, 'run-1', {
      source_kind: 'automation',
      status: 'completed',
    });
    lanes = [
      {
        jid: lane(PROJ.jid, PROJ_TWO),
        active: true,
        queryInFlight: true,
        queryStartedAt: 1_700_000_000_000,
      },
    ];
    const running = data(
      call(projCaller(), 'session_list', { state: 'running' }),
    );
    expect(running.workspaces[0].sessions.map((s: any) => s.name)).toEqual([
      'two',
    ]);
    expect(running.workspaces[0].counts).toMatchObject({ running: 1 });

    const all = data(call(projCaller(), 'session_list'));
    const names = all.workspaces[0].sessions.map((s: any) => s.name);
    expect(names).not.toContain('run-1');
    expect(all.workspaces[0].counts.ended_hidden).toBe(1);
    const withEnded = data(
      call(projCaller(), 'session_list', { include_ended: true }),
    );
    expect(withEnded.workspaces[0].sessions.map((s: any) => s.name)).toContain(
      'run-1',
    );
  });

  test('limit caps the sessions and says how many were left out', () => {
    const list = data(call(projCaller(), 'session_list', { limit: 1 }));
    expect(list.workspaces[0].sessions).toHaveLength(1);
    expect(list.workspaces[0].omitted).toBeGreaterThan(0);
  });

  test('rejects bad arguments', () => {
    expect(
      error(call(projCaller(), 'session_list', { state: 'nope' })),
    ).toMatch(/state/);
    expect(error(call(projCaller(), 'session_list', { limit: 0 }))).toMatch(
      /limit/,
    );
    expect(error(call(projCaller(), 'session_get', {}))).toMatch(/session/);
    expect(
      error(
        call(projCaller(), 'session_get', {
          session: 'self',
          message_limit: 99,
        }),
      ),
    ).toMatch(/message_limit/);
  });

  test('an ambiguous name lists the candidates by short id', () => {
    createSession('abababab-0000-4000-8000-00000000000a', PROJ, 'twin');
    createSession('abababab-1111-4000-8000-00000000000b', PROJ, 'twin2');
    expect(
      error(call(projCaller(), 'session_get', { session: 'abababab' })),
    ).toMatch(/匹配到多个会话[\s\S]*twin/);
  });
});

describe('session_get bodies', () => {
  test('message_limit 0 returns state only', () => {
    const result = data(
      call(projCaller(), 'session_get', { session: 'two', message_limit: 0 }),
    );
    expect(result.messages).toBeUndefined();
  });

  test('messages and traces together stay within 32 KiB, newest kept', () => {
    const big = 'x'.repeat(3900);
    for (let i = 0; i < 30; i += 1) {
      say(PROJ.jid, PROJ_ONE, `big-${i}`, `${i}:${big}`, i % 2 === 1, {
        turnId: i % 2 === 1 ? `turn-${i}` : undefined,
      });
    }
    const result = data(
      call(projCaller(), 'session_get', {
        session: 'self',
        message_limit: 30,
        include_traces: true,
      }),
    );
    const bodyBytes = Buffer.byteLength(
      JSON.stringify({ messages: result.messages, traces: result.traces }),
    );
    expect(bodyBytes).toBeLessThanOrEqual(
      service.SESSION_INSPECT_BODY_BUDGET_BYTES,
    );
    expect(result.messages_omitted).toBeGreaterThan(0);
    const texts = result.messages.map((m: any) => m.text as string);
    // The newest survive, in chronological order.
    expect(texts.at(-1)).toMatch(/^29:/);
    expect(texts[0].startsWith('29:')).toBe(false);
    expect(result.messages.length + result.messages_omitted).toBe(30);
  });

  test('include_traces lists the tools of recent turns without their output', () => {
    say(PROJ.jid, PROJ_TWO, 'tr-1', '完成', true, { turnId: 'turn-trace-1' });
    db.upsertTurnTrace({
      chatJid: lane(PROJ.jid, PROJ_TWO),
      turnId: 'turn-trace-1',
      thinking: '不该出现的思考',
      traceJson: '[]',
      stepsJson: JSON.stringify([
        {
          id: 's1',
          kind: 'tool',
          at: 1000,
          endedAt: 1450,
          status: 'done',
          toolName: 'Bash',
          summary: 'npm test',
          resultPreview: 'SECRET OUTPUT',
        },
        {
          id: 's2',
          kind: 'tool',
          at: 2000,
          endedAt: 2100,
          status: 'error',
          toolName: 'Edit',
          resultPreview: 'old_string not found',
        },
        {
          id: 's3',
          kind: 'thinking',
          at: 3000,
          status: 'done',
          text: '不该出现的思考',
        },
      ]),
    });
    const result = data(
      call(projCaller(), 'session_get', {
        session: 'two',
        message_limit: 1,
        include_traces: true,
      }),
    );
    expect(result.traces).toEqual([
      {
        turn_id: 'turn-trace-1',
        tools: [
          { tool: 'Bash', status: 'done', duration_ms: 450, input: 'npm test' },
          {
            tool: 'Edit',
            status: 'error',
            duration_ms: 100,
            error: 'old_string not found',
          },
        ],
      },
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain('SECRET OUTPUT');
    expect(text).not.toContain('不该出现的思考');
  });

  test('one long message is cut with an ellipsis', () => {
    say(PROJ.jid, PROJ_TWO, 'long-1', 'y'.repeat(9000), false);
    const result = data(
      call(projCaller(), 'session_get', { session: 'two', message_limit: 1 }),
    );
    expect(result.messages[0].text.length).toBeLessThanOrEqual(4001);
    expect(result.messages[0].text.endsWith('…')).toBe(true);
  });

  test('list entries preview the latest message in one short line', () => {
    say(
      PROJ.jid,
      PROJ_TWO,
      'preview-1',
      `第一行\n第二行${'z'.repeat(400)}`,
      true,
    );
    const list = data(call(projCaller(), 'session_list'));
    const two = list.workspaces[0].sessions.find((s: any) => s.name === 'two');
    expect(two.latest_message.role).toBe('agent');
    expect(two.latest_message.text.startsWith('第一行 第二行')).toBe(true);
    expect([...two.latest_message.text].length).toBeLessThanOrEqual(
      service.SESSION_PREVIEW_CHARS + 1,
    );
  });
});
