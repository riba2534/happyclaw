import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import type { AgentInfo } from '../types';

/**
 * Create / delete Runtime Sessions with the user-facing error handling shared
 * by ChatView's session list and the sidebar session tree.
 */
export function useSessionActions() {
  const [creatingSession, setCreatingSession] = useState(false);
  const createConversation = useChatStore((s) => s.createConversation);
  const deleteAgentAction = useChatStore((s) => s.deleteAgentAction);

  const createSession = useCallback(
    async (groupJid: string): Promise<AgentInfo | null> => {
      if (creatingSession) return null;
      setCreatingSession(true);
      try {
        const agent = await createConversation(groupJid, '');
        if (!agent) {
          toast.error(useChatStore.getState().error || '创建 Web 会话失败');
          return null;
        }
        return agent;
      } finally {
        setCreatingSession(false);
      }
    },
    [createConversation, creatingSession],
  );

  /**
   * Sessions still bound to an IM channel must be unbound first; in that case
   * `onNeedsUnbind` opens the binding dialog instead of deleting.
   */
  const deleteSession = useCallback(
    (groupJid: string, id: string, onNeedsUnbind: (id: string) => void) => {
      const agent = (useChatStore.getState().agents[groupJid] || []).find(
        (item) => item.id === id,
      );
      if (agent?.linked_im_groups && agent.linked_im_groups.length > 0) {
        const names = agent.linked_im_groups
          .map((item) => item.name)
          .join('、');
        onNeedsUnbind(id);
        toast.error('请先解绑消息渠道', {
          description: `当前绑定：${names}`,
        });
        return;
      }
      void deleteAgentAction(groupJid, id).then((ok) => {
        if (!ok) {
          toast.error(useChatStore.getState().error || '删除会话失败');
        }
      });
    },
    [deleteAgentAction],
  );

  return { creatingSession, createSession, deleteSession };
}
