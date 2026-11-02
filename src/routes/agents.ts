import { Hono, type Context } from 'hono';
import crypto from 'crypto';
import type { Variables } from '../web-context.js';
import {
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
  projectWebAgentStatus,
} from '../web-context.js';
import {
  createSessionWorktree,
  dirtyWorktreesConflict,
  findDirtySessionWorktrees,
  refreshSessionWorktreeStatus,
  removeSessionWorktree,
  toSessionWorktreePayload,
  WorktreeUnavailableError,
} from '../session-worktree.js';
import {
  getSessionWorktree,
  listSessionWorktreesByFolder,
  type SessionWorktree,
} from '../session-worktree-store.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup, canModifyGroup } from '../group-acl.js';
import { canViewGroup } from '../guest-access.js';
import {
  getRegisteredGroup,
  getAllRegisteredGroups,
  listAgentsByJid,
  getAgent,
  getGroupsByTargetAgents,
  setRegisteredGroup,
  getJidsByFolder,
  updateAgentInfo,
  updateAgentContextInfo,
  updateChatName,
  getLatestMessagePreviewPerChat,
  listImContextBindingsByAgent,
  listChannelMountsBySessions,
  getRegisteredGroupNames,
  getChannelAccount,
  getUserPinnedSessions,
  pinSession,
  unpinSession,
} from '../db.js';
import { sortSessionsForList } from '../session-order.js';
import type {
  AudienceMode,
  AuthUser,
  RegisteredGroup,
  SubAgent,
} from '../types.js';
import { logger } from '../logger.js';
import { getChannelType, extractChatId } from '../im-channel.js';
import {
  carryUnprocessedInputs,
  createConversationSession,
  deleteConversationSession,
  deliverCarriedInputs,
} from '../session-factory.js';
import { getAutomationService } from '../automation-run-ledger.js';
import {
  buildSessionMountUpdate,
  buildDetachedWorkspaceUpdate,
  buildWorkspaceMountUpdate,
  commitChannelMountUpdate,
  writeChannelMountUpdates,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  isBindableSession,
  isNativeContextContainer,
  listSessionBoundChatJids,
  SESSION_NOT_BINDABLE,
  matchesWorkspaceMount,
  unbindChannelMount,
  resolveWorkspaceJid,
} from '../channel-mount-service.js';
import {
  conversationBindingPolicyError,
  type ChannelConversationKind,
} from '../channel-conversation-kind.js';
import {
  FEISHU_P2P_MENTION_ACTIVATION_ERROR,
  feishuP2pRejectsMentionActivation,
  fetchLiveChatInfo,
  getConversationKind,
  hasConsistentChannelAccount,
  parseBindingResponsePolicy,
  refreshAgentLastImJid,
  type ChannelChatInfo,
} from '../channel-binding-helpers.js';

const router = new Hono<{ Variables: Variables }>();

/** Update workspace RegisteredGroup in DB + in-memory cache. */
function updateWorkspaceGroup(jid: string, workspace: RegisteredGroup): void {
  setRegisteredGroup(jid, workspace);
  const deps = getWebDeps();
  if (deps) {
    const groups = deps.getRegisteredGroups();
    groups[jid] = workspace;
  }
}

function markNativeContextWorkspace(jid: string): void {
  const freshWorkspace = getRegisteredGroup(jid);
  if (!freshWorkspace) return;
  updateWorkspaceGroup(jid, {
    ...freshWorkspace,
    conversation_source: 'native_thread',
    conversation_nav_mode: 'vertical_threads',
  });
}

/**
 * Keep native-thread navigation while any Feishu topic group or Telegram
 * forum still maps into the workspace. The source update must be committed
 * before calling this helper.
 */
function detachPreviousThreadMapIfLast(
  imJid: string,
  previous: RegisteredGroup,
  nextWorkspaceJid?: string,
  nextRoutingMode?: 'single_session' | 'thread_map',
): void {
  if (previous.binding_mode !== 'thread_map' || !previous.target_main_jid) {
    return;
  }
  const previousWorkspaceJid = resolveWorkspaceJid(previous.target_main_jid, {
    getRegisteredGroup,
    getJidsByFolder,
  });
  if (!previousWorkspaceJid) return;

  const nextResolvedWorkspaceJid =
    nextRoutingMode === 'thread_map'
      ? resolveWorkspaceJid(nextWorkspaceJid, {
          getRegisteredGroup,
          getJidsByFolder,
        })
      : null;
  if (nextResolvedWorkspaceJid === previousWorkspaceJid) return;
  if (hasRemainingThreadMapMount(previousWorkspaceJid, imJid)) return;

  const workspace = getRegisteredGroup(previousWorkspaceJid);
  if (workspace) {
    updateWorkspaceGroup(
      previousWorkspaceJid,
      buildDetachedWorkspaceUpdate(workspace),
    );
  }
}

function isNativeManagedSession(
  session: Pick<SubAgent, 'source_kind' | 'title_source'>,
): boolean {
  return (
    session.source_kind === 'native_thread' ||
    session.source_kind === 'feishu_thread' ||
    session.title_source === 'native_root' ||
    session.title_source === 'feishu_root'
  );
}

async function unbindBinding(
  user: Pick<AuthUser, 'id' | 'role'>,
  imJid: string,
  _imGroup: RegisteredGroup,
): Promise<
  | { status: 'resolved'; workspaceJid: null }
  | { status: 'unavailable'; reason: string }
> {
  // This operation requires no provider lookup/default workspace and performs
  // no await before the authorization check and atomic binding update.
  const fresh = getRegisteredGroup(imJid);
  if (!fresh) return { status: 'unavailable', reason: 'im_group_not_found' };
  if (
    !canModifyGroup(user, { ...fresh, jid: imJid }) ||
    !hasConsistentChannelAccount(user.id, imJid, fresh)
  ) {
    return { status: 'unavailable', reason: 'account_mismatch' };
  }
  unbindChannelMount(imJid, fresh);
  detachPreviousThreadMapIfLast(imJid, fresh);
  return { status: 'resolved', workspaceJid: null };
}

function unbindError(result: { reason: string }): string {
  return result.reason === 'account_mismatch'
    ? 'Channel account does not match this chat or owner'
    : 'IM group no longer exists';
}

