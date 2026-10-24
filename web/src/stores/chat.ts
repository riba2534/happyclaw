import { create } from 'zustand';
import { api, computeUploadTimeoutMs } from '../api/client';
import { useFileStore } from './files';
import { useAuthStore } from './auth';
import {
  showToast,
  notifyIfHidden,
  shouldEmitBackgroundTaskNotice,
  showNotificationPromptToast,
} from '../utils/toast';
import {
  deleteAgentMessageSnapshot,
  deleteGroupMessageSnapshots,
  loadAgentMessageSnapshot,
  saveAgentMessageSnapshot,
} from '../utils/messageSnapshotCache';
import type {
  GroupInfo,
  AgentInfo,
  AvailableImGroup,
  CreateWorkspaceOptions,
  InteractionMode,
  ProcessVisibility,
  WorkspaceDeleteImpact,
} from '../types';
import {
  applyFollowUpTransition,
  syncFollowUpContent,
} from '../lib/message-timeline';
import {
  currentRouteChatFolder,
  findRouteGroupJid,
} from '../lib/route-workspace';
import {
  normalizeGroupInteractionMode,
  normalizeInteractionMode,
} from '../lib/interaction-mode';
import {
  SPEECH_TOOL_NAME,
  filterProactiveStreamEvent,
  isSpeechToolEvent,
  normalizeProcessVisibility,
  scrubTaskStates,
  speechToolCallsIn,
  withoutSpeechTool,
} from '../lib/process-visibility';
import { useGroupsStore } from './groups';
import {
  applyRunFinished,
  applyRunStarted,
  hasExactQueryAttempt,
  runsFromAuthoritativeSnapshot,
  shouldApplyRunScopedPayload,
  shouldDiscardStreamForAuthoritativeRun,
  waitKeysForQueuedChats,
  type ClientActiveRuns,
} from './run-lifecycle';
import { extractErrorMessage } from '../utils/error';
import { markdownTail } from '../lib/markdown-blocks';
import { hasListedSteps } from '../lib/process-steps';
import {
  MAX_THINKING_TEXT,
  capThinkingText,
  extractThinkingTitle,
  thinkingSeparator,
} from '../lib/thinking-text';
import {
  addCommentaryStep,
  appendThinkingText,
  closeOpenSteps,
  closeThinkingStep,
  endToolStep,
  ensureTaskStep,
  failToolStep,
  finishSteps,
  hasTaskStep,
  isUnderTask,
  openTextStep,
  openThinkingStep,
  progressToolStep,
  rebuildSteps,
  setTaskStepStatus,
  startToolStep,
  stepList,
  type StepList,
  type StepStatus,
  type StreamingStep,
} from '../lib/stream-steps';

export type { GroupInfo, AgentInfo };

export interface Message {
  id: string;
  chat_jid: string;
  /** Stable host arrival order used by history and polling cursors. */
  ingest_sequence?: number;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  attachments?: string;
  token_usage?: string;
  workflow_runs?: import('../stream-event.types').WorkflowRunSnapshot[];
  turn_id?: string | null;
  /** The turn kept its reasoning and execution trace on the server. */
  has_trace?: boolean;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?:
    | 'sdk_final'
    | 'sdk_send_message'
    | 'scheduled_task_result'
    | 'interrupt_partial'
    | 'legacy'
    | null;
  finalization_reason?:
    | 'completed'
    | 'delivery_uncertain'
    | 'interrupted'
    | 'error'
    | 'shutdown'
    | 'crash_recovery'
    | 'truncated'
    | null;
  delivery_mode?: FollowUpMode | null;
  delivery_status?:
    | 'queued'
    | 'promoting'
    | 'released'
    | 'cancelled'
    | 'awaiting_companion'
    | 'subsumed'
    | null;
  delivery_run_id?: string | null;
  delivery_updated_at?: string | null;
}

export type FollowUpMode = 'queue' | 'steer';

export type FollowUpQueueAction =
  | 'steer'
  | 'cancel'
  | 'edit'
  | 'move_up'
  | 'move_down';

export interface QueuedFollowUp {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
  delivery_mode: FollowUpMode;
  delivery_status: 'queued' | 'promoting';
  delivery_run_id?: string | null;
  delivery_priority: number;
}

export interface FollowUpTransition {
  id: string;
  delivery_status: 'released' | 'cancelled';
  delivery_run_id?: string | null;
  delivery_updated_at: string;
}

// Streaming event types (canonical source: shared/stream-event.ts)
import type { StreamEventType, StreamEvent } from '../stream-event.types';
export type { StreamEventType, StreamEvent };

export interface StreamingTimelineEvent {
  id: string;
  timestamp: number;
  text: string;
  kind:
    | 'tool'
    | 'skill'
    | 'hook'
    | 'status'
    | 'task'
    | 'memory'
    | 'debug'
    | 'context'
    | 'permission';
}

export interface StreamingTraceEvent {
  id: string;
  timestamp: number;
  kind: StreamingTimelineEvent['kind'];
  scope?: StreamEvent['agentScope'];
  title: string;
  summary?: string;
  detail?: string;
  taskId?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  displayLevel?: StreamEvent['displayLevel'];
}

export interface StreamingTaskRuntimeState {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'error' | 'backgrounded';
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  workflowRun?: StreamEvent['workflowRun'];
  usage?: StreamEvent['sdkTaskUsage'];
  latestSummary?: string;
  lastToolName?: string;
  thinkingTail: string;
  textTail: string;
  activeTools: StreamingState['activeTools'];
  recentTools: StreamingTimelineEvent[];
  updatedAt: number;
}

/** Shape of the snapshot payload pushed from the backend on WS reconnect (stream_snapshot). */
export interface StreamSnapshotData {
  partialText: string;
  thinkingText?: string;
  /** Reasoning time of the finished bursts, and the open one's start. */
  thinkingDurationMs?: number;
  thinkingStartedAt?: number;
  phaseStartedAt?: number;
  awaitingModel?: boolean;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    elapsedSeconds?: number;
    toolInputSummary?: string;
    parentToolUseId?: string | null;
    isNested?: boolean;
    skillName?: string;
    toolInput?: Record<string, unknown>;
  }>;
  recentEvents: Array<{
    id: string;
    timestamp: number;
    text: string;
    kind: StreamingTimelineEvent['kind'];
  }>;
  traceEvents?: StreamingTraceEvent[];
  taskStates?: Record<string, StreamingTaskRuntimeState>;
  contextAudit?: StreamEvent['contextAudit'];
  todos?: Array<{ id: string; content: string; status: string }>;
  systemStatus: string | null;
  isThinking?: boolean;
  activeHook?: { hookName: string; hookEvent: string } | null;
  turnId?: string;
}

/** What the server kept of one turn's reasoning and execution (GET turn-traces). */
interface TurnTraceResponse {
  turn_id: string;
  thinking?: string | null;
  thinking_duration_ms?: number | null;
  trace?: StreamingTraceEvent[] | null;
  /** The ordered steps; `[]` for a turn recorded before steps were kept. */
  steps?: StreamingStep[] | null;
  steps_dropped?: number | null;
  created_at?: string;
}

export interface ActiveRunSnapshotData {
  chatJid: string;
  runId: string;
  startedAt: string;
  phase: 'preparing' | 'running';
}

/**
 * Messages carrying images can be megabytes of base64; give them an upload
 * timeout sized to the payload instead of the 8s default for small JSON.
 */
function attachmentTimeoutMs(
  attachments: Array<{ data: string }> | undefined,
): number | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const bytes = attachments.reduce((sum, att) => sum + att.data.length, 0);
  return computeUploadTimeoutMs(bytes);
}

export interface StreamingState {
  turnId?: string;
  sessionId?: string;
  partialText: string;
  thinkingText: string;
  isThinking: boolean;
  /**
   * Wall-clock ms the current thinking burst began. A burst that arrives all
   * at once after silent reasoning starts at the model request (`requesting`,
   * a returned tool or the run start), not at the first delta received.
   */
  thinkingStartedAt?: number;
  /** Thinking time of the finished bursts, summed. Renders "已思考 Xs". */
  thinkingDurationMs?: number;
  /** When the model's current request began; the next burst starts there. */
  phaseStartedAt?: number;
  /**
   * The model's request is in flight and nothing has come back from it yet:
   * a model request began (`requesting`), or a tool returned.
   */
  awaitingModel?: boolean;
  /** Summary title of the latest reasoning, for the collapsed label. */
  thinkingTitle?: string;
  /** A new burst of reasoning began: its first text starts a paragraph. */
  thinkingGap?: boolean;
  /**
   * The reply's steps in the order they happened (reasoning, tools,
   * sub-agents, commentary), for the step timeline. Written next to the
   * fields above, which the classic layout still reads.
   */
  steps?: StreamingStep[];
  /** Steps dropped from the front of `steps` at its cap. */
  stepsDropped?: number;
  /**
   * Part of `steps` was rebuilt from a reconnect snapshot (this tab joined the
   * run part-way): their order is plausible, not exact, and the finished
   * reply's steps are fetched from the server when the reader opens them.
   */
  stepsRebuilt?: boolean;
  /**
   * Characters cut from the head of `partialText` at its cap, so the offsets
   * text steps hold into the whole text stay valid.
   */
  partialBase?: number;
  /**
   * The run ended (run_finished) and this frozen projection waits, in
   * `settledStreaming`, for the turn's final message, which replaces it in
   * the same store update.
   */
  settling?: boolean;
  /** The finished run a settled projection belongs to. */
  runId?: string;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    elapsedSeconds?: number;
    parentToolUseId?: string | null;
    isNested?: boolean;
    skillName?: string;
    toolInputSummary?: string;
    toolInput?: Record<string, unknown>;
  }>;
  activeHook: { hookName: string; hookEvent: string } | null;
  systemStatus: string | null;
  recentEvents: StreamingTimelineEvent[];
  traceEvents: StreamingTraceEvent[];
  taskStates: Record<string, StreamingTaskRuntimeState>;
  todos?: Array<{ id: string; content: string; status: string }>;
  interrupted?: boolean;
}

export function mergeMessagesChronologically(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  // Incoming messages are authoritative, but preserve reference if content unchanged
  for (const m of incoming) {
    const old = byId.get(m.id);
    // WebSocket/stream projections can update a canonical row before their
    // payload has been enriched with the REST-only ingest cursor. Never erase
    // an already-authoritative sequence or pagination can silently fall back
    // to the provider timestamp boundary.
    let next =
      old?.ingest_sequence !== undefined && m.ingest_sequence === undefined
        ? { ...m, ingest_sequence: old.ingest_sequence }
        : m;
    if (
      old?.token_usage !== undefined &&
      next.token_usage === undefined &&
      old.chat_jid === next.chat_jid &&
      old.turn_id === next.turn_id
    ) {
      // Final WS projections can omit usage already received for this exact
      // row. A later enriched REST value still replaces the local projection.
      next = { ...next, token_usage: old.token_usage };
    }
    if (
      !old ||
      old.content !== next.content ||
      old.timestamp !== next.timestamp ||
      old.ingest_sequence !== next.ingest_sequence ||
      old.token_usage !== next.token_usage ||
      JSON.stringify(old.workflow_runs ?? []) !==
        JSON.stringify(next.workflow_runs ?? []) ||
      old.turn_id !== next.turn_id ||
      old.has_trace !== next.has_trace ||
      old.session_id !== next.session_id ||
      old.sdk_message_uuid !== next.sdk_message_uuid ||
      old.source_kind !== next.source_kind ||
      old.finalization_reason !== next.finalization_reason ||
      old.delivery_mode !== next.delivery_mode ||
      old.delivery_status !== next.delivery_status ||
      old.delivery_run_id !== next.delivery_run_id ||
      old.delivery_updated_at !== next.delivery_updated_at
    ) {
      byId.set(next.id, next);
    }
  }
  const result = Array.from(byId.values()).sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
    return a.timestamp.localeCompare(b.timestamp);
  });
  // Defensive: log when message count unexpectedly decreases
  if (result.length < existing.length) {
    const missingIds = existing.filter((m) => !byId.has(m.id)).map((m) => m.id);
    console.warn('[mergeMessages] Message count decreased!', {
      before: existing.length,
      after: result.length,
      incoming: incoming.length,
      missingIds,
    });
  }
  return result;
}

function messageSequenceBoundary(
  messages: Message[],
  direction: 'min' | 'max',
): number | undefined {
  let boundary: number | undefined;
  for (const message of messages) {
    const sequence = message.ingest_sequence;
    if (!Number.isSafeInteger(sequence) || sequence === undefined) continue;
    boundary =
      boundary === undefined
        ? sequence
        : direction === 'min'
          ? Math.min(boundary, sequence)
          : Math.max(boundary, sequence);
  }
  return boundary;
}

/**
 * Traces announced for a message this tab has not received yet, by chat and
 * message id. The server sends `message_trace` for a message it already
 * announced, but a message with attachments reaches the Web after its
 * thumbnails are made and can come second.
 */
const pendingTraceMarks = new Set<string>();
const MAX_PENDING_TRACE_MARKS = 100;

function traceMarkKey(chatJid: string, messageId: string): string {
  return `${chatJid}\0${messageId}`;
}

function rememberPendingTraceMark(chatJid: string, messageId: string): void {
  const key = traceMarkKey(chatJid, messageId);
  pendingTraceMarks.delete(key);
  pendingTraceMarks.add(key);
  while (pendingTraceMarks.size > MAX_PENDING_TRACE_MARKS) {
    const oldest = pendingTraceMarks.values().next().value;
    if (oldest === undefined) break;
    pendingTraceMarks.delete(oldest);
  }
}

/** Whether a mark waited for this message; it is spent either way. */
function takePendingTraceMark(chatJid: string, messageId: string): boolean {
  return pendingTraceMarks.delete(traceMarkKey(chatJid, messageId));
}

const MAX_THINKING_CACHE_SIZE = 500;

/**
 * Viewed conversations whose loaded messages stay in memory. Every opened
 * conversation used to keep its pages for the rest of the visit, so the heap
 * grew with each one (14MB to 26MB over 80 switches on a real account, flat
 * when revisiting the same few). Reopening a dropped one loads it again;
 * sessions repaint from the IndexedDB snapshot first.
 */
const RETAINED_CONVERSATIONS = 20;
/** Viewed conversations by runtime key, least recently viewed first. */
const viewedConversations = new Map<
  string,
  { jid: string; agentId: string | null }
>();

function noteConversationViewed(jid: string, agentId: string | null) {
  const key = agentId ? `${jid}#agent:${agentId}` : jid;
  viewedConversations.delete(key);
  viewedConversations.set(key, { jid, agentId });
}

/**
 * Drop the messages of the least recently viewed conversations beyond
 * RETAINED_CONVERSATIONS. The open workspace keeps all of its conversations,
 * because its stream events and new messages are applied to them, and so
 * does anything still running, streaming, awaiting a reply or clearing.
 */
function evictViewedConversations(
  s: ChatState,
  openJid: string,
): Partial<ChatState> {
  let excess = viewedConversations.size - RETAINED_CONVERSATIONS;
  if (excess <= 0) return {};
  let messages: ChatState['messages'] | undefined;
  let hasMore: ChatState['hasMore'] | undefined;
  let agentMessages: ChatState['agentMessages'] | undefined;
  let agentHasMore: ChatState['agentHasMore'] | undefined;
  for (const [key, { jid, agentId }] of viewedConversations) {
    if (excess <= 0) break;
    if (jid === openJid || jid === s.currentGroup) continue;
    const busy =
      !!s.activeRuns[key] ||
      !!s.settledStreaming[key] ||
      !!s.clearing[jid] ||
      (agentId
        ? !!s.agentWaiting[agentId] || !!s.agentStreaming[agentId]
        : !!s.waiting[jid] || !!s.streaming[jid]);
    if (busy) continue;
    viewedConversations.delete(key);
    excess -= 1;
    if (agentId) {
      if (!s.agentMessages[agentId]) continue;
      agentMessages ??= { ...s.agentMessages };
      agentHasMore ??= { ...s.agentHasMore };
      delete agentMessages[agentId];
      delete agentHasMore[agentId];
    } else {
      if (!s.messages[jid]) continue;
      messages ??= { ...s.messages };
      hasMore ??= { ...s.hasMore };
      delete messages[jid];
      delete hasMore[jid];
    }
  }
  return {
    ...(messages && { messages, hasMore }),
    ...(agentMessages && { agentMessages, agentHasMore }),
  };
}
const loadMessagesInFlight = new Map<string, Promise<void>>();
const loadAgentsInFlight = new Map<string, Promise<void>>();
let loadGroupsInFlight: Promise<void> | null = null;

interface GroupsResponse {
  groups: Record<string, GroupInfo>;
  admin_host_only_mode?: boolean;
}

/**
 * index.html starts GET /api/groups while the HTML is parsed on signed-in
 * routes (see web/index.html); the first loadGroups takes that response
 * instead of waiting for the app shell to mount before asking.
 */
async function takeGroupsPrewarm(): Promise<GroupsResponse | null> {
  if (typeof window === 'undefined') return null;
  const holder = window as { __groupsPrewarm?: Promise<unknown> };
  const prewarm = holder.__groupsPrewarm;
  if (!prewarm) return null;
  holder.__groupsPrewarm = undefined;
  try {
    const data = (await prewarm) as GroupsResponse | null;
    return data && typeof data.groups === 'object' && data.groups ? data : null;
  } catch {
    return null;
  }
}

/** Evict oldest entries when cache exceeds capacity (relies on insertion order) */
function capThinkingCache<V>(cache: Record<string, V>): Record<string, V> {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_THINKING_CACHE_SIZE) return cache;
  const keep = keys.slice(keys.length - MAX_THINKING_CACHE_SIZE);
  const next: Record<string, V> = {};
  for (const k of keep) next[k] = cache[k];
  return next;
}

function retainThinkingCacheForMessages<V>(
  messagesByGroup: Record<string, Message[]>,
  cache: Record<string, V>,
): Record<string, V> {
  const aliveMessageIds = new Set<string>();
  for (const messages of Object.values(messagesByGroup)) {
    for (const m of messages) aliveMessageIds.add(m.id);
  }

  const next: Record<string, V> = {};
  for (const [messageId, content] of Object.entries(cache)) {
    if (aliveMessageIds.has(messageId)) next[messageId] = content;
  }
  return capThinkingCache(next);
}

/**
 * Start a thinking burst on the transition non-thinking → thinking. Thinking
 * often streams in one late burst after the model reasoned silently, so the
 * burst starts when the model's request did (`phaseStartedAt`, or the run's
 * start for the first burst) rather than when its first delta arrived.
 */
function markThinkingStarted(
  prev: StreamingState,
  next: StreamingState,
  runStartedAt?: number,
): void {
  if (!prev.isThinking || prev.thinkingStartedAt == null) {
    const now = Date.now();
    const requestStart =
      prev.phaseStartedAt ??
      (prev.thinkingDurationMs == null && !prev.partialText
        ? runStartedAt
        : undefined);
    next.thinkingStartedAt =
      requestStart != null && requestStart <= now ? requestStart : now;
  }
  next.phaseStartedAt = undefined;
  next.awaitingModel = false;
}

/** Whether the event is a sub-agent's: its text and reasoning are its card's. */
function isSubagentEvent(event: StreamEvent): boolean {
  return !!event.parentToolUseId || event.agentScope === 'subagent';
}

/** The reply's step list, to be edited and written back with `setSteps`. */
function stepsOf(state: StreamingState): StepList {
  return stepList(state.steps, state.stepsDropped);
}

function setSteps(next: StreamingState, list: StepList): void {
  next.steps = list.steps;
  next.stepsDropped = list.dropped;
}

/**
 * A burst of reasoning ends (isThinking:true → false): add it to the reply's
 * thinking time and close its step. `reportedMs` is the model's own timing
 * from `thinking_end`; without it the clock decides.
 */
function endThinkingBurst(
  prev: StreamingState,
  next: StreamingState,
  at: number,
  reportedMs?: number,
): void {
  const reported =
    reportedMs != null && Number.isFinite(reportedMs) && reportedMs >= 0
      ? reportedMs
      : undefined;
  if (prev.isThinking && prev.thinkingStartedAt != null) {
    // The longer of the model's own timing and the clock from the request:
    // reasoning that returns no text arrives whole, after the wait, and its own
    // timing is then a few milliseconds. The host stores the same.
    next.thinkingDurationMs =
      (prev.thinkingDurationMs ?? 0) +
      Math.max(reported ?? 0, Math.max(0, at - prev.thinkingStartedAt));
    next.thinkingStartedAt = undefined;
  } else if (prev.isThinking && reported != null) {
    next.thinkingDurationMs = (prev.thinkingDurationMs ?? 0) + reported;
  }
  next.isThinking = false;
  setSteps(next, closeThinkingStep(stepsOf(next), at, reported));
}

/**
 * Reasoning began: a `thinking_start`, or the first delta of a burst when the
 * runner sends none. A new burst after earlier reasoning opens a new step and
 * its text a new paragraph; the first delta after a `thinking_start` is part
 * of the burst that start opened.
 */
function beginThinkingBurst(
  prev: StreamingState,
  next: StreamingState,
  runStartedAt: number | undefined,
  at: number,
): void {
  markThinkingStarted(prev, next, runStartedAt);
  if (!prev.isThinking) {
    next.thinkingGap = prev.thinkingText.length > 0;
    // The step starts where the burst does: when the request went out.
    setSteps(
      next,
      openThinkingStep(stepsOf(prev), next.thinkingStartedAt ?? at),
    );
  }
  next.isThinking = true;
}

/** Add reasoning text: bursts are separated, the whole is bounded and titled. */
function appendThinking(
  prev: StreamingState,
  next: StreamingState,
  text: string,
  at: number,
): void {
  const gap = next.thinkingGap ? thinkingSeparator(prev.thinkingText) : '';
  next.thinkingText = capThinkingText(
    prev.thinkingText + gap + text,
    MAX_THINKING_TEXT,
  );
  next.thinkingGap = false;
  next.thinkingTitle =
    extractThinkingTitle(next.thinkingText) ?? prev.thinkingTitle;
  setSteps(next, appendThinkingText(stepsOf(next), text, at));
}

/** Add reply text; the text after the last tool is what the host delivers. */
function appendReplyText(
  prev: StreamingState,
  next: StreamingState,
  text: string,
  at: number,
  maxText: number,
): void {
  const base = prev.partialBase ?? 0;
  const combined = prev.partialText + text;
  next.partialText = capStreamingText(combined, maxText);
  next.partialBase =
    base + Math.max(0, combined.length - next.partialText.length);
  setSteps(
    next,
    openTextStep(stepsOf(next), at, base + prev.partialText.length),
  );
}

/**
 * Whether a runtime delivers its messages itself (a proactive workspace's
 * main and conversation sessions), so no final reply ever replaces its
 * card. Fire-and-forget spawn Agents keep the Assistant contract.
 */
function isProactiveRuntime(
  s: Pick<ChatState, 'groups' | 'agents'>,
  runtimeJid: string,
): boolean {
  const marker = '#agent:';
  const markerIndex = runtimeJid.indexOf(marker);
  const chatJid =
    markerIndex >= 0 ? runtimeJid.slice(0, markerIndex) : runtimeJid;
  if (
    normalizeInteractionMode(s.groups[chatJid]?.interaction_mode) !==
    'proactive'
  ) {
    return false;
  }
  if (markerIndex < 0) return true;
  const agentId = runtimeJid.slice(markerIndex + marker.length);
  return (
    s.agents[chatJid]?.find((agent) => agent.id === agentId)?.kind !== 'spawn'
  );
}

/**
 * A proactive turn's state cut down to what `visibility` shows: nothing but
 * the spinner at `hidden`, no reasoning text at `activity`. The owner can
 * lower the level while a turn runs; what the new level hides is dropped.
 */
function scrubForVisibility(
  state: StreamingState,
  visibility: ProcessVisibility,
): StreamingState {
  if (visibility === 'hidden') {
    return {
      ...DEFAULT_STREAMING_STATE,
      turnId: state.turnId,
      sessionId: state.sessionId,
      systemStatus: state.systemStatus,
    };
  }
  // The reply is never shown, whatever the level; so is what a tool was given.
  // The log of recent events is no part of the process panel, and the host's
  // lines for the speech tool carry the start of what was said.
  const shown: StreamingState = {
    ...state,
    partialText: '',
    partialBase: 0,
    recentEvents: [],
    taskStates: scrubTaskStates(state.taskStates, visibility),
    activeTools: state.activeTools.map(
      ({ toolInput: _input, ...tool }) => tool,
    ),
  };
  if (visibility === 'full') return shown;
  return {
    ...shown,
    thinkingText: '',
    thinkingTitle: undefined,
    thinkingGap: false,
    // Reasoning text and the narration before a tool call are `full` only.
    steps: state.steps
      ?.filter((step) => !step.commentary)
      .map((step) =>
        step.kind === 'thinking'
          ? { ...step, text: '', title: undefined }
          : step,
      ),
  };
}

/** Thinking time so far, including a burst still in progress. */
function totalThinkingMs(state: StreamingState): number | undefined {
  if (state.isThinking && state.thinkingStartedAt != null) {
    return (
      (state.thinkingDurationMs ?? 0) +
      Math.max(0, Date.now() - state.thinkingStartedAt)
    );
  }
  return state.thinkingDurationMs;
}

/** Status texts that describe the run's phase rather than news for the reader. */
const PHASE_STATUS_TEXTS = new Set(['requesting', '正在深入分析…']);

function isPhaseStatus(statusText?: string | null): boolean {
  return !!statusText && PHASE_STATUS_TEXTS.has(statusText);
}

