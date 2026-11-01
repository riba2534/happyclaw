import { create } from 'zustand';
import { api, computeUploadTimeoutMs, type ApiError } from '../api/client';
import { randomUuid } from '../utils/random-uuid';
import {
  isSessionOf,
  sessionIdOf,
  sessionJidOf,
  workspaceJidOf,
} from '../lib/session-jid';
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
  SessionWorktreeInfo,
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
  MEMORY_WRITE_TOOLS,
  SPEECH_TOOL_NAME,
  filterProactiveStreamEvent,
  hasVisibleWork,
  isProgressStep,
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
  markRunAnswered,
  runsFromAuthoritativeSnapshot,
  shouldApplyRunScopedPayload,
  waitKeysForQueuedChats,
  type ClientActiveRuns,
} from './run-lifecycle';
import { extractErrorMessage } from '../utils/error';
import {
  dirtyWorktreesFromError,
  worktreeConfirmationParams,
  type WorktreeDirtyInfo,
} from '../lib/session-worktree';
import {
  sessionDeleteImpactFromError,
  sessionDeletePath,
  type SessionDeleteOptions,
  type SessionDeleteResult,
} from '../lib/session-delete';
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
  readStepQuestions,
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
    | 'automation_prompt'
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
  /** The automation that sent an `automation_prompt` input. */
  automation?: MessageAutomationOrigin | null;
}

export interface MessageAutomationOrigin {
  id: string;
  name: string;
  runId: string;
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

/**
 * What a conversation's Claude context holds now, from
 * `GET /api/groups/:jid/context-usage` and the `context_usage` push after
 * each turn. All null until a turn ran (and again after a reset).
 */
export interface ContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
  percentage: number | null;
}

function toContextUsage(
  data: Partial<ContextUsage> | null,
): ContextUsage | null {
  if (!data) return null;
  const usage: ContextUsage = {
    usedTokens: data.usedTokens ?? null,
    contextWindow: data.contextWindow ?? null,
    percentage: data.percentage ?? null,
  };
  return usage.usedTokens === null && usage.percentage === null ? null : usage;
}

// Bumped by every push or reset per key, so a GET that started before one
// does not overwrite it with an older answer.
const contextUsageRevisions = new Map<string, number>();

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
  /**
   * The progress statements the Agent sent in this proactive Web turn, in
   * order, with when each was sent (epoch ms).
   */
  progress?: Array<{ at: number; text: string }>;
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

/** `POST /api/messages` answered by the server itself (/clear, /fresh). */
type ClearedResponse = { success: true; cleared: true; fresh?: true };
type MessageCreateResponse =
  | ClearedResponse
  | {
      success: true;
      cleared?: undefined;
      messageId: string;
      timestamp: string;
      ingestSequence?: number;
      disposition: 'started' | 'queued' | 'steered';
      runId?: string;
      /**
       * A resend answered from the first attempt. Its run and queue state
       * are those of back then; the current ones come over the WebSocket.
       */
      deduplicated?: true;
    }
  | { success: false };
const isClearedResponse = (d: MessageCreateResponse): d is ClearedResponse =>
  d.success === true && d.cleared === true;

type SendAttachment = { data: string; mimeType: string };

/**
 * Each conversation's last unconfirmed send. Resending the same message
 * reuses its idempotency key, so the server answers from the first attempt.
 * The key is kept until the server accepts the send (HTTP 200), announces
 * its message with the key, a history fetch returns the message (the
 * announcement can be lost while the socket is down), or a send with another
 * target, text, images or mode takes its place.
 */
const unconfirmedSends = new Map<
  string,
  {
    content: string;
    attachments: SendAttachment[];
    mode: FollowUpMode;
    id: string;
    /** When the first attempt started, by this device's clock. */
    startedAt: number;
    /** When an HTTP fetch showed it stored (the WS echo was missed). */
    seenAt?: number;
  }
>();
// Server timestamps are compared with this device's clock.
const SEND_CLOCK_SKEW_MS = 5_000;
/**
 * A send seen stored over HTTP keeps its key this long: the failure toast
 * promised that resending the kept input will not duplicate it. After that,
 * the same text is a new message.
 */
const SEEN_SEND_GRACE_MS = 60_000;

function clientMessageIdFor(
  target: string,
  content: string,
  attachments: SendAttachment[] = [],
  mode: FollowUpMode,
): string {
  let previous = unconfirmedSends.get(target);
  if (
    previous?.seenAt !== undefined &&
    Date.now() - previous.seenAt > SEEN_SEND_GRACE_MS
  ) {
    unconfirmedSends.delete(target);
    previous = undefined;
  }
  if (
    previous &&
    previous.mode === mode &&
    previous.content === content &&
    previous.attachments.length === attachments.length &&
    previous.attachments.every(
      (att, i) =>
        att.data === attachments[i].data &&
        att.mimeType === attachments[i].mimeType,
    )
  ) {
    return previous.id;
  }
  const id = randomUuid();
  unconfirmedSends.set(target, {
    content,
    attachments,
    mode,
    id,
    startedAt: Date.now(),
  });
  return id;
}

/** The message sent under `clientMessageId` was stored: never reuse it. */
function forgetConfirmedSend(clientMessageId: string): void {
  for (const [target, send] of unconfirmedSends) {
    if (send.id === clientMessageId) unconfirmedSends.delete(target);
  }
}

/** `messages` came over HTTP: an unconfirmed send among them was stored. */
function forgetSendsSeenIn(target: string, messages: Message[]): void {
  const send = unconfirmedSends.get(target);
  if (!send) return;
  const me = useAuthStore.getState().user?.id;
  // The server stores the text trimmed.
  const content = send.content.trim();
  const earliest = send.startedAt - SEND_CLOCK_SKEW_MS;
  if (
    messages.some(
      (m) =>
        !m.is_from_me &&
        (!me || m.sender === me) &&
        m.content === content &&
        Date.parse(m.timestamp) >= earliest,
    )
  ) {
    send.seenAt ??= Date.now();
  }
}

/** No answer, or a proxy's: the send may have been stored anyway. */
function sendMayHaveLanded(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    status === 0 ||
    (typeof status === 'number' && [408, 502, 503, 504].includes(status))
  );
}

const UNCONFIRMED_SEND_HINT = '网络较慢，消息可能已发送；重发不会重复';

/** The server stored the message, then failed to process it. */
function storedDespiteError(err: unknown): boolean {
  return (err as ApiError | null)?.body?.stored === true;
}

/**
 * A stored send is settled, and a 409 means the id is spent on other
 * content: either way the next send to this target needs a fresh id.
 */
function settleFailedSend(target: string, err: unknown): void {
  if (
    storedDespiteError(err) ||
    (err as { status?: unknown } | null)?.status === 409
  ) {
    unconfirmedSends.delete(target);
  }
}

const showStoredButFailed = () =>
  showToast('消息已发送', '但处理可能失败，请稍后查看回复');
const showAlreadySent = () => showToast('这条消息已经发送过');

