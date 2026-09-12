import { Hono, type Context } from 'hono';
import type { Variables } from '../web-context.js';
import {
  hasHostExecutionPermission,
  isHostExecutionGroup,
  getWebDeps,
} from '../web-context.js';
import { canAccessGroup, canModifyGroup } from '../group-acl.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  getAgentProfileForUser,
  getRegisteredGroup,
  getChannelMount,
  getAgentChannelMount,
  setChannelMountInteractionModeOverride,
  getWorkspaceAgentProfileId,
  getWorkspaceInteractionMode,
  listAgentChannelMountsByWorkspace,
  listWorkspaceRecords,
  listWorkspaceRuntimeSessionsByWorkspace,
  type AgentChannelMountRecord,
  type WorkspaceRecord,
} from '../db.js';
import {
  HappyClawOwnerProfileMutationSchema,
  ChannelMountInteractionModePatchSchema,
} from '../schemas.js';
import {
  clearHappyClawOwnerPreferredAddress,
  getHappyClawOwnerProfileProjection,
  OwnerProfileStoreError,
  setHappyClawOwnerPreferredAddress,
  skipHappyClawOwnerIntroduction,
} from '../owner-profile-store.js';

const workspaceRoutes = new Hono<{ Variables: Variables }>();

type ResolvedWorkspaceAccess = {
  workspace: WorkspaceRecord;
  group: RegisteredGroup & { jid: string };
};

function resolveWorkspaceAccess(
  user: AuthUser,
  workspace: WorkspaceRecord,
): ResolvedWorkspaceAccess | null {
  const group = getRegisteredGroup(workspace.jid);
  if (!group || !workspace.jid.startsWith('web:')) return null;

  const groupWithJid = { ...group, jid: workspace.jid };
  const isAdmin = hasHostExecutionPermission(user);
  if (
    isHostExecutionGroup(group) &&
    !isAdmin &&
    !(group.is_home && group.created_by === user.id)
  ) {
    return null;
  }

  if (!canAccessGroup(user, groupWithJid)) return null;
  return { workspace, group: groupWithJid };
}

function canInspectGovernance(
  user: AuthUser,
  access: ResolvedWorkspaceAccess,
): boolean {
  return hasHostExecutionPermission(user) || canModifyGroup(user, access.group);
}

function getAgentProfileSnapshot(
  workspace: WorkspaceRecord,
  includePolicy: boolean,
) {
  const profileId = getWorkspaceAgentProfileId(workspace.folder);
  if (!profileId || !workspace.owner_user_id) return null;
  // Legacy mappings may predate ownership validation. Workspace access never
  // grants permission to inspect another user's top-level Agent or policy.
  const profile = getAgentProfileForUser(profileId, workspace.owner_user_id);
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    identity_hash: includePolicy ? profile.identity_hash : undefined,
    runtime_policy: includePolicy ? profile.runtime_policy : undefined,
    is_default: profile.is_default,
  };
}

function serializeMount(mount: AgentChannelMountRecord) {
  return {
    channel_jid: mount.channel_jid,
    channel_type: mount.channel_type,
    workspace_jid: mount.workspace_jid,
    workspace_folder: mount.workspace_folder,
    session_id: mount.session_id ?? null,
    routing_mode: mount.routing_mode,
    reply_policy: mount.reply_policy,
    interaction_mode_override: mount.interaction_mode_override ?? null,
    interaction_mode:
      mount.interaction_mode_override ??
      getWorkspaceInteractionMode(mount.workspace_folder ?? ''),
    activation_mode: mount.activation_mode,
    audience_mode: mount.audience_mode,
    owner_im_id: mount.owner_im_id ?? null,
    owner_user_id: mount.owner_user_id,
    agent_profile_id: mount.agent_profile_id,
    created_at: mount.created_at,
    updated_at: mount.updated_at,
  };
}

