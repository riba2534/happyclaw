import type { Dispatcher } from 'undici';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  WeChatContextTokenClaimInput,
  WeChatContextTokenRecord,
  WeChatContextTokenReleaseInput,
  WeChatContextTokenStore,
} from '../src/wechat-context-token.js';

const dbCalls = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  ...dbCalls,
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');
const { weChatClientIdForChunk } = await import('../src/wechat-outbound.js');

beforeEach(() => {
  vi.clearAllMocks();
  dbCalls.storeMessageDirect.mockImplementation(() => undefined);
});

class SharedStore implements WeChatContextTokenStore {
  record: WeChatContextTokenRecord | undefined;

  list(accountId: string): WeChatContextTokenRecord[] {
    return this.record?.accountId === accountId ? [{ ...this.record }] : [];
  }

  upsert(input: {
    accountId: string;
    userId: string;
    token: string;
    refreshedAtMs: number;
    sourceMessageId?: string | null;
    sourceSequence?: number | null;
  }): WeChatContextTokenRecord {
    this.record = { ...input, sendCount: 0, lastSentAtMs: null };
    return { ...this.record };
  }

  claim(
    input: WeChatContextTokenClaimInput,
  ):
    | { status: 'claimed'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' | 'expired' | 'quota_exhausted' } {
    const record = this.record;
    if (!record) return { status: 'missing' };
    if (
      record.token !== input.expectedToken ||
      record.refreshedAtMs !== input.expectedRefreshedAtMs ||
      (input.expectedSourceMessageId !== undefined &&
        (record.sourceMessageId ?? null) !== input.expectedSourceMessageId)
    ) {
      return { status: 'changed' };
    }
    const claimed = {
      ...record,
      sendCount: record.sendCount + input.claimCount,
      lastSentAtMs: input.nowMs,
    };
    this.record = claimed;
    return { status: 'claimed', record: { ...claimed } };
  }

  release(
    input: WeChatContextTokenReleaseInput,
  ):
    | { status: 'released'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' } {
    const record = this.record;
    if (!record) return { status: 'missing' };
    if (
      record.token !== input.expectedToken ||
      record.refreshedAtMs !== input.expectedRefreshedAtMs ||
      (input.expectedSourceMessageId !== undefined &&
        (record.sourceMessageId ?? null) !== input.expectedSourceMessageId) ||
      record.sendCount < input.releaseCount
    ) {
      return { status: 'changed' };
    }
    const released = {
      ...record,
      sendCount: record.sendCount - input.releaseCount,
    };
    this.record = released;
    return { status: 'released', record: { ...released } };
  }

