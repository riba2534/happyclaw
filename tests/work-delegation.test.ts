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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-delegation-'));

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
// The billing gate the host applies before any run, toggled per test.
let billingAllowed = true;
vi.mock('../src/billing.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  checkBillingAccessFresh: () => ({ allowed: billingAllowed }),
}));
// A delegated worker shares its session's directory: no worktree, ever.
const createSessionWorktree = vi.fn();
vi.mock('../src/session-worktree.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createSessionWorktree: (...args: unknown[]) => createSessionWorktree(...args),
}));

const db = await import('../src/db.js');
const store = await import('../src/work-item-store.js');
const service = await import('../src/work-item-service.js');
const runtime = await import('../src/work-item-runtime.js');
const gate = await import('../src/team-gate.js');
const replySource = await import('../src/channel-reply-source.js');
const sessions = await import('../src/session-factory.js');
const webContext = await import('../src/web-context.js');
const worktreeStore = await import('../src/session-worktree-store.js');

import type { ChannelTurnContext, NewMessage } from '../src/types.js';
import type { WorkItem } from '../src/work-items.js';

const OWNER = 'mt-owner';
const WORKSPACE = 'web:mt-ws';
const FOLDER = 'mt-ws';
const SINGLE_WORKSPACE = 'web:st-ws';
const SINGLE_FOLDER = 'st-ws';
const MAIN = 'mt-main';
const MAIN_2 = 'mt-main-2';
const SINGLE_MAIN = 'st-main';
const TOPIC_JID = 'feishu:oc_topicgroup#acct:acct-1#thread:omt_77';

const laneOf = (agentId: string, workspace = WORKSPACE) =>
  `${workspace}#agent:${agentId}`;

const stopped: string[] = [];
const broadcasts: string[] = [];
const laneMessages: { laneJid: string; text: string; id: string }[] = [];
const wake = vi.fn();
/** Every admission throws: a delegation fails half way. */
let failAdmissions = false;
/** Runs once, as the next session is created. */
let duringSessionCreation: (() => void) | null = null;

function installHooks(): void {
  runtime.setWorkItemRuntimeHooks({
    admitInput: () => {
      if (failAdmissions) throw new Error('queue unavailable');
      return 'started';
    },
    wake,
    broadcastNewMessage: vi.fn(),
    stopLane: (laneJid) => stopped.push(laneJid),
    drainLane: vi.fn(),
    postReply: async () => ({ ok: true, providerMessageId: null }),
    postLaneMessage: async (laneJid, text, id) => {
      laneMessages.push({ laneJid, text, id });
    },
    broadcastWorkItemEvent: (event) => broadcasts.push(event.item.id),
  });
}

function createSession(
  id: string,
  extra: {
    workspace?: string;
    folder?: string;
    kind?: 'conversation' | 'spawn';
    source_kind?: string;
  } = {},
): void {
  db.createAgent({
    id,
    group_folder: extra.folder ?? FOLDER,
    chat_jid: extra.workspace ?? WORKSPACE,
    name: `会话 ${id}`,
    prompt: '',
    status: 'idle',
    kind: extra.kind ?? 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    ...(extra.source_kind ? { source_kind: extra.source_kind } : {}),
  } as never);
}

let inputSeq = 0;
/** An input the owner typed in a session (Web unless routed elsewhere). */
function ownerInput(
  agentId: string,
  route: { sourceJid?: string; channelContext?: ChannelTurnContext } = {},
): { chatJid: string; messageId: string } {
  const chatJid = laneOf(agentId);
  const messageId = `in-${++inputSeq}`;
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    messageId,
    chatJid,
    OWNER,
    '老板',
    '帮我把这件事派出去',
    new Date(Date.now() + inputSeq).toISOString(),
    false,
    route,
  );
  return { chatJid, messageId };
}

/**
 * The caller as the host builds it: an owner turn answering `origin`, or
 * (null) a turn the owner did not start.
 */
function callerOf(
  agentId: string,
  origin: { chatJid: string; messageId: string } | null = ownerInput(agentId),
  folder = FOLDER,
) {
  return {
    folder,
    agentId,
    ownerTurn: vi.fn(() => (origin ? { input: origin } : null)),
  };
}

async function delegate(
  caller: ReturnType<typeof callerOf>,
  extra: Record<string, unknown> = {},
) {
  return service.handleWorkIpc(caller, {
    type: 'work_delegate',
    title: '调研竞品',
    task: '整理三家竞品的定价',
    inputTurnId: 'turn-1',
    ...extra,
  });
}

async function delegateOk(
  agentId = MAIN,
  extra: Record<string, unknown> = {},
  origin?: { chatJid: string; messageId: string },
): Promise<WorkItem> {
  const result = await delegate(
    callerOf(agentId, origin ?? ownerInput(agentId)),
    extra,
  );
  expect(result).toMatchObject({ ok: true });
  const { workItemId } = (result as { data: { workItemId: string } }).data;
  return store.getWorkItem(workItemId)!;
}

function report(item: WorkItem, state: string, summary = '做完了') {
  return service.handleWorkIpc(
    { folder: FOLDER, agentId: item.agentId },
    { type: 'work_report', state, summary },
  );
}

function rows(laneJid: string): NewMessage[] {
  return db.getMessagesSince(laneJid, { timestamp: '', id: '' });
}

/** The work_report inputs a session received, oldest first. */
function reportsIn(agentId: string): NewMessage[] {
  return rows(laneOf(agentId)).filter(
    (row) =>
      row.source_kind === 'work_item_input' &&
      gate.readTeamInput(row.attachments)?.tag === 'work_report',
  );
}

