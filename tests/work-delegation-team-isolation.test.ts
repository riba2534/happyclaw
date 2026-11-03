/**
 * Multi-task mode next to team mode in one workspace: no team path (routing,
 * subscriptions, follow-up copies, group replies, reconciliation, the group's
 * counts) ever reaches a delegated item.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mt-team-'));

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

const OWNER = 'iso-owner';
const WORKSPACE = 'web:iso-ws';
const FOLDER = 'iso-ws';
const CHAT = 'feishu:oc_iso';
const BOUND = 'iso-bound';
const MAIN = 'iso-main';
const ACTOR = { userId: OWNER, isAdmin: false };

const laneOf = (agentId: string) => `${WORKSPACE}#agent:${agentId}`;
const stopped: string[] = [];

function createSession(id: string): void {
  db.createAgent({
    id,
    group_folder: FOLDER,
    chat_jid: WORKSPACE,
    name: id,
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
}

function rows(laneJid: string): NewMessage[] {
  return db.getMessagesSince(laneJid, { timestamp: '', id: '' });
}

function routerAgentId(): string {
  return store.getTeamMount(CHAT)!.routerAgentId!;
}

function routerCaller() {
  return { folder: FOLDER, agentId: routerAgentId() };
}

let seq = 0;
async function enableTeam(enabled = true): Promise<void> {
  await service.saveTeamMountSettings(
    WORKSPACE,
    CHAT,
    {
      enabled,
      admission: {
        listedUnaddressed: 'ignore',
        unlistedAddressed: 'ignore',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'observe',
      rules: [],
    },
    ACTOR,
  );
}

/** A team candidate in the router lane, then accepted: a team item. */
async function teamItem(): Promise<WorkItem> {
  const trigger = `om_team_${++seq}`;
  db.storeMessageDirect(
    trigger,
    laneOf(routerAgentId()),
    'ou_owner',
    '老板',
    '修一下',
    new Date().toISOString(),
    false,
    {
      sourceJid: CHAT,
      attachments: gate.withTeamInputAttachment(
        null,
        gate.candidateInputItem({
          triggerMessageId: trigger,
          strength: 'explicit',
          listed: true,
          addressed: true,
          settings: store.getTeamMount(CHAT)!.settings,
          threadItems: [],
          senderImId: 'ou_owner',
        }),
      ),
    },
  );
  const result = await service.handleWorkIpc(routerCaller(), {
    type: 'work_route',
    items: [
      {
        kind: 'accept',
        triggerMessageId: trigger,
        title: '修',
        acknowledgement: '收到',
      },
    ],
  });
  const id = (result as { data: { results: { workItemId: string }[] } }).data
    .results[0].workItemId;
  return store.getWorkItem(id)!;
}

/** A delegated item of MAIN, through work_delegate. */
async function delegatedItem(): Promise<WorkItem> {
  const messageId = `in-${++seq}`;
  db.storeMessageDirect(
    messageId,
    laneOf(MAIN),
    OWNER,
    '老板',
    '派出去',
    new Date().toISOString(),
    false,
  );
  const result = await service.handleWorkIpc(
    {
      folder: FOLDER,
      agentId: MAIN,
      ownerTurnInput: () => ({ chatJid: laneOf(MAIN), messageId }),
    },
    { type: 'work_delegate', title: '调研', task: '做调研' },
  );
  const id = (result as { data: { workItemId: string } }).data.workItemId;
  return store.getWorkItem(id)!;
}

/**
 * A delegated item stored as if it named the group (a row no service path
 * writes): the group's own queries must still never return it.
 */
