import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface RegisterStatus {
  allowRegistration: boolean;
  requireInviteCode: boolean;
}

export function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const register = useAuthStore((state) => state.register);
  const initialized = useAuthStore((state) => state.initialized);
  const checkStatus = useAuthStore((state) => state.checkStatus);

  // Redirect to setup if system is not initialized
  useEffect(() => {
    if (initialized === null) {
      checkStatus();
    } else if (initialized === false) {
      navigate('/setup', { replace: true });
    }
  }, [initialized, checkStatus, navigate]);

  // Registration status from backend
  const [status, setStatus] = useState<RegisterStatus>({
    allowRegistration: true,
    requireInviteCode: true,
  });
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    api
      .get<RegisterStatus>('/api/auth/register/status')
      .then((data) => setStatus(data))
      .catch(() => {
        // Fallback: safe defaults
        setStatus({ allowRegistration: true, requireInviteCode: true });
      })
      .finally(() => setStatusLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Client-side validation
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setError('用户名须为 3-32 位字母、数字或下划线');
      return;
    }
    if (password.length < 8) {
      setError('密码长度不能少于 8 位');
      return;
    }
    if (password.length > 128) {
      setError('密码长度不能超过 128 位');
      return;
    }

    setLoading(true);
    try {
      const payload: { username: string; password: string; display_name?: string; invite_code?: string } = {
        username,
        password,
        display_name: displayName || undefined,
      };
      if (status.requireInviteCode || inviteCode.trim()) {
        payload.invite_code = inviteCode;
      }
      await register(payload);
      const state = useAuthStore.getState();
      if (state.user?.role === 'admin' && state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      const mustChange = useAuthStore.getState().user?.must_change_password;
      navigate(mustChange ? '/settings' : '/setup/channels');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : '注册失败',
      );
    } finally {
      setLoading(false);
    }
  };

  if (initialized !== true || statusLoading) {
    return (
      <div className="h-screen bg-slate-50 overflow-y-auto flex items-center justify-center p-4">
        <div className="text-slate-500 text-sm">加载中...</div>
      </div>
    );
  }

  // Registration disabled
  if (!status.allowRegistration) {
    return (
      <div className="h-screen bg-slate-50 overflow-y-auto flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-lg border border-slate-200 p-8">
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto">
                <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 text-center mb-2">
              注册已关闭
            </h1>
            <p className="text-slate-500 text-center mb-6">
              管理员已关闭注册功能，如需账户请联系管理员。
            </p>
            <Link
              to="/login"
              className="block w-full text-center bg-primary text-white py-2 px-4 rounded-md hover:bg-primary/90 transition-colors"
            >
              返回登录
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-50 overflow-y-auto flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg border border-slate-200 p-8">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
          </div>

          <h1 className="text-2xl font-bold text-slate-900 text-center mb-2">
            注册新账户
          </h1>
          <p className="text-slate-500 text-center mb-6">
            {status.requireInviteCode ? '需要邀请码才能注册' : '创建你的账户'}
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {status.requireInviteCode && (
              <div className="mb-4">
                <label htmlFor="invite_code" className="block text-sm font-medium text-slate-700 mb-1">
                  邀请码
                </label>
                <Input
                  id="invite_code"
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  className="font-mono"
                  placeholder="请输入邀请码"
                  required
                  autoFocus
                />
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="reg-username" className="block text-sm font-medium text-slate-700 mb-1">
                用户名
              </label>
              <Input
                id="reg-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3-32位字母、数字或下划线"
                required
                autoFocus={!status.requireInviteCode}
              />
            </div>

            <div className="mb-4">
              <label htmlFor="reg-display-name" className="block text-sm font-medium text-slate-700 mb-1">
                显示名称 <span className="text-slate-400">(可选)</span>
              </label>
              <Input
                id="reg-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="留空则使用用户名"
              />
            </div>

            <div className="mb-6">
              <label htmlFor="reg-password" className="block text-sm font-medium text-slate-700 mb-1">
                密码
              </label>
              <Input
                id="reg-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                required
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading && <Loader2 className="size-4 animate-spin" />}
              {loading ? '注册中...' : '注册'}
            </Button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-4">
            已有账户？
            <Link to="/login" className="text-primary hover:text-primary/80 ml-1">
              去登录
            </Link>
          </p>

          <p className="text-center text-sm text-slate-500 mt-2">
            HappyClaw - Powered by{' '}
            <a href="https://github.com/riba2534" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">
              riba2534
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
