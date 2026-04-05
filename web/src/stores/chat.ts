import { create } from 'zustand';
import { api } from '../api/client';
import { wsManager } from '../api/ws';
import { useFileStore } from './files';
import { useAuthStore } from './auth';
import { showToast, notifyIfHidden, shouldEmitBackgroundTaskNotice, showNotificationPromptToast } from '../utils/toast';
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
  kind: 'tool' | 'skill' | 'hook' | 'status';
}

/** Shape of the snapshot payload pushed from the backend on WS reconnect (stream_snapshot). */
export interface StreamSnapshotData {
  partialText: string;
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
    kind: 'tool' | 'skill' | 'hook' | 'status';
  }>;
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
function capThinkingCache(cache: Record<string, string>): Record<string, string> {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_THINKING_CACHE_SIZE) return cache;
  const keep = keys.slice(keys.length - MAX_THINKING_CACHE_SIZE);
  const next: Record<string, string> = {};
  for (const k of keep) next[k] = cache[k];
  return next;
}

function retainThinkingCacheForMessages(
  messagesByGroup: Record<string, Message[]>,
  cache: Record<string, string>,
): Record<string, string> {
  const aliveMessageIds = new Set<string>();
  for (const messages of Object.values(messagesByGroup)) {
    for (const m of messages) aliveMessageIds.add(m.id);
  }

  const next: Record<string, string> = {};
  for (const [messageId, content] of Object.entries(cache)) {
    if (aliveMessageIds.has(messageId)) next[messageId] = content;
  }
  return capThinkingCache(next);
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
  pendingThinking: Record<string, string>;
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
  sendMessage: (jid: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => Promise<void>;
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
  handleAgentStatus: (chatJid: string, agentId: string, status: AgentInfo['status'], name: string, prompt: string, resultSummary?: string, kind?: AgentInfo['kind']) => void;
  clearStreaming: (
    chatJid: string,
    options?: { preserveThinking?: boolean },
  ) => void;
  restoreActiveState: () => Promise<void>;
  handleStreamSnapshot: (chatJid: string, snapshot: StreamSnapshotData, agentId?: string) => void;
  // Sub-agent actions
  loadAgents: (jid: string) => Promise<void>;
  deleteAgentAction: (jid: string, agentId: string) => Promise<boolean>;
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  // Conversation agent actions
  reorderConversations: (jid: string, orderedIds: string[]) => void;
  createConversation: (jid: string, name: string, description?: string) => Promise<AgentInfo | null>;
  renameConversation: (jid: string, agentId: string, name: string) => Promise<boolean>;
  loadAgentMessages: (jid: string, agentId: string, loadMore?: boolean) => Promise<void>;
  sendAgentMessage: (jid: string, agentId: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => void;
  refreshAgentMessages: (jid: string, agentId: string) => Promise<void>;
  // Runner state sync
  handleRunnerState: (chatJid: string, state: string) => void;
  // IM binding actions
  loadAvailableImGroups: (jid: string) => Promise<AvailableImGroup[]>;
  bindImGroup: (jid: string, agentId: string, imJid: string, force?: boolean) => Promise<boolean>;
  unbindImGroup: (jid: string, agentId: string, imJid: string) => Promise<boolean>;
  bindMainImGroup: (jid: string, imJid: string, force?: boolean, activationMode?: string) => Promise<boolean>;
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
    (state.todos && state.todos.length > 0);
  if (!hasData) return null;
  return {
    ...state,
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    interrupted: true,
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

const MAX_STREAMING_TEXT = 8000;
const MAX_EVENT_LOG = 30;
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
      if (state && (state.partialText || state.activeTools.length > 0 || state.recentEvents.length > 0)) {
        stored[chatJid] = {
          partialText: state.partialText.slice(-4000), // cap size
          thinkingText: '',  // don't persist thinking
          isThinking: false,
          activeTools: state.activeTools,
          recentEvents: state.recentEvents.slice(-10),
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
      activeTools: entry.activeTools || [],
      recentEvents: entry.recentEvents || [],
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
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = true;
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
      }
      if (mergedThinking) {
        const combined = prev.thinkingText + mergedThinking;
        next.thinkingText = combined.length > MAX_STREAMING_TEXT ? combined.slice(-MAX_STREAMING_TEXT) : combined;
        next.isThinking = true;
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
  switch (event.eventType) {
    case 'text_delta': {
      const combined = prev.partialText + (event.text || '');
      next.partialText = combined.length > maxText ? combined.slice(-maxText) : combined;
      next.isThinking = false;
      break;
    }
    case 'thinking_delta': {
      const combined = prev.thinkingText + (event.text || '');
      next.thinkingText = combined.length > maxText ? combined.slice(-maxText) : combined;
      next.isThinking = true;
      break;
    }
    case 'tool_use_start': {
      next.isThinking = false;
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
  pendingThinking: {},
  clearing: {},
  agents: {},
  agentStreaming: {},
  activeAgentTab: (() => {
    try { return JSON.parse(sessionStorage.getItem('hc_activeAgentTabs') || '{}'); } catch { return {}; }
  })(),
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
          let nextPendingThinking = s.pendingThinking;
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
              const { [jid]: _, ...restPending } = s.pendingThinking;
              nextPendingThinking = restPending;
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
            pendingThinking: nextPendingThinking,
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

      const data = await api.post<{ success: boolean; messageId: string; timestamp: string }>('/api/messages', body);
      if (data.success) {
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
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
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
    try {
      await api.post<{ success: boolean; dividerMessageId: string }>(
        `/api/groups/${encodeURIComponent(jid)}/reset-session`,
        agentId ? { agentId } : undefined,
      );
      if (agentId) {
        // Agent-specific: clear agent streaming and refresh agent messages
        set((s) => {
          const nextStreaming = { ...s.agentStreaming };
          delete nextStreaming[agentId];
          const nextWaiting = { ...s.agentWaiting };
          delete nextWaiting[agentId];
          return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
        });
        await get().loadAgentMessages(jid, agentId);
      } else {
        get().clearStreaming(jid, { preserveThinking: false });
        // Refresh messages to pick up the divider message
        await get().refreshMessages(jid);
      }
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  clearHistory: async (jid: string) => {
    // Set clearing lock BEFORE the API call to block polling & WS injection
    set((s) => ({ clearing: { ...s.clearing, [jid]: true } }));

    try {
      await api.post<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/clear-history`,
      );

      set((s) => {
        // Delete the key entirely (not []==[]) so selectGroup/ChatView effect
        // will trigger loadMessages on re-entry
        const nextMessages = { ...s.messages };
        delete nextMessages[jid];
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[jid];
        const { [jid]: _pending, ...nextPendingThinking } = s.pendingThinking;
        const { [jid]: _clearing, ...nextClearing } = s.clearing;

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
          error: null,
        };
      });

      await get().loadGroups();
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
    if (event.eventType === 'text_delta' || event.eventType === 'thinking_delta') {
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
        applyStreamEvent(event, prev, next, 8000);
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
      const MAX_STREAMING_TEXT = 8000;
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
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        const updated = mergeMessagesChronologically(existing, [msg]);
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
      return;
    }

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
        // Agent 回复或系统错误：立即清除流式状态和等待标志，转移 thinking 缓存
        const streamState = s.streaming[chatJid];
        const thinkingText = isAgentReply
          ? (streamState?.thinkingText || s.pendingThinking[chatJid])
          : undefined;
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[chatJid];
        const nextPending = { ...s.pendingThinking };
        delete nextPending[chatJid];

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
          unreadReplies: nextUnread,
          ...(thinkingText ? { thinkingCache: capThinkingCache({ ...s.thinkingCache, [msg.id]: thinkingText }) } : {}),
        };
      }

      // 普通消息（如其他用户发送的消息，或显式 sdk_send_message）：只添加到列表
      return {
        messages: { ...s.messages, [chatJid]: updated },
      };
    });

    // 对话完成通知：浏览器通知（页面隐藏时）+ 首次引导开启权限
    const isAgentReplyFinal =
      msg.is_from_me &&
      msg.sender !== '__system__' &&
      source !== 'scheduled_task' &&
      msg.source_kind !== 'sdk_send_message' &&
      (msg.source_kind === 'sdk_final'
        || msg.source_kind === 'interrupt_partial'
        || msg.source_kind === null
        || msg.source_kind === undefined
        || msg.source_kind === 'legacy');

    if (isAgentReplyFinal) {
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
  handleAgentStatus: (chatJid, agentId, status, name, prompt, resultSummary?, kind?) => {
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
      const agentInfo: AgentInfo = {
        id: agentId,
        name,
        prompt,
        status,
        kind: resolvedKind,
        created_at: idx >= 0 ? existing[idx].created_at : new Date().toISOString(),
        completed_at: (status === 'completed' || status === 'error') ? new Date().toISOString() : undefined,
        result_summary: resultSummary,
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
      // Without this, Feishu-sourced messages (which skip sendAgentMessage) would
      // leave agentWaiting=false and cause all streaming events to be dropped.
      const nextAgentWaiting =
        (resolvedKind === 'conversation' || resolvedKind === 'spawn') && status === 'running'
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
  loadAgents: async (jid) => {
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
      clearSdkTaskCleanupTimer(agentId);
      clearSdkTaskStaleTimer(agentId);
      set((s) => {
        const updated = (s.agents[jid] || []).filter((a) => a.id !== agentId);
        const nextAgentStreaming = { ...s.agentStreaming };
        delete nextAgentStreaming[agentId];
        const nextActiveTab = { ...s.activeAgentTab };
        if (nextActiveTab[jid] === agentId) nextActiveTab[jid] = null;
        const nextSdkTasks = { ...s.sdkTasks };
        delete nextSdkTasks[agentId];
        const nextSdkTaskAliases = removeSdkTaskAliases(s.sdkTaskAliases, agentId);
        return {
          agents: { ...s.agents, [jid]: updated },
          agentStreaming: nextAgentStreaming,
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

  // 切换子 Agent 标签页（持久化到 sessionStorage，刷新后恢复）
  setActiveAgentTab: (jid, agentId) => {
    set((s) => ({
      activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
    }));
    try {
      const stored = JSON.parse(sessionStorage.getItem('hc_activeAgentTabs') || '{}');
      if (agentId) {
        stored[jid] = agentId;
      } else {
        delete stored[jid];
      }
      sessionStorage.setItem('hc_activeAgentTabs', JSON.stringify(stored));
    } catch { /* ignore */ }
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
      set((s) => {
        const merged = mergeMessagesChronologically(
          s.agentMessages[agentId] || [],
          sorted,
        );
        return {
          agentMessages: { ...s.agentMessages, [agentId]: merged },
          agentHasMore: { ...s.agentHasMore, [agentId]: data.hasMore },
        };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  sendAgentMessage: (jid, agentId, content, attachments?) => {
    // Clear agent streaming state before sending
    set((s) => {
      const next = { ...s.agentStreaming };
      delete next[agentId];
      return { agentStreaming: next };
    });
    // Send via WebSocket with agentId
    const normalizedAttachments = attachments && attachments.length > 0
      ? attachments.map(att => ({ type: 'image' as const, ...att }))
      : undefined;
    const sent = wsManager.send({ type: 'send_message', chatJid: jid, content, agentId, attachments: normalizedAttachments });
    if (!sent) {
      showToast('发送失败', 'WebSocket 未连接，请稍后重试');
      return;
    }
    set((s) => ({
      agentWaiting: { ...s.agentWaiting, [agentId]: true },
    }));
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
        set((s) => {
          const merged = mergeMessagesChronologically(
            s.agentMessages[agentId] || [],
            data.messages,
          );
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
      get().loadAgents(jid);
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
      get().loadAgents(jid);
      return true;
    } catch {
      return false;
    }
  },

  bindMainImGroup: async (jid, imJid, force, activationMode) => {
    try {
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/im-binding`,
        {
          im_jid: imJid,
          ...(force ? { force: true } : {}),
          ...(activationMode ? { activation_mode: activationMode } : {}),
        },
      );
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
      return true;
    } catch {
      return false;
    }
  },

  // 刷新/重连时恢复正在运行的 agent 状态
  restoreActiveState: async () => {
    try {
      const data = await api.get<{ groups: Array<{ jid: string; active: boolean; pendingMessages?: boolean }> }>('/api/status');
      set((s) => {
        const nextWaiting = { ...s.waiting };
        const nextStreaming = { ...s.streaming };

        // 构建后端已知的群组集合；不在集合中的 JID 说明后端无活跃进程
        // （pm2 restart 后 queue 为空，所有 JID 都不在集合中）。
        const knownJids = new Set(data.groups.map((g) => g.jid));

        // 清除后端不可见的 JID 的 waiting/streaming（进程已死）
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
      activeTools: (snapshot.activeTools || []).map((t) => ({
        toolName: t.toolName,
        toolUseId: t.toolUseId,
        startTime: t.startTime,
        toolInputSummary: t.toolInputSummary,
        parentToolUseId: t.parentToolUseId,
      })),
      recentEvents: (snapshot.recentEvents || []) as StreamingTimelineEvent[],
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
      const preserveThinking = options?.preserveThinking !== false;
      const nextPendingThinking = { ...s.pendingThinking };
      delete next[chatJid];
      if (preserveThinking && thinkingText) {
        nextPendingThinking[chatJid] = thinkingText;
      } else {
        delete nextPendingThinking[chatJid];
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
