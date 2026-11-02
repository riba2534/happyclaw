import crypto from 'node:crypto';

import { parseChannelAddress } from './channel-address.js';
import {
  channelPayloadHash,
  type ChannelOutboxKind,
  type ChannelRouteSnapshot,
} from './channel-reliability-store.js';

export interface ActiveChannelOutboxScope extends ChannelRouteSnapshot {
  turnRunId: string;
  /** External input correlation id used by runner-side MCP output. */
  inputTurnId?: string;
  owner: string;
  token: string;
}

export type ActiveChannelOutboxScopeInput = Omit<
  ActiveChannelOutboxScope,
  'token'
>;

/**
 * Process-local bridge between a running Agent turn and its durable outbox.
 * The token makes cleanup compare-and-delete: a late finally from an older
 * turn can never remove a newer turn that reused the same runtime key.
 */
export class ActiveChannelOutboxScopeRegistry {
  private readonly scopes = new Map<
    string,
    Map<string, ActiveChannelOutboxScope>
  >();

  bind(
    key: string,
    input: ActiveChannelOutboxScopeInput,
  ): ActiveChannelOutboxScope {
    const scope = { ...input, token: crypto.randomUUID() };
    let bucket = this.scopes.get(key);
    if (!bucket) {
      bucket = new Map();
      this.scopes.set(key, bucket);
    }
    bucket.set(scope.token, scope);
    return scope;
  }

  resolve(key: string, targetJid: string): ActiveChannelOutboxScope | null {
    const bucket = this.scopes.get(key);
    if (!bucket) return null;
    const address = parseChannelAddress(targetJid);
    if (!address) return null;
    // Newest matching scope wins for the same exact route. Different native
    // threads remain simultaneously addressable inside one workspace key.
    const candidates = [...bucket.values()].reverse();
    for (const scope of candidates) {
      if (this.matchesRoute(scope, address)) return scope;
    }
    return null;
  }

  /** Resolve the immutable scope captured for one exact input turn. */
  resolveToken(
    key: string,
    token: string,
    targetJid: string,
  ): ActiveChannelOutboxScope | null {
    const scope = this.scopes.get(key)?.get(token);
    if (!scope) return null;
    const address = parseChannelAddress(targetJid);
    return address && this.matchesRoute(scope, address) ? scope : null;
  }

  /** Resolve the immutable scope captured for an IPC tool's input turn. */
  resolveInput(
    key: string,
    inputTurnId: string,
    targetJid: string,
  ): ActiveChannelOutboxScope | null {
    const bucket = this.scopes.get(key);
    if (!bucket) return null;
    const address = parseChannelAddress(targetJid);
    if (!address) return null;
    for (const scope of [...bucket.values()].reverse()) {
      if (
        scope.inputTurnId === inputTurnId &&
        this.matchesRoute(scope, address)
      ) {
        return scope;
      }
    }
    return null;
  }

  /** Resolve the route captured for the input, without consulting a later turn. */
  resolveInputScope(
    key: string,
    inputTurnId: string,
  ): ActiveChannelOutboxScope | null {
    const bucket = this.scopes.get(key);
    if (!bucket || !inputTurnId) return null;
    const matches = [...bucket.values()].filter(
      (scope) => scope.inputTurnId === inputTurnId,
    );
    const latest = matches[matches.length - 1];
    if (!latest) return null;
    // A legacy mirror scope must never become an input's reply recipient.
    if (
      matches.some(
        (scope) =>
          scope.provider !== latest.provider ||
          scope.accountId !== latest.accountId ||
          scope.sourceJid !== latest.sourceJid ||
          scope.chatId !== latest.chatId ||
          scope.rootId !== latest.rootId ||
          scope.threadId !== latest.threadId,
      )
    )
      return null;
    return latest;
  }

  unbind(key: string, expected: ActiveChannelOutboxScope | undefined): boolean {
    if (!expected) return false;
    const bucket = this.scopes.get(key);
    if (!bucket || bucket.get(expected.token)?.token !== expected.token) {
      return false;
    }
    const deleted = bucket.delete(expected.token);
    if (bucket.size === 0) this.scopes.delete(key);
    return deleted;
  }

  clear(): void {
    this.scopes.clear();
  }

  private matchesRoute(
    scope: ActiveChannelOutboxScope,
    address: NonNullable<ReturnType<typeof parseChannelAddress>>,
  ): boolean {
    if (address.provider !== scope.provider) return false;
    if (address.externalChatId !== scope.chatId) return false;
    if (
      address.channelAccountId &&
      address.channelAccountId !== scope.accountId
    ) {
      return false;
    }
    if ((address.threadId ?? null) !== (scope.threadId ?? null)) return false;
    if ((address.rootMessageId ?? null) !== (scope.rootId ?? null))
      return false;
    return true;
  }
}

/** Stable, positive SQLite-safe ordinal derived from the logical output. */
export function stableChannelOutboxOrdinal(operationKey: string): number {
  return Number.parseInt(
    crypto.createHash('sha256').update(operationKey).digest('hex').slice(0, 12),
    16,
  );
}

/**
 * A model/tool retry may allocate a fresh requestId, so transport idempotency
 * must be derived from the visible side effect rather than that invocation.
 * Callers may supply an explicit slot only when two identical payloads are
 * intentionally distinct outputs in the same turn.
 */
export function semanticChannelOutboxIdentity(input: {
  route: ChannelRouteSnapshot;
  kind: ChannelOutboxKind;
  payload: unknown;
  ordinalSlot?: string;
}): string {
  return [
    'channel-outbox-semantic-v1',
    input.route.provider,
    input.route.accountId,
    input.route.sourceJid,
    input.route.chatId ?? '',
    input.route.rootId ?? '',
    input.route.threadId ?? '',
    input.kind,
    input.ordinalSlot ?? '',
    channelPayloadHash(input.payload),
  ].join('\u0000');
}

/** Deterministic receipt for connectors whose legacy API returns void. */
export function syntheticChannelProviderAck(input: {
  turnRunId: string;
  ordinal: number;
  payloadHash: string;
}): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${input.turnRunId}:${input.ordinal}:${input.payloadHash}`)
    .digest('hex')
    .slice(0, 32);
  return `happyclaw-synthetic:${digest}`;
}
