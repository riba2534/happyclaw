/**
 * Team mode (团队模式) and multi-task mode (多任务模式): the operations REST
 * and the host runtime share.
 *
 * Validation, the state machine and the side effects (creating and stopping
 * worker sessions, delivering inputs, posting replies) live here, so the Web
 * and the sessions' tools change work items the same way. Callers check
 * workspace access first; these functions check the rest.
 *
 * Lanes: the router session of a group is the Runtime Session recorded on
 * its team mount (source_kind 'team_router'); each work item has a worker
 * session of its own (source_kind 'work_item'). A delegated item (multi-task
 * mode) has no group: its worker reports to the session that delegated it.
 * Inputs into all of them are composed here and moved by work-item-runtime.ts.
 */
import crypto from 'crypto';

import { checkBillingAccessFresh } from './billing.js';
import { KeyedLockPool } from './capability-lock.js';
import { channelConversationJid } from './channel-address.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import {
  getAgent,
  getAgentBuilderInputMessage,
  getChannelMount,
  getMessageChannelTurnContext,
  getRegisteredGroup,
  getUserById,
  getWorkspaceWorkMode,
  listChannelMountsByWorkspace,
} from './db.js';
import { getChannelType } from './im-channel.js';
import { logger } from './logger.js';
import {
  createConversationSession,
  deleteConversationSession,
} from './session-factory.js';
import {
  createSessionWorktree,
  WorktreeUnavailableError,
} from './session-worktree.js';
import { getSessionWorktree } from './session-worktree-store.js';
import {
  candidateInputItem,
  followupInputItem,
  readTeamInput,
  teamTriggerKeys,
  canResumeWorkItem,
  type TeamGateDeps,
  type TeamGateGroup,
  type TeamInboundDecision,
  type TeamInputItem,
} from './team-gate.js';
import type {
  ChannelMount,
  ChannelTurnContext,
  RegisteredGroup,
  SubAgent,
} from './types.js';
import {
  getTeamMount,
  getTeamMountByRouter,
  listAllTeamMounts,
  getWorkDecisionForTrigger,
  getWorkItem,
  getWorkItemByAgent,
  getWorkItemBySource,
  countOpenDelegatedWorkItems,
  countWorkItemsByChannel,
  findSubscribedWorkItems,
  getWorkItemBySeq,
  hasDelegatedWorkItems,
  listOpenDelegatedWorkItems,
  getWorkItemReply,
  hasWorkEvent,
  insertWorkItem,
  insertWorkItemReply,
  isWorkItemReplyMessage,
  listPendingWorkItemReplies,
  getLastWorkReport,
  listWorkDecisions,
  listWorkEvents,
  listWorkItems,
  listWorkItemsByChannel,
  listWorkItemSubscriptions,
  updateWorkItemReply,
  type WorkItemReply,
  recordWorkDecision,
  recordWorkEvent,
  saveTeamMountSettings as storeTeamMountSettings,
  subscribeWorkItem,
  unsubscribeWorkItem,
  updateWorkItem,
  type TeamMount,
  type WorkItemPatch,
} from './work-item-store.js';
import {
  getWorkItemRuntimeHooks,
  injectTeamInput,
  laneJidOf,
  queueTeamReply,
} from './work-item-runtime.js';
import type { TeamMountView, WorkItemDetail } from './work-items.js';
import {
  admitMessage,
  countImWords,
  DELEGATE_CONTEXT_CHAR_LIMIT,
  DELEGATE_FILES_LIMIT,
  DELEGATE_FOLLOWUP_CHAR_LIMIT,
  DELEGATE_TASK_CHAR_LIMIT,
  DELEGATED_OPEN_PER_SESSION,
  DELEGATED_OPEN_PER_WORKSPACE,
  DELEGATED_REPORT_STATES,
  deriveWorkStage,
  imTextLimitError,
  parseTeamSettings,
  subscriptionKey,
  TEAM_RULE_LIMIT,
  TEAM_RULE_TEXT_LIMIT,
  TEAM_LANE_POLICY,
  teamLaneWithholdsTool,
  WORK_IPC_TYPES,
  WORK_NOTE_WORD_LIMIT,
  WORK_REPORT_STATES,
  WORK_SUMMARY_CHAR_LIMIT,
  WORK_TITLE_CHAR_LIMIT,
  isWorkItemWritable,
  type DelegatedWorkSummary,
  type TeamRole,
  type TeamSettings,
  type WorkDecision,
  type WorkDecisionKind,
  type WorkDelegateResult,
  type WorkItem,
  type WorkItemStatus,
  type WorkIpcType,
  type WorkItemView,
  type WorkMandate,
  type WorkReportState,
  type WorkRouteItem,
  type WorkRouteResultItem,
} from './work-items.js';

export interface WorkItemActor {
  userId: string;
  isAdmin: boolean;
}

/** Thrown for a refused request; REST maps `status` to the HTTP status. */
export class WorkItemError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'WorkItemError';
  }
}

export type { TeamMountView, WorkItemDetail } from './work-items.js';

const REASON_CHAR_LIMIT = 500;

// ── Team groups ────────────────────────────────────────────────────────

/** Why a group mount cannot run team mode, or null when it can. */
export function teamMountIneligibility(
  channelJid: string,
  workspaceJid: string,
  mount: ChannelMount | undefined = getChannelMount(channelJid),
): string | null {
  if (!mount || mount.workspace_jid !== workspaceJid) {
    return '这个群没有绑定到当前工作区';
  }
  if (getChannelType(channelJid) !== 'feishu') {
    return '团队模式目前只支持飞书群';
  }
  const chat = getRegisteredGroup(channelJid);
  if (resolveChannelConversationKind(channelJid, chat ?? {}) !== 'group') {
    return '团队模式只支持飞书普通群（不支持私聊和话题群）';
  }
  if (mount.routing_mode !== 'single_session' || !mount.session_id) {
    return '群需要绑定到工作区的会话';
  }
  return null;
}

/** A group with team mode on and routable, as the gate and the tools use it. */
export interface TeamGroupContext extends TeamGateGroup {
  team: TeamMount;
  mount: ChannelMount;
  chat: RegisteredGroup;
  workspace: RegisteredGroup;
}

/**
 * The group's team context, or null when team mode is off or the mount no
 * longer qualifies (then nothing about the group changes). A missing router
 * session reads as `routerAgentId: ''`: the group is in team mode but cannot
 * take requests until the settings are saved again.
 */
export function resolveTeamGroup(channelJid: string): TeamGroupContext | null {
  const team = getTeamMount(channelJid);
  if (!team?.settings.enabled) return null;
  const mount = getChannelMount(channelJid);
  if (teamMountIneligibility(channelJid, team.workspaceJid, mount)) return null;
  const chat = getRegisteredGroup(channelJid);
  const workspace = getRegisteredGroup(team.workspaceJid);
  if (!chat || !workspace || !mount) return null;
  const router = team.routerAgentId ? getAgent(team.routerAgentId) : undefined;
  const routerAgentId =
    router?.kind === 'conversation' && router.chat_jid === team.workspaceJid
      ? router.id
      : '';
  return {
    channelJid,
    workspaceJid: team.workspaceJid,
    settings: team.settings,
    routerAgentId,
    team,
    mount,
    chat,
    workspace,
  };
}

function ownerImIdOf(context: TeamGroupContext): string | null {
  return context.chat.owner_im_id || context.mount.owner_im_id || null;
}

/** The workspace owner or a sender on the group allowlist (/allow). */
export function isTeamListed(
  context: TeamGroupContext,
  senderImId: string | undefined,
): boolean {
  if (!senderImId) return false;
  return (
    senderImId === ownerImIdOf(context) ||
    (context.chat.sender_allowlist ?? []).includes(senderImId)
  );
}

/**
 * One of the bot's own messages in the group: a team reply the host posted
 * (the router's or a worker's acknowledgement), or a bot message stored in
 * the router lane.
 */
export function isTeamBotMessage(
  context: TeamGroupContext,
  messageId: string,
): boolean {
  if (isWorkItemReplyMessage(context.channelJid, messageId)) return true;
  if (!context.routerAgentId) return false;
  const row = getAgentBuilderInputMessage(
    laneJidOf(context.workspaceJid, context.routerAgentId),
    messageId,
  );
  return row?.is_from_me === 1;
}

/** Gate lookups for one team-mode group. */
export function teamGateDeps(context: TeamGroupContext): TeamGateDeps {
  return {
    findSubscribedItems: (channelJid, keys) =>
      findSubscribedWorkItems(channelJid, keys, context.workspaceJid),
    isListed: (sender) => isTeamListed(context, sender),
    isOwnBotMessage: (id) => isTeamBotMessage(context, id),
    hasWorker: hasWorkerSession,
    wasHandedBack: (itemId, messageId) =>
      hasWorkEvent(itemId, 'handback', messageId),
  };
}

export function hasWorkerSession(item: WorkItem): boolean {
  return !!liveSession(item.workspaceJid, item.agentId);
}

/** A conversation session of the workspace, while it exists. */
function liveSession(
  workspaceJid: string,
  agentId: string,
): SubAgent | undefined {
  const agent = getAgent(agentId);
  return agent?.kind === 'conversation' && agent.chat_jid === workspaceJid
    ? agent
    : undefined;
}

/**
 * The role a Runtime Session plays in team mode, or null for none, from the
 * agent row the caller already holds: any other session stops at its
 * source_kind, without a lookup.
 */
export function teamLaneOf(
  agent: Pick<SubAgent, 'id' | 'source_kind'> | undefined,
): TeamRole | null {
  if (agent?.source_kind === 'team_router') {
    return getTeamMountByRouter(agent.id) ? { role: 'router' } : null;
  }
  if (agent?.source_kind === 'work_item') {
    const item = getWorkItemByAgent(agent.id);
    if (!item) return null;
    return {
      role: 'worker',
      workItemId: item.id,
      writable: isWorkItemWritable(item),
      // A delegated worker reports to the session that delegated it.
      ...(item.origin === 'delegated' ? { origin: 'delegated' as const } : {}),
    };
  }
  return null;
}

/** {@link teamLaneOf} for a session known by id. */
export function resolveTeamRole(
  agentId: string | null | undefined,
): TeamRole | null {
  return agentId ? teamLaneOf(getAgent(agentId)) : null;
}

// ── Views and broadcast ────────────────────────────────────────────────

function toView(item: WorkItem): WorkItemView {
  return {
    ...item,
    stage: deriveWorkStage(item),
    workspaceName: getRegisteredGroup(item.workspaceJid)?.name ?? '',
    // A delegated item's channel is its delegating session's lane, no chat.
    channelName:
      item.origin === 'team'
        ? (getRegisteredGroup(item.channelJid)?.name ?? null)
        : null,
    originSessionName: originSessionOf(item)?.name ?? null,
  };
}

function broadcast(item: WorkItem): WorkItemView {
  const view = toView(item);
  try {
    getWorkItemRuntimeHooks().broadcastWorkItemEvent({
      type: 'work_item_updated',
      workspaceJid: item.workspaceJid,
      item: view,
    });
  } catch (error) {
    logger.warn(
      { err: error, workItemId: item.id },
      'Work item broadcast failed',
    );
  }
  return view;
}

function now(): string {
  return new Date().toISOString();
}

function patchItem(item: WorkItem, patch: WorkItemPatch): WorkItem {
  return updateWorkItem(item.id, patch, now()) ?? item;
}

