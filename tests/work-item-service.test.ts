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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-work-items-'));

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
const service = await import('../src/work-item-service.js');
const runtime = await import('../src/work-item-runtime.js');
const gate = await import('../src/team-gate.js');
const webContext = await import('../src/web-context.js');

import type { NewMessage } from '../src/types.js';
import type { WorkItem } from '../src/work-items.js';

const OWNER = 'owner-1';
const WORKSPACE = 'web:team-ws';
const FOLDER = 'team-ws';
const CHAT = 'feishu:oc_team';
const ACTOR = { userId: OWNER, isAdmin: false };

let replySeq = 0;
const replies: runtime.TeamReplyRequest[] = [];
const laneMessages: { laneJid: string; text: string; id: string }[] = [];
const stopped: string[] = [];
const drained: string[] = [];
const broadcasts: string[] = [];
let failReplies = false;
let replyRetryable = false;

function installHooks(): void {
  runtime.setWorkItemRuntimeHooks({
    admitInput: () => 'started',
    wake: vi.fn(),
    broadcastNewMessage: vi.fn(),
    stopLane: (laneJid) => stopped.push(laneJid),
    drainLane: (laneJid) => drained.push(laneJid),
    postReply: async (request) => {
      replies.push(request);
      if (failReplies) {
        return {
          ok: false,
          error: 'rejected by Feishu',
          retryable: replyRetryable,
        };
      }
      return { ok: true, providerMessageId: `om_bot_${++replySeq}` };
    },
    postLaneMessage: async (laneJid, text, id) => {
      laneMessages.push({ laneJid, text, id });
      db.storeMessageDirect(
        id,
        laneJid,
        'happyclaw-agent',
        'HappyClaw',
        text,
        new Date().toISOString(),
        true,
      );
    },
    broadcastWorkItemEvent: (event) => broadcasts.push(event.item.id),
  });
}

/** The workspace session the group is bound to, and another one. */
const BOUND_SESSION = 'team-bound-session';
const OTHER_SESSION = 'team-other-session';

function setGroup(jid: string, extra: Record<string, unknown> = {}): void {
  db.setRegisteredGroup(jid, {
    name: '研发群',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    target_agent_id: BOUND_SESSION,
    feishu_chat_mode: 'group',
    owner_im_id: 'ou_owner',
    sender_allowlist: ['ou_listed'],
    channel_account_id: 'acct-1',
    ...extra,
  } as never);
}

