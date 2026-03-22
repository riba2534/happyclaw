import { useEffect } from 'react';
import { Package, Plus, Pencil, Trash2, Star, Zap } from 'lucide-react';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';
import { Button } from '@/components/ui/button';

interface AdminPlansListProps {
  onEditPlan: (plan: BillingPlan) => void;
  onCreatePlan: () => void;
}

export default function AdminPlansList({
  onEditPlan,
  onCreatePlan,
}: AdminPlansListProps) {
  const { plans, loadAllPlans, deletePlan } = useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadAllPlans();
  }, [loadAllPlans]);

  const handleDelete = async (plan: BillingPlan) => {
    if (plan.is_default) return;
    const sub = (plan as BillingPlan & { subscriber_count?: number }).subscriber_count;
    const msg = sub
      ? `套餐「${plan.name}」下还有 ${sub} 个订阅用户，确定删除？`
      : `确定删除套餐「${plan.name}」？`;
    if (!confirm(msg)) return;
    await deletePlan(plan.id);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <Package className="w-5 h-5 text-primary" />
          套餐管理
        </h3>
        <Button size="sm" onClick={onCreatePlan}>
          <Plus className="w-4 h-4" />
          新建套餐
        </Button>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const sub = (plan as BillingPlan & { subscriber_count?: number })
            .subscriber_count;
          return (
            <div
              key={plan.id}
              className={`relative bg-white dark:bg-zinc-800 rounded-lg border p-5 ${
                plan.highlight
                  ? 'border-brand-400 dark:border-brand-600 ring-1 ring-brand-400/30'
                  : 'border-zinc-200 dark:border-zinc-700'
              } ${!plan.is_active ? 'opacity-60' : ''}`}
            >
              {/* Badges */}
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                {plan.is_default && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-full bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-300">
                    <Star className="w-3 h-3" />
                    默认
                  </span>
                )}
                {plan.highlight && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    <Zap className="w-3 h-3" />
                    推荐
                  </span>
                )}
                {!plan.is_active && (
                  <span className="px-1.5 py-0.5 text-xs rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                    已禁用
                  </span>
                )}
              </div>

              {/* Name + price */}
              <div className="text-lg font-bold mb-0.5">{plan.name}</div>
              <div className="text-sm text-zinc-500 mb-3">
                {plan.display_price ?? fmt(plan.monthly_cost_usd) + '/月'}
              </div>

              {/* Meta */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span>ID: {plan.id}</span>
                <span>Tier: {plan.tier}</span>
                <span>排序: {plan.sort_order}</span>
                <span>费率: {plan.rate_multiplier}x</span>
                {plan.trial_days != null && (
                  <span>试用: {plan.trial_days} 天</span>
                )}
                {sub != null && <span>订阅者: {sub}</span>}
              </div>

              {/* Quotas */}
              <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700 grid grid-cols-2 gap-1 text-xs text-zinc-500">
                {plan.daily_cost_quota != null && (
                  <span>日费用: {fmt(plan.daily_cost_quota)}</span>
                )}
                {plan.daily_token_quota != null && (
                  <span>日Token: {formatTokens(plan.daily_token_quota)}</span>
                )}
                {plan.weekly_cost_quota != null && (
                  <span>周费用: {fmt(plan.weekly_cost_quota)}</span>
                )}
                {plan.weekly_token_quota != null && (
                  <span>周Token: {formatTokens(plan.weekly_token_quota)}</span>
                )}
                {plan.monthly_cost_quota != null && (
                  <span>月费用: {fmt(plan.monthly_cost_quota)}</span>
                )}
                {plan.monthly_token_quota != null && (
                  <span>月Token: {formatTokens(plan.monthly_token_quota)}</span>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-1 mt-4">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onEditPlan(plan)}
                >
                  <Pencil className="w-3 h-3" />
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={plan.is_default}
                  onClick={() => handleDelete(plan)}
                  className="text-zinc-400 hover:text-red-500"
                >
                  <Trash2 className="w-3 h-3" />
                  删除
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {plans.length === 0 && (
        <p className="text-sm text-zinc-500 text-center py-8">
          暂无套餐，点击「新建套餐」创建
        </p>
      )}
    </div>
  );
}
