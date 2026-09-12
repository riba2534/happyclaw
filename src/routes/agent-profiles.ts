import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AgentProfileCreateSchema,
  AgentProfileGenerateSchema,
  AgentProfilePatchSchema,
  AgentProfileRefinePromptSchema,
  AgentProfileRuntimePolicySchema,
} from '../schemas.js';
import type { AuthUser } from '../types.js';
import {
  generateAgentProfileDraft,
  refineAgentProfilePrompt,
} from '../agent-profile-generator.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { buildAgentCapabilityPreview } from '../agent-capability-preview.js';
import {
  avatarUploadBodyLimit,
  AVATAR_MAX_FILE_BYTES,
} from '../http-upload-policy.js';
import {
  getWorkspaceRuntimeJids,
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  resolveEffectiveAgentProfile,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
import {
  archiveAgentProfile,
  createAgentProfile,
  getAgentProfilePromptVersion,
  getAgentProfileForUser,
  getAllRegisteredGroups,
  getOrCreateDefaultAgentProfile,
  getWorkspaceAgentProfileId,
  listAgentChannelMountsForProfile,
  listAgentProfilesForUser,
  listAgentProfilePromptVersions,
  listWorkspaceRuntimeSessionsByWorkspace,
  mergeAgentProfileRuntimePolicy,
  normalizeAgentProfileRuntimePolicy,
  updateAgentProfile,
} from '../db.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import {
  agentProfilePromptsFromLegacy,
  promptModeFromLegacyPreset,
} from '../agent-profile-prompts.js';
import {
  hasEmptyCustomHostSkillSelection,
  hasInvalidRuntimePolicyReferences,
  isUnauthorizedHostClaudeContext,
  isUnauthorizedHostSkills,
  validateRuntimePolicyReferences,
} from '../agent-profile-policy.js';
import {
  classifyRunContextSnapshot,
  getRunContextSnapshot,
  hashRuntimePolicy,
} from '../run-context-snapshot.js';
import { getProviders } from '../runtime-config.js';

const agentProfileRoutes = new Hono<{ Variables: Variables }>();
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function removeProfileAvatarFiles(profileId: string, keep?: string): void {
  if (!fs.existsSync(AVATARS_DIR)) return;
  const prefix = `agent-profile-${profileId}-`;
  for (const filename of fs.readdirSync(AVATARS_DIR)) {
    if (!filename.startsWith(prefix) || filename === keep) continue;
    fs.rmSync(path.join(AVATARS_DIR, filename), { force: true });
  }
}

function usesFourPartPromptPayload(input: {
  prompt_schema_version?: 2;
  soul_prompt?: string;
  agents_prompt?: string;
  tools_prompt?: string;
  prompt_mode?: 'append' | 'replace';
}): boolean {
  return (
    input.prompt_schema_version === 2 ||
    input.soul_prompt !== undefined ||
    input.agents_prompt !== undefined ||
    input.tools_prompt !== undefined ||
    input.prompt_mode !== undefined
  );
}

agentProfileRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const profiles = listAgentProfilesForUser(user.id);
  return c.json({
    profiles: profiles.map((profile) => ({
      ...profile,
      // Persisted policy is kept for editing. The effective policy includes
      // system defaults and the current role check used at execution time.
      effective_runtime_policy:
        resolveEffectiveAgentProfile(profile)?.runtime_policy ??
        profile.runtime_policy,
    })),
    model_configs: getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      enabled: provider.enabled,
      anthropic_model: provider.anthropicModel,
    })),
  });
});

function modelConfigExists(modelConfigId: string): boolean {
  return getProviders().some((provider) => provider.id === modelConfigId);
}

agentProfileRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (isUnauthorizedHostClaudeContext(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host_claude context requires an admin role' }, 403);
  }
  if (isUnauthorizedHostSkills(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host skills require an admin role' }, 403);
  }
  if (
    parsed.data.model_config_id &&
    !modelConfigExists(parsed.data.model_config_id)
  ) {
    return c.json({ error: '所选模型配置不存在' }, 400);
  }
  const runtimePolicy = normalizeAgentProfileRuntimePolicy(
    parsed.data.runtime_policy,
  );
  runtimePolicy.skills.host ??= { mode: 'disabled', ids: [] };
  if (hasEmptyCustomHostSkillSelection(runtimePolicy)) {
    return c.json(
      { error: 'Custom host skills require at least one selected skill' },
      400,
    );
  }
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () => {
      const invalidReferences = validateRuntimePolicyReferences(
        user.id,
        runtimePolicy,
        user.role === 'admin',
      );
      if (hasInvalidRuntimePolicyReferences(invalidReferences)) {
        return c.json(
          {
            error: 'Runtime policy references unavailable capabilities',
            invalid_runtime_policy: invalidReferences,
          },
          400,
        );
      }
      const profile = createAgentProfile({
        ownerUserId: user.id,
        name: parsed.data.name,
        ...(usesFourPartPromptPayload(parsed.data)
          ? {
              identityPrompt: parsed.data.identity_prompt ?? '',
              soulPrompt: parsed.data.soul_prompt ?? '',
              agentsPrompt: parsed.data.agents_prompt ?? '',
              toolsPrompt: parsed.data.tools_prompt ?? '',
            }
          : {
              identityPrompt: '',
              soulPrompt: '',
              agentsPrompt: parsed.data.identity_prompt ?? '',
              toolsPrompt: '',
            }),
        promptMode:
          parsed.data.prompt_mode ??
          promptModeFromLegacyPreset(parsed.data.include_claude_preset),
        avatarEmoji: parsed.data.avatar_emoji,
        avatarColor: parsed.data.avatar_color,
        modelConfigId: parsed.data.model_config_id,
        runtimePolicy,
      });
      return c.json({ profile }, 201);
    },
  );
});

agentProfileRoutes.post('/generate', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileGenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  try {
    const draft = await generateAgentProfileDraft(parsed.data.description);
    return c.json({ draft });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'AI 解析失败，请重试或手动填写';
    logger.warn(
      { err, descriptionLen: parsed.data.description.length },
      'Failed to generate Agent profile draft',
    );
    return c.json({ error: message }, message.includes('未配置') ? 503 : 502);
  }
});

