import { useCallback, useEffect, useState } from 'react';
import { Loader2, LogOut, Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { confirmDialog } from '@/stores/confirm';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { getErrorMessage, type SessionInfo } from './types';

export function SecuritySection() {
  const { logout, changePassword } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ sessions: SessionInfo[] }>(
        '/api/auth/sessions',
      );
      setSessions(data.sessions);
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法加载登录设备，请检查网络后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleChangePassword = async () => {
    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      toast.success('密码已修改，其他设备的登录会话已撤销');
      void loadSessions();
    } catch (error) {
      toast.error(getErrorMessage(error, '修改密码失败'));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleRevoke = async (shortId: string) => {
    const confirmed = await confirmDialog({
      title: '撤销设备会话',
      message: '撤销这台设备的登录会话？该设备需要重新登录。',
      confirmText: '撤销',
      variant: 'danger',
    });
    if (!confirmed) return;
    setRevokingId(shortId);
    try {
      await api.delete(`/api/auth/sessions/${encodeURIComponent(shortId)}`);
      toast.success('设备会话已撤销');
      await loadSessions();
    } catch (error) {
      toast.error(getErrorMessage(error, '撤销设备会话失败'));
    } finally {
      setRevokingId(null);
    }
  };

  const handleLogout = async () => {
    const confirmed = await confirmDialog({
      title: '退出登录',
      message: '退出当前账户？',
      confirmText: '退出',
      variant: 'danger',
    });
    if (confirmed) void logout();
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title="修改密码"
        description="修改后会撤销其他设备的登录状态，当前设备保持登录"
      >
        <SettingsGroup>
          <SettingsRow
            label="当前密码"
            htmlFor="current-password"
            control={
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                className="sm:w-64"
              />
            }
          />
          <SettingsRow
            label="新密码"
            htmlFor="new-password"
            control={
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
                className="sm:w-64"
              />
            }
          />
          <div className="flex justify-end px-4 py-3">
            <Button
              onClick={handleChangePassword}
              disabled={
                changingPassword || !currentPassword || newPassword.length < 8
              }
              size="sm"
            >
              {changingPassword && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              修改密码
            </Button>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="登录设备"
        description="查看并撤销当前账户在其他设备上的会话"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={loadSessions}
            disabled={loading}
          >
            <RefreshCw
              className={`size-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
        }
      >
        {loadError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-error/10 px-4 py-3"
          >
            <p className="text-body text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={loadSessions}>
              重新加载
            </Button>
          </div>
        ) : loading && sessions.length === 0 ? (
          <SettingsGroup>
            <div className="flex items-center justify-center gap-2 py-8 text-body text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在加载登录设备…
            </div>
          </SettingsGroup>
        ) : sessions.length === 0 ? (
          <SettingsGroup>
            <div className="py-8 text-center text-body text-muted-foreground">
              没有可显示的设备会话
            </div>
          </SettingsGroup>
        ) : (
          <ListGroup>
            {sessions.map((session) => (
              <ListRow
                key={session.shortId}
                media={
                  <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Monitor className="size-4" />
                  </div>
                }
                title={
                  session.user_agent?.split(' ').slice(0, 3).join(' ') ||
                  '未知设备'
                }
                badges={
                  session.is_current && (
                    <Badge variant="outline" dot="success">
                      当前设备
                    </Badge>
                  )
                }
                description={
                  <>
                    IP：{session.ip_address || '未知'} · 最后活跃：
                    {new Date(session.last_active_at).toLocaleString('zh-CN')}
                  </>
                }
                actions={
                  !session.is_current && (
                    <IconButton
                      label="撤销该设备会话"
                      icon={
                        revokingId === session.shortId ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )
                      }
                      disabled={revokingId === session.shortId}
                      onClick={() => handleRevoke(session.shortId)}
                      className="text-muted-foreground hover:text-error"
                    />
                  )
                }
              />
            ))}
          </ListGroup>
        )}
      </SettingsSection>

      <SettingsGroup>
        <SettingsRow
          label="退出登录"
          description="退出当前设备，不影响其他设备"
          control={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleLogout()}
            >
              <LogOut className="size-3.5" />
              退出当前设备
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}
