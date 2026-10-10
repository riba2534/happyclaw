import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  memo,
} from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
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
  Copy,
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
import { copyToClipboard } from '../../utils/clipboard';
import {
  formatChatDateLabel,
  localDayKey,
  msUntilNextLocalDay,
  startOfLocalDay,
  type ChatDateLabel,
} from '../../lib/chat-date-label';
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
  | { type: 'date'; content: string; title: string }
  | { type: 'divider'; content: string }
  | { type: 'spawn'; content: string }
  | { type: 'error'; content: string }
  | { type: 'message'; content: Message };

/**
 * Day label of a timestamp, formatted once per local calendar day: grouping
 * reruns over the whole history on every new message or usage update, and
 * formatting each of 5,000 dates took ~11ms of it.
 */
function dateLabel(
  timestamp: string,
  today: Date,
  cache: Map<number, ChatDateLabel>,
): ChatDateLabel {
  const date = new Date(timestamp);
  const day = localDayKey(date);
  let label = cache.get(day);
  if (label === undefined) {
    label = formatChatDateLabel(date, today);
    cache.set(day, label);
  }
  return label;
}

/** Start of the local day, refreshed at midnight so "今天" rolls over. */
function useLocalToday(): Date {
  const [today, setToday] = useState(() => startOfLocalDay(new Date()));
  useEffect(() => {
    const timer = window.setTimeout(
      () => setToday(startOfLocalDay(new Date())),
      msUntilNextLocalDay(new Date()) + 1000,
    );
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

/** Programmatic scrolls jump instead of animating when less motion is asked for. */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Counted toward the "new messages" badge; mirrors the rows that render. */
function isVisibleArrival(message: Message): boolean {
  return !(
    message.source_kind === 'interrupt_partial' &&
    !getPresentedMessageContent(message).trim() &&
    !message.attachments
  );
}

async function copyErrorText(text: string) {
  try {
    await copyToClipboard(text);
    toast.success('已复制错误信息');
  } catch {
    toast.error('复制失败，请手动选择文本复制');
  }
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
  const traceCache = useChatStore((s) => s.traceCache ?? {});
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
  const today = useLocalToday();
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ autoScroll: true, atTop: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  // Messages that arrived below while the reader was scrolled up.
  const [unseenCount, setUnseenCount] = useState(0);
  const prevMessageCount = useRef(timelineMessages.length);
  const lastMessageIdRef = useRef(timelineMessages.at(-1)?.id ?? null);
  // Window during which the streaming RAF and resize pinning defer to one
  // catch-up scroll, so a programmatic smooth scroll can run uninterrupted
  // (≈500ms browser default + 100ms slack).
  const smoothScrollUntilRef = useRef(0);
  const smoothCatchUpTimerRef = useRef<number | null>(null);
  const SMOOTH_SCROLL_LOCK_MS = 600;
  // A programmatic scroll to the bottom keeps the reader pinned until it
  // lands or the browser reports scrollend: content growing under the
  // animation, or rows measuring themselves, can leave it short, and that
  // must not read as the reader leaving. Their own wheel, touch, key or
  // scrollbar input ends it at once. Capped in case scrollend never comes.
  const pinUntilRef = useRef(0);
  const PIN_INTENT_MAX_MS = 3000;
  // Where pinToBottom jumped to before animating the last screen.
  const jumpTopRef = useRef<number | null>(null);
  // While the first page settles (and while a finished reply swaps in for its
  // stream), bottom pinning ignores scroll events caused by rows measuring
  // differently than estimated. Any user scroll ends it early.
  const settleUntilRef = useRef(0);
  // Where the virtualizer last moved scrollTop to absorb a row measuring
  // itself: a scroll event landing there is layout, not the reader leaving.
  const layoutScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const isEmptyRef = useRef(timelineMessages.length === 0);

  const setPinned = useCallback((pinned: boolean) => {
    if (scrollStateRef.current.autoScroll === pinned) return;
    scrollStateRef.current.autoScroll = pinned;
    setAutoScroll(pinned);
    if (pinned) setUnseenCount(0);
  }, []);

  // "回到顶部" only shows when there is somewhere to go. Recomputed on scroll
  // and on resize: content that fits the viewport never fires a scroll event.
  const syncEdges = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const isAtTop = parent.scrollTop < 50;
    if (scrollStateRef.current.atTop !== isAtTop) {
      scrollStateRef.current.atTop = isAtTop;
      setAtTop(isAtTop);
    }
    // Content that fits has no bottom to return to.
    if (parent.scrollHeight - parent.clientHeight < 10) setPinned(true);
  }, [setPinned]);

  // Chrome ignores wheel, touch and key scrolling while a programmatic smooth
  // scroll runs: the animation carries on to the bottom. Reader input during
  // one has to stop it first so the reader's own scroll takes effect.
  const animationWheelRef = useRef<((event: WheelEvent) => void) | null>(null);
  const detachAnimationWheel = useCallback(() => {
    const handler = animationWheelRef.current;
    animationWheelRef.current = null;
    if (handler) parentRef.current?.removeEventListener('wheel', handler);
  }, []);

  const cancelSmoothCatchUp = useCallback(() => {
    if (smoothCatchUpTimerRef.current !== null) {
      window.clearTimeout(smoothCatchUpTimerRef.current);
      smoothCatchUpTimerRef.current = null;
    }
  }, []);

  const scheduleSmoothCatchUp = useCallback(() => {
    cancelSmoothCatchUp();
    const delay = Math.max(0, smoothScrollUntilRef.current - Date.now()) + 16;
    smoothCatchUpTimerRef.current = window.setTimeout(() => {
      smoothCatchUpTimerRef.current = null;
      detachAnimationWheel();
      if (!scrollStateRef.current.autoScroll) return;
      const parent = parentRef.current;
      if (!parent) return;
      parent.scrollTo({ top: parent.scrollHeight });
    }, delay);
  }, [cancelSmoothCatchUp, detachAnimationWheel]);

  /** Ends the running smooth scroll where it is; false if none was running. */
  const stopSmoothScroll = useCallback(() => {
    const parent = parentRef.current;
    const animating = Date.now() < smoothScrollUntilRef.current;
    smoothScrollUntilRef.current = 0;
    cancelSmoothCatchUp();
    detachAnimationWheel();
    if (!parent || !animating) return false;
    parent.scrollTo({ top: parent.scrollTop });
    return true;
  }, [cancelSmoothCatchUp, detachAnimationWheel]);

  /**
   * The reader took over: drop every programmatic hold on the bottom (smooth
   * scroll, its catch-up, pin intent, first-page settling) so their own scroll
   * is not undone moments later. `leaveBottom` is for input that clearly
   * scrolls up; anything else is left to the scroll events that follow.
   */
  const releasePin = useCallback(
    (leaveBottom: boolean) => {
      const parent = parentRef.current;
      if (!parent) return;
      const now = Date.now();
      const holding =
        now < smoothScrollUntilRef.current ||
        now < pinUntilRef.current ||
        now < settleUntilRef.current;
      settleUntilRef.current = 0;
      if (!holding) return;
      pinUntilRef.current = 0;
      stopSmoothScroll();
      if (leaveBottom && parent.scrollTop > 0) setPinned(false);
    },
    [setPinned, stopSmoothScroll],
  );

  /** Scroll to the bottom and stay pinned there, animating at most one screen. */
  const pinToBottom = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const maxTop = parent.scrollHeight - parent.clientHeight;
    if (maxTop - parent.scrollTop < 10) return;
    pinUntilRef.current = Date.now() + PIN_INTENT_MAX_MS;
    jumpTopRef.current = null;
    if (prefersReducedMotion()) {
      parent.scrollTop = maxTop;
      return;
    }
    // A long animation outlasts the lock and mounts every row on the way:
    // jump to one screen above the bottom and animate only the last screen.
    if (maxTop - parent.scrollTop > parent.clientHeight) {
      parent.scrollTop = maxTop - parent.clientHeight;
      jumpTopRef.current = parent.scrollTop;
    }
    smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
    scheduleSmoothCatchUp();
    // Wheel up during the animation: take the wheel over and apply its delta
    // after stopping the animation. Non-passive only for this window, so
    // ordinary wheel scrolling never waits on the main thread.
    if (!animationWheelRef.current) {
      const handler = (event: WheelEvent) => {
        if (event.ctrlKey) return;
        if (Date.now() >= smoothScrollUntilRef.current) {
          // The animation is over: handle this one like the passive listener.
          detachAnimationWheel();
          if (event.deltaY < 0) releasePin(true);
          return;
        }
        if (event.deltaY >= 0) return;
        event.preventDefault();
        const unit =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? parent.clientHeight
              : 1;
        releasePin(true);
        parent.scrollTo({ top: parent.scrollTop + event.deltaY * unit });
      };
      animationWheelRef.current = handler;
      parent.addEventListener('wheel', handler, { passive: false });
    }
  }, [detachAnimationWheel, releasePin, scheduleSmoothCatchUp]);

  useEffect(() => {
    return () => {
      if (smoothCatchUpTimerRef.current !== null) {
        window.clearTimeout(smoothCatchUpTimerRef.current);
      }
    };
  }, []);

  // Compute flatMessages (with date headers) before virtualizer
  const flatMessages = useMemo<FlatItem[]>(() => {
    const labels = new Map<number, ChatDateLabel>();
    const grouped = timelineMessages.reduce(
      (acc, msg) => {
        const date = dateLabel(getMessageDisplayTimestamp(msg), today, labels);
        if (!acc[date.label]) acc[date.label] = { date, msgs: [] };
        acc[date.label].msgs.push(msg);
        return acc;
      },
      {} as Record<string, { date: ChatDateLabel; msgs: Message[] }>,
    );

    const items: FlatItem[] = [];
    Object.values(grouped).forEach(({ date, msgs }) => {
      items.push({ type: 'date', content: date.label, title: date.title });
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
  }, [timelineMessages, hasWorkflowCard, today]);

  // A finished reply replaces its streaming block in one store update (the
  // block is held, settled, until the final message arrives). The new row is
  // seeded with the block's measured height instead of the length estimate,
  // which overshot by 1.2–1.6x and rolled a pinned reader back a screen; a
  // reader scrolled into the reply keeps the row where the block was.
  const hasStreaming = useChatStore((s) =>
    agentId ? !!s.agentStreaming[agentId] : !!s.streaming[groupJid ?? ''],
  );
  const streamingBlockRef = useRef<HTMLDivElement>(null);
  const seedSizesRef = useRef(new Map<string, number>());
  const pendingSwapRef = useRef<{
    id: string;
    anchorTop: number | null;
    pinned: boolean;
  } | null>(null);
  const swappedIdRef = useRef<string | null>(null);
  // The swapped-in row keeps the streaming block's place on screen briefly.
  const anchorHoldRef = useRef<{
    id: string;
    anchorTop: number;
    until: number;
  } | null>(null);
  const SWAP_ANCHOR_HOLD_MS = 400;
  const applyAnchorHold = useCallback(() => {
    const hold = anchorHoldRef.current;
    const parent = parentRef.current;
    if (!hold || !parent) return;
    const row = parent.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(hold.id)}"]`,
    );
    if (!row) return;
    const delta =
      row.getBoundingClientRect().top -
      parent.getBoundingClientRect().top -
      hold.anchorTop;
    if (Math.abs(delta) < 1) return;
    layoutScrollTopRef.current = parent.scrollTop + delta;
    parent.scrollTop += delta;
  }, []);
  const committedStreamRef = useRef({
    hasStreaming,
    messages: timelineMessages,
  });
  {
    const committed = committedStreamRef.current;
    if (
      committed.hasStreaming &&
      !hasStreaming &&
      committed.messages !== timelineMessages &&
      !pendingSwapRef.current
    ) {
      const before = new Set(committed.messages.map((m) => m.id));
      let reply: Message | undefined;
      for (let i = timelineMessages.length - 1; i >= 0; i -= 1) {
        const m = timelineMessages[i];
        if (!before.has(m.id) && m.is_from_me && m.sender !== '__system__') {
          reply = m;
          break;
        }
      }
      const block = streamingBlockRef.current;
      const parent = parentRef.current;
      if (reply && block && parent) {
        // Still the committed DOM: the block is on screen until this commits.
        if (block.querySelector('[data-markdown-root]')) {
          seedSizesRef.current.set(reply.id, block.offsetHeight);
          if (seedSizesRef.current.size > 20) {
            const oldest = seedSizesRef.current.keys().next().value;
            if (oldest !== undefined) seedSizesRef.current.delete(oldest);
          }
        }
        pendingSwapRef.current = {
          id: reply.id,
          anchorTop:
            block.offsetHeight > 0
              ? block.getBoundingClientRect().top -
                parent.getBoundingClientRect().top
              : null,
          pinned: scrollStateRef.current.autoScroll,
        };
      }
    }
  }
  useLayoutEffect(() => {
    committedStreamRef.current = { hasStreaming, messages: timelineMessages };
  });

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
          const seeded = seedSizesRef.current.get(item.content.id);
          if (seeded !== undefined) return seeded;
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
    scrollToFn: (offset, options, instance) => {
      layoutScrollTopRef.current = offset + (options.adjustments ?? 0);
      elementScroll(offset, options, instance);
    },
  });

  // Detect at-bottom (autoScroll) and at-top (loadMore) via the scroll event.
  // Critically, this fires only on actual scroll events — not when scrollHeight
  // grows during streaming with scrollTop unchanged. So content growth never
  // spuriously flips autoScroll off (the failure mode of the IntersectionObserver
  // approach in PR #455). The ref is updated synchronously to avoid races with
  // the streaming RAF catch-up.
  const touchStartYRef = useRef<number | null>(null);
  const touchingRef = useRef(false);
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = parent;
      const movedUp = scrollTop < lastScrollTopRef.current - 1;
      lastScrollTopRef.current = scrollTop;
      const layoutTop = layoutScrollTopRef.current;
      layoutScrollTopRef.current = null;
      const layoutScroll =
        layoutTop !== null && Math.abs(scrollTop - layoutTop) < 2;
      const now = Date.now();

      if (scrollHeight - scrollTop - clientHeight < 10) {
        // Landed: whatever was carrying the reader down is done.
        pinUntilRef.current = 0;
        smoothScrollUntilRef.current = 0;
        setPinned(true);
      } else if (
        movedUp &&
        !layoutScroll &&
        now >= pinUntilRef.current &&
        now >= settleUntilRef.current
      ) {
        // Only moving up leaves the bottom. A scroll toward the bottom that
        // lands short because content grew meanwhile (a smooth scroll
        // mid-animation, or a frame racing a streaming render) never does.
        setPinned(false);
      }
      syncEdges();

      if (scrollTop < 100 && hasMore && !loading) {
        onLoadMore();
      }
    };

    const endSettle = () => {
      settleUntilRef.current = 0;
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      anchorHoldRef.current = null;
      // pinToBottom's own listener handles the wheel while it is attached.
      if (animationWheelRef.current) return;
      if (event.deltaY < 0) releasePin(true);
      else endSettle();
    };
    const handleTouchStart = (event: TouchEvent) => {
      endSettle();
      anchorHoldRef.current = null;
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
      touchingRef.current = true;
      // Let the finger take over; a tap resumes the way down on touchend.
      stopSmoothScroll();
    };
    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const y = event.touches[0]?.clientY;
      // The finger moving down drags the content down: scrolling up.
      if (startY !== null && y !== undefined && y - startY > 8) {
        touchStartYRef.current = null;
        releasePin(true);
      }
    };
    const handleTouchEnd = () => {
      touchStartYRef.current = null;
      touchingRef.current = false;
      if (
        Date.now() < pinUntilRef.current &&
        scrollStateRef.current.autoScroll
      ) {
        pinToBottom();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      anchorHoldRef.current = null;
      const scrollsUp =
        event.key === 'PageUp' ||
        event.key === 'ArrowUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey);
      if (scrollsUp) releasePin(true);
      else endSettle();
    };
    const handlePointerDown = (event: PointerEvent) => {
      // Grabbing the scrollbar takes manual control; where it is dragged
      // decides the rest.
      if (event.target === parent && event.offsetX >= parent.clientWidth) {
        anchorHoldRef.current = null;
        releasePin(false);
      }
    };
    // A scroll toward the bottom can stop short of it (content grew, or a row
    // measuring itself cut the animation off); finish the job once it ends.
    const handleScrollEnd = () => {
      if (Date.now() >= pinUntilRef.current || touchingRef.current) return;
      // scrollend also fires for the instant jump before the animated last
      // screen; the animation is still to come.
      const jumpTop = jumpTopRef.current;
      if (jumpTop !== null && Math.abs(parent.scrollTop - jumpTop) < 2) return;
      jumpTopRef.current = null;
      pinUntilRef.current = 0;
      smoothScrollUntilRef.current = 0;
      if (
        scrollStateRef.current.autoScroll &&
        parent.scrollHeight - parent.scrollTop - parent.clientHeight >= 10
      ) {
        parent.scrollTop = parent.scrollHeight;
      }
    };

    parent.addEventListener('scroll', handleScroll);
    parent.addEventListener('scrollend', handleScrollEnd);
    parent.addEventListener('wheel', handleWheel, { passive: true });
    parent.addEventListener('touchstart', handleTouchStart, { passive: true });
    parent.addEventListener('touchmove', handleTouchMove, { passive: true });
    parent.addEventListener('touchend', handleTouchEnd);
    parent.addEventListener('touchcancel', handleTouchEnd);
    parent.addEventListener('keydown', handleKeyDown);
    parent.addEventListener('pointerdown', handlePointerDown);
    return () => {
      parent.removeEventListener('scroll', handleScroll);
      parent.removeEventListener('scrollend', handleScrollEnd);
      parent.removeEventListener('wheel', handleWheel);
      parent.removeEventListener('touchstart', handleTouchStart);
      parent.removeEventListener('touchmove', handleTouchMove);
      parent.removeEventListener('touchend', handleTouchEnd);
      parent.removeEventListener('touchcancel', handleTouchEnd);
      parent.removeEventListener('keydown', handleKeyDown);
      parent.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [
    hasMore,
    loading,
    onLoadMore,
    groupJid,
    pinToBottom,
    releasePin,
    setPinned,
    stopSmoothScroll,
    syncEdges,
  ]);

  // 新消息自动滚到底部；读者停在上方时只累计“有新消息”的计数
  useEffect(() => {
    const previousLastId = lastMessageIdRef.current;
    const lastId = timelineMessages.at(-1)?.id ?? null;
    lastMessageIdRef.current = lastId;
    const grew = timelineMessages.length > prevMessageCount.current;
    prevMessageCount.current = timelineMessages.length;
    // An older page only prepends; the newest row stays the same.
    if (!grew || lastId === previousLastId) return;
    if (scrollStateRef.current.autoScroll) {
      requestAnimationFrame(() => pinToBottom());
      return;
    }
    let from = -1;
    if (previousLastId) {
      for (let i = timelineMessages.length - 1; i >= 0; i -= 1) {
        if (timelineMessages[i].id === previousLastId) {
          from = i;
          break;
        }
      }
      if (from < 0) return;
    }
    let arrived = 0;
    for (let i = from + 1; i < timelineMessages.length; i += 1) {
      // A reply that replaced the stream the reader saw is not news.
      if (timelineMessages[i].id === swappedIdRef.current) continue;
      if (isVisibleArrival(timelineMessages[i])) arrived += 1;
    }
    if (arrived > 0) setUnseenCount((count) => count + arrived);
  }, [timelineMessages, pinToBottom]);

  // 外部触发滚到底部（发送消息后）
  useEffect(() => {
    if (scrollTrigger && scrollTrigger > 0) {
      setPinned(true);
      requestAnimationFrame(() => pinToBottom());
    }
  }, [scrollTrigger, pinToBottom, setPinned]);

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

  useLayoutEffect(() => {
    isEmptyRef.current = flatMessages.length === 0;
    syncEdges();
  }, [flatMessages.length, syncEdges]);

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
  // after their first measurement (images, Mermaid, late code highlighting),
  // while a row shrinks under a correction, and while the viewport shrinks
  // (keyboard, a taller composer). The empty state reads from the top.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    const parent = parentRef.current;
    if (!content || !parent || typeof ResizeObserver === 'undefined') return;
    let lastHeight = content.offsetHeight;
    let lastViewport = parent.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      const viewport = parent.clientHeight;
      const changed = height !== lastHeight || viewport < lastViewport;
      lastHeight = height;
      lastViewport = viewport;
      syncEdges();
      if (!changed || isEmptyRef.current) return;
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
    observer.observe(parent);
    return () => observer.disconnect();
  }, [scheduleSmoothCatchUp, syncEdges]);

  // Place the swapped-in reply: a pinned reader lands on the bottom at once
  // (no animated catch-up); otherwise the row holds the block's place on
  // screen while the rows around it finish measuring (a date row or the row
  // itself correcting its estimate), until the reader scrolls.
  useLayoutEffect(() => {
    const swap = pendingSwapRef.current;
    if (!swap) return;
    pendingSwapRef.current = null;
    swappedIdRef.current = swap.id;
    const parent = parentRef.current;
    if (!parent) return;
    if (swap.pinned) {
      if (parent.scrollHeight - parent.scrollTop - parent.clientHeight >= 1) {
        layoutScrollTopRef.current = parent.scrollHeight - parent.clientHeight;
        parent.scrollTop = parent.scrollHeight;
      }
      return;
    }
    if (swap.anchorTop === null) return;
    const hold = {
      id: swap.id,
      anchorTop: swap.anchorTop,
      until: Date.now() + SWAP_ANCHOR_HOLD_MS,
    };
    anchorHoldRef.current = hold;
    const keepAnchor = () => {
      if (anchorHoldRef.current !== hold) return;
      applyAnchorHold();
      if (Date.now() < hold.until) requestAnimationFrame(keepAnchor);
      else anchorHoldRef.current = null;
    };
    keepAnchor();
  }, [flatMessages, applyAnchorHold]);
  // Rows that measure during the swap commit re-render synchronously before
  // paint; re-anchor in that commit too, not a frame later.
  useLayoutEffect(() => {
    if (anchorHoldRef.current) applyAnchorHold();
  });

  // A finished reply swaps the streaming block for its final row, inserted at
  // an estimated height and then measured; the correction moves scrollTop and
  // can look like leaving the bottom. A reader pinned before the swap stays
  // pinned: the settle window keeps those scroll events from unpinning, and
  // the resize and safety-net passes pin again once the row has measured.
  const wasStreamingRef = useRef(hasStreaming);
  useLayoutEffect(() => {
    const finished = wasStreamingRef.current && !hasStreaming;
    wasStreamingRef.current = hasStreaming;
    if (!finished || !scrollStateRef.current.autoScroll) return;
    settleUntilRef.current = Math.max(settleUntilRef.current, Date.now() + 700);
  }, [hasStreaming]);
  // Auto-scroll when streaming content is active. Subscribes directly to the
  // chat store (no React re-render) and schedules a single rAF-coalesced
  // scrollTo per animation frame, regardless of how many text_delta /
  // thinking_delta updates land. This replaces the 100ms setInterval poll
  // (PR #455 era) which competed with smooth scrolls and caused 3-4 visible
  // jumps when the user scrolled to the bottom mid-stream.
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
    const parent = parentRef.current;
    if (!parent) return;
    releasePin(false);
    if (parent.scrollTop > 0) setPinned(false);
    if (prefersReducedMotion()) {
      parent.scrollTop = 0;
      return;
    }
    // Same as the way down: animate only the last screen.
    if (parent.scrollTop > parent.clientHeight) {
      parent.scrollTop = parent.clientHeight;
    }
    parent.scrollTo({ top: 0, behavior: 'smooth' });
  }, [releasePin, setPinned]);

  const scrollToBottom = useCallback(() => {
    setPinned(true);
    pinToBottom();
  }, [pinToBottom, setPinned]);

  const showScrollButtons = timelineMessages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden pb-10"
      >
        {/* The top inset sits on the content, not the scroller: a sticky
            status row sticks inside the scroller's padding box, and with
            the padding on the scroller 24px of text scrolled by above it. */}
        <div
          ref={contentRef}
          className={
            displayMode === 'compact'
              ? 'mx-auto px-4 pt-6 min-w-0'
              : 'mx-auto min-w-0 max-w-3xl px-4 pt-6 lg:px-6'
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
                      <span
                        className="text-caption text-faint-foreground"
                        title={item.title}
                      >
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
                      <button
                        type="button"
                        onClick={() => void copyErrorText(item.content)}
                        className="-my-0.5 -mr-1.5 inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-error/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:px-2.5"
                      >
                        <Copy className="size-3.5" />
                        复制错误
                      </button>
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
                  data-message-id={message.id}
                >
                  <ErrorBoundary>
                    <MessageBubble
                      message={message}
                      showTime={showTime}
                      thinkingContent={thinkingCache[message.id]}
                      thinkingDurationMs={thinkingDurationCache[message.id]}
                      traceEvents={traceCache[message.id]}
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

          {/* In the scroll flow rather than an overlay, so a short viewport
              (phone in landscape, keyboard up) can scroll to every starter.
              The top inset subtracts the content's own pt-6. */}
          {timelineMessages.length === 0 && !loading && (
            <div
              data-hc-empty-state
              className={
                displayMode === 'compact'
                  ? 'mx-auto w-full max-w-3xl pt-[clamp(3rem,calc(14vh_-_1.5rem),7.5rem)] lg:px-6'
                  : 'pt-[clamp(3rem,calc(14vh_-_1.5rem),7.5rem)]'
              }
            >
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
          )}

          <div ref={streamingBlockRef} data-hc-streaming-block="">
            {groupJid && (
              <StreamingDisplay
                groupJid={groupJid}
                isWaiting={!!isWaiting}
                agentId={agentId}
                senderName={agentIdentity.name}
                agentAvatarUrl={agentAvatarUrl}
                agentAvatarEmoji={agentAvatarEmoji}
                agentAvatarColor={agentAvatarColor}
                interactionMode={interactionMode}
                stopHint
              />
            )}
          </div>

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
              type="button"
              onClick={scrollToTop}
              className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-surface-raised text-muted-foreground shadow-menu ring-1 ring-surface-border transition-colors hover:text-foreground pointer-coarse:size-10"
              title="回到顶部"
              aria-label="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="relative flex size-8 cursor-pointer items-center justify-center rounded-full bg-surface-raised text-muted-foreground shadow-menu ring-1 ring-surface-border transition-colors hover:text-foreground pointer-coarse:size-10"
              title="回到底部"
              aria-label={
                unseenCount > 0
                  ? `回到底部，有 ${unseenCount} 条新消息`
                  : '回到底部'
              }
            >
              <ChevronDown className="w-4 h-4" />
              {unseenCount > 0 && (
                <span
                  aria-hidden="true"
                  data-hc-unseen-count
                  className="absolute -top-1.5 -right-1.5 h-4 min-w-4 rounded-full bg-primary px-1 text-center text-micro leading-4 font-medium text-primary-foreground tabular-nums ring-2 ring-background"
                >
                  {unseenCount > 99 ? '99+' : unseenCount}
                </span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
