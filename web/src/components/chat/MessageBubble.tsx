import { useState, memo, lazy, Suspense } from 'react';
import {
  Copy,
  Check,
  ChevronRight,
  Ellipsis,
  ImageDown,
  OctagonAlert,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '../common/IconButton';
import { cn } from '@/lib/utils';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageContextMenu } from './MessageContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { formatThinkingDuration } from '../../utils/thinking-duration';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import {
  getPresentedMessageContent,
  incompleteReplyNote,
} from '../../lib/message-presentation';
import { copyToClipboard } from '../../utils/clipboard';
import { toast } from 'sonner';
import { getMessageDisplayTimestamp } from '../../lib/message-timeline';
import {
  getAuthoritativeTokenBreakdown,
  getDisplayedTokenTotal,
  getPrimaryModelUsage,
  parseTokenUsage,
} from '../../lib/token-usage-presentation';
import { WorkflowRunCard } from './WorkflowRunCard';
import type { WorkflowRunSnapshot } from '../../stream-event.types';

const ShareImageDialog = lazy(() =>
  import('./ShareImageDialog').then((m) => ({ default: m.ShareImageDialog })),
);

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  thinkingContent?: string;
  thinkingDurationMs?: number;
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

/** Collapsible reasoning block for AI messages */
function ReasoningBlock({
  content,
  durationMs,
}: {
  content: string;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    durationMs != null && durationMs > 0
      ? formatThinkingDuration(durationMs)
      : '思考过程';

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="-ml-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-sans text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <Sparkles className="size-3.5" />
        <span>{label}</span>
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className="mt-1 mb-3 max-h-72 overflow-y-auto border-l-2 border-surface-border pl-3 font-sans text-label leading-6 break-words whitespace-pre-wrap text-muted-foreground">
          {content}
        </div>
      )}
    </div>
  );
}

