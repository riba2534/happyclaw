import {
  getAgent,
  getChannelMount,
  getJidsByFolder,
  getRegisteredGroup,
  listActiveGuestIdsForWorkspace,
} from './db.js';
import {
  hasBoundWorkspaceReference,
  resolveBoundWorkspaceJid,
} from './workspace-attribution.js';

export function getGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const virtualSeparator = ['#agent:', '#task:']
    .map((separator) => chatJid.indexOf(separator))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const baseChatJid =
    virtualSeparator === undefined
      ? chatJid
      : chatJid.slice(0, virtualSeparator);
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
  const allowed = new Set<string>([ownerId]);

  // Read-only guests with an active grant on the workspace this output is
  // attributed to also receive it. The grant must come from the same owner
  // that owns the workspace now (checked in SQL together with both accounts'
  // status), so a stale grant never leaks a re-owned workspace.
  const workspaceJid = resolveAudienceWorkspaceJid(
    baseChatJid,
    boundJid,
    hasBinding,
    group.folder,
  );
  if (workspaceJid) {
    const workspace = getRegisteredGroup(workspaceJid);
    if (workspace?.created_by === ownerId) {
      for (const guestId of listActiveGuestIdsForWorkspace(
        workspaceJid,
        ownerId,
      )) {
        allowed.add(guestId);
      }
    }
  }
  return allowed;
}

function resolveAudienceWorkspaceJid(
  baseChatJid: string,
  boundJid: string | null,
  hasBinding: boolean,
  folder: string,
): string | null {
  if (boundJid) {
    const marker = boundJid.indexOf('#agent:');
    const base = marker >= 0 ? boundJid.slice(0, marker) : boundJid;
    return base.startsWith('web:') ? base : null;
  }
  if (baseChatJid.startsWith('web:')) return baseChatJid;
  if (hasBinding) return null;
  for (const siblingJid of getJidsByFolder(folder)) {
    if (siblingJid.startsWith('web:')) return siblingJid;
  }
  return null;
}
