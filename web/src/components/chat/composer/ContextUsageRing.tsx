import { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { wsManager } from '../../../api/ws';
import { sessionJidOf } from '../../../lib/session-jid';
import { useChatStore, type ContextUsage } from '../../../stores/chat';

/** 120000 → "120K", 12345 → "12.3K", 1000000 → "1M", 1500000 → "1.5M". */
export function formatTokenCount(n: number): string {
  // One decimal at most, none when it is zero.
  const thousands = Math.round(n / 100) / 10;
  if (thousands >= 1_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${thousands}K`;
  return String(Math.round(n));
}

interface ContextFigures {
  percent: number;
  label: string;
}

/** The ring's percentage and its tooltip, or null when there is no data. */
export function contextUsageFigures(
  usage: ContextUsage | null | undefined,
): ContextFigures | null {
  if (!usage) return null;
  const { usedTokens, contextWindow, percentage } = usage;
  const counted = usedTokens !== null && !!contextWindow && contextWindow > 0;
  const raw = counted ? (usedTokens / contextWindow) * 100 : percentage;
  if (raw === null || !Number.isFinite(raw)) return null;
  const percent = Math.min(100, Math.max(0, Math.round(raw)));
  return {
    percent,
    label: counted
      ? `上下文 已用 ${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)}（${percent}%）`
      : `上下文 已用 ${percent}%`,
  };
}

/** Warning from 80%, error from 95%. */
function usageTone(percent: number): string {
  return percent >= 95
    ? 'text-error'
    : percent >= 80
      ? 'text-warning'
      : 'text-muted-foreground';
}

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * cindy's context ring: how full the conversation's context is, the arc
 * starting at 12 o'clock, warning from 80% and error from 95%.
 */
export function ContextUsageRing({
  usage,
}: {
  usage: ContextUsage | null | undefined;
}) {
  const figures = contextUsageFigures(usage);
  if (!figures) return null;
  const { percent, label } = figures;
  const tone = usageTone(percent);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-context-usage
          role="img"
          aria-label={label}
          tabIndex={0}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm text-label font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            'animate-in fade-in-0 duration-200 motion-reduce:animate-none',
            tone,
          )}
        >
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            aria-hidden="true"
            className="shrink-0"
          >
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-surface-border"
            />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
            />
          </svg>
          {percent}%
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The ring for one conversation. It loads the usage when shown and after a
 * reconnect; pushes after each turn reach the store through ChatView.
 */
export function ConversationContextUsage({
  jid,
  agentId,
}: {
  jid: string;
  agentId: string;
}) {
  return <ContextUsageRing usage={useConversationContextUsage(jid, agentId)} />;
}

/**
 * The same figures as one line of text, for a phone (its composer row has no
 * room for the ring, and a touch screen shows no tooltip).
 */
export function ConversationContextUsageLine({
  jid,
  agentId,
}: {
  jid: string;
  agentId: string;
}) {
  // Shown each time the model sheet opens: what the store already has
  // (turn pushes keep it current) is not fetched again.
  const figures = contextUsageFigures(
    useConversationContextUsage(jid, agentId, { onlyIfMissing: true }),
  );
  if (!figures) return null;
  return (
    <p
      data-context-usage-line
      className={cn(
        'text-micro leading-4 tabular-nums',
        usageTone(figures.percent),
      )}
    >
      {figures.label}
    </p>
  );
}

/** One conversation's usage, loaded when shown and after a reconnect. */
function useConversationContextUsage(
  jid: string,
  agentId: string,
  { onlyIfMissing = false }: { onlyIfMissing?: boolean } = {},
) {
  const key = sessionJidOf(jid, agentId);
  const usage = useChatStore((s) => s.contextUsage[key]);
  const load = useChatStore((s) => s.loadContextUsage);
  useEffect(() => {
    if (
      !onlyIfMissing ||
      useChatStore.getState().contextUsage[key] === undefined
    ) {
      void load(jid, agentId);
    }
    const off = wsManager.on('connected', (data: { reconnect?: boolean }) => {
      if (data?.reconnect) void load(jid, agentId);
    });
    return () => {
      off();
    };
  }, [jid, agentId, key, load, onlyIfMissing]);
  return usage;
}
