import {
  ChannelOutboxItem,
  ChannelOutboxKind,
  ChannelRouteSnapshot,
  claimChannelOutboxById,
  completeChannelOutbox,
  enqueueChannelOutbox,
  failChannelOutbox,
  getChannelOutboxItem,
  getUncertainChannelOutboxForTurn,
  markChannelOutboxSending,
  markChannelOutboxUploaded,
  markChannelOutboxUploading,
  reconcileExpiredChannelOutbox,
} from './channel-reliability-store.js';

export interface ChannelDeliveryReceipt {
  providerMessageId: string;
  providerUploadKey?: string | null;
}

export interface ChannelDeliveryOperationContext {
  item: ChannelOutboxItem;
  payload: unknown;
  signal?: AbortSignal;
}

export interface ChannelSingleStageDelivery {
  mode: 'single';
  send(
    context: ChannelDeliveryOperationContext,
  ): Promise<{ providerMessageId: string }>;
}

export interface ChannelUploadThenSendDelivery {
  mode: 'upload_then_send';
  upload(
    context: ChannelDeliveryOperationContext,
  ): Promise<{ providerUploadKey: string }>;
  sendUploaded(
    context: ChannelDeliveryOperationContext & { providerUploadKey: string },
  ): Promise<{ providerMessageId: string }>;
}

export type ChannelPhysicalDelivery =
  | ChannelSingleStageDelivery
  | ChannelUploadThenSendDelivery;

export type ChannelDeliveryPersistedPhase =
  | 'claimed'
  | 'uploading'
  | 'uploaded'
  | 'sending'
  | 'delivered';

/**
 * Fault-injection-only signal that emulates an immediate process death.
 * The helper intentionally leaves the current fenced lease untouched so a
 * startup reconciliation test observes the same durable state as SIGKILL.
 */
export class ChannelDeliveryProcessCrash extends Error {
  constructor(message = 'Simulated channel delivery process crash') {
    super(message);
    this.name = 'ChannelDeliveryProcessCrash';
  }
}

/**
 * A provider explicitly rejected the operation, so it is known not to have
 * produced a visible message. Ordinary errors after `sending` are ambiguous
 * and are always fenced as `uncertain` instead.
 */
export class DefinitiveChannelDeliveryError extends Error {
  readonly code = 'CHANNEL_DELIVERY_REJECTED';
  readonly retryAt?: string;