agentProfileRoutes.post(
  '/:id/effective-capabilities',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const existing = getAgentProfileForUser(id, user.id);
    if (!existing) return c.json({ error: '智能体配置不存在' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parsedPolicy =
      body.runtime_policy === undefined
        ? { success: true as const, data: undefined }
        : AgentProfileRuntimePolicySchema.safeParse(body.runtime_policy);
    if (!parsedPolicy.success)
      return c.json({ error: 'Invalid runtime policy' }, 400);
    if (isUnauthorizedHostClaudeContext(user, parsedPolicy.data)) {
      return c.json(
        { error: 'host_claude context requires an admin role' },
        403,
      );
    }
    if (isUnauthorizedHostSkills(user, parsedPolicy.data)) {
      return c.json({ error: 'host skills require an admin role' }, 403);
    }

    const previewRuntimePolicy =
      parsedPolicy.data === undefined
        ? existing.runtime_policy
        : mergeAgentProfileRuntimePolicy(
            existing.runtime_policy,
            parsedPolicy.data,
          );
    if (
      parsedPolicy.data?.skills?.host !== undefined &&
      isUnauthorizedHostSkills(user, previewRuntimePolicy)
    ) {
      return c.json({ error: 'host skills require an admin role' }, 403);
    }
    if (hasEmptyCustomHostSkillSelection(previewRuntimePolicy)) {
      return c.json(
        { error: 'Custom host skills require at least one selected skill' },
        400,
      );
    }

    const previewProfile = resolveEffectiveAgentProfile({
      ...existing,
      runtime_policy: previewRuntimePolicy,
    })!;
    const workspaceJid =
      typeof body.workspace_jid === 'string' && body.workspace_jid.trim()
        ? body.workspace_jid.trim()
        : undefined;
    let workspace:
      | {
          jid: string;
          group: ReturnType<typeof getAllRegisteredGroups>[string];
        }
      | undefined;
    if (workspaceJid) {
      const group = getAllRegisteredGroups()[workspaceJid];
      const defaultProfile = getOrCreateDefaultAgentProfile(user.id);
      const mappedProfileId = group
        ? (getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id)
        : undefined;
      if (
        !group ||
        !workspaceJid.startsWith('web:') ||
        group.created_by !== user.id ||
        mappedProfileId !== id
      ) {
        return c.json({ error: '该工作区不属于此智能体' }, 400);
      }
      workspace = { jid: workspaceJid, group };
    }

    const preview = buildAgentCapabilityPreview({
      profile: previewProfile,
      workspace,
      ownerRole: user.role,
    });
    const runContext = workspace ? getRunContextSnapshot(workspace.jid) : null;
    return c.json({
      preview,
      run_context: runContext,
      run_context_status: classifyRunContextSnapshot(runContext, {
        agentProfile: {
          id: existing.id,
          version: existing.version,
          identityHash: previewProfile.identity_hash,
          runtimePolicyHash: hashRuntimePolicy(previewProfile.runtime_policy),
        },
        skillManifestHash: preview.skills.manifestHash,
        mcpManifestHash: preview.mcp.manifestHash,
      }),
    });
  },
);

agentProfileRoutes.post(
  '/:id/avatar',
  authMiddleware,
  avatarUploadBodyLimit,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const profile = getAgentProfileForUser(id, user.id);
    if (!profile) return c.json({ error: '智能体配置不存在' }, 404);
    if (profile.is_default) {
      return c.json(
        { error: 'Configure the main HappyClaw avatar in system settings' },
        400,
      );
    }
    if (!(c.req.header('content-type') || '').includes('multipart/form-data')) {
      return c.json({ error: 'Expected multipart/form-data' }, 400);
    }
    const formData = await c.req.formData();
    const file = formData.get('avatar');
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No avatar file provided' }, 400);
    }
    if (file.size > AVATAR_MAX_FILE_BYTES) {
      return c.json({ error: 'File too large (max 3MB)' }, 413);
    }
    const extension = AVATAR_EXTENSIONS[file.type];
    if (!extension) {
      return c.json(
        { error: 'Unsupported image type. Use jpg, png, gif or webp' },
        400,
      );
    }

    fs.mkdirSync(AVATARS_DIR, { recursive: true });
    const filename = `agent-profile-${id}-${randomBytes(4).toString('hex')}${extension}`;
    const destination = path.join(AVATARS_DIR, filename);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()));
    fs.renameSync(temporary, destination);
    const avatarUrl = `/api/auth/avatars/${filename}`;
    const updated = updateAgentProfile(id, user.id, { avatarUrl });
    removeProfileAvatarFiles(id, filename);
    return c.json({ profile: updated, avatarUrl });
  },
);

agentProfileRoutes.delete('/:id/avatar', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: '智能体配置不存在' }, 404);
  if (profile.is_default) {
    return c.json(
      { error: 'Configure the main HappyClaw avatar in system settings' },
      400,
    );
  }
  const updated = updateAgentProfile(id, user.id, { avatarUrl: null });
  removeProfileAvatarFiles(id);
  return c.json({ profile: updated });
});

agentProfileRoutes.post('/:id/refine-prompt', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: '智能体配置不存在' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileRefinePromptSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  try {
    const currentPrompts = parsed.data.current_prompts
      ? {
          ...parsed.data.current_prompts,
          prompt_mode: profile.prompt_mode,
        }
      : agentProfilePromptsFromLegacy(
          parsed.data.current_prompt,
          profile.include_claude_preset,
        );
    const refinement = await refineAgentProfilePrompt({
      agentName: profile.name,
      currentPrompts,
      currentPrompt:
        parsed.data.current_prompt ??
        parsed.data.current_prompts?.agents_prompt,
      section: parsed.data.section,
      message: parsed.data.message,
      history: parsed.data.history,
    });
    return c.json({ refinement });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'AI 调整失败，请重试或手动修改';
    logger.warn(
      {
        err,
        agentProfileId: id,
        messageLen: parsed.data.message.length,
      },
      'Failed to refine Agent profile prompt',
    );
    return c.json({ error: message }, message.includes('未配置') ? 503 : 502);
  }
});

agentProfileRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (isUnauthorizedHostClaudeContext(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host_claude context requires an admin role' }, 403);
  }
  if (isUnauthorizedHostSkills(user, parsed.data.runtime_policy)) {
    return c.json({ error: 'host skills require an admin role' }, 403);
  }
  if (
    parsed.data.name === undefined &&
    parsed.data.identity_prompt === undefined &&
    parsed.data.soul_prompt === undefined &&
    parsed.data.agents_prompt === undefined &&
    parsed.data.tools_prompt === undefined &&
    parsed.data.prompt_mode === undefined &&
    parsed.data.include_claude_preset === undefined &&
    parsed.data.avatar_emoji === undefined &&
    parsed.data.avatar_color === undefined &&
    parsed.data.model_config_id === undefined &&
    parsed.data.runtime_policy === undefined
  ) {
    return c.json({ error: 'No changes provided' }, 400);
  }
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () =>
      withAgentProfileLocks([id], async () => {
        // Membership mutations for this profile use the same lock. Reading the
        // profile and workspace snapshot here prevents a new A-owned workspace
        // from being published between snapshot and post-commit cleanup.
        const existing = getAgentProfileForUser(id, user.id);
        if (!existing) return c.json({ error: '智能体配置不存在' }, 404);
        if (
          parsed.data.model_config_id &&
          !modelConfigExists(parsed.data.model_config_id)
        ) {
          return c.json({ error: '所选模型配置不存在' }, 400);
        }

        const effectiveRuntimePolicy =
          parsed.data.runtime_policy === undefined
            ? existing.runtime_policy
            : mergeAgentProfileRuntimePolicy(
                existing.runtime_policy,
                parsed.data.runtime_policy,
              );
        if (
          parsed.data.runtime_policy?.skills?.host !== undefined &&
          isUnauthorizedHostSkills(user, effectiveRuntimePolicy)
        ) {
          return c.json({ error: 'host skills require an admin role' }, 403);
        }
        if (hasEmptyCustomHostSkillSelection(effectiveRuntimePolicy)) {
          return c.json(
            { error: 'Custom host skills require at least one selected skill' },
            400,
          );
        }
        const invalidReferences = validateRuntimePolicyReferences(
          user.id,
          effectiveRuntimePolicy,
          user.role === 'admin',
        );
        if (hasInvalidRuntimePolicyReferences(invalidReferences)) {
          return c.json(
            {
              error: 'Runtime policy references unavailable capabilities',
              invalid_runtime_policy: invalidReferences,
            },
            400,
          );
        }

        // Direct DB/API consumers created before v48 may still have content in the
        // old identity column. Migrated and newly-created legacy HTTP profiles put
        // that all-purpose prompt in AGENTS. Route legacy PATCHes to whichever
        // representation the profile currently uses so retries remain no-ops.
        const legacyPromptTargetsIdentity =
          existing.identity_prompt.length > 0 &&
          existing.agents_prompt.length === 0;

        const sensitiveConfigurationChanged =
          (parsed.data.name !== undefined &&
            parsed.data.name !== existing.name) ||
          (usesFourPartPromptPayload(parsed.data)
            ? (parsed.data.identity_prompt !== undefined &&
                parsed.data.identity_prompt !== existing.identity_prompt) ||
              (parsed.data.soul_prompt !== undefined &&
                parsed.data.soul_prompt !== existing.soul_prompt) ||
              (parsed.data.agents_prompt !== undefined &&
                parsed.data.agents_prompt !== existing.agents_prompt) ||
              (parsed.data.tools_prompt !== undefined &&
                parsed.data.tools_prompt !== existing.tools_prompt)
            : parsed.data.identity_prompt !== undefined &&
              parsed.data.identity_prompt !==
                (legacyPromptTargetsIdentity
                  ? existing.identity_prompt
                  : existing.agents_prompt)) ||
          ((parsed.data.prompt_mode !== undefined ||
            parsed.data.include_claude_preset !== undefined) &&
            (parsed.data.prompt_mode ??
              promptModeFromLegacyPreset(parsed.data.include_claude_preset)) !==
              existing.prompt_mode) ||
          (parsed.data.runtime_policy !== undefined &&
            JSON.stringify(effectiveRuntimePolicy) !==
              JSON.stringify(
                normalizeAgentProfileRuntimePolicy(existing.runtime_policy),
              )) ||
          (parsed.data.model_config_id !== undefined &&
            parsed.data.model_config_id !== existing.model_config_id);

        let invalidatedRuntimeJids = 0;
        const fourPartPromptPayload = usesFourPartPromptPayload(parsed.data);
        const commit = () => {
          const promptUpdates = fourPartPromptPayload
            ? {
                identityPrompt: parsed.data.identity_prompt,
                soulPrompt: parsed.data.soul_prompt,
                agentsPrompt: parsed.data.agents_prompt,
                toolsPrompt: parsed.data.tools_prompt,
              }
            : {
                ...(legacyPromptTargetsIdentity
                  ? { identityPrompt: parsed.data.identity_prompt }
                  : { agentsPrompt: parsed.data.identity_prompt }),
              };
          return updateAgentProfile(id, user.id, {
            name: parsed.data.name,
            ...promptUpdates,
            promptMode:
              parsed.data.prompt_mode ??
              (parsed.data.include_claude_preset === undefined
                ? undefined
                : promptModeFromLegacyPreset(
                    parsed.data.include_claude_preset,
                  )),
            avatarEmoji: parsed.data.avatar_emoji,
            avatarColor: parsed.data.avatar_color,
            modelConfigId: parsed.data.model_config_id,
            runtimePolicy: parsed.data.runtime_policy,
          });
        };
        let profile;
        const deps = getWebDeps();
        const profileWorkspaces = deps
          ? listWorkspaceGroupsForAgentProfile(user.id, id)
          : [];
        const runtimeWasSafetyBlocked =
          deps != null &&
          profileWorkspaces.some(
            ({ jid }) => deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false,
          );
        const shouldQuiesce =
          sensitiveConfigurationChanged || runtimeWasSafetyBlocked;
        const workspaces = shouldQuiesce ? profileWorkspaces : [];
        if (shouldQuiesce && deps && workspaces.length > 0) {
          try {
            const result = await quiesceWorkspaceRunnersAroundCommit(
              deps,
              workspaces.map((workspace) => ({
                folder: workspace.group.folder,
                primaryJid: workspace.jid,
              })),
              {
                reason: `Agent profile ${id} sensitive configuration changed`,
                onPostCommitFailure: (runtimeJids) =>
                  deps.queue.blockGroupsForRuntimeSafety?.(
                    runtimeJids,
                    `Agent profile ${id} runtime cleanup failed after configuration commit`,
                  ),
              },
              commit,
            );
            profile = result.value;
            invalidatedRuntimeJids = result.runtimeJids.length;
            deps.queue.unblockGroupsForRuntimeSafety?.(result.runtimeJids);
          } catch (err) {
            if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
            const persistedProfile = err.persisted
              ? (err.committedValue as ReturnType<typeof commit>)
              : undefined;
            logger.error(
              { err, agentProfileId: id, persisted: err.persisted },
              err.persisted
                ? 'Agent profile persisted but post-commit runtime cleanup failed'
                : 'Agent profile update aborted before persistence',
            );
            return c.json(
              {
                error: err.persisted
                  ? '智能体配置已更新，但运行时清理失败；请重试相同请求'
                  : '无法停止活动工作区；智能体配置未更新',
                persisted: err.persisted,
                retryable: true,
                profile: persistedProfile,
              },
              503,
            );
          }
        } else {
          profile = commit();
        }
        if (!profile) return c.json({ error: '智能体配置不存在' }, 404);

        return c.json({
          profile,
          invalidated_runtime_jids: invalidatedRuntimeJids,
        });
      }),
  );
});

