import {
  Fragment,
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Bot,
  ChevronRight,
  FileText,
  FolderSearch,
  Globe,
  MessageSquare,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  StreamingState,
  StreamingTaskRuntimeState,
} from '../../stores/chat';
import {
  buildProcessView,
  cleanToolSummary,
  describeGroup,
  describeStepCall,
  firstOutputLine,
  hasListedSteps,
  isQuestionStep,
  itemSteps,
  processSpanMs,
  stepDurationMs,
  summarizeGroup,
  toolCategory,
  toolOpensByDefault,
  toolOutput,
  visibleSteps,
  type ProcessItem,
  type ToolCategory,
} from '../../lib/process-steps';
import {
  TIMELINE_ROWS,
  readStepQuestions,
  summarizeSteps,
  type StreamingStep,
} from '../../lib/stream-steps';
import {
  formatResultFacts,
  formatTaskUsage,
  splitResultFacts,
} from '../../lib/process-facts';
import { stripInlineMarkdown } from '../../lib/thinking-text';
import { formatRunElapsed } from '../../lib/run-phase';
import { useTick } from '../../hooks/useTick';
import { formatElapsedMs } from '../../utils/format-elapsed';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ModelWaitRow } from './ModelWaitRow';
import { SubAgentBody, subAgentHasBody } from './SubAgentCard';
import {
  TOOL_STATE,
  ToolStateIcon,
  countToolStates,
  describeProblems,
  stepToolState,
  taskToolState,
  worstProblem,
  type ToolState,
} from './tool-status';
import { NO_SUMMARY_EXPLANATION, ThinkingBody } from './ThinkingBlock';
import { InfoTip } from '../common/InfoTip';
import { ClampedDetail } from './ClampedDetail';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { describeToolName } from './ToolActivityCard';
import { FinalMarkdown } from './StreamingMarkdown';
import { WorkflowRunCard } from './WorkflowRunCard';
import { isWorkflowTask, workflowRunOf } from './workflow-run';

/** A wait between tools shows its placeholder only once it has lasted a moment. */
export const LATER_WAIT_DELAY_MS = 800;

const EMPTY_TASKS: Record<string, StreamingTaskRuntimeState> = {};

/** A finger, not a mouse: no hover, so no tooltip. */
const COARSE_POINTER = '(pointer: coarse)';

// ── one row ─────────────────────────────────────────────────────────────

const ROW_CLASS =
  'flex min-h-7 w-full items-center gap-2 rounded-md px-1 text-left font-sans text-label pointer-coarse:min-h-10';
const ROW_BUTTON_CLASS =
  'cursor-pointer transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none';
const ICON_CLASS = 'size-3.5 shrink-0';

type Tone = 'quiet' | 'active' | 'warning' | 'error';

const ICON_TONE: Record<Tone, string> = {
  quiet: 'text-faint-foreground',
  active: 'text-muted-foreground',
  warning: 'text-warning',
  error: 'text-error',
};

/** A row's tone for a call in this state. */
function stateTone(state: ToolState): Tone {
  if (state === 'running' || state === 'background') return 'active';
  if (TOOL_STATE[state].quiet) return 'quiet';
  return state === 'stopped' ? 'warning' : 'error';
}

/**
 * A call's mark: its state's, or, when the state has nothing to say (done,
 * never closed), the row's own mark for the kind of call it was.
 */
function StateIcon({ state, kind }: { state: ToolState; kind: LucideIcon }) {
  return TOOL_STATE[state].quiet ? (
    <RowIcon icon={kind} tone="quiet" />
  ) : (
    <ToolStateIcon state={state} />
  );
}

function RowIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: Tone }) {
  return (
    <Icon aria-hidden="true" className={cn(ICON_CLASS, ICON_TONE[tone])} />
  );
}

