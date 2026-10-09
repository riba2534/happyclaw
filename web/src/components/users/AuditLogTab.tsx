import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Download, RefreshCw, ScrollText } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  IconButton,
  type DataTableColumn,
} from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useUsersStore, type AuditLogEntry } from '../../stores/users';
import { formatDateTime, getErrorMessage } from './utils';
import { withBasePath } from '../../utils/url';

interface AuditLogTabProps {
  setError: (value: string | null) => void;
}

export function AuditLogTab({ setError }: AuditLogTabProps) {
  const { auditLogs, loading, fetchAuditLogs } = useUsersStore();
  const [eventType, setEventType] = useState('all');
  const [username, setUsername] = useState('');
  const [actorUsername, setActorUsername] = useState('');
  const [limit, setLimit] = useState(100);

  const load = async () => {
    try {
      await fetchAuditLogs({
        event_type: eventType === 'all' ? undefined : eventType,
        username: username || undefined,
        actor_username: actorUsername || undefined,
        limit,
        offset: 0,
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
    if (event.key === 'Enter') void load();
  };

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      key: 'time',
      header: '时间',
      cell: (log) => formatDateTime(log.created_at),
      className:
        'hidden text-caption text-muted-foreground tabular-nums sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'event',
      header: '事件',
      cell: (log) => (
        <div>
          <code className="font-mono text-caption text-foreground">
            {log.event_type}
          </code>
          <div className="mt-0.5 text-micro text-muted-foreground tabular-nums sm:hidden">
            {formatDateTime(log.created_at)}
          </div>
        </div>
      ),
    },
    {
      key: 'user',
      header: '用户',
      cell: (log) => log.username,
      className: 'font-medium text-foreground',
    },
    {
      key: 'actor',
      header: '操作者',
      cell: (log) => log.actor_username || '-',
      className: 'hidden text-muted-foreground sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'ip',
      header: 'IP',
      cell: (log) => log.ip_address || '-',
      className:
        'hidden font-mono text-caption text-muted-foreground md:table-cell',
      headerClassName: 'hidden md:table-cell',
    },
    {
      key: 'details',
      header: '详情',
      align: 'right',
      cell: (log) =>
        log.details ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs">
                查看
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-96 max-w-[calc(100vw-2rem)]"
            >
              <pre className="max-h-72 overflow-auto font-mono text-micro whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(log.details, null, 2)}
              </pre>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
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
        <Input
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          onKeyDown={loadOnEnter}
          placeholder="事件类型（all）"
          aria-label="事件类型"
          className="w-full sm:w-44"
        />
        <Input
          type="number"
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10) || 100)}
          onKeyDown={loadOnEnter}
          min={10}
          max={500}
          aria-label="条数上限"
          className="w-24"
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
        empty={<EmptyState icon={ScrollText} title="暂无记录" />}
      />
    </div>
  );
}
