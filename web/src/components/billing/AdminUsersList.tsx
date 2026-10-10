import { useEffect, useMemo, useState } from 'react';
import { Users, Search, Package, AlertTriangle } from 'lucide-react';
import {
  useBillingStore,
  type UserBillingOverview,
} from '../../stores/billing';
import { useCurrency } from './utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  DataTable,
  EmptyState,
  SearchInput,
  type DataTableColumn,
} from '@/components/common';
import { SettingsSection } from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';

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
  const [batchResult, setBatchResult] = useState<{
    type: 'success' | 'error';
    msg: string;
  } | null>(null);

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
      const planName =
        plans.find((p) => p.id === batchPlanId)?.name ?? batchPlanId;
      setBatchResult({
        type: 'success',
        msg: `已为 ${count} 位用户分配「${planName}」`,
      });
      setSelected(new Set());
      setBatchPlanId('');
      setTimeout(() => setBatchResult(null), 4000);
    } catch (err) {
      setBatchResult({
        type: 'error',
        msg: `批量分配失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBatching(false);
    }
  };

  const allSelected = filtered.length > 0 && selected.size === filtered.length;
  const someSelected = selected.size > 0 && !allSelected;

  const columns: DataTableColumn<UserBillingOverview>[] = [
    {
      key: 'select',
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={toggleAll}
          aria-label="选择全部用户"
        />
      ),
      className: 'hidden w-10 sm:table-cell',
      headerClassName: 'hidden w-10 sm:table-cell',
      cell: (u) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected.has(u.user_id)}
            onCheckedChange={() => toggleSelect(u.user_id)}
            aria-label={`选择 ${u.display_name || u.username}`}
          />
        </div>
      ),
    },
    {
      key: 'user',
      header: '用户',
      className: 'max-w-72 whitespace-normal',
      cell: (u) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-foreground">
              {u.display_name || u.username}
            </span>
            {u.access_allowed === false && (
              <Badge variant="error">
                <AlertTriangle />
                已阻断
              </Badge>
            )}
          </div>
          <div className="truncate text-caption text-muted-foreground">
            @{u.username}
          </div>
          {u.access_allowed === false && u.access_reason && (
            <div
              className="mt-0.5 hidden truncate text-caption text-error sm:block"
              title={u.access_reason}
            >
              {u.access_reason}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'plan',
      header: '套餐',
      cell: (u) =>
        u.plan_name ? (
          <span className="text-foreground">
            {u.plan_name}
            {u.is_fallback && (
              <span className="ml-1 text-caption text-muted-foreground">
                (默认)
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground italic">无套餐</span>
        ),
    },
    {
      key: 'balance',
      header: '余额',
      align: 'right',
      cell: (u) => (
        <span className="tabular-nums text-foreground">
          {fmt(u.balance_usd)}
        </span>
      ),
    },
    {
      key: 'month-cost',
      header: '本月费用',
      align: 'right',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (u) => (
        <span className="tabular-nums text-muted-foreground">
          {fmt(u.current_month_cost)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      cell: (u) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onSelectUser(u.user_id);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection
      title="用户计费管理"
      actions={
        <span className="text-caption tabular-nums text-muted-foreground">
          共 {allUsers.length} 人
          {selected.size > 0 && ` / 已选 ${selected.size}`}
        </span>
      }
    >
      {/* Search + Batch */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索用户名或显示名"
          debounce={150}
          className="w-full sm:max-w-xs"
        />
        {selected.size > 0 && (
          <div className="flex items-center gap-2 sm:ml-auto">
            <NativeSelect
              value={batchPlanId}
              onChange={(e) => setBatchPlanId(e.target.value)}
              aria-label="批量分配套餐"
              className="min-w-0 flex-1 sm:w-44 sm:flex-none"
            >
              <NativeSelectOption value="">选择套餐</NativeSelectOption>
              {plans.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              onClick={handleBatchAssign}
              disabled={!batchPlanId || batching}
            >
              <Package />
              批量分配
            </Button>
          </div>
        )}
      </div>

      {/* Batch operation feedback */}
      {batchResult && (
        <div
          role={batchResult.type === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-lg px-3 py-2 text-body',
            batchResult.type === 'success'
              ? 'bg-success/10 text-success'
              : 'bg-error/10 text-error',
          )}
        >
          {batchResult.msg}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(u) => u.user_id}
        onRowClick={(u) => onSelectUser(u.user_id)}
        rowClassName={(u) =>
          selected.has(u.user_id) ? 'bg-surface-selected' : undefined
        }
        empty={
          <EmptyState
            icon={search ? Search : Users}
            title={search ? '未找到匹配的用户' : '暂无用户'}
          />
        }
      />
    </SettingsSection>
  );
}
