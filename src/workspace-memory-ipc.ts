import {
  isOwnerProfileOwnerInput,
  OWNER_PROFILE_TRUSTED_CLAIM_SOURCES,
  type AgentBuilderPersistedInput,
} from './agent-builder-turn-auth.js';
import type { WorkspaceMemoryActor } from './memory-service.js';
import {
  classifyWorkspaceTurnPrincipal,
  type WorkspaceDelegateContext,
  type WorkspaceTurnPrincipal,
} from './workspace-delegate-auth.js';
import type { WorkspaceMemorySourceType } from './memory-store.js';

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
 * The IM ids the workspace's own registrations on `provider` vouch for as
 * the owner: chats the owner registered whose owner was recorded by the host
 * (configured, a trusted direct chat, or the Feishu API), never by a claim
 * any group member could make.
 */
interface WorkspaceRegistration {
  created_by?: string;
  owner_im_id?: string;
  owner_claim_source?: string;
}

interface WorkspaceOwnerLookup {
  ownerUserId: string;
  /** Every chat JID registered to the workspace folder. */
  workspaceJids: readonly string[];
  channelType: (jid: string) => string | null;
  registration: (jid: string) => WorkspaceRegistration | undefined;
}

export function workspaceOwnerImIds(
  input: WorkspaceOwnerLookup & { provider: string },
): string[] {
  const ids = new Set<string>();
  for (const jid of input.workspaceJids) {
    if (input.channelType(jid) !== input.provider) continue;
    const row = input.registration(jid);
    if (
      row?.created_by === input.ownerUserId &&
      row.owner_im_id &&
      row.owner_claim_source &&
      OWNER_PROFILE_TRUSTED_CLAIM_SOURCES.includes(row.owner_claim_source)
    ) {
      ids.add(row.owner_im_id);
    }
  }
  return [...ids];
}

/**
 * Whether the active batch is the owner's alone: `requireActiveOwnerTurn`
 * throws unless every input in it is a human message `isOwnerInput` accepts.
 * A Web input is the owner's by user id; an IM input by the sender's IM id.
 * Such a turn (or one of the owner's delegate, see workspaceTurnPrincipal)
 * writes memory directly; any other turn (a group member's, a batch with
 * anyone else in it, an automation run) only proposes, and the owner confirms
 * or rejects the proposal on the Memory page.
 */
export function isWorkspaceMemoryOwnerTurn(
  input: WorkspaceOwnerLookup & {
    requireActiveOwnerTurn: (
      isOwnerInput: (persisted: AgentBuilderPersistedInput) => boolean,
    ) => unknown;
  },
): boolean {
  try {
    input.requireActiveOwnerTurn((persisted) =>
      isOwnerProfileOwnerInput(
        persisted,
        input.ownerUserId,
        input.registration,
        (provider) => workspaceOwnerImIds({ ...input, provider }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Like {@link isWorkspaceMemoryOwnerTurn}, but also recognises a turn of the
 * workspace's delegate (see workspace-delegate-auth.ts). Only Workspace
 * Memory and automations use this; owner-only capabilities must keep using
 * {@link isWorkspaceMemoryOwnerTurn}.
 */
export function workspaceTurnPrincipal(
  input: WorkspaceOwnerLookup & {
    delegate: Omit<WorkspaceDelegateContext, 'ownerUserId'>;
    requireTurn: (
      predicate: (persisted: AgentBuilderPersistedInput) => boolean,
    ) => unknown;
  },
): WorkspaceTurnPrincipal {
  return classifyWorkspaceTurnPrincipal({
    isOwnerInput: (persisted) =>
      isOwnerProfileOwnerInput(
        persisted,
        input.ownerUserId,
        input.registration,
        (provider) => workspaceOwnerImIds({ ...input, provider }),
      ),
    delegate: { ...input.delegate, ownerUserId: input.ownerUserId },
    requireTurn: input.requireTurn,
  });
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
