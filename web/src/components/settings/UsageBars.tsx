import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { CachedOAuthUsage, OAuthUsageBucket } from './types';

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

function barColor(utilization: number): string {
  if (utilization >= 80) return 'bg-red-500';
  if (utilization >= 50) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function formatResetTime(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return '现在';

  const totalMinutes = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function UsageColumn({
  label,
  bucket,
}: {
  label: string;
  bucket: OAuthUsageBucket;
}) {
  const pct = Math.round(bucket.utilization);
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0 justify-center">
      <span className="text-[11px] font-medium text-muted-foreground shrink-0">
        {label}
      </span>
      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
        <div
          className={`h-full rounded-full transition-all ${barColor(pct)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-[11px] font-mono text-muted-foreground shrink-0">
        {pct}%
      </span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">
        {formatResetTime(bucket.resets_at)}
      </span>
    </div>
  );
}

export function UsageBars({ providerId }: { providerId: string }) {
  const [usage, setUsage] = useState<CachedOAuthUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchUsage = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const data = await api.get<CachedOAuthUsage>(
          `/api/config/claude/providers/${providerId}/usage`,
        );
        if (!cancelled) setUsage(data);
      } catch {
        // Silent — usage is optional
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchUsage();
    timerRef.current = setInterval(fetchUsage, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchUsage();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [providerId]);

  if (loading || !usage?.data) return null;

  const USAGE_BUCKET_LABELS = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7dO',
    seven_day_sonnet: '7dS',
    seven_day_sonnet_max: '7dSMax',
    extra_usage: 'Extra',
  } as const;

  const buckets: { label: string; bucket: OAuthUsageBucket }[] = [];
  if (usage.data.five_hour)
    buckets.push({
      label: USAGE_BUCKET_LABELS.five_hour,
      bucket: usage.data.five_hour,
    });
  if (usage.data.seven_day)
    buckets.push({
      label: USAGE_BUCKET_LABELS.seven_day,
      bucket: usage.data.seven_day,
    });
  if (usage.data.seven_day_opus)
    buckets.push({
      label: USAGE_BUCKET_LABELS.seven_day_opus,
      bucket: usage.data.seven_day_opus,
    });
  if (usage.data.seven_day_sonnet)
    buckets.push({
      label: USAGE_BUCKET_LABELS.seven_day_sonnet,
      bucket: usage.data.seven_day_sonnet,
    });
  if (usage.data.seven_day_sonnet_max)
    buckets.push({
      label: USAGE_BUCKET_LABELS.seven_day_sonnet_max,
      bucket: usage.data.seven_day_sonnet_max,
    });
  if (usage.data.extra_usage)
    buckets.push({
      label: USAGE_BUCKET_LABELS.extra_usage,
      bucket: usage.data.extra_usage,
    });

  if (buckets.length === 0) return null;

  return (
    <div className="mt-1.5 ml-4 flex items-center gap-3">
      {buckets.map((b) => (
        <UsageColumn key={b.label} label={b.label} bucket={b.bucket} />
      ))}
    </div>
  );
}
