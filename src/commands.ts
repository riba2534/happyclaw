/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  deleteSession,
  getJidsByFolder,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

// ─── Session file cleanup (mirrors groups.ts clearSessionJsonlFiles) ────

function clearSessionFiles(folder: string, agentId?: string): void {
  const claudeDir = agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', folder, '.claude');
  if (!fs.existsSync(claudeDir)) return;

  const keep = new Set(['settings.json']);
  const entries = fs.readdirSync(claudeDir);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  chatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
): Promise<void> {
  if (agentId) {
    // Agent-specific reset: only stop the agent's virtual JID process
    const virtualJid = `web:${folder}#agent:${agentId}`;
    await deps.queue.stopGroup(virtualJid, { force: true });
  } else {
    // Main session reset: stop all processes for this folder
    const siblingJids = getJidsByFolder(folder);
    await Promise.all(
      siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })),
    );
  }

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder, agentId);

  // 3. Delete session from DB (+ in-memory cache for main session)
  deleteSession(folder, agentId);
  if (!agentId) {
    delete deps.sessions[folder];
  }

  // 4. Insert context_reset divider message into the correct JID
  const targetJid = agentId ? `web:${folder}#agent:${agentId}` : chatJid;
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
    const virtualJid = `web:${folder}#agent:${agentId}`;
    deps.setLastAgentTimestamp(virtualJid, { timestamp, id: dividerMessageId });
  } else {
    const siblingJids = getJidsByFolder(folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, {
        timestamp,
        id: dividerMessageId,
      });
    }
  }

  logger.info({ chatJid, folder, agentId }, 'Session reset via /clear command');
}
