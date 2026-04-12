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
    <div className="landing-page min-h-screen bg-background overflow-y-auto relative">
      {/* ── Background noise grain ── */}
      <div className="landing-gradient-bg" aria-hidden="true" />

      {/* ── Aurora blobs ── */}
      <div className="landing-aurora" aria-hidden="true">
        <div className="landing-aurora-blob landing-aurora-blob-1" />
        <div className="landing-aurora-blob landing-aurora-blob-2" />
        <div className="landing-aurora-blob landing-aurora-blob-3" />
        <div className="landing-aurora-blob landing-aurora-blob-4" />
      </div>

      {/* ── Top nav bar ── */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 lg:px-12">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl overflow-hidden">
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              alt="HappyClaw"
              className="w-full h-full object-cover"
            />
          </div>
          <span className="text-lg font-semibold text-foreground tracking-tight">
            HappyClaw
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/riba2534/happyclaw"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="ghost" size="sm">
              <Globe className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
          </a>
        </div>
      </header>

      {/* ── Hero + Auth section ── */}
      <main className="relative z-10 px-5 sm:px-6 lg:px-12 pt-4 pb-8 lg:pt-16 lg:pb-16 flex-1 flex items-start lg:items-center">
        <div className="mx-auto max-w-6xl w-full">
          {/* Mobile: card-first compact layout / Desktop: side-by-side */}
          <div className="flex flex-col-reverse lg:grid lg:grid-cols-2 gap-8 lg:gap-20 items-center lg:items-start lg:pt-12">
            {/* Left: Hero text — below card on mobile */}
            <div className="text-center lg:text-left">
              <div className="landing-badge">
                <Sparkles className="size-3.5" />
                <span>Powered by Claude Agent SDK</span>
              </div>

              <h1 className="mt-4 lg:mt-6 text-3xl sm:text-4xl lg:text-6xl font-bold text-foreground tracking-tight leading-[1.1]">
                你的私有
                <br />
                <span className="landing-gradient-text">AI Agent 平台</span>
              </h1>

              <p className="mt-4 lg:mt-6 text-sm sm:text-base lg:text-lg text-muted-foreground leading-relaxed max-w-lg mx-auto lg:mx-0">
                自托管、多用户、多渠道 —— 让 Claude 成为你的全能数字助手。
                在安全隔离的环境中，自主执行代码、管理文件、调度任务。
              </p>

              {/* Stats — hidden on small mobile to save space */}
              <div className="mt-6 lg:mt-8 hidden sm:flex items-center justify-center lg:justify-start gap-6 lg:gap-8">
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">5+</div>
                  <div className="text-xs text-muted-foreground">接入渠道</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">Docker</div>
                  <div className="text-xs text-muted-foreground">安全隔离</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">24/7</div>
                  <div className="text-xs text-muted-foreground">自主运行</div>
                </div>
              </div>
            </div>

            {/* Right: Auth card — shown first on mobile */}
            <div className="flex justify-center lg:justify-end w-full">
              <div className="landing-glass-card w-full max-w-sm">
                {/* Logo */}
                <div className="flex justify-center mb-4 lg:mb-5">
                  <div className="w-12 h-12 lg:w-14 lg:h-14 rounded-2xl overflow-hidden shadow-lg">
                    <img
                      src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
                      alt="HappyClaw"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>

                <h2 className="text-lg lg:text-xl font-semibold text-foreground text-center mb-1">
                  {tab === 'login' ? '欢迎回来' : '注册新账户'}
                </h2>
                <p className="text-muted-foreground text-xs lg:text-sm text-center mb-5 lg:mb-6">
                  {tab === 'login'
                    ? '登录以继续使用 HappyClaw'
                    : regStatus.requireInviteCode
                      ? '需要邀请码才能注册'
                      : '创建你的账户'}
                </p>

                {error && (
                  <div role="alert" className="mb-4 p-3 bg-error-bg border border-error/30 rounded-lg text-left">
                    <p className="text-sm text-error">{error}</p>
                  </div>
                )}

                {/* ── Login form ── */}
                {tab === 'login' && (
                  <>
                    <form onSubmit={handleLogin} className="text-left">
                      <div className="mb-3 lg:mb-4">
                        <Label htmlFor="login-username" className="mb-1.5 text-sm">
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
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-5 lg:mb-6">
                        <Label htmlFor="login-password" className="mb-1.5 text-sm">
                          密码
                        </Label>
                        <Input
                          id="login-password"
                          type="password"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder="请输入密码"
                          required
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <Button type="submit" disabled={loading} className="w-full h-9">
                        {loading && <Loader2 className="size-4 animate-spin" />}
                        {loading ? '登录中...' : '登录'}
                      </Button>
                    </form>

                    {regStatus.allowRegistration && (
                      <p className="text-center text-sm text-muted-foreground mt-4">
                        {regStatus.requireInviteCode ? '有邀请码？' : '还没有账户？'}
                        <button
                          type="button"
                          onClick={() => switchTab('register')}
                          className="text-primary hover:text-primary/80 ml-1 font-medium"
                        >
                          去注册
                        </button>
                      </p>
                    )}
                  </>
                )}

                {/* ── Register form ── */}
                {tab === 'register' && (
                  <>
                    <form onSubmit={handleRegister} className="text-left">
                      {regStatus.requireInviteCode && (
                        <div className="mb-3">
                          <Label htmlFor="reg-invite" className="mb-1.5 text-sm">
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
                            className="h-9 bg-background/50 font-mono"
                          />
                        </div>
                      )}

                      <div className="mb-3">
                        <Label htmlFor="reg-username" className="mb-1.5 text-sm">
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
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-3">
                        <Label htmlFor="reg-display" className="mb-1.5 text-sm">
                          显示名称{' '}
                          <span className="text-muted-foreground font-normal">(可选)</span>
                        </Label>
                        <Input
                          id="reg-display"
                          type="text"
                          value={regDisplayName}
                          onChange={(e) => setRegDisplayName(e.target.value)}
                          placeholder="留空则使用用户名"
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-5 lg:mb-6">
                        <Label htmlFor="reg-password" className="mb-1.5 text-sm">
                          密码
                        </Label>
                        <Input
                          id="reg-password"
                          type="password"
                          value={regPassword}
                          onChange={(e) => setRegPassword(e.target.value)}
                          placeholder="至少 8 位"
                          required
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <Button type="submit" disabled={loading} className="w-full h-9">
                        {loading && <Loader2 className="size-4 animate-spin" />}
                        {loading ? '注册中...' : '注册'}
                      </Button>
                    </form>

                    <p className="text-center text-sm text-muted-foreground mt-4">
                      已有账户？
                      <button
                        type="button"
                        onClick={() => switchTab('login')}
                        className="text-primary hover:text-primary/80 ml-1 font-medium"
                      >
                        去登录
                      </button>
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
