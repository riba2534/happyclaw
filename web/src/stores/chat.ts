import { create } from 'zustand';
import { api } from '../api/client';
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
  InteractionMode,
  WorkspaceDeleteImpact,
} from '../types';
import { applyFollowUpTransition } from '../lib/message-timeline';
import {
  normalizeGroupInteractionMode,
  normalizeInteractionMode,
} from '../lib/interaction-mode';
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

export type { GroupInfo, AgentInfo };

export interface Message {
  id: string;
  chat_jid: string;
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
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?:
    | 'sdk_final'
    | 'sdk_send_message'
    | 'interrupt_partial'
    | 'legacy'
    | null;
  finalization_reason?: 'completed' | 'interrupted' | 'error' | null;
  delivery_mode?: FollowUpMode | null;
  delivery_status?: 'queued' | 'promoting' | 'released' | 'cancelled' | null;
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
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    parentToolUseId?: string | null;
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

export interface ActiveRunSnapshotData {
  chatJid: string;
  runId: string;
  startedAt: string;
  phase: 'preparing' | 'running';
}

export interface StreamingState {
  turnId?: string;
  sessionId?: string;
  partialText: string;
  thinkingText: string;
  isThinking: boolean;
  /** Wall-clock ms of the first thinking_delta in the current thinking burst. */
  thinkingStartedAt?: number;
  /** Captured at the transition isThinking: true → false. Used to render "已思考 Xs". */
  thinkingDurationMs?: number;
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

function mergeMessagesChronologically(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  // Incoming messages are authoritative, but preserve reference if content unchanged
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (
      !old ||
      old.content !== m.content ||
      old.timestamp !== m.timestamp ||
      old.token_usage !== m.token_usage ||
      JSON.stringify(old.workflow_runs ?? []) !==
        JSON.stringify(m.workflow_runs ?? []) ||
      old.turn_id !== m.turn_id ||
      old.session_id !== m.session_id ||
      old.sdk_message_uuid !== m.sdk_message_uuid ||
      old.source_kind !== m.source_kind ||
      old.finalization_reason !== m.finalization_reason ||
      old.delivery_mode !== m.delivery_mode ||
      old.delivery_status !== m.delivery_status ||
      old.delivery_run_id !== m.delivery_run_id ||
      old.delivery_updated_at !== m.delivery_updated_at
    ) {
      byId.set(m.id, m);
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

const MAX_THINKING_CACHE_SIZE = 500;

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

/** Record the moment thinking starts; resets on transition non-thinking → thinking. */
function markThinkingStarted(prev: StreamingState, next: StreamingState): void {
  if (!prev.isThinking) {
    next.thinkingStartedAt = Date.now();
    next.thinkingDurationMs = undefined;
  } else if (prev.thinkingStartedAt == null) {
    next.thinkingStartedAt = Date.now();
  }
}

/** Record the elapsed thinking duration on the transition isThinking:true → false. */
function markThinkingEnded(prev: StreamingState, next: StreamingState): void {
  if (
    prev.isThinking &&
    prev.thinkingStartedAt != null &&
    next.thinkingDurationMs == null
  ) {
    next.thinkingDurationMs = Date.now() - prev.thinkingStartedAt;
  }
}

interface ChatState {
  groups: Record<string, GroupInfo>;
  currentGroup: string | null;
  messages: Record<string, Message[]>;
  waiting: Record<string, boolean>;
  /** Exact GroupQueue query attempt per main/agent runtime JID. */
  activeRuns: ClientActiveRuns;
  followUps: Record<string, QueuedFollowUp[]>;
  hasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  streaming: Record<string, StreamingState>;
  thinkingCache: Record<string, string>;
  /** Per-message-id duration in ms; rendered as "已思考 Xs" inside ReasoningBlock. */
  thinkingDurationCache: Record<string, number>;
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
  stopGroup: (jid: string) => Promise<boolean>;
  interruptQuery: (jid: string) => Promise<boolean>;
  resetSession: (jid: string, agentId?: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  deleteMessage: (jid: string, messageId: string) => Promise<boolean>;
  createFlow: (
    name: string,
    options?: {
      execution_mode?: 'container' | 'host';
      custom_cwd?: string;
      init_source_path?: string;
      init_git_url?: string;
      agent_profile_id?: string;
      interaction_mode?: InteractionMode;
    },
  ) => Promise<{ jid: string; folder: string } | null>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  updateInteractionMode: (
    jid: string,
    interactionMode: InteractionMode,
  ) => Promise<boolean>;
  togglePin: (jid: string) => Promise<void>;
  inspectDeleteFlow: (jid: string) => Promise<WorkspaceDeleteImpact>;
  deleteFlow: (
    jid: string,
    options?: { unbindChannels?: boolean },
  ) => Promise<void>;
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
  reorderConversations: (jid: string, orderedIds: string[]) => void;
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
  bindImGroup: (
    jid: string,
    agentId: string,
    imJid: string,
    force?: boolean,
  ) => Promise<boolean>;
  unbindImGroup: (
    jid: string,
    agentId: string,
    imJid: string,
  ) => Promise<boolean>;
  bindMainImGroup: (
    jid: string,
    imJid: string,
    force?: boolean,
    activationMode?: string,
    ownerImId?: string,
    audienceMode?: 'everyone' | 'owner_only',
  ) => Promise<boolean>;
  unbindMainImGroup: (jid: string, imJid: string) => Promise<boolean>;
  bindWorkspaceImGroup: (
    jid: string,
    imJid: string,
    force?: boolean,
    activationMode?: string,
    ownerImId?: string,
    audienceMode?: 'everyone' | 'owner_only',
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
  // Preserve any in-flight thinking duration so the interrupted card still shows "已思考 Xs".
  const thinkingDurationMs =
    state.thinkingDurationMs ??
    (state.isThinking && state.thinkingStartedAt != null
      ? Date.now() - state.thinkingStartedAt
      : undefined);
  return {
    ...state,
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    interrupted: true,
    thinkingDurationMs,
  };
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

const MAX_STREAMING_TEXT = 16000;
const MAX_THINKING_TEXT = 8000;
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

// ─── Streaming state sessionStorage persistence ───────────────────────
// Survives page refresh so StreamingDisplay can restore accumulated content.
const STREAMING_STORAGE_KEY = 'hc_streaming';
const streamingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isInternalLifecycleStatus(statusText?: string | null): boolean {
  return (
    statusText === 'requesting' ||
    statusText === 'compacting' ||
    statusText === 'idle' ||
    statusText === 'interrupted' ||
    statusText === '__bg_keepalive'
  );
}

function isUserVisibleTimelineEvent(event: StreamingTimelineEvent): boolean {
  return event.kind !== 'context' && !event.text.startsWith('Agent Context:');
}

function isUserVisibleTraceEvent(event: StreamingTraceEvent): boolean {
  return event.kind !== 'context' && event.title !== 'Agent Context';
}

/** Debounced save of streaming state to sessionStorage (trailing-edge, 500ms per jid). */
function saveStreamingToSession(
  chatJid: string,
  state: StreamingState | undefined,
): void {
  // Cancel previous timer to always save the latest state (trailing-edge debounce)
  const existing = streamingSaveTimers.get(chatJid);
  if (existing) clearTimeout(existing);
  streamingSaveTimers.set(
    chatJid,
    setTimeout(() => {
      streamingSaveTimers.delete(chatJid);
      try {
        const stored = JSON.parse(
          sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}',
        );
        if (
          state &&
          (state.partialText ||
            state.thinkingText ||
            state.activeTools.length > 0 ||
            state.recentEvents.length > 0 ||
            state.traceEvents.length > 0 ||
            Object.keys(state.taskStates).length > 0)
        ) {
          stored[chatJid] = {
            partialText: state.partialText.slice(-4000), // cap size
            thinkingText: state.thinkingText.slice(-MAX_THINKING_TEXT),
            isThinking: state.isThinking,
            activeTools: state.activeTools,
            recentEvents: state.recentEvents
              .filter(isUserVisibleTimelineEvent)
              .slice(-10),
            traceEvents: state.traceEvents
              .filter(isUserVisibleTraceEvent)
              .slice(-50),
            taskStates: state.taskStates,
            todos: state.todos,
            systemStatus: state.systemStatus,
            turnId: state.turnId,
            ts: Date.now(),
          };
        } else {
          delete stored[chatJid];
        }
        sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
      } catch {
        /* quota exceeded or SSR */
      }
    }, 500),
  );
}

/** Remove streaming state from sessionStorage. */
function clearStreamingFromSession(chatJid: string): void {
  const timer = streamingSaveTimers.get(chatJid);
  if (timer) {
    clearTimeout(timer);
    streamingSaveTimers.delete(chatJid);
  }
  try {
    const stored = JSON.parse(
      sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}',
    );
    delete stored[chatJid];
    sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* SSR */
  }
}

/**
 * rAF batching for text_delta / thinking_delta events.
 * Instead of calling set() on every single delta (~50ms intervals), we accumulate
 * deltas and flush them once per animation frame (~16ms), merging multiple deltas
 * into a single state update.
 */
interface PendingDelta {
  texts: string[];
  thinkings: string[];
  raf: number;
  runtimeJid: string;
  runId?: string;
}
const pendingDeltas = new Map<string, PendingDelta>();

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

function flushPendingDelta(
  key: string,
  chatJid: string,
  agentId: string | undefined,
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
): void {
  const entry = pendingDeltas.get(key);
  if (!entry) return;
  pendingDeltas.delete(key);

  const mergedText = entry.texts.join('');
  const mergedThinking = entry.thinkings.join('');

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
      if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false)
        return s;
      const prev = s.agentStreaming[agentId] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      if (mergedText) {
        const combined = prev.partialText + mergedText;
        next.partialText =
          combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
        next.isThinking = false;
        markThinkingEnded(prev, next);
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText =
          combined.length > MAX_THINKING_TEXT
            ? combined.slice(-MAX_THINKING_TEXT)
            : combined;
        next.isThinking = true;
        markThinkingStarted(prev, next);
      }
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
      if (!s.streaming[chatJid] && s.waiting[chatJid] === false) return s;
      if (s.streaming[chatJid]?.interrupted) return s;
      const prev = s.streaming[chatJid] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      if (mergedText) {
        const combined = prev.partialText + mergedText;
        next.partialText =
          combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
        next.isThinking = false;
        markThinkingEnded(prev, next);
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText =
          combined.length > MAX_THINKING_TEXT
            ? combined.slice(-MAX_THINKING_TEXT)
            : combined;
        next.isThinking = true;
        markThinkingStarted(prev, next);
      }
      saveStreamingToSession(chatJid, next);
      return {
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: { ...s.streaming, [chatJid]: next },
      };
    });
  }
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

function pushTrace(
  events: StreamingTraceEvent[],
  event: StreamEvent,
): StreamingTraceEvent[] {
  if (
    event.eventType === 'text_delta' ||
    event.eventType === 'thinking_delta' ||
    event.eventType === 'usage' ||
    event.eventType === 'init' ||
    event.eventType === 'context_audit' ||
    (event.eventType === 'status' &&
      isInternalLifecycleStatus(event.statusText))
  ) {
    return events;
  }
  const item: StreamingTraceEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind: traceKind(event),
    scope: event.agentScope,
    title: traceTitle(event),
    summary:
      event.summary ||
      event.taskSummary ||
      event.statusText ||
      event.toolInputSummary,
    detail: event.detail,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    parentToolUseId: event.parentToolUseId,
    displayLevel: event.displayLevel,
  };
  return [...events, item].slice(-MAX_TRACE_EVENTS);
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
    else if (patch?.status === 'failed' || patch?.status === 'killed')
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

/**
 * Apply a single StreamEvent to a StreamingState object.
 * Shared by main conversation and SDK subagent streaming.
 */
function applyStreamEvent(
  event: StreamEvent,
  prev: StreamingState,
  next: StreamingState,
  maxText: number,
): void {
  if (event.turnId) next.turnId = event.turnId;
  if (event.sessionId) next.sessionId = event.sessionId;
  next.traceEvents = pushTrace(prev.traceEvents || [], event);
  switch (event.eventType) {
    case 'text_delta': {
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
        break;
      }
      const combined = prev.partialText + (event.text || '');
      next.partialText =
        combined.length > maxText ? combined.slice(-maxText) : combined;
      next.isThinking = false;
      markThinkingEnded(prev, next);
      break;
    }
    case 'thinking_delta': {
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
        break;
      }
      const combined = prev.thinkingText + (event.text || '');
      next.thinkingText =
        combined.length > MAX_THINKING_TEXT
          ? combined.slice(-MAX_THINKING_TEXT)
          : combined;
      next.isThinking = true;
      markThinkingStarted(prev, next);
      break;
    }
    case 'tool_use_start': {
      next.isThinking = false;
      markThinkingEnded(prev, next);
      const toolUseId = event.toolUseId || '';
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
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
      }
      break;
    }
    case 'task_start': {
      updateTaskRuntime(prev, next, event);
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
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'task',
        `Task 更新: ${event.summary || event.taskPatch?.status || ''}`,
      );
      break;
    }
    case 'task_notification': {
      updateTaskRuntime(prev, next, event);
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
  currentGroup: null,
  messages: {},
  waiting: {},
  activeRuns: {},
  followUps: {},
  hasMore: {},
  loading: false,
  error: null,
  streaming: {},
  thinkingCache: {},
  thinkingDurationCache: {},
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
    set({ loading: true });
    try {
      const data = await api.get<{ groups: Record<string, GroupInfo> }>(
        '/api/groups',
      );
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
          currentGroup: nextCurrent,
          loading: false,
          error: null,
        };
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    const before =
      loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

    try {
      const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${new URLSearchParams(
          before ? { before: String(before), limit: '50' } : { limit: '50' },
        )}`,
      );
      // Messages come in DESC order from API, reverse to chronological for display
      const sorted = [...data.messages].reverse();
      set((s) => {
        const merged = mergeMessagesChronologically(
          s.messages[jid] || [],
          sorted,
        );
        const nextWaiting = { ...s.waiting };
        if (s.activeRuns[jid]) {
          nextWaiting[jid] = true;
        } else {
          delete nextWaiting[jid];
        }

        return {
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
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  refreshMessages: async (jid: string) => {
    // Skip polling while clearHistory is in-flight to prevent race re-injection
    if (get().clearing[jid]) return;

    const state = get();
    const existing = state.messages[jid] || [];
    const lastTs =
      existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

    try {
      // Fetch messages newer than the last one we have
      const params = new URLSearchParams({ limit: '50' });
      if (lastTs) params.set('after', lastTs);

      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );

      // Re-check clearing lock after async fetch — clearHistory may have started mid-request
      if (get().clearing[jid]) return;

      if (data.messages.length > 0) {
        // Messages from getMessagesAfter are already in ASC order
        set((s) => {
          const merged = mergeMessagesChronologically(
            s.messages[jid] || [],
            data.messages,
          );
          // Check if agent has truly finalized (explicit sdk_send_message should not clear streaming)
          // interrupt_partial 到达时若流式卡片已冻结，不视为"agent 已回复"，
          // 避免清除冻结的富内容。消息仍添加到列表，10s 兜底计时器做最终清理。
          const isFrozen = !!s.streaming[jid]?.interrupted;
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

          // Transfer pending thinking to thinkingCache
          let nextThinkingCache = s.thinkingCache;
          let nextThinkingDurationCache = s.thinkingDurationCache;
          let nextPendingThinking = s.pendingThinking;
          let nextPendingThinkingDuration = s.pendingThinkingDuration;
          if (agentReplied && s.pendingThinking[jid]) {
            const lastAiMsg = [...data.messages]
              .reverse()
              .find(
                (m) =>
                  m.is_from_me &&
                  m.sender !== '__system__' &&
                  m.source_kind !== 'sdk_send_message',
              );
            if (lastAiMsg) {
              nextThinkingCache = capThinkingCache({
                ...s.thinkingCache,
                [lastAiMsg.id]: s.pendingThinking[jid],
              });
              const pendingDur = s.pendingThinkingDuration[jid];
              if (pendingDur != null) {
                nextThinkingDurationCache = capThinkingCache({
                  ...s.thinkingDurationCache,
                  [lastAiMsg.id]: pendingDur,
                });
              }
              const { [jid]: _, ...restPending } = s.pendingThinking;
              nextPendingThinking = restPending;
              const { [jid]: __, ...restPendingDur } =
                s.pendingThinkingDuration;
              nextPendingThinkingDuration = restPendingDur;
            }
          }

          return {
            messages: { ...s.messages, [jid]: merged },
            waiting:
              agentReplied || hasSystemError
                ? { ...s.waiting, [jid]: false }
                : s.waiting,
            streaming:
              agentReplied || hasSystemError
                ? (() => {
                    const next = { ...s.streaming };
                    delete next[jid];
                    return next;
                  })()
                : s.streaming,
            thinkingCache: nextThinkingCache,
            thinkingDurationCache: nextThinkingDurationCache,
            pendingThinking: nextPendingThinking,
            pendingThinkingDuration: nextPendingThinkingDuration,
            error: null,
          };
        });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
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
            disposition: 'started' | 'queued' | 'steered';
            runId?: string;
          }
        | { success: false };
      const isClearedResponse = (
        d: MessageCreateResponse,
      ): d is ClearedResponse =>
        d.success === true && 'cleared' in d && d.cleared === true;

      const data = await api.post<MessageCreateResponse>('/api/messages', body);
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
      const message = err instanceof Error ? err.message : String(err);
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
      }));
    } catch (err) {
      console.warn('[follow-ups] failed to load queue', err);
    }
  },

  handleFollowUpUpdate: (chatJid, items, transition) => {
    set((s) => {
      const next: Partial<ChatState> = {
        followUps: { ...s.followUps, [chatJid]: items },
      };
      if (!transition) return next;

      const agentMarker = '#agent:';
      const markerIndex = chatJid.indexOf(agentMarker);
      if (markerIndex >= 0) {
        const agentId = chatJid.slice(markerIndex + agentMarker.length);
        const existing = s.agentMessages[agentId] || [];
        const updated = applyFollowUpTransition(existing, transition);
        if (updated !== existing) {
          next.agentMessages = {
            ...s.agentMessages,
            [agentId]: updated,
          };
        }
      } else {
        const existing = s.messages[chatJid] || [];
        const updated = applyFollowUpTransition(existing, transition);
        if (updated !== existing) {
          next.messages = { ...s.messages, [chatJid]: updated };
        }
      }
      return next;
    });
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

  stopGroup: async (jid: string) => {
    try {
      await api.post<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/stop`,
      );
      cancelPendingDeltaForRuntime(jid);
      get().clearStreaming(jid, { preserveThinking: false });
      set((s) => {
        const next = { ...s.waiting };
        delete next[jid];
        const activeRuns = { ...s.activeRuns };
        delete activeRuns[jid];
        return { waiting: next, activeRuns };
      });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  interruptQuery: async (jid: string) => {
    try {
      const data = await api.post<{ success: boolean; interrupted: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/interrupt`,
      );
      if (!data.interrupted) {
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
      set({ error: err instanceof Error ? err.message : String(err) });
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
      set({ error: err instanceof Error ? err.message : String(err) });
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
          pendingThinking: nextPendingThinking,
          clearing: nextClearing,
          thinkingCache: retainThinkingCacheForMessages(
            nextMessages,
            s.thinkingCache,
          ),
          thinkingDurationCache: retainThinkingCacheForMessages(
            nextMessages,
            s.thinkingDurationCache,
          ),
          agents: nextAgents,
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
          error: err instanceof Error ? err.message : String(err),
        };
      });
      return false;
    }
  },

  deleteMessage: async (jid: string, messageId: string) => {
    try {
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/messages/${encodeURIComponent(messageId)}`,
      );
      set((s) => ({
        messages: {
          ...s.messages,
          [jid]: (s.messages[jid] || []).filter((m) => m.id !== messageId),
        },
      }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  createFlow: async (
    name: string,
    options?: {
      execution_mode?: 'container' | 'host';
      custom_cwd?: string;
      init_source_path?: string;
      init_git_url?: string;
      agent_profile_id?: string;
      interaction_mode?: InteractionMode;
    },
  ) => {
    try {
      const body: Record<string, string> = { name };
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

      const needsLongTimeout = !!(
        options?.init_source_path || options?.init_git_url
      );
      const data = await api.post<{
        success: boolean;
        jid: string;
        group: GroupInfo;
      }>('/api/groups', body, needsLongTimeout ? 120_000 : undefined);
      if (!data.success) return null;

      const group = normalizeGroupInteractionMode(data.group);
      set((s) => ({
        groups: { ...s.groups, [data.jid]: group },
        error: null,
      }));

      return { jid: data.jid, folder: group.folder };
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
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
      set({ error: err instanceof Error ? err.message : String(err) });
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
      set((state) => ({
        groups: patchGroups(state.groups),
        error: null,
      }));
      useGroupsStore.setState((state) => ({
        groups: patchGroups(state.groups),
      }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
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
      set({ error: err instanceof Error ? err.message : String(err) });
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
          messages: nextMessages,
          waiting: nextWaiting,
          hasMore: nextHasMore,
          streaming: nextStreaming,
          pendingThinking: nextPendingThinking,
          thinkingCache: retainThinkingCacheForMessages(
            nextMessages,
            s.thinkingCache,
          ),
          thinkingDurationCache: retainThinkingCacheForMessages(
            nextMessages,
            s.thinkingDurationCache,
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
      const message =
        apiErr.message || (err instanceof Error ? err.message : String(err));
      set({ error: message });
      throw err;
    }
  },

  // 处理流式事件
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

    // ⓪ text_delta / thinking_delta — rAF batch for both agent and main conversation
    if (
      (event.eventType === 'text_delta' ||
        event.eventType === 'thinking_delta') &&
      (agentId || !event.parentToolUseId)
    ) {
      const key = agentId ? `agent:${agentId}` : `main:${chatJid}`;
      let entry = pendingDeltas.get(key);
      if (entry && (entry.runtimeJid !== runtimeJid || entry.runId !== runId)) {
        cancelPendingDelta(key);
        entry = undefined;
      }
      if (entry) {
        // Already have a pending rAF — just accumulate
        if (event.eventType === 'text_delta')
          entry.texts.push(event.text || '');
        else entry.thinkings.push(event.text || '');
        return;
      }
      entry = {
        texts: [],
        thinkings: [],
        raf: 0,
        runtimeJid,
        runId,
      };
      if (event.eventType === 'text_delta') entry.texts.push(event.text || '');
      else entry.thinkings.push(event.text || '');
      entry.raf = requestAnimationFrame(() => {
        flushPendingDelta(key, chatJid, agentId, set);
      });
      pendingDeltas.set(key, entry);
      return;
    }

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

      // Agent usage is emitted after the sdk_final message. At that point the
      // final-message handler has already cleared agentStreaming and marked the
      // Agent idle, so the generic late-event guard below would otherwise drop
      // the usage event. Patch the persisted final bubble directly before that
      // guard so token totals appear immediately without requiring a reload.
      if (event.eventType === 'usage' && event.usage) {
        const usage = event.usage;
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
        let snapshotMessages: Message[] | null = null;
        let snapshotHasMore = false;
        set((s) => {
          const messages = s.agentMessages[agentId] || [];
          let targetIdx = -1;
          if (event.turnId) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (
                messages[i].is_from_me &&
                messages[i].turn_id === event.turnId &&
                messages[i].source_kind !== 'sdk_send_message'
              ) {
                targetIdx = i;
                break;
              }
            }
          } else {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (
                messages[i].is_from_me &&
                messages[i].source_kind !== 'sdk_send_message'
              ) {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx < 0) return s;
          const updated = [...messages];
          updated[targetIdx] = {
            ...updated[targetIdx],
            token_usage: tokenUsageJson,
          };
          snapshotMessages = updated;
          snapshotHasMore = !!s.agentHasMore[agentId];
          return {
            agentMessages: { ...s.agentMessages, [agentId]: updated },
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

      set((s) => {
        // Guard: if streaming was already cleared (agent reply received),
        // ignore late-arriving stream events to prevent "thinking" reappearing.
        if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false) {
          return s;
        }
        const prev = resolveStreamingPrev(s.agentStreaming[agentId], event);
        const next = { ...prev };
        applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
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
        patchStatus === 'killed'
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
        applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
        saveStreamingToSession(chatJid, next);
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

    // ⑤.5 usage 事件 → 实时更新最近一条 AI 消息的 token_usage
    if (event.eventType === 'usage' && event.usage) {
      const usage = event.usage;
      // 构造与 DB 中 token_usage JSON 一致的格式
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
      set((s) => {
        const msgs = s.messages[chatJid];
        if (!msgs || msgs.length === 0) return s;
        // 优先按 turn_id 找对应正式回复，避免把 usage 绑到 send_message 上
        let targetIdx = -1;
        if (event.turnId) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (
              msgs[i].is_from_me &&
              msgs[i].turn_id === event.turnId &&
              msgs[i].source_kind !== 'sdk_send_message'
            ) {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (
              msgs[i].is_from_me &&
              msgs[i].source_kind !== 'sdk_send_message'
            ) {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx < 0) return s;
        const updated = [...msgs];
        updated[targetIdx] = {
          ...updated[targetIdx],
          token_usage: tokenUsageJson,
        };
        return { messages: { ...s.messages, [chatJid]: updated } };
      });
      // 不 return — usage 事件同时落入主对话 streaming（如需 recentEvents 展示）
    }

    // ⑥ 主对话 streaming — 使用 applyStreamEvent 共享函数
    set((s) => {
      // If streaming state was already cleared (final message received),
      // ignore late-arriving stream events to prevent "thinking" from reappearing.
      if (!s.streaming[chatJid] && s.waiting[chatJid] === false) {
        return s;
      }
      // 冻结的中断状态不接收新事件（如 usage），防止 waiting 被改回 true
      if (s.streaming[chatJid]?.interrupted) {
        return s;
      }
      const prev = resolveStreamingPrev(s.streaming[chatJid], event);
      const next = { ...prev };
      applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
      saveStreamingToSession(chatJid, next);
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
      session_id: wsMsg.session_id ?? null,
      sdk_message_uuid: wsMsg.sdk_message_uuid ?? null,
      source_kind: wsMsg.source_kind ?? null,
      finalization_reason: wsMsg.finalization_reason ?? null,
      delivery_mode: wsMsg.delivery_mode ?? null,
      delivery_status: wsMsg.delivery_status ?? null,
      delivery_run_id: wsMsg.delivery_run_id ?? null,
      delivery_updated_at: wsMsg.delivery_updated_at ?? null,
    };
    const isProactiveUtterance =
      msg.is_from_me &&
      msg.sender !== '__system__' &&
      source !== 'scheduled_task' &&
      msg.source_kind === 'sdk_send_message';

    // Route to agentMessages if this is a conversation agent message
    if (agentId) {
      let snapshotMessages: Message[] | null = null;
      let snapshotHasMore = false;
      let didReceiveProactiveUtterance = false;
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        const isNewMessage = !existing.some((item) => item.id === msg.id);
        const updated = mergeMessagesChronologically(existing, [msg]);
        snapshotMessages = updated;
        snapshotHasMore = !!s.agentHasMore[agentId];
        const isAgentReply =
          msg.is_from_me &&
          msg.sender !== '__system__' &&
          msg.source_kind !== 'sdk_send_message';
        const exactRunActive = !!s.activeRuns[`${chatJid}#agent:${agentId}`];

        const nextAgentStreaming = isAgentReply
          ? exactRunActive
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
          agentMessages: { ...s.agentMessages, [agentId]: updated },
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
      const updated = mergeMessagesChronologically(existing, [msg]);
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

        // Agent 回复或系统错误：立即清除流式状态和等待标志，转移 thinking 缓存
        const exactRunActive = !!s.activeRuns[chatJid];
        const streamState = s.streaming[chatJid];
        const thinkingText =
          isAgentReply && !exactRunActive
            ? streamState?.thinkingText || s.pendingThinking[chatJid]
            : undefined;
        const thinkingDuration =
          isAgentReply && !exactRunActive
            ? (streamState?.thinkingDurationMs ??
              s.pendingThinkingDuration[chatJid])
            : undefined;
        const nextStreaming = { ...s.streaming };
        if (exactRunActive) {
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
        if (!exactRunActive) {
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
          messages: { ...s.messages, [chatJid]: updated },
          waiting: {
            ...s.waiting,
            [chatJid]: exactRunActive || holdsRunningWorkflow,
          },
          streaming: nextStreaming,
          pendingThinking: nextPending,
          pendingThinkingDuration: nextPendingDur,
          unreadReplies: nextUnread,
          ...(thinkingText
            ? {
                thinkingCache: capThinkingCache({
                  ...s.thinkingCache,
                  [msg.id]: thinkingText,
                }),
              }
            : {}),
          ...(thinkingDuration != null
            ? {
                thinkingDurationCache: capThinkingCache({
                  ...s.thinkingDurationCache,
                  [msg.id]: thinkingDuration,
                }),
              }
            : {}),
        };
      }

      // A direct human message is also the earliest cross-tab/IM signal that a
      // new logical run is about to start. Do not wait for the first Claude
      // stream event: warm runners can spend noticeable time preparing context
      // and previously left secondary tabs looking idle during that window.
      const startsDirectRun =
        !msg.is_from_me &&
        msg.delivery_status !== 'queued' &&
        msg.delivery_status !== 'promoting' &&
        msg.delivery_status !== 'cancelled';
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
        messages: { ...s.messages, [chatJid]: updated },
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
          agentStreaming: nextAgentStreaming,
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
    set((s) => {
      let nextUnreadReplies = s.unreadReplies;
      if (s.currentGroup === jid && s.unreadReplies[jid]) {
        nextUnreadReplies = { ...s.unreadReplies };
        delete nextUnreadReplies[jid];
      }
      return {
        activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
        unreadReplies: nextUnreadReplies,
      };
    });
  },

  // -- Conversation agent actions --

  reorderConversations: (jid, orderedIds) => {
    set((s) => {
      const current = s.agents[jid] || [];
      const conversations = current.filter((a) => a.kind === 'conversation');
      const others = current.filter((a) => a.kind !== 'conversation');
      const sorted = [...sortByIdOrder(conversations, orderedIds), ...others];
      return { agents: { ...s.agents, [jid]: sorted } };
    });
    // Persist to localStorage
    try {
      localStorage.setItem(
        `happyclaw-agent-order-${jid}`,
        JSON.stringify(orderedIds),
      );
    } catch {
      /* ignore */
    }
  },

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
      set({ error: err instanceof Error ? err.message : String(err) });
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
    const before =
      loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

    try {
      const params = new URLSearchParams(
        before
          ? { before: String(before), limit: '50', agentId }
          : { limit: '50', agentId },
      );
      const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );
      const sorted = [...data.messages].reverse();
      let snapshotMessages = sorted;
      set((s) => {
        const nextMessages = loadMore
          ? mergeMessagesChronologically(s.agentMessages[agentId] || [], sorted)
          : sorted;
        snapshotMessages = nextMessages;
        return {
          agentMessages: { ...s.agentMessages, [agentId]: nextMessages },
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
      set({ error: err instanceof Error ? err.message : String(err) });
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
      const merged = mergeMessagesChronologically(existing, snapshot.messages);
      return {
        agentMessages: { ...s.agentMessages, [agentId]: merged },
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
      }>('/api/messages', {
        chatJid: jid,
        agentId,
        content,
        attachments: normalizedAttachments,
        followUpBehavior,
      });
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
    const lastTs =
      existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

    try {
      const params = new URLSearchParams({ limit: '50', agentId });
      if (lastTs) params.set('after', lastTs);

      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`,
      );

      if (data.messages.length > 0) {
        let snapshotMessages: Message[] | null = null;
        let snapshotHasMore = false;
        set((s) => {
          const merged = mergeMessagesChronologically(
            s.agentMessages[agentId] || [],
            data.messages,
          );
          snapshotMessages = merged;
          snapshotHasMore = !!s.agentHasMore[agentId];
          const agentReplied = data.messages.some(
            (m) =>
              m.is_from_me &&
              m.sender !== '__system__' &&
              m.source_kind !== 'sdk_send_message',
          );
          const nextAgentStreaming = agentReplied
            ? (() => {
                const n = { ...s.agentStreaming };
                delete n[agentId];
                return n;
              })()
            : s.agentStreaming;

          return {
            agentMessages: { ...s.agentMessages, [agentId]: merged },
            agentWaiting: agentReplied
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
      set({ error: err instanceof Error ? err.message : String(err) });
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

  bindImGroup: async (jid, agentId, imJid, force) => {
    try {
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${agentId}/im-binding`,
        { im_jid: imJid, ...(force ? { force: true } : {}) },
      );
      // Refresh agents to get updated linked_im_groups
      get().loadAgents(jid, { force: true });
      return true;
    } catch {
      return false;
    }
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

  bindMainImGroup: async (
    jid,
    imJid,
    force,
    activationMode,
    ownerImId,
    audienceMode,
  ) => {
    try {
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/sessions/main/im-binding`,
        {
          im_jid: imJid,
          ...(force ? { force: true } : {}),
          ...(activationMode ? { activation_mode: activationMode } : {}),
          ...(ownerImId ? { owner_im_id: ownerImId } : {}),
          ...(audienceMode ? { audience_mode: audienceMode } : {}),
        },
      );
      await get().loadGroups();
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

  bindWorkspaceImGroup: async (
    jid,
    imJid,
    force,
    activationMode,
    ownerImId,
    audienceMode,
  ) => {
    try {
      await api.put(`/api/groups/${encodeURIComponent(jid)}/im-binding`, {
        im_jid: imJid,
        ...(force ? { force: true } : {}),
        ...(activationMode ? { activation_mode: activationMode } : {}),
        ...(ownerImId ? { owner_im_id: ownerImId } : {}),
        ...(audienceMode ? { audience_mode: audienceMode } : {}),
      });
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
    try {
      const data = await api.get<{
        groups: Array<{
          jid: string;
          active: boolean;
          pendingMessages?: boolean;
          queryInFlight?: boolean;
          queryId?: string | null;
        }>;
      }>('/api/status');
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
            clearStreamingFromSession(jid);
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
          clearStreamingFromSession(g.jid);
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
    const restored: StreamingState = {
      ...DEFAULT_STREAMING_STATE,
      partialText: snapshot.partialText || '',
      thinkingText: snapshot.thinkingText || '',
      activeTools: (snapshot.activeTools || []).map((t) => ({
        toolName: t.toolName,
        toolUseId: t.toolUseId,
        startTime: t.startTime,
        toolInputSummary: t.toolInputSummary,
        parentToolUseId: t.parentToolUseId,
      })),
      recentEvents: (
        (snapshot.recentEvents || []) as StreamingTimelineEvent[]
      ).filter(isUserVisibleTimelineEvent),
      traceEvents: (snapshot.traceEvents || []).filter(isUserVisibleTraceEvent),
      taskStates: snapshot.taskStates || {},
      todos: snapshot.todos,
      systemStatus: snapshot.systemStatus || null,
      isThinking: snapshot.isThinking ?? false,
      activeHook: snapshot.activeHook ?? null,
      turnId: snapshot.turnId,
    };

    if (agentId) {
      // Agent-specific snapshot → restore agentStreaming + agentWaiting
      set((s) => {
        if (!shouldApplyRunScopedPayload(s.activeRuns, runtimeJid, runId)) {
          return s;
        }
        return {
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          agentStreaming: { ...s.agentStreaming, [agentId]: restored },
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
          streaming: { ...s.streaming, [chatJid]: restored },
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
    set((s) => {
      const replacingAttempt = s.activeRuns[chatJid]?.runId !== runId;
      const activeRuns = applyRunStarted(s.activeRuns, {
        chatJid,
        runId,
        startedAt: new Date().toISOString(),
        phase: 'preparing',
      });
      if (agentId) {
        const nextStreaming = { ...s.agentStreaming };
        if (replacingAttempt) delete nextStreaming[agentId];
        return {
          activeRuns,
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          agentStreaming: nextStreaming,
        };
      }
      const nextStreaming = { ...s.streaming };
      if (replacingAttempt) {
        delete nextStreaming[chatJid];
        clearStreamingFromSession(chatJid);
      }
      return {
        activeRuns,
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: nextStreaming,
      };
    });
  },

  handleRunFinished: (chatJid, runId) => {
    const marker = '#agent:';
    const markerIndex = chatJid.indexOf(marker);
    const agentId =
      markerIndex >= 0 ? chatJid.slice(markerIndex + marker.length) : null;
    if (get().activeRuns[chatJid]?.runId !== runId) return;
    cancelPendingDeltaForRuntime(chatJid);
    set((s) => {
      const finished = applyRunFinished(s.activeRuns, chatJid, runId);
      // A terminal event from an old attempt must not touch its replacement.
      if (!finished.applied) return s;
      if (agentId) {
        const nextStreaming = { ...s.agentStreaming };
        delete nextStreaming[agentId];
        return {
          activeRuns: finished.runs,
          agentWaiting: { ...s.agentWaiting, [agentId]: false },
          agentStreaming: nextStreaming,
        };
      }
      const nextStreaming = { ...s.streaming };
      delete nextStreaming[chatJid];
      const nextPendingThinking = { ...s.pendingThinking };
      delete nextPendingThinking[chatJid];
      const nextPendingThinkingDuration = {
        ...s.pendingThinkingDuration,
      };
      delete nextPendingThinkingDuration[chatJid];
      clearStreamingFromSession(chatJid);
      return {
        activeRuns: finished.runs,
        waiting: { ...s.waiting, [chatJid]: false },
        streaming: nextStreaming,
        pendingThinking: nextPendingThinking,
        pendingThinkingDuration: nextPendingThinkingDuration,
      };
    });
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
      for (const jid of Object.keys(s.streaming)) {
        if (!authoritative[jid]) clearStreamingFromSession(jid);
      }
      for (const jid of Object.keys(previous)) {
        if (jid.includes('#agent:') || authoritative[jid]) continue;
        delete nextPendingThinking[jid];
        delete nextPendingThinkingDuration[jid];
      }
      return {
        activeRuns: authoritative,
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
    clearStreamingFromSession(chatJid);
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
