import { useState } from 'react';
import {
  Check,
  Loader2,
  Pencil,
  PlugZap,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { IconButton } from '@/components/common/IconButton';
import { describeBaseUrlProblem, getModelPreset } from '@/lib/model-providers';
import {
  codexDefaultsPatch,
  storedCodexEffort,
  useCodexCatalog,
} from './codex-catalog';
import { CodexModelFields } from './CodexModelFields';
import { ConnectionModelList } from './ConnectionModelList';
import { ConnectionTestResult } from './ConnectionTestResult';
import {
  AUTH_MODE_LABELS,
  AUTO_AUTH_MODE_HINT,
  confirmProtocolChange,
  connectionKind,
  connectionKindLabel,
  connectionStatus,
  isThirdPartyKind,
  saveConnectionSecrets,
  testConnection,
  testOutcome,
  updateConnection,
  type ConnectionKind,
  type ProviderAuthMode,
  type TestOutcome,
} from './model-connections';
import { OAuthLoginPanel } from './OAuthLoginPanel';
import {
  ProviderEnvEditor,
  buildProviderCustomEnv,
  envRowsFrom,
} from './ProviderEnvEditor';
import { SettingsField, SettingsSection } from './SettingsLayout';
import {
  getErrorMessage,
  type EnvRow,
  type UnifiedProviderPublic,
  type WebFetchPreflightPolicy,
} from './types';

export type ConnectionUpdate = Pick<UnifiedProviderPublic, 'id'> &
  Partial<UnifiedProviderPublic>;

interface ConnectionDetailDialogProps {
  /** The connection to manage; null closes the dialog. */
  provider: UnifiedProviderPublic | null;
  onClose: () => void;
  /**
   * Something was saved or tested. With the fields that changed the list
   * updates that row in place; without, it reloads.
   */
  onChanged: (update?: ConnectionUpdate) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

/** One connection: its status and test, its models, and its settings. */
export function ConnectionDetailDialog({
  provider,
  onClose,
  ...props
}: ConnectionDetailDialogProps) {
  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent
        className="sm:max-w-2xl"
        // Focus the dialog itself rather than the first button, whose
        // tooltip would otherwise open with the dialog.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        {provider && (
          <ConnectionDetail key={provider.id} provider={provider} {...props} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function sameEnv(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function ConnectionDetail({
  provider,
  onChanged,
  setNotice,
  setError,
}: Omit<ConnectionDetailDialogProps, 'provider' | 'onClose'> & {
  provider: UnifiedProviderPublic;
}) {
  const kind = connectionKind(provider);
  const thirdParty = isThirdPartyKind(kind);
  const preset = getModelPreset(provider.presetId);
  const status = connectionStatus(provider);

  // ─── Name ───
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === provider.name) {
      setRenaming(false);
      return;
    }
    try {
      onChanged(await updateConnection(provider.id, { name: next }));
      setRenaming(false);
    } catch (err) {
      setError(getErrorMessage(err, '重命名失败'));
    }
  };

  // ─── Test ───
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{
    outcome: TestOutcome | null;
    error: string | null;
  } | null>(null);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const result = await testConnection({ providerId: provider.id });
      setTest({ outcome: testOutcome(result), error: null });
      // The server stored the record, and may have stored the header the
      // test proved: read the connection again.
      onChanged();
    } catch (err) {
      setTest({ outcome: null, error: getErrorMessage(err, '测试连接失败') });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DialogHeader>
        {renaming ? (
          <div className="flex items-center gap-1.5 pr-8">
            <DialogTitle className="sr-only">{provider.name}</DialogTitle>
            <Input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void rename();
                }
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setRenaming(false);
                }
              }}
              aria-label="连接名称"
              autoFocus
            />
            <IconButton
              label="保存名称"
              icon={<Check />}
              onClick={() => void rename()}
            />
            <IconButton
              label="取消重命名"
              icon={<X />}
              onClick={() => {
                setNameDraft(provider.name);
                setRenaming(false);
              }}
            />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1 pr-8">
            <DialogTitle className="truncate">{provider.name}</DialogTitle>
            <IconButton
              label="重命名"
              icon={<Pencil />}
              onClick={() => setRenaming(true)}
            />
          </div>
        )}
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{connectionKindLabel(provider)}</Badge>
            <Badge variant="outline" dot={status.tone}>
              {status.label}
            </Badge>
            {thirdParty && provider.anthropicBaseUrl && (
              <span className="min-w-0 truncate font-mono text-caption">
                {provider.anthropicBaseUrl}
              </span>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>

      <section className="space-y-2" aria-label="连接测试">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void runTest()}
            disabled={testing}
          >
            {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
            测试连接
          </Button>
          <span className="text-caption text-muted-foreground">
            {kind === 'claude_subscription' || kind === 'chatgpt'
              ? '检查账号是否可用，不消耗额度。'
              : '发送一条最小请求，可能产生极少费用。'}
          </span>
        </div>
        {status.hint && !test && (
          <p className="text-caption text-muted-foreground">{status.hint}</p>
        )}
        <ConnectionTestResult
          outcome={test?.outcome ?? null}
          testing={testing}
          requestError={test?.error ?? null}
        />
      </section>

      {kind === 'chatgpt' ? (
        <CodexDefaults
          provider={provider}
          onChanged={onChanged}
          setNotice={setNotice}
          setError={setError}
        />
      ) : (
        <SettingsSection
          title="模型"
          description="这些模型都可以在聊天和智能体里选择。"
        >
          <ConnectionModelList
            provider={provider}
            thirdParty={thirdParty}
            onSaved={onChanged}
            setNotice={setNotice}
            setError={setError}
          />
        </SettingsSection>
      )}

      <ConnectionSettings
        provider={provider}
        kind={kind}
        presetName={preset?.name ?? null}
        onChanged={onChanged}
        setNotice={setNotice}
        setError={setError}
      />
    </div>
  );
}

