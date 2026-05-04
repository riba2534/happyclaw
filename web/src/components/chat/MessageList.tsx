import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageBubble } from './MessageBubble';
import { StreamingDisplay } from './StreamingDisplay';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { Loader2, ChevronUp, ChevronDown, AlertTriangle, Square, Code2, Zap, BookOpen, Wrench } from 'lucide-react';
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
  { icon: Code2, title: '分析代码', desc: '帮我阅读和分析一段代码的逻辑' },
  { icon: Zap, title: '自动化脚本', desc: '编写一个自动化处理任务的脚本' },
  { icon: BookOpen, title: '技术概念', desc: '用简单的语言解释一个技术概念' },
  { icon: Wrench, title: '调试问题', desc: '帮我定位和修复一个 Bug' },
];

export function MessageList({ messages, loading, hasMore, onLoadMore, scrollTrigger, groupJid, isWaiting, onInterrupt, agentId, onSend }: MessageListProps) {
  const { mode: displayMode } = useDisplayMode();
  const thinkingCache = useChatStore(s => s.thinkingCache ?? {});
  const thinkingDurationCache = useChatStore(s => s.thinkingDurationCache ?? {});
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
  // Window during which the scroll handler ignores updates and the streaming
  // RAF skips its catch-up scroll, so a user-initiated smooth scroll can run
  // uninterrupted (≈500ms browser default + 100ms slack).
  const smoothScrollUntilRef = useRef(0);
  const smoothCatchUpTimerRef = useRef<number | null>(null);
  const SMOOTH_SCROLL_LOCK_MS = 600;

  const scheduleSmoothCatchUp = useCallback(() => {
    if (smoothCatchUpTimerRef.current !== null) {
      window.clearTimeout(smoothCatchUpTimerRef.current);
    }
    const delay = Math.max(0, smoothScrollUntilRef.current - Date.now()) + 16;
    smoothCatchUpTimerRef.current = window.setTimeout(() => {
      smoothCatchUpTimerRef.current = null;
      if (!scrollStateRef.current.autoScroll) return;
      const parent = parentRef.current;
      if (!parent) return;
      parent.scrollTo({ top: parent.scrollHeight });
    }, delay);
  }, []);

  useEffect(() => {
    return () => {
      if (smoothCatchUpTimerRef.current !== null) {
        window.clearTimeout(smoothCatchUpTimerRef.current);
      }
    };
  }, []);

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

  // Detect at-bottom (autoScroll) and at-top (loadMore) via the scroll event.
  // Critically, this fires only on actual scroll events — not when scrollHeight
  // grows during streaming with scrollTop unchanged. So content growth never
  // spuriously flips autoScroll off (the failure mode of the IntersectionObserver
  // approach in PR #455). The ref is updated synchronously to avoid races with
  // the streaming RAF catch-up.
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      // While a programmatic smooth scroll is animating, ignore intermediate
      // scroll events — they would briefly set autoScroll=false mid-animation
      // and flicker the floating "scroll to bottom" button.
      if (Date.now() < smoothScrollUntilRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = parent;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
      const isAtTop = scrollTop < 50;

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
        const parent = parentRef.current;
        if (!parent) return;
        smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
        scheduleSmoothCatchUp();
      });
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, autoScroll, scheduleSmoothCatchUp]);

  // 外部触发滚到底部（发送消息后）
  useEffect(() => {
    if (scrollTrigger && scrollTrigger > 0) {
      scrollStateRef.current.autoScroll = true;
      setAutoScroll(true);
      requestAnimationFrame(() => {
        const parent = parentRef.current;
        if (!parent) return;
        smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
        scheduleSmoothCatchUp();
      });
    }
  }, [scrollTrigger, scheduleSmoothCatchUp]);

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

  // Auto-scroll when streaming content is active. Subscribes directly to the
  // chat store (no React re-render) and schedules a single rAF-coalesced
  // scrollTo per animation frame, regardless of how many text_delta /
  // thinking_delta updates land. This replaces the 100ms setInterval poll
  // (PR #455 era) which competed with smooth scrolls and caused 3-4 visible
  // jumps when the user scrolled to the bottom mid-stream.
  const hasStreaming = useChatStore(s =>
    agentId ? !!s.agentStreaming[agentId] : !!s.streaming[groupJid ?? '']
  );
  useEffect(() => {
    if (!hasStreaming) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Yield to any in-progress smooth scroll so we don't snap-interrupt it.
        if (Date.now() < smoothScrollUntilRef.current) {
          scheduleSmoothCatchUp();
          return;
        }
        if (!scrollStateRef.current.autoScroll) return;
        const parent = parentRef.current;
        if (!parent) return;
        parent.scrollTo({ top: parent.scrollHeight });
      });
    };

    const readStreaming = (state: ReturnType<typeof useChatStore.getState>) =>
      agentId ? state.agentStreaming[agentId] : state.streaming[groupJid ?? ''];

    let prevText = readStreaming(useChatStore.getState())?.partialText ?? '';
    let prevThinking = readStreaming(useChatStore.getState())?.thinkingText ?? '';

    const unsubscribe = useChatStore.subscribe((state) => {
      const cur = readStreaming(state);
      const curText = cur?.partialText ?? '';
      const curThinking = cur?.thinkingText ?? '';
      if (curText !== prevText || curThinking !== prevThinking) {
        prevText = curText;
        prevThinking = curThinking;
        schedule();
      }
    });

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasStreaming, agentId, groupJid, scheduleSmoothCatchUp]);

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollStateRef.current.autoScroll = true;
    setAutoScroll(true);
    smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
    const parent = parentRef.current;
    if (!parent) return;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
    scheduleSmoothCatchUp();
  }, [scheduleSmoothCatchUp]);

  const showScrollButtons = messages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden py-6"
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
                    <span className="bg-surface px-4 py-1 rounded-full text-xs text-muted-foreground border border-border">
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
                <MessageBubble message={message} showTime={showTime} thinkingContent={thinkingCache[message.id]} thinkingDurationMs={thinkingDurationCache[message.id]} isShared={isShared} />
              </div>
            );
          })}
        </div>

        {messages.length === 0 && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
            <div className="max-w-lg w-full space-y-8">
              {/* Welcome header */}
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="relative w-16 h-16">
                  {/* Breathing glow ring */}
                  <div className="absolute inset-0 rounded-full bg-brand-200/40 dark:bg-brand-500/20 animate-[breathe_3s_ease-in-out_infinite]" />
                  {/* Orbiting dot */}
                  <div className="absolute inset-[-6px] animate-[orbit_6s_linear_infinite]">
                    <div className="w-2 h-2 rounded-full bg-brand-400" />
                  </div>
                  {/* Avatar */}
                  <div className="relative w-16 h-16 animate-[float_4s_ease-in-out_infinite]">
                    <EmojiAvatar
                      imageUrl={aiImageUrl}
                      emoji={aiEmoji}
                      color={aiColor}
                      fallbackChar={aiName[0]}
                      size="lg"
                      className="!w-16 !h-16 !text-2xl"
                    />
                  </div>
                </div>
                <div>
                  <h2 className="text-2xl font-semibold text-foreground">你好，有什么可以帮你？</h2>
                  <p className="text-sm text-muted-foreground mt-2">我是 {aiName}，你的 AI 助手。选择下方话题快速开始，或直接输入你的问题。</p>
                </div>
              </div>

              {/* Quick prompt cards — 2x2 grid */}
              {onSend && (
                <div className="grid grid-cols-2 gap-3">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt.title}
                      onClick={() => onSend(prompt.desc)}
                      className="group text-left p-4 rounded-2xl border border-border/60 bg-muted/30 hover:bg-muted/60 hover:border-border transition-all active:scale-[0.98] cursor-pointer"
                    >
                      <prompt.icon className="w-5 h-5 mb-2 text-muted-foreground" strokeWidth={1.75} />
                      <span className="text-sm font-medium text-foreground block">{prompt.title}</span>
                      <span className="text-xs text-muted-foreground mt-0.5 block">{prompt.desc}</span>
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
              className="w-8 h-8 rounded-full bg-foreground/5 backdrop-blur-sm flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-all cursor-pointer"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="w-8 h-8 rounded-full bg-foreground/5 backdrop-blur-sm flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-all cursor-pointer"
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
