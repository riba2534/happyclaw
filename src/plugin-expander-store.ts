/**
 * plugin-expander-store.ts
 *
 * DB-level persist helper for plugin-expansion sentinels. Renamed from
 * (former) plugin-expansion-store.ts so the four expander modules share
 * a unified naming scheme (#487 follow-up #6).
 *
 * Lives outside `index.ts` so the web fast-path (`handleWebUserMessage` and
 * `handleAgentConversationMessage` in `src/web.ts`) can call it directly
 * without pulling in the index module's massive transitive surface (#23
 * round-15 P1-1: web eager expand was missing the sentinel write, leaking
 * the round-14 crash-safety guarantee).
 *
 * Read-modify-write because `attachments` may already carry image entries
 * (e.g. a slash command sent with a screenshot). The writer preserves all
 * non-`plugin_expansion` items and replaces any prior sentinel idempotently.
 */

import { getMessageAttachments, updateMessageAttachments } from './db.js';
import { writePluginExpansionToAttachments } from './plugin-expander-sentinel.js';
import type { PluginExpansionSentinel } from './plugin-expander-sentinel.js';

export function persistPluginExpansion(
  msgId: string,
  chatJid: string,
  sentinel: PluginExpansionSentinel,
): void {
  const current = getMessageAttachments(chatJid, msgId);
  const next = writePluginExpansionToAttachments(current, sentinel);
  updateMessageAttachments(chatJid, msgId, next);
}