function runStartedAtMs(
  activeRuns: ClientActiveRuns,
  runtimeJid: string,
): number | undefined {
  const startedAt = activeRuns[runtimeJid]?.startedAt;
  const ms = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Apply one rAF batch of text/thinking deltas in arrival order: a batch that
 * ends in text must end the thinking burst even when thinking came first
 * (background tabs pause rAF, so whole phases land in one batch).
 */
function applyDeltaChunks(
  prev: StreamingState,
  chunks: DeltaChunk[],
  runStartedAt: number | undefined,
): StreamingState {
  let state = prev;
  let index = 0;
  const at = Date.now();
  while (index < chunks.length) {
    const thinking = chunks[index].thinking;
    let text = '';
    while (index < chunks.length && chunks[index].thinking === thinking) {
      text += chunks[index].text;
      index += 1;
    }
    if (!text) continue;
    const next = { ...state };
    if (thinking) {
      beginThinkingBurst(state, next, runStartedAt, at);
      appendThinking(state, next, text, at);
    } else {
      endThinkingBurst(state, next, at);
      appendReplyText(state, next, text, at, MAX_STREAMING_TEXT);
      next.awaitingModel = false;
      next.phaseStartedAt = undefined;
      if (isPhaseStatus(state.systemStatus)) next.systemStatus = null;
    }
    state = next;
  }
  return state;
}

interface PendingMessageUsage {
  chatJid: string;
  agentId?: string;
  inputTurnId: string;
  tokenUsageJson: string;
  receivedAt: number;
}

const PENDING_MESSAGE_USAGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_MESSAGE_USAGE = 128;

function messageUsageKey(
  chatJid: string,
  agentId: string | undefined,
  inputTurnId: string,
): string {
  return JSON.stringify([chatJid, agentId ?? null, inputTurnId]);
}

function prunePendingMessageUsage(
  pending: Record<string, PendingMessageUsage>,
): Record<string, PendingMessageUsage> {
  const oldest = Date.now() - PENDING_MESSAGE_USAGE_TTL_MS;
  return Object.fromEntries(
    Object.entries(pending)
      .filter(([, entry]) => entry.receivedAt > oldest)
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt)
      .slice(-MAX_PENDING_MESSAGE_USAGE),
  );
}

function clearPendingMessageUsage(
  pending: Record<string, PendingMessageUsage>,
  chatJid: string,
  agentId?: string,
  allAgents = false,
): Record<string, PendingMessageUsage> {
  return Object.fromEntries(
    Object.entries(pending).filter(
      ([, entry]) =>
        entry.chatJid !== chatJid || (!allAgents && entry.agentId !== agentId),
    ),
  );
}

function isUsageAnswer(message: Message, runtimeJid: string): boolean {
  return (
    message.chat_jid === runtimeJid &&
    message.is_from_me &&
    message.sender !== '__system__' &&
    message.source_kind !== 'sdk_send_message' &&
    message.source_kind !== 'scheduled_task_result' &&
    !!message.turn_id
  );
}

function mergePendingMessageUsage(
  messages: Message[],
  pending: Record<string, PendingMessageUsage>,
  chatJid: string,
  agentId?: string,
): { messages: Message[]; pending: Record<string, PendingMessageUsage> } {
  const next = prunePendingMessageUsage(pending);
  const runtimeJid = agentId ? `${chatJid}#agent:${agentId}` : chatJid;
  return {
    messages: messages.map((message) => {
      if (!isUsageAnswer(message, runtimeJid)) return message;
      const key = messageUsageKey(chatJid, agentId, message.turn_id!);
      const entry = next[key];
      if (!entry) return message;
      delete next[key];
      // Enriched REST/final rows already contain the authoritative ledger total.
      return message.token_usage
        ? message
        : { ...message, token_usage: entry.tokenUsageJson };
    }),
    pending: next,
  };
}

/** The steps of one finished reply, as its settled process card takes them. */
export interface ReplySteps {
  steps: StreamingStep[];
  /** Steps dropped from the front once the cap was reached. */
  dropped: number;
  /**
   * Rebuilt in a tab that joined the run part-way, not the server's record:
   * the reader who opens the card gets the server's (see `loadTurnTrace`).
   */
  provisional?: boolean;
}

