import { useState, useMemo, memo, lazy, Suspense, type ReactNode } from 'react';
import {
  Copy,
  Check,
  Ellipsis,
  ImageDown,
  OctagonAlert,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '../common/IconButton';
import { cn } from '@/lib/utils';
import {
  useChatStore,
  type Message,
  type ReplySteps,
  type StreamingTraceEvent,
  withoutToolResults,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { FinalMarkdown } from './StreamingMarkdown';
import { PermissionAlert, TracePanel } from './ExecutionTrace';
import { ThinkingBlock } from './ThinkingBlock';
import { ProcessCard, hasProcess } from './ProcessCard';
import { LazyTurnTrace } from './LazyTurnTrace';
import { MessageContextMenu } from './MessageContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { CollapsibleUserText } from './CollapsibleUserText';
import { InfoTip } from '../common/InfoTip';
import { useIsPhone } from '../layout/phone';
import { useLongPress } from '../../hooks/useLongPress';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useStreamLayout } from '../../hooks/useStreamLayout';
import { extractThinkingTitle } from '../../lib/thinking-text';
import { normalizeInteractionMode } from '../../lib/interaction-mode';
import {
  isProgressStep,
  normalizeProcessVisibility,
} from '../../lib/process-visibility';
import { visibleSteps } from '../../lib/process-steps';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import {
  getPresentedMessageContent,
  incompleteReplyNote,
} from '../../lib/message-presentation';
import { copyToClipboard } from '../../utils/clipboard';
import {
  AutomationOriginLink,
  AutomationPromptText,
} from '../automations/AutomationOrigin';
import { toast } from 'sonner';
import { getMessageDisplayTimestamp } from '../../lib/message-timeline';
import {
  getAuthoritativeTokenBreakdown,
  getDisplayedTokenTotal,
  getPrimaryModelUsage,
  parseTokenUsage,
} from '../../lib/token-usage-presentation';
import { WorkflowRunCard } from './WorkflowRunCard';
import { formatTokens } from '../billing/utils';
import type { WorkflowRunSnapshot } from '../../stream-event.types';

/**
 * A reply's text. On a phone it reads at 17/26, cindy's reply size; the
 * Markdown root sets its own size, so this reaches it.
 */
export const REPLY_BODY_CLASS =
  'max-w-none overflow-hidden phone:[&_[data-markdown-root]]:text-reply phone:[&_[data-markdown-root]]:leading-(--text-reply--line-height)';

const ShareImageDialog = lazy(() =>
  import('./ShareImageDialog').then((m) => ({ default: m.ShareImageDialog })),
);

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  thinkingContent?: string;
  thinkingDurationMs?: number;
  /** Tools and other steps the reply streamed, kept collapsed. */
  traceEvents?: StreamingTraceEvent[];
  /** The ordered steps the reply streamed (or the server kept). */
  replySteps?: ReplySteps;
  agentName?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
}

interface MessageAttachment {
  type: 'image';
  /**
   * base64. For stored history this is a downscaled thumbnail — a page of
   * full-resolution photos reached tens of MB and the browser failed the whole
   * request, blanking the history. `hasOriginal` marks the ones whose full
   * image must be fetched separately.
   */
  data: string;
  mimeType?: string;
  name?: string;
  hasOriginal?: boolean;
  originalBytes?: number;
}

// Shared formatters: toLocaleString with options builds a new formatter on
// every call (~60µs each), twice per bubble render.
const HOUR_MINUTE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const FULL_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 今天显示 HH:mm，其余日期显示 MM-DD HH:mm；完整时间放在 title 里。 */
function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const hm = HOUR_MINUTE_FORMATTER.format(date);
  if (date.toDateString() === now.toDateString()) return hm;
  const md = `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`;
  return date.getFullYear() === now.getFullYear()
    ? `${md} ${hm}`
    : `${date.getFullYear()}-${md} ${hm}`;
}

