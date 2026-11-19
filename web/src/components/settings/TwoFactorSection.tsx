import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '../../api/client';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';

interface TwoFactorStatus {
  enabled: boolean;
  recovery_codes_remaining: number;
}

interface Enrolment {
  secret: string;
  otpauth_uri: string;
  qr_data_url: string;
}

type Flow = 'enable' | 'recovery' | 'disable';

const CODE_ERRORS: Record<string, string> = {
  'Invalid verification code': '验证码不正确',
  'Current password is incorrect': '密码不正确',
};

function codeError(error: unknown, fallback: string): string {
  const message = getErrorMessage(error, fallback);
  return CODE_ERRORS[message] ?? message;
}

/** One-time code field: digits keyboard, autofill from the authenticator. */
function CodeInput({
  id,
  value,
  onChange,
  allowRecovery = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  allowRecovery?: boolean;
}) {
  return (
    <Input
      id={id}
      variant="code"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={allowRecovery ? '6 位验证码或恢复码' : '6 位验证码'}
      inputMode={allowRecovery ? 'text' : 'numeric'}
      autoComplete="one-time-code"
      maxLength={allowRecovery ? 32 : 6}
      autoFocus
      className="tracking-widest"
    />
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">
        每个恢复码只能用一次。手机丢失时用它登录。这些码只显示这一次，请保存到密码管理器。
      </p>
      <pre className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-muted px-4 py-3 font-mono text-body tabular-nums select-all">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => toast.success('恢复码已复制'))
            .catch(() => toast.error('复制失败，请手动选择复制'))
        }
      >
        <Copy className="size-3.5" />
        复制全部
      </Button>
    </div>
  );
}

/** 设置 > 安全: an authenticator app (TOTP) as a second login step. */
export function TwoFactorSection() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<TwoFactorStatus>('/api/auth/2fa'));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (next: Flow) => {
    setCode('');
    setPassword('');
    setCodes(null);
    setError(null);
    setEnrolment(null);
    setFlow(next);
    if (next !== 'enable') return;
    try {
      setEnrolment(await api.post<Enrolment>('/api/auth/2fa/setup', {}));
    } catch (err) {
      setError(getErrorMessage(err, '无法开始设置'));
    }
  };

  const close = () => {
    setFlow(null);
    setEnrolment(null);
    void load();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!flow || codes) return;
    setBusy(true);
    setError(null);
    try {
      if (flow === 'disable') {
        await api.post('/api/auth/2fa/disable', { password, code });
        toast.success('二次验证已关闭');
        close();
        return;
      }
      const path =
        flow === 'enable'
          ? '/api/auth/2fa/enable'
          : '/api/auth/2fa/recovery-codes';
      const result = await api.post<{ recovery_codes: string[] }>(path, {
        code,
      });
      setCodes(result.recovery_codes);
      if (flow === 'enable') toast.success('二次验证已开启');
    } catch (err) {
      setError(codeError(err, '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const title =
    flow === 'enable'
      ? '开启二次验证'
      : flow === 'recovery'
        ? '重新生成恢复码'
        : '关闭二次验证';

  return (
    <SettingsSection
      title="二次验证"
      description="登录时除了密码，还要输入验证器 App（如 1Password、Google Authenticator）上的 6 位验证码"
    >
      <SettingsGroup>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              验证器 App
              {status?.enabled && (
                <Badge variant="outline" dot="success">
                  已开启
                </Badge>
              )}
            </span>
          }
          description={
            status?.enabled
              ? `剩余 ${status.recovery_codes_remaining} 个恢复码`
              : '未开启'
          }
          control={
            status &&
            (status.enabled ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void open('recovery')}
                >
                  重新生成恢复码
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void open('disable')}
                >
                  关闭
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => void open('enable')}>
                <ShieldCheck className="size-3.5" />
                开启
              </Button>
            ))
          }
        />
      </SettingsGroup>

      <Dialog open={flow !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md" autoFocusOnPhone>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{codes ? '保存恢复码' : title}</DialogTitle>
              <DialogDescription>
                {codes
                  ? '下次换手机或丢失手机时会用到。'
                  : flow === 'enable'
                    ? '用验证器 App 扫描二维码，再输入它显示的 6 位验证码。'
                    : flow === 'recovery'
                      ? '旧的恢复码会全部作废。输入验证器 App 上的验证码。'
                      : '输入密码和验证码（或一个恢复码）。'}
              </DialogDescription>
            </DialogHeader>

            {error && (
              <p role="alert" className="text-body text-error">
                {error}
              </p>
            )}

            {codes ? (
              <RecoveryCodes codes={codes} />
            ) : (
              <>
                {flow === 'enable' &&
                  (enrolment ? (
                    <div className="flex flex-col items-center gap-2">
                      <img
                        src={enrolment.qr_data_url}
                        alt="二次验证二维码"
                        className="size-44 rounded-lg bg-white p-1"
                      />
                      <p className="text-caption text-muted-foreground">
                        无法扫码时手动输入密钥：
                      </p>
                      <code className="font-mono text-caption break-all select-all">
                        {enrolment.secret}
                      </code>
                    </div>
                  ) : (
                    !error && (
                      <div className="flex justify-center py-6">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    )
                  ))}
                {flow === 'disable' && (
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="当前密码"
                    aria-label="当前密码"
                    autoComplete="current-password"
                  />
                )}
                <CodeInput
                  id="two-factor-code"
                  value={code}
                  onChange={setCode}
                  allowRecovery={flow === 'disable'}
                />
              </>
            )}

            <DialogFooter>
              {codes ? (
                <Button type="button" onClick={close}>
                  我已保存
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={close}>
                    取消
                  </Button>
                  <Button
                    type="submit"
                    variant={flow === 'disable' ? 'destructive' : 'default'}
                    disabled={
                      busy ||
                      code.trim().length < 6 ||
                      (flow === 'disable' && !password) ||
                      (flow === 'enable' && !enrolment)
                    }
                  >
                    {busy && <Loader2 className="animate-spin" />}
                    {flow === 'disable' ? '关闭' : '确认'}
                  </Button>
                </>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
