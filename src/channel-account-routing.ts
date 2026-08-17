import type { ChannelConversationKind } from './channel-conversation-kind.js';
import type { ChannelAccount, RegisteredGroup } from './types.js';

export interface ChannelAccountFallbackWorkspace {
  jid: string;
  folder: string;
}

/** Account routing is workspace-owned. A deprecated Agent default must never
 * pick that Agent's arbitrary first workspace. */
export function resolveChannelAccountFallbackWorkspace(
  account: ChannelAccount,
  lookup: {
    getGroup: (jid: string) => RegisteredGroup | undefined;
    getHome: (
      ownerUserId: string,
    ) => (RegisteredGroup & { jid: string }) | undefined;
  },
): ChannelAccountFallbackWorkspace | null {
  if (account.default_workspace_jid) {
    const group = lookup.getGroup(account.default_workspace_jid);
    if (group?.created_by === account.owner_user_id) {
      return { jid: account.default_workspace_jid, folder: group.folder };
    }
  }
  const home = lookup.getHome(account.owner_user_id);
  return home ? { jid: home.jid, folder: home.folder } : null;
}

/**
 * Attach an inbound chat to its channel account without changing a binding the
 * user already selected. Account defaults are only a registration fallback;
 * they must never turn every subsequent IM message into a binding update.
 *
 * Group and unknown conversations may fall back to the account default
 * workspace. Direct chats must not: they share that workspace's main owner
 * slot with every group bound to the same workspace, which is how a WeCom
 * 1:1 and a group collapsed onto one reply target. Direct chats only receive
 * the account id here; callers then mount a dedicated session.
 *
 * `conversationKind` defaults to `unknown` so existing callers keep the
 * workspace fallback. Infer kind from the JID only — Feishu P2P metadata
 * must not silently opt Feishu into this path (that stays `auto_im`).
 *
 * Returns the input object unchanged when nothing needs to move, so callers
 * can skip persistence — every inbound message funnels through this path, and
 * an unconditional setRegisteredGroup costs ~10 statements per message.
 */
export function applyChannelAccountRegistrationFallback(
  group: RegisteredGroup,
  accountId: string,
  fallbackWorkspaceJid: string,
  conversationKind: ChannelConversationKind = 'unknown',
): RegisteredGroup {
  const hasExplicitBinding = Boolean(
    group.target_main_jid || group.target_agent_id,
  );
  const nextAccountId = group.channel_account_id ?? accountId;
  const shouldBindWorkspace =
    !hasExplicitBinding && conversationKind !== 'direct';
  const changed =
    nextAccountId !== group.channel_account_id ||
    (shouldBindWorkspace && group.target_main_jid !== fallbackWorkspaceJid);
  if (!changed) return group;
  return {
    ...group,
    channel_account_id: nextAccountId,
    ...(shouldBindWorkspace ? { target_main_jid: fallbackWorkspaceJid } : {}),
  };
}
