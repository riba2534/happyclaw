/**
 * Owner-lifecycle transitions for a registered IM/web group.
 *
 * Background: `owner_im_id` / `sender_allowlist` / `activation_mode` used to be
 * written by 8+ hand-rolled `setRegisteredGroup` call sites (DM auto-claim,
 * /owner_mention, /allow owner-backfill, /release_owner, admin /reset-owner,
 * /allow, /disallow, /require_mention). Two invariants were copy-pasted across
 * them and therefore drift-prone:
 *
 *   1. Releasing an owner MUST downgrade an 'owner_mentioned' activation mode
 *      to 'when_mentioned'. Otherwise `isGroupOwnerMessage()` can never match
 *      (there is no owner left to compare against) and the bot goes
 *      permanently silent in the group. Hand-copied in /release_owner AND the
 *      admin /reset-owner route.
 *   2. Claiming an owner MUST NOT touch `activation_mode` — claiming is an
 *      identity anchor, not an activation-policy change. Copied in 3 sites
 *      (DM auto-claim, /owner_mention, /allow backfill).
 *
 * These helpers are PURE (return a new group, never mutate) so each invariant
 * lives in exactly one place and is unit-tested. The other recurring footgun is
 * persistence: every site paired `setRegisteredGroup(jid, g)` with
 * `cache[jid] = g`, and forgetting the second half leaves the message poller
 * reading stale owner/allowlist state until the next restart.
 * `persistGroupUpdate` binds the two so a caller cannot do one without the other.
 *
 * Out of scope (intentionally left inline):
 *   - Initial owner seeding at registration (`buildOnNewChat`'s `registerGroup`
 *     call) — that is row birth, not a transition on an existing group.
 *   - /require_mention's own `activation_mode` writes — a single site whose mode
 *     change carries no cross-cutting invariant (it still persists via
 *     `persistGroupUpdate` for cache coherence).
 */
import { setRegisteredGroup } from './db.js';
import type { RegisteredGroup } from './types.js';

/**
 * Claim `senderImId` as the group owner. `activation_mode` is deliberately left
 * untouched (invariant #2). This helper applies the state change only; the
 * caller is responsible for gating (group unowned, or sender re-claiming
 * themselves) before invoking it.
 */
export function claimOwner(
  group: RegisteredGroup,
  senderImId: string,
): RegisteredGroup {
  return { ...group, owner_im_id: senderImId };
}

/**
 * Release ownership: clear the owner anchor + allowlist, and downgrade an
 * 'owner_mentioned' activation mode to 'when_mentioned' (invariant #1). Every
 * other activation mode is preserved.
 */
export function releaseOwner(group: RegisteredGroup): RegisteredGroup {
  return {
    ...group,
    owner_im_id: undefined,
    sender_allowlist: undefined,
    activation_mode:
      group.activation_mode === 'owner_mentioned'
        ? 'when_mentioned'
        : group.activation_mode,
  };
}

/**
 * Add ids to the sender allowlist, deduped. A null/undefined allowlist means
 * "unrestricted"; in that case the first add seeds the list with the owner so
 * the owner stays able to trigger. NOTE the seeding fires ONLY for
 * null/undefined — an explicit empty array `[]` (the "owner-locked trap" state
 * a Feishu group is born in before its owner's open_id is known; see
 * RegisteredGroup.sender_allowlist in types.ts) is a real restrictive list, so
 * `[] ?? [owner]` stays `[]` and `/allow` does NOT re-seed the owner there. That
 * `[]` state is recovered separately by backfillEmptyAllowlistsForUser, not here.
 * Returns the updated group plus the ids actually added (already-present ids are
 * dropped). When nothing new is added the original group is returned unchanged so
 * the caller can skip persistence.
 */
export function addToAllowlist(
  group: RegisteredGroup,
  ownerImId: string,
  idsToAdd: string[],
): { group: RegisteredGroup; added: string[] } {
  const current = group.sender_allowlist ?? [ownerImId];
  const added = idsToAdd.filter((id) => !current.includes(id));
  if (added.length === 0) return { group, added };
  return { group: { ...group, sender_allowlist: [...current, ...added] }, added };
}

/**
 * Remove ids from the sender allowlist. Returns the updated group plus the
 * count actually removed. A null/undefined or empty allowlist yields no change
 * (the original group is returned).
 */
export function removeFromAllowlist(
  group: RegisteredGroup,
  idsToRemove: string[],
): { group: RegisteredGroup; removed: number } {
  const current = group.sender_allowlist;
  if (!current || current.length === 0) return { group, removed: 0 };
  const next = current.filter((id) => !idsToRemove.includes(id));
  return { group: { ...group, sender_allowlist: next }, removed: current.length - next.length };
}

/**
 * Persist a group lifecycle update and keep the in-memory cache coherent in one
 * step. Pairs `setRegisteredGroup` with the `cache[jid] = updated` sync that
 * every owner-lifecycle call site was doing by hand. `cache` is the caller's
 * in-memory `Record<jid, RegisteredGroup>` (the main process's `registeredGroups`
 * map, or the web layer's `deps.getRegisteredGroups()`).
 */
export function persistGroupUpdate(
  chatJid: string,
  group: RegisteredGroup,
  cache: Record<string, RegisteredGroup>,
): void {
  setRegisteredGroup(chatJid, group);
  cache[chatJid] = group;
}
