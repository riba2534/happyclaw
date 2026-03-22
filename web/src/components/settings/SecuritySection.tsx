import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { SessionInfo } from './types';
import { getErrorMessage } from './types';

export function SecuritySection() {
  const { logout } = useAuthStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions');
      setSessions(data.sessions);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleRevoke = async (id: string) => {
    try {
      await api.delete(`/api/auth/sessions/${id}`);
      toast.success('会话已撤销');
      loadSessions();
    } catch (err) {
      toast.error(getErrorMessage(err, '操作失败'));
    }
  };

  const handleLogout = () => {
    if (confirm('确定要退出登录吗？')) logout();
  };

  return (
    <div className="space-y-6">
      {/* Sessions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-foreground">登录设备</h3>
          <Button variant="outline" onClick={loadSessions} disabled={loading}>
            <RefreshCw className="w-4 h-4" />
            刷新
          </Button>
        </div>
        <div className="divide-y divide-border">
          {sessions.length === 0 ? (
            <div className="py-4 text-sm text-muted-foreground text-center">暂无会话</div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-foreground truncate max-w-xs">{s.user_agent?.split(' ').slice(0, 3).join(' ') || '未知设备'}</span>
                    {s.is_current && <span className="text-xs px-1.5 py-0.5 bg-success-bg text-success rounded">当前</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    IP: {s.ip_address || '未知'} · 最后活跃: {new Date(s.last_active_at).toLocaleString('zh-CN')}
                  </div>
                </div>
                {!s.is_current && (
                  <button
                    onClick={() => handleRevoke(s.id)}
                    className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-error cursor-pointer"
                    title="撤销会话"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Logout */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">退出登录</div>
          <div className="text-xs text-muted-foreground mt-0.5">退出当前账户，返回登录页面</div>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-error hover:bg-error-bg rounded-lg border border-error transition-colors font-medium cursor-pointer"
        >
          退出登录
        </button>
      </div>
    </div>
  );
}
