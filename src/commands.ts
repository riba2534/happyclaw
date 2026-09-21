/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  clearSessionChannelOwner,
  deleteSession,
  getJidsByFolder,
  storeMessageDirect,
  ensureChatExists,
  getMessageCursor,
} from './db.js';
import { logger } from './logger.js';
import { clearSessionFiles } from './session-files.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

export type SessionResetMode = 'clear' | 'fresh';

export interface SessionResetOptions {
  mode?: SessionResetMode;
  handoff?: string;
  /**
   * When set, durable session prep runs first, then this hook, then
   * force-stopGroup. Used by IPC fresh_window so the runner can observe a
   * truthful terminal result before the container is killed.
   */
  beforeStop?: () => void | Promise<void>;
}

export interface FreshWindowResetOptions {
  agentId?: string;
  handoff?: string;
  beforeStop?: () => void | Promise<void>;
}

// ─── Command parsing ────────────────────────────────────────────

export function isClearCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/clear';
}

/**
 * `/fresh` with optional trailing notes. Unlike `/clear`, arguments are
 * allowed and become the zero-summary handoff notes.
 */
export function parseFreshCommand(content: string): { notes: string } | null {
  const trimmed = content.trim();
  const match = /^\/fresh(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  return { notes: (match[1] ?? '').trim() };
}

export function isFreshCommand(content: string): boolean {
  return parseFreshCommand(content) !== null;
}

export const SESSION_RESET_FAILURE_MESSAGE =
  'system_error:清除上下文失败，请稍后重试';

export const SESSION_FRESH_WINDOW_FAILURE_MESSAGE =
  'system_error:零摘要换窗失败，请稍后重试';

export const FRESH_WINDOW_SUCCESS_REPLY = '已开启新上下文窗口（零摘要换窗）✓';
export const FRESH_WINDOW_FAILURE_REPLY = '零摘要换窗失败，请稍后重试';

function storeSystemMessage(
  targetJid: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
): string {
  const messageId = crypto.randomUUID();
  ensureChatExists(targetJid);
  storeMessageDirect(
    messageId,
    targetJid,
    '__system__',
    'system',
    content,
    timestamp,
    isFromMe,
  );
  return messageId;
}

function broadcastSystemMessage(
  deps: CommandDeps,
  targetJid: string,
  messageId: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  deps.broadcast(targetJid, {
    id: messageId,
    chat_jid: targetJid,
    sender: '__system__',
    sender_name: 'system',
    content,
    timestamp,
    is_from_me: isFromMe,
  });
}

function resetTargetJids(
  folder: string,
  targetJid: string,
  agentId: string | undefined,
): string[] {
  if (agentId) return [targetJid];
  const siblingJids = getJidsByFolder(folder);
  return siblingJids.length > 0 ? siblingJids : [targetJid];
}

function cursorForStoredMessage(
  jid: string,
  messageId: string,
  timestamp: string,
): MessageCursor {
  return (
    getMessageCursor(jid, messageId) ?? {
      timestamp,
      id: messageId,
    }
  );
}

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  baseChatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
  opts?: SessionResetOptions,
): Promise<void> {
  const targetJid = agentId ? `${baseChatJid}#agent:${agentId}` : baseChatJid;
  const mode: SessionResetMode = opts?.mode === 'fresh' ? 'fresh' : 'clear';
  const dividerContent =
    mode === 'fresh' ? 'context_fresh_window' : 'context_reset';

  const stopActive = async (): Promise<void> => {
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
  };

  const resetSessionState = (): void => {
    // Clear .claude/ session files (preserve settings.json)
    clearSessionFiles(folder, agentId);

    // Delete session from DB (+ in-memory cache for main session)
    deleteSession(folder, agentId);
    clearSessionChannelOwner(folder, agentId);
    if (!agentId) {
      delete deps.sessions[folder];
    }

    // Insert a divider on every JID whose cursor we will advance. Reusing
    // one message id across sibling chats leaves those cursors at sequence 0
    // and the next turn re-ingests the whole inbound history.
    const resetJids = resetTargetJids(folder, targetJid, agentId);
    const dividerDate = new Date();
    const timestamp = dividerDate.toISOString();
    for (const jid of resetJids) {
      const dividerMessageId = storeSystemMessage(
        jid,
        dividerContent,
        timestamp,
        true,
      );
      broadcastSystemMessage(
        deps,
        jid,
        dividerMessageId,
        dividerContent,
        timestamp,
        true,
      );
      deps.setLastAgentTimestamp(
        jid,
        cursorForStoredMessage(jid, dividerMessageId, timestamp),
      );
    }

    // Fresh-window only: store the handoff AFTER the cursor so the next
    // agent turn receives it as new input. is_from_me=false is required
    // because getMessagesSince only pulls inbound (is_from_me=0) rows.
    const handoff = opts?.handoff?.trim();
    if (mode === 'fresh' && handoff) {
      const handoffTimestamp = new Date(
        dividerDate.getTime() + 1,
      ).toISOString();
      for (const jid of resetJids) {
        const handoffMessageId = storeSystemMessage(
          jid,
          handoff,
          handoffTimestamp,
          false,
        );
        broadcastSystemMessage(
          deps,
          jid,
          handoffMessageId,
          handoff,
          handoffTimestamp,
          false,
        );
      }
    }
  };

  if (opts?.beforeStop) {
    // IPC fresh_window: durable prep first while the runner is blocked on the
    // result poll, publish the truthful terminal result, then force-stop.
    // Stop failures must not unwind a committed prep / published success.
    resetSessionState();
    await opts.beforeStop();
    try {
      await stopActive();
    } catch (stopErr) {
      logger.error(
        { baseChatJid, targetJid, folder, agentId, mode, err: stopErr },
        'Session stop after successful fresh-window prep failed',
      );
    }
  } else {
    // Slash /clear and /fresh: stop first so an active agent cannot race the
    // session wipe.
    await stopActive();
    resetSessionState();
  }

  logger.info(
    { baseChatJid, targetJid, folder, agentId, mode },
    mode === 'fresh'
      ? 'Session reset via zero-summary fresh window'
      : 'Session reset via /clear command',
  );
}

export async function executeFreshWindowReset(
  baseChatJid: string,
  folder: string,
  deps: CommandDeps,
  opts?: FreshWindowResetOptions,
): Promise<void> {
  await executeSessionReset(baseChatJid, folder, deps, opts?.agentId, {
    mode: 'fresh',
    handoff: opts?.handoff,
    beforeStop: opts?.beforeStop,
  });
}
