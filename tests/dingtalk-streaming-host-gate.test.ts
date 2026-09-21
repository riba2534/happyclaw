import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const dingtalkHttps = vi.hoisted(() => {
  let deliverFailure: { error: unknown; accepted: boolean } | null = null;
  let deliverResponse: {
    status: number;
    payload: Record<string, unknown>;
  } | null = null;
  let streamFailure: { call: number; error: unknown } | null = null;
  let streamPause: {
    call: number;
    promise: Promise<unknown>;
  } | null = null;
  let streamCalls = 0;
  const visibleMutations: string[] = [];

  const emitRequestError = (
    listeners: Record<string, Array<(arg?: unknown) => void>>,
    error: unknown,
  ) => {
    queueMicrotask(() => {
      for (const handler of listeners.error ?? []) handler(error);
    });
  };

  const emitResponse = (
    cb: (res: any) => void,
    payload: Record<string, unknown>,
    statusCode = 200,
  ) => {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const res = {
      statusCode,
      on(event: string, handler: (arg?: unknown) => void) {
        (listeners[event] ??= []).push(handler);
        return res;
      },
    };
    queueMicrotask(() => {
      cb(res);
      queueMicrotask(() => {
        const body = Buffer.from(JSON.stringify(payload));
        for (const handler of listeners.data ?? []) handler(body);
        for (const handler of listeners.end ?? []) handler();
      });
    });
  };

  return {
    visibleMutations,
    failDeliver(error: unknown, accepted: boolean) {
      deliverFailure = { error, accepted };
    },
    respondToDeliver(status: number, payload: Record<string, unknown>) {
      deliverResponse = { status, payload };
    },
    failStream(call: number, error: unknown) {
      streamFailure = { call, error };
    },
    pauseStream(call: number) {
      let release!: (error?: unknown) => void;
      const promise = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      streamPause = { call, promise };
      return {
        resolve: () => release(),
        reject: (error: unknown) => release(error),
      };
    },
    reset() {
      deliverFailure = null;
      deliverResponse = null;
      streamFailure = null;
      streamPause = null;
      streamCalls = 0;
      visibleMutations.length = 0;
    },
    request(
      options: { hostname?: string; path?: string },
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
          if (String(options.hostname).includes('oapi.dingtalk.com')) {
            emitResponse(cb, {
              errcode: 0,
              access_token: 'test-token',
              expires_in: 7200,
            });
            return;
          }

          if (requestPath.includes('/card/instances/deliver')) {
            if (deliverResponse) {
              emitResponse(cb, deliverResponse.payload, deliverResponse.status);
              return;
            }
            if (deliverFailure) {
              if (deliverFailure.accepted) {
                visibleMutations.push('card-deliver');
              }
              emitRequestError(requestListeners, deliverFailure.error);
              return;
            }
            visibleMutations.push('card-deliver');
          }

          if (requestPath.includes('/card/streaming')) {
            streamCalls += 1;
            visibleMutations.push(`card-stream-${streamCalls}`);
            if (streamPause?.call === streamCalls) {
              void streamPause.promise.then((error) => {
                if (error !== undefined) {
                  emitRequestError(requestListeners, error);
                } else {
                  emitResponse(cb, { code: 'success', success: true });
                }
              });
              return;
            }
            if (streamFailure?.call === streamCalls) {
              emitRequestError(requestListeners, streamFailure.error);
              return;
            }
          }

          emitResponse(cb, { code: 'success', success: true });
        },
      };
      return req;
    },
  };
});