async function enable(overrides: Record<string, unknown> = {}) {
  return service.saveTeamMountSettings(
    WORKSPACE,
    CHAT,
    {
      enabled: true,
      admission: {
        listedUnaddressed: 'inferred',
        unlistedAddressed: 'explicit',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'auto',
      rules: [
        { id: 'r1', name: 'CI', instruction: 'Fix red CI', enabled: true },
        { id: 'r2', name: 'Docs', instruction: 'Fix typos', enabled: true },
      ],
      ...overrides,
    },
    ACTOR,
  );
}

function routerCaller() {
  const team = store.getTeamMount(CHAT)!;
  return { folder: FOLDER, agentId: team.routerAgentId };
}

function routerLane(): string {
  return `${WORKSPACE}#agent:${store.getTeamMount(CHAT)!.routerAgentId}`;
}

/** A group message the connector stored in the router lane as a candidate. */
function storeCandidate(
  messageId: string,
  input: {
    strength?: 'explicit' | 'inferred';
    listed?: boolean;
    sender?: string;
    content?: string;
  } = {},
): void {
  const item = gate.candidateInputItem({
    triggerMessageId: messageId,
    strength: input.strength ?? 'explicit',
    listed: input.listed ?? true,
    addressed: true,
    settings: store.getTeamMount(CHAT)!.settings,
    threadItems: [],
    senderImId: input.sender ?? 'ou_listed',
  });
  db.storeMessageDirect(
    messageId,
    routerLane(),
    input.sender ?? 'ou_listed',
    '小王',
    input.content ?? '帮我修一下 CI',
    new Date().toISOString(),
    false,
    {
      sourceJid: CHAT,
      attachments: gate.withTeamInputAttachment(null, item),
    },
  );
}

async function route(item: Record<string, unknown>, caller = routerCaller()) {
  return service.handleWorkIpc(caller, {
    type: 'work_route',
    items: [item],
  });
}

async function accept(trigger: string, extra: Record<string, unknown> = {}) {
  const result = await route({
    kind: 'accept',
    triggerMessageId: trigger,
    title: '修 CI',
    acknowledgement: '收到，我来看看',
    ...extra,
  });
  expect(result.ok).toBe(true);
  return (result as { data: { results: Record<string, unknown>[] } }).data
    .results[0];
}

function workerCaller(item: WorkItem) {
  return { folder: FOLDER, agentId: item.agentId };
}

function laneRows(laneJid: string): NewMessage[] {
  return db.getMessagesSince(laneJid, { timestamp: '', id: '' });
}

/** A conversation session of the team workspace. */
function createSession(id: string, status: 'idle' | 'completed' = 'idle') {
  db.createAgent({
    id,
    group_folder: FOLDER,
    chat_jid: WORKSPACE,
    name: id,
    prompt: '',
    status,
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Team WS',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
  });
  for (const id of [BOUND_SESSION, OTHER_SESSION]) createSession(id);
  setGroup(CHAT);
  webContext.setWebDeps({
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  installHooks();
});

beforeEach(() => {
  replies.length = 0;
  laneMessages.length = 0;
  stopped.length = 0;
  broadcasts.length = 0;
  failReplies = false;
  replyRetryable = false;
});

afterAll(async () => {
  await service.settleTeamReplies();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team mount settings', () => {
  test('enabling creates the router session and bumps the version', async () => {
    const first = await enable();
    expect(first.settings.version).toBe(1);
    const router = db.getAgent(first.routerAgentId!);
    expect(router).toMatchObject({
      source_kind: 'team_router',
      chat_jid: WORKSPACE,
      kind: 'conversation',
    });
    const second = await enable();
    expect(second.settings.version).toBe(2);
    expect(second.routerAgentId).toBe(first.routerAgentId);
    expect(service.listTeamMountViews(WORKSPACE)).toEqual([
      expect.objectContaining({ channelJid: CHAT, eligible: true }),
    ]);
  });

  test('a group bound to any session of the workspace can run it; an unbound one cannot', async () => {
    const other = 'feishu:oc_other';
    setGroup(other, { target_agent_id: OTHER_SESSION });
    expect(service.teamMountIneligibility(other, WORKSPACE)).toBeNull();
    expect(
      service
        .listTeamMountViews(WORKSPACE)
        .find((view) => view.channelJid === other),
    ).toMatchObject({ eligible: true, ineligibleReason: null });
    // A single-session mount without its session (never written after v88).
    expect(
      service.teamMountIneligibility(other, WORKSPACE, {
        ...db.getChannelMount(other)!,
        session_id: null,
      }),
    ).toBe('群需要绑定到工作区的会话');
    db.deleteRegisteredGroup(other);
  });

  test('a topic group or a private chat cannot run team mode', async () => {
    const topic = 'feishu:oc_topic';
    setGroup(topic, {
      feishu_chat_mode: 'topic',
      target_agent_id: undefined,
      target_main_jid: WORKSPACE,
      binding_mode: 'thread_map',
    });
    expect(service.teamMountIneligibility(topic, WORKSPACE)).toMatch(/普通群/);
    await expect(
      service.saveTeamMountSettings(
        WORKSPACE,
        topic,
        { ...store.getTeamMount(CHAT)!.settings, enabled: true },
        ACTOR,
      ),
    ).rejects.toThrow(/普通群/);
  });
});

describe('work_route', () => {
  test('accept creates the item, its worker, its subscription and replies under the request', async () => {
    storeCandidate('om_req1');
    const result = await accept('om_req1', { note: '先看日志' });
    expect(result).toMatchObject({ ok: true, decision: 'accept' });
    const item = store.getWorkItem(result.workItemId as string)!;
    expect(item).toMatchObject({
      sourceMessageId: 'om_req1',
      status: 'open',
      mandate: { strength: 'explicit', writable: true, requesterListed: true },
    });
    expect(db.getAgent(item.agentId)).toMatchObject({
      source_kind: 'work_item',
      chat_jid: WORKSPACE,
    });
    await service.settleTeamReplies();
    // The acknowledgement is quoted under the request and its message is
    // subscribed for the item.
    expect(replies).toEqual([
      expect.objectContaining({
        channelJid: CHAT,
        quoteMessageId: 'om_req1',
        text: '收到，我来看看',
      }),
    ]);
    const keys = store
      .listWorkItemSubscriptions(item.id)
      .map((entry) => entry.subKey);
    expect(keys).toEqual(['msg:om_req1', `msg:om_bot_${replySeq}`]);
    // The ack is stored as the router's own message, so a reply to it is a
    // reply to the bot.
    const context = service.resolveTeamGroup(CHAT)!;
    expect(service.isTeamBotMessage(context, `om_bot_${replySeq}`)).toBe(true);
    // The worker receives its assignment.
    const [assignment] = laneRows(`${WORKSPACE}#agent:${item.agentId}`);
    expect(assignment.source_kind).toBe('work_item_input');
    expect(gate.readTeamInput(assignment.attachments)).toMatchObject({
      tag: 'work_assignment',
      note: '先看日志',
    });
    expect(broadcasts).toContain(item.id);
    expect(service.getWorkItemDetail(item.id)?.events[0]).toMatchObject({
      kind: 'input',
      triggerMessageId: 'om_req1',
      text: '帮我修一下 CI',
    });
    expect(service.listWorkItemViews(WORKSPACE)).toContainEqual(
      expect.objectContaining({
        id: item.id,
        workspaceName: 'Team WS',
        channelName: '研发群',
      }),
    );
    expect(store.getWorkDecisionForTrigger(CHAT, 'om_req1')?.kind).toBe(
      'accept',
    );
  });

  test('accept is idempotent by trigger, also when retried concurrently', async () => {
    storeCandidate('om_req2');
    const [a, b] = await Promise.all([accept('om_req2'), accept('om_req2')]);
    expect(a.workItemId).toBe(b.workItemId);
    const again = await accept('om_req2');
    expect(again.workItemId).toBe(a.workItemId);
    // The losing call's session was not kept: every worker has an item.
    const items = new Set(
      store.listWorkItems(WORKSPACE).map((item) => item.agentId),
    );
    const workers = db
      .listAgentsByJid(WORKSPACE)
      .filter((agent) => agent.source_kind === 'work_item');
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((agent) => items.has(agent.id))).toBe(true);
  });

  test('observe only records would_accept for an inferred candidate', async () => {
    await enable({ acceptMode: 'observe' });
    storeCandidate('om_inf1', { strength: 'inferred' });
    const result = await accept('om_inf1', {
      ruleAssessments: [
        { ruleId: 'r1', matched: true, reason: 'CI is red' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    expect(result).toMatchObject({ ok: true, decision: 'would_accept' });
    expect(store.getWorkItemBySource(CHAT, 'om_inf1')).toBeUndefined();
    expect(store.getWorkDecisionForTrigger(CHAT, 'om_inf1')).toMatchObject({
      kind: 'would_accept',
      matchedRuleIds: ['r1'],
    });
    await enable({ acceptMode: 'auto' });
  });

  test('inferred needs a judgement of every rule and auto needs a match', async () => {
    storeCandidate('om_inf2', { strength: 'inferred' });
    const missing = await accept('om_inf2', {
      ruleAssessments: [{ ruleId: 'r1', matched: true, reason: 'red' }],
    });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toMatch(/every enabled rule.*r2/);
    const none = await accept('om_inf2', {
      ruleAssessments: [
        { ruleId: 'r1', matched: false, reason: 'no' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    expect(none.error).toMatch(/No enabled rule matched/);
    const ok = await accept('om_inf2', {
      ruleAssessments: [
        { ruleId: 'r1', matched: true, reason: 'red' },
        { ruleId: 'r2', matched: false, reason: 'no' },
      ],
    });
    const item = store.getWorkItem(ok.workItemId as string)!;
    expect(item.mandate).toMatchObject({
      strength: 'inferred',
      writable: false,
      matchedRules: [{ id: 'r1', name: 'CI', instruction: 'Fix red CI' }],
    });
  });

  test('an explicit request from an unlisted sender is read-only', async () => {
    storeCandidate('om_unl', { listed: false, sender: 'ou_stranger' });
    const result = await accept('om_unl');
    expect(
      store.getWorkItem(result.workItemId as string)!.mandate,
    ).toMatchObject({ requesterListed: false, writable: false });
  });

  test('attach and stop need an explicit candidate; ignore needs a reason', async () => {
    storeCandidate('om_base');
    const base = await accept('om_base');
    storeCandidate('om_inf3', { strength: 'inferred' });
    const attachInferred = await route({
      kind: 'attach',
      triggerMessageId: 'om_inf3',
      workItemId: base.workItemId,
    });
    expect(
      (attachInferred as { data: { results: { ok: boolean }[] } }).data
        .results[0].ok,
    ).toBe(false);
    storeCandidate('om_more');
    const attached = await route({
      kind: 'attach',
      triggerMessageId: 'om_more',
      workItemId: base.workItemId,
    });
    expect(attached).toMatchObject({
      ok: true,
      data: { results: [{ ok: true, decision: 'attach' }] },
    });
    const item = store.getWorkItem(base.workItemId as string)!;
    expect(
      store.listWorkItemSubscriptions(item.id).map((s) => s.subKey),
    ).toContain('msg:om_more');
    const workerRows = laneRows(`${WORKSPACE}#agent:${item.agentId}`);
    expect(workerRows.map((row) => row.id)).toContain(
      service.followupCopyId('om_more', item.id),
    );
    const ignore = await route({ kind: 'ignore', triggerMessageId: 'om_inf3' });
    expect(
      (ignore as { data: { results: { error?: string }[] } }).data.results[0]
        .error,
    ).toMatch(/reason/);
    storeCandidate('om_stop');
    const stop = await route({
      kind: 'stop',
      triggerMessageId: 'om_stop',
      workItemId: item.id,
    });
    expect(stop).toMatchObject({ data: { results: [{ ok: true }] } });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(stopped).toContain(`${WORKSPACE}#agent:${item.agentId}`);
  });

  test('a decided candidate is not decided again', async () => {
    storeCandidate('om_dec');
    await route({ kind: 'ignore', triggerMessageId: 'om_dec', reason: 'chat' });
    const again = await accept('om_dec');
    expect(again.error).toMatch(/already decided/);
  });
});

describe('lane roles', () => {
  test('a worker cannot route and a router cannot report', async () => {
    storeCandidate('om_roles');
    const { workItemId } = await accept('om_roles');
    const item = store.getWorkItem(workItemId as string)!;
    const asWorker = await route(
      { kind: 'ignore', triggerMessageId: 'om_roles', reason: 'x' },
      workerCaller(item),
    );
    expect(asWorker).toEqual({
      ok: false,
      error: 'Only a team router session can use this tool.',
    });
    const asRouter = await service.handleWorkIpc(routerCaller(), {
      type: 'work_report',
      state: 'ready',
      summary: 'done',
    });
    expect(asRouter).toEqual({
      ok: false,
      error: 'Only a work item session can use this tool.',
    });
    // The main session (no agent id) is neither.
    const asMain = await service.handleWorkIpc(
      { folder: FOLDER, agentId: null },
      { type: 'work_list' },
    );
    expect(asMain.ok).toBe(false);
  });
});

describe('work_reply', () => {
  async function newItem(trigger: string): Promise<WorkItem> {
    storeCandidate(trigger);
    const { workItemId } = await accept(trigger);
    await service.settleTeamReplies();
    replies.length = 0;
    return store.getWorkItem(workItemId as string)!;
  }

  const reply = (payload: Record<string, unknown>) =>
    service.handleWorkIpc(routerCaller(), { type: 'work_reply', ...payload });

  test('result needs a ready, blocked or failed report', async () => {
    const item = await newItem('om_res');
    expect(
      await reply({ purpose: 'result', workItemId: item.id, text: '好了' }),
    ).toMatchObject({ ok: false });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'blocked',
      summary: '没有权限',
    });
    expect(
      await reply({ purpose: 'result', workItemId: item.id, text: '做不了' }),
    ).toEqual({ ok: true, data: { queued: true } });
    await service.settleTeamReplies();
    expect(replies).toEqual([
      expect.objectContaining({ quoteMessageId: 'om_res', text: '做不了' }),
    ]);
    // The result message is subscribed: a reply to it reaches the item.
    expect(
      store.findSubscribedWorkItems(
        CHAT,
        [`msg:om_bot_${replySeq}`],
        WORKSPACE,
      ),
    ).toEqual([expect.objectContaining({ id: item.id })]);
  });

  test('attention needs a question and quotes the message that raised it', async () => {
    const item = await newItem('om_att');
    expect(
      await reply({
        purpose: 'attention',
        workItemId: item.id,
        text: '问一下',
      }),
    ).toMatchObject({ ok: false });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'waiting',
      summary: '需要确认',
      humanAction: '用哪个分支？',
      questionForMessageId: 'om_q',
    });
    expect(
      await reply({
        purpose: 'attention',
        workItemId: item.id,
        text: '用哪个分支？',
      }),
    ).toMatchObject({ ok: true });
    await service.settleTeamReplies();
    expect(replies[0]).toMatchObject({ quoteMessageId: 'om_q' });
  });

  test('answer is for a candidate no work item owns', async () => {
    storeCandidate('om_ask');
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_ask',
        text: '在 README 里',
      }),
    ).toMatchObject({ ok: true });
    const item = await newItem('om_owned');
    expect(item).toBeTruthy();
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_owned',
        text: '答',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_unknown',
        text: '答',
      }),
    ).toMatchObject({ ok: false });
  });

  test('more than 100 words is refused so the model rewrites it', async () => {
    storeCandidate('om_long');
    const long = '很'.repeat(101);
    const result = await reply({
      purpose: 'answer',
      triggerMessageId: 'om_long',
      text: long,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/101 words.*100/);
    expect(
      await reply({
        purpose: 'answer',
        triggerMessageId: 'om_long',
        text: '很'.repeat(100),
      }),
    ).toMatchObject({ ok: true });
  });

  test('a failed delivery is recorded on the item', async () => {
    const item = await newItem('om_fail');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'failed',
      summary: '编译失败',
    });
    failReplies = true;
    await reply({ purpose: 'result', workItemId: item.id, text: '失败了' });
    await service.settleTeamReplies();
    expect(store.listWorkEvents(item.id)).toContainEqual(
      expect.objectContaining({ kind: 'reply', state: 'failed' }),
    );
  });
});

