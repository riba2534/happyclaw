import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v87-work-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/work-item-store.js');
const { DEFAULT_TEAM_SETTINGS, subscriptionKey } =
  await import('../src/work-items.js');

const NOW = '2026-11-01T00:00:00.000Z';
const TABLES = [
  'team_mounts',
  'work_items',
  'work_item_subscriptions',
  'work_item_events',
  'work_decisions',
  'work_item_replies',
];

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const mandate = {
  strength: 'explicit' as const,
  requesterImId: 'ou_a',
  requesterName: 'A',
  requesterListed: true,
  requesterIsOwner: false,
  matchedRules: [],
  settingsVersion: 1,
  writable: true,
};

/** Build a current database, then rewind it to the v86 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();
  const legacy = new Database(databasePath);
  for (const table of TABLES) legacy.exec(`DROP TABLE ${table}`);
  legacy
    .prepare(
      "UPDATE router_state SET value = '86' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v87 team mode', () => {
  test('backs up the v86 database and creates the team-mode tables', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(87);
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v86-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toEqual(expect.arrayContaining(TABLES));
    } finally {
      conn.close();
    }
  });

  test('a work item is numbered per workspace and idempotent by its trigger', () => {
    const base = {
      workspaceJid: 'web:ws',
      workspaceFolder: 'ws',
      channelJid: 'feishu:oc_g',
      title: 'Fix it',
      sourceRouteJid: 'feishu:oc_g',
      mandate,
      now: NOW,
    };
    const first = store.insertWorkItem({
      ...base,
      id: 'w1',
      agentId: 'a1',
      sourceMessageId: 'om_1',
    });
    const again = store.insertWorkItem({
      ...base,
      id: 'w1-dup',
      agentId: 'a1-dup',
      sourceMessageId: 'om_1',
    });
    const second = store.insertWorkItem({
      ...base,
      id: 'w2',
      agentId: 'a2',
      sourceMessageId: 'om_2',
    });
    expect(first.seq).toBe(1);
    expect(again.id).toBe('w1');
    expect(second.seq).toBe(2);
    expect(store.getWorkItemByAgent('a2')?.id).toBe('w2');
    expect(store.getWorkItem('w1')?.mandate).toEqual(mandate);
  });

  test('subscriptions are many-to-many; a stopped item receives nothing', () => {
    const key = subscriptionKey('msg', 'om_1');
    store.subscribeWorkItem('w1', 'feishu:oc_g', key, NOW);
    store.subscribeWorkItem('w2', 'feishu:oc_g', key, NOW);
    store.subscribeWorkItem('w1', 'feishu:oc_g', key, NOW);
    expect(
      store
        .findSubscribedWorkItems('feishu:oc_g', [key, 'msg:none'], 'web:ws')
        .map((item) => item.id),
    ).toEqual(['w1', 'w2']);
    // Another chat with the same message id is a different thread.
    expect(
      store.findSubscribedWorkItems('feishu:oc_other', [key], 'web:ws'),
    ).toEqual([]);

    store.updateWorkItem(
      'w2',
      { status: 'ended', outcome: 'completed', endedAt: NOW },
      NOW,
    );
    expect(
      store
        .findSubscribedWorkItems('feishu:oc_g', [key], 'web:ws')
        .map((i) => i.id),
    ).toEqual(['w1', 'w2']);
    store.updateWorkItem('w2', { outcome: 'stopped' }, NOW);
    expect(
      store
        .findSubscribedWorkItems('feishu:oc_g', [key], 'web:ws')
        .map((i) => i.id),
    ).toEqual(['w1']);
    store.unsubscribeWorkItem('w1', 'feishu:oc_g', key);
    expect(
      store.findSubscribedWorkItems('feishu:oc_g', [key], 'web:ws'),
    ).toEqual([]);
  });

  test('an item of another workspace is never reached', () => {
    const key = subscriptionKey('msg', 'om_x');
    store.subscribeWorkItem('w1', 'feishu:oc_g', key, NOW);
    expect(
      store.findSubscribedWorkItems('feishu:oc_g', [key], 'web:other'),
    ).toEqual([]);
    store.unsubscribeWorkItem('w1', 'feishu:oc_g', key);
  });

  test('a group lists and counts its own items', () => {
    expect(
      store.listWorkItemsByChannel('feishu:oc_g').map((item) => item.id),
    ).toEqual(expect.arrayContaining(['w1', 'w2']));
    expect(store.listWorkItemsByChannel('feishu:oc_other')).toEqual([]);
    expect(store.countWorkItemsByChannel('feishu:oc_g', 'open')).toBe(
      store.listWorkItemsByChannel('feishu:oc_g', { status: 'open' }).length,
    );
  });

  test('events are found by kind and trigger', () => {
    store.recordWorkEvent({
      workItemId: 'w-events',
      kind: 'input',
      triggerMessageId: 'om_in',
      now: NOW,
    });
    expect(store.hasWorkEvent('w-events', 'input', 'om_in')).toBe(true);
    expect(store.hasWorkEvent('w-events', 'ack', 'om_in')).toBe(false);
    expect(store.hasWorkEvent('w-other', 'input', 'om_in')).toBe(false);
  });

  test('a reply is recorded once and stays pending until settled', () => {
    const reply = {
      id: 'ack:w1:om_1',
      workspaceJid: 'web:ws',
      workItemId: 'w1',
      channelJid: 'feishu:oc_g',
      quoteMessageId: 'om_1',
      text: '收到',
      purpose: 'ack',
      laneJid: 'web:ws#agent:a1',
      now: NOW,
    };
    expect(store.insertWorkItemReply(reply)).toMatchObject({
      status: 'pending',
      attempt: 0,
    });
    expect(store.insertWorkItemReply({ ...reply, text: 'other' }).text).toBe(
      '收到',
    );
    expect(store.listPendingWorkItemReplies().map((r) => r.id)).toEqual([
      'ack:w1:om_1',
    ]);
    store.updateWorkItemReply(
      reply.id,
      { status: 'delivered', attempt: 1, providerMessageId: 'om_bot' },
      NOW,
    );
    expect(store.getWorkItemReply(reply.id)).toMatchObject({
      status: 'delivered',
      providerMessageId: 'om_bot',
    });
    expect(store.listPendingWorkItemReplies()).toEqual([]);
  });

  test('an acknowledgement is recorded once per trigger', () => {
    expect(
      store.recordWorkEvent({
        workItemId: 'w1',
        kind: 'ack',
        text: 'On it',
        triggerMessageId: 'om_1',
        now: NOW,
      }),
    ).toBeGreaterThan(0);
    expect(
      store.recordWorkEvent({
        workItemId: 'w2',
        kind: 'ack',
        text: 'Again',
        triggerMessageId: 'om_1',
        now: NOW,
      }),
    ).toBeNull();
    store.recordWorkEvent({
      workItemId: 'w1',
      kind: 'report',
      state: 'progress',
      text: 'half way',
      now: NOW,
    });
    expect(store.listWorkEvents('w1').map((event) => event.kind)).toEqual([
      'ack',
      'report',
    ]);
  });

  test('settings and decisions round-trip; deleting the workspace clears them', () => {
    store.saveTeamMountSettings({
      channelJid: 'feishu:oc_g',
      workspaceJid: 'web:ws',
      settings: { ...DEFAULT_TEAM_SETTINGS, enabled: true, version: 1 },
      routerAgentId: 'router-1',
      updatedBy: 'u1',
      now: NOW,
    });
    expect(store.getTeamMountByRouter('router-1')?.channelJid).toBe(
      'feishu:oc_g',
    );
    expect(store.getTeamMount('feishu:oc_g')?.settings.enabled).toBe(true);
    store.recordWorkDecision({
      id: 'd1',
      workspaceJid: 'web:ws',
      channelJid: 'feishu:oc_g',
      triggerMessageId: 'om_9',
      strength: 'inferred',
      kind: 'would_accept',
      workItemId: null,
      reason: 'matches the small-defect rule',
      matchedRuleIds: ['r1'],
      createdAt: NOW,
    });
    expect(
      store.getWorkDecisionForTrigger('feishu:oc_g', 'om_9')?.matchedRuleIds,
    ).toEqual(['r1']);

    store.deleteWorkspaceWorkItems('web:ws');
    expect(store.listWorkItems('web:ws')).toEqual([]);
    expect(store.listWorkDecisions('web:ws')).toEqual([]);
    expect(store.getTeamMount('feishu:oc_g')).toBeUndefined();
    expect(store.listWorkEvents('w1')).toEqual([]);
    expect(store.getWorkItemReply('ack:w1:om_1')).toBeUndefined();
  });
});
