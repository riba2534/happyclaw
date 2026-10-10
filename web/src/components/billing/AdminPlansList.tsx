import { useEffect } from 'react';
import { Package, Plus, Pencil, Trash2, Star, Zap } from 'lucide-react';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DataTable,
  EmptyState,
  IconButton,
  type DataTableColumn,
} from '@/components/common';
import { SettingsSection } from '@/components/settings/SettingsLayout';
import { confirmDialog } from '@/stores/confirm';

interface AdminPlansListProps {
  onEditPlan: (plan: BillingPlan) => void;
  onCreatePlan: () => void;
}

type PlanRow = BillingPlan & { subscriber_count?: number };

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
    const sub = (plan as PlanRow).subscriber_count;
    const msg = sub
      ? `套餐「${plan.name}」下还有 ${sub} 个订阅用户，确定删除？`
      : `确定删除套餐「${plan.name}」？`;
    const confirmed = await confirmDialog({
      title: '删除套餐',
      message: msg,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    await deletePlan(plan.id);
  };

  const quotaLines = (plan: BillingPlan) =>
    [
      plan.daily_cost_quota != null && `日费用: ${fmt(plan.daily_cost_quota)}`,
      plan.daily_token_quota != null &&
        `日Token: ${formatTokens(plan.daily_token_quota)}`,
      plan.weekly_cost_quota != null &&
        `周费用: ${fmt(plan.weekly_cost_quota)}`,
      plan.weekly_token_quota != null &&
        `周Token: ${formatTokens(plan.weekly_token_quota)}`,
      plan.monthly_cost_quota != null &&
        `月费用: ${fmt(plan.monthly_cost_quota)}`,
      plan.monthly_token_quota != null &&
        `月Token: ${formatTokens(plan.monthly_token_quota)}`,
    ].filter((line): line is string => !!line);

  const columns: DataTableColumn<PlanRow>[] = [
    {
      key: 'plan',
      header: '套餐',
      className: 'whitespace-normal sm:min-w-56',
      cell: (plan) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{plan.name}</span>
            {plan.is_default && (
              <Badge variant="neutral">
                <Star />
                默认
              </Badge>
            )}
            {plan.highlight && (
              <Badge variant="info">
                <Zap />
                推荐
              </Badge>
            )}
            {!plan.is_active && (
              <Badge variant="outline" dot="muted">
                已禁用
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-caption text-muted-foreground">
            ID: {plan.id} · Tier: {plan.tier} · 排序: {plan.sort_order}
          </div>
        </div>
      ),
    },
    {
      key: 'price',
      header: '价格',
      cell: (plan) => (
        <span className="tabular-nums text-foreground">
          {plan.display_price ?? fmt(plan.monthly_cost_usd) + '/月'}
        </span>
      ),
    },
    {
      key: 'rate',
      header: '费率',
      align: 'right',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (plan) => (
        <span className="tabular-nums">{plan.rate_multiplier}x</span>
      ),
    },
    {
      key: 'quota',
      header: '配额',
      className: 'hidden whitespace-normal md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (plan) => {
        const lines = quotaLines(plan);
        return lines.length === 0 ? (
          <span className="text-faint-foreground">—</span>
        ) : (
          <div className="grid min-w-44 grid-cols-2 gap-x-3 gap-y-0.5 text-caption tabular-nums text-muted-foreground">
            {lines.map((line) => (
              <span key={line} className="whitespace-nowrap">
                {line}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'trial',
      header: '试用',
      align: 'right',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (plan) =>
        plan.trial_days != null ? (
          <span className="tabular-nums">{plan.trial_days} 天</span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'subscribers',
      header: '订阅者',
      align: 'right',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (plan) =>
        plan.subscriber_count != null ? (
          <span className="tabular-nums">{plan.subscriber_count}</span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      cell: (plan) => (
        <div
          className="flex items-center justify-end gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          <IconButton
            label="编辑"
            icon={<Pencil />}
            onClick={() => onEditPlan(plan)}
            className="text-muted-foreground"
          />
          <IconButton
            label="删除"
            icon={<Trash2 />}
            disabled={plan.is_default}
            onClick={() => void handleDelete(plan)}
            className="text-muted-foreground hover:text-error"
          />
        </div>
      ),
    },
  ];

  return (
    <SettingsSection
      title="套餐管理"
      actions={
        <Button onClick={onCreatePlan}>
          <Plus />
          新建套餐
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={plans as PlanRow[]}
        rowKey={(plan) => plan.id}
        onRowClick={onEditPlan}
        rowClassName={(plan) => (plan.is_active ? undefined : 'opacity-60')}
        empty={
          <EmptyState icon={Package} title="暂无套餐，点击「新建套餐」创建" />
        }
      />
    </SettingsSection>
  );
}
