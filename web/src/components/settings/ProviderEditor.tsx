import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import {
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
} from '../../utils/provider-model';
import type { ProviderWithHealth, EnvRow } from './types';
import { getErrorMessage } from './types';

type ProviderType = 'official' | 'third_party' | 'codex';
type OfficialAuthTab = 'oauth' | 'setup_token' | 'api_key';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

const DEFAULTED_THIRD_PARTY_ENV_KEYS = new Set(
  buildDefaultProviderEnv('', false).map((row) => row.key),
);

const MANAGED_ENV_SOURCE_LABELS = {
  model: '跟随模型',
  context: '跟随上下文',
  default: '系统默认',
} as const;

function buildCustomEnv(
  rows: EnvRow[],
  manageThirdPartyDefaults: boolean,
): {
  customEnv: Record<string, string>;
  error: string | null;
} {
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
    if (
      RESERVED_ENV_KEYS.has(key) ||
      (manageThirdPartyDefaults && DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key))
    ) {
      return {
        customEnv: {},
        error: `${key} 已在系统预填列表中，请直接修改对应值`,
      };
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
  const [oneMillionContext, setOneMillionContext] = useState(false);

  // 官方认证
  const [authTab, setAuthTab] = useState<OfficialAuthTab>('oauth');
  const [setupToken, setSetupToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  // OAuth 流程
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);
  const [codexFlowId, setCodexFlowId] = useState<string | null>(null);
  const [codexUserCode, setCodexUserCode] = useState('');
  const [codexVerifyUrl, setCodexVerifyUrl] = useState('');
  const [codexStatus, setCodexStatus] = useState<string | null>(null);

  // 第三方认证
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);

  // 环境变量
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);
  const [providerEnvOverrides, setProviderEnvOverrides] = useState<
    Record<string, string>
  >({});
  const [showCustomEnvValues, setShowCustomEnvValues] = useState<
    Record<number, boolean>
  >({});

  // 状态
  const [saving, setSaving] = useState(false);

  const defaultProviderEnv = buildDefaultProviderEnv(model, oneMillionContext);

  // 初始化表单
  useEffect(() => {
    if (!open) return;
    setShowCustomEnvValues({});

    if (isCreate) {
      setProviderType('third_party');
      setName('');
      setBaseUrl('');
      setModel('');
      setOneMillionContext(false);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setCodexFlowId(null);
      setCodexUserCode('');
      setCodexVerifyUrl('');
      setCodexStatus(null);
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setCustomEnvRows([]);
      setProviderEnvOverrides({});
    } else {
      setProviderType(provider.type);
      setName(provider.name);
      setBaseUrl(provider.anthropicBaseUrl || '');
      const modelSelection = parseProviderModel(provider.anthropicModel || '');
      setModel(modelSelection.model);
      setOneMillionContext(modelSelection.oneMillionContext);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      const providerCustomEnv = provider.customEnv || {};
      const defaultEnv = Object.fromEntries(
        buildDefaultProviderEnv(
          modelSelection.model,
          modelSelection.oneMillionContext,
        ).map((row) => [row.key, row.value]),
      );
      const initialProviderEnvOverrides: Record<string, string> = {};
      if (provider.type === 'third_party') {
        for (const [key, value] of Object.entries(providerCustomEnv)) {
          if (
            DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key) &&
            value !== defaultEnv[key]
          ) {
            initialProviderEnvOverrides[key] = value;
          }
        }
      }
      setProviderEnvOverrides(initialProviderEnvOverrides);

      const envRows = Object.entries(providerCustomEnv)
        .filter(
          ([key]) =>
            provider.type !== 'third_party' ||
            !DEFAULTED_THIRD_PARTY_ENV_KEYS.has(key),
        )
        .map(([key, value]) => ({ key, value }));
      setCustomEnvRows(envRows);
    }
  }, [open, isCreate, provider]);

  const addRow = () =>
    setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  const updateProviderEnv = (
    key: string,
    value: string,
    defaultValue: string,
  ) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      if (value === defaultValue) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const resetProviderEnv = (key: string) => {
    setProviderEnvOverrides((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

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

  const handleCodexOAuthStart = useCallback(async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (!isCreate && provider) {
        body.targetProviderId = provider.id;
      }
      const data = await api.post<{
        id: string;
        verificationUrl: string;
        userCode: string;
        status: string;
      }>('/api/config/codex/oauth/start', body);
      setCodexFlowId(data.id);
      setCodexUserCode(data.userCode);
      setCodexVerifyUrl(data.verificationUrl);
      setCodexStatus(data.status);
      window.open(data.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'Codex 授权启动失败'));
    } finally {
      setOauthLoading(false);
    }
  }, [isCreate, provider, setError]);

  useEffect(() => {
    if (!codexFlowId || (codexStatus && codexStatus !== 'pending')) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await api.get<{
          status: string;
          accountName?: string;
          error?: string;
        }>(`/api/config/codex/oauth/${codexFlowId}`);
        if (cancelled) return;
        setCodexStatus(data.status);
        if (data.status === 'completed') {
          setNotice(
            data.accountName
              ? `Codex 已登录：${data.accountName}`
              : 'Codex 登录成功，凭据已加密保存。',
          );
          onSave();
        } else if (data.status === 'failed' || data.status === 'expired') {
          setError(data.error || 'Codex 授权失败，请重新发起');
        }
      } catch {
        // keep polling until expiry
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [codexFlowId, codexStatus, onSave, setError, setNotice]);

  // ─── 保存 ──────────────────────────────────────────────────
  const handleSave = async () => {
    const normalizedModel =
      providerType === 'third_party'
        ? buildProviderModel(model, oneMillionContext)
        : providerType === 'codex'
          ? model.trim() || 'gpt-5.6-sol'
          : model.trim();
    if (providerType === 'third_party' && !normalizedModel) {
      setError('请填写第三方 API 支持的模型名称');
      return;
    }
    const trimmedName =
      name.trim() ||
      (providerType === 'third_party'
        ? parseProviderModel(normalizedModel).model
        : providerType === 'codex'
          ? 'ChatGPT Codex'
          : '');
    if (!trimmedName) {
      setError('请填写模型配置名称');
      return;
    }

    const trimmedBaseUrl = baseUrl.trim();
    if (providerType === 'third_party' && !trimmedBaseUrl) {
      setError('请填写 API 端点');
      return;
    }

    const envResult = buildCustomEnv(
      customEnvRows,
      providerType === 'third_party',
    );
    if (envResult.error) {
      setError(envResult.error);
      return;
    }
    const savedCustomEnv = {
      ...envResult.customEnv,
      ...(providerType === 'third_party' ? providerEnvOverrides : {}),
    };

    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        // ── 创建模式 ──
        const createBody: Record<string, unknown> = {
          name: trimmedName,
          type: providerType,
          customEnv: savedCustomEnv,
        };

        if (providerType === 'third_party') {
          const trimmedToken = authToken.trim();
          if (!trimmedToken) {
            setError('新建第三方模型配置时必须填写 API 密钥');
            setSaving(false);
            return;
          }
          createBody.anthropicBaseUrl = trimmedBaseUrl;
          createBody.anthropicAuthToken = trimmedToken;
        } else if (providerType === 'codex') {
          createBody.anthropicModel = normalizedModel;
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
                const oauth = parsed.claudeAiOauth as
                  | Record<string, unknown>
                  | undefined;
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

        if (normalizedModel) createBody.anthropicModel = normalizedModel;

        await api.post('/api/config/claude/providers', createBody);
        setNotice('模型配置已创建。');
      } else {
        // ── 编辑模式 ──
        const patchBody: Record<string, unknown> = {
          name: trimmedName,
          customEnv: savedCustomEnv,
        };

        if (providerType === 'third_party') {
          patchBody.anthropicBaseUrl = trimmedBaseUrl;
        }
        patchBody.anthropicModel = normalizedModel;

        await api.patch(
          `/api/config/claude/providers/${provider!.id}`,
          patchBody,
        );

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
                const oauth = parsed.claudeAiOauth as
                  | Record<string, unknown>
                  | undefined;
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
          await api.put(
            `/api/config/claude/providers/${provider!.id}/secrets`,
            secretsBody,
          );
        }

        setNotice('模型配置已保存。');
      }

      onSave();
    } catch (err) {
      setError(
        getErrorMessage(
          err,
          isCreate ? '创建模型配置失败' : '保存模型配置失败',
        ),
      );
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
      <DialogContent className="z-[10001] max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? '添加模型配置' : `编辑模型配置：${provider?.name}`}
          </DialogTitle>
          <DialogDescription className="text-left text-xs leading-5">
            {providerType === 'third_party'
              ? '填写端点、密钥和模型即可；Claude Code 运行参数会自动预填，也可在高级设置中调整。'
              : providerType === 'codex'
                ? '通过 ChatGPT 设备码登录 Codex。Runner 仍走 Anthropic Messages，由本机 facade 翻译。'
                : '配置 Claude 官方认证方式与默认模型。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 类型选择（仅创建模式） */}
          {isCreate && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                模型配置类型
              </label>
              <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                <button
                  type="button"
                  aria-pressed={providerType === 'official'}
                  onClick={() => setProviderType('official')}
                  className={`min-h-9 rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                    providerType === 'official'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  官方
                </button>
                <button
                  type="button"
                  aria-pressed={providerType === 'third_party'}
                  onClick={() => setProviderType('third_party')}
                  className={`min-h-9 rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                    providerType === 'third_party'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  第三方
                </button>
                <button
                  type="button"
                  aria-pressed={providerType === 'codex'}
                  onClick={() => setProviderType('codex')}
                  className={`min-h-9 rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                    providerType === 'codex'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  Codex
                </button>
              </div>
            </div>
          )}

          {/* 名称 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {providerType === 'third_party' ? '配置名称（可选）' : '名称'}
            </label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              placeholder={
                providerType === 'official'
                  ? '如：Claude 官方'
                  : '留空时使用模型名称'
              }
            />
          </div>

          {/* ─── 官方模式 ─── */}
          {providerType === 'official' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-2">
                  认证方式
                </label>
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
                      {tab === 'oauth'
                        ? 'OAuth 登录'
                        : tab === 'setup_token'
                          ? 'Setup Token'
                          : 'API Key'}
                    </button>
                  ))}
                </div>
              </div>

              {authTab === 'oauth' && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    一键登录 Claude（推荐）
                  </div>
                  <div className="text-xs text-muted-foreground">
                    点击按钮后会打开 claude.ai
                    授权页面，完成授权后将页面上显示的授权码粘贴回来。
                  </div>

                  {/* 编辑模式显示现有凭据 */}
                  {!isCreate && provider?.hasClaudeOAuthCredentials && (
                    <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-3 space-y-1 text-xs">
                      <div className="text-emerald-700 dark:text-emerald-300">
                        Access Token:{' '}
                        {provider.claudeOAuthCredentialsAccessTokenMasked ||
                          '***'}
                      </div>
                      {provider.claudeOAuthCredentialsExpiresAt && (
                        <div
                          className={
                            provider.claudeOAuthCredentialsExpiresAt <=
                            Date.now()
                              ? 'text-red-700 dark:text-red-400 font-medium'
                              : 'text-emerald-700 dark:text-emerald-300'
                          }
                        >
                          过期时间:{' '}
                          {new Date(
                            provider.claudeOAuthCredentialsExpiresAt,
                          ).toLocaleString('zh-CN')}
                          {provider.claudeOAuthCredentialsExpiresAt > Date.now()
                            ? ` (${Math.round((provider.claudeOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                            : ' (已过期)'}
                        </div>
                      )}
                      <div className="text-emerald-600">
                        SDK 会在 token 过期时自动刷新。
                      </div>
                    </div>
                  )}

                  {!oauthState ? (
                    <Button
                      onClick={handleOAuthStart}
                      disabled={saving || oauthLoading}
                    >
                      {oauthLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ExternalLink className="size-4" />
                      )}
                      {!isCreate && provider?.hasClaudeOAuthCredentials
                        ? '重新登录 Claude'
                        : '一键登录 Claude'}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
                        授权窗口已打开，请在 claude.ai
                        完成授权后，将页面上显示的授权码粘贴到下方。
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
                        <Button
                          onClick={handleOAuthCallback}
                          disabled={oauthExchanging || !oauthCode.trim()}
                        >
                          {oauthExchanging && (
                            <Loader2 className="size-4 animate-spin" />
                          )}
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
                      !isCreate &&
                      (provider?.hasClaudeCodeOauthToken ||
                        provider?.hasClaudeOAuthCredentials)
                        ? '输入新值覆盖'
                        : '粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出'
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    支持粘贴{' '}
                    <code className="bg-muted px-1 rounded">
                      cat ~/.claude/.credentials.json
                    </code>{' '}
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
            <div className="space-y-5">
              <div>
                <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                  <span>API 端点</span>
                  <span className="font-normal text-muted-foreground">
                    ANTHROPIC_BASE_URL
                  </span>
                </label>
                <Input
                  type="url"
                  inputMode="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://api.example.com/anthropic"
                  autoComplete="off"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  填写 Anthropic 兼容接口的完整地址。
                </p>
              </div>

              <div>
                <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                  <span>API 密钥</span>
                  <span className="font-normal text-muted-foreground">
                    {!isCreate && provider?.hasAnthropicAuthToken
                      ? `当前 ${provider.anthropicAuthTokenMasked}`
                      : 'ANTHROPIC_AUTH_TOKEN'}
                  </span>
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
                      ? '输入 API 密钥'
                      : provider?.hasAnthropicAuthToken
                        ? '留空保留当前密钥；输入新值覆盖'
                        : '输入 API 密钥'
                  }
                  autoComplete="new-password"
                />
                {!isCreate && provider?.hasAnthropicAuthToken && (
                  <label className="mt-2 inline-flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
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
                    保存时清空当前密钥
                  </label>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-end">
                <div className="min-w-0">
                  <label className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                    <span>模型名称</span>
                    <span className="font-normal text-muted-foreground">
                      ANTHROPIC_MODEL
                    </span>
                  </label>
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={saving}
                    placeholder="例如 glm-5.2、k3、qwen3.7-max"
                    autoComplete="off"
                  />
                </div>

                <div className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/35 px-3.5 py-2.5">
                  <label
                    htmlFor="provider-one-million-context"
                    className="min-w-0"
                  >
                    <span className="block text-xs font-medium text-foreground">
                      1M 上下文
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      自动添加 [1m]
                    </span>
                  </label>
                  <Switch
                    id="provider-one-million-context"
                    checked={oneMillionContext}
                    onCheckedChange={setOneMillionContext}
                    disabled={saving}
                    aria-label="启用 1M 上下文"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-primary/15 bg-primary/[0.035] px-3.5 py-3">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      系统预填 Claude Code 运行环境
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      实际模型：
                      <code className="break-all font-medium text-foreground">
                        {buildProviderModel(model, oneMillionContext) ||
                          '填写模型后生成'}
                      </code>
                      {' · '}
                      上下文窗口：
                      {oneMillionContext ? '1,000,000' : '200,000'} tokens
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      默认同步模型映射、压缩窗口、请求超时与兼容参数；可在高级设置中调整。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {providerType === 'codex' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 space-y-3 dark:border-emerald-800 dark:bg-emerald-950/20">
                <div className="text-sm font-medium text-foreground">
                  ChatGPT Codex（设备码登录）
                </div>
                <div className="text-xs text-muted-foreground">
                  浏览器只接触一次性验证码。Access / refresh token
                  仅在服务端交换并加密入库，API 不返回明文。
                </div>
                {!isCreate && provider?.hasCodexOAuthCredentials && (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
                    <div className="text-emerald-700 dark:text-emerald-300">
                      已绑定 {provider.codexOAuthEmailMasked || 'ChatGPT 订阅'}
                      {provider.codexOAuthPlanType
                        ? ` · ${provider.codexOAuthPlanType}`
                        : ''}
                    </div>
                  </div>
                )}
                {!codexFlowId ? (
                  <Button
                    onClick={handleCodexOAuthStart}
                    disabled={saving || oauthLoading}
                  >
                    {oauthLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ExternalLink className="size-4" />
                    )}
                    {!isCreate && provider?.hasCodexOAuthCredentials
                      ? '重新登录 ChatGPT'
                      : '登录 ChatGPT Codex'}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <div className="text-xs text-amber-700 dark:text-amber-300">
                      在 ChatGPT 打开验证页，输入代码{' '}
                      <code className="rounded bg-muted px-1 font-mono">
                        {codexUserCode}
                      </code>
                    </div>
                    {codexVerifyUrl && (
                      <a
                        href={codexVerifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-teal-600 underline"
                      >
                        {codexVerifyUrl}
                      </a>
                    )}
                    <div className="text-xs text-muted-foreground">
                      状态：{codexStatus || 'pending'}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  模型
                </label>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  placeholder="gpt-5.6-sol"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  默认 gpt-5.6-sol。Claude Agent SDK 经本机 Anthropic facade
                  访问 Codex Responses。
                </p>
              </div>
            </div>
          )}

          {/* ─── 官方模型选择 ─── */}
          {providerType === 'official' && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                模型
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={saving}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">default（默认）</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
                <option value="fable">fable</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                别名自动解析为最新版本，留空使用 default。
              </p>
            </div>
          )}

          {/* ─── 环境变量 ─── */}
          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              {providerType === 'third_party'
                ? '高级设置 · 环境变量'
                : '高级设置 · 自定义环境变量'}
              {providerType === 'third_party' && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {defaultProviderEnv.length} 项默认配置
                </span>
              )}
              {customEnvRows.length > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {customEnvRows.length} 项自定义
                </span>
              )}
            </summary>

            <div className="mt-4 space-y-5">
              {providerType === 'third_party' && (
                <section aria-labelledby="default-provider-env-heading">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3
                        id="default-provider-env-heading"
                        className="text-xs font-medium text-foreground"
                      >
                        系统预填环境变量
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        默认值会随模型和上下文更新；修改后以你的自定义值为准。
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {defaultProviderEnv.length} 项
                    </span>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-border/80 bg-muted/20">
                    {defaultProviderEnv.map((row, index) => {
                      const hasOverride = Object.hasOwn(
                        providerEnvOverrides,
                        row.key,
                      );
                      const value = hasOverride
                        ? providerEnvOverrides[row.key]
                        : row.value;
                      const inputId = `provider-env-default-${index}`;

                      return (
                        <div
                          key={row.key}
                          className={`grid min-w-0 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] sm:items-center sm:gap-4 ${
                            index > 0 ? 'border-t border-border/70' : ''
                          }`}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <label
                              htmlFor={inputId}
                              className="min-w-0 break-all font-mono text-[11px] text-foreground"
                            >
                              {row.key}
                            </label>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
                                hasOverride
                                  ? 'border-primary/25 bg-primary/5 text-primary'
                                  : 'border-border bg-background text-muted-foreground'
                              }`}
                            >
                              {hasOverride
                                ? '已自定义'
                                : MANAGED_ENV_SOURCE_LABELS[row.source]}
                            </span>
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Input
                              id={inputId}
                              type="text"
                              value={value}
                              onChange={(event) =>
                                updateProviderEnv(
                                  row.key,
                                  event.target.value,
                                  row.value,
                                )
                              }
                              disabled={saving}
                              placeholder="填写模型后生成"
                              autoComplete="off"
                              className="h-9 min-w-0 px-2.5 font-mono text-xs"
                            />
                            {hasOverride && (
                              <button
                                type="button"
                                onClick={() => resetProviderEnv(row.key)}
                                disabled={saving}
                                className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:size-9"
                                aria-label={`恢复 ${row.key} 的默认值`}
                                title="恢复默认值"
                              >
                                <RotateCcw className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section
                aria-labelledby="custom-provider-env-heading"
                className={
                  providerType === 'third_party'
                    ? 'border-t border-border pt-4'
                    : undefined
                }
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <h3
                      id="custom-provider-env-heading"
                      className="text-xs font-medium text-foreground"
                    >
                      自定义环境变量
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      仅用于 API 自定义 Header 等特殊需求。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addRow}
                    className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-muted"
                  >
                    <Plus className="size-3.5" />
                    添加
                  </button>
                </div>

                {customEnvRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    没有自定义环境变量，大多数配置无需添加。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {customEnvRows.map((row, idx) => (
                      <div
                        key={idx}
                        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
                      >
                        <Input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            updateRow(idx, 'key', e.target.value)
                          }
                          placeholder="KEY"
                          className="h-auto w-full px-2.5 py-1.5 font-mono text-xs sm:w-[38%]"
                        />
                        <Input
                          type={showCustomEnvValues[idx] ? 'text' : 'password'}
                          value={row.value}
                          onChange={(e) =>
                            updateRow(idx, 'value', e.target.value)
                          }
                          placeholder="value"
                          className="h-auto flex-1 px-2.5 py-1.5 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setShowCustomEnvValues((current) => ({
                              ...current,
                              [idx]: !current[idx],
                            }))
                          }
                          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={
                            showCustomEnvValues[idx]
                              ? '隐藏环境变量值'
                              : '显示环境变量值'
                          }
                        >
                          {showCustomEnvValues[idx] ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-500"
                          aria-label="删除环境变量"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </details>

          {/* ─── 操作按钮 ─── */}
          <div className="sticky -bottom-4 z-10 -mx-4 flex justify-end gap-2 border-t border-border bg-background/95 px-4 pb-4 pt-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={saving || oauthExchanging}
            >
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
