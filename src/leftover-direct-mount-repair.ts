import fs from 'node:fs';
import path from 'node:path';

import { channelConversationJid } from './channel-address.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import {
  executeRepairLeftoverDirectMount,
  resolveWorkspaceJid,
} from './channel-mount-service.js';
import {
  CURRENT_SCHEMA_VERSION,
  countRecoverableInboundMessagesFromSources,
  getAgent,
  getAllRegisteredGroups,
  getConversationHistoryIsolationMarker,
  getJidsByFolder,
  getRegisteredGroup,
  getRouterState,
  getSession,
  getSessionChannelOwner,
  getWorkspaceRuntimeSession,
  listRecoverableInboundSourceJids,
  resetWorkspaceMainIsolationGeneration,
  runImmediateTransaction,
} from './db.js';
import { DATA_DIR } from './config.js';
import {
  findWhatsAppAliasRoutingConflicts,
  sourceMatchesChannelConversation,
  type AffectedLeftoverWorkspace,
  type LeftoverDirectMountDiagnosis,
  type LeftoverDirectWorkspaceMount,
} from './leftover-direct-mount-diagnostic.js';
import type { RegisteredGroup, SubAgent } from './types.js';

export type {
  AffectedLeftoverWorkspace,
  LeftoverDirectAliasConflict,
  LeftoverDirectMountDiagnosis,
  LeftoverDirectWorkspaceMount,
} from './leftover-direct-mount-diagnostic.js';

export interface LeftoverDirectMountRepairResult extends LeftoverDirectMountDiagnosis {
  applied: boolean;
  remounted: number;
  isolationGenerationsReset: number;
  isolationMarkers: Record<string, string>;
}

function conversationAliases(jid: string): Set<string> {
  return new Set([jid, channelConversationJid(jid)]);
}

function sourceMatchesConversation(
  sourceJid: string,
  conversationJid: string,
): boolean {
  return sourceMatchesChannelConversation(sourceJid, conversationJid);
}

function resolveMountedWorkspace(
  targetMainJid: string | undefined,
): { workspaceJid: string; workspace: RegisteredGroup } | null {
  const workspaceJid = resolveWorkspaceJid(targetMainJid, {
    getRegisteredGroup,
    getJidsByFolder,
  });
  if (!workspaceJid) return null;
  const workspace = getRegisteredGroup(workspaceJid);
  if (!workspace) return null;
  return { workspaceJid, workspace };
}

function countRecoverableInboundFromChat(
  workspaceJid: string,
  channelJid: string,
): number {
  const knownSources = listRecoverableInboundSourceJids(workspaceJid).filter(
    (sourceJid) => sourceMatchesConversation(sourceJid, channelJid),
  );
  return countRecoverableInboundMessagesFromSources(workspaceJid, [
    ...conversationAliases(channelJid),
    ...knownSources,
  ]);
}

function countRecoverableInboundFromChats(
  workspaceJid: string,
  channelJids: readonly string[],
): number {
  const knownSources = listRecoverableInboundSourceJids(workspaceJid).filter(
    (sourceJid) =>
      channelJids.some((channelJid) =>
        sourceMatchesConversation(sourceJid, channelJid),
      ),
  );
  return countRecoverableInboundMessagesFromSources(workspaceJid, [
    ...channelJids.flatMap((channelJid) => [
      ...conversationAliases(channelJid),
    ]),
    ...knownSources,
  ]);
}

/**
 * JID-classifiable DMs still bound to workspace main. Feishu stays unknown
 * without metadata and is never selected — that path remains auto_im.
 */
export function findLeftoverClassifiableDirectWorkspaceMounts(): LeftoverDirectWorkspaceMount[] {
  const leftovers: LeftoverDirectWorkspaceMount[] = [];

  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (resolveChannelConversationKind(jid) !== 'direct') continue;
    if (!group.target_main_jid || group.target_agent_id) continue;

    const mounted = resolveMountedWorkspace(group.target_main_jid);
    if (!mounted) continue;

    const mainOwnerJid = getSessionChannelOwner(mounted.workspace.folder, null);
    leftovers.push({
      channelJid: jid,
      workspaceJid: mounted.workspaceJid,
      workspaceFolder: mounted.workspace.folder,
      channelAccountId: group.channel_account_id,
      mainOwnerJid,
      mainOwnerIsThisChat: Boolean(
        mainOwnerJid && sourceMatchesConversation(mainOwnerJid, jid),
      ),
      mainSessionId: getSession(mounted.workspace.folder),
      existingIsolationMarker: getConversationHistoryIsolationMarker(
        mounted.workspaceJid,
      ),
      recoverableInboundFromThisChat: countRecoverableInboundFromChat(
        mounted.workspaceJid,
        jid,
      ),
    });
  }

  return leftovers;
}

export function diagnoseLeftoverClassifiableDirectWorkspaceMounts(): LeftoverDirectMountDiagnosis {
  const leftovers = findLeftoverClassifiableDirectWorkspaceMounts();
  const aliasConflicts = findWhatsAppAliasRoutingConflicts(
    getAllRegisteredGroups(),
  );
  const byWorkspace = new Map<string, LeftoverDirectWorkspaceMount[]>();
  for (const leftover of leftovers) {
    const bucket = byWorkspace.get(leftover.workspaceJid) ?? [];
    bucket.push(leftover);
    byWorkspace.set(leftover.workspaceJid, bucket);
  }

  const affectedWorkspaces: AffectedLeftoverWorkspace[] = [];
  for (const [workspaceJid, mounts] of byWorkspace) {
    const folder = mounts[0]!.workspaceFolder;
    affectedWorkspaces.push({
      workspaceJid,
      workspaceFolder: folder,
      leftoverCount: mounts.length,
      existingIsolationMarker:
        getConversationHistoryIsolationMarker(workspaceJid),
      mainSessionId: getSession(folder),
      mainRuntimeSessionId: getWorkspaceRuntimeSession(folder)?.sdk_session_id,
      mainOwnerJid: getSessionChannelOwner(folder, null),
      recoverableInboundFromLeftovers: countRecoverableInboundFromChats(
        workspaceJid,
        mounts.map((mount) => mount.channelJid),
      ),
    });
  }

  return {
    schemaVersion:
      getRouterState('schema_version') ?? String(CURRENT_SCHEMA_VERSION),
    leftovers,
    affectedWorkspaces,
    aliasConflicts,
  };
}

