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

  test('an Axios-style Feishu HTTP 400 is definitive and leaves text fallback available', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-http-400',
    }).run;
    const request = {
      operation: 'send_card' as const,
      params: {
        card: {
          schema: '2.0',
          body: { elements: [{ tag: 'unsupported' }] },
        },
      },
    };
    const rejected = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'invalid-v2-card',
      request,
      owner: 'invalid-v2-card-worker',
      execute: async () => {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: {
              code: 230099,
              msg: 'cards of schema V2 do not support this component',
            },
          },
        });
      },
    });

    expect(rejected.delivery).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('http=400'),
    });
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();

    const fallback = await delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 2,
      kind: 'text',
      payload: { text: 'The report is ready: https://example.com/report' },
      owner: 'fallback-worker',
      delivery: {
        mode: 'single',
        send: async () => ({ providerMessageId: 'om_fallback' }),
      },
    });
    expect(fallback.status).toBe('delivered');
  });

  test('a Feishu HTTP 429 ends failed instead of an orphaned retry_wait row', async () => {
    const now = '2026-07-26T08:00:00.000Z';
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-http-429',
      now,
    }).run;
    const result = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'provider-429',
      request: {
        operation: 'send_card',
        params: { card: { schema: '2.0', body: { elements: [] } } },
      },
      owner: 'provider-429-worker',
      now: () => now,
      execute: async () => {
        throw Object.assign(new Error('Request failed with status code 429'), {
          response: {
            status: 429,
            headers: { 'retry-after': '2' },
            data: { code: 99991400, msg: 'rate limit exceeded' },
          },
        });
      },
    });

    // Capability rows have no reclaiming worker, so a provider retry hint
    // must not leave a non-terminal retry_wait row behind.
    expect(result.delivery).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('http=429'),
    });
    expect(store.getChannelOutboxItem(result.delivery.itemId)?.status).toBe(
      'failed',
    );
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();
  });

  test('a Feishu 5xx remains uncertain because acceptance cannot be ruled out', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-http-502',
    }).run;
    const request = {
      operation: 'send_card' as const,
      params: { card: { schema: '2.0', body: { elements: [] } } },
    };
    const result = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'provider-502',
      request,
      owner: 'provider-502-worker',
      execute: async () => {
        throw Object.assign(new Error('Request failed with status code 502'), {
          response: {
            status: 502,
            data: { code: 230099, msg: 'upstream failure' },
          },
        });
      },
    });

    expect(result.delivery).toMatchObject({
      status: 'uncertain',
      error: 'Request failed with status code 502',
    });
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toMatchObject({
      status: 'uncertain',
    });
  });

  test('an intermediary HTTP 408 remains uncertain', async () => {
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'feishu-mutation-http-408',
    }).run;
    const request = {
      operation: 'send_card' as const,
      params: { card: { schema: '2.0', body: { elements: [] } } },
    };
    const result = await deliverFeishuCapabilityMutation({
      ...route,
      turnRunId: run.id,
      requestId: 'provider-408',
      request,
      owner: 'provider-408-worker',
      execute: async () => {
        throw Object.assign(new Error('Request failed with status code 408'), {
          response: { status: 408, data: { code: 408, msg: 'timeout' } },
        });
      },
    });

    expect(result.delivery.status).toBe('uncertain');
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
  test('send_card carries a Feishu uuid derived from the durable Outbox identity', async () => {
    const seen: Array<string | undefined> = [];
    const deliver = async (idempotencyKey: string) => {
      const run = store.createChannelTurnRun({ ...route, idempotencyKey }).run;
      const request: {
        operation: 'send_card';
        params: Record<string, unknown>;
        providerUuid?: string;
      } = {
        operation: 'send_card',
        params: { card: { schema: '2.0', body: { elements: [] } } },
      };
      await deliverFeishuCapabilityMutation({
        ...route,
        turnRunId: run.id,
        requestId: `uuid-${idempotencyKey}`,
        request,
        owner: 'uuid-worker',
        execute: async () => {
          // The broker hands the same request object to the executor.
          seen.push(request.providerUuid);
          return { operation: 'send_card', data: { messageId: 'om_uuid' } };
        },
      });
      return request.providerUuid;
    };
    const first = await deliver('feishu-mutation-uuid-a');
    const second = await deliver('feishu-mutation-uuid-b');
    expect(first).toMatch(/^hc[a-f0-9]{40}$/);
    expect(first!.length).toBeLessThanOrEqual(50);
    expect(seen).toEqual([first, second]);
    expect(second).not.toBe(first);
  });
});
