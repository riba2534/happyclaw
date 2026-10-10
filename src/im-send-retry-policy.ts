import { isFeishuCardContentRejection } from './channel-delivery-failure.js';

export interface ImSendFailurePolicy {
  retryable: boolean;
  countsTowardChannelRemoval: boolean;
  outcome: ImSendFailureOutcome;
}

export type ImSendFailureOutcome = 'pre_accept' | 'rejected' | 'uncertain';

export interface ImSendFailureRef {
  error?: unknown;
  outcome?: ImSendFailureOutcome;
}

export class ImDeliveryPhaseError extends Error {
  constructor(
    readonly deliveryPhase: ImSendFailureOutcome,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ImDeliveryPhaseError';
  }
}

/**
 * A multi-part/chunk send acknowledged at least one physical side effect
 * before a later part failed. Replaying the enclosing operation would resend
 * the acknowledged prefix, so every host retry path must treat it as
 * uncertain regardless of the tail error's errno.
 */
export class PhysicalDeliveryProgressError extends ImDeliveryPhaseError {
  readonly acknowledgedParts: number;

  constructor(
    message: string,
    acknowledgedParts: number,
    options: { cause?: unknown } = {},
  ) {
    super('uncertain', message, options);
    this.name = 'PhysicalDeliveryProgressError';
    this.acknowledgedParts = Math.max(1, Math.trunc(acknowledgedParts));
  }
}

export function physicalDeliveryProgressError(
  error: unknown,
  acknowledgedParts: number,
): PhysicalDeliveryProgressError {
  return new PhysicalDeliveryProgressError(
    `Physical delivery failed after ${Math.max(1, Math.trunc(acknowledgedParts))} acknowledged part(s): ${
      error instanceof Error ? error.message : String(error)
    }`,
    acknowledgedParts,
    { cause: error },
  );
}

export function preAcceptImDeliveryError(
  message: string,
  cause?: unknown,
): ImDeliveryPhaseError {
  return new ImDeliveryPhaseError('pre_accept', message, { cause });
}

const REFRESH_REQUIRED_CODE = 'WECHAT_CONTEXT_REFRESH_REQUIRED';
const DEFINITIVE_DELIVERY_REJECTION_CODE = 'CHANNEL_DELIVERY_REJECTED';
const UNCERTAIN_DELIVERY_CODE = 'CHANNEL_DELIVERY_UNCERTAIN';
const PARTIAL_DELIVERY_CODE = 'CHANNEL_DELIVERY_PARTIAL';

function errorChainHasCode(error: unknown, expectedCode: string): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === expectedCode) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function explicitImDeliveryPhase(
  error: unknown,
): ImSendFailureOutcome | undefined {
  for (const item of errorChain(error)) {
    const phase = item.deliveryPhase ?? item.outcome;
    if (
      phase === 'pre_accept' ||
      phase === 'rejected' ||
      phase === 'uncertain'
    ) {
      return phase;
    }
  }
  return undefined;
}

function numericBodyCode(value: unknown): boolean {
  const code = (value as { code?: unknown } | undefined)?.code;
  return (
    (typeof code === 'number' && Number.isFinite(code)) ||
    (typeof code === 'string' && /^\d+$/.test(code))
  );
}

/**
 * Feishu capability/broker failures carry no generic delivery phase. Their
 * own wrapper says whether Feishu was unreachable before the request was
 * sent (pre-acceptance) or refused it; a raw SDK error that received a 4xx
 * response with a Feishu body code is a refusal too. 5xx/408 stay ambiguous.
 */
function classifyFeishuRefusal(
  chain: Array<Record<string, unknown>>,
): ImSendFailureOutcome | undefined {
  for (const item of chain) {
    if (item.name === 'DefinitiveFeishuCapabilityError') {
      return /before the request was sent/i.test(String(item.message ?? ''))
        ? 'pre_accept'
        : 'rejected';
    }
  }
  for (const item of chain) {
    const response = item.response as
      | { status?: unknown; data?: unknown }
      | undefined;
    if (!response || typeof response !== 'object') continue;
    const status = response.status;
    if (
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      numericBodyCode(response.data)
    ) {
      return 'rejected';
    }
  }
  return undefined;
}

/**
 * Classify only from transport-stage evidence. A bare timeout/reset is
 * uncertain because it can occur after the provider accepted the mutation.
 */
