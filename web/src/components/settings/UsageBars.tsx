import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';
import type {
  CachedOAuthUsage,
  OAuthExtraUsage,
  OAuthUsageBucket,
  ProviderQuotaObservation,
} from './types';

const POLL_INTERVAL_MS = 3 * 60 * 1000;
const LIVE_OBSERVATION_FRESHNESS_MS = 5 * 60 * 1000;

export function clampUsagePercentage(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function barColor(utilization: number): string {
  if (utilization >= 80) return 'bg-error';
  if (utilization >= 50) return 'bg-warning';
  return 'bg-success';
}

export function formatResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const resetMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const diff = resetMs - Date.now();
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

export function sdkUtilizationPercentage(
  observation: ProviderQuotaObservation,
): number | null {
  if (
    observation.utilization === undefined ||
    !Number.isFinite(observation.utilization) ||
    observation.utilization < 0 ||
    observation.utilization > 1
  ) {
    return null;
  }
  return observation.utilization * 100;
}

export function extraUsagePercentage(extra: OAuthExtraUsage): number | null {
  if (!extra.is_enabled) return null;
  const reported = clampUsagePercentage(extra.utilization);
  if (reported !== null) return reported;
  if (
    extra.used_credits === null ||
    extra.monthly_limit === null ||
    !Number.isFinite(extra.used_credits) ||
    !Number.isFinite(extra.monthly_limit) ||
    extra.monthly_limit <= 0
  ) {
    return null;
  }
  return clampUsagePercentage((extra.used_credits / extra.monthly_limit) * 100);
}

export function isCurrentProviderQuotaObservation(
  observation: ProviderQuotaObservation,
  now = Date.now(),
): boolean {
  if (
    !Number.isFinite(observation.observedAt) ||
    observation.observedAt <= 0 ||
    now - observation.observedAt > LIVE_OBSERVATION_FRESHNESS_MS
  ) {
    return false;
  }
  if (
    observation.resetsAt !== undefined &&
    Number.isFinite(observation.resetsAt) &&
    observation.resetsAt > 0 &&
    observation.resetsAt * 1000 <= now
  ) {
    return false;
  }
  return true;
}

function formatEpochReset(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 1e11 ? value * 1000 : value;
  return formatResetTime(new Date(milliseconds).toISOString());
}

function UsageColumn({
  label,
  bucket,
  detail,
}: {
  label: string;
  bucket: OAuthUsageBucket;
  detail?: string | null;
}) {
  const pct = clampUsagePercentage(bucket.utilization);
  const reset = formatResetTime(bucket.resets_at);
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span
          className="truncate text-micro font-medium text-muted-foreground"
          title={label}
        >
          {label}
        </span>
        <span className="shrink-0 font-mono text-micro text-muted-foreground tabular-nums">
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
        {pct !== null && (
          <div
            className={`h-full rounded-full transition-all ${barColor(pct)}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {(reset || detail) && (
        <div className="mt-1 truncate text-micro text-faint-foreground">
          {detail ?? (reset ? `${reset} 后重置` : null)}
        </div>
      )}
    </div>
  );
}

function formatMinorCurrency(
  value: number | null,
  currency: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const normalizedCurrency =
    currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    const zeroDecimalCurrency = ['JPY', 'KRW', 'VND'].includes(
      normalizedCurrency,
    );
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: zeroDecimalCurrency ? 0 : 2,
      maximumFractionDigits: zeroDecimalCurrency ? 0 : 2,
    });
    return formatter.format(value / (zeroDecimalCurrency ? 1 : 100));
  } catch {
    return `${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(value / 100)} ${normalizedCurrency}`;
  }
}

export function formatExtraUsageDetail(extra: OAuthExtraUsage): string {
  if (!extra.is_enabled) return '未启用';
  if (extra.monthly_limit === null) {
    return extra.used_credits === null
      ? '无月度上限'
      : `已用 ${formatMinorCurrency(extra.used_credits, extra.currency)} · 无月度上限`;
  }
  return `${formatMinorCurrency(extra.used_credits, extra.currency)} / ${formatMinorCurrency(extra.monthly_limit, extra.currency)}`;
}

function ExtraUsageColumn({ extra }: { extra: OAuthExtraUsage }) {
  return (
    <UsageColumn
      label="Extra"
      bucket={{ utilization: extraUsagePercentage(extra), resets_at: null }}
      detail={formatExtraUsageDetail(extra)}
    />
  );
}

function displayRateLimitType(type: string | undefined): string {
  switch (type) {
    case 'five_hour':
      return '5h';
    case 'seven_day':
      return '7d';
    case 'seven_day_opus':
      return 'Opus';
    case 'seven_day_sonnet':
      return 'Sonnet';
    case 'seven_day_overage_included':
      return '模型周期';
    case 'overage':
      return 'Extra';
    default:
      return type?.replaceAll('_', ' ') || '整体额度';
  }
}

function LiveStatus({
  observation,
}: {
  observation: ProviderQuotaObservation;
}) {
  const usingOverage =
    observation.isUsingOverage === true || observation.overageInUse === true;
  const current = isCurrentProviderQuotaObservation(observation);
  const currentStatus = usingOverage
    ? '正在使用额外用量'
    : observation.status === 'rejected'
      ? '已受限'
      : observation.status === 'allowed_warning'
        ? '接近限额'
        : '可用';
  const status = current ? currentStatus : `上次观测：${currentStatus}`;
  const color = !current
    ? 'bg-faint-foreground'
    : usingOverage
      ? 'bg-primary'
      : observation.status === 'rejected'
        ? 'bg-error'
        : observation.status === 'allowed_warning'
          ? 'bg-warning'
          : 'bg-success';
  const pct = sdkUtilizationPercentage(observation);
  const reset = formatEpochReset(observation.resetsAt);

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-micro text-muted-foreground"
      title={new Date(observation.observedAt).toLocaleString()}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
      <span className="shrink-0 font-medium text-foreground">
        {current ? 'Live' : 'Last'}
      </span>
      <span className="min-w-0 truncate">{status}</span>
      <span className="shrink-0">
        {displayRateLimitType(observation.rateLimitType)}
      </span>
      {pct !== null && (
        <span className="shrink-0 font-mono">{Math.round(pct)}%</span>
      )}
      {current && reset && <span className="shrink-0">{reset} 后重置</span>}
      {observation.overageStatus && !usingOverage && (
        <span className="min-w-0 truncate">
          Extra: {observation.overageStatus}
        </span>
      )}
    </div>
  );
}

export function UsageBars({
  providerId,
  providerVersion,
  className,
}: {
  providerId: string;
  providerVersion?: string;
  className?: string;
}) {
  const [usage, setUsage] = useState<CachedOAuthUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    setLoading(true);

    const fetchUsage = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const data = await api.get<CachedOAuthUsage>(
          `/api/config/claude/providers/${providerId}/usage`,
        );
        if (!cancelled) setUsage(data);
      } catch {
        // Usage observation is optional and must not disrupt provider settings.
        if (!cancelled) setUsage(null);
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
  }, [providerId, providerVersion]);

  if (loading || !usage?.data) return null;

  const buckets: { label: string; bucket: OAuthUsageBucket }[] = [];
  if (usage.data.five_hour)
    buckets.push({ label: '5h', bucket: usage.data.five_hour });
  if (usage.data.seven_day)
    buckets.push({ label: '7d', bucket: usage.data.seven_day });
  if (usage.data.seven_day_oauth_apps)
    buckets.push({
      label: 'OAuth apps',
      bucket: usage.data.seven_day_oauth_apps,
    });
  if (usage.data.seven_day_opus)
    buckets.push({ label: 'Opus', bucket: usage.data.seven_day_opus });
  if (usage.data.seven_day_sonnet)
    buckets.push({ label: 'Sonnet', bucket: usage.data.seven_day_sonnet });
  for (const bucket of usage.data.model_scoped) {
    buckets.push({ label: bucket.display_name, bucket });
  }

  if (buckets.length === 0 && !usage.data.extra_usage && !usage.observation) {
    return null;
  }

  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      {usage.error && (
        <div className="text-micro text-warning" title={usage.error}>
          暂时无法刷新，显示上次数据
          {Number.isFinite(usage.fetchedAt)
            ? `（${new Date(usage.fetchedAt).toLocaleString()}）`
            : ''}
        </div>
      )}
      {usage.observation && <LiveStatus observation={usage.observation} />}
      {(buckets.length > 0 || usage.data.extra_usage) && (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {buckets.map(({ label, bucket }, index) => (
            <UsageColumn
              key={`${label}-${index}`}
              label={label}
              bucket={bucket}
            />
          ))}
          {usage.data.extra_usage && (
            <ExtraUsageColumn extra={usage.data.extra_usage} />
          )}
        </div>
      )}
    </div>
  );
}
