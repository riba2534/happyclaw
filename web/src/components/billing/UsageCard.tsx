import { useEffect, useState } from 'react';
import { BarChart3, AlertTriangle } from 'lucide-react';
import { SegmentedControl } from '@/components/common';
import { cn } from '@/lib/utils';
import { useBillingStore } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';
import { ProgressBar } from './ProgressBar';

type WindowKey = 'daily' | 'weekly' | 'monthly';

const WINDOW_LABELS: Record<WindowKey, string> = {
  daily: '日度',
  weekly: '周度',
  monthly: '月度',
};

function WindowUsageBlock({
  costUsed,
  costQuota,
  tokenUsed,
  tokenQuota,
  fmt,
}: {
  costUsed: number;
  costQuota: number | null;
  tokenUsed: number;
  tokenQuota: number | null;
  fmt: (n: number) => string;
}) {
  const hasCostQuota = costQuota != null && costQuota > 0;
  const hasTokenQuota = tokenQuota != null && tokenQuota > 0;

  if (!hasCostQuota && !hasTokenQuota) return null;

  return (
    <div className="space-y-3">
      {hasCostQuota && (
        <div>
          <div className="mb-1.5 flex justify-between text-body">
            <span className="text-muted-foreground">费用</span>
            <span className="text-foreground tabular-nums">
              {fmt(costUsed)} / {fmt(costQuota!)}
            </span>
          </div>
          <ProgressBar value={costUsed} max={costQuota!} />
        </div>
      )}
      {hasTokenQuota && (
        <div>
          <div className="mb-1.5 flex justify-between text-body">
            <span className="text-muted-foreground">Token</span>
            <span className="text-foreground tabular-nums">
              {formatTokens(tokenUsed)} / {formatTokens(tokenQuota!)}
            </span>
          </div>
          <ProgressBar value={tokenUsed} max={tokenQuota!} />
        </div>
      )}
    </div>
  );
}

