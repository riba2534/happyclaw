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
 *  - A turn the workspace owner did not start (a group member, an automation
 *    run, a worker report) is clamped to status fields of its own workspace:
 *    no message text, no traces, no tool inputs, no other workspace.
 */

import {
  getAgent,
  getAgentProfileForWorkspace,
  getGroupsByOwner,
  getMessagesPage,
  getRegisteredGroup,
  getSessionModelSelectionDetail,
  getTurnTrace,
  getUserById,
  getUserPinnedSessions,
  listAgentsByJid,
  listQueuedFollowUps,
} from './db.js';
import { findSessionsBySpec, findWorkspaceBySpec } from './im-command-utils.js';
import { getUsageLimitWait } from './runtime-state-store.js';
import { getSessionWorktree } from './session-worktree-store.js';
import { presentTurnTrace, resolveTurnTraceExposure } from './turn-trace.js';
import { getWorkItemByAgent } from './work-item-store.js';
import { laneJidOf } from './work-item-runtime.js';
import { deriveWorkStage, type WorkStage } from './work-items.js';
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

/** Message text and traces of one `session_get`, in UTF-8 bytes of JSON. */
export const SESSION_INSPECT_BODY_BUDGET_BYTES = 32 * 1024;
export const SESSION_LIST_DEFAULT_LIMIT = 30;
export const SESSION_LIST_MAX_LIMIT = 100;
export const SESSION_GET_DEFAULT_MESSAGES = 10;
export const SESSION_GET_MAX_MESSAGES = 30;
/** Characters of the latest message shown in a session list entry. */
export const SESSION_PREVIEW_CHARS = 200;
/** Characters of one message shown by `session_get`. */
const MESSAGE_CHARS = 4000;
/** Turns whose traces `include_traces` adds, newest first. */
const TRACE_TURNS = 5;
const TRACE_TOOLS_PER_TURN = 30;
const TRACE_TEXT_CHARS = 160;
const SHORT_ID_CHARS = 8;

const NOT_FOUND =
  'not_found: 没有这个会话或工作区，或者你无权查看。session_list 可列出能查看的会话。';
const OWNER_TURN_REQUIRED =
  'owner_turn_required: 本轮不是工作区主人亲自发起的，只能查看本工作区会话的运行状态，不能跨工作区，也不能读取消息和执行轨迹。';
const UNAVAILABLE = 'unavailable: 当前会话不能使用会话查询。';

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
  | { ok: false; error: string };

export type SessionRuntimeState =
  | 'running'
  | 'queued_slot'
  | 'rate_limited'
  | 'waiting_human'
  | 'warm_idle'
  | 'idle'
  | 'error';

class InspectError extends Error {}

function fail(message: string): never {
  throw new InspectError(message);
}

interface WorkspaceRef {
  jid: string;
  folder: string;
  name: string;
  isHome: boolean;
}

