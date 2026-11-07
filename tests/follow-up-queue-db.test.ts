import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-queue-db-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('durable follow-up queue', () => {
  test('a bounded candidate batch leaves later queued inputs unclaimed', () => {
    const jid = 'web:candidate-intake-limit';
    db.ensureChatExists(jid);
    for (const id of ['a', 'b', 'c']) {
      db.storeMessageDirect(
        id,
        jid,
        'member',
        '成员',
        id,
        '2026-11-06T08:00:00Z',
        false,
        {
          sourceJid: 'feishu:oc_team',
          meta: { deliveryMode: 'queue', deliveryStatus: 'queued' },
        },
      );
    }
    const claimed = db.claimNextQueuedFollowUpBatch(jid, 'intake-batch', 2);
    expect(claimed.map((row) => row.id)).toEqual(['a', 'b']);
    expect(db.getAgentBuilderInputMessage(jid, 'c')?.delivery_status).toBe(
      'queued',
    );
    expect(
      db.claimNextQueuedFollowUpBatch(jid, 'next-batch').map((row) => row.id),
    ).toEqual(['c']);
  });
  test('atomically claims an adjacent merged-forward root and note', () => {
    const jid = 'web:follow-up-forward-bundle';
    db.ensureChatExists(jid);
    const store = (
      id: string,
      timestamp: string,
      role: 'forwarded_content' | 'forwarder_comment',
    ) =>
      db.storeMessageDirect(id, jid, 'user-1', 'User', id, timestamp, false, {
        sourceJid:
          role === 'forwarded_content'
            ? 'feishu:bot-a:oc_chat'
            : 'feishu:bot-a:oc_chat#root:om_root',
        channelContext: {
          schemaVersion: 1,
          provider: 'feishu',
          channelAccountId: 'bot-a',
          sourceJid:
            role === 'forwarded_content'
              ? 'feishu:bot-a:oc_chat'
              : 'feishu:bot-a:oc_chat#root:om_root',
          chat: { id: 'oc_chat', type: 'group' },
          message: {
            id,
            ...(role === 'forwarder_comment'
              ? { rootId: 'om_root', parentId: 'om_root' }
              : {}),
            contentLink: {
              kind: 'forward_bundle',
              bundleId: 'om_root',
              role,
            },
          },
        },
        meta: {
          deliveryMode: 'queue',
          deliveryStatus: 'queued',
          deliveryRunId: 'run-current',
        },
      });

    store('om_root', '2026-07-20T00:00:00.000Z', 'forwarded_content');
    store('om_note', '2026-07-20T00:00:01.000Z', 'forwarder_comment');

    expect(
      db.claimNextQueuedFollowUpBatch(jid, 'run-bundle').map((item) => item.id),
    ).toEqual(['om_root', 'om_note']);
    expect(db.listQueuedFollowUps(jid)).toEqual([
      expect.objectContaining({
        id: 'om_root',
        delivery_status: 'promoting',
        delivery_run_id: 'run-bundle',
      }),
      expect.objectContaining({
        id: 'om_note',
        delivery_status: 'promoting',
        delivery_run_id: 'run-bundle',
      }),
    ]);
    const claimed = db.listQueuedFollowUps(jid);
    expect(db.releaseQueuedFollowUpBatch(claimed, 'run-bundle')).toBe(true);
    expect(
      db
        .getMessagesPage(jid)
        .filter((item) => item.id === 'om_root' || item.id === 'om_note')
        .every((item) => item.delivery_status === 'released'),
    ).toBe(true);
  });

  test('separates a Web turn from the subsequent Feishu forward bundle', () => {
    const jid = 'web:follow-up-forward-boundary';
    db.ensureChatExists(jid);
    for (const [index, id] of ['ordinary', 'om_root', 'om_note'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T01:00:00.000Z') + index).toISOString(),
        false,
        {
          ...(id !== 'ordinary'
            ? {
                sourceJid: 'feishu:bot-a:oc_chat',
                channelContext: {
                  schemaVersion: 1 as const,
                  provider: 'feishu',
                  channelAccountId: 'bot-a',
                  sourceJid: 'feishu:bot-a:oc_chat',
                  chat: { id: 'oc_chat', type: 'group' as const },
                  message: {
                    id,
                    contentLink: {
                      kind: 'forward_bundle' as const,
                      bundleId: 'om_root',
                      role:
                        id === 'om_root'
                          ? ('forwarded_content' as const)
                          : ('forwarder_comment' as const),
                    },
                  },
                },
              }
            : {}),
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
          },
        },
      );
    }

    expect(
      db
        .claimNextQueuedFollowUpBatch(jid, 'run-ordinary')
        .map((item) => item.id),
    ).toEqual(['ordinary']);
    expect(
      db.claimNextQueuedFollowUpBatch(jid, 'run-feishu').map((item) => item.id),
    ).toEqual(['om_root', 'om_note']);
    expect(db.claimNextQueuedFollowUpBatch(jid, 'run-empty')).toEqual([]);
  });

  test('keeps durable FIFO when a later arrival carries an older provider timestamp', () => {
    const jid = 'web:follow-up-late-clock';
    db.ensureChatExists(jid);
    for (const [id, timestamp] of [
      ['first-arrival', '2026-08-31T06:00:00.000Z'],
      ['late-old-clock', '2020-01-01T00:00:00.000Z'],
    ]) {
      db.storeMessageDirect(id, jid, 'user-1', 'User', id, timestamp, false, {
        meta: { deliveryMode: 'queue', deliveryStatus: 'queued' },
      });
    }

    const claimed = db.claimNextQueuedFollowUpBatch(jid, 'run-late-clock');
    expect(claimed.map((item) => item.id)).toEqual([
      'first-arrival',
      'late-old-clock',
    ]);
    expect(claimed[0].ingest_sequence).toBeLessThan(
      claimed[1].ingest_sequence!,
    );
  });

  test('merges an explicit steer with the Session pending batch', () => {
    const jid = 'web:follow-up-steer-barrier';
    db.ensureChatExists(jid);
    for (const [index, id] of ['first', 'second', 'third'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T01:30:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(
      db.prioritizeQueuedFollowUp(jid, 'second', 'run-current'),
    ).toMatchObject({ delivery_mode: 'steer' });
    expect(
      db.claimNextQueuedFollowUpBatch(jid, 'run-steer').map((item) => item.id),
    ).toEqual(['second', 'first', 'third']);
    expect(db.claimNextQueuedFollowUpBatch(jid, 'run-empty')).toEqual([]);
  });

  test('leaves messages admitted after a snapshot for the following turn', () => {
    const jid = 'web:follow-up-snapshot-boundary';
    db.ensureChatExists(jid);
    const store = (id: string, timestamp: string) =>
      db.storeMessageDirect(id, jid, 'user-1', 'User', id, timestamp, false, {
        meta: {
          deliveryMode: 'queue',
          deliveryStatus: 'queued',
          deliveryRunId: 'run-current',
        },
      });

    store('before-one', '2026-07-20T01:45:00.000Z');
    store('before-two', '2026-07-20T01:45:01.000Z');
    expect(
      db
        .claimNextQueuedFollowUpBatch(jid, 'run-snapshot')
        .map((item) => item.id),
    ).toEqual(['before-one', 'before-two']);

    store('after-snapshot', '2026-07-20T01:45:02.000Z');
    expect(db.listQueuedFollowUps(jid)).toEqual([
      expect.objectContaining({
        id: 'before-one',
        delivery_status: 'promoting',
      }),
      expect.objectContaining({
        id: 'before-two',
        delivery_status: 'promoting',
      }),
      expect.objectContaining({
        id: 'after-snapshot',
        delivery_status: 'queued',
      }),
    ]);
  });

  test('hides queued rows from the runner and releases them in priority order', () => {
    const jid = 'web:follow-up-test';
    const timestamp = '2026-07-20T00:00:00.000Z';
    db.ensureChatExists(jid);
    for (const [index, id] of ['first', 'second', 'third'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse(timestamp) + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);

    const claimed = db.claimNextQueuedFollowUp(jid, 'run-next');
    expect(claimed?.id).toBe('first');
    expect(db.getQueuedFollowUp(jid, 'first')).toMatchObject({
      delivery_status: 'promoting',
      delivery_run_id: 'run-next',
    });

    const releasedAt = '2026-07-20T00:00:05.000Z';
    expect(
      db.releaseQueuedFollowUp(jid, 'first', 'run-next', releasedAt),
    ).not.toBeNull();
    expect(
      db.getMessagesPage(jid).find((item) => item.id === 'first'),
    ).toMatchObject({
      delivery_status: 'released',
      delivery_run_id: 'run-next',
      delivery_updated_at: releasedAt,
    });
    expect(
      db
        .getMessagesSince(jid, { timestamp: '', id: '' })
        .map((item) => item.id),
    ).toEqual(['first']);

    expect(db.cancelQueuedFollowUp(jid, 'third')).not.toBeNull();
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'second',
    ]);
  });

  test('moves an explicit steer ahead without releasing it into the active turn', () => {
    const jid = 'web:follow-up-steer-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['queued-first', 'steer-me'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T01:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    const steered = db.prioritizeQueuedFollowUp(jid, 'steer-me', 'run-current');
    expect(steered).toMatchObject({
      id: 'steer-me',
      delivery_mode: 'steer',
      delivery_status: 'queued',
      delivery_run_id: 'run-current',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'steer-me',
      'queued-first',
    ]);
    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
  });

  test('edits and reorders normal queued messages without releasing them', () => {
    const jid = 'web:follow-up-manage-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['one', 'two', 'three'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        `message ${id}`,
        new Date(Date.parse('2026-07-20T02:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(
      db.updateQueuedFollowUpContent(jid, 'two', '  edited two  '),
    ).toMatchObject({ id: 'two', content: 'edited two' });
    expect(db.moveQueuedFollowUp(jid, 'three', 'up')).toMatchObject({
      id: 'three',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'one',
      'three',
      'two',
    ]);
    expect(db.moveQueuedFollowUp(jid, 'three', 'up')).toMatchObject({
      id: 'three',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'three',
      'one',
      'two',
    ]);
    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
  });

  test('locks editing and reordering after a queued message starts steering', () => {
    const jid = 'web:follow-up-locked-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['first', 'second'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T03:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(
      db.prioritizeQueuedFollowUp(jid, 'second', 'run-current'),
    ).not.toBeNull();
    expect(db.updateQueuedFollowUpContent(jid, 'second', 'changed')).toBeNull();
    expect(db.moveQueuedFollowUp(jid, 'second', 'down')).toBeNull();
    expect(db.listQueuedFollowUps(jid)[0]).toMatchObject({
      id: 'second',
      content: 'second',
      delivery_mode: 'steer',
    });
  });

  test('does not cancel a note after a late forward root depends on it', () => {
    const jid = 'web:follow-up-covered-root';
    db.ensureChatExists(jid);
    db.storeMessageDirect(
      'om_note_owner',
      jid,
      'user-1',
      'User',
      '请分析',
      '2026-07-20T04:00:01.000Z',
      false,
      {
        meta: { deliveryMode: 'queue', deliveryStatus: 'queued' },
      },
    );
    db.storeMessageDirect(
      'om_late_root',
      jid,
      'user-1',
      'User',
      '[合并转发消息]',
      '2026-07-20T04:00:00.000Z',
      false,
      {
        meta: {
          deliveryStatus: 'subsumed',
          deliveryRunId: 'om_note_owner',
        },
      },
    );

    expect(db.cancelQueuedFollowUp(jid, 'om_note_owner')).toBeNull();
    expect(db.getQueuedFollowUp(jid, 'om_note_owner')).not.toBeNull();
  });

  test('/break atomically cancels the current queue cutoff including a covered root', () => {
    const jid = 'web:follow-up-break-cutoff';
    db.ensureChatExists(jid);
    for (const [id, timestamp] of [
      ['first', '2026-07-20T05:00:00.000Z'],
      ['note', '2026-07-20T05:00:01.000Z'],
    ]) {
      db.storeMessageDirect(id, jid, 'user-1', 'User', id, timestamp, false, {
        meta: {
          deliveryMode: 'queue',
          deliveryStatus: 'queued',
          deliveryRunId: 'run-active',
        },
      });
    }
    db.storeMessageDirect(
      'covered-root',
      jid,
      'user-1',
      'User',
      '[合并转发消息]',
      '2026-07-20T04:59:59.000Z',
      false,
      {
        meta: {
          deliveryStatus: 'subsumed',
          deliveryRunId: 'note',
        },
      },
    );

    expect(
      db
        .cancelQueuedFollowUpsAtCutoff(jid, '2026-07-20T05:00:02.000Z')
        .map((item) => item.id),
    ).toEqual(['first', 'note']);
    expect(db.listQueuedFollowUps(jid)).toEqual([]);
    const statuses = new Map(
      db
        .getMessagesPage(jid)
        .map((message) => [message.id, message.delivery_status]),
    );
    expect(statuses.get('first')).toBe('cancelled');
    expect(statuses.get('note')).toBe('cancelled');
    expect(statuses.get('covered-root')).toBe('cancelled');

    db.storeMessageDirect(
      'after-break',
      jid,
      'user-1',
      'User',
      'after',
      '2026-07-20T05:00:03.000Z',
      false,
      {
        meta: { deliveryMode: 'queue', deliveryStatus: 'queued' },
      },
    );
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'after-break',
    ]);
  });
});