interface RowFrameProps {
  icon: ReactNode;
  label: ReactNode;
  /** The label takes the free width (a title, a line of text); else `detail` does. */
  grow?: boolean;
  /** Second-hand information: what the call was given, why it failed. */
  detail?: ReactNode;
  /** The detail is a command or a path. */
  mono?: boolean;
  /** What the call did, between the detail and the time: "+12 −3". */
  facts?: ReactNode;
  /** How long it took, or has taken so far. */
  time?: string;
  tone?: Tone;
  /** The row is going on right now: its label shimmers. */
  running?: boolean;
  /** Spoken after the row, for what the icon shows. */
  status?: string;
  /** The tooltip of the whole row. */
  title?: string;
  /** What a touch reader opens the row to read when its text is cut short. */
  more?: string;
  /** Present when the row opens: it is then a button. */
  open?: boolean;
  onToggle?: () => void;
  /** The row's own icon is the chevron: it takes no second one at the end. */
  endChevron?: boolean;
  /** Names the row's button, so focus can be found again after a remount. */
  rowId?: string;
  panelId?: string;
  /** What opens under the row. */
  children?: ReactNode;
}

/**
 * Every row of the process timeline has this shape: icon, label, second-hand
 * information that takes what room is left, the time on the right, and a
 * chevron when the row opens. One skeleton for reasoning, tools, notes and
 * groups is what makes the list read as one list.
 */
function RowFrame({
  icon,
  label,
  grow = false,
  detail,
  mono = false,
  facts,
  time,
  tone = 'quiet',
  running = false,
  status,
  title,
  more,
  open = false,
  onToggle,
  endChevron = true,
  rowId,
  panelId,
  children,
}: RowFrameProps) {
  // Touch has no tooltip: a row cut short opens to say all of it.
  const coarse = useMediaQuery(COARSE_POINTER);
  const rowRef = useRef<HTMLButtonElement & HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const morePanelId = useId();
  const measureCut = coarse && more != null && !onToggle;
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!measureCut || !row) return;
    // The row turns from a div into a button once it is found cut short:
    // the effect then measures the button, and the div it left is ignored.
    const measure = () => {
      if (!row.isConnected) return;
      setCut(
        [...row.querySelectorAll<HTMLElement>('.truncate')].some(
          (span) => span.scrollWidth > span.clientWidth + 1,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [measureCut, cut, more]);
  const showMore = measureCut && cut;
  const rowOpen = showMore ? moreOpen : open;
  const toggle = showMore ? () => setMoreOpen((value) => !value) : onToggle;
  const rowPanelId = showMore ? morePanelId : panelId;
  const panel = showMore ? (
    <p
      data-hc-row-more=""
      className="text-caption break-words whitespace-pre-wrap text-muted-foreground"
    >
      {more}
    </p>
  ) : (
    children
  );
  const expandable = toggle !== undefined;
  const content = (
    <>
      {icon}
      <span
        className={cn(
          grow
            ? 'min-w-0 flex-1 truncate'
            : 'max-w-[60%] shrink-0 truncate font-medium',
          tone === 'quiet' && !running
            ? 'text-muted-foreground'
            : 'text-foreground',
          running && 'shimmer',
        )}
      >
        {label}
      </span>
      {!grow &&
        (detail ? (
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              mono && 'font-mono text-caption',
              tone === 'error' || tone === 'warning'
                ? ICON_TONE[tone]
                : running
                  ? 'text-muted-foreground'
                  : 'text-faint-foreground',
            )}
          >
            {detail}
          </span>
        ) : (
          <span className="flex-1" />
        ))}
      {facts && (
        <span className="min-w-0 truncate text-caption text-faint-foreground tabular-nums">
          {facts}
        </span>
      )}
      {time && (
        <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
          {time}
        </span>
      )}
      {/* Rows that do not open keep the chevron's room, so the times line up. */}
      {!endChevron ? null : expandable ? (
        <ChevronRight
          className={cn(
            ICON_CLASS,
            'text-faint-foreground transition-transform duration-150',
            rowOpen && 'rotate-90',
          )}
          aria-hidden="true"
        />
      ) : (
        <span aria-hidden="true" className={ICON_CLASS} />
      )}
      {status && <span className="sr-only">{status}</span>}
    </>
  );
  return (
    <>
      {expandable ? (
        <button
          ref={rowRef}
          type="button"
          onClick={toggle}
          aria-expanded={rowOpen}
          aria-controls={rowOpen ? rowPanelId : undefined}
          data-hc-row={rowId}
          title={title}
          className={cn(ROW_CLASS, ROW_BUTTON_CLASS)}
        >
          {content}
        </button>
      ) : (
        <div ref={rowRef} title={title} className={ROW_CLASS}>
          {content}
        </div>
      )}
      {rowOpen && panel && (
        // Under the label: the row's padding, the icon and its gap add up to 26px.
        <div id={rowPanelId} className="mb-1 ml-6.5">
          {panel}
        </div>
      )}
    </>
  );
}