vi.mock('node:https', () => ({
  default: { request: dingtalkHttps.request },
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-host-gate-'));
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
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { finalizeChannelCardAfterDelivery } =
  await import('../src/channel-card-finalization.js');
const { persistUncertainStreamingDelivery } =
  await import('../src/channel-streaming-uncertainty.js');
const { DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const { classifyImSendFailure, preAcceptImDeliveryError } =
  await import('../src/im-send-retry-policy.js');
const { DingTalkStreamingCardController } =
  await import('../src/dingtalk-streaming-card.js');

type DingTalkController = InstanceType<typeof DingTalkStreamingCardController>;
type HostKind = 'main' | 'conversation';

const route = {
  provider: 'dingtalk',
  accountId: 'dingtalk-bot',
  sourceJid: 'dingtalk:group:cid-host-gate',
  chatId: 'group:cid-host-gate',
  rootId: null,
  threadId: null,
};

let controllerOrdinal = 0;

function makeController(staticSend: (text: string) => Promise<void>) {
  controllerOrdinal += 1;
  return new DingTalkStreamingCardController(
    {
      clientId: `host-gate-client-${controllerOrdinal}`,
      clientSecret: 'test-secret',
    },
    { type: 'group', openConversationId: 'cid-host-gate' },
    { fallbackSend: staticSend },
  );
}

async function runHostGate(input: {
  kind: HostKind;
  controller: DingTalkController;
  text: string;
  prerequisitesAcknowledged?: boolean;
  staticSend: (text: string) => Promise<void>;
  scope?: {
    turnRunId: string;
    inputTurnId: string;
    owner: string;
    token: string;
  };
}) {
  const pendingCard = input.controller.isActive()
    ? input.controller
    : undefined;

  // Main reserves the provider presentation before its DB/Web projection and
  // static send branch. Conversation Agent finalizes before its static branch.
  if (input.kind === 'main' && !pendingCard) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const };
  }

  const finalization = pendingCard
    ? await finalizeChannelCardAfterDelivery(
        pendingCard,
        input.text,
        input.prerequisitesAcknowledged ?? true,
        'finalize failed',
      )
    : undefined;
  const fenced =
    finalization?.error && input.scope
      ? await persistUncertainStreamingDelivery({
          scope: { ...route, ...input.scope },
          operationKey: `dingtalk-${input.kind}-stream-final`,
          payload: {
            role: 'primary_stream_final',
            contentHash: input.text,
          },
          error: finalization.error,
        })
      : null;
  const handled =
    finalization?.acknowledged === true ||
    (finalization?.error !== undefined &&
      classifyImSendFailure(finalization.error) === 'uncertain');

  if (input.kind === 'main' && !handled) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const, finalization, fenced };
  }
  if (input.kind === 'conversation' && !handled) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const, finalization, fenced };
  }
  return { presentation: 'stream' as const, finalization, fenced };
}

function startRuntime(externalMessageId: string) {
  return ChannelTurnRuntime.start({ ...route, externalMessageId });
}

