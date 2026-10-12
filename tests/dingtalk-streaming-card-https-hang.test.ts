import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
  setDingTalkStreamingCardHttpsTimeoutMsForTests,
} from '../src/dingtalk-streaming-card.js';

/**
 * Blackhole https.request: accepts the call, never delivers a response.
 * setTimeout/destroy are present so the shared dingtalkHttpsRequest budget works.
 */
function installBlackholeHttps() {
  return vi
    .spyOn(https, 'request')
    .mockImplementation((_options: any, _cb?: any) => {
      const req = new EventEmitter() as EventEmitter & {
        write: () => void;
        end: () => void;
        setTimeout: (ms: number, cb?: () => void) => void;
        destroy: () => void;
      };
      req.write = () => undefined;
      req.end = () => undefined; // never invokes callback → hang without timeout
      req.destroy = () => undefined;
      req.setTimeout = (ms: number, cb?: () => void) => {
        if (typeof cb === 'function') setTimeout(cb, ms);
      };
      return req as any;
    });
}

function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: any = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    if (cur.message) parts.push(String(cur.message));
    cur = cur.cause;
  }
  return parts.join(' | ');
}

describe('DingTalk streaming-card HTTPS timeout against blackhole peer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDingTalkStreamingCardHttpsTimeoutMsForTests(undefined);
  });

  test('card create path rejects with timeout instead of hanging (gettoken)', async () => {
    installBlackholeHttps();
    setDingTalkStreamingCardHttpsTimeoutMsForTests(250);
    const ctrl = new DingTalkStreamingCardController(
      { clientId: 'cid-hang', clientSecret: 'sec-hang' },
      { type: 'group', openConversationId: 'cidXXXX' },
      { fallbackSend: async () => {} },
    );

    const started = Date.now();
    // complete() awaits ensureCard() → getAccessToken → dingtalkHttpsRequest
    let caught: unknown;
    try {
      await ctrl.complete('hello');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'must reject').toBeTruthy();
    expect(errorChain(caught)).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
