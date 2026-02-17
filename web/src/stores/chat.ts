import { create } from 'zustand';
import { api } from '../api/client';
import { useFileStore } from './files';
import { useAuthStore } from './auth';
import type { GroupInfo } from '../types';

export type { GroupInfo };

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

// 流式事件类型定义
// ⚠️ 与 src/types.ts (后端) 和 container/agent-runner/src/index.ts 保持同步
export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'status' | 'init';

export interface StreamEvent {
  eventType: StreamEventType;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
}

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
  loadGroups: () => Promise<void>;
  selectGroup: (jid: string) => void;
  loadMessages: (jid: string, loadMore?: boolean) => Promise<void>;
  refreshMessages: (jid: string) => Promise<void>;
  sendMessage: (jid: string, content: string, attachments?: Array<{ data: string; mimeType: string }>) => Promise<void>;
  resetSession: (jid: string) => Promise<boolean>;
  clearHistory: (jid: string) => Promise<boolean>;
  createFlow: (name: string, options?: { execution_mode?: 'container' | 'host'; custom_cwd?: string; init_source_path?: string; init_git_url?: string }) => Promise<{ jid: string; folder: string } | null>;
  renameFlow: (jid: string, name: string) => Promise<void>;
  deleteFlow: (jid: string) => Promise<void>;
  handleStreamEvent: (chatJid: string, event: StreamEvent) => void;
  handleWsNewMessage: (chatJid: string, wsMsg: any) => void;
  clearStreaming: (
    chatJid: string,
    options?: { preserveThinking?: boolean },
  ) => void;
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
      set((s) => ({
        messages: {
          ...s.messages,
          [jid]: mergeMessagesChronologically(s.messages[jid] || [], sorted),
        },
        hasMore: { ...s.hasMore, [jid]: data.hasMore },
        error: null,
      }));
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
                m.content.startsWith('context_overflow:')
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
      set((s) => {
        const next = { ...s.streaming };
        delete next[jid];
        return { streaming: next };
      });

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
  handleStreamEvent: (chatJid, event) => {
    // Skip while clearHistory is in-flight
    if (get().clearing[chatJid]) return;

    set((s) => {
      const MAX_STREAMING_TEXT = 8000; // 限制内存中保留的流式文本长度
      const MAX_EVENT_LOG = 30; // 最近事件条数上限

      const pushEvent = (
        events: StreamingTimelineEvent[],
        kind: StreamingTimelineEvent['kind'],
        text: string,
      ): StreamingTimelineEvent[] => {
        const item: StreamingTimelineEvent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          kind,
          text,
        };
        return [...events, item].slice(-MAX_EVENT_LOG);
      };

      const prev = s.streaming[chatJid] || {
        partialText: '',
        thinkingText: '',
        isThinking: false,
        activeTools: [],
        activeHook: null,
        systemStatus: null,
        recentEvents: [],
      };
      const next = { ...prev };

      switch (event.eventType) {
        case 'text_delta': {
          const combined = prev.partialText + (event.text || '');
          next.partialText = combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
          next.isThinking = false;
          break;
        }
        case 'thinking_delta': {
          const combined = prev.thinkingText + (event.text || '');
          next.thinkingText = combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
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
            ? `技能 /${tool.skillName || 'unknown'}`
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
              const elapsedSec = ((Date.now() - ended.startTime) / 1000).toFixed(1);
              const isSkill = ended.toolName === 'Skill';
              const label = isSkill
                ? `技能 /${ended.skillName || 'unknown'}`
                : `工具 ${ended.toolName}`;
              next.recentEvents = pushEvent(prev.recentEvents, isSkill ? 'skill' : 'tool', `✓ ${label} (${elapsedSec}s)`);
            }
          } else {
            next.activeTools = [];
          }
          break;
        case 'tool_progress': {
          // tool_progress 可能在 tool_use_start 之后（正常），也可能独立到达
          // 如果工具已存在则更新，否则添加
          const existing = prev.activeTools.find(t => t.toolUseId === event.toolUseId);
          if (existing) {
            next.activeTools = prev.activeTools.map(t =>
              t.toolUseId === event.toolUseId
                ? { ...t, elapsedSeconds: event.elapsedSeconds }
                : t
            );
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

      return { streaming: { ...s.streaming, [chatJid]: next } };
    });
  },

  // 通过 WebSocket new_message 事件立即添加消息（避免轮询延迟导致消息"丢失"）
  handleWsNewMessage: (chatJid, wsMsg) => {
    if (!wsMsg || !wsMsg.id) return;
    // Skip while clearHistory is in-flight to prevent race re-injection
    if (get().clearing[chatJid]) return;

    set((s) => {
      const existing = s.messages[chatJid] || [];

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

      // 消息已存在时保留原顺序，仅执行状态收尾（清 waiting/streaming）
      const alreadyExists = existing.some((m) => m.id === wsMsg.id);
      const updated = alreadyExists ? existing : [...existing, msg];

      const isAgentReply = msg.is_from_me && msg.sender !== '__system__';
      const isSystemError =
        msg.sender === '__system__' &&
        (msg.content.startsWith('agent_error:') ||
          msg.content.startsWith('agent_max_retries:') ||
          msg.content.startsWith('context_overflow:'));

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

  // 清除流式状态
  clearStreaming: (chatJid, options) => {
    set((s) => {
      const next = { ...s.streaming };
      const thinkingText = next[chatJid]?.thinkingText;
      const preserveThinking = options?.preserveThinking !== false;
      delete next[chatJid];
      return {
        waiting: { ...s.waiting, [chatJid]: false },
        streaming: next,
        ...(preserveThinking && thinkingText
          ? { pendingThinking: { ...s.pendingThinking, [chatJid]: thinkingText } }
          : {}),
      };
    });
  },
}));
