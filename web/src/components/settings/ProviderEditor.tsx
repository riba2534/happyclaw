import { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  Key,
  Loader2,
  Plus,
  X,
} from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { ProviderWithHealth, EnvRow } from './types';
import { getErrorMessage } from './types';

type ProviderType = 'official' | 'third_party';
type OfficialAuthTab = 'oauth' | 'setup_token' | 'api_key';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
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
  /** null 表示创建模式 */
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

  // 基础字段
  const [providerType, setProviderType] = useState<ProviderType>('third_party');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [weight, setWeight] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 官方认证
  const [authTab, setAuthTab] = useState<OfficialAuthTab>('oauth');
  const [setupToken, setSetupToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  // OAuth 流程
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);

  // 第三方认证
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);

  // 环境变量
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  // 状态
  const [saving, setSaving] = useState(false);

  // 初始化表单
  useEffect(() => {
    if (!open) return;

    if (isCreate) {
      setProviderType('third_party');
      setName('');
      setBaseUrl('');
      setModel('');
      setWeight(1);
      setShowAdvanced(false);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setCustomEnvRows([]);
    } else {
      setProviderType(provider.type);
      setName(provider.name);
      setBaseUrl(provider.anthropicBaseUrl || '');
      setModel(provider.anthropicModel || '');
      setWeight(provider.weight);
      setShowAdvanced(provider.weight !== 1);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      const envRows = Object.entries(provider.customEnv || {}).map(([key, value]) => ({ key, value }));
      setCustomEnvRows(envRows);
    }
  }, [open, isCreate, provider]);

  const addRow = () => setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  // ─── OAuth 流程 ─────────────────────────────────────────────
  const handleOAuthStart = useCallback(async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      // 编辑模式下传入目标提供商 ID
      if (!isCreate && provider) {
        body.targetProviderId = provider.id;
      }
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

  // ─── 保存 ──────────────────────────────────────────────────
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
        // ── 创建模式 ──
        const createBody: Record<string, unknown> = {
          name: trimmedName,
          type: providerType,
          customEnv: envResult.customEnv,
          weight,
        };

        if (providerType === 'third_party') {
          const trimmedBaseUrl = baseUrl.trim();
          const trimmedToken = authToken.trim();
          if (!trimmedBaseUrl) {
            setError('请填写 ANTHROPIC_BASE_URL');
            setSaving(false);
            return;
          }
          if (!trimmedToken) {
            setError('新建第三方提供商时必须填写 ANTHROPIC_AUTH_TOKEN');
            setSaving(false);
            return;
          }
          createBody.anthropicBaseUrl = trimmedBaseUrl;
          createBody.anthropicAuthToken = trimmedToken;
        } else {
          // 官方模式 — 根据认证方式设置凭据
          if (authTab === 'setup_token') {
            const trimmed = setupToken.trim();
            if (!trimmed) {
              setError('请填写 setup-token 或粘贴 .credentials.json 内容');
              setSaving(false);
              return;
            }
            // 检测是否为 .credentials.json
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
          } else if (authTab === 'api_key') {
            const trimmed = apiKey.trim();
            if (!trimmed) {
              setError('请填写 Anthropic API Key');
              setSaving(false);
              return;
            }
            createBody.anthropicApiKey = trimmed;
          } else {
            // OAuth 模式 — 不需要凭据，通过 OAuth 流程设置
            // 允许不带凭据创建，用户之后通过 OAuth 流程补充
          }
        }

        if (model.trim()) createBody.anthropicModel = model.trim();

        await api.post('/api/config/claude/providers', createBody);
        setNotice('提供商已创建。');
      } else {
        // ── 编辑模式 ──
        const patchBody: Record<string, unknown> = {
          name: trimmedName,
          customEnv: envResult.customEnv,
          weight,
        };

        if (providerType === 'third_party') {
          patchBody.anthropicBaseUrl = baseUrl.trim();
        }
        if (model.trim()) {
          patchBody.anthropicModel = model.trim();
        }

        await api.patch(`/api/config/claude/providers/${provider!.id}`, patchBody);

        // 更新密钥（如果有变更）
        const secretsBody: Record<string, unknown> = {};
        let hasSecretsChange = false;

        if (providerType === 'third_party') {
          if (clearTokenOnSave) {
            secretsBody.clearAnthropicAuthToken = true;
            hasSecretsChange = true;
          } else if (authTokenDirty && authToken.trim()) {
            secretsBody.anthropicAuthToken = authToken.trim();
            hasSecretsChange = true;
          }
        } else {
          // 官方模式编辑时更新凭据
          if (authTab === 'setup_token' && setupToken.trim()) {
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
                // 不是 JSON，视为 setup-token
              }
            }
            if (!hasSecretsChange) {
              secretsBody.claudeCodeOauthToken = trimmed;
              secretsBody.clearAnthropicAuthToken = true;
              secretsBody.clearAnthropicApiKey = true;
              hasSecretsChange = true;
            }
          } else if (authTab === 'api_key' && apiKey.trim()) {
            secretsBody.anthropicApiKey = apiKey.trim();
            secretsBody.clearAnthropicAuthToken = true;
            secretsBody.clearClaudeCodeOauthToken = true;
            secretsBody.clearClaudeOAuthCredentials = true;
            hasSecretsChange = true;
          }
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
          {/* 类型选择（仅创建模式） */}
          {isCreate && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">提供商类型</label>
              <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                <button
                  type="button"
                  onClick={() => setProviderType('official')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                    providerType === 'official'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  官方
                </button>
                <button
                  type="button"
                  onClick={() => setProviderType('third_party')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                    providerType === 'third_party'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  第三方
                </button>
              </div>
            </div>
          )}

          {/* 名称 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">名称</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              placeholder={providerType === 'official' ? '如：Claude 官方' : '如：OpenRouter-主账号'}
            />
          </div>

          {/* ─── 官方模式 ─── */}
          {providerType === 'official' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-2">认证方式</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['oauth', 'setup_token', 'api_key'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setAuthTab(tab)}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer ${
                        authTab === tab
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {tab === 'oauth' ? 'OAuth 登录' : tab === 'setup_token' ? 'Setup Token' : 'API Key'}
                    </button>
                  ))}
                </div>
              </div>

              {authTab === 'oauth' && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                  <div className="text-sm font-medium text-foreground">一键登录 Claude（推荐）</div>
                  <div className="text-xs text-muted-foreground">
                    点击按钮后会打开 claude.ai 授权页面，完成授权后将页面上显示的授权码粘贴回来。
                  </div>

                  {/* 编辑模式显示现有凭据 */}
                  {!isCreate && provider?.hasClaudeOAuthCredentials && (
                    <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-3 space-y-1 text-xs">
                      <div className="text-emerald-700 dark:text-emerald-300">
                        Access Token: {provider.claudeOAuthCredentialsAccessTokenMasked || '***'}
                      </div>
                      {provider.claudeOAuthCredentialsExpiresAt && (
                        <div className={
                          provider.claudeOAuthCredentialsExpiresAt <= Date.now()
                            ? 'text-red-700 dark:text-red-400 font-medium'
                            : 'text-emerald-700 dark:text-emerald-300'
                        }>
                          过期时间: {new Date(provider.claudeOAuthCredentialsExpiresAt).toLocaleString('zh-CN')}
                          {provider.claudeOAuthCredentialsExpiresAt > Date.now()
                            ? ` (${Math.round((provider.claudeOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                            : ' (已过期)'}
                        </div>
                      )}
                      <div className="text-emerald-600">SDK 会在 token 过期时自动刷新。</div>
                    </div>
                  )}

                  {!oauthState ? (
                    <Button onClick={handleOAuthStart} disabled={saving || oauthLoading}>
                      {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                      {!isCreate && provider?.hasClaudeOAuthCredentials ? '重新登录 Claude' : '一键登录 Claude'}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
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
                        <Button
                          variant="outline"
                          onClick={() => {
                            setOauthState(null);
                            setOauthCode('');
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {authTab === 'setup_token' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    setup-token 或 .credentials.json{' '}
                    {!isCreate && provider?.hasClaudeCodeOauthToken
                      ? `(${provider.claudeCodeOauthTokenMasked})`
                      : ''}
                  </label>
                  <Input
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate && (provider?.hasClaudeCodeOauthToken || provider?.hasClaudeOAuthCredentials)
                        ? '输入新值覆盖'
                        : '粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出'
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    支持粘贴{' '}
                    <code className="bg-muted px-1 rounded">cat ~/.claude/.credentials.json</code>{' '}
                    的 JSON 内容
                  </p>
                </div>
              )}

              {authTab === 'api_key' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    <span className="flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5" />
                      ANTHROPIC_API_KEY{' '}
                      {!isCreate && provider?.hasAnthropicApiKey
                        ? `(${provider.anthropicApiKeyMasked})`
                        : ''}
                    </span>
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate && provider?.hasAnthropicApiKey
                        ? '输入新值覆盖'
                        : 'sk-ant-api03-...'
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    直接使用 Anthropic 官方 API Key，从{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-600 underline"
                    >
                      console.anthropic.com
                    </a>{' '}
                    获取
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ─── 第三方模式 ─── */}
          {providerType === 'third_party' && (
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
                  ANTHROPIC_AUTH_TOKEN{' '}
                  {!isCreate && provider?.hasAnthropicAuthToken
                    ? `(${provider.anthropicAuthTokenMasked})`
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
                  placeholder={
                    isCreate
                      ? '输入 Token（必填）'
                      : provider?.hasAnthropicAuthToken
                        ? '留空不变；输入新值覆盖'
                        : '输入 Token（可选）'
                  }
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

          {/* ─── 模型选择 ─── */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {providerType === 'official' ? '模型' : 'ANTHROPIC_MODEL'}
            </label>
            {providerType === 'official' ? (
              <>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">default（默认）</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  别名自动解析为最新版本，留空使用 default。
                </p>
              </>
            ) : (
              <>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  placeholder="第三方 API 的模型名称"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  注入为 ANTHROPIC_MODEL 环境变量，值取决于第三方 API 支持的模型。
                </p>
              </>
            )}
          </div>

          {/* ─── 自定义环境变量 ─── */}
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
            <p className="mb-2 text-xs text-muted-foreground">
              这些变量仅在当前提供商生效，不同提供商互不影响。
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

          {/* ─── 高级设置 ─── */}
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
                  onChange={(e) => setWeight(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                  disabled={saving}
                  className="w-24"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  仅当负载均衡策略为「加权轮询」时生效，值越大分配到的请求越多。
                </p>
              </div>
            )}
          </div>

          {/* ─── 操作按钮 ─── */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} disabled={saving || oauthExchanging}>
              取消
            </Button>
            {/* OAuth 模式下创建时不需要保存按钮（OAuth 回调会自动触发 onSave） */}
            <Button onClick={handleSave} disabled={saving || oauthExchanging}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isCreate ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