/** Guests get 404 so an ungranted workspace's existence is not revealed. */
function guestAwareForbidden(
  c: Context<{ Variables: Variables }>,
  user: Pick<AuthUser, 'role'>,
) {
  return user.role === 'guest'
    ? c.json({ error: 'Group not found' }, 404)
    : c.json({ error: 'Forbidden' }, 403);
}

// GET /api/groups/:jid/agents — list all agents for a group
/**
 * Names of the user's automations in a workspace, for labelling their run
 * sessions. Another user's automation stays unnamed (owner isolation).
 */
function automationNamesFor(
  user: AuthUser,
  jid: string,
  sessions: SubAgent[],
): Map<string, string> {
  const service = getAutomationService();
  if (!service || !sessions.some((a) => a.source_kind === 'automation')) {
    return new Map();
  }
  try {
    return new Map(
      service
        .list(
          { kind: 'web', userId: user.id, isAdmin: user.role === 'admin' },
          { workspaceJid: jid },
        )
        .map((automation) => [automation.id, automation.name]),
    );
  } catch (err) {
    logger.warn({ err, jid }, 'Failed to list automations for sessions');
    return new Map();
  }
}

/** Sessions in the shared list order, each with the viewer's pin time. */
function orderSessions(
  sessions: SubAgent[],
  pins: Record<string, string>,
): Array<SubAgent & { pinned_at: string | null }> {
  return sortSessionsForList(
    sessions.map((session) => ({
      ...session,
      pinned_at: pins[session.id] ?? null,
    })),
  );
}

/** `automation_id` / `automation_name` of an automation run session. */
function automationFields(
  session: SubAgent,
  names: Map<string, string>,
): { automation_id?: string; automation_name?: string | null } {
  if (session.source_kind !== 'automation' || !session.automation_id) return {};
  return {
    automation_id: session.automation_id,
    automation_name: names.get(session.automation_id) ?? null,
  };
}

router.get('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canViewGroup(user, { ...group, jid })) {
    return guestAwareForbidden(c, user);
  }

  const all = listAgentsByJid(jid);
  const conversations = orderSessions(
    all.filter((a) => a.kind === 'conversation'),
    getUserPinnedSessions(user.id),
  );
  // Conversation sessions first, in the shared list order; then /sw tasks.
  // Rows of the retired `task` kind stay in the database but are not listed.
  const agents: Array<SubAgent & { pinned_at?: string | null }> = [
    ...conversations,
    ...all.filter((a) => a.kind === 'spawn'),
  ];
  const automationNames = automationNamesFor(user, jid, agents);
  const latestByChatJid = getLatestMessagePreviewPerChat(
    conversations.map((a) => `${jid}#agent:${a.id}`),
  );
  const linkedByAgent = getGroupsByTargetAgents(conversations.map((a) => a.id));
  const worktrees = worktreesBySession(group.folder, user);
  return c.json({
    agents: agents.map((a) => {
      const base = {
        id: a.id,
        name: a.name,
        prompt: a.prompt,
        status: a.status,
        kind: a.kind,
        created_at: a.created_at,
        completed_at: a.completed_at,
        result_summary: a.result_summary,
        source_kind: a.source_kind ?? null,
        thread_id: a.thread_id ?? null,
        root_message_id: a.root_message_id ?? null,
        title_source: a.title_source ?? null,
        last_active_at: a.last_active_at ?? null,
        ...automationFields(a, automationNames),
        ...(a.kind === 'spawn'
          ? { spawned_from_jid: a.spawned_from_jid ?? null }
          : {}),
      };
      if (a.kind === 'conversation') {
        const linked = linkedByAgent.get(a.id) ?? [];
        const latest = latestByChatJid.get(`${jid}#agent:${a.id}`);
        return {
          ...base,
          pinned_at: a.pinned_at ?? null,
          latest_message: latest
            ? {
                content: latest.content,
                timestamp: latest.timestamp,
              }
            : null,
          linked_im_groups: linked.map((l) => ({
            jid: l.jid,
            name: l.group.name,
          })),
          worktree: toSessionWorktreePayload(worktrees.get(a.id)),
        };
      }
      return base;
    }),
  });
});

// GET /api/groups/:jid/sessions — formal workspace session list
router.get('/:jid/sessions', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canViewGroup(user, { ...group, jid })) {
    return guestAwareForbidden(c, user);
  }

  const agents = orderSessions(
    listAgentsByJid(jid).filter((a) => a.kind === 'conversation'),
    getUserPinnedSessions(user.id),
  );
  const automationNames = automationNamesFor(user, jid, agents);
  const virtualChatJids = agents.map((a) => `${jid}#agent:${a.id}`);
  const latestByChatJid = getLatestMessagePreviewPerChat(virtualChatJids);
  const mountsBySession = listChannelMountsBySessions(agents.map((a) => a.id));
  const mountNames = getRegisteredGroupNames([
    ...new Set(
      [...mountsBySession.values()].flat().map((mount) => mount.channel_jid),
    ),
  ]);
  const worktrees = worktreesBySession(group.folder, user);

  return c.json({
    sessions: [
      ...agents.map((a) => {
        const latest = latestByChatJid.get(`${jid}#agent:${a.id}`);
        return {
          id: a.id,
          name: a.name,
          prompt: a.prompt,
          status: a.status,
          kind: 'conversation',
          chat_jid: jid,
          created_at: a.created_at,
          completed_at: a.completed_at,
          result_summary: a.result_summary,
          source_kind: a.source_kind ?? null,
          thread_id: a.thread_id ?? null,
          root_message_id: a.root_message_id ?? null,
          title_source: a.title_source ?? null,
          last_active_at: a.last_active_at ?? null,
          pinned_at: a.pinned_at,
          ...automationFields(a, automationNames),
          latest_message: latest
            ? {
                content: latest.content,
                timestamp: latest.timestamp,
              }
            : null,
          linked_im_groups: (mountsBySession.get(a.id) ?? []).map((mount) => ({
            jid: mount.channel_jid,
            name: mountNames.get(mount.channel_jid) ?? mount.channel_jid,
          })),
          worktree: toSessionWorktreePayload(worktrees.get(a.id)),
        };
      }),
    ],
  });
});

/**
 * Sessions live in a Workspace, addressed by its `web:*` JID. A session
 * created under an IM chat JID would mint a `feishu:oc_…#agent:…` logical
 * JID that no connector can deliver to (the channel only knows the
 * transport route), so creation is refused instead of producing a session
 * whose every reply fails route validation.
 */
