import { afterEach, describe, expect, test, vi } from 'vitest';

// Mock logger
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
    reset() {
      createRawBody = null;
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
                    result: {},
                    code: 'success',
                  }),
            );
            return;
          }
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

// ─── Helpers ────────────────────────────────────────────────

function makeConfig(): DingTalkStreamingCardConfig {
  return { clientId: 'test_client_id', clientSecret: 'test_client_secret' };
}

function makeGroupTarget(): DingTalkCardTarget {
  return { type: 'group', openConversationId: 'cidXXXX' };
}

function makeUserTarget(): DingTalkCardTarget {
  return { type: 'user', userId: 'user123' };
}

function makeController(
  target?: DingTalkCardTarget,
  opts?: {
    onCardCreated?: (messageId: string) => void;
    fallbackSend?: (text: string) => Promise<void>;
  },
) {
  return new DingTalkStreamingCardController(
    makeConfig(),
    target ?? makeGroupTarget(),
    {
      // Production adapters always provide a strict-ACK plain fallback. Keep
      // lifecycle-only tests on that real call shape instead of relying on a
      // missing fallback being treated as successful delivery.
      fallbackSend: async () => {},
      ...opts,
    },
  );
}

afterEach(() => {
  dingtalkHttps.reset();
});

// ─── Tests ──────────────────────────────────────────────────

