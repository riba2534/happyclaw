import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useShellStore } from '../stores/shell';
import { openWorkspaceSession } from '../lib/chat-navigation';
import { useSessionActions } from './useSessionActions';

/**
 * "New conversation": a fresh Web session in the current workspace when the
 * user may modify it, otherwise in their home workspace. An already-empty
 * session is reused so repeated presses do not pile up blank sessions.
 */
export function useNewConversation() {
  const navigate = useNavigate();
  const { createSession, creatingSession } = useSessionActions();
  const requestComposerFocus = useShellStore((s) => s.requestComposerFocus);

  const startNewConversation = useCallback(async () => {
    const state = useChatStore.getState();
    const current = state.currentGroup
      ? state.groups[state.currentGroup]
      : undefined;
    const targetJid =
      current?.can_modify && state.currentGroup
        ? state.currentGroup
        : (Object.entries(state.groups).find(
            ([, group]) => group.is_my_home && group.can_modify,
          )?.[0] ?? null);
    if (!targetJid) {
      navigate('/chat');
      return;
    }
    const group = { jid: targetJid, folder: state.groups[targetJid].folder };

    const activeId = state.activeAgentTab[targetJid];
    const active = activeId
      ? state.agents[targetJid]?.find((agent) => agent.id === activeId)
      : undefined;
    const activeIsEmpty =
      !!active &&
      active.kind === 'conversation' &&
      !active.latest_message &&
      !(state.agentMessages[active.id]?.length ?? 0);
    if (active && activeIsEmpty) {
      openWorkspaceSession(navigate, group, active.id);
      requestComposerFocus();
      return;
    }

    const agent = await createSession(targetJid);
    if (!agent) return;
    openWorkspaceSession(navigate, group, agent.id);
    requestComposerFocus();
  }, [createSession, navigate, requestComposerFocus]);

  return { startNewConversation, creatingSession };
}