const NON_WORKSPACE_SESSION_PARENT_ERROR =
  'Sessions can only be created in a workspace (web:* JID); bind the IM chat to a session instead';

function isWorkspaceSessionParent(jid: string): boolean {
  return jid.startsWith('web:') && !jid.includes('#');
}

/**
 * Create the worktree a new session asked for (`worktree: true`) before the
 * session itself, so a failure leaves nothing behind. Returns null when none
 * was requested, or the error response.
 */
async function createRequestedWorktree(
  c: Context<{ Variables: Variables }>,
  input: {
    body: Record<string, unknown>;
    jid: string;
    group: RegisteredGroup;
    user: AuthUser;
    sessionId: string;
  },
): Promise<SessionWorktree | null | Response> {
  if (input.body.worktree !== true) return null;
  if (
    isHostExecutionGroup(input.group) &&
    !hasHostExecutionPermission(input.user)
  ) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  try {
    return await createSessionWorktree({
      group: input.group,
      chatJid: input.jid,
      agentId: input.sessionId,
    });
  } catch (error) {
    if (error instanceof WorktreeUnavailableError) {
      return c.json(
        {
          error: error.message,
          code: 'WORKTREE_UNAVAILABLE',
          reason: error.reason,
        },
        400,
      );
    }
    logger.error(
      { err: error, jid: input.jid, sessionId: input.sessionId },
      'Failed to create session worktree',
    );
    return c.json(
      {
        error: `创建 worktree 失败：${error instanceof Error ? error.message : String(error)}`,
        code: 'WORKTREE_CREATE_FAILED',
      },
      500,
    );
  }
}

/** The workspace's worktrees, rechecked on disk so the list shows broken and
 * recovered checkouts as they are now. */
/** Each session's worktree; none for guests, who get no repository details. */
function worktreesBySession(
  folder: string,
  user: { role: string },
): Map<string, SessionWorktree> {
  if (user.role === 'guest') return new Map();
  return new Map(
    listSessionWorktreesByFolder(folder).map((record) => [
      record.agent_id,
      refreshSessionWorktreeStatus(record),
    ]),
  );
}

/**
 * Refuse to delete a session whose worktree holds uncommitted changes until
 * the caller confirms with `force_worktree=true`. Checked before the runner
 * is stopped, so a refused delete leaves the session untouched.
 */
async function checkWorktreeBeforeDelete(
  c: Context<{ Variables: Variables }>,
  sessionId: string,
  force: boolean,
): Promise<Response | null> {
  const worktree = getSessionWorktree(sessionId);
  if (!worktree || force) return null;
  try {
    const dirty = await findDirtySessionWorktrees([worktree]);
    return dirty.length > 0 ? c.json(dirtyWorktreesConflict(dirty), 409) : null;
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Failed to inspect worktree');
    return c.json({ error: '无法检查会话 worktree 的改动，会话未删除' }, 500);
  }
}

/**
 * Remove a deleted session's worktree, keeping its branch. The runner is
 * stopped first so nothing writes into the checkout while it is checked
 * again and removed, with only this session's lane held (never another
 * session's) and its queued work kept:
 * when the removal is refused (409, work found after the runner stopped) or
 * fails (500), the lane is released as it was. Otherwise the caller deletes
 * the session and then calls `finish` on every path, which drops the lane's
 * work and runs its discard hook.
 */
async function releaseSessionWorktree(
  c: Context<{ Variables: Variables }>,
  input: { jid: string; sessionId: string; force: boolean },
): Promise<{ refusal: Response } | { finish: () => void }> {
  if (!getSessionWorktree(input.sessionId)) return { finish: () => {} };
  const queue = getWebDeps()?.queue;
  const laneJid = `${input.jid}#agent:${input.sessionId}`;
  queue?.holdLane(laneJid);
  const refuse = (refusal: Response) => {
    queue?.releaseLane(laneJid);
    return { refusal };
  };
  try {
    await queue?.stopGroup(laneJid, { force: true, preserveQueuedWork: true });
    const result = await removeSessionWorktree(input.sessionId, {
      force: input.force,
      keepRecord: true,
    });
    if (result && !result.removed) {
      return refuse(c.json(dirtyWorktreesConflict([result.risk]), 409));
    }
  } catch (error) {
    logger.error(
      { err: error, sessionId: input.sessionId },
      'Failed to remove session worktree',
    );
    return refuse(
      c.json(
        {
          error: `移除 worktree 失败，会话未删除：${error instanceof Error ? error.message : String(error)}`,
          code: 'WORKTREE_REMOVE_FAILED',
        },
        500,
      ),
    );
  }
  return { finish: () => queue?.discardHeldLane(laneJid) };
}

// POST /api/groups/:jid/agents — create a user conversation
router.post('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Conversation CRUD mutates the owner's workspace → owner-only, mirroring
  // workspace-config (skills/mcp). Shared members get 403; non-members were
  // already 404'd above so the group's existence stays hidden from them.
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }
  if (!isWorkspaceSessionParent(jid)) {
    return c.json({ error: NON_WORKSPACE_SESSION_PARENT_ERROR }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 40) {
    return c.json({ error: 'Name too long (max 40 chars)' }, 400);
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const agentId = crypto.randomUUID();
  const worktree = await createRequestedWorktree(c, {
    body,
    jid,
    group,
    user,
    sessionId: agentId,
  });
  if (worktree instanceof Response) return worktree;
  const agent = await createConversationSession({
    workspaceJid: jid,
    group,
    createdBy: user.id,
    name,
    description,
    sessionId: agentId,
    worktree,
  });

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      prompt: agent.prompt,
      status: agent.status,
      kind: agent.kind,
      created_at: agent.created_at,
      source_kind: agent.source_kind ?? null,
      thread_id: agent.thread_id ?? null,
      root_message_id: agent.root_message_id ?? null,
      title_source: agent.title_source ?? null,
      last_active_at: agent.last_active_at ?? null,
      worktree: toSessionWorktreePayload(worktree ?? undefined),
    },
  });
});

