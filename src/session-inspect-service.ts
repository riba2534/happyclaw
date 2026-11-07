/**
 * Session inspection (`session_list`, `session_get`): a read-only view of the
 * runtime state of the calling owner's sessions, for the Agent tools of the
 * same names.
 *
 * Everything is read in the host process: the durable state from SQLite and
 * the live state from GroupQueue and the stream snapshots (passed in as
 * dependencies). Nothing here writes, and the Runner never reads the database.
 *
 * Who may see what is decided here, never by the Runner:
 *  - The caller is the IPC namespace the request was read from (folder and
 *    session id), never the request body.
 *  - Only the calling workspace's owner's workspaces are ever visible, and a
 *    workspace that is missing or not visible answers `not_found`, whatever
 *    the reason, so a name cannot be used to probe for it.
 *  - A non-Home workspace sees itself only. The Home workspace sees every
 *    workspace of its owner, and must name the workspace it looks into: a bare
 *    session id never searches across workspaces.
 *  - A Host workspace is visible only while its owner is admin, as on the Web
 *    (canViewHostGroup).
 *  - A turn the workspace owner did not start (a group member, an automation
 *    run, a worker report) is clamped to status fields of its own workspace:
 *    no message text, no traces, no tool inputs, no other workspace.
 */

import {
  countQueuedFollowUpsByChat,
  getAgent,
  getAgentProfileForWorkspace,
  getGroupsByOwner,
  getLatestVisibleMessagePerChat,
  getMessagesPage,
  getRegisteredGroup,
  getSessionModelSelectionDetail,
  getTurnTrace,
  getUserById,
  getUserPinnedSessions,
  listAgentsByJid,
} from './db.js';
import { isCancelledInput } from './follow-up-policy.js';
import { findSessionsBySpec, findWorkspaceBySpec } from './im-command-utils.js';
import {
  listWaitingUsageLimitWaits,
  type UsageLimitWait,
} from './runtime-state-store.js';
import { getSessionWorktree } from './session-worktree-store.js';
import { presentTurnTrace, resolveTurnTraceExposure } from './turn-trace.js';
import { STOPPED_PREVIEW } from './stream-steps.js';
import { getWorkItemsByAgents } from './work-item-store.js';
import { laneJidOf } from './work-item-runtime.js';
import {
  deriveWorkStage,
  stageNeedsPerson,
  type WorkItem,
  type WorkStage,
} from './work-items.js';
import { logger } from './logger.js';
import { sessionActivityAt, sortSessionsForList } from './session-order.js';
import type { SubAgent } from './types.js';
import type { QueueGroupStatus } from './group-queue.js';

export const SESSION_INSPECT_IPC_TYPES = [
  'session_list',
  'session_get',
] as const;
export type SessionInspectIpcType = (typeof SESSION_INSPECT_IPC_TYPES)[number];

export function isSessionInspectIpcType(
  type: unknown,
): type is SessionInspectIpcType {
  return (SESSION_INSPECT_IPC_TYPES as readonly unknown[]).includes(type);
}

// ── Limits ──────────────────────────────────────────────────────────────

/**
 * Message text and traces of one `session_get`, in UTF-8 bytes as the Runner
 * prints them (renderedBytes).
 */
export const SESSION_INSPECT_BODY_BUDGET_BYTES = 32 * 1024;
/** Session entries of one `session_list`, measured the same way. */
export const SESSION_LIST_BUDGET_BYTES = 24 * 1024;
export const SESSION_LIST_DEFAULT_LIMIT = 30;
export const SESSION_LIST_MAX_LIMIT = 100;
export const SESSION_GET_DEFAULT_MESSAGES = 10;
export const SESSION_GET_MAX_MESSAGES = 30;
/** Characters of the latest message shown in a session list entry. */
export const SESSION_PREVIEW_CHARS = 200;
/** Characters read for a preview: room for blanks that collapse. */
const PREVIEW_READ_CHARS = SESSION_PREVIEW_CHARS * 4;
/** Characters of one message shown by `session_get`. */
const MESSAGE_CHARS = 4000;
/** Turns whose traces `include_traces` adds, newest first. */
const TRACE_TURNS = 5;
const TRACE_TOOLS_PER_TURN = 30;
const TRACE_TEXT_CHARS = 160;
const SHORT_ID_CHARS = 8;
/** Nesting of a list entry in the result: workspaces[].sessions[]. */
const LIST_ENTRY_DEPTH = 4;
/** Nesting of a message or trace in the `session_get` result. */
const BODY_ITEM_DEPTH = 2;
/** The keys and brackets of the messages and traces arrays. */
const BODY_FRAME_BYTES = 64;