function serializeWorkspaceSummary(
  user: AuthUser,
  access: ResolvedWorkspaceAccess,
) {
  const { workspace, group } = access;
  const inspectGovernance = canInspectGovernance(user, access);
  const runtimeSessions = inspectGovernance
    ? listWorkspaceRuntimeSessionsByWorkspace(workspace.jid)
    : [];
  const channelMounts = inspectGovernance
    ? listAgentChannelMountsByWorkspace(workspace.jid)
    : [];
  const isAdmin = hasHostExecutionPermission(user);
  return {
    jid: workspace.jid,
    folder: workspace.folder,
    owner_user_id: inspectGovernance ? workspace.owner_user_id : undefined,
    name: workspace.name,
    status: workspace.status,
    is_home: workspace.is_home,
    execution_mode: inspectGovernance
      ? (group.executionMode ?? 'container')
      : undefined,
    interaction_mode: getWorkspaceInteractionMode(workspace.folder),
    custom_cwd: isAdmin ? (group.customCwd ?? null) : undefined,
    agent_profile: getAgentProfileSnapshot(workspace, inspectGovernance),
    runtime_session_count: inspectGovernance
      ? runtimeSessions.length
      : undefined,
    channel_mount_count: inspectGovernance ? channelMounts.length : undefined,
    can_modify: canModifyGroup(user, group),
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

function listVisibleWorkspaces(user: AuthUser): ResolvedWorkspaceAccess[] {
  return listWorkspaceRecords()
    .map((workspace) => resolveWorkspaceAccess(user, workspace))
    .filter((access): access is ResolvedWorkspaceAccess => access !== null);
}

function resolveOwnerProfileAccess(
  user: AuthUser,
  jid: string,
): ResolvedWorkspaceAccess | null {
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace || !workspace.is_home || workspace.owner_user_id !== user.id) {
    return null;
  }
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access || access.group.created_by !== user.id) return null;
  const profile = getAgentProfileSnapshot(workspace, true);
  return profile?.is_default === true ? access : null;
}

function ownerProfileError(c: Context, error: unknown): Response {
  if (error instanceof OwnerProfileStoreError) {
    if (error.code === 'revision_conflict') {
      return c.json(
        {
          error: error.code,
          message: error.message,
          currentRevision: error.details?.currentRevision,
          storeRevision: error.details?.storeRevision,
        },
        409,
      );
    }
    if (error.code === 'idempotency_conflict') {
      return c.json({ error: error.code, message: error.message }, 409);
    }
    if (error.code === 'not_home_workspace') {
      return c.json({ error: 'Owner Profile not found' }, 404);
    }
    return c.json({ error: error.code, message: error.message }, 400);
  }
  return c.json({ error: 'Owner Profile request failed' }, 500);
}

workspaceRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaces = listVisibleWorkspaces(user).map((access) =>
    serializeWorkspaceSummary(user, access),
  );
  return c.json({ workspaces });
});

workspaceRoutes.get('/mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const channelMounts = listVisibleWorkspaces(user)
    .filter((access) => canInspectGovernance(user, access))
    .flatMap((access) =>
      listAgentChannelMountsByWorkspace(access.workspace.jid).map(
        serializeMount,
      ),
    );
  return c.json({ channel_mounts: channelMounts });
});

workspaceRoutes.get('/:jid/owner-profile', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  try {
    return c.json({
      profile: getHappyClawOwnerProfileProjection(access.workspace.jid),
    });
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.patch('/:jid/owner-profile', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = HappyClawOwnerProfileMutationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.format() },
      400,
    );
  }
  const context = {
    actorId: user.id,
    sourceType: 'web_user' as const,
    sourceId: `api:${access.workspace.jid}:owner-profile`,
    observedAt: new Date().toISOString(),
  };
  try {
    switch (parsed.data.action) {
      case 'set':
        return c.json(
          setHappyClawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            preferredAddress: parsed.data.preferredAddress,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'clear':
        return c.json(
          clearHappyClawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'skip':
        return c.json(
          skipHappyClawOwnerIntroduction({
            workspaceJid: access.workspace.jid,
            expectedOnboardingRevision: parsed.data.expectedOnboardingRevision,
            context,
          }),
        );
    }
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.get('/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) return c.json({ error: 'Workspace not found' }, 404);

  const inspectGovernance = canInspectGovernance(user, access);
  const runtimeSessions = inspectGovernance
    ? listWorkspaceRuntimeSessionsByWorkspace(workspace.jid).map((session) => ({
        group_folder: session.group_folder,
        runtime_agent_id: session.runtime_agent_id,
        workspace_jid: session.workspace_jid,
        sdk_session_id: session.sdk_session_id,
        provider_id: session.provider_id,
        agent_profile_id: session.agent_profile_id,
        agent_profile_version: session.agent_profile_version,
        identity_hash: session.identity_hash,
        created_at: session.created_at,
        updated_at: session.updated_at,
      }))
    : undefined;
  const channelMounts = inspectGovernance
    ? listAgentChannelMountsByWorkspace(workspace.jid).map(serializeMount)
    : undefined;

  return c.json({
    workspace: serializeWorkspaceSummary(user, access),
    runtime_sessions: runtimeSessions,
    channel_mounts: channelMounts,
  });
});

workspaceRoutes.get('/:jid/runtime-sessions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (!canInspectGovernance(user, access)) {
    return c.json(
      { error: 'Only the workspace owner can inspect runtime sessions' },
      403,
    );
  }
  return c.json({
    runtime_sessions: listWorkspaceRuntimeSessionsByWorkspace(jid),
  });
});

