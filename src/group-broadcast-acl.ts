import {
  getAgent,
  getChannelMount,
  getJidsByFolder,
  getRegisteredGroup,
  getUserById,
  listActiveGuestIdsForWorkspace,
  workspaceHasGuestGrants,
} from './db.js';
import { canOwnGuests } from './guest-accounts.js';
import { stripVirtualJidSuffix } from './utils.js';
import {
  hasBoundWorkspaceReference,
  resolveBoundWorkspaceJid,
} from './workspace-attribution.js';

/** Who may receive a chat's output: its owner and the guests watching it. */
export interface GroupAudience {
  ownerId: string;
  guestIds: string[];
}

/**
 * The users a chat's output may reach, or null when its ownership cannot be
 * resolved (default-deny). Guests are included; pass `includeGuests: false`
 * for data read-only guests may not see (it mirrors what REST denies them).
 */
export function getGroupAllowedUserIds(
  chatJid: string,
  options: { includeGuests?: boolean } = {},
): Set<string> | null {
  const audience = getGroupAudience(chatJid);
  if (!audience) return null;
  return new Set(
    options.includeGuests === false
      ? [audience.ownerId]
      : [audience.ownerId, ...audience.guestIds],
  );
}

export function getGroupAudience(chatJid: string): GroupAudience | null {
  const agentSep = chatJid.indexOf('#agent:');
  const baseChatJid = agentSep < 0 ? chatJid : chatJid.slice(0, agentSep);
  const group = getRegisteredGroup(baseChatJid);
  if (!group) return null;

  const attributionDeps = {
    getRegisteredGroup,
    getAgent,
    getJidsByFolder,
    getChannelMount,
  };

  // A bound IM chat's audience is the owner of the workspace it is bound to.
  // The IM row keeps the channel account owner's `created_by` even after the
  // chat is bound elsewhere, so trusting it directly would deliver another
  // workspace's conversation to the account owner. Kept consistent with
  // normalizeHomeJid so the broadcast label and its ACL resolve the same group.
  const boundJid = resolveBoundWorkspaceJid(baseChatJid, attributionDeps);
  const hasBinding = hasBoundWorkspaceReference(baseChatJid, attributionDeps);
  // A declared binding whose target is stale is not an unbound chat. Falling
  // back to the channel row would expose the target workspace's output to the
  // channel account owner's old home session.
  if (hasBinding && !boundJid) return null;
  const attributionGroup =
    (boundJid ? getRegisteredGroup(boundJid) : null) ?? group;

  let ownerId: string | null = attributionGroup.created_by ?? null;
  // Folder fallback is compatibility-only for genuinely unbound legacy IM
  // rows. Once a binding resolves, an ownerless target must fail closed rather
  // than borrowing the channel row's original owner.
  if (!ownerId && !hasBinding && !baseChatJid.startsWith('web:')) {
    for (const siblingJid of getJidsByFolder(group.folder)) {
      if (!siblingJid.startsWith('web:')) continue;
      const sibling = getRegisteredGroup(siblingJid);
      if (sibling?.is_home && sibling.created_by) {
        ownerId = sibling.created_by;
        break;
      }
    }
  }
  if (!ownerId) return null;
  // Ownership and binding are security-sensitive mutable state. Resolve them
  // on every broadcast instead of retaining a raw-JID cache that can outlive a
  // rebind or ownership transfer.

  // Read-only guests with an active grant on the workspace this output is
  // attributed to also receive it. The grant must come from the same owner
  // that owns the workspace now (checked in SQL together with both accounts'
  // status), so a stale grant never leaks a re-owned workspace. An owner who
  // may no longer hold guests (allowMemberGuests off) shares with nobody.
  const workspaceJid = resolveAudienceWorkspaceJid(baseChatJid, boundJid);
  if (!workspaceJid) return { ownerId, guestIds: [] };
  const workspace =
    workspaceJid === baseChatJid ? group : getRegisteredGroup(workspaceJid);
  return {
    ownerId,
    guestIds:
      workspace?.created_by === ownerId
        ? listViewingGuestIds(workspaceJid, ownerId)
        : [],
  };
}

/**
 * Guests currently allowed to watch `workspaceJid`, a workspace `ownerId`
 * owns: active grants from that owner, while the owner may hold guests.
 */
export function listViewingGuestIds(
  workspaceJid: string,
  ownerId: string,
): string[] {
  // Every broadcast comes through here; most workspaces have no grants.
  if (!workspaceHasGuestGrants(workspaceJid)) return [];
  const guestIds = listActiveGuestIdsForWorkspace(workspaceJid, ownerId);
  if (guestIds.length === 0) return guestIds;
  const owner = getUserById(ownerId);
  return owner && canOwnGuests(owner) ? guestIds : [];
}

/**
 * The workspace whose guests may watch a chat: the workspace itself or the
 * one a chat is bound to. An unbound IM chat reaches no workspace's guests,
 * whatever folder its row records.
 */
function resolveAudienceWorkspaceJid(
  baseChatJid: string,
  boundJid: string | null,
): string | null {
  if (boundJid) {
    const base = stripVirtualJidSuffix(boundJid);
    return base.startsWith('web:') ? base : null;
  }
  return baseChatJid.startsWith('web:') ? baseChatJid : null;
}