function remountLeftoverDirect(
  leftover: LeftoverDirectWorkspaceMount,
  onCreating: (agent: SubAgent, workspaceJid: string) => void,
): void {
  const group = getRegisteredGroup(leftover.channelJid);
  const workspace = getRegisteredGroup(leftover.workspaceJid);
  if (!group || !workspace) {
    throw new Error(
      `Leftover direct mount disappeared during repair: ${leftover.channelJid}`,
    );
  }

  executeRepairLeftoverDirectMount({
    channelJid: leftover.channelJid,
    group,
    workspaceJid: leftover.workspaceJid,
    workspaceFolder: leftover.workspaceFolder,
    userId: group.created_by ?? workspace.created_by ?? '',
    onCreating,
  });
}

/**
 * Remount leftover JID-classifiable DMs onto `channel_direct` and reset every
 * affected workspace's recovery/isolation state with a new generation.
 *
 * Dry-run is the default. This is not a schema migration and must not bump
 * CURRENT_SCHEMA_VERSION. A previous isolation marker is not treated as
 * success: leaked post-marker main rows and a contaminated main session stay
 * recoverable unless a new generation fences them together.
 */
export function repairLeftoverClassifiableDirectWorkspaceMounts(
  options: {
    apply?: boolean;
    isolationStartedAt?: string;
    /** Fault-injection/embedding hook; runs inside the DB transaction. */
    beforeIsolationReset?: () => void;
    /** Test/embedding override for rollback compensation ownership checks. */
    cleanupAgentLookup?: typeof getAgent;
  } = {},
): LeftoverDirectMountRepairResult {
  const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
  if (options.apply && diagnosis.aliasConflicts.length > 0) {
    throw new Error(
      `Conflicting WhatsApp aliases require manual unbind before repair: ${diagnosis.aliasConflicts
        .map(
          (conflict) =>
            `${conflict.canonicalJid} [${conflict.aliases.join(', ')}]`,
        )
        .join('; ')}`,
    );
  }
  if (!options.apply || diagnosis.leftovers.length === 0) {
    return {
      ...diagnosis,
      applied: false,
      remounted: 0,
      isolationGenerationsReset: 0,
      isolationMarkers: {},
    };
  }

  const isolationStartedAt =
    options.isolationStartedAt ?? new Date().toISOString();
  const createdAgents: Array<{ folder: string; id: string }> = [];
  try {
    return runImmediateTransaction(() => {
      for (const leftover of diagnosis.leftovers) {
        remountLeftoverDirect(leftover, (agent) => {
          createdAgents.push({ folder: agent.group_folder, id: agent.id });
        });
      }

      options.beforeIsolationReset?.();

      const isolationMarkers: Record<string, string> = {};
      for (const workspace of diagnosis.affectedWorkspaces) {
        isolationMarkers[workspace.workspaceJid] =
          resetWorkspaceMainIsolationGeneration(
            workspace.workspaceJid,
            workspace.workspaceFolder,
            isolationStartedAt,
          );
      }

      const after = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
      if (after.leftovers.length > 0) {
        throw new Error(
          `Leftover direct mounts remain after repair: ${after.leftovers
            .map((item) => item.channelJid)
            .join(', ')}`,
        );
      }

      return {
        ...diagnosis,
        schemaVersion: after.schemaVersion,
        leftovers: [],
        affectedWorkspaces: diagnosis.affectedWorkspaces.map((workspace) => ({
          ...workspace,
          existingIsolationMarker: isolationMarkers[workspace.workspaceJid],
          mainSessionId: undefined,
          mainRuntimeSessionId: undefined,
          mainOwnerJid: undefined,
          recoverableInboundFromLeftovers: 0,
        })),
        applied: true,
        remounted: diagnosis.leftovers.length,
        isolationGenerationsReset: diagnosis.affectedWorkspaces.length,
        isolationMarkers,
      };
    });
  } catch (error) {
    const cleanupErrors: string[] = [];
    const originalError =
      error instanceof Error ? error.message : String(error);
    const lookupAgent = options.cleanupAgentLookup ?? getAgent;
    for (const created of createdAgents) {
      // A committed Agent owns these paths. Only compensate IDs absent after
      // the DB transaction rolled back; never touch reused or committed data.
      let agentStillCommitted: boolean;
      try {
        agentStillCommitted = Boolean(lookupAgent(created.id));
      } catch (lookupError) {
        // Do not guess ownership and delete this directory, but keep probing
        // and compensating every other Agent created by the failed repair.
        cleanupErrors.push(
          `${created.id}: could not determine whether Agent remains committed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
        );
        continue;
      }
      if (agentStillCommitted) continue;
      for (const directory of [
        path.join(DATA_DIR, 'ipc', created.folder, 'agents', created.id),
        path.join(DATA_DIR, 'sessions', created.folder, 'agents', created.id),
      ]) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(
            `${directory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Leftover direct mount repair failed (${originalError}) and could not fully clean newly created Agent directories: ${cleanupErrors.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}
