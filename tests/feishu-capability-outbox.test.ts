import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-mutation-outbox-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const { deliverFeishuCapabilityMutation } =
  await import('../src/feishu-capability-outbox.js');
const { isFeishuCapabilityMutation } =
  await import('../src/feishu-capability.js');
const { DefinitiveFeishuCapabilityError } =
  await import('../src/feishu-capability.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-capability',
  sourceJid:
    'feishu:chat-capability#account:bot-capability#root:root-capability#thread:thread-capability',
  chatId: 'chat-capability',
  rootId: 'root-capability',
  threadId: 'thread-capability',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Feishu capability mutation outbox', () => {
  test('classifies only read operations and generic GET as direct queries', () => {
    expect(isFeishuCapabilityMutation({ operation: 'get_chat' })).toBe(false);
    expect(isFeishuCapabilityMutation({ operation: 'get_history' })).toBe(
      false,
    );
    expect(
      isFeishuCapabilityMutation({
        operation: 'api_request',
        params: { method: 'GET', path: '/open-apis/docx/v1/documents/x' },
      }),
    ).toBe(false);
    expect(isFeishuCapabilityMutation({ operation: 'send_card' })).toBe(true);
    expect(isFeishuCapabilityMutation({ operation: 'add_reaction' })).toBe(
      true,
    );
    expect(
      isFeishuCapabilityMutation({
        operation: 'api_request',
        params: { method: 'PATCH', path: '/open-apis/docx/v1/documents/x' },
      }),
    ).toBe(true);
  });

  test('a new requestId reuses the delivered semantic mutation without a second provider call', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-delivered',
    }).run;
    let physicalCalls = 0;
    const request = {
      operation: 'add_reaction' as const,
      params: { messageId: 'om_target', emojiType: 'THUMBSUP' },
    };
    const execute = async () => {
      physicalCalls++;
      return {
        operation: request.operation,
        data: { messageId: 'om_target', reactionId: 'reaction-1' },
      };
    };
    const first = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'request-one',
      request,
      owner: 'worker-one',
      execute,
    });
    const replay = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'request-two',
      request,
      owner: 'worker-two',
      execute,
    });

    expect(first.delivery).toMatchObject({
      status: 'delivered',
      reused: false,
    });
    expect(first.result).toMatchObject({
      data: { reactionId: 'reaction-1' },
    });
    expect(replay.delivery).toMatchObject({
      status: 'delivered',
      reused: true,
    });
    expect(replay.result).toBeUndefined();
    expect(physicalCalls).toBe(1);
  });

  test('provider acceptance followed by process death becomes uncertain and a new requestId never calls twice', async () => {
    let now = '2026-07-23T10:00:00.000Z';
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-crash-after-provider',
      now,
    }).run;
    let physicalCalls = 0;
    const request = {
      operation: 'send_card' as const,
      params: { card: { header: { title: { content: 'Done' } } } },
    };
    const crashed = deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'request-before-crash',
      request,
      owner: 'worker-before-crash',
      leaseMs: 1_000,
      now: () => now,
      execute: async () => {
        physicalCalls++;
        // The provider accepted the operation, then this process disappeared
        // before it could persist the provider receipt.
        throw new delivery.ChannelDeliveryProcessCrash();
      },
    });
    await expect(crashed).rejects.toBeInstanceOf(
      delivery.ChannelDeliveryProcessCrash,
    );
    expect(physicalCalls).toBe(1);
    expect(
      store
        .scanChannelReliabilityNonterminal()
        .outbox.find((item) => item.turnRunId === run.id),
    ).toMatchObject({ status: 'sending' });

    now = '2026-07-23T10:00:01.001Z';
    expect(store.reconcileExpiredChannelOutbox(now)).toEqual({
      retryable: 0,
      uncertain: 1,
    });
    const replay = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'request-after-crash',
      request,
      owner: 'worker-after-crash',
      now: () => now,
      execute: async () => {
        physicalCalls++;
        return {
          operation: request.operation,
          data: { messageId: 'duplicate' },
        };
      },
    });
    expect(replay.delivery.status).toBe('uncertain');
    expect(physicalCalls).toBe(1);
  });

  test('an explicit broker or provider rejection fails definitively without fencing sibling delivery', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-definitive-rejection',
    }).run;
    const request = {
      operation: 'send_card' as const,
      params: { card: { header: { background_color: 'invalid' } } },
    };
    const rejected = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'invalid-card-request',
      request,
      owner: 'invalid-card-worker',
      execute: async () => {
        throw new DefinitiveFeishuCapabilityError(
          'send_card failed (code=230099, msg=parse card json err)',
        );
      },
    });

    expect(rejected.delivery).toMatchObject({
      status: 'failed',
      reused: false,
      error: expect.stringContaining('parse card json err'),
    });
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();

    const sibling = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'fall back to a normal message' },
      owner: 'normal-message-worker',
      delivery: {
        mode: 'single',
        send: async () => ({ providerMessageId: 'om_normal_fallback' }),
      },
    });
    expect(sibling.status).toBe('delivered');
  });

  test('the host integration requires exact input scope for mutations', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const branch = main.slice(
      main.indexOf("case 'feishu_capability':"),
      main.indexOf("case 'refresh_groups':"),
    );
    expect(branch).toContain('isFeishuCapabilityMutation(request)');
    expect(branch).toContain('activeChannelOutboxScopes.resolveInput');
    expect(branch).toContain('deliverFeishuCapabilityMutation');
    expect(branch).toContain('do not retry automatically');
  });
});
