import {
  deleteSession,
  deleteWorkspaceSessions,
  getAllUsers,
  getSession,
  listAgentProfilesForUser,
} from './db.js';
import {
  collectWorkspaceRuntimeJids,
  getWorkspaceRuntimeJids,
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  WorkspaceRuntimeQuiesceError,
  type WorkspaceRuntimeQuiesceTarget,
} from './agent-profile-runtime.js';
import {
  markFolderSessionsForHistoryReinjection,
  markSessionForHistoryReinjection,
} from './runtime-state-store.js';
import { logger } from './logger.js';
import { getWebDeps } from './web-context.js';

export type CapabilityMutationImpact =
  | {
      kind: 'skills';
      ownerUserId: string;
      /** Omit when a bulk operation may add/update more than one Skill. */
      ids?: string[];
    }
  | {
      kind: 'mcp';
      ownerUserId: string;
      scope: 'system' | 'user';
      /** Omit when a bulk import may add/update more than one MCP server. */
      ids?: string[];
    };

export class CapabilityRuntimeCommitError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly runtimeJids: string[],
  ) {
    super(
      'Capability mutation may have persisted; runtime cleanup is required',
    );
    this.name = 'CapabilityRuntimeCommitError';
  }
}

/** Response body for a runtime-quiesce or uncertain-commit failure, else null. */
export function capabilityRuntimeMutationFailure(
  error: unknown,
  action: string,
) {
  if (error instanceof WorkspaceRuntimeQuiesceError) {
    return {
      error: error.persisted
        ? `${action} was saved, but runtime cleanup failed; retry the request`
        : `Failed to stop affected workspaces; ${action} was not saved`,
      persisted: error.persisted,
      retryable: true,
    };
  }
  if (error instanceof CapabilityRuntimeCommitError) {
    return {
      error: `${action} has an uncertain commit outcome; retry the request to finish fail-closed cleanup`,
      persisted: 'unknown',
      retryable: true,
    };
  }
  return null;
}

function profileUsesCapability(
  profile: ReturnType<typeof listAgentProfilesForUser>[number],
  impact: CapabilityMutationImpact,
): boolean {
  const policy =
    impact.kind === 'skills'
      ? profile.runtime_policy.skills
      : profile.runtime_policy.mcp;
  if (policy.mode === 'disabled') return false;
  if (policy.mode === 'inherit') return true;
  if (!impact.ids || impact.ids.length === 0) return true;

  const ids = new Set(impact.ids);
  if (impact.kind === 'skills') {
    return policy.ids.some((id) => ids.has(id));
  }
  return policy.ids.some((reference) => {
    if (impact.scope === 'system') {
      return reference.startsWith('system:') && ids.has(reference.slice(7));
    }
    // Bare MCP ids are legacy user-scope references.
    return reference.startsWith('user:')
      ? ids.has(reference.slice(5))
      : !reference.startsWith('system:') && ids.has(reference);
  });
}

export function listCapabilityMutationRuntimeTargets(
  impact: CapabilityMutationImpact,
): WorkspaceRuntimeQuiesceTarget[] {
  const ownerIds =
    impact.kind === 'mcp' && impact.scope === 'system'
      ? getAllUsers()
          .filter((user) => user.status === 'active')
          .map((user) => user.id)
      : [impact.ownerUserId];
  const byFolder = new Map<string, WorkspaceRuntimeQuiesceTarget>();
  for (const ownerId of ownerIds) {
    for (const profile of listAgentProfilesForUser(ownerId)) {
      if (!profileUsesCapability(profile, impact)) continue;
      for (const workspace of listWorkspaceGroupsForAgentProfile(
        ownerId,
        profile.id,
      )) {
        if (!byFolder.has(workspace.group.folder)) {
          byFolder.set(workspace.group.folder, {
            folder: workspace.group.folder,
            primaryJid: workspace.jid,
          });
        }
      }
    }
  }
  return Array.from(byFolder.values());
}

/** Intro of the history re-injected into a session reset by this module. */
export const CAPABILITY_CHANGE_HISTORY_INTRO =
  '检测到当前 workspace 可用的 Skill / MCP 已更新，底层模型 session 已重置以加载新的能力。以下是 HappyClaw 保存的最近对话记录，供你延续上下文。';

