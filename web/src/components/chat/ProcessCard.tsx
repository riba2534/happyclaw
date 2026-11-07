import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronRight, Layers, Loader2 } from 'lucide-react';
import { m } from 'motion/react';
import { cn } from '@/lib/utils';
import type {
  StreamingState,
  StreamingTaskRuntimeState,
} from '../../stores/chat';
import type { StreamingStep } from '../../lib/stream-steps';
import {
  LIVE_TIMELINE_ROWS,
  SETTLED_TIMELINE_ROWS,
  describeWork,
  describeWorkCounts,
  hasListedSteps,
  isQuestionStep,
  summarizedSteps,
  visibleSteps,
} from '../../lib/process-steps';
import {
  rememberProcessOpen,
  rememberedProcessOpen,
} from '../../lib/process-open-memory';
import {
  deriveHeadline,
  WAITING_HEADLINE,
  type ProcessHeadline,
} from '../../lib/process-headline';
import { formatRunElapsed } from '../../lib/run-phase';
import { useSteadyValue } from '../../hooks/useSteadyValue';
import { useAfterDelay, useTick } from '../../hooks/useTick';
import { useIsPhone } from '../layout/phone';
import { MemoryReceipts } from './MemoryReceipts';
import { ModelWaitBody, modelWaitSeconds } from './ModelWaitRow';
import {
  LATER_WAIT_DELAY_MS,
  ProcessTimeline,
  QuestionCards,
} from './ProcessRows';
import {
  TOOL_STATE,
  ToolStateIcon,
  countToolStates,
  describeProblems,
  worstProblem,
} from './tool-status';

