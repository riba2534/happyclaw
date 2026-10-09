import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Globe, Sparkles } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { LogoLoading } from '../components/common/LogoLoading';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { withBasePath } from '../utils/url';

interface RegisterStatus {
  allowRegistration: boolean;
  requireInviteCode: boolean;
}

type Tab = 'login' | 'register';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(
    searchParams.get('tab') === 'register' ? 'register' : 'login',
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const initialized = useAuthStore((state) => state.initialized);
  const checkStatus = useAuthStore((state) => state.checkStatus);
  const appearance = useAuthStore((state) => state.appearance);
  const fetchAppearance = useAuthStore((state) => state.fetchAppearance);

  const appName = appearance?.appName.trim() || 'HappyClaw';
  const brandIconUrl = withBasePath(
    appearance?.brandIconUrl || '/icons/icon-192.png',
  );

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register fields
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regInviteCode, setRegInviteCode] = useState('');

  useEffect(() => {
    if (initialized === null) {
      checkStatus();
    } else if (initialized === false) {
      navigate('/setup', { replace: true });
    }
  }, [initialized, checkStatus, navigate]);

  useEffect(() => {
    void fetchAppearance();
  }, [fetchAppearance]);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const [regStatus, setRegStatus] = useState<RegisterStatus>({
    allowRegistration: true,
    requireInviteCode: true,
  });

  useEffect(() => {
    api
      .get<RegisterStatus>('/api/auth/register/status')
      .then((data) => setRegStatus(data))
      .catch(() => {
        setRegStatus({ allowRegistration: true, requireInviteCode: true });
      });
  }, []);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(loginUsername, loginPassword);
      const state = useAuthStore.getState();
      if (state.user?.role === 'admin' && state.setupStatus?.needsSetup) {
        navigate('/setup/providers');
        return;
      }
      const mustChange = useAuthStore.getState().user?.must_change_password;
      navigate(mustChange ? '/settings' : '/chat');
    } catch (err) {
      setError(extractErrorMessage(err) || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(regUsername)) {
      setError('用户名须为 3-32 位字母、数字或下划线');
      return;
    }
    if (regPassword.length < 8) {
      setError('密码长度不能少于 8 位');
      return;
    }
    if (regPassword.length > 128) {
      setError('密码长度不能超过 128 位');
      return;
    }

    setLoading(true);
    try {
      const payload: {
        username: string;
        password: string;
        display_name?: string;
        invite_code?: string;
      } = {
        username: regUsername,
        password: regPassword,
        display_name: regDisplayName || undefined,
      };
      if (regStatus.requireInviteCode || regInviteCode.trim()) {
        payload.invite_code = regInviteCode;
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
      setError(extractErrorMessage(err) || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  if (initialized !== true) {
    return <LogoLoading full />;
  }

  return (
    <div className="landing-page relative flex h-dvh flex-col overflow-y-auto bg-background">
      {/* Static brand wash — the login page keeps its scoped orange tokens. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-96 bg-linear-to-b from-brand-50 to-transparent dark:from-brand-50/40"
      />

      <header className="relative z-10 flex items-center justify-between px-5 py-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src={brandIconUrl}
            alt={appName}
            className="size-7 shrink-0 rounded-lg object-cover"
          />
          <span className="truncate text-title-sm text-foreground">
            {appName}
          </span>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <a
            href="https://github.com/riba2534/happyclaw"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Globe />
            GitHub
          </a>
        </Button>
      </header>

      <main className="relative z-10 flex flex-1 justify-center px-5 pt-[6vh] pb-10 sm:items-center sm:pt-0 sm:pb-[8vh]">
        <div className="w-full max-w-sm">
          <div className="rounded-xl bg-background p-6 shadow-floating ring-1 ring-border sm:p-8">
            <img
              src={brandIconUrl}
              alt={appName}
              className="mx-auto mb-5 size-11 rounded-xl object-cover"
            />

            <h1 className="text-center text-display-sm text-foreground">
              {tab === 'login' ? '欢迎回来' : '注册新账户'}
            </h1>
            <p className="mt-1.5 text-center text-body text-muted-foreground">
              {tab === 'login'
                ? `登录以继续使用 ${appName}`
                : regStatus.requireInviteCode
                  ? '需要邀请码才能注册'
                  : '创建你的账户'}
            </p>

            {error && (
              <div
                role="alert"
                className="mt-5 rounded-lg bg-error/10 px-3 py-2 text-body text-error"
              >
                {error}
              </div>
            )}

            {/* ── Login form ── */}
            {tab === 'login' && (
              <>
                <form onSubmit={handleLogin} className="mt-6 space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-username" className="text-label">
                      用户名
                    </Label>
                    <Input
                      id="login-username"
                      type="text"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="请输入用户名"
                      required
                      autoFocus
                      autoComplete="username"
                      className="h-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="login-password" className="text-label">
                      密码
                    </Label>
                    <Input
                      id="login-password"
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="请输入密码"
                      required
                      autoComplete="current-password"
                      className="h-9"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="h-9 w-full"
                  >
                    {loading && <Loader2 className="animate-spin" />}
                    {loading ? '登录中...' : '登录'}
                  </Button>
                </form>

                {regStatus.allowRegistration && (
                  <p className="mt-5 text-center text-body text-muted-foreground">
                    {regStatus.requireInviteCode
                      ? '有邀请码？'
                      : '还没有账户？'}
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => switchTab('register')}
                      className="ml-1 h-auto p-0"
                    >
                      去注册
                    </Button>
                  </p>
                )}
              </>
            )}

            {/* ── Register form ── */}
            {tab === 'register' && (
              <>
                <form onSubmit={handleRegister} className="mt-6 space-y-4">
                  {regStatus.requireInviteCode && (
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-invite" className="text-label">
                        邀请码
                      </Label>
                      <Input
                        id="reg-invite"
                        type="text"
                        value={regInviteCode}
                        onChange={(e) => setRegInviteCode(e.target.value)}
                        placeholder="请输入邀请码"
                        required
                        autoFocus
                        className="h-9 font-mono"
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-username" className="text-label">
                      用户名
                    </Label>
                    <Input
                      id="reg-username"
                      type="text"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      placeholder="3-32 位字母、数字或下划线"
                      required
                      autoFocus={!regStatus.requireInviteCode}
                      autoComplete="username"
                      className="h-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-display" className="text-label">
                      显示名称{' '}
                      <span className="font-normal text-muted-foreground">
                        (可选)
                      </span>
                    </Label>
                    <Input
                      id="reg-display"
                      type="text"
                      value={regDisplayName}
                      onChange={(e) => setRegDisplayName(e.target.value)}
                      placeholder="留空则使用用户名"
                      className="h-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-password" className="text-label">
                      密码
                    </Label>
                    <Input
                      id="reg-password"
                      type="password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="至少 8 位"
                      required
                      autoComplete="new-password"
                      className="h-9"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="h-9 w-full"
                  >
                    {loading && <Loader2 className="animate-spin" />}
                    {loading ? '注册中...' : '注册'}
                  </Button>
                </form>

                <p className="mt-5 text-center text-body text-muted-foreground">
                  已有账户？
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => switchTab('login')}
                    className="ml-1 h-auto p-0"
                  >
                    去登录
                  </Button>
                </p>
              </>
            )}
          </div>

          <p className="mt-6 flex items-center justify-center gap-1.5 text-caption text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" />
            Powered by Claude Agent SDK
          </p>
        </div>
      </main>
    </div>
  );
}
