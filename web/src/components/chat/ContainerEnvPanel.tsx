import { useEffect, useMemo, useState, useRef } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2 } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/lib/utils';
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

  // Only meaningful edits enable saving: blank rows and system-managed keys
  // are dropped on save, so they do not count as changes.
  const dirty = useMemo(() => {
    const normalize = (entries: { key: string; value: string }[]) =>
      JSON.stringify(
        entries
          .map(({ key, value }) => [key.trim(), value] as const)
          .filter(([key]) => key && !SYSTEM_MANAGED_ENV_KEYS.has(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    const saved = Object.entries(config?.customEnv || {}).map(
      ([key, value]) => ({ key, value }),
    );
    return normalize(customEnv) !== normalize(saved);
  }, [config, customEnv]);

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
      <div className="p-4 text-center text-caption text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-body text-error">环境变量加载失败：{error}</p>
        <Button variant="outline" onClick={() => void loadConfig(groupJid)}>
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-surface-border pr-2 pl-4">
        <h3 className="truncate text-title-sm text-foreground">
          工作区环境变量
        </h3>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label="刷新"
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
            onClick={() => loadConfig(groupJid)}
            className="text-muted-foreground pointer-coarse:size-9"
          />
          {onClose && (
            <IconButton
              label="关闭"
              icon={<X />}
              onClick={onClose}
              className="text-muted-foreground pointer-coarse:size-9"
            />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={contentScrollRef}
          className="hc-scroll-pane h-full space-y-4 overflow-y-auto px-4 py-3"
          data-testid="environment-scroll"
        >
          <p className="text-caption leading-relaxed text-muted-foreground">
            这里保存项目运行需要的环境变量，仅对当前工作区生效。Provider
            地址和凭据由系统管理员统一管理；保存后工作区会自动重建。
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error"
            >
              保存失败：{error}
            </p>
          )}
          {hasLegacySystemOverride && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning">
              该工作区包含旧版模型或 Provider
              覆盖。为兼容现有运行暂时保留，但不再允许在工作区编辑；请迁移到系统“模型配置”设置。
            </p>
          )}

          {/* Custom Env Vars */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-label text-foreground">自定义环境变量</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={addCustomEnv}
                className="-mr-1.5 text-muted-foreground"
              >
                <Plus />
                添加
              </Button>
            </div>

            {customEnv.length === 0 ? (
              <p className="text-caption text-muted-foreground">
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
                      aria-label={`第 ${i + 1} 个变量名`}
                      className="w-[40%] font-mono md:text-caption"
                    />
                    <span className="text-caption text-faint-foreground">
                      =
                    </span>
                    <Input
                      type="text"
                      value={item.value}
                      onChange={(e) =>
                        updateCustomEnv(i, 'value', e.target.value)
                      }
                      placeholder="value"
                      aria-label={`第 ${i + 1} 个变量值`}
                      className="min-w-0 flex-1 font-mono md:text-caption"
                    />
                    <IconButton
                      label="删除变量"
                      icon={<X />}
                      onClick={() => removeCustomEnv(i)}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <ScrollEdgeAffordance scrollRef={contentScrollRef} />
      </div>

      {/* Footer */}
      <div className="shrink-0 space-y-2 border-t border-surface-border p-3">
        <div className="flex items-center justify-end gap-2">
          <IconButton
            label="清空所有覆盖配置"
            icon={clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            variant="outline"
            size="icon"
            onClick={handleClear}
            disabled={saving || clearing || !config}
            tooltipSide="top"
          />
          <Button
            onClick={handleSave}
            disabled={saving || clearing || !config || !dirty}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
        </div>
        {saveSuccess && (
          <p className="text-center text-caption text-success">
            配置已保存，工作区已重建
          </p>
        )}
      </div>
    </div>
  );
}