beforeAll(() => db.initDatabase());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  dingtalkHttps.reset();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each<HostKind>(['main', 'conversation'])(
  'DingTalk %s host gate',
  (kind) => {
    test('accepted deliver timeout stays host-owned with one visible mutation', async () => {
      vi.useFakeTimers();
      const ackLoss = Object.assign(
        new Error('DingTalk deliver accepted but ACK was lost'),
        { code: 'ETIMEDOUT' },
      );
      dingtalkHttps.failDeliver(ackLoss, true);
      const staticSend = vi.fn(async () => {
        dingtalkHttps.visibleMutations.push('host-static');
      });
      const controller = makeController(staticSend);
      const runtime = startRuntime(`${kind}-dingtalk-deliver-ack-loss`);

      controller.append('possibly visible DingTalk card');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(true);

      const result = await runHostGate({
        kind,
        controller,
        text: 'final answer',
        staticSend,
        scope: {
          turnRunId: runtime.runId,
          inputTurnId: runtime.inputTurnId,
          owner: `dingtalk-${kind}-host-test`,
          token: `dingtalk-${kind}-host-token`,
        },
      });

      expect(result).toMatchObject({
        presentation: 'stream',
        finalization: { acknowledged: false, error: ackLoss },
        fenced: { status: 'uncertain' },
      });
      expect(staticSend).not.toHaveBeenCalled();
      expect(dingtalkHttps.visibleMutations).toEqual(['card-deliver']);
      expect(
        reliability.getUncertainChannelOutboxForTurn(runtime.runId),
      ).toMatchObject({ status: 'uncertain', kind: 'card' });

      controller.append('late delta');
      controller.setSystemStatus('late status');
      await vi.advanceTimersByTimeAsync(1800);
      await expect(controller.complete('repeat complete')).rejects.toBe(
        ackLoss,
      );
      await expect(controller.abort('repeat abort')).rejects.toBe(ackLoss);
      expect(dingtalkHttps.visibleMutations).toEqual(['card-deliver']);

      runtime.interrupt('DingTalk stream ACK is uncertain');
      runtime.dispose();
    });

    test.each([
      [
        'pre-accept',
        () =>
          preAcceptImDeliveryError(
            'DingTalk failed before card delivery could start',
          ),
      ],
      [
        'definitive rejection',
        () =>
          new DefinitiveChannelDeliveryError(
            'DingTalk provider rejected card delivery',
          ),
      ],
    ])(
      '%s deliver failure releases exactly one static send',
      async (_label, failureFactory) => {
        vi.useFakeTimers();
        const failure = failureFactory();
        dingtalkHttps.failDeliver(failure, false);
        const staticSend = vi.fn(async () => {
          dingtalkHttps.visibleMutations.push('host-static');
        });
        const controller = makeController(staticSend);

        controller.append('rejected DingTalk card');
        await vi.advanceTimersByTimeAsync(600);
        expect(controller.isActive()).toBe(false);

        const result = await runHostGate({
          kind,
          controller,
          text: 'safe static answer',
          staticSend,
        });
        expect(result).toMatchObject({ presentation: 'static' });
        expect(staticSend).toHaveBeenCalledOnce();
        expect(dingtalkHttps.visibleMutations).toEqual(['host-static']);

        await expect(controller.complete('repeat complete')).rejects.toBe(
          failure,
        );
        await expect(controller.abort('repeat abort')).rejects.toBe(failure);
        expect(dingtalkHttps.visibleMutations).toEqual(['host-static']);
      },
    );

    test('real HTTP 400 deliver rejection releases exactly one static send', async () => {
      vi.useFakeTimers();
      dingtalkHttps.respondToDeliver(400, {
        message: 'invalid openSpaceId',
      });
      const staticSend = vi.fn(async () => {
        dingtalkHttps.visibleMutations.push('host-static');
      });
      const controller = makeController(staticSend);
      controller.append('HTTP rejected DingTalk card');
      await vi.advanceTimersByTimeAsync(600);

      expect(controller.isActive()).toBe(false);
      const result = await runHostGate({
        kind,
        controller,
        text: 'safe static answer',
        staticSend,
      });
      expect(result).toMatchObject({ presentation: 'static' });
      expect(staticSend).toHaveBeenCalledOnce();
      expect(dingtalkHttps.visibleMutations).toEqual(['host-static']);
    });

    test('HTTP 200 provider rejection body releases exactly one static send', async () => {
      vi.useFakeTimers();
      dingtalkHttps.respondToDeliver(200, {
        code: 'InvalidParameter',
        message: 'invalid openSpaceId',
      });
      const staticSend = vi.fn(async () => {
        dingtalkHttps.visibleMutations.push('host-static');
      });
      const controller = makeController(staticSend);
      controller.append('body rejected DingTalk card');
      await vi.advanceTimersByTimeAsync(600);

      expect(controller.isActive()).toBe(false);
      const result = await runHostGate({
        kind,
        controller,
        text: 'safe static answer',
        staticSend,
      });
      expect(result).toMatchObject({ presentation: 'static' });
      expect(staticSend).toHaveBeenCalledOnce();
      expect(dingtalkHttps.visibleMutations).toEqual(['host-static']);
    });

    test('HTTP 503 deliver failure remains uncertain and never sends static', async () => {
      vi.useFakeTimers();
      dingtalkHttps.respondToDeliver(503, {
        code: 'InternalError',
        message: 'temporarily unavailable',
      });
      const staticSend = vi.fn(async () => {
        dingtalkHttps.visibleMutations.push('host-static');
      });
      const controller = makeController(staticSend);
      const runtime = startRuntime(`${kind}-dingtalk-http-503`);
      controller.append('uncertain DingTalk card');
      await vi.advanceTimersByTimeAsync(600);

      expect(controller.isActive()).toBe(true);
      const result = await runHostGate({
        kind,
        controller,
        text: 'must not send static',
        staticSend,
        scope: {
          turnRunId: runtime.runId,
          inputTurnId: runtime.inputTurnId,
          owner: `dingtalk-${kind}-503-owner`,
          token: `dingtalk-${kind}-503-token`,
        },
      });
      expect(result).toMatchObject({
        presentation: 'stream',
        finalization: { acknowledged: false },
        fenced: { status: 'uncertain' },
      });
      expect(staticSend).not.toHaveBeenCalled();
      expect(dingtalkHttps.visibleMutations).toEqual([]);
      runtime.interrupt('DingTalk HTTP 503 is uncertain');
      runtime.dispose();
    });

    test('second streaming update ACK loss is partial and never sends static', async () => {
      vi.useFakeTimers();
      const tailAckLoss = Object.assign(
        new Error('DingTalk second stream update ACK was lost'),
        { code: 'ETIMEDOUT' },
      );
      dingtalkHttps.failStream(2, tailAckLoss);
      const staticSend = vi.fn(async () => {
        dingtalkHttps.visibleMutations.push('host-static');
      });
      const controller = makeController(staticSend);
      const runtime = startRuntime(`${kind}-dingtalk-tail-ack-loss`);

      controller.append('acknowledged preview');
      await vi.advanceTimersByTimeAsync(600);
      controller.append('uncertain replacement preview');
      await vi.advanceTimersByTimeAsync(600);
      expect(controller.isActive()).toBe(true);

      const result = await runHostGate({
        kind,
        controller,
        text: 'must not create another mutation',
        staticSend,
        scope: {
          turnRunId: runtime.runId,
          inputTurnId: runtime.inputTurnId,
          owner: `dingtalk-${kind}-tail-test`,
          token: `dingtalk-${kind}-tail-token`,
        },
      });

      expect(result).toMatchObject({
        presentation: 'stream',
        finalization: {
          acknowledged: false,
          error: {
            code: 'CHANNEL_DELIVERY_PARTIAL',
            deliveredOutputs: 1,
            totalOutputs: 2,
            cause: tailAckLoss,
          },
        },
        fenced: { status: 'uncertain' },
      });
      const stickyError = result.finalization?.error;
      await expect(controller.complete('repeat complete')).rejects.toBe(
        stickyError,
      );
      await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
      expect(staticSend).not.toHaveBeenCalled();
      expect(dingtalkHttps.visibleMutations).toEqual([
        'card-deliver',
        'card-stream-1',
        'card-stream-2',
      ]);

      runtime.interrupt('DingTalk stream tail ACK is uncertain');
      runtime.dispose();
    });
  },
);

