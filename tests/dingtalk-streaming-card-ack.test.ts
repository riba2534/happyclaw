import { afterEach, describe, expect, test, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({ logger }));

const dingtalkHttps = vi.hoisted(() => {
  // Shapes follow the official @alicloud/dingtalk card_1_0 response bodies:
  // CreateCardResponseBody  { success?: boolean; result?: string }
  // DeliverCardResponseBody { success?: boolean; result?: Array<{
  //   spaceId, spaceType, success, errorMsg, carrierId }> }
  const defaultCreateBody = JSON.stringify({
    success: true,
    result: 'provider-card-result',
  });
  const defaultDeliverBody = JSON.stringify({
    success: true,
    result: [
      {
        spaceId: 'cidXXXX',
        spaceType: 'IM_GROUP',
        success: true,
        carrierId: 'carrier-1',
      },
    ],
  });

  let createRawBody = defaultCreateBody;
  let deliverRawBody = defaultDeliverBody;
  const requests: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }> = [];

  const emitRaw = (cb: (res: any) => void, rawBody: string) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
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
        const body = Buffer.from(rawBody);
        for (const handler of listeners.data ?? []) handler(body);
        for (const handler of listeners.end ?? []) handler();
      });
    });
  };

  return {
    requests,
    setCreateRawBody(body: string) {
      createRawBody = body;
    },
    setDeliverRawBody(body: string) {
      deliverRawBody = body;
    },
    reset() {
      createRawBody = defaultCreateBody;
      deliverRawBody = defaultDeliverBody;
      requests.length = 0;
    },
    request(
      options: { path?: string; method?: string; hostname?: string },
      cb: (res: any) => void,
    ) {
      const chunks: string[] = [];
      const req = {
        on() {
          return req;
        },
        write(data: string) {
          chunks.push(data);
        },
        end() {
          const path = String(options.path ?? '');
          const method = String(options.method ?? 'GET').toUpperCase();
          if (String(options.hostname ?? '').includes('oapi.dingtalk.com')) {
            emitRaw(
              cb,
              JSON.stringify({
                errcode: 0,
                access_token: 'test-token',
                expires_in: 7200,
              }),
            );
            return;
          }
          const bodyStr = chunks.join('');
          requests.push({
            method,
            path,
            body: bodyStr ? JSON.parse(bodyStr) : undefined,
          });
          if (method === 'POST' && path === '/v1.0/card/instances') {
            emitRaw(cb, createRawBody);
            return;
          }
          if (method === 'POST' && path === '/v1.0/card/instances/deliver') {
            emitRaw(cb, deliverRawBody);
            return;
          }
          emitRaw(cb, JSON.stringify({ success: true }));
        },
      };
      return req;
    },
  };
});

vi.mock('node:https', () => ({
  default: { request: dingtalkHttps.request },
}));

import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import { DingTalkStreamingCardController } from '../src/dingtalk-streaming-card.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';

function makeController() {
  return new DingTalkStreamingCardController(
    { clientId: 'ack-client', clientSecret: 'ack-secret' },
    { type: 'group', openConversationId: 'cidXXXX' },
    { fallbackSend: async () => {} },
  );
}

/**
 * Mirrors the host's streaming-card finalization: the exact static fallback
 * is released only when nothing was acknowledged and the card failure is not
 * uncertain.
 */
async function finalizeLikeHost(
  controller: DingTalkStreamingCardController,
  text: string,
) {
  const staticSend = vi.fn(async (_text: string) => {});
  const finalization = await finalizeChannelCardAfterDelivery(
    controller,
    text,
    true,
    'finalize failed',
  );
  if (
    !finalization.acknowledged &&
    controller.getAcknowledgedProviderOutputCount() === 0 &&
    (!finalization.error ||
      classifyImSendFailure(finalization.error) !== 'uncertain')
  ) {
    await staticSend(text);
  }
  return { finalization, staticSend };
}

function cardRequests(path: string, method = 'POST') {
  return dingtalkHttps.requests.filter(
    (r) => r.path === path && r.method === method,
  );
}

function deliverBody(...results: Array<Record<string, unknown>>) {
  return JSON.stringify({ success: true, result: results });
}

afterEach(() => {
  dingtalkHttps.reset();
  vi.clearAllMocks();
});

describe('DingTalk AI Card CREATE ACK', () => {
  test('success:true keeps the locally generated outTrackId', async () => {
    const controller = makeController();
    const { finalization, staticSend } = await finalizeLikeHost(
      controller,
      '你好',
    );

    expect(finalization).toEqual({ acknowledged: true });
    expect(staticSend).not.toHaveBeenCalled();
    const [created] = cardRequests('/v1.0/card/instances');
    const outTrackId = created.body?.outTrackId;
    expect(outTrackId).toMatch(/^card_/);
    expect(controller.getAllMessageIds()).toEqual([outTrackId]);
    expect(
      cardRequests('/v1.0/card/instances/deliver')[0].body?.outTrackId,
    ).toBe(outTrackId);
    expect(
      cardRequests('/v1.0/card/streaming', 'PUT').every(
        (r) => r.body?.outTrackId === outTrackId,
      ),
    ).toBe(true);
  });

  test.each([
    ['empty body', ''],
    ['HTML body', '<html>ok</html>'],
    ['broken JSON', '{broken'],
    ['success:false', JSON.stringify({ success: false })],
    ['missing success', JSON.stringify({ result: 'secret-card-result' })],
  ])(
    'CREATE 2xx with %s is pre-accept and releases the static fallback',
    async (_label, body) => {
      dingtalkHttps.setCreateRawBody(body);
      const controller = makeController();
      const { finalization, staticSend } = await finalizeLikeHost(
        controller,
        '你好',
      );

      expect(finalization.acknowledged).toBe(false);
      expect(classifyImSendFailure(finalization.error)).toBe('pre_accept');
      expect(controller.getAcknowledgedProviderOutputCount()).toBe(0);
      expect(cardRequests('/v1.0/card/instances/deliver')).toEqual([]);
      expect(staticSend).toHaveBeenCalledOnce();
    },
  );

  test('missing success:true logs response keys without values', async () => {
    dingtalkHttps.setCreateRawBody(
      JSON.stringify({ result: 'secret-card-result', requestId: 'req-1' }),
    );
    await expect(makeController().complete('你好')).rejects.toBeTruthy();

    const createWarn = logger.warn.mock.calls.find(
      ([, message]) =>
        message === 'DingTalk AI Card create response missing success:true',
    );
    expect(createWarn?.[0]).toMatchObject({
      responseKeys: ['result', 'requestId'],
    });
    expect(JSON.stringify(createWarn)).not.toContain('secret-card-result');
  });
});

