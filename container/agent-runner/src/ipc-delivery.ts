import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ChannelTurnContext, ContainerOutput } from './types.js';

export type IpcDeliveryReceipt = NonNullable<
  ContainerOutput['ipcReceipts']
>[number];

export interface IpcInputMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  /** Exact GroupQueue query attempt that admitted this IPC input. */
  queryRunId?: string;
  taskId?: string;
  sourceJid?: string;
  channelContext?: ChannelTurnContext;
  receipt?: IpcDeliveryReceipt;
}

/**
 * Restore durable arrival order after draining IPC files. Requeued messages
 * can receive newer filenames than messages written while a query is tearing
 * down, so filename order alone can invert two accepted user turns. When the
 * whole batch has receipts, the database cursor is the authoritative order.
 * Mixed legacy batches keep their existing order because receipt-less inputs
 * cannot be placed against durable cursors without guessing.
 */
export function orderIpcInputMessages(
  messages: IpcInputMessage[],
): IpcInputMessage[] {
  if (messages.length < 2 || messages.some((message) => !message.receipt)) {
    return [...messages];
  }

  return [...messages].sort((a, b) => {
    const aCursor = a.receipt!.cursor;
    const bCursor = b.receipt!.cursor;
    if (aCursor.timestamp !== bCursor.timestamp) {
      return aCursor.timestamp < bCursor.timestamp ? -1 : 1;
    }
    if (aCursor.id === bCursor.id) return 0;
    return aCursor.id < bCursor.id ? -1 : 1;
  });
}

export function parseIpcReceipt(
  value: unknown,
): IpcDeliveryReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Record<string, unknown>;
  const cursor = receipt.cursor as Record<string, unknown> | undefined;
  if (
    typeof receipt.deliveryId !== 'string' ||
    typeof receipt.chatJid !== 'string' ||
    !cursor ||
    typeof cursor.timestamp !== 'string' ||
    typeof cursor.id !== 'string'
  ) {
    return undefined;
  }
  let coveredCursors:
    | Array<{ timestamp: string; id: string; sourceJid?: string }>
    | undefined;
  if (Object.prototype.hasOwnProperty.call(receipt, 'coveredCursors')) {
    if (
      !Array.isArray(receipt.coveredCursors) ||
      receipt.coveredCursors.length === 0
    )
      return undefined;
    coveredCursors = [];
    for (const value of receipt.coveredCursors) {
      if (!value || typeof value !== 'object') return undefined;
      const covered = value as Record<string, unknown>;
      if (
        typeof covered.timestamp !== 'string' ||
        typeof covered.id !== 'string'
      )
        return undefined;
      coveredCursors.push({
        timestamp: covered.timestamp,
        id: covered.id,
        ...(typeof covered.sourceJid === 'string'
          ? { sourceJid: covered.sourceJid }
          : {}),
      });
    }
    const maximum = [...coveredCursors].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })[coveredCursors.length - 1];
    if (maximum.timestamp !== cursor.timestamp || maximum.id !== cursor.id)
      return undefined;
  }
  return {
    deliveryId: receipt.deliveryId,
    chatJid: receipt.chatJid,
    ...(coveredCursors && coveredCursors.length > 0 ? { coveredCursors } : {}),
    cursor: {
      timestamp: cursor.timestamp,
      id: cursor.id,
      ...(typeof cursor.sourceJid === 'string'
        ? { sourceJid: cursor.sourceJid }
        : {}),
    },
  };
}

export function isHealthyInputTurnCompletion(
  pendingBackgroundTasks: number,
  suspectTruncated: boolean,
): boolean {
  return pendingBackgroundTasks === 0 && !suspectTruncated;
}

/** Select the delivery id for the greatest durable DB cursor in a drained IPC
 * batch. Files written in the same millisecond contain random suffixes, so
 * readdir/filename order is not a reliable definition of the newest turn. */
export function latestIpcDeliveryId(
  messages: IpcInputMessage[],
): string | undefined {
  return latestIpcInputMessage(messages)?.receipt?.deliveryId;
}

/** Return the message with the greatest receipt cursor, falling back to the
 * last array element for legacy inputs that carry no receipt. */
export function latestIpcInputMessage(
  messages: IpcInputMessage[],
): IpcInputMessage | undefined {
  let latest: IpcInputMessage | undefined;
  for (const message of messages) {
    const receipt = message.receipt;
    if (!receipt) continue;
    if (
      !latest?.receipt ||
      receipt.cursor.timestamp > latest.receipt.cursor.timestamp ||
      (receipt.cursor.timestamp === latest.receipt.cursor.timestamp &&
        receipt.cursor.id > latest.receipt.cursor.id)
    ) {
      latest = message;
    }
  }
  return latest ?? messages[messages.length - 1];
}

/** Associates each accepted IPC batch with exactly one subsequent healthy SDK
 * result. Errors, interrupts, pending-background results and truncation do not
 * call completeNextTurn, so their messages remain replayable. */
export class IpcTurnDeliveryTracker {
  readonly unacknowledgedMessages: IpcInputMessage[];
  private readonly turns: IpcInputMessage[][];

  constructor(initialMessages: IpcInputMessage[] = []) {
    this.unacknowledgedMessages = [...initialMessages];
    this.turns = [[...initialMessages]];
  }

  acceptTurn(messages: IpcInputMessage[]): void {
    this.unacknowledgedMessages.push(...messages);
    this.turns.push([...messages]);
  }

