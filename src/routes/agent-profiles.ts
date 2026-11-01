import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Variables, WebDeps } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AGENT_NAME_MAX_CHARS,
  AGENT_PROMPT_MAX_CHARS,
  AgentProfileCreateSchema,
  AgentProfileGenerateSchema,
  AgentProfileImportSchema,
  AgentProfileMigrateAndDeleteSchema,
  AgentProfilePatchSchema,
  AgentProfileRefinePromptSchema,
  AgentProfileRuntimePolicySchema,
} from '../schemas.js';
import type {
  AgentProfile,
  AgentProfileRuntimePolicy,
  AuthUser,
  RegisteredGroup,
} from '../types.js';
import {
  ClaudeProviderNotConfiguredError,
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
  collectWorkspaceRuntimeJids,
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
  findAgentProfileNameConflict,
  getAgentProfileForUser,
  getAllRegisteredGroups,
  getOrCreateDefaultAgentProfile,
  getWorkspaceAgentProfileId,
  listAgentChannelMountsForProfile,
  listAgentProfilesForUser,
  listWorkspaceRuntimeSessionsByWorkspace,
  mergeAgentProfileRuntimePolicy,
  migrateAgentProfileWorkspacesAndArchive,
  normalizeAgentProfileRuntimePolicy,
  peekSystemMainAgentProfile,
  updateAgentProfile,
} from '../db.js';
import {
  buildAgentProfileExport,
  dropMissingReferences,
  hostGrantsOf,
  parseAgentProfileExport,
  stripHostGrants,
} from '../agent-profile-transfer.js';
import {
  bindingFromMainProfile,
  resolveModelBinding,
  summarizeModelBinding,
} from '../container-runner.js';
import { resolveAgentSdkEffort } from '../agent-effort.js';
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
import { getProviders, providerHasCredentials } from '../runtime-config.js';
import { splitOneMillionSuffix } from '../model-providers.js';
import {
  listConnectionModels,
  modelEffortsFor,
} from '../session-model-overrides.js';

const agentProfileRoutes = new Hono<{ Variables: Variables }>();
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const AVATAR_URL_PREFIX = '/api/auth/avatars/';
const avatarFilePrefix = (profileId: string) => `agent-profile-${profileId}-`;

/** A fresh file name for a profile's avatar and the URL that serves it. */
function newProfileAvatarFile(profileId: string, extension: string) {
  const filename = `${avatarFilePrefix(profileId)}${randomBytes(4).toString('hex')}${extension}`;
  return { filename, url: `${AVATAR_URL_PREFIX}${filename}` };
}

function removeProfileAvatarFiles(profileId: string, keep?: string): void {
  if (!fs.existsSync(AVATARS_DIR)) return;
  const prefix = avatarFilePrefix(profileId);
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
  const systemMain = peekSystemMainAgentProfile();
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
      model: provider.anthropicModel,
      usable: providerHasCredentials(provider),
      models: listConnectionModels(provider),
    })),
    // What an Agent without its own binding follows, for 「跟随主智能体」.
    inherited_model: {
      owner_main: inheritedModelOf(
        'owner_main',
        profiles.find((profile) => profile.is_default),
      ),
      system_main: inheritedModelOf('system_main', systemMain),
      // Only the owner learns which profile is the system main.
      system_main_profile_id:
        systemMain?.owner_user_id === user.id ? systemMain.id : null,
    },
  });
});

/** The connection, model and effort a main Agent hands down, if usable. */
function inheritedModelOf(
  source: 'owner_main' | 'system_main',
  profile: AgentProfile | undefined,
): {
  model_config_id: string;
  model: string | null;
  effort: string | null;
} | null {
  const binding = bindingFromMainProfile(source, profile);
  if (!binding?.provider) return null;
  const summary = summarizeModelBinding(binding, '', null, undefined);
  return {
    model_config_id: binding.provider.id,
    model: summary.model,
    effort: summary.effort,
  };
}

/**
 * Why an Agent's explicit effort cannot run on the model it binds, or null.
 * Only an Agent's own binding is checked; an inherited one may change under
 * it, and a launch then skips an effort the model does not take.
 */
