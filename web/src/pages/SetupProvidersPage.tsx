import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, KeyRound, Loader2, Link2, Plus, Server, ShieldCheck, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';

type ProviderMode = 'official' | 'third_party';

interface EnvRow {
  key: string;
  value: string;
}

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function buildCustomEnv(rows: EnvRow[]): { customEnv: Record<string, string>; error: string | null } {
  const customEnv: Record<string, string> = {};
  for (const [idx, row] of rows.entries()) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key || !value) {
      return { customEnv: {}, error: `第 ${idx + 1} 行环境变量的 Key 和 Value 都要填写` };
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 格式无效（仅允许大写字母/数字/下划线，且不能数字开头）` };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return { customEnv: {}, error: `${key} 属于系统保留字段，请在必填区域填写` };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }
  return { customEnv, error: null };
}

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();

  const [providerMode, setProviderMode] = useState<ProviderMode>('official');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Feishu (no prefilled defaults)
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  // Official mode
  const [officialToken, setOfficialToken] = useState('');

  // OAuth flow state
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [oauthDone, setOauthDone] = useState(false);

  // Third-party mode
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=claude', { replace: true });
    }
  }, [setupStatus, navigate]);

  const addCustomEnvRow = () => setCustomEnvRows((rows) => [...rows, { key: '', value: '' }]);
  const removeCustomEnvRow = (idx: number) =>
    setCustomEnvRows((rows) => rows.filter((_, i) => i !== idx));
  const updateCustomEnvRow = (idx: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((rows) =>
      rows.map((row, i) => (i === idx ? { ...row, [field]: value } : row)),
    );

  const handleOAuthStart = async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const data = await api.post<{ authorizeUrl: string; state: string }>('/api/config/claude/oauth/start');
      setOauthState(data.state);
      setOauthCode('');
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权启动失败'));
    } finally {
      setOauthLoading(false);
    }
  };

  const handleOAuthCallback = async () => {
    if (!oauthState || !oauthCode.trim()) {
      setError('请粘贴授权码');
      return;
    }
    setOauthExchanging(true);
    setError(null);
    try {
      await api.post('/api/config/claude/oauth/callback', {
        state: oauthState,
        code: oauthCode.trim(),
      });
      setOauthState(null);
      setOauthCode('');
      setOauthDone(true);
      setNotice('Claude OAuth 登录成功，token 已保存。');
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  };

  const handleFinish = async () => {
    setError(null);
    setNotice(null);

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }

    let customEnv: Record<string, string> = {};
    if (providerMode === 'third_party') {
      if (!baseUrl.trim()) {
        setError('第三方渠道必须填写 ANTHROPIC_BASE_URL');
        return;
      }
      if (!authToken.trim()) {
        setError('第三方渠道必须填写 ANTHROPIC_AUTH_TOKEN');
        return;
      }
      const envResult = buildCustomEnv(customEnvRows);
      if (envResult.error) {
        setError(envResult.error);
        return;
      }
      customEnv = envResult.customEnv;
    } else if (!officialToken.trim() && !oauthDone) {
      setError('官方渠道请通过一键登录或手动填写 setup-token / .credentials.json');
      return;
    }

    setSaving(true);
    try {
      // Feishu is optional. Only save when user entered anything.
      if (feishuAppId.trim() || feishuAppSecret.trim()) {
        const payload: Record<string, string> = { appId: feishuAppId.trim() };
        if (feishuAppSecret.trim()) payload.appSecret = feishuAppSecret.trim();
        await api.put('/api/config/feishu', payload);
      }

      if (providerMode === 'official') {
        if (oauthDone) {
          // OAuth already saved the token via /oauth/callback — just clear base URL and custom env
          await api.put('/api/config/claude', { anthropicBaseUrl: '' });
          await api.put('/api/config/claude/custom-env', { customEnv: {} });
        } else {
          await api.put('/api/config/claude', { anthropicBaseUrl: '' });

          // Detect if user pasted .credentials.json content
          const trimmed = officialToken.trim();
          let isCredentialsJson = false;
          if (trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed) as Record<string, unknown>;
              const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
              if (oauth?.accessToken && oauth?.refreshToken) {
                isCredentialsJson = true;
                await api.put('/api/config/claude/secrets', {
                  claudeOAuthCredentials: {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  },
                  clearAnthropicAuthToken: true,
                  clearAnthropicApiKey: true,
                  clearClaudeCodeOauthToken: true,
                });
              }
            } catch {
              // Not valid JSON, treat as setup-token
            }
          }

          if (!isCredentialsJson) {
            await api.put('/api/config/claude/secrets', {
              claudeCodeOauthToken: trimmed,
              clearAnthropicAuthToken: true,
              clearAnthropicApiKey: true,
            });
          }
          await api.put('/api/config/claude/custom-env', { customEnv: {} });
        }
      } else {
        await api.put('/api/config/claude', { anthropicBaseUrl: baseUrl.trim() });
        await api.put('/api/config/claude/secrets', {
          anthropicAuthToken: authToken.trim(),
          clearClaudeCodeOauthToken: true,
          clearAnthropicApiKey: true,
        });
        await api.put('/api/config/claude/custom-env', { customEnv });
      }

      await checkAuth();
      // 确认 setupStatus 已更新后再跳转，避免 AuthGuard 检测到 needsSetup 仍为 true 导致重定向循环
      const { setupStatus: latestStatus } = useAuthStore.getState();
      if (latestStatus?.needsSetup) {
        setError('配置已保存但验证未通过，请检查填写的配置是否正确');
        return;
      }
      navigate('/settings?tab=claude', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存初始化配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen bg-slate-50 overflow-y-auto p-4">
      <div className="w-full max-w-4xl mx-auto space-y-5">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">STEP 2 / 2</p>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">系统接入初始化</h1>
          <p className="text-sm text-slate-600">此页面保存的是系统全局默认配置。完成后才进入正式后台。</p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
        )}
        {notice && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">{notice}</div>
        )}

        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-slate-900">飞书配置（可选）</h2>
          </div>
          <p className="text-xs text-slate-500 mb-3">首装不预填任何默认值，全部由你手动输入。</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">App ID</label>
              <Input
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="输入飞书 App ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">App Secret</label>
              <Input
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="输入飞书 App Secret"
              />
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-slate-900">Claude Code 配置（二选一）</h2>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 p-1 bg-slate-50 mb-4">
            <button
              type="button"
              onClick={() => setProviderMode('official')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerMode === 'official' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'
              }`}
            >
              官方渠道
            </button>
            <button
              type="button"
              onClick={() => setProviderMode('third_party')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerMode === 'third_party' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'
              }`}
            >
              第三方渠道
            </button>
          </div>

          {providerMode === 'official' ? (
            <div className="space-y-4">
              {/* OAuth one-click login */}
              <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                <div className="text-sm font-medium text-slate-800">一键登录 Claude（推荐）</div>
                <div className="text-xs text-slate-600">
                  点击按钮后会打开 claude.ai 授权页面，完成授权后将页面上显示的授权码粘贴回来。
                </div>

                {oauthDone ? (
                  <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                    OAuth 登录成功，点击下方按钮完成配置。
                  </div>
                ) : !oauthState ? (
                  <Button onClick={handleOAuthStart} disabled={oauthLoading || saving}>
                    {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                    一键登录 Claude
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      授权窗口已打开，请在 claude.ai 完成授权后，将页面上显示的授权码粘贴到下方。
                    </div>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        value={oauthCode}
                        onChange={(e) => setOauthCode(e.target.value)}
                        disabled={oauthExchanging}
                        placeholder="粘贴授权码"
                        className="flex-1"
                      />
                      <Button onClick={handleOAuthCallback} disabled={oauthExchanging || !oauthCode.trim()}>
                        {oauthExchanging && <Loader2 className="size-4 animate-spin" />}
                        确认
                      </Button>
                      <Button variant="outline" onClick={() => { setOauthState(null); setOauthCode(''); }}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="relative flex items-center gap-3 text-xs text-slate-400">
                <div className="flex-1 border-t border-slate-200" />
                或手动粘贴 setup-token
                <div className="flex-1 border-t border-slate-200" />
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="font-medium mb-2">获取凭据</div>
                <ol className="list-decimal ml-5 space-y-1 text-xs">
                  <li>在目标机器安装 Claude Code CLI（若未安装）。</li>
                  <li>在终端执行 <code>claude login</code> 完成账号登录。</li>
                  <li>
                    方式 A：执行 <code>cat ~/.claude/.credentials.json</code>，复制完整 JSON 内容到下方（推荐，支持自动续期）。
                  </li>
                  <li>
                    方式 B：执行 <code>claude setup-token</code>，复制输出 token 到下方。
                  </li>
                </ol>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  setup-token 或 .credentials.json
                </label>
                <Input
                  type="password"
                  value={officialToken}
                  onChange={(e) => setOfficialToken(e.target.value)}
                  placeholder="粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出"
                />
                <p className="text-xs text-slate-400 mt-1">
                  支持粘贴 <code className="bg-slate-100 px-1 rounded">cat ~/.claude/.credentials.json</code> 的 JSON 内容（含自动续期）
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Server className="w-4 h-4 text-primary" />
                第三方渠道会写入系统全局默认环境变量。必填项为 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN。
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">ANTHROPIC_BASE_URL（必填）</label>
                  <Input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://your-relay.example.com/v1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">ANTHROPIC_AUTH_TOKEN（必填）</label>
                  <Input
                    type="password"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                    placeholder="输入第三方网关 Token"
                  />
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-slate-600">其他自定义环境变量（可选）</label>
                  <button
                    type="button"
                    onClick={addCustomEnvRow}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    添加
                  </button>
                </div>

                {customEnvRows.length === 0 ? (
                  <p className="text-xs text-slate-400">暂无</p>
                ) : (
                  <div className="space-y-2">
                    {customEnvRows.map((row, idx) => (
                      <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        <Input
                          type="text"
                          value={row.key}
                          onChange={(e) => updateCustomEnvRow(idx, 'key', e.target.value)}
                          placeholder="KEY"
                          className="w-full sm:w-[38%] px-2.5 py-1.5 text-xs font-mono h-auto"
                        />
                        <Input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateCustomEnvRow(idx, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-1 px-2.5 py-1.5 text-xs font-mono h-auto"
                        />
                        <button
                          type="button"
                          onClick={() => removeCustomEnvRow(idx)}
                          className="w-8 h-8 rounded-md hover:bg-slate-100 text-slate-400 hover:text-red-500 flex items-center justify-center cursor-pointer"
                          aria-label="删除环境变量"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-slate-600 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            当前页保存的数据会作为系统全局默认配置，后续可在后台设置页继续修改。
          </div>
          <Button onClick={handleFinish} disabled={saving} className="min-w-64">
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存全局默认并进入后台
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