function endItem(
  item: WorkItem,
  outcome: 'completed' | 'dropped' | 'failed' | 'stopped',
  extra: WorkItemPatch = {},
): WorkItem {
  const at = now();
  return (
    updateWorkItem(
      item.id,
      { ...extra, status: 'ended', outcome, endedAt: at },
      at,
    ) ?? item
  );
}

/** Reopen an ended item for the message that resumed it. */
function resumeItem(item: WorkItem, triggerMessageId: string): WorkItem {
  const resumed = patchItem(item, {
    status: 'open',
    outcome: null,
    endedAt: null,
  });
  // The outcome it had, so a hand-back of this message can restore it.
  recordWorkEvent({
    workItemId: item.id,
    kind: 'resume',
    state: item.outcome,
    triggerMessageId,
    now: now(),
  });
  return resumed;
}

/**
 * Note that a group message reached an item (work_ack, work_handback check
 * it). Once per message: a replay records nothing. Returns whether it was new.
 */
function noteDelivery(
  item: WorkItem,
  triggerMessageId: string,
  text?: string,
): boolean {
  if (hasWorkEvent(item.id, 'input', triggerMessageId)) return false;
  recordWorkEvent({
    workItemId: item.id,
    kind: 'input',
    text,
    triggerMessageId,
    now: now(),
  });
  return true;
}

/** A group message for an item it was not routed to: a `<work_followup>` copy. */
function deliverFollowupCopy(
  item: WorkItem,
  message: {
    id: string;
    content: string;
    senderName?: string;
    sourceJid?: string | null;
    senderImId?: string;
    senderIsBot?: boolean;
    threadId?: string;
    listed: boolean;
    addressed: boolean;
    /** The original's provider context: quotes and forwards read the same. */
    channelContext?: ChannelTurnContext | null;
  },
): void {
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: followupCopyId(message.id, item.id),
    content: message.content,
    senderName: message.senderName || undefined,
    sourceJid: message.sourceJid ?? item.channelJid,
    channelContext: message.channelContext,
    item: followupInputItem({
      item,
      triggerMessageId: message.id,
      listed: message.listed,
      addressed: message.addressed,
      senderImId: message.senderImId,
      senderIsBot: message.senderIsBot,
      threadId: message.threadId,
    }),
  });
}

// ── REST ───────────────────────────────────────────────────────────────

/** The workspace's group mounts and their team settings. */
export function listTeamMountViews(workspaceJid: string): TeamMountView[] {
  return listChannelMountsByWorkspace(workspaceJid)
    .filter((mount) => getChannelType(mount.channel_jid) === 'feishu')
    .map((mount) => {
      const team = getTeamMount(mount.channel_jid);
      const ineligibleReason = teamMountIneligibility(
        mount.channel_jid,
        workspaceJid,
        mount,
      );
      const current = team?.workspaceJid === workspaceJid ? team : undefined;
      return {
        channelJid: mount.channel_jid,
        channelName: getRegisteredGroup(mount.channel_jid)?.name ?? null,
        eligible: ineligibleReason === null,
        ineligibleReason,
        settings: current?.settings ?? parseTeamSettings(null),
        routerAgentId: current?.routerAgentId ?? null,
      };
    });
}

function normalizeSettings(
  settings: Omit<TeamSettings, 'version'>,
  version: number,
): TeamSettings {
  if (!settings || typeof settings !== 'object') {
    throw new WorkItemError('团队设置格式不正确');
  }
  const rules = Array.isArray(settings.rules) ? settings.rules : [];
  if (rules.length > TEAM_RULE_LIMIT) {
    throw new WorkItemError(`规则最多 ${TEAM_RULE_LIMIT} 条`);
  }
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.name !== 'string' ||
      typeof rule.instruction !== 'string' ||
      !rule.name.trim() ||
      !rule.instruction.trim()
    ) {
      throw new WorkItemError('每条规则都需要名称和说明');
    }
    if (
      rule.name.length > TEAM_RULE_TEXT_LIMIT ||
      rule.instruction.length > TEAM_RULE_TEXT_LIMIT
    ) {
      throw new WorkItemError(`规则文字不能超过 ${TEAM_RULE_TEXT_LIMIT} 字`);
    }
  }
  return parseTeamSettings(
    JSON.stringify({
      ...settings,
      rules: rules.map((rule) => ({
        id:
          typeof rule.id === 'string' && rule.id.trim()
            ? rule.id.trim()
            : crypto.randomUUID().slice(0, 8),
        name: rule.name.trim(),
        instruction: rule.instruction.trim(),
        enabled: rule.enabled !== false,
      })),
      version,
    }),
  );
}

/**
 * Save a mount's team settings. Bumps the version, creates the router
 * session on first enable, and stops routing through it when disabled.
 * Refuses a mount that is not an eligible Feishu group of this workspace.
 */
export async function saveTeamMountSettings(
  workspaceJid: string,
  channelJid: string,
  settings: Omit<TeamSettings, 'version'>,
  actor: WorkItemActor,
): Promise<TeamMount> {
  const workspace = getRegisteredGroup(workspaceJid);
  if (!workspace) throw new WorkItemError('工作区不存在', 404);
  const mount = getChannelMount(channelJid);
  if (!mount || mount.workspace_jid !== workspaceJid) {
    throw new WorkItemError('这个群没有绑定到当前工作区', 404);
  }
  const existing = getTeamMount(channelJid);
  const current =
    existing?.workspaceJid === workspaceJid ? existing : undefined;
  const next = normalizeSettings(
    settings,
    (current?.settings.version ?? 0) + 1,
  );
  if (next.enabled) {
    const reason = teamMountIneligibility(channelJid, workspaceJid, mount);
    if (reason) throw new WorkItemError(reason);
  }
  let routerAgentId = current?.routerAgentId ?? null;
  const router = routerAgentId ? getAgent(routerAgentId) : undefined;
  if (!router || router.chat_jid !== workspaceJid) routerAgentId = null;
  const newRouter = next.enabled && !routerAgentId;
  if (newRouter) {
    const chatName = getRegisteredGroup(channelJid)?.name || '飞书群';
    const session = await createConversationSession({
      workspaceJid,
      group: workspace,
      createdBy: workspace.created_by ?? actor.userId,
      name: `团队路由 · ${chatName}`,
      sourceKind: 'team_router',
    });
    routerAgentId = session.id;
  }
  const saved = storeTeamMountSettings({
    channelJid,
    workspaceJid,
    settings: next,
    routerAgentId,
    updatedBy: actor.userId,
    now: now(),
  });
  if (!next.enabled) stopGroupWorkItems(channelJid, 'team_mode_off');
  if (newRouter && routerAgentId) {
    redeliverReportsToRouter(channelJid, workspaceJid, routerAgentId);
  }
  logger.info(
    {
      channelJid,
      workspaceJid,
      enabled: next.enabled,
      version: next.version,
      routerAgentId,
    },
    'Team mode settings saved',
  );
  return saved;
}

/**
 * End every open item of a group that no longer runs team mode here (team
 * mode turned off, the group rebound to another workspace or session).
 * Nothing can route to them any more.
 */
export function stopGroupWorkItems(channelJid: string, reason: string): void {
  for (const item of listWorkItemsByChannel(channelJid, {
    status: 'open',
    limit: 500,
  })) {
    broadcast(stopItem(item, reason));
  }
  // Nothing the group was still owed goes out any more.
  for (const reply of listPendingWorkItemReplies(channelJid)) {
    voidReply(reply, reason);
  }
}

/**
 * Whether a chat may run team mode at all: a Feishu chat with a team mount
 * row. One indexed lookup; every other chat stops here.
 */
export function mayRunTeamMode(channelJid: string): boolean {
  return (
    channelJid.startsWith('feishu:') &&
    getTeamMount(channelJid)?.settings.enabled === true
  );
}

/**
 * Whether a lane chosen for a message of `channelJid` is still where it
 * goes: team mode on, a router lane still the group's router, a worker lane
 * still a live, not stopped item of the group. `reject` holds while team
 * mode is on.
 */
export function teamRouteStillHolds(
  channelJid: string,
  route: { effectiveJid: string; agentId: string } | 'reject',
): boolean {
  if (!mayRunTeamMode(channelJid)) return false;
  if (route === 'reject') return true;
  const context = resolveTeamGroup(channelJid);
  if (!context) return false;
  if (route.agentId === context.routerAgentId) return true;
  const item = getWorkItemByAgent(route.agentId);
  return (
    !!item &&
    item.channelJid === channelJid &&
    item.workspaceJid === context.workspaceJid &&
    item.outcome !== 'stopped' &&
    hasWorkerSession(item)
  );
}

/** Reconcile every team-mode group once (startup). */
export function reconcileAllTeamGroups(): void {
  for (const team of listAllTeamMounts()) {
    if (team.settings.enabled) reconcileTeamGroup(team.channelJid);
  }
}

/**
 * A group with team mode on that no longer qualifies (rebound to another
 * workspace or session, or no longer an ordinary group) stops its items once.
 */
export function reconcileTeamGroup(channelJid: string): void {
  const team = getTeamMount(channelJid);
  if (!team?.settings.enabled) return;
  if (!teamMountIneligibility(channelJid, team.workspaceJid)) return;
  // Chat metadata not known (yet): routing pauses, nothing is stopped.
  const chat = getRegisteredGroup(channelJid);
  if (resolveChannelConversationKind(channelJid, chat ?? {}) === 'unknown') {
    return;
  }
  if (countWorkItemsByChannel(channelJid, 'open') === 0) return;
  stopGroupWorkItems(channelJid, 'group_rebound');
}

/** Report states the router acts on; `progress` only updates the item. */
function forwardsReport(state: string, humanAction: string | null): boolean {
  return (state !== 'progress' || !!humanAction) && state !== 'dropped';
}

function reportInputId(itemId: string, eventId: number | null): string {
  return `work-report-${itemId}-${eventId}`;
}

function injectReport(
  item: WorkItem,
  routerAgentId: string,
  report: { eventId: number | null; state: string; summary: string },
): void {
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: routerAgentId,
    messageId: reportInputId(item.id, report.eventId),
    content: report.summary,
    item: {
      tag: 'work_report',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['state', report.state],
        ['attention', item.attention ?? ''],
      ],
      facts: { workItemId: item.id },
    },
  });
}

/**
 * A new router session gets the last report of each open item of its group
 * that a router would act on, so nothing reported while there was none (or
 * to the one before) is lost.
 */
function redeliverReportsToRouter(
  channelJid: string,
  workspaceJid: string,
  routerAgentId: string,
): void {
  for (const item of listWorkItemsByChannel(channelJid, {
    status: 'open',
    limit: 500,
  })) {
    if (item.workspaceJid !== workspaceJid) continue;
    const last = listWorkEvents(item.id, 200)
      .filter(
        (event) =>
          event.kind === 'report' &&
          event.state !== 'undelivered' &&
          forwardsReport(event.state ?? '', item.attention),
      )
      .at(-1);
    if (!last) continue;
    injectReport(item, routerAgentId, {
      eventId: last.id,
      state: last.state ?? '',
      summary: last.text,
    });
  }
}

export function listWorkItemViews(
  workspaceJid: string,
  options?: { status?: WorkItemStatus; limit?: number },
): WorkItemView[] {
  return listWorkItems(workspaceJid, options).map(toView);
}

export function getWorkItemDetail(id: string): WorkItemDetail | undefined {
  const item = getWorkItem(id);
  if (!item) return undefined;
  return {
    item: toView(item),
    events: listWorkEvents(id),
    subscriptions: listWorkItemSubscriptions(id),
  };
}

function requireItem(id: string): WorkItem {
  const item = getWorkItem(id);
  if (!item) throw new WorkItemError('工作项不存在', 404);
  return item;
}