describe('DingTalkStreamingCardController', () => {
  // ─── Lifecycle state machine ───────────────────────────────

  describe('isActive()', () => {
    test('returns true for newly created controller', () => {
      const ctrl = makeController();
      expect(ctrl.isActive()).toBe(true);
    });
  });

  describe('append()', () => {
    test('no-op when state is completed', async () => {
      const ctrl = makeController();
      await ctrl.complete('');
      expect(ctrl.isActive()).toBe(false);
      ctrl.append('hello');
      expect(ctrl.isActive()).toBe(false);
    });

    test('no-op when state is aborted', async () => {
      const ctrl = makeController();
      await ctrl.abort();
      ctrl.append('hello');
      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('complete()', () => {
    test('completes without error when card was never created', async () => {
      const ctrl = makeController();
      await ctrl.complete('final text');
      expect(ctrl.isActive()).toBe(false);
    });

    test('double-complete is idempotent', async () => {
      const ctrl = makeController();
      await ctrl.complete('first');
      await ctrl.complete('second');
      expect(ctrl.isActive()).toBe(false);
    });

    test('complete with empty string', async () => {
      const ctrl = makeController();
      await ctrl.complete('');
      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('abort()', () => {
    test('aborts cleanly when card was never created', async () => {
      const ctrl = makeController();
      await ctrl.abort('test reason');
      expect(ctrl.isActive()).toBe(false);
    });

    test('abort after complete is no-op', async () => {
      const ctrl = makeController();
      await ctrl.complete('done');
      await ctrl.abort('should not change state');
      expect(ctrl.isActive()).toBe(false);
    });

    test('abort with default reason', async () => {
      const ctrl = makeController();
      await ctrl.abort();
      expect(ctrl.isActive()).toBe(false);
    });
  });

  describe('dispose()', () => {
    test('clears internal timers without error', () => {
      const ctrl = makeController();
      ctrl.append('hello');
      ctrl.dispose();
      expect(ctrl.isActive()).toBe(true);
    });

    test('dispose then complete is safe', async () => {
      const ctrl = makeController();
      ctrl.append('hello');
      ctrl.dispose();
      await ctrl.complete('final');
      expect(ctrl.isActive()).toBe(false);
    });

    test('dispose then abort is safe', async () => {
      const ctrl = makeController();
      ctrl.append('hello');
      ctrl.dispose();
      await ctrl.abort('reason');
      expect(ctrl.isActive()).toBe(false);
    });
  });

  // ─── Tool tracking ─────────────────────────────────────────

  describe('startTool / endTool / getToolInfo', () => {
    test('tracks tool by ID', () => {
      const ctrl = makeController();
      ctrl.startTool('tool-1', 'ReadFile');
      expect(ctrl.getToolInfo('tool-1')).toMatchObject({ name: 'ReadFile' });
      expect(ctrl.getToolInfo('unknown')).toBeUndefined();
    });

    test('removes tool on endTool', () => {
      const ctrl = makeController();
      ctrl.startTool('tool-1', 'ReadFile');
      ctrl.endTool('tool-1', false);
      expect(ctrl.getToolInfo('tool-1')).toMatchObject({
        name: 'ReadFile',
        status: 'complete',
      });
    });

    test('tracks multiple tools independently', () => {
      const ctrl = makeController();
      ctrl.startTool('tool-1', 'ReadFile');
      ctrl.startTool('tool-2', 'WriteFile');
      expect(ctrl.getToolInfo('tool-1')).toMatchObject({ name: 'ReadFile' });
      expect(ctrl.getToolInfo('tool-2')).toMatchObject({ name: 'WriteFile' });
      ctrl.endTool('tool-1', false);
      expect(ctrl.getToolInfo('tool-1')).toMatchObject({
        name: 'ReadFile',
        status: 'complete',
      });
      expect(ctrl.getToolInfo('tool-2')).toMatchObject({ name: 'WriteFile' });
    });
  });

  // ─── Auxiliary no-ops ──────────────────────────────────────

  describe('auxiliary methods', () => {
    test('all no-op methods execute without error', () => {
      const ctrl = makeController();
      ctrl.setThinking();
      ctrl.appendThinking('thinking...');
      ctrl.setSystemStatus('processing');
      ctrl.setSystemStatus(null);
      ctrl.setHook({ hookName: 'test', hookEvent: 'PreToolUse' });
      ctrl.setHook(null);
      ctrl.setTodos([
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ]);
      ctrl.pushRecentEvent('test event');
      ctrl.updateToolSummary('tool-1', 'summary');
      expect(true).toBe(true);
    });

    test('patchUsageNote is no-op', async () => {
      const ctrl = makeController();
      await ctrl.patchUsageNote({
        inputTokens: 100,
        outputTokens: 50,
        costUSD: 0.01,
        durationMs: 5000,
        numTurns: 1,
      });
    });
  });

  // ─── getAllMessageIds ──────────────────────────────────────

  describe('getAllMessageIds()', () => {
    test('returns empty array when no card created', () => {
      const ctrl = makeController();
      expect(ctrl.getAllMessageIds()).toEqual([]);
    });
  });

  // ─── Fallback behavior ─────────────────────────────────────

  describe('fallback behavior', () => {
    test('fallbackSend is not called when card never created and complete with empty', async () => {
      const fallbackSend = vi.fn().mockResolvedValue(undefined);
      const ctrl = makeController(makeGroupTarget(), { fallbackSend });
      await ctrl.complete('');
      expect(fallbackSend).not.toHaveBeenCalled();
    });

    test('controller accepts fallbackSend callback', () => {
      const fallbackSend = vi.fn().mockResolvedValue(undefined);
      const ctrl = makeController(makeGroupTarget(), { fallbackSend });
      expect(ctrl.isActive()).toBe(true);
    });
  });

  // ─── Constructor variations ────────────────────────────────

  describe('constructor', () => {
    test('creates controller for group target', () => {
      const ctrl = makeController(makeGroupTarget());
      expect(ctrl.isActive()).toBe(true);
    });

    test('creates controller for user target', () => {
      const ctrl = makeController(makeUserTarget());
      expect(ctrl.isActive()).toBe(true);
    });

    test('stores onCardCreated callback', () => {
      const onCardCreated = vi.fn();
      const ctrl = makeController(makeGroupTarget(), { onCardCreated });
      expect(ctrl.isActive()).toBe(true);
    });

    test('works without optional callbacks', () => {
      const ctrl = makeController();
      expect(ctrl.isActive()).toBe(true);
    });
  });
});

// ─── Target types ───────────────────────────────────────────

describe('DingTalkCardTarget types', () => {
  test('group target has correct shape', () => {
    const target: DingTalkCardTarget = {
      type: 'group',
      openConversationId: 'cidTest123',
    };
    expect(target.type).toBe('group');
  });

  test('user target has correct shape', () => {
    const target: DingTalkCardTarget = {
      type: 'user',
      userId: 'staffId456',
    };
    expect(target.type).toBe('user');
  });
});

// ─── JID routing for DingTalk ───────────────────────────────

describe('DingTalk JID routing', () => {
  test('group JID extraction', () => {
    const jid = 'dingtalk:group:cidXXXX';
    const prefix = 'dingtalk:group:';
    expect(jid.startsWith(prefix)).toBe(true);
    expect(jid.slice(prefix.length)).toBe('cidXXXX');
  });

  test('c2c JID extraction', () => {
    const jid = 'dingtalk:c2c:staffId123';
    const prefix = 'dingtalk:c2c:';
    expect(jid.startsWith(prefix)).toBe(true);
    expect(jid.slice(prefix.length)).toBe('staffId123');
  });

  test('non-dingtalk JID is rejected', () => {
    const jid = 'feishu:chat_oc_xxxx';
    expect(jid.startsWith('dingtalk:')).toBe(false);
  });
});

// ─── State transitions ──────────────────────────────────────

describe('state transitions', () => {
  test('idle → completed (no text)', async () => {
    const ctrl = makeController();
    await ctrl.complete('');
    expect(ctrl.isActive()).toBe(false);
  });

  test('idle → aborted', async () => {
    const ctrl = makeController();
    await ctrl.abort('cancelled');
    expect(ctrl.isActive()).toBe(false);
  });

  test('multiple aborts are idempotent', async () => {
    const ctrl = makeController();
    await ctrl.abort('first');
    await ctrl.abort('second');
    await ctrl.abort('third');
    expect(ctrl.isActive()).toBe(false);
  });

  test('complete after abort is no-op', async () => {
    const ctrl = makeController();
    await ctrl.abort('stop');
    await ctrl.complete('final');
    expect(ctrl.isActive()).toBe(false);
  });

  test('abort after complete is no-op', async () => {
    const ctrl = makeController();
    await ctrl.complete('done');
    await ctrl.abort('should not change');
    expect(ctrl.isActive()).toBe(false);
  });
});

// ─── StreamingSession interface compatibility ───────────────

describe('StreamingSession interface compatibility', () => {
  test('controller implements IStreamingSession methods', () => {
    const ctrl = makeController();
    expect(typeof ctrl.isActive).toBe('function');
    expect(typeof ctrl.abort).toBe('function');
    expect(typeof ctrl.getAllMessageIds).toBe('function');
  });

  test('controller implements full streaming API', () => {
    const ctrl = makeController();
    expect(typeof ctrl.append).toBe('function');
    expect(typeof ctrl.complete).toBe('function');
    expect(typeof ctrl.dispose).toBe('function');
    expect(typeof ctrl.setThinking).toBe('function');
    expect(typeof ctrl.appendThinking).toBe('function');
    expect(typeof ctrl.setSystemStatus).toBe('function');
    expect(typeof ctrl.setHook).toBe('function');
    expect(typeof ctrl.setTodos).toBe('function');
    expect(typeof ctrl.pushRecentEvent).toBe('function');
    expect(typeof ctrl.startTool).toBe('function');
    expect(typeof ctrl.endTool).toBe('function');
    expect(typeof ctrl.updateToolSummary).toBe('function');
    expect(typeof ctrl.getToolInfo).toBe('function');
    expect(typeof ctrl.patchUsageNote).toBe('function');
  });
});

// ─── CREATE 2xx must require success:true via real ensureCard ─

describe('DingTalk streaming-card CREATE 2xx success:true', () => {
  test.each([
    ['empty', ''],
    ['html', '<html>ok</html>'],
    ['broken-json', '{broken'],
  ])(
    'create 200 body %s throws, no cardInstanceId, ACK count 0',
    async (_name, body) => {
      dingtalkHttps.setCreateRawBody(body);
      const ctrl = makeController();
      await expect(
        (ctrl as unknown as { ensureCard: () => Promise<void> }).ensureCard(),
      ).rejects.toBeTruthy();
      expect(ctrl.getAllMessageIds()).toEqual([]);
      expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(0);
    },
  );

  test('create 200 JSON {success:true, result} still creates', async () => {
    dingtalkHttps.setCreateRawBody(
      JSON.stringify({
        success: true,
        result: { outTrackId: 'official-track-1' },
      }),
    );
    const ctrl = makeController();
    await (ctrl as unknown as { ensureCard: () => Promise<void> }).ensureCard();
    expect(ctrl.getAllMessageIds()).toEqual(['official-track-1']);
    expect(ctrl.getAcknowledgedProviderOutputCount()).toBe(1);
  });
});