function attrsOf(row: NewMessage): Record<string, string | null> {
  return Object.fromEntries(gate.readTeamInput(row.attachments)!.attrs);
}

/** End every open delegated item, so each test starts under the limits. */
function settleOpenItems(): void {
  for (const item of store.listOpenDelegatedWorkItems()) {
    store.updateWorkItem(
      item.id,
      {
        status: 'ended',
        outcome: 'completed',
        endedAt: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
  }
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER,
    username: OWNER,
    password_hash: 'hash',
    display_name: '老板',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  const profile = db.getOrCreateDefaultAgentProfile(OWNER);
  for (const [jid, folder, mode] of [
    [WORKSPACE, FOLDER, 'host'],
    [SINGLE_WORKSPACE, SINGLE_FOLDER, 'container'],
  ] as const) {
    db.setRegisteredGroup(jid, {
      name: folder,
      folder,
      added_at: now,
      executionMode: mode,
      created_by: OWNER,
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);
  }
  db.setWorkspaceWorkMode(FOLDER, 'multi');
  createSession(MAIN);
  createSession(MAIN_2);
  createSession(SINGLE_MAIN, {
    workspace: SINGLE_WORKSPACE,
    folder: SINGLE_FOLDER,
  });
  webContext.setWebDeps({
    // A new session announces itself: a test may act right then, while the
    // delegation that made it awaits it.
    broadcastAgentStatus: vi.fn(() => {
      const step = duringSessionCreation;
      duringSessionCreation = null;
      step?.();
    }),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  installHooks();
});

beforeEach(() => {
  settleOpenItems();
  stopped.length = 0;
  broadcasts.length = 0;
  laneMessages.length = 0;
  billingAllowed = true;
  failAdmissions = false;
  db.setWorkspaceWorkMode(FOLDER, 'multi');
  createSessionWorktree.mockClear();
  wake.mockClear();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('work_delegate', () => {
  test('creates the item and its worker session, without a worktree, and assigns the task', async () => {
    const origin = ownerInput(MAIN);
    const caller = callerOf(MAIN, origin);
    const result = await delegate(caller, {
      context: '用户关心价格带',
      files: ['docs/pricing.md', ' src/a.ts '],
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { workItemId: string; seq: number } }).data;
    // The Runner's inputTurnId reaches the host's owner-turn lookup.
    expect(caller.ownerTurn).toHaveBeenCalledWith('turn-1');
    const item = store.getWorkItem(data.workItemId)!;
    expect(data.seq).toBe(item.seq);
    expect(item).toMatchObject({
      origin: 'delegated',
      originAgentId: MAIN,
      originInputId: origin.messageId,
      channelJid: laneOf(MAIN),
      sourceRouteJid: laneOf(MAIN),
      status: 'open',
      title: '调研竞品',
      mandate: {
        strength: 'explicit',
        requesterImId: null,
        requesterName: '老板',
        requesterListed: true,
        requesterIsOwner: true,
        matchedRules: [],
        settingsVersion: 0,
        writable: true,
      },
    });
    expect(item.sourceMessageId).toMatch(/^delegate:[0-9a-f-]{36}$/);
    expect(db.getAgent(item.agentId)).toMatchObject({
      kind: 'conversation',
      source_kind: 'work_item',
      chat_jid: WORKSPACE,
      name: '调研竞品',
    });
    // A host workspace, and still no worktree: it shares MAIN's directory.
    expect(createSessionWorktree).not.toHaveBeenCalled();
    expect(service.teamLaneOf(db.getAgent(item.agentId))).toEqual({
      role: 'worker',
      workItemId: item.id,
      writable: true,
      origin: 'delegated',
    });

    const [assignment] = rows(laneOf(item.agentId));
    expect(assignment).toMatchObject({
      id: `work-assignment-${item.id}`,
      source_kind: 'work_item_input',
      content:
        '整理三家竞品的定价\n\n## 背景\n用户关心价格带\n\n## 相关文件\n- docs/pricing.md\n- src/a.ts',
    });
    expect(gate.readTeamInput(assignment.attachments)).toMatchObject({
      tag: 'work_assignment',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['origin', 'delegated'],
        ['writable', 'true'],
      ],
    });
    expect(
      gate.teamInputFrameOf({
        sender_name: 'HappyClaw',
        attachments: assignment.attachments ?? undefined,
      }),
    ).toEqual({
      before: `<work_assignment item="#${item.seq}" id="${item.id}" origin="delegated" writable="true"/>\n<request>`,
      after: '</request>',
    });
    expect(wake).toHaveBeenCalledWith(WORKSPACE, item.agentId);
    expect(broadcasts).toContain(item.id);
    // The task itself is the item's request in its timeline.
    expect(store.listWorkEvents(item.id)).toEqual([
      expect.objectContaining({ kind: 'input', text: '整理三家竞品的定价' }),
    ]);
  });

  test('the task alone when no background or files are given', async () => {
    const item = await delegateOk();
    expect(rows(laneOf(item.agentId))[0].content).toBe('整理三家竞品的定价');
  });

  test('a single-task workspace refuses', async () => {
    const result = await delegate(callerOf(SINGLE_MAIN, null, SINGLE_FOLDER));
    expect(result).toEqual({
      ok: false,
      error: '当前工作区是单任务模式，不能派出后台任务；请在当前会话里完成。',
    });
  });

  test('a turn the owner did not start refuses, as does one of another session', async () => {
    const notOwner = {
      ok: false,
      error:
        '只有工作区主人亲自发起的对话可以派出后台任务；请在当前会话里完成。',
    };
    expect(await delegate(callerOf(MAIN, null))).toEqual(notOwner);
    // An owner turn of another session lends nothing.
    expect(await delegate(callerOf(MAIN, ownerInput(MAIN_2)))).toEqual(
      notOwner,
    );
    // A caller the host built without the lookup refuses too.
    expect(
      await service.handleWorkIpc(
        { folder: FOLDER, agentId: MAIN },
        { type: 'work_delegate', title: 't', task: 'x' },
      ),
    ).toEqual(notOwner);
    expect(store.listOpenDelegatedWorkItems()).toEqual([]);
  });

  test('three open items per session and five per workspace', async () => {
    const limit = {
      ok: false,
      error:
        '后台任务已达上限（每个会话最多 3 个、每个工作区最多 5 个同时进行）；请等已有任务完成，或在当前会话里完成。',
    };
    for (let i = 0; i < 3; i++) await delegateOk(MAIN);
    expect(await delegate(callerOf(MAIN))).toEqual(limit);
    // Another session still may, up to the workspace's five.
    await delegateOk(MAIN_2);
    await delegateOk(MAIN_2);
    expect(await delegate(callerOf(MAIN_2))).toEqual(limit);
    // An ended item frees its place.
    const [first] = store.listOpenDelegatedWorkItems(MAIN);
    await report(first, 'ready');
    await delegateOk(MAIN_2);
  });

  test('concurrent calls do not pass the limit together', async () => {
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(() => delegate(callerOf(MAIN))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(store.countOpenDelegatedWorkItems({ originAgentId: MAIN })).toBe(3);
  });

  test('billing that does not allow a run refuses', async () => {
    billingAllowed = false;
    expect(await delegate(callerOf(MAIN))).toEqual({
      ok: false,
      error: '当前额度不足，不能派出后台任务。',
    });
    expect(store.listOpenDelegatedWorkItems()).toEqual([]);
  });

  test('team sessions, workers and spawned agents may not delegate', async () => {
    createSession('mt-router', { source_kind: 'team_router' });
    createSession('mt-team-worker', { source_kind: 'work_item' });
    createSession('mt-spawn', { kind: 'spawn' });
    const delegated = await delegateOk();
    for (const agentId of [
      'mt-router',
      'mt-team-worker',
      'mt-spawn',
      delegated.agentId,
    ]) {
      for (const type of [
        'work_delegate',
        'work_delegations',
        'work_stop',
        'work_followup',
      ]) {
        expect(
          await service.handleWorkIpc(callerOf(agentId), {
            type,
            title: 't',
            task: 'x',
            item: `#${delegated.seq}`,
            message: 'm',
          }),
        ).toEqual({
          ok: false,
          error:
            'Only an ordinary session of a multi-task workspace can use this tool.',
        });
      }
    }
  });

  test('a caller of another folder is refused', async () => {
    expect(
      await delegate(callerOf(MAIN, ownerInput(MAIN), SINGLE_FOLDER)),
    ).toMatchObject({ ok: false });
  });

  test('the request is checked against the limits', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ title: '' }, 'title is required.'],
      [{ title: 'x'.repeat(61) }, 'title is limited to 60 characters.'],
      [{ task: '   ' }, 'task is required.'],
      [{ task: 'x'.repeat(8001) }, 'task is limited to 8000 characters.'],
      [{ context: 'x'.repeat(8001) }, 'context is limited to 8000 characters.'],
      [{ files: 'a.ts' }, 'files must be a list of paths.'],
      [
        { files: Array.from({ length: 51 }, (_, i) => `f${i}`) },
        'files is limited to 50 paths.',
      ],
    ];
    for (const [extra, error] of cases) {
      expect(await delegate(callerOf(MAIN), extra)).toEqual({
        ok: false,
        error,
      });
    }
  });
});

describe('the runner of a session', () => {
  test('gets workMode=multi only as an ordinary session of a multi-task workspace', () => {
    const conversation = {
      id: 'fresh-session',
      kind: 'conversation' as const,
      source_kind: 'manual',
    };
    expect(service.runnerWorkMode(conversation, FOLDER)).toBe('multi');
    expect(
      service.runnerWorkMode(
        {
          id: 'fresh-legacy',
          kind: 'conversation',
          source_kind: 'legacy_main',
        },
        FOLDER,
      ),
    ).toBe('multi');
    expect(service.runnerWorkMode(conversation, SINGLE_FOLDER)).toBeUndefined();
    for (const agent of [
      { id: 'r', kind: 'conversation' as const, source_kind: 'team_router' },
      { id: 'w', kind: 'conversation' as const, source_kind: 'work_item' },
      { id: 's', kind: 'spawn' as const, source_kind: 'manual' },
    ]) {
      expect(service.runnerWorkMode(agent, FOLDER)).toBeUndefined();
    }
  });
});

describe('work_delegations', () => {
  test("lists this session's open items, newest first", async () => {
    const older = await delegateOk(MAIN, { title: '较早' });
    const newer = await delegateOk(MAIN, { title: '较新' });
    const ended = await delegateOk(MAIN, { title: '已完成' });
    await report(ended, 'ready');
    await delegateOk(MAIN_2, { title: '别的会话' });
    await report(older, 'blocked', '需要你确认预算');
    const result = await service.handleWorkIpc(callerOf(MAIN), {
      type: 'work_delegations',
    });
    expect(result).toEqual({
      ok: true,
      data: [
        {
          workItemId: newer.id,
          seq: newer.seq,
          title: '较新',
          stage: 'working',
          lastReport: null,
          lastSummary: null,
          createdAt: newer.createdAt,
        },
        {
          workItemId: older.id,
          seq: older.seq,
          title: '较早',
          stage: 'answer',
          lastReport: 'blocked',
          lastSummary: '需要你确认预算',
          createdAt: older.createdAt,
        },
      ],
    });
  });
});

describe('a delegated worker reports to its session', () => {
  test('progress only updates the item', async () => {
    const item = await delegateOk();
    expect(await report(item, 'progress', '查到一半')).toEqual({
      ok: true,
      data: {},
    });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'open',
      lastReport: 'progress',
      lastSummary: '查到一半',
    });
    expect(reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id)).toEqual(
      [],
    );
  });

  test('ready ends it completed and reaches the delegating session', async () => {
    const item = await delegateOk();
    expect(await report(item, 'ready', '三家都整理好了')).toMatchObject({
      ok: true,
    });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'completed',
      lastReport: 'ready',
    });
    const event = store
      .listWorkEvents(item.id)
      .find((e) => e.kind === 'report')!;
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(input).toMatchObject({
      id: `work-report-${item.id}-${event.id}`,
      content: '三家都整理好了',
      source_kind: 'work_item_input',
    });
    expect(gate.readTeamInput(input.attachments)?.attrs).toEqual([
      ['item', `#${item.seq}`],
      ['id', item.id],
      ['title', '调研竞品'],
      ['state', 'ready'],
    ]);
    // The worker's own transcript shows the report.
    expect(laneMessages).toContainEqual({
      laneJid: laneOf(item.agentId),
      text: '三家都整理好了',
      id: `work-report-${item.id}-${event.id}`,
    });
    // Its worker can report nothing more.
    expect(await report(item, 'progress')).toEqual({
      ok: false,
      error: 'This work item has ended.',
    });
  });

  test('blocked stays open with the question as its attention', async () => {
    const item = await delegateOk();
    await report(item, 'blocked', '预算上限是多少？');
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'open',
      attention: '预算上限是多少？',
      lastReport: 'blocked',
    });
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(attrsOf(input).state).toBe('blocked');
    expect(input.content).toBe('预算上限是多少？');
  });

  test('failed ends it failed and reaches the delegating session', async () => {
    const item = await delegateOk();
    await report(item, 'failed', '网站打不开');
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'failed',
    });
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(attrsOf(input).state).toBe('failed');
  });

  test('only progress, ready, blocked and failed; never the team tools', async () => {
    const item = await delegateOk();
    for (const state of ['waiting', 'dropped', 'bogus']) {
      expect(await report(item, state)).toEqual({
        ok: false,
        error: 'state must be progress, ready, blocked or failed.',
      });
    }
    for (const type of ['work_ack', 'work_handback']) {
      expect(
        await service.handleWorkIpc(
          { folder: FOLDER, agentId: item.agentId },
          { type, triggerMessageId: item.sourceMessageId, text: 'x' },
        ),
      ).toEqual({
        ok: false,
        error: 'Only a team work item session can use this tool.',
      });
    }
    expect(
      await service.handleWorkIpc(
        { folder: FOLDER, agentId: item.agentId },
        { type: 'work_report', state: 'ready', summary: '  ' },
      ),
    ).toEqual({ ok: false, error: 'summary is required.' });
  });
});