/** Parse and display token usage for AI messages */
function TokenUsageDisplay({
  tokenUsageJson,
  workflowRuns = [],
}: {
  tokenUsageJson: string;
  workflowRuns?: WorkflowRunSnapshot[];
}) {
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

  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const summaryContent = (
    <span className="inline-flex cursor-default items-center gap-1.5 font-sans text-micro text-faint-foreground tabular-nums transition-colors hover:text-muted-foreground">
      {displayTotal > 0 && <span>{formatNum(displayTotal)} tokens</span>}
      {usage.durationMs ? (
        <>
          {displayTotal > 0 && <span className="opacity-60">·</span>}
          <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
    </span>
  );

  if (displayTotal === 0 && !usage.durationMs) return null;

  const hasDetails = displayTotal > 0 || primary !== null;

  if (!hasDetails) {
    return summaryContent;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{summaryContent}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <div className="text-xs space-y-0.5">
          {primary && (
            <div className="opacity-70 font-medium mb-1">
              主模型：{primary[0]}
            </div>
          )}
          {breakdown.totalTokens > 0 && (
            <div>
              输入 {formatNum(breakdown.inputTokens)} / 输出{' '}
              {formatNum(breakdown.outputTokens)}
            </div>
          )}
          {workflowTokens > 0 && (
            <div className="opacity-70">
              Workflow Agent 合计 {formatNum(workflowTokens)}
            </div>
          )}
          {(breakdown.cacheReadInputTokens > 0 ||
            breakdown.cacheCreationInputTokens > 0 ||
            breakdown.reasoningTokens > 0) && (
            <div className="opacity-70">
              缓存读取 {formatNum(breakdown.cacheReadInputTokens)} / 缓存写入{' '}
              {formatNum(breakdown.cacheCreationInputTokens)} / 推理{' '}
              {formatNum(breakdown.reasoningTokens)}
            </div>
          )}
          {primary && (
            <div className="opacity-70">
              主模型输入 {formatNum(primary[1].inputTokens || 0)} / 输出{' '}
              {formatNum(primary[1].outputTokens || 0)}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    showTime,
    thinkingContent,
    thinkingDurationMs,
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
    const currentUser = useAuthStore((s) => s.user);
    const appearance = useAuthStore((s) => s.appearance);
    const agentIdentity = resolveAgentDisplayIdentity({
      agentName,
      messageSenderName: message.sender_name,
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
    const { mode: displayMode } = useDisplayMode();
    const isUser = !message.is_from_me;
    const presentedContent = getPresentedMessageContent(message);
    const completedWorkflowRuns = message.workflow_runs?.filter(
      (run) => run.status !== 'running',
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
    const incompleteBadge = incomplete && (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={`${incomplete.label}：${incomplete.detail}`}
            className="inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-micro font-medium text-muted-foreground ring-1 ring-surface-border outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {incomplete.label}
          </span>
        </TooltipTrigger>
        <TooltipContent>{incomplete.detail}</TooltipContent>
      </Tooltip>
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
                className="max-h-48 max-w-48 object-cover"
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
        className="text-muted-foreground pointer-coarse:size-10"
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
              >
                {menuButton}
              </MessageContextMenu>
            </div>
          </div>

          {/* Reasoning */}
          {thinkingContent && (
            <ReasoningBlock
              content={thinkingContent}
              durationMs={thinkingDurationMs}
            />
          )}

          {/* Dynamic Workflow */}
          {completedWorkflowRuns?.map((run) => (
            <WorkflowRunCard key={run.taskId} run={run} />
          ))}

          {renderImages()}

          {/* Content — strip first-child top margin for consistent spacing */}
          {!hasOnlyImages && (
            <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
              {isAI ? (
                <MarkdownRenderer
                  content={presentedContent}
                  groupJid={message.chat_jid}
                  variant="chat"
                />
              ) : (
                <p className="text-body-lg break-words whitespace-pre-wrap text-foreground">
                  {presentedContent}
                </p>
              )}
            </div>
          )}

          {/* Token usage (compact mode) */}
          {isAI && message.token_usage && (
            <div className="mt-1">
              <TokenUsageDisplay
                tokenUsageJson={message.token_usage}
                workflowRuns={completedWorkflowRuns}
              />
            </div>
          )}

          {overlays}
        </div>
      );
    }

    // ── Chat mode (default): bubble-style layout ──
    if (isUser) {
      // User message: right-aligned
      return (
        <div className="group mb-5 flex justify-end">
          <div className="flex max-w-[85%] min-w-0 flex-col items-end">
            <div className="relative flex flex-col items-end">
              {renderImages(cn('justify-end', hasOnlyImages && 'mb-0'))}
              {!hasOnlyImages && (
                <div className="rounded-[1.25rem] bg-muted px-4 py-2.5 text-foreground">
                  <p className="text-body-lg break-words whitespace-pre-wrap">
                    {presentedContent}
                  </p>
                </div>
              )}
              <div className="absolute top-1/2 -left-8 -translate-y-1/2 transition-opacity pointer-coarse:-left-11 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 lg:has-[[aria-expanded=true]]:opacity-100">
                <MessageContextMenu
                  content={presentedContent}
                  chatJid={message.chat_jid}
                  messageId={message.id}
                  align="end"
                >
                  {menuButton}
                </MessageContextMenu>
              </div>
            </div>
            {showTime && (
              <span
                className="mt-1 mr-1 text-micro text-faint-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                title={time}
              >
                {shortTime}
              </span>
            )}
          </div>
          {overlays}
        </div>
      );
    }

    const senderName = agentIdentity.name;

    return (
      <div className="group mb-6">
        {/* Identity row: small avatar, name and time */}
        <div className="mb-1.5 flex h-6 items-center gap-2">
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
          {thinkingContent && (
            <ReasoningBlock
              content={thinkingContent}
              durationMs={thinkingDurationMs}
            />
          )}

          {completedWorkflowRuns?.map((run) => (
            <WorkflowRunCard key={run.taskId} run={run} />
          ))}

          {renderImages('mb-3')}

          {!hasOnlyImages && (
            <div className="max-w-none overflow-hidden">
              <MarkdownRenderer
                content={presentedContent}
                groupJid={message.chat_jid}
                variant="chat"
              />
            </div>
          )}
        </div>

        {/* Action row: usage summary always (faint), actions on hover */}
        <div className="mt-1.5 flex h-7 items-center gap-1.5 pointer-coarse:h-10">
          {incompleteBadge}
          {message.is_from_me && message.token_usage && (
            <TokenUsageDisplay
              tokenUsageJson={message.token_usage}
              workflowRuns={completedWorkflowRuns}
            />
          )}
          <div className="flex items-center gap-0.5 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 lg:has-[[aria-expanded=true]]:opacity-100">
            <IconButton
              label="复制消息"
              size="icon-xs"
              icon={copied ? <Check className="text-primary-text" /> : <Copy />}
              onClick={handleCopy}
              className="text-muted-foreground pointer-coarse:size-10"
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
            >
              {menuButton}
            </MessageContextMenu>
          </div>
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
    prev.message.finalization_reason === next.message.finalization_reason &&
    prev.message.timestamp === next.message.timestamp &&
    prev.message.delivery_updated_at === next.message.delivery_updated_at &&
    prev.message.delivery_status === next.message.delivery_status &&
    prev.showTime === next.showTime &&
    prev.thinkingContent === next.thinkingContent &&
    prev.thinkingDurationMs === next.thinkingDurationMs &&
    prev.agentName === next.agentName &&
    prev.agentAvatarUrl === next.agentAvatarUrl &&
    prev.agentAvatarEmoji === next.agentAvatarEmoji &&
    prev.agentAvatarColor === next.agentAvatarColor,
);
