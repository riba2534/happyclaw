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
import { channelConversationJid } from './channel-address.js';
import {
  buildUnmountUpdate,
  commitChannelMountUpdates,
  listSessionBoundChatJids,
} from './channel-mount-service.js';
import {
  clearSessionChannelOwner,
  createAgent,
  deleteAgent,
  deleteMessagesForChatJid,
  deleteSession,
  ensureChatExists,
  getMessagesSince,
  getRegisteredGroup,
  listQueuedFollowUps,
  storeMessageDirect,
  updateAgentStatus,
} from './db.js';
import { logger } from './logger.js';
import { onTeamSessionDeleted } from './work-item-service.js';
import {
  forgetSessionWorktree,
  removeSessionWorktree,
} from './session-worktree.js';
import type { SessionWorktree } from './session-worktree-store.js';
import type { NewMessage, RegisteredGroup, SubAgent } from './types.js';
import { ensureAgentDirectories } from './utils.js';
import {
  getWebDeps,
  projectWebAgentRemoved,
  projectWebAgentStatus,
  projectWebNewMessage,
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
 * Chats still bound to it are unbound through the binding write path, so
 * their mounts, the live cache and team mode follow. Synchronous, so a caller
 * can run it inside its own transaction; the rows go first, so a failed write
 * leaves the runner and the directories alone. The caller has already settled
 * the session's worktree.
 */
export function deleteConversationSession(input: {
  workspaceJid: string;
  group: RegisteredGroup;
  session: SubAgent;
}): void {
  const { workspaceJid, group, session } = input;
  const laneJid = `${workspaceJid}#agent:${session.id}`;
  const live = session.status === 'running' || session.status === 'idle';
  if (live) updateAgentStatus(session.id, 'error', '用户手动停止');
  if (session.kind === 'conversation') deleteMessagesForChatJid(laneJid);
  deleteSession(group.folder, session.id);
  clearSessionChannelOwner(group.folder, session.id);
  const unbound: Array<[string, RegisteredGroup]> = [];
  for (const chatJid of listSessionBoundChatJids(workspaceJid, session.id)) {
    const chat = getRegisteredGroup(chatJid);
    if (!chat) continue;
    // A chat bound here only through a mount is re-projected from its row.
    unbound.push([
      chatJid,
      chat.target_agent_id === session.id ? buildUnmountUpdate(chat) : chat,
    ]);
  }
  commitChannelMountUpdates(unbound);
  deleteAgent(session.id);
  forgetSessionWorktree(session.id);
  // Bound automations of the session pause; persistent ones rebind next run.
  getAutomationService()?.onSessionDeleted(laneJid);
  // Its work item ends, or its group stops routing (team mode).
  onTeamSessionDeleted(session.id);
  if (live) void getWebDeps()?.queue.stopGroup(laneJid);
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
  projectWebAgentRemoved(workspaceJid, session.id, session.name);
}

/** Inputs the host composes for a lane; they belong to the lane they were written for. */
const LANE_OWNED_INPUTS: ReadonlySet<string> = new Set([
  'automation_prompt',
  'work_item_input',
]);

/**
 * Move the inputs from `chatJids` that `fromLane` has not taken yet into
 * `toLane` as new arrivals there (new ingest sequences, so after its
 * cursor): behind an active run they wait in its queue, otherwise they are
 * pending for its next turn. Inputs handed to the stopped runner, and the
 * ones the host composed for this lane, stay and go with it. Only writes
 * rows; the caller hands the moved inputs to `deliverCarriedInputs` once its
 * transaction commits.
 */
export function carryUnprocessedInputs(
  fromLane: string,
  toLane: string,
  chatJids: ReadonlySet<string>,
): NewMessage[] {
  const deps = getWebDeps();
  if (!deps || chatJids.size === 0) return [];
  const fromChat = (input: {
    source_jid?: string;
    source_kind?: string | null;
  }) =>
    !!input.source_jid &&
    chatJids.has(channelConversationJid(input.source_jid)) &&
    !LANE_OWNED_INPUTS.has(input.source_kind ?? '');
  const pullCursor = deps.getLastAgentTimestamp()[fromLane] ?? {
    timestamp: '',
    id: '',
  };
  const inputs = [
    ...getMessagesSince(fromLane, pullCursor),
    ...listQueuedFollowUps(fromLane).filter(
      (item) => item.delivery_status === 'queued',
    ),
  ]
    .filter(fromChat)
    .sort((a, b) => (a.ingest_sequence ?? 0) - (b.ingest_sequence ?? 0));
  if (inputs.length === 0) return [];

  // Behind an active run an input waits in its queue, as one arriving now would.
  const activeRunId = deps.queue.getActiveQueryId(toLane);
  const delivery = activeRunId
    ? {
        delivery_mode: 'queue' as const,
        delivery_status: 'queued' as const,
        delivery_run_id: activeRunId,
        delivery_updated_at: new Date().toISOString(),
      }
    : {};
  ensureChatExists(toLane);
  const carried = inputs.map(
    (input): NewMessage => ({
      id: input.id,
      chat_jid: toLane,
      source_jid: input.source_jid,
      sender: input.sender,
      sender_name: input.sender_name,
      content: input.content,
      timestamp: input.timestamp,
      attachments: input.attachments,
      ...delivery,
    }),
  );
  for (const input of inputs) {
    storeMessageDirect(
      input.id,
      toLane,
      input.sender,
      input.sender_name,
      input.content,
      input.timestamp,
      false,
      {
        attachments: input.attachments,
        sourceJid: input.source_jid,
        channelContext: input.channel_context,
        meta: {
          sourceKind: input.source_kind ?? null,
          deliveryMode: delivery.delivery_mode,
          deliveryStatus: delivery.delivery_status,
          deliveryRunId: delivery.delivery_run_id,
          deliveryUpdatedAt: delivery.delivery_updated_at,
        },
      },
    );
  }
  logger.info(
    { fromLane, toLane, count: carried.length, queued: !!activeRunId },
    'Carried unprocessed inputs of rebound chats to the target session',
  );
  return carried;
}

/**
 * Show inputs carried into session `agentId` (after their transaction
 * commits) and, if the session is idle, start the turn that reads them. A
 * running session takes them from its queue when its turn ends.
 */
export function deliverCarriedInputs(
  workspaceJid: string,
  agentId: string,
  carried: readonly NewMessage[],
): void {
  const deps = getWebDeps();
  if (!deps || carried.length === 0) return;
  const laneJid = `${workspaceJid}#agent:${agentId}`;
  for (const message of carried) projectWebNewMessage(laneJid, message);
  if (deps.queue.getActiveQueryId(laneJid)) return;
  deps.queue.enqueueTask(laneJid, `agent-conv:${agentId}:${Date.now()}`, () =>
    deps.processAgentConversation(workspaceJid, agentId),
  );
}