function agentEffortRejection(
  modelConfigId: string | null,
  model: string | null,
  effort: string | undefined,
): { error: string; code: 'EFFORT_NOT_SUPPORTED' } | null {
  if (!effort || !modelConfigId) return null;
  const provider = getProviders().find((item) => item.id === modelConfigId);
  if (!provider) return null;
  const runs = model || provider.anthropicModel;
  return modelEffortsFor(provider, runs).includes(effort)
    ? null
    : {
        error: runs
          ? `模型 ${runs} 不支持推理档位 ${effort}`
          : '该模型配置未指定模型，不能设置推理档位',
        code: 'EFFORT_NOT_SUPPORTED',
      };
}

/**
 * A copied policy whose effort its bound model no longer takes: the copy
 * inherits instead, rather than refusing to copy what the source runs with.
 */
function withRunnableEffort(
  policy: AgentProfileRuntimePolicy,
  modelConfigId: string | null,
  model: string | null,
): AgentProfileRuntimePolicy {
  return agentEffortRejection(
    modelConfigId,
    model,
    resolveAgentSdkEffort(policy),
  )
    ? { ...policy, reasoning: { ...policy.reasoning, effort: 'inherit' } }
    : policy;
}

function modelConfigExists(modelConfigId: string): boolean {
  return getProviders().some((provider) => provider.id === modelConfigId);
}

/**
 * Why `model` cannot be an Agent's model within `modelConfigId`, or null when
 * it can: the configuration has to offer it.
 */
function agentModelRejection(
  modelConfigId: string | null | undefined,
  model: string,
): { error: string; code: 'MODEL_NOT_IN_CONNECTION' } | null {
  const provider = modelConfigId
    ? getProviders().find((item) => item.id === modelConfigId)
    : undefined;
  if (!provider) {
    return {
      error: modelConfigId
        ? '所选模型配置不存在'
        : '选择模型时需要同时指定模型配置',
      code: 'MODEL_NOT_IN_CONNECTION',
    };
  }
  const { model: id } = splitOneMillionSuffix(model);
  if (listConnectionModels(provider).some((entry) => entry.id === id)) {
    return null;
  }
  return {
    error: `模型 ${model} 不在所选模型配置的模型列表中`,
    code: 'MODEL_NOT_IN_CONNECTION',
  };
}

const AGENT_PROMPT_FIELD_LABELS: Record<string, string> = {
  identity_prompt: '身份定位（IDENTITY）',
  soul_prompt: '人格与表达（SOUL）',
  agents_prompt: '行为规则（AGENTS）',
  tools_prompt: '工具说明（TOOLS）',
};

/** Say which field failed instead of a bare "Invalid request body". */
function invalidAgentProfileBody(
  error: z.ZodError,
  body: unknown,
): { error: string; code?: string; field?: string; max?: number } {
  const issue = error.issues[0];
  const field = typeof issue?.path[0] === 'string' ? issue.path[0] : undefined;
  if (field && AGENT_PROMPT_FIELD_LABELS[field] && issue.code === 'too_big') {
    const value = (body as Record<string, unknown> | null)?.[field];
    return {
      error: `${AGENT_PROMPT_FIELD_LABELS[field]}超过 ${AGENT_PROMPT_MAX_CHARS} 字上限${
        typeof value === 'string' ? `（当前 ${value.length} 字）` : ''
      }`,
      code: 'PROMPT_TOO_LONG',
      field,
      max: AGENT_PROMPT_MAX_CHARS,
    };
  }
  if (field === 'name') {
    return {
      error:
        issue.code === 'too_big'
          ? `名称不能超过 ${AGENT_NAME_MAX_CHARS} 个字`
          : issue.code === 'custom'
            ? issue.message
            : '请填写名称',
      code: 'INVALID_NAME',
      field,
    };
  }
  return {
    error: 'Invalid request body',
    ...(issue?.path.length ? { field: issue.path.join('.') } : {}),
  };
}

function agentNameTaken(conflict: { name: string }) {
  return {
    error: `已有名为「${conflict.name}」的智能体，请换一个名称`,
    code: 'AGENT_NAME_TAKEN',
    field: 'name',
  };
}

