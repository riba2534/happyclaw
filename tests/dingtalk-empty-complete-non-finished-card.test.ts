import { afterEach, describe, expect, test, vi } from 'vitest';

const dingtalkHttps = vi.hoisted(() => {
  let failStreaming = false;
  let failStatus = false;
  let createDelayMs = 0;
  let pendingCreateResolve: (() => void) | null = null;
  const requests: Array<{
    hostname: string;
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];

  return {
    requests,
    setFailStreaming(value: boolean) {
      failStreaming = value;
    },
    setFailStatus(value: boolean) {
      failStatus = value;
    },
    setCreateDelay(ms: number) {
      createDelayMs = ms;
    },
    /**
     * Hold card create/deliver until releaseCreate() is called.
     * Used to prove empty complete awaits cardCreationPromise.
     */
    holdNextCreate() {
      createDelayMs = -1;
    },
    releaseCreate() {
      const resolve = pendingCreateResolve;
      pendingCreateResolve = null;
      createDelayMs = 0;
      resolve?.();
    },
    reset() {
      failStreaming = false;
      failStatus = false;
      createDelayMs = 0;
      pendingCreateResolve = null;
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

          const respond = () => {
            let payload: Record<string, unknown> = { success: true };
            if (options.hostname === 'oapi.dingtalk.com') {
              payload = {
                errcode: 0,
                access_token: 'tok',
                expires_in: 7200,
              };
            } else if (
              String(options.path).includes('/card/streaming') &&
              failStreaming
            ) {
              payload = {
                code: 'InternalError',
                message: 'streaming mutate failed',
              };
            } else if (
              String(options.path).includes('/card/instances') &&
              options.method === 'PUT' &&
              failStatus &&
              (body as any)?.cardData?.cardParamMap?.flowStatus === '3'
            ) {
              payload = {
                code: 'InternalError',
                message: 'FINISHED status failed',
              };
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
          };

          const isCreateOrDeliver =
            String(options.path).includes('/card/instances') &&
            options.method === 'POST' &&
            options.hostname !== 'oapi.dingtalk.com';

          if (isCreateOrDeliver && createDelayMs === -1) {
            // Hold until releaseCreate — only gate the first create POST
            if (
              String(options.path) === '/v1.0/card/instances' &&
              !String(options.path).includes('deliver')
            ) {
              pendingCreateResolve = respond;
              return;
            }
            // deliver also held via same gate: wait for create release then proceed
            if (String(options.path).includes('/deliver')) {
              // deliver only happens after create responds; if create was held,
              // deliver will be issued after release — proceed normally
            }
          }

          if (isCreateOrDeliver && createDelayMs > 0) {
            setTimeout(respond, createDelayMs);
            return;
          }

          respond();
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

import { DingTalkStreamingCardController } from '../src/dingtalk-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

const EMPTY_NOTICE = '> ⚠️ 本次运行没有生成可展示的最终内容。';
const FLOW_FINISHED = '3';

function makeController() {
  return new DingTalkStreamingCardController(
    { clientId: 'test_client_id', clientSecret: 'test_client_secret' },
    { type: 'group', openConversationId: 'cidXXXX' },
    { fallbackSend: async () => {} },
  );
}

function finishedStatusBodies() {
  return dingtalkHttps.requests.filter(
    (r) =>
      r.method === 'PUT' &&
      String(r.path).includes('/card/instances') &&
      (r.body as any)?.cardData?.cardParamMap?.flowStatus === FLOW_FINISHED,
  );
}

function finalizedStreamingBodies() {
  return dingtalkHttps.requests.filter(
    (r) =>
      String(r.path).includes('/card/streaming') &&
      (r.body as any)?.isFinalize === true,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  dingtalkHttps.reset();
});

describe('DingTalk empty complete() must not false-ACK a non-FINISHED AI Card', () => {
  test('setThinking → finalize complete("") does not leave non-FINISHED card with acknowledged true', async () => {
    const ctrl = makeController();
    ctrl.setThinking();
    // Allow ensureCard create+deliver to settle.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);
    expect(finishedStatusBodies()).toHaveLength(0);

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized.acknowledged).toBe(true);
    expect(finalized.error).toBeUndefined();
    // Must have terminalized with empty notice + FINISHED.
    expect(finalizedStreamingBodies().length).toBeGreaterThan(0);
    const lastStream = finalizedStreamingBodies().at(-1)!;
    expect((lastStream.body as any).content).toContain(
      '没有生成可展示的最终内容',
    );
    expect(finishedStatusBodies().length).toBeGreaterThan(0);
    const lastStatus = finishedStatusBodies().at(-1)!;
    expect((lastStatus.body as any).cardData.cardParamMap.msgContent).toContain(
      '没有生成可展示的最终内容',
    );
  });

  test('empty complete awaits in-flight cardCreationPromise before terminalizing', async () => {
    dingtalkHttps.holdNextCreate();
    const ctrl = makeController();
    ctrl.setThinking();

    // Create is held — cardInstanceId not yet minted.
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(0);

    const finalizePromise = finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    // Give complete() a chance to race ahead if it forgets to await.
    await Promise.resolve();
    await Promise.resolve();

    // Release create so card becomes visible, then complete must terminalize.
    dingtalkHttps.releaseCreate();
    // Deliver + subsequent mutations need a few ticks.
    await new Promise((r) => setTimeout(r, 50));

    const finalized = await finalizePromise;

    expect(finalized.acknowledged).toBe(true);
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);
    expect(finishedStatusBodies().length).toBeGreaterThan(0);
    expect(finalizedStreamingBodies().length).toBeGreaterThan(0);
  });

  test('empty-complete mutation failure is Partial, not acknowledged true', async () => {
    dingtalkHttps.setFailStreaming(true);
    const ctrl = makeController();
    ctrl.setThinking();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
    });
  });

  test('empty complete with no card still resolves without creating one', async () => {
    const ctrl = makeController();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '   ',
      true,
      'empty final',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(0);
    expect(
      dingtalkHttps.requests.filter((r) =>
        String(r.path).includes('/card/instances'),
      ),
    ).toHaveLength(0);
  });
});