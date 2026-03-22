import { useEffect } from 'react';
import { Package, Zap, Clock, Star } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';

export default function SubscriptionCard() {
  const {
    subscription,
    plan,
    access,
    billingMinStartBalanceUsd,
    loadMySubscription,
    loadMyAccess,
  } = useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadMySubscription();
    loadMyAccess();
  }, [loadMyAccess, loadMySubscription]);

  const isTrialing =
    subscription?.trial_ends_at && new Date(subscription.trial_ends_at) > new Date();
  const isCancelled = subscription?.status === 'cancelled';
  const isExpired = subscription?.status === 'expired';
  const isFallback = subscription?.id.startsWith('fallback_');

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Package className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">当前套餐</h3>
      </div>

      {plan ? (
        <div>
          {/* Plan name + badges */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl font-bold text-primary">{plan.name}</span>
            {isFallback && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                默认
              </span>
            )}
            {isCancelled && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                已取消
              </span>
            )}
            {isExpired && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                已过期
              </span>
            )}
            {isTrialing && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                <Clock className="w-3 h-3" />
                试用中
              </span>
            )}
          </div>

          {/* Display price */}
          {plan.display_price && (
            <p className="text-sm text-brand-700 dark:text-brand-400 font-medium mb-1">
              {plan.display_price}
            </p>
          )}

          {plan.description && (
            <p className="text-sm text-zinc-500 mb-3">{plan.description}</p>
          )}

          {/* Rate multiplier */}
          {plan.rate_multiplier !== 1 && (
            <div className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400 mb-3">
              <Zap className="w-4 h-4" />
              <span>费率倍数: {plan.rate_multiplier}x</span>
            </div>
          )}

          {/* Quota grid */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {plan.monthly_cost_quota != null && (
              <div>
                <span className="text-zinc-500">月度费用上限</span>
                <div className="font-medium">{fmt(plan.monthly_cost_quota)}</div>
              </div>
            )}
            {plan.monthly_token_quota != null && (
              <div>
                <span className="text-zinc-500">月度 Token 上限</span>
                <div className="font-medium">{formatTokens(plan.monthly_token_quota)}</div>
              </div>
            )}
            {plan.daily_cost_quota != null && (
              <div>
                <span className="text-zinc-500">日度费用上限</span>
                <div className="font-medium">{fmt(plan.daily_cost_quota)}</div>
              </div>
            )}
            {plan.weekly_cost_quota != null && (
              <div>
                <span className="text-zinc-500">周度费用上限</span>
                <div className="font-medium">{fmt(plan.weekly_cost_quota)}</div>
              </div>
            )}
            {plan.max_groups != null && (
              <div>
                <span className="text-zinc-500">工作区上限</span>
                <div className="font-medium">{plan.max_groups}</div>
              </div>
            )}
            {plan.max_im_channels != null && (
              <div>
                <span className="text-zinc-500">IM 通道上限</span>
                <div className="font-medium">{plan.max_im_channels}</div>
              </div>
            )}
          </div>

          {/* Trial / expiry info */}
          <div className="mt-3 space-y-1">
            {isTrialing && subscription?.trial_ends_at && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <Star className="w-3 h-3" />
                试用截止: {new Date(subscription.trial_ends_at).toLocaleDateString()}
              </p>
            )}
            {subscription?.expires_at && (
              <p className="text-xs text-zinc-400">
                到期时间: {new Date(subscription.expires_at).toLocaleDateString()}
              </p>
            )}
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-700 mt-2 space-y-2">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                钱包优先模式下，套餐决定费率和资源上限；是否可以继续使用，取决于当前余额是否达到 {fmt(access?.minBalanceUsd ?? billingMinStartBalanceUsd)}。
              </p>
              {!access?.allowed && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {access?.reason || '当前不可用，请联系管理员处理。'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-zinc-500">未订阅任何套餐</p>
      )}
    </div>
  );
}
