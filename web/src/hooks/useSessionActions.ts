import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import { useAutomationsStore } from '../stores/automations';
import { confirmDialog, confirmSelectDialog } from '../stores/confirm';
import {
  confirmDiscardWorktreeChanges,
  describeIncludeIncomplete,
  WORKTREE_IGNORED_FILES_NOTE,
} from '../lib/session-worktree';
import {
  NO_SESSION_DELETE_IMPACT,
  runSessionDelete,
  sessionDeleteMessage,
  type SessionDeleteImpact,
} from '../lib/session-delete';
import { automationsBySession } from '../lib/automation-presentation';
import {
  bindableSessions,
  isNativeManagedSession,
  sessionDisplayName,
} from '../lib/session-presentation';
import { sessionJidOf } from '../lib/session-jid';
import type { AgentInfo } from '../types';

/** Picked in the 改绑到 dropdown to delete without moving the chats. */
const NO_REBIND = '';

/** What this tab knows deleting `session` affects; the server has the last word. */
function knownDeleteImpact(
  groupJid: string,
  session: AgentInfo | undefined,
): SessionDeleteImpact {
  if (!session) return NO_SESSION_DELETE_IMPACT;
  const automations =
    automationsBySession(useAutomationsStore.getState().automations).get(
      sessionJidOf(groupJid, session.id),
    ) ?? [];
  return {
    linkedImGroups: session.linked_im_groups ?? [],
    threadBindings: isNativeManagedSession(session)
      ? [{ jid: '', name: session.name, contextId: session.thread_id ?? '' }]
      : [],
    automations: automations.map(({ id, name }) => ({ id, name })),
  };
}

/** Creations under way, by request: the same request joins the one running. */
const creationsInFlight = new Map<string, Promise<AgentInfo | null>>();

/**
 * Create a Web session once: a second identical request while one runs (a
 * double click, "+" while entering the workspace makes one) gets the same
 * session instead of another.
 */
function createSessionOnce(
  groupJid: string,
  options?: { name?: string; worktree?: boolean },
): Promise<AgentInfo | null> {
  const key = JSON.stringify([
    groupJid,
    options?.name ?? '',
    !!options?.worktree,
  ]);
  const running = creationsInFlight.get(key);
  if (running) return running;
  const creation = (async () => {
    const agent = await useChatStore
      .getState()
      .createConversation(groupJid, options?.name ?? '', undefined, {
        worktree: options?.worktree,
      });
    if (!agent) {
      toast.error(useChatStore.getState().error || '创建 Web 会话失败');
      return null;
    }
    const incomplete = agent.worktree?.include_incomplete;
    if (incomplete) {
      toast.warning('部分 .worktreeinclude 文件没有复制到新 worktree', {
        description: describeIncludeIncomplete(incomplete),
      });
    }
    return agent;
  })().finally(() => creationsInFlight.delete(key));
  creationsInFlight.set(key, creation);
  return creation;
}

/**
 * Create / delete sessions with the user-facing confirmation and error
 * handling shared by every session list.
 */
export function useSessionActions() {
  const [creatingSession, setCreatingSession] = useState(false);
  const deleteAgentAction = useChatStore((s) => s.deleteAgentAction);

  const createSession = useCallback(
    async (
      groupJid: string,
      options?: { name?: string; worktree?: boolean },
    ): Promise<AgentInfo | null> => {
      setCreatingSession(true);
      try {
        return await createSessionOnce(groupJid, options);
      } finally {
        setCreatingSession(false);
      }
    },
    [],
  );

  /**
   * Confirm and delete a session. The confirmation lists the chats, topics
   * and automations bound to it; chats can move to another session of the
   * workspace first. A worktree with uncommitted changes asks once more.
   */
  const deleteSession = useCallback(
    (groupJid: string, id: string) => {
      const sessions = useChatStore.getState().agents[groupJid] || [];
      const session = sessions.find((item) => item.id === id);
      const worktreeNote = session?.worktree
        ? `它的独立 worktree 目录会被移除，分支 ${session.worktree.branch} 保留。${WORKTREE_IGNORED_FILES_NOTE}`
        : undefined;
      const rebindOptions = [
        { value: NO_REBIND, label: '不改绑' },
        ...bindableSessions(sessions)
          .filter((item) => item.id !== id)
          .map((item) => ({ value: item.id, label: sessionDisplayName(item) })),
      ];
      void (async () => {
        const outcome = await runSessionDelete({
          known: knownDeleteImpact(groupJid, session),
          ask: async (impact) => {
            const options = {
              title: '删除会话',
              message: sessionDeleteMessage(impact, worktreeNote),
              confirmText: '删除',
              variant: 'danger' as const,
            };
            if (impact.linkedImGroups.length > 0 && rebindOptions.length > 1) {
              const picked = await confirmSelectDialog({
                ...options,
                select: {
                  label: '改绑到',
                  options: rebindOptions,
                  defaultValue: NO_REBIND,
                },
              });
              return picked === null ? null : { rebindTo: picked || null };
            }
            return (await confirmDialog(options)) ? { rebindTo: null } : null;
          },
          confirmWorktree: (dirty) =>
            confirmDiscardWorktreeChanges(dirty, '丢弃并删除'),
          remove: (options) => deleteAgentAction(groupJid, id, options),
        });
        if (outcome === 'failed') {
          toast.error(useChatStore.getState().error || '删除会话失败');
        }
      })();
    },
    [deleteAgentAction],
  );

  return { creatingSession, createSession, deleteSession };
}
