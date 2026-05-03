/**
 * Shared runtime-owner resolution for plugin-command expansion.
 *
 * On the admin-shared `web:main` workspace, plugin runtime is per-user — so
 * the *latest* active admin sender is the correct owner to expand against,
 * not whichever admin first materialised the group (`group.created_by`).
 *
 * Three cold-start / IPC paths share this logic:
 *   - `processGroupMessages` main-conversation cold-start (src/index.ts)
 *   - `processAgentConversation` agent-conv cold-start (src/index.ts)
 *   - active IPC injection in the message-loop (src/index.ts)
 *
 * Keeping a single helper avoids the three call sites drifting apart again
 * (codex review #21 round-13 P2-2). The function is pure: callers inject the
 * user lookup so it stays trivially unit-testable without touching the DB.
 */

export interface RuntimeOwnerCandidateMessage {
  /** Message sender id — system messages (e.g. `__system__`, `happyclaw-agent`) are skipped. */
  sender: string;
}

export interface RuntimeOwnerCandidateUser {
  id: string;
  status: 'active' | 'disabled' | 'deleted';
  role: 'admin' | 'member';
}

/**
 * Walk `messages` from end to start and return the id of the most recent
 * `active admin` sender, or `null` if none qualifies. System / agent senders
 * (`__system__`, `happyclaw-agent`) are skipped without breaking the walk.
 *
 * Callers compose this with their own fallback (typically `group.created_by`)
 * — we deliberately don't accept a fallback parameter here because the
 * admin-shared override only applies on `web:main + is_home`; on other
 * workspaces `created_by` wins outright and the helper isn't called at all.
 */
export function resolveLatestAdminSenderOverride(
  messages: ReadonlyArray<RuntimeOwnerCandidateMessage>,
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sender = messages[i]?.sender;
    if (!sender || sender === 'happyclaw-agent' || sender === '__system__') {
      continue;
    }
    const user = getUserById(sender);
    if (user?.status === 'active' && user.role === 'admin') {
      return user.id;
    }
  }
  return null;
}

/**
 * Convenience wrapper: returns the override sender id if (and only if) the
 * resolved group is the admin-shared `web:main + is_home` workspace; otherwise
 * returns `fallbackOwner` unchanged. Centralises the `chatJid === 'web:main'
 * && isHome` gate that all three call sites previously inlined.
 *
 * `chatJid` may be a virtual JID (`web:main#agent:<id>`) — the gate checks the
 * base JID before the first `#`, mirroring `resolvePluginRuntimeOwner`.
 */
export function resolveAdminSharedRuntimeOwner(args: {
  chatJid: string;
  isHome: boolean;
  fallbackOwner: string | null | undefined;
  messages: ReadonlyArray<RuntimeOwnerCandidateMessage>;
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined;
}): string | null | undefined {
  const hashIdx = args.chatJid.indexOf('#');
  const baseJid =
    hashIdx >= 0 ? args.chatJid.slice(0, hashIdx) : args.chatJid;
  if (baseJid !== 'web:main' || !args.isHome) {
    return args.fallbackOwner;
  }
  const override = resolveLatestAdminSenderOverride(
    args.messages,
    args.getUserById,
  );
  return override ?? args.fallbackOwner;
}

/**
 * Per-message variant of `resolveAdminSharedRuntimeOwner` (#23 round-15
 * P2-2). On the admin-shared `web:main + is_home` workspace, plugin runtime
 * is per-user — so each message in a mixed-admin batch must expand under
 * its OWN sender's runtime, not whichever admin happened to be the latest
 * sender for the batch as a whole.
 *
 * Returns:
 *   - the message's sender id when the sender is an active admin (use
 *     their personal plugin runtime to expand),
 *   - `fallbackOwner` when the sender is non-admin / disabled / unknown
 *     (mirrors the legacy fallback so non-admin senders on web:main still
 *     resolve plugins via the workspace's `created_by` admin),
 *   - `fallbackOwner` outright on non-admin-shared workspaces.
 */
export function resolvePerMessageRuntimeOwner(args: {
  chatJid: string;
  isHome: boolean;
  fallbackOwner: string | null | undefined;
  message: RuntimeOwnerCandidateMessage;
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined;
}): string | null | undefined {
  const hashIdx = args.chatJid.indexOf('#');
  const baseJid =
    hashIdx >= 0 ? args.chatJid.slice(0, hashIdx) : args.chatJid;
  if (baseJid !== 'web:main' || !args.isHome) {
    return args.fallbackOwner;
  }
  const sender = args.message?.sender;
  if (!sender || sender === 'happyclaw-agent' || sender === '__system__') {
    return args.fallbackOwner;
  }
  const user = args.getUserById(sender);
  if (user?.status === 'active' && user.role === 'admin') {
    return user.id;
  }
  return args.fallbackOwner;
}
