import type { MessageCursor } from './types.js';

export interface CursorOrderedMessage {
  timestamp: string;
  id: string;
  ingest_sequence?: number;
  sequence?: number;
}

function compareCursorOrder(
  message: CursorOrderedMessage,
  cursor: MessageCursor,
): number {
  if (
    (message.ingest_sequence !== undefined || message.sequence !== undefined) &&
    cursor.sequence !== undefined
  ) {
    return (message.ingest_sequence ?? message.sequence!) - cursor.sequence;
  }
  if (message.timestamp !== cursor.timestamp) {
    return message.timestamp < cursor.timestamp ? -1 : 1;
  }
  return message.id.localeCompare(cursor.id);
}

/** True when DB recovery still contains work ordered before an out-of-band
 * candidate. Such a candidate may advance next-pull but must not advance the
 * durable committed cursor. */
export function hasEarlierCursorMessage(
  pending: CursorOrderedMessage[],
  candidate: MessageCursor,
): boolean {
  return pending.some((message) => compareCursorOrder(message, candidate) < 0);
}

function cursorKey(cursor: CursorOrderedMessage): string {
  const sequence = cursor.ingest_sequence ?? cursor.sequence;
  if (sequence !== undefined) {
    return `sequence:${sequence}`;
  }
  return `${cursor.timestamp}\u0000${cursor.id}`;
}

/** True when committing an IPC batch to `terminal` would cross a DB message
 * that the batch did not actually cover. Exact membership matters: using only
 * the terminal cursor mistakes earlier members of the same batch for gaps,
 * while using only a range could skip a concurrently inserted message. */
export function hasUncoveredCursorMessageThrough(
  pending: CursorOrderedMessage[],
  terminal: MessageCursor,
  covered: CursorOrderedMessage[],
): boolean {
  const coveredKeys = new Set(covered.map(cursorKey));
  return pending.some((message) => {
    const isThroughTerminal = compareCursorOrder(message, terminal) <= 0;
    return isThroughTerminal && !coveredKeys.has(cursorKey(message));
  });
}

export class DeferredOutOfBandCursorLedger {
  private readonly entries = new Map<string, MessageCursor[]>();

  defer(jid: string, cursor: MessageCursor): void {
    const cursors = this.entries.get(jid) ?? [];
    if (
      !cursors.some((item) =>
        item.sequence !== undefined && cursor.sequence !== undefined
          ? item.sequence === cursor.sequence
          : item.timestamp === cursor.timestamp && item.id === cursor.id,
      )
    ) {
      cursors.push(cursor);
      cursors.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined) {
          return a.sequence - b.sequence;
        }
        return a.timestamp === b.timestamp
          ? a.id.localeCompare(b.id)
          : a.timestamp.localeCompare(b.timestamp);
      });
      this.entries.set(jid, cursors);
    }
  }

  /** Flush every now-contiguous direct completion. The callbacks keep this
   * class persistence-agnostic; a crash merely forgets deferred entries and
   * safely replays them from DB. */
  flush(
    jid: string,
    hasEarlier: (cursor: MessageCursor) => boolean,
    commit: (cursor: MessageCursor) => void,
  ): MessageCursor[] {
    const cursors = this.entries.get(jid);
    if (!cursors) return [];
    const committed: MessageCursor[] = [];
    while (cursors.length > 0 && !hasEarlier(cursors[0])) {
      const cursor = cursors.shift()!;
      commit(cursor);
      committed.push(cursor);
    }
    if (cursors.length === 0) this.entries.delete(jid);
    return committed;
  }
}
