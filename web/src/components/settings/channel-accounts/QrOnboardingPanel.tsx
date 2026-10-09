import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  LogOut,
  PlugZap,
  QrCode,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/stores/confirm';
import { wsManager } from '../../../api/ws';
import {
  useChannelAccountsStore,
  type ChannelAccount,
  type ChannelOnboardingState,
} from '../../../stores/channel-accounts';
import { mergeWhatsAppOnboardingState } from '../../../utils/channel-accounts';

interface QrOnboardingPanelProps {
  account: ChannelAccount;
  autoStart?: boolean;
}

export function QrOnboardingPanel({
  account,
  autoStart = false,
}: QrOnboardingPanelProps) {
  const {
    beginOnboarding,
    getOnboardingStatus,
    verifyOnboardingCode,
    disconnectAccount,
    logoutAccount,
  } = useChannelAccountsStore();
  const [onboarding, setOnboarding] = useState<ChannelOnboardingState>(() =>
    initialOnboarding(account),
  );
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<
    'start' | 'verify' | 'disconnect' | 'logout' | null
  >(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const autoStartedRef = useRef(false);
  const whatsappConnectedSyncedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const result = await getOnboardingStatus(account.id);
      setOnboarding(result.onboarding);
      setError(result.onboarding.error ?? null);
      return result.onboarding;
    } catch (err) {
      setError(getApiMessage(err, '无法获取扫码状态，请稍后重试'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [account.id, getOnboardingStatus]);

  const start = useCallback(async () => {
    if (!account.enabled) {
      const message = '账号已停用，请先启用账号再发起扫码连接';
      setError(message);
      toast.error(message);
      return;
    }
    setAction('start');
    setError(null);
    try {
      const result = await beginOnboarding(account.id);
      setOnboarding(result.onboarding);
      if (result.onboarding.transport_status === 'connected') {
        toast.success(
          `${account.provider === 'wechat' ? '微信' : 'WhatsApp'} 已连接`,
        );
      } else if (result.onboarding.auth_status === 'authorized') {
        toast.info('授权有效，已开始连接消息服务');
      }
    } catch (err) {
      const message = getApiMessage(err, '无法发起扫码连接，请稍后重试');
      setError(message);
      toast.error(message);
    } finally {
      setAction(null);
      setLoading(false);
    }
  }, [account.enabled, account.id, account.provider, beginOnboarding]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().then((current) => {
      if (
        !cancelled &&
        account.enabled &&
        autoStart &&
        !autoStartedRef.current &&
        current &&
        (current.auth_status === 'draft' ||
          current.auth_status === 'revoked' ||
          current.status === 'expired')
      ) {
        autoStartedRef.current = true;
        void start();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [account.enabled, autoStart, refresh, start]);

  useEffect(() => {
    if (!shouldPoll(onboarding)) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [onboarding, refresh]);

  useEffect(() => {
    if (
      !onboarding.needsVerifyCode &&
      onboarding.status !== 'need_verifycode'
    ) {
      setVerifyCode('');
    }
  }, [onboarding.needsVerifyCode, onboarding.status]);

  useEffect(() => {
    if (account.provider !== 'whatsapp') return;
    whatsappConnectedSyncedRef.current = false;
    const unsubscribe = wsManager.on(
      'whatsapp_status',
      (event: Partial<ChannelOnboardingState> & { accountId?: string }) => {
        if (event.accountId !== account.id) return;
        const { accountId: _accountId, ...statusEvent } = event;
        void _accountId;
        if (statusEvent.status !== 'connected') {
          whatsappConnectedSyncedRef.current = false;
        } else if (!whatsappConnectedSyncedRef.current) {
          whatsappConnectedSyncedRef.current = true;
          // The websocket updates this panel immediately, but the account-level
          // pairing gate reads the authoritative account in the Zustand store.
          // Reconcile it once before the connected state stops QR polling.
          void refresh().then((current) => {
            if (current?.auth_status !== 'authorized') {
              whatsappConnectedSyncedRef.current = false;
            }
          });
        }
        setOnboarding((current) =>
          mergeWhatsAppOnboardingState(current, statusEvent),
        );
      },
    );
    return () => {
      unsubscribe();
    };
  }, [account.id, account.provider, refresh]);

  useEffect(() => {
    if (account.provider !== 'wechat') return;
    const unsubscribe = wsManager.on(
      'channel_account_status',
      (event: {
        accountId?: string;
        transportStatus?: ChannelOnboardingState['transport_status'];
        lastError?: string | null;
      }) => {
        const transportStatus = event.transportStatus;
        if (event.accountId !== account.id || !transportStatus) return;
        setOnboarding((current) => ({
          ...current,
          transport_status: transportStatus,
          status: transportStatus,
          error: event.lastError ?? undefined,
        }));
        setError(event.lastError ?? null);
      },
    );
    return () => {
      unsubscribe();
    };
  }, [account.id, account.provider]);

  const disconnect = async () => {
    setAction('disconnect');
    setError(null);
    try {
      const result = await disconnectAccount(account.id);
      setOnboarding(result.onboarding);
      toast.success('连接已断开，授权信息已保留');
    } catch (err) {
      const message = getApiMessage(err, '断开连接失败');
      setError(message);
      toast.error(message);
    } finally {
      setAction(null);
    }
  };

  const submitVerifyCode = async () => {
    const normalized = verifyCode.replace(/\D/g, '').slice(0, 12);
    if (!normalized) {
      const message = '请输入微信中显示的数字验证码';
      setError(message);
      return;
    }
    setAction('verify');
    setError(null);
    try {
      const result = await verifyOnboardingCode(account.id, normalized);
      setOnboarding(result.onboarding);
      toast.success('验证码已提交，请在微信中继续确认');
    } catch (err) {
      const message = getApiMessage(err, '验证码提交失败，请检查后重试');
      setError(message);
      toast.error(message);
    } finally {
      setAction(null);
    }
  };

  const logout = async () => {
    const confirmed = await confirmDialog({
      title: '退出登录',
      message: `退出「${account.name}」？本地授权会被清除，下次需要重新扫码。`,
      confirmText: '退出登录',
      variant: 'danger',
    });
    if (!confirmed) return;
    setAction('logout');
    setError(null);
    try {
      const result = await logoutAccount(account.id);
      setOnboarding(result.onboarding);
      toast.success('已退出登录并清除本地授权');
    } catch (err) {
      const message = getApiMessage(err, '退出登录失败');
      setError(message);
      toast.error(message);
    } finally {
      setAction(null);
    }
  };

  const qrImage =
    account.provider === 'wechat' ? onboarding.qrcodeUrl : onboarding.qrDataUrl;
  const authorized = onboarding.auth_status === 'authorized';
  const connected = onboarding.transport_status === 'connected';
  const transportBusy =
    onboarding.transport_status === 'connecting' ||
    onboarding.transport_status === 'reconnecting';

  return (
    <div className="space-y-4">
      <div
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg bg-muted/50 px-4 py-3 ring-1 ring-surface-border"
      >
        {connected ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        ) : loading || action === 'start' || transportBusy ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 text-warning motion-safe:animate-spin" />
        ) : authorized ? (
          <PlugZap className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <QrCode className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="text-body font-medium text-foreground">
            {onboardingStatusLabel(onboarding)}
          </p>
          {account.provider === 'wechat' && (
            <p className="mt-1 text-micro leading-4 text-muted-foreground">
              网络路径：
              {account.options?.bypassProxy !== false
                ? '绕过 HappyClaw HTTP(S) 代理；系统 TUN 或 VPN 仍可能接管'
                : '使用 HappyClaw 启动环境中的 HTTP(S) 代理'}
            </p>
          )}
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            {onboardingHelp(account, onboarding)}
          </p>
          {error && (
            <p
              role={
                onboarding.transport_status === 'reconnecting'
                  ? 'status'
                  : 'alert'
              }
              className={`mt-1 text-caption ${
                onboarding.transport_status === 'reconnecting'
                  ? 'text-warning'
                  : 'text-error'
              }`}
            >
              {onboarding.transport_status === 'reconnecting'
                ? `最近一次连接失败：${error}`
                : error}
            </p>
          )}
        </div>
      </div>

      {qrImage && !authorized && (
        <div className="flex flex-col items-center gap-3 rounded-lg px-4 py-5 ring-1 ring-surface-border">
          {/* QR codes need a white quiet zone to scan in dark mode too. */}
          <div className="size-60 max-w-full overflow-hidden rounded-lg bg-white p-2 ring-1 ring-surface-border">
            <img
              src={qrImage}
              alt={`${account.provider === 'wechat' ? '微信' : 'WhatsApp'} 登录二维码`}
              className="size-full object-contain"
            />
          </div>
          <p className="max-w-sm text-center text-caption leading-5 text-muted-foreground">
            {account.provider === 'wechat'
              ? '请使用微信扫码，并在手机上确认登录。二维码过期后可重新获取。'
              : '打开 WhatsApp → 已关联设备 → 关联设备，然后扫描二维码。'}
          </p>
        </div>
      )}

      {account.provider === 'wechat' &&
        (onboarding.needsVerifyCode ||
          onboarding.status === 'need_verifycode') && (
          <form
            className="space-y-3 rounded-lg bg-warning/10 px-4 py-3 ring-1 ring-warning/30"
            onSubmit={(event) => {
              event.preventDefault();
              void submitVerifyCode();
            }}
          >
            <div>
              <p className="text-body font-medium text-foreground">
                输入微信验证码
              </p>
              <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                微信可能要求二次确认。请输入手机微信中显示的数字验证码；这不是短信验证码，也不会被长期保存。
              </p>
            </div>
            <div className="flex max-w-sm gap-2">
              <Input
                aria-label="微信验证码"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={12}
                value={verifyCode}
                onChange={(event) =>
                  setVerifyCode(
                    event.target.value.replace(/\D/g, '').slice(0, 12),
                  )
                }
                placeholder="输入数字验证码"
                disabled={action === 'verify'}
              />
              <Button
                type="submit"
                disabled={action === 'verify' || !verifyCode}
              >
                {action === 'verify' && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                提交验证码
              </Button>
            </div>
          </form>
        )}

      {account.provider === 'whatsapp' &&
        authorized &&
        (onboarding.meName ||
          onboarding.meJid ||
          onboarding.phoneNumber ||
          account.options?.phoneNumber) && (
          <dl className="grid gap-2 rounded-lg px-4 py-3 text-caption ring-1 ring-surface-border sm:grid-cols-2">
            {onboarding.meName && (
              <div>
                <dt className="text-muted-foreground">账号</dt>
                <dd className="mt-0.5 break-all text-foreground">
                  {onboarding.meName}
                </dd>
              </div>
            )}
            {(onboarding.phoneNumber ||
              account.options?.phoneNumber ||
              onboarding.meJid) && (
              <div>
                <dt className="text-muted-foreground">号码</dt>
                <dd className="mt-0.5 break-all text-foreground">
                  {onboarding.phoneNumber ||
                    account.options?.phoneNumber ||
                    onboarding.meJid}
                </dd>
              </div>
            )}
          </dl>
        )}

      <div className="flex flex-wrap gap-2">
        {!connected && !transportBusy && (
          <Button
            type="button"
            size="sm"
            onClick={() => void start()}
            disabled={!!action || loading}
          >
            {action === 'start' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : authorized ? (
              <PlugZap className="size-3.5" />
            ) : onboarding.auth_status === 'awaiting_scan' ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <QrCode className="size-3.5" />
            )}
            {authorized
              ? '重新连接'
              : onboarding.auth_status === 'awaiting_scan'
                ? '重新获取二维码'
                : '扫码连接'}
          </Button>
        )}
        {transportBusy && (
          <Button type="button" variant="outline" size="sm" disabled>
            <Loader2 className="size-3.5 motion-safe:animate-spin" />
            {onboarding.transport_status === 'reconnecting'
              ? '正在自动重连'
              : '正在连接'}
          </Button>
        )}
        {connected && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void disconnect()}
            disabled={!!action}
          >
            {action === 'disconnect' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Unplug className="size-3.5" />
            )}
            断开连接
          </Button>
        )}
        {onboarding.auth_status !== 'draft' &&
          onboarding.auth_status !== 'revoked' && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void logout()}
              disabled={!!action}
            >
              {action === 'logout' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogOut className="size-3.5" />
              )}
              退出登录
            </Button>
          )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={!!action || loading}
        >
          <RefreshCw
            className={`size-3.5 ${loading ? 'motion-safe:animate-spin' : ''}`}
          />
          刷新状态
        </Button>
      </div>
    </div>
  );
}

function initialOnboarding(account: ChannelAccount): ChannelOnboardingState {
  return {
    auth_mode: account.auth_mode ?? 'qr_session',
    auth_status: account.auth_status ?? 'draft',
    transport_status:
      account.transport_status ??
      (account.status === 'connected' ||
      account.status === 'connecting' ||
      account.status === 'reconnecting' ||
      account.status === 'error'
        ? account.status
        : 'disconnected'),
  };
}

function shouldPoll(state: ChannelOnboardingState) {
  return (
    state.auth_status === 'awaiting_scan' ||
    state.transport_status === 'connecting' ||
    state.transport_status === 'reconnecting' ||
    state.status === 'wait' ||
    state.status === 'scaned' ||
    state.status === 'scaned_but_redirect' ||
    state.status === 'need_verifycode' ||
    state.status === 'verify_code_blocked' ||
    state.status === 'binded_redirect' ||
    state.status === 'expired' ||
    state.status === 'qr'
  );
}

function onboardingStatusLabel(state: ChannelOnboardingState) {
  if (state.auth_status === 'authorized') {
    if (state.transport_status === 'connected') return '已连接';
    if (state.transport_status === 'reconnecting')
      return '网络异常，正在自动重连';
    if (state.transport_status === 'connecting') return '已授权，正在连接';
    if (state.transport_status === 'error') return '连接异常';
    return '已授权，当前离线';
  }
  if (state.status === 'need_verifycode') return '需要微信验证码';
  if (state.status === 'scaned_but_redirect') return '已扫码，正在切换服务';
  if (state.status === 'binded_redirect') return '检测到已绑定账号';
  if (state.status === 'verify_code_blocked') return '验证码校验受限';
  if (state.status === 'expired') return '二维码已过期';
  if (state.auth_status === 'awaiting_scan')
    return state.status === 'scaned' ? '已扫码，等待手机确认' : '等待扫码';
  if (state.auth_status === 'revoked') return '已退出登录';
  if (state.auth_status === 'error' || state.transport_status === 'error')
    return '连接异常';
  if (state.transport_status === 'connecting') return '正在连接';
  return '尚未连接';
}

function onboardingHelp(
  account: ChannelAccount,
  state: ChannelOnboardingState,
) {
  if (state.auth_status === 'authorized') {
    if (state.transport_status === 'connected') return '授权和消息连接均正常。';
    if (state.transport_status === 'reconnecting')
      return '网络暂时不可用，HappyClaw 会持续自动重试。';
    if (state.transport_status === 'connecting')
      return '正在建立消息连接，首次连接可能需要一个长轮询周期。';
    return '授权仍然有效，可以直接重新连接，无需再次扫码。';
  }
  if (state.status === 'need_verifycode')
    return '请在下方输入微信客户端显示的数字验证码。验证码只用于本次扫码确认。';
  if (state.status === 'scaned_but_redirect')
    return '微信正在将扫码流程切换到对应服务节点，HappyClaw 会自动继续轮询。';
  if (state.status === 'binded_redirect')
    return '微信提示该机器人已绑定，HappyClaw 正在恢复本地授权。';
  if (state.status === 'verify_code_blocked')
    return '验证码连续校验失败，系统会自动刷新二维码；若仍失败，请稍后重新扫码。';
  if (state.status === 'expired')
    return '二维码已经失效，请重新获取二维码后扫码。';
  if (state.auth_status === 'awaiting_scan')
    return account.provider === 'wechat'
      ? '二维码由 HappyClaw 向微信申请，扫码结果会自动保存。'
      : '扫码完成后，HappyClaw 会保存关联设备会话。';
  if (state.auth_status === 'revoked') return '本地授权已清除，需要重新扫码。';
  return account.provider === 'wechat'
    ? '点击“扫码连接”获取微信登录二维码。'
    : '点击“扫码连接”关联 WhatsApp 设备。';
}

function getApiMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return fallback;
}