  constructor(
    message: string,
    options: { retryAt?: string; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DefinitiveChannelDeliveryError';
    this.retryAt = options.retryAt;
  }
}

export interface DeliverChannelOutboxInput extends ChannelRouteSnapshot {
  turnRunId: string;
  ordinal: number;
  kind: ChannelOutboxKind;
  payload: unknown;
  idempotencyKey?: string;
  owner: string;
  leaseMs?: number;
  availableAt?: string;
  delivery: ChannelPhysicalDelivery;
  signal?: AbortSignal;
  /** Inject a monotonic/test clock; production callers normally omit it. */
  now?: () => Date | string;
  /** Fault-injection hook. Production callers should not set this. */
  afterPersist?: (
    phase: ChannelDeliveryPersistedPhase,
    item: ChannelOutboxItem,
  ) => void | Promise<void>;
}

export type ChannelOutboxDeliveryOutcome =
  | 'delivered'
  | 'uncertain'
  | 'failed'
  | 'retry_wait'
  | 'busy'
  | 'cancelled'
  | 'lease_lost';

export interface ChannelOutboxDeliveryResult {
  itemId: string;
  status: ChannelOutboxDeliveryOutcome;
  receipt?: ChannelDeliveryReceipt;
  error?: string;
  /** True when an earlier physical delivery receipt was reused. */
  reused: boolean;
  attempt: number;
}

function nowValue(input: DeliverChannelOutboxInput): Date | string {
  return input.now?.() ?? new Date();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireNonEmptyReceipt(
  value: unknown,
  field: string,
  definitiveWhenMissing: boolean,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    const message = `Provider returned an empty ${field}`;
    if (definitiveWhenMissing) {
      throw new DefinitiveChannelDeliveryError(message);
    }
    // The visible send may already have succeeded. Without a message receipt
    // it is unsafe to classify this as an explicit provider rejection.
    throw new Error(message);
  }
  return value.trim();
}

function resultFromItem(
  item: ChannelOutboxItem,
  reused: boolean,
): ChannelOutboxDeliveryResult {
  switch (item.status) {
    case 'delivered':
      return {
        itemId: item.id,
        status: 'delivered',
        receipt: {
          providerMessageId: item.providerMessageId ?? '',
          providerUploadKey: item.providerUploadKey,
        },
        reused,
        attempt: item.attempt,
      };
    case 'uncertain':
      return {
        itemId: item.id,
        status: 'uncertain',
        error:
          item.error ??
          'Previous provider delivery outcome is uncertain; automatic replay is blocked',
        reused,
        attempt: item.attempt,
      };
    case 'failed':
      return {
        itemId: item.id,
        status: 'failed',
        error: item.error ?? 'Channel delivery failed',
        reused,
        attempt: item.attempt,
      };
    case 'cancelled':
      return {
        itemId: item.id,
        status: 'cancelled',
        error: item.error ?? 'Channel delivery was cancelled',
        reused,
        attempt: item.attempt,
      };
    case 'retry_wait':
      return {
        itemId: item.id,
        status: 'retry_wait',
        error: item.error ?? undefined,
        reused,
        attempt: item.attempt,
      };
    default:
      return {
        itemId: item.id,
        status: 'busy',
        error: `Channel delivery is already ${item.status}`,
        reused,
        attempt: item.attempt,
      };
  }
}

async function notifyPersisted(
  input: DeliverChannelOutboxInput,
  phase: ChannelDeliveryPersistedPhase,
  itemId: string,
): Promise<void> {
  if (!input.afterPersist) return;
  const item = getChannelOutboxItem(itemId);
  if (!item)
    throw new Error(`Outbox item disappeared after ${phase}: ${itemId}`);
  await input.afterPersist(phase, item);
}

function leaseLost(
  itemId: string,
  fallbackAttempt: number,
): ChannelOutboxDeliveryResult {
  const current = getChannelOutboxItem(itemId);
  if (current?.status === 'delivered' || current?.status === 'uncertain') {
    return resultFromItem(current, current.status === 'delivered');
  }
  return {
    itemId,
    status: 'lease_lost',
    error:
      'Channel delivery lease was lost before the receipt could be persisted',
    reused: false,
    attempt: current?.attempt ?? fallbackAttempt,
  };
}

/**
 * Persist and execute one physical channel output (one text/card/image/file).
 *
 * The durable row is the idempotency boundary. This function never auto-sends
 * an `uncertain` row and immediately returns an existing `delivered` receipt.
 */
export async function deliverChannelOutboxItem(
  input: DeliverChannelOutboxInput,
): Promise<ChannelOutboxDeliveryResult> {
  if (
    input.delivery.mode === 'upload_then_send' &&
    input.kind !== 'image' &&
    input.kind !== 'file'
  ) {
    throw new Error(
      'upload_then_send is only valid for image/file outbox items',
    );
  }
  const uncertainSibling = getUncertainChannelOutboxForTurn(input.turnRunId);
  if (uncertainSibling) {
    // This also handles a retry of the same semantic row. Never enqueue or
    // physically send a sibling until the uncertain provider effect has been
    // reconciled by an operator.
    return resultFromItem(
      uncertainSibling,
      uncertainSibling.idempotencyKey === input.idempotencyKey,
    );
  }
  const enqueued = enqueueChannelOutbox({
    provider: input.provider,
    accountId: input.accountId,
    sourceJid: input.sourceJid,
    chatId: input.chatId,
    rootId: input.rootId,
    threadId: input.threadId,
    turnRunId: input.turnRunId,
    ordinal: input.ordinal,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    availableAt: input.availableAt,
    now: nowValue(input),
  });
  if (
    enqueued.item.status === 'delivered' ||
    enqueued.item.status === 'uncertain' ||
    enqueued.item.status === 'failed' ||
    enqueued.item.status === 'cancelled'
  ) {
    return resultFromItem(enqueued.item, enqueued.item.status === 'delivered');
  }

  const claim = claimChannelOutboxById(
    enqueued.item.id,
    input.owner,
    input.leaseMs ?? 60_000,
    nowValue(input),
  );
  if (!claim) {
    const current = getChannelOutboxItem(enqueued.item.id);
    return current
      ? resultFromItem(current, current.status === 'delivered')
      : {
          itemId: enqueued.item.id,
          status: 'lease_lost',
          error: 'Outbox item disappeared before claim',
          reused: false,
          attempt: enqueued.item.attempt,
        };
  }

  await notifyPersisted(input, 'claimed', claim.id);

  try {
    let uploadKey = claim.providerUploadKey;
    if (input.delivery.mode === 'upload_then_send' && !uploadKey) {
      if (!markChannelOutboxUploading(claim, nowValue(input))) {
        return leaseLost(claim.id, claim.attempt);
      }
      await notifyPersisted(input, 'uploading', claim.id);
      const uploaded = await input.delivery.upload({
        item: getChannelOutboxItem(claim.id) ?? claim,
        payload: input.payload,
        signal: input.signal,
      });
      uploadKey = requireNonEmptyReceipt(
        uploaded.providerUploadKey,
        'providerUploadKey',
        true,
      );
      if (!markChannelOutboxUploaded(claim, uploadKey, nowValue(input))) {
        return leaseLost(claim.id, claim.attempt);
      }
      await notifyPersisted(input, 'uploaded', claim.id);
    }

    if (!markChannelOutboxSending(claim, nowValue(input))) {
      return leaseLost(claim.id, claim.attempt);
    }
    await notifyPersisted(input, 'sending', claim.id);

    const sent =
      input.delivery.mode === 'upload_then_send'
        ? await input.delivery.sendUploaded({
            item: getChannelOutboxItem(claim.id) ?? claim,
            payload: input.payload,
            providerUploadKey: uploadKey!,
            signal: input.signal,
          })
        : await input.delivery.send({
            item: getChannelOutboxItem(claim.id) ?? claim,
            payload: input.payload,
            signal: input.signal,
          });
    const providerMessageId = requireNonEmptyReceipt(
      sent.providerMessageId,
      'providerMessageId',
      false,
    );
    if (
      !completeChannelOutbox(claim, {
        providerMessageId,
        now: nowValue(input),
      })
    ) {
      return leaseLost(claim.id, claim.attempt);
    }
    await notifyPersisted(input, 'delivered', claim.id);
    const delivered = getChannelOutboxItem(claim.id)!;
    return {
      itemId: delivered.id,
      status: 'delivered',
      receipt: {
        providerMessageId,
        providerUploadKey: delivered.providerUploadKey,
      },
      reused: false,
      attempt: delivered.attempt,
    };
  } catch (error) {
    if (error instanceof ChannelDeliveryProcessCrash) throw error;
    const current = getChannelOutboxItem(claim.id);
    if (!current) return leaseLost(claim.id, claim.attempt);

    // Once sending started, an ordinary timeout/disconnect cannot prove that
    // the provider rejected the message. Only an explicit rejection is safe
    // to retry/fail without creating duplicate visible output.
    const explicitlyRejected = error instanceof DefinitiveChannelDeliveryError;
    const uncertain = current.status === 'sending' && !explicitlyRejected;
    const retryAt = explicitlyRejected ? error.retryAt : undefined;
    const persisted = failChannelOutbox(claim, {
      error: errorMessage(error),
      retryAt,
      uncertain,
      now: nowValue(input),
    });
    if (!persisted) return leaseLost(claim.id, claim.attempt);
    const failed = getChannelOutboxItem(claim.id)!;
    return resultFromItem(failed, false);
  }
}

/** Run once after transports connect and before new outbox workers start. */
export function reconcileChannelOutboxDeliveries(now?: Date | string): {
  retryable: number;
  uncertain: number;
} {
  return reconcileExpiredChannelOutbox(now);
}
