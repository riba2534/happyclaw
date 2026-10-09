import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  memo,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, useChatStore } from '../../stores/chat';
import { MessageBubble } from './MessageBubble';
import { StreamingDisplay } from './StreamingDisplay';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { ErrorBoundary } from '../common';
import {
  Loader2,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Code2,
  Zap,
  BookOpen,
  Wrench,
} from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { resolveSystemMessage } from '../../lib/system-message-registry';
import {
  getPresentedMessageContent,
  isHeldBackgroundAcknowledgement,
} from '../../lib/message-presentation';
import {
  getMessageDisplayTimestamp,
  orderMessagesForTimeline,
} from '../../lib/message-timeline';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import { useAuthStore } from '../../stores/auth';
import { useShellStore } from '../../stores/shell';
import type { InteractionMode } from '../../types';

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
  /** If set, this MessageList is showing a sub-agent's messages */
  agentId?: string;
  /** Human-readable name of the active conversation for empty-state clarity */
  contextLabel?: string;
  /** Agent Profile identity for every conversation in this workspace */
  agentName?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
  interactionMode?: InteractionMode;
  /** Present when the viewer can send; empty-state starters then fill the composer. */
  onSend?: (content: string) => void;
}

type FlatItem =
  | { type: 'date'; content: string }
  | { type: 'divider'; content: string }
  | { type: 'spawn'; content: string }
  | { type: 'error'; content: string }
  | { type: 'message'; content: Message };

// Intl.DateTimeFormat construction is expensive; reuse one instance across all
// rows so flatMessages doesn't re-pay the cost per message on every re-group.
const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/**
 * Day label of a timestamp, formatted once per local calendar day: grouping
 * reruns over the whole history on every new message or usage update, and
 * formatting each of 5,000 dates took ~11ms of it.
 */
function dateLabel(timestamp: string, cache: Map<number, string>): string {
  const date = new Date(timestamp);
  const day =
    date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
  let label = cache.get(day);
  if (label === undefined) {
    label = DATE_LABEL_FORMATTER.format(date);
    cache.set(day, label);
  }
  return label;
}

const quickPrompts = [
  { icon: Code2, title: '分析代码', desc: '帮我阅读和分析一段代码的逻辑' },
  { icon: Zap, title: '自动化脚本', desc: '编写一个自动化处理任务的脚本' },
  { icon: BookOpen, title: '技术概念', desc: '用简单的语言解释一个技术概念' },
  { icon: Wrench, title: '调试问题', desc: '帮我定位和修复一个 Bug' },
];