agentProfileRoutes.get('/:id/prompt-versions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const profile = getAgentProfileForUser(id, user.id);
  if (!profile) return c.json({ error: '智能体配置不存在' }, 404);
  return c.json({ versions: listAgentProfilePromptVersions(id, user.id) });
});

agentProfileRoutes.post(
  '/:id/prompt-versions/:version/restore',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const version = Number(c.req.param('version'));
    if (!Number.isSafeInteger(version) || version < 1) {
      return c.json({ error: 'Invalid prompt version' }, 400);
    }

    return withAgentProfileLocks([id], async () => {
      const existing = getAgentProfileForUser(id, user.id);
      if (!existing) return c.json({ error: '智能体配置不存在' }, 404);
      const target = getAgentProfilePromptVersion(id, user.id, version);
      if (!target) return c.json({ error: 'Prompt version not found' }, 404);

      const promptChanged =
        target.identity_prompt !== existing.identity_prompt ||
        target.soul_prompt !== existing.soul_prompt ||
        target.agents_prompt !== existing.agents_prompt ||
        target.tools_prompt !== existing.tools_prompt ||
        target.prompt_mode !== existing.prompt_mode;
      const commit = () =>
        updateAgentProfile(id, user.id, {
          identityPrompt: target.identity_prompt,
          soulPrompt: target.soul_prompt,
          agentsPrompt: target.agents_prompt,
          toolsPrompt: target.tools_prompt,
          promptMode: target.prompt_mode,
          changeSource: 'restore',
          restoredFromVersion: version,
        });

      let profile;
      let invalidatedRuntimeJids = 0;
      const deps = getWebDeps();
      const profileWorkspaces = deps
        ? listWorkspaceGroupsForAgentProfile(user.id, id)
        : [];
      const runtimeWasSafetyBlocked =
        deps != null &&
        profileWorkspaces.some(
          ({ jid }) => deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false,
        );
      const shouldQuiesce = promptChanged || runtimeWasSafetyBlocked;
      const workspaces = shouldQuiesce ? profileWorkspaces : [];
      if (shouldQuiesce && deps && workspaces.length > 0) {
        try {
          const result = await quiesceWorkspaceRunnersAroundCommit(
            deps,
            workspaces.map((workspace) => ({
              folder: workspace.group.folder,
              primaryJid: workspace.jid,
            })),
            {
              reason: `Agent profile ${id} prompt version restored`,
              onPostCommitFailure: (runtimeJids) =>
                deps.queue.blockGroupsForRuntimeSafety?.(
                  runtimeJids,
                  `Agent profile ${id} runtime cleanup failed after prompt restore`,
                ),
            },
            commit,
          );
          profile = result.value;
          invalidatedRuntimeJids = result.runtimeJids.length;
          deps.queue.unblockGroupsForRuntimeSafety?.(result.runtimeJids);
        } catch (err) {
          if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
          return c.json(
            {
              error: err.persisted
                ? 'Prompt version was restored, but runtime cleanup failed; retry the same request'
                : 'Failed to quiesce active workspaces; prompt version was not restored',
              persisted: err.persisted,
              retryable: true,
              profile: err.persisted ? err.committedValue : undefined,
            },
            503,
          );
        }
      } else {
        profile = promptChanged ? commit() : existing;
      }

      return c.json({
        profile,
        restored_from_version: version,
        invalidated_runtime_jids: invalidatedRuntimeJids,
      });
    });
  },
);