/** A running row's time so far; nothing in its first second. */
function elapsedLabel(now: number, at: number): string | undefined {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds >= 1 ? formatRunElapsed(seconds) : undefined;
}

/**
 * The step was still going when its card stopped being the live one (a stop
 * came before the run said it was over): it is not done, and not said to be.
 */
function unfinished(step: StreamingStep, live: boolean): boolean {
  return step.status === 'running' && !live;
}

function durationLabel(step: StreamingStep): string | undefined {
  const ms = stepDurationMs(step);
  return ms != null ? formatElapsedMs(ms) || undefined : undefined;
}

// ── reasoning ───────────────────────────────────────────────────────────

interface RowProps<Item = StreamingStep> {
  step: Item;
  open: boolean;
  onToggle: (id: string, next: boolean) => void;
  /** The clock a running row counts by (0 for the rows that are not running). */
  now: number;
  /** The run is producing this card now: what is running here is running. */
  live: boolean;
  groupJid: string;
}

const ThinkingRow = memo(function ThinkingRow({
  step,
  open,
  onToggle,
  now,
  live,
  groupJid,
  thinkingText,
  titleInHeader,
  thinkingMaxHeight,
}: RowProps & {
  thinkingText: boolean;
  /** The card's headline says what this row's title would: the row does not. */
  titleInHeader: boolean;
  thinkingMaxHeight?: string;
}) {
  const panelId = useId();
  const running = step.status === 'running' && live;
  const text = thinkingText ? (step.text ?? '') : '';
  const title =
    thinkingText && !(running && titleInHeader) ? step.title : undefined;
  const canOpen = text.trim().length > 0;
  const durationMs =
    step.status === 'running' ? undefined : stepDurationMs(step);
  // The model reasoned, for a while, and returned no summary of it. Say so
  // instead of leaving a row that looks as if it could be opened. Not when the
  // text is only withheld from this view.
  const noSummary =
    thinkingText &&
    step.status !== 'running' &&
    !canOpen &&
    durationMs != null &&
    durationMs >= 1000;
  return (
    <RowFrame
      icon={<RowIcon icon={Sparkles} tone={running ? 'active' : 'quiet'} />}
      label={title || '思考'}
      grow={!!title}
      detail={
        noSummary ? (
          <InfoTip content={NO_SUMMARY_EXPLANATION}>
            <button
              type="button"
              data-hc-no-summary=""
              className="cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              模型未返回思考内容
            </button>
          </InfoTip>
        ) : undefined
      }
      time={
        running
          ? elapsedLabel(now, step.at)
          : durationMs != null
            ? formatElapsedMs(durationMs) || undefined
            : undefined
      }
      running={running}
      status={
        running ? '，进行中' : unfinished(step, live) ? '，未完成' : undefined
      }
      open={open && canOpen}
      onToggle={canOpen ? () => onToggle(step.id, !open) : undefined}
      rowId={step.id}
      panelId={panelId}
    >
      <ThinkingBody
        text={text}
        live={running}
        groupJid={groupJid}
        variant="row"
        maxHeightClass={thinkingMaxHeight}
      />
    </RowFrame>
  );
});