export interface ProcessCardProps {
  mode: 'live' | 'settled';
  steps: StreamingStep[];
  stepsDropped?: number;
  groupJid: string;
  /** Live only. Without it (settled) a sub-agent is a row with no details. */
  taskStates?: Record<string, StreamingTaskRuntimeState>;
  /** The input of an AskUserQuestion step. */
  activeTools?: StreamingState['activeTools'];
  /** Live: the model's request is out and nothing has come back. */
  waiting?: boolean;
  waitingSince?: number;
  hasContent?: boolean;
  /** Show the model's commentary between steps (text steps). Default true. */
  commentary?: boolean;
  /**
   * Show reasoning titles and text. Default true; off, a reasoning row only
   * says that the model reasoned, and for how long.
   */
  thinkingText?: boolean;
  /** Settled: the total time, for steps that carry no times of their own. */
  durationMs?: number;
  /**
   * Live: the answer is being written below. The process is over for now and
   * folds to its one-line summary, as it will on the finished reply.
   */
  answering?: boolean;
  /**
   * The turn the card belongs to: the reader's open-or-closed choice is kept
   * by it, so the finished reply's card is left as the live one was.
   */
  memoryKey?: string | null;
  /** Settled: start open (the reader asked for the steps). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** There is something of the steps to show (the timeline's own measure). */
export function hasProcess(steps: readonly StreamingStep[]): boolean {
  return hasListedSteps(steps);
}

const EMPTY_TOOLS: StreamingState['activeTools'] = [];

/** A line that changes is let settle this long before it is swapped. */
const HEADLINE_SETTLE_MS = 300;
/** Closer to the end than this, the window counts as following it. */
const FOLLOW_THRESHOLD_PX = 30;
/**
 * A scroll event within this long of the reader's own input (or of an event
 * that was theirs: a fling goes on scrolling long after the finger is off) is
 * the reader scrolling. Any other is the page: a clamp after the content got
 * shorter, say, which the browser reports a frame late, when the content may
 * have grown again.
 */
const USER_SCROLL_MS = 200;

const ICON_CLASS = 'size-3.5 shrink-0';

// ── the header ──────────────────────────────────────────────────────────

interface ProcessHeaderProps {
  /** Live and at work: what it does now. Otherwise its one-line summary. */
  working: boolean;
  steps: StreamingStep[];
  /** The model's request is out and nothing has come back (past its delay). */
  waiting: boolean;
  waitingSince?: number;
  thinkingText: boolean;
  durationMs?: number;
  open: boolean;
  /** The id of the window the header opens, when there is one. */
  bodyId?: string;
  onToggle: () => void;
}

/**
 * The one row that is always there. At work, it says what the run is doing
 * now, with how long the process has gone on in a monospace timer; folded (its
 * answer is being written, or the reply is finished), "已工作 Xs" by a Layers
 * icon, as in cindy. It is the button that opens the rest, the whole row wide,
 * never dependent on a hover.
 */
function ProcessHeader({
  working,
  steps,
  waiting,
  waitingSince,
  thinkingText,
  durationMs,
  open,
  bodyId,
  onToggle,
}: ProcessHeaderProps) {
  const latest = deriveHeadline({
    steps,
    waiting,
    thinkingText,
    waitingSince,
  }) ?? {
    source: 'waiting' as const,
    label: WAITING_HEADLINE,
    running: true,
    startedAt: waitingSince,
    text: WAITING_HEADLINE,
  };
  const headline = useSteadyValue<ProcessHeadline>(
    latest,
    `${latest.source}|${latest.running}|${latest.startedAt}|${latest.text}`,
    HEADLINE_SETTLE_MS,
  );
  // The process has gone on since its first step (or the wait before it): the
  // earliest this card has seen, as steps dropped from the front of a long
  // list must not move it.
  const earliest = useRef<number | undefined>(undefined);
  const firstAt = working
    ? (summarizedSteps(steps)[0]?.at ?? waitingSince)
    : undefined;
  if (firstAt != null) {
    earliest.current = Math.min(earliest.current ?? firstAt, firstAt);
  }
  const startedAt = working ? earliest.current : undefined;
  const now = useTick(startedAt != null);
  const seconds =
    startedAt != null
      ? Math.max(0, Math.floor((now - startedAt) / 1000))
      : null;

  // The first line is there from the start; only a change is animated.
  const shownOnce = useRef(false);
  useEffect(() => {
    shownOnce.current = true;
  }, []);

  const running = working && headline.running;
  // Folded, the line also says whether anything went wrong, and out of how
  // many calls: 「已工作 32s · 12 个工具 · 2 个失败」. Nothing when nothing did;
  // opened, the counts under it say it.
  const outcome = working || open ? null : foldedOutcome(steps);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? bodyId : undefined}
      className="-mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-10"
    >
      {working ? (
        <Loader2
          aria-hidden="true"
          className={cn(
            ICON_CLASS,
            'text-faint-foreground',
            running && 'animate-spin motion-reduce:animate-none',
          )}
        />
      ) : outcome ? (
        <ToolStateIcon state={outcome.worst} />
      ) : (
        <Layers
          aria-hidden="true"
          className={cn(ICON_CLASS, 'text-faint-foreground')}
        />
      )}
      {working ? (
        <span className="min-w-0 flex-1 overflow-hidden">
          <m.span
            key={headline.text}
            initial={shownOnce.current ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            className={cn('block truncate', running && 'shimmer')}
          >
            <span className={cn('font-medium', !running && 'text-foreground')}>
              {headline.label}
            </span>
            {headline.detail && (
              <span className={cn(!running && 'text-muted-foreground')}>
                {' · '}
                {headline.detail}
              </span>
            )}
          </m.span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {describeWork(steps, durationMs)}
          {outcome && (
            <>
              {` · ${outcome.total} 个工具 · `}
              <span
                data-hc-work-problems=""
                className={TOOL_STATE[outcome.worst].tone}
              >
                {outcome.problems}
              </span>
            </>
          )}
        </span>
      )}
      {working && seconds != null && seconds >= 1 && (
        <span className="shrink-0 font-mono text-caption text-faint-foreground tabular-nums">
          {formatRunElapsed(seconds)}
        </span>
      )}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          ICON_CLASS,
          'text-faint-foreground transition-transform duration-150',
          open && 'rotate-90',
        )}
      />
    </button>
  );
}