describe('the reply route of a report', () => {
  test('a Web delegation is answered in the Web only', async () => {
    const item = await delegateOk(MAIN, {}, ownerInput(MAIN));
    await report(item, 'ready', '好了');
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(input.source_jid).toBe(laneOf(MAIN));
    expect(input.channel_context ?? null).toBeNull();
    // What processAgentConversation resolves the turn's IM route with.
    expect(replySource.resolveBatchChannelReplySource([input])).toBeNull();
  });

  test('a delegation from a Feishu topic is answered in that topic', async () => {
    const context: ChannelTurnContext = {
      schemaVersion: 1,
      provider: 'feishu',
      channelAccountId: 'acct-1',
      sourceJid: TOPIC_JID,
      chat: { id: 'oc_topicgroup', type: 'group', isTopicStyle: true },
      message: {
        id: 'om_ask',
        rootId: 'om_root',
        threadId: 'omt_77',
        parentId: 'om_quoted',
        referencedMessages: [
          { id: 'om_quoted', senderName: '小王', content: '旧消息' } as never,
        ],
      },
      mentions: [{ key: '@_user_1', name: 'Bot' }],
    };
    const origin = ownerInput(MAIN, {
      sourceJid: TOPIC_JID,
      channelContext: context,
    });
    const item = await delegateOk(MAIN, {}, origin);
    expect(item.sourceRouteJid).toBe(TOPIC_JID);
    await report(item, 'ready', '好了');
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(input.source_jid).toBe(TOPIC_JID);
    // Same chat, topic and Bot account; nothing of the asking message's
    // content (its quote, its mentions) comes with it.
    expect(input.channel_context).toEqual({
      schemaVersion: 1,
      provider: 'feishu',
      channelAccountId: 'acct-1',
      sourceJid: TOPIC_JID,
      chat: { id: 'oc_topicgroup', type: 'group', isTopicStyle: true },
      message: { id: 'om_ask', rootId: 'om_root', threadId: 'omt_77' },
    });
    expect(replySource.resolveBatchChannelReplySource([input])).toBe(TOPIC_JID);
    // A report never shares a turn with another input of the session.
    const userInput = rows(laneOf(MAIN)).find(
      (r) => r.id === origin.messageId,
    )!;
    expect(replySource.selectChannelReplyBatch([userInput, input])).toEqual([
      userInput,
    ]);
  });
});

