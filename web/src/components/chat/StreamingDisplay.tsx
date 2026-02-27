import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TaskInlineCard } from './TaskInlineCard';

interface StreamingDisplayProps {
  groupJid: string;
  isWaiting: boolean;
  senderName?: string;
  agentId?: string;
}

export function StreamingDisplay({ groupJid, isWaiting, senderName: senderNameProp = 'AI', agentId }: StreamingDisplayProps) {
  const mainStreaming = useChatStore(s => s.streaming[groupJid]);
  const agentStreamingState = useChatStore(s => agentId ? s.agentStreaming[agentId] : undefined);
  const streaming = agentId ? agentStreamingState : mainStreaming;
  const sdkTasks = useChatStore(s => s.sdkTasks);
  const currentUser = useAuthStore(s => s.user);
  const appearance = useAuthStore(s => s.appearance);
  const senderName = currentUser?.ai_name || appearance?.aiName || senderNameProp;
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

  // Auto-scroll thinking content (unless user scrolled up)
  useEffect(() => {
    if (!thinkingExpanded || !thinkingRef.current || userScrolledRef.current) return;
    const el = thinkingRef.current;
    el.scrollTop = el.scrollHeight;
  }, [streaming?.thinkingText, thinkingExpanded]);

  // Reset on group change
  useEffect(() => {
    setThinkingExpanded(true);
    userScrolledRef.current = false;
  }, [groupJid]);

  useEffect(() => {
    if (!streaming) {
      setThinkingExpanded(true);
      userScrolledRef.current = false;
    }
  }, [streaming]);

  // Local elapsed time for tools
  useEffect(() => {
    if (!streaming?.activeTools.length) {
      setLocalElapsed({});
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const next: Record<string, number> = {};
      for (const tool of streaming.activeTools) {
        next[tool.toolUseId] = (now - tool.startTime) / 1000;
      }
      setLocalElapsed(next);
    }, 1000);

    return () => clearInterval(interval);
  }, [streaming?.activeTools]);

  const handleThinkingScroll = () => {
    if (!thinkingRef.current) return;
    const el = thinkingRef.current;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    userScrolledRef.current = !isAtBottom;
  };

  // Streaming panel should only be visible while waiting for the current turn.
  if (!isWaiting) return null;

  const hasStreamData = streaming && (
    streaming.partialText ||
    streaming.thinkingText ||
    streaming.activeTools.length > 0 ||
    streaming.activeHook ||
    streaming.systemStatus ||
    streaming.recentEvents.length > 0
  );

  // Waiting but no stream data: show empty AI card with bouncing dots
  if (!hasStreamData) {
    return (
      <div className="max-w-3xl mx-auto w-full px-4 py-3">
        {/* Mobile: compact avatar + name row */}
        <div className="flex items-center gap-2 mb-1.5 lg:hidden">
          <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="sm" />
          <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
        </div>

        <div className="lg:flex lg:gap-3">
          <div className="hidden lg:block flex-shrink-0">
            <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="md" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="hidden lg:flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 border-l-[3px] border-l-brand-400 px-5 py-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce" />
                <span className="text-sm text-slate-400 ml-1">正在思考...</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!streaming) return null;

  return (
    <div className="max-w-3xl mx-auto w-full px-4 py-3">
      {/* Mobile: compact avatar + name row */}
      <div className="flex items-center gap-2 mb-1.5 lg:hidden">
        <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="sm" />
        <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
        {streaming.isThinking && (
          <span className="flex gap-0.5 ml-1">
            <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce" />
          </span>
        )}
      </div>

      <div className="lg:flex lg:gap-3">
        <div className="hidden lg:block flex-shrink-0">
          <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="md" />
        </div>
        <div className="flex-1 min-w-0">
          {/* Desktop: name row */}
          <div className="hidden lg:flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
            {streaming.isThinking && (
              <span className="flex gap-0.5 ml-1">
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce" />
              </span>
            )}
          </div>

          {/* Card */}
          <div className="bg-white rounded-xl border border-slate-100 border-l-[3px] border-l-brand-400 px-5 py-4 overflow-hidden">
            {/* System status */}
            {streaming.systemStatus && (
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{streaming.systemStatus === 'compacting' ? '上下文压缩中...' : streaming.systemStatus}</span>
              </div>
            )}

            {/* Reasoning block */}
            {streaming.thinkingText && (
              <div className="mb-3 rounded-xl border border-amber-200/60 bg-amber-50/40 overflow-hidden">
                <button
                  onClick={() => {
                    const next = !thinkingExpanded;
                    setThinkingExpanded(next);
                    if (next) userScrolledRef.current = false;
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-50/60 transition-colors"
                >
                  <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                  </svg>
                  <span className="text-xs font-medium text-amber-700">
                    {streaming.isThinking ? 'Reasoning...' : 'Reasoning'}
                  </span>
                  {streaming.isThinking && (
                    <span className="flex gap-0.5 ml-0.5">
                      <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce" />
                    </span>
                  )}
                  <span className="flex-1" />
                  {thinkingExpanded ? (
                    <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
                  )}
                </button>
                {thinkingExpanded && (
                  <div
                    ref={thinkingRef}
                    onScroll={handleThinkingScroll}
                    className="px-3 pb-3 text-sm text-amber-900/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100"
                  >
                    {streaming.thinkingText}
                  </div>
                )}
              </div>
            )}

            {/* Active tools */}
            {streaming.activeTools.length > 0 && (() => {
              // 分离非 teammate Task（渲染为内联卡片）和其他工具（渲染为 pill）
              const inlineTaskTools = streaming.activeTools.filter(
                t => t.toolName === 'Task' && t.toolUseId && !sdkTasks[t.toolUseId]?.isTeammate
              );
              const pillTools = streaming.activeTools.filter(
                t => !(t.toolName === 'Task' && t.toolUseId && !sdkTasks[t.toolUseId]?.isTeammate)
              );

              return (
                <div className="mb-2 space-y-1">
                  {/* Inline Task cards */}
                  {inlineTaskTools.map((tool) => (
                    <TaskInlineCard
                      key={tool.toolUseId}
                      toolUseId={tool.toolUseId}
                      description={tool.toolInputSummary || sdkTasks[tool.toolUseId]?.description || 'Task'}
                      startTime={tool.startTime}
                      groupJid={groupJid}
                    />
                  ))}

                  {/* Regular tool pills */}
                  {pillTools.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {pillTools.map((tool, i) => {
                        const elapsed = tool.elapsedSeconds ?? localElapsed[tool.toolUseId];
                        const isNested = tool.isNested === true;

                        return (
                          <div key={tool.toolUseId || i} className={`flex flex-col gap-1 ${isNested ? 'pl-4 border-l-2 border-brand-200' : ''}`}>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-primary border border-brand-200">
                              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              {tool.toolName === 'Skill'
                                ? (tool.skillName || 'unknown')
                                : tool.toolName}
                              {elapsed != null && (
                                <span className="text-primary">{Math.round(elapsed)}s</span>
                              )}
                            </span>
                            {tool.toolInputSummary && (
                              <div className="text-[11px] text-slate-500 px-2 break-words line-clamp-2">
                                {tool.toolInputSummary}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Recent events timeline */}
            {streaming.recentEvents.length > 0 && (
              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2 mb-2">
                <div className="text-[11px] font-medium text-slate-500 mb-1">调用轨迹</div>
                <div className="space-y-1 max-h-28 overflow-y-auto">
                  {streaming.recentEvents.map((item) => (
                    <div key={item.id} className="text-xs text-slate-600 break-words">
                      {item.text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hook */}
            {streaming.activeHook && (
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Hook: {streaming.activeHook.hookName}</span>
              </div>
            )}

            {/* Partial text with Markdown rendering */}
            {streaming.partialText && (
              <div className="max-w-none overflow-hidden">
                <MarkdownRenderer
                  content={streaming.partialText.length > 5000
                    ? '...' + streaming.partialText.slice(-4000)
                    : streaming.partialText}
                  groupJid={groupJid}
                  variant="chat"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