/** "<name> 副本", then "<name> 副本 2", … within the name limit. */
function nextCopyName(ownerUserId: string, name: string): string {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? ' 副本' : ` 副本 ${n}`;
    const chars = Array.from(name);
    while (chars.join('').length + suffix.length > AGENT_NAME_MAX_CHARS) {
      chars.pop();
    }
    const candidate = `${chars.join('').trimEnd()}${suffix}`;
    if (!findAgentProfileNameConflict(ownerUserId, candidate)) return candidate;
  }
}

type ProfileRejection = {
  status: 400 | 403;
  body: Record<string, unknown>;
};

/**
 * Everything a new profile must satisfy, whether it is created, duplicated or
 * imported. References are checked against live capabilities, so call this
 * under the user's capability scope lock.
 */
function newProfileRejection(
  user: AuthUser,
  input: {
    runtimePolicy: AgentProfileRuntimePolicy;
    modelConfigId?: string | null;
    model?: string | null;
  },
): ProfileRejection | null {
  if (isUnauthorizedHostClaudeContext(user, input.runtimePolicy)) {
    return {
      status: 403,
      body: { error: 'host_claude context requires an admin role' },
    };
  }
  if (isUnauthorizedHostSkills(user, input.runtimePolicy)) {
    return {
      status: 403,
      body: { error: 'host skills require an admin role' },
    };
  }
  if (input.modelConfigId && !modelConfigExists(input.modelConfigId)) {
    return { status: 400, body: { error: '所选模型配置不存在' } };
  }
  if (input.model) {
    const rejection = agentModelRejection(input.modelConfigId, input.model);
    if (rejection) return { status: 400, body: rejection };
  }
  if (hasEmptyCustomHostSkillSelection(input.runtimePolicy)) {
    return {
      status: 400,
      body: { error: 'Custom host skills require at least one selected skill' },
    };
  }
  const invalidReferences = validateRuntimePolicyReferences(
    user.id,
    input.runtimePolicy,
    user.role === 'admin',
  );
  if (hasInvalidRuntimePolicyReferences(invalidReferences)) {
    return {
      status: 400,
      body: {
        error: 'Runtime policy references unavailable capabilities',
        invalid_runtime_policy: invalidReferences,
      },
    };
  }
  return null;
}

agentProfileRoutes.post('/', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfileCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(invalidAgentProfileBody(parsed.error, body), 400);
  }
  const runtimePolicy = normalizeAgentProfileRuntimePolicy(
    parsed.data.runtime_policy,
  );
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () => {
      const rejection = newProfileRejection(user, {
        runtimePolicy,
        modelConfigId: parsed.data.model_config_id,
        model: parsed.data.model,
      });
      if (rejection) return c.json(rejection.body, rejection.status);
      const effortRejection = agentEffortRejection(
        parsed.data.model_config_id ?? null,
        parsed.data.model ?? null,
        resolveAgentSdkEffort(runtimePolicy),
      );
      if (effortRejection) return c.json(effortRejection, 400);
      const conflict = findAgentProfileNameConflict(user.id, parsed.data.name);
      if (conflict) return c.json(agentNameTaken(conflict), 409);
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
        model: parsed.data.model,
        runtimePolicy,
      });
      return c.json({ profile }, 201);
    },
  );
});

/** Give a copy its own avatar file; a missing source file just goes without. */
function copyProfileAvatarFile(
  source: AgentProfile,
  targetProfileId: string,
): string | null {
  const filename = source.avatar_url?.startsWith(AVATAR_URL_PREFIX)
    ? path.basename(source.avatar_url)
    : null;
  if (!filename?.startsWith(avatarFilePrefix(source.id))) return null;
  try {
    const copy = newProfileAvatarFile(targetProfileId, path.extname(filename));
    fs.copyFileSync(
      path.join(AVATARS_DIR, filename),
      path.join(AVATARS_DIR, copy.filename),
    );
    return copy.url;
  } catch (err) {
    logger.warn(
      { err, agentProfileId: source.id },
      'Agent avatar file could not be copied',
    );
    return null;
  }
}

