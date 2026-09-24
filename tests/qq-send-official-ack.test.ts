import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-official-ack-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

const https = vi.hoisted(() => {
  let messageBody = JSON.stringify({
    id: 'official-1',
    timestamp: 1_787_808_000,
  });
  let messageRequests = 0;
  let streamBodies: string[] = [];
  let streamRequests = 0;
  return {
    setMessageBody(body: string) {
      messageBody = body;
    },
    setStreamBodies(bodies: string[]) {
      streamBodies = [...bodies];
    },
    resetRequests() {
      messageRequests = 0;
      streamRequests = 0;
    },
    get messageRequests() {
      return messageRequests;
    },
    get streamRequests() {
      return streamRequests;
    },
    request: vi.fn(
      (
        opts: { hostname?: string; path?: string },
        cb: (res: {
          statusCode: number;
          on: (event: string, fn: (...args: any[]) => void) => unknown;
          destroy: (error?: Error) => void;
        }) => void,
      ) => {
        const requestPath = String(opts.path || '');
        const hostname = String(opts.hostname || '');
        const isToken =
          hostname.includes('bots.qq.com') ||
          requestPath.includes('getAppAccessToken');
        const isStream = requestPath.includes('/stream_messages');
        const isMessages = requestPath.includes('/messages');
        if (isMessages) messageRequests += 1;
        if (isStream) streamRequests += 1;
        const payload = isToken
          ? JSON.stringify({ access_token: 'qq-token', expires_in: 7200 })
          : isStream
            ? (streamBodies.shift() ?? JSON.stringify({ id: 'stream-1' }))
            : isMessages
              ? messageBody
              : JSON.stringify({ file_info: 'file-info-1', ttl: 600 });
        const res = {
          statusCode: 200,
          on(event: string, fn: (...args: any[]) => void) {
            if (event === 'data') fn(Buffer.from(payload));
            if (event === 'end') fn();
            return res;
          },
          destroy: vi.fn(),
        };
        return {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn(),
          end() {
            cb(res);
          },
          destroy: vi.fn(),
        };
      },
    ),
  };
});