describe('DingTalk fast main finalization', () => {
  test('idle card rejection uses the post-finalizer exact static fallback', async () => {
    dingtalkHttps.respondToDeliver(400, {
      message: 'invalid openSpaceId',
    });
    const staticSend = vi.fn(async () => {
      dingtalkHttps.visibleMutations.push('host-static');
    });
    const controller = makeController(staticSend);

    expect(controller.isActive()).toBe(true);
    const result = await runHostGate({
      kind: 'main',
      controller,
      text: 'fast final answer',
      staticSend,
    });

    expect(result).toMatchObject({
      presentation: 'static',
      finalization: {
        acknowledged: false,
        error: { deliveryPhase: 'rejected' },
      },
    });
    expect(staticSend).toHaveBeenCalledOnce();
    expect(dingtalkHttps.visibleMutations).toEqual(['host-static']);
  });
});

describe('DingTalk abort prerequisite fence', () => {
  test('successful abort keeps the visible card as the only presentation', async () => {
    vi.useFakeTimers();
    const staticSend = vi.fn(async () => {
      dingtalkHttps.visibleMutations.push('host-static');
    });
    const controller = makeController(staticSend);
    const runtime = startRuntime('dingtalk-abort-prerequisite');
    controller.append('visible DingTalk preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'dingtalk-abort-owner',
        token: 'dingtalk-abort-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
      },
      fenced: { status: 'uncertain' },
    });
    expect(staticSend).not.toHaveBeenCalled();
    expect(dingtalkHttps.visibleMutations).toEqual([
      'card-deliver',
      'card-stream-1',
      'card-stream-2',
    ]);
    runtime.interrupt('DingTalk abort prerequisite is partial');
    runtime.dispose();
  });

  test('abort ACK loss is sticky partial and never opens static delivery', async () => {
    vi.useFakeTimers();
    const abortAckLoss = Object.assign(
      new Error('DingTalk abort update accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    dingtalkHttps.failStream(2, abortAckLoss);
    const staticSend = vi.fn(async () => {
      dingtalkHttps.visibleMutations.push('host-static');
    });
    const controller = makeController(staticSend);
    const runtime = startRuntime('dingtalk-abort-ack-loss');
    controller.append('visible DingTalk preview');
    await vi.advanceTimersByTimeAsync(600);

    const result = await runHostGate({
      kind: 'conversation',
      controller,
      text: 'unused final',
      prerequisitesAcknowledged: false,
      staticSend,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'dingtalk-abort-loss-owner',
        token: 'dingtalk-abort-loss-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: {
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          cause: abortAckLoss,
        },
      },
      fenced: { status: 'uncertain' },
    });
    const stickyError = result.finalization?.error;
    await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
    await expect(controller.complete('repeat complete')).rejects.toBe(
      stickyError,
    );
    expect(staticSend).not.toHaveBeenCalled();
    expect(dingtalkHttps.visibleMutations).toEqual([
      'card-deliver',
      'card-stream-1',
      'card-stream-2',
    ]);
    runtime.interrupt('DingTalk abort ACK is uncertain');
    runtime.dispose();
  });
});

