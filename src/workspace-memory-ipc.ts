import type { AgentBuilderPersistedInput } from './agent-builder-turn-auth.js';
import type { WorkspaceMemoryActor } from './memory-service.js';
import type { WorkspaceMemorySourceType } from './memory-store.js';
import {
  isWorkspaceOwnerInput,
  type WorkspaceOwnerIdentityLookup,
} from './workspace-owner-identity.js';

export type WorkspaceMemoryIpcOperation =
  | 'snapshot'
  | 'search'
  | 'get'
  | 'create'
  | 'update'
  | 'delete';

export interface WorkspaceMemoryAuthoritativePrincipal {
  actor: WorkspaceMemoryActor;
  workspaceJid: string;
  sourceType: WorkspaceMemorySourceType;
  provenance: {
    sourceId?: string | null;
    sessionId?: string | null;
    observedAt?: string | null;
  };
  /** The turn only proposes: it may revise proposals, nothing else. */
  proposal?: boolean;
}

const MUTATIONS = new Set<WorkspaceMemoryIpcOperation>([
  'create',
  'update',
  'delete',
]);

const UPDATE_FIELDS = [
  'kind',
  'title',
  'content',
  'canonicalKey',
  'status',
  'importance',
  'confidence',
  'validFrom',
  'validUntil',
  'expiresAt',
] as const;

export function isWorkspaceMemoryMutation(
  operation: string | undefined,
): boolean {
  return MUTATIONS.has(operation as WorkspaceMemoryIpcOperation);
}

/**
 * Whether the active batch is the owner's alone: `requireActiveOwnerTurn`
 * throws unless every input in it is a human message `isOwnerInput` accepts.
 * Who the owner is comes from {@link isWorkspaceOwnerInput}: a Web input by
 * user id, an IM input by the sender's IM id, whichever workspace the chat is
 * bound to. Only such a turn writes memory directly; any other turn (a group
 * member's, a batch with anyone but the owner in it, an automation run) only
 * proposes, and the owner confirms or rejects the proposal on the Memory page.
 */
export function isWorkspaceMemoryOwnerTurn(
  input: WorkspaceOwnerIdentityLookup & {
    requireActiveOwnerTurn: (
      isOwnerInput: (persisted: AgentBuilderPersistedInput) => boolean,
    ) => unknown;
  },
): boolean {
  try {
    input.requireActiveOwnerTurn((persisted) =>
      isWorkspaceOwnerInput(persisted, input),
    );
    return true;
  } catch {
    return false;
  }
}

export function workspaceMemoryWriteRejection(input: {
  operation: string | undefined;
  hostTurnKind: 'interactive' | 'automation' | 'unknown';
  runtimeAgentId: string | null;
  runtimeAgentKind: 'task' | 'conversation' | 'spawn' | null;
  capabilityValid: boolean;
}): { code: string; error: string } | null {
  if (!isWorkspaceMemoryMutation(input.operation)) {
    return null;
  }
  if (input.runtimeAgentId && input.runtimeAgentKind !== 'conversation') {
    return {
      code: 'runtime_agent_memory_read_only',
      error:
        'Spawned and task Agents have read-only Workspace Memory access; return candidate learnings to an interactive conversation session.',
    };
  }
  if (
    input.hostTurnKind !== 'interactive' &&
    input.hostTurnKind !== 'automation'
  ) {
    return {
      code: 'workspace_memory_no_active_turn',
      error: 'Workspace Memory mutations require a host-admitted active turn.',
    };
  }
  if (!input.capabilityValid) {
    return {
      code: 'workspace_memory_invalid_capability',
      error: 'Workspace Memory mutation authorization is missing or invalid.',
    };
  }
  return null;
}

/**
 * Build an update request without spreading attacker-controlled principal
 * fields. Authoritative fields are assigned last as a second line of defense.
 */
export function buildWorkspaceMemoryUpdateInput(
  untrusted: {
    itemId?: string;
    expectedRevision?: number;
    idempotencyKey?: string;
    patch?: Record<string, unknown>;
  },
  principal: WorkspaceMemoryAuthoritativePrincipal,
): Record<string, unknown> {
  const source = untrusted.patch ?? {};
  const patch = Object.fromEntries(
    UPDATE_FIELDS.filter(
      (key) =>
        Object.prototype.hasOwnProperty.call(source, key) &&
        source[key] !== undefined,
    ).map((key) => [key, source[key]]),
  );
  return {
    itemId: untrusted.itemId ?? '',
    expectedRevision: untrusted.expectedRevision ?? 0,
    idempotencyKey: untrusted.idempotencyKey,
    ...patch,
    actor: principal.actor,
    workspaceJid: principal.workspaceJid,
    sourceType: principal.sourceType,
    provenance: principal.provenance,
    proposal: principal.proposal === true,
  };
}