describe('work_stop and work_followup', () => {
  test('work_stop ends the item, stops its worker and reports stopped', async () => {
    const item = await delegateOk();
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_stop',
        item: `#${item.seq}`,
      }),
    ).toEqual({ ok: true, data: {} });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(stopped).toEqual([laneOf(item.agentId)]);
    // The session asked for the stop itself: no report, no extra turn.
    expect(reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id)).toEqual(
      [],
    );
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_stop',
        item: item.id,
      }),
    ).toEqual({ ok: false, error: '这个后台任务已经结束。' });
  });

  test("another session's item, or none, is not found", async () => {
    const item = await delegateOk(MAIN_2);
    for (const ref of [item.id, `#${item.seq}`, 'nope', '#999']) {
      for (const type of ['work_stop', 'work_followup']) {
        expect(
          await service.handleWorkIpc(callerOf(MAIN), {
            type,
            item: ref,
            message: 'x',
          }),
        ).toEqual({ ok: false, error: `没有找到这个后台任务：${ref}。` });
      }
    }
    expect(store.getWorkItem(item.id)?.status).toBe('open');
  });

  test("work_followup is the worker's next input and answers its question", async () => {
    const item = await delegateOk();
    await report(item, 'blocked', '预算上限是多少？');
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_followup',
        item: item.id,
        message: '一万以内',
      }),
    ).toEqual({ ok: true, data: {} });
    expect(store.getWorkItem(item.id)).toMatchObject({
      attention: null,
      lastReport: 'progress',
    });
    // Working again: no longer among the items waiting for a person.
    expect(
      service.listWorkItemViews(WORKSPACE).find((view) => view.id === item.id)
        ?.stage,
    ).not.toBe('blocked');
    const followup = rows(laneOf(item.agentId)).at(-1)!;
    expect(followup).toMatchObject({
      content: '一万以内',
      source_kind: 'work_item_input',
    });
    expect(followup.id).toMatch(new RegExp(`^work-followup-${item.id}-\\d+$`));
    expect(gate.readTeamInput(followup.attachments)).toMatchObject({
      tag: 'work_followup',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['origin', 'delegated'],
      ],
    });
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_followup',
        item: item.id,
        message: 'x'.repeat(4001),
      }),
    ).toEqual({ ok: false, error: 'message is limited to 4000 characters.' });
    await report(item, 'ready');
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_followup',
        item: item.id,
        message: '还有一件',
      }),
    ).toEqual({ ok: false, error: '这个后台任务已经结束。' });
  });

  test('stopping it on the Web reports stopped to its session', async () => {
    const item = await delegateOk();
    const view = service.stopWorkItem(item.id);
    expect(view).toMatchObject({ status: 'ended', outcome: 'stopped' });
    expect(stopped).toEqual([laneOf(item.agentId)]);
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(input.content).toBe('已停止：用户在 Web 上停止了它');
    // Stopping again changes nothing.
    service.stopWorkItem(item.id);
    expect(
      reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id),
    ).toHaveLength(1);
  });
});

