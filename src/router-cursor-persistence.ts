import type { MessageCursor } from './types.js';

export type RouterCursorKind = 'next_pull' | 'committed';

export interface RouterCursorRow {
  kind: RouterCursorKind;
  chat_jid: string;
  cursor: string;
}

export interface RouterCursorChange {
  kind: RouterCursorKind;
  chatJid: string;
  /** Serialized cursor, or null to delete the row. */
  cursor: string | null;
}

export interface RouterCursorMaps {
  nextPull: Record<string, MessageCursor>;
  committed: Record<string, MessageCursor>;
}

const SEPARATOR = '\0';

/**
 * Tracks which per-chat cursors changed since the last persist.
 *
 * Both cursor maps used to be written as two whole-map JSON blobs on every
 * change: with 2,104 chats that was ~384KB per blob, 2ms of stringify and
 * 2.3ms of writes per call, several times per turn. Rows are keyed by
 * (kind, chat_jid) instead, so a persist only writes what changed.
 */
export class RouterCursorPersistence {
  private readonly dirty = new Set<string>();

  markDirty(kind: RouterCursorKind, chatJid: string): void {
    this.dirty.add(`${kind}${SEPARATOR}${chatJid}`);
  }

  get pendingCount(): number {
    return this.dirty.size;
  }

  /**
   * Rebuild both maps from stored rows. Rows whose normalized form differs
   * from what is stored (legacy cursors upgraded to an ingest sequence) are
   * marked dirty so the first persist writes the upgrade, as the whole-map
   * blob write used to. Unparseable rows are dropped and deleted.
   */
  load(
    rows: RouterCursorRow[],
    normalize: (value: unknown, chatJid: string) => MessageCursor,
  ): RouterCursorMaps {
    const maps: RouterCursorMaps = { nextPull: {}, committed: {} };
    for (const row of rows) {
      const target = row.kind === 'committed' ? maps.committed : maps.nextPull;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.cursor);
      } catch {
        this.markDirty(row.kind, row.chat_jid);
        continue;
      }
      const normalized = normalize(parsed, row.chat_jid);
      target[row.chat_jid] = normalized;
      if (JSON.stringify(normalized) !== row.cursor) {
        this.markDirty(row.kind, row.chat_jid);
      }
    }
    return maps;
  }

  /** Current values of every dirty cursor; absent entries become deletes. */
  collectChanges(maps: RouterCursorMaps): RouterCursorChange[] {
    const changes: RouterCursorChange[] = [];
    for (const key of this.dirty) {
      const separator = key.indexOf(SEPARATOR);
      const kind = key.slice(0, separator) as RouterCursorKind;
      const chatJid = key.slice(separator + 1);
      const map = kind === 'committed' ? maps.committed : maps.nextPull;
      const value = Object.prototype.hasOwnProperty.call(map, chatJid)
        ? map[chatJid]
        : undefined;
      changes.push({
        kind,
        chatJid,
        cursor: value ? JSON.stringify(value) : null,
      });
    }
    return changes;
  }

  /** Forget changes that were durably written. */
  acknowledge(changes: RouterCursorChange[]): void {
    for (const change of changes) {
      this.dirty.delete(`${change.kind}${SEPARATOR}${change.chatJid}`);
    }
  }
}