function stopItem(item: WorkItem, by: string, stopLane = true): WorkItem {
  const { stopped } = endStopped(item, by);
  if (stopLane) stopWorkerLane(item);
  return stopped;
}

/** The rows of a stop: the item ends stopped, and its `stop` event. */
function endStopped(
  item: WorkItem,
  by: string,
): { stopped: WorkItem; eventId: number | null } {
  const stopped = endItem(item, 'stopped', { attention: null });
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'stop',
    text: by,
    now: now(),
  });
  return { stopped, eventId };
}

/**
 * The worker stops like `/break`: its current turn and every input it has
 * not run yet.
 */
function stopWorkerLane(item: WorkItem): void {
  getWorkItemRuntimeHooks().stopLane(
    laneJidOf(item.workspaceJid, item.agentId),
  );
}

/** End an item as stopped by a person; interrupts its worker. */
export function stopWorkItem(id: string, _actor?: WorkItemActor): WorkItemView {
  const item = requireItem(id);
  if (item.status === 'ended') {
    if (item.outcome === 'stopped') return toView(item);
    throw new WorkItemError('工作项已经结束', 409);
  }
  if (item.origin === 'delegated') return stopDelegatedItem(item, 'web')();
  return broadcast(stopItem(item, 'web'));
}

/** Allow edits on an item that started read-only, and tell its worker. */
export function approveWorkItem(
  id: string,
  _actor?: WorkItemActor,
): WorkItemView {
  const item = requireItem(id);
  if (item.status === 'ended') throw new WorkItemError('工作项已经结束', 409);
  if (isWorkItemWritable(item)) {
    throw new WorkItemError('工作项已经可以修改', 409);
  }
  const approved = patchItem(item, { approvedAt: now() });
  recordWorkEvent({ workItemId: item.id, kind: 'approve', now: now() });
  // The worker's role changes with this (writable): its warm runner, started
  // without the edit tools, finishes its turn and the approval starts a
  // fresh one with them restored.
  getWorkItemRuntimeHooks().drainLane(
    laneJidOf(item.workspaceJid, item.agentId),
  );
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: `work-approved-${item.id}`,
    content: '',
    item: { tag: 'work_approved', attrs: [['item', `#${item.seq}`]] },
  });
  return broadcast(approved);
}

export function listWorkDecisionsForWorkspace(
  workspaceJid: string,
  options?: { kind?: WorkDecisionKind; limit?: number },
): WorkDecision[] {
  return listWorkDecisions(workspaceJid, options);
}

// ── Inbound: what a stored group message does ──────────────────────────

/**
 * The header a routed group message is stored with, so its lane reads it as
 * a candidate or a follow-up. Null for ignored messages.
 */
export function teamInputItemFor(
  decision: TeamInboundDecision,
  message: {
    messageId: string;
    threadId?: string;
    senderImId?: string;
    senderIsBot?: boolean;
    mentionedBot: boolean;
  },
  settings: TeamSettings,
): TeamInputItem | null {
  if (decision.kind === 'ignore') return null;
  if (decision.kind === 'subscribed') {
    const [primary, ...copies] = decision.items;
    return followupInputItem({
      item: primary,
      triggerMessageId: message.messageId,
      listed: decision.listed,
      addressed: decision.addressed,
      senderImId: message.senderImId,
      senderIsBot: message.senderIsBot,
      threadId: message.threadId,
      copyItemIds: copies.map((item) => item.id),
    });
  }
  return candidateInputItem({
    triggerMessageId: message.messageId,
    strength: decision.strength,
    listed: decision.listed,
    addressed: decision.addressed,
    settings,
    threadItems: decision.threadItems,
    senderImId: message.senderImId,
    senderIsBot: message.senderIsBot,
    threadId: message.threadId,
  });
}

/** The id of the copy of group message `messageId` for a further item. */
export function followupCopyId(messageId: string, workItemId: string): string {
  return `${messageId}:wi:${workItemId}`;
}

/**
 * A group message was stored in a team lane. A follow-up (its stored header
 * names the items it reaches) resumes the ended items it reaches, gives each
 * further item its copy and notes the delivery on every item (work_ack and
 * work_handback check it). Derived from the stored row alone, so it does not
 * depend on the gate's in-memory decision, and idempotent: a replay of the
 * same message records, resumes, copies and broadcasts nothing again.
 */
export function onTeamMessageStored(laneJid: string, messageId: string): void {
  const row = getAgentBuilderInputMessage(laneJid, messageId);
  const header = row ? readTeamInput(row.attachments) : null;
  if (!row || header?.tag !== 'work_followup') return;
  if (row.source_kind === 'work_item_input') return;
  const facts = header.facts ?? {};
  const ids = [facts.workItemId, ...(facts.copyItemIds ?? [])].filter(
    (id): id is string => !!id,
  );
  const context = resolveTeamGroup(
    row.source_jid ? channelConversationJid(row.source_jid) : '',
  );
  const isListed = (sender: string | undefined) =>
    !!context && isTeamListed(context, sender);
  const channelContext =
    ids.length > 1 ? getMessageChannelTurnContext(laneJid, messageId) : null;
  for (const [index, id] of ids.entries()) {
    let item = getWorkItem(id);
    if (!item) continue;
    let changed = false;
    if (item.status === 'ended') {
      if (facts.senderIsBot || !canResumeWorkItem(item, isListed)) continue;
      item = resumeItem(item, messageId);
      changed = true;
    }
    if (noteDelivery(item, messageId)) changed = true;
    if (index > 0) {
      deliverFollowupCopy(item, {
        id: messageId,
        content: row.content,
        senderName: row.sender_name ?? undefined,
        sourceJid: row.source_jid,
        senderImId: facts.senderImId,
        senderIsBot: facts.senderIsBot,
        threadId: facts.threadId,
        listed: facts.listed === true,
        addressed: facts.addressed === true,
        channelContext,
      });
    }
    if (changed) broadcast(item);
  }
}

/**
 * The ids of the copies a stored group message was given: the further items
 * of a subscribed message, or the item a router attached a candidate to.
 * Recalling the message withdraws them with it.
 */
export function followupCopyIdsOf(
  channelJid: string,
  messageId: string,
  attachmentsJson: string | null | undefined,
): string[] {
  const item = readTeamInput(attachmentsJson);
  if (!item) return [];
  const ids = [...(item.facts?.copyItemIds ?? [])];
  if (item.tag === 'team_candidate') {
    const decision = getWorkDecisionForTrigger(channelJid, messageId);
    if (decision?.kind === 'attach' && decision.workItemId) {
      ids.push(decision.workItemId);
    }
  }
  return [
    ...ids.map((id) => followupCopyId(messageId, id)),
    // A follow-up a worker handed back waits in the router lane as well.
    ...(item.tag === 'work_followup' ? [handbackInputId(messageId)] : []),
  ];
}

// ── IPC: router and worker tools ───────────────────────────────────────

/** A request type the team tools use. */
export function isWorkIpcType(type: unknown): type is WorkIpcType {
  return (WORK_IPC_TYPES as readonly unknown[]).includes(type);
}

/** Host-derived identity of the session that called a work tool. */
export interface WorkIpcCaller {
  folder: string;
  agentId: string | null;
  /**
   * Delegation tools: the calling turn when the workspace owner started it
   * (the install_skill rule), else null. Read from the host's turn registry;
   * `inputTurnId` (the Runner's) names which delivered batch the turn is, and
   * `input` is that batch's last input (null when no batch is named).
   */
  ownerTurn?: (inputTurnId: string | null) => OwnerTurn | null;
}

/** The workspace owner's own turn, as the host judged it. */
export interface OwnerTurn {
  input: DelegationOriginInput | null;
}

/** The stored input a delegating turn was answering. */
export interface DelegationOriginInput {
  chatJid: string;
  messageId: string;
}

export type WorkIpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

class WorkIpcError extends Error {}

function fail(message: string): never {
  throw new WorkIpcError(message);
}

interface RouterLane {
  context: TeamGroupContext;
  laneJid: string;
}

function requireRouter(caller: WorkIpcCaller): RouterLane {
  const agent = caller.agentId ? getAgent(caller.agentId) : undefined;
  const team =
    agent?.source_kind === 'team_router'
      ? getTeamMountByRouter(agent.id)
      : undefined;
  if (!agent || !team || agent.group_folder !== caller.folder) {
    fail('Only a team router session can use this tool.');
  }
  const context = resolveTeamGroup(team.channelJid);
  if (
    !context ||
    context.routerAgentId !== agent.id ||
    agent.chat_jid !== context.workspaceJid
  ) {
    reconcileTeamGroup(team.channelJid);
    fail('Team mode is off for this group.');
  }
  return { context, laneJid: laneJidOf(context.workspaceJid, agent.id) };
}

function requireWorker(caller: WorkIpcCaller): WorkItem {
  const agent = caller.agentId ? getAgent(caller.agentId) : undefined;
  const item =
    agent?.source_kind === 'work_item'
      ? getWorkItemByAgent(agent.id)
      : undefined;
  if (!agent || !item || agent.group_folder !== caller.folder) {
    fail('Only a work item session can use this tool.');
  }
  // A delegated item has no group: it reports to its delegating session.
  if (item.origin === 'delegated') return item;
  // The group must still run team mode, mounted on the item's workspace.
  const context = resolveTeamGroup(item.channelJid);
  if (!context || context.workspaceJid !== item.workspaceJid) {
    reconcileTeamGroup(item.channelJid);
    fail('Team mode is off for this group.');
  }
  return item;
}

/** A worker tool that speaks in a group (work_ack, work_handback). */
function requireTeamWorker(caller: WorkIpcCaller): WorkItem {
  const item = requireWorker(caller);
  if (item.origin !== 'team') {
    fail('Only a team work item session can use this tool.');
  }
  return item;
}

function requireOpen(item: WorkItem): void {
  if (item.status !== 'open') fail('This work item has ended.');
}

function requireImText(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail(`${what} is required.`);
  const refusal = imTextLimitError(text);
  if (refusal) fail(`${what}: ${refusal}`);
  return text;
}

