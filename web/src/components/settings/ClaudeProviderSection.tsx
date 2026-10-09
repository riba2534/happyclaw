import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type {
  BalancingConfig,
  ProviderWithHealth,
  ProvidersListResponse,
  ProviderHealthStatus,
} from './types';
import { getErrorMessage } from './types';
import { ProviderList } from './ProviderList';
import { ProviderEditor } from './ProviderEditor';
import { BalancingSettings } from './BalancingSettings';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { SettingsSection } from './SettingsLayout';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function createBalancingMutationQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(request: () => Promise<T>): Promise<T> {
    const operation = tail.then(request);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

export function ClaudeProviderSection({
  setNotice,
  setError,
}: ClaudeProviderSectionProps) {
  const [providers, setProviders] = useState<ProviderWithHealth[]>([]);
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const [balancing, setBalancing] = useState<BalancingConfig | null>(null);
  const balancingRef = useRef<BalancingConfig | null>(null);
  const balancingRevisionRef = useRef(0);
  const balancingPendingRef = useRef(0);
  const balancingQueueRef = useRef<ReturnType<
    typeof createBalancingMutationQueue
  > | null>(null);
  balancingQueueRef.current ??= createBalancingMutationQueue();

  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [balancingSaving, setBalancingSaving] = useState(false);

  // 编辑器状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<ProviderWithHealth | null>(null);

  // 确认对话框
  const [pendingDeleteProvider, setPendingDeleteProvider] =
    useState<ProviderWithHealth | null>(null);

  // ─── 加载提供商列表 ──────────────────────────────────────────
  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<ProvidersListResponse>(
        '/api/config/claude/providers',
      );
      setProviders(data.providers);
      balancingRef.current = data.balancing;
      setBalancing(data.balancing);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型配置列表失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // ─── 健康状态轮询（启用 >= 2 个提供商时，仅页面可见时） ──────
  const pollHealth = useCallback(async () => {
    try {
      const data = await api.get<{ statuses: ProviderHealthStatus[] }>(
        '/api/config/claude/providers/health',
      );
      setProviders((prev) =>
        prev.map((p) => {
          const updated = data.statuses.find((s) => s.profileId === p.id);
          return updated ? { ...p, health: updated } : p;
        }),
      );
    } catch {
      // 静默忽略
    }
  }, []);
  useVisibleInterval(pollHealth, 10000, enabledCount >= 2);

  // ─── 切换提供商启用/禁用 ──────────────────────────────────────
  const handleToggle = useCallback(
    async (provider: ProviderWithHealth) => {
      setTogglingId(provider.id);
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/toggle`,
          { enabled: !provider.enabled },
          120_000,
        );
        await loadProviders();
        setNotice(
          provider.enabled
            ? `已禁用「${provider.name}」`
            : `已启用「${provider.name}」`,
        );
      } catch (err) {
        // A 503 can mean the target state was persisted but runtime teardown
        // failed afterward. Reload instead of leaving a stale toggle that a
        // user might click again and accidentally reverse.
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '切换模型配置状态失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 重置健康状态 ─────────────────────────────────────────────
  const handleResetHealth = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/reset-health`,
        );
        await loadProviders();
        setNotice('健康状态已重置');
      } catch (err) {
        setError(getErrorMessage(err, '重置健康状态失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 删除提供商 ───────────────────────────────────────────────
  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDeleteProvider) return;

    const provider = pendingDeleteProvider;
    setDeletingId(provider.id);
    setPendingDeleteProvider(null);

    try {
      await api.delete(`/api/config/claude/providers/${provider.id}`);
      setNotice(`已删除模型配置「${provider.name}」`);
      await loadProviders();
    } catch (err) {
      setError(getErrorMessage(err, '删除模型配置失败'));
    } finally {
      setDeletingId(null);
    }
  }, [pendingDeleteProvider, loadProviders, setNotice, setError]);

  // ─── 复制第三方提供商 ────────────────────────────────────────────
  const handleDuplicate = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post('/api/config/claude/providers', {
          name: `${provider.name} (副本)`,
          type: 'third_party',
          anthropicBaseUrl: provider.anthropicBaseUrl,
          anthropicModel: provider.anthropicModel,
          customEnv: provider.customEnv,
          enabled: false,
        });
        await loadProviders();
        setNotice(`已复制模型配置「${provider.name}」，密钥需要重新填写`);
      } catch (err) {
        setError(getErrorMessage(err, '复制模型配置失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 更新负载均衡设置 ─────────────────────────────────────────
  const handleBalancingChange = useCallback(
    async (updates: Partial<BalancingConfig>) => {
      const current = balancingRef.current;
      if (!current) return;
      const next = { ...current, ...updates };
      const revision = ++balancingRevisionRef.current;
      balancingRef.current = next;
      setBalancing(next);
      balancingPendingRef.current += 1;
      setBalancingSaving(true);

      try {
        // Serialize full-snapshot PUTs so the server cannot persist them in a
        // different order. The revision guard also prevents a stale response
        // from replacing a newer optimistic value in the UI.
        const saved = await balancingQueueRef.current!(() =>
          api.put<BalancingConfig>('/api/config/claude/balancing', next),
        );
        if (revision === balancingRevisionRef.current) {
          balancingRef.current = saved;
          setBalancing(saved);
          setNotice('负载均衡设置已更新');
        }
      } catch (err) {
        if (revision === balancingRevisionRef.current) {
          await loadProviders().catch(() => {});
          setError(getErrorMessage(err, '更新负载均衡设置失败'));
        }
      } finally {
        balancingPendingRef.current = Math.max(
          0,
          balancingPendingRef.current - 1,
        );
        if (balancingPendingRef.current === 0) {
          setBalancingSaving(false);
        }
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 编辑器回调 ───────────────────────────────────────────────
  const handleEditorSave = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
    loadProviders();
  }, [loadProviders]);

  const handleEditorCancel = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
  }, []);

  const handleAdd = useCallback(() => {
    setEditingProvider(null);
    setEditorOpen(true);
  }, []);

  const busy =
    loading || togglingId !== null || deletingId !== null || balancingSaving;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 提供商列表 */}
      <SettingsSection
        title="模型配置列表"
        description={`${providers.length} 个模型配置`}
        actions={
          providers.length > 0 && (
            <Button onClick={handleAdd} disabled={busy}>
              <Plus />
              添加模型配置
            </Button>
          )
        }
      >
        <ProviderList
          providers={providers}
          onEdit={(p) => {
            setEditingProvider(p);
            setEditorOpen(true);
          }}
          onDelete={(p) => setPendingDeleteProvider(p)}
          onToggle={handleToggle}
          onResetHealth={handleResetHealth}
          onDuplicate={handleDuplicate}
          onAdd={handleAdd}
          togglingId={togglingId}
          deletingId={deletingId}
          disabled={busy}
        />

        {/* 负载均衡设置：配置了多个模型时展示（池只在 >=2 启用时生效） */}
        {balancing && providers.length >= 2 && (
          <BalancingSettings
            balancing={balancing}
            onChange={handleBalancingChange}
            disabled={busy}
            saving={balancingSaving}
          />
        )}
      </SettingsSection>

      {/* 编辑器弹窗 */}
      <ProviderEditor
        open={editorOpen}
        provider={editingProvider}
        onSave={handleEditorSave}
        onCancel={handleEditorCancel}
        setNotice={setNotice}
        setError={setError}
      />

      {/* 确认删除对话框 */}
      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={handleDeleteConfirm}
        title="删除模型配置"
        message={
          pendingDeleteProvider
            ? `确认删除模型配置「${pendingDeleteProvider.name}」？`
            : '确认删除该模型配置？'
        }
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deletingId !== null}
      />
    </div>
  );
}