agentProfileRoutes.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withAgentProfileLocks([id], () => {
    // Target-profile validation in create/migrate is repeated under this same
    // lock, so either archive wins and publication is rejected, or membership
    // wins and archive observes the mapping and returns 409.
    const result = archiveAgentProfile(id, user.id);
    if (result === 'not_found') {
      return c.json({ error: '智能体配置不存在' }, 404);
    }
    if (result === 'is_default') {
      return c.json({ error: '不能删除内置的 HappyClaw 智能体' }, 400);
    }
    if (result === 'has_workspaces') {
      return c.json(
        {
          error: '该智能体仍拥有工作区；请先迁移或删除这些工作区',
        },
        409,
      );
    }
    if (result === 'has_mounts') {
      return c.json(
        {
          error: '该智能体仍有消息渠道挂载；请先解绑',
        },
        409,
      );
    }
    return c.json({ success: true });
  });
});

agentProfileRoutes.post('/:id/runtime-cleanup', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () =>
      withAgentProfileLocks([id], async () => {
        const profile = getAgentProfileForUser(id, user.id);
        if (!profile) return c.json({ error: '智能体配置不存在' }, 404);

        const deps = getWebDeps();
        const profileWorkspaces = deps
          ? listWorkspaceGroupsForAgentProfile(user.id, id)
          : [];
        if (!deps || profileWorkspaces.length === 0) {
          return c.json({
            success: true,
            cleaned_runtime_jids: 0,
            runtime_cleanup_pending: false,
          });
        }
        const targets = profileWorkspaces.map((workspace) => ({
          folder: workspace.group.folder,
          primaryJid: workspace.jid,
        }));
        const runtimeJids = Array.from(
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
              reason: `Retry pending runtime cleanup for Agent profile ${id}`,
              onPostCommitFailure: (failedRuntimeJids) =>
                deps.queue.blockGroupsForRuntimeSafety?.(
                  failedRuntimeJids,
                  `Agent profile ${id} runtime cleanup retry failed`,
                ),
            },
            () => undefined,
          );
          deps.queue.unblockGroupsForRuntimeSafety?.(result.runtimeJids);
          return c.json({
            success: true,
            cleaned_runtime_jids: result.runtimeJids.length,
            runtime_cleanup_pending: false,
          });
        } catch (err) {
          if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
          // Keep the profile fail-closed even if a cleanup-only retry fails
          // before its no-op commit. The original configuration is already
          // durable, so every user can safely retry this owner-scoped endpoint.
          deps.queue.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `Agent profile ${id} runtime cleanup retry failed`,
          );
          logger.error(
            { err, agentProfileId: id },
            'Agent profile runtime cleanup retry failed',
          );
          return c.json(
            {
              error: '工作区运行时清理失败，请重试',
              retryable: true,
              runtime_cleanup_pending: true,
            },
            503,
          );
        }
      }),
  );
});

