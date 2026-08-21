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

function timedOutAfterSend(): Error {
  return Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:443'), {
    code: 'ETIMEDOUT',
    errno: 'ETIMEDOUT',
    syscall: 'connect',
  });
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

  test('does not issue a second physical send when the first send times out after it was attempted', async () => {
    const telegram = createTelegramConnection({ botToken: 'token' });
    expect(
      await telegram.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => true,
      }),
    ).toBe(true);
    cleanup.push(() => telegram.disconnect());

    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (chatId: number, text: string, extra?: { parse_mode?: string }) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        throw timedOutAfterSend();
      },
    );

    await expect(
      telegram.sendMessage('12345', 'hello **world**'),
    ).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(physicalSends).toHaveLength(1);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('DingTalk markdown format fallback must not duplicate after timeout', () => {
  let requestSpy: ReturnType<typeof vi.spyOn> | undefined;
  const groupSends: Array<{ msgKey?: string; msgParam?: string }> = [];

  beforeEach(() => {
    groupSends.length = 0;
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
          body: string;
        };
        req.body = '';
        req.write = (chunk: string) => {
          req.body += chunk;
          return true;
        };
        req.destroy = () => undefined;
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
              req.emit('error', timedOutAfterSend());
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
});
