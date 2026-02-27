import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { MarkdownRenderer } from './MarkdownRenderer';

interface TaskInlineCardProps {
  toolUseId: string;
  description: string;
  startTime: number;
  groupJid: string;
}

export function TaskInlineCard({ toolUseId, description, startTime, groupJid }: TaskInlineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const taskInfo = useChatStore(s => s.sdkTasks[toolUseId]);
  const streaming = useChatStore(s => s.agentStreaming[toolUseId]);
  const contentRef = useRef<HTMLDivElement>(null);

  const status = taskInfo?.status || 'running';
  const summary = taskInfo?.summary;
  const isRunning = status === 'running';

  // Elapsed timer
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setElapsed((Date.now() - startTime) / 1000);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, startTime]);

  // Final elapsed on completion
  useEffect(() => {
    if (!isRunning) {
      setElapsed((Date.now() - startTime) / 1000);
    }
  }, [isRunning, startTime]);

  // Auto-scroll expanded content
  useEffect(() => {
    if (expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [expanded, streaming?.partialText, streaming?.thinkingText]);

  const statusIcon = isRunning ? (
    <Loader2 className="w-4 h-4 text-brand-500 animate-spin flex-shrink-0" />
  ) : status === 'completed' ? (
    <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
  ) : (
    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
  );

  const hasContent = streaming && (
    streaming.partialText ||
    streaming.thinkingText ||
    streaming.activeTools.length > 0 ||
    streaming.recentEvents.length > 0
  );

  return (
    <div className="w-full my-1">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded(v => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors text-left ${
          isRunning
            ? 'border-brand-200 bg-brand-50/50 hover:bg-brand-50'
            : status === 'completed'
              ? 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50'
              : 'border-red-200 bg-red-50/50 hover:bg-red-50'
        }`}
      >
        {statusIcon}
        <span className="text-xs font-medium text-slate-700 truncate flex-1">
          Task: {description}
        </span>
        {summary && !expanded && (
          <span className="text-[11px] text-slate-500 truncate max-w-[200px]">
            {summary}
          </span>
        )}
        <span className="text-[11px] text-slate-400 flex-shrink-0 tabular-nums">
          {Math.round(elapsed)}s
        </span>
        {hasContent && (
          expanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          )
        )}
      </button>

      {/* Expanded detail */}
      {expanded && hasContent && streaming && (
        <div
          ref={contentRef}
          className="mt-1 rounded-lg border border-slate-200 bg-white max-h-80 overflow-y-auto"
        >
          <div className="px-3 py-2 space-y-2">
            {/* Thinking / Reasoning */}
            {streaming.thinkingText && (
              <div className="rounded-md border border-amber-200/60 bg-amber-50/40 px-2.5 py-2">
                <div className="text-[11px] font-medium text-amber-700 mb-1 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                  </svg>
                  Reasoning
                </div>
                <div className="text-xs text-amber-900/70 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {streaming.thinkingText.length > 2000
                    ? '...' + streaming.thinkingText.slice(-1800)
                    : streaming.thinkingText}
                </div>
              </div>
            )}

            {/* Nested tool pills */}
            {streaming.activeTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {streaming.activeTools.map((tool, i) => (
                  <span
                    key={tool.toolUseId || i}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-brand-50 text-primary border border-brand-200"
                  >
                    <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {tool.toolName === 'Skill' ? (tool.skillName || 'unknown') : tool.toolName}
                  </span>
                ))}
              </div>
            )}

            {/* Recent events timeline */}
            {streaming.recentEvents.length > 0 && (
              <div className="rounded-md border border-slate-100 bg-slate-50/50 p-1.5">
                <div className="text-[10px] font-medium text-slate-500 mb-0.5">调用轨迹</div>
                <div className="space-y-0.5 max-h-20 overflow-y-auto">
                  {streaming.recentEvents.map((item) => (
                    <div key={item.id} className="text-[11px] text-slate-600 break-words">
                      {item.text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Partial text output */}
            {streaming.partialText && (
              <div className="text-sm overflow-hidden">
                <MarkdownRenderer
                  content={streaming.partialText.length > 3000
                    ? '...' + streaming.partialText.slice(-2500)
                    : streaming.partialText}
                  groupJid={groupJid}
                  variant="chat"
                />
              </div>
            )}

            {/* Summary on completion */}
            {!isRunning && summary && (
              <div className={`text-xs px-2 py-1.5 rounded-md ${
                status === 'completed'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                {summary}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collapsed summary for completed tasks */}
      {!expanded && !isRunning && summary && (
        <div className="mt-0.5 px-3 text-[11px] text-slate-500 truncate">
          {summary}
        </div>
      )}
    </div>
  );
}
