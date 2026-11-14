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
import { api } from '../../api/client';
import { apiErrorBody } from '../../utils/error';
import { SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';

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
  unavailable_reason: 'no_origin' | 'insecure' | 'not_allowed' | null;
}

const UNAVAILABLE: Record<string, string> = {
  insecure:
    '通行密钥只能在 HTTPS 域名（或 localhost）下使用。当前是 HTTP 地址，请改用 HTTPS 域名访问。',
  not_allowed:
    '当前地址未被允许使用通行密钥。经反向代理访问时，请管理员把公网地址加入 CORS_ALLOWED_ORIGINS。',
  unsupported: '这个浏览器不支持通行密钥。',
};

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '通行密钥';
}

const formatDate = (value: string) => new Date(value).toLocaleDateString();

/** 设置 > 安全: passkeys that sign in without a password. */
export function PasskeySection() {
  const [list, setList] = useState<PasskeyList | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function';
  const unavailable = !window.isSecureContext
    ? 'insecure'
    : !supported
      ? 'unsupported'
      : list?.unavailable_reason === 'insecure' ||
          list?.unavailable_reason === 'not_allowed'
        ? list.unavailable_reason
        : null;

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

  const add = async () => {
    setAdding(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const optionsJSON = await api.post<never>(
        '/api/auth/passkeys/options',
        {},
      );
      const response = await startRegistration({ optionsJSON });
      await api.post('/api/auth/passkeys', { response, name: defaultName() });
      toast.success('通行密钥已添加');
      await load();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') return;
      if (name === 'InvalidStateError') {
        toast.error('这台设备上已经有本站的通行密钥');
        return;
      }
      const code = apiErrorBody(err)?.code;
      toast.error(
        code === 'PASSKEY_INVALID'
          ? '通行密钥验证失败'
          : getErrorMessage(err, '添加失败'),
      );
    } finally {
      setAdding(false);
    }
  };

  const openRename = (passkey: Passkey) => {
    setValue(passkey.name);
    setError(null);
    setRenaming(passkey);
  };

  const openRemove = (passkey: Passkey) => {
    setValue('');
    setError(null);
    setRemoving(passkey);
  };

  const closeDialog = () => {
    setRenaming(null);
    setRemoving(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = renaming ?? removing;
    if (!target) return;
    setBusy(true);
    setError(null);
    const id = encodeURIComponent(target.id);
    try {
      if (renaming) {
        await api.patch(`/api/auth/passkeys/${id}`, { name: value.trim() });
      } else {
        await api.post(`/api/auth/passkeys/${id}/delete`, { password: value });
        toast.success('通行密钥已删除');
      }
      closeDialog();
      await load();
    } catch (err) {
      const message = getErrorMessage(err, '操作失败');
      setError(
        message === 'Current password is incorrect' ? '密码不正确' : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const passkeys = list?.passkeys ?? [];

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
                    onClick={() => openRename(passkey)}
                  />
                  <IconButton
                    label="删除通行密钥"
                    icon={<Trash2 className="size-4" />}
                    onClick={() => openRemove(passkey)}
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
          disabled={!!unavailable || adding || !list}
          onClick={() => void add()}
        >
          {adding ? <Loader2 className="animate-spin" /> : <Plus />}
          添加通行密钥
        </Button>
      </div>

      <Dialog
        open={!!renaming || !!removing}
        onOpenChange={(next) => !next && closeDialog()}
      >
        <DialogContent className="sm:max-w-md" autoFocusOnPhone>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {renaming ? '重命名通行密钥' : '删除通行密钥'}
              </DialogTitle>
              <DialogDescription>
                {renaming
                  ? '起个能认出设备的名字。'
                  : `删除「${removing?.name ?? ''}」后不能再用它登录。设备上保存的密钥需要在设备的密码管理器里另行删除。输入当前密码确认。`}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-body text-error">
                {error}
              </p>
            )}
            {renaming ? (
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                aria-label="名称"
                maxLength={64}
                autoFocus
              />
            ) : (
              <Input
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="当前密码"
                aria-label="当前密码"
                autoComplete="current-password"
                autoFocus
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog}>
                取消
              </Button>
              <Button
                type="submit"
                variant={removing ? 'destructive' : 'default'}
                disabled={busy || !value.trim()}
              >
                {busy && <Loader2 className="animate-spin" />}
                {removing ? '删除' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