const NOT_FOUND =
  'not_found: 没有这个会话或工作区，或者你无权查看。session_list 可列出能查看的会话。';
const OWNER_TURN_REQUIRED =
  'owner_turn_required: 本轮不是工作区主人亲自发起的，只能查看本工作区会话的运行状态，不能跨工作区，也不能读取消息和执行轨迹。';
const UNAVAILABLE = 'unavailable: 当前会话不能使用会话查询。';
const AMBIGUOUS =
  'ambiguous: 匹配到多个会话，请写更长的短 ID。候选会话在下面的数据里。';

// ── Types ───────────────────────────────────────────────────────────────

/** What a running session is doing, from its stream snapshot (web.ts). */
export interface SessionLiveActivity {
  activeTools: Array<{
    name: string;
    elapsedSeconds: number | null;
    summary: string | null;
  }>;
  activeSubagents: Array<{
    title: string;
    status: string;
    type: string | null;
  }>;
  compacting: boolean;
  latestProgress: { at: number; text: string } | null;
  updatedAt: number;
}

export interface SessionInspectDeps {
  queueStatus: () => { groups: QueueLane[]; waitingGroupJids: string[] };
  liveActivity: (laneJid: string) => SessionLiveActivity | null;
  now?: () => number;
}

export interface SessionInspectCaller {
  /** Folder of the IPC namespace the request came from. */
  folder: string;
  /** Session of the IPC namespace the request came from. */
  agentId: string;
  /**
   * Whether the turn the request names is the workspace owner's own human
   * input (the install_skill rule); false for a stale or missing turn.
   */
  ownerTurn: (inputTurnId: string | null) => boolean;
}

export type SessionInspectResult =
  | { ok: true; data: unknown }
  /**
   * `data`, when present, is shown fenced as untrusted beside the error: the
   * session names of an ambiguous match.
   */
  | { ok: false; error: string; data?: unknown };

export type SessionRuntimeState =
  | 'running'
  | 'queued_slot'
  | 'rate_limited'
  | 'waiting_human'
  | 'warm_idle'
  | 'idle'
  | 'error';

class InspectError extends Error {
  constructor(
    message: string,
    /** Shown fenced as untrusted beside the error (session names). */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function fail(message: string, data?: unknown): never {
  throw new InspectError(message, data);
}

interface WorkspaceRef {
  jid: string;
  folder: string;
  name: string;
  isHome: boolean;
}

interface Scope {
  ownerId: string;
  /** Host workspaces are visible only while the owner is admin. */
  ownerIsAdmin: boolean;
  /** The turn is the owner's own; otherwise the view is clamped. */
  ownerTurn: boolean;
  isHome: boolean;
  /** The calling session and its workspace. */
  self: SubAgent;
  own: WorkspaceRef;
}

type QueueLane = Pick<
  QueueGroupStatus,
  'jid' | 'active' | 'queryInFlight' | 'queryStartedAt'
>;

interface Snapshot {
  queueByLane: Map<string, QueueLane>;
  /** Position (from 0) of each lane waiting for a container slot. */
  waitingIndex: Map<string, number>;
  /** Lanes parked on the usage limit. */
  limitWaits: Map<string, UsageLimitWait>;
  pins: Record<string, string>;
  nowMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncate(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}

function oneLine(text: string, limit: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), limit);
}

function shortId(id: string): string {
  return id.slice(0, SHORT_ID_CHARS);
}

/**
 * Bytes `value` adds to the tool result as the Runner prints it
 * (untrustedChannelData in container/agent-runner/src/mcp-tools.ts: JSON
 * indented by two, `<`, `>` and `&` as six-byte \u escapes) when it is an
 * array element `depth` levels deep, its `,\n` separator included.
 */
function renderedBytes(value: unknown, depth: number): number {
  const json = JSON.stringify(value, null, 2) ?? 'null';
  const escaped = json.match(/[<>&]/g)?.length ?? 0;
  const lines = json.split('\n').length;
  return Buffer.byteLength(json, 'utf8') + escaped * 5 + lines * depth * 2 + 2;
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

function optionalInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${name} 必须是整数。`);
  }
  if (value < min || value > max)
    fail(`${name} 必须在 ${min} 到 ${max} 之间。`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${name} 必须是字符串。`);
  const text = value.trim();
  return text || undefined;
}