describe('DingTalk terminal-pending mutation fence', () => {
  test.each(['complete', 'abort'] as const)(
    '%s blocks a late append while its terminal stream update awaits ACK',
    async (operation) => {
      vi.useFakeTimers();
      const controller = makeController(async () => {});
      controller.append('PREVIEW');
      await vi.advanceTimersByTimeAsync(600);
      const terminalPause = dingtalkHttps.pauseStream(2);

      const terminal =
        operation === 'complete'
          ? controller.complete('FINAL')
          : controller.abort('STOP');
      await vi.waitFor(() =>
        expect(dingtalkHttps.visibleMutations).toContain('card-stream-2'),
      );
      expect(controller.isActive()).toBe(false);
      controller.append(`LATE AFTER ${operation}`);
      await vi.advanceTimersByTimeAsync(600);
      expect(dingtalkHttps.visibleMutations).toEqual([
        'card-deliver',
        'card-stream-1',
        'card-stream-2',
      ]);

      terminalPause.resolve();
      await terminal;
      expect(dingtalkHttps.visibleMutations).toEqual([
        'card-deliver',
        'card-stream-1',
        'card-stream-2',
      ]);
    },
  );

  test('serializes aux and text updates before fencing an ACK-lost mutation', async () => {
    vi.useFakeTimers();
    const ackLoss = Object.assign(
      new Error('DingTalk aux update accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const controller = makeController(async () => {});
    controller.append('PREVIEW');
    await vi.advanceTimersByTimeAsync(600);
    const auxPause = dingtalkHttps.pauseStream(2);

    controller.setSystemStatus('status');
    controller.append('NEXT');
    await vi.advanceTimersByTimeAsync(1800);
    expect(dingtalkHttps.visibleMutations).toEqual([
      'card-deliver',
      'card-stream-1',
      'card-stream-2',
    ]);

    auxPause.reject(ackLoss);
    await vi.waitFor(() => expect(controller.isActive()).toBe(true));
    await vi.advanceTimersByTimeAsync(1800);
    expect(dingtalkHttps.visibleMutations).toEqual([
      'card-deliver',
      'card-stream-1',
      'card-stream-2',
    ]);
    const stickyError = await controller.complete('FINAL').catch((e) => e);
    expect(stickyError).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: ackLoss,
    });
  });
});

describe('DingTalk production host wiring', () => {
  test('main reserves active card delivery before static send and then finalizes', () => {
    const main = fs.readFileSync('src/index.ts', 'utf8');
    const branch = main.slice(
      main.indexOf('let streamingCardHandledIM = false;'),
      main.indexOf('// Only reset idle timer on actual results'),
    );
    const gate = branch.indexOf('outputStreamingSession?.isActive()');
    const staticDelivery = branch.indexOf(
      'const replySendOutcome = await sendMessageWithOutcome',
    );
    const finalization = branch.indexOf(
      'await finalizeChannelCardAfterDelivery(',
    );
    const postFinalizationStatic = branch.indexOf(
      'postFinalizationStaticDelivered = await sendImWithRetry(',
    );

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(staticDelivery).toBeGreaterThan(gate);
    expect(finalization).toBeGreaterThan(staticDelivery);
    expect(postFinalizationStatic).toBeGreaterThan(finalization);
    expect(branch).toContain(
      'pendingStreamingCardCompletion = outputStreamingSession',
    );
    expect(branch).toContain('await persistUncertainStreamingDelivery({');
    expect(branch).toContain(
      "classifyImSendFailure(cardFinalization.error) !==\n                      'uncertain'",
    );
    expect(branch).toContain(
      'directImReply &&\n                    !skipImSend',
    );
  });

  test('conversation Agent finalizes before its exact static fallback gate', () => {
    const main = fs.readFileSync('src/index.ts', 'utf8');
    const agentStart = main.indexOf('async function processAgentConversation(');
    const branchStart = main.indexOf(
      '// ── Complete or hold Feishu streaming card, or fall back to static ──',
      agentStart,
    );
    const branch = main.slice(
      branchStart,
      main.indexOf(
        '// Optional mirror mode for linked IM channels',
        branchStart,
      ),
    );
    const gate = branch.indexOf('outputAgentStreamingSession?.isActive()');
    const finalization = branch.indexOf(
      'await finalizeChannelCardAfterDelivery(',
    );
    const staticDelivery = branch.indexOf(
      'const agentStaticTextDelivered = await sendImWithRetry(',
    );

    expect(gate).toBeGreaterThanOrEqual(0);
    expect(finalization).toBeGreaterThan(gate);
    expect(staticDelivery).toBeGreaterThan(finalization);
    expect(branch).toContain(
      'pendingAgentCardCompletion = outputAgentStreamingSession',
    );
    expect(branch).toContain('await persistUncertainStreamingDelivery({');
    expect(branch).toContain(
      'outputAgentReplySourceJid &&\n          !streamingCardHandledIM &&\n          isFirstReply',
    );
  });
});
