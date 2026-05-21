/**
 * Pure helpers for computing default field values when auto-registering
 * IM group chats. Extracted from src/index.ts so unit tests can lock the
 * behavior without booting the full service.
 *
 * The single source of truth for "what defaults should a newly auto-
 * registered Feishu/Telegram/etc group get" lives here. Both the
 * `buildOnNewChat` flow in index.ts and unit tests call this.
 */

export interface ImGroupDefaultsInput {
  /**
   * The owner user's per-user preference for require_mention on newly
   * auto-registered IM groups. Undefined when the user record cannot be
   * resolved (defensive — auto-register can race with user deletion); in
   * that case we treat as `false` to preserve the legacy default.
   */
  ownerDefaultRequireMention?: boolean | null;
}

export interface ImGroupDefaultsOutput {
  /** Final require_mention value to stamp on the newly registered group. */
  requireMention: boolean;
}

/**
 * Compute the field values to apply when auto-registering a brand-new IM
 * group chat (one that does NOT already exist in registered_groups).
 *
 * Locked by tests/im-group-defaults.test.ts. Adding new fields here
 * should also extend the test file with a row.
 */
export function resolveImGroupDefaults(
  input: ImGroupDefaultsInput,
): ImGroupDefaultsOutput {
  return {
    requireMention: input.ownerDefaultRequireMention === true,
  };
}
