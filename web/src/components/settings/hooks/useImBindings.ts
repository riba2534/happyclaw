import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api/client';
import { useChatStore } from '../../../stores/chat';
import type { AvailableImGroup, AgentInfo } from '../../../types';
import { buildImBindingRequest } from '../../../utils/im-binding-policy';
import { getAgentProfileDisplayName } from '../../../utils/agent-product';

export interface BindingTarget {
  type: 'workspace' | 'session';
  groupJid: string;
  groupName: string;
  agentProfileId?: string;
  agentProfileName?: string;
  sessionId?: string;
  sessionName?: string;
}

type WorkspaceSessionInfo = Omit<AgentInfo, 'kind'> & {
  kind: AgentInfo['kind'] | 'main';
  is_main?: boolean;
};

export function useImBindings() {
  const [bindings, setBindings] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [targets, setTargets] = useState<BindingTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [bindingsLoadError, setBindingsLoadError] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const groups = useChatStore((s) => s.groups);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);
  const syncAvailableImGroups = useChatStore((s) => s.syncAvailableImGroups);

  // Derive homeJid as a stable value — no callback, no dependency cycle
  const homeJid = useMemo((): string | null => {
    for (const [jid, group] of Object.entries(groups)) {
      if (group.is_my_home) return jid;
    }
    return null;
  }, [groups]);

  // Use refs to read latest groups inside callbacks without creating dependency cycles
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const homeJidRef = useRef(homeJid);
  homeJidRef.current = homeJid;

  const loadBindings = useCallback(async () => {
    const hJid = homeJidRef.current;
    if (!hJid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setBindingsLoadError(null);
    try {
      const result = await loadAvailableImGroups(hJid);
      setBindings(result);
    } catch (err) {
      setBindingsLoadError(
        err instanceof Error ? err.message : '消息渠道加载失败，请稍后重试',
      );
    } finally {
      setLoading(false);
    }
  }, [loadAvailableImGroups]);

  const loadTargets = useCallback(async () => {
    setTargetsLoading(true);
    try {
      const currentGroups = groupsRef.current;
      const webGroups = Object.entries(currentGroups).filter(([jid]) =>
        jid.startsWith('web:'),
      );

      const allTargets: BindingTarget[] = [];

      for (const [jid, group] of webGroups) {
        allTargets.push({
          type: 'workspace',
          groupJid: jid,
          groupName: group.name,
          agentProfileId: group.agent_profile_id,
          agentProfileName: getAgentProfileDisplayName(
            group.agent_profile_name,
          ),
        });
      }

      const sessionPromises = webGroups.map(async ([jid, group]) => {
        try {
          const data = await api.get<{ sessions: WorkspaceSessionInfo[] }>(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
          );
          return data.sessions
            .filter((a) => a.kind === 'conversation' || a.kind === 'main')
            .map((a) => ({
              type: 'session' as const,
              groupJid: jid,
              groupName: group.name,
              agentProfileId: group.agent_profile_id,
              agentProfileName: getAgentProfileDisplayName(
                group.agent_profile_name,
              ),
              sessionId: a.id,
              sessionName: a.name,
            }));
        } catch {
          return [];
        }
      });

      const sessionResults = await Promise.all(sessionPromises);
      for (const sessions of sessionResults) {
        allTargets.push(...sessions);
      }

      setTargets(allTargets);
    } finally {
      setTargetsLoading(false);
    }
  }, []);

  const syncBindings = useCallback(async () => {
    const hJid = homeJidRef.current;
    if (!hJid) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await syncAvailableImGroups(hJid);
      const result = await loadAvailableImGroups(hJid);
      setBindings(result);
      setBindingsLoadError(null);
    } catch (err) {
      setSyncError(
        err instanceof Error ? err.message : '渠道聊天同步失败，已保留本地列表',
      );
    } finally {
      setSyncing(false);
    }
  }, [loadAvailableImGroups, syncAvailableImGroups]);

  // Initial load — run once
  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // When homeJid changes (derived from groups), reload bindings and targets
  useEffect(() => {
    if (homeJid) {
      void loadBindings().then(() => void syncBindings());
      loadTargets();
    } else {
      // No home group — clear loading state to avoid perpetual spinner
      setLoading(false);
      setTargetsLoading(false);
    }
  }, [homeJid, loadBindings, loadTargets, syncBindings]);

  const rebind = useCallback(
    async (
      imJid: string,
      target: {
        target_main_jid?: string;
        target_session_id?: string;
        target_agent_id?: string;
        unbind?: boolean;
        force?: boolean;
        reply_policy?: 'source_only' | 'mirror';
        activation_mode?:
          | 'auto'
          | 'always'
          | 'when_mentioned'
          | 'owner_mentioned'
          | 'disabled';
        owner_im_id?: string;
        audience_mode?: 'everyone' | 'owner_only';
      },
    ): Promise<string | null> => {
      setError(null);
      try {
        await api.put(
          `/api/config/user-im/bindings/${encodeURIComponent(imJid)}`,
          target,
        );
        await loadBindings();
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '操作失败，请重试';
        setError(msg);
        return msg;
      }
    },
    [loadBindings],
  );

  const bindTarget = useCallback(
    async (
      group: AvailableImGroup,
      target: BindingTarget,
      force: boolean,
    ): Promise<string | null> => {
      setError(null);
      try {
        const request = buildImBindingRequest(group, target, { force });
        await api.put(request.url, request.body);
        await Promise.all([
          loadGroups(),
          loadAgents(target.groupJid, { force: true }),
        ]);
        await loadBindings();
        return null;
      } catch (err) {
        const message = err instanceof Error ? err.message : '绑定失败';
        setError(message);
        return message;
      }
    },
    [loadBindings, loadGroups, loadAgents],
  );

  const reload = useCallback(() => {
    void syncBindings();
    loadTargets();
  }, [loadTargets, syncBindings]);

  const resetAllowlist = useCallback(
    async (imJid: string): Promise<string | null> => {
      setError(null);
      try {
        await api.post(
          `/api/config/user-im/bindings/${encodeURIComponent(imJid)}/reset-allowlist`,
        );
        await loadBindings();
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '解除发言者限制失败';
        setError(msg);
        return msg;
      }
    },
    [loadBindings],
  );

  const setDelegate = useCallback(
    async (
      group: AvailableImGroup,
      enabled: boolean,
    ): Promise<string | null> => {
      if (!group.mount_workspace_jid) return '这个渠道还没有绑定会话';
      setError(null);
      try {
        await api.put(
          `/api/workspaces/${encodeURIComponent(group.mount_workspace_jid)}/channel-mounts/${encodeURIComponent(group.jid)}/delegate`,
          { enabled },
        );
        await loadBindings();
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '保存失败，请重试';
        setError(msg);
        return msg;
      }
    },
    [loadBindings],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    bindings,
    loading,
    syncing,
    syncError,
    bindingsLoadError,
    targets,
    targetsLoading,
    reload,
    rebind,
    bindTarget,
    resetAllowlist,
    setDelegate,
    error,
    clearError,
  };
}
