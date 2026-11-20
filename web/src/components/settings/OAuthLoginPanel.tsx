import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '../../api/client';
import { getErrorMessage, type UnifiedProviderPublic } from './types';

interface OAuthLoginPanelProps {
  service: 'claude' | 'chatgpt' | 'agy';
  /** Logs an existing connection in again instead of creating one. */
  targetProviderId?: string;
  /** The server saved the login; the provider it answered with, if any. */
  onSuccess: (provider: UnifiedProviderPublic | null) => void;
}

const COPY = {
  claude: {
    start: '/api/config/claude/oauth/start',
    callback: '/api/config/claude/oauth/callback',
    login: '登录 Claude',
    relogin: '重新登录 Claude',
    intro:
      '打开 claude.ai 授权页，完成授权后把页面上显示的授权码（或回调页完整地址）粘贴回来。',
    waiting:
      '授权窗口已打开。在 Claude 完成授权后，把页面上显示的授权码粘贴到下方。',
    placeholder: '粘贴授权码或回调页地址',
    inputLabel: '粘贴授权码',
    startError: 'Claude 授权启动失败',
    exchangeError: 'Claude 授权码换取失败',
  },
  chatgpt: {
    start: '/api/config/codex/oauth/start',
    callback: '/api/config/codex/oauth/callback',
    login: '登录 ChatGPT',
    relogin: '重新登录 ChatGPT',
    intro:
      '打开 ChatGPT 登录页（需要 Plus / Pro / Team 订阅）。授权后浏览器会跳到 localhost:1455，这个页面打不开是正常的，把地址栏的完整地址粘贴回来即可。',
    waiting:
      '授权窗口已打开。在 ChatGPT 完成登录后，把跳转页面的完整地址粘贴到下方。',
    placeholder: '粘贴 localhost:1455（或 127.0.0.1:1455）回调完整地址',
    inputLabel: '粘贴 localhost:1455 回调完整地址',
    startError: 'ChatGPT 授权启动失败',
    exchangeError: 'ChatGPT 授权码换取失败',
  },
  agy: {
    start: '/api/config/agy/oauth/start',
    callback: '/api/config/agy/oauth/callback',
    login: '登录 Antigravity',
    relogin: '重新登录 Antigravity',
    intro:
      '打开 Google 授权页登录 Antigravity 账号。授权凭据将保存在独立隔离目录中（不依赖宿主机默认登录），支持宿主机、Docker 容器与群聊。',
    waiting:
      '授权窗口已打开。完成 Google 登录后，把回调页显示的授权码或完整页面地址粘贴到下方。',
    placeholder: '粘贴授权码或 antigravity.google/oauth-callback 完整地址',
    inputLabel: '粘贴授权码或回调完整地址',
    startError: 'Antigravity 授权启动失败',
    exchangeError: 'Antigravity 授权换取失败',
  },
} as const;

/**
 * The paste-back OAuth login both subscriptions use: open the vendor's page,
 * paste the code (or callback URL) here, and the server stores the login.
 */
export function OAuthLoginPanel({
  service,
  targetProviderId,
  onSuccess,
}: OAuthLoginPanelProps) {
  const copy = COPY[service];
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 'setup_token' = 1 年期、仅推理权限（与 claude setup-token 相同）
  const start = async (profile?: 'setup_token') => {
    setStarting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (targetProviderId) body.targetProviderId = targetProviderId;
      if (profile) body.profile = profile;
      const data = await api.post<{ authorizeUrl: string; state: string }>(
        copy.start,
        Object.keys(body).length > 0 ? body : undefined,
      );
      setPendingState(data.state);
      setCode('');
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, copy.startError));
    } finally {
      setStarting(false);
    }
  };

  const exchange = async () => {
    if (!pendingState || !code.trim()) return;
    setExchanging(true);
    setError(null);
    try {
      const provider = await api.post<UnifiedProviderPublic | undefined>(
        copy.callback,
        { state: pendingState, code: code.trim() },
        60_000,
      );
      setPendingState(null);
      setCode('');
      onSuccess(provider && 'id' in provider ? provider : null);
    } catch (err) {
      // A definitive rejection consumed the flow server-side; only transient
      // failures (retryable) can be retried with the same code.
      const retryable = (err as { body?: { retryable?: unknown } })?.body
        ?.retryable;
      if (retryable === false) {
        setPendingState(null);
        setCode('');
      }
      setError(getErrorMessage(err, copy.exchangeError));
    } finally {
      setExchanging(false);
    }
  };

  return (
    <div className="space-y-3">
      {!pendingState ? (
        <>
          <p className="text-caption leading-5 text-muted-foreground">
            {copy.intro}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={targetProviderId ? 'outline' : 'default'}
              onClick={() => void start()}
              disabled={starting}
            >
              {starting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ExternalLink />
              )}
              {targetProviderId ? copy.relogin : copy.login}
            </Button>
            {service === 'claude' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void start('setup_token')}
                disabled={starting}
                title="与 claude setup-token 相同：1 年有效、仅推理权限，不支持用量查询"
              >
                改为获取 1 年期 Setup Token
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <div className="rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning">
            {copy.waiting}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              variant="code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void exchange();
                }
              }}
              disabled={exchanging}
              placeholder={copy.placeholder}
              aria-label={copy.inputLabel}
              autoComplete="off"
              className="min-w-0 flex-1"
            />
            <div className="flex gap-2">
              <Button
                onClick={() => void exchange()}
                disabled={exchanging || !code.trim()}
                className="flex-1 sm:flex-none"
              >
                {exchanging && <Loader2 className="animate-spin" />}
                确认
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPendingState(null);
                  setCode('');
                  setError(null);
                }}
                disabled={exchanging}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption leading-5 text-error">
          {error}
        </p>
      )}
    </div>
  );
}
