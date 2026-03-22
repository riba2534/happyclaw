import { useEffect, useState, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Package,
  Wallet,
  History,
  XCircle,
  Loader2,
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
import { api } from '../../api/client';

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

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-brand-500';
  return (
    <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all`}
        style={{ width: `${pct}%` }}
      />
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

  const loadDetail = useCallback(async (uid: string) => {
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
  }, [getUserSubscriptionHistory]);

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
    if (!confirm('确定撤销该用户的订阅？')) return;
    await cancelUserSubscription(userId);
    await loadDetail(userId);
  };

  return (
    <Sheet open={!!userId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {detail
              ? `${detail.display_name || detail.username} 的账单`
              : '用户详情'}
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !detail ? (
          <p className="text-sm text-zinc-500 p-4">无法加载用户信息</p>
        ) : (
          <div className="space-y-6 p-4">
            {/* Current plan */}
            <div>
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <Package className="w-4 h-4 text-primary" />
                当前套餐
              </div>
              <div className="flex items-center gap-2">
                <div className="text-lg font-bold">
                  {detail.plan_name || '无套餐'}
                </div>
                {detail.is_fallback && (
                  <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                    默认
                  </span>
                )}
              </div>
              {detail.subscription_status && detail.subscription_status !== 'default' && (
                <span className="text-xs text-zinc-400">
                  状态: {detail.subscription_status}
                </span>
              )}
            </div>

            {/* Balance */}
            <div>
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <Wallet className="w-4 h-4 text-primary" />
                余额
              </div>
              <div className="text-2xl font-bold text-primary">
                {fmt(detail.balance_usd)}
              </div>
              <div
                className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                  detail.access_allowed
                    ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {detail.access_allowed ? (
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{detail.access_allowed ? '当前可用' : detail.access_reason || '当前被计费阻断'}</span>
                </div>
                <p className="mt-1 opacity-80">
                  最低起用余额 {fmt(detail.min_balance_usd ?? 0)}
                </p>
              </div>
            </div>

            {/* Usage progress (3 windows) */}
            <div>
              <div className="text-sm font-medium mb-2">用量进度</div>
              <div className="space-y-3">
                {detail.daily_cost_quota != null && (
                  <div>
                    <div className="flex justify-between text-xs text-zinc-500 mb-1">
                      <span>日度费用</span>
                      <span>
                        {fmt(detail.daily_cost_used ?? 0)} /{' '}
                        {fmt(detail.daily_cost_quota)}
                      </span>
                    </div>
                    <ProgressBar
                      value={detail.daily_cost_used ?? 0}
                      max={detail.daily_cost_quota}
                    />
                  </div>
                )}
                {detail.weekly_cost_quota != null && (
                  <div>
                    <div className="flex justify-between text-xs text-zinc-500 mb-1">
                      <span>周度费用</span>
                      <span>
                        {fmt(detail.weekly_cost_used ?? 0)} /{' '}
                        {fmt(detail.weekly_cost_quota)}
                      </span>
                    </div>
                    <ProgressBar
                      value={detail.weekly_cost_used ?? 0}
                      max={detail.weekly_cost_quota}
                    />
                  </div>
                )}
                {detail.monthly_cost_quota != null && (
                  <div>
                    <div className="flex justify-between text-xs text-zinc-500 mb-1">
                      <span>月度费用</span>
                      <span>
                        {fmt(detail.current_month_cost)} /{' '}
                        {fmt(detail.monthly_cost_quota)}
                      </span>
                    </div>
                    <ProgressBar
                      value={detail.current_month_cost}
                      max={detail.monthly_cost_quota}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-4 pt-2 border-t border-zinc-200 dark:border-zinc-700">
              {/* Assign plan */}
              <div>
                <label className="text-xs text-zinc-500">分配套餐</label>
                <div className="flex gap-2 mt-1">
                  <select
                    value={assignPlanId}
                    onChange={(e) => setAssignPlanId(e.target.value)}
                    className="flex-1 h-9 px-3 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent"
                  >
                    <option value="">选择套餐</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={handleAssign}
                    disabled={!assignPlanId || assigning}
                  >
                    确认
                  </Button>
                </div>
              </div>

              {/* Adjust balance */}
              <div>
                <label className="text-xs text-zinc-500">充值 / 扣减额度</label>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="number"
                    placeholder="金额 (正数充值，负数扣减)"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    placeholder="备注说明"
                    value={adjDesc}
                    onChange={(e) => setAdjDesc(e.target.value)}
                    className="flex-1"
                  />
                </div>
                <Button
                  size="sm"
                  className="mt-1"
                  onClick={handleAdjust}
                  disabled={adjusting}
                >
                  提交资金调整
                </Button>
              </div>

              {/* Cancel subscription — only for real subscriptions, not fallback */}
              {detail.has_real_subscription && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleCancelSub}
                >
                  <XCircle className="w-4 h-4" />
                  撤销订阅
                </Button>
              )}
            </div>

            {/* Subscription history */}
            {subHistory.length > 0 && (
              <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700">
                <div className="text-sm font-medium mb-2">订阅历史</div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {subHistory.map((h) => (
                    <div
                      key={h.id}
                      className="flex justify-between text-xs py-1"
                    >
                      <span>{h.plan_name}</span>
                      <span className="text-zinc-400">
                        {h.status} /{' '}
                        {new Date(h.started_at).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent transactions */}
            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700">
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <History className="w-4 h-4 text-primary" />
                交易记录
              </div>
              {transactions.length === 0 ? (
                <p className="text-xs text-zinc-500">暂无记录</p>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {transactions.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex justify-between items-center py-1.5 border-b border-zinc-100 dark:border-zinc-700 last:border-0"
                    >
                      <div>
                        <div className="text-xs">{tx.description || tx.type}</div>
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                          {new Date(tx.created_at).toLocaleString()}
                          {(tx.source || tx.type) && (
                            <span className="rounded bg-zinc-100 px-1 py-0.5 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                              {TX_SOURCE_LABELS[tx.source || ''] || tx.type}
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-medium ${
                          tx.amount_usd > 0
                            ? 'text-green-600'
                            : 'text-red-500'
                        }`}
                      >
                        {tx.amount_usd > 0 ? '+' : ''}
                        {fmt(tx.amount_usd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