agentProfileRoutes.post('/:id/duplicate', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () => {
      const source = getAgentProfileForUser(id, user.id);
      if (!source) return c.json({ error: '智能体配置不存在' }, 404);
      if (source.is_default) {
        return c.json({ error: '内置 HappyClaw 不能复制' }, 400);
      }
      const { policy: granted, stripped } = stripHostGrants(
        source.runtime_policy,
        user.role === 'admin',
      );
      const policy = withRunnableEffort(
        granted,
        source.model_config_id,
        source.model,
      );
      const rejection = newProfileRejection(user, {
        runtimePolicy: policy,
        modelConfigId: source.model_config_id,
        model: source.model,
      });
      if (rejection) return c.json(rejection.body, rejection.status);
      const profileId = randomUUID();
      const profile = createAgentProfile({
        profileId,
        ownerUserId: user.id,
        name: nextCopyName(user.id, source.name),
        identityPrompt: source.identity_prompt,
        soulPrompt: source.soul_prompt,
        agentsPrompt: source.agents_prompt,
        toolsPrompt: source.tools_prompt,
        promptMode: source.prompt_mode,
        avatarEmoji: source.avatar_emoji,
        avatarColor: source.avatar_color,
        avatarUrl: copyProfileAvatarFile(source, profileId),
        modelConfigId: source.model_config_id,
        model: source.model,
        runtimePolicy: policy,
      });
      return c.json({ profile, stripped }, 201);
    },
  );
});

agentProfileRoutes.get('/:id/export', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const profile = getAgentProfileForUser(c.req.param('id'), user.id);
  if (!profile) return c.json({ error: '智能体配置不存在' }, 404);
  if (profile.is_default) {
    return c.json({ error: '内置 HappyClaw 不能导出' }, 400);
  }
  return c.json(buildAgentProfileExport(profile));
});

agentProfileRoutes.post('/import', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsedBody = AgentProfileImportSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json(invalidAgentProfileBody(parsedBody.error, body), 400);
  }
  const parsed = parseAgentProfileExport(parsedBody.data.data);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, code: parsed.code }, 400);
  }
  const { agent } = parsed;
  const name = parsedBody.data.name ?? agent.name;
  const imported = stripHostGrants(
    normalizeAgentProfileRuntimePolicy(agent.runtime_policy),
    user.role === 'admin',
  );
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    () => {
      const conflict = findAgentProfileNameConflict(user.id, name);
      if (conflict) return c.json(agentNameTaken(conflict), 409);
      // An admin keeps host grants, but only after seeing them: a file from
      // elsewhere must not quietly load ~/.claude or every host Skill.
      const hostGrants = hostGrantsOf(imported.policy);
      if (hostGrants.length > 0 && !parsedBody.data.confirm_host_grants) {
        return c.json(
          {
            error: '导入的智能体会使用宿主机资源，需要确认',
            code: 'AGENT_IMPORT_HOST_GRANTS',
            grants: hostGrants,
          },
          409,
        );
      }
      // Restricted system MCP already shows up as missing for a member.
      const { restricted_system_mcp: _restricted, ...missing } =
        validateRuntimePolicyReferences(
          user.id,
          imported.policy,
          user.role === 'admin',
        );
      const dropped = hasInvalidRuntimePolicyReferences(missing);
      if (dropped && !parsedBody.data.drop_missing) {
        return c.json(
          {
            error: '导入的智能体引用了当前账号没有的 Skills 或 MCP',
            code: 'AGENT_IMPORT_MISSING_REFERENCES',
            missing,
            stripped: imported.stripped,
          },
          409,
        );
      }
      const runtimePolicy = dropped
        ? dropMissingReferences(imported.policy, missing)
        : imported.policy;
      const rejection = newProfileRejection(user, { runtimePolicy });
      if (rejection) return c.json(rejection.body, rejection.status);
      const profile = createAgentProfile({
        ownerUserId: user.id,
        name,
        identityPrompt: agent.identity_prompt ?? '',
        soulPrompt: agent.soul_prompt ?? '',
        agentsPrompt: agent.agents_prompt ?? '',
        toolsPrompt: agent.tools_prompt ?? '',
        promptMode: agent.prompt_mode ?? 'append',
        avatarEmoji: agent.avatar_emoji ?? null,
        avatarColor: agent.avatar_color ?? null,
        runtimePolicy,
      });
      return c.json(
        {
          profile,
          stripped: imported.stripped,
          dropped: missing,
        },
        201,
      );
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
    return c.json(
      { error: message },
      err instanceof ClaudeProviderNotConfiguredError ? 503 : 502,
    );
  }
});