describe('DingTalk AI Card DELIVER ACK', () => {
  test('per-space success:true mints the card', async () => {
    const controller = makeController();
    const { finalization, staticSend } = await finalizeLikeHost(
      controller,
      '你好',
    );

    expect(finalization).toEqual({ acknowledged: true });
    expect(controller.getAcknowledgedProviderOutputCount()).toBe(1);
    expect(staticSend).not.toHaveBeenCalled();
  });

  test.each([
    ['spaces of card is empty'],
    ['robot is not a member of the group'],
  ])(
    'top-level success:true with result[0].success:false (%s) is pre-accept',
    async (errorMsg) => {
      dingtalkHttps.setDeliverRawBody(
        deliverBody({
          spaceId: 'cidXXXX',
          spaceType: 'IM_GROUP',
          success: false,
          errorMsg,
        }),
      );
      const controller = makeController();
      const { finalization, staticSend } = await finalizeLikeHost(
        controller,
        '你好',
      );

      expect(finalization.acknowledged).toBe(false);
      expect(classifyImSendFailure(finalization.error)).toBe('pre_accept');
      expect((finalization.error as Error).message).toContain(errorMsg);
      expect(controller.getAllMessageIds()).toEqual([]);
      expect(cardRequests('/v1.0/card/streaming', 'PUT')).toEqual([]);
      expect(staticSend).toHaveBeenCalledOnce();
    },
  );

  test('the target space entry decides over other spaces', async () => {
    dingtalkHttps.setDeliverRawBody(
      deliverBody(
        { spaceId: 'cidOTHER', spaceType: 'IM_GROUP', success: true },
        {
          spaceId: 'cidXXXX',
          spaceType: 'IM_GROUP',
          success: false,
          errorMsg: 'robot is not a member of the group',
        },
      ),
    );
    const controller = makeController();
    const { finalization, staticSend } = await finalizeLikeHost(
      controller,
      '你好',
    );

    expect(classifyImSendFailure(finalization.error)).toBe('pre_accept');
    expect(controller.getAcknowledgedProviderOutputCount()).toBe(0);
    expect(staticSend).toHaveBeenCalledOnce();
  });

  test('entries that cannot be matched to the target must all succeed', async () => {
    dingtalkHttps.setDeliverRawBody(deliverBody({ success: true }));
    const controller = makeController();
    const { finalization } = await finalizeLikeHost(controller, '你好');

    expect(finalization).toEqual({ acknowledged: true });
    expect(controller.getAcknowledgedProviderOutputCount()).toBe(1);
  });

  test('explicit top-level success:false without results is pre-accept', async () => {
    dingtalkHttps.setDeliverRawBody(JSON.stringify({ success: false }));
    const controller = makeController();
    const { finalization, staticSend } = await finalizeLikeHost(
      controller,
      '你好',
    );

    expect(classifyImSendFailure(finalization.error)).toBe('pre_accept');
    expect(staticSend).toHaveBeenCalledOnce();
  });

  test.each([
    ['empty body', ''],
    ['HTML body', '<html>ok</html>'],
    ['broken JSON', '{broken'],
    ['empty object', '{}'],
    ['code-only envelope', JSON.stringify({ code: 'success' })],
    [
      'per-space entry without success',
      deliverBody({ spaceId: 'cidXXXX', spaceType: 'IM_GROUP' }),
    ],
  ])(
    'DELIVER 2xx with %s fails closed as uncertain without static fallback',
    async (_label, body) => {
      dingtalkHttps.setDeliverRawBody(body);
      const controller = makeController();
      const { finalization, staticSend } = await finalizeLikeHost(
        controller,
        '你好',
      );

      expect(finalization.acknowledged).toBe(false);
      expect(classifyImSendFailure(finalization.error)).toBe('uncertain');
      expect(controller.getAllMessageIds()).toEqual([]);
      expect(cardRequests('/v1.0/card/instances/deliver')).toHaveLength(1);
      expect(cardRequests('/v1.0/card/streaming', 'PUT')).toEqual([]);
      expect(staticSend).not.toHaveBeenCalled();
      await expect(controller.complete('retry')).rejects.toBe(
        finalization.error,
      );
      expect(cardRequests('/v1.0/card/instances/deliver')).toHaveLength(1);
    },
  );
});
