import { useEffect } from 'react';
import { Sparkles, Check, Zap, Clock, Layers } from 'lucide-react';
import { EmptyState } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';

function PlanCard({
  plan,
  isCurrent,
  fmt,
}: {
  plan: BillingPlan;
  isCurrent: boolean;
  fmt: (n: number) => string;
}) {
  const isRecommended = plan.highlight;

  // Collect resource limits
  const resources: { label: string; value: string }[] = [];
  if (plan.max_groups != null)
    resources.push({ label: '工作区', value: `${plan.max_groups}` });
  if (plan.max_im_channels != null)
    resources.push({ label: 'IM 通道', value: `${plan.max_im_channels}` });
  if (plan.max_mcp_servers != null)
    resources.push({ label: 'MCP Server', value: `${plan.max_mcp_servers}` });
  if (plan.max_concurrent_containers != null)
    resources.push({
      label: '并发容器',
      value: `${plan.max_concurrent_containers}`,
    });
  if (plan.max_storage_mb != null)
    resources.push({ label: '存储', value: `${plan.max_storage_mb} MB` });

  // Collect quotas
  const quotas: { label: string; value: string }[] = [];
  if (plan.monthly_cost_quota != null)
    quotas.push({ label: '月度费用', value: fmt(plan.monthly_cost_quota) });
  if (plan.weekly_cost_quota != null)
    quotas.push({ label: '周度费用', value: fmt(plan.weekly_cost_quota) });
  if (plan.daily_cost_quota != null)
    quotas.push({ label: '日度费用', value: fmt(plan.daily_cost_quota) });
  if (plan.monthly_token_quota != null)
    quotas.push({
      label: '月度 Token',
      value: formatTokens(plan.monthly_token_quota),
    });
  if (plan.weekly_token_quota != null)
    quotas.push({
      label: '周度 Token',
      value: formatTokens(plan.weekly_token_quota),
    });
  if (plan.daily_token_quota != null)
    quotas.push({
      label: '日度 Token',
      value: formatTokens(plan.daily_token_quota),
    });

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl bg-surface-raised p-4 sm:p-5',
        // Only the plan the user is on gets the accent ring; "recommended"
        // stays a quiet badge so the two states never look alike.
        isCurrent ? 'ring-2 ring-primary' : 'ring-1 ring-surface-border',
      )}
    >
      {/* Header */}
      <div className="mb-4">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="truncate text-title text-foreground">{plan.name}</h4>
          {isRecommended && (
            <Badge variant="outline">
              <Sparkles />
              推荐
            </Badge>
          )}
          {isCurrent && (
            <Badge variant="info" className="ml-auto">
              当前
            </Badge>
          )}
        </div>
        <p className="mt-2 text-display-sm text-foreground tabular-nums">
          {plan.display_price
            ? plan.display_price
            : plan.monthly_cost_usd === 0
              ? '免费'
              : `${fmt(plan.monthly_cost_usd)}/月`}
        </p>
        {plan.description && (
          <p className="mt-1 text-caption text-muted-foreground">
            {plan.description}
          </p>
        )}
      </div>

      {/* Rate multiplier / trial days */}
      {(plan.rate_multiplier !== 1 ||
        (plan.trial_days != null && plan.trial_days > 0)) && (
        <div className="mb-4 space-y-1.5">
          {plan.rate_multiplier !== 1 && (
            <div className="flex items-center gap-1.5 text-body text-foreground">
              <Zap className="size-4 text-muted-foreground" />
              <span>费率倍数: {plan.rate_multiplier}x</span>
            </div>
          )}
          {plan.trial_days != null && plan.trial_days > 0 && (
            <div className="flex items-center gap-1.5 text-body text-foreground">
              <Clock className="size-4 text-muted-foreground" />
              <span>{plan.trial_days} 天免费试用</span>
            </div>
          )}
        </div>
      )}

      {/* Features */}
      {plan.features.length > 0 && (
        <ul className="mb-4 space-y-1.5">
          {plan.features.map((feature, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-body text-foreground"
            >
              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Quotas */}
      {quotas.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
            <Layers className="size-3.5" />
            配额
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-body">
            {quotas.map((q) => (
              <div key={q.label} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{q.label}</span>
                <span className="font-medium text-foreground tabular-nums">
                  {q.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resources */}
      {resources.length > 0 && (
        <div className="mt-auto border-t border-surface-border pt-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-body">
            {resources.map((r) => (
              <div key={r.label} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="text-foreground tabular-nums">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PricingGrid() {
  const {
    plans,
    plan: currentPlan,
    loadPlans,
    loadMySubscription,
  } = useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadPlans();
    loadMySubscription();
  }, [loadPlans, loadMySubscription]);

  const activePlans = plans
    .filter((p) => p.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.tier - b.tier);

  if (activePlans.length === 0) {
    return (
      <div className="rounded-xl bg-surface-raised ring-1 ring-surface-border">
        <EmptyState icon={Sparkles} title="暂无可用套餐" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {activePlans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          isCurrent={currentPlan?.id === plan.id}
          fmt={fmt}
        />
      ))}
    </div>
  );
}
