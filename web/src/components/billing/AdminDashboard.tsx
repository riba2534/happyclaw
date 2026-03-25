import { useEffect } from 'react';
import { Users, CreditCard, TrendingUp, DollarSign } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency } from './utils';

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
        <Icon className="w-4 h-4 text-primary" />
        {label}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function PlanDistribution({
  data,
}: {
  data: Array<{ plan_name: string; count: number }>;
}) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1;

  return (
    <div className="bg-card rounded-lg border border-border p-5">
      <h3 className="font-semibold text-sm mb-4">套餐分布</h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据</p>
      ) : (
        <div className="space-y-3">
          {data.map((item) => {
            const pct = Math.round((item.count / total) * 100);
            return (
              <div key={item.plan_name}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{item.plan_name}</span>
                  <span className="text-muted-foreground">
                    {item.count} ({pct}%)
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-500 rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
    <div className="bg-card rounded-lg border border-border p-5">
      <h3 className="font-semibold text-sm mb-4">收入趋势</h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据</p>
      ) : (
        <div className="flex items-end gap-1 h-40">
          {data.map((item) => {
            const height = Math.max((item.revenue / maxRevenue) * 100, 2);
            const label = item.month.slice(5);
            return (
              <div
                key={item.month}
                className="flex-1 flex flex-col items-center gap-1 min-w-0"
              >
                <span className="text-[10px] text-muted-foreground truncate w-full text-center">
                  {fmt(item.revenue)}
                </span>
                <div
                  className="w-full bg-brand-500 rounded-t transition-all hover:bg-brand-400"
                  style={{ height: `${height}%` }}
                  title={`${item.month}: ${fmt(item.revenue)} / ${item.users} 用户`}
                />
                <span className="text-[10px] text-muted-foreground truncate w-full text-center">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
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

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
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
          value={String(dd?.blockedUsers ?? 0)}
          sub="余额不足或套餐限制"
        />
      </div>

      {/* Plan Distribution + Revenue Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PlanDistribution data={dd?.planDistribution ?? []} />
        <RevenueTrendChart data={revenueTrend} fmt={fmt} />
      </div>
    </div>
  );
}
