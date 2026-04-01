import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Key, Loader2, Plus, X } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { ProviderWithHealth, EnvRow } from './types';
import { getErrorMessage } from './types';

type ProviderRuntime = 'claude' | 'codex';
type ProviderType = 'official' | 'third_party';
type ClaudeAuthTab = 'oauth' | 'setup_token' | 'api_key';
type CodexAuthTab = 'oauth' | 'api_key';

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
    const value = row.value;

    if (!key && !value.trim()) continue;

    if (!key) {
      return { customEnv: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        customEnv: {},
        error: `环境变量 Key "${key}" 格式无效（需匹配 [A-Za-z_][A-Za-z0-9_]*）`,
      };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return { customEnv: {}, error: `${key} 属于系统保留字段，请在配置表单中填写` };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }

  return { customEnv, error: null };
}

interface ProviderEditorProps {
  open: boolean;
  provider: ProviderWithHealth | null;
  onSave: () => void;
  onCancel: () => void;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ProviderEditor({
  open,
  provider,
  onSave,
  onCancel,
  setNotice,
  setError,
}: ProviderEditorProps) {
  const isCreate = provider === null;

  const [providerRuntime, setProviderRuntime] = useState<ProviderRuntime>('claude');
  const [providerType, setProviderType] = useState<ProviderType>('third_party');
  const [claudeAuthTab, setClaudeAuthTab] = useState<ClaudeAuthTab>('oauth');
  const [codexAuthTab, setCodexAuthTab] = useState<CodexAuthTab>('oauth');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [codexAuthJson, setCodexAuthJson] = useState('');
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);
  const [weight, setWeight] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [codexOauthImporting, setCodexOauthImporting] = useState(false);
  const [setupToken, setSetupToken] = useState('');