export interface StreamingState {
  turnId?: string;
  /**
   * The input this stream answers: the `turn_id` of its final row. A warm
   * turn's `turnId` is the Runner's own, so only this pairs the two there.
   */
  inputTurnId?: string;
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
/** Viewed sessions by runtime key, least recently viewed first. */
const viewedConversations = new Map<string, { jid: string; agentId: string }>();

function noteConversationViewed(jid: string, agentId: string) {
  const key = sessionJidOf(jid, agentId);
  viewedConversations.delete(key);
  viewedConversations.set(key, { jid, agentId });
}

/**
 * Drop the messages of the least recently viewed sessions beyond
 * RETAINED_CONVERSATIONS. The open workspace keeps all of its sessions,
 * because its stream events and new messages are applied to them, and so
 * does anything still running, streaming, awaiting a reply or clearing.
 */
function evictViewedConversations(
  s: ChatState,
  openJid: string,
): Partial<ChatState> {
  let excess = viewedConversations.size - RETAINED_CONVERSATIONS;
  if (excess <= 0) return {};
  let agentMessages: ChatState['agentMessages'] | undefined;
  let agentHasMore: ChatState['agentHasMore'] | undefined;
  for (const [key, { jid, agentId }] of viewedConversations) {
    if (excess <= 0) break;
    if (jid === openJid || jid === s.currentGroup) continue;
    const busy =
      !!s.activeRuns[key] ||
      !!s.settledStreaming[key] ||
      !!s.clearing[jid] ||
      !!s.agentWaiting[agentId] ||
      !!s.agentStreaming[agentId];
    if (busy) continue;
    viewedConversations.delete(key);
    excess -= 1;
    if (!s.agentMessages[agentId]) continue;
    agentMessages ??= { ...s.agentMessages };
    agentHasMore ??= { ...s.agentHasMore };
    delete agentMessages[agentId];
    delete agentHasMore[agentId];
  }
  return agentMessages ? { agentMessages, agentHasMore } : {};
}
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
 * Whether a runtime delivers its messages itself (a session of a proactive
 * workspace), so no final reply ever replaces its card. Fire-and-forget
 * spawn Agents keep the Assistant contract.
 */
export function isProactiveRuntime(
  s: Pick<ChatState, 'groups' | 'agents'>,
  runtimeJid: string,
): boolean {
  const agentId = sessionIdOf(runtimeJid);
  if (!agentId) return false;
  const chatJid = workspaceJidOf(runtimeJid);
  if (
    normalizeInteractionMode(s.groups[chatJid]?.interaction_mode) !==
    'proactive'
  ) {
    return false;
  }
  return (
    s.agents[chatJid]?.find((agent) => agent.id === agentId)?.kind !== 'spawn'
  );
}

/**
 * A proactive turn's state cut down to what `visibility` shows: the spinner
 * and the progress the Agent sent at `hidden`, no reasoning text at
 * `activity`. The owner can lower the level while a turn runs; what the new
 * level hides is dropped, and the progress, which every level shows, stays.
 */
function scrubForVisibility(
  state: StreamingState,
  visibility: ProcessVisibility,
): StreamingState {
  if (visibility === 'hidden') {
    const progress = state.steps?.filter(isProgressStep);
    return {
      ...DEFAULT_STREAMING_STATE,
      turnId: state.turnId,
      inputTurnId: state.inputTurnId,
      sessionId: state.sessionId,
      systemStatus: state.systemStatus,
      ...(progress?.length ? { steps: progress } : {}),
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
      ?.filter((step) => !step.commentary || isProgressStep(step))
      .map((step) =>
        step.kind === 'thinking'
          ? { ...step, text: '', title: undefined }
          : step,
      ),
  };
}

/**
 * `steps` with the progress statements a reconnect snapshot names that they
 * do not already hold (this tab may have missed some while it was away), in
 * the order they were sent among the other steps.
 */
function withSnapshotProgress(
  steps: StreamingStep[],
  progress: ReadonlyArray<{ at: number; text: string }>,
): StreamingStep[] {
  const held = new Set(
    steps.filter(isProgressStep).map((step) => step.text?.trim()),
  );
  const missing = progress.filter((entry) => !held.has(entry.text.trim()));
  if (missing.length === 0) return steps;
  const added: StreamingStep[] = missing.map((entry, index) => ({
    id: `progress-snapshot-${entry.at}-${index}`,
    kind: 'text',
    at: entry.at,
    endedAt: entry.at,
    status: 'done',
    commentary: true,
    progress: true,
    text: entry.text,
  }));
  return [...steps, ...added].sort((a, b) => a.at - b.at);
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
  agentId: string;
  inputTurnId: string;
  tokenUsageJson: string;
  receivedAt: number;
}

const PENDING_MESSAGE_USAGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_MESSAGE_USAGE = 128;

function messageUsageKey(
  chatJid: string,
  agentId: string,
  inputTurnId: string,
): string {
  return JSON.stringify([chatJid, agentId, inputTurnId]);
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

/** Drop a session's pending usage; without a session, the workspace's. */
function clearPendingMessageUsage(
  pending: Record<string, PendingMessageUsage>,
  chatJid: string,
  agentId?: string,
): Record<string, PendingMessageUsage> {
  return Object.fromEntries(
    Object.entries(pending).filter(
      ([, entry]) =>
        entry.chatJid !== chatJid ||
        (agentId !== undefined && entry.agentId !== agentId),
    ),
  );
}

function isUsageAnswer(message: Message, runtimeJid: string): boolean {
  return (
    message.chat_jid === runtimeJid &&
    message.is_from_me &&
    message.sender !== '__system__' &&
    message.source_kind !== 'sdk_send_message' &&
    !!message.turn_id
  );
}

function mergePendingMessageUsage(
  messages: Message[],
  pending: Record<string, PendingMessageUsage>,
  chatJid: string,
  agentId: string,
): { messages: Message[]; pending: Record<string, PendingMessageUsage> } {
  const next = prunePendingMessageUsage(pending);
  const runtimeJid = sessionJidOf(chatJid, agentId);
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
  /** Exact GroupQueue query attempt per session runtime JID. */
  activeRuns: ClientActiveRuns;
  /** Usage received before its canonical final row; bounded and session-scoped. */
  pendingMessageUsage: Record<string, PendingMessageUsage>;
  followUps: Record<string, QueuedFollowUp[]>;
  /** By session JID; null once known to be empty. */
  contextUsage: Record<string, ContextUsage | null>;
  loading: boolean;
  error: string | null;
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
  /**
   * A proactive reply whose turn's trace is on its way, by runtime JID: the
   * server stores it, and names the reply that carries it, when the turn ends.
   * The reply holds the row meanwhile, so its text does not move.
   */
  traceAwaited: Record<string, string>;
  /** Stop requested for a runtime JID (ms); the run shows "正在停止…". */
  stopRequests: Record<string, number>;
  /**
   * A finished run's frozen card by runtime JID, kept apart from the live
   * projection (`agentStreaming`) so the next queued run can start streaming
   * while the previous reply still waits for its final.
   */
  settledStreaming: Record<string, StreamingState>;
  /** Per-group lock: true while clearHistory is in-flight, prevents race re-injection */
  clearing: Record<string, boolean>;
  /** A workspace's sessions (and its running task/spawn agents), by workspace JID. */
  agents: Record<string, AgentInfo[]>;
  /** A session's live reply, by session id. */
  agentStreaming: Record<string, StreamingState>;
  /** The session open in a workspace, by workspace JID; absent when none is. */
  activeAgentTab: Record<string, string>;
  /** A session's loaded messages, by session id. */
  agentMessages: Record<string, Message[]>;
  /** Whether a session waits for a reply, by session id. */
  agentWaiting: Record<string, boolean>;
  /** Whether a session has older messages to load, by session id. */
  agentHasMore: Record<string, boolean>;
  loadGroups: () => Promise<void>;
  selectGroup: (jid: string) => void;
  loadFollowUps: (chatJid: string) => Promise<void>;
  loadContextUsage: (jid: string, agentId: string) => Promise<void>;
  /** A `context_usage` push (or a reset, with null). */
  setContextUsage: (
    jid: string,
    agentId: string,
    usage: Partial<ContextUsage> | null,
  ) => void;
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
  resetSession: (jid: string, agentId: string) => Promise<boolean>;
  /**
   * Rebuild the workspace. Session worktrees that could lose work refuse it
   * until `confirmedWorktrees` names every such session.
   */
  clearHistory: (
    jid: string,
    options?: { confirmedWorktrees?: string[] },
  ) => Promise<boolean | { worktreesDirty: WorktreeDirtyInfo[] }>;
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
  ) => Promise<{
    jid: string;
    folder: string;
    /** Non-blocking notes, e.g. another workspace uses the same directory. */
    warnings: Array<{ code: string; message: string }>;
  }>;
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
    options?: { unbindChannels?: boolean; confirmedWorktrees?: string[] },
  ) => Promise<void>;
  /**
   * Load the reasoning and execution trace the server kept of a finished
   * turn into the caches the message renders from. Quiet on failure.
   */
  loadTurnTrace: (
    message: Pick<Message, 'id' | 'chat_jid' | 'turn_id'>,
  ) => Promise<boolean>;
  /** A session's stream event; one without a session id has no conversation. */
  handleStreamEvent: (
    chatJid: string,
    event: StreamEvent,
    agentId?: string,
    runId?: string,
  ) => void;
  /** A session's new message; one without a session id has no conversation. */
  handleWsNewMessage: (chatJid: string, wsMsg: any, agentId?: string) => void;
  handleAgentStatus: (
    chatJid: string,
    agentId: string,
    status: AgentInfo['status'],
    name: string,
    prompt: string,
    resultSummary?: string,
    kind?: AgentInfo['kind'],
    titleGenerating?: boolean,
    /** Sent for a session that owns a worktree. */
    worktree?: SessionWorktreeInfo,
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
  /**
   * Resolves true when deleted. A session with chats, topics or automations
   * bound to it is kept until `confirmBindings` confirms what it affects
   * (`rebindTo` moves its chats to another session first); one whose worktree
   * has uncommitted changes until `forceWorktree` confirms discarding them.
   */
  deleteAgentAction: (
    jid: string,
    agentId: string,
    options?: SessionDeleteOptions,
  ) => Promise<SessionDeleteResult>;
  /** Pin or unpin a session for the current user. */
  pinSession: (
    jid: string,
    agentId: string,
    pinned: boolean,
  ) => Promise<boolean>;
  /** The session open in a workspace; null when none is. */
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  // Conversation agent actions
  createConversation: (
    jid: string,
    name?: string,
    description?: string,
    options?: { worktree?: boolean },
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
  // Run lifecycle
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

/**
 * The projection streams the answer to input `turnId`: the input it names, or
 * on a cold start its own turn, which is that input. Never a guess: a stream
 * that names neither belongs to some other turn as far as this tab can tell.
 */
function answersInput(
  state: StreamingState | undefined,
  turnId: string | null | undefined,
): state is StreamingState {
  return (
    !!state &&
    !!turnId &&
    (state.inputTurnId === turnId || state.turnId === turnId)
  );
}

/**
 * A final that closes its turn. A truncated one is followed by its
 * continuation and a held one by its running Workflow, in the same turn.
 */
function endsTurn(msg: Message): boolean {
  return (
    msg.finalization_reason !== 'truncated' &&
    !msg.workflow_runs?.some((run) => run.status === 'running')
  );
}

/** The live card of an active run, not stopped, streams input `turnId`. */
function streamsInputOf(
  runs: ClientActiveRuns,
  runtimeJid: string,
  live: StreamingState | undefined,
  turnId: string | null | undefined,
): live is StreamingState {
  return (
    !!runs[runtimeJid] &&
    !isFrozenProjection(live) &&
    answersInput(live, turnId)
  );
}

interface FinalSettlement {
  /** The live card of the final's own turn gives way while its run closes. */
  inPlace: boolean;
  /** The live card gives way: in place, or its run is over or was stopped. */
  replacesLive: boolean;
  /** The card whose thinking, steps and trace the reply takes. */
  source: StreamingState | undefined;
  /** The settled card gives way too; one of another turn waits for its own. */
  dropsSettled: boolean;
  activeRuns: ClientActiveRuns;
}

/**
 * How a final reply settles the cards of its runtime, whichever way it arrives
 * (its own frame, or a refresh). The live card of exactly its turn settles in
 * place: the run may still be closing, but the turn is over, so the card gives
 * way to the reply now rather than at run_finished. Otherwise the reply takes
 * a settled card's place, or the live one of a run that is over or stopped; a
 * live card of another turn is left alone.
 */
function settlementOf(
  runs: ClientActiveRuns,
  runtimeJid: string,
  live: StreamingState | undefined,
  settled: StreamingState | undefined,
  msg: Message,
  /** A system error ends a turn too, but only a reply takes its card's place. */
  isReply = true,
): FinalSettlement {
  const inPlace =
    isReply &&
    endsTurn(msg) &&
    streamsInputOf(runs, runtimeJid, live, msg.turn_id);
  const replacesLive = inPlace || !runs[runtimeJid] || isFrozenProjection(live);
  return {
    inPlace,
    replacesLive,
    source: inPlace ? live : (settled ?? (replacesLive ? live : undefined)),
    dropsSettled: !!settled && (!inPlace || answersInput(settled, msg.turn_id)),
    activeRuns: inPlace ? markRunAnswered(runs, runtimeJid, msg.turn_id) : runs,
  };
}

/**
 * Nothing of the run is left to show: the turn of its live slot ended in place
 * (`ClientActiveRun.answered`) and no other input of the run streams yet. The
 * composer still has the run to stop until run_finished.
 */
export function runTurnAnswered(
  answered: string | undefined,
  live: StreamingState | undefined,
): boolean {
  return !!answered && (!live || answersInput(live, answered));
}

/** The live projection of a session runtime. */
export function liveStreamOf(
  s: Pick<ChatState, 'agentStreaming'>,
  runtimeJid: string,
): StreamingState | undefined {
  const agentId = sessionIdOf(runtimeJid);
  return agentId ? s.agentStreaming[agentId] : undefined;
}

/**
 * A proactive turn has replied (`proactiveReplyLanded`) and since only
 * reasons, as it does once more before it ends: its panel stays away, and so
 * does the run status bar for a while. One rule for both.
 */
export function proactiveTurnQuiet(
  s: Pick<ChatState, 'groups' | 'agents' | 'activeRuns' | 'agentStreaming'>,
  runtimeJid: string,
): boolean {
  if (!isProactiveRuntime(s, runtimeJid)) return false;
  const live = liveStreamOf(s, runtimeJid);
  return (
    runTurnAnswered(s.activeRuns[runtimeJid]?.answered, live) &&
    !hasVisibleWork(live)
  );
}

/**
 * A proactive workspace answers through send_message: an utterance (checked by
 * the caller) of the turn the live panel streams is that turn's reply. The
 * panel gives way to it, and stays away while the turn only reasons (it asks
 * the model once more to decide it is done); new work brings it back
 * (`hasVisibleWork`). Nothing of the process moves onto the reply here: the
 * server hangs the turn's process on its last reply, at the owner's level.
 */
function proactiveReplyLanded(
  s: ChatState,
  runtimeJid: string,
  live: StreamingState | undefined,
  utterance: Message,
): boolean {
  if (
    utterance.finalization_reason &&
    utterance.finalization_reason !== 'completed'
  ) {
    return false;
  }
  return (
    isProactiveRuntime(s, runtimeJid) &&
    streamsInputOf(s.activeRuns, runtimeJid, live, utterance.turn_id)
  );
}

/**
 * `traceAwaited` with `reply` as the proactive reply of `runtimeJid` whose
 * trace is coming: where the process is kept, and at `hidden` only for a turn
 * that sent progress statements (all that level keeps).
 */
function withAwaitedTrace(
  s: ChatState,
  runtimeJid: string,
  reply: Message,
): Record<string, string> {
  return processViewOfRuntime(s, runtimeJid) === 'proactive:hidden' &&
    !liveStreamOf(s, runtimeJid)?.steps?.some(isProgressStep)
    ? s.traceAwaited
    : { ...s.traceAwaited, [runtimeJid]: reply.id };
}

/** `traceAwaited` without the held row of `runtimeJid`, if it is `replyId`'s. */
function releaseAwaitedTrace(
  s: ChatState,
  runtimeJid: string,
  replyId: string,
): ChatState | Pick<ChatState, 'traceAwaited'> {
  return s.traceAwaited[runtimeJid] === replyId
    ? { traceAwaited: withoutKey(s.traceAwaited, runtimeJid) }
    : s;
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

/** The view of the workspace a session runtime belongs to. */
function processViewOfRuntime(
  s: Pick<ChatState, 'groups'>,
  runtimeJid: string,
): string {
  return processView(s.groups[workspaceJidOf(runtimeJid)]);
}

/**
 * The turn-trace request in flight for each message, newest last. A reply of
 * the view that has changed since it was asked for, or of a request that a
 * newer one has taken over, is not written (see `loadTurnTrace`).
 */
const turnTraceRequests = new Map<string, symbol>();

/**
 * The reasoning, trace and steps this tab holds for the replies of the
 * sessions of workspaces, let go. They were read at the view that was in force: a
 * lowered level must not leave what it hides in memory or on screen, and a
 * raised one must not leave the replies without what it now shows (or marked
 * empty). The replies load again, at the new view, when they are opened.
 */
function withoutProcessCaches(
  s: ChatState,
  jids: readonly string[],
): Partial<ChatState> {
  const ids = new Set<string>();
  for (const messages of Object.values(s.agentMessages)) {
    for (const message of messages) {
      if (jids.some((jid) => isSessionOf(message.chat_jid, jid))) {
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
    ...withoutStaleTraceFlags(
      s,
      jids.filter((jid) => processView(s.groups[jid]) === 'proactive:hidden'),
    ),
  };
}

/**
 * The replies of workspaces now `hidden`, without the `has_trace` read at
 * another level. At `hidden` only a turn that sent progress has a trace to
 * show, and which ones did is the server's to say on the next load.
 */
function withoutStaleTraceFlags(
  s: ChatState,
  jids: readonly string[],
): Partial<ChatState> {
  if (jids.length === 0) return {};
  let next = s.agentMessages;
  for (const [key, list] of Object.entries(s.agentMessages)) {
    if (
      !list.some((message) => message.has_trace) ||
      !list.some((message) =>
        jids.some((jid) => isSessionOf(message.chat_jid, jid)),
      )
    ) {
      continue;
    }
    if (next === s.agentMessages) next = { ...s.agentMessages };
    next[key] = list.map((message) =>
      message.has_trace ? { ...message, has_trace: false } : message,
    );
  }
  return { agentMessages: next };
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

/** Messages the reader has in front of them: the open session's. */
function idsOnScreen(
  s: Pick<ChatState, 'currentGroup' | 'agentMessages' | 'activeAgentTab'>,
): Set<string> {
  const ids = new Set<string>();
  const agentId = s.currentGroup ? s.activeAgentTab[s.currentGroup] : null;
  for (const message of (agentId && s.agentMessages[agentId]) || []) {
    ids.add(message.id);
  }
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
 * output and the numbers read from it. A proactive workspace never shows them,
 * except structured workspace-memory write receipts.
 */
export function withoutToolResults(step: StreamingStep): StreamingStep {
  const keepMemoryReceipt =
    step.kind === 'tool' &&
    step.status === 'done' &&
    !!step.toolName &&
    MEMORY_WRITE_TOOLS.has(step.toolName);
  if (
    (keepMemoryReceipt || step.resultPreview === undefined) &&
    step.resultFacts === undefined
  ) {
    return step;
  }
  const { resultPreview: _preview, resultFacts: _facts, ...rest } = step;
  return keepMemoryReceipt && step.resultPreview !== undefined
    ? { ...rest, resultPreview: step.resultPreview }
    : rest;
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
      inputTurnId: event.inputTurnId,
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
  const agentId = sessionIdOf(chatJid);
  if (!agentId) return {};
  const existing = s.agentMessages[agentId] || [];
  const updated = apply(existing);
  return updated === existing
    ? {}
    : { agentMessages: { ...s.agentMessages, [agentId]: updated } };
}
const MAX_EVENT_LOG = 30;
const MAX_TRACE_EVENTS = 200;
const MAX_TASK_TAIL = 4000;

/** 已结束的 spawn agent 自动清理定时器（完成后延迟移除） */
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
  inputTurnId?: string;
}
/** Deltas waiting for the next frame, by session id. */
const pendingDeltas = new Map<string, PendingDelta>();

/**
 * Tool calls of one kind, per runtime: a call's start names its tool, its
 * later events carry only the id of the call. Kept for the run that made them,
 * so a new run starts empty.
 */
const NO_CALLS: ReadonlySet<string> = new Set();

class RunToolCalls {
  private readonly byRuntime = new Map<
    string,
    { runId: string; calls: Set<string> }
  >();

  constructor(private readonly max: number) {}

  of(runtimeJid: string, runId?: string): ReadonlySet<string> {
    const entry = this.byRuntime.get(runtimeJid);
    return entry && entry.runId === (runId ?? '') ? entry.calls : NO_CALLS;
  }

  remember(
    runtimeJid: string,
    runId: string | undefined,
    ids: Iterable<string>,
  ): void {
    const key = runId ?? '';
    let entry = this.byRuntime.get(runtimeJid);
    if (!entry || entry.runId !== key) {
      entry = { runId: key, calls: new Set() };
      this.byRuntime.set(runtimeJid, entry);
    }
    for (const id of ids) {
      if (entry.calls.size >= this.max) {
        const oldest = entry.calls.values().next().value;
        if (oldest !== undefined) entry.calls.delete(oldest);
      }
      entry.calls.add(id);
    }
  }
}

/** The calls of a proactive turn's speech tool. */
const speechToolCalls = new RunToolCalls(64);
/**
 * The calls of a proactive turn's memory write tools: only their results are
 * kept, as the receipts the process links to.
 */
const memoryWriteCalls = new RunToolCalls(64);

/** The speech tool's calls in a reconnect snapshot: its rows and running calls. */
function speechCallsOfSnapshot(snapshot: StreamSnapshotData): Set<string> {
  const calls = speechToolCallsIn(snapshot.traceEvents ?? []);
  for (const tool of snapshot.activeTools ?? []) {
    if (tool.toolName === SPEECH_TOOL_NAME) calls.add(tool.toolUseId);
  }
  return calls;
}

// Match the runner's retry banner (including unknown SDK counters), not user
// progress text that happens to mention a retry or a file named retry.ts.
const API_RETRY_STATUS_RE =
  /^API (?:重试中 \((?:\d+|\?)\/(?:\d+|\?)\)，\d+s 后重试|retry in progress \((?:\d+|\?)\/(?:\d+|\?)\))$/i;

function cancelPendingDelta(agentId: string): void {
  const entry = pendingDeltas.get(agentId);
  if (!entry) return;
  cancelAnimationFrame(entry.raf);
  pendingDeltas.delete(agentId);
}

function cancelPendingDeltaForRuntime(runtimeJid: string): void {
  const agentId = sessionIdOf(runtimeJid);
  if (agentId && pendingDeltas.get(agentId)?.runtimeJid === runtimeJid) {
    cancelPendingDelta(agentId);
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
  const agentId = sessionIdOf(runtimeJid);
  if (!agentId) return;
  const entry = pendingDeltas.get(agentId);
  if (!entry || entry.runtimeJid !== runtimeJid) return;
  cancelAnimationFrame(entry.raf);
  flushPendingDelta(agentId, set);
}

/**
 * The state a batch of deltas extends: the live projection of the same turn,
 * or a fresh one for a new turn.
 */
function deltaBase(
  current: StreamingState | undefined,
  { turnId, inputTurnId }: Pick<PendingDelta, 'turnId' | 'inputTurnId'>,
): StreamingState {
  if (!current || (current.turnId && turnId && current.turnId !== turnId)) {
    return { ...DEFAULT_STREAMING_STATE, turnId, inputTurnId };
  }
  const next = {
    turnId: current.turnId ?? turnId,
    inputTurnId: inputTurnId ?? current.inputTurnId,
  };
  return next.turnId === current.turnId &&
    next.inputTurnId === current.inputTurnId
    ? current
    : { ...current, ...next };
}

function flushPendingDelta(
  agentId: string,
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
): void {
  const entry = pendingDeltas.get(agentId);
  if (!entry) return;
  pendingDeltas.delete(agentId);

  set((s) => {
    if (
      !shouldApplyRunScopedPayload(s.activeRuns, entry.runtimeJid, entry.runId)
    ) {
      return s;
    }
    const current = s.agentStreaming[agentId];
    if (!current && s.agentWaiting[agentId] === false) return s;
    // A stopped card is frozen until its terminal message replaces it.
    if (current?.interrupted) return s;
    const prev = deltaBase(current, entry);
    const next = applyDeltaChunks(
      prev,
      entry.chunks,
      runStartedAtMs(s.activeRuns, entry.runtimeJid),
    );
    if (next === prev) return s;
    return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
  });
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

/** The state of one session, let go: it was deleted or removed. */
function withoutSession(
  s: ChatState,
  jid: string,
  agentId: string,
): Partial<ChatState> {
  return {
    agents: {
      ...s.agents,
      [jid]: (s.agents[jid] || []).filter((a) => a.id !== agentId),
    },
    pendingMessageUsage: clearPendingMessageUsage(
      s.pendingMessageUsage,
      jid,
      agentId,
    ),
    agentMessages: withoutKey(s.agentMessages, agentId),
    agentStreaming: withoutKey(s.agentStreaming, agentId),
    agentWaiting: withoutKey(s.agentWaiting, agentId),
    agentHasMore: withoutKey(s.agentHasMore, agentId),
    settledStreaming: withoutKey(
      s.settledStreaming,
      sessionJidOf(jid, agentId),
    ),
    activeAgentTab:
      s.activeAgentTab[jid] === agentId
        ? withoutKey(s.activeAgentTab, jid)
        : s.activeAgentTab,
  };
}

/**
 * The state of a workspace's sessions, let go: their list, the open one,
 * their messages, live and settled replies, and the reasoning and steps of
 * replies no session holds any more.
 */
function withoutWorkspaceSessions(
  s: ChatState,
  jid: string,
): Partial<ChatState> {
  const agentMessages = { ...s.agentMessages };
  const agentStreaming = { ...s.agentStreaming };
  const agentWaiting = { ...s.agentWaiting };
  const agentHasMore = { ...s.agentHasMore };
  for (const { id } of s.agents[jid] ?? []) {
    delete agentMessages[id];
    delete agentStreaming[id];
    delete agentWaiting[id];
    delete agentHasMore[id];
  }
  return {
    agents: withoutKey(s.agents, jid),
    activeAgentTab: withoutKey(s.activeAgentTab, jid),
    agentMessages,
    agentStreaming,
    agentWaiting,
    agentHasMore,
    settledStreaming: withoutWorkspaceSettled(s.settledStreaming, jid),
    pendingMessageUsage: clearPendingMessageUsage(s.pendingMessageUsage, jid),
    thinkingCache: retainThinkingCacheForMessages(
      agentMessages,
      s.thinkingCache,
    ),
    thinkingDurationCache: retainThinkingCacheForMessages(
      agentMessages,
      s.thinkingDurationCache,
    ),
    traceCache: retainThinkingCacheForMessages(agentMessages, s.traceCache),
    stepsCache: retainThinkingCacheForMessages(agentMessages, s.stepsCache),
    turnTraceStatus: retainThinkingCacheForMessages(
      agentMessages,
      s.turnTraceStatus,
    ),
  };
}

/** Settled cards of all the sessions of a workspace. */
function withoutWorkspaceSettled(
  settled: Record<string, StreamingState>,
  jid: string,
): Record<string, StreamingState> {
  const keys = Object.keys(settled).filter((key) => isSessionOf(key, jid));
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
  const agentId = sessionIdOf(runtimeJid);
  const chatJid = workspaceJidOf(runtimeJid);
  const current = () => get().settledStreaming[runtimeJid];
  setTimeout(async () => {
    if (current() !== settled) return;
    try {
      if (agentId && get().agentMessages[agentId]) {
        await get().refreshAgentMessages(chatJid, agentId);
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
      return { agents: { ...s.agents, [chatJid]: filtered } };
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

/** SDK task types that are not sub-agents (e.g. backgrounded Bash, monitors). */
const NON_AGENT_TASK_TYPES = new Set(['local_bash', 'monitor', 'mcp_task']);

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
  const task = next.taskStates[taskId];
  const effectiveTaskType = event.taskType ?? task?.taskType;
  const id = event.toolUseId ?? taskId;
  let list = stepsOf(next);
  if (
    (effectiveTaskType && NON_AGENT_TASK_TYPES.has(effectiveTaskType)) ||
    list.steps.some(
      (s) =>
        s.kind === 'tool' &&
        s.toolUseId === id &&
        s.toolName !== 'Task' &&
        s.toolName !== 'Agent',
    )
  ) {
    return;
  }
  if (!hasTaskStep(list, taskId)) {
    list = closeOpenSteps(list, at, prev.partialText, prev.partialBase ?? 0);
  }
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
 * Shared by every session's stream.
 */
function applyStreamEvent(
  event: StreamEvent,
  prev: StreamingState,
  next: StreamingState,
  maxText: number,
  runStartedAt?: number,
): void {
  if (event.turnId) next.turnId = event.turnId;
  if (event.inputTurnId) next.inputTurnId = event.inputTurnId;
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
      setSteps(
        next,
        addCommentaryStep(stepsOf(next), at, event.text, !!event.progress),
      );
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
              questions: readStepQuestions(event.toolInput),
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
              questions: readStepQuestions(event.toolInput),
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
  activeRuns: {},
  pendingMessageUsage: {},
  followUps: {},
  contextUsage: {},
  loading: false,
  error: null,
  thinkingCache: {},
  thinkingDurationCache: {},
  traceCache: {},
  stepsCache: {},
  turnTraceStatus: {},
  stopRequests: {},
  settledStreaming: {},
  traceAwaited: {},
  clearing: {},
  agents: {},
  agentStreaming: {},
  // The open session is mirrored from the URL (?agent=...) by ChatView. The
  // store holds an in-memory copy for components that read it directly.
  activeAgentTab: {},
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
  },

  loadContextUsage: async (jid, agentId) => {
    const key = sessionJidOf(jid, agentId);
    const revision = contextUsageRevisions.get(key) ?? 0;
    try {
      const data = await api.get<Partial<ContextUsage>>(
        `/api/groups/${encodeURIComponent(jid)}/context-usage?${new URLSearchParams({ agentId })}`,
      );
      if ((contextUsageRevisions.get(key) ?? 0) !== revision) return;
      set((s) => ({
        contextUsage: { ...s.contextUsage, [key]: toContextUsage(data) },
      }));
    } catch (err) {
      console.warn('[context-usage] failed to load', err);
    }
  },

  setContextUsage: (jid, agentId, usage) => {
    const key = sessionJidOf(jid, agentId);
    contextUsageRevisions.set(key, (contextUsageRevisions.get(key) ?? 0) + 1);
    set((s) => ({
      contextUsage: { ...s.contextUsage, [key]: toContextUsage(usage) },
    }));
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
        // Agent 已完成，无活跃查询可中断：清除该会话卡住的状态。
        const agentId = sessionIdOf(jid);
        if (agentId) {
          // Cancel pending rAF to prevent stale flushes
          cancelPendingDelta(agentId);
          set((s) => ({
            agentStreaming: withoutKey(s.agentStreaming, agentId),
            agentWaiting: { ...s.agentWaiting, [agentId]: false },
          }));
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

  resetSession: async (jid: string, agentId: string) => {
    try {
      await api.post<{ success: boolean; dividerMessageId: string }>(
        `/api/groups/${encodeURIComponent(jid)}/reset-session`,
        { agentId },
      );
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      return false;
    }
    set((s) => ({
      pendingMessageUsage: clearPendingMessageUsage(
        s.pendingMessageUsage,
        jid,
        agentId,
      ),
      agentStreaming: withoutKey(s.agentStreaming, agentId),
      agentWaiting: withoutKey(s.agentWaiting, agentId),
    }));
    get().setContextUsage(jid, agentId, null);
    await get().loadAgentMessages(jid, agentId);
    return true;
  },

  clearHistory: async (jid: string, options = {}) => {
    // Set clearing lock BEFORE the API call to block polling & WS injection
    set((s) => ({ clearing: { ...s.clearing, [jid]: true } }));

    try {
      const search = worktreeConfirmationParams(
        options.confirmedWorktrees,
      ).toString();
      await api.post<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/clear-history${
          search ? `?${search}` : ''
        }`,
      );

      void deleteGroupMessageSnapshots(jid);

      set((s) => {
        // Reset UI-scoped state tied to this workspace's sessions.
        const nextDrafts = Object.fromEntries(
          Object.entries(s.drafts).filter(([key]) => !isSessionOf(key, jid)),
        );
        return {
          // The backend has deleted the session rows already.
          ...withoutWorkspaceSessions(s, jid),
          clearing: withoutKey(s.clearing, jid),
          drafts: nextDrafts,
          error: null,
        };
      });

      await get().loadGroups();
      await get().loadAgents(jid, { force: true });
      // 重建工作区后刷新文件列表（工作目录已被清空）
      useFileStore.getState().loadFiles(jid);
      return true;
    } catch (err) {
      const worktreesDirty = dirtyWorktreesFromError(err);
      // Release clearing lock on failure
      set((s) => {
        const { [jid]: _, ...nextClearing } = s.clearing;
        return {
          clearing: nextClearing,
          ...(worktreesDirty ? {} : { error: extractErrorMessage(err) }),
        };
      });
      return worktreesDirty ? { worktreesDirty } : false;
    }
  },

  handleMessageDeleted: async (messageChatJid, messageId) => {
    // Every message is a session's, in that session's list.
    const agentId = sessionIdOf(messageChatJid);
    if (!agentId) return;
    const workspaceJid = workspaceJidOf(messageChatJid);

    set((s) => {
      const loaded = s.agentMessages[agentId]?.filter(
        (message) =>
          message.id !== messageId || message.chat_jid !== messageChatJid,
      );
      const agentMessages = loaded
        ? { ...s.agentMessages, [agentId]: loaded }
        : s.agentMessages;

      // The Session sidebar has its own latest-message projection. Update it
      // immediately from the loaded page, then force an authoritative refresh
      // below in case the previous message is outside that page.
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
      return { agentMessages, agents };
    });

    // A deleted sensitive message must not survive in the PWA's persisted
    // hydrate cache. Await invalidation so an immediate reload cannot race it.
    await deleteAgentMessageSnapshot(workspaceJid, agentId);
    await get().loadAgents(workspaceJid, { force: true });
  },

  handleMessageTrace: (messageChatJid, messageId) => {
    const agentId = sessionIdOf(messageChatJid);
    const workspaceJid = agentId ? workspaceJidOf(messageChatJid) : null;
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
      // Every message is a session's, in that session's list.
      const list = agentId ? s.agentMessages[agentId] : undefined;
      known = !!list?.some(isIt);
      if (!agentId || !list?.some(marks)) return s;
      const updated = mark(list);
      snapshot = { messages: updated, hasMore: !!s.agentHasMore[agentId] };
      return { agentMessages: { ...s.agentMessages, [agentId]: updated } };
    });
    // The held row is the reply's own now (marked first, so it never lapses).
    set((s) => releaseAwaitedTrace(s, messageChatJid, messageId));
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
        warnings?: Array<{ code: string; message: string }>;
      }>('/api/groups', body, needsLongTimeout ? 120_000 : undefined);
      if (!data.success) {
        throw new Error('服务器未能创建工作区');
      }

      const group = normalizeGroupInteractionMode(data.group);
      set((s) => ({
        groups: { ...s.groups, [data.jid]: group },
        error: null,
      }));

      return {
        jid: data.jid,
        folder: group.folder,
        warnings: data.warnings ?? [],
      };
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
        // A level lowered mid-run must not leave what it hides in memory:
        // the workspace's listed sessions and those running in it.
        const sessionIds = new Set([
          ...(state.agents[jid] ?? []).map((agent) => agent.id),
          ...Object.keys(state.activeRuns).flatMap((runtimeJid) =>
            workspaceJidOf(runtimeJid) === jid
              ? [sessionIdOf(runtimeJid) ?? '']
              : [],
          ),
        ]);
        const nextAgentStreaming = { ...state.agentStreaming };
        for (const agentId of sessionIds) {
          if (
            nextAgentStreaming[agentId] &&
            isProactiveRuntime(state, sessionJidOf(jid, agentId))
          ) {
            nextAgentStreaming[agentId] = scrubForVisibility(
              nextAgentStreaming[agentId],
              processVisibility,
            );
          }
        }
        return {
          groups: patchGroups(state.groups),
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
      const params = worktreeConfirmationParams(options.confirmedWorktrees);
      if (options.unbindChannels) params.set('unbind_channels', 'true');
      const search = params.toString();
      const query = search ? `?${search}` : '';
      await api.delete<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}${query}`,
      );
      // Workspace 已删除，连带把该 jid 下所有 conversation agent 的 IDB 快照
      // 也清掉，避免 IDB 长期堆积孤儿条目。
      void deleteGroupMessageSnapshots(jid);
      set((s) => {
        const nextGroups = { ...s.groups };
        delete nextGroups[jid];

        let nextCurrent = s.currentGroup === jid ? null : s.currentGroup;
        // Auto-select first remaining group after deletion
        if (nextCurrent === null) {
          const remainingJids = Object.keys(nextGroups);
          nextCurrent = remainingJids.length > 0 ? remainingJids[0] : null;
        }

        return {
          groups: nextGroups,
          ...withoutWorkspaceSessions(s, jid),
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
          apiErr.body?.bound_thread_contexts)
      ) {
        const e = new Error(
          apiErr.message || 'IM binding conflict',
        ) as Error & {
          boundSessions?: unknown;
          boundAgents?: unknown;
          boundThreadContexts?: unknown;
        };
        e.boundSessions = apiErr.body.bound_sessions;
        e.boundAgents = apiErr.body.bound_agents;
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
    // Every conversation is a session: an event without one has nowhere to go.
    if (!agentId) return;
    // Skip while clearHistory is in-flight
    if (get().clearing[chatJid]) return;

    // Runtime context audits may contain host paths and prompt wiring. They are
    // useful to operators, but never belong in a user's conversation state.
    if (event.eventType === 'context_audit') return;

    const runtimeJid = sessionJidOf(chatJid, agentId);
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
        const messages = s.agentMessages[agentId] || [];
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
        snapshotMessages = updated;
        snapshotHasMore = !!s.agentHasMore[agentId];
        return {
          agentMessages: { ...s.agentMessages, [agentId]: updated },
          pendingMessageUsage: pending,
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
      return;
    }

    // A proactive workspace shows the process at the level its owner chose and
    // never its model text: whatever else reaches the Web is dropped here,
    // even if the host sent it.
    if (isProactiveRuntime(get(), runtimeJid)) {
      if (
        event.eventType === 'tool_use_start' &&
        event.toolUseId &&
        MEMORY_WRITE_TOOLS.has(event.toolName ?? '')
      ) {
        memoryWriteCalls.remember(runtimeJid, runId, [event.toolUseId]);
      }
      const allowed = filterProactiveStreamEvent(
        normalizeProcessVisibility(get().groups[chatJid]?.process_visibility),
        event,
        memoryWriteCalls.of(runtimeJid, runId),
      );
      if (!allowed) return;
      event = allowed;
      // Calling the speech tool is the reply itself, not work to watch: it is
      // neither a step nor the latest tool, and does not count among the tools
      // used. Its start still ends the reasoning before it.
      if (isSpeechToolEvent(event, speechToolCalls.of(runtimeJid, runId))) {
        if (event.eventType === 'tool_use_start' && event.toolUseId) {
          speechToolCalls.remember(runtimeJid, runId, [event.toolUseId]);
          // Keep arrival order: reasoning still waiting for its frame came first.
          flushPendingDeltaForRuntime(runtimeJid, set);
          set((s) => {
            const prev = s.agentStreaming[agentId];
            if (!prev || prev.interrupted) return s;
            const next = { ...prev };
            endThinkingBurst(prev, next, Date.now());
            next.awaitingModel = false;
            next.phaseStartedAt = undefined;
            return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
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
        const prev = s.agentStreaming[agentId];
        if (
          !prev ||
          prev.interrupted ||
          !API_RETRY_STATUS_RE.test(prev.systemStatus || '')
        ) {
          return s;
        }
        return {
          agentStreaming: {
            ...s.agentStreaming,
            [agentId]: { ...prev, systemStatus: null },
          },
        };
      });
    }

    // ⓪ text_delta / thinking_delta — rAF batch. A sub-agent's own text and
    // reasoning (it has a parent tool) is its task's tail, not the reply's.
    if (
      (event.eventType === 'text_delta' ||
        event.eventType === 'thinking_delta') &&
      !event.parentToolUseId
    ) {
      let entry = pendingDeltas.get(agentId);
      if (entry && (entry.runtimeJid !== runtimeJid || entry.runId !== runId)) {
        cancelPendingDelta(agentId);
        entry = undefined;
      }
      if (entry && event.turnId && entry.turnId !== event.turnId) {
        // A new turn: settle the old turn's frame before starting this one.
        cancelAnimationFrame(entry.raf);
        flushPendingDelta(agentId, set);
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
        inputTurnId: event.inputTurnId,
      };
      entry.raf = requestAnimationFrame(() => {
        flushPendingDelta(agentId, set);
      });
      pendingDeltas.set(agentId, entry);
      return;
    }

    // Keep arrival order: text/thinking still waiting for rAF happened before
    // this event (a tool start must not be overtaken by the thinking that
    // preceded it).
    flushPendingDeltaForRuntime(runtimeJid, set);

    if (event.eventType === 'status' && event.statusText === 'interrupted') {
      // 两阶段处理：先冻结（保留已输出内容），
      // 等 new_message (interrupt_partial) 到达后完成最终清理。
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
          set((s) => ({
            agentStreaming: withoutKey(s.agentStreaming, agentId),
          }));
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

    // A background task's end is news even when the reader looks elsewhere
    // (after the stream took it: a notification that throws skips nothing).
    // The SDK marks its own background completions; the ones the stream
    // processor makes up for foreground tasks carry no such mark.
    if (
      event.eventType === 'task_notification' &&
      event.taskId &&
      event.isBackground &&
      shouldEmitBackgroundTaskNotice(event.taskId)
    ) {
      const desc = (
        get().agentStreaming[agentId]?.taskStates[event.taskId]?.title ||
        event.taskSummary ||
        '后台任务'
      ).slice(0, 60);
      const status = event.taskStatus === 'completed' ? '已完成' : '失败';
      if (typeof document === 'undefined' || !document.hidden) {
        showToast(`${desc} ${status}`, event.taskSummary);
      }
      notifyIfHidden(`HappyClaw: ${desc} ${status}`, event.taskSummary);
    }
  },

  // 通过 WebSocket new_message 事件立即添加消息（避免轮询延迟导致消息"丢失"）
  handleWsNewMessage: (chatJid, wsMsg, agentId?) => {
    if (!wsMsg || !wsMsg.id) return;
    if (typeof wsMsg.client_message_id === 'string') {
      forgetConfirmedSend(wsMsg.client_message_id);
    }
    // Every conversation is a session: a message without one is no
    // conversation's.
    if (!agentId) return;
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
      ...(wsMsg.automation ? { automation: wsMsg.automation } : {}),
    };
    const resetsContext =
      msg.sender === '__system__' &&
      (msg.content === 'context_reset' ||
        msg.content === 'context_fresh_window');
    // The conversation starts over, wherever the reset came from (Web, IM,
    // the agent itself): no context until its next turn.
    if (resetsContext) get().setContextUsage(chatJid, agentId, null);
    const isProactiveUtterance =
      msg.is_from_me &&
      msg.sender !== '__system__' &&
      msg.source_kind === 'sdk_send_message';
    const isAgentReply =
      msg.is_from_me &&
      msg.sender !== '__system__' &&
      msg.source_kind !== 'sdk_send_message';
    // A finished reply (not a progress row of a workflow still running).
    const finishesReply =
      isAgentReply &&
      !holdsRunningWorkflow &&
      (msg.source_kind === 'sdk_final' ||
        msg.source_kind === 'interrupt_partial' ||
        msg.source_kind === 'legacy' ||
        msg.source_kind == null);
    const runtimeJid = sessionJidOf(chatJid, agentId);

    // Apply a frame still waiting for rAF before the reply replaces the card
    // it belongs to.
    flushPendingDeltaForRuntime(runtimeJid, set);
    let snapshotMessages: Message[] | null = null;
    let snapshotHasMore = false;
    let didReceiveProactiveUtterance = false;
    let didFinishReply = false;
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
      const exactRunActive = !!s.activeRuns[runtimeJid];
      // The reply takes its card's place in this same update, carrying its
      // thinking and execution details over (`settlementOf`).
      const agentState = s.agentStreaming[agentId];
      const settlement = isAgentReply
        ? settlementOf(
            s.activeRuns,
            runtimeJid,
            agentState,
            s.settledStreaming[runtimeJid],
            msg,
          )
        : null;
      const replyLanded =
        isProactiveUtterance &&
        proactiveReplyLanded(s, runtimeJid, agentState, msg);
      const nextAgentStreaming =
        !replyLanded && !settlement?.replacesLive
          ? s.agentStreaming
          : settlement && holdsRunningWorkflow
            ? {
                ...s.agentStreaming,
                [agentId]: streamingStateFromWorkflowRuns(runningWorkflowRuns),
              }
            : withoutKey(s.agentStreaming, agentId);

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
      // Unread replies are counted per workspace: one arriving while the
      // page is hidden or another conversation is open.
      const isHidden = typeof document !== 'undefined' && document.hidden;
      const isOtherConversation =
        s.currentGroup !== chatJid || s.activeAgentTab[chatJid] !== agentId;
      didReceiveProactiveUtterance = isNewMessage && isProactiveUtterance;
      didFinishReply = isNewMessage && finishesReply;
      const nextUnread =
        (didReceiveProactiveUtterance || didFinishReply) &&
        (isHidden || isOtherConversation)
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
        ...(settlement?.source
          ? finalizedReplyCaches(s, settlement.source, msg.id)
          : {}),
        ...(settlement?.dropsSettled
          ? { settledStreaming: withoutKey(s.settledStreaming, runtimeJid) }
          : {}),
        activeRuns: replyLanded
          ? markRunAnswered(s.activeRuns, runtimeJid, msg.turn_id)
          : (settlement?.activeRuns ?? s.activeRuns),
        ...(replyLanded
          ? { traceAwaited: withAwaitedTrace(s, runtimeJid, msg) }
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
    if (didFinishReply || didReceiveProactiveUtterance) {
      const groupName = get().groups[chatJid]?.name || '对话';
      const preview = msg.content ? msg.content.slice(0, 80) : '';
      notifyIfHidden(
        groupName,
        preview || (didFinishReply ? '收到新回复' : '收到新消息'),
      );
    }
    if (didFinishReply && typeof document !== 'undefined' && !document.hidden) {
      showNotificationPromptToast();
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
    worktree?,
  ) => {
    // '__removed__' signal: agent has been cleaned up, remove from list
    if (resultSummary === '__removed__') {
      clearDbTaskAgentCleanupTimer(agentId);
      set((s) => withoutSession(s, chatJid, agentId));
      return;
    }
    set((s) => {
      const existing = s.agents[chatJid] || [];
      const idx = existing.findIndex((a) => a.id === agentId);
      const previous = idx >= 0 ? existing[idx] : undefined;
      const resolvedKind = kind || previous?.kind;
      // Sessions and spawned agents are listed; SDK tasks show in the stream.
      if (!resolvedKind || resolvedKind === 'task') return s;
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
        ...(worktree ? { worktree } : {}),
      };
      const updated =
        idx >= 0
          ? existing.map((a, i) => (i === idx ? agentInfo : a))
          : [...existing, agentInfo];

      // Spawn agents are fire-and-forget: auto-remove from frontend state after completion
      if (
        resolvedKind === 'spawn' &&
        (status === 'completed' || status === 'error')
      ) {
        scheduleDbTaskAgentCleanup(set, agentId, chatJid);
      }

      // Clean up agent streaming if not actively running
      const exactAgentRunActive =
        !!s.activeRuns[sessionJidOf(chatJid, agentId)];
      return {
        agents: { ...s.agents, [chatJid]: updated },
        agentStreaming:
          status !== 'running' && !exactAgentRunActive
            ? withoutKey(s.agentStreaming, agentId)
            : s.agentStreaming,
      };
    });
  },

  // 加载工作区的会话列表
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
              (a.kind === 'spawn' && a.status !== 'completed'),
          );
          const open = s.activeAgentTab[jid];
          return {
            agents: { ...s.agents, [jid]: visibleAgents },
            activeAgentTab:
              open && !visibleAgents.some((a) => a.id === open)
                ? withoutKey(s.activeAgentTab, jid)
                : s.activeAgentTab,
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

  deleteAgentAction: async (jid, agentId, options) => {
    try {
      await api.delete(sessionDeletePath(jid, agentId, options));
    } catch (err) {
      const bindings = sessionDeleteImpactFromError(err);
      if (bindings) return { bindings };
      const worktreesDirty = dirtyWorktreesFromError(err);
      if (worktreesDirty) return { worktreesDirty };
      set({ error: extractErrorMessage(err) || '删除会话失败' });
      return false;
    }
    void deleteAgentMessageSnapshot(jid, agentId);
    set((s) => withoutSession(s, jid, agentId));
    // Chats moved to another session show on its row.
    if (options?.rebindTo) void get().loadAgents(jid, { force: true });
    return true;
  },

  pinSession: async (jid, agentId, pinned) => {
    try {
      const data = await api.patch<{
        success: boolean;
        pinned_at?: string | null;
      }>(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(agentId)}`,
        { pinned },
      );
      const pinnedAt = pinned
        ? data.pinned_at || new Date().toISOString()
        : null;
      set((s) => ({
        agents: {
          ...s.agents,
          [jid]: (s.agents[jid] || []).map((agent) =>
            agent.id === agentId ? { ...agent, pinned_at: pinnedAt } : agent,
          ),
        },
      }));
      return true;
    } catch (err) {
      const message = extractErrorMessage(err) || '操作失败';
      set({ error: message });
      showToast(pinned ? '置顶失败' : '取消置顶失败', message);
      return false;
    }
  },

  // 打开的会话（在内存中 mirror，URL 是真正的真相源）。未读按 Workspace
  // 聚合：在当前 Workspace 内打开任一会话，都视为已经查看该 Workspace。
  // 后台 Workspace 的 URL/tab 同步不得清除其未读。
  setActiveAgentTab: (jid, agentId) => {
    if (!agentId) {
      set((s) =>
        jid in s.activeAgentTab
          ? { activeAgentTab: withoutKey(s.activeAgentTab, jid) }
          : s,
      );
      return;
    }
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

  createConversation: async (jid, name, description?, options?) => {
    try {
      const data = await api.post<{ session?: AgentInfo; agent?: AgentInfo }>(
        `/api/groups/${encodeURIComponent(jid)}/sessions`,
        { name, description, ...(options?.worktree ? { worktree: true } : {}) },
      );
      const created = data.session ?? data.agent;
      if (!created) throw new Error('创建会话失败');
      set((s) => {
        const existing = s.agents[jid] || [];
        // WS agent_status broadcast may have already added it, without the
        // worktree only the creation response carries.
        if (existing.some((a) => a.id === created.id)) {
          return {
            agents: {
              ...s.agents,
              [jid]: existing.map((a) =>
                a.id === created.id
                  ? { ...a, worktree: created.worktree ?? null }
                  : a,
              ),
            },
          };
        }
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
      forgetSendsSeenIn(sessionJidOf(jid, agentId), data.messages);
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
    const runtimeJid = sessionJidOf(jid, agentId);
    try {
      // Sends use the acknowledged HTTP path. WebSocket remains the push
      // channel for the stored message and stream events; a successful return
      // means the server really persisted and classified this message as
      // started/queued/steered.
      const data = await api.post<MessageCreateResponse>(
        '/api/messages',
        {
          chatJid: jid,
          agentId,
          content,
          attachments: normalizedAttachments,
          followUpBehavior,
          clientMessageId: clientMessageIdFor(
            runtimeJid,
            content,
            attachments,
            followUpBehavior,
          ),
        },
        attachmentTimeoutMs(normalizedAttachments),
      );
      unconfirmedSends.delete(runtimeJid);
      // /clear and /fresh were handled by the server: no message was stored
      // and no reply is coming, so the session must not wait for one.
      if (isClearedResponse(data)) return true;
      if (!data.success) throw new Error('服务器返回失败');
      // A resend answered from the first attempt: that run may be long over.
      if (data.deduplicated) {
        showAlreadySent();
        // Its announcement was missed: read the session again. Its run and
        // waiting state are not this old answer's to set.
        if (
          !get().agentMessages[agentId]?.some((m) => m.id === data.messageId)
        ) {
          void get().refreshAgentMessages(jid, agentId);
        }
        return true;
      }
      if (data.disposition === 'started' && data.runId) {
        get().handleRunStarted(runtimeJid, data.runId);
      }
      // Show the message at once, from the server's answer, unless its
      // announcement came first (and may be newer).
      const user = useAuthStore.getState().user;
      const sent: Message = {
        id: data.messageId,
        chat_jid: runtimeJid,
        sender: user?.id || 'web-user',
        sender_name: user?.display_name || user?.username || 'Web',
        content,
        // The server's timestamp keeps the polling cursor monotonic.
        timestamp: data.timestamp,
        ingest_sequence: data.ingestSequence,
        is_from_me: false,
        attachments: normalizedAttachments
          ? JSON.stringify(normalizedAttachments)
          : undefined,
        delivery_mode:
          data.disposition === 'queued'
            ? 'queue'
            : data.disposition === 'steered'
              ? 'steer'
              : null,
        delivery_status: data.disposition === 'started' ? null : 'queued',
        delivery_run_id: data.runId ?? null,
        delivery_updated_at:
          data.disposition === 'started' ? null : data.timestamp,
      };
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        return {
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          ...(existing.some((m) => m.id === sent.id)
            ? {}
            : {
                agentMessages: {
                  ...s.agentMessages,
                  [agentId]: mergeMessagesChronologically(existing, [sent]),
                },
              }),
        };
      });
      return true;
    } catch (err) {
      settleFailedSend(runtimeJid, err);
      if (storedDespiteError(err)) {
        showStoredButFailed();
        return true;
      }
      // 弱网/断网/后端 500 等场景：记录错误并给用户可见的 toast，返回 false
      // 让调用方（MessageInput）保留输入不清空。
      const message = extractErrorMessage(err);
      set({ error: message });
      showToast(
        '发送失败',
        sendMayHaveLanded(err)
          ? `${UNCONFIRMED_SEND_HINT}，输入已保留`
          : `消息未发送，输入已保留${message ? `：${message}` : '，请检查网络后重试'}`,
      );
      return false;
    }
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
      forgetSendsSeenIn(sessionJidOf(jid, agentId), data.messages);

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
          const runtimeJid = sessionJidOf(jid, agentId);
          const exactRunActive = !!s.activeRuns[runtimeJid];
          // The same rule as a live final message (`settlementOf`), and as a
          // proactive reply.
          const settlement = lastAiMsg
            ? settlementOf(
                s.activeRuns,
                runtimeJid,
                agentState,
                s.settledStreaming[runtimeJid],
                lastAiMsg,
              )
            : null;
          const finalizes = !!settlement?.replacesLive;
          const utterance = [...data.messages]
            .reverse()
            .find(
              (m) =>
                m.is_from_me &&
                m.sender !== '__system__' &&
                m.source_kind === 'sdk_send_message',
            );
          const replyLanded =
            !!utterance &&
            proactiveReplyLanded(s, runtimeJid, agentState, utterance);

          return {
            ...(lastAiMsg && settlement?.source
              ? finalizedReplyCaches(s, settlement.source, lastAiMsg.id)
              : {}),
            ...(settlement?.dropsSettled
              ? { settledStreaming: withoutKey(s.settledStreaming, runtimeJid) }
              : {}),
            activeRuns: replyLanded
              ? markRunAnswered(s.activeRuns, runtimeJid, utterance?.turn_id)
              : (settlement?.activeRuns ?? s.activeRuns),
            ...(replyLanded && utterance
              ? { traceAwaited: withAwaitedTrace(s, runtimeJid, utterance) }
              : {}),
            agentMessages: { ...s.agentMessages, [agentId]: merged },
            pendingMessageUsage: mergedUsage.pending,
            agentWaiting:
              finalizes && !exactRunActive
                ? { ...s.agentWaiting, [agentId]: false }
                : s.agentWaiting,
            agentStreaming:
              finalizes || replyLanded
                ? withoutKey(s.agentStreaming, agentId)
                : s.agentStreaming,
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
      const activeAgentIds = new Set(
        data.groups
          .map((g) => sessionIdOf(g.jid))
          .filter((agentId): agentId is string => !!agentId),
      );

      // 关键：对 active 会话先刷新消息，同步本地与后端真相，再做推断。
      // 否则 ws 断开期间漏接 agent 完成的 new_message 时，本地最新仍是用户消息，
      // UI 会一直卡在"正在思考..."。刷新拉到 agent 回复时会主动清除
      // waiting/streaming。仅刷新本地已加载过消息的会话。
      const loaded = get().agentMessages;
      await Promise.all(
        data.groups.flatMap((g) => {
          const agentId = sessionIdOf(g.jid);
          return g.active && agentId && loaded[agentId]
            ? [get().refreshAgentMessages(workspaceJidOf(g.jid), agentId)]
            : [];
        }),
      );

      set((s) => {
        const nextAgentWaiting = { ...s.agentWaiting };
        const nextAgentStreaming = { ...s.agentStreaming };

        // 清除后端不可见的会话的 waiting/streaming（进程已死）
        // （主服务重启后 queue 为空，所有会话都不在集合中）。
        for (const agentId of Object.keys(nextAgentWaiting)) {
          if (!activeAgentIds.has(agentId)) {
            delete nextAgentWaiting[agentId];
            delete nextAgentStreaming[agentId];
          }
        }

        for (const g of data.groups) {
          const agentId = sessionIdOf(g.jid);
          if (!agentId) continue;
          // A conversation runner intentionally stays alive between turns.
          // Only a terminal-capable exact attempt restores waiting.
          // pendingMessages may merely be a retry/backoff reservation and
          // has no run_finished identity. Never infer waiting from message
          // shape: it can override an authoritative empty WS snapshot and
          // create a spinner that no run_finished can close.
          if (hasExactQueryAttempt(g)) {
            nextAgentWaiting[agentId] = true;
          } else {
            delete nextAgentWaiting[agentId];
            delete nextAgentStreaming[agentId];
          }
        }
        return {
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
    // Every conversation is a session: a snapshot without one shows nothing.
    if (!agentId) return;
    const runtimeJid = sessionJidOf(chatJid, agentId);
    // The speech tool of a proactive turn is not work to watch: the calls the
    // snapshot shows are remembered so their later events are left out too.
    const speech = isProactiveRuntime(get(), runtimeJid)
      ? speechCallsOfSnapshot(snapshot)
      : null;
    if (speech) {
      speechToolCalls.remember(runtimeJid, runId, speech);
      // A memory write still running returns its receipt after the snapshot.
      memoryWriteCalls.remember(
        runtimeJid,
        runId,
        (snapshot.activeTools ?? [])
          .filter((tool) => MEMORY_WRITE_TOOLS.has(tool.toolName))
          .map((tool) => tool.toolUseId),
      );
    }
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
      // The progress the Agent sent is no part of what the pieces rebuild:
      // the snapshot names it, in order, and the steps take what they lack.
      if (snapshot.progress?.length) {
        restored.steps = withSnapshotProgress(
          restored.steps ?? [],
          snapshot.progress,
        );
      }
      return level ? scrubForVisibility(restored, level) : restored;
    };

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
  },

  handleRunStarted: (chatJid, runId) => {
    // Older servers may omit runId. Keep their stream events functional, but
    // only exact IDs enter the fenced lifecycle map.
    if (!runId) return;
    const agentId = sessionIdOf(chatJid);
    // Every conversation is a session: a run without one shows nothing.
    if (!agentId) return;
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
      if (replacingAttempt && !isProactiveRuntime(s, chatJid)) {
        settled.state = settleStreamingState(
          s.agentStreaming[agentId],
          s.activeRuns[chatJid]?.runId,
        );
      }
      const settledStreaming = settled.state
        ? { ...s.settledStreaming, [chatJid]: settled.state }
        : s.settledStreaming;
      return {
        activeRuns,
        stopRequests,
        settledStreaming,
        agentWaiting: { ...s.agentWaiting, [agentId]: true },
        agentStreaming: replacingAttempt
          ? withoutKey(s.agentStreaming, agentId)
          : s.agentStreaming,
      };
    });
    if (settled.state) scheduleSettleFallback(chatJid, settled.state, set, get);
  },

  handleRunFinished: (chatJid, runId) => {
    const agentId = sessionIdOf(chatJid);
    if (!agentId || get().activeRuns[chatJid]?.runId !== runId) return;
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
        : settleStreamingState(s.agentStreaming[agentId], runId);
      const settledStreaming = settled.state
        ? { ...s.settledStreaming, [chatJid]: settled.state }
        : s.settledStreaming;
      return {
        activeRuns: finished.runs,
        stopRequests,
        settledStreaming,
        agentWaiting: { ...s.agentWaiting, [agentId]: false },
        agentStreaming: withoutKey(s.agentStreaming, agentId),
      };
    });
    if (settled.state) scheduleSettleFallback(chatJid, settled.state, set, get);
    // The trace of a proactive reply is stored just after its run ends; a turn
    // that kept nothing has none, and its reply lets the held row go.
    const awaited = get().traceAwaited[chatJid];
    if (awaited) {
      setTimeout(
        () => set((s) => releaseAwaitedTrace(s, chatJid, awaited)),
        SETTLE_FALLBACK_MS,
      );
    }
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
      const nextAgentWaiting: Record<string, boolean> = {};
      const nextAgentStreaming = { ...s.agentStreaming };

      for (const agentId of Object.keys(s.agentWaiting)) {
        const previousJid = Object.keys(previous).find(
          (jid) => sessionIdOf(jid) === agentId,
        );
        const authoritativeJid = Object.keys(authoritative).find(
          (jid) => sessionIdOf(jid) === agentId,
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
        const agentId = sessionIdOf(run.chatJid);
        if (agentId) nextAgentWaiting[agentId] = true;
      }
      // Queued chats have no run identity, so they never enter activeRuns and
      // never expect a run_finished. They still need the wait state, otherwise
      // reloading while a message sits behind a busy runner shows an idle
      // composer. The next authoritative snapshot recomputes this from scratch.
      for (const agentId of waitKeysForQueuedChats(queuedChatJids)) {
        nextAgentWaiting[agentId] = true;
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
        agentWaiting: nextAgentWaiting,
        agentStreaming: nextAgentStreaming,
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
  for (const jid of changed) {
    if (processView(state.groups[jid]) === 'proactive:hidden') {
      void resyncTraceFlags(jid);
    }
  }
});

/** The newest replies whose `has_trace` is read again after a view change. */
const TRACE_FLAG_RESYNC_LIMIT = 200;

/**
 * The `has_trace` of the replies this tab holds of the sessions of `jid`,
 * read again for the view now in force. At `hidden` the server flags only the
 * turns whose progress it keeps, which this tab cannot tell from what it
 * holds; the flags read at another level were let go meanwhile.
 */
async function resyncTraceFlags(jid: string): Promise<void> {
  const view = processViewOfRuntime(useChatStore.getState(), jid);
  const flaggedOf = async (query: string): Promise<Set<string> | null> => {
    try {
      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${query}`,
      );
      if (processViewOfRuntime(useChatStore.getState(), jid) !== view) {
        return null;
      }
      return new Set(data.messages.filter((m) => m.has_trace).map((m) => m.id));
    } catch {
      return null;
    }
  };
  const flag = (list: Message[], flagged: Set<string>): Message[] =>
    list.some((m) => !m.has_trace && flagged.has(m.id))
      ? list.map((m) =>
          !m.has_trace && flagged.has(m.id) ? { ...m, has_trace: true } : m,
        )
      : list;
  const limit = `limit=${TRACE_FLAG_RESYNC_LIMIT}`;
  const sessions = Object.entries(useChatStore.getState().agentMessages)
    .filter(([, list]) => list.some((m) => isSessionOf(m.chat_jid, jid)))
    .map(([agentId]) => agentId);
  for (const agentId of sessions) {
    const flagged = await flaggedOf(
      `agentId=${encodeURIComponent(agentId)}&${limit}`,
    );
    if (!flagged?.size) continue;
    useChatStore.setState((s) =>
      s.agentMessages[agentId]
        ? {
            agentMessages: {
              ...s.agentMessages,
              [agentId]: flag(s.agentMessages[agentId], flagged),
            },
          }
        : s,
    );
  }
}
