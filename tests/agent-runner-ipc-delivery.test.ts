import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  IpcTurnDeliveryTracker,
  IpcTurnOutputCorrelation,
  isHealthyInputTurnCompletion,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  orderIpcInputMessages,
  parseIpcReceipt,
  partitionIpcMessagesForLogicalTurn,
  requeueIpcInputMessages,
  resolveLogicalQueryInputTurnId,
  shouldAcceptIpcMessagesDuringQuery,
  serializeIpcInputMessage,
  type IpcDeliveryReceipt,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function message(id: string): IpcInputMessage {
  return {
    text: id,
    receipt: {
      deliveryId: `delivery-${id}`,
      chatJid: 'web:main',
      cursor: { timestamp: `2026-07-10T00:00:0${id}.000Z`, id },
    },
  };
}

describe('agent-runner IPC delivery turn tracker', () => {
  test('orders requeued older messages before newly written messages by durable cursor', () => {
    const olderRequeued = message('1');
    const newerArrival = message('2');

    expect(orderIpcInputMessages([newerArrival, olderRequeued])).toEqual([
      olderRequeued,
      newerArrival,
    ]);
  });

  test('preserves filesystem order when a mixed batch has no complete durable ordering', () => {
    const newerArrival = message('2');
    const legacyMessage: IpcInputMessage = { text: 'legacy' };
    const olderRequeued = message('1');
    const drained = [newerArrival, legacyMessage, olderRequeued];

    expect(orderIpcInputMessages(drained)).toEqual(drained);
  });

  test('selects the greatest receipt cursor regardless of filesystem order', () => {
    const older = message('1');
    const newerSameTimestamp: IpcInputMessage = {
      text: 'newer',
      receipt: {
        deliveryId: 'delivery-newer',
        chatJid: 'web:main',
        cursor: {
          timestamp: older.receipt!.cursor.timestamp,
          id: 'z-newer',
        },
      },
    };

    expect(latestIpcDeliveryId([newerSameTimestamp, older])).toBe(
      'delivery-newer',
    );
    expect(latestIpcDeliveryId([older, newerSameTimestamp])).toBe(
      'delivery-newer',
    );
    expect(latestIpcInputMessage([newerSameTimestamp, older])).toBe(
      newerSameTimestamp,
    );
  });

  test('startup and idle-drained batches acknowledge only their exact completed turn', () => {
    const startup = [message('1'), message('2')];
    const tracker = new IpcTurnDeliveryTracker(startup);
    const idle = [message('3'), message('4')];
    tracker.acceptTurn(idle);

    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '1',
      '2',
    ]);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.unacknowledgedMessages).toEqual([]);
  });

  test('mid-query turns are FIFO and later receipts cannot attach to an earlier result', () => {
    const tracker = new IpcTurnDeliveryTracker([]);
    tracker.acceptTurn([message('1')]);
    tracker.acceptTurn([message('2')]);

    expect(tracker.pendingTurnCount).toBe(3);
    expect(tracker.hasPendingTurns).toBe(true);
    expect(tracker.completeNextTurn()).toEqual([]); // initial non-IPC prompt
    // The first result completed, but two accepted steer turns are still
    // waiting in the same SDK stream. The runner must not arm its 5s close
    // timeout or tell the host to release a durable queued message yet.
    expect(tracker.pendingTurnCount).toBe(2);
    expect(tracker.hasPendingTurns).toBe(true);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['1']);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual(['2']);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['2']);
    expect(tracker.pendingTurnCount).toBe(0);
    expect(tracker.hasPendingTurns).toBe(false);
  });

  test('keeps slow turn A as output owner until A completes, then advances to queued B', () => {
    const turnA = message('1');
    const turnB = message('2');
    const tracker = new IpcTurnDeliveryTracker([turnA]);
    const correlation = new IpcTurnOutputCorrelation(tracker, 'cold-host-turn');

    // A is still running when B is accepted. A's later delta, status, usage,
    // and result must retain A's immutable delivery identity.
    const outputs = [
      correlation.correlate({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'text_delta', textDelta: 'A1' },
      }),
    ];
    tracker.acceptTurn([turnB]);
    outputs.push(
      correlation.correlate({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'status', statusText: 'A still running' },
      }),
      correlation.correlate({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'usage',
          usage: {
            eventId: 'usage-A',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            costUSD: 0,
            durationMs: 1,
            numTurns: 1,
          },
        },
      }),
      correlation.correlate({ status: 'success', result: 'A done' }),
      correlation.correlate({
        status: 'error',
        result: null,
        error: 'A terminal diagnostic',
      }),
    );
    expect(outputs.map((output) => output.inputTurnId)).toEqual([
      'delivery-1',
      'delivery-1',
      'delivery-1',
      'delivery-1',
      'delivery-1',
    ]);

    expect(tracker.completeNextTurn()).toEqual([turnA.receipt]);
    correlation.syncCurrentTurn();
    const firstBEvent = correlation.correlate({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'text_delta', textDelta: 'B1' },
    });
    expect(firstBEvent.inputTurnId).toBe('delivery-2');
  });

  test('exposes no delivery identity for a cold non-IPC turn so caller can use the original host turnId', () => {
    const tracker = new IpcTurnDeliveryTracker([]);
    const correlation = new IpcTurnOutputCorrelation(tracker, 'host-turn-cold');
    expect(tracker.currentTurnDeliveryId).toBeUndefined();
    expect(
      correlation.correlate({ status: 'success', result: 'cold result' })
        .inputTurnId,
    ).toBe('host-turn-cold');
  });

  test('keeps an internal truncation continuation on the original logical input', () => {
    expect(
      resolveLogicalQueryInputTurnId(
        'presentation-turn-for-continuation',
        'scheduled-prompt-logical-input',
      ),
    ).toBe('scheduled-prompt-logical-input');
    expect(resolveLogicalQueryInputTurnId('ordinary-turn')).toBe(
      'ordinary-turn',
    );
  });

  test('keeps continuation A authoritative while deferring later IPC B', () => {
    const turnA = message('1');
    const turnB = message('2');
    const logicalA = turnA.receipt!.deliveryId;
    const { owned, deferred } = partitionIpcMessagesForLogicalTurn(
      [turnA, turnB],
      logicalA,
    );
    expect(owned).toEqual([turnA]);
    expect(deferred).toEqual([turnB]);

    // Even a malformed/unpartitioned legacy call cannot let receipt B override
    // the explicit continuation owner A.
    const tracker = new IpcTurnDeliveryTracker([turnB]);
    const correlation = new IpcTurnOutputCorrelation(
      tracker,
      'presentation-continuation',
      logicalA,
    );
    expect(
      correlation.correlate({ status: 'success', result: 'A continued' })
        .inputTurnId,
    ).toBe(logicalA);
    expect(correlation.syncCurrentTurn()).toBe(logicalA);
    expect(shouldAcceptIpcMessagesDuringQuery(true, false)).toBe(false);
    expect(shouldAcceptIpcMessagesDuringQuery(true, true)).toBe(true);
  });

  test('pending background, truncation, error and interrupt are not completions', () => {
    expect(isHealthyInputTurnCompletion(1, false)).toBe(false);
    expect(isHealthyInputTurnCompletion(0, true)).toBe(false);
    expect(isHealthyInputTurnCompletion(0, false)).toBe(true);

    const pending = message('1');
    const tracker = new IpcTurnDeliveryTracker([pending]);
    // Error/interrupt paths never invoke completeNextTurn.
    expect(tracker.unacknowledgedMessages).toEqual([pending]);
  });

  test('interrupt requeue serialization preserves the exact receipt', () => {
    const original: IpcInputMessage = {
      ...message('1'),
      sourceJid: 'feishu:oc_test#account:account-1',
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        sourceJid: 'feishu:oc_test#account:account-1',
        channelAccountId: 'account-1',
        message: { id: 'om_test' },
      },
    };
    const serialized = serializeIpcInputMessage(original) as {
      receipt: IpcDeliveryReceipt;
    };
    expect(parseIpcReceipt(serialized.receipt)).toEqual(original.receipt);
    expect(serialized).toMatchObject({
      type: 'message',
      text: '1',
      channelContext: original.channelContext,
      receipt: original.receipt,
    });
  });

  test('failed/interrupt carry requeues messages in order with exact receipts', () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-requeue-'));
    tempDirs.push(inputDir);
    const pending = [message('1'), message('2'), message('3')];

    const written = requeueIpcInputMessages(inputDir, pending);
    expect(written).toHaveLength(3);
    const replayed = fs
      .readdirSync(inputDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(inputDir, name), 'utf8')),
      ) as Array<{ text: string; receipt: IpcDeliveryReceipt }>;

    expect(replayed.map((item) => item.text)).toEqual(['1', '2', '3']);
    expect(replayed.map((item) => item.receipt)).toEqual(
      pending.map((item) => item.receipt),
    );
  });

  test('failed/interrupt requeue preserves warm-turn channel context', () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-requeue-'));
    tempDirs.push(inputDir);
    const original: IpcInputMessage = {
      ...message('1'),
      sourceJid: 'feishu:oc_test#account:account-2#thread:omt_test',
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        sourceJid: 'feishu:oc_test#account:account-2#thread:omt_test',
        channelAccountId: 'account-2',
        chat: { id: 'oc_test', type: 'group', isTopicStyle: true },
        message: { id: 'om_test', threadId: 'omt_test' },
        sender: { openId: 'ou_sender' },
      },
    };

    const [filepath] = requeueIpcInputMessages(inputDir, [original]);
    const replayed = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    expect(replayed.channelContext).toEqual(original.channelContext);
  });

  test('intentional interrupt cancels the current warm-runner turn but preserves later turns', () => {
    const current = message('superseded');
    const laterOne = message('later-1');
    const laterTwo = message('later-2');
    const tracker = new IpcTurnDeliveryTracker([current]);
    tracker.acceptTurn([laterOne]);
    tracker.acceptTurn([laterTwo]);

    expect(tracker.cancelCurrentTurn()).toEqual([current]);
    expect(tracker.unacknowledgedMessages).toEqual([laterOne, laterTwo]);
    expect(tracker.pendingTurnCount).toBe(2);

    expect(tracker.completeNextTurn()).toEqual([laterOne.receipt]);
    expect(tracker.unacknowledgedMessages).toEqual([laterTwo]);
  });

  test('parses and preserves the exact covered cursor set for a batch', () => {
    const parsed = parseIpcReceipt({
      deliveryId: 'delivery-batch',
      chatJid: 'web:main',
      coveredCursors: [
        {
          timestamp: '2026-07-10T00:00:01.000Z',
          id: 'm1',
          sourceJid: 'feishu:oc_chat#account:account-a',
        },
        {
          timestamp: '2026-07-10T00:00:02.000Z',
          id: 'm2',
          sourceJid: 'telegram:-100123#account:account-b',
        },
      ],
      cursor: {
        timestamp: '2026-07-10T00:00:02.000Z',
        id: 'm2',
        sourceJid: 'telegram:-100123#account:account-b',
      },
    });

    expect(parsed?.coveredCursors?.map((cursor) => cursor.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(parsed?.coveredCursors?.map((cursor) => cursor.sourceJid)).toEqual([
      'feishu:oc_chat#account:account-a',
      'telegram:-100123#account:account-b',
    ]);
    expect(parsed?.cursor.sourceJid).toBe('telegram:-100123#account:account-b');
  });

  test('malformed or stale receipt payloads are rejected at the runner boundary', () => {
    expect(parseIpcReceipt(null)).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        cursor: { timestamp: 123, id: 'm' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [
          { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
          { timestamp: 123, id: 'm2' },
        ],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [{ timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' }],
        cursor: { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
      }),
    ).toBeUndefined();
  });
});