  useEffect(() => {
    if (!open) return;

    if (isCreate) {
      setProviderRuntime('claude');
      setProviderType('third_party');
      setClaudeAuthTab('oauth');
      setCodexAuthTab('oauth');
      setName('');
      setBaseUrl('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setModel('');
      setApiKey('');
      setCodexAuthJson('');
      setCustomEnvRows([]);
      setWeight(1);
      setShowAdvanced(false);
      setOauthState(null);
      setOauthCode('');
      setSetupToken('');
      return;
    }

    setProviderRuntime(provider.runtime);
    setProviderType(provider.type);
    setClaudeAuthTab('oauth');
    setCodexAuthTab('oauth');
    setName(provider.name);
    setBaseUrl(
      provider.runtime === 'codex' ? (provider.openaiBaseUrl || '') : (provider.anthropicBaseUrl || ''),
    );
    setAuthToken('');
    setAuthTokenDirty(false);
    setClearTokenOnSave(false);
    setModel(provider.runtime === 'codex' ? (provider.codexModel || '') : (provider.anthropicModel || ''));
    setApiKey('');
    setCodexAuthJson('');
    setCustomEnvRows(Object.entries(provider.customEnv || {}).map(([key, value]) => ({ key, value })));
    setWeight(provider.weight);
    setShowAdvanced(provider.weight !== 1);
    setOauthState(null);
    setOauthCode('');
    setSetupToken('');
  }, [open, isCreate, provider]);

  const addRow = () => setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  const handleOAuthStart = useCallback(async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (!isCreate && provider) body.targetProviderId = provider.id;
      const data = await api.post<{ authorizeUrl: string; state: string }>(
        '/api/config/claude/oauth/start',
        Object.keys(body).length > 0 ? body : undefined,
      );
      setOauthState(data.state);
      setOauthCode('');
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权启动失败'));
    } finally {
      setOauthLoading(false);
    }
  }, [isCreate, provider, setError]);

  const handleOAuthCallback = useCallback(async () => {
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
      setNotice('OAuth 登录成功，凭据已保存。');
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  }, [oauthState, oauthCode, setError, setNotice, onSave]);

  const handleCodexOAuthImport = useCallback(async () => {
    setCodexOauthImporting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (!isCreate && provider) body.targetProviderId = provider.id;
      const imported = await api.post<ProviderWithHealth | { id: string }>(
        '/api/config/codex/oauth/import-local',
        Object.keys(body).length > 0 ? body : undefined,
      );
      if (isCreate) {
        const patchBody: Record<string, unknown> = {};
        if (name.trim()) patchBody.name = name.trim();
        if (model.trim()) patchBody.codexModel = model.trim();
        const envResult = buildCustomEnv(customEnvRows);
        if (!envResult.error) patchBody.customEnv = envResult.customEnv;
        if (weight !== 1) patchBody.weight = weight;
        if (Object.keys(patchBody).length > 0) {
          await api.patch(`/api/config/claude/providers/${imported.id}`, patchBody);
        }
      }
      setNotice('Codex 登录态已导入。');
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, '导入 Codex 登录态失败'));
    } finally {
      setCodexOauthImporting(false);
    }
  }, [isCreate, provider, setError, setNotice, onSave, name, model, customEnvRows, weight]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写提供商名称');
      return;
    }

    const envResult = buildCustomEnv(customEnvRows);
    if (envResult.error) {
      setError(envResult.error);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        const createBody: Record<string, unknown> = {
          name: trimmedName,
          runtime: providerRuntime,
          type: providerType,
          customEnv: envResult.customEnv,
          weight,
        };

        if (providerRuntime === 'claude') {
          if (providerType === 'third_party') {
            if (!baseUrl.trim()) throw new Error('请填写 ANTHROPIC_BASE_URL');
            if (!authToken.trim()) throw new Error('请填写 ANTHROPIC_AUTH_TOKEN');
            createBody.anthropicBaseUrl = baseUrl.trim();
            createBody.anthropicAuthToken = authToken.trim();
          } else if (claudeAuthTab === 'setup_token') {
            const trimmed = setupToken.trim();
            if (!trimmed) throw new Error('请填写 setup-token 或 .credentials.json 内容');
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                if (oauth?.accessToken && oauth?.refreshToken) {
                  createBody.claudeOAuthCredentials = {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  };
                } else {
                  createBody.claudeCodeOauthToken = trimmed;
                }
              } catch {
                createBody.claudeCodeOauthToken = trimmed;
              }
            } else {
              createBody.claudeCodeOauthToken = trimmed;
            }
          } else if (claudeAuthTab === 'api_key') {
            if (!apiKey.trim()) throw new Error('请填写 Anthropic API Key');
            createBody.anthropicApiKey = apiKey.trim();
          }
          if (model.trim()) createBody.anthropicModel = model.trim();
        } else {
          if (codexAuthTab === 'oauth') {
            if (!codexAuthJson.trim()) throw new Error('请填写 auth.json 或导入当前服务器的 Codex 登录态');
            createBody.codexAuthJson = codexAuthJson.trim();
          } else {
            if (!apiKey.trim()) throw new Error('请填写 OpenAI API Key');
            createBody.openaiApiKey = apiKey.trim();
          }
          if (providerType === 'third_party') {
            if (!baseUrl.trim()) throw new Error('请填写 OPENAI_BASE_URL');
            createBody.openaiBaseUrl = baseUrl.trim();
          }
          if (model.trim()) createBody.codexModel = model.trim();
        }

        await api.post('/api/config/claude/providers', createBody);
        setNotice('提供商已创建。');
      } else {
        const patchBody: Record<string, unknown> = {
          name: trimmedName,
          customEnv: envResult.customEnv,
          weight,
        };

        if (providerRuntime === 'claude') {
          if (providerType === 'third_party') {
            patchBody.anthropicBaseUrl = baseUrl.trim();
          }
          patchBody.anthropicModel = model.trim();
        } else {
          patchBody.openaiBaseUrl = baseUrl.trim();
          patchBody.codexModel = model.trim();
        }

        await api.patch(`/api/config/claude/providers/${provider!.id}`, patchBody);

        const secretsBody: Record<string, unknown> = {};
        let hasSecretsChange = false;

        if (providerRuntime === 'claude') {
          if (providerType === 'third_party') {
            if (clearTokenOnSave) {
              secretsBody.clearAnthropicAuthToken = true;
              hasSecretsChange = true;
            } else if (authTokenDirty && authToken.trim()) {
              secretsBody.anthropicAuthToken = authToken.trim();
              hasSecretsChange = true;
            }
          } else if (claudeAuthTab === 'setup_token' && setupToken.trim()) {
            const trimmed = setupToken.trim();
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                if (oauth?.accessToken && oauth?.refreshToken) {
                  secretsBody.claudeOAuthCredentials = {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  };
                  secretsBody.clearAnthropicAuthToken = true;
                  secretsBody.clearAnthropicApiKey = true;
                  secretsBody.clearClaudeCodeOauthToken = true;
                  hasSecretsChange = true;
                }
              } catch {
                /* ignore */
              }
            }
            if (!hasSecretsChange) {
              secretsBody.claudeCodeOauthToken = trimmed;
              secretsBody.clearAnthropicAuthToken = true;
              secretsBody.clearAnthropicApiKey = true;
              hasSecretsChange = true;
            }
          } else if (claudeAuthTab === 'api_key' && apiKey.trim()) {
            secretsBody.anthropicApiKey = apiKey.trim();
            secretsBody.clearAnthropicAuthToken = true;
            secretsBody.clearClaudeCodeOauthToken = true;
            secretsBody.clearClaudeOAuthCredentials = true;
            hasSecretsChange = true;
          }
        } else if (codexAuthTab === 'oauth' && codexAuthJson.trim()) {
          secretsBody.codexAuthJson = codexAuthJson.trim();
          secretsBody.clearOpenAIApiKey = true;
          hasSecretsChange = true;
        } else if (apiKey.trim()) {
          secretsBody.openaiApiKey = apiKey.trim();
          secretsBody.clearCodexAuthJson = true;
          hasSecretsChange = true;
        }

        if (hasSecretsChange) {
          await api.put(`/api/config/claude/providers/${provider!.id}/secrets`, secretsBody);
        }

        setNotice('提供商配置已保存。');
      }

      onSave();
    } catch (err) {
      setError(getErrorMessage(err, isCreate ? '创建提供商失败' : '保存提供商失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving && !oauthExchanging) {
      setOauthState(null);
      onCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? '添加提供商' : `编辑提供商：${provider?.name}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {isCreate && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">运行时</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['claude', 'codex'] as const).map((runtime) => (
                    <button
                      key={runtime}
                      type="button"
                      onClick={() => {
                        setProviderRuntime(runtime);
                        setProviderType(runtime === 'codex' ? 'official' : 'third_party');
                        setClaudeAuthTab('oauth');
                        setCodexAuthTab('oauth');
                      }}
                      className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                        providerRuntime === runtime
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {runtime === 'claude' ? 'Claude' : 'Codex'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">提供商类型</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['official', 'third_party'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setProviderType(type)}
                      className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                        providerType === type
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {type === 'official' ? '官方' : '第三方'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs text-muted-foreground mb-1">名称</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              placeholder={
                providerRuntime === 'codex'
                  ? providerType === 'official'
                    ? '如：Codex 官方'
                    : '如：Codex 兼容网关'
                  : providerType === 'official'
                    ? '如：Claude 官方'
                    : '如：OpenRouter-主账号'
              }
            />
          </div>

          {providerRuntime === 'claude' && providerType === 'official' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-2">认证方式</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['oauth', 'setup_token', 'api_key'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setClaudeAuthTab(tab)}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer ${
                        claudeAuthTab === tab
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {tab === 'oauth' ? 'OAuth 登录' : tab === 'setup_token' ? 'Setup Token' : 'API Key'}
                    </button>
                  ))}
                </div>
              </div>

              {claudeAuthTab === 'oauth' && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                  <div className="text-sm font-medium text-foreground">一键登录 Claude</div>
                  <div className="text-xs text-muted-foreground">
                    打开 claude.ai 授权页，完成授权后将授权码粘贴回来。
                  </div>
                  {!oauthState ? (
                    <Button onClick={handleOAuthStart} disabled={saving || oauthLoading}>
                      {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                      登录 Claude
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        type="text"
                        value={oauthCode}
                        onChange={(e) => setOauthCode(e.target.value)}
                        disabled={oauthExchanging}
                        placeholder="粘贴授权码"
                      />
                      <div className="flex gap-2">
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
              )}

              {claudeAuthTab === 'setup_token' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    setup-token 或 .credentials.json
                  </label>
                  <Input
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    disabled={saving}
                    placeholder="粘贴 setup-token 或 ~/.claude/.credentials.json 内容"
                  />
                </div>
              )}

              {claudeAuthTab === 'api_key' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    <span className="flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5" />
                      ANTHROPIC_API_KEY
                      {!isCreate && provider?.hasAnthropicApiKey
                        ? ` (${provider.anthropicApiKeyMasked})`
                        : ''}
                    </span>
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={saving}
                    placeholder="sk-ant-api03-..."
                    className="font-mono"
                  />
                </div>
              )}
            </div>
          )}

          {providerRuntime === 'claude' && providerType === 'third_party' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">ANTHROPIC_BASE_URL</label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://your-relay.example.com/v1"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  ANTHROPIC_AUTH_TOKEN
                  {!isCreate && provider?.hasAnthropicAuthToken
                    ? ` (${provider.anthropicAuthTokenMasked})`
                    : ''}
                </label>
                <Input
                  type="password"
                  value={authToken}
                  onChange={(e) => {
                    setAuthToken(e.target.value);
                    setAuthTokenDirty(true);
                    setClearTokenOnSave(false);
                  }}
                  disabled={saving || clearTokenOnSave}
                  placeholder="输入 Token"
                />
                {!isCreate && provider?.hasAnthropicAuthToken && (
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={clearTokenOnSave}
                      onChange={(e) => {
                        setClearTokenOnSave(e.target.checked);
                        if (e.target.checked) {
                          setAuthToken('');
                          setAuthTokenDirty(false);
                        }
                      }}
                      disabled={saving}
                    />
                    保存时清空当前 Token
                  </label>
                )}
              </div>
            </div>
          )}

          {providerRuntime === 'codex' && providerType === 'official' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-2">认证方式</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['oauth', 'api_key'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setCodexAuthTab(tab)}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer ${
                        codexAuthTab === tab
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {tab === 'oauth' ? 'OAuth 登录' : 'API Key'}
                    </button>
                  ))}
                </div>
              </div>

              {codexAuthTab === 'oauth' && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
                    <div className="font-medium mb-2">Codex ChatGPT 登录</div>
                    <div className="text-xs text-muted-foreground">
                      先在服务器上执行 <code>codex login</code>，再导入 <code>~/.codex/auth.json</code>，或直接粘贴该文件内容。
                    </div>
                  </div>
                  <Button onClick={handleCodexOAuthImport} disabled={saving || codexOauthImporting}>
                    {codexOauthImporting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                    导入本机 Codex 登录态
                  </Button>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">auth.json（手动粘贴）</label>
                    <textarea
                      value={codexAuthJson}
                      onChange={(e) => setCodexAuthJson(e.target.value)}
                      disabled={saving}
                      placeholder="粘贴 ~/.codex/auth.json 内容"
                      className="w-full min-h-32 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground"
                    />
                    {!isCreate && provider?.hasCodexAuthJson && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        当前已保存 {provider.codexAuthMode === 'chatgpt' ? 'ChatGPT OAuth' : 'Codex OAuth'} 登录态
                      </p>
                    )}
                  </div>
                </div>
              )}

              {codexAuthTab === 'api_key' && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    OPENAI_API_KEY
                    {!isCreate && provider?.hasOpenAIApiKey
                      ? ` (${provider.openaiApiKeyMasked})`
                      : ''}
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={saving}
                    placeholder="sk-..."
                    className="font-mono"
                  />
                </div>
              )}
            </div>
          )}

          {providerRuntime === 'codex' && providerType === 'third_party' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">OPENAI_BASE_URL</label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://your-openai-compatible.example.com/v1"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  OPENAI_API_KEY
                  {!isCreate && provider?.hasOpenAIApiKey
                    ? ` (${provider.openaiApiKeyMasked})`
                    : ''}
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={saving}
                  placeholder="sk-..."
                  className="font-mono"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {providerRuntime === 'codex' ? 'Codex 模型' : providerType === 'official' ? '模型' : 'ANTHROPIC_MODEL'}
            </label>
            <Input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={saving}
              placeholder={providerRuntime === 'codex' ? '例如 gpt-5.4' : '留空使用默认模型'}
              className="font-mono"
            />
          </div>

          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">其他自定义环境变量（可选）</label>
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                添加
              </button>
            </div>

            {customEnvRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无</p>
            ) : (
              <div className="space-y-2">
                {customEnvRows.map((row, idx) => (
                  <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <Input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateRow(idx, 'key', e.target.value)}
                      placeholder="KEY"
                      className="w-full sm:w-[38%] px-2.5 py-1.5 text-xs font-mono h-auto"
                    />
                    <Input
                      type="text"
                      value={row.value}
                      onChange={(e) => updateRow(idx, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 px-2.5 py-1.5 text-xs font-mono h-auto"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="w-8 h-8 rounded-md hover:bg-muted text-muted-foreground hover:text-red-500 flex items-center justify-center cursor-pointer"
                      aria-label="删除环境变量"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? '收起高级设置' : '展开高级设置'}
            </button>
            {showAdvanced && (
              <div className="mt-2">
                <label className="block text-xs text-muted-foreground mb-1">
                  权重（用于加权轮询策略）
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={weight}
                  onChange={(e) => setWeight(Number(e.target.value || 1))}
                  disabled={saving}
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} disabled={saving || oauthExchanging}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || oauthExchanging}>
              {(saving || oauthExchanging) && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