function optionalText(value: unknown, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('Expected a string.');
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

/** A message the router received as a candidate, original or handed back. */
interface Candidate {
  messageId: string;
  /** The row's id in the router lane (the message id, or a hand-back's). */
  rowId: string;
  content: string;
  senderName: string;
  sourceJid: string | null;
  item: TeamInputItem;
}

function handbackInputId(triggerMessageId: string): string {
  return `handback:${triggerMessageId}`;
}

function loadCandidate(
  router: RouterLane,
  triggerMessageId: unknown,
): Candidate {
  if (typeof triggerMessageId !== 'string' || !triggerMessageId) {
    fail('triggerMessageId is required.');
  }
  for (const id of [triggerMessageId, handbackInputId(triggerMessageId)]) {
    const row = getAgentBuilderInputMessage(router.laneJid, id);
    const item = row ? readTeamInput(row.attachments) : null;
    if (row && item?.tag === 'team_candidate') {
      return {
        messageId: triggerMessageId,
        rowId: id,
        content: row.content,
        senderName: row.sender_name ?? '',
        sourceJid: row.source_jid,
        item,
      };
    }
  }
  fail(`${triggerMessageId} is not a candidate this router received.`);
}

function requireGroupItem(router: RouterLane, workItemId: unknown): WorkItem {
  const item =
    typeof workItemId === 'string' ? getWorkItem(workItemId) : undefined;
  if (!item || item.channelJid !== router.context.channelJid) {
    fail('workItemId is not a work item of this group.');
  }
  return item;
}

function decide(
  router: RouterLane,
  candidate: Candidate,
  kind: WorkDecisionKind,
  input: { workItemId?: string | null; reason?: string; ruleIds?: string[] },
): void {
  recordWorkDecision({
    id: crypto.randomUUID(),
    workspaceJid: router.context.workspaceJid,
    channelJid: router.context.channelJid,
    triggerMessageId: candidate.messageId,
    strength: candidate.item.facts?.strength ?? 'explicit',
    kind,
    workItemId: input.workItemId ?? null,
    reason: input.reason ?? '',
    matchedRuleIds: input.ruleIds ?? [],
    createdAt: now(),
  });
}

function refuseDecided(router: RouterLane, candidate: Candidate): void {
  const previous = getWorkDecisionForTrigger(
    router.context.channelJid,
    candidate.messageId,
  );
  if (previous) {
    fail(`This candidate was already decided (${previous.kind}).`);
  }
}

// ── Replies in the group ───────────────────────────────────────────────

/** How long a re-send is safe: Feishu dedupes a reply's uuid for an hour. */
const REPLY_RESEND_WINDOW_MS = 55 * 60_000;
const REPLY_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

const PURPOSE_LABEL: Record<string, string> = {
  ack: '确认',
  result: '结果',
  attention: '问题',
  answer: '回答',
};

/**
 * Record a reply the group is owed and send it. The record is durable
 * before this returns, so the caller may answer `queued` or record its ack:
 * a restart sends it still (resumePendingTeamReplies). The id is the reply's
 * identity; asking for the same reply again changes nothing.
 */
function requestReply(input: {
  id: string;
  workspaceJid: string;
  workItem: WorkItem | null;
  channelJid: string;
  quoteMessageId: string;
  text: string;
  purpose: string;
  laneJid: string;
}): WorkItemReply {
  const reply = insertWorkItemReply({
    id: input.id,
    workspaceJid: input.workspaceJid,
    workItemId: input.workItem?.id ?? null,
    channelJid: input.channelJid,
    quoteMessageId: input.quoteMessageId,
    text: input.text,
    purpose: input.purpose,
    laneJid: input.laneJid,
    now: now(),
  });
  if (reply.status === 'pending') scheduleReply(reply.id, 0);
  return reply;
}

const replyTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; dueAt: number }
>();
const repliesInFlight = new Set<string>();

function scheduleReply(id: string, delayMs: number): void {
  if (replyTimers.has(id) || repliesInFlight.has(id)) return;
  const timer = setTimeout(() => {
    replyTimers.delete(id);
    void sendReply(id);
  }, delayMs);
  timer.unref?.();
  replyTimers.set(id, { timer, dueAt: Date.now() + delayMs });
}

function cancelReplyTimer(id: string): void {
  const waiting = replyTimers.get(id);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  replyTimers.delete(id);
}

/** Send every reply still owed, after a restart. Ids only are logged. */
export function resumePendingTeamReplies(): void {
  const pending = listPendingWorkItemReplies();
  for (const reply of pending) {
    cancelReplyTimer(reply.id);
    scheduleReply(reply.id, 0);
  }
  if (pending.length > 0) {
    logger.info(
      { replyIds: pending.map((reply) => reply.id) },
      'Resuming team replies owed to groups',
    );
  }
}

/**
 * Test seam: send the replies that are due now and wait for them; a reply
 * waiting out a retry delay stays pending.
 */
export async function settleTeamReplies(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    for (const [id, waiting] of replyTimers) {
      if (waiting.dueAt > Date.now()) continue;
      cancelReplyTimer(id);
      void sendReply(id);
    }
    await new Promise((resolve) => setImmediate(resolve));
    const due = [...replyTimers.values()].some(
      (waiting) => waiting.dueAt <= Date.now(),
    );
    if (!due && repliesInFlight.size === 0) return;
  }
}

async function sendReply(id: string): Promise<void> {
  const reply = getWorkItemReply(id);
  if (!reply || reply.status !== 'pending' || repliesInFlight.has(id)) return;
  // An earlier attempt may have reached the group; past Feishu's dedupe
  // window a re-send could post the reply twice, so it is settled instead.
  if (
    reply.attempt > 0 &&
    Date.now() - Date.parse(reply.createdAt) > REPLY_RESEND_WINDOW_MS
  ) {
    settleReplyFailed(reply, '投递结果无法确认，已停止重发');
    return;
  }
  // Team mode turned off or the group moved: the reply is void.
  const context = resolveTeamGroup(reply.channelJid);
  if (!context || context.workspaceJid !== reply.workspaceJid) {
    voidReply(reply, 'team_mode_off');
    return;
  }
  repliesInFlight.add(id);
  const attempt = reply.attempt + 1;
  updateWorkItemReply(id, { attempt }, now());
  try {
    const outcome = await queueTeamReply({
      channelJid: reply.channelJid,
      quoteMessageId: reply.quoteMessageId,
      text: reply.text,
      deliveryKey: reply.id,
      attempt,
    });
    if (outcome.ok) {
      await settleReplyDelivered(reply, outcome.providerMessageId);
    } else if (outcome.retryable && attempt <= REPLY_RETRY_DELAYS_MS.length) {
      logger.warn(
        { replyId: id, workItemId: reply.workItemId, attempt },
        'Team reply not delivered yet; retrying',
      );
      repliesInFlight.delete(id);
      scheduleReply(id, REPLY_RETRY_DELAYS_MS[attempt - 1]);
    } else {
      settleReplyFailed(reply, outcome.error);
    }
  } finally {
    repliesInFlight.delete(id);
  }
}

/** A reply that must not go out any more; no question for anyone. */
function voidReply(reply: WorkItemReply, reason: string): void {
  cancelReplyTimer(reply.id);
  updateWorkItemReply(reply.id, { status: 'failed', error: reason }, now());
  logger.info(
    { replyId: reply.id, workItemId: reply.workItemId, reason },
    'Team reply voided',
  );
}

/**
 * The reply is in the group: subscribe its message for the item (a reply to
 * it reaches the item) and store it in the lane that said it.
 */
async function settleReplyDelivered(
  reply: WorkItemReply,
  providerMessageId: string | null,
): Promise<void> {
  updateWorkItemReply(
    reply.id,
    { status: 'delivered', providerMessageId, error: null },
    now(),
  );
  const item = reply.workItemId ? getWorkItem(reply.workItemId) : undefined;
  if (item && providerMessageId) {
    subscribeWorkItem(
      item.id,
      item.channelJid,
      subscriptionKey('msg', providerMessageId),
      now(),
    );
  }
  if (item && reply.purpose !== 'ack') {
    recordWorkEvent({
      workItemId: item.id,
      kind: 'reply',
      state: reply.purpose,
      text: reply.text,
      triggerMessageId: reply.quoteMessageId,
      now: now(),
    });
  }
  try {
    await getWorkItemRuntimeHooks().postLaneMessage(
      reply.laneJid,
      reply.text,
      providerMessageId ?? `team-reply-${reply.id}`,
    );
  } catch (error) {
    logger.warn(
      { err: error, replyId: reply.id },
      'Team reply was not stored in its lane',
    );
  }
  if (item) broadcast(getWorkItem(item.id) ?? item);
}

/**
 * The reply cannot reach the group (its message recalled, the chat gone, or
 * the outcome unknowable). The item gets a question for a person, so it
 * shows among the items that need someone.
 */
function settleReplyFailed(reply: WorkItemReply, error: string): void {
  updateWorkItemReply(
    reply.id,
    { status: 'failed', error: error.slice(0, 500) },
    now(),
  );
  logger.warn(
    { replyId: reply.id, workItemId: reply.workItemId, purpose: reply.purpose },
    'Team reply was not delivered',
  );
  const item = reply.workItemId ? getWorkItem(reply.workItemId) : undefined;
  if (!item) return;
  // The reason is an event of its own; the item's open question (if any)
  // stays as it is, and an ended item needs nobody.
  recordWorkEvent({
    workItemId: item.id,
    kind: 'reply',
    state: 'failed',
    text: `${reply.purpose}: ${error}`.slice(0, 500),
    triggerMessageId: reply.quoteMessageId,
    now: now(),
  });
  if (item.status !== 'open' || item.attention) {
    broadcast(item);
    return;
  }
  const label = PURPOSE_LABEL[reply.purpose] ?? '回复';
  broadcast(
    patchItem(item, {
      attention: `群里的${label}没有发出，请在 Web 上查看并处理。`,
      attentionMessageId: null,
    }),
  );
}

// One accept at a time per trigger: a retried tool call never creates two
// worker sessions.
const acceptsInFlight = new Map<string, Promise<WorkRouteResultItem>>();

async function createWorkerSession(
  context: TeamGroupContext,
  title: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const workspace = context.workspace;
  let worktree = null;
  if (workspace.executionMode === 'host') {
    // A worktree when the directory is a git repository; a plain session
    // when it cannot have one (not a repository, no commits).
    try {
      worktree = await createSessionWorktree({
        group: workspace,
        chatJid: context.workspaceJid,
        agentId: sessionId,
      });
    } catch (error) {
      if (!(error instanceof WorktreeUnavailableError)) throw error;
    }
  }
  const session = await createConversationSession({
    workspaceJid: context.workspaceJid,
    group: workspace,
    createdBy: workspace.created_by ?? '',
    name: title,
    sessionId,
    sourceKind: 'work_item',
    worktree,
  });
  return session.id;
}

/** Delete a worker session no item ended up using. */
function discardSession(
  workspaceJid: string,
  group: RegisteredGroup,
  agentId: string,
): void {
  const orphan = getAgent(agentId);
  if (!orphan) return;
  try {
    deleteConversationSession({ workspaceJid, group, session: orphan });
  } catch {
    /* the orphan stays; nothing routes to it */
  }
}