function optionalBool(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(`${name} 必须是布尔值。`);
  return value;
}

// ── Scope ───────────────────────────────────────────────────────────────

function resolveScope(
  caller: SessionInspectCaller,
  inputTurnId: string | null,
): Scope {
  const self = getAgent(caller.agentId);
  if (
    !self ||
    self.kind !== 'conversation' ||
    self.group_folder !== caller.folder ||
    // Team routers and workers (including delegated Workers) never inspect.
    self.source_kind === 'team_router' ||
    self.source_kind === 'work_item'
  ) {
    fail(UNAVAILABLE);
  }
  const group = getRegisteredGroup(self.chat_jid);
  if (!group?.created_by || !self.chat_jid.startsWith('web:'))
    fail(UNAVAILABLE);
  const owner = getUserById(group.created_by);
  if (!owner || owner.status !== 'active') fail(UNAVAILABLE);
  const ownerIsAdmin = owner.role === 'admin';
  if (isHostWorkspace(group) && !ownerIsAdmin) fail(UNAVAILABLE);
  return {
    ownerId: owner.id,
    ownerIsAdmin,
    ownerTurn: caller.ownerTurn(inputTurnId),
    isHome: !!group.is_home,
    self,
    own: {
      jid: self.chat_jid,
      folder: group.folder,
      name: group.name,
      isHome: !!group.is_home,
    },
  };
}

function isHostWorkspace(group: { executionMode?: string | null }): boolean {
  return (group.executionMode ?? 'container') === 'host';
}

/**
 * The owner's workspaces (Web JIDs, one per folder), the caller's first.
 * Host workspaces count only while the owner is admin.
 */
