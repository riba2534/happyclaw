import {
  DefinitiveChannelDeliveryError,
  deliverChannelOutboxItem,
  type ChannelDeliveryPersistedPhase,
  type ChannelOutboxDeliveryResult,
} from './channel-outbox-delivery.js';
import {
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  syntheticChannelProviderAck,
} from './channel-outbox-runtime-scope.js';
import {
  channelPayloadHash,
  type ChannelOutboxItem,
  type ChannelRouteSnapshot,
} from './channel-reliability-store.js';
import type {
  FeishuCapabilityRequest,
  FeishuCapabilityResult,
} from './feishu-capability.js';
import { DefinitiveFeishuCapabilityError } from './feishu-capability.js';

export interface DeliverFeishuCapabilityMutationInput extends ChannelRouteSnapshot {
  turnRunId: string;
  requestId?: string;
  request: FeishuCapabilityRequest;
  owner: string;
  execute(): Promise<FeishuCapabilityResult>;
  leaseMs?: number;
  now?: () => Date | string;
  afterPersist?: (
    phase: ChannelDeliveryPersistedPhase,
    item: ChannelOutboxItem,
  ) => void | Promise<void>;
}

export interface FeishuCapabilityMutationDelivery {
  delivery: ChannelOutboxDeliveryResult;
  /** Present only when this process performed the physical provider call. */
  result?: FeishuCapabilityResult;
}

/**
 * One Feishu mutation equals one semantic Outbox row. requestId is accepted
 * for tracing only and deliberately excluded from the identity: runner/model
 * retries allocate a fresh UUID and must not repeat the provider operation.
 */
export async function deliverFeishuCapabilityMutation(
  input: DeliverFeishuCapabilityMutationInput,
): Promise<FeishuCapabilityMutationDelivery> {
  const payload = {
    operation: input.request.operation,
    params: input.request.params ?? {},
  };
  const identity = semanticChannelOutboxIdentity({
    route: input,
    kind: 'mutation',
    payload,
  });
  const ordinal = stableChannelOutboxOrdinal(identity);
  let providerResult: FeishuCapabilityResult | undefined;
  const delivery = await deliverChannelOutboxItem({
    provider: input.provider,
    accountId: input.accountId,
    sourceJid: input.sourceJid,
    chatId: input.chatId,
    rootId: input.rootId,
    threadId: input.threadId,
    turnRunId: input.turnRunId,
    ordinal,
    kind: 'mutation',
    payload,
    idempotencyKey: `${input.turnRunId}:${identity}`,
    owner: input.owner,
    leaseMs: input.leaseMs,
    now: input.now,
    afterPersist: input.afterPersist,
    delivery: {
      mode: 'single',
      send: async () => {
        try {
          providerResult = await input.execute();
        } catch (error) {
          if (error instanceof DefinitiveFeishuCapabilityError) {
            throw new DefinitiveChannelDeliveryError(error.message, {
              cause: error,
            });
          }
          throw error;
        }
        return {
          // Legacy connector APIs do not expose a uniform mutation receipt.
          // Persist a deterministic ACK only after the operation returned
          // successfully; an exception after `sending` remains uncertain.
          providerMessageId: syntheticChannelProviderAck({
            turnRunId: input.turnRunId,
            ordinal,
            payloadHash: channelPayloadHash({ payload, providerResult }),
          }),
        };
      },
    },
  });
  return { delivery, result: providerResult };
}
