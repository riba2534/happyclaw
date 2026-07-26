import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  canModifyGroup,
  hasHostExecutionPermission,
  isHostExecutionGroup,
} from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  getAgentProfile,
  getRegisteredGroup,
  getWorkspaceAgentProfileId,
  getWorkspaceInteractionMode,
  listAgentChannelMountsByWorkspace,
  listWorkspaceRecords,
  listWorkspaceRuntimeSessionsByWorkspace,
  type AgentChannelMountRecord,
  type WorkspaceRecord,
} from '../db.js';

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
  if (!profileId) return null;
  const profile = getAgentProfile(profileId);
  if (!profile || profile.status !== 'active') return null;
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

export default workspaceRoutes;
