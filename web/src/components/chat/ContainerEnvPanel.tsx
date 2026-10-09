import { useEffect, useState, useRef } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2 } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollEdgeAffordance } from '../common/ScrollEdgeAffordance';
import { confirmDialog } from '../../stores/confirm';

interface ContainerEnvPanelProps {
  groupJid: string;
  onClose?: () => void;
}

const SYSTEM_MANAGED_ENV_KEYS = new Set([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export function ContainerEnvPanel({
  groupJid,
  onClose,
}: ContainerEnvPanelProps) {
  const { configs, loading, saving, error, loadConfig, saveConfig } =
    useContainerEnvStore();
  const config = configs[groupJid];

  // Draft state for form fields
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>(
    [],
  );
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const contentScrollRef = useRef<HTMLDivElement>(null);

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
    const entries = Object.entries(config.customEnv || {}).map(
      ([key, value]) => ({ key, value }),
    );
    setCustomEnv(
      entries.filter(({ key }) => !SYSTEM_MANAGED_ENV_KEYS.has(key)),
    );
  }, [config]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};

    // Build custom env (filter empty keys)
    const envMap: Record<string, string> = {};
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k || SYSTEM_MANAGED_ENV_KEYS.has(k)) continue;
      envMap[k] = value;
    }
    // Keep legacy system overrides intact while removing them from the editor.
    // Administrators can migrate/clear them through the compatibility API.
    for (const key of SYSTEM_MANAGED_ENV_KEYS) {
      const legacyValue = config?.customEnv?.[key];
      if (legacyValue) envMap[key] = legacyValue;
    }
    data.customEnv = envMap;

    const ok = await saveConfig(
      groupJid,
      data as {
        anthropicBaseUrl?: string;
        anthropicAuthToken?: string;
        customEnv?: Record<string, string>;
      },
    );
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const handleClear = async () => {
    const confirmed = await confirmDialog({
      title: '清空覆盖配置',
      message: '确定要清空所有覆盖配置并重建工作区吗？',
      confirmText: '清空并重建',
      variant: 'danger',
    });
    if (!confirmed) return;
    setClearing(true);
    const ok = await saveConfig(groupJid, {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      anthropicModel: '',
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

  const updateCustomEnv = (
    index: number,
    field: 'key' | 'value',
    val: string,
  ) => {
    setCustomEnv((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item)),
    );
  };

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        加载中...
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-destructive">环境变量加载失败：{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadConfig(groupJid)}
        >
          重试
        </Button>
      </div>
    );
  }

  const hasLegacySystemOverride = Boolean(
    config?.anthropicModel ||
    config?.anthropicBaseUrl ||
    config?.hasAnthropicAuthToken ||
    config?.hasAnthropicApiKey ||
    config?.hasClaudeCodeOauthToken ||
    Object.keys(config?.customEnv ?? {}).some((key) =>
      SYSTEM_MANAGED_ENV_KEYS.has(key),
    ),
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-foreground text-sm">
          工作区环境变量
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(groupJid)}
            className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-2 rounded-md hover:bg-muted cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={contentScrollRef}
          className="hc-scroll-pane h-full overflow-y-auto px-4 py-3 space-y-4"
          data-testid="environment-scroll"
        >
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            这里保存项目运行需要的环境变量，仅对当前工作区生效。Provider
            地址和凭据由系统管理员统一管理；保存后工作区会自动重建。
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-5 text-destructive"
            >
              保存失败：{error}
            </p>
          )}
          {hasLegacySystemOverride && (
            <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[11px] leading-5 text-warning">
              该工作区包含旧版模型或 Provider
              覆盖。为兼容现有运行暂时保留，但不再允许在工作区编辑；请迁移到系统“模型配置”设置。
            </p>
          )}

          {/* Custom Env Vars */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">
                自定义环境变量
              </label>
              <button
                onClick={addCustomEnv}
                className="flex-shrink-0 flex items-center gap-1 text-[11px] text-primary hover:text-primary cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                添加
              </button>
            </div>

            {customEnv.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                暂无自定义变量
              </p>
            ) : (
              <div className="space-y-1.5">
                {customEnv.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      type="text"
                      value={item.key}
                      onChange={(e) =>
                        updateCustomEnv(i, 'key', e.target.value)
                      }
                      placeholder="KEY"
                      className="w-[40%] px-2 py-1 text-[11px] font-mono h-auto"
                    />
                    <span className="text-muted-foreground/50 text-xs">=</span>
                    <Input
                      type="text"
                      value={item.value}
                      onChange={(e) =>
                        updateCustomEnv(i, 'value', e.target.value)
                      }
                      placeholder="value"
                      className="flex-1 px-2 py-1 text-[11px] font-mono h-auto"
                    />
                    <button
                      onClick={() => removeCustomEnv(i)}
                      className="flex-shrink-0 p-1 text-muted-foreground cursor-pointer hover:text-destructive"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <ScrollEdgeAffordance scrollRef={contentScrollRef} />
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-border space-y-2">
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || clearing || !config}
            className="flex-1"
            size="sm"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
          <Button
            onClick={handleClear}
            disabled={saving || clearing || !config}
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
