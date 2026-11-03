import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im-follow-up-host-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { resolveFollowUpMode } = await import('../src/follow-up-policy.js');
const { getChannelType } = await import('../src/im-channel.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The host half of the durable follow-up queue, executed from index.ts
 * against a real database: what every connector's onFollowUpMessage and
 * onSessionBreak lead to. Connector tests pin the other half (which inputs
 * reach these callbacks, with which arguments).
 */
function hostHarness() {
  let activeRunId: string | null = 'run-1';
  const queue = {
    getActiveQueryId: vi.fn(() => activeRunId),
    hasBackgroundHold: vi.fn(() => false),
    interruptQuery: vi.fn(() => true),
    activeQueryExclusivelyCoversMessage: vi.fn(() => false),
  };
  const interruptActiveSessionRun = vi.fn(() => ({
    activeRunId,
    interrupted: activeRunId !== null,
  }));
  const globals: Record<string, unknown> = {
    queue,
    resolveFollowUpMode,
    setMessageFollowUp: db.setMessageFollowUp,
    listQueuedFollowUps: db.listQueuedFollowUps,
    getQueuedFollowUp: db.getQueuedFollowUp,
    cancelQueuedFollowUpsAtCutoff: db.cancelQueuedFollowUpsAtCutoff,
    getChannelType,
    markSteeringInterrupt: vi.fn(),
    clearSteeringInterrupt: vi.fn(),
    dispatchQueuedFollowUpFamily: vi.fn(),
    clearTrackedProcessingIndicators: vi.fn(async () => undefined),
    clearStandaloneProcessingIndicator: vi.fn(async () => undefined),
    broadcastFollowUpUpdate: vi.fn(),
    closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
    channelTurnScopeForInput: vi.fn(() => null),
    interruptActiveSessionRun,
    endUsageLimitWait: vi.fn(),
    learnFeishuDirectChat: vi.fn(),
    // No registered chat: a group route that failed must not be guessed.
    registeredGroups: {},
    getRegisteredGroup: vi.fn(() => undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'deliverWithoutInterruptingBackgroundWork',
    'steerQueuedFollowUpBatch',
    'handleIncomingFollowUp',
    'resolveRuntimeControlTarget',
    'handleSessionBreak',
  ]) {
    harness.install(name);
  }
  return {
    queue,
    interruptActiveSessionRun,
    setActive: (runId: string | null) => {
      activeRunId = runId;
    },
    offer: globals.handleIncomingFollowUp as (input: {
      targetJid: string;
      sourceJid: string;
      messageId: string;
      senderImId: string;
      requestedMode?: 'steer';
    }) => { disposition: string; position?: number },
    breakSession: globals.handleSessionBreak as (input: {
      sourceJid: string;
      targetJid?: string;
      senderImId: string;
      chatType?: string;
    }) => Promise<string>,
  };
}

const CHANNELS = [
  ['telegram', 'telegram:4242', 'tg:4242'],
  ['dingtalk', 'dingtalk:c2c:staff-1', 'dingtalk:staff-1'],
  ['discord', 'discord:dm:777', 'discord:777'],
  [
    'whatsapp',
    'whatsapp:15550001@s.whatsapp.net',
    'whatsapp:15550001@s.whatsapp.net',
  ],
  ['wechat', 'wechat:wxid_peer', 'wechat:wxid_peer'],
  ['wecom', 'wecom:c2c:user-1', 'wecom:user-1'],
] as const;

let clock = Date.parse('2026-10-27T08:00:00.000Z');

describe.each(CHANNELS)(
  '%s inputs on the host queue',
  (provider, sourceJid, sender) => {
    const targetJid = `web:queue-${provider}`;

    /** What the connector does: persist the row, then offer it. */
    function arrive(
      host: ReturnType<typeof hostHarness>,
      id: string,
      extra: { attachments?: string; steer?: boolean; source?: string } = {},
    ) {
      clock += 1000;
      const source = extra.source ?? sourceJid;
      db.storeMessageDirect(
        id,
        targetJid,
        sender,
        'Member',
        `${id} text`,
        new Date(clock).toISOString(),
        false,
        { sourceJid: source, attachments: extra.attachments },
      );
      return host.offer({
        targetJid,
        sourceJid: source,
        messageId: id,
        senderImId: sender,
        requestedMode: extra.steer ? 'steer' : undefined,
      });
    }

    test('inputs during a run queue durably and drain as one next batch with /steer', () => {
      db.ensureChatExists(targetJid);
      const host = hostHarness();
      const image = JSON.stringify([
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ]);
      expect(arrive(host, `${provider}-a`)).toMatchObject({
        disposition: 'queued',
        position: 1,
      });
      expect(
        arrive(host, `${provider}-b`, { attachments: image }),
      ).toMatchObject({ disposition: 'queued', position: 2 });
      // Nothing queued is visible to the warm-runner injection path.
      expect(
        db.getMessagesSince(targetJid, { timestamp: '', id: '', sequence: 0 }),
      ).toEqual([]);

      expect(arrive(host, `${provider}-steer`, { steer: true })).toMatchObject({
        disposition: 'steered',
      });
      expect(host.queue.interruptQuery).toHaveBeenCalledWith(
        targetJid,
        'run-1',
      );

      const batch = db.claimNextQueuedFollowUpBatch(targetJid, 'run-2');
      expect(batch.map((item) => item.id)).toEqual([
        `${provider}-a`,
        `${provider}-b`,
        `${provider}-steer`,
      ]);
      expect(batch.every((item) => item.source_jid === sourceJid)).toBe(true);
      expect(batch[1].attachments).toBe(image);
      expect(db.releaseQueuedFollowUpBatch(batch, 'run-2')).toBe(true);
    });

    test('/break cancels the pending inputs and spares the ones after it', async () => {
      const host = hostHarness();
      arrive(host, `${provider}-p1`);
      arrive(host, `${provider}-p2`);
      await expect(
        host.breakSession({
          sourceJid,
          targetJid,
          senderImId: sender,
          chatType: 'p2p',
        }),
      ).resolves.toBe('Current task stopped.');
      expect(host.interruptActiveSessionRun).toHaveBeenCalledWith(
        targetJid,
        '/break',
        { withdrawDeliveryIds: [] },
      );
      expect(db.listQueuedFollowUps(targetJid)).toEqual([]);

      arrive(host, `${provider}-after`);
      expect(db.listQueuedFollowUps(targetJid).map((item) => item.id)).toEqual([
        `${provider}-after`,
      ]);
      db.cancelQueuedFollowUpsAtCutoff(targetJid);
    });

    test('a group /break without a routed target reports it instead of guessing', async () => {
      const host = hostHarness();
      await expect(
        host.breakSession({ sourceJid, senderImId: sender, chatType: 'group' }),
      ).resolves.toBe('当前绑定目标不存在，无法执行 /break。');
      expect(host.interruptActiveSessionRun).not.toHaveBeenCalled();
    });

    test('another source in the same Session is never batched under this reply target', () => {
      const host = hostHarness();
      arrive(host, `${provider}-mine`);
      arrive(host, `${provider}-web`, { source: 'web:elsewhere' });
      expect(
        db.claimNextQueuedFollowUpBatch(targetJid, 'run-3').map((i) => i.id),
      ).toEqual([`${provider}-mine`]);
      db.cancelQueuedFollowUpsAtCutoff(targetJid);
    });

    test('with no active run the input starts a turn immediately', () => {
      const host = hostHarness();
      host.setActive(null);
      expect(arrive(host, `${provider}-idle`)).toEqual({
        disposition: 'started',
      });
      expect(db.listQueuedFollowUps(targetJid)).toEqual([]);
    });
  },
);
