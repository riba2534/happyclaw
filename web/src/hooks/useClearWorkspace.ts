import { useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import {
  confirmDiscardWorktreeChanges,
  WORKTREE_IGNORED_FILES_NOTE,
} from '../lib/session-worktree';
import type { GroupInfo } from '../types';

/**
 * What a rebuild deletes, as POST /clear-history does it: HappyClaw's own
 * data/groups/<folder> is emptied and session worktrees are removed (their
 * branches stay), but a Host workspace's custom directory is never touched.
 */
export function workspaceRebuildMessage(
  name: string,
  group: Pick<GroupInfo, 'execution_mode' | 'custom_cwd'> | undefined,
): string {
  const host = group?.execution_mode === 'host';
  const files = host
    ? group?.custom_cwd
      ? '会话的独立 worktree 目录（分支保留）'
      : '工作目录文件、会话的独立 worktree 目录（分支保留）'
    : '工作目录文件';
  const keptDirectory = group?.custom_cwd
    ? `自定义工作目录 ${group.custom_cwd} 中的文件不会被删除。`
    : '';
  const ignoredFiles = host ? WORKTREE_IGNORED_FILES_NOTE : '';
  return `确认重建工作区「${name}」吗？这会永久删除所有会话及其聊天记录与上下文、${files}，以及该工作区的全部 Memory（含版本历史、遗忘记录和 HappyClaw 称呼偏好）；Home 还会重置首次唤醒状态。${keptDirectory}${ignoredFiles}持久化目录 (data/extra/) 保留。此操作不可撤销。`;
}

export function useClearWorkspace() {
  const clearHistory = useChatStore((s) => s.clearHistory);
  const [clearState, setClearState] = useState({
    open: false,
    jid: '',
    name: '',
  });
  const [clearLoading, setClearLoading] = useState(false);
  const clearGroup = useChatStore((s) =>
    clearState.jid ? s.groups[clearState.jid] : undefined,
  );
  const clearMessage = workspaceRebuildMessage(clearState.name, clearGroup);

  const openClear = (jid: string, name: string) =>
    setClearState({ open: true, jid, name });
  const closeClear = () => setClearState({ open: false, jid: '', name: '' });

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      let result = await clearHistory(clearState.jid);
      // Session worktrees hold work the rebuild would remove. The server
      // checks again after stopping runners and asks about anything new.
      while (typeof result === 'object') {
        const discard = await confirmDiscardWorktreeChanges(
          result.worktreesDirty,
          '丢弃并重建',
        );
        if (!discard) {
          closeClear();
          return;
        }
        result = await clearHistory(clearState.jid, {
          confirmedWorktrees: result.worktreesDirty.map(
            (item) => item.sessionId,
          ),
        });
      }
      const ok = result === true;
      if (!ok) toast.error('重建工作区失败，请稍后重试');
      closeClear();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : '重建工作区失败，请稍后重试',
      );
      closeClear();
    } finally {
      setClearLoading(false);
    }
  };

  return {
    clearState,
    clearMessage,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  };
}
