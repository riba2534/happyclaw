import {
  deleteWorkspaceSessions,
  getAllUsers,
  getAllRegisteredGroups,
  listAgentProfilesForUser,
} from './db.js';
import {
  getWorkspaceRuntimeJids,
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  type WorkspaceRuntimeQuiesceTarget,
} from './agent-profile-runtime.js';
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
    }
  | {
      kind: 'plugins';
      ownerUserId: string;
      pluginFullId?: string;
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

function profileUsesCapability(
  profile: ReturnType<typeof listAgentProfilesForUser>[number],
  impact: CapabilityMutationImpact,
): boolean {
  if (impact.kind === 'plugins') return true;
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
  const mcpScope = impact.scope;
  return policy.ids.some((reference) => {
    if (mcpScope === 'system') {
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
  if (impact.kind === 'plugins') {
    const byFolder = new Map<string, WorkspaceRuntimeQuiesceTarget>();
    for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
      if (
        group.created_by === impact.ownerUserId &&
        !byFolder.has(group.folder)
      ) {
        byFolder.set(group.folder, {
          folder: group.folder,
          primaryJid: jid,
        });
      }
    }
    return Array.from(byFolder.values());
  }

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

function invalidateWorkspaceSessions(
  targets: WorkspaceRuntimeQuiesceTarget[],
): void {
  const deps = getWebDeps();
  for (const target of targets) {
    deleteWorkspaceSessions(target.folder);
    if (deps) delete deps.sessions[target.folder];
  }
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

  const knownRuntimeJids = Array.from(
    new Set(
      targets.flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
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
