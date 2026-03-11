import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api/client';
import { useChatStore } from '../../../stores/chat';
import type { AvailableImGroup, AgentInfo } from '../../../types';

export interface BindingTarget {
  type: 'main' | 'agent';
  groupJid: string;
  groupName: string;
  agentId?: string;
  agentName?: string;
}

export function useImBindings() {
  const [bindings, setBindings] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<BindingTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const groups = useChatStore((s) => s.groups);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);

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
    try {
      const result = await loadAvailableImGroups(hJid);
      setBindings(result);
    } finally {
      setLoading(false);
    }
  }, [loadAvailableImGroups]);

  const loadTargets = useCallback(async () => {
    setTargetsLoading(true);
    try {
      const currentGroups = groupsRef.current;
      const webGroups = Object.entries(currentGroups).filter(
        ([jid, g]) => jid.startsWith('web:') && !g.is_home,
      );

      const allTargets: BindingTarget[] = [];

      for (const [jid, group] of webGroups) {
        allTargets.push({
          type: 'main',
          groupJid: jid,
          groupName: group.name,
        });
      }

      // Load conversation agents for each workspace
      const agentPromises = webGroups.map(async ([jid, group]) => {
        try {
          const data = await api.get<{ agents: AgentInfo[] }>(
            `/api/groups/${encodeURIComponent(jid)}/agents`,
          );
          return data.agents
            .filter((a) => a.kind === 'conversation')
            .map((a) => ({
              type: 'agent' as const,
              groupJid: jid,
              groupName: group.name,
              agentId: a.id,
              agentName: a.name,
            }));
        } catch {
          return [];
        }
      });

      const agentResults = await Promise.all(agentPromises);
      for (const agents of agentResults) {
        allTargets.push(...agents);
      }

      setTargets(allTargets);
    } finally {
      setTargetsLoading(false);
    }
  }, []);

  // Initial load — run once
  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // When homeJid changes (derived from groups), reload bindings and targets
  useEffect(() => {
    if (homeJid) {
      loadBindings();
      loadTargets();
    } else {
      // No home group — clear loading state to avoid perpetual spinner
      setLoading(false);
      setTargetsLoading(false);
    }
  }, [homeJid, loadBindings, loadTargets]);

  const rebind = useCallback(
    async (
      imJid: string,
      target: {
        target_main_jid?: string;
        target_agent_id?: string;
        unbind?: boolean;
        force?: boolean;
        reply_policy?: 'source_only' | 'mirror';
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
        const msg =
          err instanceof Error ? err.message : '操作失败，请重试';
        setError(msg);
        return msg;
      }
    },
    [loadBindings],
  );

  const reload = useCallback(() => {
    loadBindings();
    loadTargets();
  }, [loadBindings, loadTargets]);

  const clearError = useCallback(() => setError(null), []);

  return { bindings, loading, targets, targetsLoading, reload, rebind, error, clearError };
}
