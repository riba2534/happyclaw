import { create } from 'zustand';
import { api } from '../api/client';
import { wsManager } from '../api/ws';
import { useFileStore } from './files';
import { useAuthStore } from './auth';
import { showToast, notifyIfHidden, shouldEmitBackgroundTaskNotice, showNotificationPromptToast } from '../utils/toast';
import { invalidateGroupCache } from '../utils/pwaCache';
import {
  deleteAgentMessageSnapshot,
  deleteGroupMessageSnapshots,
  loadAgentMessageSnapshot,
  saveAgentMessageSnapshot,
} from '../utils/messageSnapshotCache';
import type { GroupInfo, AgentInfo, AvailableImGroup } from '../types';

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
  turn_id?: string | null;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?: 'sdk_final' | 'sdk_send_message' | 'interrupt_partial' | 'legacy' | null;
  finalization_reason?: 'completed' | 'interrupted' | 'error' | null;
}

// Streaming event types (canonical source: shared/stream-event.ts)
import type { StreamEventType, StreamEvent } from '../stream-event.types';
export type { StreamEventType, StreamEvent };

export interface StreamingTimelineEvent {
  id: string;
  timestamp: number;
  text: string;
  kind: 'tool' | 'skill' | 'hook' | 'status' | 'task' | 'memory' | 'debug' | 'context';
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
  turnId?: string;
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
  contextAudit?: StreamEvent['contextAudit'];
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
      old.turn_id !== m.turn_id ||
      old.session_id !== m.session_id ||
      old.sdk_message_uuid !== m.sdk_message_uuid ||
      old.source_kind !== m.source_kind ||
      old.finalization_reason !== m.finalization_reason
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
    console.warn(
      '[mergeMessages] Message count decreased!',
      { before: existing.length, after: result.length, incoming: incoming.length, missingIds },
    );
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
  if (prev.isThinking && prev.thinkingStartedAt != null && next.thinkingDurationMs == null) {
    next.thinkingDurationMs = Date.now() - prev.thinkingStartedAt;
  }
}

