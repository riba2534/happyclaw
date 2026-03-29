import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageBubble } from './MessageBubble';
import { StreamingDisplay } from './StreamingDisplay';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { Loader2, ChevronUp, ChevronDown, AlertTriangle, Square } from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Increment to force scroll to bottom (e.g. after sending a message) */
  scrollTrigger?: number;
  /** Current group JID — used to save/restore scroll position across group switches */
  groupJid?: string;
  /** Whether the agent is currently processing */
  isWaiting?: boolean;
  /** Callback to interrupt the current agent query */
  onInterrupt?: () => void;
  /** If set, this MessageList is showing a sub-agent's messages */
  agentId?: string;
  /** Callback to send a message (used for quick prompts in empty state) */
  onSend?: (content: string) => void;
}

type FlatItem =
  | { type: 'date'; content: string }
  | { type: 'divider'; content: string }
  | { type: 'spawn'; content: string }
  | { type: 'error'; content: string }
  | { type: 'message'; content: Message };

const quickPrompts = [
  '帮我分析一段代码',
  '写一个自动化脚本',
  '解释一个技术概念',
  '帮我调试一个问题',
];

export function MessageList({ messages, loading, hasMore, onLoadMore, scrollTrigger, groupJid, isWaiting, onInterrupt, agentId, onSend }: MessageListProps) {
  const { mode: displayMode } = useDisplayMode();
  const thinkingCache = useChatStore(s => s.thinkingCache ?? {});
  const isShared = useChatStore(s => !!s.groups[groupJid ?? '']?.is_shared);
  // Spawn agents: selector returns stable reference (the agents array itself),
  // then useMemo filters for spawn kind. Direct .filter() in selector causes
  // infinite re-render because Zustand sees a new array reference every time.
  const allAgentsForSpawn = useChatStore(s => groupJid ? s.agents[groupJid] : undefined);
  const spawnAgents = useMemo(
    () => (allAgentsForSpawn ?? []).filter(a => a.kind === 'spawn' && a.status === 'running'),
    [allAgentsForSpawn],
  );
  const currentUser = useAuthStore(s => s.user);
  const appearance = useAuthStore(s => s.appearance);
  const aiName = currentUser?.ai_name || appearance?.aiName || 'AI 助手';
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ autoScroll: true, atTop: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const prevMessageCount = useRef(messages.length);

  // Compute flatMessages (with date headers) before virtualizer
  const flatMessages = useMemo<FlatItem[]>(() => {
    const grouped = messages.reduce((acc, msg) => {
      const date = new Date(msg.timestamp).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!acc[date]) acc[date] = [];
      acc[date].push(msg);
      return acc;
    }, {} as Record<string, Message[]>);

    const items: FlatItem[] = [];
    Object.entries(grouped).forEach(([date, msgs]) => {
      items.push({ type: 'date', content: date });
      msgs.forEach((msg) => {
        if (msg.sender === '__system__') {
          if (msg.content === 'context_reset') {
            items.push({ type: 'divider', content: '上下文已清除' });
          } else if (msg.content === 'query_interrupted') {
            items.push({ type: 'divider', content: '已中断' });
          } else if (msg.content.startsWith('agent_error:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_error:'.length) });
          } else if (msg.content.startsWith('agent_max_retries:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_max_retries:'.length) });
          } else if (msg.content.startsWith('system_info:')) {
            items.push({ type: 'divider', content: msg.content.slice('system_info:'.length) });
          }
        } else if (!msg.is_from_me && /^\/(sw|spawn)\s+/i.test(msg.content)) {
          // /sw or /spawn commands render as compact spawn-task cards
          items.push({ type: 'spawn', content: msg.content.replace(/^\/(sw|spawn)\s+/i, '') });
        } else {
          items.push({ type: 'message', content: msg });
        }
      });
    });
    return items;
  }, [messages]);

  // Chat always starts at bottom — no scroll position restoration.
  // key={...} on <MessageList> guarantees a fresh mount on group/tab switch.
  const virtualizer = useVirtualizer({
    count: flatMessages.length,
    getScrollElement: () => parentRef.current,
    initialOffset: flatMessages.length > 0 ? 99999999 : 0,
    getItemKey: (index) => {
      const item = flatMessages[index];
      if (!item) return index;
      switch (item.type) {
        case 'date': return `date-${item.content}`;
        case 'divider': return `div-${index}`;
        case 'spawn': return `spawn-${index}`;
        case 'error': return `err-${index}`;
        case 'message': return item.content.id;
      }
    },
    estimateSize: (index) => {
      const item = flatMessages[index];
      if (!item) return 100;
      switch (item.type) {
        case 'date': return 48;
        case 'divider':
        case 'spawn':
        case 'error': return 56;
        case 'message': {
          const len = item.content.content.length;
          if (item.content.is_from_me) {
            // AI messages often contain markdown tables, code blocks, and
            // structured content that renders much taller than plain text.
            // A low cap causes the virtualizer to miscalculate total height,
            // leading to scroll position oscillation (visible flickering).
            return Math.max(80, Math.ceil(len / 40) * 24 + 80);
          }
          return Math.max(48, Math.min(200, Math.ceil(len / 80) * 24 + 40));
        }
        default: return 100;
      }
    },
    overscan: window.innerWidth < 1024 ? 12 : 8,
  });

  // 检测向上滚动触发 loadMore + 保存滚动位置
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = parent;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
      const isAtTop = scrollTop < 50;

      // Only trigger setState when value actually changes
      if (scrollStateRef.current.autoScroll !== isAtBottom) {
        scrollStateRef.current.autoScroll = isAtBottom;
        setAutoScroll(isAtBottom);
      }
      if (scrollStateRef.current.atTop !== isAtTop) {
        scrollStateRef.current.atTop = isAtTop;
        setAtTop(isAtTop);
      }

      if (scrollTop < 100 && hasMore && !loading) {
        onLoadMore();
      }
    };

    parent.addEventListener('scroll', handleScroll);
    return () => parent.removeEventListener('scroll', handleScroll);
  }, [hasMore, loading, onLoadMore, groupJid]);

  // 新消息自动滚到底部
  useEffect(() => {
    if (autoScroll && messages.length > prevMessageCount.current) {
      requestAnimationFrame(() => {
        parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, autoScroll]);

  // 外部触发滚到底部（发送消息后）
  useEffect(() => {
    if (scrollTrigger && scrollTrigger > 0) {
      setAutoScroll(true);
      requestAnimationFrame(() => {
        parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [scrollTrigger]);

  // Fallback: 消息在挂载后加载（首次页面加载时 store 为空）
  // initialOffset 只在挂载时生效，消息后加载需要手动定位
  const initialScrollDone = useRef(flatMessages.length > 0);
  useLayoutEffect(() => {
    if (!initialScrollDone.current && flatMessages.length > 0) {
      initialScrollDone.current = true;
      prevMessageCount.current = messages.length;
      virtualizer.scrollToIndex(flatMessages.length - 1, { align: 'end' });
      if (parentRef.current) {
        parentRef.current.scrollTop = parentRef.current.scrollHeight;
      }
      setAutoScroll(true);
      // 4-frame rAF chain (~66ms) to wait for measureElement to complete
      let handle: number;
      const correct = (depth: number) => {
        handle = requestAnimationFrame(() => {
          if (parentRef.current) {
            parentRef.current.scrollTop = parentRef.current.scrollHeight;
          }
          if (depth < 3) correct(depth + 1);
        });
      };
      correct(0);
      return () => cancelAnimationFrame(handle);
    }
  }, [flatMessages.length, virtualizer, messages.length]);

  // Safety net: initialOffset relies on estimated sizes which may be inaccurate.
  // After mount (or when messages load asynchronously), verify we're actually at
  // the bottom and correct if not. Depends on flatMessages.length so that async
  // message loading triggers a fresh round of corrections.
  useEffect(() => {
    if (flatMessages.length === 0) return;
    const timers: number[] = [];
    for (const delay of [50, 150, 300, 500]) {
      timers.push(window.setTimeout(() => {
        const el = parentRef.current;
        if (!el) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap > 100) {
          el.scrollTop = el.scrollHeight;
        }
      }, delay));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatMessages.length]);

  // Auto-scroll when streaming content is active — poll-based to avoid
  // re-rendering on every text_delta (the streaming object changes very frequently).
  const hasStreaming = useChatStore(s =>
    agentId ? !!s.agentStreaming[agentId] : !!s.streaming[groupJid ?? '']
  );
  useEffect(() => {
    if (!autoScroll || !hasStreaming) return;
    const id = setInterval(() => {
      parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight });
    }, 100);
    return () => clearInterval(id);
  }, [hasStreaming, autoScroll]);

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
  }, []);

  const showScrollButtons = messages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden py-6 bg-background"
      >
        <div className={displayMode === 'compact' ? 'mx-auto px-4 min-w-0' : 'max-w-4xl mx-auto px-4 min-w-0'}>
        {loading && hasMore && (
          <div className="flex justify-center py-4">
            <Loader2 className="animate-spin text-primary" size={24} />
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatMessages[virtualItem.index];
            if (!item) return null;

            if (item.type === 'date') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex justify-center my-6">
                    <span className="bg-card px-4 py-1 rounded-full text-xs text-muted-foreground border border-border">
                      {item.content}
                    </span>
                  </div>
                </div>
              );
            }

            if (item.type === 'divider') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-amber-300" />
                    <span className="text-xs text-amber-600 whitespace-pre-wrap">
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-amber-300" />
                  </div>
                </div>
              );
            }

            if (item.type === 'spawn') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-2 my-4 px-4">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-50 dark:bg-violet-950/40 text-xs text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800">
                      <span>⚡</span>
                      <span className="font-medium">并行任务</span>
                      <span className="text-violet-400 dark:text-violet-500">|</span>
                      <span className="max-w-[400px] truncate">{item.content}</span>
                    </span>
                  </div>
                </div>
              );
            }

            if (item.type === 'error') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-red-300" />
                    <span className="text-xs text-red-600 whitespace-pre-wrap flex items-center gap-1">
                      <AlertTriangle size={14} />
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-red-300" />
                  </div>
                </div>
              );
            }

            const message = item.content;
            const showTime = true;

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
              >
                <MessageBubble message={message} showTime={showTime} thinkingContent={thinkingCache[message.id]} isShared={isShared} />
              </div>
            );
          })}
        </div>

        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full px-6">
            <div className="max-w-sm w-full space-y-6">
              {/* AI avatar + welcome */}
              <div className="flex flex-col items-center text-center space-y-3">
                <div className="w-16 h-16">
                  <EmojiAvatar
                    imageUrl={aiImageUrl}
                    emoji={aiEmoji}
                    color={aiColor}
                    fallbackChar={aiName[0]}
                    size="lg"
                    className="!w-16 !h-16 !text-2xl"
                  />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">{aiName}</h3>
                  <p className="text-sm text-muted-foreground mt-1">有什么我可以帮你的吗？</p>
                </div>
              </div>

              {/* Quick prompts */}
              {onSend && (
                <div className="space-y-2">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => onSend(prompt)}
                      className="w-full text-left px-4 py-3 rounded-xl text-sm text-foreground transition-all active:scale-[0.98] cursor-pointer bg-card/60 backdrop-blur-sm border border-border/60 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:bg-card/80 hover:shadow-[0_4px_12px_rgba(0,0,0,0.06)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {groupJid && !agentId && (
          <StreamingDisplay groupJid={groupJid} isWaiting={!!isWaiting} />
        )}
        {groupJid && agentId && (
          <StreamingDisplay groupJid={groupJid} isWaiting={!!isWaiting} agentId={agentId} />
        )}

        {/* Inline streaming for spawn agents — parallel tasks in same chat */}
        {groupJid && !agentId && spawnAgents.map(a => (
          <StreamingDisplay key={a.id} groupJid={groupJid} isWaiting={true} agentId={a.id} senderName={a.name} />
        ))}

        </div>
      </div>

      {/* Floating interrupt button — positioned outside scroll content to avoid
          layout shift when textarea height changes (container resize would
          briefly hide the button if it lived inside scroll content). */}
      {isWaiting && onInterrupt && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
          <button
            type="button"
            onClick={onInterrupt}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground hover:text-red-600 dark:hover:text-red-400 bg-card/90 backdrop-blur-sm hover:bg-red-50 dark:hover:bg-red-950/40 rounded-full border border-border shadow-sm transition-colors cursor-pointer"
          >
            <Square className="w-3 h-3" />
            中断
          </button>
        </div>
      )}

      {/* Floating scroll buttons */}
      {showScrollButtons && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-1.5">
          {!atTop && (
            <button
              onClick={scrollToTop}
              className="w-10 h-10 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="w-10 h-10 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              title="回到底部"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