function delegatedOnGroup(): WorkItem {
  const item = store.insertWorkItem({
    id: `forged-${++seq}`,
    workspaceJid: WORKSPACE,
    workspaceFolder: FOLDER,
    channelJid: CHAT,
    agentId: `forged-worker-${seq}`,
    title: 'forged',
    sourceMessageId: `delegate:forged-${seq}`,
    sourceRouteJid: CHAT,
    mandate: {
      strength: 'explicit',
      requesterImId: null,
      requesterName: null,
      requesterListed: true,
      requesterIsOwner: true,
      matchedRules: [],
      settingsVersion: 0,
      writable: true,
    },
    now: new Date().toISOString(),
    delegatedBy: { agentId: MAIN, inputId: null },
  });
  store.subscribeWorkItem(
    item.id,
    CHAT,
    gate.teamTriggerKeys({ messageId: 'om_forged' })[0],
    new Date().toISOString(),
  );
  return item;
}

beforeAll(async () => {
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
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Iso WS',
    folder: FOLDER,
    added_at: now,
    executionMode: 'container',
    created_by: OWNER,
  });
  db.assignWorkspaceAgentProfile(
    FOLDER,
    db.getOrCreateDefaultAgentProfile(OWNER).id,
  );
  db.setWorkspaceWorkMode(FOLDER, 'multi');
  createSession(BOUND);
  createSession(MAIN);
  db.ensureChatExists(laneOf(MAIN));
  db.setRegisteredGroup(CHAT, {
    name: '研发群',
    folder: FOLDER,
    added_at: now,
    created_by: OWNER,
    target_agent_id: BOUND,
    feishu_chat_mode: 'group',
    owner_im_id: 'ou_owner',
    channel_account_id: 'acct-1',
  } as never);
  webContext.setWebDeps({
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup: vi.fn(async () => {}) },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  runtime.setWorkItemRuntimeHooks({
    admitInput: () => 'started',
    wake: vi.fn(),
    broadcastNewMessage: vi.fn(),
    stopLane: (laneJid) => stopped.push(laneJid),
    drainLane: vi.fn(),
    postReply: async () => ({ ok: true, providerMessageId: null }),
    postLaneMessage: async () => {},
    broadcastWorkItemEvent: vi.fn(),
  });
  await enableTeam();
});

beforeEach(() => {
  stopped.length = 0;
  for (const item of store.listOpenDelegatedWorkItems()) {
    store.updateWorkItem(
      item.id,
      { status: 'ended', outcome: 'completed' },
      new Date().toISOString(),
    );
  }
});