describe('work reports and approval', () => {
  test('a read-only item that reports ready waits for approval', async () => {
    storeCandidate('om_ro', { listed: false, sender: 'ou_stranger' });
    const { workItemId } = await accept('om_ro');
    let item = store.getWorkItem(workItemId as string)!;
    expect(service.resolveTeamRole(item.agentId)).toEqual({
      role: 'worker',
      workItemId: item.id,
      writable: false,
    });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '复现了，改法是……',
    });
    const [view] = service
      .listWorkItemViews(WORKSPACE)
      .filter((entry) => entry.id === item.id);
    expect(view).toMatchObject({ status: 'open', stage: 'approval' });
    // The report reaches the router.
    const reports = laneRows(routerLane()).filter(
      (row) => gate.readTeamInput(row.attachments)?.tag === 'work_report',
    );
    expect(reports.at(-1)?.content).toBe('复现了，改法是……');

    const approved = await service.approveWorkItem(item.id, ACTOR);
    expect(approved.approvedAt).toBeTruthy();
    // Its read-only warm runner is retired before the approval arrives.
    expect(drained).toContain(`${WORKSPACE}#agent:${item.agentId}`);
    expect(service.resolveTeamRole(item.agentId)).toMatchObject({
      writable: true,
    });
    expect(
      laneRows(`${WORKSPACE}#agent:${item.agentId}`).map(
        (row) => gate.readTeamInput(row.attachments)?.tag,
      ),
    ).toContain('work_approved');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '已改好',
    });
    item = store.getWorkItem(item.id)!;
    expect(item).toMatchObject({ status: 'ended', outcome: 'completed' });
  });

  test('progress only updates the item; dropped ends it silently', async () => {
    storeCandidate('om_prog');
    const { workItemId } = await accept('om_prog');
    const item = store.getWorkItem(workItemId as string)!;
    const before = laneRows(routerLane()).length;
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'progress',
      summary: '在看',
    });
    expect(laneRows(routerLane()).length).toBe(before);
    expect(store.getWorkItem(item.id)!.lastReport).toBe('progress');
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'dropped',
      summary: '不需要做了',
    });
    expect(laneRows(routerLane()).length).toBe(before);
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'dropped',
    });
  });

  test('the router’s acknowledgement makes a worker ack on the same trigger a duplicate', async () => {
    storeCandidate('om_ack');
    const { workItemId } = await accept('om_ack');
    const item = store.getWorkItem(workItemId as string)!;
    await service.settleTeamReplies();
    replies.length = 0;
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_ack',
        triggerMessageId: 'om_ack',
        text: '开工',
      }),
    ).toEqual({ ok: true, data: { duplicate: true } });
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_ack',
        triggerMessageId: 'om_elsewhere',
        text: '开工',
      }),
    ).toMatchObject({ ok: false });
    expect(replies).toEqual([]);
  });
});