// POST /api/groups/:jid/sessions — create a workspace conversation session
router.post('/:jid/sessions', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage sessions' },
      403,
    );
  }
  if (!isWorkspaceSessionParent(jid)) {
    return c.json({ error: NON_WORKSPACE_SESSION_PARENT_ERROR }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 40) {
    return c.json({ error: 'Name too long (max 40 chars)' }, 400);
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const sessionId = crypto.randomUUID();
  const worktree = await createRequestedWorktree(c, {
    body,
    jid,
    group,
    user,
    sessionId,
  });
  if (worktree instanceof Response) return worktree;
  // A thread-mapped channel only controls its own native sessions. It must
  // not remove the workspace owner's ability to create independent Web
  // sessions in the same workspace.
  const session = await createConversationSession({
    workspaceJid: jid,
    group,
    createdBy: user.id,
    name,
    description,
    sessionId,
    worktree,
  });

  const payload = {
    id: session.id,
    name: session.name,
    prompt: session.prompt,
    status: session.status,
    kind: session.kind,
    created_at: session.created_at,
    source_kind: session.source_kind ?? null,
    thread_id: session.thread_id ?? null,
    root_message_id: session.root_message_id ?? null,
    title_source: session.title_source ?? null,
    last_active_at: session.last_active_at ?? null,
    pinned_at: null,
    worktree: toSessionWorktreePayload(worktree ?? undefined),
  };
  return c.json({ session: payload, agent: payload });
});

// PATCH /api/groups/:jid/agents/:agentId — rename a conversation agent
router.patch('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Rename mutates the owner's workspace → owner-only (see POST for rationale).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (isNativeManagedSession(agent)) {
    return c.json(
      { error: 'Native thread conversations use read-only titles' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) {
    return c.json({ error: 'Name is required (max 40 chars)' }, 400);
  }

  // Update agent name in DB
  updateAgentInfo(agentId, name, agent.prompt);
  updateAgentContextInfo(agentId, { title_source: 'manual' });

  // Update virtual chat name
  const virtualChatJid = `${jid}#agent:${agentId}`;
  updateChatName(virtualChatJid, name);

  // Broadcast update via WebSocket
  projectWebAgentStatus(
    jid,
    agentId,
    agent.status as import('../types.js').AgentStatus,
    name,
    agent.prompt,
  );

  logger.info({ agentId, jid, name, userId: user.id }, 'Agent renamed');
  return c.json({ success: true });
});

// PATCH /api/groups/:jid/sessions/:sessionId — rename a workspace session
// (`name`, owner only) and/or pin it for the current user (`pinned`).
router.patch('/:jid/sessions/:sessionId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const sessionId = c.req.param('sessionId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const session = getAgent(sessionId);
  if (!session || session.chat_jid !== jid || session.kind !== 'conversation') {
    return c.json({ error: 'Session not found' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const pinned = typeof body.pinned === 'boolean' ? body.pinned : undefined;
  if (pinned === undefined || body.name !== undefined) {
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage sessions' },
        403,
      );
    }
    if (isNativeManagedSession(session)) {
      return c.json(
        { error: 'Native thread sessions use read-only titles' },
        400,
      );
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) {
      return c.json({ error: 'Name is required (max 40 chars)' }, 400);
    }

    updateAgentInfo(sessionId, name, session.prompt);
    updateAgentContextInfo(sessionId, { title_source: 'manual' });
    updateChatName(`${jid}#agent:${sessionId}`, name);

    projectWebAgentStatus(
      jid,
      sessionId,
      session.status as import('../types.js').AgentStatus,
      name,
      session.prompt,
    );
    logger.info({ sessionId, jid, name, userId: user.id }, 'Session renamed');
  }

  let pinnedAt: string | null = null;
  if (pinned === true) pinnedAt = pinSession(user.id, sessionId);
  else if (pinned === false) unpinSession(user.id, sessionId);
  else pinnedAt = getUserPinnedSessions(user.id)[sessionId] ?? null;
  return c.json({ success: true, pinned_at: pinnedAt });
});

/**
 * Everything deleting a session takes with it: the direct chats and
 * ordinary groups bound to it, its native topic bindings, and its bound
 * automations.
 */
function collectSessionDeleteImpact(jid: string, sessionId: string) {
  const linkedJids = listSessionBoundChatJids(jid, sessionId);
  const contexts = listImContextBindingsByAgent(sessionId);
  const names = getRegisteredGroupNames([
    ...new Set([
      ...linkedJids,
      ...contexts.map((binding) => binding.source_jid),
    ]),
  ]);
  const automations = (
    getAutomationService()?.listForSession(`${jid}#agent:${sessionId}`) ?? []
  )
    .filter((automation) => automation.status !== 'completed')
    .map((automation) => ({ id: automation.id, name: automation.name }));
  return {
    linkedImGroups: linkedJids.map((imJid) => ({
      jid: imJid,
      name: names.get(imJid) ?? imJid,
    })),
    threadBindings: contexts.map((binding) => ({
      jid: binding.source_jid,
      name: names.get(binding.source_jid) ?? binding.source_jid,
      context_id: binding.context_id,
    })),
    automations,
  };
}

/**
 * Moving the chats of session `doomed` to session `targetId` before it is
 * deleted: every chat bound to it, each passing the checks a session bind
 * runs, with its own reply, activation and audience settings kept. Either
 * the whole move or a refusal; a chat whose row is gone has nothing to move.
 */
function planRebind(
  user: AuthUser,
  jid: string,
  doomed: SubAgent,
  targetId: string,
): { updates: Array<[string, RegisteredGroup]> } | { refusal: string } {
  const target = getAgent(targetId);
  if (
    targetId === doomed.id ||
    target?.chat_jid !== jid ||
    !isBindableSession(target)
  ) {
    return {
      refusal:
        'The rebind target must be another session of this workspace that chats can bind to',
    };
  }
  const updates: Array<[string, RegisteredGroup]> = [];
  for (const chatJid of listSessionBoundChatJids(jid, doomed.id)) {
    const chat = getRegisteredGroup(chatJid);
    if (!chat) continue;
    // The PUT im-binding checks, on the stored chat kind (the move runs in one
    // synchronous transaction, so no live chat info). The chat is bound here,
    // so there is no conflict to force; a topic group's workspace binding is
    // refused rather than detached.
    if (
      !canModifyGroup(user, { ...chat, jid: chatJid }) ||
      !hasConsistentChannelAccount(user.id, chatJid, chat) ||
      chat.target_main_jid ||
      isNativeContextContainer(chatJid, chat) ||
      conversationBindingPolicyError(
        getConversationKind(chatJid, chat),
        'session',
      )
    ) {
      return {
        refusal: `Chat ${chat.name || chatJid} cannot be bound to the rebind target`,
      };
    }
    updates.push([
      chatJid,
      buildSessionMountUpdate(chat, targetId, {
        replyPolicy: chat.reply_policy,
      }),
    ]);
  }
  return { updates };
}

/**
 * Delete one session of workspace `jid`. A session that chats, topics or
 * automations depend on answers 409 `session_has_bindings` until the client
 * confirms with `confirm_bindings=true`; `rebind_to=<session>` then moves
 * every chat bound to it to another session of the same workspace, together
 * with their inputs it has not taken yet, in the same transaction that
 * deletes it. Without it those chats are left unbound. Topic bindings go
 * with the session (the topic's next message opens a new one); bound
 * automations pause.
 */
async function deleteWorkspaceSession(
  c: Context<{ Variables: Variables }>,
  input: {
    jid: string;
    group: RegisteredGroup;
    session: SubAgent;
  },
): Promise<Response | null> {
  const { jid, group, session } = input;
  const user = c.get('user');
  const rebindTo = c.req.query('rebind_to');
  const invalidRebind = (error: string) =>
    c.json({ error, code: 'invalid_rebind_target' }, 400);
  if (rebindTo) {
    const plan = planRebind(user, jid, session, rebindTo);
    if ('refusal' in plan) return invalidRebind(plan.refusal);
  }

  const impact =
    session.kind === 'conversation'
      ? collectSessionDeleteImpact(jid, session.id)
      : { linkedImGroups: [], threadBindings: [], automations: [] };
  if (
    c.req.query('confirm_bindings') !== 'true' &&
    (impact.linkedImGroups.length > 0 ||
      impact.threadBindings.length > 0 ||
      impact.automations.length > 0)
  ) {
    return c.json(
      {
        error: 'Session has channel bindings or automations',
        code: 'session_has_bindings',
        linked_im_groups: impact.linkedImGroups,
        thread_bindings: impact.threadBindings,
        automations: impact.automations,
      },
      409,
    );
  }

  const forceWorktree = c.req.query('force_worktree') === 'true';
  const worktreeBlock = await checkWorktreeBeforeDelete(
    c,
    session.id,
    forceWorktree,
  );
  if (worktreeBlock) return worktreeBlock;

  // Nothing destructive happens before the worktree is settled: a refused
  // removal leaves the session, its runner state and its queue as they were.
  const worktreeRelease = await releaseSessionWorktree(c, {
    jid,
    sessionId: session.id,
    force: forceWorktree,
  });
  if ('refusal' in worktreeRelease) return worktreeRelease.refusal;
  try {
    const deletion = { workspaceJid: jid, group, session };
    if (!rebindTo) {
      deleteConversationSession(deletion);
      return null;
    }
    // From here on synchronous: the move is checked again against the rows
    // as they are after the awaits, and commits with the deletion or not at
    // all. (A worktree checkout removed above is not restored on a refusal;
    // its branch is kept.)
    const plan = planRebind(user, jid, session, rebindTo);
    if ('refusal' in plan) return invalidRebind(plan.refusal);
    deleteConversationSession(deletion, () => {
      const applyCache = writeChannelMountUpdates(plan.updates);
      const carried = carryUnprocessedInputs(
        jid,
        session.id,
        rebindTo,
        new Set(plan.updates.map(([imJid]) => imJid)),
      );
      refreshAgentLastImJid(rebindTo);
      return {
        reboundChatsCache: applyCache,
        carriedInputs: () => deliverCarriedInputs(jid, rebindTo, carried),
      };
    });
  } finally {
    // The worktree is gone: whatever happened above, the lane's work must
    // not run on without it.
    worktreeRelease.finish();
  }
  return null;
}

// DELETE /api/groups/:jid/agents/:agentId — stop and delete an agent
router.delete('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Delete mutates the owner's workspace → owner-only (see POST for rationale).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage conversations' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  const refused = await deleteWorkspaceSession(c, {
    jid,
    group,
    session: agent,
  });
  if (refused) return refused;

  logger.info({ agentId, jid, userId: user.id }, 'Agent deleted by user');
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/sessions/:sessionId — delete a workspace session
router.delete('/:jid/sessions/:sessionId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const sessionId = c.req.param('sessionId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage sessions' },
      403,
    );
  }

  const session = getAgent(sessionId);
  if (!session || session.chat_jid !== jid || session.kind !== 'conversation') {
    return c.json({ error: 'Session not found' }, 404);
  }
  const refused = await deleteWorkspaceSession(c, {
    jid,
    group,
    session,
  });
  if (refused) return refused;

  logger.info({ sessionId, jid, userId: user.id }, 'Session deleted by user');
  return c.json({ success: true });
});

