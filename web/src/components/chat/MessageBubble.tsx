import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  thinkingContent?: string;
}

interface MessageAttachment {
  type: 'image';
  data: string; // base64
  mimeType?: string;
  name?: string;
}

/** Image lightbox modal */
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <img
        src={src}
        alt="放大查看"
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
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

export function MessageBubble({ message, showTime, thinkingContent }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const isUser = !message.is_from_me;
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

  if (isUser) {
    // User message: solid colored pill, right-aligned
    return (
      <div className="group flex justify-end mb-4">
        <div className="flex flex-col items-end max-w-[85%] lg:max-w-[75%] min-w-0">
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
                    onClick={() => setExpandedImage(`data:${img.mimeType || 'image/png'};base64,${img.data}`)}
                  />
                ))}
              </div>
            )}
            <div className="bg-white border border-slate-200 text-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm shadow-sm">
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{message.content}</p>
            </div>
            <button
              onClick={handleCopy}
              className="absolute -left-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity cursor-pointer"
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

        {expandedImage && <ImageLightbox src={expandedImage} onClose={() => setExpandedImage(null)} />}
      </div>
    );
  }

  // AI message: avatar + card layout
  const appearance = useAuthStore((s) => s.appearance);
  const senderName = appearance?.aiName || message.sender_name || 'AI';

  return (
    <div className="group flex gap-3 mb-4">
      {/* Avatar */}
      <EmojiAvatar
        emoji={appearance?.aiAvatarEmoji}
        color={appearance?.aiAvatarColor}
        fallbackChar={senderName[0]}
        size="md"
      />

      {/* Right content */}
      <div className="flex-1 min-w-0">
        {/* Name + time row */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
          {showTime && <span className="text-xs text-muted-foreground">{time}</span>}
        </div>

        {/* Card */}
        <div className="relative bg-white rounded-xl border border-slate-100 border-l-[3px] border-l-brand-400 px-5 py-4">
          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity cursor-pointer"
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
                  onClick={() => setExpandedImage(`data:${img.mimeType || 'image/png'};base64,${img.data}`)}
                />
              ))}
            </div>
          )}

          {/* Content */}
          <div className="prose prose-sm max-w-none prose-headings:text-slate-900 prose-p:text-slate-800 prose-p:leading-relaxed">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      </div>

      {expandedImage && <ImageLightbox src={expandedImage} onClose={() => setExpandedImage(null)} />}
    </div>
  );
}