  /** Number of accepted user-input turns that have not produced a healthy SDK
   * result yet. A result can complete the current turn while a steer message is
   * already queued inside the same SDK stream; callers must keep that stream
   * alive until this reaches zero. */
  get pendingTurnCount(): number {
    return this.turns.length;
  }

  get hasPendingTurns(): boolean {
    return this.turns.length > 0;
  }

  /** Exact IPC batch owned by the SDK turn that will complete next. */
  get currentTurnMessages(): IpcInputMessage[] {
    return [...(this.turns[0] ?? [])];
  }

  /** Durable identity of the SDK input turn that owns output right now.
   * A later accepted steer does not become current until completeNextTurn()
   * removes the turn ahead of it. */
  get currentTurnDeliveryId(): string | undefined {
    return latestIpcDeliveryId(this.turns[0] ?? []);
  }

  /** Accepted follow-up turns after the current one, kept in delivery order. */
  get laterTurnMessages(): IpcInputMessage[] {
    return this.turns.slice(1).flatMap((turn) => turn);
  }

  /**
   * Intentionally cancel only the input turn currently owned by the aborted
   * SDK query. Later accepted turns remain unacknowledged and can be requeued.
   *
   * This distinction matters for warm runners: their initial IPC message is
   * part of `unacknowledgedMessages`. Requeueing that message after a user
   * steer would replay the superseded prompt before the steering prompt.
   */
  cancelCurrentTurn(): IpcInputMessage[] {
    const cancelled = this.turns.shift() ?? [];
    for (const message of cancelled) {
      const index = this.unacknowledgedMessages.indexOf(message);
      if (index >= 0) this.unacknowledgedMessages.splice(index, 1);
    }
    return cancelled;
  }

  completeNextTurn(): IpcDeliveryReceipt[] {
    const completed = this.turns.shift() ?? [];
    for (const message of completed) {
      const index = this.unacknowledgedMessages.indexOf(message);
      if (index >= 0) this.unacknowledgedMessages.splice(index, 1);
    }
    return completed
      .map((message) => message.receipt)
      .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
  }
}

/**
 * Snapshots the durable input identity onto emitted frames.
 *
 * The tracker may accept future turns while the SDK is still producing output
 * for the current one, so callers explicitly sync only when the current turn
 * starts or after it is completed. This makes attribution independent from
 * mutable presentation turn IDs and arrival timing.
 */
export class IpcTurnOutputCorrelation {
  private inputTurnIdValue: string;

  constructor(
    private readonly tracker: IpcTurnDeliveryTracker,
    coldHostTurnId: string,
    private readonly forcedLogicalInputTurnId?: string,
  ) {
    this.inputTurnIdValue =
      forcedLogicalInputTurnId ||
      tracker.currentTurnDeliveryId ||
      coldHostTurnId;
  }

  get currentInputTurnId(): string {
    return this.inputTurnIdValue;
  }

  syncCurrentTurn(fallbackInputTurnId = this.inputTurnIdValue): string {
    this.inputTurnIdValue =
      this.forcedLogicalInputTurnId ||
      this.tracker.currentTurnDeliveryId ||
      fallbackInputTurnId;
    return this.inputTurnIdValue;
  }

  correlate(output: ContainerOutput): ContainerOutput {
    return { ...output, inputTurnId: this.inputTurnIdValue };
  }
}

/** Internal continuation queries may rotate their presentation turn id, but
 * every emitted frame must retain the immutable user-input identity. */
export function resolveLogicalQueryInputTurnId(
  presentationTurnId: string | undefined,
  logicalInputTurnIdOverride?: string,
): string | undefined {
  return logicalInputTurnIdOverride ?? presentationTurnId;
}

export function partitionIpcMessagesForLogicalTurn(
  messages: IpcInputMessage[],
  logicalInputTurnId: string | undefined,
): {
  owned: IpcInputMessage[];
  deferred: IpcInputMessage[];
} {
  if (!logicalInputTurnId) return { owned: [...messages], deferred: [] };
  const owned: IpcInputMessage[] = [];
  const deferred: IpcInputMessage[] = [];
  for (const message of messages) {
    if (!message.receipt || message.receipt.deliveryId === logicalInputTurnId) {
      owned.push(message);
    } else {
      deferred.push(message);
    }
  }
  return { owned, deferred };
}

export function shouldAcceptIpcMessagesDuringQuery(
  emitOutput: boolean,
  acceptIpcMessagesDuringQuery: boolean,
): boolean {
  return emitOutput && acceptIpcMessagesDuringQuery;
}

export function serializeIpcInputMessage(message: IpcInputMessage): object {
  return {
    type: 'message',
    text: message.text,
    images: message.images,
    queryRunId: message.queryRunId,
    taskId: message.taskId,
    sourceJid: message.sourceJid,
    channelContext: message.channelContext,
    receipt: message.receipt,
  };
}

/** Put messages consumed by a query that did not complete back into the IPC
 * queue. Filenames preserve the original array order, and each write is
 * atomic so crash recovery never observes a partial receipt payload. */
export function requeueIpcInputMessages(
  inputDir: string,
  messages: IpcInputMessage[],
): string[] {
  if (messages.length === 0) return [];
  fs.mkdirSync(inputDir, { recursive: true });
  const batchId = `${Date.now()}-${randomUUID()}`;
  const written: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const filename = `${batchId}-requeue-${String(index).padStart(6, '0')}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    try {
      fs.writeFileSync(
        tempPath,
        JSON.stringify(serializeIpcInputMessage(messages[index])),
      );
      fs.renameSync(tempPath, filepath);
      written.push(filepath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore missing partial temp file */
      }
      throw err;
    }
  }
  return written;
}