/**
 * The connection, model and effort a run of this Agent uses, and which step
 * of the order chose it (resolveModelBinding, the same function a launch
 * calls), for a session that picked nothing. With a Workspace its own
 * provider environment counts.
 */
function resolveAgentModelResolution(
  profile: Pick<
    AgentProfile,
    'model_config_id' | 'model' | 'owner_user_id' | 'runtime_policy'
  >,
  workspace?: RegisteredGroup,
) {
  const folder = workspace?.folder ?? '';
  const binding = resolveModelBinding(
    { modelConfigId: profile.model_config_id, model: profile.model },
    workspace ? { groupFolder: folder } : undefined,
    { ownerUserId: profile.owner_user_id, includeSession: false },
  );
  const summary = summarizeModelBinding(
    binding,
    folder,
    null,
    resolveAgentSdkEffort(profile.runtime_policy),
  );
  return {
    source: summary.source,
    model_config_id: summary.modelConfigId,
    model_config_name: summary.provider?.name ?? null,
    model: summary.model,
    effort: summary.effort,
    // The binding that decides names a connection that is gone or has no
    // credential: runs fail until it is chosen again.
    connection_missing: summary.connectionMissing,
  };
}

/**
 * The model binding a preview resolves: unsaved values in the request win,
 * like the unsaved policy does. A model belongs to its configuration, so a
 * new configuration without a model runs that configuration's default.
 */
function previewModelBinding(
  saved: Pick<AgentProfile, 'model_config_id' | 'model'>,
  body: Record<string, unknown>,
): Pick<AgentProfile, 'model_config_id' | 'model'> | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const valid = (value: unknown) =>
    value === null || (typeof value === 'string' && value.length <= 200);
  if (
    (has('model_config_id') && !valid(body.model_config_id)) ||
    (has('model') && !valid(body.model))
  ) {
    return null;
  }
  const modelConfigId = has('model_config_id')
    ? ((body.model_config_id as string | null) ?? null)
    : saved.model_config_id;
  const model = has('model')
    ? ((body.model as string | null) ?? null)
    : modelConfigId === saved.model_config_id
      ? saved.model
      : null;
  return {
    model_config_id: modelConfigId,
    model: modelConfigId ? model : null,
  };
}

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
    const modelBinding = previewModelBinding(existing, body);
    if (!modelBinding) return c.json({ error: 'Invalid model binding' }, 400);
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
      ownerRole: user.role === 'admin' ? 'admin' : 'member',
    });
    const runContext = workspace ? getRunContextSnapshot(workspace.jid) : null;
    return c.json({
      preview,
      model_resolution: resolveAgentModelResolution(
        {
          ...modelBinding,
          owner_user_id: existing.owner_user_id,
          runtime_policy: previewRuntimePolicy,
        },
        workspace?.group,
      ),
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
    const { filename, url: avatarUrl } = newProfileAvatarFile(id, extension);
    const destination = path.join(AVATARS_DIR, filename);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()));
    fs.renameSync(temporary, destination);
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
    return c.json(
      { error: message },
      err instanceof ClaudeProviderNotConfiguredError ? 503 : 502,
    );
  }
});

agentProfileRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(invalidAgentProfileBody(parsed.error, body), 400);
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
    parsed.data.model === undefined &&
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
        // Only a rename is checked; names that already collide stay as-is.
        if (
          parsed.data.name !== undefined &&
          parsed.data.name !== existing.name
        ) {
          const conflict = findAgentProfileNameConflict(
            user.id,
            parsed.data.name,
            id,
          );
          if (conflict) return c.json(agentNameTaken(conflict), 409);
        }
        if (
          parsed.data.model_config_id &&
          !modelConfigExists(parsed.data.model_config_id)
        ) {
          return c.json({ error: '所选模型配置不存在' }, 400);
        }
        // A model is checked against the configuration it will belong to:
        // the one this request names, else the Agent's current one.
        if (parsed.data.model) {
          const rejection = agentModelRejection(
            parsed.data.model_config_id === undefined
              ? existing.model_config_id
              : parsed.data.model_config_id,
            parsed.data.model,
          );
          if (rejection) return c.json(rejection, 400);
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
        // The effort is judged with the binding it will run on, whenever
        // this request touches either.
        if (
          parsed.data.model_config_id !== undefined ||
          parsed.data.model !== undefined ||
          parsed.data.runtime_policy?.reasoning !== undefined
        ) {
          const nextModelConfigId =
            parsed.data.model_config_id === undefined
              ? existing.model_config_id
              : parsed.data.model_config_id;
          const nextModel =
            parsed.data.model !== undefined
              ? parsed.data.model
              : nextModelConfigId === existing.model_config_id
                ? existing.model
                : null;
          const effortRejection = agentEffortRejection(
            nextModelConfigId,
            nextModel,
            resolveAgentSdkEffort(effectiveRuntimePolicy),
          );
          if (effortRejection) return c.json(effortRejection, 400);
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
            parsed.data.model_config_id !== existing.model_config_id) ||
          (parsed.data.model !== undefined &&
            (parsed.data.model ?? null) !== existing.model);

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
            model: parsed.data.model,
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

const ARCHIVE_REFUSALS = {
  not_found: { status: 404, error: '智能体配置不存在' },
  is_default: { status: 400, error: '不能删除内置的 HappyClaw 智能体' },
  has_workspaces: {
    status: 409,
    error: '该智能体仍拥有工作区；请先迁移或删除这些工作区',
  },
  has_mounts: {
    status: 409,
    error: '该智能体仍有消息渠道挂载；请先解绑',
  },
} as const;

agentProfileRoutes.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withAgentProfileLocks([id], () => {
    // Target-profile validation in create/migrate is repeated under this same
    // lock, so either archive wins and publication is rejected, or membership
    // wins and archive observes the mapping and returns 409.
    const result = archiveAgentProfile(id, user.id);
    if (result !== 'ok') {
      const refusal = ARCHIVE_REFUSALS[result];
      return c.json({ error: refusal.error }, refusal.status);
    }
    return c.json({ success: true });
  });
});

class AgentProfileMigrateRefusedError extends Error {
  constructor(
    readonly reason: Exclude<
      ReturnType<typeof migrateAgentProfileWorkspacesAndArchive>,
      'ok'
    >,
  ) {
    super(`Agent profile migration refused: ${reason}`);
    this.name = 'AgentProfileMigrateRefusedError';
  }
}

/**
 * Move every Workspace of an Agent to another Agent and archive it, all or
 * nothing: the Workspaces' runners are stopped around one transaction that
 * either moves them all and archives the Agent or changes nothing.
 */
