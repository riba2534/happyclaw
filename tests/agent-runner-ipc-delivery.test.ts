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
  scheduledGroupRunIdFromIpcMessages,
  sdkResultAnsweredUserMessageUuids,
  sdkResultConsumedUserMessageUuids,
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
  test('recovers the scheduled group occurrence from a warm-runner receipt', () => {
    const scheduled: IpcInputMessage = {
      text: 'scheduled',
      taskId: 'task-42',
      receipt: {
        deliveryId: 'delivery-random',
        chatJid: 'web:main',
        coveredCursors: [
          {
            timestamp: '2026-08-13T00:00:00.000Z',
            id: 'scheduled-task-prompt:run-abc',
          },
        ],
        cursor: {
          timestamp: '2026-08-13T00:00:00.000Z',
          id: 'scheduled-task-prompt:run-abc',
        },
      },
    };
    expect(scheduledGroupRunIdFromIpcMessages([scheduled], 'task-42')).toBe(
      'run-abc',
    );
    expect(
      scheduledGroupRunIdFromIpcMessages([scheduled], 'another-task'),
    ).toBeNull();
  });

  test('orders requeued older messages before newly written messages by durable cursor', () => {
    const olderRequeued = message('1');
    const newerArrival = message('2');

    expect(orderIpcInputMessages([newerArrival, olderRequeued])).toEqual([
      olderRequeued,
      newerArrival,
    ]);
  });

  test('uses host ingest sequence when provider clocks and random IDs disagree', () => {
    const first = message('1');
    first.receipt!.cursor = {
      timestamp: '2026-08-31T00:00:00.000Z',
      id: 'z-random',
      sequence: 41,
    };
    const late = message('2');
    late.receipt!.cursor = {
      timestamp: '2020-01-01T00:00:00.000Z',
      id: 'a-random',
      sequence: 42,
    };

    expect(orderIpcInputMessages([late, first])).toEqual([first, late]);
    expect(latestIpcInputMessage([late, first])).toBe(late);
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

  test('deduplicates a crash claim and Host re-emission by delivery id', () => {
    const original = message('1');
    const tracker = new IpcTurnDeliveryTracker([original]);
    const duplicate = {
      ...original,
      text: 'same durable input re-emitted after claim recovery',
      receipt: {
        ...original.receipt!,
        deliveryId: 'replacement-attempt-delivery-id',
      },
    };

    expect(tracker.acceptTurn([duplicate])).toEqual([]);
    expect(tracker.pendingTurnCount).toBe(1);
    expect(tracker.unacknowledgedMessages).toEqual([original]);
    expect(tracker.completeNextTurn()).toEqual([original.receipt]);
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

  test('completes queued turns the SDK merged into an already finished turn', () => {
    // Reproduces the 2026-10-07 stuck stream: A starts, B/C/D are piped while
    // A is busy, the CLI folds C and D into one turn, and background
    // notifications produce extra results. One-result-per-turn accounting left
    // C and D pending until the 30 min idle timeout.
    const a = message('1');
    const tracker = new IpcTurnDeliveryTracker([a]);
    tracker.bindSdkMessageUuid([a], 'uuid-a');
    for (const id of ['2', '3', '4']) {
      const queuedMessage = message(id);
      tracker.acceptTurn([queuedMessage]);
      tracker.bindSdkMessageUuid([queuedMessage], `uuid-${id}`);
    }
    expect(tracker.pendingTurnCount).toBe(4);

    // Withheld result (background tasks still running) consumed A, B, C, D.
    tracker.observeAnsweredSdkUuids(['uuid-a', 'uuid-2']);
    tracker.observeAnsweredSdkUuids(['uuid-3', 'uuid-4']);
    expect(tracker.completeAnsweredTurns().map((r) => r.cursor.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(tracker.hasPendingTurns).toBe(false);
    expect(tracker.unacknowledgedMessages).toEqual([]);
  });

  test('does not complete a queued turn the SDK has not consumed yet', () => {
    const a = message('1');
    const b = message('2');
    const c = message('3');
    const tracker = new IpcTurnDeliveryTracker([a]);
    tracker.bindSdkMessageUuid([a], 'uuid-a');
    tracker.acceptTurn([b]);
    tracker.bindSdkMessageUuid([b], 'uuid-b');
    tracker.acceptTurn([c]);
    tracker.bindSdkMessageUuid([c], 'uuid-c');

    // C was consumed, but B still waits ahead of it: keep FIFO ownership.
    tracker.observeAnsweredSdkUuids(['uuid-a', 'uuid-c']);
    expect(tracker.completeAnsweredTurns().map((r) => r.cursor.id)).toEqual([
      '1',
    ]);
    expect(tracker.currentTurnDeliveryId).toBe('delivery-2');
    expect(tracker.completeAnsweredTurns().map((r) => r.cursor.id)).toEqual([
      '2',
      '3',
    ]);
    expect(tracker.hasPendingTurns).toBe(false);
  });

  test('falls back to one result per turn when the CLI echoes no uuids', () => {
    const tracker = new IpcTurnDeliveryTracker([]);
    const b = message('2');
    tracker.acceptTurn([b]);
    tracker.bindSdkMessageUuid([b], 'uuid-b');
    tracker.observeAnsweredSdkUuids(
      sdkResultConsumedUserMessageUuids({ type: 'result' }),
    );
    expect(tracker.completeAnsweredTurns()).toEqual([]);
    expect(tracker.pendingTurnCount).toBe(1);
  });

  test('reads consumed user message uuids from SDK results', () => {
    expect(
      sdkResultConsumedUserMessageUuids({
        user_message_uuid: 'b',
        user_message_uuids: ['a', 'b', 7],
      }),
    ).toEqual(['a', 'b', 'b']);
    expect(
      sdkResultConsumedUserMessageUuids({ user_message_uuid: 'a' }),
    ).toEqual(['a']);
    expect(sdkResultConsumedUserMessageUuids({})).toEqual([]);
  });

  test('only a successful result answers the user messages it consumed', () => {
    const consumed = { user_message_uuids: ['a', 'b'] };
    expect(
      sdkResultAnsweredUserMessageUuids({
        ...consumed,
        subtype: 'success',
        is_error: false,
      }),
    ).toEqual(['a', 'b']);
    expect(
      sdkResultAnsweredUserMessageUuids({
        ...consumed,
        subtype: 'success',
        is_error: true,
      }),
    ).toEqual([]);
    expect(
      sdkResultAnsweredUserMessageUuids({
        ...consumed,
        subtype: 'error_during_execution',
      }),
    ).toEqual([]);
  });

  test('inputs merged into an API-error result stay replayable', () => {
    const a = message('1');
    const b = message('2');
    const tracker = new IpcTurnDeliveryTracker([a]);
    tracker.bindSdkMessageUuid([a], 'uuid-a');
    tracker.acceptTurn([b]);
    tracker.bindSdkMessageUuid([b], 'uuid-b');
    tracker.observeAnsweredSdkUuids(
      sdkResultAnsweredUserMessageUuids({
        subtype: 'success',
        is_error: true,
        user_message_uuids: ['uuid-a', 'uuid-b'],
      }),
    );
    // A later healthy result still completes the head turn, but B was never
    // answered and must remain pending.
    expect(tracker.completeAnsweredTurns()).toEqual([a.receipt]);
    expect(tracker.pendingTurnCount).toBe(1);
    expect(tracker.unacknowledgedMessages).toEqual([b]);
  });

  test('after interrupt, exposes only the next turn and not every later turn', () => {
    const turnA = message('1');
    const turnB = message('2');
    const turnC = message('3');
    const tracker = new IpcTurnDeliveryTracker([turnA]);
    tracker.acceptTurn([turnB]);
    tracker.acceptTurn([turnC]);

    expect(tracker.cancelCurrentTurn()).toEqual([turnA]);
    expect(tracker.currentTurnReceipts).toEqual([turnB.receipt]);
    expect(tracker.laterTurnMessages).toEqual([turnC]);
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
    expect(tracker.currentTurnReceipts).toEqual([turnB.receipt]);
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
          sequence: 81,
          sourceJid: 'feishu:oc_chat#account:account-a',
        },
        {
          timestamp: '2026-07-10T00:00:02.000Z',
          id: 'm2',
          sequence: 82,
          sourceJid: 'telegram:-100123#account:account-b',
        },
      ],
      cursor: {
        timestamp: '2026-07-10T00:00:02.000Z',
        id: 'm2',
        sequence: 82,
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
    expect(parsed?.coveredCursors?.map((cursor) => cursor.sequence)).toEqual([
      81, 82,
    ]);
    expect(parsed?.cursor.sequence).toBe(82);
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
