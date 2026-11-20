import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type {
  MagpieQuotasUsage,
  MagpieQuotaWindow,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import type {
  AgyQuotaUsage,
  CachedOAuthUsage,
  CodexRateLimitsUsage,
  CodexRateLimitWindow,
  OAuthExtraUsage,
  OAuthUsageBucket,
  ProviderQuotaObservation,
} from './types';

/** What the usage route answers, by the kind of connection. */
type ProviderUsage =
  | AgyQuotaUsage
  | CachedOAuthUsage
  | CodexRateLimitsUsage
  | MagpieQuotasUsage;

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

/** 300 → "5h", 10080 → "7d": the window lengths ChatGPT reports. */
export function codexWindowLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0)
    return '额度';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function codexWindowBucket(window: CodexRateLimitWindow): OAuthUsageBucket {
  return {
    utilization: window.usedPercent,
    resets_at:
      window.resetsAt && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt * 1000).toISOString()
        : null,
  };
}

/** ChatGPT subscription windows as seen on the latest gateway response. */
function CodexUsage({
  usage,
  className,
}: {
  usage: CodexRateLimitsUsage;
  className?: string;
}) {
  if (usage.limits.length === 0) {
    return (
      <div className={cn('text-micro text-muted-foreground', className)}>
        发出一次请求后显示 ChatGPT 订阅额度
      </div>
    );
  }
  const columns: Array<{
    key: string;
    label: string;
    bucket: OAuthUsageBucket;
    detail?: string;
  }> = [];
  for (const limit of usage.limits) {
    // The account-wide limit is "codex"; others are model-specific.
    const prefix =
      limit.limitId === 'codex' ? '' : `${limit.limitName ?? limit.limitId} `;
    for (const window of [limit.primary, limit.secondary]) {
      if (!window) continue;
      columns.push({
        key: `${limit.limitId}-${window.windowMinutes}`,
        label: `${prefix}${codexWindowLabel(window.windowMinutes)}`,
        bucket: codexWindowBucket(window),
      });
    }
    if (limit.credits?.hasCredits) {
      columns.push({
        key: `${limit.limitId}-credits`,
        label: `${prefix}Credits`,
        bucket: { utilization: null, resets_at: null },
        detail: limit.credits.unlimited
          ? '不限量'
          : `余额 ${limit.credits.balance ?? '—'}`,
      });
    }
  }
  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      {usage.rateLimitReachedType && (
        <div className="text-micro text-error">
          已触达 ChatGPT 订阅限额（{usage.rateLimitReachedType}
          ），重置前请求会被拒绝
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {columns.map((column) => (
          <UsageColumn
            key={column.key}
            label={column.label}
            bucket={column.bucket}
            detail={column.detail}
          />
        ))}
      </div>
      {usage.observedAt && (
        <div className="text-micro text-faint-foreground">
          更新于 {new Date(usage.observedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

/** One magpie usage window: what is left of it and when it renews. */
function QuotaWindowColumn({ quota }: { quota: MagpieQuotaWindow }) {
  const remaining = quota.unlimited
    ? null
    : clampUsagePercentage(quota.remaining);
  const reset = formatResetTime(quota.resetsAt);
  const label = quota.name || '额度';
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
          {quota.unlimited
            ? '不限量'
            : remaining === null
              ? '—'
              : `剩余 ${Math.round(remaining)}%`}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
        {remaining !== null && (
          <div
            className={`h-full rounded-full transition-all ${barColor(100 - remaining)}`}
            style={{ width: `${remaining}%` }}
          />
        )}
      </div>
      {reset && (
        <div className="mt-1 truncate text-micro text-faint-foreground">
          {reset} 后重置
        </div>
      )}
    </div>
  );
}

/**
 * The accounts a magpie gateway routes to, each with its windows as magpie
 * read them. A failed read names its reason, for the gateway as a whole or
 * for one account.
 */
function MagpieUsage({
  usage,
  className,
}: {
  usage: MagpieQuotasUsage;
  className?: string;
}) {
  if (usage.error) {
    return (
      <div
        className={cn('text-micro break-words text-warning', className)}
        title={usage.error}
      >
        无法读取 magpie 用量：{usage.error}
      </div>
    );
  }
  if (usage.accounts.length === 0) {
    return (
      <div className={cn('text-micro text-muted-foreground', className)}>
        magpie 还没有能查询用量的账号
      </div>
    );
  }
  return (
    <div className={cn('min-w-0 space-y-3', className)}>
      {usage.accounts.map((account, index) => (
        <section
          key={`${account.provider}-${account.name}-${index}`}
          aria-label={`${account.name} 的用量`}
          className="min-w-0 space-y-1.5"
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-micro">
            <span className="min-w-0 truncate font-medium text-foreground">
              {account.name}
            </span>
            <span className="font-mono text-muted-foreground">
              {account.provider}
            </span>
            {account.plan && (
              <span className="text-muted-foreground">{account.plan}</span>
            )}
          </div>
          {account.error ? (
            <div className="text-micro break-words text-error">
              读取失败：{account.error}
            </div>
          ) : account.windows.length === 0 ? (
            <div className="text-micro text-muted-foreground">没有用量窗口</div>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {account.windows.map((quota, quotaIndex) => (
                <QuotaWindowColumn
                  key={`${quota.name}-${quotaIndex}`}
                  quota={quota}
                />
              ))}
            </div>
          )}
        </section>
      ))}
      {Number.isFinite(usage.fetchedAt) && usage.fetchedAt > 0 && (
        <div className="text-micro text-faint-foreground">
          更新于 {new Date(usage.fetchedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
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

function AgyUsage({
  usage,
  className,
}: {
  usage: AgyQuotaUsage;
  className?: string;
}) {
  if (usage.groups.length === 0 && !usage.error) return null;

  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      {usage.error && (
        <div className="text-micro text-warning" title={usage.error}>
          暂时无法刷新 AGY 配额
          {usage.groups.length > 0 ? '，显示上次数据' : `：${usage.error}`}
        </div>
      )}
      {usage.groups.length > 0 && (
        <div className="space-y-2">
          {usage.groups.map((group) => {
            const windows: Array<{
              key: string;
              label: string;
              bucket: OAuthUsageBucket;
              detail?: string;
            }> = [];
            if (group.fiveHour) {
              windows.push({
                key: '5h',
                label: '5h',
                bucket: {
                  utilization: group.fiveHour.usedPercent,
                  resets_at: group.fiveHour.resetsAt,
                },
                detail: `剩余 ${group.fiveHour.remainingPercent}%`,
              });
            }
            if (group.weekly) {
              windows.push({
                key: '7d',
                label: '7d',
                bucket: {
                  utilization: group.weekly.usedPercent,
                  resets_at: group.weekly.resetsAt,
                },
                detail: `剩余 ${group.weekly.remainingPercent}%`,
              });
            }
            for (const other of group.others) {
              windows.push({
                key: other.label,
                label: other.label,
                bucket: {
                  utilization: other.usedPercent,
                  resets_at: other.resetsAt,
                },
                detail: `剩余 ${other.remainingPercent}%`,
              });
            }
            if (windows.length === 0) return null;
            return (
              <div key={group.group} className="space-y-1">
                <div className="text-micro font-medium text-muted-foreground">
                  {group.group}
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  {windows.map((w) => (
                    <UsageColumn
                      key={w.key}
                      label={w.label}
                      bucket={w.bucket}
                      detail={w.detail}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
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
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    setLoading(true);

    const fetchUsage = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const data = await api.get<ProviderUsage>(
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

  if (loading || !usage) return null;
  if ('kind' in usage && usage.kind === 'agy_quotas') {
    return <AgyUsage usage={usage} className={className} />;
  }
  if ('kind' in usage && usage.kind === 'codex_rate_limits') {
    return <CodexUsage usage={usage} className={className} />;
  }
  if ('kind' in usage && usage.kind === 'magpie_quotas') {
    return <MagpieUsage usage={usage} className={className} />;
  }
  if (!('data' in usage) || !usage.data) return null;

  // An unsupported grant can still carry live SDK rate-limit observations;
  // only the usage buckets are unavailable.
  const statusNote =
    usage.status === 'needs_relogin'
      ? { tone: 'text-error', text: '授权已失效，重新登录后才能查看用量' }
      : usage.status === 'unsupported' && usage.unsupportedReason !== 'no_oauth'
        ? {
            tone: 'text-muted-foreground',
            text: 'Setup Token / 仅推理权限的授权不支持用量查询',
          }
        : null;
  if (usage.status) {
    if (!statusNote && !usage.observation) return null;
    return (
      <div className={cn('min-w-0 space-y-2', className)}>
        {statusNote && (
          <div className={cn('text-micro', statusNote.tone)}>
            {statusNote.text}
          </div>
        )}
        {usage.observation && <LiveStatus observation={usage.observation} />}
      </div>
    );
  }

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