async function acceptCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): Promise<WorkRouteResultItem> {
  const { context } = router;
  const existing = getWorkItemBySource(context.channelJid, candidate.messageId);
  if (existing) {
    return routed(candidate, 'accept', existing.id);
  }
  refuseDecided(router, candidate);
  const title = typeof route.title === 'string' ? route.title.trim() : '';
  if (!title) fail('accept needs a title.');
  if ([...title].length > WORK_TITLE_CHAR_LIMIT) {
    fail(`title is limited to ${WORK_TITLE_CHAR_LIMIT} characters.`);
  }
  const acknowledgement = requireImText(
    route.acknowledgement,
    'acknowledgement',
  );
  const note = optionalNote(route.note);
  const facts = candidate.item.facts ?? {};
  const strength = facts.strength ?? 'explicit';
  const settings = context.settings;
  let matchedRules: WorkMandate['matchedRules'] = [];
  if (strength === 'inferred') {
    const enabled = settings.rules.filter((rule) => rule.enabled);
    const assessments = Array.isArray(route.ruleAssessments)
      ? route.ruleAssessments
      : [];
    const assessed = new Map(
      assessments.map((entry) => [entry?.ruleId, entry] as const),
    );
    const missing = enabled.filter((rule) => !assessed.has(rule.id));
    if (missing.length > 0) {
      fail(
        `ruleAssessments must judge every enabled rule; missing: ${missing.map((rule) => rule.id).join(', ')}.`,
      );
    }
    matchedRules = enabled
      .filter((rule) => assessed.get(rule.id)?.matched === true)
      .map(({ id, name, instruction }) => ({ id, name, instruction }));
    if (matchedRules.length === 0) {
      fail('No enabled rule matched this inferred candidate; use ignore.');
    }
    if (settings.acceptMode === 'observe') {
      decide(router, candidate, 'would_accept', {
        reason: note ?? title,
        ruleIds: matchedRules.map((rule) => rule.id),
      });
      return routed(candidate, 'would_accept');
    }
    if (settings.acceptMode !== 'auto') {
      fail('This group does not accept inferred work.');
    }
  }
  const listed = facts.listed === true;
  const ownerImId = ownerImIdOf(context);
  const mandate: WorkMandate = {
    strength,
    requesterImId: facts.senderImId ?? null,
    requesterName: candidate.senderName || null,
    requesterListed: listed,
    requesterIsOwner: !!ownerImId && facts.senderImId === ownerImId,
    matchedRules,
    settingsVersion: settings.version,
    writable: strength === 'explicit' && listed,
  };

  let agentId: string;
  try {
    agentId = await createWorkerSession(context, title);
  } catch (error) {
    logger.warn(
      {
        err: error,
        channelJid: context.channelJid,
        trigger: candidate.messageId,
      },
      'Could not create the worker session of a work item',
    );
    fail(
      `Could not create the work item's session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const item = insertWorkItem({
    id: crypto.randomUUID(),
    workspaceJid: context.workspaceJid,
    workspaceFolder: context.workspace.folder,
    channelJid: context.channelJid,
    agentId,
    title,
    sourceMessageId: candidate.messageId,
    sourceRouteJid: context.channelJid,
    mandate,
    now: now(),
  });
  if (item.agentId !== agentId) {
    // Another process won the insert: its session does the work.
    discardSession(context.workspaceJid, context.workspace, agentId);
    return routed(candidate, 'accept', item.id);
  }
  subscribeTrigger(item, candidate.messageId, facts.threadId);
  decide(router, candidate, 'accept', {
    workItemId: item.id,
    reason: note ?? '',
    ruleIds: matchedRules.map((rule) => rule.id),
  });
  // The request itself, in full: the item's detail shows it as the original
  // message.
  noteDelivery(item, candidate.messageId, candidate.content);
  // The router's acknowledgement is this trigger's one ack: a worker's
  // work_ack on the same trigger is a duplicate.
  acknowledge(item, candidate.messageId, acknowledgement, router.laneJid);
  const rules = matchedRules
    .map((rule) => `${rule.name}: ${rule.instruction}`)
    .join('; ');
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: `work-assignment-${item.id}`,
    content: candidate.content,
    senderName: candidate.senderName || undefined,
    item: {
      tag: 'work_assignment',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['trigger', candidate.messageId],
        ['writable', String(mandate.writable)],
        ['rules', rules],
      ],
      ...(note ? { note } : {}),
      facts: { workItemId: item.id },
    },
  });
  logger.info(
    {
      workItemId: item.id,
      seq: item.seq,
      agentId,
      channelJid: context.channelJid,
      strength,
      writable: mandate.writable,
    },
    'Work item accepted',
  );
  broadcast(item);
  return routed(candidate, 'accept', item.id);
}

function routed(
  candidate: Candidate,
  decision: WorkDecisionKind,
  workItemId?: string,
): WorkRouteResultItem {
  return {
    triggerMessageId: candidate.messageId,
    ok: true,
    ...(workItemId ? { workItemId } : {}),
    decision,
  };
}

/** Subscribe an item to a trigger and its thread, so replies reach it. */
function subscribeTrigger(
  item: WorkItem,
  messageId: string,
  threadId: string | undefined,
): void {
  for (const key of teamTriggerKeys({ messageId, threadId })) {
    subscribeWorkItem(item.id, item.channelJid, key, now());
  }
}

/** A router note: routing background of at most WORK_NOTE_WORD_LIMIT words. */
function optionalNote(value: unknown): string | null {
  const note = optionalText(value, 2000);
  if (note && countImWords(note) > WORK_NOTE_WORD_LIMIT) {
    fail(`note is limited to ${WORK_NOTE_WORD_LIMIT} words.`);
  }
  return note;
}

function requireExplicit(candidate: Candidate, kind: string): void {
  if (candidate.item.facts?.strength !== 'explicit') {
    fail(`${kind} needs an explicit candidate.`);
  }
}

function attachCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): WorkRouteResultItem {
  requireExplicit(candidate, 'attach');
  let item = requireGroupItem(router, route.workItemId);
  if (item.status === 'ended' && item.outcome === 'stopped') {
    fail('That work item was stopped by a person.');
  }
  // Resuming needs the item's mandate to hold, as for any follow-up.
  if (
    item.status === 'ended' &&
    !canResumeWorkItem(item, (sender) => isTeamListed(router.context, sender))
  ) {
    fail(
      'That work item cannot be resumed: its requester is no longer listed.',
    );
  }
  refuseDecided(router, candidate);
  const note = optionalNote(route.note);
  const facts = candidate.item.facts ?? {};
  if (item.status === 'ended') item = resumeItem(item, candidate.messageId);
  subscribeTrigger(item, candidate.messageId, facts.threadId);
  decide(router, candidate, 'attach', {
    workItemId: item.id,
    reason: note ?? '',
  });
  noteDelivery(item, candidate.messageId);
  // The item keeps its own mandate: a follow-up from someone who is not
  // listed is marked so (listed="false") and authorizes nothing.
  deliverFollowupCopy(item, {
    id: candidate.messageId,
    content: candidate.content,
    senderName: candidate.senderName,
    sourceJid: candidate.sourceJid,
    senderImId: facts.senderImId,
    senderIsBot: facts.senderIsBot,
    threadId: facts.threadId,
    listed: facts.listed === true,
    addressed: facts.addressed === true,
    channelContext: getMessageChannelTurnContext(
      router.laneJid,
      candidate.rowId,
    ),
  });
  broadcast(item);
  return routed(candidate, 'attach', item.id);
}

function stopFromCandidate(
  router: RouterLane,
  candidate: Candidate,
  route: WorkRouteItem,
): WorkRouteResultItem {
  requireExplicit(candidate, 'stop');
  const item = requireGroupItem(router, route.workItemId);
  refuseDecided(router, candidate);
  decide(router, candidate, 'stop', {
    workItemId: item.id,
    reason: optionalText(route.reason, REASON_CHAR_LIMIT) ?? '',
  });
  if (item.status === 'open') broadcast(stopItem(item, candidate.messageId));
  return routed(candidate, 'stop', item.id);
}

async function routeOne(
  router: RouterLane,
  route: WorkRouteItem,
): Promise<WorkRouteResultItem> {
  const trigger =
    route && typeof route.triggerMessageId === 'string'
      ? route.triggerMessageId
      : '';
  try {
    const candidate = loadCandidate(router, trigger);
    switch (route.kind) {
      case 'accept': {
        const key = `${router.context.channelJid}\u0000${trigger}`;
        const inFlight = acceptsInFlight.get(key);
        if (inFlight) return await inFlight;
        const accepting = acceptCandidate(router, candidate, route);
        acceptsInFlight.set(key, accepting);
        try {
          return await accepting;
        } finally {
          acceptsInFlight.delete(key);
        }
      }
      case 'attach':
        return attachCandidate(router, candidate, route);
      case 'stop':
        return stopFromCandidate(router, candidate, route);
      case 'ignore': {
        const reason = optionalText(route.reason, REASON_CHAR_LIMIT);
        if (!reason) fail('ignore needs a reason.');
        refuseDecided(router, candidate);
        decide(router, candidate, 'ignore', { reason });
        return { triggerMessageId: trigger, ok: true, decision: 'ignore' };
      }
      default:
        fail('kind must be accept, attach, stop or ignore.');
    }
  } catch (error) {
    if (!(error instanceof WorkIpcError) && !(error instanceof WorkItemError)) {
      logger.error(
        { err: error, trigger, kind: route?.kind },
        'work_route item failed unexpectedly',
      );
    }
    return {
      triggerMessageId: trigger,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleWorkRoute(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const router = requireRouter(caller);
  const items = Array.isArray(payload.items)
    ? (payload.items as WorkRouteItem[])
    : fail('items must be a list.');
  if (items.length === 0) fail('items must not be empty.');
  const results: WorkRouteResultItem[] = [];
  for (const route of items) results.push(await routeOne(router, route));
  return { results };
}

/**
 * The trigger's one acknowledgement: recorded as a reply first (durable),
 * then as the item's ack event. Returns false when the trigger was already
 * acknowledged (by the router's accept or an earlier work_ack).
 */
function acknowledge(
  item: WorkItem,
  triggerMessageId: string,
  text: string,
  laneJid: string,
): boolean {
  const id = `ack:${triggerMessageId}`;
  if (getWorkItemReply(id)) return false;
  requestReply({
    id,
    workspaceJid: item.workspaceJid,
    workItem: item,
    channelJid: item.channelJid,
    quoteMessageId: triggerMessageId,
    text,
    purpose: 'ack',
    laneJid,
  });
  recordWorkEvent({
    workItemId: item.id,
    kind: 'ack',
    text,
    triggerMessageId,
    now: now(),
  });
  return true;
}

/** The last report a result answers (ready, blocked or failed), if any. */
function lastResultReportId(item: WorkItem): number | null {
  const last = getLastWorkReport(item.id);
  return last &&
    (last.state === 'ready' ||
      last.state === 'blocked' ||
      last.state === 'failed')
    ? last.id
    : null;
}

function handleWorkReply(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const router = requireRouter(caller);
  const text = requireImText(payload.text, 'text');
  const purpose = payload.purpose;
  if (purpose === 'result' || purpose === 'attention') {
    const item = requireGroupItem(router, payload.workItemId);
    let quote: string;
    let id: string;
    if (purpose === 'result') {
      const reportId =
        item.lastReport === 'ready' ||
        item.lastReport === 'blocked' ||
        item.lastReport === 'failed'
          ? lastResultReportId(item)
          : null;
      if (reportId === null) {
        fail(
          'A result needs the item to have reported ready, blocked or failed.',
        );
      }
      // One result per report.
      id = `result:${item.id}:${reportId}`;
      if (getWorkItemReply(id)) {
        fail('The result of this report was already posted.');
      }
      quote = item.sourceMessageId;
    } else {
      if (!item.attention) fail('This work item is not waiting for anyone.');
      quote = item.attentionMessageId ?? item.sourceMessageId;
      id = `attention:${item.id}:${crypto.randomUUID()}`;
    }
    requestReply({
      id,
      workspaceJid: item.workspaceJid,
      workItem: item,
      channelJid: item.channelJid,
      quoteMessageId: quote,
      text,
      purpose,
      laneJid: router.laneJid,
    });
    return { queued: true };
  }
  if (purpose === 'answer') {
    const candidate = loadCandidate(router, payload.triggerMessageId);
    const decision = getWorkDecisionForTrigger(
      router.context.channelJid,
      candidate.messageId,
    );
    if (
      getWorkItemBySource(router.context.channelJid, candidate.messageId) ||
      decision?.kind === 'accept' ||
      decision?.kind === 'attach'
    ) {
      fail('That message belongs to a work item; answer through it.');
    }
    // One answer per candidate.
    const id = `answer:${router.context.channelJid}:${candidate.messageId}`;
    if (getWorkItemReply(id)) fail('This candidate was already answered.');
    requestReply({
      id,
      workspaceJid: router.context.workspaceJid,
      workItem: null,
      channelJid: router.context.channelJid,
      quoteMessageId: candidate.messageId,
      text,
      purpose,
      laneJid: router.laneJid,
    });
    return { queued: true };
  }
  fail('purpose must be result, attention or answer.');
}

function handleWorkList(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const router = requireRouter(caller);
  const status =
    payload.status === 'open' || payload.status === 'ended'
      ? payload.status
      : undefined;
  const limit =
    typeof payload.limit === 'number' && Number.isFinite(payload.limit)
      ? Math.min(Math.max(Math.trunc(payload.limit), 1), 100)
      : 30;
  const items = listWorkItemsByChannel(router.context.channelJid, {
    status,
    limit,
  })
    .filter((item) => item.workspaceJid === router.context.workspaceJid)
    .map((item) => ({
      id: item.id,
      seq: item.seq,
      title: item.title,
      stage: deriveWorkStage(item),
      lastReport: item.lastReport,
      lastSummary: item.lastSummary,
      attention: item.attention,
      sourceMessageId: item.sourceMessageId,
    }));
  return { items };
}

const REPORT_STATES: ReadonlySet<string> = new Set(WORK_REPORT_STATES);

/** Record a worker's report and show it in the worker's own transcript. */
function recordReport(
  item: WorkItem,
  state: WorkReportState,
  summary: string,
): number | null {
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'report',
    state,
    text: summary,
    now: now(),
  });
  void getWorkItemRuntimeHooks()
    .postLaneMessage(
      laneJidOf(item.workspaceJid, item.agentId),
      summary,
      reportInputId(item.id, eventId),
    )
    .catch((error) =>
      logger.warn({ err: error, workItemId: item.id }, 'Report not stored'),
    );
  return eventId;
}

function handleWorkReport(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireWorker(caller);
  if (item.status !== 'open') fail('This work item has ended.');
  if (item.origin === 'delegated') return handleDelegatedReport(item, payload);
  const state = payload.state as WorkReportState;
  if (!REPORT_STATES.has(state)) fail('state is not a report state.');
  const summary = optionalText(payload.summary, WORK_SUMMARY_CHAR_LIMIT);
  if (!summary) fail('summary is required.');
  const humanAction = optionalText(payload.humanAction, 1000);
  const questionFor = optionalText(payload.questionForMessageId, 200);
  // An omitted humanAction keeps the open question; null clears it.
  const patch: WorkItemPatch = {
    lastReport: state,
    lastSummary: summary,
    ...(payload.humanAction !== undefined
      ? {
          attention: humanAction,
          attentionMessageId: humanAction ? questionFor : null,
        }
      : {}),
  };
  let updated: WorkItem;
  if (state === 'ready' && isWorkItemWritable(item)) {
    updated = endItem(item, 'completed', patch);
  } else if (state === 'dropped') {
    updated = endItem(item, 'dropped', { ...patch, attention: null });
  } else {
    updated = patchItem(item, patch);
  }
  const eventId = recordReport(item, state, summary);
  // Progress only updates the item; a dropped item ends silently.
  if (forwardsReport(state, updated.attention)) {
    const context = resolveTeamGroup(item.channelJid);
    if (context?.routerAgentId) {
      injectReport(updated, context.routerAgentId, {
        eventId,
        state,
        summary,
      });
    } else {
      // Nobody can act on it now: kept on the item, and handed to the
      // router the group gets when its settings are saved again.
      recordWorkEvent({
        workItemId: item.id,
        kind: 'report',
        state: 'undelivered',
        text: '路由会话不存在，这份报告还没有送达；重新保存团队设置后会补发给新的路由会话。',
        now: now(),
      });
    }
  }
  broadcast(updated);
  return {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The trigger was delivered to this item (its source or a follow-up). */
function wasDeliveredTo(item: WorkItem, triggerMessageId: string): boolean {
  return (
    item.sourceMessageId === triggerMessageId ||
    hasWorkEvent(item.id, 'input', triggerMessageId)
  );
}

function handleWorkAck(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireTeamWorker(caller);
  requireOpen(item);
  const trigger = stringField(payload.triggerMessageId);
  if (!trigger || !wasDeliveredTo(item, trigger)) {
    fail('triggerMessageId is not a message delivered to this work item.');
  }
  const text = requireImText(payload.text, 'text');
  const posted = acknowledge(
    item,
    trigger,
    text,
    laneJidOf(item.workspaceJid, item.agentId),
  );
  return { duplicate: !posted };
}

function handleWorkHandback(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): unknown {
  const item = requireTeamWorker(caller);
  requireOpen(item);
  const trigger = stringField(payload.triggerMessageId);
  if (
    !trigger ||
    trigger === item.sourceMessageId ||
    !wasDeliveredTo(item, trigger)
  ) {
    fail('triggerMessageId is not a follow-up delivered to this work item.');
  }
  const reason = optionalText(payload.reason, REASON_CHAR_LIMIT);
  if (!reason) fail('reason is required.');
  const context = resolveTeamGroup(item.channelJid);
  if (!context?.routerAgentId) fail('Team mode is off for this group.');
  const routerLane = laneJidOf(context.workspaceJid, context.routerAgentId);
  if (getAgentBuilderInputMessage(routerLane, handbackInputId(trigger))) {
    return {};
  }
  const workerLane = laneJidOf(item.workspaceJid, item.agentId);
  const row =
    getAgentBuilderInputMessage(workerLane, trigger) ??
    getAgentBuilderInputMessage(workerLane, followupCopyId(trigger, item.id));
  const original = row ? readTeamInput(row.attachments) : null;
  if (!row || !original) fail('The follow-up is no longer stored.');
  const facts = original.facts ?? {};
  const fromBot = facts.senderIsBot === true;
  // The facts the gate judged when the message arrived (its header), not
  // the copy's or the hand-back's own shape.
  const listed =
    !fromBot && (facts.listed ?? isTeamListed(context, facts.senderImId));
  const addressed = facts.addressed === true;
  const strength = admitMessage(context.settings, {
    listed,
    addressed,
    fromBot,
  });
  if (strength === 'ignore') {
    fail(
      'The group would not admit this message as a request; keep or drop it.',
    );
  }
  // The message and the replies to it no longer reach this item (the gate
  // also skips it for their root and thread, by the handback event).
  unsubscribeWorkItem(
    item.id,
    item.channelJid,
    subscriptionKey('msg', trigger),
  );
  recordWorkEvent({
    workItemId: item.id,
    kind: 'handback',
    text: reason,
    triggerMessageId: trigger,
    now: now(),
  });
  injectTeamInput({
    workspaceJid: context.workspaceJid,
    agentId: context.routerAgentId,
    messageId: handbackInputId(trigger),
    content: row.content,
    senderName: row.sender_name ?? undefined,
    sourceJid: row.source_jid ?? item.channelJid,
    channelContext: getMessageChannelTurnContext(workerLane, row.id),
    item: candidateInputItem({
      triggerMessageId: trigger,
      strength,
      listed,
      addressed,
      settings: context.settings,
      threadItems: [item],
      senderImId: facts.senderImId,
      senderIsBot: fromBot,
      threadId: facts.threadId,
      handback: { item, reason },
    }),
  });
  broadcast(restoreIfOnlyResumedBy(getWorkItem(item.id) ?? item, trigger));
  return {};
}

/**
 * An ended item a message resumed, and whose worker handed exactly that
 * message back without reporting or receiving anything else, ends again as
 * it was: nothing about it changed.
 */
function restoreIfOnlyResumedBy(item: WorkItem, trigger: string): WorkItem {
  if (item.status !== 'open') return item;
  const events = listWorkEvents(item.id, 200);
  let resumeIndex = -1;
  events.forEach((event, index) => {
    if (event.kind === 'resume') resumeIndex = index;
  });
  const resume = events[resumeIndex];
  if (!resume || resume.triggerMessageId !== trigger) return item;
  const outcome = resume.state as WorkItem['outcome'];
  if (outcome !== 'completed' && outcome !== 'dropped') return item;
  const since = events.slice(resumeIndex + 1);
  if (
    since.some(
      (event) =>
        event.kind === 'report' ||
        (event.kind === 'input' && event.triggerMessageId !== trigger),
    )
  ) {
    return item;
  }
  recordWorkEvent({
    workItemId: item.id,
    kind: 'resume',
    state: 'undone',
    text: 'The message that resumed it was handed back.',
    triggerMessageId: trigger,
    now: now(),
  });
  return endItem(item, outcome);
}

// ── Multi-task mode: delegated work ────────────────────────────────────

/** Errors the delegating session's model reads, in the contract's words. */
const DELEGATION_ERRORS = {
  singleTask: '当前工作区是单任务模式，不能派出后台任务；请在当前会话里完成。',
  notOwner:
    '只有工作区主人亲自发起的对话可以派出后台任务；请在当前会话里完成。',
  limit: `后台任务已达上限（每个会话最多 ${DELEGATED_OPEN_PER_SESSION} 个、每个工作区最多 ${DELEGATED_OPEN_PER_WORKSPACE} 个同时进行）；请等已有任务完成，或在当前会话里完成。`,
  billing: '当前额度不足，不能派出后台任务。',
  ended: '这个后台任务已经结束。',
  notFound: (item: string) => `没有找到这个后台任务：${item}。`,
  manageNotOwner:
    '只有工作区主人亲自发起的对话可以停止或跟进后台任务；请把用户的意思转告主人。',
  worktree: '独立 worktree 会话暂不支持派出后台任务；请在当前会话里完成。',
  stoppedBeforeStart: '这个后台任务在 Worker 启动前已被停止，没有开始执行。',
};

/** Why a delegated item stopped: its event text, and what its session reads. */
type DelegatedStopCause =
  | 'work_stop'
  | 'web'
  | 'session_deleted'
  | 'origin_deleted';

const DELEGATED_STOP_REASON: Record<DelegatedStopCause, string> = {
  work_stop: '本会话用 work_stop 停止了它',
  web: '用户在 Web 上停止了它',
  session_deleted: 'Worker 会话已被删除',
  origin_deleted: '派出它的会话已被删除',
};

const WORKER_GONE_REPORT = 'Worker 会话已不存在，任务没有完成。';
const WORKER_NO_RESULT_REPORT = 'Worker 结束了这一轮，但没有交回结果。';

// One delegation at a time per workspace, so concurrent calls cannot pass
// the open-item limits together. The checks and the item's insert run with
// no await between them today; the lock keeps that true if one is added.
const delegationLocks = new KeyedLockPool();

/** A session that may delegate: ordinary, of a multi-task workspace. */
interface DelegatingLane {
  agentId: string;
  workspaceJid: string;
  workspace: RegisteredGroup;
  laneJid: string;
}

/** The session that delegated an item, while it exists. */
function originSessionOf(item: WorkItem): SubAgent | undefined {
  return item.origin === 'delegated' && item.originAgentId
    ? liveSession(item.workspaceJid, item.originAgentId)
    : undefined;
}

/**
 * Whether a session takes part in multi-task mode: an ordinary conversation.
 * Team sessions (a router, any worker, delegated ones too) and spawned
 * agents do not.
 */
export function mayDelegateWork(
  agent: Pick<SubAgent, 'kind' | 'source_kind'>,
): boolean {
  return (
    agent.kind === 'conversation' &&
    agent.source_kind !== 'team_router' &&
    agent.source_kind !== 'work_item'
  );
}

/**
 * `ContainerInput.workMode`: `multi` for a session that may delegate in a
 * multi-task workspace, and for one whose delegated work is still under way
 * after the workspace went back to single-task (an open item, or a report of
 * one in the batch it runs), so it keeps the tools to follow that work up and
 * reads its reports. An automation's session (its turns never pass the owner
 * rule) and a worktree session (refused) get no delegation tools.
 */
export function runnerWorkMode(
  agent: Pick<SubAgent, 'id' | 'kind' | 'source_kind'>,
  workspaceFolder: string,
  inputs: readonly DelegatedReportCandidate[] = [],
): 'multi' | undefined {
  if (
    !mayDelegateWork(agent) ||
    agent.source_kind === 'automation' ||
    getSessionWorktree(agent.id)
  ) {
    return undefined;
  }
  return getWorkspaceWorkMode(workspaceFolder) === 'multi' ||
    countOpenDelegatedWorkItems({ originAgentId: agent.id }) > 0 ||
    inputs.some(isDelegatedReportInput)
    ? 'multi'
    : undefined;
}

/** The fields of a stored input that tell a delegated report. */
interface DelegatedReportCandidate {
  source_kind?: string | null;
  attachments?: string | null;
}

/**
 * A delegated item's report in its session's lane. Stopping that session's
 * turn does not withdraw it from the queue: the item has ended, and the
 * report is the only news of it.
 */
export function isDelegatedReportInput(
  input: DelegatedReportCandidate,
): boolean {
  if (input.source_kind !== 'work_item_input') return false;
  const header = readTeamInput(input.attachments);
  const id = header?.tag === 'work_report' ? header.facts?.workItemId : null;
  return !!id && getWorkItem(id)?.origin === 'delegated';
}

/**
 * The calling session, if it may use a delegation tool. `delegate` needs a
 * multi-task workspace and no worktree; following up work already delegated
 * (`manage`) stays possible after the workspace went back to single-task.
 */
function requireDelegatingLane(
  caller: WorkIpcCaller,
  purpose: 'delegate' | 'manage',
): DelegatingLane {
  const agent = caller.agentId ? getAgent(caller.agentId) : undefined;
  const workspace = agent?.chat_jid
    ? getRegisteredGroup(agent.chat_jid)
    : undefined;
  if (
    !agent ||
    !workspace ||
    agent.group_folder !== caller.folder ||
    !mayDelegateWork(agent)
  ) {
    fail(
      'Only an ordinary session of a multi-task workspace can use this tool.',
    );
  }
  if (
    getWorkspaceWorkMode(workspace.folder) !== 'multi' &&
    (purpose === 'delegate' || !hasDelegatedWorkItems(agent.id))
  ) {
    fail(DELEGATION_ERRORS.singleTask);
  }
  // Its worker would edit the main checkout, not this session's worktree.
  if (purpose === 'delegate' && getSessionWorktree(agent.id)) {
    fail(DELEGATION_ERRORS.worktree);
  }
  return {
    agentId: agent.id,
    workspaceJid: agent.chat_jid,
    workspace,
    laneJid: laneJidOf(agent.chat_jid, agent.id),
  };
}

/**
 * The calling turn may change a delegated item (stop it, follow it up): the
 * workspace owner started it, as for work_delegate. A turn answering a
 * report is not the owner's own.
 */
function requireOwnerTurn(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): void {
  if (!caller.ownerTurn?.(stringField(payload.inputTurnId) || null)) {
    fail(DELEGATION_ERRORS.manageNotOwner);
  }
}

/**
 * `payload.item` names one of the calling session's delegated items, by id
 * or `#seq`, and the item is still open; the turn is the owner's own.
 */
function requireOpenDelegatedItem(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): WorkItem {
  const lane = requireDelegatingLane(caller, 'manage');
  requireOwnerTurn(caller, payload);
  const ref = payload.item;
  const text = typeof ref === 'number' ? String(ref) : stringField(ref).trim();
  const seq = /^#?(\d+)$/.exec(text);
  const item = seq
    ? getWorkItemBySeq(lane.workspaceJid, Number(seq[1]))
    : getWorkItem(text);
  if (
    !item ||
    item.origin !== 'delegated' ||
    item.originAgentId !== lane.agentId
  ) {
    fail(DELEGATION_ERRORS.notFound(text));
  }
  if (item.status !== 'open') fail(DELEGATION_ERRORS.ended);
  return item;
}

/** A trimmed string of at most `limit` characters, or null when empty. */
function boundedText(
  value: unknown,
  what: string,
  limit: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${what} must be a string.`);
  const text = value.trim();
  if ([...text].length > limit) {
    fail(`${what} is limited to ${limit} characters.`);
  }
  return text || null;
}

function requireText(value: unknown, what: string, limit: number): string {
  return boundedText(value, what, limit) ?? fail(`${what} is required.`);
}

/** The worker's assignment: the task, then the background and files given. */
function assignmentBody(request: {
  task: string;
  context: string | null;
  files: string[];
}): string {
  const parts = [request.task];
  if (request.context) parts.push(`## 背景\n${request.context}`);
  if (request.files.length > 0) {
    parts.push(
      `## 相关文件\n${request.files.map((file) => `- ${file}`).join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

function parseDelegateRequest(payload: Record<string, unknown>): {
  title: string;
  task: string;
  context: string | null;
  files: string[];
} {
  const title = requireText(payload.title, 'title', WORK_TITLE_CHAR_LIMIT);
  const task = requireText(payload.task, 'task', DELEGATE_TASK_CHAR_LIMIT);
  const context = boundedText(
    payload.context,
    'context',
    DELEGATE_CONTEXT_CHAR_LIMIT,
  );
  let files: string[] = [];
  if (payload.files !== undefined && payload.files !== null) {
    if (
      !Array.isArray(payload.files) ||
      payload.files.some((file) => typeof file !== 'string')
    ) {
      fail('files must be a list of paths.');
    }
    files = (payload.files as string[])
      .map((file) => file.trim())
      .filter(Boolean);
    if (files.length > DELEGATE_FILES_LIMIT) {
      fail(`files is limited to ${DELEGATE_FILES_LIMIT} paths.`);
    }
  }
  return { title, task, context, files };
}

/**
 * The reply route of the input a delegation answered: its provider, Bot
 * account, chat, topic and message. Nothing of that input's content (a
 * quote, a forward, mentions, its sender) comes along: the report is not a
 * reply to anything and must not render as quoted or forwarded material,
 * but it goes back to the same chat and topic.
 */
function replyRouteContext(
  context: ChannelTurnContext | null,
): ChannelTurnContext | null {
  if (!context) return null;
  const { id, rootId, threadId } = context.message;
  return {
    schemaVersion: context.schemaVersion,
    provider: context.provider,
    channelAccountId: context.channelAccountId,
    sourceJid: context.sourceJid,
    ...(context.bot ? { bot: context.bot } : {}),
    chat: context.chat,
    message: {
      id,
      ...(rootId ? { rootId } : {}),
      ...(threadId ? { threadId } : {}),
    },
  };
}

async function handleWorkDelegate(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): Promise<WorkDelegateResult> {
  const { workspaceJid } = requireDelegatingLane(caller, 'delegate');
  const request = parseDelegateRequest(payload);
  // Judged inside the lock: a call that waited for another delegation sees
  // the session, the mode and the turn as they are now. The turn must name
  // the input it answers, which the item's reports go back to.
  return delegationLocks.withLocks([workspaceJid], () => {
    const lane = requireDelegatingLane(caller, 'delegate');
    const origin = caller.ownerTurn?.(
      stringField(payload.inputTurnId) || null,
    )?.input;
    if (!origin || origin.chatJid !== lane.laneJid) {
      fail(DELEGATION_ERRORS.notOwner);
    }
    return delegate(lane, request, origin);
  });
}

async function delegate(
  lane: DelegatingLane,
  request: ReturnType<typeof parseDelegateRequest>,
  origin: DelegationOriginInput,
): Promise<WorkDelegateResult> {
  if (
    countOpenDelegatedWorkItems({ originAgentId: lane.agentId }) >=
      DELEGATED_OPEN_PER_SESSION ||
    countOpenDelegatedWorkItems({ workspaceJid: lane.workspaceJid }) >=
      DELEGATED_OPEN_PER_WORKSPACE
  ) {
    fail(DELEGATION_ERRORS.limit);
  }
  // The billing gate every run of the owner passes.
  const owner = lane.workspace.created_by
    ? getUserById(lane.workspace.created_by)
    : undefined;
  if (
    !owner ||
    owner.status !== 'active' ||
    !checkBillingAccessFresh(owner.id, owner.role).allowed
  ) {
    fail(DELEGATION_ERRORS.billing);
  }
  const originRow = getAgentBuilderInputMessage(lane.laneJid, origin.messageId);
  // The item before its session: a crash in between leaves an item without
  // a worker, which startup fails, never a session no item names.
  const agentId = crypto.randomUUID();
  const item = insertWorkItem({
    id: crypto.randomUUID(),
    workspaceJid: lane.workspaceJid,
    workspaceFolder: lane.workspace.folder,
    channelJid: lane.laneJid,
    agentId,
    title: request.title,
    sourceMessageId: `delegate:${crypto.randomUUID()}`,
    sourceRouteJid: originRow?.source_jid || lane.laneJid,
    mandate: {
      strength: 'explicit',
      requesterImId: null,
      requesterName: owner.display_name || owner.username || null,
      requesterListed: true,
      requesterIsOwner: true,
      matchedRules: [],
      settingsVersion: 0,
      writable: true,
    },
    now: now(),
    delegatedBy: { agentId: lane.agentId, inputId: origin.messageId },
  });
  // Nothing half made stays: the item fails and its session goes.
  const abandon = (error: unknown): never => {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      { err: error, workItemId: item.id, laneJid: lane.laneJid },
      'Could not start a delegated item',
    );
    broadcast(endItem(item, 'failed', { lastSummary: `派出失败：${reason}` }));
    discardSession(lane.workspaceJid, lane.workspace, agentId);
    return fail(`Could not start the delegated task: ${reason}`);
  };
  try {
    // Shares the delegating session's directory: no worktree.
    await createConversationSession({
      workspaceJid: lane.workspaceJid,
      group: lane.workspace,
      createdBy: owner.id,
      name: request.title,
      sessionId: agentId,
      sourceKind: 'work_item',
    });
  } catch (error) {
    abandon(error);
  }
  // Stopped on the Web, or its delegating session deleted, while the
  // session was being made: no worker runs it.
  const current = getWorkItem(item.id);
  if (current?.status !== 'open' || !originSessionOf(current)) {
    if (current?.status === 'open') {
      stopDelegatedItem(current, 'origin_deleted')();
    }
    discardSession(lane.workspaceJid, lane.workspace, agentId);
    fail(DELEGATION_ERRORS.stoppedBeforeStart);
  }
  try {
    // The task in full: the item's detail shows it as the request.
    noteDelivery(item, item.sourceMessageId, request.task);
    injectTeamInput({
      workspaceJid: item.workspaceJid,
      agentId,
      messageId: `work-assignment-${item.id}`,
      content: assignmentBody(request),
      item: {
        tag: 'work_assignment',
        attrs: [
          ['item', `#${item.seq}`],
          ['id', item.id],
          ['origin', 'delegated'],
          ['writable', 'true'],
        ],
        facts: { workItemId: item.id },
      },
    });
  } catch (error) {
    abandon(error);
  }
  logger.info(
    {
      workItemId: item.id,
      seq: item.seq,
      agentId,
      originAgentId: lane.agentId,
      workspaceJid: lane.workspaceJid,
    },
    'Work delegated',
  );
  broadcast(item);
  return { workItemId: item.id, seq: item.seq };
}