function ReloginAlert({ title, message }: { title: string; message?: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg bg-error/10 px-3 py-2.5 text-caption leading-5 text-error"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {message && <div className="break-words opacity-80">{message}</div>}
      </div>
    </div>
  );
}

/** The ChatGPT login's default model and effort (its catalog is its list). */
function CodexDefaults({
  provider,
  onChanged,
  setNotice,
  setError,
}: {
  provider: UnifiedProviderPublic;
  onChanged: (update?: ConnectionUpdate) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const catalog = useCodexCatalog(provider.id);
  const [pick, setPick] = useState<{ model: string; effort: string } | null>(
    null,
  );
  const model =
    pick?.model ?? (provider.anthropicModel || catalog.defaultModel);
  const effort =
    pick?.effort ?? storedCodexEffort(provider) ?? catalog.defaultEffort;
  const [saving, setSaving] = useState(false);
  const patch = codexDefaultsPatch(provider, model, effort);

  const save = async () => {
    if (!(await confirmProtocolChange(provider))) return;
    setSaving(true);
    try {
      onChanged(await updateConnection(provider.id, patch));
      setPick(null);
      setNotice('默认模型已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存默认模型失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="模型"
      description="ChatGPT 订阅的模型来自账号的实时目录，聊天里可以按对话切换；这里设置没有指定时的默认值。"
    >
      <CodexModelFields
        catalog={catalog}
        model={model}
        effort={effort}
        onChange={setPick}
        disabled={saving}
      />
      <Button
        onClick={() => void save()}
        disabled={Object.keys(patch).length === 0 || saving}
      >
        {saving && <Loader2 className="animate-spin" />}
        保存默认模型
      </Button>
    </SettingsSection>
  );
}

/** Credentials, address and environment: edits here restart runners. */
function ConnectionSettings({
  provider,
  kind,
  presetName,
  onChanged,
  setNotice,
  setError,
}: {
  provider: UnifiedProviderPublic;
  kind: ConnectionKind;
  presetName: string | null;
  onChanged: (update?: ConnectionUpdate) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const thirdParty = isThirdPartyKind(kind);
  const [baseUrl, setBaseUrl] = useState(provider.anthropicBaseUrl);
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState<EnvRow[]>(() =>
    envRowsFrom(provider.customEnv ?? {}),
  );
  const savedAuthMode = provider.anthropicAuthMode ?? 'auto';
  // Null until the user picks one: the select follows the saved header,
  // which a test may store (a reload brings it in) while this is open.
  const [authModeDraft, setAuthModeDraft] = useState<
    ProviderAuthMode | 'auto' | null
  >(null);
  const authMode = authModeDraft ?? savedAuthMode;
  const savedWebFetchPolicy =
    provider.webFetchPreflightPolicy === 'skip' ? 'skip' : 'check';
  const [webFetchPolicyDraft, setWebFetchPolicyDraft] =
    useState<WebFetchPreflightPolicy | null>(null);
  const webFetchPolicy = webFetchPolicyDraft ?? savedWebFetchPolicy;
  const [saving, setSaving] = useState(false);
  const baseUrlProblem =
    kind === 'custom' ? describeBaseUrlProblem(baseUrl) : null;

  // A ChatGPT connection shows only the WebFetch switch here: CodexDefaults
  // saves its env, which leaves the env draft above a stale snapshot.
  const editsProtocol = kind !== 'chatgpt';
  const built = buildProviderCustomEnv(env);
  const envChanged =
    editsProtocol && !sameEnv(built.customEnv, provider.customEnv ?? {});
  const urlChanged =
    kind === 'custom' && baseUrl.trim() !== provider.anthropicBaseUrl;
  const authModeChanged = editsProtocol && authMode !== savedAuthMode;
  const protocolChanged =
    urlChanged || !!secret.trim() || envChanged || authModeChanged;
  const webFetchPolicyChanged = webFetchPolicy !== savedWebFetchPolicy;
  const dirty = protocolChanged || webFetchPolicyChanged;

  const save = async () => {
    if (built.error) {
      setError(built.error);
      return;
    }
    if (urlChanged && !baseUrl.trim()) {
      setError('请填写服务地址');
      return;
    }
    if (protocolChanged && !(await confirmProtocolChange(provider))) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = {};
      if (webFetchPolicyChanged) patch.webFetchPreflightPolicy = webFetchPolicy;
      if (urlChanged) patch.anthropicBaseUrl = baseUrl.trim();
      // Null clears the stored header, so the server falls back again.
      if (authModeChanged) {
        patch.anthropicAuthMode = authMode === 'auto' ? null : authMode;
      }
      if (envChanged) patch.customEnv = built.customEnv;
      if (secret.trim()) {
        if (thirdParty) {
          // The key travels with the other fields: one request, one runner
          // restart, and never an address saved without its key.
          patch.anthropicAuthToken = secret.trim();
        } else if (kind === 'anthropic_api') {
          secrets.anthropicApiKey = secret.trim();
        } else {
          // 服务端解析粘贴原文，并保证官方连接只保留一种凭据
          secrets.claudeCredentialInput = secret.trim();
        }
      }
      const saved =
        Object.keys(patch).length > 0
          ? await updateConnection(provider.id, patch)
          : undefined;
      if (Object.keys(secrets).length > 0) {
        await saveConnectionSecrets(provider.id, secrets);
      }
      setSecret('');
      setAuthModeDraft(null);
      setWebFetchPolicyDraft(null);
      setNotice(
        protocolChanged
          ? '连接设置已保存；建议测试一次连接'
          : '网页抓取设置已保存，当前回复结束后生效',
      );
      // The PATCH answer is the saved state; a new credential also changes
      // masked fields it lacks, so reload after applying it.
      onChanged(saved);
      if (saved && Object.keys(secrets).length > 0) onChanged();
    } catch (err) {
      setError(getErrorMessage(err, '保存连接设置失败'));
    } finally {
      setSaving(false);
    }
  };

  const relogin = () => {
    setNotice('登录成功，凭据已更新');
    onChanged();
  };

  return (
    <SettingsSection
      title="连接设置"
      description="修改地址、密钥或环境变量会停止正在使用它的会话；下一条消息开启新的 SDK 会话，聊天记录保留。"
    >
      {kind === 'claude_subscription' && (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border">
          {provider.claudeOAuthNeedsReLogin && (
            <ReloginAlert
              title={
                provider.claudeOAuthLastRefreshError?.kind ===
                'account_mismatch'
                  ? '续期返回了另一个账号，已拒绝写入，请重新登录'
                  : '授权已失效，需要重新登录 Claude'
              }
              message={provider.claudeOAuthLastRefreshError?.message}
            />
          )}
          {provider.hasClaudeOAuthCredentials && (
            <div className="space-y-0.5 text-caption leading-5 text-muted-foreground">
              {(provider.claudeOAuthAccountEmail ||
                provider.claudeOAuthSubscriptionType) && (
                <div className="text-foreground">
                  账号：{provider.claudeOAuthAccountEmail ?? '未知'}
                  {provider.claudeOAuthSubscriptionType
                    ? `（${provider.claudeOAuthSubscriptionType}）`
                    : ''}
                  {provider.claudeOAuthOrganizationName
                    ? ` · ${provider.claudeOAuthOrganizationName}`
                    : ''}
                </div>
              )}
              <div>
                Access Token：
                <span className="font-mono">
                  {provider.claudeOAuthCredentialsAccessTokenMasked || '***'}
                </span>
              </div>
              {provider.claudeOAuthCredentialsExpiresAt && (
                <div>
                  过期时间：
                  {formatTime(provider.claudeOAuthCredentialsExpiresAt)}
                </div>
              )}
              <div>
                HappyClaw 会在过期前自动续期
                {provider.claudeOAuthLastRefreshAt
                  ? `，上次续期 ${formatTime(provider.claudeOAuthLastRefreshAt)}`
                  : ''}
                。
              </div>
            </div>
          )}
          {provider.hasClaudeCodeOauthToken && (
            <div className="text-caption text-muted-foreground">
              Setup Token：
              <span className="font-mono">
                {provider.claudeCodeOauthTokenMasked}
              </span>
            </div>
          )}
          <OAuthLoginPanel
            service="claude"
            targetProviderId={provider.id}
            onSuccess={relogin}
          />
        </div>
      )}

      {kind === 'chatgpt' && (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border">
          {provider.codexOAuthNeedsReauth && (
            <ReloginAlert
              title="ChatGPT 授权已失效，请重新登录"
              message={provider.codexOAuthLastRefreshError?.message}
            />
          )}
          {(provider.codexOAuthCredentialsEmail ||
            provider.codexOAuthCredentialsExpiresAt) && (
            <div className="space-y-0.5 text-caption leading-5 text-muted-foreground">
              {provider.codexOAuthCredentialsEmail && (
                <div className="text-foreground">
                  账号：{provider.codexOAuthCredentialsEmail}
                  {provider.codexOAuthCredentialsPlanType
                    ? `（${provider.codexOAuthCredentialsPlanType}）`
                    : ''}
                </div>
              )}
              <div>网关会在 token 过期时自动刷新。</div>
            </div>
          )}
          <OAuthLoginPanel
            service="chatgpt"
            targetProviderId={provider.id}
            onSuccess={relogin}
          />
        </div>
      )}

      {kind !== 'chatgpt' && (
        <div className="space-y-4">
          {thirdParty && (
            <SettingsField
              label="服务地址"
              htmlFor="connection-base-url"
              description={
                kind === 'preset' ? (
                  `「${presetName}」预设的地址，不能修改；需要其他地址请添加自定义连接。`
                ) : baseUrlProblem ? (
                  <span className="flex gap-1.5 text-warning">
                    <TriangleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {baseUrlProblem}
                  </span>
                ) : undefined
              }
            >
              <Input
                variant="code"
                id="connection-base-url"
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                readOnly={kind === 'preset'}
                disabled={saving}
                autoComplete="off"
                className="font-mono"
              />
            </SettingsField>
          )}
          <SettingsField
            label={
              kind === 'claude_subscription'
                ? '粘贴新的 setup-token 或 .credentials.json'
                : '更换 API Key'
            }
            htmlFor="connection-secret"
            description={
              thirdParty && provider.hasAnthropicAuthToken
                ? `当前 ${provider.anthropicAuthTokenMasked ?? '已设置'}；留空保留。`
                : kind === 'anthropic_api' && provider.hasAnthropicApiKey
                  ? `当前 ${provider.anthropicApiKeyMasked ?? '已设置'}；留空保留。`
                  : undefined
            }
          >
            <Input
              variant="code"
              id="connection-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              disabled={saving}
              placeholder="留空保留当前凭据"
              autoComplete="new-password"
              className="font-mono"
            />
          </SettingsField>
          {thirdParty && (
            <SettingsField
              label="认证方式"
              htmlFor="connection-auth-mode"
              description={
                authMode === 'auto'
                  ? AUTO_AUTH_MODE_HINT
                  : '只用这一种请求头发送密钥。'
              }
            >
              <NativeSelect
                id="connection-auth-mode"
                value={authMode}
                onChange={(event) =>
                  setAuthModeDraft(
                    event.target.value as ProviderAuthMode | 'auto',
                  )
                }
                disabled={saving}
                className="w-full sm:w-72"
              >
                <NativeSelectOption value="auto">自动判断</NativeSelectOption>
                {(['bearer', 'x-api-key'] as const).map((mode) => (
                  <NativeSelectOption key={mode} value={mode}>
                    {AUTH_MODE_LABELS[mode]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </SettingsField>
          )}
          <ProviderEnvEditor value={env} onChange={setEnv} disabled={saving} />
        </div>
      )}
      <SettingsField
        label="网页抓取域名检查"
        htmlFor="connection-web-fetch-preflight"
        description="抓取网页前先向 Anthropic 查询域名；连不上 Anthropic 时选择跳过。对使用此连接的所有会话生效。"
      >
        <NativeSelect
          id="connection-web-fetch-preflight"
          value={webFetchPolicy}
          onChange={(event) =>
            setWebFetchPolicyDraft(
              event.target.value as WebFetchPreflightPolicy,
            )
          }
          disabled={saving}
          className="w-full sm:w-72"
        >
          <NativeSelectOption value="check">
            跟随 Claude Code 设置（默认检查）
          </NativeSelectOption>
          <NativeSelectOption value="skip">跳过检查</NativeSelectOption>
        </NativeSelect>
      </SettingsField>
      <Button onClick={() => void save()} disabled={!dirty || saving}>
        {saving && <Loader2 className="animate-spin" />}
        保存连接设置
      </Button>
    </SettingsSection>
  );
}
