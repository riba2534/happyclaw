import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const dingtalkHttps = vi.hoisted(() => {
  let createRawBody: string | null = null;
  let deliverRawBody: string | null = null;

  const emitRaw = (
    cb: (res: any) => void,
    rawBody: string,
    statusCode = 200,
  ) => {
    const responseListeners: Record<
      string,
      Array<(arg?: unknown) => void>
    > = {};
    const res = {
      statusCode,
      on(event: string, handler: (arg?: unknown) => void) {
        (responseListeners[event] ??= []).push(handler);
        return res;
      },
    };
    queueMicrotask(() => {
      cb(res);
      queueMicrotask(() => {
        const body = Buffer.from(rawBody);
        for (const handler of responseListeners.data ?? []) handler(body);
        for (const handler of responseListeners.end ?? []) handler();
      });
    });
  };

  return {
    setCreateRawBody(body: string | null) {
      createRawBody = body;
    },
    setDeliverRawBody(body: string | null) {
      deliverRawBody = body;
    },
    reset() {
      createRawBody = null;
      deliverRawBody = null;
    },
    request(
      options: { path?: string; method?: string; hostname?: string },
      cb: (res: any) => void,
    ) {
      const requestListeners: Record<
        string,
        Array<(arg?: unknown) => void>
      > = {};
      const req = {
        on(event: string, handler: (arg?: unknown) => void) {
          (requestListeners[event] ??= []).push(handler);
          return req;
        },
        write() {},
        end() {
          const requestPath = String(options.path ?? '');
          const method = String(options.method ?? 'GET').toUpperCase();
          if (
            requestPath.includes('/gettoken') ||
            String(options.hostname ?? '').includes('oapi.dingtalk.com')
          ) {
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
          const isDeliver =
            method === 'POST' &&
            requestPath.includes('/card/instances/deliver');
          const isCreate =
            method === 'POST' &&
            requestPath.includes('/card/instances') &&
            !requestPath.includes('/deliver');
          if (isCreate) {
            emitRaw(
              cb,
              createRawBody !== null
                ? createRawBody
                : JSON.stringify({
                    success: true,
                    result: { outTrackId: 'create-track-ok' },
                    code: 'success',
                  }),
            );
            return;
          }
          if (isDeliver) {
            emitRaw(
              cb,
              deliverRawBody !== null
                ? deliverRawBody
                : JSON.stringify({ success: true, code: 'success' }),
            );
            return;
          }
          // PUT streaming / status — keep apiRequest soft {} behavior untouched
          emitRaw(cb, JSON.stringify({ success: true, code: 'success' }));
        },
      };
      return req;
    },
  };
});

vi.mock('node:https', () => ({
  default: { request: dingtalkHttps.request },
}));

import {
  DingTalkStreamingCardController,
  type DingTalkStreamingCardConfig,
  type DingTalkCardTarget,
} from '../src/dingtalk-streaming-card.js';

function makeConfig(): DingTalkStreamingCardConfig {
  return { clientId: 'test_client_id', clientSecret: 'test_client_secret' };
}

function makeGroupTarget(): DingTalkCardTarget {
  return { type: 'group', openConversationId: 'cidXXXX' };
}

function makeController() {
  return new DingTalkStreamingCardController(makeConfig(), makeGroupTarget(), {
    fallbackSend: async () => {},
  });
}

afterEach(() => {
  dingtalkHttps.reset();
});

describe('DingTalk streaming-card DELIVER 2xx success ACK (≠ CREATE/#730)', () => {
  test.each([
    ['empty', ''],
    ['html', '<html>ok</html>'],
    ['broken-json', '{broken'],
    ['success-false', JSON.stringify({ success: false })],
  ])(
    'deliver 200 body %s → ensureCard leaves ACK count 0 (no cardInstanceId mint)',
    async (_name, body) => {
      dingtalkHttps.setDeliverRawBody(body);
      const ctrl = makeController();
      await (
        ctrl as unknown as { ensureCard: () => Promise<void> }
      ).ensureCard();
      expect(ctrl.getAllMessageIds()).toEqual([]);
      expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(0);
    },
  );

  test.each([
    ['empty', ''],
    ['html', '<html>ok</html>'],
    ['broken-json', '{broken'],
    ['success-false', JSON.stringify({ success: false })],
  ])(
    'deliver 200 body %s → complete rejects and ACK count stays 0',
    async (_name, body) => {
      dingtalkHttps.setDeliverRawBody(body);
      const ctrl = makeController();
      await expect(ctrl.complete('你好')).rejects.toBeTruthy();
      expect(ctrl.getAllMessageIds()).toEqual([]);
      expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(0);
    },
  );

  test('deliver 200 JSON {success:true} still mints cardInstanceId (count 1)', async () => {
    dingtalkHttps.setDeliverRawBody(
      JSON.stringify({ success: true, code: 'success' }),
    );
    const ctrl = makeController();
    await (ctrl as unknown as { ensureCard: () => Promise<void> }).ensureCard();
    expect(ctrl.getAllMessageIds().length).toBe(1);
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);
  });

  test('deliver 200 JSON {code:success} equivalent envelope still mints', async () => {
    dingtalkHttps.setDeliverRawBody(JSON.stringify({ code: 'success' }));
    const ctrl = makeController();
    await (ctrl as unknown as { ensureCard: () => Promise<void> }).ensureCard();
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);
  });
});