import { useEffect, useState, useRef } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2 } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ContainerEnvPanelProps {
  groupJid: string;
  onClose?: () => void;
}

const MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const MODEL_PRESETS = ['opus', 'sonnet', 'haiku'] as const;

export function ContainerEnvPanel({ groupJid, onClose }: ContainerEnvPanelProps) {
  const { configs, loading, saving, loadConfig, saveConfig } = useContainerEnvStore();
  const config = configs[groupJid];

  // Draft state for form fields
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [model, setModel] = useState('');
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (groupJid) loadConfig(groupJid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Cleanup save-success timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Sync config to draft when loaded
  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.anthropicBaseUrl || '');
    setAuthToken('');
    setAuthTokenDirty(false);
    const entries = Object.entries(config.customEnv || {}).map(([key, value]) => ({ key, value }));
    const modelFromConfig = (config.customEnv && config.customEnv[MODEL_ENV_KEY]) || '';
    setModel(modelFromConfig);
    setCustomEnv(entries.filter(({ key }) => key !== MODEL_ENV_KEY));
  }, [config]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};

    // Always send baseUrl
    data.anthropicBaseUrl = baseUrl;

    // Only update secret when field has been edited.
    // If edited to empty string, backend will clear override and fall back to global.
    if (authTokenDirty) data.anthropicAuthToken = authToken;

    // Build custom env (filter empty keys)
    const envMap: Record<string, string> = {};
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k || k === MODEL_ENV_KEY) continue;
      envMap[k] = value;
    }
    const normalizedModel = model.trim();
    if (normalizedModel) {
      envMap[MODEL_ENV_KEY] = normalizedModel;
    }
    data.customEnv = envMap;

    const ok = await saveConfig(groupJid, data as {
      anthropicBaseUrl?: string;
      anthropicAuthToken?: string;
      customEnv?: Record<string, string>;
    });
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
      setAuthToken('');
      setAuthTokenDirty(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定要清空所有覆盖配置并重建工作区吗？')) return;
    setClearing(true);
    const ok = await saveConfig(groupJid, {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      customEnv: {},
    });
    setClearing(false);
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const addCustomEnv = () => {
    setCustomEnv((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeCustomEnv = (index: number) => {
    setCustomEnv((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCustomEnv = (index: number, field: 'key' | 'value', val: string) => {
    setCustomEnv((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item))
    );
  };

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-slate-400 text-center">加载中...</div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">工作区环境变量</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(groupJid)}
            className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          覆盖全局 Claude 配置，仅对当前工作区生效。留空则使用全局配置。保存后工作区将自动重建。
        </p>

        {/* Claude Provider Fields */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              ANTHROPIC_BASE_URL
            </label>
            <Input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="留空使用全局配置"
              className="px-2.5 py-1.5 text-xs h-auto"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              ANTHROPIC_AUTH_TOKEN
              {config?.hasAnthropicAuthToken && (
                <span className="ml-1.5 text-[10px] text-slate-400 font-normal">
                  ({config.anthropicAuthTokenMasked})
                </span>
              )}
            </label>
            <Input
              type="password"
              value={authToken}
              onChange={(e) => {
                setAuthToken(e.target.value);
                setAuthTokenDirty(true);
              }}
              placeholder={config?.hasAnthropicAuthToken ? '已设置，输入新值覆盖；留空可清除覆盖' : '留空使用全局配置'}
              className="px-2.5 py-1.5 text-xs h-auto"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              模型（ANTHROPIC_MODEL）
            </label>
            <div className="space-y-1.5">
              <Input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="opus / sonnet / haiku 或完整模型 ID"
                className="px-2.5 py-1.5 text-xs h-auto font-mono"
                list="anthropic-model-presets"
              />
              <datalist id="anthropic-model-presets">
                {MODEL_PRESETS.map((preset) => (
                  <option key={preset} value={preset} />
                ))}
              </datalist>
              <p className="text-[11px] text-slate-400">
                留空则回退到全局配置（默认值通常为 <code className="bg-slate-100 px-1 rounded">opus</code>）。
              </p>
            </div>
          </div>

        </div>

        {/* Separator */}
        <div className="border-t border-slate-100" />

        {/* Custom Env Vars */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-slate-600">自定义环境变量</label>
            <button
              onClick={addCustomEnv}
              className="flex-shrink-0 flex items-center gap-1 text-[11px] text-primary hover:text-primary cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>

          {customEnv.length === 0 ? (
            <p className="text-[11px] text-slate-400">暂无自定义变量</p>
          ) : (
            <div className="space-y-1.5">
              {customEnv.map((item, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    value={item.key}
                    onChange={(e) => updateCustomEnv(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="w-[40%] px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <span className="text-slate-300 text-xs">=</span>
                  <Input
                    type="text"
                    value={item.value}
                    onChange={(e) => updateCustomEnv(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <button
                    onClick={() => removeCustomEnv(i)}
                    className="flex-shrink-0 p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-slate-200 space-y-2">
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || clearing} className="flex-1" size="sm">
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
          <Button
            onClick={handleClear}
            disabled={saving || clearing}
            variant="outline"
            size="sm"
            title="清空所有覆盖配置"
          >
            {clearing && <Loader2 className="size-4 animate-spin" />}
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
        {saveSuccess && (
          <p className="text-[11px] text-primary text-center">
            配置已保存，工作区已重建
          </p>
        )}
      </div>
    </div>
  );
}
