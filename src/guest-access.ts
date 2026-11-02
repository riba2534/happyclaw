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
  hasActiveGuestWorkspaceGrant,
} from './db.js';
import { canAccessGroup } from './group-acl.js';
import type { Automation, AutomationRun } from './automation.js';
import type { RegisteredGroup, UserRole } from './types.js';
import { stripVirtualJidSuffix } from './utils.js';
import { resolveBoundWorkspaceJid } from './workspace-attribution.js';

export const GUEST_READ_ONLY_ERROR = 'Guest accounts are read-only';

type ActorLike = { id: string; role: UserRole };
type GroupWithJid = RegisteredGroup & { jid: string };

/**
 * Names that hide a path from guests when any of its segments matches
 * (compared lowercased, so a case-insensitive filesystem cannot reopen one).
 * A host workspace's root is the admin's real directory, so the default is
 * to hide: every dot entry (`.git`, `.ssh`, `.aws`, `.env*`, `.npmrc`,
 * `.claude` …), common key and credential files, runner logs and raw
 * conversation archives. Matching any depth is deliberately conservative: a
 * project subdirectory named `logs` is hidden too.
 */
const GUEST_HIDDEN_NAMES: ReadonlySet<string> = new Set([
  'logs',
  'conversations',
  'credentials.json',
]);
const GUEST_HIDDEN_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore'];
const GUEST_HIDDEN_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

function isGuestHiddenName(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    name.startsWith('.') ||
    GUEST_HIDDEN_NAMES.has(name) ||
    GUEST_HIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    GUEST_HIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * True when a workspace-relative path is hidden from guests. Callers that
 * read the filesystem also check where the path really points (symlinks).
 */
export function isGuestHiddenWorkspacePath(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => part !== '' && part !== '.' && isGuestHiddenName(part));
}

/**
 * Resolve the `web:` workspace a group row belongs to: the row itself for a
 * workspace or one of its sessions, the bound workspace for a bound IM chat.
 * An unbound or stale-bound IM chat belongs to no workspace a guest can view,
 * whatever folder its row records.
 */
export function resolveViewWorkspace(group: GroupWithJid): GroupWithJid | null {
  const jid = stripVirtualJidSuffix(group.jid);
  if (jid.startsWith('web:')) {
    if (jid === group.jid) return group;
    const base = getRegisteredGroup(jid);
    return base ? { ...base, jid } : null;
  }
  const bound = resolveBoundWorkspaceJid(jid, {
    getRegisteredGroup,
    getAgent,
    getJidsByFolder,
    getChannelMount,
  });
  if (!bound) return null;
  const base = stripVirtualJidSuffix(bound);
  const row = getRegisteredGroup(base);
  return row && base.startsWith('web:') ? { ...row, jid: base } : null;
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

/** Pre-run checks and scripts run on the host; guests see neither. */
export function redactAutomationForGuest(automation: Automation): Automation {
  return { ...automation, preRunCheck: null, scriptCommand: null };
}

/** A run as a guest sees it: the pre-run check's output left out. */
export function redactAutomationRunForGuest(run: AutomationRun): AutomationRun {
  return run.preCheck
    ? { ...run, preCheck: { ...run.preCheck, stdout: '', stderr: '' } }
    : run;
}

/** A message as guests see it: no token usage or cost. */
export function withoutUsageForGuest<
  T extends { token_usage?: unknown; cost_usd?: unknown },
>(message: T): T {
  if (message.token_usage === undefined && message.cost_usd === undefined) {
    return message;
  }
  const { token_usage: _usage, cost_usd: _cost, ...rest } = message;
  return rest as T;
}
