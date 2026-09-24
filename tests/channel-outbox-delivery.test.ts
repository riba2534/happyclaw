import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-outbox-runtime-'));
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
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const runtimeScope = await import('../src/channel-outbox-runtime-scope.js');
const retryPolicy = await import('../src/im-send-retry-policy.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-primary',
  sourceJid: 'feishu:bot-primary:chat-1#root:root-1#thread:thread-1',
  chatId: 'chat-1',
  rootId: 'root-1',
  threadId: 'thread-1',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun(name: string, now: string) {
  return store.createChannelTurnRun({
    ...route,
    idempotencyKey: `delivery-test:${name}`,
    now,
  }).run;
}

describe('channel outbox physical delivery transaction', () => {
  const semanticInput = (
    runId: string,
    payload: unknown,
    owner: string,
    send: () => Promise<{ providerMessageId: string }>,
  ) => {
    const identity = runtimeScope.semanticChannelOutboxIdentity({
      route,
      kind: 'file',
      payload,
    });
    return {
      ...route,
      turnRunId: runId,
      ordinal: runtimeScope.stableChannelOutboxOrdinal(identity),
      kind: 'file' as const,
      payload,
      idempotencyKey: `${runId}:${identity}`,
      owner,
      delivery: { mode: 'single' as const, send },
    };
  };

  test('blocks a new requestId and every sibling after one provider ACK becomes uncertain', async () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'message-before-runner-close',
      agentId: 'agent-uncertain-sibling',
    });
    let physicalSends = 0;
    const sameFile = {
      fileName: 'person-20260723-bill.pdf',
      contentHash: 'same-content',
    };
    const first = await delivery.deliverChannelOutboxItem(
      semanticInput(runtime.runId, sameFile, 'request-id-one', async () => {
        physicalSends++;
        // Provider accepted the file, but the host lost the ACK.
        throw new Error('connection closed after provider accepted file');
      }),
    );
    expect(first.status).toBe('uncertain');
    // `_close` must not put this execution into retry_wait. The index performs
    // this same check before runtime.retry and commits the application cursor.
    expect(store.hasUncertainChannelOutbox(runtime.runId)).toBe(true);
    expect(
      runtime.interrupt('Uncertain file delivery requires manual review'),
    ).toBe(true);
    runtime.dispose();
    const closedRunnerReplay = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'message-before-runner-close',
      agentId: 'agent-uncertain-sibling',
    });
    expect(closedRunnerReplay.executionDisposition).toBe(
      'manual_reconciliation',
    );
    closedRunnerReplay.dispose();

    const modelRetryWithNewRequestId = await delivery.deliverChannelOutboxItem(
      semanticInput(runtime.runId, sameFile, 'request-id-two', async () => {
        physicalSends++;
        return { providerMessageId: 'must-not-send-again' };
      }),
    );
    expect(modelRetryWithNewRequestId).toMatchObject({
      status: 'uncertain',
      itemId: first.itemId,
    });

    const siblingFile = await delivery.deliverChannelOutboxItem(
      semanticInput(
        runtime.runId,
        { fileName: 'other.pdf', contentHash: 'different-content' },
        'request-id-three',
        async () => {
          physicalSends++;
          return { providerMessageId: 'must-not-send-sibling' };
        },
      ),
    );
    expect(siblingFile).toMatchObject({
      status: 'uncertain',
      itemId: first.itemId,
    });
    expect(physicalSends).toBe(1);
    expect(store.hasUncertainChannelOutbox(runtime.runId)).toBe(true);

    const uncertain = store.getChannelOutboxItem(first.itemId)!;
    expect(
      store.resolveUncertainChannelOutbox(uncertain.id, uncertain.revision, {
        resolution: 'delivered',
        providerMessageId: 'provider-message-confirmed-manually',
      }),
    ).toBe(true);
    const confirmedReplay = await delivery.deliverChannelOutboxItem(
      semanticInput(runtime.runId, sameFile, 'request-id-four', async () => {
        physicalSends++;
        return { providerMessageId: 'must-not-send-after-confirmation' };
      }),
    );
    expect(confirmedReplay).toMatchObject({
      status: 'delivered',
      reused: true,
      receipt: {
        providerMessageId: 'provider-message-confirmed-manually',
      },
    });
    expect(physicalSends).toBe(1);
  });

  test('manual failed resolution remains terminal and never physically resends', async () => {
    const run = createRun('manual-failed', '2026-07-23T03:59:00.000Z');
    let physicalSends = 0;
    const payload = { fileName: 'rejected.pdf', contentHash: 'rejected' };
    const input = semanticInput(run.id, payload, 'request-one', async () => {
      physicalSends++;
      throw new Error('ACK timeout after provider call');
    });
    const first = await delivery.deliverChannelOutboxItem(input);
    expect(first.status).toBe('uncertain');
    const uncertain = store.getChannelOutboxItem(first.itemId)!;
    expect(
      store.resolveUncertainChannelOutbox(uncertain.id, uncertain.revision, {
        resolution: 'failed',
        error: 'Provider confirmed rejection',
      }),
    ).toBe(true);

    const replay = await delivery.deliverChannelOutboxItem({
      ...input,
      owner: 'request-two',
      delivery: {
        mode: 'single',
        send: async () => {
          physicalSends++;
          return { providerMessageId: 'must-not-send-after-failure' };
        },
      },
    });
    expect(replay).toMatchObject({
      status: 'failed',
      reused: false,
      error: 'Provider confirmed rejection',
    });
    expect(physicalSends).toBe(1);
  });

  test('allows two different files in one healthy turn exactly once each', async () => {
    const run = createRun('healthy-distinct-files', '2026-07-23T03:59:30.000Z');
    const sends = new Map<string, number>();
    const sendFile = (name: string) => async () => {
      sends.set(name, (sends.get(name) ?? 0) + 1);
      return { providerMessageId: `message-${name}` };
    };
    const fileA = { fileName: 'a.pdf', contentHash: 'content-a' };
    const fileB = { fileName: 'b.pdf', contentHash: 'content-b' };

    await delivery.deliverChannelOutboxItem(
      semanticInput(run.id, fileA, 'request-a', sendFile('a')),
    );
    await delivery.deliverChannelOutboxItem(
      semanticInput(run.id, fileB, 'request-b', sendFile('b')),
    );
    await delivery.deliverChannelOutboxItem(
      semanticInput(run.id, fileA, 'request-a-replay', sendFile('a')),
    );

    expect(Object.fromEntries(sends)).toEqual({ a: 1, b: 1 });
  });

  test('binds mirror deliveries to independent exact targets in the same turn', async () => {
    const run = createRun('mirror-exact-targets', '2026-07-23T03:59:45.000Z');
    const payload = { text: '同一个回复' };
    const mirrorRoutes = [
      {
        provider: 'feishu',
        accountId: 'bot-primary',
        sourceJid:
          'feishu:bot-primary:chat-mirror-a#root:root-a#thread:thread-a',
        chatId: 'chat-mirror-a',
        rootId: 'root-a',
        threadId: 'thread-a',
      },
      {
        provider: 'feishu',
        accountId: 'bot-secondary',
        sourceJid:
          'feishu:bot-secondary:chat-mirror-b#root:root-b#thread:thread-b',
        chatId: 'chat-mirror-b',
        rootId: 'root-b',
        threadId: 'thread-b',
      },
    ];
    const sends = new Map<string, number>();

    const deliverMirror = async (
      target: (typeof mirrorRoutes)[number],
      owner: string,
    ) => {
      const identity = runtimeScope.semanticChannelOutboxIdentity({
        route: target,
        kind: 'text',
        payload,
        ordinalSlot: `mirror:${target.sourceJid}`,
      });
      return delivery.deliverChannelOutboxItem({
        ...target,
        turnRunId: run.id,
        ordinal: runtimeScope.stableChannelOutboxOrdinal(identity),
        kind: 'text',
        payload,
        idempotencyKey: `${run.id}:${identity}`,
        owner,
        delivery: {
          mode: 'single',
          send: async () => {
            sends.set(target.sourceJid, (sends.get(target.sourceJid) ?? 0) + 1);
            return {
              providerMessageId: `ack-${target.chatId}`,
            };
          },
        },
      });
    };

    await deliverMirror(mirrorRoutes[0]!, 'mirror-a-first');
    await deliverMirror(mirrorRoutes[1]!, 'mirror-b-first');
    const replay = await deliverMirror(mirrorRoutes[0]!, 'mirror-a-replay');

    expect(Object.fromEntries(sends)).toEqual({
      [mirrorRoutes[0]!.sourceJid]: 1,
      [mirrorRoutes[1]!.sourceJid]: 1,
    });
    expect(replay).toMatchObject({ status: 'delivered', reused: true });
  });

  test('reuses delivered text while one failed attachment remains independent', async () => {
    const now = '2026-07-23T04:00:00.000Z';
    const run = createRun('partial-attachment', now);
    let textSends = 0;
    let fileSends = 0;
    const textInput = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text' as const,
      payload: { text: '正文' },
      owner: 'sender-text',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => {
          textSends++;
          return { providerMessageId: 'text-message-1' };
        },
      },
    };
    const text = await delivery.deliverChannelOutboxItem(textInput);
    expect(text).toMatchObject({
      status: 'delivered',
      reused: false,
      receipt: { providerMessageId: 'text-message-1' },
    });
    const textReplay = await delivery.deliverChannelOutboxItem(textInput);
    expect(textReplay).toMatchObject({
      status: 'delivered',
      reused: true,
      receipt: { providerMessageId: 'text-message-1' },
    });
    expect(textSends).toBe(1);

    const fileInput = {
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'file' as const,
      payload: { path: 'deliverables/report.pdf' },
      owner: 'sender-file',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async (): Promise<{ providerMessageId: string }> => {
          fileSends++;
          throw new delivery.DefinitiveChannelDeliveryError(
            'provider rejected file type',
          );
        },
      },
    };
    const file = await delivery.deliverChannelOutboxItem(fileInput);
    expect(file).toMatchObject({
      status: 'failed',
      error: 'provider rejected file type',
    });
    const fileReplay = await delivery.deliverChannelOutboxItem(fileInput);
    expect(fileReplay.status).toBe('failed');
    expect(fileSends).toBe(1);
    expect(store.getChannelOutboxItem(text.itemId)?.status).toBe('delivered');
  });

  test('marks server-success/client-timeout as uncertain and never replays it', async () => {
    const now = '2026-07-23T04:01:00.000Z';
    const run = createRun('timeout', now);
    let providerAccepted = 0;
    const input = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'card' as const,
      payload: { card: { title: 'result' } },
      owner: 'sender-timeout',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async (): Promise<{ providerMessageId: string }> => {
          providerAccepted++;
          // The provider persisted the card, but the client never received
          // its response. Retrying would create a duplicate visible card.
          throw new Error('response timeout after provider accepted request');
        },
      },
    };
    const first = await delivery.deliverChannelOutboxItem(input);
    expect(first).toMatchObject({ status: 'uncertain', reused: false });
    const replay = await delivery.deliverChannelOutboxItem(input);
    expect(replay.status).toBe('uncertain');
    expect(providerAccepted).toBe(1);
  });

  test('marks connector pre-accept failures as failed without fencing the turn', async () => {
    const now = '2026-07-23T04:01:30.000Z';
    const run = createRun('pre-accept', now);
    let sends = 0;
    const input = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'file' as const,
      payload: { path: 'deliverables/huge.zip' },
      owner: 'sender-pre-accept',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async (): Promise<{ providerMessageId: string }> => {
          sends++;
          // Typed pre-accept evidence: the connector proved no provider
          // mutation happened (e.g. a local size-limit preflight).
          throw retryPolicy.preAcceptImDeliveryError(
            '文件大小超过 30MB 限制 (47.64MB)',
          );
        },
      },
    };
    const first = await delivery.deliverChannelOutboxItem(input);
    expect(first).toMatchObject({
      status: 'failed',
      error: '文件大小超过 30MB 限制 (47.64MB)',
    });
    expect(sends).toBe(1);
    // A definitive local failure must not block later sends in the turn.
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeFalsy();
  });

  test('reuses a persisted upload after process death before send', async () => {
    let now = '2026-07-23T04:02:00.000Z';
    const run = createRun('upload-crash', now);
    let uploads = 0;
    let sends = 0;
    const base = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'file' as const,
      payload: { path: 'deliverables/report.pdf' },
      owner: 'sender-upload-crash',
      leaseMs: 1_000,
      now: () => now,
      delivery: {
        mode: 'upload_then_send' as const,
        upload: async () => {
          uploads++;
          return { providerUploadKey: 'persisted-file-key' };
        },
        sendUploaded: async () => {
          sends++;
          return { providerMessageId: 'file-message-after-restart' };
        },
      },
    };
    await expect(
      delivery.deliverChannelOutboxItem({
        ...base,
        afterPersist: (phase) => {
          if (phase === 'uploaded') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);
    expect(uploads).toBe(1);
    expect(sends).toBe(0);
    const durable = store.getChannelOutboxItem(
      store
        .scanChannelReliabilityNonterminal()
        .outbox.find((item) => item.turnRunId === run.id)!.id,
    )!;
    expect(durable).toMatchObject({
      status: 'uploaded',
      providerUploadKey: 'persisted-file-key',
    });

    now = '2026-07-23T04:02:01.001Z';
    expect(delivery.reconcileChannelOutboxDeliveries(now)).toEqual({
      retryable: 1,
      uncertain: 0,
    });
    const resumed = await delivery.deliverChannelOutboxItem(base);
    expect(resumed).toMatchObject({
      status: 'delivered',
      receipt: {
        providerMessageId: 'file-message-after-restart',
        providerUploadKey: 'persisted-file-key',
      },
    });
    expect(uploads).toBe(1);
    expect(sends).toBe(1);
  });

  test('startup reconciliation fences a crash after sending began', async () => {
    let now = '2026-07-23T04:03:00.000Z';
    const run = createRun('sending-crash', now);
    let sends = 0;
    const base = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'image' as const,
      payload: { path: 'result.png' },
      owner: 'sender-combined-crash',
      leaseMs: 1_000,
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => {
          sends++;
          return { providerMessageId: 'should-not-run-in-test' };
        },
      },
    };
    await expect(
      delivery.deliverChannelOutboxItem({
        ...base,
        afterPersist: (phase) => {
          if (phase === 'sending') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);
    expect(sends).toBe(0);

    now = '2026-07-23T04:03:01.001Z';
    expect(delivery.reconcileChannelOutboxDeliveries(now)).toEqual({
      retryable: 0,
      uncertain: 1,
    });
    const replay = await delivery.deliverChannelOutboxItem(base);
    expect(replay.status).toBe('uncertain');
    expect(sends).toBe(0);
  });
});