// ── tools ───────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  terminal: Terminal,
  file: FileText,
  search: Search,
  web: Globe,
  generic: Wrench,
};

/** A summary that is long enough to be cut short in its row opens to be read. */
const LONG_SUMMARY_CHARS = 80;

/** "+12 −3" with what was added in the success colour and what was removed in the error one. */
function FactsText({ text, plain }: { text: string; plain?: boolean }) {
  if (plain) return <>{text}</>;
  return (
    <>
      {splitResultFacts(text).map((segment, index) => (
        <Fragment key={index}>
          {segment.tone ? (
            <span
              className={
                segment.tone === 'added' ? 'text-success' : 'text-error'
              }
            >
              {segment.text}
            </span>
          ) : (
            segment.text
          )}
        </Fragment>
      ))}
    </>
  );
}

const ToolStepRow = memo(function ToolStepRow({
  step,
  open,
  onToggle,
  now,
  live,
}: RowProps) {
  const panelId = useId();
  const name = step.toolName ?? 'unknown';
  const { hint } = describeToolName(name, step.skillName);
  const { verb, param } = describeStepCall(step);
  const summary = cleanToolSummary(step.summary);
  const state = stepToolState(step, live);
  const running = state === 'running';
  const failed = step.status === 'error';
  const tone = stateTone(state);
  const output = toolOutput(step);
  const facts =
    step.status === 'running'
      ? null
      : formatResultFacts(name, step.resultFacts, failed);
  // A failed call says what went wrong where a good one says what it was
  // given: its facts first ("退出码 1"), then the first line of its output.
  const failure = failed
    ? [facts, output && firstOutputLine(output)].filter(Boolean).join(' · ')
    : '';
  const longSummary =
    !!summary &&
    (summary.length > LONG_SUMMARY_CHARS || summary.includes('\n'));
  // Touch has no tooltip for a command cut short: an open row says it whole.
  const coarse = useMediaQuery(COARSE_POINTER);
  const expandable = !!output || longSummary;
  return (
    <RowFrame
      icon={
        <StateIcon state={state} kind={CATEGORY_ICON[toolCategory(name)]} />
      }
      label={verb}
      detail={failure || param}
      mono={!failure && name === 'Bash'}
      facts={!failed && facts ? <FactsText text={facts} /> : undefined}
      time={
        running
          ? elapsedLabel(now, step.at)
          : step.status === 'running'
            ? undefined
            : durationLabel(step)
      }
      tone={tone}
      running={running}
      status={`，${TOOL_STATE[state].label}`}
      title={summary ?? hint}
      more={summary}
      open={open && expandable}
      onToggle={expandable ? () => onToggle(step.id, !open) : undefined}
      rowId={step.id}
      panelId={panelId}
    >
      <div className="space-y-1 text-caption break-words">
        {summary && (longSummary || !!failure || (coarse && !!output)) && (
          <ClampedDetail
            title={verb}
            maxHeightClass="max-h-32"
            className={cn(
              'whitespace-pre-wrap text-muted-foreground',
              name === 'Bash' && 'font-mono',
            )}
          >
            {summary}
          </ClampedDetail>
        )}
        {output && (
          <ClampedDetail
            pre
            title={`${verb} · 输出`}
            maxHeightClass="max-h-40"
            tabIndex={0}
            className={cn(
              'rounded-sm font-mono text-label break-words whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
              failed ? ICON_TONE[tone] : 'text-muted-foreground',
            )}
          >
            {output}
          </ClampedDetail>
        )}
      </div>
    </RowFrame>
  );
});

