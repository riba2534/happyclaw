/**
 * Read-only guest accounts.
 *
 * A guest belongs to one owner (an active admin or member) and may *view* the
 * subset of the owner's workspaces the owner granted. Viewing is deliberately
 * a separate predicate from `canAccessGroup`: that helper gates ~30
 * side-effecting paths (terminal, message send, task run, file writes, IM sync
 * …), so widening it would hand guests those too. Read handlers that guests
 * may reach opt in to `canViewGroup` one by one; everything else keeps using
 * the owner-only predicates and the global guest guard
 * (src/middleware/guest-guard.ts) rejects every route that is not on its
 * explicit allowlist.
 */
import {
  getAgent,
  getChannelMount,
  getJidsByFolder,
  getRegisteredGroup,
  deleteUserSessionsByUserId,
  getUserById,
  hasActiveGuestWorkspaceGrant,
  listGuestIdsByOwner,
} from './db.js';
import { invalidateUserSessions } from './web-context.js';
import { canAccessGroup } from './group-acl.js';
import type { RegisteredGroup, User, UserRole } from './types.js';
import {
  hasBoundWorkspaceReference,
  resolveBoundWorkspaceJid,
} from './workspace-attribution.js';

export const GUEST_READ_ONLY_ERROR = 'Guest accounts are read-only';

type ActorLike = { id: string; role: UserRole };
type GroupWithJid = RegisteredGroup & { jid: string };

export function isGuestUser(user: { role: UserRole } | null | undefined) {
  return user?.role === 'guest';
}

/**
 * Paths inside a workspace that guests never see. Directories: runtime and
 * session state (`.claude` holds SDK transcripts, settings and credential
 * snapshots), runner logs, and raw conversation archives. They are matched
 * at any depth (conservative: a project subdirectory named `logs` is hidden
 * too). Files: dotenv files (`.env`, `.env.*`), which commonly hold secrets in
 * a host workspace's real project directory.
 */
export const GUEST_HIDDEN_WORKSPACE_DIRS: ReadonlySet<string> = new Set([
  '.claude',
  'logs',
  'conversations',
]);

/** True when a workspace-relative path is hidden from guests. */
export function isGuestHiddenWorkspacePath(relativePath: string): boolean {
  const parts = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.');
  if (parts.some((part) => GUEST_HIDDEN_WORKSPACE_DIRS.has(part))) return true;
  const base = parts[parts.length - 1] ?? '';
  return base === '.env' || base.startsWith('.env.');
}

function stripVirtualSuffix(jid: string): string {
  const indexes = ['#agent:', '#task:']
    .map((marker) => jid.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length ? jid.slice(0, Math.min(...indexes)) : jid;
}

/**
 * Resolve the `web:` workspace a group row belongs to: the row itself for a
 * workspace, the bound workspace for a bound IM chat, the folder's workspace
 * for an unbound legacy IM chat. A stale binding resolves to nothing.
 */
export function resolveViewWorkspace(group: GroupWithJid): GroupWithJid | null {
  const jid = stripVirtualSuffix(group.jid);
  if (jid.startsWith('web:')) {
    if (jid === group.jid) return group;
    const base = getRegisteredGroup(jid);
    return base ? { ...base, jid } : null;
  }
  const deps = {
    getRegisteredGroup,
    getAgent,
    getJidsByFolder,
    getChannelMount,
  };
  const bound = resolveBoundWorkspaceJid(jid, deps);
  if (bound) {
    const base = stripVirtualSuffix(bound);
    const row = getRegisteredGroup(base);
    return row && base.startsWith('web:') ? { ...row, jid: base } : null;
  }
  if (hasBoundWorkspaceReference(jid, deps)) return null;
  for (const sibling of getJidsByFolder(group.folder)) {
    if (!sibling.startsWith('web:')) continue;
    const row = getRegisteredGroup(sibling);
    if (row) return { ...row, jid: sibling };
  }
  return null;
}

/**
 * Whether a guest holds a currently valid grant for the workspace behind
 * `group`. Valid means: the actor is a guest, the grant row exists, the guest
 * and its owner are both active, and the workspace is still owned by the
 * owner who granted it.
 */
export function guestHasActiveGrant(
  user: ActorLike,
  group: GroupWithJid,
): boolean {
  if (user.role !== 'guest') return false;
  const workspace = resolveViewWorkspace(group);
  if (!workspace || !workspace.created_by) return false;
  return hasActiveGuestWorkspaceGrant(
    user.id,
    workspace.jid,
    workspace.created_by,
  );
}

/** Read-only visibility: owner access, or an active guest grant. */
export function canViewGroup(user: ActorLike, group: GroupWithJid): boolean {
  return canAccessGroup(user, group) || guestHasActiveGrant(user, group);
}

/**
 * Host-mode workspaces are hidden from non-admins. A granted guest may still
 * *read* the owner's host workspace (typically an admin Home); this never
 * extends to execution, which every write path keeps gating on admin.
 */
export function canViewHostGroup(
  user: ActorLike,
  group: GroupWithJid,
): boolean {
  return user.role === 'admin' || guestHasActiveGrant(user, group);
}

export type GuestAccountState =
  | { valid: true; guest: User; owner: User }
  | { valid: false; reason: 'not_guest' | 'guest_inactive' | 'owner_invalid' };

/**
 * Fresh (uncached) validity of a guest account: the row is an active guest
 * and its owner is an active non-guest. Checked on every guest request so a
 * disabled or deleted owner cuts its guests off immediately.
 */
export function getGuestAccountState(guestUserId: string): GuestAccountState {
  const guest = getUserById(guestUserId);
  if (!guest || guest.role !== 'guest') {
    return { valid: false, reason: 'not_guest' };
  }
  if (guest.status !== 'active') {
    return { valid: false, reason: 'guest_inactive' };
  }
  const owner = guest.guest_owner_id
    ? getUserById(guest.guest_owner_id)
    : undefined;
  if (!owner || owner.status !== 'active' || owner.role === 'guest') {
    return { valid: false, reason: 'owner_invalid' };
  }
  return { valid: true, guest, owner };
}

/**
 * Log out every guest of `ownerId`. Called when the owner is disabled or
 * deleted; the per-request owner check already denies them, this also drops
 * their sessions so open tabs and sockets do not linger.
 */
export function revokeGuestSessionsForOwner(ownerId: string): number {
  const guestIds = listGuestIdsByOwner(ownerId);
  for (const guestId of guestIds) {
    invalidateUserSessions(guestId);
    deleteUserSessionsByUserId(guestId);
  }
  return guestIds.length;
}
