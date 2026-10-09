import { useEffect, useState, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  Package,
  Wallet,
  XCircle,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import {
  useBillingStore,
  type UserBillingOverview,
  type BalanceTransaction,
  type SubscriptionHistoryItem,
} from '../../stores/billing';
import { useCurrency } from './utils';
import { ProgressBar } from './ProgressBar';
import { api } from '../../api/client';
import { confirmDialog } from '@/stores/confirm';
import { cn } from '@/lib/utils';

const TX_SOURCE_LABELS: Record<string, string> = {
  admin_manual_recharge: '后台充值',
  admin_manual_deduct: '后台扣减',
  usage_charge: '用量扣费',
  redeem_code: '兑换码',
  migration_opening: '初始化',
  refund: '退款',
};

interface UserBillingDrawerProps {
  userId: string | null;
  onClose: () => void;
}

interface UserDetail extends UserBillingOverview {
  subscription_status?: string;
  is_fallback?: boolean;
  has_real_subscription?: boolean;
  daily_cost_used?: number;
  daily_cost_quota?: number | null;
  weekly_cost_used?: number;
  weekly_cost_quota?: number | null;
  monthly_cost_quota?: number | null;
}

function UsageMeter({
  label,
  used,
  quota,
  fmt,
}: {
  label: string;
  used: number;
  quota: number;
  fmt: (v: number) => string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex justify-between gap-3 text-caption">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">
          {fmt(used)} / {fmt(quota)}
        </span>
      </div>
      <ProgressBar value={used} max={quota} />
    </div>
  );
}

export default function UserBillingDrawer({
  userId,
  onClose,
}: UserBillingDrawerProps) {
  const {
    plans,
    assignPlan,
    adjustBalance,
    cancelUserSubscription,
    getUserSubscriptionHistory,
  } = useBillingStore();
  const fmt = useCurrency();

  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [transactions, setTransactions] = useState<BalanceTransaction[]>([]);
  const [subHistory, setSubHistory] = useState<SubscriptionHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Assign plan form
  const [assignPlanId, setAssignPlanId] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Adjust balance form
  const [adjAmount, setAdjAmount] = useState('');
  const [adjDesc, setAdjDesc] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  const loadDetail = useCallback(
    async (uid: string) => {
      setLoading(true);
      try {
        const [d, tx] = await Promise.all([
          api.get<UserDetail>(`/api/billing/admin/users/${uid}/detail`),
          api.get<{ transactions: BalanceTransaction[] }>(
            `/api/billing/admin/users/${uid}/transactions?limit=20`,
          ),
        ]);
        setDetail(d);
        setTransactions(tx.transactions);
        const hist = await getUserSubscriptionHistory(uid);
        setSubHistory(hist);
      } catch {
        setDetail(null);
        setTransactions([]);
        setSubHistory([]);
      } finally {
        setLoading(false);
      }
    },
    [getUserSubscriptionHistory],
  );

  useEffect(() => {
    if (userId) {
      loadDetail(userId);
      setAssignPlanId('');
      setAdjAmount('');
      setAdjDesc('');
    }
  }, [userId, loadDetail]);

  const handleAssign = async () => {
    if (!userId || !assignPlanId) return;
    setAssigning(true);
    try {
      await assignPlan(userId, assignPlanId);
      await loadDetail(userId);
      setAssignPlanId('');
    } finally {
      setAssigning(false);
    }
  };

  const handleAdjust = async () => {
    if (!userId) return;
    const amount = parseFloat(adjAmount);
    if (isNaN(amount) || amount === 0 || !adjDesc.trim()) return;
    setAdjusting(true);
    try {
      await adjustBalance(userId, amount, adjDesc.trim());
      await loadDetail(userId);
      setAdjAmount('');
      setAdjDesc('');
    } finally {
      setAdjusting(false);
    }
  };

  const handleCancelSub = async () => {
    if (!userId) return;
    const confirmed = await confirmDialog({
      title: '撤销订阅',
      message: '确定撤销该用户的订阅？',
      confirmText: '撤销订阅',
      variant: 'danger',
    });
    if (!confirmed) return;
    await cancelUserSubscription(userId);
    await loadDetail(userId);
  };

  const hasQuota =
    !!detail &&
    (detail.daily_cost_quota != null ||
      detail.weekly_cost_quota != null ||
      detail.monthly_cost_quota != null);

  return (
    <Sheet open={!!userId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b border-surface-border pr-12">
          <SheetTitle className="truncate text-title">
            {detail
              ? `${detail.display_name || detail.username} 的账单`
              : '用户详情'}
          </SheetTitle>
          <SheetDescription className="truncate text-caption">
            {detail ? `@${detail.username}` : '用户账单详情'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : !detail ? (
            <p className="p-4 text-body text-muted-foreground">
              无法加载用户信息
            </p>
          ) : (
            <div className="space-y-6 p-4">
              {/* Current plan + balance */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0 rounded-xl p-4 ring-1 ring-surface-border">
                    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
                      <Package className="size-3.5 text-faint-foreground" />
                      当前套餐
                    </div>
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-title text-foreground">
                        {detail.plan_name || '无套餐'}
                      </span>
                      {detail.is_fallback && (
                        <Badge variant="neutral">默认</Badge>
                      )}
                    </div>
                    {detail.subscription_status &&
                      detail.subscription_status !== 'default' && (
                        <div className="mt-1 text-caption text-muted-foreground">
                          状态: {detail.subscription_status}
                        </div>
                      )}
                    {/* Cancel subscription — only for real subscriptions, not fallback */}
                    {detail.has_real_subscription && (
                      <Button
                        variant="destructive"
                        size="xs"
                        className="mt-2"
                        onClick={handleCancelSub}
                      >
                        <XCircle />
                        撤销订阅
                      </Button>
                    )}
                  </div>
                  <div className="min-w-0 rounded-xl p-4 ring-1 ring-surface-border">
                    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
                      <Wallet className="size-3.5 text-faint-foreground" />
                      余额
                    </div>
                    <div className="mt-1 truncate text-display-sm tabular-nums text-foreground">
                      {fmt(detail.balance_usd)}
                    </div>
                  </div>
                </div>
                <div
                  className={cn(
                    'rounded-lg px-3 py-2 text-caption',
                    detail.access_allowed
                      ? 'bg-success/10 text-success'
                      : 'bg-error/10 text-error',
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {detail.access_allowed ? (
                      <ShieldCheck className="size-3.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="size-3.5 shrink-0" />
                    )}
                    <span>
                      {detail.access_allowed
                        ? '当前可用'
                        : detail.access_reason || '当前被计费阻断'}
                    </span>
                  </div>
                  <p className="mt-0.5 opacity-80">
                    最低起用余额 {fmt(detail.min_balance_usd ?? 0)}
                  </p>
                </div>
              </div>

              {/* Usage progress (3 windows) */}
              {hasQuota && (
                <SettingsSection title="用量进度">
                  <SettingsGroup>
                    {detail.daily_cost_quota != null && (
                      <UsageMeter
                        label="日度费用"
                        used={detail.daily_cost_used ?? 0}
                        quota={detail.daily_cost_quota}
                        fmt={fmt}
                      />
                    )}
                    {detail.weekly_cost_quota != null && (
                      <UsageMeter
                        label="周度费用"
                        used={detail.weekly_cost_used ?? 0}
                        quota={detail.weekly_cost_quota}
                        fmt={fmt}
                      />
                    )}
                    {detail.monthly_cost_quota != null && (
                      <UsageMeter
                        label="月度费用"
                        used={detail.current_month_cost}
                        quota={detail.monthly_cost_quota}
                        fmt={fmt}
                      />
                    )}
                  </SettingsGroup>
                </SettingsSection>
              )}

              {/* Actions */}
              <SettingsGroup>
                <div className="px-4 py-3">
                  <SettingsField
                    label="分配套餐"
                    htmlFor="billing-drawer-assign-plan"
                  >
                    <div className="flex gap-2">
                      <NativeSelect
                        id="billing-drawer-assign-plan"
                        value={assignPlanId}
                        onChange={(e) => setAssignPlanId(e.target.value)}
                        className="min-w-0 flex-1"
                      >
                        <NativeSelectOption value="">
                          选择套餐
                        </NativeSelectOption>
                        {plans.map((p) => (
                          <NativeSelectOption key={p.id} value={p.id}>
                            {p.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Button
                        onClick={handleAssign}
                        disabled={!assignPlanId || assigning}
                      >
                        确认
                      </Button>
                    </div>
                  </SettingsField>
                </div>

                <div className="px-4 py-3">
                  <SettingsField
                    label="充值 / 扣减额度"
                    htmlFor="billing-drawer-adjust-amount"
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        id="billing-drawer-adjust-amount"
                        type="number"
                        placeholder="金额 (正数充值，负数扣减)"
                        value={adjAmount}
                        onChange={(e) => setAdjAmount(e.target.value)}
                      />
                      <Input
                        placeholder="备注说明"
                        aria-label="备注说明"
                        value={adjDesc}
                        onChange={(e) => setAdjDesc(e.target.value)}
                      />
                    </div>
                    <div className="flex justify-end pt-1">
                      <Button
                        variant="outline"
                        onClick={handleAdjust}
                        disabled={adjusting}
                      >
                        提交资金调整
                      </Button>
                    </div>
                  </SettingsField>
                </div>
              </SettingsGroup>

              {/* Subscription history */}
              {subHistory.length > 0 && (
                <SettingsSection title="订阅历史">
                  <SettingsGroup>
                    {subHistory.map((h) => (
                      <div
                        key={h.id}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 text-body"
                      >
                        <span className="truncate text-foreground">
                          {h.plan_name}
                        </span>
                        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                          {h.status} /{' '}
                          {new Date(h.started_at).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </SettingsGroup>
                </SettingsSection>
              )}

              {/* Recent transactions */}
              <SettingsSection title="交易记录">
                {transactions.length === 0 ? (
                  <p className="text-caption text-muted-foreground">暂无记录</p>
                ) : (
                  <SettingsGroup>
                    {transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-body text-foreground">
                            {tx.description || tx.type}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
                            <span className="tabular-nums">
                              {new Date(tx.created_at).toLocaleString()}
                            </span>
                            {(tx.source || tx.type) && (
                              <Badge variant="neutral">
                                {TX_SOURCE_LABELS[tx.source || ''] || tx.type}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 text-body font-medium tabular-nums',
                            tx.amount_usd > 0 ? 'text-success' : 'text-error',
                          )}
                        >
                          {tx.amount_usd > 0 ? '+' : ''}
                          {fmt(tx.amount_usd)}
                        </span>
                      </div>
                    ))}
                  </SettingsGroup>
                )}
              </SettingsSection>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
