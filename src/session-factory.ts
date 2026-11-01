/**
 * Creating and deleting Runtime Sessions (`agents` rows of kind
 * 'conversation'). The Web routes and automation runs share these, so a
 * session made for an automation is the same thing a user creates.
 *
 * Request validation, ACL and worktree confirmation stay with the callers.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getAutomationService } from './automation-run-ledger.js';
import { DATA_DIR } from './config.js';
import {
  clearSessionChannelOwner,
  createAgent,
  deleteAgent,
  deleteMessagesForChatJid,
  deleteSession,
  ensureChatExists,
  getGroupsByTargetAgent,
  updateAgentStatus,
} from './db.js';
import { refreshChannelMountCache } from './channel-mount-service.js';
import { logger } from './logger.js';
import { onTeamSessionDeleted } from './work-item-service.js';
import {
  forgetSessionWorktree,
  removeSessionWorktree,
} from './session-worktree.js';
import type { SessionWorktree } from './session-worktree-store.js';
import type { RegisteredGroup, SubAgent } from './types.js';
import { ensureAgentDirectories } from './utils.js';
import {
  getWebDeps,
  projectWebAgentRemoved,
  projectWebAgentStatus,
} from './web-context.js';

export interface CreateConversationSessionInput {
  workspaceJid: string;
  group: RegisteredGroup;
  createdBy: string;
  /** Empty → 「新对话」 with an automatic title. */
  name?: string;
  description?: string;
  sessionId?: string;
  sourceKind?: 'manual' | 'automation' | 'team_router' | 'work_item';
  automationId?: string | null;
  /** Created beforehand by the caller; removed again if the insert fails. */
  worktree?: SessionWorktree | null;
}

export async function createConversationSession(
  input: CreateConversationSessionInput,
): Promise<SubAgent> {
  const name = input.name?.trim() || '新对话';
  const session: SubAgent = {
    id: input.sessionId ?? crypto.randomUUID(),
    group_folder: input.group.folder,
    chat_jid: input.workspaceJid,
    name,
    prompt: input.description ?? '',
    status: 'idle',
    kind: 'conversation',
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    // Channel-native topics and Web-created conversations intentionally
    // coexist in one workspace. The source belongs to the session, not to
    // the workspace-wide navigation mode.
    source_kind: input.sourceKind ?? 'manual',
    automation_id: input.automationId ?? null,
    title_source: input.name?.trim() ? 'manual' : 'auto_pending',
  };
  try {
    createAgent(session);
  } catch (error) {
    if (input.worktree) {
      await removeSessionWorktree(session.id, { force: true }).catch(
        (cleanupError) =>
          logger.error(
            { err: cleanupError, sessionId: session.id },
            'Failed to remove the worktree of a session that was not created',
          ),
      );
    }
    throw error;
  }
  ensureAgentDirectories(input.group.folder, session.id);
  ensureChatExists(`${input.workspaceJid}#agent:${session.id}`);
  projectWebAgentStatus(
    input.workspaceJid,
    session.id,
    'idle',
    session.name,
    session.prompt,
  );
  logger.info(
    {
      sessionId: session.id,
      jid: input.workspaceJid,
      name: session.name,
      userId: input.createdBy,
      sourceKind: session.source_kind,
    },
    'Workspace session created',
  );
  return session;
}

/** Hide a session from the session tree; its history stays. */
export function archiveConversationSession(
  workspaceJid: string,
  session: SubAgent,
): void {
  updateAgentStatus(session.id, 'completed');
  projectWebAgentStatus(
    workspaceJid,
    session.id,
    'completed',
    session.name,
    session.prompt,
  );
}

/**
 * Stop a session's runner and delete its directories, transcript and rows.
 * Chats still bound to it are left unbound, in the database and the live
 * cache. The caller has already settled the session's worktree.
 */
export async function deleteConversationSession(input: {
  workspaceJid: string;
  group: RegisteredGroup;
  session: SubAgent;
}): Promise<void> {
  const { workspaceJid, group, session } = input;
  const laneJid = `${workspaceJid}#agent:${session.id}`;
  if (session.status === 'running' || session.status === 'idle') {
    updateAgentStatus(session.id, 'error', '用户手动停止');
    getWebDeps()?.queue.stopGroup(laneJid);
  }
  for (const dir of [
    path.join(DATA_DIR, 'ipc', group.folder, 'agents', session.id),
    path.join(DATA_DIR, 'sessions', group.folder, 'agents', session.id),
  ]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (session.kind === 'conversation') deleteMessagesForChatJid(laneJid);
  deleteSession(group.folder, session.id);
  clearSessionChannelOwner(group.folder, session.id);
  const boundChats = getGroupsByTargetAgent(session.id).map(({ jid }) => jid);
  // Unbinds those chats in the same transaction as the row.
  deleteAgent(session.id);
  refreshChannelMountCache(boundChats);
  forgetSessionWorktree(session.id);
  // Bound automations of the session pause; persistent ones rebind next run.
  getAutomationService()?.onSessionDeleted(laneJid);
  // Its work item ends, or its group stops routing (team mode).
  onTeamSessionDeleted(session.id);
  projectWebAgentRemoved(workspaceJid, session.id, session.name);
}