// POST /api/groups/:jid/im-groups/sync — actively discover chats from every
// connected bot owned by the current user. The GET endpoint remains a fast
// local-cache read so opening the dialog never waits on provider APIs.
router.post('/:jid/im-groups/sync', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const syncUserImGroups = getWebDeps()?.syncUserImGroups;
  if (!syncUserImGroups) {
    return c.json({ error: 'Channel discovery is unavailable' }, 503);
  }

  try {
    const result = await syncUserImGroups(user.id);
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.warn({ error, userId: user.id }, 'Manual IM group sync failed');
    return c.json(
      {
        error: '同步失败，已保留本地聊天列表，请检查 Bot 连接后重试',
      },
      502,
    );
  }
});

// GET /api/groups/:jid/im-groups — list locally known IM chats for this user
router.get('/:jid/im-groups', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Find all IM groups this user can access (across all folders).
  const allGroups = getAllRegisteredGroups();
  const imJids = Object.keys(allGroups).filter((j) => {
    if (j.startsWith('web:')) return false;
    return canAccessGroup(user, { ...allGroups[j], jid: j });
  });

  // Build candidate list
  interface ImGroupCandidate {
    jid: string;
    name: string;
    bound_agent_id: string | null;
    bound_session_id: string | null;
    bound_main_jid: string | null;
    bound_workspace_jid: string | null;
    binding_mode: 'single_context' | 'thread_map';
    routing_mode: 'single_session' | 'thread_map';
    reply_policy: 'source_only' | 'mirror';
    bound_target_name: string | null;
    bound_workspace_name: string | null;
    avatar?: string;
    member_count?: number;
    channel_type: string;
    channel_account_id: string | null;
    channel_account_name: string | null;
    chat_mode?: string; // 'p2p' | 'group' — from Feishu API (distinguishes P2P vs group chat)
    group_message_type?: string;
    is_thread_capable?: boolean;
    conversation_kind: ChannelConversationKind;
    activation_mode?: string;
    audience_mode?: AudienceMode;
    require_mention?: boolean;
    owner_im_id?: string | null;
    sender_allowlist_locked?: boolean;
    added_at: string;
  }

  const candidates: ImGroupCandidate[] = [];
  for (const j of imJids) {
    const g = allGroups[j];

    // Resolve bound target name for display
    let boundTargetName: string | null = null;
    let boundWorkspaceName: string | null = null;
    if (g.target_agent_id) {
      const boundAgent = getAgent(g.target_agent_id);
      if (boundAgent) {
        boundTargetName = boundAgent.name;
        const ownerGroup = getRegisteredGroup(boundAgent.chat_jid);
        if (ownerGroup) boundWorkspaceName = ownerGroup.name;
      }
    } else if (g.target_main_jid) {
      let boundGroup = getRegisteredGroup(g.target_main_jid);
      // Legacy fallback: old bindings stored web:${folder} instead of actual JID
      if (!boundGroup && g.target_main_jid.startsWith('web:')) {
        const folder = g.target_main_jid.slice(4);
        const jids = getJidsByFolder(folder);
        for (const fj of jids) {
          if (fj.startsWith('web:')) {
            boundGroup = getRegisteredGroup(fj);
            if (boundGroup) break;
          }
        }
      }
      if (boundGroup) boundTargetName = boundGroup.name;
    }

    candidates.push({
      jid: j,
      name: g.name,
      bound_agent_id: g.target_agent_id ?? null,
      bound_session_id: g.target_agent_id ?? null,
      bound_main_jid: g.target_main_jid ?? null,
      bound_workspace_jid: g.target_main_jid ?? null,
      binding_mode: g.binding_mode ?? 'single_context',
      routing_mode:
        g.binding_mode === 'thread_map' ? 'thread_map' : 'single_session',
      reply_policy: 'source_only',
      bound_target_name: boundTargetName,
      bound_workspace_name: boundWorkspaceName,
      avatar: g.avatar_url,
      channel_type: getChannelType(j) ?? 'unknown',
      channel_account_id: g.channel_account_id ?? null,
      channel_account_name: g.channel_account_id
        ? (getChannelAccount(g.channel_account_id)?.name ?? null)
        : null,
      chat_mode: g.feishu_chat_mode,
      group_message_type: g.feishu_group_message_type,
      is_thread_capable: isNativeContextContainer(j, g),
      conversation_kind: getConversationKind(j, g),
      activation_mode: g.activation_mode,
      audience_mode: g.audience_mode ?? 'everyone',
      require_mention: g.require_mention === true,
      owner_im_id: g.owner_im_id ?? null,
      sender_allowlist_locked:
        (g.audience_mode === 'owner_only' ||
          g.activation_mode === 'owner_mentioned') &&
        Array.isArray(g.sender_allowlist) &&
        g.sender_allowlist.length === 0,
      added_at: g.added_at,
    });
  }

  // Enrich newly discovered Feishu chats so topic containers are recognized.
  // Telegram Forum capability is persisted by its connector events. Only
  // query live Feishu metadata when durable capability or avatar data is
  // missing. Once persisted, subsequent reads stay cache-only; chat.list sync
  // refreshes names and avatars without an N+1 provider lookup.
  const deps = getWebDeps();
  if (deps?.getChannelChatInfo || deps?.getFeishuChatInfo) {
    const chatInfoPromises = candidates
      .filter(
        (g) =>
          g.channel_type === 'feishu' &&
          (!allGroups[g.jid].feishu_chat_mode || !allGroups[g.jid].avatar_url),
      )
      .map(async (g) => {
        const chatId = extractChatId(g.jid);
        const info = deps.getChannelChatInfo
          ? await deps.getChannelChatInfo(g.jid)
          : g.channel_type === 'feishu'
            ? await deps.getFeishuChatInfo!(user.id, chatId)
            : null;
        if (info) {
          g.avatar = info.avatar;
          g.chat_mode = info.chat_mode;
          g.group_message_type = info.group_message_type;
          g.is_thread_capable = isNativeContextContainer(
            g.jid,
            allGroups[g.jid],
            info as ChannelChatInfo,
          );
          g.conversation_kind = getConversationKind(
            g.jid,
            allGroups[g.jid],
            info as ChannelChatInfo,
          );
          if (info.user_count != null) {
            const count = parseInt(info.user_count, 10);
            if (!isNaN(count)) g.member_count = count;
          }
          if (info.name && info.name !== g.name) g.name = info.name;

          // Persist live metadata against a fresh row so later cached reads do
          // not forget that this is a topic container. Re-reading here also
          // preserves any binding/owner update that landed during the await.
          const fresh = getRegisteredGroup(g.jid);
          if (fresh && canAccessGroup(user, { ...fresh, jid: g.jid })) {
            const next: RegisteredGroup = {
              ...fresh,
              name: info.name?.trim() || fresh.name,
              avatar_url: info.avatar?.trim() || fresh.avatar_url,
              feishu_chat_mode: info.chat_mode ?? fresh.feishu_chat_mode,
              feishu_group_message_type:
                info.group_message_type ?? fresh.feishu_group_message_type,
              native_context_type: g.is_thread_capable
                ? 'thread'
                : fresh.native_context_type,
            };
            if (
              next.name !== fresh.name ||
              next.avatar_url !== fresh.avatar_url ||
              next.feishu_chat_mode !== fresh.feishu_chat_mode ||
              next.feishu_group_message_type !==
                fresh.feishu_group_message_type ||
              next.native_context_type !== fresh.native_context_type
            ) {
              setRegisteredGroup(g.jid, next);
              const cached = deps.getRegisteredGroups();
              if (cached[g.jid]) cached[g.jid] = next;
            }
          }
        }
      });
    await Promise.allSettled(chatInfoPromises);
  }

  const legacyMainJid = `web:${group.folder}`;
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const priority = (candidate: ImGroupCandidate): number => {
    if (
      candidate.bound_workspace_jid === jid ||
      candidate.bound_workspace_jid === legacyMainJid
    ) {
      return 0;
    }
    const addedAt = Date.parse(candidate.added_at);
    if (Number.isFinite(addedAt) && addedAt >= recentCutoff) return 1;
    if (!candidate.bound_agent_id && !candidate.bound_workspace_jid) return 2;
    return 3;
  };
  candidates.sort((a, b) => {
    const priorityDiff = priority(a) - priority(b);
    if (priorityDiff !== 0) return priorityDiff;
    const dateDiff = Date.parse(b.added_at) - Date.parse(a.added_at);
    if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
    const nameDiff = a.name.localeCompare(b.name, 'zh-CN');
    return nameDiff !== 0 ? nameDiff : a.jid.localeCompare(b.jid);
  });

  // Feishu: all registered chats (group and p2p) are now returned.
  // The member_count filter was removed because p2p chats have user_count=0 or 1
  // from the Feishu API (counting non-bot users), which is not a meaningful filter.
  return c.json({ imGroups: candidates });
});

