import type { Dispatcher } from 'undici';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type {
  WeChatContextTokenClaimInput,
  WeChatContextTokenRecord,
  WeChatContextTokenReleaseInput,
  WeChatContextTokenStore,
} from '../src/wechat-context-token.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-outbox-http-'));
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
const reliability = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const scope = await import('../src/channel-outbox-runtime-scope.js');
const { createWeChatConnection } = await import('../src/wechat.js');

class MemoryContextStore implements WeChatContextTokenStore {
  record: WeChatContextTokenRecord;

  constructor(status: number) {
    this.record = {
      accountId: 'wechat-account',
      userId: 'peer',
      token: `context-${status}`,
      refreshedAtMs: Date.now(),
      sourceMessageId: `inbound-${status}`,
      sourceSequence: status,
      sendCount: 0,
      lastSentAtMs: null,
    };
  }

  list(accountId: string): WeChatContextTokenRecord[] {
    return this.record.accountId === accountId ? [{ ...this.record }] : [];
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

  claim(input: WeChatContextTokenClaimInput) {
    if (
      this.record.token !== input.expectedToken ||
      this.record.refreshedAtMs !== input.expectedRefreshedAtMs
    ) {
      return { status: 'changed' as const };
    }
    this.record = {
      ...this.record,
      sendCount: this.record.sendCount + input.claimCount,
      lastSentAtMs: input.nowMs,
    };
    return { status: 'claimed' as const, record: { ...this.record } };
  }

  release(input: WeChatContextTokenReleaseInput) {
    if (this.record.sendCount < input.releaseCount) {
      return { status: 'changed' as const };
    }
    this.record = {
      ...this.record,
      sendCount: this.record.sendCount - input.releaseCount,
    };
    return { status: 'released' as const, record: { ...this.record } };
  }

  delete(): boolean {
    return false;
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

const route = {
  provider: 'wechat',
  accountId: 'wechat-account',
  sourceJid: 'wechat:peer#account:wechat-account',
  chatId: 'peer',
  rootId: null,
  threadId: null,
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WeChat scoped outbox HTTP rejection state', () => {
  const cases = [425, 429].flatMap((status) =>
    (['text', 'image', 'file'] as const).map((kind) => ({ status, kind })),
  );

  test.each(cases)(
    'HTTP $status $kind becomes terminal failed rather than orphaned retry_wait',
    async ({ status, kind }) => {
      const contextStore = new MemoryContextStore(status);
      const dispatcher = {
        close: vi.fn(async () => undefined),
      } as unknown as Dispatcher;
      let physicalSends = 0;
      const fetchMock = vi.fn(
        async (url: string, init?: { signal?: AbortSignal | null }) => {
          if (url.includes('sendmessage')) {
            physicalSends += 1;
            return new Response('rate limited', {
              status,
              headers: { 'retry-after': '10' },
            });
          }
          return waitUntilAborted(init?.signal);
        },
      );
      const connection = createWeChatConnection(
        {
          botToken: 'bot-token',
          ilinkBotId: 'bot-id',
          logContext: { accountId: 'wechat-account' },
        },
        {
          fetch: fetchMock as typeof fetch,
          createDispatcher: () => dispatcher,
          contextTokenStore: contextStore,
          uploadMediaBuffer: vi.fn(async () => ({
            filekey: 'file-key',
            downloadEncryptedQueryParam: 'encrypted-query',
            aeskey: 'aes-key',
            fileSize: 5,
            fileSizeCiphertext: 21,
          })),
        },
      );
      await connection.connect({ onNewChat: vi.fn() });

      try {
        const run = reliability.createChannelTurnRun({
          ...route,
          idempotencyKey: `wechat-http-${status}-${kind}`,
        }).run;
        const text = `status-${status}-${kind}`;
        const payload = { text, kind };
        const identity = scope.semanticChannelOutboxIdentity({
          route,
          kind,
          payload,
          ordinalSlot: `${kind}:0`,
        });
        const filePath = path.join(root, `status-${status}-${kind}.txt`);
        fs.writeFileSync(filePath, 'file');
        const input = {
          ...route,
          turnRunId: run.id,
          ordinal: scope.stableChannelOutboxOrdinal(identity),
          kind,
          payload,
          idempotencyKey: `${run.id}:${identity}`,
          owner: `wechat-http-owner-${status}-${kind}`,
          delivery: {
            mode: 'single' as const,
            send: async ({ item }: { item: { id: string } }) => {
              const options = {
                deliveryId: item.id,
                chunkIndex: 0,
                physicalOutput: true,
              } as const;
              if (kind === 'text') {
                await connection.sendMessage('peer', text, [], options);
              } else if (kind === 'image') {
                await connection.sendImage(
                  'peer',
                  Buffer.from('image'),
                  'image/png',
                  undefined,
                  'image.png',
                  options,
                );
              } else {
                await connection.sendFile(
                  'peer',
                  filePath,
                  'file.txt',
                  options,
                );
              }
              return { providerMessageId: 'unreachable' };
            },
          },
        };

        const result = await delivery.deliverChannelOutboxItem(input);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('manual_retry_after=');
        expect(reliability.getChannelOutboxItem(result.itemId)).toMatchObject({
          status: 'failed',
        });
        expect(
          reliability.getChannelOutboxItem(result.itemId)?.status,
        ).not.toBe('retry_wait');

        const replay = await delivery.deliverChannelOutboxItem(input);
        expect(replay.status).toBe('failed');
        expect(physicalSends).toBe(1);
      } finally {
        await connection.disconnect();
      }
    },
  );
});