agentProfileRoutes.get('/:id/workspaces', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withAgentProfileLocks([id], () => {
    const profile = getAgentProfileForUser(id, user.id);
    if (!profile) return c.json({ error: '智能体配置不存在' }, 404);

    const defaultProfile = getOrCreateDefaultAgentProfile(user.id);
    const groups = getAllRegisteredGroups();
    const workspaces = Object.entries(groups)
      .filter(([jid, group]) => {
        if (!jid.startsWith('web:')) return false;
        if (group.created_by !== user.id) return false;
        const mapped =
          getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id;
        return mapped === id;
      })
      .map(([jid, group]) => ({
        jid,
        name: group.name,
        folder: group.folder,
        is_home: !!group.is_home,
        execution_mode: group.executionMode ?? 'container',
        added_at: group.added_at,
        runtime_sessions: listWorkspaceRuntimeSessionsByWorkspace(jid).map(
          (session) => ({
            runtime_agent_id: session.runtime_agent_id,
            sdk_session_id: session.sdk_session_id,
            provider_id: session.provider_id,
            agent_profile_id: session.agent_profile_id,
            agent_profile_version: session.agent_profile_version,
            identity_hash: session.identity_hash,
            updated_at: session.updated_at,
          }),
        ),
      }));
    const workspaceJids = new Set(workspaces.map((workspace) => workspace.jid));
    const channelMounts = listAgentChannelMountsForProfile(id)
      .filter((mount) => workspaceJids.has(mount.workspace_jid))
      .map((mount) => ({
        channel_jid: mount.channel_jid,
        channel_type: mount.channel_type,
        workspace_jid: mount.workspace_jid,
        workspace_folder: mount.workspace_folder,
        session_id: mount.session_id ?? null,
        routing_mode: mount.routing_mode,
        reply_policy: mount.reply_policy,
        interaction_mode_override: mount.interaction_mode_override ?? null,
        activation_mode: mount.activation_mode,
        audience_mode: mount.audience_mode,
        owner_im_id: mount.owner_im_id ?? null,
        updated_at: mount.updated_at,
      }));
    const deps = getWebDeps();
    const runtimeCleanupPending =
      deps != null &&
      listWorkspaceGroupsForAgentProfile(user.id, id).some((workspace) =>
        getWorkspaceRuntimeJids(
          deps,
          workspace.group.folder,
          workspace.jid,
        ).some((jid) => deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false),
      );

    return c.json({
      profile,
      workspaces,
      channel_mounts: channelMounts,
      runtime_cleanup_pending: runtimeCleanupPending,
    });
  });
});

export default agentProfileRoutes;