// PUT /api/groups/:jid/sessions/:sessionId/im-binding — bind an IM group to a workspace session
router.put(
  '/:jid/sessions/:sessionId/im-binding',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const sessionId = c.req.param('sessionId');
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!jid.startsWith('web:')) {
      return c.json({ error: 'Binding target must be a workspace' }, 400);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
    if (!imJid) {
      return c.json({ error: 'im_jid is required' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }

    const force = body.force === true;
    const replyPolicy = 'source_only' as const;

    const session = getAgent(sessionId);
    if (
      !session ||
      session.chat_jid !== jid ||
      session.kind !== 'conversation'
    ) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!isBindableSession(session)) {
      return c.json(SESSION_NOT_BINDABLE, 400);
    }
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read after the await: fetchLiveChatInfo makes a live network
    // call (e.g. Feishu getFeishuChatInfo) that yields the event loop,
    // during which a concurrent bind request or the message router's
    // owner-learning path can commit a new mount for this exact imJid —
    // or upgrade native_context_type from 'none' to 'thread'. Building
    // the update, or computing threadCapable, from the pre-await
    // snapshot would silently clobber that concurrent write, bypass the
    // conflict check below (commitChannelMountUpdate persists the full
    // row), or bind a now-thread-capable container as a fixed single
    // session, breaking that thread's session isolation.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    // The pre-await canModifyGroup/hasConsistentChannelAccount checks
    // above only proved authorization against the stale imGroup. During
    // the await, ownership could have changed (credential transfer,
    // delete+recreate, owner-learning) — re-run both checks against the
    // fresh row before committing, or a mutation could cross the
    // original authorization boundary.
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const freshSession = getAgent(sessionId);
    const freshTargetGroup = getRegisteredGroup(jid);
    if (
      !freshSession ||
      freshSession.chat_jid !== jid ||
      freshSession.kind !== 'conversation' ||
      !freshTargetGroup
    ) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!isBindableSession(freshSession)) {
      return c.json(SESSION_NOT_BINDABLE, 400);
    }
    if (!canModifyGroup(user, { ...freshTargetGroup, jid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
      return c.json(
        {
          error:
            'Native thread containers can only bind to a workspace, not a single session',
        },
        400,
      );
    }
    const bindingPolicyError = conversationBindingPolicyError(
      getConversationKind(imJid, freshImGroup, chatInfo),
      'session',
    );
    if (bindingPolicyError) {
      return c.json({ error: bindingPolicyError }, 400);
    }
    const hasConflict = hasSessionMountConflict(freshImGroup, sessionId);
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const { activationMode, audienceMode } = parseBindingResponsePolicy(
      imJid,
      body,
    );
    if (
      feishuP2pRejectsMentionActivation(
        imJid,
        chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
        activationMode,
      )
    ) {
      return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
    }

    const updated = buildSessionMountUpdate(freshImGroup, sessionId, {
      replyPolicy,
      activationMode,
      audienceMode,
    });
    commitChannelMountUpdate(imJid, updated);
    detachPreviousThreadMapIfLast(imJid, freshImGroup);
    logger.info(
      { imJid, sessionId, userId: user.id },
      'IM group bound to workspace session',
    );
    return c.json({ success: true });
  },
);

// DELETE /api/groups/:jid/sessions/:sessionId/im-binding/:imJid — unbind an IM group from a session
router.delete(
  '/:jid/sessions/:sessionId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const sessionId = c.req.param('sessionId');
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const session = getAgent(sessionId);
    if (
      !session ||
      session.chat_jid !== jid ||
      session.kind !== 'conversation'
    ) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (imGroup.target_agent_id !== sessionId) {
      return c.json({ error: 'IM group is not bound to this session' }, 400);
    }
    const restored = await unbindBinding(user, imJid, imGroup);
    if (restored.status !== 'resolved') {
      return c.json({ error: unbindError(restored) }, 409);
    }
    refreshAgentLastImJid(sessionId);
    logger.info(
      {
        imJid,
        sessionId,
        unbound: true,
        userId: user.id,
      },
      'IM channel unbound',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  },
);

// PUT /api/groups/:jid/agents/:agentId/im-binding — bind an IM group to this workspace session
router.put('/:jid/agents/:agentId/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json({ error: 'Binding target must be a workspace' }, 400);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // IM binding mutates the owner's workspace routing → owner-only, same as
  // agent CRUD (the imGroup-side check below stays Access — you only need
  // access to the IM group you're binding).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== jid) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (!isBindableSession(agent)) {
    return c.json(SESSION_NOT_BINDABLE, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
  // Re-read + re-authorize after the await — see the analogous comment on
  // the PUT /:jid/sessions/:sessionId/im-binding route above.
  const freshImGroup = getRegisteredGroup(imJid);
  if (!freshImGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const freshAgent = getAgent(agentId);
  const freshTargetGroup = getRegisteredGroup(jid);
  if (
    !freshAgent ||
    freshAgent.chat_jid !== jid ||
    freshAgent.kind !== 'conversation' ||
    !freshTargetGroup
  ) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (!isBindableSession(freshAgent)) {
    return c.json(SESSION_NOT_BINDABLE, 400);
  }
  if (!canModifyGroup(user, { ...freshTargetGroup, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  // Compute against freshImGroup, not the pre-await snapshot — see
  // fetchLiveChatInfo's doc comment.
  if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
    return c.json(
      {
        error:
          'Native thread containers can only bind to a workspace, not a single session',
      },
      400,
    );
  }
  const bindingPolicyError = conversationBindingPolicyError(
    getConversationKind(imJid, freshImGroup, chatInfo),
    'session',
  );
  if (bindingPolicyError) {
    return c.json({ error: bindingPolicyError }, 400);
  }
  const force = body.force === true;
  const replyPolicy = 'source_only' as const;
  const hasConflict = hasSessionMountConflict(freshImGroup, agentId);
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  const { activationMode, audienceMode } = parseBindingResponsePolicy(
    imJid,
    body,
  );
  if (
    feishuP2pRejectsMentionActivation(
      imJid,
      chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      activationMode,
    )
  ) {
    return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
  }

  // Update DB + in-memory cache — clear target_main_jid to avoid conflicts
  const updated: RegisteredGroup = buildSessionMountUpdate(
    freshImGroup,
    agentId,
    {
      replyPolicy,
      activationMode,
      audienceMode,
    },
  );
  commitChannelMountUpdate(imJid, updated);
  detachPreviousThreadMapIfLast(imJid, freshImGroup);

  logger.info(
    { imJid, sessionId: agentId, userId: user.id },
    'IM group bound to workspace session',
  );
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/agents/:agentId/im-binding/:imJid — unbind an IM group from this workspace session
router.delete(
  '/:jid/agents/:agentId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const agentId = c.req.param('agentId');
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user');

    const group = getRegisteredGroup(jid);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...group, jid })) {
      return c.json({ error: 'Group not found' }, 404);
    }
    // IM unbinding mutates the owner's workspace routing → owner-only.
    if (!canModifyGroup(user, { ...group, jid })) {
      return c.json(
        { error: 'Only the workspace owner can manage IM bindings' },
        403,
      );
    }

    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.target_agent_id !== agentId) {
      return c.json({ error: 'IM group is not bound to this session' }, 400);
    }

    const restored = await unbindBinding(user, imJid, imGroup);
    if (restored.status !== 'resolved') {
      return c.json({ error: unbindError(restored) }, 409);
    }

    // Clear persisted IM routing so restart won't route to unbound channel (#225)
    refreshAgentLastImJid(agentId);

    logger.info(
      {
        imJid,
        sessionId: agentId,
        unbound: true,
        userId: user.id,
      },
      'IM channel unbound',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  },
);

// PUT /api/groups/:jid/im-binding — bind a native topic group to this workspace:
// each topic gets its own session (thread_map)
router.put('/:jid/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json({ error: 'Binding target must be a workspace' }, 400);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Binding a topic group mutates the owner's workspace routing → owner-only
  // (the imGroup-side check below stays Access).
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
  // Re-read after the await — fetchLiveChatInfo yields the event loop on a
  // live network call, and a concurrent write to this imJid must not be
  // silently overwritten by the pre-await snapshot below.
  const freshImGroup = getRegisteredGroup(imJid);
  if (!freshImGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  // Re-run authorization against the fresh row — the pre-await checks above
  // only proved it against the stale imGroup.
  if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }
  const freshTargetGroup = getRegisteredGroup(jid);
  if (!freshTargetGroup) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...freshTargetGroup, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const bindingPolicyError = conversationBindingPolicyError(
    getConversationKind(imJid, freshImGroup, chatInfo),
    'workspace',
  );
  if (bindingPolicyError) {
    return c.json({ error: bindingPolicyError }, 400);
  }
  const targetWorkspaceJid = jid; // Use actual registered JID (not folder-based)
  const legacyWorkspaceJid = `web:${freshTargetGroup.folder}`;
  const force = body.force === true;
  const replyPolicy = 'source_only' as const;
  const hasConflict = hasWorkspaceMountConflict(
    freshImGroup,
    targetWorkspaceJid,
    legacyWorkspaceJid,
  );
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }
  // Parse activation_mode from request body
  const { activationMode, audienceMode } = parseBindingResponsePolicy(
    imJid,
    body,
  );
  if (
    feishuP2pRejectsMentionActivation(
      imJid,
      chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      activationMode,
    )
  ) {
    return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
  }

  // Parse owner_im_id for owner_mentioned mode
  // 如果前端传了 owner_im_id 就用，否则 owner_mentioned 模式下自动设为空（后续首条消息自动学习）
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Update DB + in-memory cache — clear target_agent_id to avoid conflicts
  const updated: RegisteredGroup = {
    ...buildWorkspaceMountUpdate(
      freshImGroup,
      targetWorkspaceJid,
      'thread_map',
      {
        ...(replyPolicy !== undefined ? { replyPolicy } : {}),
        ...(activationMode !== undefined ? { activationMode } : {}),
        ...(audienceMode !== undefined ? { audienceMode } : {}),
        ...(ownerImId !== undefined ? { ownerImId } : {}),
      },
    ),
    feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
    feishu_group_message_type:
      chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
    ...(ownerImId !== undefined
      ? { owner_claim_source: 'configured' as const }
      : {}),
  };
  commitChannelMountUpdate(imJid, updated);
  detachPreviousThreadMapIfLast(
    imJid,
    freshImGroup,
    targetWorkspaceJid,
    'thread_map',
  );
  markNativeContextWorkspace(jid);

  logger.info(
    { imJid, targetWorkspaceJid, activationMode, userId: user.id },
    'IM topic group bound to workspace',
  );
  return c.json({ success: true });
});

// DELETE /api/groups/:jid/im-binding/:imJid — unbind a topic group from this workspace
router.delete('/:jid/im-binding/:imJid', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user');

  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'Group not found' }, 404);
  }
  // Unbinding mutates the owner's workspace routing → owner-only.
  if (!canModifyGroup(user, { ...group, jid })) {
    return c.json(
      { error: 'Only the workspace owner can manage IM bindings' },
      403,
    );
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const targetWorkspaceJid = jid; // Use actual registered JID (not folder-based)
  const legacyWorkspaceJid = `web:${group.folder}`;
  if (!matchesWorkspaceMount(imGroup, targetWorkspaceJid, legacyWorkspaceJid)) {
    return c.json({ error: 'IM group is not bound to this workspace' }, 400);
  }

  const restored = await unbindBinding(user, imJid, imGroup);
  if (restored.status !== 'resolved') {
    return c.json({ error: unbindError(restored) }, 409);
  }

  logger.info(
    {
      imJid,
      targetWorkspaceJid,
      unbound: true,
      userId: user.id,
    },
    'IM channel unbound',
  );
  return c.json({ success: true, target_main_jid: restored.workspaceJid });
});

export default router;
