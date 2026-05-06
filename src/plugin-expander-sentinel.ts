/**
 * plugin-expander-sentinel.ts
 *
 * Sentinel schema + pure JSON helpers for plugin-expansion crash-safety
 * (P1 round-14). Read/write attachments-array entries with
 * type: 'plugin_expansion'. Zero deps — kept separate from
 * plugin-expander-store.ts which holds the DB-bound persist fn, so that
 * plugin-expander-core.ts (which only needs the pure helpers) does not
 * transitively load db.ts.
 *
 * Split out of (former) plugin-command-expander.ts (#487 follow-up #6).
 */

/**
 * Plugin-expansion sentinel persisted into a message's `attachments` JSON
 * after inline `!` commands run successfully. Recovery detects this and
 * skips re-running the inline (P1 round-14 crash-safety). Stored as an
 * extra item in the existing attachments array — `type !== 'image'` so all
 * image readers (frontend MessageBubble, normalizeImageAttachments,
 * agent collectMessageImages) ignore it naturally.
 */
export const PLUGIN_EXPANSION_ATTACHMENT_TYPE = 'plugin_expansion';

export interface PluginExpansionSentinel {
  type: typeof PLUGIN_EXPANSION_ATTACHMENT_TYPE;
  expanded: true;
  prompt: string;
  expandedAt: string;
}

/**
 * Parse the `attachments` JSON string and return a previously-persisted
 * plugin-expansion sentinel, or null if none / malformed. Tolerant of:
 *   - undefined / empty / non-array JSON (returns null silently)
 *   - extra unknown items (ignored, image entries co-exist)
 *   - missing fields on the sentinel (returns null — recovery re-expands)
 */
export function readPluginExpansionFromAttachments(
  attachmentsJson: string | undefined | null,
): PluginExpansionSentinel | null {
  if (!attachmentsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== PLUGIN_EXPANSION_ATTACHMENT_TYPE) continue;
    if (obj.expanded !== true) continue;
    if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) continue;
    const expandedAt =
      typeof obj.expandedAt === 'string' ? obj.expandedAt : '';
    return {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true,
      prompt: obj.prompt,
      expandedAt,
    };
  }
  return null;
}

/**
 * Append (or replace) the plugin-expansion sentinel inside the existing
 * attachments JSON, preserving any image entries. Returns the new JSON
 * string; caller persists it back to the messages row (one DB write per
 * successful expansion).
 *
 * The replace path is defensive: re-running the writer with the same msg
 * id (e.g. an in-flight retry) yields the latest prompt without ever
 * accumulating duplicate sentinels.
 */
export function writePluginExpansionToAttachments(
  attachmentsJson: string | undefined | null,
  sentinel: PluginExpansionSentinel,
): string {
  let arr: unknown[] = [];
  if (attachmentsJson) {
    try {
      const parsed = JSON.parse(attachmentsJson);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // fall through with empty arr — original payload was non-JSON / corrupt
    }
  }
  const filtered = arr.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    return (
      (item as Record<string, unknown>).type !==
      PLUGIN_EXPANSION_ATTACHMENT_TYPE
    );
  });
  filtered.push(sentinel);
  return JSON.stringify(filtered);
}

/**
 * Persist a successfully-expanded prompt back to the message row.
 *
 * Crash-safety contract (P1 round-14): MUST be invoked synchronously after
 * inline execution succeeds, BEFORE the cursor advances past the message.
 * Otherwise a crash between exec and persist would re-execute on recovery.
 * The batch helper enforces ordering by writing inside the for-loop before
 * pushing the expanded message into `toSend`.
 */
export type PersistExpansionFn = (
  msgId: string,
  chatJid: string,
  expansion: PluginExpansionSentinel,
) => void;
