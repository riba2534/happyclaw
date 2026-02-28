import { useState, useRef, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MessageContextMenu } from './MessageContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { mediumTap } from '../../hooks/useHaptic';
import { useDisplayMode } from '../../hooks/useDisplayMode';

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
    <div className="mb-3 rounded-xl border border-amber-200/60 bg-amber-50/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-50/60 transition-colors"
      >
        <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
        </svg>
        <span className="text-xs font-medium text-amber-700">Reasoning</span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-sm text-amber-900/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100">
          {content}
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message, showTime, thinkingContent, isShared }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [lightboxState, setLightboxState] = useState<{ images: string[]; index: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touchStartPos = useRef({ x: 0, y: 0 });
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

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    touchTimer.current = setTimeout(() => {
      mediumTap();
      setContextMenu({ x: touch.clientX, y: touch.clientY - 10 });
    }, 500);
  };

  const handleTouchEnd = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPos.current.x);
    const dy = Math.abs(touch.clientY - touchStartPos.current.y);
    if (dx > 10 || dy > 10) {
      if (touchTimer.current) clearTimeout(touchTimer.current);
    }
  };

  // Context overflow system message
  if (message.sender === '__system__' && message.content.startsWith('context_overflow:')) {
    const errorMsg = message.content.replace(/^context_overflow:\s*/, '');
    return (
      <div className="mb-6">
        {showTime && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-slate-500">{time}</span>
            <span className="text-xs font-medium text-red-600">系统消息</span>
          </div>
        )}
        <div className="relative bg-red-50 rounded-xl border border-red-200 border-l-[3px] border-l-red-500 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
              !
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-900 mb-1">上下文溢出错误</h3>
              <p className="text-sm text-red-800 leading-relaxed">{errorMsg}</p>
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
      <div className="group mb-2 border-b border-slate-100 pb-2" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}>
        {/* Sender line — no avatars in compact mode */}
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`text-xs font-semibold ${isAI ? 'text-brand-600' : 'text-slate-700'}`}>{senderName}</span>
          {showTime && <span className="text-[11px] text-slate-400">{time}</span>}
          <button
            onClick={handleCopy}
            className="ml-1 w-5 h-5 rounded flex items-center justify-center text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            title="复制"
          >
            {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
          </button>
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
                className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-slate-200 hover:border-primary transition-colors"
                onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
              />
            ))}
          </div>
        )}

        {/* Content — strip first-child top margin for consistent spacing */}
        <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
          {isAI ? (
            <MarkdownRenderer content={message.content} groupJid={message.chat_jid} variant="chat" />
          ) : (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-slate-800">{message.content}</p>
          )}
        </div>

        {lightboxState && (
          <ImageLightbox images={lightboxState.images} initialIndex={lightboxState.index} onClose={() => setLightboxState(null)} />
        )}
        {contextMenu && (
          <MessageContextMenu content={message.content} position={contextMenu} onClose={() => setContextMenu(null)} />
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
        <div className="group mb-4" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}>
          <div className="flex items-center gap-2 mb-1.5 lg:hidden">
            <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600 flex-shrink-0">
              {initial}
            </div>
            <span className="text-xs text-muted-foreground font-medium">{otherName}</span>
            {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
          </div>

          <div className="lg:flex lg:gap-3">
            <div className="hidden lg:block flex-shrink-0">
              <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-sm font-medium text-slate-600">
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
                <div className="bg-white border border-slate-200 text-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm shadow-sm">
                  <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
                </div>
                <button
                  onClick={handleCopy}
                  className="absolute -right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 max-lg:hidden lg:opacity-0 lg:group-hover:opacity-100 transition-opacity cursor-pointer"
                  title="复制"
                  aria-label="复制消息"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
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
            />
          )}
        </div>
      );
    }

    // User message (own): right-aligned
    const showSenderLabel = isShared;
    return (
      <div className="group flex justify-end mb-4" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}>
        <div className="flex flex-col items-end min-w-0 w-full">
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
            <div className="bg-white border border-slate-200 text-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm shadow-sm">
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
            </div>
            <button
              onClick={handleCopy}
              className="absolute -left-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 max-lg:hidden lg:opacity-0 lg:group-hover:opacity-100 transition-opacity cursor-pointer"
              title="复制"
              aria-label="复制消息"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          {showTime && (
            <span className="text-xs text-slate-400 mt-1.5 mr-1">{time}</span>
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
    <div className="group mb-4" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchMove}>
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

          {/* Card */}
          <div className="relative bg-white rounded-xl border border-slate-100 border-l-[3px] border-l-brand-400 px-5 py-4 max-lg:bg-white/90 max-lg:backdrop-blur-sm overflow-hidden">
            {/* Copy button — desktop only, mobile uses long-press menu */}
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 max-lg:hidden lg:opacity-0 lg:group-hover:opacity-100 transition-opacity cursor-pointer"
              title="复制"
              aria-label="复制消息"
            >
              {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
            </button>

            {/* Reasoning block */}
            {thinkingContent && <ReasoningBlock content={thinkingContent} />}

            {/* Image attachments */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                    alt={img.name || `图片 ${i + 1}`}
                    className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-slate-200 hover:border-primary transition-colors"
                    onClick={() => setLightboxState({ images: allImageSrcs, index: i })}
                  />
                ))}
              </div>
            )}

            {/* Content */}
            <div className="max-w-none overflow-hidden">
              <MarkdownRenderer content={message.content} groupJid={message.chat_jid} variant="chat" />
            </div>
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
        />
      )}
    </div>
  );
}, (prev, next) =>
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.showTime === next.showTime &&
  prev.thinkingContent === next.thinkingContent &&
  prev.isShared === next.isShared
);
