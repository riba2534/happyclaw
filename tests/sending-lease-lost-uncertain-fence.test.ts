import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'sending-lease-lost-uncertain-fence-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-primary',
  sourceJid: 'feishu:bot-primary:chat-1#root:root-1#thread:thread-1',
  chatId: 'chat-1',
  rootId: 'root-1',
  threadId: 'thread-1',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun(name: string, now: string) {
  return store.createChannelTurnRun({
    ...route,
    idempotencyKey: `uf-1087:${name}`,
    now,
  }).run;
}

interface ShadowOutboxItem {
  id: string;
  turnRunId: string;
  status:
    | 'claimed'
    | 'uploading'
    | 'uploaded'
    | 'sending'
    | 'delivered'
    | 'uncertain'
    | 'failed';
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  error: string | null;
  updatedAt: string;
  deliveredAt: string | null;
}

describe('UF-1087: post-sending lease expiry uncertain fence', () => {
  describe('A) shadow tip vs fix semantics', () => {
    function tipFailChannelOutbox(
      item: ShadowOutboxItem,
      { uncertain, now }: { uncertain: boolean; now: string },
    ): boolean {
      if (
        !['claimed', 'uploading', 'uploaded', 'sending'].includes(item.status)
      ) {
        return false;
      }
      if (!item.leaseExpiresAt || item.leaseExpiresAt <= now) return false;
      item.status = uncertain ? 'uncertain' : 'failed';
      item.leaseOwner = null;
      item.leaseExpiresAt = null;
      item.updatedAt = now;
      return true;
    }

    function tipCompleteChannelOutbox(
      item: ShadowOutboxItem,
      { now }: { now: string },
    ): boolean {
      if (!['claimed', 'uploaded', 'sending'].includes(item.status))
        return false;
      if (!item.leaseExpiresAt || item.leaseExpiresAt <= now) return false;
      item.status = 'delivered';
      item.leaseOwner = null;
      item.leaseExpiresAt = null;
      item.deliveredAt = now;
      return true;
    }

    function tipLeaseLost(item: ShadowOutboxItem) {
      if (item.status === 'delivered' || item.status === 'uncertain') {
        return { status: item.status, reused: item.status === 'delivered' };
      }
      return {
        status: 'lease_lost' as const,
        error:
          'Channel delivery lease was lost before the receipt could be persisted',
      };
    }

    function fixFailChannelOutbox(
      item: ShadowOutboxItem,
      { uncertain, now }: { uncertain: boolean; now: string },
    ): boolean {
      if (
        !['claimed', 'uploading', 'uploaded', 'sending'].includes(item.status)
      ) {
        return false;
      }
      if (!uncertain && (!item.leaseExpiresAt || item.leaseExpiresAt <= now)) {
        return false;
      }
      item.status = uncertain ? 'uncertain' : 'failed';
      item.leaseOwner = null;
      item.leaseExpiresAt = null;
      item.error =
        item.error ??
        'Delivery lease expired after send began; reconcile provider receipt before retry';
      item.updatedAt = now;
      return true;
    }

    function fixReconcileExpiredSending(item: ShadowOutboxItem, now: string) {
      if (
        item.status === 'sending' &&
        item.leaseExpiresAt !== null &&
        item.leaseExpiresAt <= now
      ) {
        item.status = 'uncertain';
        item.error =
          item.error ??
          'Delivery lease expired after send began; reconcile provider receipt before retry';
        item.leaseOwner = null;
        item.leaseExpiresAt = null;
        item.updatedAt = now;
      }
    }

    function fixLeaseLost(item: ShadowOutboxItem, now: string) {
      if (item.status === 'sending') {
        fixReconcileExpiredSending(item, now);
        if (item.status === 'uncertain' || item.status === 'delivered') {
          return { status: item.status, reused: item.status === 'delivered' };
        }
      }
      if (item.status === 'delivered' || item.status === 'uncertain') {
        return { status: item.status, reused: item.status === 'delivered' };
      }
      return {
        status: 'lease_lost' as const,
        error:
          'Channel delivery lease was lost before the receipt could be persisted',
      };
    }

    function getUncertain(item: ShadowOutboxItem) {
      return item.status === 'uncertain' ? item : undefined;
    }

    function tipAfterSendLeaseExpired(
      item: ShadowOutboxItem,
      kind: 'success' | 'throw',
      now: string,
    ) {
      if (kind === 'success') {
        if (!tipCompleteChannelOutbox(item, { now })) return tipLeaseLost(item);
        return { status: 'delivered' as const };
      }
      const uncertain = item.status === 'sending';
      if (!tipFailChannelOutbox(item, { uncertain, now })) {
        return tipLeaseLost(item);
      }
      return { status: item.status };
    }

    function fixAfterSendLeaseExpired(
      item: ShadowOutboxItem,
      kind: 'success' | 'throw',
      now: string,
    ) {
      if (kind === 'success') {
        if (!tipCompleteChannelOutbox(item, { now })) {
          return fixLeaseLost(item, now);
        }
        return { status: 'delivered' as const };
      }
      const uncertain = item.status === 'sending';
      if (!fixFailChannelOutbox(item, { uncertain, now })) {
        return fixLeaseLost(item, now);
      }
      return { status: item.status };
    }

    function freshSending(leaseExpiresAt: string): ShadowOutboxItem {
      return {
        id: 'ob-1',
        turnRunId: 'turn-1',
        status: 'sending',
        leaseOwner: 'owner-1',
        leaseToken: 1,
        leaseExpiresAt,
        error: null,
        updatedAt: 'T0',
        deliveredAt: null,
      };
    }

    function runOnce(
      label: string,
      afterSend: (
        item: ShadowOutboxItem,
        kind: 'success' | 'throw',
        now: string,
      ) => { status: string },
    ) {
      const leaseEnd = '2026-10-12T07:00:00.000Z';
      const afterLease = '2026-10-12T07:00:01.000Z';

      const a = freshSending(leaseEnd);
      const resultA = afterSend(a, 'success', afterLease);
      const uncertainA = getUncertain(a);

      const b = freshSending(leaseEnd);
      const resultB = afterSend(b, 'throw', afterLease);
      const uncertainB = getUncertain(b);

      const hostSeesUncertainFence = Boolean(uncertainA) && Boolean(uncertainB);
      const durableStuckSending =
        a.status === 'sending' || b.status === 'sending';

      const tipFail = durableStuckSending && !hostSeesUncertainFence;
      const fixPass =
        a.status === 'uncertain' &&
        b.status === 'uncertain' &&
        hostSeesUncertainFence &&
        !durableStuckSending;

      return {
        label,
        tipFail,
        fixPass,
        resultA: resultA.status,
        durableA: a.status,
        hostUncertainA: Boolean(uncertainA),
        resultB: resultB.status,
        durableB: b.status,
        hostUncertainB: Boolean(uncertainB),
        hostSeesUncertainFence,
        durableStuckSending,
      };
    }

    test('fail@tip leaves sending unfenced and pass@fix promotes both paths to uncertain', () => {
      const tip = runOnce('tip', tipAfterSendLeaseExpired);
      const fix = runOnce('fix', fixAfterSendLeaseExpired);

      expect(tip.tipFail).toBe(true);
      expect(tip.resultA).toBe('lease_lost');
      expect(tip.resultB).toBe('lease_lost');
      expect(tip.durableA).toBe('sending');
      expect(tip.durableB).toBe('sending');
      expect(tip.hostUncertainA).toBe(false);
      expect(tip.hostUncertainB).toBe(false);

      expect(fix.fixPass).toBe(true);
      expect(fix.resultA).toBe('uncertain');
      expect(fix.resultB).toBe('uncertain');
      expect(fix.durableA).toBe('uncertain');
      expect(fix.durableB).toBe('uncertain');
      expect(fix.hostUncertainA).toBe(true);
      expect(fix.hostUncertainB).toBe(true);
    });
  });

  describe('B) integration against channel-reliability-store + channel-outbox-delivery', () => {
    test('pass@fix throw-after-sending with expired lease fences durable row as uncertain', async () => {
      const baseMs = Date.now() - 60_000;
      let currentNow = new Date(baseMs).toISOString();
      const run = createRun('throw-after-sending-expired', currentNow);

      const result = await delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        payload: { text: 'throw after sending with expired lease' },
        owner: 'worker-throw-expired',
        leaseMs: 1_000,
        now: () => currentNow,
        afterPersist: (phase) => {
          if (phase === 'sending') {
            currentNow = new Date(baseMs + 5_000).toISOString();
          }
        },
        delivery: {
          mode: 'single',
          send: async () => {
            throw new Error('socket hang up after provider received request');
          },
        },
      });

      expect(result.status).toBe('uncertain');
      const item = store.getChannelOutboxItem(result.itemId);
      expect(item?.status).toBe('uncertain');
      expect(item?.leaseOwner).toBeNull();
      expect(item?.leaseExpiresAt).toBeNull();

      const fenced = store.getUncertainChannelOutboxForTurn(run.id);
      expect(fenced).toBeDefined();
      expect(fenced?.id).toBe(result.itemId);
      expect(store.hasUncertainChannelOutbox(run.id)).toBe(true);
    });

    test('pass@fix success-after-sending with expired lease reconciles sending to uncertain', async () => {
      const baseMs = Date.now() - 60_000;
      let currentNow = new Date(baseMs).toISOString();
      const run = createRun('success-after-sending-expired', currentNow);

      const result = await delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        payload: { text: 'success after sending with expired lease' },
        owner: 'worker-success-expired',
        leaseMs: 1_000,
        now: () => currentNow,
        afterPersist: (phase) => {
          if (phase === 'sending') {
            currentNow = new Date(baseMs + 5_000).toISOString();
          }
        },
        delivery: {
          mode: 'single',
          send: async () => ({
            providerMessageId: 'om_late_provider_receipt',
          }),
        },
      });

      expect(result.status).toBe('uncertain');
      const item = store.getChannelOutboxItem(result.itemId);
      expect(item?.status).toBe('uncertain');
      expect(item?.status).not.toBe('sending');
      expect(item?.leaseOwner).toBeNull();
      expect(item?.leaseExpiresAt).toBeNull();

      const fenced = store.getUncertainChannelOutboxForTurn(run.id);
      expect(fenced).toBeDefined();
      expect(fenced?.id).toBe(result.itemId);
      expect(store.hasUncertainChannelOutbox(run.id)).toBe(true);
    });
  });
});
