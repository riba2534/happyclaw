/**
 * Terminal system-notice settle helper for deterministic turn failures
 * (context_overflow / context_budget / agent_profile_unavailable /
 * OOM context_reset / unrecoverable_transcript / agent_max_retries).
 *
 * Telegram / WhatsApp / WeChat never create a streaming session
 * (im-manager only feishu/dingtalk/discord/qq/wecom), so the main finally
 * abort does not cover them. Web-only sendSystemMessage + commitCursor left
 * those IMs silent while the host still returned SUCCESS. Mirror
 * billing-denied: deliverIndependentChannelSystemNotice first,
 * sendSystemMessage as Web audit after ACK, commit/advance only after ACK
 * (preserve cursor on notice failure).
 *
 * HOLD: WeChat outbound hang leftovers are untouched — this helper only
 * decides settle order; callers reuse the existing independent-notice path.
 */

export type TerminalSystemNoticeKey =
  | 'context-overflow'
  | 'context-budget'
  | 'agent-profile-unavailable'
  | 'oom-context-reset'
  | 'unrecoverable-transcript'
  | 'unrecoverable-transcript-agent'
  | 'agent-max-retries';

export type TerminalNoticeSettleResult = 'preserve-cursor' | 'committed';

/**
 * Fan out an IM notice when a reply route exists, then run the Web audit.
 * Commit is allowed only after IM ACK (or when there is no IM route).
 */
export async function settleTerminalSystemNotice(input: {
  hasImReplyRoute: boolean;
  /** Deliver IM notice; must return true only on ACK / uncertain-as-delivered. */
  deliverImNotice: () => Promise<boolean>;
  /** Web transcript audit (sendSystemMessage). Called only when settling. */
  webAudit: () => void | Promise<void>;
}): Promise<TerminalNoticeSettleResult> {
  if (input.hasImReplyRoute) {
    const acknowledged = await input.deliverImNotice();
    if (!acknowledged) {
      return 'preserve-cursor';
    }
  }
  await input.webAudit();
  return 'committed';
}

/** Resolve IM target for max-retries / out-of-band terminal notices. */
export function resolveTerminalNoticeImJid(input: {
  messageSourceJids: Array<string | null | undefined>;
  activeReplyRouteJid?: string | null;
  chatJid?: string | null;
  isImJid: (jid: string) => boolean;
}): string | null {
  for (let i = input.messageSourceJids.length - 1; i >= 0; i--) {
    const jid = input.messageSourceJids[i];
    if (jid && input.isImJid(jid)) return jid;
  }
  if (input.activeReplyRouteJid && input.isImJid(input.activeReplyRouteJid)) {
    return input.activeReplyRouteJid;
  }
  if (input.chatJid && input.isImJid(input.chatJid)) {
    return input.chatJid;
  }
  return null;
}
