import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';
import type { GroupInfo } from '../types';
import { normalizeGroupInteractionMode } from '../lib/interaction-mode';
import { isSessionOf } from '../lib/session-jid';

export type { GroupInfo };

interface GroupsState {
  groups: Record<string, GroupInfo>;
  adminHostOnlyMode: boolean;
  loading: boolean;
  error: string | null;
  /** Runners at work, by session runtime JID (idle ones are dropped). */
  runnerStates: Record<string, 'idle' | 'running'>;
  loadGroups: () => Promise<void>;
  setRunnerState: (chatJid: string, state: 'idle' | 'running') => void;
}

/** Whether any session of a workspace has its runner at work. */
export function isWorkspaceRunning(
  runnerStates: GroupsState['runnerStates'],
  workspaceJid: string,
): boolean {
  return Object.entries(runnerStates).some(
    ([jid, state]) => state === 'running' && isSessionOf(jid, workspaceJid),
  );
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: {},
  adminHostOnlyMode: false,
  loading: false,
  error: null,
  runnerStates: {},

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        groups: Record<string, GroupInfo>;
        admin_host_only_mode?: boolean;
      }>('/api/groups');
      const groups = Object.fromEntries(
        Object.entries(data.groups).map(([jid, group]) => [
          jid,
          normalizeGroupInteractionMode(group),
        ]),
      );
      set({
        groups,
        adminHostOnlyMode: data.admin_host_only_mode === true,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: extractErrorMessage(err),
      });
    }
  },

  setRunnerState: (chatJid: string, state: 'idle' | 'running') => {
    set((s) => {
      // Every session's runner reports here: an unchanged one changes nothing.
      if ((s.runnerStates[chatJid] ?? 'idle') === state) return s;
      if (state === 'idle') {
        const { [chatJid]: _, ...rest } = s.runnerStates;
        return { runnerStates: rest };
      }
      return { runnerStates: { ...s.runnerStates, [chatJid]: state } };
    });
  },
}));