interface ChatState {
  groups: Record<string, GroupInfo>;
  adminHostOnlyMode: boolean;
  currentGroup: string | null;
  messages: Record<string, Message[]>;
  waiting: Record<string, boolean>;
  /** Exact GroupQueue query attempt per main/agent runtime JID. */
  activeRuns: ClientActiveRuns;
  /** Usage received before its canonical final row; bounded and session-scoped. */
  pendingMessageUsage: Record<string, PendingMessageUsage>;
  followUps: Record<string, QueuedFollowUp[]>;
  hasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  streaming: Record<string, StreamingState>;
  thinkingCache: Record<string, string>;
  /** Per-message-id duration in ms; rendered as "已思考 Xs" inside ReasoningBlock. */
  thinkingDurationCache: Record<string, number>;
  /**
   * The execution trace a finished reply streamed (tools, hooks, tasks), by
   * final message id, so the reply keeps its collapsed "执行详情".
   */
  traceCache: Record<string, StreamingTraceEvent[]>;
  /**
   * The ordered steps a finished reply streamed, by final message id: what its
   * settled process card lists. A reply without an entry (an older turn, or the
   * classic layout's) keeps the reasoning and trace rows.
   */
  stepsCache: Record<string, ReplySteps>;
  /**
   * A message whose reasoning and trace the server kept but this tab has not
   * loaded: `loading` while asked, `failed` to try again on the next ask,
   * `empty` when the server had nothing (or no longer shows it).
   */
  turnTraceStatus: Record<string, 'loading' | 'failed' | 'empty'>;
  /** Stop requested for a runtime JID (ms); the run shows "正在停止…". */
  stopRequests: Record<string, number>;
  /**
   * A finished run's frozen card by runtime JID, kept apart from the live
   * projection (`streaming` / `agentStreaming`) so the next queued run can
   * start streaming while the previous reply still waits for its final.
   */
  settledStreaming: Record<string, StreamingState>;
  pendingThinking: Record<string, string>;
  pendingThinkingDuration: Record<string, number>;
  /** Per-group lock: true while clearHistory is in-flight, prevents race re-injection */
  clearing: Record<string, boolean>;
  // Sub-agent state
  agents: Record<string, AgentInfo[]>; // jid → agents
  agentStreaming: Record<string, StreamingState>; // agentId → streaming state
  activeAgentTab: Record<string, string | null>; // jid → selected agentId (null = main)
  // SDK Task subagent state (in-process via Task tool, not DB-persisted)
  sdkTasks: Record<
    string,
    {
      // toolUseId → task info
      chatJid: string;
      description: string;
      status: 'running' | 'completed' | 'error';
      summary?: string;
      isTeammate?: boolean;
      startedAt?: number; // 任务创建时间戳（ms），用于 UI 计时器
    }
  >;
  // SDK Task alias map: runtime taskId/parentToolUseId -> canonical sdkTasks key
  sdkTaskAliases: Record<string, string>;
  // Conversation agent state
  agentMessages: Record<string, Message[]>; // agentId → messages
  agentWaiting: Record<string, boolean>; // agentId → waiting for reply
  agentHasMore: Record<string, boolean>; // agentId → has more messages
  loadGroups: () => Promise<void>;
  selectGroup: (jid: string) => void;
  loadMessages: (jid: string, loadMore?: boolean) => Promise<void>;
  refreshMessages: (jid: string) => Promise<void>;
  sendMessage: (
    jid: string,
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => Promise<boolean>;
  loadFollowUps: (chatJid: string) => Promise<void>;
  handleFollowUpUpdate: (
    chatJid: string,
    items: QueuedFollowUp[],
    transition?: FollowUpTransition,
  ) => void;
  actOnFollowUp: (
    chatJid: string,
    messageId: string,
    action: FollowUpQueueAction,
    expectedRunId?: string | null,
    content?: string,
  ) => Promise<boolean>;
  interruptQuery: (jid: string) => Promise<boolean>;
  resetSession: (jid: string, agentId?: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  deleteMessage: (jid: string, messageId: string) => Promise<boolean>;
  handleMessageDeleted: (
    messageChatJid: string,
    messageId: string,
  ) => Promise<void>;
  /**
   * The server stored the trace of a message's turn after announcing the
   * message (a proactive utterance is announced mid-turn): mark it, so its
   * reasoning and execution rows appear without a reload.
   */
  handleMessageTrace: (messageChatJid: string, messageId: string) => void;
  createFlow: (
    name: string,
    options?: CreateWorkspaceOptions,
  ) => Promise<{ jid: string; folder: string }>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  updateInteractionMode: (
    jid: string,
    interactionMode: InteractionMode,
  ) => Promise<boolean>;
  /** Change how much of a proactive turn's process the Web shows (no restart). */
  updateProcessVisibility: (
    jid: string,
    visibility: ProcessVisibility,
  ) => Promise<boolean>;
  togglePin: (jid: string) => Promise<void>;
  inspectDeleteFlow: (jid: string) => Promise<WorkspaceDeleteImpact>;
  deleteFlow: (
    jid: string,
    options?: { unbindChannels?: boolean },
  ) => Promise<void>;
  /**
   * Load the reasoning and execution trace the server kept of a finished
   * turn into the caches the message renders from. Quiet on failure.
   */
  loadTurnTrace: (
    message: Pick<Message, 'id' | 'chat_jid' | 'turn_id'>,
  ) => Promise<boolean>;
  handleStreamEvent: (
    chatJid: string,
    event: StreamEvent,
    agentId?: string,
    runId?: string,
  ) => void;
  handleWsNewMessage: (
    chatJid: string,
    wsMsg: any,
    agentId?: string,
    source?: string,
  ) => void;
  handleAgentStatus: (
    chatJid: string,
    agentId: string,
    status: AgentInfo['status'],
    name: string,
    prompt: string,
    resultSummary?: string,
    kind?: AgentInfo['kind'],
    titleGenerating?: boolean,
  ) => void;
  clearStreaming: (
    chatJid: string,
    options?: { preserveThinking?: boolean },
  ) => void;
  restoreActiveState: () => Promise<void>;
  handleStreamSnapshot: (
    chatJid: string,
    snapshot: StreamSnapshotData,
    agentId?: string,
    runId?: string,
  ) => void;
  // Sub-agent actions
  loadAgents: (jid: string, opts?: { force?: boolean }) => Promise<void>;
  deleteAgentAction: (jid: string, agentId: string) => Promise<boolean>;
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  // Conversation agent actions
  createConversation: (
    jid: string,
    name?: string,
    description?: string,
  ) => Promise<AgentInfo | null>;
  renameConversation: (
    jid: string,
    agentId: string,
    name: string,
  ) => Promise<boolean>;
  loadAgentMessages: (
    jid: string,
    agentId: string,
    loadMore?: boolean,
  ) => Promise<void>;
  hydrateAgentMessages: (jid: string, agentId: string) => Promise<void>;
  sendAgentMessage: (
    jid: string,
    agentId: string,
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => Promise<boolean>;
  refreshAgentMessages: (jid: string, agentId: string) => Promise<void>;
  // Runner state sync
  handleRunnerState: (chatJid: string, state: string) => void;
  handleRunStarted: (chatJid: string, runId?: string | null) => void;
  handleRunFinished: (chatJid: string, runId: string) => void;
  handleActiveRunSnapshot: (
    runs: ActiveRunSnapshotData[],
    queuedChatJids?: string[],
  ) => void;
  // IM binding actions
  loadAvailableImGroups: (jid: string) => Promise<AvailableImGroup[]>;
  syncAvailableImGroups: (
    jid: string,
  ) => Promise<{ success: boolean; feishuAccounts: number }>;
  unbindImGroup: (
    jid: string,
    agentId: string,
    imJid: string,
  ) => Promise<boolean>;
  unbindMainImGroup: (jid: string, imJid: string) => Promise<boolean>;
  unbindWorkspaceImGroup: (jid: string, imJid: string) => Promise<boolean>;
  // Draft persistence across route navigation
  drafts: Record<string, string>;
  saveDraft: (jid: string, text: string) => void;
  clearDraft: (jid: string) => void;
  // Unread agent replies (incremented when page is hidden or a different chat is active)
  unreadReplies: Record<string, number>;
  markChatRead: (chatJid: string) => void;
}

const DEFAULT_STREAMING_STATE: StreamingState = {
  turnId: undefined,
  sessionId: undefined,
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
};

const STALE_WAITING_NO_DATA_MS = 60_000;
const STALE_WAITING_WITH_DATA_MS = 180_000;

/** Decide whether a waiting UI is orphaned and safe to recover locally. */
export function shouldRecoverStaleWaiting(input: {
  elapsedMs: number;
  hasStreamData: boolean;
  hasActiveRun: boolean;
}): boolean {
  if (input.hasActiveRun) return false;
  const threshold = input.hasStreamData
    ? STALE_WAITING_WITH_DATA_MS
    : STALE_WAITING_NO_DATA_MS;
  return input.elapsedMs > threshold;
}

/**
 * Transfer SDK Workflow ownership from a finishing Claude turn to the
 * background-wait UI. The acknowledgement is a held result, not the logical
 * end of the user's request, so the Workflow card must remain live while the
 * runner waits for task_notification.
 */
function streamingStateFromWorkflowRuns(
  runs: import('../stream-event.types').WorkflowRunSnapshot[],
): StreamingState {
  const now = Date.now();
  const taskStates: Record<string, StreamingTaskRuntimeState> = {};
  for (const run of runs) {
    taskStates[run.taskId] = {
      id: run.taskId,
      title: run.summary || run.workflowName || '动态工作流',
      status: 'backgrounded',
      taskType: 'local_workflow',
      workflowName: run.workflowName,
      workflowRun: run,
      thinkingTail: '',
      textTail: '',
      activeTools: [],
      recentTools: [],
      updatedAt: now,
    };
  }
  return {
    ...DEFAULT_STREAMING_STATE,
    activeTools: [],
    recentEvents: [],
    traceEvents: [],
    taskStates,
  };
}

/**
 * Sort items by a given ID order. Items not in the order list are appended at the end.
 */
function sortByIdOrder(items: AgentInfo[], orderedIds: string[]): AgentInfo[] {
  const idIndex = new Map(orderedIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ia = idIndex.get(a.id) ?? Infinity;
    const ib = idIndex.get(b.id) ?? Infinity;
    return ia - ib;
  });
}

/**
 * Freeze a streaming state for interrupted display: clear active indicators,
 * keep accumulated text/events, mark as interrupted. Returns null if no data
 * worth preserving (caller should delete the entry).
 */
function freezeStreamingState(
  state: StreamingState | undefined,
): StreamingState | null {
  if (!state) return null;
  // A tool/status-only shell is not useful after Stop and looks like the
  // agent is still running. Preserve the card only when the user has already
  // seen actual answer/reasoning text; the terminal DB message will replace it
  // as soon as it arrives.
  const hasData = state.partialText || state.thinkingText;
  if (!hasData) return null;
  const steps = finishSteps(stepsOf(state), Date.now(), true);
  return {
    ...state,
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    awaitingModel: false,
    interrupted: true,
    // Keep an in-flight burst so the interrupted card still shows "已思考 Xs".
    thinkingDurationMs: totalThinkingMs(state),
    thinkingStartedAt: undefined,
    steps: steps.steps,
    stepsDropped: steps.dropped,
  };
}

/**
 * Freeze a finished run's projection until its final message arrives. The
 * server announces run_finished before it broadcasts the final message;
 * dropping the card on run_finished blanked the reply, moved the reader and
 * lost the thinking and execution details. Null when nothing was shown.
 */
function settleStreamingState(
  state: StreamingState | undefined,
  runId: string | undefined,
): StreamingState | null {
  if (!state) return null;
  // Reasoning without a summary still leaves "已思考 Xs" to carry over.
  if (
    !state.partialText &&
    !state.thinkingText &&
    !((totalThinkingMs(state) ?? 0) > 0)
  ) {
    return null;
  }
  const steps = finishSteps(stepsOf(state), Date.now(), false);
  return {
    ...state,
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    awaitingModel: false,
    thinkingDurationMs: totalThinkingMs(state),
    thinkingStartedAt: undefined,
    steps: steps.steps,
    stepsDropped: steps.dropped,
    settling: true,
    runId,
  };
}

/**
 * A live projection that is really producing output: not a card frozen by a
 * stop. Session "running" indicators follow this, not the mere presence of
 * a card.
 */
export function isLiveStream(state: StreamingState | undefined): boolean {
  return !!state && !state.interrupted && !state.settling;
}

/** A final reply of `turnId` belongs to this settled card. */
function settledTurnMatches(
  settled: StreamingState,
  turnId: string | null | undefined,
): boolean {
  return !settled.turnId || !turnId || settled.turnId === turnId;
}

/** How long a settled card waits for its final message before re-syncing. */
const SETTLE_FALLBACK_MS = 1500;
/** Trace rows kept per finished reply (the panel shows 20 per group). */
const MAX_CACHED_TRACE_EVENTS = 60;

/**
 * A trace cut to what is kept for a finished reply: the newest rows, but never
 * a denied permission, which the streaming card shows as a banner above its
 * steps and which would otherwise vanish when the final message replaces it.
 */
function capCachedTrace(rows: StreamingTraceEvent[]): StreamingTraceEvent[] {
  if (rows.length <= MAX_CACHED_TRACE_EVENTS) return rows;
  const denied = rows.filter((row) => row.kind === 'permission');
  let room = Math.max(0, MAX_CACHED_TRACE_EVENTS - denied.length);
  const kept = new Set<StreamingTraceEvent>(denied);
  for (let i = rows.length - 1; i >= 0 && room > 0; i -= 1) {
    if (kept.has(rows[i])) continue;
    kept.add(rows[i]);
    room -= 1;
  }
  return rows.filter((row) => kept.has(row));
}

/**
 * What the Web shows of a turn's process in a workspace, as one comparable
 * value: all of it (with what the tools returned) in an Assistant workspace,
 * and in a proactive one the level its owner chose, without the tool results
 * at any level. A reply's cached process was read for one of these.
 */
function processView(group: GroupInfo | undefined): string {
  return normalizeInteractionMode(group?.interaction_mode) === 'proactive'
    ? `proactive:${normalizeProcessVisibility(group?.process_visibility)}`
    : 'assistant';
}

/** The view of the workspace a runtime (the workspace or a session) belongs to. */
function processViewOfRuntime(
  s: Pick<ChatState, 'groups'>,
  runtimeJid: string,
): string {
  return processView(s.groups[runtimeJid.replace(/#agent:.*$/, '')]);
}

/**
 * The turn-trace request in flight for each message, newest last. A reply of
 * the view that has changed since it was asked for, or of a request that a
 * newer one has taken over, is not written (see `loadTurnTrace`).
 */
const turnTraceRequests = new Map<string, symbol>();

/**
 * The reasoning, trace and steps this tab holds for the replies of workspaces
 * and their sessions, let go. They were read at the view that was in force: a
 * lowered level must not leave what it hides in memory or on screen, and a
 * raised one must not leave the replies without what it now shows (or marked
 * empty). The replies load again, at the new view, when they are opened.
 */
function withoutProcessCaches(
  s: ChatState,
  jids: readonly string[],
): Partial<ChatState> {
  const ids = new Set<string>();
  for (const jid of jids) {
    for (const message of s.messages[jid] ?? []) ids.add(message.id);
  }
  const sessionPrefixes = jids.map((jid) => `${jid}#agent:`);
  for (const messages of Object.values(s.agentMessages)) {
    for (const message of messages) {
      if (
        sessionPrefixes.some((prefix) => message.chat_jid.startsWith(prefix))
      ) {
        ids.add(message.id);
      }
    }
  }
  const without = <V>(cache: Record<string, V>): Record<string, V> => {
    const next: Record<string, V> = {};
    for (const [id, value] of Object.entries(cache)) {
      if (!ids.has(id)) next[id] = value;
    }
    return next;
  };
  return {
    thinkingCache: without(s.thinkingCache),
    thinkingDurationCache: without(s.thinkingDurationCache),
    traceCache: without(s.traceCache),
    stepsCache: without(s.stepsCache),
    turnTraceStatus: without(s.turnTraceStatus),
  };
}

/** A reply's steps as they stay, whether or not the server had better ones. */
function notProvisional(held: ReplySteps): ReplySteps {
  const { provisional: _provisional, ...rest } = held;
  return rest;
}

/**
 * What all the cached steps may hold in text, in characters. The entries are
 * capped in number (500) and each by the reducer, but a long run's reasoning,
 * summaries and output previews can still add up to far more than a tab
 * should keep, and the reasoning is held a second time in `thinkingCache`.
 */
export const MAX_STEPS_CACHE_CHARS = 4_000_000;

const stepsCharsOf = new WeakMap<ReplySteps, number>();

/** The text a reply's steps carry: what its cache entry weighs. */
function stepsChars(entry: ReplySteps): number {
  let chars = stepsCharsOf.get(entry);
  if (chars === undefined) {
    chars = 0;
    for (const step of entry.steps) {
      chars +=
        (step.text?.length ?? 0) +
        (step.resultPreview?.length ?? 0) +
        (step.summary?.length ?? 0) +
        (step.title?.length ?? 0);
    }
    stepsCharsOf.set(entry, chars);
  }
  return chars;
}

/** Messages the reader has in front of them: this workspace, or its open tab. */
function idsOnScreen(
  s: Pick<
    ChatState,
    'currentGroup' | 'messages' | 'agentMessages' | 'activeAgentTab'
  >,
): Set<string> {
  const ids = new Set<string>();
  const jid = s.currentGroup;
  if (!jid) return ids;
  const agentId = s.activeAgentTab[jid];
  const shown = agentId ? s.agentMessages[agentId] : s.messages[jid];
  for (const message of shown ?? []) ids.add(message.id);
  return ids;
}

/**
 * The steps of a reply written to the cache: it is the newest entry, and what
 * the cache holds is kept to its count and to `MAX_STEPS_CACHE_CHARS` in all.
 * Past that the oldest entries go first, those of messages that are not in
 * front of the reader before those that are; the entry just written stays.
 */
function withReplySteps(
  s: ChatState,
  messageId: string,
  entry: ReplySteps,
): Record<string, ReplySteps> {
  const { [messageId]: _replaced, ...others } = s.stepsCache;
  const cache = capThinkingCache({ ...others, [messageId]: entry });
  const sizes = new Map<string, number>();
  let total = 0;
  for (const [id, held] of Object.entries(cache)) {
    const chars = stepsChars(held);
    sizes.set(id, chars);
    total += chars;
  }
  if (total <= MAX_STEPS_CACHE_CHARS) return cache;
  const onScreen = idsOnScreen(s);
  const older = Object.keys(cache).filter((id) => id !== messageId);
  const order = [
    ...older.filter((id) => !onScreen.has(id)),
    ...older.filter((id) => onScreen.has(id)),
  ];
  const gone = new Set<string>();
  for (const id of order) {
    if (total <= MAX_STEPS_CACHE_CHARS) break;
    total -= sizes.get(id) ?? 0;
    gone.add(id);
  }
  return Object.fromEntries(
    Object.entries(cache).filter(([id]) => !gone.has(id)),
  );
}

/**
 * A step without what its tool or sub-agent returned: the preview of the
 * output and the numbers read from it. A proactive workspace never shows them.
 */
export function withoutToolResults(step: StreamingStep): StreamingStep {
  if (step.resultPreview === undefined && step.resultFacts === undefined) {
    return step;
  }
  const { resultPreview: _preview, resultFacts: _facts, ...rest } = step;
  return rest;
}

/**
 * Thinking, execution details and ordered steps of a finished reply, keyed by
 * its final message id. Only taken from a projection that belongs to the
 * finished reply: a settled or interrupted card, or a live one with no newer
 * run.
 */
function finalizedReplyCaches(
  s: ChatState,
  state: StreamingState | undefined,
  messageId: string,
  fallbackThinking?: string,
  fallbackDuration?: number,
): Partial<ChatState> {
  const thinkingText = state?.thinkingText || fallbackThinking;
  const duration = state ? totalThinkingMs(state) : fallbackDuration;
  const trace = (state?.traceEvents ?? []).filter(isUserVisibleTraceEvent);
  // A projection that was never settled may still hold a running step.
  const steps = state ? finishSteps(stepsOf(state), Date.now(), false) : null;
  return {
    ...(steps && hasListedSteps(steps.steps)
      ? {
          stepsCache: withReplySteps(s, messageId, {
            steps: steps.steps,
            dropped: steps.dropped,
            ...(state?.stepsRebuilt ? { provisional: true } : {}),
          }),
        }
      : {}),
    ...(thinkingText
      ? {
          thinkingCache: capThinkingCache({
            ...s.thinkingCache,
            [messageId]: thinkingText,
          }),
        }
      : {}),
    ...(duration != null && (thinkingText || duration >= 1000)
      ? {
          thinkingDurationCache: capThinkingCache({
            ...s.thinkingDurationCache,
            [messageId]: duration,
          }),
        }
      : {}),
    ...(trace.length > 0
      ? {
          traceCache: capThinkingCache({
            ...s.traceCache,
            [messageId]: capCachedTrace(trace),
          }),
        }
      : {}),
  };
}

/** A live projection frozen by a stop: it belongs to the stopped reply. */
function isFrozenProjection(state: StreamingState | undefined): boolean {
  return !!state?.interrupted;
}

/**
 * Resolve the previous StreamingState for a new event, resetting if turnId changed.
 */
function resolveStreamingPrev(
  current: StreamingState | undefined,
  event: StreamEvent,
): StreamingState {
  if (current?.turnId && event.turnId && current.turnId !== event.turnId) {
    return {
      ...DEFAULT_STREAMING_STATE,
      turnId: event.turnId,
      sessionId: event.sessionId,
    };
  }
  return current || { ...DEFAULT_STREAMING_STATE };
}

// The whole streamed reply is rendered (finished blocks are memoized), so
// this is only a memory guard; past it the tail is kept from a block boundary.
const MAX_STREAMING_TEXT = 200_000;

/**
 * Past the cap, keep a block-bounded tail with headroom: cutting to exactly
 * `max` (plus the "…" marker) put every following delta over the cap again,
 * re-splitting ~200k characters on each frame. Now a cut happens once per
 * tenth of the cap.
 */
function capStreamingText(text: string, max: number): string {
  return text.length > max ? markdownTail(text, Math.floor(max * 0.9)) : text;
}

/**
 * Message-list updates for a follow-up queue change: edited queue content is
 * copied onto the hidden rows, then the release/cancel transition applies.
 */
function patchFollowUpMessages(
  s: ChatState,
  chatJid: string,
  items: QueuedFollowUp[],
  transition?: FollowUpTransition | null,
): Partial<ChatState> {
  const apply = (existing: Message[]) => {
    const synced = syncFollowUpContent(existing, items);
    return transition ? applyFollowUpTransition(synced, transition) : synced;
  };
  const agentMarker = '#agent:';
  const markerIndex = chatJid.indexOf(agentMarker);
  if (markerIndex >= 0) {
    const agentId = chatJid.slice(markerIndex + agentMarker.length);
    const existing = s.agentMessages[agentId] || [];
    const updated = apply(existing);
    return updated === existing
      ? {}
      : { agentMessages: { ...s.agentMessages, [agentId]: updated } };
  }
  const existing = s.messages[chatJid] || [];
  const updated = apply(existing);
  return updated === existing
    ? {}
    : { messages: { ...s.messages, [chatJid]: updated } };
}
const MAX_EVENT_LOG = 30;
const MAX_TRACE_EVENTS = 200;
const MAX_TASK_TAIL = 4000;
const SDK_TASK_AUTO_CLOSE_MS = 3000;
const SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS = 1200;
const SDK_TASK_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes stale timeout for non-teammate tasks
const sdkTaskCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sdkTaskStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 已完成/出错的 SDK Task ID，防止迟到事件 re-create */
const completedSdkTaskIds = new Set<string>();

/** DB task agent 自动清理定时器（完成后延迟移除） */
const DB_TASK_AGENT_AUTO_CLEAN_MS = 5000;
const dbTaskAgentCleanupTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function isInternalLifecycleStatus(statusText?: string | null): boolean {
  return (
    statusText === 'requesting' ||
    statusText === 'compacting' ||
    statusText === 'idle' ||
    statusText === 'interrupted'
  );
}

function isUserVisibleTimelineEvent(event: StreamingTimelineEvent): boolean {
  return event.kind !== 'context' && !event.text.startsWith('Agent Context:');
}

function isUserVisibleTraceEvent(event: StreamingTraceEvent): boolean {
  return event.kind !== 'context' && event.title !== 'Agent Context';
}

/**
 * rAF batching for text_delta / thinking_delta events.
 * Instead of calling set() on every single delta (~50ms intervals), we accumulate
 * deltas and flush them once per animation frame (~16ms), merging multiple deltas
 * into a single state update.
 */
interface DeltaChunk {
  thinking: boolean;
  text: string;
}
interface PendingDelta {
  /** Text and thinking deltas in arrival order. */
  chunks: DeltaChunk[];
  raf: number;
  runtimeJid: string;
  runId?: string;
  /** Turn of every chunk; a delta of another turn flushes the batch first. */
  turnId?: string;
}
const pendingDeltas = new Map<string, PendingDelta>();

/**
 * The calls of a proactive turn's speech tool, per runtime: its start names
 * the tool, its later events carry only the id of the call. Kept for the
 * run that made them, so a new run starts empty.
 */
const speechToolCalls = new Map<
  string,
  { runId: string; calls: Set<string> }
>();
const MAX_SPEECH_CALLS = 64;

function speechCallsOf(runtimeJid: string, runId?: string): Set<string> {
  const entry = speechToolCalls.get(runtimeJid);
  return entry && entry.runId === (runId ?? '') ? entry.calls : new Set();
}

/** The speech tool's calls in a reconnect snapshot: its rows and running calls. */
function speechCallsOfSnapshot(snapshot: StreamSnapshotData): Set<string> {
  const calls = speechToolCallsIn(snapshot.traceEvents ?? []);
  for (const tool of snapshot.activeTools ?? []) {
    if (tool.toolName === SPEECH_TOOL_NAME) calls.add(tool.toolUseId);
  }
  return calls;
}

function rememberSpeechCalls(
  runtimeJid: string,
  runId: string | undefined,
  ids: Iterable<string>,
): void {
  const key = runId ?? '';
  let entry = speechToolCalls.get(runtimeJid);
  if (!entry || entry.runId !== key) {
    entry = { runId: key, calls: new Set() };
    speechToolCalls.set(runtimeJid, entry);
  }
  for (const id of ids) {
    if (entry.calls.size >= MAX_SPEECH_CALLS) {
      const oldest = entry.calls.values().next().value;
      if (oldest !== undefined) entry.calls.delete(oldest);
    }
    entry.calls.add(id);
  }
}

// Match the runner's retry banner (including unknown SDK counters), not user
// progress text that happens to mention a retry or a file named retry.ts.
const API_RETRY_STATUS_RE =
  /^API (?:重试中 \((?:\d+|\?)\/(?:\d+|\?)\)，\d+s 后重试|retry in progress \((?:\d+|\?)\/(?:\d+|\?)\))$/i;

function cancelPendingDelta(key: string): void {
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  cancelAnimationFrame(entry.raf);
  pendingDeltas.delete(key);
}

function cancelPendingDeltaForRuntime(runtimeJid: string): void {
  for (const [key, entry] of pendingDeltas) {
    if (entry.runtimeJid === runtimeJid) cancelPendingDelta(key);
  }
}

/**
 * Apply a runtime's buffered deltas now, while its run still owns them: a
 * terminal event (run_finished, interrupted, the final message) must not
 * drop the last frame of text or thinking still waiting for rAF.
 */
function flushPendingDeltaForRuntime(
  runtimeJid: string,
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
): void {
  const marker = '#agent:';
  const markerIndex = runtimeJid.indexOf(marker);
  const agentId =
    markerIndex >= 0
      ? runtimeJid.slice(markerIndex + marker.length)
      : undefined;
  const chatJid =
    markerIndex >= 0 ? runtimeJid.slice(0, markerIndex) : runtimeJid;
  const key = agentId ? `agent:${agentId}` : `main:${chatJid}`;
  const entry = pendingDeltas.get(key);
  if (!entry || entry.runtimeJid !== runtimeJid) return;
  cancelAnimationFrame(entry.raf);
  flushPendingDelta(key, chatJid, agentId, set);
}

/**
 * The state a batch of deltas extends: the live projection of the same turn,
 * or a fresh one for a new turn.
 */
function deltaBase(
  current: StreamingState | undefined,
  turnId: string | undefined,
): StreamingState {
  if (!current || (current.turnId && turnId && current.turnId !== turnId)) {
    return { ...DEFAULT_STREAMING_STATE, turnId };
  }
  return turnId && !current.turnId ? { ...current, turnId } : current;
}

function flushPendingDelta(
  key: string,
  chatJid: string,
  agentId: string | undefined,
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
): void {
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  pendingDeltas.delete(key);

  if (agentId) {
    set((s) => {
      if (
        !shouldApplyRunScopedPayload(
          s.activeRuns,
          entry.runtimeJid,
          entry.runId,
        )
      ) {
        return s;
      }
      const current = s.agentStreaming[agentId];
      if (!current && s.agentWaiting[agentId] === false) return s;
      // A stopped card is frozen until its terminal message replaces it.
      if (current?.interrupted) return s;
      const prev = deltaBase(current, entry.turnId);
      const next = applyDeltaChunks(
        prev,
        entry.chunks,
        runStartedAtMs(s.activeRuns, entry.runtimeJid),
      );
      if (next === prev) return s;
      return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
    });
  } else {
    set((s) => {
      if (
        !shouldApplyRunScopedPayload(
          s.activeRuns,
          entry.runtimeJid,
          entry.runId,
        )
      ) {
        return s;
      }
      const current = s.streaming[chatJid];
      if (!current && s.waiting[chatJid] === false) return s;
      if (current?.interrupted) return s;
      const prev = deltaBase(current, entry.turnId);
      const next = applyDeltaChunks(
        prev,
        entry.chunks,
        runStartedAtMs(s.activeRuns, entry.runtimeJid),
      );
      if (next === prev) return s;
      return {
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: { ...s.streaming, [chatJid]: next },
      };
    });
  }
}

function withoutKey<V>(
  record: Record<string, V>,
  key: string,
): Record<string, V> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Settled cards of a workspace's main conversation and all its sessions. */
function withoutWorkspaceSettled(
  settled: Record<string, StreamingState>,
  jid: string,
): Record<string, StreamingState> {
  const prefix = `${jid}#agent:`;
  const keys = Object.keys(settled).filter(
    (key) => key === jid || key.startsWith(prefix),
  );
  if (keys.length === 0) return settled;
  const next = { ...settled };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * A settled card normally gives way to its final message within ~60ms. If
 * none arrives (a missed WebSocket frame, a reply persisted only in the DB),
 * re-sync from the server so the final replaces it; failing that, drop it.
 */
function scheduleSettleFallback(
  runtimeJid: string,
  settled: StreamingState,
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
): void {
  const marker = '#agent:';
  const markerIndex = runtimeJid.indexOf(marker);
  const agentId =
    markerIndex >= 0 ? runtimeJid.slice(markerIndex + marker.length) : null;
  const chatJid =
    markerIndex >= 0 ? runtimeJid.slice(0, markerIndex) : runtimeJid;
  const current = () => get().settledStreaming[runtimeJid];
  setTimeout(async () => {
    if (current() !== settled) return;
    try {
      if (agentId) {
        if (get().agentMessages[agentId]) {
          await get().refreshAgentMessages(chatJid, agentId);
        }
      } else if (get().messages[chatJid]) {
        await get().refreshMessages(chatJid);
      }
    } catch {
      /* fall through to dropping the card */
    }
    if (current() !== settled) return;
    // Its thinking is not kept for "the next reply": a later, unrelated
    // final must not pick it up.
    set((s) =>
      s.settledStreaming[runtimeJid] === settled
        ? { settledStreaming: withoutKey(s.settledStreaming, runtimeJid) }
        : s,
    );
  }, SETTLE_FALLBACK_MS);
}

function scheduleDbTaskAgentCleanup(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  agentId: string,
  chatJid: string,
): void {
  clearDbTaskAgentCleanupTimer(agentId);
  const timer = setTimeout(() => {
    dbTaskAgentCleanupTimers.delete(agentId);
    set((s) => {
      const existing = s.agents[chatJid] || [];
      const filtered = existing.filter((a) => a.id !== agentId);
      if (filtered.length === existing.length) return {};
      const nextActiveTab = { ...s.activeAgentTab };
      if (nextActiveTab[chatJid] === agentId) nextActiveTab[chatJid] = null;
      return {
        agents: { ...s.agents, [chatJid]: filtered },
        activeAgentTab: nextActiveTab,
      };
    });
  }, DB_TASK_AGENT_AUTO_CLEAN_MS);
  dbTaskAgentCleanupTimers.set(agentId, timer);
}

function clearDbTaskAgentCleanupTimer(agentId: string): void {
  const timer = dbTaskAgentCleanupTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    dbTaskAgentCleanupTimers.delete(agentId);
  }
}

function removeSdkTaskAliases(
  aliases: Record<string, string>,
  taskId: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias === taskId || target === taskId) continue;
    next[alias] = target;
  }
  return next;
}

function resolveSdkTaskId(
  state: Pick<ChatState, 'sdkTasks' | 'sdkTaskAliases'>,
  rawId: string,
): string {
  if (state.sdkTasks[rawId]) return rawId;
  return state.sdkTaskAliases[rawId] || rawId;
}

function pickSdkTaskAliasTarget(
  state: Pick<ChatState, 'sdkTasks' | 'sdkTaskAliases' | 'agents'>,
  chatJid: string,
): string | null {
  const runningIds = Object.entries(state.sdkTasks)
    .filter(([, task]) => task.chatJid === chatJid && task.status === 'running')
    .map(([id]) => id);
  if (runningIds.length === 0) return null;

  const usedTargets = new Set(Object.values(state.sdkTaskAliases));
  const unbound = runningIds.filter((id) => !usedTargets.has(id));
  const pool = (unbound.length > 0 ? unbound : runningIds).slice();
  const createdAtMap = new Map(
    (state.agents[chatJid] || []).map((a) => [a.id, a.created_at]),
  );
  pool.sort((a, b) =>
    (createdAtMap.get(a) || '').localeCompare(createdAtMap.get(b) || ''),
  );
  return pool[0] || null;
}

function isTerminalSystemMessage(
  message: Pick<Message, 'sender' | 'content'>,
): boolean {
  if (message.sender === '__billing__') return true;
  // query_interrupted 仅作为视觉分隔线，不参与流式状态清理。
  // 流式状态由 status:interrupted（冻结）→ interrupt_partial（转正）两阶段处理。
  return (
    message.sender === '__system__' &&
    (message.content === 'context_reset' ||
      message.content === 'context_fresh_window' ||
      message.content.startsWith('agent_error:') ||
      message.content.startsWith('agent_max_retries:') ||
      message.content.startsWith('context_overflow:'))
  );
}

function isInterruptSystemMessage(
  message: Pick<Message, 'sender' | 'content'>,
): boolean {
  return (
    message.sender === '__system__' && message.content === 'query_interrupted'
  );
}

function clearSdkTaskCleanupTimer(taskId: string): void {
  const timer = sdkTaskCleanupTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    sdkTaskCleanupTimers.delete(taskId);
  }
}

function clearSdkTaskStaleTimer(taskId: string): void {
  const timer = sdkTaskStaleTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    sdkTaskStaleTimers.delete(taskId);
  }
}

/**
 * Reset the stale timer for a non-teammate SDK task.
 * If no events are received within SDK_TASK_STALE_TIMEOUT_MS, auto-finalize it.
 */
function resetSdkTaskStaleTimer(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
  taskId: string,
  chatJid: string,
): void {
  clearSdkTaskStaleTimer(taskId);
  const timer = setTimeout(() => {
    sdkTaskStaleTimers.delete(taskId);
    const state = get();
    const task = state.sdkTasks[taskId];
    if (task && task.status === 'running' && !task.isTeammate) {
      // Auto-finalize stale task
      set((s) => {
        const existingTask = s.sdkTasks[taskId];
        if (!existingTask || existingTask.status !== 'running') return {};
        return {
          sdkTasks: {
            ...s.sdkTasks,
            [taskId]: { ...existingTask, status: 'completed' as const },
          },
        };
      });
      scheduleSdkTaskCleanup(set, taskId, chatJid, SDK_TASK_AUTO_CLOSE_MS);
    }
  }, SDK_TASK_STALE_TIMEOUT_MS);
  sdkTaskStaleTimers.set(taskId, timer);
}

function doSdkTaskCleanup(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  taskId: string,
  _chatJid: string,
): void {
  sdkTaskCleanupTimers.delete(taskId);
  clearSdkTaskStaleTimer(taskId);
  completedSdkTaskIds.delete(taskId);
  set((s) => {
    const nextSdkTasks = { ...s.sdkTasks };
    delete nextSdkTasks[taskId];
    const nextAliases = removeSdkTaskAliases(s.sdkTaskAliases, taskId);
    return {
      sdkTasks: nextSdkTasks,
      sdkTaskAliases: nextAliases,
    };
  });
}

function scheduleSdkTaskCleanup(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  taskId: string,
  chatJid: string,
  delayMs = SDK_TASK_AUTO_CLOSE_MS,
): void {
  clearSdkTaskCleanupTimer(taskId);
  const timer = setTimeout(() => {
    doSdkTaskCleanup(set, taskId, chatJid);
  }, delayMs);
  sdkTaskCleanupTimers.set(taskId, timer);
}

function pushEvent(
  events: StreamingTimelineEvent[],
  kind: StreamingTimelineEvent['kind'],
  text: string,
): StreamingTimelineEvent[] {
  const item: StreamingTimelineEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind,
    text,
  };
  return [...events, item].slice(-MAX_EVENT_LOG);
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

function traceKind(event: StreamEvent): StreamingTraceEvent['kind'] {
  if (event.eventType.startsWith('tool_'))
    return event.skillName ? 'skill' : 'tool';
  if (event.eventType.startsWith('hook_')) return 'hook';
  if (event.eventType.startsWith('task_')) return 'task';
  if (
    event.eventType === 'memory_recall' ||
    event.eventType === 'compact_boundary'
  )
    return 'memory';
  if (event.eventType === 'permission_denied') return 'permission';
  if (event.eventType === 'raw_sdk_event') return 'debug';
  return 'status';
}

function traceTitle(event: StreamEvent): string {
  if (event.title) return event.title;
  switch (event.eventType) {
    case 'tool_use_start':
      return event.skillName
        ? `技能 ${event.skillName}`
        : `工具 ${event.toolName || 'unknown'}`;
    case 'tool_use_end':
      return `工具完成 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'tool_result':
      return '工具结果';
    case 'tool_progress':
      return `工具进度 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'task_start':
      return `Task 启动`;
    case 'task_progress':
      return `Task 进度`;
    case 'task_updated':
      return `Task 更新`;
    case 'task_notification':
      return `Task ${event.taskStatus || '完成'}`;
    case 'status':
      return event.statusText || '状态更新';
    case 'permission_denied':
      return `权限拒绝 ${event.toolName || ''}`.trim();
    case 'memory_recall':
      return '记忆召回';
    case 'compact_boundary':
      return '上下文压缩';
    case 'notification':
      return '通知';
    case 'prompt_suggestion':
      return '建议';
    default:
      return event.rawType || event.eventType;
  }
}

/** What a trace row says about its event: the first of these it has. */
function traceSummary(event: StreamEvent): string | undefined {
  return (
    event.summary ||
    event.taskSummary ||
    event.statusText ||
    event.toolInputSummary
  );
}

/** The row a tool's start wrote to the trace, if it is still there. */
function toolTraceIndex(
  events: StreamingTraceEvent[],
  toolUseId: string,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (
      row.toolUseId === toolUseId &&
      (row.kind === 'tool' || row.kind === 'skill') &&
      /^(?:工具|技能) /.test(row.title)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * A running tool reports progress many times: say it on the row it already
 * has (its input becomes known, its skill name resolves) instead of writing
 * a row per report, which pushed the rest of the trace out of its bound.
 */
function pushToolProgress(
  events: StreamingTraceEvent[],
  event: StreamEvent,
): StreamingTraceEvent[] {
  if (!event.toolUseId) return events;
  const index = toolTraceIndex(events, event.toolUseId);
  if (index < 0) {
    // A bare elapsed-time heartbeat says nothing the trace could keep; the
    // host does not keep it either.
    if (!traceSummary(event) && !event.skillName) return events;
    const row = traceRow({ ...event, eventType: 'tool_use_start' });
    return [...events, row].slice(-MAX_TRACE_EVENTS);
  }
  const row = events[index];
  const summary = traceSummary(event) || row.summary;
  const skillResolved = !!event.skillName && row.kind !== 'skill';
  if (summary === row.summary && !skillResolved) return events;
  const next = events.slice();
  next[index] = {
    ...row,
    summary,
    ...(skillResolved
      ? { kind: 'skill' as const, title: `技能 ${event.skillName}` }
      : {}),
  };
  return next;
}

function traceRow(event: StreamEvent): StreamingTraceEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind: traceKind(event),
    scope: event.agentScope,
    title: traceTitle(event),
    summary: traceSummary(event),
    detail: event.detail,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    parentToolUseId: event.parentToolUseId,
    displayLevel: event.displayLevel,
  };
}

function pushTrace(
  events: StreamingTraceEvent[],
  event: StreamEvent,
): StreamingTraceEvent[] {
  if (
    event.eventType === 'text_delta' ||
    event.eventType === 'commentary' ||
    event.eventType === 'thinking_delta' ||
    event.eventType === 'thinking_start' ||
    event.eventType === 'thinking_end' ||
    event.eventType === 'usage' ||
    event.eventType === 'init' ||
    event.eventType === 'context_audit' ||
    // Debug rows are never shown; they only used up the trace's bound.
    event.displayLevel === 'debug' ||
    (event.eventType === 'status' &&
      isInternalLifecycleStatus(event.statusText))
  ) {
    return events;
  }
  if (event.eventType === 'tool_progress') {
    return pushToolProgress(events, event);
  }
  return [...events, traceRow(event)].slice(-MAX_TRACE_EVENTS);
}

function taskIdFromEvent(event: StreamEvent): string | null {
  return (
    event.parentToolUseId ||
    event.taskId ||
    (event.eventType === 'task_start' ||
    event.eventType === 'task_progress' ||
    event.eventType === 'task_updated' ||
    event.eventType === 'task_notification'
      ? event.toolUseId || null
      : null)
  );
}

function ensureTaskRuntime(
  taskStates: Record<string, StreamingTaskRuntimeState>,
  taskId: string,
  event: StreamEvent,
): StreamingTaskRuntimeState {
  return (
    taskStates[taskId] || {
      id: taskId,
      title:
        event.taskDescription ||
        event.toolInputSummary ||
        event.summary ||
        'Task',
      status: 'running',
      subagentType: event.subagentType,
      taskType: event.taskType,
      workflowName: event.workflowName,
      workflowRun: event.workflowRun,
      usage: event.sdkTaskUsage,
      thinkingTail: '',
      textTail: '',
      activeTools: [],
      recentTools: [],
      updatedAt: Date.now(),
    }
  );
}

function updateTaskRuntime(
  prev: StreamingState,
  next: StreamingState,
  event: StreamEvent,
): boolean {
  const taskId = taskIdFromEvent(event);
  if (!taskId) return false;
  const taskStates = { ...prev.taskStates };
  const task = { ...ensureTaskRuntime(taskStates, taskId, event) };
  task.updatedAt = Date.now();
  if (event.taskDescription && (!task.title || task.title === 'Task'))
    task.title = event.taskDescription;
  if (event.subagentType) task.subagentType = event.subagentType;
  if (event.taskType) task.taskType = event.taskType;
  if (event.workflowName) task.workflowName = event.workflowName;
  if (event.sdkTaskUsage) task.usage = event.sdkTaskUsage;
  if (event.workflowRun) {
    task.workflowRun = {
      ...(task.workflowRun ?? {}),
      ...event.workflowRun,
      phases:
        event.workflowRun.phases.length > 0
          ? event.workflowRun.phases
          : (task.workflowRun?.phases ?? []),
      agents:
        event.workflowRun.agents.length > 0
          ? event.workflowRun.agents
          : (task.workflowRun?.agents ?? []),
    };
  }

  if (event.eventType === 'text_delta') {
    task.textTail = tail(task.textTail + (event.text || ''), MAX_TASK_TAIL);
  } else if (event.eventType === 'thinking_delta') {
    task.thinkingTail = tail(
      task.thinkingTail + (event.text || ''),
      MAX_TASK_TAIL,
    );
  } else if (event.eventType === 'task_progress') {
    task.status = 'running';
    task.latestSummary =
      event.summary ||
      event.taskSummary ||
      event.taskDescription ||
      task.latestSummary;
    task.lastToolName = event.lastToolName || task.lastToolName;
    if (task.workflowRun && event.sdkTaskUsage) {
      task.workflowRun = {
        ...task.workflowRun,
        status: 'running',
        totalTokens: event.sdkTaskUsage.totalTokens,
        totalToolCalls: event.sdkTaskUsage.toolUses,
        durationMs: event.sdkTaskUsage.durationMs,
      };
    }
  } else if (event.eventType === 'task_updated') {
    const patch = event.taskPatch;
    if (patch?.status === 'completed') task.status = 'completed';
    else if (
      patch?.status === 'failed' ||
      patch?.status === 'killed' ||
      patch?.status === 'stopped' ||
      patch?.status === 'aborted'
    )
      task.status = 'error';
    else if (patch?.is_backgrounded) task.status = 'backgrounded';
    else if (patch?.status === 'running' || patch?.status === 'pending')
      task.status = 'running';
    task.latestSummary =
      event.summary || patch?.description || patch?.error || task.latestSummary;
  } else if (event.eventType === 'task_notification') {
    task.status = event.taskStatus === 'completed' ? 'completed' : 'error';
    task.latestSummary =
      event.taskSummary || event.summary || task.latestSummary;
    if (task.workflowRun) {
      task.workflowRun = {
        ...task.workflowRun,
        status: event.taskStatus === 'completed' ? 'completed' : 'failed',
        completedAt: task.workflowRun.completedAt ?? Date.now(),
      };
    }
  } else if (event.eventType === 'tool_use_start' && event.parentToolUseId) {
    const tool = {
      toolName: event.toolName || 'unknown',
      toolUseId: event.toolUseId || '',
      startTime: Date.now(),
      parentToolUseId: event.parentToolUseId,
      isNested: event.isNested,
      skillName: event.skillName,
      toolInputSummary: event.toolInputSummary,
      toolInput: event.toolInput,
    };
    task.activeTools = task.activeTools.some(
      (t) => t.toolUseId === tool.toolUseId && tool.toolUseId,
    )
      ? task.activeTools.map((t) =>
          t.toolUseId === tool.toolUseId ? { ...t, ...tool } : t,
        )
      : [...task.activeTools, tool];
    task.recentTools = pushEvent(
      task.recentTools,
      event.skillName ? 'skill' : 'tool',
      `${event.skillName ? `技能 ${event.skillName}` : `工具 ${event.toolName || 'unknown'}`}${event.toolInputSummary ? ` (${event.toolInputSummary})` : ''}`,
    );
  } else if (event.eventType === 'tool_use_end' && event.parentToolUseId) {
    task.activeTools = task.activeTools.filter(
      (t) => t.toolUseId !== event.toolUseId,
    );
    task.recentTools = pushEvent(
      task.recentTools,
      'tool',
      `✓ ${event.toolName || event.toolUseId || '工具'}`,
    );
  } else if (event.eventType === 'tool_progress' && event.parentToolUseId) {
    task.activeTools = task.activeTools.map((t) =>
      t.toolUseId === event.toolUseId
        ? {
            ...t,
            elapsedSeconds: event.elapsedSeconds,
            toolInputSummary: event.toolInputSummary || t.toolInputSummary,
          }
        : t,
    );
  }
  taskStates[taskId] = task;
  next.taskStates = taskStates;
  return true;
}

/** Tools whose end comes from their own lifecycle, not their tool_result. */
const TOOLS_ENDED_BY_LIFECYCLE = new Set(['Task', 'Agent', 'Skill']);

function stepStatusOfTask(
  status: StreamingTaskRuntimeState['status'],
): StepStatus {
  if (status === 'completed') return 'done';
  return status === 'error' ? 'error' : 'running';
}

/**
 * Mirror a task event into the step list: the task's card keeps its details
 * in `taskStates`; the step holds its place in the order and its summary.
 * Runs after `updateTaskRuntime`, so the status is the task's own.
 */
function applyTaskToSteps(
  event: StreamEvent,
  prev: StreamingState,
  next: StreamingState,
  at: number,
): void {
  // A task event with a parent belongs to a task nested in another.
  if (event.parentToolUseId) return;
  const taskId = taskIdFromEvent(event);
  if (!taskId) return;
  let list = stepsOf(next);
  if (!hasTaskStep(list, taskId)) {
    list = closeOpenSteps(list, at, prev.partialText, prev.partialBase ?? 0);
  }
  const task = next.taskStates[taskId];
  list = ensureTaskStep(
    list,
    {
      taskId,
      toolUseId: event.toolUseId,
      title: event.taskDescription || event.toolInputSummary || task?.title,
      summary: task?.latestSummary,
    },
    at,
  );
  if (task) {
    list = setTaskStepStatus(
      list,
      taskId,
      stepStatusOfTask(task.status),
      at,
      task.latestSummary,
    );
  }
  setSteps(next, list);
}

/**
 * Apply a single StreamEvent to a StreamingState object.
 * Shared by main conversation and SDK subagent streaming.
 */
function applyStreamEvent(
  event: StreamEvent,
  prev: StreamingState,
  next: StreamingState,
  maxText: number,
  runStartedAt?: number,
): void {
  if (event.turnId) next.turnId = event.turnId;
  if (event.sessionId) next.sessionId = event.sessionId;
  next.traceEvents = pushTrace(prev.traceEvents || [], event);
  const at = Date.now();
  switch (event.eventType) {
    case 'text_delta': {
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
        break;
      }
      endThinkingBurst(prev, next, at);
      if (event.text) appendReplyText(prev, next, event.text, at, maxText);
      next.awaitingModel = false;
      next.phaseStartedAt = undefined;
      if (isPhaseStatus(prev.systemStatus)) next.systemStatus = null;
      break;
    }
    case 'commentary': {
      // A proactive workspace's narration before a tool call, whole. It is a
      // step of the process, never the reply: no partial text is involved.
      if (isSubagentEvent(event) || !event.text) break;
      endThinkingBurst(prev, next, at);
      setSteps(next, addCommentaryStep(stepsOf(next), at, event.text));
      break;
    }
    case 'thinking_delta': {
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
        break;
      }
      beginThinkingBurst(prev, next, runStartedAt, at);
      appendThinking(prev, next, event.text || '', at);
      break;
    }
    case 'thinking_start': {
      // Sub-agents do not send these; their reasoning is their task's tail.
      if (isSubagentEvent(event)) break;
      beginThinkingBurst(prev, next, runStartedAt, at);
      break;
    }
    case 'thinking_end': {
      if (isSubagentEvent(event)) break;
      endThinkingBurst(prev, next, at, event.thinkingDurationMs);
      break;
    }
    case 'tool_use_start': {
      // A sub-agent's tool is not the main agent's: its own reasoning goes on.
      if (!isSubagentEvent(event)) endThinkingBurst(prev, next, at);
      if (!event.parentToolUseId) {
        next.awaitingModel = false;
        next.phaseStartedAt = undefined;
        if (isPhaseStatus(prev.systemStatus)) next.systemStatus = null;
      }
      const toolUseId = event.toolUseId || '';
      if (toolUseId && !isUnderTask(stepsOf(next), event.parentToolUseId)) {
        // Text before a tool was commentary; the tool is the next step.
        setSteps(
          next,
          startToolStep(
            closeOpenSteps(
              stepsOf(next),
              at,
              prev.partialText,
              prev.partialBase ?? 0,
            ),
            {
              toolUseId,
              toolName: event.toolName || 'unknown',
              skillName: event.skillName,
              summary: event.toolInputSummary,
            },
            at,
          ),
        );
      }
      const existing = prev.activeTools.find(
        (t) => t.toolUseId === toolUseId && toolUseId,
      );
      const tool = {
        toolName: event.toolName || 'unknown',
        toolUseId,
        startTime: Date.now(),
        parentToolUseId: event.parentToolUseId,
        isNested: event.isNested,
        skillName: event.skillName,
        toolInputSummary: event.toolInputSummary,
      };
      next.activeTools = existing
        ? prev.activeTools.map((t) =>
            t.toolUseId === toolUseId ? { ...t, ...tool } : t,
          )
        : [...prev.activeTools, tool];
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
      }

