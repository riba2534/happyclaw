import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'routes-process-visibility-'),
);
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [dataDir, storeDir, groupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    DATA_DIR: dataDir,
    STORE_DIR: storeDir,
    GROUPS_DIR: groupsDir,
    isDockerAvailable: vi.fn(async () => true),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = process.env.HAPPYCLAW_VISIBILITY_TEST_USER ?? 'visibility-owner';
    c.set('user', {
      id,
      username: id,
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;
const turnTraceRoutes = (await import('../src/routes/turn-traces.js')).default;
const { TurnTraceTracker } = await import('../src/turn-trace.js');

const OWNER_ID = 'visibility-owner';
const STRANGER_ID = 'visibility-stranger';
const registeredGroups: Record<string, any> = {};
const sessions: Record<string, string> = {};
const stopGroup = vi.fn(async () => {});
const queue = {
  pauseGroupsForMutation: vi.fn(() => ({ id: 1 })),
  resumeGroupsAfterMutation: vi.fn(),
  listDescendantJids: vi.fn(() => []),
  stopGroup,
  isGroupRuntimeSafetyBlocked: vi.fn(() => false),
  blockGroupsForRuntimeSafety: vi.fn(),
  unblockGroupsForRuntimeSafety: vi.fn(),
};

function createUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

function asUser(id: string): void {
  process.env.HAPPYCLAW_VISIBILITY_TEST_USER = id;
}

function workspace(
  slug: string,
  mode: 'assistant' | 'proactive',
  visibility?: 'hidden' | 'activity' | 'full',
): { jid: string; folder: string; agentId: string; lane: string } {
  const jid = `web:${slug}`;
  db.setRegisteredGroup(jid, {
    name: slug,
    folder: slug,
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    executionMode: 'container',
  });
  registeredGroups[jid] = db.getRegisteredGroup(jid);
  db.assignWorkspaceAgentProfile(
    slug,
    db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
    mode,
    visibility,
  );
  // History and traces live in a session of the workspace.
  const agentId = `${slug}-session`;
  if (!db.getAgent(agentId)) {
    db.createAgent({
      id: agentId,
      group_folder: slug,
      chat_jid: jid,
      name: 'Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
  }
  return { jid, folder: slug, agentId, lane: `${jid}#agent:${agentId}` };
}

const json = { 'content-type': 'application/json' };
const patchGroup = (jid: string, body: unknown) =>
  groupRoutes.request(`/${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify(body),
  });

beforeAll(() => {
  db.initDatabase();
  createUser(OWNER_ID);
  createUser(STRANGER_ID);
  webContext.setWebDeps({
    queue,
    sessions,
    getRegisteredGroups: () => registeredGroups,
    ensureTerminalContainerStarted: vi.fn(() => true),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_VISIBILITY_TEST_USER;
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace process_visibility API', () => {
  test('a new workspace defaults to activity and may be created with any level', async () => {
    asUser(OWNER_ID);
    const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const create = (extra: Record<string, unknown>) =>
      groupRoutes.request('/', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          name: 'Visibility Workspace',
          agent_profile_id: profile.id,
          execution_mode: 'container',
          interaction_mode: 'proactive',
          ...extra,
        }),
      });

    const defaulted = await (await create({})).json();
    expect(defaulted.group.process_visibility).toBe('activity');
    expect(db.getWorkspaceProcessVisibility(defaulted.group.folder)).toBe(
      'activity',
    );

    for (const level of ['hidden', 'full'] as const) {
      const created = await (
        await create({ process_visibility: level })
      ).json();
      expect(created.group.process_visibility).toBe(level);
      expect(db.getWorkspaceProcessVisibility(created.group.folder)).toBe(
        level,
      );
    }

    const rejected = await create({ process_visibility: 'everything' });
    expect(rejected.status).toBe(400);
  });

  test('the group list carries the effective value of every web workspace', async () => {
    asUser(OWNER_ID);
    const legacy = workspace('visibility-legacy', 'proactive');
    db.setWorkspaceProcessVisibility(legacy.folder, 'hidden');
    const shown = workspace('visibility-shown', 'assistant', 'full');

    const body = await (
      await groupRoutes.request('/', { method: 'GET' })
    ).json();
    expect(body.groups[legacy.jid].process_visibility).toBe('hidden');
    expect(body.groups[shown.jid].process_visibility).toBe('full');
    for (const [jid, group] of Object.entries<any>(body.groups)) {
      if (jid.startsWith('web:')) {
        expect(['hidden', 'activity', 'full']).toContain(
          group.process_visibility,
        );
      }
    }
  });

  test('the owner changes it live: no quiesce, no restart, no session reset', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('visibility-live', 'proactive', 'hidden');
    db.setSession(folder, 'sdk-session-keep');
    sessions[folder] = 'sdk-session-keep';

    const response = await patchGroup(jid, { process_visibility: 'full' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('full');
    // the interaction contract is untouched
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(stopGroup).not.toHaveBeenCalled();
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    expect(db.getSession(folder)).toBe('sdk-session-keep');
    expect(sessions[folder]).toBe('sdk-session-keep');
  });

  test('an Assistant workspace may store the setting too', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace(
      'visibility-assistant',
      'assistant',
      'hidden',
    );
    const response = await patchGroup(jid, { process_visibility: 'activity' });
    expect(response.status).toBe(200);
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('activity');
    expect(db.getWorkspaceInteractionMode(folder)).toBe('assistant');
  });

  test('changing the mode and the visibility together applies both', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('visibility-both', 'assistant', 'hidden');
    const response = await patchGroup(jid, {
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('full');
  });

  test('only the owner may change it, and only on web workspaces', async () => {
    const { jid, folder } = workspace(
      'visibility-denied',
      'proactive',
      'hidden',
    );

    asUser(STRANGER_ID);
    expect((await patchGroup(jid, { process_visibility: 'full' })).status).toBe(
      404,
    );
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('hidden');

    asUser(OWNER_ID);
    expect((await patchGroup(jid, { process_visibility: 'nope' })).status).toBe(
      400,
    );
    expect((await patchGroup(jid, {})).status).toBe(400);

    const imJid = 'feishu:oc_visibility_im';
    db.setRegisteredGroup(imJid, {
      name: 'IM Chat',
      folder: 'visibility-im',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[imJid] = db.getRegisteredGroup(imJid);
    const im = await patchGroup(imJid, { process_visibility: 'full' });
    expect(im.status).toBe(403);
  });

  test('a workspace without an AgentProfile binding answers 409', async () => {
    asUser(OWNER_ID);
    const jid = 'web:visibility-unbound';
    db.setRegisteredGroup(jid, {
      name: 'Unbound',
      folder: 'visibility-unbound',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[jid] = db.getRegisteredGroup(jid);
    const response = await patchGroup(jid, { process_visibility: 'full' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKSPACE_AGENT_PROFILE_MISSING',
    });
  });
});

/** A turn of a workspace: a user message, two agent messages, a stored trace. */
function seedTurn(
  chatJid: string,
  turnId: string,
  options: {
    thinking?: string;
    stepsJson?: string;
    stepsDropped?: number;
    traceJson?: string;
  } = {},
): void {
  db.ensureChatExists(chatJid);
  const at = (minute: number) =>
    `2026-10-12T01:${String(minute).padStart(2, '0')}:00.000Z`;
  db.storeMessageDirect(
    `${turnId}-user`,
    chatJid,
    OWNER_ID,
    'Owner',
    'hi',
    at(1),
    false,
    {
      meta: { turnId },
    },
  );
  db.storeMessageDirect(
    `${turnId}-a`,
    chatJid,
    'happyclaw-agent',
    'Agent',
    'one',
    at(2),
    true,
    {
      meta: { turnId, sourceKind: 'sdk_send_message' },
    },
  );
  db.storeMessageDirect(
    `${turnId}-b`,
    chatJid,
    'happyclaw-agent',
    'Agent',
    'two',
    at(3),
    true,
    {
      meta: { turnId, sourceKind: 'sdk_send_message' },
    },
  );
  db.upsertTurnTrace({
    chatJid,
    turnId,
    thinking: options.thinking ?? '想了想',
    thinkingDurationMs: 4_200,
    traceJson:
      options.traceJson ??
      JSON.stringify([
        { id: '1-a', timestamp: 1, kind: 'tool', title: '工具 Bash' },
      ]),
    stepsJson: options.stepsJson,
    stepsDropped: options.stepsDropped,
  });
}

/** The ordered steps of a turn that reasoned, ran a tool, said something, spoke. */
const STORED_STEPS = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: 1_000,
    endedAt: 1_900,
    status: 'done',
    durationMs: 900,
    text: '**读取配置**\n\n先看一下目录。',
    title: '读取配置',
  },
  {
    id: 'text-1',
    kind: 'text',
    at: 1_900,
    endedAt: 2_000,
    status: 'done',
    text: '我先列出文件。',
  },
  {
    id: 'tool-bash-2',
    kind: 'tool',
    at: 2_000,
    endedAt: 2_500,
    status: 'done',
    toolUseId: 'bash',
    toolName: 'Bash',
    summary: 'ls',
    resultPreview: 'a.txt',
  },
  {
    id: 'tool-say-3',
    kind: 'tool',
    at: 2_500,
    endedAt: 2_600,
    status: 'done',
    toolUseId: 'say',
    toolName: 'mcp__happyclaw__send_message',
    summary: '你好',
  },
  {
    id: 'thinking-4',
    kind: 'thinking',
    at: 2_600,
    endedAt: 3_000,
    status: 'done',
    durationMs: 400,
    text: '该回答了。',
    title: '收尾',
  },
];

const getMessages = async (jid: string, agentId: string) =>
  (await (
    await groupRoutes.request(
      `/${encodeURIComponent(jid)}/messages?agentId=${agentId}`,
      { method: 'GET' },
    )
  ).json()) as { messages: Array<{ id: string; has_trace?: boolean }> };

const getTrace = (jid: string, turnId: string) =>
  turnTraceRoutes.request(
    `/${encodeURIComponent(jid)}/turn-traces/${encodeURIComponent(turnId)}`,
    { method: 'GET' },
  );

describe('turn traces over HTTP', () => {
  test('an Assistant workspace lists has_trace and serves the whole trace', async () => {
    asUser(OWNER_ID);
    const { jid, agentId, lane } = workspace(
      'trace-assistant',
      'assistant',
      'hidden',
    );
    seedTurn(lane, 'turn-a');

    const { messages } = await getMessages(jid, agentId);
    expect(messages.filter((m) => m.has_trace).map((m) => m.id)).toEqual([
      'turn-a-b',
    ]);

    const response = await getTrace(lane, 'turn-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toMatchObject({
      turn_id: 'turn-a',
      thinking: '想了想',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash', kind: 'tool' }],
      created_at: expect.any(String),
    });
    expect((await getTrace(lane, 'no-such-turn')).status).toBe(404);
  });

  test('a proactive workspace follows its current visibility', async () => {
    asUser(OWNER_ID);
    const { jid, folder, agentId, lane } = workspace(
      'trace-proactive',
      'proactive',
      'full',
    );
    seedTurn(lane, 'turn-p');

    expect((await (await getTrace(lane, 'turn-p')).json()).thinking).toBe(
      '想了想',
    );
    expect(
      (await getMessages(jid, agentId)).messages.some((m) => m.has_trace),
    ).toBe(true);

    db.setWorkspaceProcessVisibility(folder, 'activity');
    const activity = await getTrace(lane, 'turn-p');
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toMatchObject({
      thinking: '',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash' }],
    });
    expect(
      (await getMessages(jid, agentId)).messages.some((m) => m.has_trace),
    ).toBe(true);

    db.setWorkspaceProcessVisibility(folder, 'hidden');
    expect((await getTrace(lane, 'turn-p')).status).toBe(404);
    expect(
      (await getMessages(jid, agentId)).messages.some((m) => m.has_trace),
    ).toBe(false);
  });

  test('other users get a 404, like every other resource of the workspace', async () => {
    const { jid } = workspace('trace-private', 'assistant');
    seedTurn(jid, 'turn-x');
    asUser(STRANGER_ID);
    expect((await getTrace(jid, 'turn-x')).status).toBe(404);
    expect((await getTrace('web:no-such-workspace', 'turn-x')).status).toBe(
      404,
    );
  });

  test('a Runtime Session trace is read through its virtual chat JID', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('trace-session', 'assistant');
    const agentId = 'session-trace-1';
    db.createAgent({
      id: agentId,
      group_folder: 'trace-session',
      chat_jid: jid,
      name: 'Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    const virtualJid = `${jid}#agent:${agentId}`;
    seedTurn(virtualJid, 'turn-s', { thinking: '会话里的思考' });

    const response = await getTrace(virtualJid, 'turn-s');
    expect(response.status).toBe(200);
    expect((await response.json()).thinking).toBe('会话里的思考');
    // the session list flags its last agent message
    const listed = (await (
      await groupRoutes.request(
        `/${encodeURIComponent(jid)}/messages?agentId=${agentId}`,
        { method: 'GET' },
      )
    ).json()) as { messages: Array<{ id: string; has_trace?: boolean }> };
    expect(listed.messages.filter((m) => m.has_trace).map((m) => m.id)).toEqual(
      ['turn-s-b'],
    );

    // another workspace's session id does not open it
    const otherWorkspace = workspace('trace-session-other', 'assistant');
    expect(
      (await getTrace(`${otherWorkspace.jid}#agent:${agentId}`, 'turn-s'))
        .status,
    ).toBe(404);
  });

  test('deleting the last message of a turn removes its trace', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('trace-delete', 'assistant');
    seedTurn(jid, 'turn-d');
    // user messages cannot be deleted by a member? they are the sender's own
    db.deleteMessage(jid, 'turn-d-a');
    expect((await getTrace(jid, 'turn-d')).status).toBe(200);
    db.deleteMessage(jid, 'turn-d-b');
    db.deleteMessage(jid, 'turn-d-user');
    expect((await getTrace(jid, 'turn-d')).status).toBe(404);
  });
});

interface TraceBody {
  turn_id: string;
  thinking: string;
  thinking_duration_ms: number | null;
  trace: unknown[];
  steps: Array<Record<string, unknown>>;
  steps_dropped: number;
  created_at: string;
}

const readTrace = async (jid: string, turnId: string): Promise<TraceBody> =>
  (await (await getTrace(jid, turnId)).json()) as TraceBody;

describe('turn trace steps over HTTP', () => {
  const seedSteps = (jid: string, turnId: string, stepsDropped = 0) =>
    seedTurn(jid, turnId, {
      stepsJson: JSON.stringify(STORED_STEPS),
      stepsDropped,
    });

  test('an Assistant workspace serves every step in order, and the old fields as before', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-assistant', 'assistant', 'hidden');
    seedSteps(jid, 'turn-1', 7);

    const response = await getTrace(jid, 'turn-1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as TraceBody;
    expect(Object.keys(body).sort()).toEqual(
      [
        'created_at',
        'steps',
        'steps_dropped',
        'thinking',
        'thinking_duration_ms',
        'trace',
        'turn_id',
      ].sort(),
    );
    expect(body.steps).toEqual(STORED_STEPS);
    expect(body.steps_dropped).toBe(7);
    expect(body).toMatchObject({
      turn_id: 'turn-1',
      thinking: '想了想',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash' }],
    });
  });

  test('a proactive workspace at full shows the reasoning and tools, never its speech tool or model text', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-full', 'proactive', 'full');
    seedSteps(jid, 'turn-1');
    const { steps } = await readTrace(jid, 'turn-1');
    expect(steps.map((s) => s.id)).toEqual([
      'thinking-0',
      'tool-bash-2',
      'thinking-4',
    ]);
    expect(steps[0]).toMatchObject({
      text: '**读取配置**\n\n先看一下目录。',
      title: '读取配置',
    });
    const raw = JSON.stringify(steps);
    expect(raw).not.toContain('send_message');
    expect(raw).not.toContain('你好');
    expect(raw).not.toContain('我先列出文件');
  });

  test('activity keeps the status and times of the reasoning but not its text or title', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-activity', 'proactive', 'activity');
    seedSteps(jid, 'turn-1');
    const body = await readTrace(jid, 'turn-1');
    expect(body.steps).toEqual([
      {
        id: 'thinking-0',
        kind: 'thinking',
        at: 1_000,
        endedAt: 1_900,
        status: 'done',
        durationMs: 900,
      },
      expect.objectContaining({ id: 'tool-bash-2', toolName: 'Bash' }),
      {
        id: 'thinking-4',
        kind: 'thinking',
        at: 2_600,
        endedAt: 3_000,
        status: 'done',
        durationMs: 400,
      },
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('读取配置');
    expect(raw).not.toContain('该回答了');
    expect(raw).not.toContain('收尾');
    expect(raw).not.toContain('send_message');
  });

  test('hidden is a 404 that carries no step', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-hidden', 'proactive', 'hidden');
    seedSteps(jid, 'turn-1');
    const response = await getTrace(jid, 'turn-1');
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('thinking-0');
  });

  test('the current level decides, whatever it was when the turn ran', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('steps-live', 'proactive', 'full');
    seedSteps(jid, 'turn-1');
    expect((await readTrace(jid, 'turn-1')).steps[0].text).toBeDefined();
    db.setWorkspaceProcessVisibility(folder, 'activity');
    expect((await readTrace(jid, 'turn-1')).steps[0].text).toBeUndefined();
    db.setWorkspaceProcessVisibility(folder, 'hidden');
    expect((await getTrace(jid, 'turn-1')).status).toBe(404);
    db.setWorkspaceProcessVisibility(folder, 'full');
    expect((await readTrace(jid, 'turn-1')).steps[0].text).toBeDefined();
  });

  test('a spawn Agent of a proactive workspace keeps Assistant semantics', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-spawn', 'proactive', 'hidden');
    const agentId = 'steps-spawn-1';
    db.createAgent({
      id: agentId,
      group_folder: 'steps-spawn',
      chat_jid: jid,
      name: 'Spawn',
      prompt: '',
      status: 'idle',
      kind: 'spawn',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    const virtualJid = `${jid}#agent:${agentId}`;
    seedSteps(virtualJid, 'turn-s');
    expect((await readTrace(virtualJid, 'turn-s')).steps).toEqual(STORED_STEPS);
  });

  test('a turn stored before steps were kept reads as none, the rest as before', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-old', 'assistant');
    seedTurn(jid, 'turn-old');
    const body = await readTrace(jid, 'turn-old');
    expect(body.steps).toEqual([]);
    expect(body.steps_dropped).toBe(0);
    expect(body).toMatchObject({
      thinking: '想了想',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash' }],
    });
  });

  test('damaged steps read as none instead of failing the request', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('steps-damaged', 'assistant');
    seedTurn(jid, 'turn-bad-json', { stepsJson: '{not json', stepsDropped: 3 });
    seedTurn(jid, 'turn-bad-shape', {
      stepsJson: JSON.stringify({ steps: STORED_STEPS }),
      stepsDropped: 3,
    });
    seedTurn(jid, 'turn-bad-rows', {
      stepsJson: JSON.stringify([null, 'x', { kind: 'tool' }]),
      stepsDropped: 3,
    });
    for (const turnId of ['turn-bad-json', 'turn-bad-shape', 'turn-bad-rows']) {
      const response = await getTrace(jid, turnId);
      expect(response.status).toBe(200);
      const body = (await response.json()) as TraceBody;
      expect(body.steps).toEqual([]);
      expect(body.steps_dropped).toBe(0);
      expect(body.thinking).toBe('想了想');
    }
  });
});

