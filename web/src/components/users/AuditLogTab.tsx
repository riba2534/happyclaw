import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Download, RefreshCw, ScrollText } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  IconButton,
  type DataTableColumn,
} from '@/components/common';
import {
  AuditDetailsPopover,
  AuditPagination,
} from '@/components/shared/AuditLogParts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { useUsersStore, type AuditLogEntry } from '../../stores/users';
import { formatDateTime, getErrorMessage } from './utils';
import { withBasePath } from '../../utils/url';

const EVENT_TYPE_LABELS: Record<string, string> = {
  login_success: '登录成功',
  login_failed: '登录失败',
  logout: '退出登录',
  register_success: '注册成功',
  password_changed: '修改密码',
  profile_updated: '更新资料',
  recovery_reset: '恢复重置',
  session_revoked: '撤销会话',
  user_created: '创建用户',
  user_updated: '更新用户',
  role_changed: '变更角色',
  user_disabled: '禁用用户',
  user_enabled: '启用用户',
  user_deleted: '删除用户',
  user_restored: '恢复用户',
  invite_created: '创建邀请码',
  invite_used: '使用邀请码',
  invite_deleted: '删除邀请码',
  system_settings_updated: '更新系统设置',
  host_integration_updated: '更新宿主机集成',
};

const PAGE_SIZES = [50, 100, 200, 500];

const eventLabel = (type: string) => EVENT_TYPE_LABELS[type] ?? type;

interface AuditLogTabProps {
  setError: (value: string | null) => void;
}

export function AuditLogTab({ setError }: AuditLogTabProps) {
  const { auditLogs, loading, fetchAuditLogs } = useUsersStore();
  const [eventType, setEventType] = useState('all');
  const [username, setUsername] = useState('');
  const [actorUsername, setActorUsername] = useState('');
  const [limit, setLimit] = useState(100);
  const [page, setPage] = useState(0);

  const load = async (
    overrides: { eventType?: string; limit?: number; page?: number } = {},
  ) => {
    const nextEventType = overrides.eventType ?? eventType;
    const nextLimit = overrides.limit ?? limit;
    const nextPage = overrides.page ?? page;
    setPage(nextPage);
    try {
      await fetchAuditLogs({
        event_type: nextEventType === 'all' ? undefined : nextEventType,
        username: username || undefined,
        actor_username: actorUsername || undefined,
        limit: nextLimit,
        offset: nextPage * nextLimit,
      });
    } catch (err) {
      setError(getErrorMessage(err, '加载审计日志失败'));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (eventType !== 'all') params.set('event_type', eventType);
    if (username.trim()) params.set('username', username.trim());
    if (actorUsername.trim())
      params.set('actor_username', actorUsername.trim());
    return withBasePath(`/api/admin/audit-log/export?${params.toString()}`);
  }, [actorUsername, eventType, limit, username]);

  const loadOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void load({ page: 0 });
  };

  // Known event types plus any unexpected ones already in the results.
  const eventTypes = Array.from(
    new Set([
      ...Object.keys(EVENT_TYPE_LABELS),
      ...auditLogs.map((log) => log.event_type),
    ]),
  );

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      key: 'event',
      header: '事件',
      cell: (log) => (
        <div>
          <Badge variant="neutral">{eventLabel(log.event_type)}</Badge>
          <div className="mt-1 text-caption text-muted-foreground tabular-nums sm:hidden">
            {formatDateTime(log.created_at)}
          </div>
        </div>
      ),
    },
    {
      key: 'user',
      header: '用户',
      cell: (log) => log.username,
      className: 'max-w-48 truncate text-foreground',
    },
    {
      key: 'actor',
      header: '操作者',
      cell: (log) =>
        log.actor_username || <span className="text-faint-foreground">—</span>,
      className: 'hidden max-w-48 truncate text-muted-foreground sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'ip',
      header: 'IP',
      cell: (log) =>
        log.ip_address || <span className="text-faint-foreground">—</span>,
      className:
        'hidden font-mono text-caption text-muted-foreground md:table-cell',
      headerClassName: 'hidden md:table-cell',
    },
    {
      key: 'time',
      header: '时间',
      cell: (log) => formatDateTime(log.created_at),
      className:
        'hidden text-caption text-muted-foreground tabular-nums sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'details',
      header: <span className="sr-only">详情</span>,
      align: 'right',
      cell: (log) =>
        log.details ? <AuditDetailsPopover details={log.details} /> : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          value={eventType}
          onChange={(e) => {
            setEventType(e.target.value);
            void load({ eventType: e.target.value, page: 0 });
          }}
          aria-label="事件类型"
          className="w-full sm:w-44"
        >
          <NativeSelectOption value="all">全部事件类型</NativeSelectOption>
          {eventTypes.map((type) => (
            <NativeSelectOption key={type} value={type}>
              {eventLabel(type)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={loadOnEnter}
          placeholder="目标用户名"
          aria-label="目标用户名"
          className="w-full sm:w-40"
        />
        <Input
          value={actorUsername}
          onChange={(e) => setActorUsername(e.target.value)}
          onKeyDown={loadOnEnter}
          placeholder="操作者用户名"
          aria-label="操作者用户名"
          className="w-full sm:w-40"
        />
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label="刷新"
            variant="outline"
            size="icon"
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
            onClick={() => load()}
            disabled={loading}
          />
          <Button variant="outline" asChild>
            <a href={exportUrl}>
              <Download />
              导出 CSV
            </a>
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={auditLogs}
        rowKey={(log) => log.id}
        loading={loading}
        empty={<EmptyState icon={ScrollText} title="暂无审计日志" />}
      />

      <div className="flex items-center justify-between gap-2">
        <NativeSelect
          size="sm"
          value={String(limit)}
          onChange={(e) => {
            const next = Number(e.target.value);
            setLimit(next);
            void load({ limit: next, page: 0 });
          }}
          aria-label="每页条数"
        >
          {PAGE_SIZES.map((size) => (
            <NativeSelectOption key={size} value={size}>
              每页 {size} 条
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {(page > 0 || auditLogs.length >= limit) && (
          <AuditPagination
            page={page}
            hasNext={auditLogs.length >= limit}
            onPageChange={(next) => void load({ page: next })}
            disabled={loading}
          />
        )}
      </div>
    </div>
  );
}
