import { useEffect } from 'react';
import { Sparkles, Check, Zap, Clock, Layers } from 'lucide-react';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';

function PlanCard({ plan, isCurrent, fmt }: { plan: BillingPlan; isCurrent: boolean; fmt: (n: number) => string }) {
  const isHighlighted = plan.highlight;

  // Collect resource limits
  const resources: { label: string; value: string }[] = [];
  if (plan.max_groups != null) resources.push({ label: '工作区', value: `${plan.max_groups}` });
  if (plan.max_im_channels != null)
    resources.push({ label: 'IM 通道', value: `${plan.max_im_channels}` });
  if (plan.max_mcp_servers != null)
    resources.push({ label: 'MCP Server', value: `${plan.max_mcp_servers}` });
  if (plan.max_concurrent_containers != null)
    resources.push({ label: '并发容器', value: `${plan.max_concurrent_containers}` });
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
    quotas.push({ label: '月度 Token', value: formatTokens(plan.monthly_token_quota) });
  if (plan.weekly_token_quota != null)
    quotas.push({ label: '周度 Token', value: formatTokens(plan.weekly_token_quota) });
  if (plan.daily_token_quota != null)
    quotas.push({ label: '日度 Token', value: formatTokens(plan.daily_token_quota) });

  return (
    <div
      className={`relative rounded-lg border p-5 flex flex-col transition-shadow ${
        isHighlighted
          ? 'border-brand-500 dark:border-brand-400 shadow-[0_0_12px_rgba(249,115,22,0.25)] dark:shadow-[0_0_12px_rgba(251,146,60,0.2)]'
          : 'border-zinc-200 dark:border-zinc-700'
      } bg-white dark:bg-zinc-800`}
    >
      {/* Recommended badge */}
      {isHighlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center gap-1 px-3 py-0.5 text-xs font-medium rounded-full bg-brand-600 text-white">
            <Sparkles className="w-3 h-3" />
            推荐
          </span>
        </div>
      )}

      {/* Current plan badge */}
      {isCurrent && (
        <div className="absolute top-3 right-3">
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-300">
            当前
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-4">
        <h4 className="text-lg font-bold">{plan.name}</h4>
        {plan.display_price ? (
          <p className="text-xl font-bold text-primary dark:text-brand-400 mt-1">
            {plan.display_price}
          </p>
        ) : (
          <p className="text-xl font-bold text-primary dark:text-brand-400 mt-1">
            {plan.monthly_cost_usd === 0 ? '免费' : `${fmt(plan.monthly_cost_usd)}/月`}
          </p>
        )}
        {plan.description && (
          <p className="text-sm text-zinc-500 mt-1">{plan.description}</p>
        )}
      </div>

      {/* Rate multiplier */}
      {plan.rate_multiplier !== 1 && (
        <div className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400 mb-3">
          <Zap className="w-4 h-4" />
          <span>费率倍数: {plan.rate_multiplier}x</span>
        </div>
      )}

      {/* Trial days */}
      {plan.trial_days != null && plan.trial_days > 0 && (
        <div className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 mb-3">
          <Clock className="w-4 h-4" />
          <span>{plan.trial_days} 天免费试用</span>
        </div>
      )}

      {/* Features */}
      {plan.features.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {plan.features.map((feature, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <Check className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" />
              <span>{feature}</span>
            </div>
          ))}
        </div>
      )}

      {/* Quotas */}
      {quotas.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
            <Layers className="w-3.5 h-3.5" />
            配额
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {quotas.map((q) => (
              <div key={q.label} className="flex justify-between">
                <span className="text-zinc-500">{q.label}</span>
                <span className="font-medium">{q.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resources */}
      {resources.length > 0 && (
        <div className="mt-auto pt-3 border-t border-zinc-100 dark:border-zinc-700">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {resources.map((r) => (
              <div key={r.label} className="flex justify-between">
                <span className="text-zinc-400">{r.label}</span>
                <span className="text-zinc-600 dark:text-zinc-300">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PricingGrid() {
  const { plans, plan: currentPlan, loadPlans, loadMySubscription } = useBillingStore();
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
      <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-8 text-center">
        <Sparkles className="w-8 h-8 text-zinc-300 mx-auto mb-3" />
        <p className="text-sm text-zinc-500">暂无可用套餐</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