afterAll(async () => {
  await service.settleTeamReplies();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team paths never reach a delegated item', () => {
  test('routing: a reply on its subscription is a candidate, not a follow-up', () => {
    delegatedOnGroup();
    const context = service.resolveTeamGroup(CHAT)!;
    const deps = service.teamGateDeps(context);
    expect(
      deps.findSubscribedItems(
        CHAT,
        gate.teamMessageKeys({ parentId: 'om_forged' }),
      ),
    ).toEqual([]);
    const decision = gate.decideTeamInbound(
      context,
      {
        messageId: 'om_reply',
        parentId: 'om_forged',
        senderImId: 'ou_owner',
        mentionedBot: true,
      },
      deps,
    );
    expect(decision.kind).toBe('candidate');
  });

  test('follow-up copies: a delegated follow-up stored in its worker is no group follow-up', async () => {
    const item = await delegatedItem();
    await service.handleWorkIpc(
      { folder: FOLDER, agentId: MAIN },
      { type: 'work_followup', item: item.id, message: '补充一句' },
    );
    const followup = rows(laneOf(item.agentId)).at(-1)!;
    const events = store.listWorkEvents(item.id).length;
    service.onTeamMessageStored(laneOf(item.agentId), followup.id);
    expect(store.listWorkEvents(item.id)).toHaveLength(events);
    expect(rows(laneOf(item.agentId)).at(-1)!.id).toBe(followup.id);
  });

  test('group replies: the router cannot answer for, attach to or stop a delegated item', async () => {
    const item = await delegatedItem();
    await service.handleWorkIpc(
      { folder: FOLDER, agentId: item.agentId },
      { type: 'work_report', state: 'blocked', summary: '问一下' },
    );
    for (const purpose of ['result', 'attention']) {
      expect(
        await service.handleWorkIpc(routerCaller(), {
          type: 'work_reply',
          purpose,
          workItemId: item.id,
          text: '好的',
        }),
      ).toEqual({
        ok: false,
        error: 'workItemId is not a work item of this group.',
      });
    }
    expect(store.getWorkItem(item.id)?.status).toBe('open');
  });

  test("a delegated report never reaches the group's router", async () => {
    const before = rows(laneOf(routerAgentId())).length;
    const item = await delegatedItem();
    for (const state of ['blocked', 'ready']) {
      await service.handleWorkIpc(
        { folder: FOLDER, agentId: item.agentId },
        { type: 'work_report', state, summary: state },
      );
    }
    expect(rows(laneOf(routerAgentId()))).toHaveLength(before);
    // Nor is it held for a router that does not exist.
    expect(
      store
        .listWorkEvents(item.id)
        .some((event) => event.state === 'undelivered'),
    ).toBe(false);
  });

  test("reconciliation: stopping a group's items and turning team mode off leave delegated items open", async () => {
    const team = await teamItem();
    const forged = delegatedOnGroup();
    const delegated = await delegatedItem();
    service.stopGroupWorkItems(CHAT, 'group_rebound');
    expect(store.getWorkItem(team.id)?.outcome).toBe('stopped');
    expect(store.getWorkItem(forged.id)?.status).toBe('open');
    expect(store.getWorkItem(delegated.id)?.status).toBe('open');

    await enableTeam(false);
    service.reconcileAllTeamGroups();
    expect(store.getWorkItem(delegated.id)?.status).toBe('open');
    expect(stopped).not.toContain(laneOf(delegated.agentId));
    await enableTeam(true);
  });

  test("the group's counts and work_list: /status and the router see team items only", async () => {
    const team = await teamItem();
    const openTeam = store
      .listWorkItemsByChannel(CHAT, { status: 'open' })
      .map((item) => item.id);
    delegatedOnGroup();
    await delegatedItem();
    expect(service.countOpenWorkItems(CHAT)).toBe(openTeam.length);
    const listed = await service.handleWorkIpc(routerCaller(), {
      type: 'work_list',
      status: 'open',
    });
    const ids = (
      listed as { data: { items: { id: string }[] } }
    ).data.items.map((item) => item.id);
    expect(ids).toContain(team.id);
    expect(ids.sort()).toEqual([...openTeam].sort());
  });

  test("a delegated worker's lane is never a group route", async () => {
    const item = await delegatedItem();
    expect(
      service.teamRouteStillHolds(CHAT, {
        effectiveJid: laneOf(item.agentId),
        agentId: item.agentId,
      }),
    ).toBe(false);
    // A team worker's lane still is.
    const team = await teamItem();
    expect(
      service.teamRouteStillHolds(CHAT, {
        effectiveJid: laneOf(team.agentId),
        agentId: team.agentId,
      }),
    ).toBe(true);
  });

  test('a team worker keeps its role and reports to the router as before', async () => {
    const team = await teamItem();
    expect(service.resolveTeamRole(team.agentId)).toEqual({
      role: 'worker',
      workItemId: team.id,
      writable: true,
    });
    const before = rows(laneOf(routerAgentId())).length;
    await service.handleWorkIpc(
      { folder: FOLDER, agentId: team.agentId },
      { type: 'work_report', state: 'blocked', summary: '卡住了' },
    );
    expect(rows(laneOf(routerAgentId()))).toHaveLength(before + 1);
    // Team sessions have no part in multi-task mode.
    expect(
      await service.handleWorkIpc(
        { folder: FOLDER, agentId: team.agentId },
        { type: 'work_delegations' },
      ),
    ).toMatchObject({ ok: false });
  });
});
