import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { IconButton } from '../components/common/IconButton';
import { LogoLoading } from '../components/common/LogoLoading';
import {
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../components/settings/SettingsLayout';

import { useAuthStore } from '../stores/auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// --- Helpers ---

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// --- Component ---

export function SetupPage() {
  const navigate = useNavigate();
  const { initialized, authenticated, setupAdmin, checkStatus } =
    useAuthStore();

  // Check initialization status on mount (this is a public page, no AuthGuard)
  useEffect(() => {
    if (initialized === null) {
      checkStatus();
    }
  }, [initialized, checkStatus]);

  // If system is already initialized, redirect to login
  useEffect(() => {
    if (initialized === true && !authenticated) {
      navigate('/login', { replace: true });
    }
  }, [initialized, authenticated, navigate]);

  if (initialized === true && authenticated) {
    return <Navigate to="/setup/providers" replace />;
  }

  // Loading or redirecting
  if (initialized !== false) {
    return <LogoLoading full />;
  }

  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
        <header className="text-center">
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            alt="HappyClaw"
            className="mx-auto size-11 rounded-xl object-cover"
          />
          <p className="mt-4 text-caption text-muted-foreground">步骤 1/2</p>
          <h1 className="mt-1 text-title-lg text-foreground">
            HappyClaw 初始设置
          </h1>
          <p className="mt-1.5 text-body text-muted-foreground">
            先创建管理员账号，完成后进入后台继续配置飞书 Token 与 Claude Key
          </p>
        </header>

        <CreateAdminStep
          onDone={() => navigate('/setup/providers', { replace: true })}
          setupAdmin={setupAdmin}
        />
      </div>
    </div>
  );
}

// --- Create Admin Step ---

function CreateAdminStep({
  onDone,
  setupAdmin,
}: {
  onDone: () => void;
  setupAdmin: (username: string, password: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!username.trim()) {
      setError('请填写用户名');
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setError('用户名须为 3-32 位字母、数字或下划线');
      return;
    }
    if (!password) {
      setError('请填写密码');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirmPwd) {
      setError('两次输入的密码不一致');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setupAdmin(username, password);
      onDone();
    } catch (err) {
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: unknown }).status)
          : NaN;
      if (status === 403) {
        setError('系统已被其他管理员初始化，即将跳转到登录页...');
        setTimeout(() => {
          navigate('/login', { replace: true });
        }, 2000);
        return;
      }
      setError(getErrorMessage(err, '创建管理员失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void handleSubmit();
  };

  return (
    <SettingsSection
      title="创建管理员账号"
      description="首次使用请先创建管理员，提交后进入系统接入配置向导。"
    >
      <SettingsGroup>
        <form onSubmit={handleFormSubmit} className="space-y-4 p-4">
          {error && (
            <div
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
            >
              {error}
            </div>
          )}

          <SettingsField label="用户名" htmlFor="setup-username">
            <Input
              id="setup-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-32 位字母、数字或下划线"
              autoComplete="username"
              autoFocus
            />
          </SettingsField>
          <SettingsField label="密码" htmlFor="setup-password">
            <div className="relative">
              <Input
                id="setup-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-9"
                placeholder="至少 8 位"
                autoComplete="new-password"
              />
              <IconButton
                label={showPassword ? '隐藏密码' : '显示密码'}
                icon={showPassword ? <EyeOff /> : <Eye />}
                size="icon-xs"
                hideTooltip
                onClick={() => setShowPassword(!showPassword)}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </SettingsField>
          <SettingsField label="确认密码" htmlFor="setup-confirm">
            <div className="relative">
              <Input
                id="setup-confirm"
                type={showConfirm ? 'text' : 'password'}
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                className="pr-9"
                placeholder="再次输入密码"
                autoComplete="new-password"
              />
              <IconButton
                label={showConfirm ? '隐藏密码' : '显示密码'}
                icon={showConfirm ? <EyeOff /> : <Eye />}
                size="icon-xs"
                hideTooltip
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </SettingsField>
          <Button type="submit" disabled={saving} className="w-full">
            {saving && <Loader2 className="animate-spin" />}
            创建账号并下一步
            <ChevronRight />
          </Button>
        </form>
      </SettingsGroup>
    </SettingsSection>
  );
}
