import { useEffect, useState, useCallback, useMemo } from 'react';
import { FileText } from 'lucide-react';
import { useBillingStore, type BillingAuditLog } from '../../stores/billing';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  DataTable,
  EmptyState,
  type DataTableColumn,
} from '@/components/common';
import {
  AuditDetailsPopover,
  AuditPagination,
} from '@/components/shared/AuditLogParts';
import { SettingsSection } from '@/components/settings/SettingsLayout';

const EVENT_TYPE_LABELS: Record<string, string> = {
  plan_created: '创建套餐',
  plan_updated: '更新套餐',
  plan_deleted: '删除套餐',
  subscription_assigned: '分配订阅',
  subscription_cancelled: '取消订阅',
  subscription_expired: '订阅过期',
  balance_adjusted: '调整余额',
  manual_recharge: '手动充值',
  manual_deduct: '手动扣减',
  balance_deducted: '余额扣减',
  code_created: '创建兑换码',
  code_redeemed: '使用兑换码',
  code_deleted: '删除兑换码',
  wallet_blocked: '钱包阻断',
  wallet_unblocked: '解除钱包阻断',
  quota_exceeded: '超出配额',
  billing_settings_updated: '更新计费设置',
};

const PAGE_SIZE = 20;

export default function AdminAuditLog() {
  const { auditLogs, auditLogsTotal, loadAuditLog, allUsers, loadAllUsers } =
    useBillingStore();

  const [eventType, setEventType] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const totalPages = Math.ceil(auditLogsTotal / PAGE_SIZE);

  // Build a user_id → display name map for friendly display
  const userNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of allUsers) {
      m.set(u.user_id, u.display_name || u.username);
    }
    return m;
  }, [allUsers]);

  useEffect(() => {
    if (allUsers.length === 0) loadAllUsers();
  }, [allUsers.length, loadAllUsers]);

  const load = useCallback(() => {
    loadAuditLog(
      PAGE_SIZE,
      page * PAGE_SIZE,
      userFilter.trim() || undefined,
      eventType || undefined,
    );
  }, [loadAuditLog, page, userFilter, eventType]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [eventType, userFilter]);

  const filteredLogs = auditLogs;

  const eventLabel = (type: string) => EVENT_TYPE_LABELS[type] ?? type;

  // Unique event types from known labels + actual data
  const allEventTypes = Array.from(
    new Set([
      ...Object.keys(EVENT_TYPE_LABELS),
      ...auditLogs.map((l) => l.event_type),
    ]),
  ).sort();

  const columns: DataTableColumn<BillingAuditLog>[] = [
    {
      key: 'event',
      header: '事件',
      cell: (log) => (
        <div>
          <Badge variant="neutral">{eventLabel(log.event_type)}</Badge>
          <div className="mt-1 text-caption tabular-nums text-muted-foreground sm:hidden">
            {new Date(log.created_at).toLocaleString()}
          </div>
        </div>
      ),
    },
    {
      key: 'user',
      header: '用户',
      className: 'max-w-48 truncate',
      cell: (log) =>
        log.user_id ? (
          <span className="text-foreground">
            {userNameMap.get(log.user_id) ?? log.user_id.slice(0, 8)}
          </span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'actor',
      header: '操作者',
      className: 'hidden max-w-48 truncate sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (log) =>
        log.actor_id && log.actor_id !== log.user_id ? (
          <span className="text-muted-foreground">
            {userNameMap.get(log.actor_id) ?? log.actor_id.slice(0, 8)}
          </span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'time',
      header: '时间',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (log) => (
        <span className="text-caption tabular-nums text-muted-foreground">
          {new Date(log.created_at).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'details',
      header: <span className="sr-only">详情</span>,
      align: 'right',
      cell: (log) =>
        log.details ? (
          <AuditDetailsPopover
            details={log.details}
            open={expandedId === log.id}
            onOpenChange={(open) => setExpandedId(open ? log.id : null)}
          />
        ) : null,
    },
  ];

  return (
    <SettingsSection
      title="审计日志"
      actions={
        <span className="text-caption tabular-nums text-muted-foreground">
          共 {auditLogsTotal} 条
        </span>
      }
    >
      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <NativeSelect
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          aria-label="事件类型"
          className="w-full sm:w-44"
        >
          <NativeSelectOption value="">全部事件类型</NativeSelectOption>
          {allEventTypes.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {eventLabel(t)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          placeholder="用户 ID 筛选"
          aria-label="用户 ID 筛选"
          className="sm:w-56"
        />
      </div>

      {/* Log entries */}
      <DataTable
        columns={columns}
        rows={filteredLogs}
        rowKey={(log) => log.id}
        empty={<EmptyState icon={FileText} title="暂无审计日志" />}
      />

      {/* Pagination */}
      {totalPages > 1 && (
        <AuditPagination
          page={page}
          totalPages={totalPages}
          hasNext={page < totalPages - 1}
          onPageChange={(next) =>
            setPage(Math.min(totalPages - 1, Math.max(0, next)))
          }
        />
      )}
    </SettingsSection>
  );
}
