import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, KeyRound, Loader2, Link2, Plus, Server, ShieldCheck, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';
import type {
  UnifiedProviderPublic,
  EnvRow,
} from '../components/settings/types';
import { getErrorMessage } from '../components/settings/types';
import { useAuthStore } from '../stores/auth';

type ProviderMode = 'official' | 'third_party';
type ProviderRuntime = 'claude' | 'codex';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'HAPPYCLAW_RUNTIME',
  'HAPPYCLAW_CODEX_MODEL',
]);

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
  const [providerRuntime, setProviderRuntime] = useState<ProviderRuntime>('claude');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Feishu (no prefilled defaults)
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  // Official mode
  type OfficialTab = 'oauth' | 'setup-token' | 'api-key';
  const [officialTab, setOfficialTab] = useState<OfficialTab>('oauth');
  const [officialToken, setOfficialToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [codexAuthJson, setCodexAuthJson] = useState('');
  const [codexOauthReady, setCodexOauthReady] = useState(false);
  const [codexOauthImporting, setCodexOauthImporting] = useState(false);
  const [codexImportedProviderId, setCodexImportedProviderId] = useState<string | null>(null);

  // OAuth flow state
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [oauthDone, setOauthDone] = useState(false);

  // Third-party mode
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [model, setModel] = useState('');
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
        setError(providerRuntime === 'codex' ? '第三方渠道必须填写 OPENAI_BASE_URL' : '第三方渠道必须填写 ANTHROPIC_BASE_URL');
        return;
      }
      if (!(providerRuntime === 'codex' ? apiKey.trim() : authToken.trim())) {
        setError(providerRuntime === 'codex' ? '第三方渠道必须填写 OpenAI API Key' : '第三方渠道必须填写 ANTHROPIC_AUTH_TOKEN');
        return;
      }
      const envResult = buildCustomEnv(customEnvRows);
      if (envResult.error) {
        setError(envResult.error);
        return;
      }
      customEnv = envResult.customEnv;
    } else if (providerRuntime === 'claude' && !officialToken.trim() && !apiKey.trim() && !oauthDone) {
      setError('官方渠道请通过一键登录、填写 API Key 或手动填写 setup-token / .credentials.json');
      return;
    } else if (
      providerRuntime === 'codex' &&
      officialTab === 'api-key' &&
      !apiKey.trim()
    ) {
      setError('Codex 官方渠道请填写 OpenAI API Key');
      return;
    } else if (
      providerRuntime === 'codex' &&
      officialTab === 'oauth' &&
      !codexOauthReady &&
      !codexAuthJson.trim()
    ) {
      setError('Codex OAuth 请先导入本机登录态或粘贴 auth.json');
      return;
    }

    setSaving(true);
    try {
      // Feishu is optional. Only save when user entered anything.
      if (feishuAppId.trim() || feishuAppSecret.trim()) {
        const payload: Record<string, string> = { appId: feishuAppId.trim() };
        if (feishuAppSecret.trim()) payload.appSecret = feishuAppSecret.trim();
        await api.put('/api/config/user-im/feishu', payload);
      }

      if (providerRuntime === 'codex') {
        if (providerMode === 'official' && officialTab === 'oauth' && codexOauthReady) {
          if (codexImportedProviderId && model.trim()) {
            await api.patch(`/api/config/claude/providers/${codexImportedProviderId}`, {
              codexModel: model.trim(),
            });
          }
        } else {
          await api.post<UnifiedProviderPublic>(
            '/api/config/claude/providers',
            {
              name: providerMode === 'official' ? `官方 Codex (${officialTab === 'oauth' ? 'OAuth' : 'API Key'})` : 'Codex 兼容提供商',
              runtime: 'codex',
              type: providerMode,
              ...(providerMode === 'third_party' ? { openaiBaseUrl: baseUrl.trim() } : {}),
              ...(providerMode === 'official' && officialTab === 'oauth'
                ? { codexAuthJson: codexAuthJson.trim() }
                : { openaiApiKey: apiKey.trim() }),
              codexModel: model.trim(),
              customEnv,
              enabled: true,
            },
          );
        }
      } else if (providerMode === 'official') {
        if (oauthDone) {
          // OAuth already created the provider via callback — nothing to do
        } else if (apiKey.trim()) {
          // API Key mode — create official provider
          await api.post('/api/config/claude/providers', {
            name: '官方 Claude (API Key)',
            runtime: 'claude',
            type: 'official',
            anthropicApiKey: apiKey.trim(),
            enabled: true,
          });
        } else {
          // Setup token or .credentials.json
          const trimmed = officialToken.trim();
          let created = false;
          if (trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed) as Record<string, unknown>;
              const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
              if (oauth?.accessToken && oauth?.refreshToken) {
                created = true;
                await api.post('/api/config/claude/providers', {
                  name: '官方 Claude (OAuth)',
                  runtime: 'claude',
                  type: 'official',
                  claudeOAuthCredentials: {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  },
                  enabled: true,
                });
              }
            } catch {
              // Not valid JSON, treat as setup-token
            }
          }

          if (!created) {
            await api.post('/api/config/claude/providers', {
              name: '官方 Claude (Setup Token)',
              runtime: 'claude',
              type: 'official',
              claudeCodeOauthToken: trimmed,
              enabled: true,
            });
          }
        }
      } else {
        await api.post<UnifiedProviderPublic>(
          '/api/config/claude/providers',
          {
            name: '默认第三方',
            runtime: 'claude',
            type: 'third_party',
            anthropicBaseUrl: baseUrl.trim(),
            anthropicAuthToken: authToken.trim(),
            anthropicModel: model.trim(),
            customEnv,
            enabled: true,
          },
        );
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

  const handleCodexOAuthImport = async () => {
    setCodexOauthImporting(true);
    setError(null);
    try {
      const provider = await api.post<UnifiedProviderPublic>('/api/config/codex/oauth/import-local', {});
      setCodexImportedProviderId(provider.id);
      setCodexOauthReady(true);
      setNotice('已导入当前服务器的 Codex 登录态。');
    } catch (err) {
      setError(getErrorMessage(err, '导入 Codex 登录态失败'));
    } finally {
      setCodexOauthImporting(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-4xl mx-auto space-y-5">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">STEP 2 / 2</p>
          <h1 className="text-2xl font-bold text-foreground mb-2">系统接入初始化</h1>
          <p className="text-sm text-muted-foreground">此页面保存的是系统全局默认配置。完成后才进入正式后台。</p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-error-bg border border-error/30 text-error text-sm">{error}</div>
        )}
        {notice && (
          <div className="p-3 rounded-lg bg-success-bg border border-success/30 text-success text-sm">{notice}</div>
        )}

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">飞书配置（可选）</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-3">首装不预填任何默认值，全部由你手动输入。</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">App ID</label>
              <Input
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="输入飞书 App ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">App Secret</label>
              <Input
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="输入飞书 App Secret"
              />
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">Agent 运行时配置</h2>
          </div>

          <div className="inline-flex rounded-lg border border-border p-1 bg-muted mb-3">
            <button
              type="button"
              onClick={() => setProviderRuntime('claude')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerRuntime === 'claude' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
              }`}
            >
              Claude
            </button>
            <button
              type="button"
              onClick={() => {
                setProviderRuntime('codex');
                setOfficialTab('oauth');
              }}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerRuntime === 'codex' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
              }`}
            >
              Codex
            </button>
          </div>

          <div className="inline-flex rounded-lg border border-border p-1 bg-muted mb-4">
            <button
              type="button"
              onClick={() => setProviderMode('official')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerMode === 'official' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
              }`}
            >
              官方渠道
            </button>
            <button
              type="button"
              onClick={() => setProviderMode('third_party')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                providerMode === 'third_party' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
              }`}
            >
              第三方渠道
            </button>
          </div>

          {providerMode === 'official' ? (
            <div className="space-y-4">
              {providerRuntime === 'claude' && (
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  <button
                    type="button"
                    onClick={() => setOfficialTab('oauth')}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                      officialTab === 'oauth' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    OAuth 登录
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfficialTab('setup-token')}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                      officialTab === 'setup-token' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    Setup Token
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfficialTab('api-key')}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                      officialTab === 'api-key' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    API Key
                  </button>
                </div>
              )}

              {providerRuntime === 'codex' && (
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  <button
                    type="button"
                    onClick={() => setOfficialTab('oauth')}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                      officialTab === 'oauth' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    OAuth 登录
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfficialTab('api-key')}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                      officialTab === 'api-key' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    API Key
                  </button>
                </div>
              )}

              {providerRuntime === 'claude' && officialTab === 'oauth' && (
                <>
                  {/* OAuth one-click login */}
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
                    <div className="text-sm font-medium text-foreground">一键登录 Claude（推荐）</div>
                    <div className="text-xs text-muted-foreground">
                      点击按钮后会打开 claude.ai 授权页面，完成授权后将页面上显示的授权码粘贴回来。
                    </div>

                    {oauthDone ? (
                      <div className="text-sm bg-success-bg border border-success/30 text-success rounded-md px-3 py-2">
                        OAuth 登录成功，点击下方按钮完成配置。
                      </div>
                    ) : !oauthState ? (
                      <Button onClick={handleOAuthStart} disabled={oauthLoading || saving}>
                        {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                        一键登录 Claude
                      </Button>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-xs bg-warning-bg border border-warning/30 text-warning rounded-md px-3 py-2">
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
                </>
              )}

              {providerRuntime === 'claude' && officialTab === 'setup-token' && (
                <>
                  <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
                    <div className="font-medium mb-2">获取凭据</div>
                    <ol className="list-decimal ml-5 space-y-1 text-xs text-muted-foreground">
                      <li>在目标机器安装 Claude Code CLI（若未安装）。</li>
                      <li>在终端执行 <code>claude login</code> 完成账号登录。</li>
                      <li>
                        方式 A：执行 <code>cat ~/.claude/.credentials.json</code>，复制完整 JSON 内容到下方（推荐）。
                      </li>
                      <li>
                        方式 B：执行 <code>claude setup-token</code>，复制输出 token 到下方。
                      </li>
                    </ol>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      setup-token 或 .credentials.json
                    </label>
                    <Input
                      type="password"
                      value={officialToken}
                      onChange={(e) => setOfficialToken(e.target.value)}
                      placeholder="粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      支持粘贴 <code className="bg-muted px-1 rounded">cat ~/.claude/.credentials.json</code> 的 JSON 内容
                    </p>
                  </div>
                </>
              )}

              {providerRuntime === 'codex' && officialTab === 'oauth' && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
                    <div className="font-medium mb-2">Codex ChatGPT 登录</div>
                    <ol className="list-decimal ml-5 space-y-1 text-xs text-muted-foreground">
                      <li>在当前服务器执行 <code>codex login</code> 完成 ChatGPT 登录。</li>
                      <li>点击下方按钮直接导入 <code>~/.codex/auth.json</code>。</li>
                      <li>如果不是同一台机器，也可以手动粘贴 <code>auth.json</code> 内容。</li>
                    </ol>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button onClick={handleCodexOAuthImport} disabled={codexOauthImporting || saving}>
                      {codexOauthImporting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                      导入本机 Codex 登录态
                    </Button>
                    {codexOauthReady && (
                      <span className="text-xs text-success">已导入，可直接完成配置</span>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">auth.json（可选，手动粘贴）</label>
                    <textarea
                      value={codexAuthJson}
                      onChange={(e) => setCodexAuthJson(e.target.value)}
                      placeholder="粘贴 ~/.codex/auth.json 内容"
                      className="w-full min-h-32 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">Codex 模型（可选）</label>
                    <Input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="gpt-5.4"
                      className="font-mono"
                    />
                  </div>
                </div>
              )}

              {((providerRuntime === 'claude' && officialTab === 'api-key') || (providerRuntime === 'codex' && officialTab === 'api-key')) && (
                <>
                  <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
                    <div className="font-medium mb-2">
                      {providerRuntime === 'codex' ? 'OpenAI API Key' : 'Anthropic API Key'}
                    </div>
                    {providerRuntime === 'claude' ? (
                      <ol className="list-decimal ml-5 space-y-1 text-xs text-muted-foreground">
                        <li>
                          前往{' '}
                          <a
                            href="https://console.anthropic.com/settings/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline"
                          >
                            console.anthropic.com
                          </a>{' '}
                          创建 API Key。
                        </li>
                        <li>将以 <code>sk-ant-api03-</code> 开头的 Key 粘贴到下方。</li>
                      </ol>
                    ) : (
                      <ol className="list-decimal ml-5 space-y-1 text-xs text-muted-foreground">
                        <li>前往 OpenAI 平台创建 API Key。</li>
                        <li>将以 <code>sk-</code> 开头的 Key 粘贴到下方。</li>
                      </ol>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      {providerRuntime === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}
                    </label>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={providerRuntime === 'codex' ? 'sk-...' : 'sk-ant-api03-...'}
                      className="font-mono"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {providerRuntime === 'codex'
                        ? '直接使用 OpenAI API Key 调用 Codex'
                        : '直接使用 Anthropic 官方 API Key 调用 Claude'}
                    </p>
                  </div>

                  {providerRuntime === 'codex' && (
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">Codex 模型（可选）</label>
                      <Input
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="gpt-5.4"
                        className="font-mono"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Server className="w-4 h-4 text-primary" />
                {providerRuntime === 'codex'
                  ? '第三方 Codex 兼容渠道需要填写 OPENAI_BASE_URL 和 OpenAI API Key。'
                  : '第三方 Claude 渠道会写入系统全局默认环境变量。必填项为 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN。'}
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {providerRuntime === 'codex' ? 'OPENAI_BASE_URL（必填）' : 'ANTHROPIC_BASE_URL（必填）'}
                  </label>
                  <Input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://your-relay.example.com/v1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {providerRuntime === 'codex' ? 'Codex 模型（可选）' : 'ANTHROPIC_MODEL（可选）'}
                  </label>
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={providerRuntime === 'codex' ? 'gpt-5.4' : 'opus[1m] / opus / sonnet[1m] / sonnet / haiku'}
                    className="font-mono"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {providerRuntime === 'codex' ? 'OPENAI_API_KEY（必填）' : 'ANTHROPIC_AUTH_TOKEN（必填）'}
                  </label>
                  <Input
                    type="password"
                    value={providerRuntime === 'codex' ? apiKey : authToken}
                    onChange={(e) => providerRuntime === 'codex' ? setApiKey(e.target.value) : setAuthToken(e.target.value)}
                    placeholder={providerRuntime === 'codex' ? '输入 OpenAI API Key' : '输入第三方网关 Token'}
                  />
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-muted-foreground">其他自定义环境变量（可选）</label>
                  <button
                    type="button"
                    onClick={addCustomEnvRow}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    添加
                  </button>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">
                  这些变量属于系统全局设置，后续切换第三方配置时不会跟随切换。
                </p>

                {customEnvRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无</p>
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
                          className="w-8 h-8 rounded-md hover:bg-muted text-muted-foreground hover:text-error flex items-center justify-center cursor-pointer"
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

        <div className="bg-card rounded-xl border border-border shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-muted-foreground flex items-start gap-2">
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
