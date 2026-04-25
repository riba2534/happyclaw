import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu } from 'lucide-react';

import { api } from '../../api/client';
import { wsManager } from '../../api/ws';
import type {
  ConversationRuntimeState,
  ProviderPool,
  ProviderPoolModelOption,
} from '../settings/types';

interface WorkspaceModelResponse {
  scope: ConversationRuntimeState;
  pools: ProviderPool[];
  options: ProviderPoolModelOption[];
}

interface WorkspaceModelSelectorProps {
  groupJid: string;
  agentId?: string | null;
}

function valueFor(poolId: string, modelId: string, modelKind: string): string {
  return `${poolId}::${modelId}::${modelKind}`;
}

function parseValue(value: string) {
  const [providerPoolId, modelId, modelKind] = value.split('::');
  return { providerPoolId, modelId, modelKind };
}

export function WorkspaceModelSelector({ groupJid, agentId }: WorkspaceModelSelectorProps) {
  const [data, setData] = useState<WorkspaceModelResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const next = await api.get<WorkspaceModelResponse>(
        `/api/model/workspaces/${encodeURIComponent(groupJid)}${query}`,
      );
      setData(next);
      setDisabled(false);
    } catch {
      setDisabled(true);
    }
  }, [agentId, groupJid]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = wsManager.on('model_changed', (event) => {
      if (event.chatJid !== groupJid) return;
      if ((event.agentId || null) !== (agentId || null)) return;
      void load();
    });
    return () => {
      unsubscribe();
    };
  }, [agentId, groupJid, load]);

  const options = useMemo(
    () => (data?.options || []).filter((option) => option.status !== 'hidden' && option.status !== 'unsupported'),
    [data],
  );

  const currentValue = useMemo(() => {
    if (!data) return '';
    const modelId = data.scope.selected_model || 'default';
    const match = options.find(
      (option) =>
        option.provider_pool_id === data.scope.provider_pool_id &&
        option.model_id === modelId &&
        option.model_kind === data.scope.model_kind,
    );
    return match ? valueFor(match.provider_pool_id, match.model_id, match.model_kind) : '';
  }, [data, options]);

  const handleChange = async (value: string) => {
    const parsed = parseValue(value);
    setBusy(true);
    try {
      const path = agentId
        ? `/api/model/workspaces/${encodeURIComponent(groupJid)}/agents/${encodeURIComponent(agentId)}/model`
        : `/api/model/workspaces/${encodeURIComponent(groupJid)}/scopes/main`;
      await api.put(path, {
        providerPoolId: parsed.providerPoolId,
        model: parsed.modelId === 'default' ? null : parsed.modelId,
        modelKind: parsed.modelKind,
      });
      await load();
    } catch {
      setDisabled(true);
    } finally {
      setBusy(false);
    }
  };

  if (disabled || !data || options.length === 0) return null;

  return (
    <label className="hidden items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground lg:flex">
      <Cpu className="h-3.5 w-3.5" />
      <select
        value={currentValue}
        disabled={busy}
        onChange={(event) => handleChange(event.target.value)}
        className="max-w-44 bg-transparent text-xs text-foreground outline-none"
        title="切换当前会话模型"
      >
        {data.pools.map((pool) => (
          <optgroup key={pool.provider_pool_id} label={pool.display_name}>
            {options
              .filter((option) => option.provider_pool_id === pool.provider_pool_id)
              .map((option) => (
                <option key={valueFor(option.provider_pool_id, option.model_id, option.model_kind)} value={valueFor(option.provider_pool_id, option.model_id, option.model_kind)}>
                  {option.display_name || option.model_id}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
