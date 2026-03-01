import { create } from 'zustand';
import { api } from '../api/client';
import { wsManager } from '../api/ws';
import { useFileStore } from './files';
import { useAuthStore } from './auth';
import { showToast, notifyIfHidden, shouldEmitBackgroundTaskNotice } from '../utils/toast';
import type { GroupInfo, AgentInfo } from '../types';

export type { GroupInfo, AgentInfo };

export interface Message {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  attachments?: string;
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

export interface StreamingState {
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
  }>;
  activeHook: { hookName: string; hookEvent: string } | null;
  systemStatus: string | null;
  recentEvents: StreamingTimelineEvent[];
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
    if (!old || old.content !== m.content || old.timestamp !== m.timestamp) {
      byId.set(m.id, m);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
    return a.timestamp.localeCompare(b.timestamp);
  });
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
  resetSession: (jid: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  createFlow: (name: string, options?: { execution_mode?: 'container' | 'host'; custom_cwd?: string; init_source_path?: string; init_git_url?: string }) => Promise<{ jid: string; folder: string } | null>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  deleteFlow: (jid: string) => Promise<void>;
  handleStreamEvent: (chatJid: string, event: StreamEvent, agentId?: string) => void;
  handleWsNewMessage: (chatJid: string, wsMsg: any, agentId?: string) => void;
  handleAgentStatus: (chatJid: string, agentId: string, status: AgentInfo['status'], name: string, prompt: string, resultSummary?: string, kind?: AgentInfo['kind']) => void;
  clearStreaming: (
    chatJid: string,
    options?: { preserveThinking?: boolean },
  ) => void;
  restoreActiveState: () => Promise<void>;
  // Sub-agent actions
  loadAgents: (jid: string) => Promise<void>;
  deleteAgentAction: (jid: string, agentId: string) => Promise<boolean>;
  setActiveAgentTab: (jid: string, agentId: string | null) => void;
  // Conversation agent actions
  createConversation: (jid: string, name: string, description?: string) => Promise<AgentInfo | null>;
  loadAgentMessages: (jid: string, agentId: string, loadMore?: boolean) => Promise<void>;
  sendAgentMessage: (jid: string, agentId: string, content: string) => void;
  refreshAgentMessages: (jid: string, agentId: string) => Promise<void>;
}

const DEFAULT_STREAMING_STATE: StreamingState = {
  partialText: '', thinkingText: '', isThinking: false,
  activeTools: [], activeHook: null, systemStatus: null, recentEvents: [],
};

const MAX_EVENT_LOG = 30;
const SDK_TASK_AUTO_CLOSE_MS = 3000;
const SDK_TASK_TOOL_END_FALLBACK_CLOSE_MS = 1200;
const SDK_TASK_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes stale timeout for non-teammate tasks
const sdkTaskCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sdkTaskStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 兜底路由支持的事件类型（模块级常量，避免热路径上重复创建 Set）
const FALLBACK_EVENT_TYPES: Set<StreamEventType> = new Set([
  'text_delta', 'thinking_delta',
  'tool_use_start', 'tool_use_end', 'tool_progress',
  'hook_started', 'hook_progress', 'hook_response',
  'status',
]);

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
      scheduleSdkTaskCleanup(set, taskId, chatJid, SDK_TASK_AUTO_CLOSE_MS, get);
    }
  }, SDK_TASK_STALE_TIMEOUT_MS);
  sdkTaskStaleTimers.set(taskId, timer);
}

const SDK_TASK_VIEWING_CLOSE_MS = 8000; // 用户正在查看标签页时延长关闭延迟

function doSdkTaskCleanup(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  taskId: string,
  chatJid: string,
): void {
  sdkTaskCleanupTimers.delete(taskId);
  clearSdkTaskStaleTimer(taskId);
  set((s) => {
    const isTeammate = s.sdkTasks[taskId]?.isTeammate || false;
    const nextSdkTasks = { ...s.sdkTasks };
    delete nextSdkTasks[taskId];
    const nextStreaming = { ...s.agentStreaming };
    delete nextStreaming[taskId];
    const nextAliases = removeSdkTaskAliases(s.sdkTaskAliases, taskId);

    // 非 teammate：不清理 agents[] 和 activeAgentTab（它们本就没被写入）
    if (!isTeammate) {
      return {
        sdkTasks: nextSdkTasks,
        sdkTaskAliases: nextAliases,
        agentStreaming: nextStreaming,
      };
    }

    // Teammate：完整清理
    const nextActiveTab = { ...s.activeAgentTab };
    if (nextActiveTab[chatJid] === taskId) nextActiveTab[chatJid] = null;
    return {
      sdkTasks: nextSdkTasks,
      sdkTaskAliases: nextAliases,
      agents: { ...s.agents, [chatJid]: (s.agents[chatJid] || []).filter(a => a.id !== taskId) },
      agentStreaming: nextStreaming,
      activeAgentTab: nextActiveTab,
    };
  });
}