describe('views', () => {
  test('carry the origin and the delegating session name', async () => {
    const item = await delegateOk();
    const view = service
      .listWorkItemViews(WORKSPACE)
      .find((v) => v.id === item.id)!;
    expect(view).toMatchObject({
      origin: 'delegated',
      originAgentId: MAIN,
      originInputId: item.originInputId,
      originSessionName: `会话 ${MAIN}`,
      channelName: null,
      stage: 'working',
    });
    expect(service.getWorkItemDetail(item.id)?.item.originSessionName).toBe(
      `会话 ${MAIN}`,
    );
  });
});

describe('session deletion', () => {
  function deleteSession(agentId: string): void {
    sessions.deleteConversationSession({
      workspaceJid: WORKSPACE,
      group: db.getRegisteredGroup(WORKSPACE)!,
      session: db.getAgent(agentId)!,
    });
  }

  test('deleting the worker stops the item and tells its session', async () => {
    const item = await delegateOk();
    deleteSession(item.agentId);
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(attrsOf(input).state).toBe('stopped');
    expect(input.content).toBe('已停止：Worker 会话已被删除');
  });

  test('deleting the delegating session stops its items and reports nothing', async () => {
    createSession('mt-doomed');
    const first = await delegateOk('mt-doomed');
    const second = await delegateOk('mt-doomed');
    const ended = await delegateOk('mt-doomed');
    await report(ended, 'ready');
    const other = await delegateOk(MAIN);
    stopped.length = 0;
    deleteSession('mt-doomed');
    for (const item of [first, second]) {
      expect(store.getWorkItem(item.id)).toMatchObject({
        status: 'ended',
        outcome: 'stopped',
      });
      // The worker sessions stay, stopped; they get no input about it.
      expect(db.getAgent(item.agentId)).toBeDefined();
      expect(rows(laneOf(item.agentId))).toHaveLength(1);
    }
    expect(stopped.sort()).toEqual(
      [laneOf(first.agentId), laneOf(second.agentId)].sort(),
    );
    expect(store.getWorkItem(ended.id)?.outcome).toBe('completed');
    expect(store.getWorkItem(other.id)?.status).toBe('open');
    expect(
      service.listWorkItemViews(WORKSPACE).find((v) => v.id === first.id)
        ?.originSessionName,
    ).toBeNull();
  });
});

