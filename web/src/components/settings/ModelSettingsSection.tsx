import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, Loader2, Plus, RefreshCw } from 'lucide-react';

import { api } from '../../api/client';
import type {
  ConversationRuntimeState,
  ProviderPool,
  ProviderPoolModelOption,
} from './types';
import { getErrorMessage } from './types';

interface PoolsResponse {
  pools: ProviderPool[];
  options: ProviderPoolModelOption[];
}

interface SystemDefaultResponse {
  default: ConversationRuntimeState;
}

const MODEL_KIND_LABEL: Record<ProviderPoolModelOption['model_kind'], string> = {
  provider_default: '账号默认',
  runtime_default: '运行时默认',
  alias: '别名',
  explicit_version: '明确版本',
  custom: '自定义',
};

function optionValue(option: ProviderPoolModelOption): string {
  return `${option.provider_pool_id}::${option.model_id}::${option.model_kind}`;
}

function parseOptionValue(value: string) {
  const [providerPoolId, modelId, modelKind] = value.split('::');
  return { providerPoolId, modelId, modelKind };
}

export function ModelSettingsSection() {
  const [pools, setPools] = useState<ProviderPool[]>([]);
  const [options, setOptions] = useState<ProviderPoolModelOption[]>([]);
  const [systemDefault, setSystemDefault] = useState<ConversationRuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newModelPool, setNewModelPool] = useState('gpt');
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [newModelKind, setNewModelKind] = useState<ProviderPoolModelOption['model_kind']>('explicit_version');
  const [newModelStatus, setNewModelStatus] = useState<ProviderPoolModelOption['status']>('available');

  const visibleOptions = useMemo(
    () => options.filter((option) => option.status !== 'hidden' && option.status !== 'unsupported'),
    [options],
  );

  const selectedDefaultValue = useMemo(() => {
    if (!systemDefault) return '';
    const modelId = systemDefault.selected_model || 'default';
    const match = options.find(
      (option) =>
        option.provider_pool_id === systemDefault.provider_pool_id &&
        option.model_id === modelId &&
        option.model_kind === systemDefault.model_kind,
    );
    return match ? optionValue(match) : '';
  }, [options, systemDefault]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [poolData, defaultData] = await Promise.all([
        api.get<PoolsResponse>('/api/model/pools?includeAll=true'),
        api.get<SystemDefaultResponse>('/api/model/system/default'),
      ]);
      setPools(poolData.pools);
      setOptions(poolData.options);
      setSystemDefault(defaultData.default);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveSystemDefault = async (value: string) => {
    const parsed = parseOptionValue(value);
    const model = parsed.modelId === 'default' ? null : parsed.modelId;
    setBusy(true);
    setError(null);
    try {
      const data = await api.put<SystemDefaultResponse>('/api/model/system/default', {
        providerPoolId: parsed.providerPoolId,
        model,
        modelKind: parsed.modelKind,
      });
      setSystemDefault(data.default);
      setNotice('系统默认模型已更新');
    } catch (err) {
      setError(getErrorMessage(err, '保存系统默认模型失败'));
    } finally {
      setBusy(false);
    }
  };

  const addModelOption = async () => {
    if (!newModelId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/model/pools/${newModelPool}/options`, {
        modelId: newModelId.trim(),
        modelKind: newModelKind,
        displayName: newModelName.trim() || null,
        status: newModelStatus,
      });
      setNewModelId('');
      setNewModelName('');
      setNotice('模型选项已保存');
      await load();
    } catch (err) {
      setError(getErrorMessage(err, '保存模型选项失败'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {(error || notice) && (
        <div className={`rounded-md border px-3 py-2 text-sm ${error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
          {error || notice}
        </div>
      )}

      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">默认模型</h2>
          </div>
          <button onClick={load} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="刷新">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <select
          value={selectedDefaultValue}
          disabled={busy}
          onChange={(event) => saveSystemDefault(event.target.value)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {visibleOptions.map((option) => (
            <option key={optionValue(option)} value={optionValue(option)}>
              {option.display_name || option.model_id} · {option.provider_pool_id} · {MODEL_KIND_LABEL[option.model_kind]}
            </option>
          ))}
        </select>
      </section>

      <section className="rounded-lg border border-border p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">模型目录</h2>
        <div className="grid gap-2 md:grid-cols-[1fr_1.2fr_1fr_1fr]">
          <select value={newModelPool} onChange={(e) => setNewModelPool(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            {pools.map((pool) => <option key={pool.provider_pool_id} value={pool.provider_pool_id}>{pool.display_name}</option>)}
          </select>
          <input value={newModelId} onChange={(e) => setNewModelId(e.target.value)} placeholder="gpt-5.5 / claude-opus-4.7" className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
          <select value={newModelKind} onChange={(e) => setNewModelKind(e.target.value as ProviderPoolModelOption['model_kind'])} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="explicit_version">明确版本</option>
            <option value="alias">别名</option>
            <option value="custom">自定义</option>
            <option value="provider_default">账号默认</option>
          </select>
          <select value={newModelStatus} onChange={(e) => setNewModelStatus(e.target.value as ProviderPoolModelOption['status'])} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="available">可用</option>
            <option value="unverified">未验证</option>
            <option value="hidden">隐藏</option>
            <option value="unsupported">不支持</option>
          </select>
        </div>
        <div className="mt-2 flex gap-2">
          <input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} placeholder="显示名（可选）" className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
          <button disabled={busy || !newModelId.trim()} onClick={addModelOption} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
            <Plus className="h-4 w-4" /> 添加
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          {options.map((option) => (
            <div key={optionValue(option)} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-foreground">{option.model_id}</div>
                {option.display_name && option.display_name !== option.model_id && (
                  <div className="truncate text-xs text-muted-foreground">{option.display_name}</div>
                )}
              </div>
              <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                {option.provider_pool_id} · {MODEL_KIND_LABEL[option.model_kind]} · {option.status}
              </span>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
