import { memo, useMemo } from 'react';
import { Hourglass, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  isLiveStream,
  isProactiveRuntime,
  liveStreamOf,
  proactiveTurnQuiet,
  runTurnAnswered,
  useChatStore,
} from '../../stores/chat';
import { useShellStore } from '../../stores/shell';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { useReplyRate } from '../../hooks/useReplyRate';
import { useRunElapsed } from '../../hooks/useRunElapsed';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { sessionJidOf } from '../../lib/session-jid';
import { useAfterDelay } from '../../hooks/useTick';
import {
  latestProgress,
  normalizeProcessVisibility,
} from '../../lib/process-visibility';
import { describeRunStatus, formatRunElapsed } from '../../lib/run-phase';
import { stripInlineMarkdown } from '../../lib/thinking-text';
import {
  formatResumeTime,
  useUsageLimitWaits,
} from '../../stores/usage-limit-waits';

/**
 * How long a proactive turn may go on quietly after its reply before the bar
 * shows it again: longer than the request in which the model decides it is
 * done, so that one never flashes it.
 */
const QUIET_DELAY_MS = 3000;

/** What a proactive turn shows when its owner keeps the process hidden. */
const BUSY_TEXT = '处理中';

const PILL =
  'inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-full bg-surface-raised/85 px-3 text-caption ring-1 ring-surface-border backdrop-blur-sm pointer-coarse:min-h-8';

/**
 * The state of a run, above the composer, after cindy's activity pills: what
 * it is doing on the left (the phase, in the status accent while it works),
 * how long it has run and how fast it writes on the right. Nothing when no run
 * is active, or while one only closes after its turn ended. A proactive
 * workspace shows no more than its process level already does: at `hidden`
 * only that it is busy, and after its reply nothing until it has been going
 * quietly for a while. While it works, the latest progress the Agent sent the
 * user follows the phase, at every level.
 */
export const RunStatusBar = memo(function RunStatusBar({
  groupJid,
  agentId,
}: {
  groupJid: string;
  agentId: string;
}) {
  const runtimeJid = sessionJidOf(groupJid, agentId);
  const running = useChatStore(
    (s) => !!s.agentWaiting[agentId] || isLiveStream(s.agentStreaming[agentId]),
  );
  const stopping = useChatStore((s) => !!s.stopRequests[runtimeJid]);
  const proactive = useChatStore((s) => isProactiveRuntime(s, runtimeJid));
  const hidden = useChatStore(
    (s) =>
      normalizeProcessVisibility(s.groups[groupJid]?.process_visibility) ===
      'hidden',
  );
  const canChangeVisibility = useChatStore(
    (s) => !!s.groups[groupJid]?.can_modify,
  );
  // Primitives, so the bar renders when they change, not on every frame.
  const phase = useChatStore((s) =>
    describeRunStatus(liveStreamOf(s, runtimeJid), stopping),
  );
  // An Assistant turn that ended in place: the run only closes.
  const ended = useChatStore(
    (s) =>
      !proactive &&
      runTurnAnswered(
        s.activeRuns[runtimeJid]?.answered,
        liveStreamOf(s, runtimeJid),
      ),
  );
  const quiet = useChatStore((s) => proactiveTurnQuiet(s, runtimeJid));
  const progressText = useChatStore((s) =>
    proactive ? latestProgress(liveStreamOf(s, runtimeJid)?.steps) : null,
  );
  const progress = useMemo(
    () => (progressText ? stripInlineMarkdown(progressText) : null),
    [progressText],
  );
  const stillGoing = useAfterDelay(running && quiet, QUIET_DELAY_MS);
  const elapsed = useRunElapsed(runtimeJid);
  const rate = useReplyRate(agentId);
  const offline = useConnectionStatus() === 'offline';
  const busyOnly = (proactive && hidden) || quiet;
  const label = offline
    ? '网络已断开，恢复后同步'
    : busyOnly
      ? BUSY_TEXT
      : phase;
  const shownProgress = !offline && !quiet ? progress : null;
  const announced = useThrottledValue(
    shownProgress ? `${label}：${shownProgress}` : label,
    3000,
  );
  const usageWait = useUsageLimitWaits((s) => s.waits[runtimeJid]);

  // Between runs, an input waiting for a usage-limit reset says when it goes on.
  if (!running && usageWait) {
    return (
      <div
        data-hc-usage-limit-wait=""
        className="flex min-h-11 items-center gap-2 px-1 font-sans"
      >
        <span
          role="status"
          aria-live="polite"
          className={cn(PILL, 'font-medium text-warning')}
        >
          <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            额度用尽，预计 {formatResumeTime(usageWait.resumeAt)} 自动继续
          </span>
        </span>
      </div>
    );
  }

  if (!running || ended || (quiet && !stillGoing)) return null;

  const meta = [
    elapsed != null && !offline ? formatRunElapsed(elapsed) : null,
    rate != null && !stopping && !offline ? `${rate} tok/s` : null,
  ].filter(Boolean);
  return (
    <div
      data-hc-run-status-bar=""
      className="flex min-h-11 items-center justify-between gap-2 px-1 font-sans"
    >
      <span
        className={cn(
          PILL,
          'font-medium',
          offline || stopping ? 'text-muted-foreground' : 'text-status-accent',
        )}
      >
        <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
        <span
          data-hc-run-phase=""
          className={shownProgress ? 'shrink-0' : 'truncate'}
        >
          {label}
        </span>
        {shownProgress && (
          <span
            data-hc-run-progress=""
            title={shownProgress}
            className="min-w-0 truncate font-normal text-muted-foreground"
          >
            {shownProgress}
          </span>
        )}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
      {(meta.length > 0 || (proactive && hidden && canChangeVisibility)) && (
        <span className={cn(PILL, 'shrink-0 text-faint-foreground')}>
          {meta.length > 0 && (
            <span className="tabular-nums">{meta.join(' · ')}</span>
          )}
          {proactive && hidden && canChangeVisibility && (
            <button
              type="button"
              onClick={() =>
                useShellStore.getState().requestWorkspaceSettings(groupJid)
              }
              className="-mr-1.5 inline-flex h-6 cursor-pointer items-center rounded-full px-1.5 text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:h-10"
            >
              显示过程
            </button>
          )}
        </span>
      )}
    </div>
  );
});
