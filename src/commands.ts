/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  clearSessionChannelOwner,
  deleteSession,
  storeMessageDirect,
  ensureChatExists,
  getMessageCursor,
} from './db.js';
import { cancelAutomationRunsOfLanes } from './automation-run-ledger.js';
import { logger } from './logger.js';
import { notifyConversationContextCleared } from './context-usage-events.js';
import { clearSessionFiles } from './session-files.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

export type SessionResetMode = 'clear' | 'fresh';

export interface SessionResetOptions {
  mode?: SessionResetMode;
  handoff?: string;
}

export interface FreshWindowResetOptions {
  agentId: string;
  handoff?: string;
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
  agentId: string,
  opts?: SessionResetOptions,
): Promise<void> {
  const targetJid = `${baseChatJid}#agent:${agentId}`;
  const mode: SessionResetMode = opts?.mode === 'fresh' ? 'fresh' : 'clear';
  const dividerContent =
    mode === 'fresh' ? 'context_fresh_window' : 'context_reset';
  // The reset skips every input of the session, so their automation runs
  // end now, before the runner stops.
  cancelAutomationRunsOfLanes([targetJid], mode);

  // 1. Stop only this session's runner.
  await deps.queue.stopGroup(targetJid, { force: true });

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder, agentId);

  // 3. Delete the SDK session
  deleteSession(folder, agentId);
  clearSessionChannelOwner(folder, agentId);
  notifyConversationContextCleared(folder, agentId);

  // 4. Insert a divider and advance the session's cursor past it.
  const dividerDate = new Date();
  const timestamp = dividerDate.toISOString();
  const dividerMessageId = storeSystemMessage(
    targetJid,
    dividerContent,
    timestamp,
    true,
  );
  broadcastSystemMessage(
    deps,
    targetJid,
    dividerMessageId,
    dividerContent,
    timestamp,
    true,
  );
  deps.setLastAgentTimestamp(
    targetJid,
    cursorForStoredMessage(targetJid, dividerMessageId, timestamp),
  );

  // 5. Fresh-window only: store the handoff AFTER the cursor so the next
  //    agent turn receives it as new input. is_from_me=false is required
  //    because getMessagesSince only pulls inbound (is_from_me=0) rows.
  const handoff = opts?.handoff?.trim();
  if (mode === 'fresh' && handoff) {
    const handoffTimestamp = new Date(dividerDate.getTime() + 1).toISOString();
    const handoffMessageId = storeSystemMessage(
      targetJid,
      handoff,
      handoffTimestamp,
      false,
    );
    broadcastSystemMessage(
      deps,
      targetJid,
      handoffMessageId,
      handoff,
      handoffTimestamp,
      false,
    );
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
  opts: FreshWindowResetOptions,
): Promise<void> {
  await executeSessionReset(baseChatJid, folder, deps, opts.agentId, {
    mode: 'fresh',
    handoff: opts.handoff,
  });
}