vi.mock('node:https', () => ({ default: https, request: https.request }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const { syntheticChannelProviderAck } =
  await import('../src/channel-outbox-runtime-scope.js');
const {
  createQQConnection,
  QQApiError,
  QQOfficialSendAckError,
  requireQQOfficialSendId,
} = await import('../src/qq.js');
const { QQStreamingController } = await import('../src/qq-streaming-card.js');
const { finalizeChannelCardAfterDelivery } =
  await import('../src/channel-card-finalization.js');
const { classifyImSendFailure, imSendFailurePolicy } =
  await import('../src/im-send-retry-policy.js');

const route = {
  provider: 'qq',
  accountId: 'qq-account',
  sourceJid: 'qq:qq-account:c2c:user-openid',
  chatId: 'c2c:user-openid',
  rootId: null,
  threadId: null,
};

let connection: ReturnType<typeof createQQConnection> | null = null;
let runSequence = 0;

beforeAll(() => db.initDatabase());

beforeEach(() => {
  vi.clearAllMocks();
  https.resetRequests();
  https.setStreamBodies([]);
  https.setMessageBody(
    JSON.stringify({ id: 'official-1', timestamp: 1_787_808_000 }),
  );
  connection = createQQConnection({ appId: 'app', appSecret: 'secret' });
});

afterEach(async () => {
  await connection?.disconnect();
  connection = null;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun() {
  runSequence += 1;
  return store.createChannelTurnRun({
    ...route,
    idempotencyKey: `qq-official-ack:${runSequence}`,
    now: new Date(1_787_808_000_000 + runSequence).toISOString(),
  }).run;
}

function outboxInput(
  runId: string,
  owner: string,
  physicalSends: { value: number },
) {
  return {
    ...route,
    turnRunId: runId,
    ordinal: 1,
    kind: 'text' as const,
    payload: { text: 'hello' },
    idempotencyKey: `${runId}:text`,
    owner,
    delivery: {
      mode: 'single' as const,
      send: async () => {
        physicalSends.value += 1;
        await connection!.sendMessage('c2c:user-openid', 'hello');
        return {
          providerMessageId: syntheticChannelProviderAck({
            turnRunId: runId,
            ordinal: 1,
            payloadHash: 'qq-official-ack',
          }),
        };
      },
    },
  };
}

describe('QQ official send ACK', () => {
  test.each(['', '<html>ok</html>', '{broken', '{}', 'null', '[]'])(
    '2xx body %j is uncertain and never automatically replayed',
    async (body) => {
      https.setMessageBody(body);
      const run = createRun();
      const physicalSends = { value: 0 };
      const first = await delivery.deliverChannelOutboxItem(
        outboxInput(run.id, 'first-attempt', physicalSends),
      );
      expect(first).toMatchObject({ status: 'uncertain', reused: false });
      expect(first.error).toMatch(/official id/);

      const replay = await delivery.deliverChannelOutboxItem(
        outboxInput(run.id, 'automatic-replay', physicalSends),
      );
      expect(replay.status).toBe('uncertain');
      expect(physicalSends.value).toBe(1);
      expect(https.messageRequests).toBe(1);
    },
  );

  test('official {id, timestamp} response completes the Outbox row', async () => {
    const run = createRun();
    const physicalSends = { value: 0 };
    const result = await delivery.deliverChannelOutboxItem(
      outboxInput(run.id, 'official-ack', physicalSends),
    );
    expect(result).toMatchObject({
      status: 'delivered',
      reused: false,
      receipt: { providerMessageId: expect.stringMatching(/^happyclaw-/) },
    });
    expect(physicalSends.value).toBe(1);
    expect(https.messageRequests).toBe(1);
  });

  test.each([{}, { id: '' }, { id: '   ' }, { id: 123 }, [], null])(
    'non-official id shape %j is explicitly classified uncertain',
    (body) => {
      let error: unknown;
      try {
        requireQQOfficialSendId(body);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(QQOfficialSendAckError);
      expect(classifyImSendFailure(error)).toBe('uncertain');
      expect(imSendFailurePolicy(error)).toMatchObject({
        outcome: 'uncertain',
        retryable: false,
        countsTowardChannelRemoval: false,
      });
    },
  );

  test('image final send also requires the official message id', async () => {
    https.setMessageBody('<html>edge proxy</html>');
    await expect(
      connection!.sendImage(
        'c2c:user-openid',
        Buffer.from('small-image'),
        'image/png',
      ),
    ).rejects.toBeInstanceOf(QQOfficialSendAckError);
    expect(https.messageRequests).toBe(1);
  });
});

describe('QQ stream_messages follow-up ACK', () => {
  // Wired exactly like the QQ channel adapter wires its streaming sessions.
  function createStream() {
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user-openid',
      msgSeq: 1,
      passiveMsgId: 'inbound-message',
      sendStreamChunk: (openid, params) =>
        connection!.sendStreamMessage(openid, params),
      fallbackSend: fallback,
    });
    return { controller, fallback };
  }

  test.each([
    JSON.stringify({ code: 40034001, message: 'stream rejected' }),
    JSON.stringify({ err_code: 40034001, msg: 'stream rejected' }),
  ])(
    'a 2xx business error %s on DONE is partial and never re-sent',
    async (doneBody) => {
      https.setStreamBodies([JSON.stringify({ id: 'stream-1' }), doneBody]);
      const { controller, fallback } = createStream();

      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        'final answer',
        true,
        'delivery failed',
      );

      expect(finalized.acknowledged).toBe(false);
      expect(finalized.error).toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
      });
      const cause = (finalized.error as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(QQApiError);
      expect(cause).toMatchObject({ bizCode: 40034001 });
      expect(fallback).not.toHaveBeenCalled();
      expect(https.streamRequests).toBe(2);
      expect(controller.getAcknowledgedProviderOutputCount()).toBe(1);
    },
  );

  test.each(['{}', JSON.stringify({ timestamp: 1_787_808_000 }), ''])(
    'an id-less 2xx DONE body %j completes the stream',
    async (doneBody) => {
      https.setStreamBodies([JSON.stringify({ id: 'stream-1' }), doneBody]);
      const { controller, fallback } = createStream();

      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        'final answer',
        true,
        'delivery failed',
      );

      expect(finalized).toEqual({ acknowledged: true });
      expect(fallback).not.toHaveBeenCalled();
      expect(https.streamRequests).toBe(2);
      expect(controller.getAcknowledgedProviderOutputCount()).toBe(2);
    },
  );
});
