import type { RegisteredGroup } from './types.js';

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Admin home can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - Member home groups can send to groups created by the same user.
 * - A topic group bound to the source workspace (binding_mode='thread_map',
 *   target_main_jid) is reachable from that workspace's sessions — the
 *   runner's ctx.chatJid is the IM source of the turn.
 * - IM chats bound to a session (target_agent_id) resolve through that
 *   session's workspace folder. Such a chat's row keeps its own `folder` at
 *   the channel account's default workspace, so the folder branch misses and
 *   a reply from a session outside that workspace would be rejected while the
 *   runner completes the turn and the channel stays silent.
 */
export function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
  lookupGroup: (jid: string) => RegisteredGroup | undefined,
  /**
   * Resolve a Runtime Session id to the workspace folder it lives in.
   * Returns undefined for unknown sessions, which denies the branch.
   */
  lookupAgentFolder: (agentId: string) => string | undefined,
): boolean {
  if (isAdminHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (
    isHome &&
    targetGroup &&
    sourceGroupEntry?.created_by != null &&
    targetGroup.created_by === sourceGroupEntry.created_by
  )
    return true;
  if (
    targetGroup?.binding_mode === 'thread_map' &&
    targetGroup.target_main_jid
  ) {
    const bound = lookupGroup(targetGroup.target_main_jid);
    if (bound?.folder === sourceFolder) return true;
  }
  if (targetGroup?.target_agent_id) {
    // An unknown session yields undefined, which never equals a folder string.
    if (lookupAgentFolder(targetGroup.target_agent_id) === sourceFolder)
      return true;
  }
  return false;
}