describe('startup reconciliation', () => {
  test('a missing worker fails the item; a missing delegating session stops it', async () => {
    createSession('mt-gone-origin');
    const workerGone = await delegateOk();
    const originGone = await delegateOk('mt-gone-origin');
    const bothGone = await delegateOk('mt-gone-origin');
    const alive = await delegateOk(MAIN_2);
    // Removed while the service was down: rows only, no deletion hooks.
    db.deleteAgent(workerGone.agentId);
    db.deleteAgent(bothGone.agentId);
    db.deleteAgent('mt-gone-origin');
    stopped.length = 0;

    service.reconcileDelegatedWorkItems();

    expect(store.getWorkItem(workerGone.id)).toMatchObject({
      status: 'ended',
      outcome: 'failed',
    });
    const [input] = reportsIn(MAIN).filter(
      (r) => attrsOf(r).id === workerGone.id,
    );
    expect(attrsOf(input).state).toBe('failed');
    expect(input.content).toBe('Worker 会话已不存在，任务没有完成。');

    expect(store.getWorkItem(originGone.id)).toMatchObject({
      status: 'ended',
      outcome: 'stopped',
    });
    expect(stopped).toEqual([laneOf(originGone.agentId)]);
    expect(store.getWorkItem(bothGone.id)?.outcome).toBe('failed');
    expect(store.getWorkItem(alive.id)?.status).toBe('open');

    // Idempotent: a second run changes and delivers nothing.
    const before = reportsIn(MAIN).length;
    service.reconcileDelegatedWorkItems();
    expect(reportsIn(MAIN)).toHaveLength(before);
  });
});

describe('a workspace back in single-task mode (A)', () => {
  test('work already delegated keeps its tools and its reports; nothing new is delegated', async () => {
    const item = await delegateOk(MAIN);
    db.setWorkspaceWorkMode(FOLDER, 'single');
    const session = db.getAgent(MAIN)!;
    // Its runner keeps the tools while the item is open.
    expect(service.runnerWorkMode(session, FOLDER)).toBe('multi');
    // A session that never delegated gets nothing, and may not manage.
    createSession('mt-never');
    expect(
      service.runnerWorkMode(db.getAgent('mt-never')!, FOLDER),
    ).toBeUndefined();
    for (const type of ['work_delegations', 'work_followup', 'work_stop']) {
      expect(
        await service.handleWorkIpc(callerOf('mt-never'), {
          type,
          item: `#${item.seq}`,
          message: 'x',
        }),
      ).toEqual({
        ok: false,
        error: '当前工作区是单任务模式，不能派出后台任务；请在当前会话里完成。',
      });
    }
    // Delegating anew is refused, following up is not.
    expect(await delegate(callerOf(MAIN))).toEqual({
      ok: false,
      error: '当前工作区是单任务模式，不能派出后台任务；请在当前会话里完成。',
    });
    const listed = await service.handleWorkIpc(callerOf(MAIN), {
      type: 'work_delegations',
    });
    expect(listed).toMatchObject({ ok: true });
    expect(
      (listed as { data: { workItemId: string }[] }).data.map(
        (entry) => entry.workItemId,
      ),
    ).toContain(item.id);
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_followup',
        item: item.id,
        message: '继续',
      }),
    ).toEqual({ ok: true, data: {} });
    // Its last report reaches a runner that still reads reports.
    await report(item, 'ready', '做完了');
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(service.runnerWorkMode(session, FOLDER)).toBeUndefined();
    expect(service.runnerWorkMode(session, FOLDER, [input])).toBe('multi');
    // Ended items can still be named: their stop says they ended.
    expect(
      await service.handleWorkIpc(callerOf(MAIN), {
        type: 'work_stop',
        item: item.id,
      }),
    ).toEqual({ ok: false, error: '这个后台任务已经结束。' });
    // Back in multi-task mode, all is as before.
    db.setWorkspaceWorkMode(FOLDER, 'multi');
    expect(service.runnerWorkMode(db.getAgent('mt-never')!, FOLDER)).toBe(
      'multi',
    );
    await delegateOk(MAIN);
  });
});

describe('sessions that get no delegation tools (D, F)', () => {
  test("an automation's session gets no work mode", () => {
    expect(
      service.runnerWorkMode(
        { id: 'auto-1', kind: 'conversation', source_kind: 'automation' },
        FOLDER,
      ),
    ).toBeUndefined();
  });

  test('a worktree session may not delegate: its worker would edit the main checkout', async () => {
    createSession('mt-worktree');
    worktreeStore.insertSessionWorktree({
      agent_id: 'mt-worktree',
      group_folder: FOLDER,
      chat_jid: WORKSPACE,
      repo_path: '/repo',
      cwd_subpath: '',
      worktree_path: '/repo-worktrees/mt-worktree',
      branch: 'happyclaw/mt-worktree',
      base_commit: 'abc',
      created_at: new Date().toISOString(),
    });
    expect(
      service.runnerWorkMode(db.getAgent('mt-worktree')!, FOLDER),
    ).toBeUndefined();
    expect(await delegate(callerOf('mt-worktree'))).toEqual({
      ok: false,
      error: '独立 worktree 会话暂不支持派出后台任务；请在当前会话里完成。',
    });
    expect(store.listOpenDelegatedWorkItems('mt-worktree')).toEqual([]);
  });
});

