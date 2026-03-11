import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Edit3,
  ExternalLink,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  X,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api } from '../../api/client';
import type {
  ClaudeConfigPublic,
  ClaudeApplyResult,
  ClaudeThirdPartyActivateResult,
  ClaudeThirdPartyProfileItem,
  ClaudeThirdPartyProfilesResp,
  EnvRow,
  SettingsNotification,
} from './types';
import { getErrorMessage } from './types';

type ProviderMode = 'official' | 'third_party';
type ProfileEditorMode = 'create' | 'edit';

const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HAPPYCLAW_MODEL',
]);

interface ClaudeProviderSectionProps extends SettingsNotification {}

function formatDateTime(value: string | null): string {
  if (!value) return '未记录';
  return new Date(value).toLocaleString('zh-CN');
}

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

export function ClaudeProviderSection({ setNotice, setError }: ClaudeProviderSectionProps) {
  const [config, setConfig] = useState<ClaudeConfigPublic | null>(null);
  const [profilesState, setProfilesState] = useState<ClaudeThirdPartyProfilesResp | null>(null);
  const [providerMode, setProviderMode] = useState<ProviderMode>('third_party');

  const [officialCode, setOfficialCode] = useState('');

  // OAuth flow state
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);

  // Third-party profile editor
  const [editorMode, setEditorMode] = useState<ProfileEditorMode>('create');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  // Local Claude Code detection
  const [localCC, setLocalCC] = useState<{
    detected: boolean;
    hasCredentials: boolean;
    expiresAt: number | null;
    accessTokenMasked: string | null;
  } | null>(null);
  const [localCCImporting, setLocalCCImporting] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);

  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<ClaudeThirdPartyProfileItem | null>(null);

  const activeProfile = useMemo(() => {
    if (!profilesState) return null;
    return (
      profilesState.profiles.find((profile) => profile.id === profilesState.activeProfileId) ||
      profilesState.profiles[0] ||
      null
    );
  }, [profilesState]);

  const editingProfile = useMemo(() => {
    if (!profilesState || !editingProfileId) return null;
    return profilesState.profiles.find((profile) => profile.id === editingProfileId) || null;
  }, [profilesState, editingProfileId]);

  const resetEditorForCreate = useCallback((defaultModel = '') => {
    setEditorMode('create');
    setEditingProfileId(null);
    setProfileName('');
    setBaseUrl('');
    setModel(defaultModel);
    setAuthToken('');
    setAuthTokenDirty(false);
    setClearTokenOnSave(false);
    setCustomEnvRows([]);
    setIsEditorOpen(true);
  }, []);

  const fillEditorFromProfile = useCallback((profile: ClaudeThirdPartyProfileItem) => {
    setEditorMode('edit');
    setEditingProfileId(profile.id);
    setProfileName(profile.name);
    setBaseUrl(profile.anthropicBaseUrl || '');
    setModel(profile.happyclawModel || '');
    setAuthToken('');
    setAuthTokenDirty(false);
    setClearTokenOnSave(false);
    const envRows = Object.entries(profile.customEnv || {}).map(([key, value]) => ({ key, value }));
    setCustomEnvRows(envRows);
    setIsEditorOpen(true);
  }, []);

  // Claude API status from status.claude.com
  const [claudeStatus, setClaudeStatus] = useState<{
    indicator: string;
    components: { name: string; status: string }[];
  } | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [configData, profilesData] = await Promise.all([
        api.get<ClaudeConfigPublic>('/api/config/claude'),
        api.get<ClaudeThirdPartyProfilesResp>('/api/config/claude/third-party/profiles'),
      ]);

      setConfig(configData);
      setProfilesState(profilesData);

      // Load customEnvRows from the active profile
      const activeId = profilesData.activeProfileId;
      const activeProf = profilesData.profiles.find((p) => p.id === activeId) || profilesData.profiles[0];
      if (activeProf) {
        const envRows = Object.entries(activeProf.customEnv || {}).map(([key, value]) => ({ key, value }));
        setCustomEnvRows(envRows);
      } else {
        setCustomEnvRows([]);
      }

      const inferredMode: ProviderMode =
        (configData.hasClaudeCodeOauthToken || configData.hasClaudeOAuthCredentials) &&
        !configData.hasAnthropicAuthToken &&
        !configData.anthropicBaseUrl
          ? 'official'
          : 'third_party';
      setProviderMode(inferredMode);
    } catch (err) {
      setError(getErrorMessage(err, '加载 Claude 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Detect local Claude Code credentials
  useEffect(() => {
    api.get<{
      detected: boolean;
      hasCredentials: boolean;
      expiresAt: number | null;
      accessTokenMasked: string | null;
    }>('/api/config/claude/detect-local').then(setLocalCC).catch(() => {});
  }, []);

  // Fetch Claude service status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const [statusRes, compRes] = await Promise.all([
          fetch('https://status.claude.com/api/v2/status.json'),
          fetch('https://status.claude.com/api/v2/components.json'),
        ]);
        if (!statusRes.ok || !compRes.ok) return;
        const statusData = await statusRes.json();
        const compData = await compRes.json();
        const keyComponents = (compData.components || [])
          .filter((c: any) => ['Claude API (api.anthropic.com)', 'claude.ai', 'Claude Code'].includes(c.name))
          .map((c: any) => ({ name: c.name, status: c.status as string }));
        setClaudeStatus({
          indicator: statusData.status?.indicator || 'none',
          components: keyComponents,
        });
      } catch {
        // silently ignore - status is non-critical
      }
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(timer);
  }, []);

  const updatedAt = useMemo(() => {
    return formatDateTime(config?.updatedAt ?? null);
  }, [config?.updatedAt]);

  // Switch back to official using existing OAuth credentials (no re-auth needed)
  const handleUseExistingOAuth = async () => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      await api.put<ClaudeConfigPublic>('/api/config/claude', {
        anthropicBaseUrl: '',
      });
      const saved = await api.put<ClaudeConfigPublic>('/api/config/claude/secrets', {
        clearAnthropicAuthToken: true,
        clearAnthropicApiKey: true,
      });
      setConfig(saved);
      setProviderMode('official');
      setNotice('已切换回官方渠道，使用已有 OAuth 凭据。');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '切换失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOfficial = async () => {
    if (!officialCode.trim()) {
      setError('请填写官方 setup-token 或粘贴 .credentials.json 内容');
      return;
    }

    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      // Detect if user pasted .credentials.json content
      const trimmed = officialCode.trim();
      let isCredentialsJson = false;
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
          if (oauth?.accessToken && oauth?.refreshToken) {
            isCredentialsJson = true;
            // Step 1: clear auth token and set OAuth credentials first
            // (backend validation requires anthropicAuthToken to have a baseUrl,
            //  so we must clear the token before we can clear the baseUrl)
            await api.put<ClaudeConfigPublic>('/api/config/claude/secrets', {
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
            // Step 2: now that auth token is cleared, clear the base URL
            const saved = await api.put<ClaudeConfigPublic>('/api/config/claude', {
              anthropicBaseUrl: '',
            });
            setConfig(saved);
            setOfficialCode('');
            setProviderMode('official');
            setNotice('OAuth 凭据已保存。');
            await loadConfig();
            return;
          }
        } catch {
          // Not valid JSON, treat as setup-token
        }
      }

      if (!isCredentialsJson) {
        // Step 1: clear auth token and set oauth token first
        // (backend validation requires anthropicAuthToken to have a baseUrl,
        //  so we must clear the token before we can clear the baseUrl)
        await api.put<ClaudeConfigPublic>('/api/config/claude/secrets', {
          claudeCodeOauthToken: trimmed,
          clearAnthropicAuthToken: true,
          clearAnthropicApiKey: true,
        });
        // Step 2: now that auth token is cleared, clear the base URL
        const saved = await api.put<ClaudeConfigPublic>('/api/config/claude', {
          anthropicBaseUrl: '',
        });
        setConfig(saved);
        setOfficialCode('');
        setProviderMode('official');
        setNotice('官方提供商 setup-token 已保存。');
        await loadConfig();
      }
    } catch (err) {
      setError(getErrorMessage(err, '保存官方提供商配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleImportLocalCC = async () => {
    setLocalCCImporting(true);
    setNotice(null);
    setError(null);
    try {
      await api.post('/api/config/claude/import-local');
      setNotice('已导入本机 Claude Code 登录凭据。');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '导入本机凭据失败'));
    } finally {
      setLocalCCImporting(false);
    }
  };

  const handleOAuthStart = async () => {
    setOauthLoading(true);
    setError(null);
    setNotice(null);
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
    setNotice(null);
    try {
      await api.post<ClaudeConfigPublic>('/api/config/claude/oauth/callback', {
        state: oauthState,
        code: oauthCode.trim(),
      });
      setOauthState(null);
      setOauthCode('');
      setNotice('Claude OAuth 登录成功，token 已保存。');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  };

  const handleSaveThirdParty = async () => {
    const trimmedName = profileName.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedModel = model.trim();
    const trimmedToken = authToken.trim();

    if (!trimmedName) {
      setError('请填写配置名称');
      return;
    }
    if (!trimmedBaseUrl) {
      setError('请填写 ANTHROPIC_BASE_URL');
      return;
    }
    if (editorMode === 'create' && !trimmedToken) {
      setError('新增配置时必须填写 ANTHROPIC_AUTH_TOKEN');
      return;
    }

    const envResult = buildCustomEnv(customEnvRows);
    if (envResult.error) {
      setError(envResult.error);
      return;
    }

    setSaving(true);
    setNotice(null);
    setError(null);

    try {
      if (editorMode === 'create') {
        await api.post<ClaudeThirdPartyProfileItem>('/api/config/claude/third-party/profiles', {
          name: trimmedName,
          anthropicBaseUrl: trimmedBaseUrl,
          anthropicAuthToken: trimmedToken,
          happyclawModel: trimmedModel,
          customEnv: envResult.customEnv,
        });
      } else {
        if (!editingProfileId) {
          setError('未选择要编辑的配置');
          return;
        }

        await api.patch<ClaudeThirdPartyProfileItem>(
          `/api/config/claude/third-party/profiles/${editingProfileId}`,
          {
            name: trimmedName,
            anthropicBaseUrl: trimmedBaseUrl,
            happyclawModel: trimmedModel,
            customEnv: envResult.customEnv,
          },
        );

        if (clearTokenOnSave || authTokenDirty) {
          const payload = clearTokenOnSave || !trimmedToken
            ? { clearAnthropicAuthToken: true }
            : { anthropicAuthToken: trimmedToken };
          await api.put<ClaudeThirdPartyProfileItem>(
            `/api/config/claude/third-party/profiles/${editingProfileId}/secrets`,
            payload,
          );
        }
      }

      setNotice(editorMode === 'create' ? '第三方配置已创建。' : '第三方配置已保存。');
      setIsEditorOpen(false);
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, editorMode === 'create' ? '创建第三方配置失败' : '保存第三方配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleActivateProfile = async (profile: ClaudeThirdPartyProfileItem) => {
    setActivatingProfileId(profile.id);
    setNotice(null);
    setError(null);

    try {
      const result = await api.post<ClaudeThirdPartyActivateResult>(
        `/api/config/claude/third-party/profiles/${profile.id}/activate`,
      );

      await loadConfig();

      if (result.alreadyActive) {
        setNotice(`配置「${profile.name}」已是当前激活状态`);
        return;
      }

      const applyText = `已自动应用并停止 ${result.stoppedCount} 个工作区` +
        (result.failedCount > 0 ? `，失败 ${result.failedCount} 个` : '');

      if (result.success) {
        setNotice(`已切换到「${profile.name}」，${applyText}`);
      } else {
        setError(result.error || `已切换到「${profile.name}」，但自动应用部分失败：${applyText}`);
      }
    } catch (err) {
      setError(getErrorMessage(err, '切换第三方配置失败'));
    } finally {
      setActivatingProfileId(null);
    }
  };

  const handleDeleteProfile = async () => {
    if (!pendingDeleteProfile) return;

    const profile = pendingDeleteProfile;
    setDeletingProfileId(profile.id);
    setPendingDeleteProfile(null);
    setNotice(null);
    setError(null);

    try {
      await api.delete(`/api/config/claude/third-party/profiles/${profile.id}`);
      setNotice(`已删除配置「${profile.name}」`);
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '删除第三方配置失败'));
    } finally {
      setDeletingProfileId(null);
    }
  };

  const doApply = async () => {
    setShowApplyConfirm(false);
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<ClaudeApplyResult>('/api/config/claude/apply');
      if (result.success) {
        setNotice(`已应用配置并停止 ${result.stoppedCount} 个活动工作区`);
      } else {
        const suffix = typeof result.failedCount === 'number' ? `（失败 ${result.failedCount} 个）` : '';
        setError(result.error || `应用配置部分失败${suffix}`);
      }
    } catch (err) {
      setError(getErrorMessage(err, '应用配置失败'));
    } finally {
      setApplying(false);
    }
  };

  const handleApply = () => setShowApplyConfirm(true);

  const addRow = () => setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-slate-200 p-1 bg-slate-50 mb-4">
        <button
          type="button"
          onClick={() => setProviderMode('official')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            providerMode === 'official' ? 'bg-background text-primary shadow-sm' : 'text-slate-500'
          }`}
        >
          官方
        </button>
        <button
          type="button"
          onClick={() => setProviderMode('third_party')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            providerMode === 'third_party' ? 'bg-background text-primary shadow-sm' : 'text-slate-500'
          }`}
        >
          第三方
        </button>
      </div>

      {providerMode === 'official' ? (
        <div className="space-y-4">
          {config?.hasClaudeOAuthCredentials && (
            <div className={`rounded-lg border p-4 space-y-2 ${
              config.claudeOAuthCredentialsExpiresAt && config.claudeOAuthCredentialsExpiresAt <= Date.now()
                ? 'border-red-300 bg-red-50/50'
                : 'border-emerald-200 bg-emerald-50/50'
            }`}>
              <div className="flex items-center justify-between">
                <div className={`text-sm font-medium ${
                  config.claudeOAuthCredentialsExpiresAt && config.claudeOAuthCredentialsExpiresAt <= Date.now()
                    ? 'text-red-800'
                    : 'text-emerald-800'
                }`}>
                  OAuth 凭据
                </div>
              </div>
              <div className="text-xs text-emerald-700">
                Access Token: {config.claudeOAuthCredentialsAccessTokenMasked || '***'}
              </div>
              {config.claudeOAuthCredentialsExpiresAt && (
                <div className={`text-xs ${
                  config.claudeOAuthCredentialsExpiresAt <= Date.now()
                    ? 'text-red-700 font-medium'
                    : 'text-emerald-700'
                }`}>
                  过期时间: {new Date(config.claudeOAuthCredentialsExpiresAt).toLocaleString('zh-CN')}
                  {config.claudeOAuthCredentialsExpiresAt > Date.now()
                    ? ` (${Math.round((config.claudeOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                    : ' (已过期)'}
                </div>
              )}
              <div className="text-xs text-emerald-600">SDK 会在 token 过期时自动刷新。</div>
              {/* Show switch button when third-party config is still active */}
              {(config.anthropicBaseUrl || config.hasAnthropicAuthToken) && (
                <div className="pt-2 border-t border-emerald-200">
                  <div className="text-xs text-slate-600 mb-2">当前正在使用第三方渠道，可直接切换回官方。</div>
                  <Button size="sm" onClick={handleUseExistingOAuth} disabled={loading || saving}>
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    使用此凭据切换回官方
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Claude service status */}
          {claudeStatus && (
            <div className={`rounded-lg border p-3 space-y-1.5 ${
              claudeStatus.indicator === 'none'
                ? 'border-emerald-200 bg-emerald-50/50'
                : claudeStatus.indicator === 'minor'
                  ? 'border-amber-200 bg-amber-50/50'
                  : 'border-red-200 bg-red-50/50'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block size-2 rounded-full ${
                    claudeStatus.indicator === 'none'
                      ? 'bg-emerald-500'
                      : claudeStatus.indicator === 'minor'
                        ? 'bg-amber-500'
                        : 'bg-red-500'
                  }`} />
                  <span className="text-xs font-medium text-slate-700">Claude 服务状态</span>
                </div>
                <a
                  href="https://status.claude.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  详情
                </a>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                {claudeStatus.components.map((comp) => (
                  <div key={comp.name} className="flex items-center gap-1 text-xs text-slate-600">
                    <span className={`inline-block size-1.5 rounded-full ${
                      comp.status === 'operational'
                        ? 'bg-emerald-500'
                        : comp.status === 'degraded_performance'
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`} />
                    {comp.name.replace(' (api.anthropic.com)', '').replace(' (formerly console.anthropic.com)', '')}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Local Claude Code detection */}
          {localCC?.hasCredentials && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-blue-600" />
                <div className="text-sm font-medium text-slate-800">
                  检测到本机已登录 Claude Code
                </div>
              </div>
              <div className="text-xs text-slate-600">
                本机 <code className="bg-white/60 px-1 rounded">~/.claude/.credentials.json</code> 中存在有效凭据（{localCC.accessTokenMasked}），可一键导入{config?.hasClaudeOAuthCredentials ? '以更新当前凭据' : ''}。
              </div>
              <Button onClick={handleImportLocalCC} disabled={loading || localCCImporting}>
                {localCCImporting ? <Loader2 className="size-4 animate-spin" /> : <HardDrive className="size-4" />}
                {config?.hasClaudeOAuthCredentials ? '重新导入本机凭据' : '导入本机凭据'}
              </Button>
            </div>
          )}

          {/* OAuth one-click login */}
          <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
            <div className="text-sm font-medium text-slate-800">一键登录 Claude（推荐）</div>
            <div className="text-xs text-slate-600">
              点击按钮后会打开 claude.ai 授权页面，完成授权后将页面上显示的授权码粘贴回来。
            </div>

            {!oauthState ? (
              <Button onClick={handleOAuthStart} disabled={loading || oauthLoading}>
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

          <div className="relative flex items-center gap-3 text-xs text-slate-400">
            <div className="flex-1 border-t border-slate-200" />
            或手动粘贴 setup-token / .credentials.json
            <div className="flex-1 border-t border-slate-200" />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">
              setup-token 或 .credentials.json{' '}
              {config?.hasClaudeCodeOauthToken ? `(${config.claudeCodeOauthTokenMasked})` : ''}
            </label>
            <Input
              type="password"
              value={officialCode}
              onChange={(e) => setOfficialCode(e.target.value)}
              disabled={loading || saving}
              placeholder={
                config?.hasClaudeCodeOauthToken || config?.hasClaudeOAuthCredentials
                  ? '输入新值覆盖'
                  : '粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出'
              }
            />
            <p className="text-xs text-slate-400 mt-1">
              支持粘贴{' '}
              <code className="bg-slate-100 px-1 rounded">cat ~/.claude/.credentials.json</code>{' '}
              的 JSON 内容
            </p>
          </div>

          <Button onClick={handleSaveOfficial} disabled={loading || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存凭据
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/70">
              <div className="text-sm font-medium text-slate-800">第三方配置列表</div>
            </div>

            {!profilesState || profilesState.profiles.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">暂无第三方配置</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {profilesState.profiles.map((profile) => {
                  const isActive = profile.id === profilesState.activeProfileId;
                  const isEditing = editorMode === 'edit' && editingProfileId === profile.id;
                  const switching = activatingProfileId === profile.id;
                  const deleting = deletingProfileId === profile.id;

                  return (
                    <div key={profile.id} className="px-4 py-3 space-y-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-slate-900 break-all sm:break-normal">{profile.name}</span>
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${
                                isActive
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {isActive ? '已激活' : '未激活'}
                            </span>
                            {isEditing && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-brand-100 text-primary">编辑中</span>
                            )}
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
                            <div>
                              <div className="text-slate-400">Base URL</div>
                              <div className="text-slate-700 font-mono break-all sm:truncate">
                                {profile.anthropicBaseUrl || '-'}
                              </div>
                            </div>
                            <div>
                              <div className="text-slate-400">Model</div>
                              <div className="text-slate-700 font-mono break-all sm:truncate">
                                {profile.happyclawModel || '-'}
                              </div>
                            </div>
                            <div>
                              <div className="text-slate-400">Token</div>
                              <div className="text-slate-700 font-mono break-all sm:truncate">
                                {profile.anthropicAuthTokenMasked || '未设置'}
                              </div>
                            </div>
                            <div>
                              <div className="text-slate-400">更新时间</div>
                              <div className="text-slate-700">{formatDateTime(profile.updatedAt)}</div>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleActivateProfile(profile)}
                            disabled={
                              isActive ||
                              switching ||
                              deleting ||
                              loading ||
                              saving ||
                              applying ||
                              activatingProfileId !== null
                            }
                            className="min-w-[72px] justify-center"
                          >
                            {switching ? <Loader2 className="size-4 animate-spin" /> : null}
                            切换
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => fillEditorFromProfile(profile)}
                            disabled={loading || saving || applying || switching || deleting}
                            className="min-w-[72px] justify-center"
                          >
                            <Edit3 className="size-4" />
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPendingDeleteProfile(profile)}
                            disabled={
                              isActive ||
                              loading ||
                              saving ||
                              applying ||
                              switching ||
                              deleting ||
                              deletingProfileId !== null
                            }
                            className="min-w-[72px] justify-center"
                          >
                            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                            删除
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-start">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetEditorForCreate(config?.happyclawModel || '')}
              disabled={loading || saving || applying || activatingProfileId !== null || deletingProfileId !== null}
            >
              <Plus className="size-4" />
              新增配置
            </Button>
          </div>

          {isEditorOpen && (
            <div className="rounded-xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-slate-800">
                  {editorMode === 'create'
                    ? '新增第三方配置'
                    : `编辑第三方配置${editingProfile ? `：${editingProfile.name}` : ''}`}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsEditorOpen(false);
                    setEditingProfileId(null);
                    setEditorMode('create');
                    setAuthToken('');
                    setAuthTokenDirty(false);
                    setClearTokenOnSave(false);
                  }}
                  disabled={loading || saving}
                >
                  关闭
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">配置名称</label>
                  <Input
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    disabled={loading || saving}
                    placeholder="如：OpenRouter-主账号"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-600 mb-1">ANTHROPIC_BASE_URL</label>
                  <Input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={loading || saving}
                    placeholder="https://your-relay.example.com/v1"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-600 mb-1">HAPPYCLAW_MODEL</label>
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={loading || saving}
                    placeholder="opus / sonnet / haiku 或完整模型 ID"
                    className="font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-600 mb-1">
                    ANTHROPIC_AUTH_TOKEN{' '}
                    {editorMode === 'edit' && editingProfile?.hasAnthropicAuthToken
                      ? `(${editingProfile.anthropicAuthTokenMasked})`
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
                    disabled={loading || saving || clearTokenOnSave}
                    placeholder={
                      editorMode === 'create'
                        ? '输入 Token（必填）'
                        : editingProfile?.hasAnthropicAuthToken
                          ? '留空不变；输入新值覆盖'
                          : '输入 Token（可选）'
                    }
                  />
                  {editorMode === 'edit' && editingProfile?.hasAnthropicAuthToken && (
                    <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600">
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
                        disabled={loading || saving}
                      />
                      保存时清空当前 Token
                    </label>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-slate-600">其他自定义环境变量（可选）</label>
                  <button
                    type="button"
                    onClick={addRow}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    添加
                  </button>
                </div>
                <p className="mb-2 text-xs text-slate-500">
                  这些变量仅在当前配置生效，不同配置互不影响。
                </p>

                {customEnvRows.length === 0 ? (
                  <p className="text-xs text-slate-400">暂无</p>
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

              <Button onClick={handleSaveThirdParty} disabled={loading || saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {editorMode === 'create' ? '创建第三方配置' : '保存第三方配置'}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={loadConfig} disabled={loading || saving || applying}>
          <RefreshCw className="w-4 h-4" />
          重新加载
        </Button>
        <Button variant="destructive" onClick={handleApply} disabled={loading || saving || applying}>
          {applying && <Loader2 className="size-4 animate-spin" />}
          <Rocket className="w-4 h-4" />
          应用到所有工作区
        </Button>
      </div>

      <div className="text-xs text-slate-500">
        最近保存：{updatedAt}
        {providerMode === 'third_party' && activeProfile ? ` · 当前激活：${activeProfile.name}` : ''}
      </div>

      <ConfirmDialog
        open={showApplyConfirm}
        onClose={() => setShowApplyConfirm(false)}
        onConfirm={doApply}
        title="应用配置到所有工作区"
        message="这会停止所有活动工作区并清空其待处理队列，是否继续？"
        confirmText="确认应用"
        confirmVariant="danger"
        loading={applying}
      />

      <ConfirmDialog
        open={pendingDeleteProfile !== null}
        onClose={() => setPendingDeleteProfile(null)}
        onConfirm={handleDeleteProfile}
        title="删除第三方配置"
        message={pendingDeleteProfile ? `确认删除配置「${pendingDeleteProfile.name}」？` : '确认删除该配置？'}
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deletingProfileId !== null}
      />
    </div>
  );
}