/**
 * A group message the connector stored in its first item's lane, with the
 * header the gate gave it, then the post-store fan-out.
 */
function storeFollowup(
  messageId: string,
  input: {
    threadId?: string;
    parentId?: string;
    sender?: string;
    content?: string;
  } = {},
) {
  const context = service.resolveTeamGroup(CHAT)!;
  const message = {
    messageId,
    threadId: input.threadId,
    parentId: input.parentId,
    senderImId: input.sender ?? 'ou_listed',
    mentionedBot: false,
  };
  const decision = gate.decideTeamInbound(
    context,
    message,
    service.teamGateDeps(context),
  );
  if (decision.kind !== 'subscribed') return { decision, laneJid: null };
  const laneJid = `${WORKSPACE}#agent:${decision.items[0].agentId}`;
  const header = service.teamInputItemFor(decision, message, context.settings)!;
  db.storeMessageDirect(
    messageId,
    laneJid,
    message.senderImId,
    '小王',
    input.content ?? '还有一个问题',
    new Date().toISOString(),
    false,
    {
      sourceJid: CHAT,
      attachments: gate.withTeamInputAttachment(null, header),
    },
  );
  service.onTeamMessageStored(laneJid, messageId);
  return { decision, laneJid };
}

describe('subscribed group messages', () => {
  test('the first item gets the message, further items a copy; ended items resume, stopped ones do not', async () => {
    storeCandidate('om_a');
    const a = store.getWorkItem((await accept('om_a')).workItemId as string)!;
    storeCandidate('om_b');
    const b = store.getWorkItem((await accept('om_b')).workItemId as string)!;
    storeCandidate('om_c');
    const c = store.getWorkItem((await accept('om_c')).workItemId as string)!;
    // All three follow one thread; b has completed, c was stopped.
    for (const item of [a, b, c]) {
      store.subscribeWorkItem(item.id, CHAT, 'thread:omt_shared', 'x');
    }
    await service.handleWorkIpc(workerCaller(b), {
      type: 'work_report',
      state: 'ready',
      summary: 'done',
    });
    await service.stopWorkItem(c.id, ACTOR);
    broadcasts.length = 0;

    const { decision } = storeFollowup('om_follow', {
      threadId: 'omt_shared',
    });
    expect(decision.kind).toBe('subscribed');
    if (decision.kind !== 'subscribed') return;
    expect(decision.items.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(store.getWorkItem(b.id)).toMatchObject({ status: 'open' });
    const copy = laneRows(`${WORKSPACE}#agent:${b.agentId}`).find(
      (row) => row.id === service.followupCopyId('om_follow', b.id),
    );
    expect(copy).toMatchObject({
      content: '还有一个问题',
      source_jid: CHAT,
      source_kind: 'work_item_input',
    });
    expect(gate.readTeamInput(copy!.attachments)?.attrs).toContainEqual([
      'listed',
      'true',
    ]);
    expect(
      laneRows(`${WORKSPACE}#agent:${c.agentId}`).some((row) =>
        row.id.startsWith('om_follow'),
      ),
    ).toBe(false);

    // A replay of the same message changes nothing.
    const events = (id: string) =>
      store.listWorkEvents(id).filter((event) => event.kind === 'input');
    const before = [
      events(a.id).length,
      events(b.id).length,
      broadcasts.length,
    ];
    const copyStamp = copy!.timestamp;
    service.onTeamMessageStored(`${WORKSPACE}#agent:${a.agentId}`, 'om_follow');
    expect([
      events(a.id).length,
      events(b.id).length,
      broadcasts.length,
    ]).toEqual(before);
    expect(
      laneRows(`${WORKSPACE}#agent:${b.agentId}`).find(
        (row) => row.id === service.followupCopyId('om_follow', b.id),
      )?.timestamp,
    ).toBe(copyStamp);
    expect(
      store.listWorkEvents(b.id).filter((event) => event.kind === 'resume'),
    ).toHaveLength(1);

    // The follow-up was delivered to a, so a may acknowledge it.
    expect(
      await service.handleWorkIpc(workerCaller(a), {
        type: 'work_ack',
        triggerMessageId: 'om_follow',
        text: '看到了',
      }),
    ).toEqual({ ok: true, data: { duplicate: false } });
  });

  test('a reply reaches the items of the message it replies to only', async () => {
    storeCandidate('om_p1');
    const first = store.getWorkItem(
      (await accept('om_p1')).workItemId as string,
    )!;
    storeCandidate('om_p2');
    const second = store.getWorkItem(
      (await accept('om_p2')).workItemId as string,
    )!;
    // Both follow the thread; only the second subscribes the parent.
    store.subscribeWorkItem(first.id, CHAT, 'thread:omt_p', 'x');
    store.subscribeWorkItem(second.id, CHAT, 'thread:omt_p', 'x');
    const { decision } = storeFollowup('om_reply', {
      threadId: 'omt_p',
      parentId: 'om_p2',
    });
    expect(
      decision.kind === 'subscribed' && decision.items.map((i) => i.id),
    ).toEqual([second.id]);
  });

  test('a follow-up from an unlisted sender is marked so', async () => {
    storeCandidate('om_ul');
    await accept('om_ul');
    const { laneJid } = storeFollowup('om_ul2', {
      parentId: 'om_ul',
      sender: 'ou_stranger',
    });
    const row = laneRows(laneJid!).find((entry) => entry.id === 'om_ul2');
    expect(gate.readTeamInput(row!.attachments)?.attrs).toContainEqual([
      'listed',
      'false',
    ]);
  });

  test('a hand-back returns the follow-up to the router once, and replies to it stay away', async () => {
    storeCandidate('om_h');
    const item = store.getWorkItem(
      (await accept('om_h')).workItemId as string,
    )!;
    store.subscribeWorkItem(item.id, CHAT, 'thread:omt_h', 'x');
    storeFollowup('om_h2', { threadId: 'omt_h', parentId: 'om_h' });
    const handback = () =>
      service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_h2',
        reason: '不是这个工作项的事',
      });
    expect(await handback()).toEqual({ ok: true, data: {} });
    expect(await handback()).toEqual({ ok: true, data: {} });
    const handed = laneRows(routerLane()).filter(
      (row) => row.id === 'handback:om_h2',
    );
    expect(handed).toHaveLength(1);
    expect(gate.readTeamInput(handed[0].attachments)?.attrs).toContainEqual([
      'handed_back_by',
      `#${item.seq}`,
    ]);
    // A reply to the handed-back message no longer reaches the item, not
    // even through its thread.
    const { decision } = storeFollowup('om_h3', {
      threadId: 'omt_h',
      parentId: 'om_h2',
    });
    expect(decision.kind).not.toBe('subscribed');
    // The source request itself is not a follow-up.
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_h',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false });
  });

  test('a stopped item neither acknowledges nor hands back', async () => {
    storeCandidate('om_st');
    const item = store.getWorkItem(
      (await accept('om_st')).workItemId as string,
    )!;
    storeFollowup('om_st2', { parentId: 'om_st' });
    await service.stopWorkItem(item.id, ACTOR);
    expect(stopped).toContain(`${WORKSPACE}#agent:${item.agentId}`);
    for (const type of ['work_ack', 'work_handback']) {
      expect(
        await service.handleWorkIpc(workerCaller(item), {
          type,
          triggerMessageId: 'om_st2',
          text: 'x',
          reason: 'x',
        }),
      ).toEqual({ ok: false, error: 'This work item has ended.' });
    }
  });
});