function ownerWorkspaces(scope: Scope): WorkspaceRef[] {
  const seen = new Set<string>();
  const list: WorkspaceRef[] = [];
  for (const group of getGroupsByOwner(scope.ownerId)) {
    if (!group.jid.startsWith('web:') || seen.has(group.folder)) continue;
    if (isHostWorkspace(group) && !scope.ownerIsAdmin) continue;
    seen.add(group.folder);
    list.push({
      jid: group.jid,
      folder: group.folder,
      name: group.name,
      isHome: !!group.is_home,
    });
  }
  return list.sort((a, b) => {
    if (a.folder === scope.own.folder) return -1;
    if (b.folder === scope.own.folder) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The workspace a spec names, if the caller may look into it. The calling
 * workspace always qualifies. Any other one needs the Home workspace and the
 * owner's own turn; everything else is `not_found` (or, for a clamped Home
 * turn, the turn rule: no lookup happens, so nothing is revealed).
 */
function workspaceForSpec(scope: Scope, spec: string): WorkspaceRef {
  if (findWorkspaceBySpec([scope.own], spec)) return scope.own;
  if (!scope.isHome) fail(NOT_FOUND);
  if (!scope.ownerTurn) fail(OWNER_TURN_REQUIRED);
  return findWorkspaceBySpec(ownerWorkspaces(scope), spec) ?? fail(NOT_FOUND);
}

// ── Session state ───────────────────────────────────────────────────────

function takeSnapshot(deps: SessionInspectDeps, scope: Scope): Snapshot {
  const status = deps.queueStatus();
  const waitingIndex = new Map<string, number>();
  status.waitingGroupJids.forEach((jid, index) => {
    if (!waitingIndex.has(jid)) waitingIndex.set(jid, index);
  });
  return {
    queueByLane: new Map(status.groups.map((group) => [group.jid, group])),
    waitingIndex,
    limitWaits: new Map(
      listWaitingUsageLimitWaits().map((wait) => [wait.scopeKey, wait]),
    ),
    pins: getUserPinnedSessions(scope.ownerId),
    nowMs: (deps.now ?? Date.now)(),
  };
}

interface Classified {
  agent: SubAgent;
  laneJid: string;
  state: SessionRuntimeState;
  /** Fields that come with the state: timing, queue position, work item. */
  stateFields: Record<string, unknown>;
  ended: boolean;
  queuedInputs: number;
}

function liveView(
  live: SessionLiveActivity | null,
  clamped: boolean,
): Record<string, unknown> | null {
  if (!live) return null;
  return {
    compacting: live.compacting,
    tools: live.activeTools.map((tool) => ({
      name: tool.name,
      ...(clamped
        ? {}
        : {
            elapsed_seconds: tool.elapsedSeconds,
            input: tool.summary
              ? oneLine(tool.summary, TRACE_TEXT_CHARS)
              : null,
          }),
    })),
    subagents: live.activeSubagents.map((task) => ({
      status: task.status,
      type: task.type,
      ...(clamped ? {} : { title: oneLine(task.title, TRACE_TEXT_CHARS) }),
    })),
    ...(clamped || !live.latestProgress
      ? {}
      : {
          latest_progress: {
            at: iso(live.latestProgress.at),
            text: oneLine(live.latestProgress.text, SESSION_PREVIEW_CHARS),
          },
        }),
  };
}

function previewOf(
  latest:
    | { content: string; timestamp: string; is_from_me: boolean }
    | undefined,
): Record<string, unknown> | null {
  if (!latest) return null;
  const text = oneLine(latest.content, SESSION_PREVIEW_CHARS);
  if (!text) return null;
  return {
    role: latest.is_from_me ? 'agent' : 'user',
    at: latest.timestamp,
    text,
  };
}

/**
 * Whether the session's last turn failed. A conversation settles back to
 * `idle` with the error kept in `result_summary` (possibly empty) until its
 * next turn starts and clears it; only spawn-style rows end as `error`.
 */
function lastTurnFailed(agent: SubAgent): boolean {
  return (
    agent.status === 'error' ||
    (agent.status === 'idle' && agent.result_summary != null)
  );
}

/**
 * The state of each of a workspace's sessions, from the snapshot and two
 * batched reads (queued inputs, work items), however many sessions there are.
 */
function classifySessions(
  deps: SessionInspectDeps,
  scope: Scope,
  snapshot: Snapshot,
  agents: SubAgent[],
): Classified[] {
  const laneJids = agents.map((agent) => laneJidOf(agent.chat_jid, agent.id));
  const queued = countQueuedFollowUpsByChat(laneJids);
  const workItems = getWorkItemsByAgents(agents.map((agent) => agent.id));
  return agents.map((agent, index) =>
    classify(
      deps,
      scope,
      snapshot,
      agent,
      laneJids[index],
      workItems.get(agent.id),
      queued.get(laneJids[index]) ?? 0,
    ),
  );
}

/**
 * One session's state. `active` is not "running": a warm runner waits for its
 * next input with the process alive, which is `warm_idle`; only a query in
 * flight is `running`.
 */
function classify(
  deps: SessionInspectDeps,
  scope: Scope,
  snapshot: Snapshot,
  agent: SubAgent,
  laneJid: string,
  workItem: WorkItem | undefined,
  queuedInputs: number,
): Classified {
  const clamped = !scope.ownerTurn;
  const queue = snapshot.queueByLane.get(laneJid);
  const stage: WorkStage | null = workItem ? deriveWorkStage(workItem) : null;
  const fields: Record<string, unknown> = {};
  let state: SessionRuntimeState;

  const waitingIndex = snapshot.waitingIndex.get(laneJid);
  const limitWait = snapshot.limitWaits.get(laneJid);
  if (queue?.queryInFlight) {
    state = 'running';
    fields.started_at = iso(queue.queryStartedAt);
    if (queue.queryStartedAt) {
      fields.elapsed_seconds = Math.max(
        0,
        Math.round((snapshot.nowMs - queue.queryStartedAt) / 1000),
      );
    }
    const activity = liveView(deps.liveActivity(laneJid), clamped);
    if (activity) fields.activity = activity;
  } else if (waitingIndex !== undefined && !queue?.active) {
    state = 'queued_slot';
    fields.queue_position = waitingIndex + 1;
  } else if (limitWait) {
    state = 'rate_limited';
    fields.reset_at = limitWait.resetAt;
    fields.resume_at = limitWait.resumeAt;
  } else if (workItem?.status === 'open' && stage && stageNeedsPerson(stage)) {
    state = 'waiting_human';
    fields.work_stage = stage;
    fields.work_item = clamped
      ? { seq: workItem.seq }
      : {
          seq: workItem.seq,
          title: oneLine(workItem.title, TRACE_TEXT_CHARS),
          ...(workItem.attention
            ? { question: oneLine(workItem.attention, SESSION_PREVIEW_CHARS) }
            : {}),
        };
  } else if (lastTurnFailed(agent)) {
    state = 'error';
    const summary = clamped
      ? ''
      : oneLine(agent.result_summary ?? '', SESSION_PREVIEW_CHARS);
    if (summary) fields.error_summary = summary;
  } else if (queue?.active) {
    state = 'warm_idle';
  } else {
    state = 'idle';
  }

  // A temporary session that is over folds away whatever its last turn did.
  const ended =
    (agent.source_kind === 'automation' || agent.source_kind === 'work_item') &&
    (state === 'idle' || state === 'warm_idle' || state === 'error') &&
    (agent.status === 'completed' || workItem?.status === 'ended');

  return {
    agent,
    laneJid,
    state,
    stateFields: fields,
    ended,
    queuedInputs,
  };
}

/**
 * The entries of the sessions actually returned. Worktree, model and latest
 * message are read for these alone, the previews in one batched read and the
 * workspace's agent profile at most once.
 */
function presentSessions(
  scope: Scope,
  workspace: WorkspaceRef,
  items: Classified[],
): Array<Record<string, unknown>> {
  if (items.length === 0) return [];
  const previews = scope.ownerTurn
    ? getLatestVisibleMessagePerChat(
        items.map((item) => item.laneJid),
        PREVIEW_READ_CHARS,
      )
    : null;
  let profileModel: string | null | undefined;
  const workspaceModel = (): string | null => {
    if (profileModel === undefined) {
      profileModel =
        getAgentProfileForWorkspace(workspace.folder, scope.ownerId)?.model ??
        null;
    }
    return profileModel;
  };
  return items.map((item) => {
    const { agent } = item;
    const worktree = getSessionWorktree(agent.id);
    const selection = getSessionModelSelectionDetail(
      workspace.folder,
      agent.id,
    );
    const entry: Record<string, unknown> = {
      id: shortId(agent.id),
      name: agent.name,
      source_kind: agent.source_kind ?? 'manual',
      runtime_state: item.state,
      ...item.stateFields,
      queued_inputs: item.queuedInputs,
      worktree_branch: worktree?.branch ?? null,
      model: selection?.model ?? workspaceModel(),
      last_active_at: sessionActivityAt(agent),
      ...(agent.id === scope.self.id ? { is_self: true } : {}),
      ...(item.ended ? { ended: true } : {}),
    };
    if (previews) entry.latest_message = previewOf(previews.get(item.laneJid));
    return entry;
  });
}

// ── session_list ────────────────────────────────────────────────────────

type StateFilter = 'running' | 'busy' | 'error' | 'all';

function matchesFilter(item: Classified, filter: StateFilter): boolean {
  switch (filter) {
    case 'running':
      return item.state === 'running';
    case 'busy':
      return (
        item.state === 'running' ||
        item.state === 'queued_slot' ||
        item.state === 'rate_limited' ||
        item.queuedInputs > 0
      );
    case 'error':
      return item.state === 'error';
    default:
      return true;
  }
}

function workspaceSessions(
  scope: Scope,
  snapshot: Snapshot,
  workspace: WorkspaceRef,
): SubAgent[] {
  return sortSessionsForList(
    listAgentsByJid(workspace.jid)
      .filter((agent) => agent.kind === 'conversation')
      .map((agent) => ({
        ...agent,
        pinned_at: snapshot.pins[agent.id] ?? null,
      })),
  );
}

function sessionList(
  deps: SessionInspectDeps,
  scope: Scope,
  request: Record<string, unknown>,
): unknown {
  const stateArg = optionalString(request.state, 'state') ?? 'all';
  if (!['running', 'busy', 'error', 'all'].includes(stateArg)) {
    fail('state 只能是 running、busy、error 或 all。');
  }
  const filter = stateArg as StateFilter;
  const limit = optionalInt(
    request.limit,
    'limit',
    1,
    SESSION_LIST_MAX_LIMIT,
    SESSION_LIST_DEFAULT_LIMIT,
  );
  const includeEnded = optionalBool(request.include_ended, 'include_ended');
  const workspaceSpec = optionalString(request.workspace, 'workspace');
  const allWorkspaces = optionalBool(request.all_workspaces, 'all_workspaces');

  let workspaces: WorkspaceRef[];
  if (allWorkspaces) {
    if (!scope.isHome) fail(NOT_FOUND);
    if (!scope.ownerTurn) fail(OWNER_TURN_REQUIRED);
    workspaces = ownerWorkspaces(scope);
  } else if (workspaceSpec) {
    workspaces = [workspaceForSpec(scope, workspaceSpec)];
  } else {
    workspaces = [scope.own];
  }

  const snapshot = takeSnapshot(deps, scope);
  let remaining = limit;
  let budget = SESSION_LIST_BUDGET_BYTES;
  let overBudget = false;
  const result = workspaces.map((workspace) => {
    const classified = classifySessions(
      deps,
      scope,
      snapshot,
      workspaceSessions(scope, snapshot, workspace),
    );
    const counts: Record<string, number> = {
      total: classified.length,
      running: 0,
      queued_slot: 0,
      rate_limited: 0,
      waiting_human: 0,
      warm_idle: 0,
      idle: 0,
      error: 0,
      queued_inputs: 0,
      ended_hidden: 0,
    };
    // A folded session counts as hidden only, not in the state it ended in:
    // otherwise `error: 1` would point at a session `state: 'error'` never
    // lists. total = the state buckets + ended_hidden.
    for (const item of classified) {
      if (item.ended && !includeEnded) {
        counts.ended_hidden += 1;
        continue;
      }
      counts[item.state] += 1;
      counts.queued_inputs += item.queuedInputs;
    }
    const shown = classified.filter(
      (item) => (includeEnded || !item.ended) && matchesFilter(item, filter),
    );
    const page = overBudget ? [] : shown.slice(0, Math.max(0, remaining));
    // Entries are added while they fit the output budget; the first one that
    // does not ends the list, in this workspace and the ones after it.
    const sessions: Array<Record<string, unknown>> = [];
    for (const entry of presentSessions(scope, workspace, page)) {
      const size = renderedBytes(entry, LIST_ENTRY_DEPTH);
      if (size > budget) {
        overBudget = true;
        break;
      }
      budget -= size;
      sessions.push(entry);
    }
    remaining -= sessions.length;
    return {
      workspace: {
        name: workspace.name,
        folder: workspace.folder,
        is_home: workspace.isHome,
        ...(workspace.folder === scope.own.folder ? { is_current: true } : {}),
      },
      counts,
      sessions,
      ...(shown.length > sessions.length
        ? { omitted: shown.length - sessions.length }
        : {}),
    };
  });
  return {
    ...(scope.ownerTurn
      ? {}
      : { clamped: '本轮不是工作区主人发起的，只显示本工作区的运行状态。' }),
    ...(overBudget
      ? {
          truncated: `结果超过 ${SESSION_LIST_BUDGET_BYTES / 1024} KiB，后面的会话没有列出（见各工作区的 omitted）；可以用 state、workspace 或更小的 limit 缩小范围。`,
        }
      : {}),
    workspaces: result,
  };
}

// ── session_get ─────────────────────────────────────────────────────────

function resolveSession(
  scope: Scope,
  snapshot: Snapshot,
  spec: string,
): { agent: SubAgent; workspace: WorkspaceRef } {
  const inWorkspace = (
    workspace: WorkspaceRef,
    sessionSpec: string,
  ): SubAgent => {
    const matches = findSessionsBySpec(
      workspaceSessions(scope, snapshot, workspace),
      sessionSpec,
    );
    if (matches.length === 0) fail(NOT_FOUND);
    if (matches.length > 1) {
      // Names can come from anyone's messages: they travel as data, which
      // the Runner fences as untrusted, never in the error text.
      fail(AMBIGUOUS, {
        candidates: matches.map((item) => ({
          id: shortId(item.id),
          name: item.name,
        })),
      });
    }
    return matches[0];
  };

  if (spec.toLowerCase() === 'self') {
    return { agent: scope.self, workspace: scope.own };
  }
  // A session name may itself contain a slash: try the whole spec in the
  // calling workspace before reading it as <工作区>/<会话>.
  const direct = findSessionsBySpec(
    workspaceSessions(scope, snapshot, scope.own),
    spec,
  );
  if (direct.length > 0 || !spec.includes('/')) {
    return { agent: inWorkspace(scope.own, spec), workspace: scope.own };
  }
  const slash = spec.indexOf('/');
  const workspace = workspaceForSpec(scope, spec.slice(0, slash));
  const sessionSpec = spec.slice(slash + 1).trim();
  if (!sessionSpec) fail('请在 / 后写会话短 ID 或名称：<工作区>/<会话>。');
  return { agent: inWorkspace(workspace, sessionSpec), workspace };
}

interface TraceTool {
  tool: string;
  status: string;
  duration_ms: number | null;
  input?: string;
  error?: string;
}

function turnTraces(
  agent: SubAgent,
  laneJid: string,
  workspace: WorkspaceRef,
  turnIds: string[],
): Array<{ turn_id: string; tools: TraceTool[] }> {
  const exposure = resolveTurnTraceExposure(workspace.folder, {
    agentKind: agent.kind,
  });
  const traces: Array<{ turn_id: string; tools: TraceTool[] }> = [];
  for (const turnId of turnIds) {
    const record = getTurnTrace(laneJid, turnId);
    const presented = record ? presentTurnTrace(record, exposure) : null;
    if (!presented) continue;
    const tools: TraceTool[] = presented.steps
      .filter((step) => step.kind === 'tool' && step.toolName)
      .map((step) => {
        // A stopped or denied call is stored as `error` with an outcome (or,
        // before outcomes were kept, the stopped preview); it did not fail.
        const ended =
          step.status === 'error'
            ? (step.outcome ??
              (step.resultPreview === STOPPED_PREVIEW ? 'stopped' : undefined))
            : undefined;
        return { step, status: ended ?? step.status };
      })
      .map(({ step, status }) => ({
        tool: step.toolName as string,
        status,
        duration_ms:
          step.endedAt !== undefined
            ? Math.max(0, step.endedAt - step.at)
            : null,
        ...(step.summary
          ? { input: oneLine(step.summary, TRACE_TEXT_CHARS) }
          : {}),
        ...(status === 'error' && step.resultPreview
          ? { error: oneLine(step.resultPreview, TRACE_TEXT_CHARS) }
          : {}),
      }))
      .slice(-TRACE_TOOLS_PER_TURN);
    traces.push({ turn_id: turnId, tools });
  }
  return traces;
}

function sessionGet(
  deps: SessionInspectDeps,
  scope: Scope,
  request: Record<string, unknown>,
): unknown {
  const spec = optionalString(request.session, 'session');
  if (!spec) fail('session 必填：self、会话短 ID 或名称。');
  const messageLimit = optionalInt(
    request.message_limit,
    'message_limit',
    0,
    SESSION_GET_MAX_MESSAGES,
    SESSION_GET_DEFAULT_MESSAGES,
  );
  const includeTraces = optionalBool(request.include_traces, 'include_traces');

  const snapshot = takeSnapshot(deps, scope);
  const { agent, workspace } = resolveSession(scope, snapshot, spec);
  const [classified] = classifySessions(deps, scope, snapshot, [agent]);
  const [entry] = presentSessions(scope, workspace, [classified]);
  const session = {
    workspace: { name: workspace.name, folder: workspace.folder },
    ...entry,
  };
  if (!scope.ownerTurn) {
    return {
      clamped: '本轮不是工作区主人发起的，只返回运行状态，不含消息和执行轨迹。',
      session,
    };
  }

  const out: Record<string, unknown> = { session };
  const wantMessages = messageLimit > 0;
  if (!wantMessages && !includeTraces) return out;

  // Newest first, then budgeted from the newest so the cut falls on old ones.
  // Cancelled inputs are not history: read a margin past them.
  const wanted = Math.max(
    messageLimit,
    includeTraces ? SESSION_GET_MAX_MESSAGES : 0,
  );
  const rows = getMessagesPage(classified.laneJid, undefined, wanted * 2)
    .filter((row) => !isCancelledInput(row))
    .slice(0, wanted);
  // The keys and brackets around the two arrays.
  let used = BODY_FRAME_BYTES;
  const fits = (value: unknown): boolean => {
    const size = renderedBytes(value, BODY_ITEM_DEPTH);
    if (used + size > SESSION_INSPECT_BODY_BUDGET_BYTES) return false;
    used += size;
    return true;
  };
  let omittedMessages = 0;
  let omittedTraces = 0;
  if (wantMessages) {
    const candidates = rows.slice(0, messageLimit);
    const messages: Array<Record<string, unknown>> = [];
    for (const row of candidates) {
      const item: Record<string, unknown> = {
        at: row.timestamp,
        role:
          row.sender === '__system__'
            ? 'system'
            : row.is_from_me
              ? 'agent'
              : 'user',
        ...(row.is_from_me ? {} : { sender: row.sender_name }),
        ...(row.delivery_status === 'queued' ||
        row.delivery_status === 'promoting'
          ? { queued: true }
          : {}),
        text: truncate(row.content ?? '', MESSAGE_CHARS),
      };
      // The first one that does not fit ends the history: no holes.
      if (!fits(item)) break;
      messages.push(item);
    }
    omittedMessages = candidates.length - messages.length;
    messages.reverse();
    out.messages = messages;
    if (omittedMessages > 0) out.messages_omitted = omittedMessages;
  }

  if (includeTraces) {
    const turnIds: string[] = [];
    for (const row of rows) {
      if (row.is_from_me && row.turn_id && !turnIds.includes(row.turn_id)) {
        turnIds.push(row.turn_id);
        if (turnIds.length >= TRACE_TURNS) break;
      }
    }
    const all = turnTraces(agent, classified.laneJid, workspace, turnIds);
    const traces: Array<{ turn_id: string; tools: TraceTool[] }> = [];
    for (const trace of all) {
      if (!fits(trace)) break;
      traces.push(trace);
    }
    omittedTraces = all.length - traces.length;
    out.traces = traces;
    if (omittedTraces > 0) out.traces_omitted = omittedTraces;
  }

  if (omittedMessages > 0 || omittedTraces > 0) {
    const parts = [
      ...(omittedMessages > 0 ? [`更早的 ${omittedMessages} 条消息`] : []),
      ...(omittedTraces > 0 ? [`更早的 ${omittedTraces} 轮轨迹`] : []),
    ];
    out.truncated = `消息和轨迹合计超过 ${SESSION_INSPECT_BODY_BUDGET_BYTES / 1024} KiB，${parts.join('和')}没有返回。`;
  }
  return out;
}

// ── Entry ───────────────────────────────────────────────────────────────

/** Run one `session_list` / `session_get` call; never throws. */
export function handleSessionInspectIpc(
  deps: SessionInspectDeps,
  caller: SessionInspectCaller,
  request: { type: string } & Record<string, unknown>,
): SessionInspectResult {
  try {
    const inputTurnId =
      typeof request.inputTurnId === 'string' && request.inputTurnId
        ? request.inputTurnId
        : null;
    const scope = resolveScope(caller, inputTurnId);
    switch (request.type) {
      case 'session_list':
        return { ok: true, data: sessionList(deps, scope, request) };
      case 'session_get':
        return { ok: true, data: sessionGet(deps, scope, request) };
      default:
        return { ok: false, error: 'Unknown session tool.' };
    }
  } catch (error) {
    if (error instanceof InspectError) {
      return {
        ok: false,
        error: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      };
    }
    logger.error(
      { err: error, type: request.type, agentId: caller.agentId },
      'Session inspection failed unexpectedly',
    );
    return {
      ok: false,
      error: 'Internal error while inspecting sessions.',
    };
  }
}