      const isSkill = tool.toolName === 'Skill';
      const label = isSkill
        ? `技能 ${tool.skillName || 'unknown'}`
        : `工具 ${tool.toolName}`;
      const detail = tool.toolInputSummary ? ` (${tool.toolInputSummary})` : '';
      next.recentEvents = pushEvent(
        prev.recentEvents,
        isSkill ? 'skill' : 'tool',
        `${label}${detail}`,
      );
      break;
    }
    case 'tool_use_end':
      if (event.toolUseId) {
        const ended = prev.activeTools.find(
          (t) => t.toolUseId === event.toolUseId,
        );
        next.activeTools = prev.activeTools.filter(
          (t) => t.toolUseId !== event.toolUseId,
        );
        if (!isUnderTask(stepsOf(next), event.parentToolUseId)) {
          setSteps(next, endToolStep(stepsOf(next), event.toolUseId, at));
        }
        if (ended) {
          const rawSec = (Date.now() - ended.startTime) / 1000;
          const elapsedSec =
            rawSec % 1 === 0 ? rawSec.toFixed(0) : rawSec.toFixed(1);
          const isSkill = ended.toolName === 'Skill';
          const label = isSkill
            ? `技能 ${ended.skillName || 'unknown'}`
            : `工具 ${ended.toolName}`;
          next.recentEvents = pushEvent(
            prev.recentEvents,
            isSkill ? 'skill' : 'tool',
            `✓ ${label} (${elapsedSec}s)`,
          );
          if (!event.parentToolUseId && !ended.isNested) {
            // The model takes over again: the next burst starts here.
            next.awaitingModel = true;
            next.phaseStartedAt = Date.now();
          }
        }
      }
      // An end event without a toolUseId is malformed — ignore it instead of
      // clearing ALL active tools, which would make genuinely-running tools
      // suddenly vanish from the UI. Matches the feishu card + WS snapshot
      // behaviour (both key off toolUseId and skip idless ends).
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
      }
      break;
    case 'tool_result': {
      // A returned tool is done even before the runner infers its end from
      // the next assistant message; the status line must not keep saying
      // "正在运行命令" while the model is already on its next step. Task and
      // Skill keep their own lifecycle (sub-agent events, nested tools).
      if (!event.toolUseId || event.parentToolUseId) break;
      setSteps(
        next,
        endToolStep(stepsOf(next), event.toolUseId, at, event.toolResult, {
          isError: event.toolIsError,
          facts: event.toolResultFacts,
        }),
      );
      const ended = prev.activeTools.find(
        (t) => t.toolUseId === event.toolUseId,
      );
      if (!ended || TOOLS_ENDED_BY_LIFECYCLE.has(ended.toolName)) break;
      next.activeTools = prev.activeTools.filter(
        (t) => t.toolUseId !== event.toolUseId,
      );
      const rawSec = (Date.now() - ended.startTime) / 1000;
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'tool',
        `✓ 工具 ${ended.toolName} (${rawSec % 1 === 0 ? rawSec.toFixed(0) : rawSec.toFixed(1)}s)`,
      );
      if (!ended.isNested) {
        next.awaitingModel = true;
        next.phaseStartedAt = Date.now();
      }
      break;
    }
    case 'tool_progress': {
      const existing = prev.activeTools.find(
        (t) => t.toolUseId === event.toolUseId,
      );
      if (existing) {
        const skillNameResolved = event.skillName && !existing.skillName;
        next.activeTools = prev.activeTools.map((t) =>
          t.toolUseId === event.toolUseId
            ? {
                ...t,
                elapsedSeconds: event.elapsedSeconds,
                ...(event.skillName ? { skillName: event.skillName } : {}),
                ...(event.toolInput ? { toolInput: event.toolInput } : {}),
                ...(event.toolInputSummary
                  ? { toolInputSummary: event.toolInputSummary }
                  : {}),
              }
            : t,
        );
        if (skillNameResolved) {
          const oldLabel = `技能 unknown`;
          const newLabel = `技能 ${event.skillName}`;
          next.recentEvents = prev.recentEvents.map((e) =>
            e.kind === 'skill' && e.text.includes(oldLabel)
              ? { ...e, text: e.text.replace(oldLabel, newLabel) }
              : e,
          );
        }
      } else {
        next.activeTools = [
          ...prev.activeTools,
          {
            toolName: event.toolName || 'unknown',
            toolUseId: event.toolUseId || '',
            startTime: Date.now(),
            parentToolUseId: event.parentToolUseId,
            isNested: event.isNested,
            elapsedSeconds: event.elapsedSeconds,
            ...(event.toolInputSummary
              ? { toolInputSummary: event.toolInputSummary }
              : {}),
          },
        ];
      }
      if (
        event.toolUseId &&
        !isUnderTask(stepsOf(next), event.parentToolUseId)
      ) {
        setSteps(
          next,
          progressToolStep(
            stepsOf(next),
            {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              skillName: event.skillName,
              summary: event.toolInputSummary,
            },
            at,
          ),
        );
      }
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
      }
      break;
    }
    case 'task_start': {
      updateTaskRuntime(prev, next, event);
      applyTaskToSteps(event, prev, next, at);
      const desc =
        event.taskDescription ||
        event.toolInputSummary ||
        event.summary ||
        'Task';
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'task',
        `Task 启动: ${desc}`,
      );
      break;
    }
    case 'task_progress': {
      updateTaskRuntime(prev, next, event);
      applyTaskToSteps(event, prev, next, at);
      const label = event.lastToolName
        ? `Task 进度 [${event.lastToolName}]`
        : 'Task 进度';
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'task',
        `${label}: ${event.summary || event.taskDescription || ''}`,
      );
      break;
    }
    case 'task_updated': {
      updateTaskRuntime(prev, next, event);
      applyTaskToSteps(event, prev, next, at);
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'task',
        `Task 更新: ${event.summary || event.taskPatch?.status || ''}`,
      );
      break;
    }
    case 'task_notification': {
      updateTaskRuntime(prev, next, event);
      applyTaskToSteps(event, prev, next, at);
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'task',
        `Task ${event.taskStatus === 'completed' ? '完成' : '结束'}: ${event.taskSummary || event.summary || ''}`,
      );
      break;
    }
    case 'hook_started':
      next.activeHook = {
        hookName: event.hookName || '',
        hookEvent: event.hookEvent || '',
      };
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'hook',
        `Hook 开始: ${event.hookName || 'unknown'} (${event.hookEvent || 'unknown'})`,
      );
      break;
    case 'hook_progress':
      next.activeHook = {
        hookName: event.hookName || '',
        hookEvent: event.hookEvent || '',
      };
      break;
    case 'hook_response':
      next.activeHook = null;
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'hook',
        `Hook 结束: ${event.hookName || 'unknown'} (${event.hookOutcome || 'success'})`,
      );
      break;
    case 'todo_update':
      if (event.todos) {
        next.todos = event.todos;
      }
      break;
    case 'status': {
      next.systemStatus = event.statusText || null;
      // A new model request: thinking that follows started here, and until
      // something comes back the model is the one at work.
      if (event.statusText === 'requesting' && !event.parentToolUseId) {
        // The previous request is over: reasoning that follows is a new block.
        endThinkingBurst(prev, next, at);
        next.phaseStartedAt = at;
        next.awaitingModel = true;
      }
      if (event.statusText && !isInternalLifecycleStatus(event.statusText)) {
        next.recentEvents = pushEvent(
          prev.recentEvents,
          'status',
          `状态: ${event.statusText}`,
        );
      }
      break;
    }
    case 'permission_denied': {
      const pd = event.permissionDenied;
      const tool = pd?.toolName || event.toolName || '';
      const why =
        pd?.reason ||
        pd?.message ||
        event.summary ||
        event.detail ||
        '权限被拒绝';
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'permission',
        `🚫 ${tool ? `${tool}: ` : ''}${why}`.trim(),
      );
      if (pd?.toolUseId) {
        setSteps(next, failToolStep(stepsOf(next), pd.toolUseId, at, why));
      }
      break;
    }
    case 'memory_recall':
    case 'compact_boundary':
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'memory',
        event.summary || traceTitle(event),
      );
      break;
    case 'notification':
    case 'prompt_suggestion':
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'status',
        event.summary || traceTitle(event),
      );
      break;
    case 'raw_sdk_event':
      if (event.displayLevel === 'primary') {
        next.recentEvents = pushEvent(
          prev.recentEvents,
          'debug',
          event.summary || traceTitle(event),
        );
      }
      break;
    case 'context_audit':
      // Operator-only runtime diagnostics; intentionally absent from chat UI.
      break;
    case 'usage':
      // Token usage is handled at handleStreamEvent level (direct message table update).
      // No streaming state mutation needed.
      break;
    case 'init':
      // Internal signal, no UI handling needed.
      break;
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  groups: {},
  adminHostOnlyMode: false,
  currentGroup: null,
  messages: {},
  waiting: {},
  activeRuns: {},
  pendingMessageUsage: {},
  followUps: {},
  hasMore: {},
  loading: false,
  error: null,
  streaming: {},
  thinkingCache: {},
  thinkingDurationCache: {},
  traceCache: {},
  stepsCache: {},
  turnTraceStatus: {},
  stopRequests: {},
  settledStreaming: {},
  pendingThinking: {},
  pendingThinkingDuration: {},
  clearing: {},
  agents: {},
  agentStreaming: {},
  // Active sub-conversation tab is mirrored from URL (?agent=...) by ChatView.
  // The store holds an in-memory copy for components that read it directly.
  activeAgentTab: {},
  sdkTasks: {},
  sdkTaskAliases: {},
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  drafts: {},
  unreadReplies: {},

  loadGroups: async () => {
    // 桌面端（侧边栏 + ChatPage）会各触发一次；同一时刻只发一个请求。
    if (loadGroupsInFlight) return loadGroupsInFlight;
    loadGroupsInFlight = (async () => {
      set({ loading: true });
      try {
        const data =
          (await takeGroupsPrewarm()) ??
          (await api.get<GroupsResponse>('/api/groups'));
        const groups = Object.fromEntries(
          Object.entries(data.groups).map(([jid, group]) => [
            jid,
            normalizeGroupInteractionMode(group),
          ]),
        );
        set((state) => {
          const currentStillExists =
            state.currentGroup && !!groups[state.currentGroup];

          let nextCurrent = currentStillExists ? state.currentGroup : null;
          // The first load lands before ChatPage syncs the route into the
          // store. Defaulting to home there made the sidebar expand home and
          // fetch its session list on every load of another workspace.
          const routeFolder = nextCurrent ? null : currentRouteChatFolder();
          if (!nextCurrent && routeFolder) {
            nextCurrent = findRouteGroupJid(groups, routeFolder);
          }
          if (!nextCurrent) {
            const homeEntry = Object.entries(groups).find(
              ([_, group]) => group.is_my_home,
            );
            if (homeEntry) {
              nextCurrent = homeEntry[0];
            } else {
              nextCurrent = Object.keys(groups)[0] || null;
            }
          }

          return {
            groups,
            adminHostOnlyMode: data.admin_host_only_mode === true,
            currentGroup: nextCurrent,
            loading: false,
            error: null,
          };
        });
      } catch (err) {
        set({
          loading: false,
          error: extractErrorMessage(err),
        });
      }
    })().finally(() => {
      loadGroupsInFlight = null;
    });
    return loadGroupsInFlight;
  },

  selectGroup: (jid: string) => {
    set({ currentGroup: jid });
    const state = get();
    if (!state.messages[jid]) {
      get().loadMessages(jid);
    }
  },

  loadMessages: async (jid: string, loadMore = false) => {
    const state = get();
    const existing = state.messages[jid] || [];
    const beforeSequence = loadMore
      ? messageSequenceBoundary(existing, 'min')
      : undefined;
    const before =
      loadMore && beforeSequence === undefined && existing.length > 0
        ? existing[0].timestamp
        : undefined;

    // 首屏有两个入口（ChatPage 路由解析 + ChatView 挂载）会各发一次同参请求；
    // 同一目标的首页加载在途时直接复用，避免重复拉 50 条。
    const inFlightKey = `${jid}\0${beforeSequence ?? before ?? 'first'}`;
    const inFlight = loadMessagesInFlight.get(inFlightKey);
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
          `/api/groups/${encodeURIComponent(jid)}/messages?${new URLSearchParams(
            beforeSequence !== undefined
              ? { beforeSequence: String(beforeSequence), limit: '50' }
              : before
                ? { before: String(before), limit: '50' }
                : { limit: '50' },
          )}`,
        );
        // Messages come in DESC order from API, reverse to chronological for display
        const sorted = [...data.messages].reverse();
        set((s) => {
          const mergedUsage = mergePendingMessageUsage(
            mergeMessagesChronologically(s.messages[jid] || [], sorted),
            s.pendingMessageUsage,
            jid,
          );
          const merged = mergedUsage.messages;
          const nextWaiting = { ...s.waiting };
          if (s.activeRuns[jid]) {
            nextWaiting[jid] = true;
          } else {
            delete nextWaiting[jid];
          }

          return {
            pendingMessageUsage: mergedUsage.pending,
            messages: {
              ...s.messages,
              [jid]: merged,
            },
            waiting: nextWaiting,
            hasMore: { ...s.hasMore, [jid]: data.hasMore },
            error: null,
          };
        });
      } catch (err) {
        set({ error: extractErrorMessage(err) });
      }
    })().finally(() => {
      loadMessagesInFlight.delete(inFlightKey);
    });
    loadMessagesInFlight.set(inFlightKey, request);
    return request;
  },

  refreshMessages: async (jid: string) => {
    // Skip polling while clearHistory is in-flight to prevent race re-injection
    if (get().clearing[jid]) return;

    const state = get();
    const existing = state.messages[jid] || [];
    const lastSequence = messageSequenceBoundary(existing, 'max');
    const lastTs =
      lastSequence === undefined && existing.length > 0
        ? existing[existing.length - 1].timestamp
        : undefined;

    try {
      // Fetch messages newer than the last one we have
      const params = new URLSearchParams({ limit: '50' });
      if (lastSequence !== undefined) {
        params.set('afterSequence', String(lastSequence));
      } else if (lastTs) {
        params.set('after', lastTs);
      }

      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );

      // Re-check clearing lock after async fetch — clearHistory may have started mid-request
      if (get().clearing[jid]) return;

      if (data.messages.length > 0) {
        // Messages from getMessagesAfter are already in ASC order
        set((s) => {
          const mergedUsage = mergePendingMessageUsage(
            mergeMessagesChronologically(s.messages[jid] || [], data.messages),
            s.pendingMessageUsage,
            jid,
          );
          const merged = mergedUsage.messages;
          // Check if agent has truly finalized (explicit sdk_send_message should not clear streaming)
          // interrupt_partial 到达时若流式卡片已冻结（运行仍在），不视为"agent 已回复"，
          // 避免清除冻结的富内容。消息仍添加到列表，10s 兜底计时器做最终清理。
          const streamState = s.streaming[jid];
          const settledState = s.settledStreaming[jid];
          const exactRunActive = !!s.activeRuns[jid];
          const isFrozen = !!streamState?.interrupted;
          const agentReplied = data.messages.some(
            (m) =>
              m.is_from_me &&
              m.sender !== '__system__' &&
              m.source_kind !== 'sdk_send_message' &&
              !(isFrozen && m.source_kind === 'interrupt_partial'),
          );
          const hasSystemError = data.messages.some((m) =>
            isTerminalSystemMessage(m),
          );
          // Same rule as a live final message: it replaces a settled or
          // stopped card, never the projection of a newer active run.
          const finalizes =
            (agentReplied || hasSystemError) &&
            (!exactRunActive || isFrozenProjection(streamState));

          // Move the finished reply's thinking and execution details onto it.
          const lastAiMsg = agentReplied
            ? [...data.messages]
                .reverse()
                .find(
                  (m) =>
                    m.is_from_me &&
                    m.sender !== '__system__' &&
                    m.source_kind !== 'sdk_send_message',
                )
            : undefined;
          // A settled card always belongs to a finished run: any new reply
          // replaces it, whatever the live projection of a newer run does.
          const replacesSettled = !!settledState && agentReplied;
          const replyCaches = !lastAiMsg
            ? {}
            : replacesSettled
              ? finalizedReplyCaches(s, settledState, lastAiMsg.id)
              : finalizes
                ? finalizedReplyCaches(
                    s,
                    streamState,
                    lastAiMsg.id,
                    s.pendingThinking[jid],
                    s.pendingThinkingDuration[jid],
                  )
                : {};
          let nextPendingThinking = s.pendingThinking;
          let nextPendingThinkingDuration = s.pendingThinkingDuration;
          if (finalizes && lastAiMsg) {
            const { [jid]: _, ...restPending } = s.pendingThinking;
            nextPendingThinking = restPending;
            const { [jid]: __, ...restPendingDur } = s.pendingThinkingDuration;
            nextPendingThinkingDuration = restPendingDur;
          }

          return {
            ...replyCaches,
            ...(replacesSettled || (settledState && hasSystemError)
              ? { settledStreaming: withoutKey(s.settledStreaming, jid) }
              : {}),
            pendingMessageUsage: mergedUsage.pending,
            messages: { ...s.messages, [jid]: merged },
            waiting:
              finalizes && !exactRunActive
                ? { ...s.waiting, [jid]: false }
                : s.waiting,
            streaming: finalizes
              ? (() => {
                  const next = { ...s.streaming };
                  delete next[jid];
                  return next;
                })()
              : s.streaming,
            pendingThinking: nextPendingThinking,
            pendingThinkingDuration: nextPendingThinkingDuration,
            error: null,
          };
        });
      }
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  sendMessage: async (
    jid: string,
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior: FollowUpMode = 'queue',
  ) => {
    try {
      // streaming 状态由以下 3 条路径正确清理，sendMessage 不应无条件清空：
      // 1. handleWsNewMessage 收到 is_from_me 消息时
      // 2. agent_reply WebSocket 事件时
      // 3. status:interrupted 事件时

      const body: {
        chatJid: string;
        content: string;
        attachments?: Array<{ type: 'image'; data: string; mimeType: string }>;
        followUpBehavior: FollowUpMode;
      } = { chatJid: jid, content, followUpBehavior };
      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map((att) => ({
          type: 'image',
          ...att,
        }));
      }

      type ClearedResponse = { success: true; cleared: true };
      type MessageCreateResponse =
        | ClearedResponse
        | {
            success: true;
            messageId: string;
            timestamp: string;
            ingestSequence?: number;
            disposition: 'started' | 'queued' | 'steered';
            runId?: string;
          }
        | { success: false };
      const isClearedResponse = (
        d: MessageCreateResponse,
      ): d is ClearedResponse =>
        d.success === true && 'cleared' in d && d.cleared === true;

      const data = await api.post<MessageCreateResponse>(
        '/api/messages',
        body,
        attachmentTimeoutMs(body.attachments),
      );
      if (!data.success) {
        // Server returned non-success payload — surface as a send failure so caller can retain input.
        const msg = '服务器返回失败，请重试';
        set({ error: msg });
        showToast('发送失败', msg);
        return false;
      }
      // /clear was intercepted server-side: skip local user message merge.
      // The context_reset divider arrives via WS new_message and triggers state cleanup.
      if (isClearedResponse(data)) return true;
      if (data.disposition === 'started' && data.runId) {
        get().handleRunStarted(jid, data.runId);
      }
      // Add user message to local state immediately
      const authState = useAuthStore.getState();
      const sender = authState.user?.id || 'web-user';
      const senderName =
        authState.user?.display_name || authState.user?.username || 'Web';
      const msg: Message = {
        id: data.messageId,
        chat_jid: jid,
        sender,
        sender_name: senderName,
        content,
        // Use server timestamp so incremental polling cursor stays monotonic with backend data.
        timestamp: data.timestamp,
        ingest_sequence: data.ingestSequence,
        // is_from_me is from the bot's perspective: true = bot sent it, false = human sent it
        is_from_me: false,
        attachments: body.attachments
          ? JSON.stringify(body.attachments)
          : undefined,
        delivery_mode:
          data.disposition === 'queued'
            ? 'queue'
            : data.disposition === 'steered'
              ? 'steer'
              : null,
        delivery_status:
          data.disposition === 'started'
            ? null
            : data.disposition === 'queued'
              ? 'queued'
              : 'queued',
        delivery_run_id: data.runId ?? null,
        delivery_updated_at:
          data.disposition === 'started' ? null : data.timestamp,
      };
      set((s) => {
        const existing = s.messages[jid] || [];
        if (!s.messages[jid]) {
          console.warn(
            '[sendMessage] messages[jid] is undefined at send time',
            { jid, storeKeys: Object.keys(s.messages) },
          );
        }
        const merged = mergeMessagesChronologically(existing, [msg]);
        const latest = merged.length > 0 ? merged[merged.length - 1] : null;
        const shouldWait =
          !!latest &&
          latest.is_from_me === false &&
          !isTerminalSystemMessage(latest);
        return {
          messages: {
            ...s.messages,
            [jid]: merged,
          },
          waiting: { ...s.waiting, [jid]: shouldWait },
          error: null,
        };
      });
      if (data.disposition !== 'started') {
        void get().loadFollowUps(jid);
      }
      return true;
    } catch (err) {
      // 弱网/断网/后端 500 等场景：记录错误并给用户可见的 toast，
      // 返回 false 让调用方（MessageInput）保留输入不清空。
      const message = extractErrorMessage(err);
      set({ error: message });
      showToast('发送失败', '消息未发送，输入已保留，请检查网络后重试');
      return false;
    }
  },

  loadFollowUps: async (chatJid) => {
    try {
      const data = await api.get<{ items: QueuedFollowUp[] }>(
        `/api/follow-ups?${new URLSearchParams({ chatJid })}`,
      );
      set((s) => ({
        followUps: { ...s.followUps, [chatJid]: data.items },
        ...patchFollowUpMessages(s, chatJid, data.items),
      }));
    } catch (err) {
      console.warn('[follow-ups] failed to load queue', err);
    }
  },

  handleFollowUpUpdate: (chatJid, items, transition) => {
    set((s) => ({
      followUps: { ...s.followUps, [chatJid]: items },
      ...patchFollowUpMessages(s, chatJid, items, transition),
    }));
  },

  actOnFollowUp: async (chatJid, messageId, action, expectedRunId, content) => {
    try {
      const result = await api.post<{ ok: boolean; message: string }>(
        `/api/follow-ups/${encodeURIComponent(messageId)}/action`,
        {
          chatJid,
          action,
          ...(expectedRunId ? { expectedRunId } : {}),
          ...(content !== undefined ? { content } : {}),
        },
      );
      await get().loadFollowUps(chatJid);
      if (!result.ok) showToast('操作未执行', result.message);
      return result.ok;
    } catch (err) {
      const message =
        typeof err === 'object' && err && 'message' in err
          ? String(err.message)
          : '操作失败，请稍后重试';
      showToast('操作未执行', message);
      await get().loadFollowUps(chatJid);
      return false;
    }
  },

  interruptQuery: async (jid: string) => {
    // Answer the click at once: the run shows "正在停止…" with its timer
    // frozen while the interrupt travels; text already in flight still lands.
    set((s) => ({ stopRequests: { ...s.stopRequests, [jid]: Date.now() } }));
    const clearStopRequest = () =>
      set((s) => ({ stopRequests: withoutKey(s.stopRequests, jid) }));
    try {
      const data = await api.post<{ success: boolean; interrupted: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/interrupt`,
      );
      if (!data.interrupted) {
        clearStopRequest();
        // Agent 已完成，无活跃查询可中断。
        // 解析虚拟 JID 判断是 agent 还是主会话，清除卡住的状态。
        const agentSep = jid.indexOf('#agent:');
        if (agentSep >= 0) {
          const agentId = jid.slice(agentSep + 7);
          // Cancel pending rAF to prevent stale flushes
          const agentKey = `agent:${agentId}`;
          const pendingEntry = pendingDeltas.get(agentKey);
          if (pendingEntry) {
            cancelAnimationFrame(pendingEntry.raf);
            pendingDeltas.delete(agentKey);
          }
          set((s) => {
            const nextStreaming = { ...s.agentStreaming };
            delete nextStreaming[agentId];
            return {
              agentStreaming: nextStreaming,
              agentWaiting: { ...s.agentWaiting, [agentId]: false },
            };
          });
        } else {
          get().clearStreaming(jid);
        }
        return false;
      }

      // 中断已发出，后端 status:interrupted 事件会驱动 UI 冻结。
      return true;
    } catch (err) {
      const message = extractErrorMessage(err);
      clearStopRequest();
      set({ error: message });
      // The run keeps going; say so instead of silently restoring the button.
      showToast('停止失败', message || '请检查网络后重试');
      return false;
    }
  },

  resetSession: async (jid: string, agentId?: string) => {
    // Hold the clearing lock for main-session reset so late-arriving stream
    // events from the soon-to-be-killed process can't repopulate UI state
    // (same lock clearHistory uses at chat.ts ~1105). Agent-specific reset
    // is scoped narrowly enough that the lock isn't needed.
    // Release the lock BEFORE calling refreshMessages/loadAgentMessages,
    // which themselves honor `clearing[jid]` and would otherwise skip.
    const useLock = !agentId;
    if (useLock) {
      set((s) => ({ clearing: { ...s.clearing, [jid]: true } }));
    }
    let succeeded = false;
    try {
      await api.post<{ success: boolean; dividerMessageId: string }>(
        `/api/groups/${encodeURIComponent(jid)}/reset-session`,
        agentId ? { agentId } : undefined,
      );
      set((s) => ({
        pendingMessageUsage: clearPendingMessageUsage(
          s.pendingMessageUsage,
          jid,
          agentId,
        ),
      }));
      if (agentId) {
        set((s) => {
          const nextStreaming = { ...s.agentStreaming };
          delete nextStreaming[agentId];
          const nextWaiting = { ...s.agentWaiting };
          delete nextWaiting[agentId];
          return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
        });
      } else {
        get().clearStreaming(jid, { preserveThinking: false });
      }
      succeeded = true;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    } finally {
      if (useLock) {
        set((s) => {
          const { [jid]: _, ...nextClearing } = s.clearing;
          return { clearing: nextClearing };
        });
      }
    }
    if (succeeded) {
      if (agentId) await get().loadAgentMessages(jid, agentId);
      else await get().refreshMessages(jid);
    }
    return succeeded;
  },

  clearHistory: async (jid: string) => {
    // Set clearing lock BEFORE the API call to block polling & WS injection
    set((s) => ({ clearing: { ...s.clearing, [jid]: true } }));

    try {
      await api.post<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/clear-history`,
      );

      void deleteGroupMessageSnapshots(jid);

      set((s) => {
        // Delete the key entirely (not []==[]) so selectGroup/ChatView effect
        // will trigger loadMessages on re-entry
        const nextMessages = { ...s.messages };
        delete nextMessages[jid];
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[jid];
        const { [jid]: _pending, ...nextPendingThinking } = s.pendingThinking;
        const { [jid]: _clearing, ...nextClearing } = s.clearing;

        // Collect sub-agent IDs that belonged to this workspace so we can
        // scrub their per-agent state — backend has deleted the agent rows
        // already, leaving these Maps orphaned otherwise.
        const staleAgentIds = (s.agents[jid] || []).map((a) => a.id);
        const nextAgents = { ...s.agents };
        delete nextAgents[jid];
        const nextAgentMessages = { ...s.agentMessages };
        const nextAgentStreaming = { ...s.agentStreaming };
        const nextAgentWaiting = { ...s.agentWaiting };
        for (const aid of staleAgentIds) {
          delete nextAgentMessages[aid];
          delete nextAgentStreaming[aid];
          delete nextAgentWaiting[aid];
        }

        // Reset UI-scoped state tied to this workspace jid.
        const nextDrafts = { ...s.drafts };
        delete nextDrafts[jid];
        const nextActiveAgentTab = { ...s.activeAgentTab };
        delete nextActiveAgentTab[jid];

        // Purge SDK Task state that originated from this workspace.
        const nextSdkTasks = { ...s.sdkTasks };
        const droppedTaskKeys = new Set<string>();
        for (const [taskKey, info] of Object.entries(s.sdkTasks)) {
          if (info.chatJid === jid) {
            delete nextSdkTasks[taskKey];
            droppedTaskKeys.add(taskKey);
          }
        }
        const nextSdkTaskAliases = { ...s.sdkTaskAliases };
        for (const [alias, canonical] of Object.entries(s.sdkTaskAliases)) {
          if (droppedTaskKeys.has(canonical)) delete nextSdkTaskAliases[alias];
        }

        return {
          messages: nextMessages,
          waiting: { ...s.waiting, [jid]: false },
          hasMore: { ...s.hasMore, [jid]: false },
          streaming: nextStreaming,
          settledStreaming: withoutWorkspaceSettled(s.settledStreaming, jid),
          pendingThinking: nextPendingThinking,
          clearing: nextClearing,
          thinkingCache: retainThinkingCacheForMessages(
            { ...nextAgentMessages, ...nextMessages },
            s.thinkingCache,
          ),
          thinkingDurationCache: retainThinkingCacheForMessages(
            { ...nextAgentMessages, ...nextMessages },
            s.thinkingDurationCache,
          ),
          traceCache: retainThinkingCacheForMessages(
            { ...nextAgentMessages, ...nextMessages },
            s.traceCache,
          ),
          stepsCache: retainThinkingCacheForMessages(
            { ...nextAgentMessages, ...nextMessages },
            s.stepsCache,
          ),
          turnTraceStatus: retainThinkingCacheForMessages(
            { ...nextAgentMessages, ...nextMessages },
            s.turnTraceStatus,
          ),
          agents: nextAgents,
          pendingMessageUsage: clearPendingMessageUsage(
            s.pendingMessageUsage,
            jid,
            undefined,
            true,
          ),
          agentMessages: nextAgentMessages,
          agentStreaming: nextAgentStreaming,
          agentWaiting: nextAgentWaiting,
          drafts: nextDrafts,
          activeAgentTab: nextActiveAgentTab,
          sdkTasks: nextSdkTasks,
          sdkTaskAliases: nextSdkTaskAliases,
          error: null,
        };
      });

      await get().loadGroups();
      await get().loadAgents(jid, { force: true });
      // 重建工作区后刷新文件列表（工作目录已被清空）
      useFileStore.getState().loadFiles(jid);
      return true;
    } catch (err) {
      // Release clearing lock on failure
      set((s) => {
        const { [jid]: _, ...nextClearing } = s.clearing;
        return {
          clearing: nextClearing,
          error: extractErrorMessage(err),
        };
      });
      return false;
    }
  },

  handleMessageDeleted: async (messageChatJid, messageId) => {
    const agentMarker = '#agent:';
    const agentSep = messageChatJid.indexOf(agentMarker);
    const workspaceJid =
      agentSep >= 0 ? messageChatJid.slice(0, agentSep) : null;
    const agentId =
      agentSep >= 0
        ? messageChatJid.slice(agentSep + agentMarker.length)
        : null;

    set((s) => {
      const matchesDeletedRow = (message: Message) =>
        message.id === messageId && message.chat_jid === messageChatJid;
      const messages = { ...s.messages };
      for (const [key, list] of Object.entries(messages)) {
        if (list.some(matchesDeletedRow)) {
          messages[key] = list.filter((message) => !matchesDeletedRow(message));
        }
      }

      const agentMessages = { ...s.agentMessages };
      for (const [key, list] of Object.entries(agentMessages)) {
        if (list.some(matchesDeletedRow)) {
          agentMessages[key] = list.filter(
            (message) => !matchesDeletedRow(message),
          );
        }
      }

      if (!workspaceJid || !agentId) return { messages, agentMessages };

      // The Session sidebar has its own latest-message projection. Update it
      // immediately from the loaded page, then force an authoritative refresh
      // below in case the previous message is outside that page.
      const loaded = agentMessages[agentId];
      const latest = loaded?.[loaded.length - 1];
      const agents = { ...s.agents };
      if (agents[workspaceJid]) {
        agents[workspaceJid] = agents[workspaceJid].map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                latest_message: latest
                  ? { content: latest.content, timestamp: latest.timestamp }
                  : null,
              }
            : agent,
        );
      }
      return { messages, agentMessages, agents };
    });

    if (workspaceJid && agentId) {
      // A deleted sensitive message must not survive in the PWA's persisted
      // hydrate cache. Await invalidation so an immediate reload cannot race it.
      await deleteAgentMessageSnapshot(workspaceJid, agentId);
      await get().loadAgents(workspaceJid, { force: true });
    }
  },

  handleMessageTrace: (messageChatJid, messageId) => {
    const agentMarker = '#agent:';
    const agentSep = messageChatJid.indexOf(agentMarker);
    const workspaceJid =
      agentSep >= 0 ? messageChatJid.slice(0, agentSep) : null;
    const agentId =
      agentSep >= 0
        ? messageChatJid.slice(agentSep + agentMarker.length)
        : null;
    const isIt = (message: Message) =>
      message.id === messageId && message.chat_jid === messageChatJid;
    const marks = (message: Message) => isIt(message) && !message.has_trace;
    const mark = (list: Message[]) =>
      list.map((message) =>
        marks(message) ? { ...message, has_trace: true } : message,
      );

    let snapshot: { messages: Message[]; hasMore: boolean } | null = null;
    let known = false;
    set((s) => {
      known =
        Object.values(s.messages).some((list) => list.some(isIt)) ||
        Object.values(s.agentMessages).some((list) => list.some(isIt));
      let messages = s.messages;
      for (const [key, list] of Object.entries(s.messages)) {
        if (list.some(marks)) {
          messages = { ...messages, [key]: mark(list) };
        }
      }
      let agentMessages = s.agentMessages;
      for (const [key, list] of Object.entries(s.agentMessages)) {
        if (!list.some(marks)) continue;
        const updated = mark(list);
        agentMessages = { ...agentMessages, [key]: updated };
        if (key === agentId) {
          snapshot = { messages: updated, hasMore: !!s.agentHasMore[key] };
        }
      }
      if (messages === s.messages && agentMessages === s.agentMessages) {
        return s;
      }
      return { messages, agentMessages };
    });
    // A message with attachments is announced after its thumbnails are made, so
    // this can arrive first: keep the mark for the message when it does.
    if (!known) rememberPendingTraceMark(messageChatJid, messageId);
    // The PWA repaints a session from its stored snapshot first: keep the
    // flag there too, or a reload before the next fetch would drop the rows.
    if (workspaceJid && agentId && snapshot) {
      const { messages, hasMore } = snapshot;
      void saveAgentMessageSnapshot(workspaceJid, agentId, messages, hasMore);
    }
  },

  deleteMessage: async (jid: string, messageId: string) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/messages/${encodeURIComponent(messageId)}`,
      );
      await get().handleMessageDeleted(jid, messageId);
      return true;
    } catch (err) {
      const message = extractErrorMessage(err) || '删除聊天记录失败';
      set({ error: message });
      showToast('删除失败', message);
      return false;
    }
  },

  createFlow: async (name: string, options?: CreateWorkspaceOptions) => {
    try {
      const body: Record<string, unknown> = { name };
      if (options?.execution_mode) body.execution_mode = options.execution_mode;
      if (options?.custom_cwd) body.custom_cwd = options.custom_cwd;
      if (options?.init_source_path)
        body.init_source_path = options.init_source_path;
      if (options?.init_git_url) body.init_git_url = options.init_git_url;
      if (options?.agent_profile_id)
        body.agent_profile_id = options.agent_profile_id;
      body.interaction_mode = normalizeInteractionMode(
        options?.interaction_mode,
      );
      if (options?.additional_mounts?.length)
        body.additional_mounts = options.additional_mounts;

      const needsLongTimeout = !!(
        options?.init_source_path || options?.init_git_url
      );
      const data = await api.post<{
        success: boolean;
        jid: string;
        group: GroupInfo;
      }>('/api/groups', body, needsLongTimeout ? 120_000 : undefined);
      if (!data.success) {
        throw new Error('服务器未能创建工作区');
      }

      const group = normalizeGroupInteractionMode(data.group);
      set((s) => ({
        groups: { ...s.groups, [data.jid]: group },
        error: null,
      }));

      return { jid: data.jid, folder: group.folder };
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  renameFlow: async (jid: string, name: string) => {
    try {
      await api.patch<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}`,
        { name },
      );
      set((s) => {
        const group = s.groups[jid];
        if (!group) return s;
        return {
          groups: {
            ...s.groups,
            [jid]: {
              ...group,
              name,
            },
          },
          error: null,
        };
      });
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  updateInteractionMode: async (jid, interactionMode) => {
    try {
      await api.patch<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}`,
        { interaction_mode: interactionMode },
      );
      const patchGroups = (groups: Record<string, GroupInfo>) => {
        const group = groups[jid];
        if (!group) return groups;
        return {
          ...groups,
          [jid]: { ...group, interaction_mode: interactionMode },
        };
      };
      // The caches of the process the mode no longer shows go with the
      // groups (see the subscription below the store).
      set((state) => ({
        groups: patchGroups(state.groups),
        error: null,
      }));
      useGroupsStore.setState((state) => ({
        groups: patchGroups(state.groups),
      }));
      return true;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      return false;
    }
  },

  updateProcessVisibility: async (jid, requested) => {
    try {
      const saved = await api.patch<{
        success: boolean;
        process_visibility?: string;
      }>(`/api/groups/${encodeURIComponent(jid)}`, {
        process_visibility: requested,
      });
      // The server echoes the level now in force; an older one says nothing.
      const processVisibility = normalizeProcessVisibility(
        saved?.process_visibility ?? requested,
      );
      const patchGroups = (groups: Record<string, GroupInfo>) => {
        const group = groups[jid];
        if (!group) return groups;
        return {
          ...groups,
          [jid]: { ...group, process_visibility: processVisibility },
        };
      };
      set((state) => {
        // A level lowered mid-run must not leave what it hides in memory.
        const scrub = isProactiveRuntime(state, jid);
        const nextStreaming = { ...state.streaming };
        if (scrub && nextStreaming[jid]) {
          nextStreaming[jid] = scrubForVisibility(
            nextStreaming[jid],
            processVisibility,
          );
        }
        const nextAgentStreaming = { ...state.agentStreaming };
        for (const agent of state.agents[jid] ?? []) {
          if (
            isProactiveRuntime(state, `${jid}#agent:${agent.id}`) &&
            nextAgentStreaming[agent.id]
          ) {
            nextAgentStreaming[agent.id] = scrubForVisibility(
              nextAgentStreaming[agent.id],
              processVisibility,
            );
          }
        }
        return {
          groups: patchGroups(state.groups),
          streaming: nextStreaming,
          agentStreaming: nextAgentStreaming,
          error: null,
        };
      });
      useGroupsStore.setState((state) => ({
        groups: patchGroups(state.groups),
      }));
      return true;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      return false;
    }
  },

  togglePin: async (jid: string) => {
    const group = get().groups[jid];
    if (!group) return;
    const willPin = !group.pinned_at;
    try {
      const data = await api.patch<{ success: boolean; pinned_at?: string }>(
        `/api/groups/${encodeURIComponent(jid)}`,
        { is_pinned: willPin },
      );
      set((s) => {
        const g = s.groups[jid];
        if (!g) return s;
        return {
          groups: {
            ...s.groups,
            [jid]: {
              ...g,
              pinned_at: willPin
                ? data.pinned_at || new Date().toISOString()
                : undefined,
            },
          },
        };
      });
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  inspectDeleteFlow: async (jid: string) =>
    api.get<WorkspaceDeleteImpact>(
      `/api/groups/${encodeURIComponent(jid)}/delete-impact`,
    ),

  deleteFlow: async (jid: string, options = {}) => {
    try {
      const query = options.unbindChannels ? '?unbind_channels=true' : '';
      await api.delete<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}${query}`,
      );
      // Workspace 已删除，连带把该 jid 下所有 conversation agent 的 IDB 快照
      // 也清掉，避免 IDB 长期堆积孤儿条目。
      void deleteGroupMessageSnapshots(jid);
      set((s) => {
        const nextGroups = { ...s.groups };
        const nextMessages = { ...s.messages };
        const nextWaiting = { ...s.waiting };
        const nextHasMore = { ...s.hasMore };
        const nextStreaming = { ...s.streaming };
        const nextPendingThinking = { ...s.pendingThinking };

        delete nextGroups[jid];
        delete nextMessages[jid];
        delete nextWaiting[jid];
        delete nextHasMore[jid];
        delete nextStreaming[jid];
        delete nextPendingThinking[jid];

        let nextCurrent = s.currentGroup === jid ? null : s.currentGroup;
        // Auto-select first remaining group after deletion
        if (nextCurrent === null) {
          const remainingJids = Object.keys(nextGroups);
          nextCurrent = remainingJids.length > 0 ? remainingJids[0] : null;
        }

        return {
          groups: nextGroups,
          pendingMessageUsage: clearPendingMessageUsage(
            s.pendingMessageUsage,
            jid,
            undefined,
            true,
          ),
          messages: nextMessages,
          waiting: nextWaiting,
          hasMore: nextHasMore,
          streaming: nextStreaming,
          settledStreaming: withoutWorkspaceSettled(s.settledStreaming, jid),
          pendingThinking: nextPendingThinking,
          thinkingCache: retainThinkingCacheForMessages(
            { ...s.agentMessages, ...nextMessages },
            s.thinkingCache,
          ),
          thinkingDurationCache: retainThinkingCacheForMessages(
            { ...s.agentMessages, ...nextMessages },
            s.thinkingDurationCache,
          ),
          traceCache: retainThinkingCacheForMessages(
            { ...s.agentMessages, ...nextMessages },
            s.traceCache,
          ),
          stepsCache: retainThinkingCacheForMessages(
            { ...s.agentMessages, ...nextMessages },
            s.stepsCache,
          ),
          turnTraceStatus: retainThinkingCacheForMessages(
            { ...s.agentMessages, ...nextMessages },
            s.turnTraceStatus,
          ),
          currentGroup: nextCurrent,
          error: null,
        };
      });
    } catch (err: unknown) {
      const apiErr = err as {
        status?: number;
        body?: Record<string, unknown>;
        message?: string;
      };
      if (
        apiErr.status === 409 &&
        (apiErr.body?.bound_sessions ||
          apiErr.body?.bound_agents ||
          apiErr.body?.bound_main_im_groups ||
          apiErr.body?.bound_thread_contexts)
      ) {
        const e = new Error(
          apiErr.message || 'IM binding conflict',
        ) as Error & {
          boundSessions?: unknown;
          boundAgents?: unknown;
          boundMainImGroups?: unknown;
          boundThreadContexts?: unknown;
        };
        e.boundSessions = apiErr.body.bound_sessions;
        e.boundAgents = apiErr.body.bound_agents;
        e.boundMainImGroups = apiErr.body.bound_main_im_groups;
        e.boundThreadContexts = apiErr.body.bound_thread_contexts;
        throw e;
      }
      const message = apiErr.message || extractErrorMessage(err);
      set({ error: message });
      throw err;
    }
  },

  // 处理流式事件
  loadTurnTrace: async (message) => {
    const { id, chat_jid: jid, turn_id: turnId } = message;
    if (!turnId) return false;
    const current = get();
    if (current.turnTraceStatus[id] === 'loading') return false;
    // Steps a tab rebuilt from a snapshot are asked for again, to be replaced
    // by the server's; whatever else a cache holds is all there is to load.
    const upgrading = current.stepsCache[id]?.provisional === true;
    if (
      !upgrading &&
      (current.thinkingCache[id] !== undefined ||
        current.thinkingDurationCache[id] !== undefined ||
        current.traceCache[id] !== undefined ||
        current.stepsCache[id] !== undefined)
    ) {
      return true;
    }
    set((s) => ({
      turnTraceStatus: { ...s.turnTraceStatus, [id]: 'loading' },
    }));
    // What the server answers is for the view the workspace had when asked.
    // If the owner has changed it since (the caches were let go meanwhile),
    // the answer is not written: it would put back what the old view showed,
    // or mark the reply empty for a view that may show it. The request that
    // is still the latest only gives up its 'loading', so the reply can be
    // asked for again under the new view.
    const request = Symbol(id);
    turnTraceRequests.set(id, request);
    const viewAsked = processViewOfRuntime(current, jid);
    const stale = () =>
      turnTraceRequests.get(id) !== request ||
      processViewOfRuntime(get(), jid) !== viewAsked;
    const finish = () => {
      if (turnTraceRequests.get(id) === request) turnTraceRequests.delete(id);
    };
    const dropped = (): boolean => {
      if (!stale()) return false;
      if (turnTraceRequests.get(id) === request) {
        set((s) => {
          if (s.turnTraceStatus[id] !== 'loading') return s;
          const status = { ...s.turnTraceStatus };
          delete status[id];
          return { turnTraceStatus: status };
        });
      }
      finish();
      return true;
    };
    try {
      const data = await api.get<TurnTraceResponse>(
        `/api/groups/${encodeURIComponent(jid)}/turn-traces/${encodeURIComponent(turnId)}`,
      );
      if (dropped()) return false;
      const proactive = isProactiveRuntime(get(), jid);
      const thinking = capThinkingText(data.thinking || '');
      const duration = data.thinking_duration_ms ?? undefined;
      const rows = (Array.isArray(data.trace) ? data.trace : []).filter(
        isUserVisibleTraceEvent,
      );
      // The host keeps the speech tool's rows of a proactive turn; the live
      // view leaves them out, so the reloaded one does too.
      const trace = capCachedTrace(proactive ? withoutSpeechTool(rows) : rows);
      // A proactive turn's speech tool is no step either, and what a tool or a
      // sub-agent returned is not shown (the server leaves both out already; a
      // server that sends more cannot put them on screen).
      const sent = Array.isArray(data.steps) ? data.steps : [];
      const steps = proactive
        ? sent
            .filter((step) => step.toolName !== SPEECH_TOOL_NAME)
            .map(withoutToolResults)
        : sent;
      const keepsSteps = hasListedSteps(steps);
      const keepsDuration =
        duration !== undefined &&
        Number.isFinite(duration) &&
        duration > 0 &&
        (!!thinking || duration >= 1000);
      set((s) => {
        const status = { ...s.turnTraceStatus };
        // A card already shows the steps this tab has: the server having
        // nothing more is no reason to take it away.
        if (
          !upgrading &&
          !thinking &&
          !keepsDuration &&
          trace.length === 0 &&
          !keepsSteps
        ) {
          status[id] = 'empty';
        } else {
          delete status[id];
        }
        const held = s.stepsCache[id];
        return {
          turnTraceStatus: capThinkingCache(status),
          ...(thinking
            ? {
                thinkingCache: capThinkingCache({
                  ...s.thinkingCache,
                  [id]: thinking,
                }),
              }
            : {}),
          ...(keepsDuration
            ? {
                thinkingDurationCache: capThinkingCache({
                  ...s.thinkingDurationCache,
                  [id]: duration,
                }),
              }
            : {}),
          ...(trace.length > 0
            ? {
                traceCache: capThinkingCache({
                  ...s.traceCache,
                  [id]: trace,
                }),
              }
            : {}),
          ...(keepsSteps
            ? {
                stepsCache: withReplySteps(s, id, {
                  steps,
                  dropped:
                    typeof data.steps_dropped === 'number' &&
                    data.steps_dropped > 0
                      ? data.steps_dropped
                      : 0,
                }),
              }
            : upgrading && held
              ? { stepsCache: { ...s.stepsCache, [id]: notProvisional(held) } }
              : {}),
        };
      });
      return true;
    } catch (err) {
      // A turn the server no longer shows (its owner hid the process) is
      // nothing to load; anything else may work on the next ask.
      if (dropped()) return false;
      const gone = (err as { status?: number } | null)?.status === 404;
      set((s) => {
        const status = { ...s.turnTraceStatus };
        const held = s.stepsCache[id];
        if (upgrading) {
          // The reader keeps the card they have, and nothing is marked on it.
          delete status[id];
          return {
            turnTraceStatus: status,
            // Gone for good: do not ask again. A failure may work next time.
            ...(gone && held
              ? { stepsCache: { ...s.stepsCache, [id]: notProvisional(held) } }
              : {}),
          };
        }
        return {
          turnTraceStatus: { ...status, [id]: gone ? 'empty' : 'failed' },
        };
      });
      return false;
    } finally {
      finish();
    }
  },

  handleStreamEvent: (chatJid, event, agentId, runId) => {
    // Skip while clearHistory is in-flight
    if (get().clearing[chatJid]) return;

    // Runtime context audits may contain host paths and prompt wiring. They are
    // useful to operators, but never belong in a user's conversation state.
    if (event.eventType === 'context_audit') return;

    const runtimeJid = agentId ? `${chatJid}#agent:${agentId}` : chatJid;
    if (!shouldApplyRunScopedPayload(get().activeRuns, runtimeJid, runId)) {
      return;
    }

    if (event.eventType === 'usage' && event.usage) {
      // Warm delivery IDs differ from presentation turn IDs. An old protocol
      // event may use only an exact turn match; never guess the latest reply.
      const inputTurnId = event.inputTurnId || event.turnId;
      if (!inputTurnId) return;
      const usage = event.usage;
      // input_total replaces the complete input snapshot, including when it
      // arrives before the final. Legacy result batches are already merged by
      // the host; both formats replace here instead of re-counting replayed data.
      const tokenUsageJson = JSON.stringify({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        reasoningTokens: usage.reasoningTokens,
        costUSD: usage.costUSD,
        durationMs: usage.durationMs,
        numTurns: usage.numTurns,
        modelUsage: usage.modelUsage,
      });
      let snapshotMessages: Message[] | undefined;
      let snapshotHasMore = false;
      set((s) => {
        const pending = prunePendingMessageUsage(s.pendingMessageUsage);
        const messages = agentId
          ? s.agentMessages[agentId] || []
          : s.messages[chatJid] || [];
        let targetIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (
            isUsageAnswer(messages[i], runtimeJid) &&
            messages[i].turn_id === inputTurnId
          ) {
            targetIdx = i;
            break;
          }
        }
        const key = messageUsageKey(chatJid, agentId, inputTurnId);
        if (targetIdx < 0) {
          pending[key] = {
            chatJid,
            agentId,
            inputTurnId,
            tokenUsageJson,
            receivedAt: Date.now(),
          };
          return { pendingMessageUsage: prunePendingMessageUsage(pending) };
        }
        delete pending[key];
        const updated = [...messages];
        updated[targetIdx] = {
          ...updated[targetIdx],
          token_usage: tokenUsageJson,
        };
        if (agentId) {
          snapshotMessages = updated;
          snapshotHasMore = !!s.agentHasMore[agentId];
          return {
            agentMessages: { ...s.agentMessages, [agentId]: updated },
            pendingMessageUsage: pending,
          };
        }
        return {
          messages: { ...s.messages, [chatJid]: updated },
          pendingMessageUsage: pending,
        };
      });
      if (agentId && snapshotMessages) {
        void saveAgentMessageSnapshot(
          chatJid,
          agentId,
          snapshotMessages,
          snapshotHasMore,
        );
      }
      return;
    }

    // A proactive workspace shows the process at the level its owner chose and
    // never its model text: whatever else reaches the Web is dropped here,
    // even if the host sent it.
    if (isProactiveRuntime(get(), runtimeJid)) {
      const allowed = filterProactiveStreamEvent(
        normalizeProcessVisibility(get().groups[chatJid]?.process_visibility),
        event,
      );
      if (!allowed) return;
      event = allowed;
      // Calling the speech tool is the reply itself, not work to watch: it is
      // neither a step nor the latest tool, and does not count among the tools
      // used. Its start still ends the reasoning before it.
      if (isSpeechToolEvent(event, speechCallsOf(runtimeJid, runId))) {
        if (event.eventType === 'tool_use_start' && event.toolUseId) {
          rememberSpeechCalls(runtimeJid, runId, [event.toolUseId]);
          // Keep arrival order: reasoning still waiting for its frame came first.
          flushPendingDeltaForRuntime(runtimeJid, set);
          set((s) => {
            const prev = agentId
              ? s.agentStreaming[agentId]
              : s.streaming[chatJid];
            if (!prev || prev.interrupted) return s;
            const next = { ...prev };
            endThinkingBurst(prev, next, Date.now());
            next.awaitingModel = false;
            next.phaseStartedAt = undefined;
            return agentId
              ? { agentStreaming: { ...s.agentStreaming, [agentId]: next } }
              : { streaming: { ...s.streaming, [chatJid]: next } };
          });
        }
        return;
      }
    }

    // Clear in receive order: an older rAF batch must not erase a newer retry.
    // Child activity does not mean the parent request has recovered.
    if (
      !event.parentToolUseId &&
      (event.eventType === 'tool_use_start' ||
        ((event.eventType === 'text_delta' ||
          event.eventType === 'thinking_delta') &&
          !!event.text))
    ) {
      set((s) => {
        const prev = agentId ? s.agentStreaming[agentId] : s.streaming[chatJid];
        if (
          !prev ||
          prev.interrupted ||
          !API_RETRY_STATUS_RE.test(prev.systemStatus || '')
        ) {
          return s;
        }
        const next = { ...prev, systemStatus: null };
        if (agentId) {
          return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
        }
        return { streaming: { ...s.streaming, [chatJid]: next } };
      });
    }

    // ⓪ text_delta / thinking_delta — rAF batch for both agent and main
    // conversation. A sub-agent's own text and reasoning (it has a parent tool)
    // is its task's tail, not the reply's, in a session as in the main stream.
    if (
      (event.eventType === 'text_delta' ||
        event.eventType === 'thinking_delta') &&
      !event.parentToolUseId
    ) {
      const key = agentId ? `agent:${agentId}` : `main:${chatJid}`;
      let entry = pendingDeltas.get(key);
      if (entry && (entry.runtimeJid !== runtimeJid || entry.runId !== runId)) {
        cancelPendingDelta(key);
        entry = undefined;
      }
      if (entry && event.turnId && entry.turnId !== event.turnId) {
        // A new turn: settle the old turn's frame before starting this one.
        cancelAnimationFrame(entry.raf);
        flushPendingDelta(key, chatJid, agentId, set);
        entry = undefined;
      }
      const chunk = {
        thinking: event.eventType === 'thinking_delta',
        text: event.text || '',
      };
      if (entry) {
        // Already have a pending rAF — just accumulate, keeping arrival order
        entry.chunks.push(chunk);
        return;
      }
      entry = {
        chunks: [chunk],
        raf: 0,
        runtimeJid,
        runId,
        turnId: event.turnId,
      };
      entry.raf = requestAnimationFrame(() => {
        flushPendingDelta(key, chatJid, agentId, set);
      });
      pendingDeltas.set(key, entry);
      return;
    }

    // Keep arrival order: text/thinking still waiting for rAF happened before
    // this event (a tool start must not be overtaken by the thinking that
    // preceded it).
    flushPendingDeltaForRuntime(runtimeJid, set);

    // ① conversation agent（DB 持久化的）
    if (agentId) {
      if (event.eventType === 'status' && event.statusText === 'interrupted') {
        // 与主会话一致的两阶段处理：先冻结（保留已输出内容），
        // 等 new_message (interrupt_partial) 到达后完成最终清理。
        const key = `agent:${agentId}`;
        const pendingEntry = pendingDeltas.get(key);
        if (pendingEntry) {
          cancelAnimationFrame(pendingEntry.raf);
          flushPendingDelta(key, chatJid, agentId, set);
        }
        set((s) => {
          const frozen = freezeStreamingState(s.agentStreaming[agentId]);
          const nextStreaming = { ...s.agentStreaming };
          if (frozen) {
            nextStreaming[agentId] = frozen;
          } else {
            delete nextStreaming[agentId];
          }
          return {
            agentStreaming: nextStreaming,
            agentWaiting: { ...s.agentWaiting, [agentId]: false },
          };
        });

        // Fallback：10s 后如果 new_message 未到达，强制清除冻结状态
        setTimeout(() => {
          const state = get();
          if (
            state.agentStreaming[agentId]?.interrupted &&
            !state.agentWaiting[agentId]
          ) {
            set((s) => {
              const next = { ...s.agentStreaming };
              delete next[agentId];
              return { agentStreaming: next };
            });
          }
        }, 10_000);
        return;
      }

      set((s) => {
        // Guard: if streaming was already cleared (agent reply received),
        // ignore late-arriving stream events to prevent "thinking" reappearing.
        if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false) {
          return s;
        }
        // A stopped card stays frozen until its terminal message arrives.
        const current = s.agentStreaming[agentId];
        if (current?.interrupted) return s;
        const prev = resolveStreamingPrev(current, event);
        const next = { ...prev };
        applyStreamEvent(
          event,
          prev,
          next,
          MAX_STREAMING_TEXT,
          runStartedAtMs(s.activeRuns, runtimeJid),
        );
        return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
      });
      return;
    }

    const ensureSdkTask = (
      taskId: string,
      description?: string,
      isTeammate?: boolean,
    ) => {
      set((s) => {
        const existingTask = s.sdkTasks[taskId];
        const desc = description || existingTask?.description || 'Task';
        const teammate = isTeammate || existingTask?.isTeammate || false;

        return {
          sdkTasks: {
            ...s.sdkTasks,
            [taskId]: {
              chatJid,
              description: desc,
              status: 'running' as const,
              summary: existingTask?.summary,
              startedAt: existingTask?.startedAt || Date.now(),
              ...(teammate ? { isTeammate: true } : {}),
            },
          },
        };
      });
      // Start stale timer for non-teammate tasks
      if (!isTeammate) {
        resetSdkTaskStaleTimer(set, get, taskId, chatJid);
      }
    };

    const resolveOrBindTaskId = (rawId: string): string => {
      const state = get();
      const resolved = resolveSdkTaskId(state, rawId);
      if (state.sdkTasks[resolved]) return resolved;
      const target = pickSdkTaskAliasTarget(state, chatJid);
      if (target && rawId !== target) {
        set((s) => ({
          sdkTaskAliases: { ...s.sdkTaskAliases, [rawId]: target },
        }));
        return target;
      }
      return resolved;
    };

    const finalizeSdkTask = (
      taskId: string,
      status: 'completed' | 'error',
      summary?: string,
      closeAfterMs = SDK_TASK_AUTO_CLOSE_MS,
    ) => {
      clearSdkTaskStaleTimer(taskId);
      completedSdkTaskIds.add(taskId);
      let targetChatJid: string | null = null;
      set((s) => {
        const existingTask = s.sdkTasks[taskId];
        if (!existingTask) return {};
        const taskChatJid = existingTask.chatJid || chatJid;
        targetChatJid = taskChatJid;
        return {
          sdkTasks: {
            ...s.sdkTasks,
            [taskId]: {
              chatJid: taskChatJid,
              description: existingTask.description,
              status,
              summary: summary ?? existingTask.summary,
              ...(existingTask.isTeammate ? { isTeammate: true } : {}),
            },
          },
        };
      });
      if (targetChatJid) {
        scheduleSdkTaskCleanup(set, taskId, targetChatJid, closeAfterMs);
      }
    };

    // ② task_start / Task tool start → 创建/更新虚拟 Agent（SDK Task）
    if (
      (event.eventType === 'task_start' && event.toolUseId) ||
      (event.eventType === 'tool_use_start' &&
        event.toolName === 'Task' &&
        event.toolUseId)
    ) {
      ensureSdkTask(
        event.toolUseId!,
        event.taskDescription || event.toolInputSummary,
        event.isTeammate,
      );
      // 不 return — 让 task_start 同时落入主对话 streaming（显示 Task 工具卡片）
    }

    if (
      event.eventType === 'task_progress' &&
      (event.toolUseId || event.taskId)
    ) {
      const resolvedTaskId = resolveOrBindTaskId(
        event.toolUseId || event.taskId!,
      );
      set((s) => {
        const existing = s.sdkTasks[resolvedTaskId];
        if (!existing) return {};
        return {
          sdkTasks: {
            ...s.sdkTasks,
            [resolvedTaskId]: {
              ...existing,
              description: event.taskDescription || existing.description,
              summary: event.summary || event.taskSummary || existing.summary,
            },
          },
        };
      });
    }

    if (
      event.eventType === 'task_updated' &&
      (event.toolUseId || event.taskId)
    ) {
      const resolvedTaskId = resolveOrBindTaskId(
        event.toolUseId || event.taskId!,
      );
      const patchStatus = event.taskPatch?.status;
      if (
        patchStatus === 'completed' ||
        patchStatus === 'failed' ||
        patchStatus === 'killed' ||
        patchStatus === 'stopped' ||
        patchStatus === 'aborted'
      ) {
        finalizeSdkTask(
          resolvedTaskId,
          patchStatus === 'completed' ? 'completed' : 'error',
          event.summary || event.taskPatch?.error,
        );
      }
    }

    // ③ task_notification → 标记完成/失败并自动关闭标签页
    if (event.eventType === 'task_notification' && event.taskId) {
      const resolvedTaskId = resolveOrBindTaskId(event.taskId);
      finalizeSdkTask(
        resolvedTaskId,
        event.taskStatus === 'completed' ? 'completed' : 'error',
        event.taskSummary,
      );

      // Toast + 浏览器通知（仅限后台任务）
      // stream-processor 为前台 Task 合成的 task_notification 不带 isBackground 标记，
      // 仅 SDK 原生的后台完成事件携带 isBackground: true。
      if (
        event.isBackground &&
        shouldEmitBackgroundTaskNotice(resolvedTaskId)
      ) {
        const taskInfo = get().sdkTasks[resolvedTaskId];
        const desc = (
          taskInfo?.description ||
          event.taskSummary ||
          '后台任务'
        ).slice(0, 60);
        const status = event.taskStatus === 'completed' ? '已完成' : '失败';
        if (typeof document === 'undefined' || !document.hidden) {
          showToast(`${desc} ${status}`, event.taskSummary);
        }
        notifyIfHidden(`HappyClaw: ${desc} ${status}`, event.taskSummary);
      }

      set((s) => {
        const current = s.streaming[chatJid];
        if (!current || current.interrupted) return s;
        const prev = resolveStreamingPrev(current, event);
        const next = { ...prev };
        applyStreamEvent(
          event,
          prev,
          next,
          MAX_STREAMING_TEXT,
          runStartedAtMs(s.activeRuns, runtimeJid),
        );
        return {
          streaming: { ...s.streaming, [chatJid]: next },
        };
      });

      // 不落入主对话 streaming
      return;
    }

    // ④ parentToolUseId 匹配已知 SDK Task → 刷新 stale timer，事件落入主对话 streaming
    if (event.parentToolUseId) {
      const tid = resolveOrBindTaskId(event.parentToolUseId);
      const state = get();
      const knownTask = !!state.sdkTasks[tid];
      if (knownTask) {
        if (completedSdkTaskIds.has(tid)) return;
        const task = state.sdkTasks[tid];
        if (task && !task.isTeammate) {
          resetSdkTaskStaleTimer(set, get, tid, chatJid);
        }
        // 不 return — 让事件落入主对话 streaming（步骤⑥）
      }
    }

    // ⑤ task tool_use_end 兜底：若 task_notification 缺失，仍然收敛状态并自动关闭
    if (event.eventType === 'tool_use_end' && event.toolUseId) {
      const resolvedToolUseId = resolveOrBindTaskId(event.toolUseId);
      const task = get().sdkTasks[resolvedToolUseId];
      if (task && task.status === 'running') {
        finalizeSdkTask(
          resolvedToolUseId,
          'completed',
          task.summary,
          SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS,
        );
      }
      // fall-through 到主对话处理，移除 activeTools 中的 Task 条目
    }

    // turn 干净结束信号（silent-success：agent 仅用 send_message 旁路回复或最终
    // result 为空，后端不会发 sdk_final new_message 来清 waiting）。直接清除 streaming
    // 与 waiting，避免 spinner/思考动画永久残留。那些 send_message 已作为独立 new_message
    // 在消息列表中，无需保留 streaming 富内容。
    if (event.eventType === 'status' && event.statusText === 'idle') {
      // status:idle predates exact GroupQueue query IDs. While a precise run
      // is active this can be a late event from its predecessor, so only the
      // matching run_finished event may close the waiting state.
      if (get().activeRuns[chatJid]) return;
      const mainKey = `main:${chatJid}`;
      const pendingEntry = pendingDeltas.get(mainKey);
      if (pendingEntry) {
        cancelAnimationFrame(pendingEntry.raf);
        pendingDeltas.delete(mainKey);
      }
      set((s) => {
        if (!s.streaming[chatJid] && s.waiting[chatJid] === false) return s;
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[chatJid];
        const nextPendingThinking = { ...s.pendingThinking };
        delete nextPendingThinking[chatJid];
        return {
          waiting: { ...s.waiting, [chatJid]: false },
          streaming: nextStreaming,
          pendingThinking: nextPendingThinking,
        };
      });
      return;
    }

    // 中断事件：冻结流式 UI（保留已输出文本），等待 new_message 完成最终转换。
    if (event.eventType === 'status' && event.statusText === 'interrupted') {
      // 强制 flush rAF 缓冲：thinking_delta/text_delta 通过 requestAnimationFrame 批处理，
      // 中断信号可能在 rAF 回调执行前到达，导致 thinkingText 仍为空 → hasData=false → 卡片消失。
      const mainKey = `main:${chatJid}`;
      const pendingEntry = pendingDeltas.get(mainKey);
      if (pendingEntry) {
        cancelAnimationFrame(pendingEntry.raf);
        flushPendingDelta(mainKey, chatJid, undefined, set);
      }
      set((s) => {
        const frozen = freezeStreamingState(s.streaming[chatJid]);
        const nextStreaming = { ...s.streaming };
        if (frozen) {
          nextStreaming[chatJid] = frozen;
        } else {
          delete nextStreaming[chatJid];
        }
        const nextPendingThinking = { ...s.pendingThinking };
        delete nextPendingThinking[chatJid];
        return {
          waiting: { ...s.waiting, [chatJid]: false },
          streaming: nextStreaming,
          pendingThinking: nextPendingThinking,
        };
      });

      // Fallback：10s 后如果 new_message 未到达，强制清除冻结状态
      setTimeout(() => {
        const state = get();
        if (state.streaming[chatJid]?.interrupted && !state.waiting[chatJid]) {
          set((s) => {
            const next = { ...s.streaming };
            delete next[chatJid];
            return { streaming: next };
          });
        }
      }, 10_000);

      return;
    }

    // ⑥ 主对话 streaming — 使用 applyStreamEvent 共享函数
    set((s) => {
      // If streaming state was already cleared (final message received),
      // ignore late-arriving stream events to prevent "thinking" from reappearing.
      if (!s.streaming[chatJid] && s.waiting[chatJid] === false) {
        return s;
      }
      // 冻结的中断状态不接收新事件（如 usage），防止 waiting 被改回 true
      const current = s.streaming[chatJid];
      if (current?.interrupted) {
        return s;
      }
      const prev = resolveStreamingPrev(current, event);
      const next = { ...prev };
      applyStreamEvent(
        event,
        prev,
        next,
        MAX_STREAMING_TEXT,
        runStartedAtMs(s.activeRuns, runtimeJid),
      );
      return {
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: { ...s.streaming, [chatJid]: next },
      };
    });
  },

  // 通过 WebSocket new_message 事件立即添加消息（避免轮询延迟导致消息"丢失"）
  handleWsNewMessage: (chatJid, wsMsg, agentId?, source?) => {
    if (!wsMsg || !wsMsg.id) return;
    // Skip while clearHistory is in-flight to prevent race re-injection
    if (get().clearing[chatJid]) return;

    const incomingWorkflowRuns = (wsMsg.workflow_runs || []) as NonNullable<
      Message['workflow_runs']
    >;
    const runningWorkflowRuns = incomingWorkflowRuns.filter(
      (run) => run.status === 'running',
    );
    const completedWorkflowRuns = incomingWorkflowRuns.filter(
      (run) => run.status !== 'running',
    );
    const holdsRunningWorkflow = runningWorkflowRuns.length > 0;

    const msg: Message = {
      id: wsMsg.id,
      chat_jid: wsMsg.chat_jid || chatJid,
      sender: wsMsg.sender || '',
      sender_name: wsMsg.sender_name || '',
      content: wsMsg.content || '',
      timestamp: wsMsg.timestamp || new Date().toISOString(),
      is_from_me: wsMsg.is_from_me ?? false,
      attachments: wsMsg.attachments,
      token_usage: wsMsg.token_usage,
      // Running runs are rendered by StreamingDisplay so progress events can
      // keep mutating the same card. Completed runs belong to MessageBubble.
      workflow_runs:
        completedWorkflowRuns.length > 0 ? completedWorkflowRuns : undefined,
      turn_id: wsMsg.turn_id ?? null,
      ...(wsMsg.has_trace ||
      takePendingTraceMark(wsMsg.chat_jid || chatJid, wsMsg.id)
        ? { has_trace: true }
        : {}),
      session_id: wsMsg.session_id ?? null,
      sdk_message_uuid: wsMsg.sdk_message_uuid ?? null,
      source_kind: wsMsg.source_kind ?? null,
      finalization_reason: wsMsg.finalization_reason ?? null,
      delivery_mode: wsMsg.delivery_mode ?? null,
      delivery_status: wsMsg.delivery_status ?? null,
      delivery_run_id: wsMsg.delivery_run_id ?? null,
      delivery_updated_at: wsMsg.delivery_updated_at ?? null,
    };
    const resetsContext =
      msg.sender === '__system__' &&
      (msg.content === 'context_reset' ||
        msg.content === 'context_fresh_window');
    const isProactiveUtterance =
      msg.is_from_me &&
      msg.sender !== '__system__' &&
      source !== 'scheduled_task' &&
      msg.source_kind === 'sdk_send_message';

    // Route to agentMessages if this is a conversation agent message
    if (agentId) {
      // Same as the main path below: apply a frame still waiting for rAF
      // before the reply replaces the card it belongs to.
      flushPendingDeltaForRuntime(`${chatJid}#agent:${agentId}`, set);
      let snapshotMessages: Message[] | null = null;
      let snapshotHasMore = false;
      let didReceiveProactiveUtterance = false;
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        const isNewMessage = !existing.some((item) => item.id === msg.id);
        const mergedUsage = mergePendingMessageUsage(
          mergeMessagesChronologically(existing, [msg]),
          resetsContext
            ? clearPendingMessageUsage(s.pendingMessageUsage, chatJid, agentId)
            : s.pendingMessageUsage,
          chatJid,
          agentId,
        );
        const updated = mergedUsage.messages;
        snapshotMessages = updated;
        snapshotHasMore = !!s.agentHasMore[agentId];
        const isAgentReply =
          msg.is_from_me &&
          msg.sender !== '__system__' &&
          msg.source_kind !== 'sdk_send_message';
        const exactRunActive = !!s.activeRuns[`${chatJid}#agent:${agentId}`];
        // The reply replaces its settled (or stopped) card in this same
        // update, carrying its thinking and execution details over. A live
        // projection under an active run belongs to the next attempt.
        const agentState = s.agentStreaming[agentId];
        const runtimeJid = `${chatJid}#agent:${agentId}`;
        const settledState = isAgentReply
          ? s.settledStreaming[runtimeJid]
          : undefined;
        const replacesProjection =
          isAgentReply && (!exactRunActive || isFrozenProjection(agentState));
        const replyCaches = settledState
          ? finalizedReplyCaches(s, settledState, msg.id)
          : replacesProjection && agentState
            ? finalizedReplyCaches(s, agentState, msg.id)
            : {};

        const nextAgentStreaming = isAgentReply
          ? exactRunActive && !replacesProjection
            ? s.agentStreaming
            : holdsRunningWorkflow
              ? {
                  ...s.agentStreaming,
                  [agentId]:
                    streamingStateFromWorkflowRuns(runningWorkflowRuns),
                }
              : (() => {
                  const n = { ...s.agentStreaming };
                  delete n[agentId];
                  return n;
                })()
          : s.agentStreaming;

        // For user messages (non-reply), set agentWaiting=true so subsequent
        // streaming events are accepted.  This handles messages injected from
        // Feishu/Telegram which don't go through sendAgentMessage().
        const nextAgentWaiting = isAgentReply
          ? {
              ...s.agentWaiting,
              [agentId]: exactRunActive || holdsRunningWorkflow,
            }
          : !msg.is_from_me
            ? { ...s.agentWaiting, [agentId]: true }
            : s.agentWaiting;
        const isHidden = typeof document !== 'undefined' && document.hidden;
        const isOtherConversation =
          s.currentGroup !== chatJid || s.activeAgentTab[chatJid] !== agentId;
        didReceiveProactiveUtterance = isNewMessage && isProactiveUtterance;
        const nextUnread =
          didReceiveProactiveUtterance && (isHidden || isOtherConversation)
            ? {
                ...s.unreadReplies,
                [chatJid]: (s.unreadReplies[chatJid] || 0) + 1,
              }
            : s.unreadReplies;
        const currentAgents = s.agents[chatJid];
        const nextAgents = currentAgents?.map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                last_active_at: msg.timestamp,
                latest_message: {
                  content: msg.content,
                  timestamp: msg.timestamp,
                },
              }
            : agent,
        );

        return {
          ...replyCaches,
          ...(settledState
            ? { settledStreaming: withoutKey(s.settledStreaming, runtimeJid) }
            : {}),
          agentMessages: { ...s.agentMessages, [agentId]: updated },
          pendingMessageUsage: mergedUsage.pending,
          agentWaiting: nextAgentWaiting,
          agentStreaming: nextAgentStreaming,
          unreadReplies: nextUnread,
          ...(nextAgents
            ? { agents: { ...s.agents, [chatJid]: nextAgents } }
            : {}),
        };
      });
      if (snapshotMessages) {
        void saveAgentMessageSnapshot(
          chatJid,
          agentId,
          snapshotMessages,
          snapshotHasMore,
        );
      }
      if (didReceiveProactiveUtterance) {
        const groupName = get().groups[chatJid]?.name || '对话';
        const preview = msg.content ? msg.content.slice(0, 80) : '';
        notifyIfHidden(groupName, preview || '收到新消息');
      }
      return;
    }

    // 闭包外标志：set() 内部计算后传出，用于驱动通知逻辑（避免重复判断条件）
    let didFinalizeAssistant = false;
    let didReceiveProactiveUtterance = false;

    // 强制 flush rAF 缓冲：finalize 会 delete streaming 并把 thinkingText 转存
    // thinkingCache。若某轮最后一帧 thinking_delta/text_delta 仍卡在 pendingDeltas
    // （页面隐藏时 rAF 被节流），不先 flush 会随 streaming 删除而丢失。
    // 与中断路径（status:interrupted）和 agent-status 路径对称。
    {
      const mainKey = `main:${chatJid}`;
      const pendingEntry = pendingDeltas.get(mainKey);
      if (pendingEntry) {
        cancelAnimationFrame(pendingEntry.raf);
        flushPendingDelta(mainKey, chatJid, undefined, set);
      }
    }

    set((s) => {
      const existing = s.messages[chatJid] || [];
      const isNewMessage = !existing.some((item) => item.id === msg.id);

      // 消息已存在时保留原顺序，仅执行状态收尾（清 waiting/streaming）
      const mergedUsage = mergePendingMessageUsage(
        mergeMessagesChronologically(existing, [msg]),
        resetsContext
          ? clearPendingMessageUsage(s.pendingMessageUsage, chatJid)
          : s.pendingMessageUsage,
        chatJid,
      );
      const updated = mergedUsage.messages;
      didReceiveProactiveUtterance = isNewMessage && isProactiveUtterance;

      const isAgentReply =
        msg.is_from_me &&
        msg.sender !== '__system__' &&
        source !== 'scheduled_task' &&
        msg.source_kind !== 'sdk_send_message';
      const isSystemError = isTerminalSystemMessage(msg);
      const shouldFinalizeAssistant =
        isAgentReply &&
        (msg.source_kind === 'sdk_final' ||
          msg.source_kind === 'interrupt_partial' ||
          msg.source_kind === null ||
          msg.source_kind === undefined ||
          msg.source_kind === 'legacy');

      if (shouldFinalizeAssistant || isSystemError) {
        if (shouldFinalizeAssistant && !holdsRunningWorkflow)
          didFinalizeAssistant = true;

        // Agent 回复或系统错误：在同一次更新里用定稿替换流式卡片（已结束
        // 运行的 settled 卡片，或已中断冻结的卡片），并把 thinking 与执行
        // 详情转存到该消息。下一轮的 live 卡片不受影响。
        const exactRunActive = !!s.activeRuns[chatJid];
        const streamState = s.streaming[chatJid];
        const settledState = s.settledStreaming[chatJid];
        const replacesProjection =
          !exactRunActive || isFrozenProjection(streamState);
        const replyCaches = isAgentReply
          ? settledState
            ? finalizedReplyCaches(s, settledState, msg.id)
            : replacesProjection
              ? finalizedReplyCaches(
                  s,
                  streamState,
                  msg.id,
                  s.pendingThinking[chatJid],
                  s.pendingThinkingDuration[chatJid],
                )
              : {}
          : {};
        const nextStreaming = { ...s.streaming };
        if (!replacesProjection) {
          // The exact terminal for the previous reply has already started a
          // replacement attempt. Preserve that replacement's stream.
        } else if (holdsRunningWorkflow) {
          nextStreaming[chatJid] =
            streamingStateFromWorkflowRuns(runningWorkflowRuns);
        } else {
          delete nextStreaming[chatJid];
        }
        const nextPending = { ...s.pendingThinking };
        const nextPendingDur = { ...s.pendingThinkingDuration };
        if (replacesProjection) {
          delete nextPending[chatJid];
          delete nextPendingDur[chatJid];
        }

        // 未读计数：页面隐藏或不在当前对话时增加
        const isHidden = typeof document !== 'undefined' && document.hidden;
        const isOtherChat = s.currentGroup !== chatJid;
        const nextUnread =
          (isHidden || isOtherChat) &&
          shouldFinalizeAssistant &&
          !holdsRunningWorkflow
            ? {
                ...s.unreadReplies,
                [chatJid]: (s.unreadReplies[chatJid] || 0) + 1,
              }
            : s.unreadReplies;

        return {
          ...replyCaches,
          messages: { ...s.messages, [chatJid]: updated },
          pendingMessageUsage: mergedUsage.pending,
          waiting: {
            ...s.waiting,
            [chatJid]: exactRunActive || holdsRunningWorkflow,
          },
          streaming: nextStreaming,
          settledStreaming: withoutKey(s.settledStreaming, chatJid),
          pendingThinking: nextPending,
          pendingThinkingDuration: nextPendingDur,
          unreadReplies: nextUnread,
        };
      }

      // A group-mode scheduled task streams in the main runner and posts its
      // result as a scheduled_task message: it is that run's final, and
      // replaces the settled card of the same turn in this same update.
      const settledForTask = s.settledStreaming[chatJid];
      const replacesSettledTask =
        (source === 'scheduled_task' ||
          msg.source_kind === 'scheduled_task_result') &&
        msg.is_from_me &&
        msg.sender !== '__system__' &&
        !!settledForTask &&
        settledTurnMatches(settledForTask, msg.turn_id);

      // A direct human message is also the earliest cross-tab/IM signal that a
      // new logical run is about to start. Do not wait for the first Claude
      // stream event: warm runners can spend noticeable time preparing context
      // and previously left secondary tabs looking idle during that window.
      const startsDirectRun =
        !msg.is_from_me &&
        msg.delivery_status !== 'queued' &&
        msg.delivery_status !== 'promoting' &&
        msg.delivery_status !== 'cancelled' &&
        msg.delivery_status !== 'subsumed';
      const isHidden = typeof document !== 'undefined' && document.hidden;
      const isOtherChat =
        s.currentGroup !== chatJid || !!s.activeAgentTab[chatJid];
      const nextUnread =
        didReceiveProactiveUtterance && (isHidden || isOtherChat)
          ? {
              ...s.unreadReplies,
              [chatJid]: (s.unreadReplies[chatJid] || 0) + 1,
            }
          : s.unreadReplies;
      return {
        ...(replacesSettledTask && settledForTask
          ? {
              ...finalizedReplyCaches(s, settledForTask, msg.id),
              settledStreaming: withoutKey(s.settledStreaming, chatJid),
            }
          : {}),
        messages: { ...s.messages, [chatJid]: updated },
        pendingMessageUsage: mergedUsage.pending,
        unreadReplies: nextUnread,
        ...(startsDirectRun
          ? { waiting: { ...s.waiting, [chatJid]: true } }
          : {}),
      };
    });

    // 对话完成通知：复用 set() 内部的 shouldFinalizeAssistant 判断结果
    if (didFinalizeAssistant) {
      const groupName = get().groups[chatJid]?.name || '对话';
      const preview = msg.content ? msg.content.slice(0, 80) : '';
      notifyIfHidden(groupName, preview || '收到新回复');
      if (typeof document !== 'undefined' && !document.hidden) {
        showNotificationPromptToast();
      }
    }
    if (didReceiveProactiveUtterance) {
      const groupName = get().groups[chatJid]?.name || '对话';
      const preview = msg.content ? msg.content.slice(0, 80) : '';
      notifyIfHidden(groupName, preview || '收到新消息');
    }

    // query_interrupted 仅作为视觉分隔线，不清理流式状态。
    // 流式状态由 status:interrupted（冻结）→ interrupt_partial（转正）两阶段处理。
    // 兜底：20s 后若流式状态仍未清理（如 status:interrupted 或 interrupt_partial 丢失），
    // 强制清理 streaming 和 waiting，防止 UI 永久卡死。
    if (isInterruptSystemMessage(msg) && get().streaming[chatJid]) {
      setTimeout(() => {
        const state = get();
        // 只清除仍处于中断冻结的状态；如果已被清理或已被新查询覆盖则跳过
        if (state.streaming[chatJid]?.interrupted) {
          set((s) => {
            if (!s.streaming[chatJid]?.interrupted) return s;
            const next = { ...s.streaming };
            delete next[chatJid];
            return {
              streaming: next,
              waiting: { ...s.waiting, [chatJid]: false },
            };
          });
        }
      }, 20_000);
    }
  },

  // 处理子 Agent 状态变更事件
  handleAgentStatus: (
    chatJid,
    agentId,
    status,
    name,
    prompt,
    resultSummary?,
    kind?,
    titleGenerating?,
  ) => {
    set((s) => {
      const existing = s.agents[chatJid] || [];

      // '__removed__' signal: agent has been cleaned up, remove from list
      if (resultSummary === '__removed__') {
        clearSdkTaskCleanupTimer(agentId);
        clearSdkTaskStaleTimer(agentId);
        clearDbTaskAgentCleanupTimer(agentId);
        const filtered = existing.filter((a) => a.id !== agentId);
        const nextAgentStreaming = { ...s.agentStreaming };
        delete nextAgentStreaming[agentId];
        const nextSettled = withoutKey(
          s.settledStreaming,
          `${chatJid}#agent:${agentId}`,
        );
        const nextActiveTab = { ...s.activeAgentTab };
        if (nextActiveTab[chatJid] === agentId) nextActiveTab[chatJid] = null;
        const nextSdkTasks = { ...s.sdkTasks };
        delete nextSdkTasks[agentId];
        const nextSdkTaskAliases = removeSdkTaskAliases(
          s.sdkTaskAliases,
          agentId,
        );
        // Clean up conversation agent state
        const nextAgentMessages = { ...s.agentMessages };
        delete nextAgentMessages[agentId];
        const nextAgentWaiting = { ...s.agentWaiting };
        delete nextAgentWaiting[agentId];
        const nextAgentHasMore = { ...s.agentHasMore };
        delete nextAgentHasMore[agentId];
        return {
          agents: { ...s.agents, [chatJid]: filtered },
          pendingMessageUsage: clearPendingMessageUsage(
            s.pendingMessageUsage,
            chatJid,
            agentId,
            false,
          ),
          agentStreaming: nextAgentStreaming,
          settledStreaming: nextSettled,
          activeAgentTab: nextActiveTab,
          sdkTasks: nextSdkTasks,
          sdkTaskAliases: nextSdkTaskAliases,
          agentMessages: nextAgentMessages,
          agentWaiting: nextAgentWaiting,
          agentHasMore: nextAgentHasMore,
        };
      }

      const idx = existing.findIndex((a) => a.id === agentId);
      const resolvedKind = kind || (idx >= 0 ? existing[idx].kind : 'task');
      const previous = idx >= 0 ? existing[idx] : undefined;
      const agentInfo: AgentInfo = {
        ...previous,
        id: agentId,
        name,
        prompt,
        status,
        kind: resolvedKind,
        created_at: previous?.created_at || new Date().toISOString(),
        completed_at:
          status === 'completed' || status === 'error'
            ? new Date().toISOString()
            : undefined,
        result_summary: resultSummary,
        title_generating:
          typeof titleGenerating === 'boolean'
            ? titleGenerating
            : previous?.title_generating,
      };
      const updated =
        idx >= 0
          ? existing.map((a, i) => (i === idx ? agentInfo : a))
          : [...existing, agentInfo];

      // Clean up agent streaming if not actively running
      const nextAgentStreaming = { ...s.agentStreaming };
      const exactAgentRunActive = !!s.activeRuns[`${chatJid}#agent:${agentId}`];
      if (status !== 'running' && !exactAgentRunActive) {
        delete nextAgentStreaming[agentId];
      }
      const nextSdkTasks = { ...s.sdkTasks };
      let nextSdkTaskAliases = { ...s.sdkTaskAliases };
      if (resolvedKind === 'task') {
        if (status !== 'running') {
          completedSdkTaskIds.add(agentId);
          clearSdkTaskCleanupTimer(agentId);
          clearSdkTaskStaleTimer(agentId);
          delete nextSdkTasks[agentId];
          nextSdkTaskAliases = removeSdkTaskAliases(
            nextSdkTaskAliases,
            agentId,
          );
          // 自动清理已完成的 DB task agent（延迟移除，让用户看到完成状态）
          scheduleDbTaskAgentCleanup(set, agentId, chatJid);
        } else {
          // Task 回到 running 状态，取消 pending 的清理定时器
          clearDbTaskAgentCleanupTimer(agentId);
          if (nextSdkTasks[agentId]) {
            nextSdkTasks[agentId] = {
              ...nextSdkTasks[agentId],
              chatJid,
              description: prompt,
              status: 'running',
            };
          }
        }
      }
      // Spawn agents are fire-and-forget: auto-remove from frontend state after completion
      if (
        resolvedKind === 'spawn' &&
        (status === 'completed' || status === 'error')
      ) {
        scheduleDbTaskAgentCleanup(set, agentId, chatJid);
      }

      return {
        agents: { ...s.agents, [chatJid]: updated },
        agentStreaming: nextAgentStreaming,
        sdkTasks: nextSdkTasks,
        sdkTaskAliases: nextSdkTaskAliases,
      };
    });
  },

  // 加载子 Agent 列表
  loadAgents: async (jid, opts) => {
    // Skip network call if agents are already cached.  WebSocket events
    // (agent_status, agent created/deleted) keep the cache fresh after the
    // first load.  Pass { force: true } to bypass (e.g. WS reconnect).
    if (!opts?.force && get().agents[jid]) {
      return;
    }
    // Sidebar and ChatView both ask for the same workspace on mount; share
    // one request instead of fetching it twice.
    const inFlight = loadAgentsInFlight.get(jid);
    if (inFlight && !opts?.force) return inFlight;
    const request = (async () => {
      try {
        const data = await api.get<{ agents: AgentInfo[] }>(
          `/api/groups/${encodeURIComponent(jid)}/agents`,
        );
        set((s) => {
          const visibleAgents = data.agents.filter(
            (a) =>
              a.kind === 'conversation' ||
              (a.kind === 'spawn' && a.status !== 'completed') ||
              a.status === 'running',
          );
          const runningTasks = data.agents.filter(
            (a) => a.kind === 'task' && a.status === 'running',
          );
          const runningTaskIds = new Set(runningTasks.map((a) => a.id));
          const runningTaskMap = new Map(runningTasks.map((a) => [a.id, a]));

          const nextSdkTasks: ChatState['sdkTasks'] = {};
          for (const [id, task] of Object.entries(s.sdkTasks)) {
            if (task.chatJid !== jid) {
              nextSdkTasks[id] = task;
              continue;
            }
            if (runningTaskIds.has(id)) {
              const agent = runningTaskMap.get(id)!;
              nextSdkTasks[id] = {
                ...task,
                chatJid: jid,
                description: agent.prompt || agent.name,
                status: 'running',
              };
            } else {
              clearSdkTaskCleanupTimer(id);
              clearSdkTaskStaleTimer(id);
            }
          }

          for (const agent of runningTasks) {
            if (!nextSdkTasks[agent.id]) {
              nextSdkTasks[agent.id] = {
                chatJid: jid,
                description: agent.prompt || agent.name,
                status: 'running',
              };
            }
          }

          const nextAgentStreaming = { ...s.agentStreaming };
          for (const [id, task] of Object.entries(s.sdkTasks)) {
            if (task.chatJid === jid && !runningTaskIds.has(id)) {
              delete nextAgentStreaming[id];
            }
          }

          const nextActiveTab = { ...s.activeAgentTab };
          if (nextActiveTab[jid] && !runningTaskIds.has(nextActiveTab[jid]!)) {
            const stillExists = visibleAgents.some(
              (a) => a.id === nextActiveTab[jid],
            );
            if (!stillExists) nextActiveTab[jid] = null;
          }

          const nextSdkTaskAliases: Record<string, string> = {};
          for (const [alias, target] of Object.entries(s.sdkTaskAliases)) {
            const task = nextSdkTasks[target];
            if (!task) continue;
            if (task.chatJid === jid && task.status !== 'running') continue;
            if (alias === target && task.status !== 'running') continue;
            nextSdkTaskAliases[alias] = target;
          }

          // Apply saved conversation order from localStorage (only to conversations)
          let orderedAgents = visibleAgents;
          try {
            const savedOrder = localStorage.getItem(
              `happyclaw-agent-order-${jid}`,
            );
            if (savedOrder) {
              const ids: string[] = JSON.parse(savedOrder);
              const conversations = visibleAgents.filter(
                (a) => a.kind === 'conversation',
              );
              const others = visibleAgents.filter(
                (a) => a.kind !== 'conversation',
              );
              orderedAgents = [...sortByIdOrder(conversations, ids), ...others];
            }
          } catch {
            /* ignore */
          }

          return {
            agents: { ...s.agents, [jid]: orderedAgents },
            sdkTasks: nextSdkTasks,
            sdkTaskAliases: nextSdkTaskAliases,
            agentStreaming: nextAgentStreaming,
            activeAgentTab: nextActiveTab,
          };
        });
      } catch {
        // Silent fail
      }
    })().finally(() => {
      if (loadAgentsInFlight.get(jid) === request)
        loadAgentsInFlight.delete(jid);
    });
    loadAgentsInFlight.set(jid, request);
    return request;
  },

  // 删除子 Agent
  deleteAgentAction: async (jid, agentId) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${agentId}`,
      );
      void deleteAgentMessageSnapshot(jid, agentId);
      clearSdkTaskCleanupTimer(agentId);
      clearSdkTaskStaleTimer(agentId);
      set((s) => {
        const updated = (s.agents[jid] || []).filter((a) => a.id !== agentId);
        const nextAgentMessages = { ...s.agentMessages };
        delete nextAgentMessages[agentId];
        const nextAgentStreaming = { ...s.agentStreaming };
        delete nextAgentStreaming[agentId];
        const nextAgentWaiting = { ...s.agentWaiting };
        delete nextAgentWaiting[agentId];
        const nextAgentHasMore = { ...s.agentHasMore };
        delete nextAgentHasMore[agentId];
        const nextActiveTab = { ...s.activeAgentTab };
        if (nextActiveTab[jid] === agentId) nextActiveTab[jid] = null;
        const nextSdkTasks = { ...s.sdkTasks };
        delete nextSdkTasks[agentId];
        const nextSdkTaskAliases = removeSdkTaskAliases(
          s.sdkTaskAliases,
          agentId,
        );
        return {
          agents: { ...s.agents, [jid]: updated },
          pendingMessageUsage: clearPendingMessageUsage(
            s.pendingMessageUsage,
            jid,
            agentId,
            false,
          ),
          agentMessages: nextAgentMessages,
          agentStreaming: nextAgentStreaming,
          agentWaiting: nextAgentWaiting,
          agentHasMore: nextAgentHasMore,
          activeAgentTab: nextActiveTab,
          sdkTasks: nextSdkTasks,
          sdkTaskAliases: nextSdkTaskAliases,
        };
      });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '删除会话失败' });
      return false;
    }
  },

  // 切换子 Agent 标签页（在内存中 mirror，URL 是真正的真相源）。
  // 未读目前按 Workspace 聚合；在当前 Workspace 内进入主会话或任一
  // Agent 会话，都视为已经查看该 Workspace。后台 Workspace 的 URL/tab
  // 同步不得清除其未读。
  setActiveAgentTab: (jid, agentId) => {
    // ChatView calls this whenever it shows a conversation.
    noteConversationViewed(jid, agentId);
    set((s) => {
      let nextUnreadReplies = s.unreadReplies;
      if (s.currentGroup === jid && s.unreadReplies[jid]) {
        nextUnreadReplies = { ...s.unreadReplies };
        delete nextUnreadReplies[jid];
      }
      return {
        activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
        unreadReplies: nextUnreadReplies,
        ...evictViewedConversations(s, jid),
      };
    });
  },

  // -- Conversation agent actions --

  createConversation: async (jid, name, description?) => {
    try {
      const data = await api.post<{ session?: AgentInfo; agent?: AgentInfo }>(
        `/api/groups/${encodeURIComponent(jid)}/sessions`,
        { name, description },
      );
      const created = data.session ?? data.agent;
      if (!created) throw new Error('创建会话失败');
      set((s) => {
        const existing = s.agents[jid] || [];
        // WS agent_status broadcast may have already added it
        if (existing.some((a) => a.id === created.id)) return s;
        return { agents: { ...s.agents, [jid]: [...existing, created] } };
      });
      return created;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      return null;
    }
  },

  renameConversation: async (jid, agentId, name) => {
    try {
      await api.patch(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${agentId}`,
        { name },
      );
      set((s) => {
        const agents = (s.agents[jid] || []).map((a) =>
          a.id === agentId ? { ...a, name } : a,
        );
        return { agents: { ...s.agents, [jid]: agents } };
      });
      return true;
    } catch {
      return false;
    }
  },

  loadAgentMessages: async (jid, agentId, loadMore = false) => {
    const existing = get().agentMessages[agentId] || [];
    const beforeSequence = loadMore
      ? messageSequenceBoundary(existing, 'min')
      : undefined;
    const before =
      loadMore && beforeSequence === undefined && existing.length > 0
        ? existing[0].timestamp
        : undefined;

    try {
      const params = new URLSearchParams(
        beforeSequence !== undefined
          ? {
              beforeSequence: String(beforeSequence),
              limit: '50',
              agentId,
            }
          : before
            ? { before: String(before), limit: '50', agentId }
            : { limit: '50', agentId },
      );
      const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );
      const sorted = [...data.messages].reverse();
      let snapshotMessages = sorted;
      set((s) => {
        const loadedMessages = loadMore
          ? mergeMessagesChronologically(s.agentMessages[agentId] || [], sorted)
          : sorted;
        const mergedUsage = mergePendingMessageUsage(
          loadedMessages,
          s.pendingMessageUsage,
          jid,
          agentId,
        );
        const nextMessages = mergedUsage.messages;
        snapshotMessages = nextMessages;
        return {
          agentMessages: { ...s.agentMessages, [agentId]: nextMessages },
          pendingMessageUsage: mergedUsage.pending,
          agentHasMore: { ...s.agentHasMore, [agentId]: data.hasMore },
        };
      });
      if (!loadMore && snapshotMessages.length === 0) {
        void deleteAgentMessageSnapshot(jid, agentId);
      } else {
        void saveAgentMessageSnapshot(
          jid,
          agentId,
          snapshotMessages,
          data.hasMore,
        );
      }
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  hydrateAgentMessages: async (jid, agentId) => {
    // Honor clearHistory's in-flight lock — same contract as loadMessages /
    // refreshMessages / handleWsNewMessage. Without this, snapshot hydrate can
    // race with clearHistory and resurrect just-deleted messages into the
    // agentMessages map.
    if (get().clearing[jid]) return;
    const snapshot = await loadAgentMessageSnapshot(jid, agentId);
    if (!snapshot || snapshot.messages.length === 0) return;
    // Re-check after the async IDB read: clearHistory may have started while
    // we were awaiting.
    if (get().clearing[jid]) return;
    set((s) => {
      const existing = s.agentMessages[agentId] || [];
      const mergedUsage = mergePendingMessageUsage(
        mergeMessagesChronologically(existing, snapshot.messages),
        s.pendingMessageUsage,
        jid,
        agentId,
      );
      const merged = mergedUsage.messages;
      return {
        agentMessages: { ...s.agentMessages, [agentId]: merged },
        pendingMessageUsage: mergedUsage.pending,
        agentHasMore: {
          ...s.agentHasMore,
          [agentId]: s.agentHasMore[agentId] ?? snapshot.hasMore,
        },
      };
    });
  },

  sendAgentMessage: async (
    jid,
    agentId,
    content,
    attachments?,
    followUpBehavior = 'queue',
  ) => {
    const normalizedAttachments =
      attachments && attachments.length > 0
        ? attachments.map((att) => ({ type: 'image' as const, ...att }))
        : undefined;
    try {
      // Conversation sends use the acknowledged HTTP path, just like the
      // main chat. WebSocket remains the push channel for the stored message
      // and stream events; a successful return now means the server really
      // persisted and classified this message as started/queued/steered.
      const data = await api.post<{
        success: true;
        messageId: string;
        timestamp: string;
        disposition: 'started' | 'queued' | 'steered';
        runId?: string;
      }>(
        '/api/messages',
        {
          chatJid: jid,
          agentId,
          content,
          attachments: normalizedAttachments,
          followUpBehavior,
        },
        attachmentTimeoutMs(normalizedAttachments),
      );
      if (data.disposition === 'started' && data.runId) {
        get().handleRunStarted(`${jid}#agent:${agentId}`, data.runId);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : '服务器未确认消息';
      showToast('发送失败', `${detail}，输入已保留，请稍后重试`);
      return false;
    }
    set((s) => ({
      agentWaiting: { ...s.agentWaiting, [agentId]: true },
    }));
    return true;
  },

  refreshAgentMessages: async (jid, agentId) => {
    const existing = get().agentMessages[agentId] || [];
    const lastSequence = messageSequenceBoundary(existing, 'max');
    const lastTs =
      lastSequence === undefined && existing.length > 0
        ? existing[existing.length - 1].timestamp
        : undefined;

    try {
      const params = new URLSearchParams({ limit: '50', agentId });
      if (lastSequence !== undefined) {
        params.set('afterSequence', String(lastSequence));
      } else if (lastTs) {
        params.set('after', lastTs);
      }

      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );

      if (data.messages.length > 0) {
        let snapshotMessages: Message[] | null = null;
        let snapshotHasMore = false;
        set((s) => {
          const mergedUsage = mergePendingMessageUsage(
            mergeMessagesChronologically(
              s.agentMessages[agentId] || [],
              data.messages,
            ),
            s.pendingMessageUsage,
            jid,
            agentId,
          );
          const merged = mergedUsage.messages;
          snapshotMessages = merged;
          snapshotHasMore = !!s.agentHasMore[agentId];
          const lastAiMsg = [...data.messages]
            .reverse()
            .find(
              (m) =>
                m.is_from_me &&
                m.sender !== '__system__' &&
                m.source_kind !== 'sdk_send_message',
            );
          const agentState = s.agentStreaming[agentId];
          const runtimeJid = `${jid}#agent:${agentId}`;
          const settledState = lastAiMsg
            ? s.settledStreaming[runtimeJid]
            : undefined;
          const exactRunActive = !!s.activeRuns[runtimeJid];
          // Same rule as a live final message: it replaces a settled or
          // stopped card, never the projection of a newer active run.
          const finalizes =
            !!lastAiMsg && (!exactRunActive || isFrozenProjection(agentState));
          const nextAgentStreaming = finalizes
            ? (() => {
                const n = { ...s.agentStreaming };
                delete n[agentId];
                return n;
              })()
            : s.agentStreaming;

          return {
            ...(lastAiMsg && settledState
              ? {
                  ...finalizedReplyCaches(s, settledState, lastAiMsg.id),
                  settledStreaming: withoutKey(s.settledStreaming, runtimeJid),
                }
              : finalizes && lastAiMsg && agentState
                ? finalizedReplyCaches(s, agentState, lastAiMsg.id)
                : {}),
            agentMessages: { ...s.agentMessages, [agentId]: merged },
            pendingMessageUsage: mergedUsage.pending,
            agentWaiting:
              finalizes && !exactRunActive
                ? { ...s.agentWaiting, [agentId]: false }
                : s.agentWaiting,
            agentStreaming: nextAgentStreaming,
          };
        });
        if (snapshotMessages) {
          void saveAgentMessageSnapshot(
            jid,
            agentId,
            snapshotMessages,
            snapshotHasMore,
          );
        }
      }
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  // IM binding actions
  loadAvailableImGroups: async (jid) => {
    try {
      const data = await api.get<{ imGroups: AvailableImGroup[] }>(
        `/api/groups/${encodeURIComponent(jid)}/im-groups`,
      );
      return data.imGroups;
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载消息渠道失败';
      set({ error: message });
      throw err;
    }
  },

  syncAvailableImGroups: async (jid) => {
    return api.post<{ success: boolean; feishuAccounts: number }>(
      `/api/groups/${encodeURIComponent(jid)}/im-groups/sync`,
    );
  },

  unbindImGroup: async (jid, agentId, imJid) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${agentId}/im-binding/${encodeURIComponent(imJid)}`,
      );
      get().loadAgents(jid, { force: true });
      return true;
    } catch {
      return false;
    }
  },

  unbindMainImGroup: async (jid, imJid) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/sessions/main/im-binding/${encodeURIComponent(imJid)}`,
      );
      await get().loadGroups();
      return true;
    } catch {
      return false;
    }
  },

  unbindWorkspaceImGroup: async (jid, imJid) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/im-binding/${encodeURIComponent(imJid)}`,
      );
      await get().loadGroups();
      return true;
    } catch {
      return false;
    }
  },

  // 刷新/重连时恢复正在运行的 agent 状态
  restoreActiveState: async () => {
    // /api/status is not readable by read-only guests; their run state comes
    // from the WebSocket active_run_snapshot instead.
    if (useAuthStore.getState().user?.role === 'guest') return;
    try {
      const data = await api.get<{
        groups: Array<{
          jid: string;
          active: boolean;
          pendingMessages?: boolean;
          queryInFlight?: boolean;
          queryId?: string | null;
        }>;
      }>('/api/status/groups');
      const knownJids = new Set(data.groups.map((g) => g.jid));
      const activeAgentIds = new Set(
        data.groups
          .map((g) => {
            const marker = '#agent:';
            const markerIndex = g.jid.indexOf(marker);
            return markerIndex >= 0
              ? g.jid.slice(markerIndex + marker.length)
              : null;
          })
          .filter((agentId): agentId is string => !!agentId),
      );

      // 关键：对 active 群组先 refreshMessages 同步本地与后端真相，再做推断。
      // 否则 ws 断开期间漏接 agent 完成的 new_message 时，本地最新仍是用户消息，
      // 下面的 inferredWaiting 会错把 waiting 设回 true，UI 永久卡"正在思考..."。
      // refreshMessages 内部在拉到 agent 回复时会主动清除 waiting/streaming。
      // 仅刷新本地已加载过 messages 的群组，避免为侧边栏未点开的群组浪费请求。
      const currentMessages = get().messages;
      const activeJidsToRefresh = data.groups
        .filter((g) => g.active && currentMessages[g.jid])
        .map((g) => g.jid);
      await Promise.all(
        activeJidsToRefresh.map((jid) => get().refreshMessages(jid)),
      );

      set((s) => {
        const nextWaiting = { ...s.waiting };
        const nextStreaming = { ...s.streaming };
        const nextAgentWaiting = { ...s.agentWaiting };
        const nextAgentStreaming = { ...s.agentStreaming };

        // 清除后端不可见的 JID 的 waiting/streaming（进程已死）
        // （主服务重启后 queue 为空，所有 JID 都不在集合中）。
        for (const jid of Object.keys(nextWaiting)) {
          if (!knownJids.has(jid)) {
            delete nextWaiting[jid];
            delete nextStreaming[jid];
          }
        }
        for (const agentId of Object.keys(nextAgentWaiting)) {
          if (!activeAgentIds.has(agentId)) {
            delete nextAgentWaiting[agentId];
            delete nextAgentStreaming[agentId];
          }
        }

        for (const g of data.groups) {
          const agentMarker = '#agent:';
          const agentMarkerIndex = g.jid.indexOf(agentMarker);
          if (agentMarkerIndex >= 0) {
            const agentId = g.jid.slice(agentMarkerIndex + agentMarker.length);
            // A conversation runner intentionally stays alive between turns.
            // Only a terminal-capable exact attempt restores waiting.
            // pendingMessages may merely be a retry/backoff reservation and
            // has no run_finished identity.
            if (hasExactQueryAttempt(g)) {
              nextAgentWaiting[agentId] = true;
            } else {
              delete nextAgentWaiting[agentId];
              delete nextAgentStreaming[agentId];
            }
            continue;
          }
          if (hasExactQueryAttempt(g)) {
            nextWaiting[g.jid] = true;
            continue;
          }
          // Warm process, retry/backoff and proactive sdk_send_message history
          // have no exact terminal-capable attempt. Never infer waiting from
          // message shape: it can override an authoritative empty WS snapshot
          // and create a spinner that no run_finished can close.
          delete nextWaiting[g.jid];
          delete nextStreaming[g.jid];
        }
        return {
          waiting: nextWaiting,
          streaming: nextStreaming,
          agentWaiting: nextAgentWaiting,
          agentStreaming: nextAgentStreaming,
        };
      });
    } catch {
      // 静默失败
    }
  },

  // WS 重连时接收后端推送的流式快照，恢复 StreamingDisplay
  handleStreamSnapshot: (chatJid, snapshot, agentId, runId) => {
    const runtimeJid = agentId ? `${chatJid}#agent:${agentId}` : chatJid;
    // The speech tool of a proactive turn is not work to watch: the calls the
    // snapshot shows are remembered so their later events are left out too.
    const speech = isProactiveRuntime(get(), runtimeJid)
      ? speechCallsOfSnapshot(snapshot)
      : null;
    if (speech) rememberSpeechCalls(runtimeJid, runId, speech);
    // A proactive workspace's snapshot is cut to the level its owner chose,
    // whatever the host put in it.
    const levelOf = (s: ChatState): ProcessVisibility | null =>
      isProactiveRuntime(s, runtimeJid)
        ? normalizeProcessVisibility(s.groups[chatJid]?.process_visibility)
        : null;
    const restore = (
      local: StreamingState | undefined,
      level: ProcessVisibility | null,
    ): StreamingState => {
      const restored: StreamingState = {
        ...DEFAULT_STREAMING_STATE,
        partialText: snapshot.partialText || '',
        thinkingText: capThinkingText(snapshot.thinkingText || ''),
        thinkingDurationMs: snapshot.thinkingDurationMs,
        thinkingStartedAt: snapshot.thinkingStartedAt,
        phaseStartedAt: snapshot.phaseStartedAt,
        awaitingModel: snapshot.awaitingModel,
        activeTools: (snapshot.activeTools || [])
          .filter((t) => !level || !speech?.has(t.toolUseId))
          .map((t) => ({
            toolName: t.toolName,
            toolUseId: t.toolUseId,
            startTime: t.startTime,
            ...(t.elapsedSeconds != null
              ? { elapsedSeconds: t.elapsedSeconds }
              : {}),
            toolInputSummary: t.toolInputSummary,
            parentToolUseId: t.parentToolUseId,
            ...(t.isNested != null ? { isNested: t.isNested } : {}),
            ...(t.skillName ? { skillName: t.skillName } : {}),
            ...(t.toolInput ? { toolInput: t.toolInput } : {}),
          })),
        recentEvents: (
          (snapshot.recentEvents || []) as StreamingTimelineEvent[]
        ).filter(isUserVisibleTimelineEvent),
        traceEvents: (() => {
          const rows = (snapshot.traceEvents || []).filter(
            isUserVisibleTraceEvent,
          );
          return level && speech ? withoutSpeechTool(rows) : rows;
        })(),
        taskStates: snapshot.taskStates || {},
        todos: snapshot.todos,
        systemStatus: snapshot.systemStatus || null,
        isThinking: snapshot.isThinking ?? false,
        activeHook: snapshot.activeHook ?? null,
        turnId: snapshot.turnId,
      };
      // The same turn of the same run (the caller fences the run) only ever
      // grows. A reconnect snapshot may carry a block-bounded tail of a very
      // long reply: never replace the longer text this tab already shows
      // with it. A shorter local text missed deltas and takes the snapshot.
      const sameTurn =
        !!local &&
        (!local.turnId || !snapshot.turnId || local.turnId === snapshot.turnId);
      if (local && sameTurn) {
        if (local.partialText.length > restored.partialText.length) {
          restored.partialText = local.partialText;
        }
        if (local.thinkingText.length > restored.thinkingText.length) {
          restored.thinkingText = local.thinkingText;
        }
        restored.thinkingStartedAt = local.thinkingStartedAt;
        restored.thinkingDurationMs = local.thinkingDurationMs;
        restored.phaseStartedAt = local.phaseStartedAt;
        restored.awaitingModel = local.awaitingModel;
        restored.sessionId = local.sessionId;
        restored.interrupted = local.interrupted;
      }
      restored.thinkingTitle = extractThinkingTitle(restored.thinkingText, {
        final: !restored.isThinking,
      });
      // The snapshot has the pieces but not their order. This tab's own steps
      // of the same turn know it; otherwise rebuild a plausible order.
      if (local && sameTurn && local.steps && local.steps.length > 0) {
        restored.steps = local.steps;
        restored.stepsDropped = local.stepsDropped;
        restored.stepsRebuilt = local.stepsRebuilt;
        restored.partialBase = local.partialBase;
        restored.thinkingGap = local.thinkingGap;
        if (local.thinkingTitle) restored.thinkingTitle = local.thinkingTitle;
      } else {
        const rebuilt = rebuildSteps({
          thinkingText: restored.thinkingText,
          thinkingDurationMs: restored.thinkingDurationMs,
          isThinking: restored.isThinking,
          partialText: restored.partialText,
          activeTools: restored.activeTools,
          tasks: Object.values(restored.taskStates).map((task) => ({
            id: task.id,
            status: task.status,
            title: task.title,
          })),
          tracedTools: restored.traceEvents.flatMap((row) =>
            (row.kind === 'tool' || row.kind === 'skill') &&
            !row.parentToolUseId &&
            row.toolUseId &&
            /^(?:工具|技能) /.test(row.title)
              ? [
                  {
                    toolUseId: row.toolUseId,
                    timestamp: row.timestamp,
                    summary: row.summary,
                    ...(row.kind === 'skill'
                      ? { skillName: row.title.slice(3), toolName: 'Skill' }
                      : { toolName: row.title.slice(3) }),
                  },
                ]
              : [],
          ),
          now: Date.now(),
        });
        restored.steps = rebuilt.steps;
        restored.stepsDropped = rebuilt.dropped;
        restored.stepsRebuilt = true;
      }
      return level ? scrubForVisibility(restored, level) : restored;
    };

    if (agentId) {
      // Agent-specific snapshot → restore agentStreaming + agentWaiting
      set((s) => {
        if (!shouldApplyRunScopedPayload(s.activeRuns, runtimeJid, runId)) {
          return s;
        }
        return {
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          agentStreaming: {
            ...s.agentStreaming,
            [agentId]: restore(s.agentStreaming[agentId], levelOf(s)),
          },
        };
      });
    } else {
      // Main conversation snapshot
      set((s) => {
        if (!shouldApplyRunScopedPayload(s.activeRuns, runtimeJid, runId)) {
          return s;
        }
        return {
          waiting: { ...s.waiting, [chatJid]: true },
          streaming: {
            ...s.streaming,
            [chatJid]: restore(s.streaming[chatJid], levelOf(s)),
          },
        };
      });
    }
  },

  // Process lifecycle is sidebar-only. A warm conversation process may be
  // running while no query exists, so runner_state must never own waiting.
  handleRunnerState: (chatJid, state) => {
    if (chatJid.includes('#agent:')) return;
    if (state === 'idle') {
      // Process teardown still owns cleanup of process-scoped SDK task tabs.
      const currentAgents = get().agents[chatJid] || [];
      const hasTaskAgents = currentAgents.some((a) => a.kind === 'task');
      if (hasTaskAgents) {
        set((s) => {
          const existing = s.agents[chatJid] || [];
          const filtered = existing.filter((a) => a.kind !== 'task');
          return { agents: { ...s.agents, [chatJid]: filtered } };
        });
      }
    }
  },

  handleRunStarted: (chatJid, runId) => {
    // Older servers may omit runId. Keep their stream events functional, but
    // only exact IDs enter the fenced lifecycle map.
    if (!runId) return;
    const marker = '#agent:';
    const markerIndex = chatJid.indexOf(marker);
    const agentId =
      markerIndex >= 0 ? chatJid.slice(markerIndex + marker.length) : null;
    if (get().activeRuns[chatJid]?.runId !== runId) {
      cancelPendingDeltaForRuntime(chatJid);
    }
    const settled: { state: StreamingState | null } = { state: null };
    set((s) => {
      const replacingAttempt = s.activeRuns[chatJid]?.runId !== runId;
      const activeRuns = applyRunStarted(s.activeRuns, {
        chatJid,
        runId,
        startedAt: new Date().toISOString(),
        phase: 'preparing',
      });
      const stopRequests = replacingAttempt
        ? withoutKey(s.stopRequests, chatJid)
        : s.stopRequests;
      // A replaced attempt's card (no run_finished seen for it) waits,
      // settled, for its final message like a finished run's; the new run
      // streams into a fresh live projection next to it.
      const previous = agentId
        ? s.agentStreaming[agentId]
        : s.streaming[chatJid];
      if (replacingAttempt && !isProactiveRuntime(s, chatJid)) {
        settled.state = settleStreamingState(
          previous,
          s.activeRuns[chatJid]?.runId,
        );
      }
      const settledStreaming = settled.state
        ? { ...s.settledStreaming, [chatJid]: settled.state }
        : s.settledStreaming;
      if (agentId) {
        return {
          activeRuns,
          stopRequests,
          settledStreaming,
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          agentStreaming: replacingAttempt
            ? withoutKey(s.agentStreaming, agentId)
            : s.agentStreaming,
        };
      }
      return {
        activeRuns,
        stopRequests,
        settledStreaming,
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: replacingAttempt
          ? withoutKey(s.streaming, chatJid)
          : s.streaming,
      };
    });
    if (settled.state) scheduleSettleFallback(chatJid, settled.state, set, get);
  },

  handleRunFinished: (chatJid, runId) => {
    const marker = '#agent:';
    const markerIndex = chatJid.indexOf(marker);
    const agentId =
      markerIndex >= 0 ? chatJid.slice(markerIndex + marker.length) : null;
    if (get().activeRuns[chatJid]?.runId !== runId) return;
    // The last buffered frame still belongs to this run: apply it before the
    // run fence closes, then drop anything left.
    flushPendingDeltaForRuntime(chatJid, set);
    cancelPendingDeltaForRuntime(chatJid);
    const settled: { state: StreamingState | null } = { state: null };
    set((s) => {
      const finished = applyRunFinished(s.activeRuns, chatJid, runId);
      // A terminal event from an old attempt must not touch its replacement.
      if (!finished.applied) return s;
      const stopRequests = withoutKey(s.stopRequests, chatJid);
      // The server announces run_finished before it broadcasts the final
      // message. Freeze the card (settled) so the final replaces it in one
      // update instead of leaving a blank frame in between; the next queued
      // run streams into a separate live projection meanwhile.
      // A proactive workspace's messages are not replies to a card.
      settled.state = isProactiveRuntime(s, chatJid)
        ? null
        : settleStreamingState(
            agentId ? s.agentStreaming[agentId] : s.streaming[chatJid],
            runId,
          );
      const settledStreaming = settled.state
        ? { ...s.settledStreaming, [chatJid]: settled.state }
        : s.settledStreaming;
      if (agentId) {
        return {
          activeRuns: finished.runs,
          stopRequests,
          settledStreaming,
          agentWaiting: { ...s.agentWaiting, [agentId]: false },
          agentStreaming: withoutKey(s.agentStreaming, agentId),
        };
      }
      const nextStreaming = withoutKey(s.streaming, chatJid);
      const nextPendingThinking = { ...s.pendingThinking };
      delete nextPendingThinking[chatJid];
      const nextPendingThinkingDuration = {
        ...s.pendingThinkingDuration,
      };
      delete nextPendingThinkingDuration[chatJid];
      return {
        activeRuns: finished.runs,
        stopRequests,
        settledStreaming,
        waiting: { ...s.waiting, [chatJid]: false },
        streaming: nextStreaming,
        pendingThinking: nextPendingThinking,
        pendingThinkingDuration: nextPendingThinkingDuration,
      };
    });
    if (settled.state) scheduleSettleFallback(chatJid, settled.state, set, get);
  },

  handleActiveRunSnapshot: (runs, queuedChatJids = []) => {
    // The server sends this before stream snapshots on every WS connection. It
    // is authoritative: absent/replaced attempts are no longer running, and
    // their local projection must be gone before the canonical snapshot lands.
    const authoritative = runsFromAuthoritativeSnapshot(runs);
    const previous = get().activeRuns;
    for (const [jid, oldRun] of Object.entries(previous)) {
      if (authoritative[jid]?.runId !== oldRun.runId) {
        cancelPendingDeltaForRuntime(jid);
      }
    }
    set((s) => {
      const nextWaiting: Record<string, boolean> = {};
      const nextAgentWaiting: Record<string, boolean> = {};
      const nextStreaming = { ...s.streaming };
      const nextAgentStreaming = { ...s.agentStreaming };
      const nextPendingThinking = { ...s.pendingThinking };
      const nextPendingThinkingDuration = {
        ...s.pendingThinkingDuration,
      };

      for (const jid of Object.keys(nextStreaming)) {
        if (
          shouldDiscardStreamForAuthoritativeRun(previous, authoritative, jid)
        ) {
          delete nextStreaming[jid];
        }
      }
      for (const agentId of Object.keys(s.agentWaiting)) {
        const suffix = `#agent:${agentId}`;
        const previousJid = Object.keys(previous).find((jid) =>
          jid.endsWith(suffix),
        );
        const authoritativeJid = Object.keys(authoritative).find((jid) =>
          jid.endsWith(suffix),
        );
        if (
          !authoritativeJid ||
          !previousJid ||
          previous[previousJid]?.runId !==
            authoritative[authoritativeJid]?.runId
        ) {
          delete nextAgentStreaming[agentId];
        }
      }
      for (const run of Object.values(authoritative)) {
        const marker = '#agent:';
        const markerIndex = run.chatJid.indexOf(marker);
        if (markerIndex >= 0) {
          nextAgentWaiting[run.chatJid.slice(markerIndex + marker.length)] =
            true;
        } else {
          nextWaiting[run.chatJid] = true;
        }
      }
      // Queued chats have no run identity, so they never enter activeRuns and
      // never expect a run_finished. They still need the wait state, otherwise
      // reloading while a message sits behind a busy runner shows an idle
      // composer. The next authoritative snapshot recomputes this from scratch.
      const queuedWaitKeys = waitKeysForQueuedChats(queuedChatJids);
      for (const jid of queuedWaitKeys.waiting) nextWaiting[jid] = true;
      for (const agentId of queuedWaitKeys.agentWaiting) {
        nextAgentWaiting[agentId] = true;
      }
      for (const jid of Object.keys(previous)) {
        if (jid.includes('#agent:') || authoritative[jid]) continue;
        delete nextPendingThinking[jid];
        delete nextPendingThinkingDuration[jid];
      }
      const stopRequests = Object.fromEntries(
        Object.entries(s.stopRequests).filter(
          ([jid]) =>
            !!authoritative[jid] &&
            authoritative[jid].runId === previous[jid]?.runId,
        ),
      );
      return {
        activeRuns: authoritative,
        stopRequests,
        waiting: nextWaiting,
        agentWaiting: nextAgentWaiting,
        streaming: nextStreaming,
        agentStreaming: nextAgentStreaming,
        pendingThinking: nextPendingThinking,
        pendingThinkingDuration: nextPendingThinkingDuration,
      };
    });
  },

  // 清除流式状态（保留仍在运行的后台 SDK Task 的 agentStreaming）
  clearStreaming: (chatJid, options) => {
    // Cancel any pending rAF for this chatJid to prevent stale flushes
    const mainKey = `main:${chatJid}`;
    const mainEntry = pendingDeltas.get(mainKey);
    if (mainEntry) {
      cancelAnimationFrame(mainEntry.raf);
      pendingDeltas.delete(mainKey);
    }
    set((s) => {
      const next = { ...s.streaming };
      const thinkingText = next[chatJid]?.thinkingText;
      const thinkingDur = next[chatJid]?.thinkingDurationMs;
      const preserveThinking = options?.preserveThinking !== false;
      const nextPendingThinking = { ...s.pendingThinking };
      const nextPendingThinkingDuration = { ...s.pendingThinkingDuration };
      delete next[chatJid];
      if (preserveThinking && thinkingText) {
        nextPendingThinking[chatJid] = thinkingText;
        if (thinkingDur != null)
          nextPendingThinkingDuration[chatJid] = thinkingDur;
        else delete nextPendingThinkingDuration[chatJid];
      } else {
        delete nextPendingThinking[chatJid];
        delete nextPendingThinkingDuration[chatJid];
      }

      // 收集该 chatJid 下仍在运行的 SDK Task
      const runningSet = new Set<string>();
      for (const [taskId, task] of Object.entries(s.sdkTasks)) {
        if (task.chatJid === chatJid && task.status === 'running') {
          runningSet.add(taskId);
        }
      }

      // 清理已结束 task 的 agentStreaming（无论是否有运行中的 task）
      const nextAgentStreaming = { ...s.agentStreaming };
      let agentStreamingChanged = false;
      for (const [taskId, task] of Object.entries(s.sdkTasks)) {
        if (
          task.chatJid === chatJid &&
          !runningSet.has(taskId) &&
          nextAgentStreaming[taskId]
        ) {
          delete nextAgentStreaming[taskId];
          agentStreamingChanged = true;
        }
      }
      // 同时清理 agents[] 中已完成的 conversation agent 的 agentStreaming
      for (const agent of s.agents[chatJid] || []) {
        if (agent.status !== 'running' && nextAgentStreaming[agent.id]) {
          delete nextAgentStreaming[agent.id];
          agentStreamingChanged = true;
        }
      }

      return {
        waiting: { ...s.waiting, [chatJid]: false },
        streaming: next,
        pendingThinking: nextPendingThinking,
        pendingThinkingDuration: nextPendingThinkingDuration,
        ...(agentStreamingChanged
          ? { agentStreaming: nextAgentStreaming }
          : {}),
      };
    });
  },

  saveDraft: (jid, text) => {
    set((s) => {
      if (text) {
        if (s.drafts[jid] === text) return s;
        return { drafts: { ...s.drafts, [jid]: text } };
      }
      if (!(jid in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[jid];
      return { drafts: next };
    });
  },

  clearDraft: (jid) => {
    set((s) => {
      if (!(jid in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[jid];
      return { drafts: next };
    });
  },

  markChatRead: (chatJid) => {
    set((s) => {
      if (!s.unreadReplies[chatJid]) return s;
      const next = { ...s.unreadReplies };
      delete next[chatJid];
      return { unreadReplies: next };
    });
  },
}));

// What the replies a tab holds were read at is the view their workspace had
// then. Whoever changes it (this tab, another one, the settings page, a load
// of the groups) replaces `groups`, so the caches are let go here, for every
// workspace whose view differs from the one before, rather than in each place
// that replaces them. A workspace the previous groups did not have is not a
// change.
useChatStore.subscribe((state, previous) => {
  if (state.groups === previous.groups) return;
  const changed: string[] = [];
  for (const [jid, group] of Object.entries(state.groups)) {
    const before = previous.groups[jid];
    if (before && processView(before) !== processView(group)) changed.push(jid);
  }
  if (changed.length === 0) return;
  useChatStore.setState((current) => withoutProcessCaches(current, changed));
});