// Memoized: ChatView re-renders for dialogs, panels and run status; the
// transcript and composer only need to when their own props change.
export const MessageList = memo(function MessageList({
  messages,
  loading,
  hasMore,
  onLoadMore,
  scrollTrigger,
  groupJid,
  isWaiting,
  agentId,
  contextLabel,
  agentName,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
  interactionMode = 'assistant',
  onSend,
}: MessageListProps) {
  const { mode: displayMode } = useDisplayMode();
  const requestComposerDraft = useShellStore((s) => s.requestComposerDraft);
  const thinkingCache = useChatStore((s) => s.thinkingCache ?? {});
  const thinkingDurationCache = useChatStore(
    (s) => s.thinkingDurationCache ?? {},
  );
  const hasWorkflowCard = useChatStore((state) => {
    const current = agentId
      ? state.agentStreaming[agentId]
      : state.streaming[groupJid ?? ''];
    return Object.values(current?.taskStates ?? {}).some(
      (task) => task.taskType === 'local_workflow' && task.workflowRun,
    );
  });
  // Spawn agents: selector returns stable reference (the agents array itself),
  // then useMemo filters for spawn kind. Direct .filter() in selector causes
  // infinite re-render because Zustand sees a new array reference every time.
  const allAgentsForSpawn = useChatStore((s) =>
    groupJid ? s.agents[groupJid] : undefined,
  );
  const spawnAgents = useMemo(
    () =>
      (allAgentsForSpawn ?? []).filter(
        (a) => a.kind === 'spawn' && a.status === 'running',
      ),
    [allAgentsForSpawn],
  );
  const appearance = useAuthStore((state) => state.appearance);
  const agentIdentity = resolveAgentDisplayIdentity({
    agentName,
    avatarUrl: agentAvatarUrl,
    avatarEmoji: agentAvatarEmoji,
    avatarColor: agentAvatarColor,
    mainAvatarUrl: appearance?.aiAvatarUrl,
    mainAvatarEmoji:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarEmoji
        : undefined,
    mainAvatarColor:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarColor
        : undefined,
  });
  const timelineMessages = useMemo(
    () => orderMessagesForTimeline(messages),
    [messages],
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ autoScroll: true, atTop: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const prevMessageCount = useRef(timelineMessages.length);
  // Window during which the scroll handler ignores updates and the streaming
  // RAF skips its catch-up scroll, so a user-initiated smooth scroll can run
  // uninterrupted (≈500ms browser default + 100ms slack).
  const smoothScrollUntilRef = useRef(0);
  const smoothCatchUpTimerRef = useRef<number | null>(null);
  const SMOOTH_SCROLL_LOCK_MS = 600;
  // While the first page settles, bottom pinning ignores scroll events caused
  // by rows measuring taller than estimated. Any user scroll ends it early.
  const settleUntilRef = useRef(0);

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
    const labels = new Map<number, string>();
    const grouped = timelineMessages.reduce(
      (acc, msg) => {
        const date = dateLabel(getMessageDisplayTimestamp(msg), labels);
        if (!acc[date]) acc[date] = [];
        acc[date].push(msg);
        return acc;
      },
      {} as Record<string, Message[]>,
    );

    const items: FlatItem[] = [];
    Object.entries(grouped).forEach(([date, msgs]) => {
      items.push({ type: 'date', content: date });
      msgs.forEach((msg) => {
        const messageHasRunningWorkflow = msg.workflow_runs?.some(
          (run) => run.status === 'running',
        );
        if (
          msg.is_from_me &&
          (hasWorkflowCard || messageHasRunningWorkflow) &&
          isHeldBackgroundAcknowledgement(msg.content)
        ) {
          // While the SDK Workflow is live, its structured card is the single
          // source of truth. The acknowledgement is restored automatically if
          // the card disappears because of an interruption or failed restore.
          return;
        }
        if (
          msg.source_kind === 'interrupt_partial' &&
          msg.finalization_reason === 'interrupted' &&
          !getPresentedMessageContent(msg).trim() &&
          !msg.attachments
        ) {
          return;
        }
        if (msg.sender === '__system__') {
          if (msg.content.startsWith('context_overflow:')) {
            items.push({ type: 'message', content: msg });
          } else {
            const resolved = resolveSystemMessage(msg.content);
            items.push({ type: resolved.style, content: resolved.text });
          }
        } else if (!msg.is_from_me && /^\/(sw|spawn)\s+/i.test(msg.content)) {
          // /sw or /spawn commands render as compact spawn-task cards
          items.push({
            type: 'spawn',
            content: msg.content.replace(/^\/(sw|spawn)\s+/i, ''),
          });
        } else {
          items.push({ type: 'message', content: msg });
        }
      });
    });
    return items;
  }, [timelineMessages, hasWorkflowCard]);

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
        case 'date':
          return `date-${item.content}`;
        case 'divider':
          return `div-${index}`;
        case 'spawn':
          return `spawn-${index}`;
        case 'error':
          return `err-${index}`;
        case 'message':
          return item.content.id;
      }
    },
    estimateSize: (index) => {
      const item = flatMessages[index];
      if (!item) return 100;
      switch (item.type) {
        case 'date':
          return 48;
        case 'divider':
        case 'spawn':
        case 'error':
          return 56;
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
        default:
          return 100;
      }
    },
    overscan: window.innerWidth < 1024 ? 12 : 8,
    // Re-render on scroll in a normal React update instead of flushSync inside
    // the scroll event: rows mounted there were measured (a forced layout)
    // before the frame's own layout, and wheel scrolling through a long
    // history cut long tasks from ~9 to ~3 per 6s at 4x CPU throttle.
    useFlushSync: false,
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

    const endSettle = () => {
      settleUntilRef.current = 0;
    };

    parent.addEventListener('scroll', handleScroll);
    parent.addEventListener('wheel', endSettle, { passive: true });
    parent.addEventListener('touchstart', endSettle, { passive: true });
    parent.addEventListener('keydown', endSettle);
    return () => {
      parent.removeEventListener('scroll', handleScroll);
      parent.removeEventListener('wheel', endSettle);
      parent.removeEventListener('touchstart', endSettle);
      parent.removeEventListener('keydown', endSettle);
    };
  }, [hasMore, loading, onLoadMore, groupJid]);

  // 新消息自动滚到底部
  useEffect(() => {
    if (autoScroll && timelineMessages.length > prevMessageCount.current) {
      requestAnimationFrame(() => {
        const parent = parentRef.current;
        if (!parent) return;
        smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
        scheduleSmoothCatchUp();
      });
    }
    prevMessageCount.current = timelineMessages.length;
  }, [timelineMessages.length, autoScroll, scheduleSmoothCatchUp]);

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
      prevMessageCount.current = timelineMessages.length;
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
  }, [flatMessages.length, virtualizer, timelineMessages.length]);

  // Safety net: initialOffset relies on estimated sizes which may be inaccurate.
  // After mount (or when messages load asynchronously), verify we're actually at
  // the bottom and correct if not. Depends on flatMessages.length so that async
  // message loading triggers a fresh round of corrections. After the first
  // page has settled this only runs while the reader is pinned to the bottom:
  // a new message or an older page must not pull someone reading history back
  // down. While the first page settles, rows measuring taller than estimated
  // fire scroll events that look like "left the bottom", so ignore those.
  const hadRowsRef = useRef(false);
  useEffect(() => {
    if (flatMessages.length === 0) return;
    if (!hadRowsRef.current) {
      hadRowsRef.current = true;
      settleUntilRef.current = Date.now() + 700;
    }
    const timers: number[] = [];
    for (const delay of [50, 150, 300, 500]) {
      timers.push(
        window.setTimeout(() => {
          const el = parentRef.current;
          if (!el) return;
          if (
            !scrollStateRef.current.autoScroll &&
            Date.now() > settleUntilRef.current
          ) {
            return;
          }
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (gap > 100) {
            el.scrollTop = el.scrollHeight;
          }
        }, delay),
      );
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatMessages.length]);

  // Loading an older page inserts rows above the ones being read. Shift the
  // scroll position by the height they add so the visible rows stay put, and
  // keep paging if the reader is still at the very top (no further scroll
  // event would fire there).
  // The loading row above the list shifts it too; count it in the offset.
  const loadingRowHeightRef = useRef(0);
  const measureLoadingRow = useCallback((node: HTMLDivElement | null) => {
    loadingRowHeightRef.current = node ? node.offsetHeight : 0;
  }, []);
  const totalSize = virtualizer.getTotalSize();
  const committedTotalRef = useRef(totalSize);
  const firstMessageIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const parent = parentRef.current;
    const firstId = timelineMessages[0]?.id ?? null;
    const previousFirstId = firstMessageIdRef.current;
    firstMessageIdRef.current = firstId;
    if (
      !parent ||
      !previousFirstId ||
      previousFirstId === firstId ||
      scrollStateRef.current.autoScroll ||
      !timelineMessages.some((m) => m.id === previousFirstId)
    ) {
      return;
    }
    const added =
      totalSize + loadingRowHeightRef.current - committedTotalRef.current;
    if (added > 0) parent.scrollTop += added;
    if (parent.scrollTop < 100 && hasMore && !loading) onLoadMore();
    // Only a change of the first row is a prepend; size changes alone are not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineMessages]);
  // Declared after the prepend check so it still sees the previous commit.
  useLayoutEffect(() => {
    committedTotalRef.current = totalSize + loadingRowHeightRef.current;
  });

  // Keep a reader who is pinned to the bottom there while rows below grow
  // after their first measurement (images, Mermaid, late code highlighting).
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    const parent = parentRef.current;
    if (!content || !parent || typeof ResizeObserver === 'undefined') return;
    let lastHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      const grew = height > lastHeight;
      lastHeight = height;
      if (!grew) return;
      if (
        !scrollStateRef.current.autoScroll &&
        Date.now() > settleUntilRef.current
      ) {
        return;
      }
      if (Date.now() < smoothScrollUntilRef.current) {
        scheduleSmoothCatchUp();
        return;
      }
      parent.scrollTop = parent.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleSmoothCatchUp]);

  // Auto-scroll when streaming content is active. Subscribes directly to the
  // chat store (no React re-render) and schedules a single rAF-coalesced
  // scrollTo per animation frame, regardless of how many text_delta /
  // thinking_delta updates land. This replaces the 100ms setInterval poll
  // (PR #455 era) which competed with smooth scrolls and caused 3-4 visible
  // jumps when the user scrolled to the bottom mid-stream.
  const hasStreaming = useChatStore((s) =>
    agentId ? !!s.agentStreaming[agentId] : !!s.streaming[groupJid ?? ''],
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
    let prevThinking =
      readStreaming(useChatStore.getState())?.thinkingText ?? '';

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

  const showScrollButtons = timelineMessages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden pb-10 pt-6"
      >
        <div
          ref={contentRef}
          className={
            displayMode === 'compact'
              ? 'mx-auto px-4 min-w-0'
              : 'mx-auto min-w-0 max-w-3xl px-4 lg:px-6'
          }
        >
          {loading && hasMore && (
            <div ref={measureLoadingRow} className="flex justify-center py-4">
              <Loader2
                className="animate-spin text-muted-foreground"
                size={18}
              />
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
                    <div className="my-6 flex items-center gap-3">
                      <div className="h-px flex-1 bg-surface-border" />
                      <span className="text-caption text-faint-foreground">
                        {item.content}
                      </span>
                      <div className="h-px flex-1 bg-surface-border" />
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
                    <div className="my-6 flex items-center gap-3">
                      <div className="h-px flex-1 bg-surface-border" />
                      <span className="text-caption whitespace-pre-wrap text-muted-foreground">
                        {item.content}
                      </span>
                      <div className="h-px flex-1 bg-surface-border" />
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
                    <div className="my-4 flex items-center gap-2">
                      <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-surface-raised px-2.5 text-caption text-muted-foreground ring-1 ring-surface-border">
                        <Zap className="size-3.5 shrink-0 text-primary-text" />
                        <span className="font-medium text-foreground">
                          并行任务
                        </span>
                        <span className="text-faint-foreground">·</span>
                        <span className="max-w-[400px] truncate">
                          {item.content}
                        </span>
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
                    {/* Inline callout in the message column: long errors
                        stay readable instead of squeezing between rules. */}
                    <div className="my-4 flex items-start gap-2 rounded-lg bg-error/5 px-3 py-2 ring-1 ring-error/15">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-error" />
                      <div className="min-w-0 flex-1 text-caption leading-5">
                        <span className="font-medium text-error">运行出错</span>
                        <span className="ml-2 break-words whitespace-pre-wrap text-muted-foreground">
                          {item.content}
                        </span>
                      </div>
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
                  <ErrorBoundary>
                    <MessageBubble
                      message={message}
                      showTime={showTime}
                      thinkingContent={thinkingCache[message.id]}
                      thinkingDurationMs={thinkingDurationCache[message.id]}
                      agentName={agentIdentity.name}
                      agentAvatarUrl={agentAvatarUrl}
                      agentAvatarEmoji={agentAvatarEmoji}
                      agentAvatarColor={agentAvatarColor}
                    />
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>

          {timelineMessages.length === 0 && !loading && (
            <div
              data-hc-empty-state
              className="absolute inset-x-0 top-0 bottom-0 flex justify-center px-4 pt-[clamp(4.5rem,14vh,9rem)]"
            >
              <div className="w-full max-w-3xl lg:px-6">
                <div className="flex items-start gap-3">
                  <EmojiAvatar
                    imageUrl={agentIdentity.imageUrl}
                    emoji={agentIdentity.emoji}
                    color={agentIdentity.color}
                    fallbackChar={agentIdentity.fallbackChar}
                    size="md"
                    className="mt-0.5 !size-9 shrink-0 !text-base"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-title-lg text-foreground">
                      {agentId ? '开始当前会话' : '开始主会话'}
                    </h2>
                    <p className="mt-1 max-w-2xl text-body text-muted-foreground">
                      {agentId && contextLabel
                        ? `“${contextLabel}”使用独立上下文。直接输入你的问题。`
                        : `我是 ${agentIdentity.name}。直接输入你的问题，或从下面选择一个常用起点。`}
                    </p>
                  </div>
                </div>

                {onSend && (
                  <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                    {quickPrompts.map((prompt) => (
                      <button
                        key={prompt.title}
                        onClick={() => requestComposerDraft(prompt.desc)}
                        className="group min-h-16 cursor-pointer rounded-xl bg-surface-raised px-3.5 py-3 text-left ring-1 ring-surface-border transition-[background-color,box-shadow] hover:bg-surface-hover hover:ring-foreground/15 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.99]"
                      >
                        <div className="flex items-start gap-3">
                          <prompt.icon
                            className="mt-0.5 h-4.5 w-4.5 shrink-0 text-muted-foreground group-hover:text-foreground"
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-body font-medium text-foreground">
                              {prompt.title}
                            </span>
                            <span className="mt-0.5 block overflow-hidden text-caption text-ellipsis text-muted-foreground">
                              {prompt.desc}
                            </span>
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {groupJid && !agentId && (
            <StreamingDisplay
              groupJid={groupJid}
              isWaiting={!!isWaiting}
              senderName={agentIdentity.name}
              agentAvatarUrl={agentAvatarUrl}
              agentAvatarEmoji={agentAvatarEmoji}
              agentAvatarColor={agentAvatarColor}
              interactionMode={interactionMode}
            />
          )}
          {groupJid && agentId && (
            <StreamingDisplay
              groupJid={groupJid}
              isWaiting={!!isWaiting}
              agentId={agentId}
              senderName={agentIdentity.name}
              agentAvatarUrl={agentAvatarUrl}
              agentAvatarEmoji={agentAvatarEmoji}
              agentAvatarColor={agentAvatarColor}
              interactionMode={interactionMode}
            />
          )}

          {/* Inline streaming for spawn agents — parallel tasks in same chat */}
          {groupJid &&
            !agentId &&
            spawnAgents.map((a) => (
              <StreamingDisplay
                key={a.id}
                groupJid={groupJid}
                isWaiting={true}
                agentId={a.id}
                senderName={a.name}
                agentAvatarUrl={agentAvatarUrl}
                agentAvatarEmoji={agentAvatarEmoji}
                agentAvatarColor={agentAvatarColor}
                interactionMode={interactionMode}
              />
            ))}
        </div>
      </div>

      {/* Floating scroll buttons */}
      {showScrollButtons && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-1.5">
          {!atTop && (
            <button
              onClick={scrollToTop}
              className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-surface-raised text-muted-foreground shadow-menu ring-1 ring-surface-border transition-colors hover:text-foreground"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-surface-raised text-muted-foreground shadow-menu ring-1 ring-surface-border transition-colors hover:text-foreground"
              title="回到底部"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