interface ChatState {
  groups: Record<string, GroupInfo>;
  currentGroup: string | null;
  messages: Record<string, Message[]>;
  waiting: Record<string, boolean>;
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
  agents: Record<string, AgentInfo[]>;              // jid → agents
  agentStreaming: Record<string, StreamingState>;    // agentId → streaming state
  activeAgentTab: Record<string, string | null>;     // jid → selected agentId (null = main)
  // SDK Task subagent state (in-process via Task tool, not DB-persisted)
  sdkTasks: Record<string, {  // toolUseId → task info
    chatJid: string;
    description: string;
    status: 'running' | 'completed' | 'error';
    summary?: string;
    isTeammate?: boolean;
    startedAt?: number;  // 任务创建时间戳（ms），用于 UI 计时器
  }>;
  // SDK Task alias map: runtime taskId/parentToolUseId -> canonical sdkTasks key
  sdkTaskAliases: Record<string, string>;
  // Conversation agent state
  agentMessages: Record<string, Message[]>;          // agentId → messages
  agentWaiting: Record<string, boolean>;             // agentId → waiting for reply
  agentHasMore: Record<string, boolean>;             // agentId → has more messages
  loadGroups: () => Promise<void>;
  selectGroup: (jid: string) => void;
  loadMessages: (jid: string, loadMore?: boolean) => Promise<void>;
  refreshMessages: (jid: string) => Promise<void>;
  sendMessage: (jid: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => Promise<boolean>;
  stopGroup: (jid: string) => Promise<boolean>;
  interruptQuery: (jid: string) => Promise<boolean>;
  resetSession: (jid: string, agentId?: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  deleteMessage: (jid: string, messageId: string) => Promise<boolean>;
  createFlow: (name: string, options?: { execution_mode?: 'container' | 'host'; custom_cwd?: string; init_source_path?: string; init_git_url?: string }) => Promise<{ jid: string; folder: string } | null>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  togglePin: (jid: string) => Promise<void>;
  deleteFlow: (jid: string) => Promise<void>;
  handleStreamEvent: (chatJid: string, event: StreamEvent, agentId?: string) => void;
  handleWsNewMessage: (chatJid: string, wsMsg: any, agentId?: string, source?: string) => void;
  handleAgentStatus: (chatJid: string, agentId: string, status: AgentInfo['status'], name: string, prompt: string, resultSummary?: string, kind?: AgentInfo['kind'], titleGenerating?: boolean) => void;
  clearStreaming: (
    chatJid: string,
    options?: { preserveThinking?: boolean },
  ) => void;
  restoreActiveState: () => Promise<void>;
  handleStreamSnapshot: (chatJid: string, snapshot: StreamSnapshotData, agentId?: string) => void;
  // Sub-agent actions
  loadAgents: (jid: string, opts?: { force?: boolean }) => Promise<void>;
  deleteAgentAction: (jid: string, agentId: string) => Promise<boolean>;
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  // Conversation agent actions
  reorderConversations: (jid: string, orderedIds: string[]) => void;
  createConversation: (jid: string, name?: string, description?: string) => Promise<AgentInfo | null>;
  renameConversation: (jid: string, agentId: string, name: string) => Promise<boolean>;
  loadAgentMessages: (jid: string, agentId: string, loadMore?: boolean) => Promise<void>;
  hydrateAgentMessages: (jid: string, agentId: string) => Promise<void>;
  sendAgentMessage: (jid: string, agentId: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => boolean;
  refreshAgentMessages: (jid: string, agentId: string) => Promise<void>;
  // Runner state sync
  handleRunnerState: (chatJid: string, state: string) => void;
  // IM binding actions
  loadAvailableImGroups: (jid: string) => Promise<AvailableImGroup[]>;
  bindImGroup: (jid: string, agentId: string, imJid: string, force?: boolean) => Promise<boolean>;
  unbindImGroup: (jid: string, agentId: string, imJid: string) => Promise<boolean>;
  bindMainImGroup: (jid: string, imJid: string, force?: boolean, activationMode?: string, ownerImId?: string) => Promise<boolean>;
  unbindMainImGroup: (jid: string, imJid: string) => Promise<boolean>;
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
  partialText: '', thinkingText: '', isThinking: false,
  activeTools: [], activeHook: null, systemStatus: null, recentEvents: [],
  traceEvents: [], taskStates: {},
};

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
function freezeStreamingState(state: StreamingState | undefined): StreamingState | null {
  if (!state) return null;
  const hasData =
    state.partialText ||
    state.thinkingText ||
      state.activeTools.length > 0 ||
      state.activeHook ||
      state.systemStatus ||
      state.recentEvents.length > 0 ||
      state.traceEvents.length > 0 ||
      Object.keys(state.taskStates).length > 0 ||
      (state.todos && state.todos.length > 0);
  if (!hasData) return null;
  // Preserve any in-flight thinking duration so the interrupted card still shows "已思考 Xs".
  const thinkingDurationMs = state.thinkingDurationMs ?? (
    state.isThinking && state.thinkingStartedAt != null
      ? Date.now() - state.thinkingStartedAt
      : undefined
  );
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
function resolveStreamingPrev(current: StreamingState | undefined, event: StreamEvent): StreamingState {
  if (current?.turnId && event.turnId && current.turnId !== event.turnId) {
    return { ...DEFAULT_STREAMING_STATE, turnId: event.turnId, sessionId: event.sessionId };
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
const dbTaskAgentCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Streaming state sessionStorage persistence ───────────────────────
// Survives page refresh so StreamingDisplay can restore accumulated content.
const STREAMING_STORAGE_KEY = 'hc_streaming';
const streamingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced save of streaming state to sessionStorage (trailing-edge, 500ms per jid). */
function saveStreamingToSession(chatJid: string, state: StreamingState | undefined): void {
  // Cancel previous timer to always save the latest state (trailing-edge debounce)
  const existing = streamingSaveTimers.get(chatJid);
  if (existing) clearTimeout(existing);
  streamingSaveTimers.set(chatJid, setTimeout(() => {
    streamingSaveTimers.delete(chatJid);
    try {
      const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
      if (state && (state.partialText || state.thinkingText || state.activeTools.length > 0 || state.recentEvents.length > 0 || state.traceEvents.length > 0 || Object.keys(state.taskStates).length > 0 || state.contextAudit)) {
        stored[chatJid] = {
          partialText: state.partialText.slice(-4000), // cap size
          thinkingText: state.thinkingText.slice(-MAX_THINKING_TEXT),
          isThinking: state.isThinking,
          activeTools: state.activeTools,
          recentEvents: state.recentEvents.slice(-10),
          traceEvents: state.traceEvents.slice(-50),
          taskStates: state.taskStates,
          contextAudit: state.contextAudit,
          todos: state.todos,
          systemStatus: state.systemStatus,
          turnId: state.turnId,
          ts: Date.now(),
        };
      } else {
        delete stored[chatJid];
      }
      sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
    } catch { /* quota exceeded or SSR */ }
  }, 500));
}

/** Remove streaming state from sessionStorage. */
function clearStreamingFromSession(chatJid: string): void {
  const timer = streamingSaveTimers.get(chatJid);
  if (timer) { clearTimeout(timer); streamingSaveTimers.delete(chatJid); }
  try {
    const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
    delete stored[chatJid];
    sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
  } catch { /* SSR */ }
}

/** Restore streaming state from sessionStorage (stale entries > 5min are discarded). */
function restoreStreamingFromSession(chatJid: string): StreamingState | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STREAMING_STORAGE_KEY) || '{}');
    const entry = stored[chatJid];
    if (!entry) return null;
    // Discard stale entries (> 5 minutes old)
    if (Date.now() - (entry.ts || 0) > 5 * 60 * 1000) {
      delete stored[chatJid];
      sessionStorage.setItem(STREAMING_STORAGE_KEY, JSON.stringify(stored));
      return null;
    }
    return {
      ...DEFAULT_STREAMING_STATE,
      partialText: entry.partialText || '',
      thinkingText: entry.thinkingText || '',
      isThinking: entry.isThinking || false,
      activeTools: entry.activeTools || [],
      recentEvents: entry.recentEvents || [],
      traceEvents: entry.traceEvents || [],
      taskStates: entry.taskStates || {},
      contextAudit: entry.contextAudit,
      todos: entry.todos,
      systemStatus: entry.systemStatus || null,
      turnId: entry.turnId,
    };
  } catch { return null; }
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
}
const pendingDeltas = new Map<string, PendingDelta>();

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
      if (!s.agentStreaming[agentId] && s.agentWaiting[agentId] === false) return s;
      const prev = s.agentStreaming[agentId] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      if (mergedText) {
        const combined = prev.partialText + mergedText;
        next.partialText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = false;
        markThinkingEnded(prev, next);
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText = combined.length > MAX_THINKING_TEXT ? combined.slice(-MAX_THINKING_TEXT) : combined;
        next.isThinking = true;
        markThinkingStarted(prev, next);
      }
      return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
    });
  } else {
    set((s) => {
      if (!s.streaming[chatJid] && s.waiting[chatJid] === false) return s;
      if (s.streaming[chatJid]?.interrupted) return s;
      const prev = s.streaming[chatJid] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      if (mergedText) {
        const combined = prev.partialText + mergedText;
        next.partialText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = false;
        markThinkingEnded(prev, next);
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText = combined.length > MAX_THINKING_TEXT ? combined.slice(-MAX_THINKING_TEXT) : combined;
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
  const createdAtMap = new Map((state.agents[chatJid] || []).map((a) => [a.id, a.created_at]));
  pool.sort((a, b) => (createdAtMap.get(a) || '').localeCompare(createdAtMap.get(b) || ''));
  return pool[0] || null;
}

function isTerminalSystemMessage(message: Pick<Message, 'sender' | 'content'>): boolean {
  if (message.sender === '__billing__') return true;
  // query_interrupted 仅作为视觉分隔线，不参与流式状态清理。
  // 流式状态由 status:interrupted（冻结）→ interrupt_partial（转正）两阶段处理。
  return message.sender === '__system__' && (
    message.content === 'context_reset' ||
    message.content.startsWith('agent_error:') ||
    message.content.startsWith('agent_max_retries:') ||
    message.content.startsWith('context_overflow:')
  );
}

function isInterruptSystemMessage(message: Pick<Message, 'sender' | 'content'>): boolean {
  return message.sender === '__system__' && message.content === 'query_interrupted';
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
  if (event.eventType.startsWith('tool_')) return event.skillName ? 'skill' : 'tool';
  if (event.eventType.startsWith('hook_')) return 'hook';
  if (event.eventType.startsWith('task_')) return 'task';
  if (event.eventType === 'context_audit') return 'context';
  if (event.eventType === 'memory_recall' || event.eventType === 'compact_boundary') return 'memory';
  if (event.eventType === 'raw_sdk_event') return 'debug';
  return 'status';
}

function traceTitle(event: StreamEvent): string {
  if (event.title) return event.title;
  switch (event.eventType) {
    case 'tool_use_start': return event.skillName ? `技能 ${event.skillName}` : `工具 ${event.toolName || 'unknown'}`;
    case 'tool_use_end': return `工具完成 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'tool_progress': return `工具进度 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'task_start': return `Task 启动`;
    case 'task_progress': return `Task 进度`;
    case 'task_updated': return `Task 更新`;
    case 'task_notification': return `Task ${event.taskStatus || '完成'}`;
    case 'context_audit': return 'Agent Context';
    case 'status': return event.statusText || '状态更新';
    case 'permission_denied': return `权限拒绝 ${event.toolName || ''}`.trim();
    case 'memory_recall': return '记忆召回';
    case 'compact_boundary': return '上下文压缩';
    case 'notification': return '通知';
    case 'prompt_suggestion': return '建议';
    default: return event.rawType || event.eventType;
  }
}

function pushTrace(events: StreamingTraceEvent[], event: StreamEvent): StreamingTraceEvent[] {
  if (event.eventType === 'text_delta' || event.eventType === 'thinking_delta' || event.eventType === 'usage' || event.eventType === 'init') {
    return events;
  }
  const item: StreamingTraceEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind: traceKind(event),
    scope: event.agentScope,
    title: traceTitle(event),
    summary: event.summary || event.taskSummary || event.statusText || event.toolInputSummary,
    detail: event.detail,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    parentToolUseId: event.parentToolUseId,
    displayLevel: event.displayLevel,
  };
  return [...events, item].slice(-MAX_TRACE_EVENTS);
}

function taskIdFromEvent(event: StreamEvent): string | null {
  return event.parentToolUseId || event.taskId || (
    (event.eventType === 'task_start' || event.eventType === 'task_progress' || event.eventType === 'task_updated' || event.eventType === 'task_notification')
      ? event.toolUseId || null
      : null
  );
}

function ensureTaskRuntime(
  taskStates: Record<string, StreamingTaskRuntimeState>,
  taskId: string,
  event: StreamEvent,
): StreamingTaskRuntimeState {
  return taskStates[taskId] || {
    id: taskId,
    title: event.taskDescription || event.toolInputSummary || event.summary || 'Task',
    status: 'running',
    subagentType: event.subagentType,
    thinkingTail: '',
    textTail: '',
    activeTools: [],
    recentTools: [],
    updatedAt: Date.now(),
  };
}

function updateTaskRuntime(prev: StreamingState, next: StreamingState, event: StreamEvent): boolean {
  const taskId = taskIdFromEvent(event);
  if (!taskId) return false;
  const taskStates = { ...prev.taskStates };
  const task = { ...ensureTaskRuntime(taskStates, taskId, event) };
  task.updatedAt = Date.now();
  if (event.taskDescription && (!task.title || task.title === 'Task')) task.title = event.taskDescription;
  if (event.subagentType) task.subagentType = event.subagentType;

  if (event.eventType === 'text_delta') {
    task.textTail = tail(task.textTail + (event.text || ''), MAX_TASK_TAIL);
  } else if (event.eventType === 'thinking_delta') {
    task.thinkingTail = tail(task.thinkingTail + (event.text || ''), MAX_TASK_TAIL);
  } else if (event.eventType === 'task_progress') {
    task.status = 'running';
    task.latestSummary = event.summary || event.taskSummary || event.taskDescription || task.latestSummary;
    task.lastToolName = event.lastToolName || task.lastToolName;
  } else if (event.eventType === 'task_updated') {
    const patch = event.taskPatch;
    if (patch?.status === 'completed') task.status = 'completed';
    else if (patch?.status === 'failed' || patch?.status === 'killed') task.status = 'error';
    else if (patch?.is_backgrounded) task.status = 'backgrounded';
    else if (patch?.status === 'running' || patch?.status === 'pending') task.status = 'running';
    task.latestSummary = event.summary || patch?.description || patch?.error || task.latestSummary;
  } else if (event.eventType === 'task_notification') {
    task.status = event.taskStatus === 'completed' ? 'completed' : 'error';
    task.latestSummary = event.taskSummary || event.summary || task.latestSummary;
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
    task.activeTools = task.activeTools.some(t => t.toolUseId === tool.toolUseId && tool.toolUseId)
      ? task.activeTools.map(t => (t.toolUseId === tool.toolUseId ? { ...t, ...tool } : t))
      : [...task.activeTools, tool];
    task.recentTools = pushEvent(task.recentTools, event.skillName ? 'skill' : 'tool', `${event.skillName ? `技能 ${event.skillName}` : `工具 ${event.toolName || 'unknown'}`}${event.toolInputSummary ? ` (${event.toolInputSummary})` : ''}`);
  } else if (event.eventType === 'tool_use_end' && event.parentToolUseId) {
    task.activeTools = task.activeTools.filter(t => t.toolUseId !== event.toolUseId);
    task.recentTools = pushEvent(task.recentTools, 'tool', `✓ ${event.toolName || event.toolUseId || '工具'}`);
  } else if (event.eventType === 'tool_progress' && event.parentToolUseId) {
    task.activeTools = task.activeTools.map(t => t.toolUseId === event.toolUseId
      ? { ...t, elapsedSeconds: event.elapsedSeconds, toolInputSummary: event.toolInputSummary || t.toolInputSummary }
      : t);
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
      next.partialText = combined.length > maxText ? combined.slice(-maxText) : combined;
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
      next.thinkingText = combined.length > MAX_THINKING_TEXT ? combined.slice(-MAX_THINKING_TEXT) : combined;
      next.isThinking = true;
      markThinkingStarted(prev, next);
      break;
    }
    case 'tool_use_start': {
      next.isThinking = false;
      markThinkingEnded(prev, next);
      const toolUseId = event.toolUseId || '';
      const existing = prev.activeTools.find(t => t.toolUseId === toolUseId && toolUseId);
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
        ? prev.activeTools.map(t => (t.toolUseId === toolUseId ? { ...t, ...tool } : t))
        : [...prev.activeTools, tool];
      if (event.parentToolUseId) {
        updateTaskRuntime(prev, next, event);
      }

      const isSkill = tool.toolName === 'Skill';
      const label = isSkill
        ? `技能 ${tool.skillName || 'unknown'}`
        : `工具 ${tool.toolName}`;
      const detail = tool.toolInputSummary ? ` (${tool.toolInputSummary})` : '';
      next.recentEvents = pushEvent(prev.recentEvents, isSkill ? 'skill' : 'tool', `${label}${detail}`);
      break;
    }
      case 'tool_use_end':
        if (event.toolUseId) {
        const ended = prev.activeTools.find(t => t.toolUseId === event.toolUseId);
        next.activeTools = prev.activeTools.filter(t => t.toolUseId !== event.toolUseId);
        if (ended) {
          const rawSec = (Date.now() - ended.startTime) / 1000;
          const elapsedSec = rawSec % 1 === 0 ? rawSec.toFixed(0) : rawSec.toFixed(1);
          const isSkill = ended.toolName === 'Skill';
          const label = isSkill
            ? `技能 ${ended.skillName || 'unknown'}`
            : `工具 ${ended.toolName}`;
            next.recentEvents = pushEvent(prev.recentEvents, isSkill ? 'skill' : 'tool', `✓ ${label} (${elapsedSec}s)`);
          }
        } else {
          next.activeTools = [];
        }
        if (event.parentToolUseId) {
          updateTaskRuntime(prev, next, event);
        }
        break;
    case 'tool_progress': {
      const existing = prev.activeTools.find(t => t.toolUseId === event.toolUseId);
        if (existing) {
        const skillNameResolved = event.skillName && !existing.skillName;
        next.activeTools = prev.activeTools.map(t =>
          t.toolUseId === event.toolUseId
            ? {
                ...t,
                elapsedSeconds: event.elapsedSeconds,
                ...(event.skillName ? { skillName: event.skillName } : {}),
                ...(event.toolInput ? { toolInput: event.toolInput } : {}),
              }
            : t
        );
        if (skillNameResolved) {
          const oldLabel = `技能 unknown`;
          const newLabel = `技能 ${event.skillName}`;
          next.recentEvents = prev.recentEvents.map(e =>
            e.kind === 'skill' && e.text.includes(oldLabel)
              ? { ...e, text: e.text.replace(oldLabel, newLabel) }
              : e
          );
        }
        } else {
        next.activeTools = [...prev.activeTools, {
          toolName: event.toolName || 'unknown',
          toolUseId: event.toolUseId || '',
          startTime: Date.now(),
          parentToolUseId: event.parentToolUseId,
          isNested: event.isNested,
          elapsedSeconds: event.elapsedSeconds,
        }];
        }
        if (event.parentToolUseId) {
          updateTaskRuntime(prev, next, event);
        }
        break;
      }
    case 'task_start': {
      updateTaskRuntime(prev, next, event);
      const desc = event.taskDescription || event.toolInputSummary || event.summary || 'Task';
      next.recentEvents = pushEvent(prev.recentEvents, 'task', `Task 启动: ${desc}`);
      break;
    }
    case 'task_progress': {
      updateTaskRuntime(prev, next, event);
      const label = event.lastToolName ? `Task 进度 [${event.lastToolName}]` : 'Task 进度';
      next.recentEvents = pushEvent(prev.recentEvents, 'task', `${label}: ${event.summary || event.taskDescription || ''}`);
      break;
    }
    case 'task_updated': {
      updateTaskRuntime(prev, next, event);
      next.recentEvents = pushEvent(prev.recentEvents, 'task', `Task 更新: ${event.summary || event.taskPatch?.status || ''}`);
      break;
    }
    case 'task_notification': {
      updateTaskRuntime(prev, next, event);
      next.recentEvents = pushEvent(prev.recentEvents, 'task', `Task ${event.taskStatus === 'completed' ? '完成' : '结束'}: ${event.taskSummary || event.summary || ''}`);
      break;
    }
    case 'hook_started':
      next.activeHook = { hookName: event.hookName || '', hookEvent: event.hookEvent || '' };
      next.recentEvents = pushEvent(
        prev.recentEvents,
        'hook',
        `Hook 开始: ${event.hookName || 'unknown'} (${event.hookEvent || 'unknown'})`,
      );
      break;
    case 'hook_progress':
      next.activeHook = { hookName: event.hookName || '', hookEvent: event.hookEvent || '' };
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
      if (event.statusText) {
        next.recentEvents = pushEvent(prev.recentEvents, 'status', `状态: ${event.statusText}`);
      }
        break;
      }
      case 'permission_denied':
        next.recentEvents = pushEvent(prev.recentEvents, 'status', event.summary || event.detail || '权限被拒绝');
        break;
      case 'memory_recall':
      case 'compact_boundary':
        next.recentEvents = pushEvent(prev.recentEvents, 'memory', event.summary || traceTitle(event));
        break;
      case 'notification':
      case 'prompt_suggestion':
        next.recentEvents = pushEvent(prev.recentEvents, 'status', event.summary || traceTitle(event));
        break;
      case 'raw_sdk_event':
        if (event.displayLevel === 'primary') {
          next.recentEvents = pushEvent(prev.recentEvents, 'debug', event.summary || traceTitle(event));
        }
        break;
      case 'context_audit':
        next.contextAudit = event.contextAudit;
        if (event.contextAudit?.warnings?.length) {
          next.recentEvents = pushEvent(prev.recentEvents, 'context', `Agent Context: ${event.contextAudit.warnings[0]}`);
        }
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
      const data = await api.get<{ groups: Record<string, GroupInfo> }>('/api/groups');
      set((state) => {
        const currentStillExists =
          state.currentGroup && !!data.groups[state.currentGroup];

        let nextCurrent = currentStillExists ? state.currentGroup : null;
        if (!nextCurrent) {
          const homeEntry = Object.entries(data.groups).find(
            ([_, group]) => group.is_my_home,
          );
          if (homeEntry) {
            nextCurrent = homeEntry[0];
          } else {
            nextCurrent = Object.keys(data.groups)[0] || null;
          }
        }

        return {
          groups: data.groups,
          currentGroup: nextCurrent,
          loading: false,
          error: null,
        };
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
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
    const before = loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

    try {
      const data = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${new URLSearchParams(
          before ? { before: String(before), limit: '50' } : { limit: '50' }
        )}`
      );
      // Messages come in DESC order from API, reverse to chronological for display
      const sorted = [...data.messages].reverse();
      set((s) => {
        const merged = mergeMessagesChronologically(s.messages[jid] || [], sorted);
        const latest = merged.length > 0 ? merged[merged.length - 1] : null;
        const shouldWait =
          !!latest &&
          latest.sender !== '__system__' &&
          (latest.is_from_me === false || latest.source_kind === 'sdk_send_message');
        const nextWaiting = { ...s.waiting };
        if (shouldWait) {
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
    const lastTs = existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

    try {
      // Fetch messages newer than the last one we have
      const params = new URLSearchParams({ limit: '50' });
      if (lastTs) params.set('after', lastTs);

      const data = await api.get<{ messages: Message[] }>(
        `/api/groups/${encodeURIComponent(jid)}/messages?${params}`
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
          const hasSystemError = data.messages.some((m) => isTerminalSystemMessage(m));

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
              nextThinkingCache = capThinkingCache({ ...s.thinkingCache, [lastAiMsg.id]: s.pendingThinking[jid] });
              const pendingDur = s.pendingThinkingDuration[jid];
              if (pendingDur != null) {
                nextThinkingDurationCache = capThinkingCache({ ...s.thinkingDurationCache, [lastAiMsg.id]: pendingDur });
              }
              const { [jid]: _, ...restPending } = s.pendingThinking;
              nextPendingThinking = restPending;
              const { [jid]: __, ...restPendingDur } = s.pendingThinkingDuration;
              nextPendingThinkingDuration = restPendingDur;
            }
          }

          return {
            messages: { ...s.messages, [jid]: merged },
            waiting: (agentReplied || hasSystemError)
              ? { ...s.waiting, [jid]: false }
              : s.waiting,
            streaming: (agentReplied || hasSystemError)
              ? (() => { const next = { ...s.streaming }; delete next[jid]; return next; })()
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

  sendMessage: async (jid: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => {
    try {
      // streaming 状态由以下 3 条路径正确清理，sendMessage 不应无条件清空：
      // 1. handleWsNewMessage 收到 is_from_me 消息时
      // 2. agent_reply WebSocket 事件时
      // 3. status:interrupted 事件时

      const body: { chatJid: string; content: string; attachments?: Array<{ type: 'image'; data: string; mimeType: string }> } = { chatJid: jid, content };
      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map(att => ({ type: 'image', ...att }));
      }

      type ClearedResponse = { success: true; cleared: true };
      type MessageCreateResponse =
        | ClearedResponse
        | { success: true; messageId: string; timestamp: string }
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
      // Add user message to local state immediately
      const authState = useAuthStore.getState();
      const sender = authState.user?.id || 'web-user';
      const senderName = authState.user?.display_name || authState.user?.username || 'Web';
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
        attachments: body.attachments ? JSON.stringify(body.attachments) : undefined,
      };
      set((s) => {
        const existing = s.messages[jid] || [];
        if (!s.messages[jid]) {
          console.warn('[sendMessage] messages[jid] is undefined at send time', { jid, storeKeys: Object.keys(s.messages) });
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

  stopGroup: async (jid: string) => {
    try {
      await api.post<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/stop`,
      );
      get().clearStreaming(jid, { preserveThinking: false });
      set((s) => {
        const next = { ...s.waiting };
        delete next[jid];
        return { waiting: next };
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

      // Invalidate SW cache for this group so the next page load doesn't
      // serve a stale messages/agents response from before the clear (#467).
      void invalidateGroupCache(jid);
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
        return { clearing: nextClearing, error: err instanceof Error ? err.message : String(err) };
      });
      return false;
    }
  },

  deleteMessage: async (jid: string, messageId: string) => {
    try {
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/messages/${encodeURIComponent(messageId)}`);
      // Invalidate SW cache so paginated message responses don't keep serving
      // the deleted message for up to 24h after deletion (#467).
      void invalidateGroupCache(jid);
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

  createFlow: async (name: string, options?: { execution_mode?: 'container' | 'host'; custom_cwd?: string; init_source_path?: string; init_git_url?: string }) => {
    try {
      const body: Record<string, string> = { name };
      if (options?.execution_mode) body.execution_mode = options.execution_mode;
      if (options?.custom_cwd) body.custom_cwd = options.custom_cwd;
      if (options?.init_source_path) body.init_source_path = options.init_source_path;
      if (options?.init_git_url) body.init_git_url = options.init_git_url;

      const needsLongTimeout = !!(options?.init_source_path || options?.init_git_url);
      const data = await api.post<{
        success: boolean;
        jid: string;
        group: GroupInfo;
      }>('/api/groups', body, needsLongTimeout ? 120_000 : undefined);
      if (!data.success) return null;

      set((s) => ({
        groups: { ...s.groups, [data.jid]: data.group },
        error: null,
      }));

      return { jid: data.jid, folder: data.group.folder };
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  renameFlow: async (jid: string, name: string) => {
    try {
      await api.patch<{ success: boolean }>(`/api/groups/${encodeURIComponent(jid)}`, { name });
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
              pinned_at: willPin ? (data.pinned_at || new Date().toISOString()) : undefined,
            },
          },
        };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteFlow: async (jid: string) => {
    try {
      await api.delete<{ success: boolean }>(`/api/groups/${encodeURIComponent(jid)}`);
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
      const apiErr = err as { status?: number; body?: Record<string, unknown>; message?: string };
      if (apiErr.status === 409 && apiErr.body?.bound_agents) {
        const e = new Error(apiErr.message || 'IM binding conflict') as Error & { boundAgents: unknown };
        e.boundAgents = apiErr.body.bound_agents;
        throw e;
      }
      set({ error: apiErr.message || (err instanceof Error ? err.message : String(err)) });
    }
  },

  // 处理流式事件
  handleStreamEvent: (chatJid, event, agentId?) => {
    // Skip while clearHistory is in-flight
    if (get().clearing[chatJid]) return;

    // ⓪ text_delta / thinking_delta — rAF batch for both agent and main conversation
    if ((event.eventType === 'text_delta' || event.eventType === 'thinking_delta') && (agentId || !event.parentToolUseId)) {
      const key = agentId ? `agent:${agentId}` : `main:${chatJid}`;
      let entry = pendingDeltas.get(key);
      if (entry) {
        // Already have a pending rAF — just accumulate
        if (event.eventType === 'text_delta') entry.texts.push(event.text || '');
        else entry.thinkings.push(event.text || '');
        return;
      }
      entry = { texts: [], thinkings: [], raf: 0 };
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
          if (state.agentStreaming[agentId]?.interrupted && !state.agentWaiting[agentId]) {
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
        const prev = resolveStreamingPrev(s.agentStreaming[agentId], event);
        const next = { ...prev };
        applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
        return { agentStreaming: { ...s.agentStreaming, [agentId]: next } };
      });
      return;
    }

    const ensureSdkTask = (taskId: string, description?: string, isTeammate?: boolean) => {
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
        set((s) => ({ sdkTaskAliases: { ...s.sdkTaskAliases, [rawId]: target } }));
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
        (event.eventType === 'task_start' && event.toolUseId)
        || (event.eventType === 'tool_use_start' && event.toolName === 'Task' && event.toolUseId)
    ) {
      ensureSdkTask(
        event.toolUseId!,
        event.taskDescription || event.toolInputSummary,
        event.isTeammate,
      );
      // 不 return — 让 task_start 同时落入主对话 streaming（显示 Task 工具卡片）
    }

    if (event.eventType === 'task_progress' && (event.toolUseId || event.taskId)) {
      const resolvedTaskId = resolveOrBindTaskId(event.toolUseId || event.taskId!);
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

    if (event.eventType === 'task_updated' && (event.toolUseId || event.taskId)) {
      const resolvedTaskId = resolveOrBindTaskId(event.toolUseId || event.taskId!);
      const patchStatus = event.taskPatch?.status;
      if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
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
      if (event.isBackground && shouldEmitBackgroundTaskNotice(resolvedTaskId)) {
        const taskInfo = get().sdkTasks[resolvedTaskId];
        const desc = (taskInfo?.description || event.taskSummary || '后台任务').slice(0, 60);
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
        finalizeSdkTask(resolvedToolUseId, 'completed', task.summary, SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS);
      }
      // fall-through 到主对话处理，移除 activeTools 中的 Task 条目
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
        updated[targetIdx] = { ...updated[targetIdx], token_usage: tokenUsageJson };
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
      turn_id: wsMsg.turn_id ?? null,
      session_id: wsMsg.session_id ?? null,
      sdk_message_uuid: wsMsg.sdk_message_uuid ?? null,
      source_kind: wsMsg.source_kind ?? null,
      finalization_reason: wsMsg.finalization_reason ?? null,
    };

    // Route to agentMessages if this is a conversation agent message
    if (agentId) {
      let snapshotMessages: Message[] | null = null;
      let snapshotHasMore = false;
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        const updated = mergeMessagesChronologically(existing, [msg]);
        snapshotMessages = updated;
        snapshotHasMore = !!s.agentHasMore[agentId];
        const isAgentReply =
          msg.is_from_me &&
          msg.sender !== '__system__' &&
          msg.source_kind !== 'sdk_send_message';

        // interrupt_partial 到达时，如果流式卡片已冻结（interrupted=true），
        // 不清除 agentStreaming——保留冻结的富内容，10s 兜底计时器做最终清理。
        const isFrozen = !!s.agentStreaming[agentId]?.interrupted;
        const interruptPartialWhileFrozen =
          msg.source_kind === 'interrupt_partial' && isFrozen;

        const nextAgentStreaming = (isAgentReply && !interruptPartialWhileFrozen)
          ? (() => { const n = { ...s.agentStreaming }; delete n[agentId]; return n; })()
          : s.agentStreaming;

        // For user messages (non-reply), set agentWaiting=true so subsequent
        // streaming events are accepted.  This handles messages injected from
        // Feishu/Telegram which don't go through sendAgentMessage().
        const nextAgentWaiting = isAgentReply
          ? { ...s.agentWaiting, [agentId]: false }
          : !msg.is_from_me
            ? { ...s.agentWaiting, [agentId]: true }
            : s.agentWaiting;

        return {
          agentMessages: { ...s.agentMessages, [agentId]: updated },
          agentWaiting: nextAgentWaiting,
          agentStreaming: nextAgentStreaming,
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

    // 闭包外标志：set() 内部计算后传出，用于驱动通知逻辑（避免重复判断条件）
    let didFinalizeAssistant = false;

    set((s) => {
      const existing = s.messages[chatJid] || [];

      // 消息已存在时保留原顺序，仅执行状态收尾（清 waiting/streaming）
      const updated = mergeMessagesChronologically(existing, [msg]);

      const isAgentReply =
        msg.is_from_me &&
        msg.sender !== '__system__' &&
        source !== 'scheduled_task' &&
        msg.source_kind !== 'sdk_send_message';
      const isSystemError = isTerminalSystemMessage(msg);
      // interrupt_partial 到达时，如果流式卡片已冻结（interrupted=true），
      // 不清除 streaming——保留冻结的富内容（thinking、工具、任务进度）。
      // 消息仍会添加到列表（走下方普通消息分支），10s 兜底计时器做最终清理。
      const interruptPartialWhileFrozen =
        msg.source_kind === 'interrupt_partial' && s.streaming[chatJid]?.interrupted;
      const shouldFinalizeAssistant =
        isAgentReply &&
        !interruptPartialWhileFrozen &&
        (msg.source_kind === 'sdk_final'
          || msg.source_kind === 'interrupt_partial'
          || msg.source_kind === null
          || msg.source_kind === undefined
          || msg.source_kind === 'legacy');

      if (shouldFinalizeAssistant || isSystemError) {
        if (shouldFinalizeAssistant) didFinalizeAssistant = true;

        // Agent 回复或系统错误：立即清除流式状态和等待标志，转移 thinking 缓存
        const streamState = s.streaming[chatJid];
        const thinkingText = isAgentReply
          ? (streamState?.thinkingText || s.pendingThinking[chatJid])
          : undefined;
        const thinkingDuration = isAgentReply
          ? (streamState?.thinkingDurationMs ?? s.pendingThinkingDuration[chatJid])
          : undefined;
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[chatJid];
        const nextPending = { ...s.pendingThinking };
        delete nextPending[chatJid];
        const nextPendingDur = { ...s.pendingThinkingDuration };
        delete nextPendingDur[chatJid];

        // 未读计数：页面隐藏或不在当前对话时增加
        const isHidden = typeof document !== 'undefined' && document.hidden;
        const isOtherChat = s.currentGroup !== chatJid;
        const nextUnread = (isHidden || isOtherChat) && shouldFinalizeAssistant
          ? { ...s.unreadReplies, [chatJid]: (s.unreadReplies[chatJid] || 0) + 1 }
          : s.unreadReplies;

        return {
          messages: { ...s.messages, [chatJid]: updated },
          waiting: { ...s.waiting, [chatJid]: false },
          streaming: nextStreaming,
          pendingThinking: nextPending,
          pendingThinkingDuration: nextPendingDur,
          unreadReplies: nextUnread,
          ...(thinkingText ? { thinkingCache: capThinkingCache({ ...s.thinkingCache, [msg.id]: thinkingText }) } : {}),
          ...(thinkingDuration != null ? { thinkingDurationCache: capThinkingCache({ ...s.thinkingDurationCache, [msg.id]: thinkingDuration }) } : {}),
        };
      }

      // 普通消息（如其他用户发送的消息，或显式 sdk_send_message）：只添加到列表
      return {
        messages: { ...s.messages, [chatJid]: updated },
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
  handleAgentStatus: (chatJid, agentId, status, name, prompt, resultSummary?, kind?, titleGenerating?) => {
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
        const nextSdkTaskAliases = removeSdkTaskAliases(s.sdkTaskAliases, agentId);
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
        completed_at: (status === 'completed' || status === 'error') ? new Date().toISOString() : undefined,
        result_summary: resultSummary,
        title_generating: typeof titleGenerating === 'boolean' ? titleGenerating : previous?.title_generating,
      };
      const updated = idx >= 0
        ? existing.map((a, i) => (i === idx ? agentInfo : a))
        : [...existing, agentInfo];

      // Clean up agent streaming if not actively running
      const nextAgentStreaming = { ...s.agentStreaming };
      if (status !== 'running') {
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
          nextSdkTaskAliases = removeSdkTaskAliases(nextSdkTaskAliases, agentId);
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
      if (resolvedKind === 'spawn' && (status === 'completed' || status === 'error')) {
        scheduleDbTaskAgentCleanup(set, agentId, chatJid);
      }

      // Conversation agent started running: reset agentWaiting so stream events
      // are accepted (mirrors handleRunnerState for the main conversation).
      // Skip for title-only broadcasts (titleGenerating set) — those carry the
      // persistent running status but shouldn't re-open the "waiting" window
      // after the reply has already finalized.
      const nextAgentWaiting =
        (resolvedKind === 'conversation' || resolvedKind === 'spawn') &&
        status === 'running' &&
        typeof titleGenerating !== 'boolean'
          ? { ...s.agentWaiting, [agentId]: true }
          : s.agentWaiting;

      return {
        agents: { ...s.agents, [chatJid]: updated },
        agentStreaming: nextAgentStreaming,
        agentWaiting: nextAgentWaiting,
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
        const visibleAgents = data.agents.filter((a) => a.kind === 'conversation' || (a.kind === 'spawn' && a.status !== 'completed') || a.status === 'running');
        const runningTasks = data.agents.filter((a) => a.kind === 'task' && a.status === 'running');
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
          const stillExists = visibleAgents.some((a) => a.id === nextActiveTab[jid]);
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
          const savedOrder = localStorage.getItem(`happyclaw-agent-order-${jid}`);
          if (savedOrder) {
            const ids: string[] = JSON.parse(savedOrder);
            const conversations = visibleAgents.filter((a) => a.kind === 'conversation');
            const others = visibleAgents.filter((a) => a.kind !== 'conversation');
            orderedAgents = [...sortByIdOrder(conversations, ids), ...others];
          }
        } catch { /* ignore */ }

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
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/agents/${agentId}`);
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
        const nextSdkTaskAliases = removeSdkTaskAliases(s.sdkTaskAliases, agentId);
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
    } catch {
      return false;
    }
  },

  // 切换子 Agent 标签页（在内存中 mirror，URL 是真正的真相源）
  setActiveAgentTab: (jid, agentId) => {
    set((s) => ({
      activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
    }));
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
      localStorage.setItem(`happyclaw-agent-order-${jid}`, JSON.stringify(orderedIds));
    } catch { /* ignore */ }
  },

  createConversation: async (jid, name, description?) => {
    try {
      const data = await api.post<{ agent: AgentInfo }>(
        `/api/groups/${encodeURIComponent(jid)}/agents`,
        { name, description },
      );
      set((s) => {
        const existing = s.agents[jid] || [];
        // WS agent_status broadcast may have already added it
        if (existing.some((a) => a.id === data.agent.id)) return s;
        return { agents: { ...s.agents, [jid]: [...existing, data.agent] } };
      });
      return data.agent;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  renameConversation: async (jid, agentId, name) => {
    try {
      await api.patch(`/api/groups/${encodeURIComponent(jid)}/agents/${agentId}`, { name });
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
    const before = loadMore && existing.length > 0 ? existing[0].timestamp : undefined;

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
        void saveAgentMessageSnapshot(jid, agentId, snapshotMessages, data.hasMore);
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

  sendAgentMessage: (jid, agentId, content, attachments?) => {
    // Send via WebSocket with agentId.
    // NOTE: 先尝试 ws.send，成功后再清 agentStreaming / 置 agentWaiting，
    // 避免失败时 UI 进入"等待中但消息没发出"的不一致状态。
    const normalizedAttachments = attachments && attachments.length > 0
      ? attachments.map(att => ({ type: 'image' as const, ...att }))
      : undefined;
    const sent = wsManager.send({ type: 'send_message', chatJid: jid, content, agentId, attachments: normalizedAttachments });
    if (!sent) {
      showToast('发送失败', 'WebSocket 未连接，输入已保留，请稍后重试');
      return false;
    }
    set((s) => {
      const nextAgentStreaming = { ...s.agentStreaming };
      delete nextAgentStreaming[agentId];
      return {
        agentStreaming: nextAgentStreaming,
        agentWaiting: { ...s.agentWaiting, [agentId]: true },
      };
    });
    return true;
  },

  refreshAgentMessages: async (jid, agentId) => {
    const existing = get().agentMessages[agentId] || [];
    const lastTs = existing.length > 0 ? existing[existing.length - 1].timestamp : undefined;

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
            ? (() => { const n = { ...s.agentStreaming }; delete n[agentId]; return n; })()
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
          void saveAgentMessageSnapshot(jid, agentId, snapshotMessages, snapshotHasMore);
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
    } catch {
      return [];
    }
  },

  bindImGroup: async (jid, agentId, imJid, force) => {
    try {
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/agents/${agentId}/im-binding`,
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
        `/api/groups/${encodeURIComponent(jid)}/agents/${agentId}/im-binding/${encodeURIComponent(imJid)}`,
      );
      get().loadAgents(jid, { force: true });
      return true;
    } catch {
      return false;
    }
  },

  bindMainImGroup: async (jid, imJid, force, activationMode, ownerImId) => {
    try {
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/im-binding`,
        {
          im_jid: imJid,
          ...(force ? { force: true } : {}),
          ...(activationMode ? { activation_mode: activationMode } : {}),
          ...(ownerImId ? { owner_im_id: ownerImId } : {}),
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
      const data = await api.get<{ groups: Array<{ jid: string; active: boolean; pendingMessages?: boolean }> }>('/api/status');
      const knownJids = new Set(data.groups.map((g) => g.jid));

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

        // 清除后端不可见的 JID 的 waiting/streaming（进程已死）
        // （pm2 restart 后 queue 为空，所有 JID 都不在集合中）。
        for (const jid of Object.keys(nextWaiting)) {
          if (!knownJids.has(jid)) {
            delete nextWaiting[jid];
            delete nextStreaming[jid];
            clearStreamingFromSession(jid);
          }
        }

        for (const g of data.groups) {
          if (g.pendingMessages) {
            nextWaiting[g.jid] = true;
            continue;
          }
          // 没有活跃进程且没有待处理消息 → 不应等待。
          if (!g.active) {
            delete nextWaiting[g.jid];
            delete nextStreaming[g.jid];
            clearStreamingFromSession(g.jid);
            continue;
          }
          // active 可能仅表示 runner 空闲存活，这里回退到消息语义推断。
          // 上面已 refreshMessages，s.messages 已与 DB 同步。
          const msgs = s.messages[g.jid] || [];
          const latest = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const inferredWaiting =
            !!latest &&
            latest.sender !== '__system__' &&
            (latest.is_from_me === false || latest.source_kind === 'sdk_send_message');
          if (inferredWaiting) {
            nextWaiting[g.jid] = true;
            // Restore streaming state from sessionStorage if available
            if (!nextStreaming[g.jid]) {
              const restored = restoreStreamingFromSession(g.jid);
              if (restored) {
                nextStreaming[g.jid] = restored;
              }
            }
          } else {
            delete nextWaiting[g.jid];
            clearStreamingFromSession(g.jid);
          }
        }
        return { waiting: nextWaiting, streaming: nextStreaming };
      });
    } catch {
      // 静默失败
    }
  },

  // WS 重连时接收后端推送的流式快照，恢复 StreamingDisplay
  handleStreamSnapshot: (chatJid, snapshot, agentId) => {
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
      recentEvents: (snapshot.recentEvents || []) as StreamingTimelineEvent[],
      traceEvents: snapshot.traceEvents || [],
      taskStates: snapshot.taskStates || {},
      contextAudit: snapshot.contextAudit,
      todos: snapshot.todos,
      systemStatus: snapshot.systemStatus || null,
      turnId: snapshot.turnId,
    };

    if (agentId) {
      // Agent-specific snapshot → restore agentStreaming + agentWaiting
      set((s) => {
        if (s.agentStreaming[agentId]?.partialText) return s;
        return {
          agentWaiting: { ...s.agentWaiting, [agentId]: true },
          agentStreaming: { ...s.agentStreaming, [agentId]: restored },
        };
      });
    } else {
      // Main conversation snapshot
      set((s) => {
        if (s.streaming[chatJid]?.partialText) return s;
        return {
          waiting: { ...s.waiting, [chatJid]: true },
          streaming: { ...s.streaming, [chatJid]: restored },
        };
      });
    }
  },

  // Runner 状态同步：idle 时清理残留状态，running 时重新启用 stream event 接收
  handleRunnerState: (chatJid, state) => {
    if (state === 'idle') {
      // 冻结的中断状态不清除：等 new_message 或 fallback 定时器处理
      if (get().streaming[chatJid]?.interrupted) return;
      get().clearStreaming(chatJid);

      // Runner idle → query 已结束，所有 SDK Task 应已完成。
      // 直接从 agents 数组中移除所有 task agent（不管状态），清理残留。
      const currentAgents = get().agents[chatJid] || [];
      const hasTaskAgents = currentAgents.some((a) => a.kind === 'task');
      if (hasTaskAgents) {
        set((s) => {
          const existing = s.agents[chatJid] || [];
          const filtered = existing.filter((a) => a.kind !== 'task');
          return { agents: { ...s.agents, [chatJid]: filtered } };
        });
      }
    } else if (state === 'running') {
      // 新进程启动时重新设置 waiting=true，确保 handleStreamEvent 的防重入
      // guard（!streaming && waiting===false）不会丢弃新进程的 stream events。
      // 典型场景：上一进程的 idle 清除了 waiting，drainGroup 立即启动新进程。
      // 同时清除残留的冻结中断状态，防止新流式输出继承 interrupted 标志。
      set((s) => {
        const nextStreaming = { ...s.streaming };
        if (nextStreaming[chatJid]?.interrupted) {
          delete nextStreaming[chatJid];
        }
        return {
          waiting: { ...s.waiting, [chatJid]: true },
          streaming: nextStreaming,
        };
      });
    }
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
        if (thinkingDur != null) nextPendingThinkingDuration[chatJid] = thinkingDur;
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
        if (task.chatJid === chatJid && !runningSet.has(taskId) && nextAgentStreaming[taskId]) {
          delete nextAgentStreaming[taskId];
          agentStreamingChanged = true;
        }
      }
      // 同时清理 agents[] 中已完成的 conversation agent 的 agentStreaming
      for (const agent of (s.agents[chatJid] || [])) {
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
        ...(agentStreamingChanged ? { agentStreaming: nextAgentStreaming } : {}),
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
