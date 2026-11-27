import { afterEach, describe, expect, test, vi } from 'vitest';

const dingtalkHttps = vi.hoisted(() => {
  let failFinalize = false;
  const requests: Array<{
    hostname: string;
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];

  return {
    requests,
    setFailFinalize(value: boolean) {
      failFinalize = value;
    },
    reset() {
      failFinalize = false;
      requests.length = 0;
    },
    request(options: any, cb: (res: any) => void) {
      const chunks: Buffer[] = [];
      const req = {
        on() {
          return req;
        },
        write(data: string) {
          chunks.push(Buffer.from(data));
        },
        setTimeout() {},
        destroy() {},
        end() {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> | undefined;
          try {
            body = bodyStr ? JSON.parse(bodyStr) : undefined;
          } catch {
            body = undefined;
          }
          requests.push({
            hostname: options.hostname,
            path: options.path,
            method: options.method,
            body,
          });

          let payload: Record<string, unknown> = { success: true };
          if (options.hostname === 'oapi.dingtalk.com') {
            payload = {
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            };
          } else if (
            String(options.path).includes('/card/streaming') &&
            body?.isFinalize &&
            failFinalize
          ) {
            payload = { code: 'InternalError', message: 'finalize failed' };
          }

          const listeners: Record<string, Array<(arg?: unknown) => void>> = {
            data: [],
            end: [],
            error: [],
          };
          const res = {
            statusCode: 200,
            on(event: string, handler: (arg?: unknown) => void) {
              (listeners[event] ??= []).push(handler);
              return res;
            },
          };
          queueMicrotask(() => {
            cb(res);
            queueMicrotask(() => {
              const buf = Buffer.from(JSON.stringify(payload));
              for (const handler of listeners.data) handler(buf);
              for (const handler of listeners.end) handler();
            });
          });
        },
      };
      return req;
    },
  };
});

vi.mock('node:https', () => ({
  default: { request: dingtalkHttps.request },
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  DingTalkStreamingCardController,
  type DingTalkStreamingCardConfig,
  type DingTalkCardTarget,
} from '../src/dingtalk-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  dingtalkHttps.reset();
});

describe('DingTalk streaming finalize must not send a second full copy', () => {
  test('preview flush + failed finalize does not fallback-send', async () => {
    vi.useFakeTimers();
    dingtalkHttps.setFailFinalize(false);

    const fallbackSend = vi.fn(async () => {});
    const config: DingTalkStreamingCardConfig = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    };
    const target: DingTalkCardTarget = {
      type: 'group',
      openConversationId: 'cidXXXX',
    };
    const ctrl = new DingTalkStreamingCardController(config, target, {
      fallbackSend,
    });

    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => {
      expect(
        dingtalkHttps.requests.some((req) =>
          String(req.path).includes('/card/streaming'),
        ),
      ).toBe(true);
    });
    expect(fallbackSend).not.toHaveBeenCalled();

    dingtalkHttps.setFailFinalize(true);
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toBeInstanceOf(Error);
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(
      dingtalkHttps.requests.some(
        (req) =>
          String(req.path).includes('/card/streaming') &&
          req.body?.isFinalize === true,
      ),
    ).toBe(true);
    expect(fallbackSend).not.toHaveBeenCalled();
  });
});