function handleWorkDelegations(caller: WorkIpcCaller): DelegatedWorkSummary[] {
  const lane = requireDelegatingLane(caller, 'manage');
  return listOpenDelegatedWorkItems(lane.agentId).map((item) => ({
    workItemId: item.id,
    seq: item.seq,
    title: item.title,
    stage: deriveWorkStage(item),
    lastReport: item.lastReport,
    lastSummary: item.lastSummary,
    createdAt: item.createdAt,
  }));
}

function handleWorkStop(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): Record<string, never> {
  stopDelegatedItem(requireOpenDelegatedItem(caller, payload), 'work_stop')();
  return {};
}

function handleWorkFollowup(
  caller: WorkIpcCaller,
  payload: Record<string, unknown>,
): Record<string, never> {
  const item = requireOpenDelegatedItem(caller, payload);
  const message = requireText(
    payload.message,
    'message',
    DELEGATE_FOLLOWUP_CHAR_LIMIT,
  );
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'input',
    text: message,
    now: now(),
  });
  // The question it was blocked on is answered (or overtaken): the item is
  // working again, no longer waiting for a person.
  const updated =
    item.attention || item.lastReport === 'blocked'
      ? patchItem(item, {
          attention: null,
          ...(item.lastReport === 'blocked'
            ? { lastReport: 'progress' as const }
            : {}),
        })
      : item;
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: item.agentId,
    messageId: `work-followup-${item.id}-${eventId}`,
    content: message,
    item: {
      tag: 'work_followup',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['origin', 'delegated'],
      ],
      facts: { workItemId: item.id },
    },
  });
  broadcast(updated);
  return {};
}