describe('the owner turn (H, I)', () => {
  test('a delegation must name the input its turn answers', async () => {
    const caller = {
      folder: FOLDER,
      agentId: MAIN,
      // The owner's turn, but no batch named: no input to answer to.
      ownerTurn: vi.fn(() => ({ input: null })),
    };
    expect(await delegate(caller)).toEqual({
      ok: false,
      error:
        '只有工作区主人亲自发起的对话可以派出后台任务；请在当前会话里完成。',
    });
  });

  test('stop and follow-up need the owner turn too; the list does not', async () => {
    const item = await delegateOk(MAIN);
    const notOwner = callerOf(MAIN, null);
    for (const type of ['work_stop', 'work_followup']) {
      expect(
        await service.handleWorkIpc(notOwner, {
          type,
          item: item.id,
          message: '改成别的',
        }),
      ).toEqual({
        ok: false,
        error:
          '只有工作区主人亲自发起的对话可以停止或跟进后台任务；请把用户的意思转告主人。',
      });
    }
    expect(store.getWorkItem(item.id)?.status).toBe('open');
    expect(rows(laneOf(item.agentId))).toHaveLength(1);
    expect(
      await service.handleWorkIpc(notOwner, { type: 'work_delegations' }),
    ).toMatchObject({ ok: true });
  });
});

describe('a delegation judged inside the lock (E)', () => {
  test('a session deleted while its call waited delegates nothing', async () => {
    createSession('mt-vanishing');
    const pending = [
      delegate(callerOf('mt-vanishing')),
      delegate(callerOf('mt-vanishing')),
    ];
    db.deleteAgent('mt-vanishing');
    for (const result of await Promise.all(pending)) {
      expect(result).toEqual({
        ok: false,
        error:
          'Only an ordinary session of a multi-task workspace can use this tool.',
      });
    }
    expect(store.listOpenDelegatedWorkItems('mt-vanishing')).toEqual([]);
  });

  test('a turn that stopped being the owner while the call waited delegates nothing', async () => {
    let owner = true;
    const origin = ownerInput(MAIN);
    const caller = {
      folder: FOLDER,
      agentId: MAIN,
      ownerTurn: vi.fn(() => (owner ? { input: origin } : null)),
    };
    const pending = delegate(caller);
    owner = false;
    expect(await pending).toMatchObject({ ok: false });
    expect(store.listOpenDelegatedWorkItems(MAIN)).toEqual([]);
  });

  test('a delegation that fails half way leaves a failed item and no session', async () => {
    const before = new Set(
      service.listWorkItemViews(WORKSPACE).map((view) => view.id),
    );
    // The worker's lane refuses its assignment.
    const caller = callerOf(MAIN);
    failAdmissions = true;
    const result = await delegate(caller);
    failAdmissions = false;
    expect(result).toEqual({
      ok: false,
      error: 'Could not start the delegated task: queue unavailable',
    });
    const [item] = service
      .listWorkItemViews(WORKSPACE)
      .filter((view) => !before.has(view.id));
    expect(item).toMatchObject({ status: 'ended', outcome: 'failed' });
    // Its session was made, then removed again.
    expect(db.getAgent(item.agentId)).toBeUndefined();
    expect(store.countOpenDelegatedWorkItems({ originAgentId: MAIN })).toBe(0);
  });
});

describe('a delegated worker that ends without a result (C)', () => {
  test('a finished turn with nothing handed back fails the item and tells its session', async () => {
    const item = await delegateOk();
    await report(item, 'progress', '查到一半');
    service.failDelegatedWorkerRun(item.agentId, null);
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'ended',
      outcome: 'failed',
    });
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(attrsOf(input).state).toBe('failed');
    expect(input.content).toBe('Worker 结束了这一轮，但没有交回结果。');
  });

  test('a turn that ends on a question is normal', async () => {
    const item = await delegateOk();
    await report(item, 'blocked', '要哪三家？');
    service.failDelegatedWorkerRun(item.agentId, null);
    expect(store.getWorkItem(item.id)?.status).toBe('open');
    // A failed run fails it even then.
    service.failDelegatedWorkerRun(
      item.agentId,
      `context_overflow: 上下文太长\n${'x'.repeat(10)}`,
    );
    expect(store.getWorkItem(item.id)?.outcome).toBe('failed');
    const failed = reportsIn(MAIN).filter(
      (r) => attrsOf(r).id === item.id && attrsOf(r).state === 'failed',
    );
    expect(failed.map((r) => r.content)).toEqual([
      'Worker 运行失败：context_overflow: 上下文太长',
    ]);
  });

  test('a long reason is cut; settled items and team workers are left alone', async () => {
    const item = await delegateOk();
    service.failDelegatedWorkerRun(item.agentId, 'e'.repeat(300));
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    expect(input.content).toBe(`Worker 运行失败：${'e'.repeat(200)}…`);
    // Ended already: nothing more.
    service.failDelegatedWorkerRun(item.agentId, null);
    expect(
      reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id),
    ).toHaveLength(1);
    // A team worker's item is not this rule's.
    const team = store.insertWorkItem({
      id: 'team-item-c',
      workspaceJid: WORKSPACE,
      workspaceFolder: FOLDER,
      channelJid: 'feishu:oc_team_c',
      agentId: 'team-worker-c',
      title: 'team',
      sourceMessageId: 'om_team_c',
      sourceRouteJid: 'feishu:oc_team_c',
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
    });
    service.failDelegatedWorkerRun(team.agentId, null);
    service.failDelegatedWorkerRun(team.agentId, 'boom');
    expect(store.getWorkItem(team.id)?.status).toBe('open');
  });
});

