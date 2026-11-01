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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-host-gate-'));
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
const { preAcceptImDeliveryError } =
  await import('../src/im-send-retry-policy.js');
const { WeComStreamingController } = await import('../src/wecom-streaming.js');

const route = {
  provider: 'wecom',
  accountId: 'wecom-bot',
  sourceJid: 'wecom:chat-1',
  chatId: 'chat-1',
  rootId: null,
  threadId: null,
};

type WeComController = InstanceType<typeof WeComStreamingController>;

async function runMainHostGate(input: {
  controller: WeComController;
  text: string;
  staticSend: (text: string) => Promise<void>;
  scope?: {
    turnRunId: string;
    inputTurnId: string;
    owner: string;
    token: string;
  };
}) {
  // This is the production main-runner ownership gate: an active provider
  // session reserves the native presentation before the static send branch.
  const pendingStreamingCardCompletion = input.controller.isActive()
    ? input.controller
    : undefined;
  if (!pendingStreamingCardCompletion) {
    await input.staticSend(input.text);
    return { presentation: 'static' as const };
  }

  const finalization = await finalizeChannelCardAfterDelivery(
    pendingStreamingCardCompletion,
    input.text,
    true,
    'finalize failed',
  );
  const fenced =
    finalization.error && input.scope
      ? await persistUncertainStreamingDelivery({
          scope: { ...route, ...input.scope },
          operationKey: 'wecom-stream-final',
          payload: {
            role: 'primary_stream_final',
            contentHash: input.text,
          },
          error: finalization.error,
        })
      : null;
  return { presentation: 'stream' as const, finalization, fenced };
}

beforeAll(() => db.initDatabase());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WeCom main host streaming gate', () => {
  test('first preview ACK loss stays host-owned and cannot open a static copy', async () => {
    vi.useFakeTimers();
    const ackLoss = Object.assign(
      new Error('WeCom preview accepted but ACK was lost'),
      { code: 'ETIMEDOUT' },
    );
    const visibleMutations: string[] = [];
    const sendStream = vi.fn(async () => {
      visibleMutations.push('stream-preview');
      throw ackLoss;
    });
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new WeComStreamingController({
      chatId: route.chatId,
      sendStream,
      fallbackSend: staticSend,
    });
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'wecom-first-preview-ack-loss',
    });

    controller.append('possibly visible preview');
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.isActive()).toBe(true);

    const result = await runMainHostGate({
      controller,
      text: 'final answer',
      staticSend,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'wecom-host-gate-test',
        token: 'wecom-host-gate-token',
      },
    });

    expect(result).toMatchObject({
      presentation: 'stream',
      finalization: { acknowledged: false, error: ackLoss },
      fenced: { status: 'uncertain' },
    });
    expect(controller.isActive()).toBe(true);
    expect(staticSend).not.toHaveBeenCalled();
    expect(visibleMutations).toEqual(['stream-preview']);
    expect(
      reliability.getUncertainChannelOutboxForTurn(runtime.runId),
    ).toMatchObject({ status: 'uncertain', kind: 'card' });

    // Host visibility must not make the failed controller mutable again.
    controller.append('late delta');
    controller.setSystemStatus('late status');
    await vi.advanceTimersByTimeAsync(800);
    await expect(controller.complete('repeat complete')).rejects.toBe(ackLoss);
    await expect(controller.abort('repeat abort')).rejects.toBe(ackLoss);
    await expect(controller.complete('third attempt')).rejects.toBe(ackLoss);
    expect(sendStream).toHaveBeenCalledTimes(1);
    expect(visibleMutations).toEqual(['stream-preview']);

    expect(
      runtime.interrupt(
        'WeCom streaming delivery is uncertain; manual reconciliation required',
      ),
    ).toBe(true);
    runtime.dispose();
    const replay = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'wecom-first-preview-ack-loss',
    });
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    replay.dispose();
  });

  test.each([
    [
      'pre-accept',
      preAcceptImDeliveryError('WeCom rejected before provider acceptance'),
    ],
    [
      'definitive rejection',
      new DefinitiveChannelDeliveryError('WeCom provider rejected preview'),
    ],
  ])(
    '%s preview failure releases the host gate for exactly one static send',
    async (_label, failure) => {
      vi.useFakeTimers();
      const visibleMutations: string[] = [];
      const sendStream = vi.fn(async () => Promise.reject(failure));
      const staticSend = vi.fn(async () => {
        visibleMutations.push('host-static');
      });
      const controller = new WeComStreamingController({
        chatId: route.chatId,
        sendStream,
        fallbackSend: staticSend,
      });

      controller.append('rejected preview');
      await vi.advanceTimersByTimeAsync(800);
      expect(controller.isActive()).toBe(false);

      const result = await runMainHostGate({
        controller,
        text: 'safe static answer',
        staticSend,
      });
      expect(result).toEqual({ presentation: 'static' });
      expect(staticSend).toHaveBeenCalledOnce();
      expect(visibleMutations).toEqual(['host-static']);

      await expect(controller.complete('repeat complete')).rejects.toBe(
        failure,
      );
      await expect(controller.abort('repeat abort')).rejects.toBe(failure);
      expect(sendStream).toHaveBeenCalledTimes(1);
      expect(visibleMutations).toEqual(['host-static']);
    },
  );

  test('second preview ACK loss remains partial and never sends a static tail', async () => {
    vi.useFakeTimers();
    const tailAckLoss = new Error('WeCom second preview ACK was lost');
    const visibleMutations: string[] = [];
    let callCount = 0;
    const sendStream = vi.fn(async () => {
      callCount += 1;
      visibleMutations.push(`stream-preview-${callCount}`);
      if (callCount === 2) throw tailAckLoss;
    });
    const staticSend = vi.fn(async () => {
      visibleMutations.push('host-static');
    });
    const controller = new WeComStreamingController({
      chatId: route.chatId,
      sendStream,
      fallbackSend: staticSend,
    });
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'wecom-second-preview-ack-loss',
    });

    controller.append('acknowledged preview');
    await vi.advanceTimersByTimeAsync(800);
    controller.append('uncertain replacement preview');
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.isActive()).toBe(true);

    const result = await runMainHostGate({
      controller,
      text: 'must not create a third mutation',
      staticSend,
      scope: {
        turnRunId: runtime.runId,
        inputTurnId: runtime.inputTurnId,
        owner: 'wecom-host-gate-test',
        token: 'wecom-host-gate-token-2',
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
    expect(controller.isActive()).toBe(true);
    const stickyError =
      result.presentation === 'stream' ? result.finalization.error : undefined;
    await expect(controller.complete('repeat complete')).rejects.toBe(
      stickyError,
    );
    await expect(controller.abort('repeat abort')).rejects.toBe(stickyError);
    expect(staticSend).not.toHaveBeenCalled();
    expect(sendStream).toHaveBeenCalledTimes(2);
    expect(visibleMutations).toEqual(['stream-preview-1', 'stream-preview-2']);

    runtime.dispose();
  });
});

describe('WeCom host wiring', () => {
  test('conversation Agent finalizes an active session before considering static delivery', () => {
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

    expect(agentStart).toBeGreaterThanOrEqual(0);
    expect(branchStart).toBeGreaterThan(agentStart);
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