/**
 * A delegated worker's report. `progress` only updates the item; `ready`
 * ends it completed and `failed` failed; `blocked` keeps it open with its
 * question as the attention. The last three reach the delegating session as
 * a `work_report` input on the route of the input that delegated it.
 */
function handleDelegatedReport(
  item: WorkItem,
  payload: Record<string, unknown>,
): Record<string, never> {
  const state = payload.state as WorkReportState;
  if (!(DELEGATED_REPORT_STATES as readonly string[]).includes(state)) {
    fail('state must be progress, ready, blocked or failed.');
  }
  // Refused, not cut: the delegating session relays the summary as it is.
  const summary = stringField(payload.summary).trim();
  if (!summary) fail('summary is required.');
  if ([...summary].length > WORK_SUMMARY_CHAR_LIMIT) {
    fail(
      `summary is limited to ${WORK_SUMMARY_CHAR_LIMIT} characters; put a longer result in a file and give its path.`,
    );
  }
  const patch: WorkItemPatch = { lastReport: state, lastSummary: summary };
  let updated: WorkItem;
  if (state === 'ready') {
    updated = endItem(item, 'completed', { ...patch, attention: null });
  } else if (state === 'failed') {
    updated = endItem(item, 'failed', { ...patch, attention: null });
  } else if (state === 'blocked') {
    updated = patchItem(item, { ...patch, attention: summary });
  } else {
    updated = patchItem(item, patch);
  }
  const eventId = recordReport(item, state, summary);
  if (state !== 'progress') {
    reportToOrigin(updated, { eventId, state, text: summary });
  }
  broadcast(updated);
  return {};
}

