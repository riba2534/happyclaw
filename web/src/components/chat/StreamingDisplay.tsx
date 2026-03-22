import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, OctagonX } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import type { AgentInfo } from '../../types';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TodoProgressPanel } from './TodoProgressPanel';
import { ToolActivityCard } from './ToolActivityCard';
import { useDisplayMode } from '../../hooks/useDisplayMode';

/** Render AskUserQuestion options as a visual card (read-only). */
function AskUserQuestionCard({ toolInput }: { toolInput: Record<string, unknown> }) {
  // Support both "question" (string) and "questions" (array) formats
  const questions: Array<{ question: string; options?: Array<{ value: string; label?: string }> }> = [];
  if (Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      if (q && typeof q === 'object' && 'question' in q) {
        questions.push(q as { question: string; options?: Array<{ value: string; label?: string }> });
      }
    }
  } else if (typeof toolInput.question === 'string') {
    questions.push({
      question: toolInput.question,
      options: Array.isArray(toolInput.options) ? toolInput.options : undefined,
    });
  }

  if (questions.length === 0) return null;

  return (
    <div className="mt-2 mb-2 space-y-2">
      {questions.map((q, qi) => (
        <div key={qi} className="rounded-lg border border-brand-200 bg-brand-50/30 p-3">
          <div className="text-sm font-medium text-foreground mb-2">{q.question}</div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => (
                <span
                  key={oi}
                  className="inline-block px-2.5 py-1 rounded-md text-xs font-medium bg-brand-100 text-primary border border-brand-200"
                >
                  {opt.label || opt.value || '—'}
                </span>
              ))}
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-2">
            请在 Agent 终端中回复
          </div>
        </div>
      ))}
    </div>
  );
}

const TASK_STATUS_LABELS: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  error: '出错',
};

