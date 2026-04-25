/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  deleteSession,
  getJidsByFolder,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { logger } from './logger.js';
import { clearSessionFiles } from './session-files.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  baseChatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
): Promise<void> {
  const targetJid = agentId
    ? `${baseChatJid}#agent:${agentId}`
    : baseChatJid;

  if (agentId) {
    // Agent-specific reset: only stop the agent's virtual JID process
    await deps.queue.stopGroup(targetJid, { force: true });
  } else {
    // Main session reset: stop all processes for this folder
    const siblingJids = getJidsByFolder(folder);
    await Promise.all(
      siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })),
    );
  }

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder, agentId);

  // 3. Delete runtime-aware native session state from DB.
  deleteSession(folder, agentId);

  // 4. Insert context_reset divider message into the correct JID
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(targetJid);
  storeMessageDirect(
    dividerMessageId,
    targetJid,
    '__system__',
    'system',
    'context_reset',
    timestamp,
    true,
  );

  deps.broadcast(targetJid, {
    id: dividerMessageId,
    chat_jid: targetJid,
    sender: '__system__',
    sender_name: 'system',
    content: 'context_reset',
    timestamp,
    is_from_me: true,
  });

  // 5. Advance lastAgentTimestamp so old messages before the reset are not
  //    re-sent to the next fresh agent session.
  if (agentId) {
    deps.setLastAgentTimestamp(targetJid, { timestamp, id: dividerMessageId });
  } else {
    const siblingJids = getJidsByFolder(folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, {
        timestamp,
        id: dividerMessageId,
      });
    }
  }

  logger.info(
    { baseChatJid, targetJid, folder, agentId },
    'Session reset via /clear command',
  );
}