  delete(input: {
    accountId: string;
    userId: string;
    expectedToken?: string;
    expectedRefreshedAtMs?: number;
    expectedSourceMessageId?: string | null;
  }): boolean {
    if (
      !this.record ||
      this.record.accountId !== input.accountId ||
      this.record.userId !== input.userId ||
      (input.expectedToken !== undefined &&
        (this.record.token !== input.expectedToken ||
          this.record.refreshedAtMs !== input.expectedRefreshedAtMs ||
          (input.expectedSourceMessageId !== undefined &&
            (this.record.sourceMessageId ?? null) !==
              input.expectedSourceMessageId)))
    ) {
      return false;
    }
    this.record = undefined;
    return true;
  }
}

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('WeChat connection durable context_token integration', () => {
  test('does not consume send quota when media upload fails before sendmessage', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-1',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const uploadFailure = new Error('CDN unavailable');
    const uploadMedia = vi.fn(async () => {
      throw uploadFailure;
    });
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: vi.fn((_url, init) =>
          waitUntilAborted(init?.signal),
        ) as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
        uploadMediaBuffer: uploadMedia,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await expect(
      connection.sendImage(
        'peer',
        Buffer.from('image'),
        'image/png',
        'caption',
      ),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_REJECTED',
      cause: uploadFailure,
    });
    expect(store.record?.sendCount).toBe(0);
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-wechat-upload-')),
      'report.txt',
    );
    fs.writeFileSync(filePath, 'report');
    try {
      await expect(
        connection.sendFile('peer', filePath, 'report.txt'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED',
        cause: uploadFailure,
      });
      expect(store.record?.sendCount).toBe(0);
      expect(uploadMedia).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    await connection.disconnect();
  });

  test('multi-chunk send claims only attempted chunks and treats a mid-batch 502 as uncertain', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-1',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const attemptedTexts: string[] = [];
    let sendAttempts = 0;
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          sendAttempts += 1;
          const body = JSON.parse(String(init?.body));
          const text = String(body.msg.item_list[0].text_item.text);
          attemptedTexts.push(text);
          if (sendAttempts === 2) {
            return new Response('bad gateway', {
              status: 502,
              statusText: 'Bad Gateway',
            });
          }
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    const longText = 'A'.repeat(2500);
    await expect(
      connection.sendMessage('peer', longText, [], {
        deliveryId: 'delivery-mid-batch',
      }),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredChunks: 1,
      totalChunks: 2,
      uncertainTail: true,
      cause: {
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
        deliveryId: 'delivery-mid-batch',
        chunkIndex: 1,
      },
    });

    expect(attemptedTexts).toHaveLength(2);
    expect(store.record?.sendCount).toBe(2);
    expect(sendAttempts).toBe(2);

    await connection.disconnect();
  });

  test('sendMessage delivers its body and every local image with stable chunk indexes', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-local-images',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const uploadMedia = vi.fn(async (input: { buf: Buffer }) => ({
      filekey: 'fk',
      downloadEncryptedQueryParam: 'q-enc',
      aeskey: 'aes-key',
      fileSize: input.buf.length,
      fileSizeCiphertext: input.buf.length + 16,
    }));
    const sendBodies: any[] = [];
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
        uploadMediaBuffer: uploadMedia,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-local-images-'));
    const first = path.join(dir, 'first.png');
    const second = path.join(dir, 'second.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(first, png);
    fs.writeFileSync(second, png);
    try {
      await connection.sendMessage('peer', 'body', [first, second], {
        deliveryId: 'wechat-local-images',
      });
      expect(sendBodies.map((body) => body.msg.item_list[0].type)).toEqual([
        1, 2, 2,
      ]);
      expect(sendBodies.map((body) => body.msg.client_id)).toEqual([
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ]);
      expect(new Set(sendBodies.map((body) => body.msg.client_id)).size).toBe(
        3,
      );
      expect(uploadMedia).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await connection.disconnect();
    }
  });

  test('ACKed body and first image fence a second-image transport failure', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-local-tail',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const uploadMedia = vi.fn(async (input: { buf: Buffer }) => ({
      filekey: 'fk',
      downloadEncryptedQueryParam: 'q-enc',
      aeskey: 'aes-key',
      fileSize: input.buf.length,
      fileSizeCiphertext: input.buf.length + 16,
    }));
    let sends = 0;
    const fetchMock = vi.fn(
      async (url: string, init?: { signal?: AbortSignal | null }) => {
        if (url.includes('sendmessage')) {
          sends += 1;
          if (sends === 3) {
            return new Response('bad gateway', { status: 502 });
          }
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
        uploadMediaBuffer: uploadMedia,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-local-tail-'));
    const first = path.join(dir, 'first.png');
    const second = path.join(dir, 'second.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(first, png);
    fs.writeFileSync(second, png);
    try {
      await expect(
        connection.sendMessage('peer', 'body', [first, second], {
          deliveryId: 'wechat-local-tail',
        }),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 2,
        totalOutputs: 3,
      });
      expect(sends).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await connection.disconnect();
    }
  });

  test('two concurrent identical texts remain distinct durable deliveries', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-1',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const clientIds: string[] = [];
    const texts: string[] = [];
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          const body = JSON.parse(String(init?.body));
          clientIds.push(String(body.msg.client_id));
          texts.push(String(body.msg.item_list[0].text_item.text));
          await Promise.resolve();
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await Promise.all([
      connection.sendMessage('peer', 'same text', [], {
        deliveryId: 'delivery-a',
      }),
      connection.sendMessage('peer', 'same text', [], {
        deliveryId: 'delivery-b',
      }),
    ]);
    expect(texts).toEqual(['same text', 'same text']);
    expect(new Set(clientIds).size).toBe(2);
    expect(store.record?.sendCount).toBe(2);
    await connection.disconnect();
  });

  test('accepted response lost is charged once and never retried internally', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-1',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const acceptedClientIds: string[] = [];
    let attempts = 0;
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          attempts += 1;
          const body = JSON.parse(String(init?.body));
          acceptedClientIds.push(String(body.msg.client_id));
          throw new TypeError('socket closed after provider accepted request');
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await expect(
      connection.sendMessage('peer', 'accepted but ack lost', [], {
        deliveryId: 'durable-delivery-7',
      }),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_UNCERTAIN',
      deliveryId: 'durable-delivery-7',
      chunkIndex: 0,
    });
    expect(attempts).toBe(1);
    expect(store.record?.sendCount).toBe(1);
    expect(acceptedClientIds).toHaveLength(1);
    await connection.disconnect();
  });

  test('a durable physical row uses its actual item id and chunk index for client_id', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-1',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    let clientId = '';
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          clientId = String(JSON.parse(String(init?.body)).msg.client_id);
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await connection.sendMessage('peer', 'one physical chunk', [], {
      deliveryId: 'actual-channel-outbox-item-id',
      chunkIndex: 7,
      physicalOutput: true,
    });
    expect(clientId).toBe(
      weChatClientIdForChunk('actual-channel-outbox-item-id', 7),
    );
    expect(store.record?.sendCount).toBe(1);
    await connection.disconnect();
  });

  test('non-outbox 2500-character text uses a unique client_id for every local chunk', async () => {
    const store = new SharedStore();
    store.record = {
      accountId: 'account',
      userId: 'peer',
      token: 'durable-secret',
      refreshedAtMs: Date.now(),
      sourceMessageId: 'inbound-local-chunks',
      sourceSequence: 1,
      sendCount: 0,
      lastSentAtMs: null,
    };
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const clientIds: string[] = [];
    const fetchMock = vi.fn(
      async (
        url: string,
        init?: { body?: unknown; signal?: AbortSignal | null },
      ) => {
        if (url.includes('sendmessage')) {
          clientIds.push(String(JSON.parse(String(init?.body)).msg.client_id));
          return Response.json({ ret: 0 });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await connection.sendMessage('peer', 'A'.repeat(2500), [], {
      deliveryId: 'host-non-outbox-delivery',
      chunkIndex: 0,
    });
    expect(clientIds).toEqual([
      weChatClientIdForChunk('host-non-outbox-delivery', 0),
      weChatClientIdForChunk('host-non-outbox-delivery', 1),
    ]);
    expect(new Set(clientIds).size).toBe(2);
    expect(store.record?.sendCount).toBe(2);
    await connection.disconnect();
  });

  test('physical-row preflight failures are definitive and make no provider request', async () => {
    const store = new SharedStore();
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) =>
        waitUntilAborted(init?.signal),
    );
    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await connection.connect({ onNewChat: vi.fn() });

    await expect(
      connection.sendMessage('peer', 'missing context', [], {
        deliveryId: 'outbox-missing-context',
        physicalOutput: true,
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_REJECTED' });
    await expect(
      connection.sendMessage('peer', 'A'.repeat(2500), [], {
        deliveryId: 'outbox-not-pre-split',
        physicalOutput: true,
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_REJECTED' });
    await expect(
      connection.sendImage(
        'peer',
        Buffer.from('image'),
        'image/png',
        'caption must be a separate row',
        'image.png',
        {
          deliveryId: 'outbox-image-with-caption',
          physicalOutput: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_REJECTED' });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('sendmessage'),
      ),
    ).toHaveLength(0);
    await connection.disconnect();
  });

  test('strictly classifies HTTP/ACK outcomes without creating dead retry-wait', async () => {
    const cases = [
      {
        name: 'nonzero-ack',
        response: () => Response.json({ ret: 4001, errmsg: 'rejected' }),
        code: 'CHANNEL_DELIVERY_REJECTED',
      },
      {
        name: 'http-400',
        response: () => new Response('bad request', { status: 400 }),
        code: 'CHANNEL_DELIVERY_REJECTED',
      },
      {
        name: 'http-408',
        response: () => new Response('request timeout', { status: 408 }),
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
      },
      {
        name: 'http-409',
        response: () => new Response('conflict', { status: 409 }),
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
      },
      {
        name: 'http-425',
        response: () =>
          new Response('too early', {
            status: 425,
            headers: { 'retry-after': '2' },
          }),
        code: 'CHANNEL_DELIVERY_REJECTED',
        manualRetry: true,
        expectedRetryMs: 2000,
      },
      {
        name: 'http-429',
        response: () =>
          new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '7' },
          }),
        code: 'CHANNEL_DELIVERY_REJECTED',
        manualRetry: true,
        expectedRetryMs: 7000,
      },
      {
        name: 'http-499',
        response: () => new Response('client closed', { status: 499 }),
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
      },
      {
        name: 'http-503',
        response: () => new Response('unavailable', { status: 503 }),
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
      },
      {
        name: 'invalid-2xx',
        response: () => new Response('not-json', { status: 200 }),
        code: 'CHANNEL_DELIVERY_UNCERTAIN',
      },
    ] as const;

    for (const testCase of cases) {
      const store = new SharedStore();
      store.record = {
        accountId: 'account',
        userId: 'peer',
        token: 'durable-secret',
        refreshedAtMs: Date.now(),
        sourceMessageId: `inbound-${testCase.name}`,
        sourceSequence: 1,
        sendCount: 0,
        lastSentAtMs: null,
      };
      const dispatcher = {
        close: vi.fn(async () => undefined),
      } as unknown as Dispatcher;
      let sends = 0;
      const fetchMock = vi.fn(
        async (url: string, init?: { signal?: AbortSignal | null }) => {
          if (url.includes('sendmessage')) {
            sends += 1;
            return testCase.response();
          }
          return waitUntilAborted(init?.signal);
        },
      );
      const connection = createWeChatConnection(
        {
          botToken: 'bot-token',
          ilinkBotId: 'bot-id',
          logContext: { accountId: 'account' },
        },
        {
          fetch: fetchMock as typeof fetch,
          createDispatcher: () => dispatcher,
          contextTokenStore: store,
        },
      );
      await connection.connect({ onNewChat: vi.fn() });
      const startedAt = Date.now();
      const error = await connection
        .sendMessage('peer', testCase.name, [], {
          deliveryId: `outbox-${testCase.name}`,
          physicalOutput: true,
        })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: testCase.code });
      if ('manualRetry' in testCase && testCase.manualRetry) {
        expect((error as { retryAt?: string }).retryAt).toBeUndefined();
        expect(String((error as Error).message)).toContain(
          'manual_retry_after=',
        );
        const cause = (error as Error & { cause?: unknown }).cause as {
          manualRetryAfter?: string;
        };
        const retryAt = Date.parse(String(cause.manualRetryAfter));
        expect(retryAt - startedAt).toBeGreaterThanOrEqual(
          testCase.expectedRetryMs - 1000,
        );
        expect(retryAt - startedAt).toBeLessThanOrEqual(
          testCase.expectedRetryMs + 1000,
        );
      }
      expect(sends).toBe(1);
      expect(store.record?.sendCount).toBe(1);
      await connection.disconnect();
    }
  });

  test('persists inbound token, restores after restart, and invalidates ret=-2 without tokenless retry', async () => {
    const store = new SharedStore();
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    let firstPoll = true;
    const firstFetch = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) => {
        if (firstPoll) {
          firstPoll = false;
          return Response.json({
            get_updates_buf: 'cursor-1',
            msgs: [
              {
                message_id: 1,
                from_user_id: 'peer',
                message_type: 1,
                create_time_ms: Date.now(),
                context_token: 'durable-secret',
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              },
            ],
          });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const first = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: firstFetch as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await first.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    });
    await vi.waitFor(() => expect(store.record?.token).toBe('durable-secret'));
    await first.disconnect();

    let sendAttempts = 0;
    const secondFetch = vi.fn(
      async (url: string, init?: { signal?: AbortSignal | null }) => {
        if (url.includes('sendmessage')) {
          sendAttempts += 1;
          const body = JSON.parse(String((init as { body?: unknown })?.body));
          expect(body.msg.context_token).toBe('durable-secret');
          return Response.json(
            sendAttempts === 1 ? { ret: 0 } : { ret: -2, errmsg: '' },
          );
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const restarted = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: secondFetch as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await restarted.connect({ onNewChat: vi.fn() });
    await expect(restarted.sendMessage('peer', 'after restart')).resolves.toBe(
      undefined,
    );
    await expect(restarted.sendMessage('peer', 'stale now')).rejects.toThrow(
      'ret=-2',
    );
    expect(store.record).toBeUndefined();
    await expect(
      restarted.sendMessage('peer', 'must not fall back'),
    ).rejects.toThrow('请让该用户先向机器人发送一条新消息');
    expect(sendAttempts).toBe(2);
    await restarted.disconnect();
  });
});

describe('WeChat inbound replay classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps the old cursor and replays after an infrastructure failure', async () => {
    const store = new SharedStore();
    const onUpdatesBuf = vi.fn();
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const batch = {
      get_updates_buf: 'cursor-after-message',
      msgs: [
        {
          message_id: 42,
          from_user_id: 'peer',
          message_type: 1,
          create_time_ms: Date.now(),
          context_token: 'retry-token',
          item_list: [{ type: 1, text_item: { text: 'retry me' } }],
        },
      ],
    };
    let polls = 0;
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) => {
        polls += 1;
        if (polls <= 2) return Response.json(batch);
        return waitUntilAborted(init?.signal);
      },
    );
    dbCalls.storeMessageDirect
      .mockImplementationOnce(() => {
        throw new Error('database temporarily unavailable');
      })
      .mockImplementation(() => undefined);

    const connection = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
        random: () => 0.5,
      },
    );
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onUpdatesBuf,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(dbCalls.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(onUpdatesBuf).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(dbCalls.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(onUpdatesBuf).toHaveBeenCalledTimes(1);
    expect(onUpdatesBuf).toHaveBeenCalledWith('cursor-after-message');
    await connection.disconnect();
  });

  test('acknowledges an intentional terminal ignore without persistence', async () => {
    const onUpdatesBuf = vi.fn();
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    let firstPoll = true;
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) => {
        if (firstPoll) {
          firstPoll = false;
          return Response.json({
            get_updates_buf: 'cursor-after-bot-message',
            msgs: [{ message_id: 7, message_type: 2 }],
          });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const connection = createWeChatConnection(
      { botToken: 'bot-token', ilinkBotId: 'bot-id' },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: null,
      },
    );
    await connection.connect({ onNewChat: vi.fn(), onUpdatesBuf });

    await vi.advanceTimersByTimeAsync(0);
    expect(dbCalls.storeMessageDirect).not.toHaveBeenCalled();
    expect(onUpdatesBuf).toHaveBeenCalledWith('cursor-after-bot-message');
    await connection.disconnect();
  });
});