const ReadGroupRow = memo(
  function ReadGroupRow({
    group,
    override,
    onToggle,
    now,
    live,
    groupJid,
    open,
  }: Omit<RowProps<never>, 'step'> & {
    group: Extract<ProcessItem, { type: 'group' }>;
    override: Readonly<Record<string, boolean>>;
  }) {
    const panelId = useId();
    const summary = summarizeGroup(group.steps);
    const running = live && summary.running > 0;
    const counts = countToolStates(group.steps, live);
    const problem = worstProblem(counts);
    const state: ToolState = problem ?? (running ? 'running' : 'done');
    const span = processSpanMs(group.steps);
    const label = [
      describeGroup({ ...summary, running: running ? summary.running : 0 }),
      ...describeProblems(counts),
    ].join(' · ');
    return (
      <RowFrame
        icon={<StateIcon state={state} kind={FolderSearch} />}
        label={label}
        grow
        time={
          running
            ? elapsedLabel(now, group.steps[0].at)
            : span != null
              ? formatElapsedMs(span) || undefined
              : undefined
        }
        tone={stateTone(state)}
        running={running}
        status={
          running
            ? '，运行中'
            : !live && summary.running > 0
              ? '，未完成'
              : problem
                ? `，${TOOL_STATE[problem].label}`
                : '，已完成'
        }
        open={open}
        onToggle={() => onToggle(group.id, !open)}
        rowId={group.id}
        panelId={panelId}
      >
        <div role="list" aria-label="已合并的读取步骤">
          {group.steps.map((step) => (
            <div role="listitem" key={step.id}>
              <ToolStepRow
                step={step}
                open={override[step.id] ?? toolOpensByDefault(step)}
                onToggle={onToggle}
                now={step.status === 'running' ? now : 0}
                live={live}
                groupJid={groupJid}
              />
            </div>
          ))}
        </div>
      </RowFrame>
    );
  },
  (prev, next) =>
    prev.open === next.open &&
    prev.now === next.now &&
    prev.live === next.live &&
    prev.override === next.override &&
    prev.onToggle === next.onToggle &&
    prev.group.id === next.group.id &&
    prev.group.steps.length === next.group.steps.length &&
    prev.group.steps.every((step, index) => step === next.group.steps[index]),
);

// ── notes and sub-agents ────────────────────────────────────────────────

const TextRow = memo(function TextRow({
  step,
  open,
  onToggle,
  groupJid,
}: RowProps) {
  const panelId = useId();
  const text = step.text ?? '';
  return (
    <RowFrame
      icon={<RowIcon icon={MessageSquare} tone="quiet" />}
      label={
        open ? (step.progress ? '进展' : '过程说明') : stripInlineMarkdown(text)
      }
      grow
      open={open}
      onToggle={() => onToggle(step.id, !open)}
      rowId={step.id}
      panelId={panelId}
    >
      <ClampedDetail
        title={step.progress ? '进展' : '过程说明'}
        maxHeightClass="max-h-48"
        className="text-muted-foreground [&_[data-markdown-root]]:text-label [&_[data-markdown-root]]:text-muted-foreground"
      >
        <FinalMarkdown content={text} variant="docs" groupJid={groupJid} />
      </ClampedDetail>
    </RowFrame>
  );
});