describe('a report the session has not run yet survives a stop (B)', () => {
  test('the cutoff keeps a delegated report and cancels everything else', async () => {
    const item = await delegateOk();
    await report(item, 'ready', '做完了');
    const [input] = reportsIn(MAIN).filter((r) => attrsOf(r).id === item.id);
    const lane = laneOf(MAIN);
    const typed = ownerInput(MAIN);
    for (const id of [input.id, typed.messageId]) {
      db.setMessageFollowUp(lane, id, {
        mode: 'queue',
        status: 'queued',
        runId: 'run-1',
      });
    }
    expect(service.isDelegatedReportInput(input)).toBe(true);
    const cancelled = db.cancelQueuedFollowUpsAtCutoff(
      lane,
      undefined,
      service.isDelegatedReportInput,
    );
    expect(cancelled.map((row) => row.id)).toEqual([typed.messageId]);
    expect(db.listQueuedFollowUps(lane).map((row) => row.id)).toEqual([
      input.id,
    ]);
  });

  test("a team router's report is not a delegated report", () => {
    const header = gate.withTeamInputAttachment(null, {
      type: 'team_input',
      tag: 'work_report',
      attrs: [['state', 'ready']],
      facts: { workItemId: 'team-item-c' },
    });
    expect(
      service.isDelegatedReportInput({
        source_kind: 'work_item_input',
        attachments: header,
      }),
    ).toBe(false);
    expect(
      service.isDelegatedReportInput({
        source_kind: null,
        attachments: header,
      }),
    ).toBe(false);
  });
});

describe('a delegated summary over the limit (G)', () => {
  test('is refused, not cut', async () => {
    const item = await delegateOk();
    expect(await report(item, 'ready', 'x'.repeat(4001))).toEqual({
      ok: false,
      error:
        'summary is limited to 4000 characters; put a longer result in a file and give its path.',
    });
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'open',
      lastSummary: null,
    });
    expect(await report(item, 'ready', 'x'.repeat(4000))).toMatchObject({
      ok: true,
    });
  });
});

describe('a delegation stopped while its worker session was made', () => {
  const stoppedBeforeStart = {
    ok: false,
    error: '这个后台任务在 Worker 启动前已被停止，没有开始执行。',
  };

  test('stopped on the Web: the worker never gets the task', async () => {
    duringSessionCreation = () => {
      const [item] = store.listOpenDelegatedWorkItems(MAIN);
      service.stopWorkItem(item.id);
    };
    expect(await delegate(callerOf(MAIN))).toEqual(stoppedBeforeStart);
    const [item] = service
      .listWorkItemViews(WORKSPACE)
      .sort((a, b) => b.seq - a.seq);
    expect(item).toMatchObject({ status: 'ended', outcome: 'stopped' });
    expect(db.getAgent(item.agentId)).toBeUndefined();
    expect(rows(laneOf(item.agentId))).toEqual([]);
  });

  test('stopped on the Web, then the session fails: it stays stopped', async () => {
    duringSessionCreation = () => {
      const [item] = store.listOpenDelegatedWorkItems(MAIN);
      service.stopWorkItem(item.id);
      throw new Error('disk full');
    };
    expect(await delegate(callerOf(MAIN))).toEqual({
      ok: false,
      error: 'Could not start the delegated task: disk full',
    });
    const [item] = service
      .listWorkItemViews(WORKSPACE)
      .sort((a, b) => b.seq - a.seq);
    expect(item).toMatchObject({ status: 'ended', outcome: 'stopped' });
    expect(db.getAgent(item.agentId)).toBeUndefined();
  });

  test('its delegating session deleted: the item stops, the session goes', async () => {
    createSession('mt-gone-midway');
    duringSessionCreation = () => db.deleteAgent('mt-gone-midway');
    expect(await delegate(callerOf('mt-gone-midway'))).toEqual(
      stoppedBeforeStart,
    );
    const [item] = service
      .listWorkItemViews(WORKSPACE)
      .sort((a, b) => b.seq - a.seq);
    expect(item).toMatchObject({
      originAgentId: 'mt-gone-midway',
      status: 'ended',
      outcome: 'stopped',
    });
    expect(db.getAgent(item.agentId)).toBeUndefined();
    expect(rows(laneOf(item.agentId))).toEqual([]);
  });
});

describe('a queued report a reset passed (moveMessagesToIngestTail)', () => {
  test('is read again past the new cursor once released', () => {
    const lane = laneOf(MAIN);
    const waiting = ownerInput(MAIN).messageId;
    db.setMessageFollowUp(lane, waiting, {
      mode: 'queue',
      status: 'queued',
      runId: 'run-1',
    });
    const divider = ownerInput(MAIN).messageId;
    const cursor = db.getMessageCursor(lane, divider)!;
    db.releaseQueuedFollowUpBatch(
      [{ chat_jid: lane, id: waiting }],
      'recovery:1',
    );
    const readable = () =>
      db.getMessagesSince(lane, cursor).map((message) => message.id);
    expect(readable()).not.toContain(waiting);
    db.moveMessagesToIngestTail(lane, [waiting]);
    expect(readable()).toEqual([waiting]);
  });
});
