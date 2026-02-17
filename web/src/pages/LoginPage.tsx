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

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
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

  // Registration status
  const [regStatus, setRegStatus] = useState<RegisterStatus>({
    allowRegistration: true,
    requireInviteCode: true,
  });

  useEffect(() => {
    api
      .get<RegisterStatus>('/api/auth/register/status')
      .then((data) => setRegStatus(data))
      .catch(() => {
        // Fallback: show link with invite code text (safe default)
        setRegStatus({ allowRegistration: true, requireInviteCode: true });
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(username, password);
      const state = useAuthStore.getState();
      if (state.user?.role === 'admin' && state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      const mustChange = useAuthStore.getState().user?.must_change_password;
      navigate(mustChange ? '/settings' : '/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  if (initialized !== true) {
    return (
      <div className="h-screen bg-slate-50 overflow-y-auto flex items-center justify-center p-4">
        <div className="text-slate-500 text-sm">加载中...</div>
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

          {/* Title */}
          <h1 className="text-2xl font-bold text-slate-900 text-center mb-2">
            欢迎使用 HappyClaw
          </h1>
          <p className="text-slate-500 text-center mb-6">
            请登录以继续
          </p>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-1">
                用户名
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="mb-6">
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                密码
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full">
              {loading && <Loader2 className="size-4 animate-spin" />}
              {loading ? '登录中...' : '登录'}
            </Button>
          </form>

          {/* Register Link — hidden when registration is disabled */}
          {regStatus.allowRegistration && (
            <p className="text-center text-sm text-slate-500 mt-4">
              {regStatus.requireInviteCode ? '有邀请码？' : '还没有账户？'}
              <Link to="/register" className="text-primary hover:text-primary/80 ml-1">
                去注册
              </Link>
            </p>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-slate-500 mt-4">
          HappyClaw - Powered by{' '}
          <a href="https://github.com/riba2534" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">
            riba2534
          </a>
        </p>
      </div>
    </div>
  );
}
