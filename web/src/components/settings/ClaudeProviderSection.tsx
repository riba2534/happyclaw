import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Plus, RefreshCw, Rocket, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api } from '../../api/client';
import type {
  ClaudeConfigPublic,
  ClaudeCustomEnvResp,
  ClaudeApplyResult,
  EnvRow,
  SettingsNotification,
} from './types';
import { getErrorMessage } from './types';

type ProviderMode = 'official' | 'third_party';

interface ClaudeProviderSectionProps extends SettingsNotification {}

export function ClaudeProviderSection({ setNotice, setError }: ClaudeProviderSectionProps) {
  const [config, setConfig] = useState<ClaudeConfigPublic | null>(null);
  const [providerMode, setProviderMode] = useState<ProviderMode>('third_party');

  const [officialCode, setOfficialCode] = useState('');

  // OAuth flow state
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);

  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configData, customEnvData] = await Promise.all([
        api.get<ClaudeConfigPublic>('/api/config/claude'),
        api.get<ClaudeCustomEnvResp>('/api/config/claude/custom-env'),
      ]);

      setConfig(configData);
      setBaseUrl(configData.anthropicBaseUrl || '');
      setAuthToken('');
      setAuthTokenDirty(false);

      const envRows = Object.entries(customEnvData.customEnv || {}).map(([key, value]) => ({ key, value }));
      setCustomEnvRows(envRows);

      const inferredMode: ProviderMode =
        configData.hasClaudeCodeOauthToken &&
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

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const updatedAt = useMemo(() => {
    if (!config?.updatedAt) return '未记录';
    return new Date(config.updatedAt).toLocaleString('zh-CN');
  }, [config?.updatedAt]);

  const handleSaveOfficial = async () => {
    if (!officialCode.trim()) {
      setError('请填写官方 setup-token');
      return;
    }

    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      await api.put<ClaudeConfigPublic>('/api/config/claude', {
        anthropicBaseUrl: '',
      });

      const saved = await api.put<ClaudeConfigPublic>('/api/config/claude/secrets', {
        claudeCodeOauthToken: officialCode.trim(),
        clearAnthropicAuthToken: true,
        clearAnthropicApiKey: true,
      });

      setConfig(saved);
      setOfficialCode('');
      setProviderMode('official');
      setNotice('官方提供商 setup-token 已保存。');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '保存官方提供商配置失败'));
    } finally {
      setSaving(false);
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
    setSaving(true);
    setNotice(null);
    setError(null);

    try {
      await api.put<ClaudeConfigPublic>('/api/config/claude', {
        anthropicBaseUrl: baseUrl,
      });

      const secretPayload: Record<string, unknown> = {
        clearClaudeCodeOauthToken: true,
        clearAnthropicApiKey: true,
      };
      if (authTokenDirty) secretPayload.anthropicAuthToken = authToken;
      const saved = await api.put<ClaudeConfigPublic>('/api/config/claude/secrets', secretPayload);
      setConfig(saved);

      const customEnv: Record<string, string> = {};
      for (const row of customEnvRows) {
        const k = row.key.trim();
        if (!k) continue;
        customEnv[k] = row.value;
      }
      await api.put<ClaudeCustomEnvResp>('/api/config/claude/custom-env', { customEnv });

      setAuthToken('');
      setAuthTokenDirty(false);
      setProviderMode('third_party');
      setNotice('第三方提供商配置已保存。');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '保存第三方提供商配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const [showApplyConfirm, setShowApplyConfirm] = useState(false);

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
  const removeRow = (index: number) => setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-slate-200 p-1 bg-slate-50 mb-4">
        <button
          type="button"
          onClick={() => setProviderMode('official')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            providerMode === 'official' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'
          }`}
        >
          官方
        </button>
        <button
          type="button"
          onClick={() => setProviderMode('third_party')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            providerMode === 'third_party' ? 'bg-white text-primary shadow-sm' : 'text-slate-500'
          }`}
        >
          第三方
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

          <div>
            <label className="block text-xs text-slate-600 mb-1">
              官方 setup-token {config?.hasClaudeCodeOauthToken ? `(${config.claudeCodeOauthTokenMasked})` : ''}
            </label>
            <Input
              type="password"
              value={officialCode}
              onChange={(e) => setOfficialCode(e.target.value)}
              disabled={loading || saving}
              placeholder={config?.hasClaudeCodeOauthToken ? '输入新值覆盖' : '粘贴 claude setup-token 输出'}
            />
          </div>

          <Button onClick={handleSaveOfficial} disabled={loading || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存官方 setup-token
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
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
              <label className="block text-xs text-slate-600 mb-1">
                ANTHROPIC_AUTH_TOKEN {config?.hasAnthropicAuthToken ? `(${config.anthropicAuthTokenMasked})` : ''}
              </label>
              <Input
                type="password"
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                  setAuthTokenDirty(true);
                }}
                disabled={loading || saving}
                placeholder={config?.hasAnthropicAuthToken ? '留空并保存可清空' : '输入 Token'}
              />
            </div>

          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-slate-600">其他自定义环境变量</label>
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
            保存第三方配置
          </Button>
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

      <div className="text-xs text-slate-500">最近保存：{updatedAt}</div>

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
    </div>
  );
}
