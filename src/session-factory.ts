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
  listSessionBoundChatJids,
  writeChannelMountUpdates,
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
  runImmediateTransaction,
  storeMessageDirect,
  updateAgentStatus,
} from './db.js';
import {
  cancelChannelTurnRunById,
  listNonterminalChannelTurnRuns,
} from './channel-reliability-store.js';
import { logger } from './logger.js';
import { onTeamSessionDeleted } from './work-item-service.js';
import {
  forgetSessionWorktree,
  removeSessionWorktree,
} from './session-worktree.js';
import type { SessionWorktree } from './session-worktree-store.js';
import type { NewMessage, RegisteredGroup, SubAgent } from './types.js';
import { ensureAgentDirectories, sessionIpcDir } from './utils.js';
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

/** The session a deletion removes, and its workspace. */
export interface SessionDeletion {
  workspaceJid: string;
  group: RegisteredGroup;
  session: SubAgent;
}

/**
 * What follows a committed deletion, by name. Each runs on its own: one that
 * fails is logged and does not keep the others from running.
 */
export type AfterCommit = Record<string, () => void>;

/**
 * Delete a session. One transaction runs `moveFirst` (a caller's own writes,
 * such as moving the session's chats elsewhere) and writes the deletion; on
 * a throw nothing outside the database has changed. Once it commits, the
 * effects outside it follow: those `moveFirst` returned, then the live cache
 * of the chats, the runner stop, the directory removal and the Web updates.
 * The caller has already settled the session's worktree.
 */
export function deleteConversationSession(
  input: SessionDeletion,
  moveFirst?: () => AfterCommit,
): void {
  const afterCommit = runImmediateTransaction(() => [
    moveFirst?.() ?? {},
    writeSessionDeletion(input),
  ]);
  for (const steps of afterCommit) {
    for (const [step, run] of Object.entries(steps)) {
      try {
        run();
      } catch (err) {
        logger.error(
          { err, sessionId: input.session.id, step },
          'A step after deleting a session failed',
        );
      }
    }
  }
}

/** The turns of a session that have not ended: running, waiting to retry or for its user. */
function openTurnsOf(agentId: string) {
  return listNonterminalChannelTurnRuns(50_000).filter(
    (turn) => turn.agentId === agentId,
  );
}

/**
 * The rows of a session's deletion: its transcript, session and runtime rows,
 * its open turns (cancelled: what it was running or waiting to retry goes
 * with it), and the bindings of the chats still bound to it (through the
 * binding write path, so their mounts and team mode follow).
 */
function writeSessionDeletion({
  workspaceJid,
  group,
  session,
}: SessionDeletion): AfterCommit {
  const laneJid = `${workspaceJid}#agent:${session.id}`;
  const live = session.status === 'running' || session.status === 'idle';
  if (live) updateAgentStatus(session.id, 'error', '用户手动停止');
  if (session.kind === 'conversation') deleteMessagesForChatJid(laneJid);
  deleteSession(group.folder, session.id);
  clearSessionChannelOwner(group.folder, session.id);
  for (const turn of openTurnsOf(session.id)) {
    cancelChannelTurnRunById(turn.id, 'Session deleted');
  }
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
  const applyCache = writeChannelMountUpdates(unbound);
  deleteAgent(session.id);
  forgetSessionWorktree(session.id);
  // Its work item ends, or its group stops routing (team mode).
  const announceTeam = onTeamSessionDeleted(session.id);
  // Bound automations of the session pause; persistent ones rebind next run.
  // Last of the writes: the automation service also tells its clients and
  // wakes its scheduler as it goes, so that only happens once the rest
  // succeeded.
  getAutomationService()?.onSessionDeleted(laneJid);
  const removeDir = (dir: string) => () =>
    fs.rmSync(dir, { recursive: true, force: true });
  return {
    unboundChatsCache: applyCache,
    // Whatever its status: this also clears its retry timer and parked tasks.
    runner: () => void getWebDeps()?.queue.stopGroup(laneJid),
    ipcDirectory: removeDir(sessionIpcDir(group.folder, session.id)),
    sessionDirectory: removeDir(
      path.join(DATA_DIR, 'sessions', group.folder, 'agents', session.id),
    ),
    team: announceTeam,
    web: () => projectWebAgentRemoved(workspaceJid, session.id, session.name),
  };
}

/** Inputs the host composes for a lane; they belong to the lane they were written for. */
const LANE_OWNED_INPUTS: ReadonlySet<string> = new Set([
  'automation_prompt',
  'work_item_input',
]);

/**
 * Move the inputs from `chatJids` that session `fromId` has not taken yet
 * into session `toId` as new arrivals there (new ingest sequences, so after
 * its cursor): behind an active run they wait in its queue, otherwise they
 * are pending for its next turn. What stays and goes with the session: the
 * inputs an open turn of it covers (a turn covers its input and the earlier
 * ones of its batch; running or waiting to retry, they are cancelled with
 * it), and the ones the host composed for its lane. Only writes rows; the
 * caller hands the moved inputs to `deliverCarriedInputs` once its
 * transaction commits.
 */
export function carryUnprocessedInputs(
  workspaceJid: string,
  fromId: string,
  toId: string,
  chatJids: ReadonlySet<string>,
): NewMessage[] {
  const deps = getWebDeps();
  if (!deps || chatJids.size === 0) return [];
  const fromLane = `${workspaceJid}#agent:${fromId}`;
  const toLane = `${workspaceJid}#agent:${toId}`;
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
  const pending = getMessagesSince(fromLane, pullCursor);
  const turnInputs = new Set(
    pending.length > 0 ? openTurnsOf(fromId).map((t) => t.correlationId) : [],
  );
  const covered = pending.reduce(
    (last, input, index) => (turnInputs.has(input.id) ? index : last),
    -1,
  );
  const inputs = [
    ...pending.slice(covered + 1),
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
