import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useShellStore } from '../stores/shell';
import { openWorkspaceSession } from '../lib/chat-navigation';
import {
  currentRouteChatFolder,
  findRouteGroupJid,
} from '../lib/route-workspace';
import { isNativeManagedSession } from '../lib/session-presentation';
import type { AgentInfo, GroupInfo } from '../types';
import { useSessionActions } from './useSessionActions';

/**
 * Where a new conversation goes: a given workspace, Home, or the workspace
 * open in the chat (Home when none is). Only a workspace the user may modify;
 * otherwise Home.
 */
export type NewConversationTarget = 'current' | 'home' | { jid: string };

export function newConversationWorkspace(
  groups: Record<string, GroupInfo>,
  target: NewConversationTarget,
  routeFolder: string | null,
): string | null {
  const home =
    Object.entries(groups).find(
      ([, group]) => group.is_my_home && group.can_modify,
    )?.[0] ?? null;
  const wanted =
    target === 'home'
      ? null
      : target === 'current'
        ? routeFolder && findRouteGroupJid(groups, routeFolder)
        : target.jid;
  return wanted && groups[wanted]?.can_modify ? wanted : home;
}

/**
 * A session a new conversation can reuse instead of piling up blank ones:
 * one nobody has written in yet (the open one first) that only the Web uses.
 */
export function reusableEmptySession(
  sessions: readonly AgentInfo[],
  openId: string | undefined,
  loadedMessages: Record<string, unknown[] | undefined>,
): AgentInfo | null {
  const empty = sessions.filter(
    (session) =>
      session.kind === 'conversation' &&
      !session.latest_message &&
      !(loadedMessages[session.id]?.length ?? 0) &&
      !session.automation_id &&
      !isNativeManagedSession(session) &&
      !(session.linked_im_groups?.length ?? 0),
  );
  return empty.find((session) => session.id === openId) ?? empty[0] ?? null;
}

/**
 * "New conversation": a fresh Web session in the target workspace, reusing
 * one there that has never been written in.
 */
export function useNewConversation() {
  const navigate = useNavigate();
  const { createSession, creatingSession } = useSessionActions();
  const requestComposerFocus = useShellStore((s) => s.requestComposerFocus);

  const startNewConversation = useCallback(
    async ({
      target = 'current',
      replace = false,
      create,
    }: {
      target?: NewConversationTarget;
      replace?: boolean;
      /** Always create one, with these options (a worktree session). */
      create?: { name?: string; worktree?: boolean };
    } = {}): Promise<boolean> => {
      const state = useChatStore.getState();
      const targetJid = newConversationWorkspace(
        state.groups,
        target,
        currentRouteChatFolder(),
      );
      if (!targetJid) {
        navigate('/chat');
        return false;
      }
      const group = { jid: targetJid, folder: state.groups[targetJid].folder };
      let reusable: AgentInfo | null = null;
      if (!create) {
        await state.loadAgents(targetJid);
        const current = useChatStore.getState();
        reusable = reusableEmptySession(
          current.agents[targetJid] ?? [],
          current.activeAgentTab[targetJid],
          current.agentMessages,
        );
      }
      const session = reusable ?? (await createSession(targetJid, create));
      if (!session) return false;
      openWorkspaceSession(navigate, group, session.id, { replace });
      requestComposerFocus();
      return true;
    },
    [createSession, navigate, requestComposerFocus],
  );

  return { startNewConversation, creatingSession };
}