describe('replies are durable and reconciled', () => {
  test('a reply is recorded before the tool returns and sent after a restart', async () => {
    storeCandidate('om_dur');
    // The channel is down: nothing reaches the group yet.
    failReplies = true;
    replyRetryable = true;
    const before = replies.length;
    const result = await service.handleWorkIpc(routerCaller(), {
      type: 'work_reply',
      purpose: 'answer',
      triggerMessageId: 'om_dur',
      text: '在 README 里',
    });
    expect(result).toEqual({ ok: true, data: { queued: true } });
    const id = `answer:${CHAT}:om_dur`;
    // Durable at once, before any send settled.
    expect(store.getWorkItemReply(id)).toMatchObject({ status: 'pending' });
    await service.settleTeamReplies();
    expect(replies.length).toBeGreaterThan(before);
    expect(store.getWorkItemReply(id)?.status).toBe('pending');
    // A restart finds it pending and sends it.
    failReplies = false;
    replyRetryable = false;
    service.resumePendingTeamReplies();
    await service.settleTeamReplies();
    expect(store.getWorkItemReply(id)).toMatchObject({
      status: 'delivered',
      providerMessageId: expect.stringMatching(/^om_bot_/),
    });
    // Each attempt is a new one of the same reply (same key, so Feishu
    // dedupes the re-sends by its uuid).
    const attempts = replies
      .slice(before)
      .filter((request) => request.deliveryKey === id)
      .map((request) => request.attempt);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts).toEqual(attempts.map((_, index) => attempts[0] + index));
  });

  test('a reply Feishu refuses for good puts a question on the item', async () => {
    storeCandidate('om_gone');
    const { workItemId } = await accept('om_gone');
    failReplies = true;
    await service.settleTeamReplies();
    const item = store.getWorkItem(workItemId as string)!;
    expect(store.getWorkItemReply('ack:om_gone')?.status).toBe('failed');
    expect(item.attention).toMatch(/确认没有发出/);
    const view = service
      .listWorkItemViews(WORKSPACE)
      .find((entry) => entry.id === item.id)!;
    expect(view.stage).toBe('answer');
  });

  test('a result is posted once per report and an answer once per candidate', async () => {
    storeCandidate('om_once');
    const { workItemId } = await accept('om_once');
    const item = store.getWorkItem(workItemId as string)!;
    const result = () =>
      service.handleWorkIpc(routerCaller(), {
        type: 'work_reply',
        purpose: 'result',
        workItemId: item.id,
        text: '做不了',
      });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'blocked',
      summary: '没权限',
    });
    expect(await result()).toMatchObject({ ok: true });
    expect(await result()).toMatchObject({ ok: false });
    // A new report may be answered again.
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'failed',
      summary: '还是不行',
    });
    expect(await result()).toMatchObject({ ok: true });

    storeCandidate('om_ask2');
    const answer = () =>
      service.handleWorkIpc(routerCaller(), {
        type: 'work_reply',
        purpose: 'answer',
        triggerMessageId: 'om_ask2',
        text: '答',
      });
    expect(await answer()).toMatchObject({ ok: true });
    expect(await answer()).toMatchObject({ ok: false });
  });

  test('a long text is refused by characters as well as words', async () => {
    storeCandidate('om_chars');
    const result = await service.handleWorkIpc(routerCaller(), {
      type: 'work_reply',
      purpose: 'answer',
      triggerMessageId: 'om_chars',
      text: 'a'.repeat(700),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/characters/);
  });

  test("a reply to a worker's acknowledgement addresses the bot", async () => {
    storeCandidate('om_wack');
    const item = store.getWorkItem(
      (await accept('om_wack')).workItemId as string,
    )!;
    storeFollowup('om_wack2', { parentId: 'om_wack' });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_ack',
      triggerMessageId: 'om_wack2',
      text: '收到',
    });
    await service.settleTeamReplies();
    const posted = store.getWorkItemReply('ack:om_wack2')!.providerMessageId!;
    expect(
      service.isTeamBotMessage(service.resolveTeamGroup(CHAT)!, posted),
    ).toBe(true);
  });
});