/**
 * Hand a delegated item's news to the session that delegated it, as an
 * input on the route of the input that delegated it: a Web turn answers in
 * the Web, a chat or topic in that chat or topic. The id is fixed by the
 * event, so a replay delivers nothing twice. Nothing when that session is
 * gone.
 */
function reportToOrigin(
  item: WorkItem,
  report: { eventId: number | null; state: string; text: string },
): void {
  const origin = originSessionOf(item);
  if (!origin) {
    logger.info(
      { workItemId: item.id, state: report.state },
      'Delegated report not delivered: its delegating session is gone',
    );
    return;
  }
  injectTeamInput({
    workspaceJid: item.workspaceJid,
    agentId: origin.id,
    messageId: reportInputId(item.id, report.eventId),
    content: report.text,
    sourceJid: item.sourceRouteJid,
    channelContext: item.originInputId
      ? replyRouteContext(
          getMessageChannelTurnContext(item.channelJid, item.originInputId),
        )
      : null,
    item: {
      tag: 'work_report',
      attrs: [
        ['item', `#${item.seq}`],
        ['id', item.id],
        ['title', item.title],
        ['state', report.state],
      ],
      facts: { workItemId: item.id },
    },
  });
}

/**
 * End a delegated item as stopped. Writes rows only; returns what follows,
 * to run now or once the caller's transaction commits: its worker stops
 * (unless the worker's own session is being deleted), its delegating
 * session hears `state="stopped"` (unless that session is the one gone) and
 * the Web updates.
 */
function stopDelegatedItem(
  item: WorkItem,
  cause: DelegatedStopCause,
): () => WorkItemView {
  const { stopped, eventId } = endStopped(item, cause);
  return () => {
    if (cause !== 'session_deleted') stopWorkerLane(item);
    // The delegating session hears of a stop it did not make itself: one it
    // asked for with work_stop needs no report, which would only cost a turn.
    if (cause !== 'origin_deleted' && cause !== 'work_stop') {
      try {
        reportToOrigin(stopped, {
          eventId,
          state: 'stopped',
          text: `已停止：${DELEGATED_STOP_REASON[cause]}`,
        });
      } catch (error) {
        logger.warn(
          { err: error, workItemId: item.id },
          'Could not tell the delegating session that its item stopped',
        );
      }
    }
    return broadcast(stopped);
  };
}

/** End a delegated item failed, and tell its delegating session why. */
function failDelegatedItem(item: WorkItem, text: string): void {
  const failed = endItem(item, 'failed', { attention: null });
  const eventId = recordWorkEvent({
    workItemId: item.id,
    kind: 'report',
    state: 'failed',
    text,
    now: now(),
  });
  reportToOrigin(failed, { eventId, state: 'failed', text });
  broadcast(failed);
}

/**
 * A delegated worker's run ended without handing back a result.
 * `failure` null: its turn finished and nothing else waits for it, yet the
 * item is open and not waiting on a question (`blocked` is a result). A
 * string: the run failed for good (retries exhausted, a failure no replay
 * fixes, billing), and why. The item fails and its delegating session hears
 * so; a team worker, or an item already settled, is left alone.
 */
export function failDelegatedWorkerRun(
  agentId: string,
  failure: string | null,
): void {
  const item = getWorkItemByAgent(agentId);
  if (item?.origin !== 'delegated' || item.status !== 'open') return;
  if (failure === null && item.lastReport === 'blocked') return;
  failDelegatedItem(
    item,
    failure === null
      ? WORKER_NO_RESULT_REPORT
      : `Worker 运行失败：${briefReason(failure)}`,
  );
}

/** The first line of an error, at most 200 characters. */
function briefReason(text: string): string {
  const line = [...(text.trim().split('\n')[0] ?? '')];
  if (line.length === 0) return '未知错误';
  return line.length > 200 ? `${line.slice(0, 200).join('')}…` : line.join('');
}

/**
 * Startup: open delegated items whose sessions went away while the service
 * was down. No worker: the item failed, and its delegating session (if any)
 * hears so. No delegating session: the item stops, nobody to report to.
 */
export function reconcileDelegatedWorkItems(): void {
  for (const item of listOpenDelegatedWorkItems()) {
    if (!hasWorkerSession(item)) {
      failDelegatedItem(item, WORKER_GONE_REPORT);
    } else if (!originSessionOf(item)) {
      stopDelegatedItem(item, 'origin_deleted')();
    }
  }
}

/** Run one team tool call; never throws. */
export async function handleWorkIpc(
  caller: WorkIpcCaller,
  request: { type: string } & Record<string, unknown>,
): Promise<WorkIpcResult> {
  try {
    let data: unknown;
    switch (request.type) {
      case 'work_route':
        data = await handleWorkRoute(caller, request);
        break;
      case 'work_reply':
        data = handleWorkReply(caller, request);
        break;
      case 'work_list':
        data = handleWorkList(caller, request);
        break;
      case 'work_report':
        data = handleWorkReport(caller, request);
        break;
      case 'work_ack':
        data = handleWorkAck(caller, request);
        break;
      case 'work_handback':
        data = handleWorkHandback(caller, request);
        break;
      case 'work_delegate':
        data = await handleWorkDelegate(caller, request);
        break;
      case 'work_delegations':
        data = handleWorkDelegations(caller);
        break;
      case 'work_stop':
        data = handleWorkStop(caller, request);
        break;
      case 'work_followup':
        data = handleWorkFollowup(caller, request);
        break;
      default:
        fail('Unknown team tool.');
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof WorkIpcError || error instanceof WorkItemError) {
      return { ok: false, error: error.message };
    }
    logger.error(
      { err: error, type: request.type, agentId: caller.agentId },
      'Team tool call failed unexpectedly',
    );
    return { ok: false, error: 'Internal error while handling the team tool.' };
  }
}

// ── Session deletion ───────────────────────────────────────────────────

/**
 * A deleted session leaves no live team state behind: its work item ends
 * stopped (nothing can run it any more), and a deleted router stops routing
 * until the group's settings are saved again (which creates a new one). A
 * deleted delegated worker's session hears that its item stopped; a deleted
 * delegating session stops every item it delegated.
 * Writes rows only; returns what follows (inputs, lane stops, Web updates),
 * to run once the caller's transaction commits.
 */
export function onTeamSessionDeleted(agentId: string): () => void {
  const after: (() => unknown)[] = [];
  const item = getWorkItemByAgent(agentId);
  if (item?.status === 'open' && item.origin === 'delegated') {
    // Its delegating session hears that it stopped, once this commits.
    after.push(stopDelegatedItem(item, 'session_deleted'));
  } else if (item?.status === 'open') {
    const stopped = stopItem(item, 'session_deleted', false);
    after.push(() => broadcast(stopped));
  }
  // A deleted delegating session stops what it delegated: nobody is left to
  // report to.
  for (const delegated of listOpenDelegatedWorkItems(agentId)) {
    after.push(stopDelegatedItem(delegated, 'origin_deleted'));
  }
  const team = getTeamMountByRouter(agentId);
  if (team) {
    storeTeamMountSettings({
      channelJid: team.channelJid,
      workspaceJid: team.workspaceJid,
      settings: team.settings,
      routerAgentId: null,
      updatedBy: null,
      now: now(),
    });
  }
  return () => {
    for (const step of after) step();
  };
}

/** Open work items of a group, for `/status`. */
export function countOpenWorkItems(channelJid: string): number {
  return countWorkItemsByChannel(channelJid, 'open');
}

/** IPC request types of tools that are not their own name. */
const IPC_TYPE_TOOL: Record<string, string> = {
  message: 'send_message',
  image: 'send_image',
};

/**
 * Why a team session's IPC request is refused, or null when it may run. One
 * table for both sides (TEAM_LANE_POLICY): the Runner does not register these
 * tools, and the host refuses their requests. Of the Feishu capabilities a
 * team session keeps exactly the reads (an allowlist, so a new capability
 * stays refused until it is added there).
 */
export function teamIpcRefusal(
  type: string,
  operation: string | undefined,
): string | null {
  if (type === 'feishu_capability') {
    return operation &&
      (TEAM_LANE_POLICY.feishuReadOperations as readonly string[]).includes(
        operation,
      )
      ? null
      : TEAM_SESSION_TOOL_REFUSAL;
  }
  return teamLaneWithholdsTool(IPC_TYPE_TOOL[type] ?? type)
    ? TEAM_SESSION_TOOL_REFUSAL
    : null;
}

const TEAM_SESSION_TOOL_REFUSAL =
  'Team-mode sessions use only their work tools and Feishu reads: a router replies with work_reply; a worker acknowledges with work_ack and reports with work_report. Messages, files, cards, automations and Skill changes are not theirs to make.';