/**
 * The usage of a reply: its one-line summary ("12.3K tokens · 4.2s") and, when
 * there is more to say, the breakdown.
 */
interface TokenUsageView {
  summary: ReactNode;
  details: ReactNode | null;
}

/** A reply's usage, read once for both ways it is shown; `null` for none. */
function tokenUsageView(
  tokenUsageJson: string,
  workflowRuns: WorkflowRunSnapshot[] = [],
): TokenUsageView | null {
  const usage = parseTokenUsage(tokenUsageJson);
  if (!usage) return null;

  // 主模型 = 费用最高的（即用户指定的模型），内部模型不向用户展示
  const primary = getPrimaryModelUsage(usage);
  const breakdown = getAuthoritativeTokenBreakdown(usage);
  const workflowTokens = workflowRuns.reduce(
    (total, run) => total + (run.totalTokens || 0),
    0,
  );
  // Workflow subagents are billed outside the main assistant-message usage
  // payload. Present both authorities together instead of showing a false 0.
  const displayTotal = getDisplayedTokenTotal(
    usage,
    workflowRuns.map((run) => run.totalTokens),
  );
  if (displayTotal === 0 && !usage.durationMs) return null;

  const summary = (
    <>
      {displayTotal > 0 && <span>{formatTokens(displayTotal)} tokens</span>}
      {usage.durationMs ? (
        <>
          {displayTotal > 0 && <span className="opacity-60">·</span>}
          <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
    </>
  );
  const details =
    displayTotal > 0 || primary !== null ? (
      <div className="text-xs space-y-0.5">
        {primary && (
          <div className="opacity-70 font-medium mb-1">
            主模型：{primary[0]}
          </div>
        )}
        {breakdown.totalTokens > 0 && (
          <div>
            输入 {formatTokens(breakdown.inputTokens)} / 输出{' '}
            {formatTokens(breakdown.outputTokens)}
          </div>
        )}
        {workflowTokens > 0 && (
          <div className="opacity-70">
            Workflow Agent 合计 {formatTokens(workflowTokens)}
          </div>
        )}
        {(breakdown.cacheReadInputTokens > 0 ||
          breakdown.cacheCreationInputTokens > 0 ||
          breakdown.reasoningTokens > 0) && (
          <div className="opacity-70">
            缓存读取 {formatTokens(breakdown.cacheReadInputTokens)} / 缓存写入{' '}
            {formatTokens(breakdown.cacheCreationInputTokens)} / 推理{' '}
            {formatTokens(breakdown.reasoningTokens)}
          </div>
        )}
        {primary && (
          <div className="opacity-70">
            主模型输入 {formatTokens(primary[1].inputTokens || 0)} / 输出{' '}
            {formatTokens(primary[1].outputTokens || 0)}
          </div>
        )}
      </div>
    ) : null;
  return { summary, details };
}

/** A reply's usage in its action row, the breakdown on hover. */
function TokenUsageDisplay({
  view,
  className,
}: {
  view: TokenUsageView;
  className?: string;
}) {
  const summaryContent = (
    <span
      className={cn(
        'inline-flex cursor-default items-center gap-1.5 font-sans text-micro text-faint-foreground tabular-nums transition-colors hover:text-muted-foreground',
        className,
      )}
    >
      {view.summary}
    </span>
  );
  if (!view.details) return summaryContent;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{summaryContent}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {view.details}
      </TooltipContent>
    </Tooltip>
  );
}

/** A phone's action row keeps the usage behind 「详情」, out of the row. */
function TokenUsagePopover({ view }: { view: TokenUsageView }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hidden h-11 cursor-pointer items-center rounded-md px-2 font-sans text-caption text-faint-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none phone:inline-flex"
        >
          详情
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-auto max-w-72">
        <div className="mb-1 flex items-center gap-1.5 font-sans text-caption text-muted-foreground tabular-nums">
          {view.summary}
        </div>
        {view.details}
      </PopoverContent>
    </Popover>
  );
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    showTime,
    thinkingContent,
    thinkingDurationMs,
    traceEvents,
    replySteps,
    agentName,
    agentAvatarUrl,
    agentAvatarEmoji,
    agentAvatarColor,
  }: MessageBubbleProps) {
    const [copied, setCopied] = useState(false);
    const [lightboxState, setLightboxState] = useState<{
      images: string[];
      index: number;
    } | null>(null);
    const [showShareDialog, setShowShareDialog] = useState(false);
    // A phone opens the message's menu by a long press on it as well as by
    // its 「⋯」; one menu, so both open the same sheet.
    const isPhone = useIsPhone();
    const [menuOpen, setMenuOpen] = useState(false);
    const longPress = useLongPress(() => setMenuOpen(true));
    const pressToOpenMenu = isPhone ? longPress : undefined;
    const currentUser = useAuthStore((s) => s.user);
    const { layout } = useStreamLayout();
    const appearance = useAuthStore((s) => s.appearance);
    const agentIdentity = resolveAgentDisplayIdentity({
      agentName,
      messageSenderName: message.sender_name,
      avatarUrl: agentAvatarUrl,
      avatarEmoji: agentAvatarEmoji,
      avatarColor: agentAvatarColor,
      appearance,
    });
    const { mode: displayMode } = useDisplayMode();
    const thinkingTitle = useMemo(
      () =>
        thinkingContent
          ? extractThinkingTitle(thinkingContent, { final: true })
          : undefined,
      [thinkingContent],
    );
    // What the server kept of a turn this tab did not stream, shown as the
    // same rows and loaded when one is opened. A proactive workspace shows
    // only what its owner chose: the progress the Agent sent when hidden, no
    // reasoning text at the activity level.
    const [openOnLoad, setOpenOnLoad] = useState<
      'thinking' | 'trace' | 'process' | null
    >(null);
    const process = useChatStore((s) => {
      const group = s.groups[message.chat_jid.replace(/#agent:.*$/, '')];
      return normalizeInteractionMode(group?.interaction_mode) === 'proactive'
        ? normalizeProcessVisibility(group?.process_visibility)
        : 'full';
    });
    // A proactive workspace never shows what a tool returned, at any level.
    const proactive = useChatStore(
      (s) =>
        normalizeInteractionMode(
          s.groups[message.chat_jid.replace(/#agent:.*$/, '')]
            ?.interaction_mode,
        ) === 'proactive',
    );
    const loadTurnTrace = useChatStore((s) => s.loadTurnTrace);
    // At the hidden level only the progress the Agent sent is shown of what
    // this tab holds of the process: the rest may have been read when the
    // level was higher.
    const processShown = process !== 'hidden';
    // The steps this tab holds were read for the workspace as it was then. The
    // caches are let go when its view changes; this is what shows meanwhile:
    // the steps as the workspace shows them now.
    const shownSteps = useMemo(() => {
      if (!replySteps || !proactive) return replySteps;
      const steps = replySteps.steps.map(withoutToolResults);
      return {
        ...replySteps,
        steps: processShown ? steps : steps.filter(isProgressStep),
      };
    }, [replySteps, proactive, processShown]);
    // Reasoning without a summary still says how long the model thought.
    const hasReasoning =
      processShown && (!!thinkingContent || (thinkingDurationMs ?? 0) >= 1000);
    // The timeline layout sums a reply up in the same card its streaming left
    // off with: one row, the steps in order behind it. A reply without steps
    // (an older turn) and the classic layout keep the reasoning and the trace
    // as the two rows they always were, unless the Agent sent progress: no
    // other row holds it.
    const settledSteps =
      shownSteps &&
      (layout === 'timeline' ||
        (proactive && shownSteps.steps.some(isProgressStep))) &&
      hasProcess(visibleSteps(shownSteps.steps, process === 'full'))
        ? shownSteps
        : null;
    // One row asked for both: the reasoning opens if there is any to read.
    const openThinking =
      openOnLoad === 'thinking' ||
      (openOnLoad === 'process' && !!thinkingContent);
    const openTrace =
      openOnLoad === 'trace' || (openOnLoad === 'process' && !thinkingContent);
    // A proactive turn's reply is announced before its trace is stored, at the
    // turn's end: its row is held from the start, so the text does not move
    // when the trace arrives (`traceAwaited` in the store).
    const awaitingTrace = useChatStore(
      (s) => s.traceAwaited[message.chat_jid] === message.id,
    );
    const traceOnServer =
      message.is_from_me &&
      (!!message.has_trace || awaitingTrace) &&
      !!message.turn_id &&
      !hasReasoning &&
      !settledSteps &&
      !(traceEvents && traceEvents.length > 0);
    const isUser = !message.is_from_me;
    const presentedContent = getPresentedMessageContent(message);
    // An automation's input names its automation above the bubble.
    const automationOrigin =
      isUser && message.source_kind === 'automation_prompt'
        ? (message.automation ?? null)
        : null;
    const completedWorkflowRuns = useMemo(
      () => message.workflow_runs?.filter((run) => run.status !== 'running'),
      [message.workflow_runs],
    );
    const usageView = useMemo(
      () =>
        message.is_from_me && message.token_usage
          ? tokenUsageView(message.token_usage, completedWorkflowRuns)
          : null,
      [message.is_from_me, message.token_usage, completedWorkflowRuns],
    );
    const presentedMessage =
      presentedContent === message.content
        ? message
        : { ...message, content: presentedContent };
    const displayDate = new Date(getMessageDisplayTimestamp(message));
    const time = Number.isNaN(displayDate.getTime())
      ? 'Invalid Date'
      : FULL_TIME_FORMATTER.format(displayDate).replace(/\//g, '-');
    const shortTime = formatShortTime(getMessageDisplayTimestamp(message));

    // Parse image attachments
    const attachments: MessageAttachment[] = message.attachments
      ? (() => {
          try {
            return JSON.parse(message.attachments);
          } catch {
            return [];
          }
        })()
      : [];
    // Carry each attachment's position in the stored array: the original-image
    // endpoint indexes the full list, so filtering to images first would point
    // a mixed-attachment message at the wrong entry.
    const images = attachments
      .map((att, attachmentIndex) => ({ ...att, attachmentIndex }))
      .filter((att) => att.type === 'image');
    // Inline `src` stays the thumbnail; the lightbox is what needs full
    // resolution, so it pulls the original on open instead of inflating the
    // history payload for every image on screen.
    const allImageSrcs = images.map((img) =>
      img.hasOriginal
        ? `/api/groups/${encodeURIComponent(message.chat_jid)}/messages/${encodeURIComponent(message.id)}/attachments/${img.attachmentIndex}/original`
        : `data:${img.mimeType || 'image/png'};base64,${img.data}`,
    );

    // Check if content is empty (only whitespace) and we have images
    const hasOnlyImages = !presentedContent.trim() && images.length > 0;
    // Same base JID the stream rendered with, so its blocks' rendered trees
    // are reused (links resolve against the workspace either way).
    const markdownJid = message.chat_jid.replace(/#agent:.*$/, '');
    const executionTrace = processShown &&
      !settledSteps &&
      traceEvents &&
      traceEvents.length > 0 && (
        <>
          <PermissionAlert traceEvents={traceEvents} />
          <TracePanel
            traceEvents={traceEvents}
            taskCount={0}
            defaultExpanded={openTrace}
          />
        </>
      );
    // The streaming card, once settled, is shaped like this: a denied tool
    // call above the summary row, the answer below.
    const settledCard = settledSteps && (
      <>
        {traceEvents && traceEvents.length > 0 && (
          <PermissionAlert traceEvents={traceEvents} />
        )}
        <ProcessCard
          mode="settled"
          steps={settledSteps.steps}
          stepsDropped={settledSteps.dropped}
          groupJid={markdownJid}
          commentary={process === 'full'}
          thinkingText={process === 'full'}
          durationMs={thinkingDurationMs}
          memoryKey={message.turn_id}
          defaultOpen={openOnLoad !== null}
          // Rebuilt steps are plausible, not exact: the reader who opens them
          // gets the server's, and keeps these if it has none.
          onOpenChange={
            settledSteps.provisional
              ? (open) => {
                  if (open) void loadTurnTrace(message);
                }
              : undefined
          }
        />
      </>
    );

    const handleCopy = async () => {
      try {
        await copyToClipboard(presentedContent);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        toast.error('复制失败，请手动选择文本复制');
      }
    };
    const incomplete = incompleteReplyNote(message);
    // Touch has no hover: there a tap on the badge says what it means.
    const incompleteBadge = incomplete && (
      <InfoTip content={incomplete.detail}>
        <button
          type="button"
          aria-label={`${incomplete.label}：${incomplete.detail}`}
          data-hc-incomplete=""
          className="relative inline-flex h-5 shrink-0 cursor-help items-center rounded-md px-1.5 text-micro font-medium text-muted-foreground ring-1 ring-surface-border outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 pointer-coarse:after:content-['']"
        >
          {incomplete.label}
        </button>
      </InfoTip>
    );

    // Context overflow system message
    if (
      message.sender === '__system__' &&
      message.content.startsWith('context_overflow:')
    ) {
      const errorMsg = message.content.replace(/^context_overflow:\s*/, '');
      return (
        <div className="mb-6">
          <div className="flex items-start gap-3 rounded-xl bg-error/5 px-4 py-3 ring-1 ring-error/20">
            <OctagonAlert className="mt-0.5 size-4 shrink-0 text-error" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body font-medium text-foreground">
                  上下文溢出错误
                </h3>
                <Badge variant="error">系统消息</Badge>
                {showTime && (
                  <span
                    className="text-micro text-faint-foreground"
                    title={time}
                  >
                    {shortTime}
                  </span>
                )}
              </div>
              <p className="mt-1 text-body leading-relaxed text-muted-foreground">
                {errorMsg}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Billing system message (quota exceeded / insufficient balance)
    if (message.sender === '__billing__') {
      const displayMsg = message.content.replace(/^⚠️\s*/, '');
      const isBalanceBlocked = displayMsg.includes('充值余额后继续使用');
      // Detect which quota window was exceeded
      const windowLabels: Record<string, string> = {
        daily: '日度',
        weekly: '周度',
        monthly: '月度',
      };
      let exceededWindow = '';
      if (displayMsg.includes('日度')) exceededWindow = 'daily';
      else if (displayMsg.includes('周度')) exceededWindow = 'weekly';
      else if (displayMsg.includes('月度')) exceededWindow = 'monthly';
      const windowTag = isBalanceBlocked
        ? '余额'
        : windowLabels[exceededWindow] || '配额';
      // Extract reset hint if present (e.g. "约 3 小时后重置" or "约 1 天后重置")
      const resetMatch = displayMsg.match(/约\s*(\d+)\s*(小时|天)后重置/);
      return (
        <div className="mb-6">
          <div className="flex items-start gap-3 rounded-xl bg-warning/5 px-4 py-3 ring-1 ring-warning/25">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body font-medium text-foreground">
                  {isBalanceBlocked ? '余额不足' : `${windowTag}配额已用完`}
                </h3>
                <Badge variant="warning">
                  {isBalanceBlocked ? '余额提醒' : '配额提醒'}
                </Badge>
                {!isBalanceBlocked && exceededWindow && (
                  <Badge variant="outline">{windowTag}限额</Badge>
                )}
                {showTime && (
                  <span
                    className="text-micro text-faint-foreground"
                    title={time}
                  >
                    {shortTime}
                  </span>
                )}
              </div>
              <p className="mt-1 text-body leading-relaxed text-muted-foreground">
                {displayMsg}
              </p>
              {resetMatch && (
                <p className="mt-1 text-caption text-muted-foreground">
                  预计 {resetMatch[1]} {resetMatch[2]}后自动重置
                </p>
              )}
              <Link
                to="/billing"
                className="mt-2 inline-block text-body font-medium text-primary-text hover:underline"
              >
                查看账单 &rarr;
              </Link>
            </div>
          </div>
        </div>
      );
    }

    const overlays = (
      <>
        {lightboxState && (
          <ImageLightbox
            images={lightboxState.images}
            initialIndex={lightboxState.index}
            onClose={() => setLightboxState(null)}
          />
        )}
        {showShareDialog && (
          <Suspense>
            <ShareImageDialog
              onClose={() => setShowShareDialog(false)}
              message={presentedMessage}
              agentName={agentIdentity.name}
              agentAvatarUrl={agentAvatarUrl}
              agentAvatarEmoji={agentAvatarEmoji}
              agentAvatarColor={agentAvatarColor}
            />
          </Suspense>
        )}
      </>
    );

    const renderImages = (className?: string) =>
      images.length > 0 && (
        <div className={cn('mb-2 flex flex-wrap gap-2', className)}>
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                setLightboxState({ images: allImageSrcs, index: i })
              }
              className="cursor-zoom-in overflow-hidden rounded-xl ring-1 ring-surface-border transition-shadow hover:ring-foreground/25"
            >
              <img
                src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                alt={img.name || `图片 ${i + 1}`}
                className="max-h-48 max-w-48 touch-callout-default object-cover"
              />
            </button>
          ))}
        </div>
      );

    const menuButton = (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="消息菜单"
        className="text-muted-foreground pointer-coarse:size-10 phone:size-11"
      >
        <Ellipsis />
      </Button>
    );

    // ── Compact mode: all messages left-aligned, no bubbles, full-width ──
    if (displayMode === 'compact') {
      const isAI = message.is_from_me;
      const senderName = isAI
        ? agentIdentity.name
        : currentUser?.display_name || currentUser?.username || '我';

      return (
        <div className="group mb-2 border-b border-surface-border pb-2">
          {/* Sender line — no avatars in compact mode */}
          <div className="mb-1 flex h-6 items-center gap-1.5">
            <span
              className={cn(
                'text-caption font-medium',
                isAI ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {senderName}
            </span>
            {showTime && (
              <span className="text-micro text-faint-foreground" title={time}>
                {shortTime}
              </span>
            )}
            {incompleteBadge}
            <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
              {!hasOnlyImages && (
                <IconButton
                  label="复制"
                  size="icon-xs"
                  icon={
                    copied ? <Check className="text-primary-text" /> : <Copy />
                  }
                  onClick={handleCopy}
                  className="text-muted-foreground pointer-coarse:size-10"
                />
              )}
              {isAI && (
                <IconButton
                  label="导出为长图"
                  size="icon-xs"
                  icon={<ImageDown />}
                  onClick={() => setShowShareDialog(true)}
                  className="text-muted-foreground pointer-coarse:size-10"
                />
              )}
              <MessageContextMenu
                content={presentedContent}
                chatJid={message.chat_jid}
                messageId={message.id}
                onShareImage={isAI ? () => setShowShareDialog(true) : undefined}
                open={menuOpen}
                onOpenChange={setMenuOpen}
              >
                {menuButton}
              </MessageContextMenu>
            </div>
          </div>

          {automationOrigin && (
            <AutomationOriginLink automation={automationOrigin} />
          )}

          {/* Process: the settled card, or the reasoning and the trace */}
          {settledCard}
          {!settledSteps && hasReasoning && (
            <ThinkingBlock
              text={thinkingContent ?? ''}
              title={thinkingTitle}
              durationMs={thinkingDurationMs}
              withheld={process !== 'full'}
              groupJid={markdownJid}
              defaultExpanded={openThinking}
            />
          )}
          {traceOnServer && (
            <LazyTurnTrace
              message={message}
              reasoning={process === 'full'}
              stepsOnly={!processShown}
              onRequest={setOpenOnLoad}
              pending={!message.has_trace}
            />
          )}

          {isAI && executionTrace}

          {/* Dynamic Workflow */}
          {completedWorkflowRuns?.map((run) => (
            <WorkflowRunCard key={run.taskId} run={run} />
          ))}

          {renderImages()}

          {/* Content — strip first-child top margin for consistent spacing */}
          {!hasOnlyImages && (
            <div
              className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0"
              {...pressToOpenMenu}
            >
              {isAI ? (
                <FinalMarkdown
                  content={presentedContent}
                  groupJid={markdownJid}
                  variant="chat"
                />
              ) : automationOrigin ? (
                <AutomationPromptText
                  content={presentedContent}
                  className="text-foreground"
                />
              ) : (
                <CollapsibleUserText
                  text={presentedContent}
                  className="text-foreground"
                />
              )}
            </div>
          )}

          {/* Token usage (compact mode) */}
          {usageView && (
            <div className="mt-1">
              <TokenUsageDisplay view={usageView} />
            </div>
          )}

          {overlays}
        </div>
      );
    }

    // ── Chat mode (default): bubble-style layout ──
    if (isUser) {
      const userMenu = (
        <MessageContextMenu
          content={presentedContent}
          chatJid={message.chat_jid}
          messageId={message.id}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          {menuButton}
        </MessageContextMenu>
      );
      // User message: right-aligned
      return (
        <div className="group mb-5 flex justify-end">
          <div className="flex max-w-[85%] min-w-0 flex-col items-end phone:max-w-[86%]">
            {automationOrigin && (
              <AutomationOriginLink automation={automationOrigin} />
            )}
            <div className="relative flex flex-col items-end">
              {renderImages(cn('justify-end', hasOnlyImages && 'mb-0'))}
              {!hasOnlyImages && (
                <div
                  className="rounded-[1.25rem] bg-muted px-4 py-2.5 text-foreground phone:rounded-xl phone:border phone:border-surface-border phone:bg-surface-raised phone:p-3"
                  {...pressToOpenMenu}
                >
                  {automationOrigin ? (
                    <AutomationPromptText content={presentedContent} />
                  ) : (
                    <CollapsibleUserText text={presentedContent} />
                  )}
                </div>
              )}
              {!isPhone && (
                <div className="absolute top-1/2 -left-8 -translate-y-1/2 transition-opacity pointer-coarse:-left-11 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 lg:has-[[aria-expanded=true]]:opacity-100">
                  {userMenu}
                </div>
              )}
            </div>
            {/* A phone has 「⋯」 below the bubble, with the time. */}
            <div className="mt-1 mr-1 flex items-center phone:mt-0 phone:mr-0">
              {showTime && (
                <span
                  className="text-micro text-faint-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                  title={time}
                >
                  {shortTime}
                </span>
              )}
              {isPhone && <span className="inline-flex">{userMenu}</span>}
            </div>
          </div>
          {overlays}
        </div>
      );
    }

    const senderName = agentIdentity.name;

    return (
      <div className="group mb-6">
        {/* Identity row: small avatar, name and time. A phone shows the agent
            in the header only, and the time in the action row; a proactive
            workspace's messages keep theirs. */}
        <div
          className={cn(
            'mb-1.5 flex h-6 items-center gap-2',
            !proactive && 'phone:hidden',
          )}
        >
          <EmojiAvatar
            imageUrl={agentIdentity.imageUrl}
            emoji={agentIdentity.emoji}
            color={agentIdentity.color}
            fallbackChar={agentIdentity.fallbackChar}
            size="sm"
            className="size-6"
          />
          <span className="text-label font-medium text-foreground">
            {senderName}
          </span>
          {showTime && (
            <span className="text-micro text-faint-foreground" title={time}>
              {shortTime}
            </span>
          )}
        </div>

        {/* Claude-style: no card container, direct content */}
        <div className="overflow-hidden font-serif">
          {settledCard}
          {!settledSteps && hasReasoning && (
            <ThinkingBlock
              text={thinkingContent ?? ''}
              title={thinkingTitle}
              durationMs={thinkingDurationMs}
              withheld={process !== 'full'}
              groupJid={markdownJid}
              defaultExpanded={openThinking}
            />
          )}
          {traceOnServer && (
            <LazyTurnTrace
              message={message}
              reasoning={process === 'full'}
              stepsOnly={!processShown}
              onRequest={setOpenOnLoad}
              pending={!message.has_trace}
            />
          )}

          {executionTrace}

          {completedWorkflowRuns?.map((run) => (
            <WorkflowRunCard key={run.taskId} run={run} />
          ))}

          {renderImages('mb-3')}

          {!hasOnlyImages && (
            <div className={REPLY_BODY_CLASS} {...pressToOpenMenu}>
              <FinalMarkdown
                content={presentedContent}
                groupJid={markdownJid}
                variant="chat"
              />
            </div>
          )}
        </div>

        {/* Action row: usage summary always (faint), actions on hover. A
            phone has the time here and the usage behind 「详情」. */}
        <div className="mt-1.5 flex h-7 items-center gap-1.5 pointer-coarse:h-10 phone:h-11 phone:gap-0">
          {incompleteBadge}
          {showTime && !proactive && (
            <span
              className="hidden pr-1 text-micro text-faint-foreground phone:inline"
              title={time}
            >
              {shortTime}
            </span>
          )}
          {usageView && (
            <TokenUsageDisplay view={usageView} className="phone:hidden" />
          )}
          <div className="flex items-center gap-0.5 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 lg:has-[[aria-expanded=true]]:opacity-100 phone:gap-0">
            <IconButton
              label="复制消息"
              size="icon-xs"
              icon={copied ? <Check className="text-primary-text" /> : <Copy />}
              onClick={handleCopy}
              className="text-muted-foreground pointer-coarse:size-10 phone:size-11"
            />
            <IconButton
              label="生成分享图片"
              size="icon-xs"
              icon={<ImageDown />}
              onClick={() => setShowShareDialog(true)}
              className="text-muted-foreground max-lg:hidden"
            />
            <MessageContextMenu
              content={presentedContent}
              chatJid={message.chat_jid}
              messageId={message.id}
              onShareImage={() => setShowShareDialog(true)}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {menuButton}
            </MessageContextMenu>
          </div>
          {usageView && <TokenUsagePopover view={usageView} />}
        </div>

        {overlays}
      </div>
    );
  },
  // Every message field the bubble renders: attachments and workflow runs
  // used to be missing, so updates to them kept showing the stale version.
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.token_usage === next.message.token_usage &&
    prev.message.attachments === next.message.attachments &&
    prev.message.workflow_runs === next.message.workflow_runs &&
    prev.message.source_kind === next.message.source_kind &&
    prev.message.has_trace === next.message.has_trace &&
    prev.message.turn_id === next.message.turn_id &&
    prev.message.finalization_reason === next.message.finalization_reason &&
    prev.message.timestamp === next.message.timestamp &&
    prev.message.delivery_updated_at === next.message.delivery_updated_at &&
    prev.message.delivery_status === next.message.delivery_status &&
    prev.message.automation?.name === next.message.automation?.name &&
    prev.showTime === next.showTime &&
    prev.thinkingContent === next.thinkingContent &&
    prev.thinkingDurationMs === next.thinkingDurationMs &&
    prev.traceEvents === next.traceEvents &&
    prev.replySteps === next.replySteps &&
    prev.agentName === next.agentName &&
    prev.agentAvatarUrl === next.agentAvatarUrl &&
    prev.agentAvatarEmoji === next.agentAvatarEmoji &&
    prev.agentAvatarColor === next.agentAvatarColor,
);