describe('attach', () => {
  test('an ended item whose listed requester left is not resumed by an attach', async () => {
    storeCandidate('om_att0');
    const item = store.getWorkItem(
      (await accept('om_att0')).workItemId as string,
    )!;
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: 'done',
    });
    expect(store.getWorkItem(item.id)?.status).toBe('ended');
    // The requester (ou_listed) leaves the allowlist.
    setGroup(CHAT, { sender_allowlist: [] });
    storeCandidate('om_att1', { sender: 'ou_owner' });
    const attach = (trigger: string) =>
      route({ kind: 'attach', triggerMessageId: trigger, workItemId: item.id });
    const refused = await attach('om_att1');
    expect(
      (refused as { data: { results: { ok: boolean; error?: string }[] } }).data
        .results[0],
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer listed/),
    });
    expect(store.getWorkItem(item.id)?.status).toBe('ended');
    // Listed again: the attach resumes it.
    setGroup(CHAT);
    expect(await attach('om_att1')).toMatchObject({
      data: { results: [{ ok: true, decision: 'attach' }] },
    });
    expect(store.getWorkItem(item.id)?.status).toBe('open');
  });
});

describe('team mode going away', () => {
  test('a worker of a group whose team mode is off can no longer act, and its items stop', async () => {
    storeCandidate('om_off');
    const item = store.getWorkItem(
      (await accept('om_off')).workItemId as string,
    )!;
    const settings = store.getTeamMount(CHAT)!.settings;
    await service.saveTeamMountSettings(
      WORKSPACE,
      CHAT,
      { ...settings, enabled: false },
      ACTOR,
    );
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(store.listWorkEvents(item.id).at(-1)).toMatchObject({
      kind: 'stop',
      text: 'team_mode_off',
    });
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_report',
        state: 'progress',
        summary: 'x',
      }),
    ).toEqual({ ok: false, error: 'Team mode is off for this group.' });
    await enable();
  });

  test('a report made while the router is gone reaches the next router', async () => {
    storeCandidate('om_norouter');
    const item = store.getWorkItem(
      (await accept('om_norouter')).workItemId as string,
    )!;
    const team = store.getTeamMount(CHAT)!;
    const { deleteConversationSession } =
      await import('../src/session-factory.js');
    await deleteConversationSession({
      workspaceJid: WORKSPACE,
      group: db.getRegisteredGroup(WORKSPACE)!,
      session: db.getAgent(team.routerAgentId!)!,
    });
    // The worker can still report while its group runs team mode.
    store.saveTeamMountSettings({
      channelJid: CHAT,
      workspaceJid: WORKSPACE,
      settings: team.settings,
      routerAgentId: null,
      updatedBy: null,
      now: new Date().toISOString(),
    });
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_report',
        state: 'blocked',
        summary: '复现了',
      }),
    ).toEqual({ ok: true, data: {} });
    expect(store.listWorkEvents(item.id).at(-1)).toMatchObject({
      kind: 'report',
      state: 'undelivered',
    });
    await enable();
    const reports = laneRows(routerLane()).filter(
      (row) => gate.readTeamInput(row.attachments)?.tag === 'work_report',
    );
    expect(reports.map((row) => row.content)).toContain('复现了');
  });
});

describe('replies after review', () => {
  test('a failed reply keeps an open question and asks nothing of an ended item', async () => {
    storeCandidate('om_q1');
    const item = store.getWorkItem(
      (await accept('om_q1')).workItemId as string,
    )!;
    await service.settleTeamReplies();
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'waiting',
      summary: '要确认',
      humanAction: '用哪个分支？',
      questionForMessageId: 'om_q1',
    });
    failReplies = true;
    await service.handleWorkIpc(routerCaller(), {
      type: 'work_reply',
      purpose: 'attention',
      workItemId: item.id,
      text: '用哪个分支？',
    });
    await service.settleTeamReplies();
    expect(store.getWorkItem(item.id)).toMatchObject({
      attention: '用哪个分支？',
      attentionMessageId: 'om_q1',
    });
    expect(store.listWorkEvents(item.id).at(-1)).toMatchObject({
      kind: 'reply',
      state: 'failed',
    });

    failReplies = false;
    storeCandidate('om_q2');
    const ended = store.getWorkItem(
      (await accept('om_q2')).workItemId as string,
    )!;
    await service.settleTeamReplies();
    await service.handleWorkIpc(workerCaller(ended), {
      type: 'work_report',
      state: 'ready',
      summary: '好了',
    });
    failReplies = true;
    await service.handleWorkIpc(routerCaller(), {
      type: 'work_reply',
      purpose: 'result',
      workItemId: ended.id,
      text: '好了',
    });
    await service.settleTeamReplies();
    expect(store.getWorkItem(ended.id)).toMatchObject({
      status: 'ended',
      attention: null,
    });
  });

  test('a reply of a group whose team mode went off is voided, not sent', async () => {
    storeCandidate('om_void');
    // The channel is down, so the acknowledgement waits for a retry.
    failReplies = true;
    replyRetryable = true;
    await accept('om_void');
    await service.settleTeamReplies();
    expect(store.getWorkItemReply('ack:om_void')?.status).toBe('pending');
    const settings = store.getTeamMount(CHAT)!.settings;
    await service.saveTeamMountSettings(
      WORKSPACE,
      CHAT,
      { ...settings, enabled: false },
      ACTOR,
    );
    expect(store.getWorkItemReply('ack:om_void')).toMatchObject({
      status: 'failed',
      error: 'team_mode_off',
    });
    // A reply still pending is not sent once its group left team mode.
    failReplies = false;
    replyRetryable = false;
    store.insertWorkItemReply({
      id: 'answer:late',
      workspaceJid: WORKSPACE,
      workItemId: null,
      channelJid: CHAT,
      quoteMessageId: 'om_void',
      text: '迟到的回答',
      purpose: 'answer',
      laneJid: routerLane(),
      now: new Date().toISOString(),
    });
    const before = replies.length;
    service.resumePendingTeamReplies();
    await service.settleTeamReplies();
    expect(replies.length).toBe(before);
    expect(store.getWorkItemReply('answer:late')?.status).toBe('failed');
    await enable();
  });

  test('a ready report made while the router was gone can be answered by the next router', async () => {
    storeCandidate('om_rr');
    const item = store.getWorkItem(
      (await accept('om_rr')).workItemId as string,
    )!;
    await service.settleTeamReplies();
    const team = store.getTeamMount(CHAT)!;
    store.saveTeamMountSettings({
      channelJid: CHAT,
      workspaceJid: WORKSPACE,
      settings: team.settings,
      routerAgentId: null,
      updatedBy: null,
      now: new Date().toISOString(),
    });
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '改好了',
    });
    expect(store.listWorkEvents(item.id).at(-1)?.state).toBe('undelivered');
    await enable();
    expect(
      await service.handleWorkIpc(routerCaller(), {
        type: 'work_reply',
        purpose: 'result',
        workItemId: item.id,
        text: '改好了',
      }),
    ).toEqual({ ok: true, data: { queued: true } });
  });

  test('chat metadata going missing pauses routing without stopping anything', async () => {
    storeCandidate('om_unk');
    const item = store.getWorkItem(
      (await accept('om_unk')).workItemId as string,
    )!;
    setGroup(CHAT, { feishu_chat_mode: undefined });
    expect(service.resolveTeamGroup(CHAT)).toBeNull();
    service.reconcileTeamGroup(CHAT);
    expect(store.getWorkItem(item.id)?.status).toBe('open');
    // A real rebind (a topic group now) stops the group's items.
    setGroup(CHAT, { feishu_chat_mode: 'topic' });
    service.reconcileTeamGroup(CHAT);
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    setGroup(CHAT);
  });
});