export default function UsageCard() {
  const {
    currentUsage,
    plan,
    quota,
    access,
    loadMyUsage,
    loadMyQuota,
    loadMyAccess,
  } = useBillingStore();
  const fmt = useCurrency();
  const [activeWindow, setActiveWindow] = useState<WindowKey>('monthly');

  useEffect(() => {
    loadMyUsage();
    loadMyQuota();
    loadMyAccess();
  }, [loadMyAccess, loadMyQuota, loadMyUsage]);

  // Compute per-window usage from quota data
  const monthlyUsage = quota?.usage;
  const dailyUsage = quota?.usage?.daily;
  const weeklyUsage = quota?.usage?.weekly;

  // Overall warning based on highest usage ratio
  const ratios: number[] = [];
  const addRatio = (used: number, limit: number | null | undefined) => {
    if (limit != null && limit > 0) ratios.push((used / limit) * 100);
  };
  addRatio(monthlyUsage?.costUsed ?? 0, monthlyUsage?.costQuota);
  addRatio(monthlyUsage?.tokenUsed ?? 0, monthlyUsage?.tokenQuota);
  addRatio(dailyUsage?.costUsed ?? 0, dailyUsage?.costQuota);
  addRatio(dailyUsage?.tokenUsed ?? 0, dailyUsage?.tokenQuota);
  addRatio(weeklyUsage?.costUsed ?? 0, weeklyUsage?.costQuota);
  addRatio(weeklyUsage?.tokenUsed ?? 0, weeklyUsage?.tokenQuota);
  const maxPercent = ratios.length > 0 ? Math.max(...ratios) : 0;

  // Determine which windows have quotas
  const hasDaily =
    (plan?.daily_cost_quota != null && plan.daily_cost_quota > 0) ||
    (plan?.daily_token_quota != null && plan.daily_token_quota > 0);
  const hasWeekly =
    (plan?.weekly_cost_quota != null && plan.weekly_cost_quota > 0) ||
    (plan?.weekly_token_quota != null && plan.weekly_token_quota > 0);
  const hasMonthly =
    (plan?.monthly_cost_quota != null && plan.monthly_cost_quota > 0) ||
    (plan?.monthly_token_quota != null && plan.monthly_token_quota > 0);

  const availableWindows: WindowKey[] = [];
  if (hasDaily) availableWindows.push('daily');
  if (hasWeekly) availableWindows.push('weekly');
  if (hasMonthly) availableWindows.push('monthly');
  // Always show monthly as fallback
  if (availableWindows.length === 0) availableWindows.push('monthly');
  const shownWindow = availableWindows.includes(activeWindow)
    ? activeWindow
    : availableWindows[0];

  return (
    <section className="flex flex-col rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border sm:p-5">
      <div className="mb-3 flex min-h-7 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="size-4 text-muted-foreground" />
          <h3 className="text-title-sm text-foreground">用量</h3>
        </div>
        {/* Window tabs, or the only window's name */}
        {availableWindows.length > 1 ? (
          <SegmentedControl
            label="用量统计周期"
            size="sm"
            value={shownWindow}
            onChange={setActiveWindow}
            options={availableWindows.map((w) => ({
              value: w,
              label: WINDOW_LABELS[w],
            }))}
          />
        ) : (
          <span className="text-caption text-muted-foreground">
            {WINDOW_LABELS[shownWindow]}
          </span>
        )}
      </div>

      {/* Warning banner */}
      {access && !access.allowed && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-error/10 px-3 py-2 text-body text-error">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            {access.reason || '当前不可用，请联系管理员处理余额或套餐限制。'}
          </span>
        </div>
      )}
      {(!access ||
        access.allowed ||
        access.blockType !== 'insufficient_balance') &&
        maxPercent >= 80 && (
          <div
            className={cn(
              'mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-body',
              maxPercent >= 100
                ? 'bg-error/10 text-error'
                : 'bg-warning/10 text-warning',
            )}
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              {maxPercent >= 100
                ? '配额已用完，请联系管理员调整套餐或额度'
                : `配额已使用 ${Math.round(maxPercent)}%，即将达到上限`}
            </span>
          </div>
        )}

      {/* Active window content */}
      <div className="space-y-4">
        {shownWindow === 'daily' && (
          <WindowUsageBlock
            costUsed={dailyUsage?.costUsed ?? 0}
            costQuota={dailyUsage?.costQuota ?? plan?.daily_cost_quota ?? null}
            tokenUsed={dailyUsage?.tokenUsed ?? 0}
            tokenQuota={
              dailyUsage?.tokenQuota ?? plan?.daily_token_quota ?? null
            }
            fmt={fmt}
          />
        )}
        {shownWindow === 'weekly' && (
          <WindowUsageBlock
            costUsed={weeklyUsage?.costUsed ?? 0}
            costQuota={
              weeklyUsage?.costQuota ?? plan?.weekly_cost_quota ?? null
            }
            tokenUsed={weeklyUsage?.tokenUsed ?? 0}
            tokenQuota={
              weeklyUsage?.tokenQuota ?? plan?.weekly_token_quota ?? null
            }
            fmt={fmt}
          />
        )}
        {shownWindow === 'monthly' && (
          <WindowUsageBlock
            costUsed={
              monthlyUsage?.costUsed ?? currentUsage?.total_cost_usd ?? 0
            }
            costQuota={
              monthlyUsage?.costQuota ?? plan?.monthly_cost_quota ?? null
            }
            tokenUsed={
              monthlyUsage?.tokenUsed ??
              (currentUsage
                ? currentUsage.total_input_tokens +
                  currentUsage.total_output_tokens
                : 0)
            }
            tokenQuota={
              monthlyUsage?.tokenQuota ?? plan?.monthly_token_quota ?? null
            }
            fmt={fmt}
          />
        )}

        {/* Summary stats (always visible) */}
        <dl className="grid grid-cols-3 gap-2 border-t border-surface-border pt-3">
          <div className="min-w-0">
            <dt className="text-caption text-muted-foreground">本月费用</dt>
            <dd className="truncate text-body font-medium text-foreground tabular-nums">
              {fmt(currentUsage?.total_cost_usd ?? 0)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-muted-foreground">本月 Token</dt>
            <dd className="truncate text-body font-medium text-foreground tabular-nums">
              {formatTokens(
                (currentUsage?.total_input_tokens ?? 0) +
                  (currentUsage?.total_output_tokens ?? 0),
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-muted-foreground">消息数</dt>
            <dd className="truncate text-body font-medium text-foreground tabular-nums">
              {currentUsage?.message_count ?? 0}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