/** What went wrong in a settled process, or `null` when nothing did. */
function foldedOutcome(steps: readonly StreamingStep[]) {
  const counts = countToolStates(summarizedSteps(steps), false);
  const worst = worstProblem(counts);
  if (!worst) return null;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { worst, total, problems: describeProblems(counts).join(' · ') };
}

// ── the window ──────────────────────────────────────────────────────────

/**
 * The steps of a card in a window. Live, its height is limited: it follows
 * the end as steps arrive, fades its top edge once something has scrolled out
 * of it, and lets go of the end when the reader scrolls up or opens a row to
 * read it. Settled, it is taller and still. It is the same element either way:
 * what a reader has opened in it survives the end of the run.
 *
 * The end is looked at once a frame, not once a render: a render for each
 * streamed delta that read the scroll size would force a layout of the whole
 * page for each one. It is left only by the reader's own scrolling, never by
 * the page moving the position under it.
 */
function ProcessWindow({
  id,
  live,
  children,
}: {
  id: string;
  live: boolean;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // When the reader last did something to the window, as far as it knows.
  const userAt = useRef(Number.NEGATIVE_INFINITY);
  const noteUser = useCallback(() => {
    userAt.current = performance.now();
  }, []);
  const [faded, setFaded] = useState(false);

  const follow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !live || !following.current) return;
    if (el.scrollTop >= el.scrollHeight - el.clientHeight - 0.5) return;
    el.scrollTop = el.scrollHeight;
  }, [live]);

  // A look at the end, once a frame at most, after that frame's layout. A
  // render asks for one (a step that grew and shrank again within a frame
  // reports no change of size, yet may have left the end out of reach), and so
  // does a scroll the reader did not make; the browser's report of a change of
  // size comes with its own.
  const frame = useRef(0);
  const look = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      follow();
    });
  }, [follow]);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !live) return;
    setFaded(el.scrollTop > 1);
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const now = performance.now();
    const theirs = now - userAt.current < USER_SCROLL_MS;
    // Their scrolling goes on for as long as its events do (a fling), until it
    // arrives at the very end: what the page does a moment later (a clamp, say)
    // is not theirs. Not before: a fling that starts at the end passes through
    // here on its way up.
    if (theirs) userAt.current = gap < 1 ? Number.NEGATIVE_INFINITY : now;
    if (gap < FOLLOW_THRESHOLD_PX) {
      following.current = true;
    } else if (theirs) {
      following.current = false;
    } else if (following.current) {
      // Nobody scrolled: the page moved the position (a clamp). The end is
      // still where it is followed to.
      look();
    }
  }, [live, look]);

  // The end is in view when the window opens (and when it becomes the live
  // one); after that it is looked at once a frame, when something asks.
  useLayoutEffect(follow, [follow]);
  useLayoutEffect(() => {
    if (live) look();
  });
  useEffect(
    () => () => {
      // A cancelled frame is not a pending one: React's strict mode unmounts
      // and mounts the effects again, and a stale flag would stop every look.
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (
      !live ||
      !content ||
      !scroller ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [live, follow]);

  // Opening a row is reading it: the end is not followed past it. Once the
  // row has taken its place, a window still at the end follows again.
  const handleClick = () => {
    if (!live) return;
    noteUser();
    following.current = false;
    requestAnimationFrame(measure);
  };

  return (
    <div
      id={id}
      ref={scrollRef}
      onScroll={measure}
      onWheel={noteUser}
      onTouchStart={noteUser}
      onTouchMove={noteUser}
      onPointerDown={noteUser}
      onKeyDown={noteUser}
      onClickCapture={handleClick}
      data-scroll-fade={live && faded ? 'top' : undefined}
      data-hc-process-window=""
      className={cn(
        'mt-0.5 ml-1.5',
        // A phone has no window in the conversation: the rows scroll with it
        // and what is long in them folds (ClampedDetail).
        !isPhone && 'overflow-y-auto overscroll-contain',
        !isPhone &&
          (live ? 'max-h-60 pointer-coarse:max-h-40' : 'max-h-[60vh]'),
      )}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

/** The wait for the model, under the steps; it counts its own seconds. */
function WaitNote({ since, hasRows }: { since?: number; hasRows: boolean }) {
  const now = useTick(true);
  return (
    <div className={cn(hasRows && 'mt-1.5')}>
      <ModelWaitBody seconds={modelWaitSeconds(since, now)} />
    </div>
  );
}

// ── the card ────────────────────────────────────────────────────────────

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** Where the text below the card, and the card, are on screen. */
interface Sighting {
  below: Element;
  view: HTMLElement;
  /** Top of the text below the card. */
  y: number;
  /** The card is wholly above the top of the view. */
  cardAbove: boolean;
}

/** The page as the reader sees it now, or `null` when there is no text below. */
function sight(
  card: HTMLElement | null,
  scroller: { current: HTMLElement | null },
): Sighting | null {
  const below = card?.parentElement?.lastElementChild;
  if (!card || !below || below === card) return null;
  scroller.current ??= scrollParent(card);
  const view = scroller.current;
  if (!view) return null;
  return {
    below,
    view,
    y: below.getBoundingClientRect().top,
    cardAbove:
      card.getBoundingClientRect().bottom <= view.getBoundingClientRect().top,
  };
}

/**
 * The card folds by itself when its run ends, and what is below it moves up by
 * what it gave up. A reader who has scrolled past it, into the answer, would
 * see the text jump away from them (Safari has no scroll anchoring to hold it;
 * where there is, the net movement is what counts). So when the card is about
 * to fold, this notes where the text below it is on screen, and once it has
 * folded the scroll position takes up the difference. Not for a reader at the
 * end of the chat (the browser clamped the position to the shorter page:
 * nothing moved on screen) nor one who can see the card (what they watch is
 * the card).
 *
 * The page is read at that moment only. The fold shows in the props before it
 * shows in the page, so the render that is about to commit it still finds the
 * live card in the document, exactly as the reader sees it.
 */
function useFoldAnchor(
  ref: RefObject<HTMLElement | null>,
  mode: ProcessCardProps['mode'],
) {
  const scroller = useRef<HTMLElement | null>(null);
  const seen = useRef<Sighting | null>(null);
  const was = useRef(mode);
  if (was.current === 'live' && mode !== 'live') {
    seen.current = sight(ref.current, scroller);
  }
  useLayoutEffect(() => {
    const before = was.current;
    was.current = mode;
    const sighting = seen.current;
    seen.current = null;
    if (before !== 'live' || mode === 'live' || !sighting) return;
    if (!sighting.cardAbove || !sighting.below.isConnected) return;
    // Reading the position lays the folded page out; the net movement is what
    // the reader would see, whoever has moved the scroll position already.
    const { view } = sighting;
    const drift = sighting.below.getBoundingClientRect().top - sighting.y;
    const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
    if (Math.abs(drift) > 1 && gap > 1) view.scrollTop += drift;
  }, [mode]);
}

/**
 * The process of a reply as one card, live or settled. Live, it is a headline
 * that says what the run is doing now over a window of its steps; settled, it
 * is a line that says what it did, and the same steps behind it. How it is
 * open is the reader's choice once they have made one: the card never folds
 * or opens over it.
 */
export const ProcessCard = memo(function ProcessCard({
  mode,
  steps,
  stepsDropped = 0,
  groupJid,
  taskStates,
  activeTools = EMPTY_TOOLS,
  waiting = false,
  waitingSince,
  hasContent = false,
  commentary = true,
  thinkingText = true,
  durationMs,
  answering = false,
  memoryKey,
  defaultOpen,
  onOpenChange,
  className,
}: ProcessCardProps) {
  const live = mode === 'live';
  // At work: the run is producing steps, not yet the answer. Folded otherwise.
  const working = live && !answering;
  const shown = useMemo(
    () => visibleSteps(steps, commentary),
    [steps, commentary],
  );
  // Rows to list: a question put to the reader has its own place, not a row.
  const listed = hasProcess(shown);
  // A wait between tools shows only once it has lasted a moment.
  const waitVisible = useAfterDelay(
    working && waiting,
    hasContent ? LATER_WAIT_DELAY_MS : 0,
  );
  // What the reader chose, for this card or for the one it replaces; until
  // then the card follows its own state.
  const [chosen, setChosen] = useState<boolean | undefined>(() =>
    rememberedProcessOpen(memoryKey),
  );
  // The choice outlives this card: the reply that takes its place keeps it.
  useEffect(() => {
    if (chosen !== undefined) rememberProcessOpen(memoryKey, chosen);
  }, [chosen, memoryKey]);
  const bodyId = useId();
  // A reader reading a row in the window has chosen to have it open: the card
  // does not fold over them when its answer starts or its run ends.
  const keepOpen = useCallback(
    () => setChosen((current) => current ?? true),
    [],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useFoldAnchor(rootRef, working ? 'live' : 'settled');
  if (!listed && !waitVisible) {
    // A question alone is the card the reader answers, with no process to open.
    return shown.some(isQuestionStep) ? (
      <QuestionCards steps={shown} activeTools={activeTools} />
    ) : null;
  }

  const open = chosen ?? (working ? true : (defaultOpen ?? false));
  const toggle = () => {
    const next = !open;
    setChosen(next);
    onOpenChange?.(next);
  };
  // At work and as it comes, the latest rows (cindy's five); all of them once
  // the reader asked, or the process is over.
  const maxRows =
    working && chosen === undefined
      ? LIVE_TIMELINE_ROWS
      : SETTLED_TIMELINE_ROWS;
  const counts =
    open && !working ? describeWorkCounts(shown, stepsDropped) : '';

  const timeline = (
    <ProcessTimeline
      steps={shown}
      stepsDropped={stepsDropped}
      groupJid={groupJid}
      taskStates={taskStates}
      thinkingText={thinkingText}
      live={live}
      maxRows={maxRows}
      titleInHeader={working}
      onInteract={keepOpen}
      thinkingMaxHeight={
        working ? 'max-h-36 pointer-coarse:max-h-24' : undefined
      }
      after={
        waitVisible ? (
          <WaitNote since={waitingSince} hasRows={listed} />
        ) : undefined
      }
    />
  );

  return (
    <div
      ref={rootRef}
      data-hc-process-card=""
      data-mode={mode}
      data-folded={working ? undefined : ''}
      data-hc-model-wait={!listed && waitVisible ? '' : undefined}
      className={cn('mb-2 font-sans', className)}
    >
      <ProcessHeader
        working={working}
        steps={shown}
        waiting={waitVisible}
        waitingSince={waitingSince}
        thinkingText={thinkingText}
        durationMs={durationMs}
        open={open}
        bodyId={open ? bodyId : undefined}
        onToggle={toggle}
      />
      {open && (
        <ProcessWindow id={bodyId} live={working}>
          {counts && (
            <p
              data-hc-work-counts=""
              className="mb-1 text-caption text-faint-foreground"
            >
              {counts}
            </p>
          )}
          {timeline}
        </ProcessWindow>
      )}
      <QuestionCards steps={shown} activeTools={activeTools} />
      <MemoryReceipts steps={shown} groupJid={groupJid} />
    </div>
  );
});
