import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronRight, Eye, EyeOff, Loader2 } from 'lucide-react';

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
  const { initialized, authenticated, setupAdmin, checkStatus } = useAuthStore();

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
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-16 h-16 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-50 overflow-y-auto p-4 flex flex-col items-center justify-center">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-2xl overflow-hidden">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1">HappyClaw 初始设置</h1>
          <p className="text-sm text-slate-500">先创建管理员账号，完成后进入后台继续配置飞书 Token 与 Claude Key</p>
        </div>

        {/* Step card */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <CreateAdminStep
            onDone={() => navigate('/setup/providers', { replace: true })}
            setupAdmin={setupAdmin}
          />
        </div>
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
        setTimeout(() => { navigate('/login', { replace: true }); }, 2000);
        return;
      }
      setError(getErrorMessage(err, '创建管理员失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900 mb-1">创建管理员账号</h2>
      <p className="text-sm text-slate-500 mb-4">首次使用请先创建管理员，提交后进入系统接入配置向导。</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">用户名</label>
          <Input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="3-32 位字母、数字或下划线"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">密码</label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-10"
              placeholder="至少 8 位"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">确认密码</label>
          <div className="relative">
            <Input
              type={showConfirm ? 'text' : 'password'}
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              className="pr-10"
              placeholder="再次输入密码"
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <Button onClick={handleSubmit} disabled={saving} className="w-full mt-2">
          {saving && <Loader2 className="size-4 animate-spin" />}
          创建账号并下一步
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
