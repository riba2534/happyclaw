import { useEffect, type ReactNode } from 'react';
import { Users, CreditCard, TrendingUp, DollarSign } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency } from './utils';
import { cn } from '@/lib/utils';

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  className,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub?: string;
  tone?: 'error';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Icon className="size-3.5 shrink-0 text-faint-foreground" />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          'mt-1 truncate text-display-sm tabular-nums text-foreground',
          tone === 'error' && 'text-error',
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 truncate text-caption text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border sm:p-5">
      <h3 className="mb-4 text-title-sm text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function PlanDistribution({
  data,
}: {
  data: Array<{ plan_name: string; count: number }>;
}) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1;

  return (
    <ChartCard title="套餐分布">
      {data.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          暂无数据
        </p>
      ) : (
        <div className="space-y-3.5">
          {data.map((item) => {
            const pct = Math.round((item.count / total) * 100);
            return (
              <div key={item.plan_name}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3 text-body">
                  <span className="truncate text-foreground">
                    {item.plan_name}
                  </span>
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                    {item.count} ({pct}%)
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-selected">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

function RevenueTrendChart({
  data,
  fmt,
}: {
  data: Array<{ month: string; revenue: number; users: number }>;
  fmt: (v: number) => string;
}) {
  const maxRevenue = Math.max(...data.map((d) => d.revenue), 1);

  return (
    <ChartCard title="收入趋势">
      {data.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          暂无数据
        </p>
      ) : (
        <div className="flex h-44 items-end gap-1.5">
          {data.map((item) => {
            const height = Math.max((item.revenue / maxRevenue) * 100, 2);
            const label = item.month.slice(5);
            return (
              <div
                key={item.month}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              >
                <span className="w-full truncate text-center text-micro tabular-nums text-muted-foreground">
                  {fmt(item.revenue)}
                </span>
                <div className="flex w-full flex-1 items-end border-b border-surface-border">
                  <div
                    className="w-full rounded-t-sm bg-primary/80 transition-colors hover:bg-primary"
                    style={{ height: `${height}%` }}
                    title={`${item.month}: ${fmt(item.revenue)} / ${item.users} 用户`}
                  />
                </div>
                <span className="w-full truncate text-center text-micro tabular-nums text-muted-foreground">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

export default function AdminDashboard() {
  const { dashboardData, revenueTrend, loadDashboard, loadRevenueTrend } =
    useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadDashboard();
    loadRevenueTrend();
  }, [loadDashboard, loadRevenueTrend]);

  const dd = dashboardData;
  const blockedUsers = dd?.blockedUsers ?? 0;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          icon={Users}
          label="活跃用户"
          value={`${dd?.activeUsers ?? 0} / ${dd?.totalUsers ?? 0}`}
          sub="活跃 / 总用户"
        />
        <KpiCard
          icon={CreditCard}
          label="活跃订阅"
          value={String(dd?.activeSubscriptions ?? 0)}
        />
        <KpiCard
          icon={DollarSign}
          label="今日费用"
          value={fmt(dd?.todayCost ?? 0)}
        />
        <KpiCard
          icon={TrendingUp}
          label="本月费用"
          value={fmt(dd?.monthCost ?? 0)}
        />
        <KpiCard
          icon={Users}
          label="已阻断用户"
          value={String(blockedUsers)}
          sub="余额不足或套餐限制"
          tone={blockedUsers > 0 ? 'error' : undefined}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {/* Plan Distribution + Revenue Trend */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlanDistribution data={dd?.planDistribution ?? []} />
        <RevenueTrendChart data={revenueTrend} fmt={fmt} />
      </div>
    </div>
  );
}
