import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

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
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { PasswordInput } from '@/components/common/PasswordInput';
import { api } from '../../api/client';
import { authErrorCode, authErrorMessage } from '../../lib/auth-errors';
import { SettingsSection } from './SettingsLayout';
import { CodeInput } from './TwoFactorSection';

interface Passkey {
  id: string;
  name: string;
  rp_id: string;
  created_at: string;
  last_used_at: string | null;
}

interface PasskeyList {
  passkeys: Passkey[];
  rp_id: string | null;
  unavailable_reason:
    | 'no_origin'
    | 'ip_host'
    | 'insecure'
    | 'not_allowed'
    | null;
  /** Adding a passkey then also takes an authenticator code. */
  two_factor_enabled?: boolean;
}

const UNAVAILABLE: Record<string, string> = {
  ip_host:
    '通行密钥不能在 IP 地址下使用。请用 localhost（本机）或域名访问本站。',
  insecure:
    '通行密钥只能在 HTTPS 域名（或 localhost）下使用。当前是 HTTP 地址，请改用 HTTPS 域名访问。',
  not_allowed:
    '当前地址未被允许使用通行密钥。经反向代理访问时，请管理员把公网地址加入 CORS_ALLOWED_ORIGINS。',
  unsupported: '这个浏览器不支持通行密钥。',
};

/** An RP ID must be a domain: an IPv4 or IPv6 literal never works. */
function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '通行密钥';
}

const formatDate = (value: string) => new Date(value).toLocaleDateString();

type Mode =
  | { kind: 'add' }
  | { kind: 'rename'; passkey: Passkey }
  | { kind: 'remove'; passkey: Passkey };

/** 设置 > 安全: passkeys that sign in without a password. */
export function PasskeySection() {
  const [list, setList] = useState<PasskeyList | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function';
  const unavailable = isIpHost(window.location.hostname.replace(/^\[|\]$/g, ''))
    ? 'ip_host'
    : !window.isSecureContext
      ? 'insecure'
      : !supported
        ? 'unsupported'
        : list?.unavailable_reason === 'ip_host' ||
            list?.unavailable_reason === 'insecure' ||
            list?.unavailable_reason === 'not_allowed'
          ? list.unavailable_reason
          : null;
  const needsCode = mode?.kind === 'add' && !!list?.two_factor_enabled;

  const load = useCallback(async () => {
    try {
      setList(await api.get<PasskeyList>('/api/auth/passkeys'));
    } catch {
      setList(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (next: Mode) => {
    setValue(next.kind === 'rename' ? next.passkey.name : '');
    setCode('');
    setError(null);
    setMode(next);
  };

  const close = () => setMode(null);

  /**
   * Adding: the password (and a code with two-factor on) earns the options,
   * then the browser creates the passkey.
   */
  const add = async () => {
    const optionsJSON = await api.post<never>('/api/auth/passkeys/options', {
      password: value,
      ...(needsCode ? { code: code.trim() } : {}),
    });
    const { startRegistration } = await import('@simplewebauthn/browser');
    let response;
    try {
      response = await startRegistration({ optionsJSON });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      // Cancelled in the browser's prompt: nothing to report.
      if (name === 'NotAllowedError' || name === 'AbortError') {
        close();
        return;
      }
      if (name === 'InvalidStateError') {
        throw new Error('这台设备上已经有本站的通行密钥');
      }
      throw err;
    }
    await api.post('/api/auth/passkeys', { response, name: defaultName() });
    toast.success('通行密钥已添加');
    close();
    await load();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === 'add') {
        await add();
        return;
      }
      const id = encodeURIComponent(mode.passkey.id);
      if (mode.kind === 'rename') {
        await api.patch(`/api/auth/passkeys/${id}`, { name: value.trim() });
      } else {
        await api.post(`/api/auth/passkeys/${id}/delete`, { password: value });
        toast.success('通行密钥已删除');
      }
      close();
      await load();
    } catch (err) {
      // A code is spent once checked; the next try needs a fresh one.
      if (authErrorCode(err) !== 'CURRENT_PASSWORD_INCORRECT') setCode('');
      setError(
        authErrorCode(err) === 'PASSKEY_INVALID'
          ? '通行密钥验证失败'
          : authErrorMessage(err, '操作失败'),
      );
    } finally {
      setBusy(false);
    }
  };

  const passkeys = list?.passkeys ?? [];
  const removing = mode?.kind === 'remove' ? mode.passkey : null;

  return (
    <SettingsSection
      title="通行密钥"
      description="用设备的指纹、面容或屏幕锁登录，不用输入密码，也不需要二次验证码"
    >
      {unavailable && (
        <p className="text-body text-muted-foreground">
          {UNAVAILABLE[unavailable]}
        </p>
      )}
      {passkeys.length > 0 && (
        <ListGroup>
          {passkeys.map((passkey) => (
            <ListRow
              key={passkey.id}
              media={
                <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <KeyRound className="size-4" />
                </div>
              }
              title={passkey.name}
              description={`${passkey.rp_id} · 添加于 ${formatDate(passkey.created_at)}${
                passkey.last_used_at
                  ? ` · 上次使用 ${formatDate(passkey.last_used_at)}`
                  : ''
              }`}
              actions={
                <>
                  <IconButton
                    label="重命名"
                    icon={<Pencil className="size-4" />}
                    onClick={() => open({ kind: 'rename', passkey })}
                  />
                  <IconButton
                    label="删除通行密钥"
                    icon={<Trash2 className="size-4" />}
                    onClick={() => open({ kind: 'remove', passkey })}
                  />
                </>
              }
            />
          ))}
        </ListGroup>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!!unavailable || !list}
          onClick={() => open({ kind: 'add' })}
        >
          <Plus />
          添加通行密钥
        </Button>
      </div>

      <Dialog open={!!mode} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md" autoFocusOnPhone={!needsCode}>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {mode?.kind === 'add'
                  ? '添加通行密钥'
                  : mode?.kind === 'rename'
                    ? '重命名通行密钥'
                    : '删除通行密钥'}
              </DialogTitle>
              <DialogDescription>
                {mode?.kind === 'add'
                  ? needsCode
                    ? '通行密钥可以代替密码和二次验证登录。先输入当前密码和验证器 App 上的验证码确认是你本人。'
                    : '通行密钥可以代替密码登录。先输入当前密码确认是你本人。'
                  : mode?.kind === 'rename'
                    ? '起个能认出设备的名字。'
                    : `删除「${removing?.name ?? ''}」后不能再用它登录。设备上保存的密钥需要在设备的密码管理器里另行删除。输入当前密码确认。`}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-body text-error">
                {error}
              </p>
            )}
            {mode?.kind === 'rename' ? (
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                aria-label="名称"
                maxLength={64}
                autoFocus
              />
            ) : (
              <PasswordInput
                id="passkey-password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="当前密码"
                aria-label="当前密码"
                autoComplete="current-password"
                autoFocus
              />
            )}
            {needsCode && (
              <CodeInput
                id="passkey-code"
                value={code}
                onChange={setCode}
                allowRecovery
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                取消
              </Button>
              <Button
                type="submit"
                variant={removing ? 'destructive' : 'default'}
                disabled={
                  busy || !value.trim() || (needsCode && code.trim().length < 6)
                }
              >
                {busy && <Loader2 className="animate-spin" />}
                {mode?.kind === 'add' ? '继续' : removing ? '删除' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
