/**
 * Provider-specific reading of a channel delivery failure, shared by the host
 * settlement paths (turn close, user notices, send_message tool results).
 *
 * The Outbox only persists an error *message*. The structured provider cause
 * (Feishu business code, DLP reason, recalled anchor) is captured here while
 * the failing call is still in memory so the same process can decide how to
 * close the Turn and what to tell the user and the Agent.
 */
import { classifyFeishuError, feishuErrorCode } from './feishu-errors.js';
import type { FeishuErrorKind } from './feishu-errors.js';

export interface ChannelDeliveryFailureDetail {
  kind?: FeishuErrorKind;
  code?: number;
  /** Short Chinese explanation suitable for user-facing notices. */
  reason?: string;
  /** The reply anchor was recalled/deleted, or the bot cannot post there. */
  targetUnavailable: boolean;
  /** The content itself was refused (DLP audit, invalid card content). */
  contentRejected: boolean;
}

const MAX_CHAIN_DEPTH = 8;

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    typeof current === 'object' &&
    !seen.has(current) &&
    chain.length < MAX_CHAIN_DEPTH
  ) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Find the first node in the cause chain that carries a Feishu business code
 * and classify it. Host wrappers (Scoped/Definitive delivery errors) carry the
 * provider failure as `cause`; non-Feishu failures yield an empty detail.
 */
export function describeChannelDeliveryFailure(
  error: unknown,
): ChannelDeliveryFailureDetail {
  for (const node of errorChain(error)) {
    if (feishuErrorCode(node) === undefined) continue;
    const classified = classifyFeishuError(node);
    return {
      kind: classified.kind,
      ...(classified.code !== undefined ? { code: classified.code } : {}),
      ...(classified.reason ? { reason: classified.reason } : {}),
      targetUnavailable: classified.kind === 'target_unavailable',
      contentRejected: classified.kind === 'content_rejected',
    };
  }
  return { targetUnavailable: false, contentRejected: false };
}

/**
 * A Feishu streaming card whose final body was refused was terminalized to a
 * minimal state and never showed the reply. Matched by name so this policy
 * module does not import the card controller. Only the top-level error
 * counts: wrapped inside partial/uncertain evidence it no longer proves that
 * nothing of the reply became visible.
 */
export function isFeishuCardContentRejection(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'FeishuCardContentRejectedError'
  );
}

/**
 * Text to deliver as static messages after a refused Feishu card body: the
 * whole reply for a single-page card, only the refused pages for a
 * multi-page card (accepted pages stay visible). Only when the card was
 * terminalized to its minimal notice; otherwise the card may still show the
 * streamed body (and recovery may rewrite it), so no static copy is safe and
 * the caller must treat the outcome as uncertain.
 */
export function feishuCardStaticFallbackText(
  error: unknown,
): string | undefined {
  if (!isFeishuCardContentRejection(error)) return undefined;
  const rejected = error as {
    undeliveredText?: unknown;
    cardTerminalized?: unknown;
  };
  if (rejected.cardTerminalized === false) return undefined;
  return typeof rejected.undeliveredText === 'string'
    ? rejected.undeliveredText
    : undefined;
}

/**
 * A refused card's other page whose final update failed ambiguously (mixed
 * failure). The refused pages are still delivered statically; this cause
 * additionally flags the reply as unconfirmed.
 */
export function feishuCardUncertainCause(error: unknown): unknown {
  if (!isFeishuCardContentRejection(error)) return undefined;
  return (error as { uncertainCause?: unknown }).uncertainCause;
}

// ─── Per-process failure detail registry ─────────────────────────────────

const MAX_REMEMBERED_FAILURES = 512;
const rememberedFailures = new Map<string, ChannelDeliveryFailureDetail>();

/** Remember the structured cause of a non-delivered Outbox row. */
export function rememberChannelOutboxFailure(
  outboxItemId: string | undefined,
  error: unknown,
): ChannelDeliveryFailureDetail {
  const detail = describeChannelDeliveryFailure(error);
  if (!outboxItemId) return detail;
  rememberedFailures.delete(outboxItemId);
  rememberedFailures.set(outboxItemId, detail);
  while (rememberedFailures.size > MAX_REMEMBERED_FAILURES) {
    const oldest = rememberedFailures.keys().next().value;
    if (oldest === undefined) break;
    rememberedFailures.delete(oldest);
  }
  return detail;
}

export function channelOutboxFailureDetail(
  outboxItemId: string | undefined,
): ChannelDeliveryFailureDetail | undefined {
  return outboxItemId ? rememberedFailures.get(outboxItemId) : undefined;
}

/** Test seam. */
export function resetChannelOutboxFailuresForTests(): void {
  rememberedFailures.clear();
}

// ─── Wording ─────────────────────────────────────────────────────────────

/** Append the provider's reason to a user-facing rejection notice. */
export function withChannelFailureReason(
  notice: string,
  reason: string | undefined,
): string {
  if (!reason) return notice;
  return `${notice}\n原因：${reason}。`;
}

/**
 * Tool-result guidance for an Agent whose send was definitively refused.
 * Content refusals are actionable (rewrite and resend); a vanished target is
 * not.
 */
export function channelRejectionAgentGuidance(
  detail: ChannelDeliveryFailureDetail | undefined,
): string {
  if (detail?.contentRejected) {
    return (
      `The channel refused this content${detail.reason ? ` (${detail.reason}${detail.code !== undefined ? `, code ${detail.code}` : ''})` : ''}. ` +
      'Rewrite the message to remove the refused content (for example mask e-mail addresses or other sensitive data, or simplify the formatting) and send it again.'
    );
  }
  if (detail?.targetUnavailable) {
    return (
      `The reply target is no longer available${detail.reason ? ` (${detail.reason})` : ''}. ` +
      'Do not retry; the user withdrew the message or the bot can no longer post there.'
    );
  }
  return 'The complete answer will remain available in HappyClaw Web; do not retry or rewrite it solely for this channel failure.';
}