workspaceRoutes.get('/:jid/channel-mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  if (!canInspectGovernance(user, access)) {
    return c.json(
      { error: 'Only the workspace owner can inspect channel mounts' },
      403,
    );
  }
  const channelMounts =
    listAgentChannelMountsByWorkspace(jid).map(serializeMount);
  return c.json({ channel_mounts: channelMounts });
});

workspaceRoutes.patch(
  '/:jid/channel-mounts/:channelJid',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const jid = c.req.param('jid');
    const channelJid = c.req.param('channelJid');
    const workspace = listWorkspaceRecords().find(
      (record) => record.jid === jid,
    );
    const access = workspace ? resolveWorkspaceAccess(user, workspace) : null;
    const mount = getChannelMount(channelJid);
    const channel = getRegisteredGroup(channelJid);
    if (
      !access ||
      !mount ||
      mount.workspace_jid !== jid ||
      !channel ||
      !canModifyGroup(user, access.group) ||
      !canModifyGroup(user, { ...channel, jid: channelJid })
    ) {
      return c.json({ error: 'Channel mount not found' }, 404);
    }
    const parsed = ChannelMountInteractionModePatchSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: 'Invalid request', details: parsed.error.format() },
        400,
      );
    const deps = getWebDeps();
    if (!deps)
      return c.json({ error: 'Runtime is not ready', retryable: true }, 503);
    const {
      quiesceWorkspaceRunnersAroundCommit,
      withAgentProfileLocks,
      WorkspaceRuntimeQuiesceError,
    } = await import('../agent-profile-runtime.js');
    const mode = parsed.data.interaction_mode_override;
    const profileId = getWorkspaceAgentProfileId(access.workspace.folder);
    const stillOwnsBinding = () => {
      const latestWorkspace = getRegisteredGroup(jid);
      const latestChannel = getRegisteredGroup(channelJid);
      return Boolean(
        latestWorkspace &&
        latestChannel &&
        latestWorkspace.folder === access.workspace.folder &&
        canModifyGroup(user, { ...latestWorkspace, jid }) &&
        canModifyGroup(user, { ...latestChannel, jid: channelJid }),
      );
    };
    return withAgentProfileLocks(
      [profileId ?? `workspace:${jid}`],
      async () => {
        const current = getChannelMount(channelJid);
        if (
          !current ||
          !stillOwnsBinding() ||
          current.workspace_jid !== jid ||
          current.session_id !== mount.session_id
        ) {
          return c.json(
            { error: 'Channel binding changed; reload and retry' },
            409,
          );
        }
        const runtimeBlocked =
          deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false;
        if (
          (current.interaction_mode_override ?? null) === mode &&
          !runtimeBlocked
        ) {
          return c.json({
            channel_mount: serializeMount(getAgentChannelMount(channelJid)!),
          });
        }
        try {
          const result = await quiesceWorkspaceRunnersAroundCommit(
            deps,
            [{ folder: access.workspace.folder, primaryJid: jid }],
            {
              reason: `Channel ${channelJid} interaction override changed`,
              onPostCommitFailure: (jids) =>
                deps.queue.blockGroupsForRuntimeSafety?.(
                  jids,
                  `Channel ${channelJid} runtime cleanup failed after interaction override commit`,
                ),
            },
            () => {
              const latest = getChannelMount(channelJid);
              if (
                !latest ||
                !stillOwnsBinding() ||
                latest.workspace_jid !== jid ||
                latest.session_id !== current.session_id
              ) {
                return false;
              }
              // Only change the mount setting. Product conversation bindings,
              // history and SDK resume rows remain available to runtime admission.
              return Boolean(
                setChannelMountInteractionModeOverride(channelJid, jid, mode),
              );
            },
          );
          if (!result.value)
            return c.json(
              { error: 'Channel binding changed; reload and retry' },
              409,
            );
          deps.queue.unblockGroupsForRuntimeSafety?.(result.runtimeJids);
          return c.json({
            channel_mount: serializeMount(getAgentChannelMount(channelJid)!),
          });
        } catch (error) {
          if (!(error instanceof WorkspaceRuntimeQuiesceError)) throw error;
          return c.json(
            {
              error: error.persisted
                ? 'Setting saved, but runtime cleanup failed; retry the request'
                : 'Could not stop the active runtime; setting was not changed',
              persisted: error.persisted,
              retryable: true,
            },
            503,
          );
        }
      },
    );
  },
);

export default workspaceRoutes;