interface Scope {
  ownerId: string;
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
  waiting: string[];
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
  return {
    ownerId: owner.id,
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

/** The owner's workspaces (Web JIDs, one per folder), the caller's first. */
function ownerWorkspaces(scope: Scope): WorkspaceRef[] {
  const seen = new Set<string>();
  const list: WorkspaceRef[] = [];
  for (const group of getGroupsByOwner(scope.ownerId)) {
    if (!group.jid.startsWith('web:') || seen.has(group.folder)) continue;
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
  return {
    queueByLane: new Map(status.groups.map((group) => [group.jid, group])),
    waiting: status.waitingGroupJids,
    pins: getUserPinnedSessions(scope.ownerId),
    nowMs: (deps.now ?? Date.now)(),
  };
}

interface Described {
  agent: SubAgent;
  laneJid: string;
  state: SessionRuntimeState;
  entry: Record<string, unknown>;
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

function latestPreview(laneJid: string): Record<string, unknown> | null {
  for (const message of getMessagesPage(laneJid, undefined, 8)) {
    if (message.sender === '__system__') continue;
    const text = oneLine(message.content ?? '', SESSION_PREVIEW_CHARS);
    if (!text) continue;
    return {
      role: message.is_from_me ? 'agent' : 'user',
      at: message.timestamp,
      text,
    };
  }
  return null;
}

/**
 * One session's state. `active` is not "running": a warm runner waits for its
 * next input with the process alive, which is `warm_idle`; only a query in
 * flight is `running`.
 */
function describe(
  deps: SessionInspectDeps,
  scope: Scope,
  snapshot: Snapshot,
  agent: SubAgent,
  workspace: WorkspaceRef,
): Described {
  const clamped = !scope.ownerTurn;
  const laneJid = laneJidOf(agent.chat_jid, agent.id);
  const queue = snapshot.queueByLane.get(laneJid);
  const workItem = getWorkItemByAgent(agent.id);
  const stage: WorkStage | null = workItem ? deriveWorkStage(workItem) : null;
  const queuedInputs = listQueuedFollowUps(laneJid).length;
  const extra: Record<string, unknown> = {};
  let state: SessionRuntimeState;

  const waitingIndex = snapshot.waiting.indexOf(laneJid);
  const limitWait = getUsageLimitWait(laneJid);
  if (queue?.queryInFlight) {
    state = 'running';
    extra.started_at = iso(queue.queryStartedAt);
    if (queue.queryStartedAt) {
      extra.elapsed_seconds = Math.max(
        0,
        Math.round((snapshot.nowMs - queue.queryStartedAt) / 1000),
      );
    }
    const activity = liveView(deps.liveActivity(laneJid), clamped);
    if (activity) extra.activity = activity;
  } else if (waitingIndex >= 0 && !queue?.active) {
    state = 'queued_slot';
    extra.queue_position = waitingIndex + 1;
  } else if (limitWait?.state === 'waiting') {
    state = 'rate_limited';
    extra.reset_at = limitWait.resetAt;
    extra.resume_at = limitWait.resumeAt;
  } else if (
    workItem?.status === 'open' &&
    (stage === 'answer' || stage === 'approval' || stage === 'blocked')
  ) {
    state = 'waiting_human';
    extra.work_stage = stage;
    extra.work_item = clamped
      ? { seq: workItem.seq }
      : {
          seq: workItem.seq,
          title: oneLine(workItem.title, TRACE_TEXT_CHARS),
          ...(workItem.attention
            ? { question: oneLine(workItem.attention, SESSION_PREVIEW_CHARS) }
            : {}),
        };
  } else if (agent.status === 'error') {
    state = 'error';
    if (!clamped && agent.result_summary) {
      extra.error_summary = oneLine(
        agent.result_summary,
        SESSION_PREVIEW_CHARS,
      );
    }
  } else if (queue?.active) {
    state = 'warm_idle';
  } else {
    state = 'idle';
  }

  const worktree = getSessionWorktree(agent.id);
  const selection = getSessionModelSelectionDetail(workspace.folder, agent.id);
  const model =
    selection?.model ??
    getAgentProfileForWorkspace(workspace.folder, scope.ownerId)?.model ??
    null;

  const ended =
    (agent.source_kind === 'automation' || agent.source_kind === 'work_item') &&
    (state === 'idle' || state === 'warm_idle') &&
    (agent.status === 'completed' || workItem?.status === 'ended');

  const entry: Record<string, unknown> = {
    id: shortId(agent.id),
    name: agent.name,
    source_kind: agent.source_kind ?? 'manual',
    runtime_state: state,
    ...extra,
    queued_inputs: queuedInputs,
    worktree_branch: worktree?.branch ?? null,
    model,
    last_active_at: sessionActivityAt(agent),
    ...(agent.id === scope.self.id ? { is_self: true } : {}),
    ...(ended ? { ended: true } : {}),
  };
  if (!clamped) entry.latest_message = latestPreview(laneJid);
  return { agent, laneJid, state, entry, ended, queuedInputs };
}

// ── session_list ────────────────────────────────────────────────────────

type StateFilter = 'running' | 'busy' | 'error' | 'all';

function matchesFilter(item: Described, filter: StateFilter): boolean {
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
  const result = workspaces.map((workspace) => {
    const described = workspaceSessions(scope, snapshot, workspace).map(
      (agent) => describe(deps, scope, snapshot, agent, workspace),
    );
    const counts: Record<string, number> = {
      total: described.length,
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
    for (const item of described) {
      counts[item.state] += 1;
      counts.queued_inputs += item.queuedInputs;
      if (item.ended && !includeEnded) counts.ended_hidden += 1;
    }
    const shown = described.filter(
      (item) => (includeEnded || !item.ended) && matchesFilter(item, filter),
    );
    const page = shown.slice(0, Math.max(0, remaining));
    remaining -= page.length;
    return {
      workspace: {
        name: workspace.name,
        folder: workspace.folder,
        is_home: workspace.isHome,
        ...(workspace.folder === scope.own.folder ? { is_current: true } : {}),
      },
      counts,
      sessions: page.map((item) => item.entry),
      ...(shown.length > page.length
        ? { omitted: shown.length - page.length }
        : {}),
    };
  });
  return {
    ...(scope.ownerTurn
      ? {}
      : { clamped: '本轮不是工作区主人发起的，只显示本工作区的运行状态。' }),
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
      fail(
        [
          '匹配到多个会话，请写更长的短 ID：',
          ...matches.map((item) => `· ${item.name} [${shortId(item.id)}]`),
        ].join('\n'),
      );
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
      .map((step) => ({
        tool: step.toolName as string,
        status: step.status,
        duration_ms:
          step.endedAt !== undefined
            ? Math.max(0, step.endedAt - step.at)
            : null,
        ...(step.summary
          ? { input: oneLine(step.summary, TRACE_TEXT_CHARS) }
          : {}),
        ...(step.status === 'error' && step.resultPreview
          ? { error: oneLine(step.resultPreview, TRACE_TEXT_CHARS) }
          : {}),
      }))
      .slice(-TRACE_TOOLS_PER_TURN);
    traces.push({ turn_id: turnId, tools });
  }
  return traces;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
  const described = describe(deps, scope, snapshot, agent, workspace);
  const session = {
    workspace: { name: workspace.name, folder: workspace.folder },
    ...described.entry,
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
  const rows = getMessagesPage(
    described.laneJid,
    undefined,
    Math.max(messageLimit, includeTraces ? SESSION_GET_MAX_MESSAGES : 0),
  );
  let used = 0;
  const messages: Array<Record<string, unknown>> = [];
  let omittedMessages = 0;
  if (wantMessages) {
    for (const row of rows.slice(0, messageLimit)) {
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
      const size = bytesOf(item);
      if (used + size > SESSION_INSPECT_BODY_BUDGET_BYTES) {
        omittedMessages += 1;
        continue;
      }
      used += size;
      messages.push(item);
    }
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
    const traces: Array<{ turn_id: string; tools: TraceTool[] }> = [];
    let omittedTraces = 0;
    for (const trace of turnTraces(
      agent,
      described.laneJid,
      workspace,
      turnIds,
    )) {
      const size = bytesOf(trace);
      if (used + size > SESSION_INSPECT_BODY_BUDGET_BYTES) {
        omittedTraces += 1;
        continue;
      }
      used += size;
      traces.push(trace);
    }
    out.traces = traces;
    if (omittedTraces > 0) out.traces_omitted = omittedTraces;
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
    if (error instanceof InspectError)
      return { ok: false, error: error.message };
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
