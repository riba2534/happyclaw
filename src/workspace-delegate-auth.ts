/**
 * Workspace delegates: the owner may trust the counterpart of one direct chat
 * bound to a session of their workspace (channel_mounts.delegate_enabled) to
 * manage that workspace's automations and write its Workspace Memory directly.
 *
 * A delegate is never the owner. Skill installs, Agent Builder, Owner Profile
 * and every other owner-turn check keep using the owner predicate alone; only
 * callers that explicitly ask for {@link classifyWorkspaceTurnPrincipal}
 * grant the delegate tier.
 *
 * Everything here is decided from host-persisted fields: the input's
 * source_jid and sender, and the mount row the owner toggled on the Web.
 */
import {
  ownerImIdFromDirectConversationJid,
  ownerImIdFromPersistedSender,
  type AgentBuilderPersistedInput,
} from './agent-builder-turn-auth.js';
import { channelConversationJid } from './channel-address.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';

/** The agent_channel_mounts fields the delegate rule reads. */
export interface WorkspaceDelegateMount {
  delegate_enabled?: boolean;
  workspace_folder: string | null;
  owner_user_id: string | null;
  session_id?: string | null;
  routing_mode?: string;
}

/**
 * A conversation the delegate switch may be turned on for: structurally a
 * direct chat whose single counterpart can be read from the JID itself.
 * Groups, topics and chats whose kind needs metadata (Feishu) never qualify.
 */
export function isDelegateCapableConversation(jid: string): boolean {
  const conversationJid = channelConversationJid(jid);
  return (
    resolveChannelConversationKind(conversationJid) === 'direct' &&
    ownerImIdFromDirectConversationJid(conversationJid) !== null
  );
}

export interface WorkspaceDelegateContext {
  /** The workspace owner's user id (registered_groups.created_by). */
  ownerUserId: string;
  /** Folder of the runner making the request (verified IPC namespace). */
  workspaceFolder: string;
  /** Runtime Session id of the runner, or null for the Main Session. */
  runtimeAgentId: string | null;
  /**
   * The workspace runs on the host. Host workspaces never have delegates,
   * even if a flag survived a switch to host mode.
   */
  hostWorkspace: boolean;
  /** agent_channel_mounts row by conversation JID. */
  getMount: (conversationJid: string) => WorkspaceDelegateMount | undefined;
}

/**
 * Whether one persisted input was spoken by the delegate of this workspace:
 * it came from a direct chat whose binding has the switch on, points at this
 * workspace and session of this owner, and its sender is that chat's own
 * counterpart. Automation and non-human checks are the turn registry's job.
 */
export function isWorkspaceDelegateInput(
  input: Pick<AgentBuilderPersistedInput, 'sender' | 'source_jid'>,
  context: WorkspaceDelegateContext,
): boolean {
  const sourceJid = input.source_jid;
  if (!sourceJid || sourceJid.startsWith('web:') || !input.sender) {
    return false;
  }
  if (context.hostWorkspace) return false;
  const conversationJid = channelConversationJid(sourceJid);
  if (!isDelegateCapableConversation(conversationJid)) return false;
  const mount = context.getMount(conversationJid);
  if (
    mount?.delegate_enabled !== true ||
    (mount.routing_mode !== undefined &&
      mount.routing_mode !== 'single_session') ||
    !context.ownerUserId ||
    mount.owner_user_id !== context.ownerUserId ||
    !context.workspaceFolder ||
    mount.workspace_folder !== context.workspaceFolder ||
    (mount.session_id ?? null) !== (context.runtimeAgentId ?? null)
  ) {
    return false;
  }
  const counterpart = ownerImIdFromDirectConversationJid(conversationJid);
  const sender = ownerImIdFromPersistedSender(sourceJid, input.sender);
  return !!counterpart && !!sender && counterpart === sender;
}

export type WorkspaceTurnPrincipal =
  | { kind: 'owner' }
  | { kind: 'delegate'; conversationJids: string[] }
  | { kind: 'other' };

/**
 * Classify the turn with the registry's own owner-turn gate, so stale,
 * queued, automation and non-human inputs are handled exactly as for the
 * owner: `requireTurn` throws unless every input it checks passes the
 * predicate. An owner-only batch is `owner`; a batch where every input is the
 * owner's or the delegate's (at least one delegate) is `delegate`, the weaker
 * of the two; anything else is `other`.
 */
export function classifyWorkspaceTurnPrincipal(input: {
  isOwnerInput: (persisted: AgentBuilderPersistedInput) => boolean;
  delegate: WorkspaceDelegateContext;
  requireTurn: (
    predicate: (persisted: AgentBuilderPersistedInput) => boolean,
  ) => unknown;
}): WorkspaceTurnPrincipal {
  try {
    input.requireTurn(input.isOwnerInput);
    return { kind: 'owner' };
  } catch {
    // Not the owner's alone; maybe the delegate's.
  }
  const conversationJids = new Set<string>();
  try {
    input.requireTurn((persisted) => {
      if (input.isOwnerInput(persisted)) return true;
      if (!isWorkspaceDelegateInput(persisted, input.delegate)) return false;
      conversationJids.add(channelConversationJid(persisted.source_jid!));
      return true;
    });
  } catch {
    return { kind: 'other' };
  }
  return conversationJids.size > 0
    ? { kind: 'delegate', conversationJids: [...conversationJids] }
    : { kind: 'other' };
}
