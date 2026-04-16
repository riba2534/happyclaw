import { useState, memo, lazy, Suspense } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Ellipsis, ImageDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageContextMenu } from './MessageContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { mediumTap } from '../../hooks/useHaptic';
import { useDisplayMode } from '../../hooks/useDisplayMode';

const ShareImageDialog = lazy(() => import('./ShareImageDialog').then(m => ({ default: m.ShareImageDialog })));

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  thinkingContent?: string;
  isShared?: boolean;
}

interface MessageAttachment {
  type: 'image';
  data: string; // base64
  mimeType?: string;
  name?: string;
}

/** Collapsible reasoning block for AI messages */
function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3 rounded-xl border border-amber-200/60 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-950/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 pr-16 text-left hover:bg-amber-50/60 dark:hover:bg-amber-950/40 transition-colors"
      >
        <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
        </svg>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Reasoning</span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-sm text-amber-900/70 dark:text-amber-300/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100 dark:border-amber-800/40">
          {content}
        </div>
      )}
    </div>
  );
}

/** Parse and display token usage for AI messages */
function TokenUsageDisplay({ tokenUsageJson }: { tokenUsageJson: string }) {
  const usage = (() => {
    try {
      return JSON.parse(tokenUsageJson) as {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
        durationMs?: number;
        numTurns?: number;
        modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
      };
    } catch {
      return null;
    }
  })();

  if (!usage) return null;

  const models = usage.modelUsage ? Object.entries(usage.modelUsage) : [];
  // 主模型 = 费用最高的（即用户指定的模型），内部模型不向用户展示
  models.sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0));
  const primary = models.length > 0 ? models[0] : null;
  const primaryInput = primary ? primary[1].inputTokens : (usage.inputTokens || 0);
  const primaryOutput = primary ? primary[1].outputTokens : (usage.outputTokens || 0);
  const totalTokens = primaryInput + primaryOutput;

  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const summaryContent = (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-default">
      <span>{formatNum(totalTokens)} tokens</span>
      {usage.durationMs ? (
        <>
          <span className="opacity-40">·</span>
          <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
    </span>
  );

  const hasDetails = primary || (usage.cacheReadInputTokens || 0) > 0;

  if (!hasDetails) {
    return <div className="mt-1.5">{summaryContent}</div>;
  }

  return (
    <div className="mt-1.5">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{summaryContent}</TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <div className="text-xs space-y-0.5">
              {primary && <div className="opacity-70 font-medium mb-1">{primary[0]}</div>}
              {primary && <div>In {formatNum(primaryInput)} / Out {formatNum(primaryOutput)}</div>}
              {(usage.cacheReadInputTokens || 0) > 0 && (
                <div className="opacity-70">
                  Read {formatNum(usage.cacheReadInputTokens || 0)}
                  {(usage.cacheCreationInputTokens || 0) > 0 && ` / Write ${formatNum(usage.cacheCreationInputTokens || 0)}`}
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message, showTime, thinkingContent, isShared }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [lightboxState, setLightboxState] = useState<{ images: string[]; index: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const currentUser = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const { mode: displayMode } = useDisplayMode();
  const isUser = !message.is_from_me;
  const isOtherUser = isShared && isUser && message.sender !== currentUser?.id;
  const time = new Date(message.timestamp)
    .toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');

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
  const images = attachments.filter((att) => att.type === 'image');
  const allImageSrcs = images.map((img) => `data:${img.mimeType || 'image/png'};base64,${img.data}`);

  // Check if content is empty (only whitespace) and we have images
  const hasOnlyImages = !message.content.trim() && images.length > 0;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = message.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleMenuButton = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    mediumTap();
    setContextMenu({ x: rect.left, y: rect.bottom + 4 });
  };


  // Context overflow system message
  if (message.sender === '__system__' && message.content.startsWith('context_overflow:')) {
    const errorMsg = message.content.replace(/^context_overflow:\s*/, '');
    return (
      <div className="mb-6">
        {showTime && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-muted-foreground">{time}</span>
            <span className="text-xs font-medium text-red-600">系统消息</span>
          </div>
        )}
        <div className="relative bg-red-50 dark:bg-red-950/30 rounded-xl border border-red-200 dark:border-red-800/60 border-l-[3px] border-l-red-500 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
              !
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-900 dark:text-red-200 mb-1">上下文溢出错误</h3>
              <p className="text-sm text-red-800 dark:text-red-300 leading-relaxed">{errorMsg}</p>
            </div>
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
    const windowLabels: Record<string, string> = { daily: '日度', weekly: '周度', monthly: '月度' };
    let exceededWindow = '';
    if (displayMsg.includes('日度')) exceededWindow = 'daily';
    else if (displayMsg.includes('周度')) exceededWindow = 'weekly';
    else if (displayMsg.includes('月度')) exceededWindow = 'monthly';
    const windowTag = isBalanceBlocked ? '余额' : windowLabels[exceededWindow] || '配额';
    // Extract reset hint if present (e.g. "约 3 小时后重置" or "约 1 天后重置")
    const resetMatch = displayMsg.match(/约\s*(\d+)\s*(小时|天)后重置/);
    return (
      <div className="mb-6">
        {showTime && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-muted-foreground">{time}</span>
            <span className="text-xs font-medium text-amber-600">
              {isBalanceBlocked ? '余额提醒' : '配额提醒'}
            </span>
          </div>
        )}
        <div className="relative bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800 border-l-[3px] border-l-amber-500 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-6 h-6 bg-amber-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
              !
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  {isBalanceBlocked ? '余额不足' : `${windowTag}配额已用完`}
                </h3>
                {!isBalanceBlocked && exceededWindow && (
                  <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                    exceededWindow === 'daily'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                      : exceededWindow === 'weekly'
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                  }`}>
                    {windowTag}限额
                  </span>
                )}
              </div>
              <p className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed">{displayMsg}</p>
              {resetMatch && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  预计 {resetMatch[1]} {resetMatch[2]}后自动重置
                </p>
              )}
              <Link to="/billing" className="inline-block mt-2 text-sm text-primary hover:underline font-medium">
                查看账单 &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Compact mode: all messages left-aligned, no bubbles, full-width ──
  if (displayMode === 'compact') {
    const isAI = message.is_from_me;
    const senderName = isAI
      ? (currentUser?.ai_name || appearance?.aiName || message.sender_name || 'AI')
      : (isOtherUser ? (message.sender_name || '用户') : (currentUser?.display_name || currentUser?.username || '我'));

    return (
      <div className="group mb-2 border-b border-border pb-2">
        {/* Sender line — no avatars in compact mode */}
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`text-xs font-semibold ${isAI ? 'text-primary' : 'text-muted-foreground'}`}>{senderName}</span>
          {showTime && <span className="text-[11px] text-muted-foreground">{time}</span>}
          <button
            onClick={handleCopy}
            className="ml-1 w-5 h-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            title="复制"
          >
            {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
          </button>
          {isAI && (
            <button
              onClick={() => setShowShareDialog(true)}
              className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              title="导出为长图"
              aria-label="导出为长图"
            >
              <ImageDown className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Reasoning */}
        {thinkingContent && <ReasoningBlock content={thinkingContent} />}

        {/* Images */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                alt={img.name || `图片 ${i + 1}`}
                className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-border hover:border-primary transition-colors"
                onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
              />
            ))}
          </div>
        )}

        {/* Content — strip first-child top margin for consistent spacing */}
        {!hasOnlyImages && (
          <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            {isAI ? (
              <MarkdownRenderer content={message.content} groupJid={message.chat_jid} variant="chat" />
            ) : (
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-foreground">{message.content}</p>
            )}
          </div>
        )}

        {/* Token usage (compact mode) */}
        {isAI && message.token_usage && (
          <TokenUsageDisplay tokenUsageJson={message.token_usage} />
        )}

        {lightboxState && (
          <ImageLightbox images={lightboxState.images} initialIndex={lightboxState.index} onClose={() => setLightboxState(null)} />
        )}
        {contextMenu && (
          <MessageContextMenu
            content={message.content}
            position={contextMenu}
            onClose={() => setContextMenu(null)}
            chatJid={message.chat_jid}
            messageId={message.id}
            onShareImage={isAI ? () => setShowShareDialog(true) : undefined}
          />
        )}
        {showShareDialog && (
          <Suspense>
            <ShareImageDialog
              onClose={() => setShowShareDialog(false)}
              message={message}
            />
          </Suspense>
        )}
      </div>
    );
  }

  // ── Chat mode (default): bubble-style layout ──
  if (isUser) {
    // Shared workspace — other user's message: left-aligned with avatar
    if (isOtherUser) {
      const otherName = message.sender_name || '用户';
      const initial = otherName[0]?.toUpperCase() || '?';
      return (
        <div className="group mb-4">
          <div className="flex items-center gap-2 mb-1.5 lg:hidden">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-foreground/70 flex-shrink-0">
              {initial}
            </div>
            <span className="text-xs text-muted-foreground font-medium">{otherName}</span>
            {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
          </div>

          <div className="lg:flex lg:gap-3">
            <div className="hidden lg:block flex-shrink-0">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-foreground/70">
                {initial}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="hidden lg:flex items-center gap-2 mb-1">
                <span className="text-xs text-muted-foreground font-medium">{otherName}</span>
                {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
              </div>
              <div className="relative">
                {images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {images.map((img, i) => (
                      <img
                        key={i}
                        src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                        alt={img.name || `图片 ${i + 1}`}
                        className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border-2 border-primary hover:border-primary transition-colors"
                        onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
                      />
                    ))}
                  </div>
                )}
                {!hasOnlyImages && (
                  <div className="bg-card border border-border text-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm shadow-sm">
                    <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
                  </div>
                )}
                {!hasOnlyImages && (
                  <button
                    onClick={handleMenuButton}
                    className="absolute -right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 lg:opacity-0 lg:group-hover:opacity-100 transition-all cursor-pointer"
                    title="更多"
                    aria-label="消息菜单"
                  >
                    <Ellipsis className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {lightboxState && (
            <ImageLightbox
              images={lightboxState.images}
              initialIndex={lightboxState.index}
              onClose={() => setLightboxState(null)}
            />
          )}
          {contextMenu && (
            <MessageContextMenu
              content={message.content}
              position={contextMenu}
              onClose={() => setContextMenu(null)}
              chatJid={message.chat_jid}
              messageId={message.id}
            />
          )}
        </div>
      );
    }

    // User message (own): right-aligned
    const showSenderLabel = isShared;
    return (
      <div className="group flex justify-end mb-4">
        <div className="flex flex-col items-end min-w-0 max-w-[75%]">
          {showSenderLabel && (
            <span className="text-xs text-muted-foreground font-medium mb-1 mr-1">
              {message.sender_name || currentUser?.display_name || currentUser?.username || '我'}
            </span>
          )}
          <div className="relative">
            {/* Image attachments */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 justify-end">
                {images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                    alt={img.name || `图片 ${i + 1}`}
                    className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border-2 border-primary hover:border-primary transition-colors"
                    onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
                  />
                ))}
              </div>
            )}
            {!hasOnlyImages && (
              <div className="bg-muted text-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm">
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
              </div>
            )}
            {!hasOnlyImages && (
              <button
                onClick={handleMenuButton}
                className="absolute -left-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 lg:opacity-0 lg:group-hover:opacity-100 transition-all cursor-pointer"
                title="更多"
                aria-label="消息菜单"
              >
                <Ellipsis className="w-4 h-4" />
              </button>
            )}
          </div>
          {showTime && (
            <span className="text-xs text-muted-foreground mt-1.5 mr-1">{time}</span>
          )}
        </div>

        {lightboxState && (
          <ImageLightbox
            images={lightboxState.images}
            initialIndex={lightboxState.index}
            onClose={() => setLightboxState(null)}
          />
        )}
        {contextMenu && (
          <MessageContextMenu
            content={message.content}
            position={contextMenu}
            onClose={() => setContextMenu(null)}
            chatJid={message.chat_jid}
            messageId={message.id}
          />
        )}
      </div>
    );
  }

  // AI message: avatar + card layout — user-level AI appearance takes priority
  const senderName = currentUser?.ai_name || appearance?.aiName || message.sender_name || 'AI';
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;

  return (
    <div className="group mb-4">
      {/* Mobile: compact avatar + name row */}
      <div className="flex items-center gap-2 mb-1.5 lg:hidden">
        <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="sm" />
        <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
        {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
      </div>

      {/* Desktop: horizontal avatar + content layout */}
      <div className="lg:flex lg:gap-3">
        <div className="hidden lg:block flex-shrink-0">
          <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="md" />
        </div>
        <div className="flex-1 min-w-0">
          {/* Desktop: name + time row */}
          <div className="hidden lg:flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
            {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
          </div>

          {/* Claude-style: no card container, direct content */}
          <div className="overflow-hidden font-serif">
            {/* Reasoning block — muted left border style */}
            {thinkingContent && <ReasoningBlock content={thinkingContent} />}

            {/* Image attachments */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                    alt={img.name || `图片 ${i + 1}`}
                    className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-border hover:border-primary transition-colors"
                    onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
                  />
                ))}
              </div>
            )}

            {/* Content */}
            {!hasOnlyImages && (
              <div className="max-w-none overflow-hidden">
                <MarkdownRenderer content={message.content} groupJid={message.chat_jid} variant="chat" />
              </div>
            )}

            {/* Token usage */}
            {message.is_from_me && message.token_usage && (
              <TokenUsageDisplay tokenUsageJson={message.token_usage} />
            )}
          </div>

          {/* Action toolbar — below content, Claude-style */}
          <div className="flex items-center gap-0.5 mt-1 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="h-7 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs cursor-pointer transition-colors"
              title="复制"
              aria-label="复制消息"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setShowShareDialog(true)}
              className="h-7 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs max-lg:hidden cursor-pointer transition-colors"
              title="分享"
              aria-label="生成分享图片"
            >
              <ImageDown className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleMenuButton}
              className="h-7 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs cursor-pointer transition-colors"
              title="更多"
              aria-label="消息菜单"
            >
              <Ellipsis className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {lightboxState && (
        <ImageLightbox
          images={lightboxState.images}
          initialIndex={lightboxState.index}
          onClose={() => setLightboxState(null)}
        />
      )}
      {contextMenu && (
        <MessageContextMenu
          content={message.content}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          chatJid={message.chat_jid}
          messageId={message.id}
          onShareImage={() => setShowShareDialog(true)}
        />
      )}
      {showShareDialog && (
        <Suspense>
          <ShareImageDialog
            onClose={() => setShowShareDialog(false)}
            message={message}
          />
        </Suspense>
      )}
    </div>
  );
}, (prev, next) =>
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.message.token_usage === next.message.token_usage &&
  prev.showTime === next.showTime &&
  prev.thinkingContent === next.thinkingContent &&
  prev.isShared === next.isShared
);
