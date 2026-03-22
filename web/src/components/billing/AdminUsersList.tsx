import { useEffect, useMemo, useState } from 'react';
import { Users, Search, Package, CheckSquare, Square, AlertTriangle } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency } from './utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface AdminUsersListProps {
  onSelectUser: (userId: string) => void;
}

export default function AdminUsersList({ onSelectUser }: AdminUsersListProps) {
  const { allUsers, plans, loadAllUsers, loadAllPlans, batchAssignPlan } =
    useBillingStore();
  const fmt = useCurrency();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchPlanId, setBatchPlanId] = useState('');
  const [batching, setBatching] = useState(false);
  const [batchResult, setBatchResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    loadAllUsers();
    loadAllPlans();
  }, [loadAllUsers, loadAllPlans]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allUsers;
    const q = search.toLowerCase();
    return allUsers.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.display_name.toLowerCase().includes(q),
    );
  }, [allUsers, search]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((u) => u.user_id)));
    }
  };

  const handleBatchAssign = async () => {
    if (!batchPlanId || selected.size === 0) return;
    setBatching(true);
    setBatchResult(null);
    try {
      const count = selected.size;
      await batchAssignPlan(Array.from(selected), batchPlanId);
      const planName = plans.find((p) => p.id === batchPlanId)?.name ?? batchPlanId;
      setBatchResult({ type: 'success', msg: `已为 ${count} 位用户分配「${planName}」` });
      setSelected(new Set());
      setBatchPlanId('');
      setTimeout(() => setBatchResult(null), 4000);
    } catch (err) {
      setBatchResult({ type: 'error', msg: `批量分配失败: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBatching(false);
    }
  };

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          用户计费管理
        </h3>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          共 {allUsers.length} 人
          {selected.size > 0 && ` / 已选 ${selected.size}`}
        </div>
      </div>

      {/* Search + Batch */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索用户名或显示名"
            className="pl-9"
          />
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={batchPlanId}
              onChange={(e) => setBatchPlanId(e.target.value)}
              className="h-9 px-3 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent"
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
              onClick={handleBatchAssign}
              disabled={!batchPlanId || batching}
            >
              <Package className="w-4 h-4" />
              批量分配
            </Button>
          </div>
        )}
      </div>

      {/* Table header */}
      <div className="hidden sm:grid sm:grid-cols-[auto_1fr_120px_100px_100px_80px] gap-2 px-3 py-2 text-xs text-zinc-500 font-medium border-b border-zinc-200 dark:border-zinc-700">
        <button onClick={toggleAll} className="p-0.5">
          {allSelected ? (
            <CheckSquare className="w-4 h-4 text-primary" />
          ) : (
            <Square className="w-4 h-4" />
          )}
        </button>
        <span>用户</span>
        <span>套餐</span>
        <span className="text-right">余额</span>
        <span className="text-right">本月费用</span>
        <span className="text-right">操作</span>
      </div>

      {/* User rows */}
      <div className="space-y-1">
        {filtered.map((u) => (
          <div
            key={u.user_id}
            className={`grid grid-cols-1 sm:grid-cols-[auto_1fr_120px_100px_100px_80px] gap-2 items-center px-3 py-2.5 bg-white dark:bg-zinc-800 rounded-lg border ${
              u.access_allowed === false
                ? 'border-red-200 dark:border-red-900/60'
                : 'border-zinc-200 dark:border-zinc-700'
            }`}
          >
            {/* Checkbox */}
            <button
              onClick={() => toggleSelect(u.user_id)}
              className="hidden sm:block p-0.5"
            >
              {selected.has(u.user_id) ? (
                <CheckSquare className="w-4 h-4 text-primary" />
              ) : (
                <Square className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {/* User info */}
            <div className="min-w-0">
              <span className="font-medium text-sm truncate block">
                {u.display_name || u.username}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">@{u.username}</span>
                {u.access_allowed === false && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/30 dark:text-red-300">
                    <AlertTriangle className="h-3 w-3" />
                    已阻断
                  </span>
                )}
              </div>
              {u.access_allowed === false && u.access_reason && (
                <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400 truncate">
                  {u.access_reason}
                </span>
              )}
            </div>

            {/* Plan */}
            <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate">
              {u.plan_name ? (
                <>
                  {u.plan_name}
                  {u.is_fallback && (
                    <span className="ml-1 text-[10px] text-zinc-400">(默认)</span>
                  )}
                </>
              ) : (
                <span className="text-zinc-400 italic">无套餐</span>
              )}
            </span>

            {/* Balance */}
            <span className="text-sm text-right font-mono">
              {fmt(u.balance_usd)}
            </span>

            {/* Month cost */}
            <span className="text-sm text-right font-mono text-zinc-500">
              {fmt(u.current_month_cost)}
            </span>

            {/* Action */}
            <div className="text-right">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onSelectUser(u.user_id)}
              >
                详情
              </Button>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-zinc-500 text-center py-8">
          {search ? '未找到匹配的用户' : '暂无用户'}
        </p>
      )}

      {/* Batch operation feedback */}
      {batchResult && (
        <div
          className={`text-sm px-3 py-2 rounded-md ${
            batchResult.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
          }`}
        >
          {batchResult.msg}
        </div>
      )}
    </div>
  );
}
