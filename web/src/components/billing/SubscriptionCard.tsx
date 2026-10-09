import { useEffect } from 'react';
import { Package, Zap, Clock, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
    subscription?.trial_ends_at &&
    new Date(subscription.trial_ends_at) > new Date();
  const isCancelled = subscription?.status === 'cancelled';
  const isExpired = subscription?.status === 'expired';
  const isFallback = subscription?.id.startsWith('fallback_');

  const quotas: { label: string; value: string | number }[] = [];
  if (plan?.monthly_cost_quota != null)
    quotas.push({ label: '月度费用上限', value: fmt(plan.monthly_cost_quota) });
  if (plan?.monthly_token_quota != null)
    quotas.push({
      label: '月度 Token 上限',
      value: formatTokens(plan.monthly_token_quota),
    });
  if (plan?.daily_cost_quota != null)
    quotas.push({ label: '日度费用上限', value: fmt(plan.daily_cost_quota) });
  if (plan?.weekly_cost_quota != null)
    quotas.push({ label: '周度费用上限', value: fmt(plan.weekly_cost_quota) });
  if (plan?.max_groups != null)
    quotas.push({ label: '工作区上限', value: plan.max_groups });
  if (plan?.max_im_channels != null)
    quotas.push({ label: 'IM 通道上限', value: plan.max_im_channels });

  return (
    <section className="flex flex-col rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border sm:p-5">
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <Package className="size-4 text-muted-foreground" />
        <h3 className="text-title-sm text-foreground">当前套餐</h3>
      </div>

      {plan ? (
        <div className="flex flex-1 flex-col">
          {/* Plan name + badges */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-title-lg text-foreground">
              {plan.name}
            </span>
            {isFallback && <Badge variant="neutral">默认</Badge>}
            {isCancelled && <Badge variant="error">已取消</Badge>}
            {isExpired && <Badge variant="neutral">已过期</Badge>}
            {isTrialing && (
              <Badge variant="neutral">
                <Clock />
                试用中
              </Badge>
            )}
          </div>

          {/* Display price */}
          {plan.display_price && (
            <p className="mt-1 text-body font-medium text-foreground tabular-nums">
              {plan.display_price}
            </p>
          )}

          {plan.description && (
            <p className="mt-1 text-caption text-muted-foreground">
              {plan.description}
            </p>
          )}

          {/* Rate multiplier */}
          {plan.rate_multiplier !== 1 && (
            <div className="mt-3 flex items-center gap-1.5 text-body text-foreground">
              <Zap className="size-4 text-muted-foreground" />
              <span>费率倍数: {plan.rate_multiplier}x</span>
            </div>
          )}

          {/* Quota grid */}
          {quotas.length > 0 && (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
              {quotas.map((quota) => (
                <div key={quota.label} className="min-w-0">
                  <dt className="text-caption text-muted-foreground">
                    {quota.label}
                  </dt>
                  <dd className="text-body font-medium text-foreground tabular-nums">
                    {quota.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Trial / expiry info */}
          <div className="mt-4 space-y-1">
            {isTrialing && subscription?.trial_ends_at && (
              <p className="flex items-center gap-1 text-caption text-muted-foreground">
                <Star className="size-3" />
                试用截止:{' '}
                {new Date(subscription.trial_ends_at).toLocaleDateString()}
              </p>
            )}
            {subscription?.expires_at && (
              <p className="text-caption text-muted-foreground">
                到期时间:{' '}
                {new Date(subscription.expires_at).toLocaleDateString()}
              </p>
            )}
            <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
              <p className="text-caption leading-5 text-muted-foreground">
                钱包优先模式下，套餐决定费率和资源上限；是否可以继续使用，取决于当前余额是否达到{' '}
                {fmt(access?.minBalanceUsd ?? billingMinStartBalanceUsd)}。
              </p>
              {!access?.allowed && (
                <p className="text-caption text-error">
                  {access?.reason || '当前不可用，请联系管理员处理。'}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">未订阅任何套餐</p>
      )}
    </section>
  );
}