/** A turn that ran under an Assistant contract: tools returned things. */
const SECRET = 'API_KEY=hunter2';
const RETURNED_STEPS = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: 1_000,
    endedAt: 1_500,
    status: 'done',
    durationMs: 500,
    text: '**读取配置**\n\n先看一下。',
    title: '读取配置',
  },
  {
    id: 'tool-read-1',
    kind: 'tool',
    at: 1_500,
    endedAt: 1_600,
    status: 'done',
    toolUseId: 'read-1',
    toolName: 'Read',
    summary: 'file: .env',
    resultPreview: SECRET,
    resultFacts: { lines: 3, totalLines: 3 },
  },
  {
    id: 'tool-bash-2',
    kind: 'tool',
    at: 1_600,
    endedAt: 1_700,
    status: 'error',
    toolUseId: 'bash-2',
    toolName: 'Bash',
    resultPreview: `cat: ${SECRET}: Permission denied`,
    resultFacts: { exitCode: 1 },
  },
  {
    id: 'task-agent-3',
    kind: 'task',
    at: 1_700,
    endedAt: 1_800,
    status: 'done',
    taskId: 'agent-3',
    toolUseId: 'agent-3',
    toolName: 'Agent',
    title: '调研',
    summary: '读了 3 个文件',
    resultPreview: `最终回答：${SECRET}`,
    resultFacts: { agent: { toolUses: 4 } },
  },
];
const RETURNED_TRACE = [
  { id: 't1', timestamp: 1, kind: 'tool', title: '工具 Read' },
  {
    id: 't2',
    timestamp: 2,
    kind: 'tool',
    title: '工具结果',
    detail: SECRET,
    toolUseId: 'read-1',
  },
  {
    id: 't3',
    timestamp: 3,
    kind: 'task',
    title: 'Task 启动',
    detail: `读 .env 并回报 ${SECRET}`,
    toolUseId: 'agent-3',
  },
  {
    id: 't4',
    timestamp: 4,
    kind: 'hook',
    title: 'Hook 结束',
    detail: 'hook output',
  },
];