export function classifyImSendFailure(error: unknown): ImSendFailureOutcome {
  // A Feishu streaming card whose final body was refused and that was then
  // terminalized to a minimal notice never showed the reply: an explicit
  // rejection, so the host delivers the reply as static messages. If even
  // the notice update failed (`cardTerminalized: false`) the card may still
  // show streamed body text and recovery may rewrite it, so a static copy
  // could duplicate the answer: that outcome stays uncertain.
  if (isFeishuCardContentRejection(error)) {
    return (error as { cardTerminalized?: unknown }).cardTerminalized === false
      ? 'uncertain'
      : 'rejected';
  }
  const chain = errorChain(error);
  // Any acknowledged-prefix/uncertain evidence dominates a nested definitive
  // tail rejection. The outer operation can no longer be replayed safely even
  // when the final provider mutation was explicitly rejected.
  if (
    errorChainHasCode(error, UNCERTAIN_DELIVERY_CODE) ||
    errorChainHasCode(error, PARTIAL_DELIVERY_CODE) ||
    explicitImDeliveryPhase(error) === 'uncertain'
  ) {
    return 'uncertain';
  }
  if (
    errorChainHasCode(error, REFRESH_REQUIRED_CODE) ||
    errorChainHasCode(error, DEFINITIVE_DELIVERY_REJECTION_CODE) ||
    explicitImDeliveryPhase(error) === 'rejected'
  ) {
    return 'rejected';
  }
  if (explicitImDeliveryPhase(error) === 'pre_accept') {
    return 'pre_accept';
  }
  const feishuRefusal = classifyFeishuRefusal(chain);
  if (feishuRefusal) return feishuRefusal;

  const codes = new Set(chain.map((item) => String(item.code ?? '')));
  const message = chain.map((item) => String(item.message ?? '')).join(' ');
  if (
    codes.has('ENOTFOUND') ||
    codes.has('EAI_AGAIN') ||
    codes.has('ECONNREFUSED') ||
    codes.has('UND_ERR_CONNECT_TIMEOUT') ||
    /disconnected before secure TLS connection was established/i.test(
      message,
    ) ||
    /^(?:Unknown channel type|No IM channel available|Invalid .*chat ID|.* channel is not connected)/i.test(
      message,
    ) ||
    /(?:file|image).*(?:too large|not found|unavailable)/i.test(message)
  ) {
    return 'pre_accept';
  }
  return 'uncertain';
}

/**
 * Decide whether repeating a failed IM send can make progress and whether the
 * failure is evidence that the concrete chat binding is unhealthy.
 */
export function imSendFailurePolicy(error: unknown): ImSendFailurePolicy {
  const outcome = classifyImSendFailure(error);
  if (outcome !== 'pre_accept') {
    return {
      retryable: false,
      countsTowardChannelRemoval: false,
      outcome,
    };
  }
  return {
    retryable: true,
    countsTowardChannelRemoval: true,
    outcome,
  };
}

/**
 * A timeout after the physical send started cannot prove the provider
 * rejected the message. The request may already have been accepted.
 */
export function isUncertainAfterAcceptImError(error: unknown): boolean {
  return classifyImSendFailure(error) === 'uncertain';
}

export interface RetryUnscopedImSendOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailure?: (error: unknown, attempt: number) => void;
}

/**
 * Unscoped (no outbox) IM send. Pre-accept failures may still retry;
 * an ETIMEDOUT after the physical send started must not resend.
 */
export async function retryUnscopedImSend(
  send: () => Promise<void>,
  options: RetryUnscopedImSendOptions = {},
): Promise<{
  ok: boolean;
  outcome: 'delivered' | ImSendFailureOutcome;
  error?: unknown;
}> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 2_000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await send();
      return { ok: true, outcome: 'delivered' };
    } catch (error) {
      lastError = error;
      options.onAttemptFailure?.(error, attempt);
      // After the physical send started, ETIMEDOUT cannot prove rejection.
      // Retrying would deliver a second visible copy of the same notice.
      const policy = imSendFailurePolicy(error);
      if (!policy.retryable) {
        return { ok: false, outcome: policy.outcome, error };
      }
      if (attempt < maxAttempts - 1) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }
  return { ok: false, outcome: 'pre_accept', error: lastError };
}
