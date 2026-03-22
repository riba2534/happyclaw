import { useEffect, useState } from 'react';
import { BarChart3, AlertTriangle } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';

type WindowKey = 'daily' | 'weekly' | 'monthly';

const WINDOW_LABELS: Record<WindowKey, string> = {
  daily: '日度',
  weekly: '周度',
  monthly: '月度',
};

function ProgressBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-brand-500';
  return (
    <div className={`h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden ${className ?? ''}`}>
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function WindowUsageBlock({
  label,
  costUsed,
  costQuota,
  tokenUsed,
  tokenQuota,
  fmt,
}: {
  label: string;
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
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</h4>
      {hasCostQuota && (
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-zinc-500">费用</span>
            <span>
              {fmt(costUsed)} / {fmt(costQuota!)}
            </span>
          </div>
          <ProgressBar value={costUsed} max={costQuota!} />
        </div>
      )}
      {hasTokenQuota && (
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-zinc-500">Token</span>
            <span>
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

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">用量</h3>
        </div>
        {/* Window tabs */}
        {availableWindows.length > 1 && (
          <div className="flex gap-1">
            {availableWindows.map((w) => (
              <button
                key={w}
                onClick={() => setActiveWindow(w)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  activeWindow === w
                    ? 'bg-brand-100 dark:bg-brand-700/30 text-brand-700 dark:text-brand-300'
                    : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
                }`}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Warning banner */}
      {access && !access.allowed && (
        <div className="flex items-center gap-2 text-sm mb-3 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{access.reason || '当前不可用，请联系管理员处理余额或套餐限制。'}</span>
        </div>
      )}
      {(!access || access.allowed || access.blockType !== 'insufficient_balance') && maxPercent >= 80 && (
        <div
          className={`flex items-center gap-2 text-sm mb-3 px-3 py-2 rounded-md ${
            maxPercent >= 100
              ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
              : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400'
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {maxPercent >= 100
              ? '配额已用完，请联系管理员调整套餐或额度'
              : `配额已使用 ${Math.round(maxPercent)}%，即将达到上限`}
          </span>
        </div>
      )}

      {/* Active window content */}
      <div className="space-y-4">
        {activeWindow === 'daily' && (
          <WindowUsageBlock
            label={WINDOW_LABELS.daily}
            costUsed={dailyUsage?.costUsed ?? 0}
            costQuota={dailyUsage?.costQuota ?? plan?.daily_cost_quota ?? null}
            tokenUsed={dailyUsage?.tokenUsed ?? 0}
            tokenQuota={dailyUsage?.tokenQuota ?? plan?.daily_token_quota ?? null}
            fmt={fmt}
          />
        )}
        {activeWindow === 'weekly' && (
          <WindowUsageBlock
            label={WINDOW_LABELS.weekly}
            costUsed={weeklyUsage?.costUsed ?? 0}
            costQuota={weeklyUsage?.costQuota ?? plan?.weekly_cost_quota ?? null}
            tokenUsed={weeklyUsage?.tokenUsed ?? 0}
            tokenQuota={weeklyUsage?.tokenQuota ?? plan?.weekly_token_quota ?? null}
            fmt={fmt}
          />
        )}
        {activeWindow === 'monthly' && (
          <WindowUsageBlock
            label={WINDOW_LABELS.monthly}
            costUsed={monthlyUsage?.costUsed ?? currentUsage?.total_cost_usd ?? 0}
            costQuota={monthlyUsage?.costQuota ?? plan?.monthly_cost_quota ?? null}
            tokenUsed={
              monthlyUsage?.tokenUsed ??
              (currentUsage
                ? currentUsage.total_input_tokens + currentUsage.total_output_tokens
                : 0)
            }
            tokenQuota={monthlyUsage?.tokenQuota ?? plan?.monthly_token_quota ?? null}
            fmt={fmt}
          />
        )}

        {/* Summary stats (always visible) */}
        <div className="grid grid-cols-2 gap-2 text-sm text-zinc-500">
          <div>
            <span className="block text-xs text-zinc-400">本月费用</span>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {fmt(currentUsage?.total_cost_usd ?? 0)}
            </span>
          </div>
          <div>
            <span className="block text-xs text-zinc-400">本月 Token</span>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {formatTokens(
                (currentUsage?.total_input_tokens ?? 0) +
                  (currentUsage?.total_output_tokens ?? 0),
              )}
            </span>
          </div>
          <div>
            <span className="block text-xs text-zinc-400">消息数</span>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {currentUsage?.message_count ?? 0}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