const TaskRow = memo(function TaskRow({
  step,
  task,
  open,
  onToggle,
  now,
  live,
  groupJid,
}: RowProps & { task?: StreamingTaskRuntimeState }) {
  const panelId = useId();
  if (task && isWorkflowTask(task)) {
    return <WorkflowRunCard run={workflowRunOf(task)} />;
  }
  // Without the sub-agent's details (a reconnect rebuilt the step but not the
  // card) it is a row of its own, with nothing to open.
  const state = taskToolState(step, task, live);
  const running = state === 'running' || state === 'background';
  const failed = !running && !TOOL_STATE[state].quiet;
  const canOpen = !!task && subAgentHasBody(task);
  const tone = stateTone(state);
  const detail = task
    ? [task.subagentType, task.lastToolName, task.latestSummary]
        .filter(Boolean)
        .join(' · ')
    : step.summary;
  // What it did, once its call returned; until then what it has cost so far.
  const facts =
    formatResultFacts('Agent', step.resultFacts, failed) ??
    formatTaskUsage(task?.usage);
  return (
    <RowFrame
      icon={<StateIcon state={state} kind={Bot} />}
      label={task?.title ?? step.title ?? '子 Agent'}
      detail={detail}
      facts={facts ? <FactsText text={facts} plain={failed} /> : undefined}
      // The facts are cut short in a narrow row: the whole of them is here.
      title={facts ?? undefined}
      more={facts ?? undefined}
      time={
        running
          ? elapsedLabel(now, step.at)
          : step.status === 'running'
            ? undefined
            : durationLabel(step)
      }
      tone={tone}
      running={running}
      status={`，子 Agent，${TOOL_STATE[state].label}`}
      open={open && canOpen}
      onToggle={canOpen ? () => onToggle(step.id, !open) : undefined}
      rowId={step.id}
      panelId={panelId}
    >
      {task && (
        <div className="space-y-2 text-caption">
          <SubAgentBody task={task} groupJid={groupJid} inline />
        </div>
      )}
    </RowFrame>
  );
});

// ── older steps ─────────────────────────────────────────────────────────