describe('what a tool returned, read in a proactive workspace', () => {
  const seedReturned = (jid: string, turnId = 'turn-1') =>
    seedTurn(jid, turnId, {
      stepsJson: JSON.stringify(RETURNED_STEPS),
      traceJson: JSON.stringify(RETURNED_TRACE),
    });

  /** Nothing a tool returned, in the steps or in the rows of the trace. */
  const expectNothingReturned = (body: TraceBody) => {
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('Permission denied');
    expect(raw).not.toContain('resultPreview');
    expect(raw).not.toContain('resultFacts');
    expect(body.steps.map((s) => s.id)).toEqual(
      expect.arrayContaining(['tool-read-1', 'tool-bash-2', 'task-agent-3']),
    );
    // how the calls ended, what they were given and the rest of the trace stay
    expect(body.steps.find((s) => s.id === 'tool-bash-2')).toMatchObject({
      status: 'error',
    });
    expect(body.steps.find((s) => s.id === 'tool-read-1')).toMatchObject({
      summary: 'file: .env',
    });
    expect(body.steps.find((s) => s.id === 'task-agent-3')).toMatchObject({
      title: '调研',
      summary: '读了 3 个文件',
    });
    expect(body.trace.map((row: any) => row.title)).toEqual([
      '工具 Read',
      '工具结果',
      'Task 启动',
      'Hook 结束',
    ]);
    expect(
      body.trace.find((row: any) => row.title === 'Hook 结束'),
    ).toMatchObject({ detail: 'hook output' });
  };

  test('an Assistant workspace serves it, until it becomes a proactive one', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('returned-switch', 'assistant', 'hidden');
    seedReturned(jid);

    const before = await readTrace(jid, 'turn-1');
    expect(JSON.stringify(before.steps)).toContain(SECRET);
    expect(JSON.stringify(before.trace)).toContain(SECRET);

    const response = await patchGroup(jid, {
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(response.status).toBe(200);
    expectNothingReturned(await readTrace(jid, 'turn-1'));

    // and at every level that shows the process
    db.setWorkspaceProcessVisibility('returned-switch', 'activity');
    expectNothingReturned(await readTrace(jid, 'turn-1'));

    // back to an Assistant workspace, it is shown again: the stored turn is intact
    await patchGroup(jid, { interaction_mode: 'assistant' });
    const again = await readTrace(jid, 'turn-1');
    expect(JSON.stringify(again.steps)).toContain(SECRET);
    expect(JSON.stringify(again.trace)).toContain(SECRET);
  });

  test('a turn a channel mount ran as an Assistant one is read by the proactive workspace', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('returned-override', 'proactive', 'full');
    // The mount's interaction_mode_override makes the Runner for its messages
    // an Assistant one, so the tracker records under that contract...
    const tracker = new TurnTraceTracker({
      mode: 'assistant',
      getVisibility: () => 'hidden',
    });
    const events = [
      { eventType: 'thinking_delta', text: '**读取配置**\n\n先看一下。' },
      {
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'read-1',
        toolInputSummary: 'file: .env',
      },
      {
        eventType: 'tool_result',
        toolUseId: 'read-1',
        toolResult: SECRET,
        detail: SECRET,
        toolResultFacts: { lines: 3, totalLines: 3 },
      },
      { eventType: 'tool_use_end', toolUseId: 'read-1' },
    ] as const;
    events.forEach((event, i) =>
      tracker.observe('in-1', event as any, i * 100),
    );
    expect(tracker.persist({ chatJid: jid, inputId: 'in-1', now: 1_000 })).toBe(
      true,
    );
    const stored = db.getTurnTrace(jid, 'in-1')!;
    // ... which keeps what the tool returned
    expect(stored.steps_json).toContain(SECRET);
    expect(stored.trace_json).toContain(SECRET);

    // ... and the workspace, which is proactive, reads it under its own.
    const body = await readTrace(jid, 'in-1');
    expect(body.steps.map((s) => s.toolName ?? s.kind)).toEqual([
      'thinking',
      'Read',
    ]);
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body.steps)).not.toContain('resultFacts');
    expect(JSON.stringify(body.steps)).not.toContain('resultPreview');
    expect(body.trace.some((row: any) => row.title === '工具结果')).toBe(true);
    expect(body.trace.some((row: any) => 'detail' in row && row.detail)).toBe(
      false,
    );
  });
});
