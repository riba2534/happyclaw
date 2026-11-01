import { channelTurnScope } from './channel-turn-registry.js';
import {
  ActiveTurnOutputRegistry,
  type StageTurnMessageResult,
  type TurnMessageDeliveryRole,
} from './turn-output-coordinator.js';

/**
 * What the Agent is told when an IM turn's progress is rejected for want of a
 * route: nothing was sent, and sending it again cannot help.
 */
export const NATIVE_ROUTE_UNAVAILABLE_ERROR =
  "Progress was not delivered: this turn's native channel route is unavailable. Do not retry it. End the turn, or send your final answer once with send_message(delivery_role=final); the final uses the same route, so if it fails as well, do not retry it either.";

/**
 * An IPC request file is disposable only after its result ACK is durable.
 * Legacy requests without requestId keep the fire-and-forget path.
 */
export function canDeleteAcknowledgedIpcSource(
  requestId: string | undefined,
  resultWritten: boolean,
): boolean {
  return !requestId || resultWritten;
}

export interface HostIpcOutputRouteInput {
  sourceGroup: string;
  agentId?: string | null;
  inputTurnId?: unknown;
  text: string;
  deliveryRole?: unknown;
  authorized: boolean;
  interactionMode?: 'assistant' | 'proactive';
  /**
   * The channel the input turn came from (recorded when its turn was bound):
   * `im` when it has a native reply source, `web` when it has none. Unknown
   * (no inputTurnId, or no bound turn) keeps the independent message lane a
   * proactive progress statement always had.
   */
  turnSource?: 'web' | 'im';
  /** An IM turn's own reply route is open (its outbox scope is bound). */
  imRouteAvailable?: boolean;
}

/**
 * Resolve the logical chat JID an IPC output should be persisted and broadcast
 * under.
 *
 * `sourceChatJid` is the runner's `channelContext.sourceJid`, i.e. the raw IM
 * JID (`qq:c2c:...`). Inbound routing already folds that JID to the bound
 * workspace before the turn runs, so without the symmetric fold here a
 * proactive `send_message` would be stored against the IM row — whose
 * `folder`/`created_by` still belong to the channel account owner, not to the
 * workspace that produced the reply. `resolveWorkspaceJid` supplies that fold;
 * when it is absent or returns null the raw JID is kept, preserving behaviour
 * for unbound chats.
 */
export function resolveHostIpcLogicalChatJid(input: {
  sourceChatJid: string;
  agentId?: string | null;
  agentChatJid?: string | null;
  resolveWorkspaceJid?: (chatJid: string) => string | null;
}): string {
  const baseChatJid =
    input.resolveWorkspaceJid?.(input.sourceChatJid) || input.sourceChatJid;
  if (input.agentId) {
    return `${input.agentChatJid || baseChatJid}#agent:${input.agentId}`;
  }
  return baseChatJid;
}

export type HostIpcOutputRoute =
  | {
      path: 'primary_projection';
      delivered: boolean;
      staged: boolean;
      disposition?: 'staged_progress' | 'staged_final';
      deliveryRole: 'progress' | 'final';
      stageResult: StageTurnMessageResult;
    }
  | {
      path: 'separate_provider';
      delivered: false;
      staged: false;
      deliveryRole: TurnMessageDeliveryRole | null;
      attemptedFinalRecorded: boolean;
    }
  | {
      path: 'rejected';
      delivered: false;
      staged: false;
      deliveryRole: TurnMessageDeliveryRole | null;
      reason: 'unauthorized' | 'conflicting_final' | 'native_route_unavailable';
    };

function normalizeDeliveryRole(value: unknown): TurnMessageDeliveryRole | null {
  return value === 'progress' || value === 'final' || value === 'separate'
    ? value
    : null;
}

/**
 * Selects the host-side delivery lane for one send_message IPC request.
 *
 * An explicit progress/final request is consumed by the exact active primary
 * turn, including conversation agents. Even a failed stage attempt is still
 * consumed so it cannot fall through and create a second provider message.
 * Legacy requests and explicit `separate` keep their independent delivery
 * path.
 *
 * A proactive turn's final is always its own message. Its progress depends on
 * where the turn came from: a Web turn stages it into the turn's process,
 * which the Web shows at every process visibility and folds away once the
 * final lands; an IM turn sends it as a message of its own, because a channel
 * cannot fold anything and the user would otherwise hear nothing until the
 * final. An IM turn whose route is gone (a recalled input, an address without
 * its account) fails closed: the Agent is told nothing was delivered, and
 * nothing goes to the Web in its place.
 */
export function routeHostIpcOutput(
  input: HostIpcOutputRouteInput,
  activeTurnOutputs: ActiveTurnOutputRegistry,
): HostIpcOutputRoute {
  const deliveryRole = normalizeDeliveryRole(input.deliveryRole);
  if (!input.authorized) {
    return {
      path: 'rejected',
      delivered: false,
      staged: false,
      deliveryRole,
      reason: 'unauthorized',
    };
  }
  if (deliveryRole === null || deliveryRole === 'separate') {
    return {
      path: 'separate_provider',
      delivered: false,
      staged: false,
      deliveryRole,
      attemptedFinalRecorded: false,
    };
  }

  if (input.interactionMode === 'proactive' && deliveryRole === 'final') {
    let attemptedFinalRecorded = false;
    if (typeof input.inputTurnId === 'string' && input.inputTurnId) {
      attemptedFinalRecorded = activeTurnOutputs.recordAttemptedFinal({
        scopeKey: channelTurnScope(input.sourceGroup, input.agentId),
        inputTurnId: input.inputTurnId,
        text: input.text,
      });
      if (!attemptedFinalRecorded) {
        // The first explicit final seals the physical provider lane. Returning
        // a rejected route is essential: merely recording `false` while still
        // selecting separate_provider allowed a second, different final to be
        // irreversibly sent.
        return {
          path: 'rejected',
          delivered: false,
          staged: false,
          deliveryRole,
          reason: 'conflicting_final',
        };
      }
    }
    return {
      path: 'separate_provider',
      delivered: false,
      staged: false,
      deliveryRole,
      attemptedFinalRecorded,
    };
  }

  if (input.interactionMode === 'proactive' && input.turnSource !== 'web') {
    if (input.turnSource === 'im' && !input.imRouteAvailable) {
      return {
        path: 'rejected',
        delivered: false,
        staged: false,
        deliveryRole,
        reason: 'native_route_unavailable',
      };
    }
    return {
      path: 'separate_provider',
      delivered: false,
      staged: false,
      deliveryRole,
      attemptedFinalRecorded: false,
    };
  }

  const stageResult =
    typeof input.inputTurnId === 'string' && input.inputTurnId
      ? activeTurnOutputs.stage({
          scopeKey: channelTurnScope(input.sourceGroup, input.agentId),
          inputTurnId: input.inputTurnId,
          role: deliveryRole,
          text: input.text,
        })
      : {
          accepted: false,
          duplicate: false,
          reason: 'inactive_turn' as const,
        };

  return {
    path: 'primary_projection',
    delivered: stageResult.accepted,
    staged: stageResult.accepted,
    disposition: stageResult.accepted
      ? deliveryRole === 'progress'
        ? 'staged_progress'
        : 'staged_final'
      : undefined,
    deliveryRole,
    stageResult,
  };
}
