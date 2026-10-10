import { useMemo } from 'react';
import { useChatStore } from '../stores/chat';
import {
  type GroupEntry,
  compareByLastActivity,
  compareWorkspaces,
} from '../utils/group-utils';
import {
  groupWorkspacesByAgent,
  partitionAgentWorkspaceSections,
} from '../utils/agent-product';

/**
 * Agent-first workspace grouping shared by the desktop sidebar tree and the
 * mobile workspace list: home first, then pinned, then by last activity.
 */
export function useWorkspaceTree() {
  const groups = useChatStore((s) => s.groups);

  return useMemo(() => {
    const entries: GroupEntry[] = Object.entries(groups).map(([jid, info]) => ({
      jid,
      ...info,
    }));
    entries.sort(compareByLastActivity);
    const homeGroup = entries.find((entry) => entry.is_my_home) ?? null;
    const defaultAgentId = homeGroup?.agent_profile_id || '__default__';
    const prioritized = [...entries].sort(compareWorkspaces);
    const agentSections = groupWorkspacesByAgent(prioritized, defaultAgentId);
    return {
      allGroups: entries,
      homeGroup,
      agentSections,
      agentPartitions: partitionAgentWorkspaceSections(agentSections),
    };
  }, [groups]);
}