/** Steps folded out of sight: what they were, and a way to see them. */
function FoldedRow({
  folded,
  dropped,
  open,
  onToggle,
}: {
  folded: StreamingStep[];
  dropped: number;
  open: boolean;
  onToggle: () => void;
}) {
  const sum = summarizeSteps(folded);
  const parts = [`较早 ${folded.length + dropped} 步`];
  if (sum.tools + sum.tasks > 0) parts.push(`${sum.tools + sum.tasks} 个工具`);
  if (sum.thinking > 0) parts.push(`${sum.thinking} 段思考`);
  parts.push(...describeProblems(countToolStates(folded)));
  return (
    <RowFrame
      icon={
        <ChevronRight
          aria-hidden="true"
          className={cn(
            ICON_CLASS,
            'text-faint-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      }
      label={<span className="tabular-nums">{parts.join(' · ')}</span>}
      grow
      open={open}
      onToggle={onToggle}
      endChevron={false}
      rowId="folded"
      title="较早的步骤"
    />
  );
}

// ── the list ────────────────────────────────────────────────────────────

export interface ProcessTimelineProps {
  /** The steps to list: what the card shows, the commentary already chosen. */
  steps: StreamingStep[];
  stepsDropped?: number;
  groupJid: string;
  taskStates?: Record<string, StreamingTaskRuntimeState>;
  /** Show reasoning titles and text; off, only that the model reasoned. */
  thinkingText?: boolean;
  /** The run is producing these steps now: what runs here animates and counts. */
  live: boolean;
  /** How many rows are listed before the older ones fold into one line. */
  maxRows?: number;
  /**
   * A headline above says what the reasoning being written is titled: its row
   * does not say it again.
   */
  titleInHeader?: boolean;
  /** The height (`max-h-*`) of a row's open reasoning text. */
  thinkingMaxHeight?: string;
  /** The reader opened or closed a row. */
  onInteract?: () => void;
  /** Under the list, on the same line down the left. */
  after?: ReactNode;
}

/**
 * The steps of a reply in the order they happened, as rows of one skeleton
 * along a single line down the left. Older steps fold into one row; a run of
 * read-only calls is one row; the step in progress is open and the reader's
 * own opening or closing of a row is never overridden. The answer is not a
 * step of this list: it is the text below it.
 */
export const ProcessTimeline = memo(function ProcessTimeline({
  steps,
  stepsDropped = 0,
  groupJid,
  taskStates = EMPTY_TASKS,
  thinkingText = true,
  live,
  maxRows = TIMELINE_ROWS,
  titleInHeader = false,
  thinkingMaxHeight,
  onInteract,
  after,
}: ProcessTimelineProps) {
  const view = useMemo(
    () => buildProcessView(steps, maxRows),
    [steps, maxRows],
  );
  // Rows the reader opened or closed themselves; the rest follow the default.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [foldedOpen, setFoldedOpen] = useState(false);
  // One list, folded rows and the rest, so a row that slides from one to the
  // other is the same row and keeps what the reader opened.
  const items = useMemo(
    () => (foldedOpen ? [...view.folded, ...view.rows] : view.rows),
    [foldedOpen, view],
  );
  const foldedSteps = useMemo(() => itemSteps(view.folded), [view.folded]);
  const counting =
    live && itemSteps(items).some((step) => step.status === 'running');
  const now = useTick(counting);
  const onToggle = useCallback(
    (id: string, next: boolean) => {
      setOverride((current) => ({ ...current, [id]: next }));
      onInteract?.();
    },
    [onInteract],
  );

  // A row that is rebuilt (a call that joins the one above it as a group)
  // would take the reader's focus with it: put it back where the row went.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focused.current;
    const active = document.activeElement;
    if (!id || (active && active !== document.body)) return;
    [...(root.current?.querySelectorAll<HTMLElement>('[data-hc-row]') ?? [])]
      .find((row) => row.getAttribute('data-hc-row') === id)
      ?.focus({ preventScroll: true });
  });

  const latestCommentaryId = useMemo(
    () =>
      [...steps]
        .reverse()
        .find((s) => s.kind === 'text' && s.commentary && !!s.text?.trim())?.id,
    [steps],
  );

  const defaultOpen = (step: StreamingStep): boolean => {
    if (step.kind === 'tool') return toolOpensByDefault(step);
    if (!live) return false;
    if (
      step.kind === 'text' &&
      step.commentary &&
      step.id === latestCommentaryId &&
      !!step.text &&
      (step.text.includes('\n') || step.text.length > 60)
    ) {
      return true;
    }
    if (step.status !== 'running') return false;
    return step.kind === 'thinking' && thinkingText && !!step.text?.trim();
  };

  const renderItem = (item: ProcessItem) => {
    if (item.type === 'group') {
      // A group that holds a row the reader opened is open: that row was theirs
      // before it was a member.
      const open =
        override[item.id] ??
        item.steps.some((step) => override[step.id] === true);
      return (
        <div role="listitem" key={item.id}>
          <ReadGroupRow
            group={item}
            override={override}
            open={open}
            onToggle={onToggle}
            now={now}
            live={live}
            groupJid={groupJid}
          />
        </div>
      );
    }
    const { step } = item;
    const open = override[step.id] ?? defaultOpen(step);
    const common = {
      step,
      open,
      onToggle,
      now: step.status === 'running' ? now : 0,
      live,
      groupJid,
    };
    let row: ReactNode;
    switch (step.kind) {
      case 'thinking':
        row = (
          <ThinkingRow
            {...common}
            thinkingText={thinkingText}
            titleInHeader={titleInHeader}
            thinkingMaxHeight={thinkingMaxHeight}
          />
        );
        break;
      case 'tool':
        row = <ToolStepRow {...common} />;
        break;
      case 'task':
        row = <TaskRow {...common} task={taskStates[step.taskId ?? '']} />;
        break;
      case 'text':
        row = <TextRow {...common} />;
        break;
    }
    return (
      <div role="listitem" key={step.id}>
        {row}
      </div>
    );
  };

  const hasRows = view.rows.length > 0 || view.folded.length > 0;
  if (!hasRows && !after) return null;
  return (
    <div
      ref={root}
      onFocus={(event) => {
        focused.current =
          (event.target as HTMLElement)
            .closest('[data-hc-row]')
            ?.getAttribute('data-hc-row') ?? null;
      }}
      onBlur={(event) => {
        const target = event.target as HTMLElement;
        // A row taken out of the page under focus does not count as the
        // reader moving on.
        queueMicrotask(() => {
          if (target.isConnected) focused.current = null;
        });
      }}
      className="border-l-2 border-surface-border pl-3 font-sans"
    >
      {hasRows && (
        <div
          role="list"
          aria-label="处理步骤"
          data-hc-step-timeline=""
          className="space-y-0.5"
        >
          {(view.folded.length > 0 || stepsDropped > 0) && (
            <div role="listitem">
              <FoldedRow
                folded={foldedSteps}
                dropped={stepsDropped}
                open={foldedOpen}
                onToggle={() => setFoldedOpen(!foldedOpen)}
              />
            </div>
          )}
          {items.map(renderItem)}
        </div>
      )}
      {after}
    </div>
  );
});

// ── a question for the reader ───────────────────────────────────────────

/**
 * The questions the model has put to the reader. They are not rows: a card
 * the reader has to answer must not scroll away or fold shut. The step keeps
 * them once the call returns, so they stay with the settled reply.
 */
export function QuestionCards({
  steps,
  activeTools,
}: {
  steps: readonly StreamingStep[];
  activeTools: StreamingState['activeTools'];
}) {
  const cards = steps
    .filter(isQuestionStep)
    .map((step) => ({
      id: step.id,
      toolUseId: step.toolUseId ?? step.id,
      questions:
        step.questions ??
        readStepQuestions(
          activeTools.find((tool) => tool.toolUseId === step.toolUseId)
            ?.toolInput,
        ),
    }))
    .filter((card) => card.questions);
  if (cards.length === 0) return null;
  return (
    <div className="mt-1 space-y-1.5">
      {cards.map((card) => (
        <AskUserQuestionCard
          key={card.id}
          toolUseId={card.toolUseId}
          questions={card.questions ?? []}
        />
      ))}
    </div>
  );
}

// ── the list on its own ─────────────────────────────────────────────────

export interface ProcessStepsProps {
  steps: StreamingStep[] | undefined;
  stepsDropped?: number;
  taskStates: Record<string, StreamingTaskRuntimeState>;
  activeTools: StreamingState['activeTools'];
  /** The model's request is out and nothing has come back. */
  waiting: boolean;
  /** When that request began (ms). */
  waitingSince?: number;
  /** Something is on the card already: a wait is then shown only if it lasts. */
  hasContent: boolean;
  groupJid: string;
  /** The run is producing these steps now (not a stopped or settled one). */
  live: boolean;
  /** Show the model's own commentary between steps. */
  commentary?: boolean;
  /** Show reasoning text; off, only that the model reasoned (and how long). */
  thinkingText?: boolean;
}

/**
 * The timeline and the wait for the model, without a header of their own: for
 * the panel of a proactive workspace, which has its own summary line.
 */
export const ProcessSteps = memo(function ProcessSteps({
  steps,
  stepsDropped = 0,
  taskStates,
  activeTools,
  waiting,
  waitingSince,
  hasContent,
  groupJid,
  live,
  commentary = true,
  thinkingText = true,
}: ProcessStepsProps) {
  const shown = useMemo(
    () => visibleSteps(steps ?? [], commentary),
    [steps, commentary],
  );
  const hasRows = hasListedSteps(shown);
  const hasQuestion = shown.some(isQuestionStep);
  if (!hasRows && !hasQuestion && !waiting) return null;
  return (
    <>
      {(hasRows || hasQuestion) && (
        <div className="mb-2">
          <ProcessTimeline
            steps={shown}
            stepsDropped={stepsDropped}
            groupJid={groupJid}
            taskStates={taskStates}
            thinkingText={thinkingText}
            live={live}
          />
          <QuestionCards steps={shown} activeTools={activeTools} />
        </div>
      )}
      <ModelWaitRow
        active={live && waiting}
        since={waitingSince}
        delayMs={hasContent ? LATER_WAIT_DELAY_MS : 0}
      />
    </>
  );
});
