import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const telegramControls = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stopPolling: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn().mockResolvedValue({ id: 1, username: 'fallback_bot' }),
      sendMessage: telegramControls.sendMessage,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        telegramControls.stopPolling = resolve;
      });
    }
    stop() {
      telegramControls.stopPolling?.();
      telegramControls.stopPolling = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection } = await import('../src/telegram.js');
const { createDingTalkConnection } = await import('../src/dingtalk.js');

function grammyHttpTimeout(): Error {
  const inner = new Error(
    "Request to 'sendMessage' timed out after 30 seconds",
  );
  const err = new Error("Network request for 'sendMessage' failed!");
  err.name = 'HttpError';
  Object.assign(err, { error: inner });
  return err;
}

function grammyParseEntitiesError(): Error {
  const err = new Error(
    "Call to 'sendMessage' failed! (400: can't parse entities)",
  );
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: "can't parse entities: unclosed start tag at byte offset 12",
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyTooManyRequests(): Error {
  const err = new Error(
    "Call to 'sendMessage' failed! (429: Too Many Requests)",
  );
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 429,
    description: 'Too Many Requests: retry after 3',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

describe('Telegram HTML format fallback must not duplicate after timeout', () => {
  let cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanup = [];
    telegramControls.stopPolling = null;
    telegramControls.sendMessage.mockReset();
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup.map((fn) => fn()));
  });

  async function connectTelegram() {
    const telegram = createTelegramConnection({ botToken: 'token' });
    expect(
      await telegram.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => true,
      }),
    ).toBe(true);
    cleanup.push(() => telegram.disconnect());
    return telegram;
  }

  test('does not issue a second physical send when grammy wraps a 30s timeout as HttpError', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        throw grammyHttpTimeout();
      },
    );

    await expect(
      telegram.sendMessage('12345', 'hello **world**'),
    ).rejects.toMatchObject({ name: 'HttpError' });
    expect(physicalSends).toHaveLength(1);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('still falls back to plain text on GrammyError 400 parse entities', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        if (extra?.parse_mode === 'HTML') {
          throw grammyParseEntitiesError();
        }
      },
    );

    await telegram.sendMessage('12345', 'hello **world**');
    expect(physicalSends).toHaveLength(2);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(physicalSends[1]?.parseMode).toBeUndefined();
  });

  test('does not plain-resend on GrammyError 429', async () => {
    const telegram = await connectTelegram();
    telegramControls.sendMessage.mockImplementation(async () => {
      throw grammyTooManyRequests();
    });

    // 429 proves no message became visible, so it surfaces as a definitive
    // rejection with a flood-wait retryAt instead of fencing the turn.
    const failure = await telegram
      .sendMessage('12345', 'hello **world**')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({
      name: 'DefinitiveChannelDeliveryError',
      cause: { error_code: 429 },
    });
    expect(typeof (failure as { retryAt?: unknown }).retryAt).toBe('string');
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('DingTalk markdown format fallback must not duplicate after timeout', () => {
  let requestSpy: ReturnType<typeof vi.spyOn> | undefined;
  const groupSends: Array<{ msgKey?: string; msgParam?: string }> = [];
  let groupFailure:
    | 'timeout'
    | 'reset'
    | 'http503'
    | 'empty200'
    | 'invalid200'
    | 'unknown200'
    | 'formatRejected'
    | 'tailEmpty200' = 'timeout';

  function timedOutAfterSend(): Error {
    return Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:443'), {
      code: 'ETIMEDOUT',
      errno: 'ETIMEDOUT',
      syscall: 'connect',
    });
  }

  beforeEach(() => {
    groupSends.length = 0;
    groupFailure = 'timeout';
    requestSpy = vi
      .spyOn(https, 'request')
      .mockImplementation((options, callback) => {
        const opts = typeof options === 'string' ? { path: options } : options;
        const path = String(
          opts && typeof opts === 'object' && 'path' in opts ? opts.path : '',
        );
        const req = new EventEmitter() as EventEmitter & {
          write: (chunk: string) => boolean;
          end: () => void;
          destroy: () => void;
          setTimeout: (ms: number, callback?: () => void) => typeof req;
          body: string;
        };
        req.body = '';
        req.write = (chunk: string) => {
          req.body += chunk;
          return true;
        };
        req.destroy = () => undefined;
        req.setTimeout = () => req;
        req.end = () => {
          queueMicrotask(() => {
            if (path.includes('gettoken')) {
              const res = new Readable({
                read() {
                  this.push(
                    Buffer.from(
                      JSON.stringify({
                        errcode: 0,
                        access_token: 'dingtalk-token',
                        expires_in: 7200,
                      }),
                    ),
                  );
                  this.push(null);
                },
              }) as Readable & { statusCode: number };
              res.statusCode = 200;
              (callback as ((res: typeof res) => void) | undefined)?.(res);
              return;
            }
            if (path.includes('/v1.0/robot/groupMessages/send')) {
              groupSends.push(
                JSON.parse(req.body || '{}') as {
                  msgKey?: string;
                  msgParam?: string;
                },
              );
              if (groupFailure === 'timeout') {
                req.emit('error', timedOutAfterSend());
                return;
              }
              if (groupFailure === 'reset') {
                req.emit(
                  'error',
                  Object.assign(new Error('socket reset after request write'), {
                    code: 'ECONNRESET',
                  }),
                );
                return;
              }
              let responseBody: string;
              let statusCode = 200;
              if (groupFailure === 'empty200') {
                responseBody = '';
              } else if (groupFailure === 'invalid200') {
                responseBody = '{broken';
              } else if (groupFailure === 'unknown200') {
                responseBody = '{}';
              } else if (
                groupFailure === 'formatRejected' &&
                groupSends.length === 1
              ) {
                responseBody = JSON.stringify({
                  code: 'InvalidParameter',
                  message: 'sampleMarkdown msgParam format is invalid',
                });
              } else if (
                groupFailure === 'tailEmpty200' &&
                groupSends.length === 2
              ) {
                responseBody = '';
              } else if (groupFailure === 'http503') {
                statusCode = 503;
                responseBody = '{"message":"internal error"}';
              } else {
                responseBody = JSON.stringify({
                  processQueryKey: `ack-${groupSends.length}`,
                });
              }
              const res = new Readable({
                read() {
                  if (responseBody) this.push(Buffer.from(responseBody));
                  this.push(null);
                },
              }) as Readable & { statusCode: number };
              res.statusCode = statusCode;
              (callback as ((res: typeof res) => void) | undefined)?.(res);
              return;
            }
            req.emit(
              'error',
              new Error(`unexpected https.request path: ${path}`),
            );
          });
        };
        return req as unknown as ReturnType<typeof https.request>;
      });
  });

  afterEach(() => {
    requestSpy?.mockRestore();
  });

  test('does not issue a second physical send when the first send times out after it was attempted', async () => {
    const dingtalk = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });

    await expect(
      dingtalk.sendMessage('dingtalk:group:cidXXXX', 'hello **world**'),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    expect(groupSends).toHaveLength(1);
    expect(groupSends[0]?.msgKey).toBe('sampleMarkdown');
  });

  test('does not plain-resend after HTTP failed (503)', async () => {
    groupFailure = 'http503';
    const dingtalk = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });

    await expect(
      dingtalk.sendMessage('dingtalk:group:cidXXXX', 'hello **world**'),
    ).rejects.toThrow(/HTTP failed \(503\)/);

    expect(groupSends).toHaveLength(1);
    expect(groupSends[0]?.msgKey).toBe('sampleMarkdown');
  });

  test.each([
    ['empty200', /empty response/],
    ['invalid200', /invalid JSON/],
    ['unknown200', /unrecognized success envelope/],
    ['reset', /socket reset/],
  ] as const)(
    'does not plain-resend after an uncertain %s acknowledgement',
    async (failure, expectedError) => {
      groupFailure = failure;
      const dingtalk = createDingTalkConnection({
        clientId: 'ding-client',
        clientSecret: 'ding-secret',
      });

      await expect(
        dingtalk.sendMessage('dingtalk:group:cidXXXX', 'hello **world**'),
      ).rejects.toThrow(expectedError);

      expect(groupSends).toHaveLength(1);
      expect(groupSends[0]?.msgKey).toBe('sampleMarkdown');
    },
  );

  test('falls back once after an authoritative markdown format rejection', async () => {
    groupFailure = 'formatRejected';
    const dingtalk = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });

    await expect(
      dingtalk.sendMessage('dingtalk:group:cidXXXX', 'hello **world**'),
    ).resolves.toBeUndefined();

    expect(groupSends.map((send) => send.msgKey)).toEqual([
      'sampleMarkdown',
      'sampleText',
    ]);
  });

  test('an ACKed first chunk plus an unknown tail ACK is partial without plain resend', async () => {
    groupFailure = 'tailEmpty200';
    const dingtalk = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });

    await expect(
      dingtalk.sendMessage('dingtalk:group:cidXXXX', 'x'.repeat(4500)),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredChunks: 1,
      totalChunks: 2,
    });

    expect(groupSends.map((send) => send.msgKey)).toEqual([
      'sampleMarkdown',
      'sampleMarkdown',
    ]);
  });
});