describe('IPC a team session may not use', () => {
  test('of the Feishu capabilities only the reads are allowed', () => {
    for (const read of [
      'get_chat',
      'list_members',
      'get_user',
      'get_history',
    ]) {
      expect(service.teamIpcRefusal('feishu_capability', read)).toBeNull();
    }
    for (const write of [
      'send_card',
      'api_request',
      'edit_message',
      'recall_message',
      'add_reaction',
      'reply_text',
      undefined,
    ]) {
      expect(service.teamIpcRefusal('feishu_capability', write)).toMatch(
        /work tools/,
      );
    }
    expect(service.teamIpcRefusal('send_file', undefined)).toMatch(
      /work tools/,
    );
    for (const type of [
      'automation_create',
      'automation_list',
      'install_skill',
      'uninstall_skill',
      'message',
      'image',
      'schedule_task',
    ]) {
      expect(service.teamIpcRefusal(type, undefined)).toMatch(/work tools/);
    }
    for (const type of ['work_report', 'workspace_memory', 'fresh_window']) {
      expect(service.teamIpcRefusal(type, undefined)).toBeNull();
    }
    expect(service.teamIpcRefusal('workspace_memory', undefined)).toBeNull();
  });
});

describe('recall', () => {
  test('recalling a follow-up withdraws its copies and its hand-back', async () => {
    storeCandidate('om_rc');
    await accept('om_rc');
    const { laneJid } = storeFollowup('om_rc2', { parentId: 'om_rc' });
    const row = laneRows(laneJid!).find((entry) => entry.id === 'om_rc2')!;
    expect(
      service.followupCopyIdsOf(CHAT, 'om_rc2', row.attachments),
    ).toContain('handback:om_rc2');
  });
});

describe('after the review on the Mac mini', () => {
  test('a planned lane holds only while its item and router do', async () => {
    storeCandidate('om_hold');
    const item = store.getWorkItem(
      (await accept('om_hold')).workItemId as string,
    )!;
    const lane = {
      effectiveJid: `${WORKSPACE}#agent:${item.agentId}`,
      agentId: item.agentId,
    };
    const router = store.getTeamMount(CHAT)!.routerAgentId!;
    const routerLaneRoute = {
      effectiveJid: `${WORKSPACE}#agent:${router}`,
      agentId: router,
    };
    expect(service.teamRouteStillHolds(CHAT, lane)).toBe(true);
    expect(service.teamRouteStillHolds(CHAT, routerLaneRoute)).toBe(true);
    expect(
      service.teamRouteStillHolds(CHAT, { effectiveJid: 'x', agentId: 'gone' }),
    ).toBe(false);
    await service.stopWorkItem(item.id, ACTOR);
    expect(service.teamRouteStillHolds(CHAT, lane)).toBe(false);
    const settings = store.getTeamMount(CHAT)!.settings;
    await service.saveTeamMountSettings(
      WORKSPACE,
      CHAT,
      { ...settings, enabled: false },
      ACTOR,
    );
    expect(service.teamRouteStillHolds(CHAT, routerLaneRoute)).toBe(false);
    expect(service.teamRouteStillHolds(CHAT, 'reject')).toBe(false);
    await enable();
  });

  test('rebinding the group to another session of the workspace keeps team mode', async () => {
    storeCandidate('om_rebind_session');
    const item = store.getWorkItem(
      (await accept('om_rebind_session')).workItemId as string,
    )!;
    db.setChannelMountChangeListener(service.reconcileTeamGroup);
    try {
      setGroup(CHAT, { target_agent_id: OTHER_SESSION });
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.resolveTeamGroup(CHAT)).not.toBeNull();
      expect(store.getWorkItem(item.id)?.status).toBe('open');
    } finally {
      db.setChannelMountChangeListener(null);
      setGroup(CHAT);
    }
  });

  test('deleting the session the group is bound to ends team mode there; a rebind keeps it', async () => {
    const { deleteConversationSession } =
      await import('../src/session-factory.js');
    const mounts = await import('../src/channel-mount-service.js');
    const remove = (id: string) =>
      deleteConversationSession({
        workspaceJid: WORKSPACE,
        group: db.getRegisteredGroup(WORKSPACE)!,
        session: db.getAgent(id)!,
      });
    db.setChannelMountChangeListener(service.reconcileTeamGroup);
    try {
      // Rebound first, as DELETE ?rebind_to does: the items keep running.
      createSession('team-doomed-a', 'completed');
      setGroup(CHAT, { target_agent_id: 'team-doomed-a' });
      storeCandidate('om_del_rebind');
      const kept = store.getWorkItem(
        (await accept('om_del_rebind')).workItemId as string,
      )!;
      mounts.commitChannelMountUpdates([
        [
          CHAT,
          mounts.buildSessionMountUpdate(
            db.getRegisteredGroup(CHAT)!,
            OTHER_SESSION,
          ),
        ],
      ]);
      remove('team-doomed-a');
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.resolveTeamGroup(CHAT)).not.toBeNull();
      expect(store.getWorkItem(kept.id)?.status).toBe('open');

      // Deleted without a rebind: the group is unbound and its items stop.
      createSession('team-doomed-b', 'completed');
      setGroup(CHAT, { target_agent_id: 'team-doomed-b' });
      storeCandidate('om_del_unbind');
      const stopped = store.getWorkItem(
        (await accept('om_del_unbind')).workItemId as string,
      )!;
      remove('team-doomed-b');
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.getRegisteredGroup(CHAT)?.target_agent_id).toBeUndefined();
      expect(db.getChannelMount(CHAT)).toBeUndefined();
      expect(store.getWorkItem(stopped.id)).toMatchObject({
        status: 'ended',
        outcome: 'stopped',
      });
    } finally {
      db.setChannelMountChangeListener(null);
      setGroup(CHAT);
    }
  });

  test('a binding change reconciles the group', async () => {
    storeCandidate('om_rebind');
    const item = store.getWorkItem(
      (await accept('om_rebind')).workItemId as string,
    )!;
    db.setChannelMountChangeListener(service.reconcileTeamGroup);
    try {
      // The IM /bind and auto-unbind write the group the same way.
      setGroup(CHAT, { feishu_chat_mode: 'topic' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getWorkItem(item.id)).toMatchObject({
        status: 'ended',
        outcome: 'stopped',
      });
    } finally {
      db.setChannelMountChangeListener(null);
      setGroup(CHAT);
    }
  });

  test('handing back the message that resumed a finished item ends it as it was', async () => {
    storeCandidate('om_done');
    const item = store.getWorkItem(
      (await accept('om_done')).workItemId as string,
    )!;
    await service.handleWorkIpc(workerCaller(item), {
      type: 'work_report',
      state: 'ready',
      summary: '好了',
    });
    expect(store.getWorkItem(item.id)?.outcome).toBe('completed');
    storeFollowup('om_later', { parentId: 'om_done' });
    expect(store.getWorkItem(item.id)?.status).toBe('open');
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_later',
        reason: '不是这个工作项的事',
      }),
    ).toEqual({ ok: true, data: {} });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'completed',
    });
    expect(store.listWorkEvents(item.id).at(-1)).toMatchObject({
      kind: 'resume',
      state: 'undone',
    });
  });
});

