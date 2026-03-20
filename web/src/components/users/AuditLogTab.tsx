import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useUsersStore } from '../../stores/users';
import { getErrorMessage } from './utils';
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
    if (actorUsername.trim()) params.set('actor_username', actorUsername.trim());
    return withBasePath(`/api/admin/audit-log/export?${params.toString()}`);
  }, [actorUsername, eventType, limit, username]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="目标用户名"
          className="text-sm"
        />
        <Input
          type="text"
          value={actorUsername}
          onChange={(e) => setActorUsername(e.target.value)}
          placeholder="操作者用户名"
          className="text-sm"
        />
        <Input
          type="text"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          placeholder="事件类型（all）"
          className="text-sm"
        />
        <Input
          type="number"
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10) || 100)}
          min={10}
          max={500}
          className="text-sm w-28"
        />
        <Button variant="outline" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
        <a
          href={exportUrl}
          className="px-3 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-muted"
        >
          导出 CSV
        </a>
      </div>

      <Card className="divide-y divide-border overflow-hidden">
        {auditLogs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无记录</div>
        ) : (
          auditLogs.map((log) => (
            <div key={log.id} className="px-5 py-3">
              <div className="text-sm text-foreground">
                {log.event_type} · {log.username}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                操作者: {log.actor_username || '-'} · IP: {log.ip_address || '-'} · 时间: {new Date(log.created_at).toLocaleString('zh-CN')}
              </div>
              {log.details && (
                <pre className="mt-2 text-[11px] text-muted-foreground bg-muted rounded p-2 overflow-x-auto">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