agentProfileRoutes.post(
  '/:id/migrate-and-delete',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentProfileMigrateAndDeleteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
    const targetId = parsed.data.target_agent_profile_id;
    if (targetId === id) {
      return c.json({ error: '目标智能体不能是要删除的智能体' }, 400);
    }
    return withAgentProfileLocks([id, targetId], async () => {
      const source = getAgentProfileForUser(id, user.id);
      if (!source) return c.json({ error: '智能体配置不存在' }, 404);
      if (source.is_default) {
        return c.json({ error: ARCHIVE_REFUSALS.is_default.error }, 400);
      }
      if (!getAgentProfileForUser(targetId, user.id)) {
        return c.json({ error: '目标智能体不存在' }, 404);
      }
      // Membership changes for both Agents hold these locks, so the list
      // cannot grow; Workspace deletion does not, so the commit re-reads it.
      const workspaces = listWorkspaceGroupsForAgentProfile(user.id, id);
      const commit = () => {
        const outcome = migrateAgentProfileWorkspacesAndArchive(
          id,
          user.id,
          targetId,
          listWorkspaceGroupsForAgentProfile(user.id, id).map(
            (workspace) => workspace.group.folder,
          ),
        );
        // Throw when the transaction rolled back so quiesceWorkspaceRunnersAroundCommit
        // skips its post-commit stop pass, never invokes onPostCommitFailure, and
        // never reports persisted:true for an aborted migration.
        if (outcome !== 'ok') {
          throw new AgentProfileMigrateRefusedError(outcome);
        }
        return outcome;
      };
      const deps = getWebDeps();
      let result: ReturnType<typeof migrateAgentProfileWorkspacesAndArchive>;
      let invalidatedRuntimeJids = 0;
      try {
        if (!deps || workspaces.length === 0) {
          result = commit();
        } else {
          const quiesced = await quiesceWorkspaceRunnersAroundCommit(
            deps,
            workspaces.map((workspace) => ({
              folder: workspace.group.folder,
              primaryJid: workspace.jid,
            })),
            {
              reason: `Agent profile ${id} migrated to ${targetId} and archived`,
              onPostCommitFailure: (runtimeJids) =>
                deps.queue.blockGroupsForRuntimeSafety?.(
                  runtimeJids,
                  `Agent profile ${id} migration cleanup failed after commit`,
                ),
            },
            commit,
          );
          result = quiesced.value;
          invalidatedRuntimeJids = quiesced.runtimeJids.length;
          deps.queue.unblockGroupsForRuntimeSafety?.(quiesced.runtimeJids);
        }
      } catch (err) {
        if (err instanceof AgentProfileMigrateRefusedError) {
          result = err.reason;
        } else {
          if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
          logger.error(
            { err, agentProfileId: id, persisted: err.persisted },
            err.persisted
              ? 'Agent profile migrated and archived but runtime cleanup failed'
              : 'Agent profile migration aborted before persistence',
          );
          return c.json(
            {
              error: err.persisted
                ? '工作区已迁移且智能体已删除，但运行时清理失败；请在目标智能体页面重试清理'
                : '无法停止活动工作区；没有迁移任何工作区，智能体未删除',
              persisted: err.persisted,
              retryable: !err.persisted,
            },
            503,
          );
        }
      }
      if (result === 'has_workspaces') {
        // A mapping the owner cannot see (e.g. another user's Workspace).
        return c.json(
          { error: '该智能体还有无法迁移的工作区归属；没有迁移任何工作区' },
          409,
        );
      }
      if (result !== 'ok') {
        const refusal = ARCHIVE_REFUSALS[result];
        return c.json({ error: refusal.error }, refusal.status);
      }
      return c.json({
        success: true,
        migrated_workspaces: workspaces.length,
        invalidated_runtime_jids: invalidatedRuntimeJids,
      });
    });
  },
);

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
        const runtimeJids = collectWorkspaceRuntimeJids(deps, targets);
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

/**
 * Runtimes mid-turn or with queued input: what a save that restarts the
 * Agent's runners would interrupt. A warm runner only waiting for input is
 * not counted.
 */
function busyRuntimeJids(deps: WebDeps): Set<string> {
  return new Set(
    deps.queue
      .getStatus()
      .groups.filter(
        (group) =>
          group.queryInFlight ||
          group.pendingMessages ||
          group.pendingTasks > 0,
      )
      .map((group) => group.jid),
  );
}

agentProfileRoutes.get('/:id/workspaces', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  return withAgentProfileLocks([id], () => {
    const profile = getAgentProfileForUser(id, user.id);
    if (!profile) return c.json({ error: '智能体配置不存在' }, 404);

    const defaultProfile = getOrCreateDefaultAgentProfile(user.id);
    const deps = getWebDeps();
    const busy = deps ? busyRuntimeJids(deps) : new Set<string>();
    const owned = Object.entries(getAllRegisteredGroups())
      .filter(([jid, group]) => {
        if (!jid.startsWith('web:')) return false;
        if (group.created_by !== user.id) return false;
        const mapped =
          getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id;
        return mapped === id;
      })
      .map(([jid, group]) => ({
        jid,
        group,
        runtimeJids: deps
          ? getWorkspaceRuntimeJids(deps, group.folder, jid)
          : [],
      }));
    const workspaces = owned.map(({ jid, group, runtimeJids }) => ({
      jid,
      name: group.name,
      folder: group.folder,
      is_home: !!group.is_home,
      execution_mode: group.executionMode ?? 'container',
      added_at: group.added_at,
      active_conversations: runtimeJids.filter((runtimeJid) =>
        busy.has(runtimeJid),
      ).length,
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
    const runtimeCleanupPending =
      deps != null &&
      owned.some(({ runtimeJids }) =>
        runtimeJids.some(
          (jid) => deps.queue.isGroupRuntimeSafetyBlocked?.(jid) ?? false,
        ),
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