/** Collapsible block for a single Task Agent — visually consistent with the Thinking block. */
function TaskAgentBlock({ agent, groupJid }: { agent: AgentInfo; groupJid: string }) {
  const streaming = useChatStore(s => s.agentStreaming[agent.id]);
  const isRunning = agent.status === 'running';
  const [expanded, setExpanded] = useState(isRunning);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

  // Auto-expand when agent starts running
  useEffect(() => {
    if (isRunning) setExpanded(true);
  }, [isRunning]);

  // Local elapsed timer for tools
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

  const borderColor = isRunning ? 'border-blue-200/60 dark:border-blue-700/40' : agent.status === 'error' ? 'border-red-200/60 dark:border-red-700/40' : 'border-emerald-200/60 dark:border-emerald-700/40';
  const bgColor = isRunning ? 'bg-blue-50/40 dark:bg-blue-950/30' : agent.status === 'error' ? 'bg-red-50/40 dark:bg-red-950/30' : 'bg-emerald-50/40 dark:bg-emerald-950/30';
  const hoverBg = isRunning ? 'hover:bg-blue-50/60 dark:hover:bg-blue-900/30' : agent.status === 'error' ? 'hover:bg-red-50/60 dark:hover:bg-red-900/30' : 'hover:bg-emerald-50/60 dark:hover:bg-emerald-900/30';
  const dotColor = isRunning ? 'bg-blue-500 animate-pulse' : agent.status === 'error' ? 'bg-red-500' : 'bg-emerald-500';
  const textColor = isRunning ? 'text-blue-700 dark:text-blue-300' : agent.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300';
  const chevronColor = isRunning ? 'text-blue-400 dark:text-blue-500' : agent.status === 'error' ? 'text-red-400 dark:text-red-500' : 'text-emerald-400 dark:text-emerald-500';
  const contentBorderColor = isRunning ? 'border-blue-100 dark:border-blue-800/50' : agent.status === 'error' ? 'border-red-100 dark:border-red-800/50' : 'border-emerald-100 dark:border-emerald-800/50';

  return (
    <div className={`mb-3 rounded-xl border ${borderColor} ${bgColor} overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${hoverBg} transition-colors`}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className={`text-xs font-medium ${textColor}`}>
          子 Agent: {agent.name}
        </span>
        <span className={`text-[11px] ${textColor} opacity-70`}>
          {TASK_STATUS_LABELS[agent.status] || agent.status}
        </span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className={`w-3.5 h-3.5 ${chevronColor}`} />
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 ${chevronColor}`} />
        )}
      </button>
      {expanded && (
        <div className={`px-3 pb-3 border-t ${contentBorderColor} space-y-2`}>
          {/* Agent prompt */}
          <p className="text-[13px] text-foreground/60 mt-2 line-clamp-2">{agent.prompt}</p>

          {/* Live streaming state (running) */}
          {isRunning && streaming && (
            <>
              {streaming.isThinking && (
                <p className="text-[13px] text-blue-500 dark:text-blue-400 italic flex items-center gap-1">
                  思考中
                  <span className="flex gap-0.5 ml-0.5">
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" />
                  </span>
                </p>
              )}
              {streaming.activeTools.length > 0 && (
                <div className="space-y-1.5">
                  {streaming.activeTools.filter(t => t.toolName !== 'AskUserQuestion').map((tool) => (
                    <ToolActivityCard
                      key={tool.toolUseId}
                      tool={tool}
                      localElapsed={localElapsed[tool.toolUseId]}
                    />
                  ))}
                </div>
              )}
              {streaming.partialText && (
                <div className="max-w-none overflow-hidden text-sm [&>div>*:first-child]:!mt-0">
                  <MarkdownRenderer
                    content={streaming.partialText.length > 2000
                      ? '...' + streaming.partialText.slice(-1500)
                      : streaming.partialText}
                    groupJid={groupJid}
                    variant="chat"
                    streaming
                  />
                </div>
              )}
            </>
          )}

          {/* Result summary (completed/error) */}
          {!isRunning && agent.result_summary && (
            <p className="text-[13px] text-foreground/70">{agent.result_summary}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared streaming content — used by both compact and chat modes to eliminate duplication. */
function StreamingContent({
  streaming,
  localElapsed,
  groupJid,
  thinkingExpanded,
  setThinkingExpanded,
  thinkingRef,
  handleThinkingScroll,
}: {
  streaming: import('../../stores/chat').StreamingState;
  localElapsed: Record<string, number>;
  groupJid: string;
  thinkingExpanded: boolean;
  setThinkingExpanded: (v: boolean) => void;
  thinkingRef: React.RefObject<HTMLDivElement | null>;
  handleThinkingScroll: () => void;
}) {
  // Classify active tools
  const cardTools = streaming.activeTools.filter(
    t => t.toolName !== 'AskUserQuestion'
  );
  const askUserTools = streaming.activeTools.filter(
    t => t.toolName === 'AskUserQuestion' && t.toolInput
  );

  return (
    <>
      {/* System status */}
      {streaming.systemStatus && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground mb-2">
          <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{streaming.systemStatus === 'compacting' ? '上下文压缩中...' : streaming.systemStatus}</span>
        </div>
      )}

      {/* Reasoning block */}
      {streaming.thinkingText && (
        <div className="mb-3 rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-950/30 overflow-hidden">
          <button
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-50/60 dark:hover:bg-amber-900/30 transition-colors"
          >
            <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
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
              className="px-3 pb-3 text-sm text-amber-900/70 dark:text-amber-200/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100 dark:border-amber-800/50"
            >
              {streaming.thinkingText}
            </div>
          )}
        </div>
      )}

      {/* Active tools */}
      {streaming.activeTools.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {cardTools.length > 0 && (
            <div className="space-y-1.5">
              {cardTools.map((tool) => (
                <ToolActivityCard
                  key={tool.toolUseId}
                  tool={tool}
                  localElapsed={localElapsed[tool.toolUseId]}
                />
              ))}
            </div>
          )}
          {askUserTools.map((tool) => (
            <AskUserQuestionCard key={tool.toolUseId} toolInput={tool.toolInput ?? {}} />
          ))}
        </div>
      )}

      {/* Todo progress */}
      {streaming.todos && streaming.todos.length > 0 && (
        <TodoProgressPanel todos={streaming.todos} />
      )}

      {/* Recent events timeline */}
      {streaming.recentEvents.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-2 mb-2">
          <div className="text-xs font-medium text-muted-foreground mb-1">调用轨迹</div>
          <div className="space-y-0.5 max-h-28 overflow-y-auto">
            {streaming.recentEvents.map((item) => (
              <div key={item.id} className="text-[13px] text-foreground/70 break-words">
                {item.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hook */}
      {streaming.activeHook && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground mb-2">
          <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Hook: {streaming.activeHook.hookName}</span>
        </div>
      )}

      {/* Partial text */}
      {streaming.partialText && (
        <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
          <MarkdownRenderer
            content={streaming.partialText.length > 3000
              ? '...' + streaming.partialText.slice(-2000)
              : streaming.partialText}
            groupJid={groupJid}
            variant="chat"
            streaming
          />
        </div>
      )}

      {/* Interrupted indicator */}
      {streaming.interrupted && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center gap-1.5 text-[13px] text-amber-600">
            <OctagonX className="w-3.5 h-3.5" />
            <span>已中断</span>
          </div>
        </div>
      )}
    </>
  );
}

interface StreamingDisplayProps {
  groupJid: string;
  isWaiting: boolean;
  senderName?: string;
  agentId?: string;
}

const EMPTY_AGENTS: AgentInfo[] = [];

export function StreamingDisplay({ groupJid, isWaiting, senderName: senderNameProp = 'AI', agentId }: StreamingDisplayProps) {
  const mainStreaming = useChatStore(s => s.streaming[groupJid]);
  const agentStreamingState = useChatStore(s => agentId ? s.agentStreaming[agentId] : undefined);
  const streaming = agentId ? agentStreamingState : mainStreaming;
  // Task agents — only shown in main conversation (not inside agent tabs)
  const allAgents = useChatStore(s => !agentId ? (s.agents[groupJid] ?? EMPTY_AGENTS) : EMPTY_AGENTS);
  const taskAgents = useMemo(() => allAgents.filter(a => a.kind === 'task' && a.status === 'running'), [allAgents]);
  const hasTaskAgents = taskAgents.length > 0;
  const currentUser = useAuthStore(s => s.user);
  const appearance = useAuthStore(s => s.appearance);
  const senderName = currentUser?.ai_name || appearance?.aiName || senderNameProp;
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

  // Auto-clear stale waiting state to prevent UI getting stuck when agent
  // process dies without sending a final message.
  const lastStreamActivityRef = useRef(Date.now());
  useEffect(() => {
    // Reset activity timer whenever streaming state changes (i.e., new stream events)
    if (streaming) {
      lastStreamActivityRef.current = Date.now();
    }
  }, [streaming]);

  useEffect(() => {
    if (!isWaiting) return;
    // Record the moment waiting starts
    lastStreamActivityRef.current = Date.now();

    const STALE_NO_DATA_MS = 60_000;   // 60s with no stream data at all
    const STALE_WITH_DATA_MS = 180_000; // 3min since last stream event

    const interval = setInterval(() => {
      const elapsed = Date.now() - lastStreamActivityRef.current;
      const state = useChatStore.getState();
      const hasData = agentId
        ? !!state.agentStreaming[agentId]
        : !!state.streaming[groupJid];
      const threshold = hasData ? STALE_WITH_DATA_MS : STALE_NO_DATA_MS;

      if (elapsed > threshold) {
        // Clear the stuck waiting state via clearStreaming (handles pendingThinking + SDK Task preservation)
        useChatStore.getState().clearStreaming(groupJid);
        if (agentId) {
          // clearStreaming doesn't handle agent-specific state, clean it separately
          useChatStore.setState(s => {
            const nextStreaming = { ...s.agentStreaming };
            delete nextStreaming[agentId];
            return {
              agentWaiting: { ...s.agentWaiting, [agentId]: false },
              agentStreaming: nextStreaming,
            };
          });
        }
      }
    }, 10_000); // check every 10s

    return () => clearInterval(interval);
  }, [isWaiting, groupJid, agentId]);

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

  // 计算是否有流式数据（含中断后冻结的 partialText）
  const hasStreamData = (streaming && (
    streaming.partialText ||
    streaming.thinkingText ||
    streaming.activeTools.length > 0 ||
    streaming.activeHook ||
    streaming.systemStatus ||
    streaming.recentEvents.length > 0 ||
    (streaming.todos && streaming.todos.length > 0)
  )) || hasTaskAgents;

  // 仅在既不等待也无冻结数据时才隐藏
  if (!isWaiting && !hasStreamData) return null;

  // Waiting but no stream data: show empty AI card with bouncing dots
  if (isWaiting && !hasStreamData) {
    if (isCompact) {
      return (
        <div className="mb-2 border-b border-border pb-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-semibold text-primary">{senderName}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-bounce" />
            <span className="text-sm text-muted-foreground ml-1">正在思考...</span>
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-4xl mx-auto w-full px-4 py-3">
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
            <div className="bg-surface rounded-xl border border-border/60 px-5 py-4 font-serif shadow-card">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 bg-brand-400 rounded-full animate-bounce" />
                <span className="text-sm text-muted-foreground ml-1">正在思考...</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!streaming && !hasTaskAgents) return null;

  // ── Compact mode streaming ──
  if (isCompact) {
    return (
      <div className="mb-2 border-b border-border pb-2">
        {/* Sender line */}
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs font-semibold text-primary">{senderName}</span>
          {streaming?.isThinking && (
            <span className="flex gap-0.5 ml-0.5">
              <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce" />
            </span>
          )}
        </div>

        {/* Content — flat, no card wrapper */}
        <div className="min-w-0 overflow-hidden">

          {/* Shared streaming content */}
          {streaming && (
            <StreamingContent
              streaming={streaming}
              localElapsed={localElapsed}
              groupJid={groupJid}
              thinkingExpanded={thinkingExpanded}
              setThinkingExpanded={(v) => {
                setThinkingExpanded(v);
                if (v) userScrolledRef.current = false;
              }}
              thinkingRef={thinkingRef}
              handleThinkingScroll={handleThinkingScroll}
            />
          )}

          {/* Task agent blocks */}
          {taskAgents.map((agent) => (
            <TaskAgentBlock key={agent.id} agent={agent} groupJid={groupJid} />
          ))}
        </div>
      </div>
    );
  }

  // ── Chat mode streaming (default) ──
  return (
    <div className="max-w-4xl mx-auto w-full px-4 py-3">
      {/* Mobile: compact avatar + name row */}
      <div className="flex items-center gap-2 mb-1.5 lg:hidden">
        <EmojiAvatar imageUrl={aiImageUrl} emoji={aiEmoji} color={aiColor} fallbackChar={senderName[0]} size="sm" />
        <span className="text-xs text-muted-foreground font-medium">{senderName}</span>
        {streaming?.isThinking && (
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
            {streaming?.isThinking && (
              <span className="flex gap-0.5 ml-1">
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1 h-1 bg-brand-400 rounded-full animate-bounce" />
              </span>
            )}
          </div>

          {/* Card */}
          <div className="bg-surface rounded-xl border border-border/60 px-5 py-4 overflow-hidden font-serif shadow-card">
            {streaming && (
              <StreamingContent
                streaming={streaming}
                localElapsed={localElapsed}
                groupJid={groupJid}
                thinkingExpanded={thinkingExpanded}
                setThinkingExpanded={(v) => {
                  setThinkingExpanded(v);
                  if (v) userScrolledRef.current = false;
                }}
                thinkingRef={thinkingRef}
                handleThinkingScroll={handleThinkingScroll}
              />
            )}

            {/* Task agent blocks */}
            {taskAgents.map((agent) => (
              <TaskAgentBlock key={agent.id} agent={agent} groupJid={groupJid} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