function scheduleSdkTaskCleanup(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  taskId: string,
  chatJid: string,
  delayMs = SDK_TASK_AUTO_CLOSE_MS,
  get?: () => ChatState,
): void {
  clearSdkTaskCleanupTimer(taskId);
  const timer = setTimeout(() => {
    // 如果用户正在查看该标签页，每 SDK_TASK_VIEWING_CLOSE_MS 重新检查一次。
    // 用户切走后 setActiveAgentTab 会立即清理已完成的 Task，因此不会无限挂起。
    if (get) {
      const state = get();
      if (state.activeAgentTab[chatJid] === taskId) {
        scheduleSdkTaskCleanup(set, taskId, chatJid, SDK_TASK_VIEWING_CLOSE_MS, get);
        return;
      }
    }
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
    case 'status': {
      next.systemStatus = event.statusText || null;
      if (event.statusText) {
        next.recentEvents = pushEvent(prev.recentEvents, 'status', `状态: ${event.statusText}`);
      }
      break;
    }
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
  activeAgentTab: {},
  sdkTasks: {},
  sdkTaskAliases: {},
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},

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
          latest.is_from_me === false;
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
          // Check if agent has replied (any new message with is_from_me=true)
          const agentReplied = data.messages.some(
            (m) => m.is_from_me && m.sender !== '__system__',
          );
          const hasSystemError = data.messages.some(
            (m) => m.sender === '__system__' &&
              (
                m.content.startsWith('agent_error:') ||
                m.content.startsWith('agent_max_retries:') ||
                m.content.startsWith('context_overflow:') ||
                m.content === 'query_interrupted'
              )
          );

          // Transfer pending thinking to thinkingCache
          let nextThinkingCache = s.thinkingCache;
          let nextPendingThinking = s.pendingThinking;
          if (agentReplied && s.pendingThinking[jid]) {
            const lastAiMsg = [...data.messages]
              .reverse()
              .find((m) => m.is_from_me && m.sender !== '__system__');
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
        set((s) => ({
          messages: {
            ...s.messages,
            [jid]: (s.messages[jid] || []).some((m) => m.id === msg.id)
              ? (s.messages[jid] || [])
              : [...(s.messages[jid] || []), msg],
          },
          waiting: { ...s.waiting, [jid]: true },
          error: null,
        }));
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
        set({ error: 'No active query to interrupt' });
        return false;
      }

      // Agent conversation JIDs contain #agent:{agentId}
      const agentSep = jid.indexOf('#agent:');
      if (agentSep >= 0) {
        const agentId = jid.slice(agentSep + 7);
        set((s) => {
          const nextStreaming = { ...s.agentStreaming };
          delete nextStreaming[agentId];
          const nextWaiting = { ...s.agentWaiting };
          delete nextWaiting[agentId];
          return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
        });
      } else {
        get().clearStreaming(jid, { preserveThinking: false });
        set((s) => {
          const next = { ...s.waiting };
          delete next[jid];
          return { waiting: next };
        });
      }
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  resetSession: async (jid: string) => {
    try {
      await api.post<{ success: boolean; dividerMessageId: string }>(
        `/api/groups/${encodeURIComponent(jid)}/reset-session`,
      );
      get().clearStreaming(jid, { preserveThinking: false });
      // Refresh messages to pick up the divider message
      await get().refreshMessages(jid);
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
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  // 处理流式事件
  handleStreamEvent: (chatJid, event, agentId?) => {
    // Skip while clearHistory is in-flight
    if (get().clearing[chatJid]) return;

    // ① conversation agent（DB 持久化的）— 已有逻辑不变
    if (agentId) {
      if (event.eventType === 'status' && event.statusText === 'interrupted') {
        set((s) => {
          const nextStreaming = { ...s.agentStreaming };
          delete nextStreaming[agentId];
          const nextWaiting = { ...s.agentWaiting };
          delete nextWaiting[agentId];
          return { agentStreaming: nextStreaming, agentWaiting: nextWaiting };
        });
        return;
      }
      set((s) => {
        const prev = s.agentStreaming[agentId] || { ...DEFAULT_STREAMING_STATE };
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

        const nextSdkTasks = {
          ...s.sdkTasks,
          [taskId]: {
            chatJid,
            description: desc,
            status: 'running' as const,
            summary: existingTask?.summary,
            startedAt: existingTask?.startedAt || Date.now(),
            ...(teammate ? { isTeammate: true } : {}),
          },
        };

        // 仅 Teammate Task 创建标签页（写入 agents[]）
        if (!teammate) {
          return { sdkTasks: nextSdkTasks };
        }

        const agents = s.agents[chatJid] || [];
        const idx = agents.findIndex(a => a.id === taskId);
        const nextAgent: AgentInfo = {
          id: taskId,
          name: desc.slice(0, 40),
          prompt: desc,
          status: 'running',
          kind: 'task',
          created_at: idx >= 0 ? agents[idx].created_at : new Date().toISOString(),
        };
        const updatedAgents = idx >= 0
          ? agents.map((a, i) => (i === idx ? { ...a, ...nextAgent } : a))
          : [...agents, nextAgent];

        return {
          sdkTasks: nextSdkTasks,
          agents: { ...s.agents, [chatJid]: updatedAgents },
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
      let targetChatJid: string | null = null;
      set((s) => {
        const existingTask = s.sdkTasks[taskId];
        const taskChatJid = existingTask?.chatJid || chatJid;
        const isTeammate = existingTask?.isTeammate || false;

        if (!isTeammate) {
          // 非 teammate：只更新 sdkTasks，不触碰 agents[]
          if (!existingTask) return {};
          targetChatJid = taskChatJid;
          return {
            sdkTasks: {
              ...s.sdkTasks,
              [taskId]: {
                chatJid: taskChatJid,
                description: existingTask.description,
                status,
                summary: summary ?? existingTask.summary,
              },
            },
          };
        }

        // Teammate Task：更新 sdkTasks + agents[]
        const agents = s.agents[taskChatJid] || [];
        const idx = agents.findIndex(a => a.id === taskId && a.kind === 'task');
        if (!existingTask && idx < 0) return {};

        const desc = existingTask?.description
          || (idx >= 0 ? (agents[idx].prompt || agents[idx].name) : 'Task');
        const nextAgents = idx >= 0
          ? agents.map((a, i) => (
            i === idx
              ? {
                  ...a,
                  status,
                  completed_at: new Date().toISOString(),
                  ...(summary ? { result_summary: summary } : {}),
                }
              : a
          ))
          : [
              ...agents,
              {
                id: taskId,
                name: desc.slice(0, 40),
                prompt: desc,
                status,
                kind: 'task' as const,
                created_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                ...(summary ? { result_summary: summary } : {}),
              },
            ];
        targetChatJid = taskChatJid;
        return {
          sdkTasks: {
            ...s.sdkTasks,
            [taskId]: {
              chatJid: taskChatJid,
              description: desc,
              status,
              summary: summary ?? existingTask?.summary,
              isTeammate: true,
            },
          },
          agents: { ...s.agents, [taskChatJid]: nextAgents },
        };
      });
      if (targetChatJid) {
        scheduleSdkTaskCleanup(set, taskId, targetChatJid, closeAfterMs, get);
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

    // ④ parentToolUseId 匹配虚拟 Agent → 路由到 subagent streaming
    if (event.parentToolUseId) {
      const tid = resolveOrBindTaskId(event.parentToolUseId);
      const state = get();
      const taskFromDb = (state.agents[chatJid] || []).find(a => a.id === tid && a.kind === 'task');
      const knownTask = !!state.sdkTasks[tid] || !!taskFromDb;
      if (knownTask) {
        if (!state.sdkTasks[tid]) {
          ensureSdkTask(tid, taskFromDb?.prompt || taskFromDb?.name);
        }
        // Reset stale timer — task is still active
        const task = state.sdkTasks[tid];
        if (task && !task.isTeammate) {
          resetSdkTaskStaleTimer(set, get, tid, chatJid);
        }
        set((s) => {
          const prev = s.agentStreaming[tid] || { ...DEFAULT_STREAMING_STATE };
          const next = { ...prev };
          applyStreamEvent(event, prev, next, 8000);
          return { agentStreaming: { ...s.agentStreaming, [tid]: next } };
        });
        return;
      }
    }

    // ④.5 兜底路由：无 parentToolUseId 时，如果只有 1 个运行中的 **非 Teammate** SDK Task，
    // 将事件同时应用到该 Task 的 agentStreaming（不 return，仍落入主对话）。
    // 限制条件：仅单 Task 运行时生效，避免多 Task 并发时误路由；
    // 排除 Teammate Task（Teammate 的事件由 agent-runner 子 Agent 消息转换提供，无需兜底）。
    if (!event.parentToolUseId && event.eventType !== 'task_start' && event.eventType !== 'task_notification') {
      if (FALLBACK_EVENT_TYPES.has(event.eventType)) {
        const state = get();
        const runningNonTeammateTaskIds = Object.entries(state.sdkTasks)
          .filter(([, task]) => task.chatJid === chatJid && task.status === 'running' && !task.isTeammate)
          .map(([id]) => id);
        if (runningNonTeammateTaskIds.length === 1) {
          const tid = runningNonTeammateTaskIds[0];
          // Reset stale timer — task is still active (fallback-routed events)
          resetSdkTaskStaleTimer(set, get, tid, chatJid);
          set((s) => {
            const prev = s.agentStreaming[tid] || { ...DEFAULT_STREAMING_STATE };
            const next = { ...prev };
            applyStreamEvent(event, prev, next, 8000);
            return { agentStreaming: { ...s.agentStreaming, [tid]: next } };
          });
          // 不 return — 事件同时在主对话中显示
        }
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

    // 中断事件需要在所有客户端显式收尾，避免 waiting 残留。
    if (event.eventType === 'status' && event.statusText === 'interrupted') {
      set((s) => {
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[chatJid];
        const nextPendingThinking = { ...s.pendingThinking };
        delete nextPendingThinking[chatJid];
        const nextWaiting = { ...s.waiting };
        delete nextWaiting[chatJid];
        return {
          waiting: nextWaiting,
          streaming: nextStreaming,
          pendingThinking: nextPendingThinking,
        };
      });
      return;
    }

    // ⑥ 主对话 streaming — 使用 applyStreamEvent 共享函数
    set((s) => {
      const MAX_STREAMING_TEXT = 8000;
      const prev = s.streaming[chatJid] || { ...DEFAULT_STREAMING_STATE };
      const next = { ...prev };
      applyStreamEvent(event, prev, next, MAX_STREAMING_TEXT);
      return {
        waiting: { ...s.waiting, [chatJid]: true },
        streaming: { ...s.streaming, [chatJid]: next },
      };
    });
  },

  // 通过 WebSocket new_message 事件立即添加消息（避免轮询延迟导致消息"丢失"）
  handleWsNewMessage: (chatJid, wsMsg, agentId?) => {
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
    };

    // Route to agentMessages if this is a conversation agent message
    if (agentId) {
      set((s) => {
        const existing = s.agentMessages[agentId] || [];
        const alreadyExists = existing.some((m) => m.id === wsMsg.id);
        const updated = alreadyExists ? existing : [...existing, msg];
        const isAgentReply = msg.is_from_me && msg.sender !== '__system__';

        const nextAgentStreaming = isAgentReply
          ? (() => { const n = { ...s.agentStreaming }; delete n[agentId]; return n; })()
          : s.agentStreaming;

        return {
          agentMessages: { ...s.agentMessages, [agentId]: updated },
          agentWaiting: isAgentReply
            ? { ...s.agentWaiting, [agentId]: false }
            : s.agentWaiting,
          agentStreaming: nextAgentStreaming,
        };
      });
      return;
    }

    set((s) => {
      const existing = s.messages[chatJid] || [];

      // 消息已存在时保留原顺序，仅执行状态收尾（清 waiting/streaming）
      const alreadyExists = existing.some((m) => m.id === wsMsg.id);
      const updated = alreadyExists ? existing : [...existing, msg];

      const isAgentReply = msg.is_from_me && msg.sender !== '__system__';
      const isSystemError =
        msg.sender === '__system__' &&
        (msg.content.startsWith('agent_error:') ||
          msg.content.startsWith('agent_max_retries:') ||
          msg.content.startsWith('context_overflow:') ||
          msg.content === 'query_interrupted');

      if (isAgentReply || isSystemError) {
        // Agent 回复或系统错误：立即清除流式状态和等待标志，转移 thinking 缓存
        const streamState = s.streaming[chatJid];
        const thinkingText = isAgentReply
          ? (streamState?.thinkingText || s.pendingThinking[chatJid])
          : undefined;
        const nextStreaming = { ...s.streaming };
        delete nextStreaming[chatJid];
        const nextPending = { ...s.pendingThinking };
        delete nextPending[chatJid];

        return {
          messages: { ...s.messages, [chatJid]: updated },
          waiting: { ...s.waiting, [chatJid]: false },
          streaming: nextStreaming,
          pendingThinking: nextPending,
          ...(thinkingText ? { thinkingCache: capThinkingCache({ ...s.thinkingCache, [msg.id]: thinkingText }) } : {}),
        };
      }

      // 普通消息（如其他用户发送的消息）：只添加到列表
      return {
        messages: { ...s.messages, [chatJid]: updated },
      };
    });
  },

  // 处理子 Agent 状态变更事件
  handleAgentStatus: (chatJid, agentId, status, name, prompt, resultSummary?, kind?) => {
    set((s) => {
      const existing = s.agents[chatJid] || [];

      // '__removed__' signal: agent has been cleaned up, remove from list
      if (resultSummary === '__removed__') {
        clearSdkTaskCleanupTimer(agentId);
        clearSdkTaskStaleTimer(agentId);
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
          clearSdkTaskCleanupTimer(agentId);
          clearSdkTaskStaleTimer(agentId);
          delete nextSdkTasks[agentId];
          nextSdkTaskAliases = removeSdkTaskAliases(nextSdkTaskAliases, agentId);
        } else if (nextSdkTasks[agentId]) {
          nextSdkTasks[agentId] = {
            ...nextSdkTasks[agentId],
            chatJid,
            description: prompt,
            status: 'running',
          };
        }
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
  loadAgents: async (jid) => {
    try {
      const data = await api.get<{ agents: AgentInfo[] }>(
        `/api/groups/${encodeURIComponent(jid)}/agents`,
      );
      set((s) => {
        const visibleAgents = data.agents.filter((a) => a.kind === 'conversation' || a.status === 'running');
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

        return {
          agents: { ...s.agents, [jid]: visibleAgents },
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

  // 切换子 Agent 标签页
  setActiveAgentTab: (jid, agentId) => {
    const prev = get().activeAgentTab[jid];
    set((s) => ({
      activeAgentTab: { ...s.activeAgentTab, [jid]: agentId },
    }));
    // 切走已完成的 SDK Task 时立即清理
    if (prev && prev !== agentId) {
      const task = get().sdkTasks[prev];
      if (task && task.status !== 'running') {
        clearSdkTaskCleanupTimer(prev);
        doSdkTaskCleanup(set, prev, jid);
      }
    }
  },

  // -- Conversation agent actions --

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

  sendAgentMessage: (jid, agentId, content) => {
    // Clear agent streaming state before sending
    set((s) => {
      const next = { ...s.agentStreaming };
      delete next[agentId];
      return { agentStreaming: next };
    });
    // Send via WebSocket with agentId
    wsManager.send({ type: 'send_message', chatJid: jid, content, agentId });
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
            (m) => m.is_from_me && m.sender !== '__system__',
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
            continue;
          }
          // active 可能仅表示 runner 空闲存活，这里回退到消息语义推断。
          const msgs = s.messages[g.jid] || [];
          const latest = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const inferredWaiting =
            !!latest &&
            latest.sender !== '__system__' &&
            latest.is_from_me === false;
          if (inferredWaiting) {
            nextWaiting[g.jid] = true;
          } else {
            delete nextWaiting[g.jid];
          }
        }
        return { waiting: nextWaiting, streaming: nextStreaming };
      });
    } catch {
      // 静默失败
    }
  },

  // 清除流式状态
  clearStreaming: (chatJid, options) => {
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
      return {
        waiting: { ...s.waiting, [chatJid]: false },
        streaming: next,
        pendingThinking: nextPendingThinking,
      };
    });
  },
}));