describe('a hand-back keeps the facts of the message as it arrived', () => {
  test("the owner's reply to the bot's message is handed back as an explicit request", async () => {
    storeCandidate('om_res2');
    const item = store.getWorkItem(
      (await accept('om_res2')).workItemId as string,
    )!;
    await service.settleTeamReplies();
    const botMessage =
      store.getWorkItemReply('ack:om_res2')!.providerMessageId!;
    // A reply to the bot's message, no @: addressed by its parent.
    storeFollowup('om_notes', { parentId: botMessage, sender: 'ou_owner' });
    expect(
      await service.handleWorkIpc(workerCaller(item), {
        type: 'work_handback',
        triggerMessageId: 'om_notes',
        reason: '新的需求',
      }),
    ).toEqual({ ok: true, data: {} });
    const handed = laneRows(routerLane()).find(
      (row) => row.id === 'handback:om_notes',
    )!;
    expect(gate.readTeamInput(handed.attachments)).toMatchObject({
      facts: { strength: 'explicit', listed: true, addressed: true },
    });
  });
});

describe('an inferred request split across a host-selected batch', () => {
  test('the worker receives the client context and deadline without widening its mandate', async () => {
    await enable();
    const ids = ['om_split_context', 'om_split_action', 'om_split_deadline'];
    const text = ['刚才那个客户诉求', '谁去跟进一下', '今天下班前搞定'];
    for (const [index, id] of ids.entries()) {
      storeCandidate(id, {
        strength: 'inferred',
        listed: false,
        content: text[index],
      });
      const row = db.getAgentBuilderInputMessage(routerLane(), id)!;
      const header = gate.readTeamInput(row.attachments)!;
      db.updateMessageAttachments(
        routerLane(),
        id,
        gate.withTeamInputAttachment(row.attachments, {
          ...header,
          facts: { ...header.facts, candidateBatchIds: ids },
        }),
      );
    }
    const result = await accept(ids[1], {
      ruleAssessments: [
        { ruleId: 'r1', matched: true, reason: '客户跟进' },
        { ruleId: 'r2', matched: false, reason: '不是文档' },
      ],
    });
    const item = store.getWorkItem(result.workItemId as string)!;
    const assignment = laneRows(`${WORKSPACE}#agent:${item.agentId}`).find(
      (row) => row.id.startsWith('work-assignment-'),
    )!;
    for (const fragment of text) expect(assignment.content).toContain(fragment);
    expect(item.mandate.strength).toBe('inferred');
    expect(item.mandate.writable).toBe(false);
  });
});

describe('session deletion', () => {
  test('deleting a worker session ends its item', async () => {
    storeCandidate('om_del');
    const item = store.getWorkItem(
      (await accept('om_del')).workItemId as string,
    )!;
    broadcasts.length = 0;
    const { deleteConversationSession } =
      await import('../src/session-factory.js');
    await deleteConversationSession({
      workspaceJid: WORKSPACE,
      group: db.getRegisteredGroup(WORKSPACE)!,
      session: db.getAgent(item.agentId)!,
    });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(broadcasts).toContain(item.id);
  });

  test('a deletion that rolls back leaves its item open and unannounced', async () => {
    storeCandidate('om_del_rollback');
    const item = store.getWorkItem(
      (await accept('om_del_rollback')).workItemId as string,
    )!;
    broadcasts.length = 0;
    const { deleteConversationSession } =
      await import('../src/session-factory.js');
    const ledger = await import('../src/automation-run-ledger.js');
    // The last write of the deletion fails.
    ledger.setAutomationRuntimeService({
      onSessionDeleted: () => {
        throw new Error('a later step failed');
      },
    } as never);
    try {
      expect(() =>
        deleteConversationSession({
          workspaceJid: WORKSPACE,
          group: db.getRegisteredGroup(WORKSPACE)!,
          session: db.getAgent(item.agentId)!,
        }),
      ).toThrow('a later step failed');
    } finally {
      ledger.setAutomationRuntimeService(null);
    }
    expect(store.getWorkItem(item.id)?.status).toBe('open');
    expect(broadcasts).not.toContain(item.id);
  });
});
