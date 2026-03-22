import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  FileText,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
} from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const EVENT_TYPE_LABELS: Record<string, string> = {
  plan_created: '创建套餐',
  plan_updated: '更新套餐',
  plan_deleted: '删除套餐',
  subscription_assigned: '分配订阅',
  subscription_cancelled: '取消订阅',
  subscription_expired: '订阅过期',
  balance_adjusted: '调整余额',
  code_created: '创建兑换码',
  code_redeemed: '使用兑换码',
  code_deleted: '删除兑换码',
};

const PAGE_SIZE = 20;

export default function AdminAuditLog() {
  const { auditLogs, auditLogsTotal, loadAuditLog, allUsers, loadAllUsers } = useBillingStore();

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

  const eventLabel = (type: string) =>
    EVENT_TYPE_LABELS[type] ?? type;

  // Unique event types from known labels + actual data
  const allEventTypes = Array.from(
    new Set([
      ...Object.keys(EVENT_TYPE_LABELS),
      ...auditLogs.map((l) => l.event_type),
    ]),
  ).sort();

  return (
    <div className="space-y-4">
      {/* Header */}
      <h3 className="font-semibold flex items-center gap-2">
        <FileText className="w-5 h-5 text-primary" />
        审计日志
      </h3>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="h-9 px-3 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent"
        >
          <option value="">全部事件类型</option>
          {allEventTypes.map((t) => (
            <option key={t} value={t}>
              {eventLabel(t)}
            </option>
          ))}
        </select>
        <Input
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          placeholder="用户 ID 筛选"
          className="sm:max-w-[200px]"
        />
        <div className="flex items-center gap-1 ml-auto text-sm text-zinc-500">
          共 {auditLogsTotal} 条
        </div>
      </div>

      {/* Log entries */}
      <div className="space-y-1">
        {filteredLogs.map((log) => (
          <div
            key={log.id}
            className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700"
          >
            <button
              onClick={() =>
                setExpandedId(expandedId === log.id ? null : log.id)
              }
              className="w-full flex items-center gap-2 p-3 text-left"
            >
              {expandedId === log.id ? (
                <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0" />
              )}
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-300 shrink-0">
                {eventLabel(log.event_type)}
              </span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate flex-1">
                {log.user_id && (
                  <span className="text-zinc-400">
                    用户 {userNameMap.get(log.user_id) ?? log.user_id.slice(0, 8)}
                  </span>
                )}
                {log.actor_id && log.actor_id !== log.user_id && (
                  <span className="text-zinc-400 ml-2">
                    操作者 {userNameMap.get(log.actor_id) ?? log.actor_id.slice(0, 8)}
                  </span>
                )}
              </span>
              <span className="text-xs text-zinc-400 shrink-0">
                {new Date(log.created_at).toLocaleString()}
              </span>
            </button>

            {/* Expanded details */}
            {expandedId === log.id && log.details && (
              <div className="px-3 pb-3">
                <pre className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-900 rounded-md p-3 overflow-x-auto max-h-48 overflow-y-auto">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {filteredLogs.length === 0 && (
        <p className="text-sm text-zinc-500 text-center py-8">暂无审计日志</p>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => setPage(0)}
            disabled={page === 0}
          >
            <ChevronsLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm text-zinc-500">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