/**
 * A capability change must start new SDK sessions, but the conversation
 * itself goes on: each session that had one is marked so its next turn
 * re-injects recent history, as an identity change does.
 */
function invalidateWorkspaceSessions(
  targets: WorkspaceRuntimeQuiesceTarget[],
): void {
  for (const target of targets) {
    try {
      markFolderSessionsForHistoryReinjection(target.folder);
    } catch (err) {
      // The hand-off is a courtesy; the reset itself must still happen.
      logger.warn(
        { err, folder: target.folder },
        'Failed to record the history hand-off for reset sessions',
      );
    }
    deleteWorkspaceSessions(target.folder);
  }
}

/**
 * A runner whose own tool call changed the capability set finished its turn
 * on the old set and, while doing so, saved its SDK session again. Once it has
 * closed, drop that session too so the next turn loads the new capabilities,
 * with the same history hand-off as the other sessions.
 */
export function invalidateSessionAfterRunnerExit(
  groupFolder: string,
  agentId: string,
): void {
  if (!getSession(groupFolder, agentId)) return;
  markSessionForHistoryReinjection(groupFolder, agentId);
  deleteSession(groupFolder, agentId);
}

/**
 * Stop every runner whose effective Agent policy can observe a managed
 * capability mutation. The capability commit and SDK-session invalidation run
 * under the queue mutation pause. Any uncertain/failed commit or post-commit
 * teardown installs the existing runtime-safety gate, so queued work cannot
 * restart with a stale MCP JSON/credential or Skill snapshot.
 */
export async function mutateCapabilityAroundRuntimeQuiesce<T>(
  impact: CapabilityMutationImpact,
  reason: string,
  commit: () => Promise<T> | T,
): Promise<{ value: T; invalidatedRuntimeJids: number }> {
  const deps = getWebDeps();
  // Route-level unit tests and early startup have no live queue/runners. Avoid
  // touching Agent/workspace DB projections before WebDeps is initialized.
  if (!deps) {
    return { value: await commit(), invalidatedRuntimeJids: 0 };
  }
  const targets = listCapabilityMutationRuntimeTargets(impact);
  if (targets.length === 0) {
    const value = await commit();
    invalidateWorkspaceSessions(targets);
    return { value, invalidatedRuntimeJids: 0 };
  }

  const knownRuntimeJids = collectWorkspaceRuntimeJids(deps, targets);
  try {
    const result = await quiesceWorkspaceRunnersAroundCommit(
      deps,
      targets,
      {
        reason,
        onPostCommitFailure: (runtimeJids) =>
          deps.queue.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `${reason}: post-commit runtime cleanup failed`,
          ),
      },
      async () => {
        try {
          const value = await commit();
          invalidateWorkspaceSessions(targets);
          return value;
        } catch (error) {
          // Filesystem-backed capability commits can fail after an atomic
          // rename has already made part of the new state visible. Treat the
          // outcome as uncertain and keep all affected work fail-closed until
          // a retry completes cleanup.
          deps.queue.blockGroupsForRuntimeSafety?.(
            knownRuntimeJids,
            `${reason}: capability commit outcome requires cleanup`,
          );
          throw new CapabilityRuntimeCommitError(error, knownRuntimeJids);
        }
      },
    );
    deps.queue.unblockGroupsForRuntimeSafety?.(result.runtimeJids);
    return {
      value: result.value,
      invalidatedRuntimeJids: result.runtimeJids.length,
    };
  } catch (error) {
    throw error;
  }
}

/** Repair a persistent runtime-safety gate left by a previous retryable call. */
export async function repairCapabilityRuntimeSafetyBlock(
  impact: CapabilityMutationImpact,
  reason: string,
): Promise<number> {
  const deps = getWebDeps();
  if (!deps) return 0;
  const targets = listCapabilityMutationRuntimeTargets(impact);
  const hasBlockedRuntime = targets.some((target) =>
    getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid).some(
      (jid) => deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false,
    ),
  );
  if (!hasBlockedRuntime) return 0;
  return (
    await mutateCapabilityAroundRuntimeQuiesce(
      impact,
      `${reason}: retrying pending runtime cleanup`,
      () => undefined,
    )
  ).invalidatedRuntimeJids;
}
