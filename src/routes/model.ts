import { Hono } from 'hono';
import { z } from 'zod';

import { authMiddleware, requirePermission } from '../middleware/auth.js';
import type {
  AuthUser,
  ModelBinding,
  ModelSelectionKind,
  ProviderPoolModelOption,
  RegisteredGroup,
} from '../types.js';
import {
  ensureConversationRuntimeState,
  ensureWorkspaceModelDefault,
  getConversationRuntimeState,
  getJidsByFolder,
  getProviderPool,
  getProviderPools,
  getRegisteredGroup,
  getSystemModelDefault,
  listProviderPoolModelOptions,
  setConversationRuntimeBinding,
  setSystemModelDefault,
  setWorkspaceModelDefault,
  upsertProviderPoolModelOption,
} from '../db.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import { logger } from '../logger.js';
import type { Variables } from '../web-context.js';

const modelRoutes = new Hono<{ Variables: Variables }>();

const ModelKindSchema = z.enum([
  'provider_default',
  'runtime_default',
  'alias',
  'explicit_version',
  'custom',
]);

const ModelBindingInputSchema = z.object({
  providerPoolId: z.string().min(1),
  model: z.string().trim().min(1).nullable().optional(),
  modelKind: ModelKindSchema.optional(),
});

const PoolOptionInputSchema = z.object({
  modelId: z.string().trim().min(1),
  modelKind: ModelKindSchema.default('custom'),
  displayName: z.string().trim().min(1).nullable().optional(),
  status: z
    .enum(['available', 'unverified', 'unsupported', 'stale', 'hidden'])
    .default('unverified'),
  metadataJson: z.string().nullable().optional(),
});

interface CanonicalWorkspace {
  jid: string;
  group: RegisteredGroup & { jid: string };
  folder: string;
  ownerId: string;
}

function withJid(
  jid: string,
  group: RegisteredGroup,
): RegisteredGroup & { jid: string } {
  return { ...group, jid };
}

function resolveCanonicalWorkspace(
  workspaceJid: string,
): CanonicalWorkspace | { error: string; status: 400 | 404 | 409 } {
  const group = getRegisteredGroup(workspaceJid);
  if (!group) return { error: 'Workspace not found', status: 404 };
  if (!workspaceJid.startsWith('web:')) {
    return {
      error: 'Model mutation requires a canonical web workspace JID',
      status: 400,
    };
  }
  if (!group.created_by) {
    return {
      error:
        'Workspace owner is missing; repair legacy workspace ownership first',
      status: 409,
    };
  }

  const ownerIds = new Set<string>();
  for (const jid of getJidsByFolder(group.folder)) {
    const sibling = getRegisteredGroup(jid);
    if (sibling?.created_by) ownerIds.add(sibling.created_by);
  }
  if (ownerIds.size > 1) {
    return {
      error:
        'Workspace folder has ambiguous owners; repair before changing model',
      status: 409,
    };
  }

  return {
    jid: workspaceJid,
    group: withJid(workspaceJid, group),
    folder: group.folder,
    ownerId: group.created_by,
  };
}

function parseBindingInput(input: z.infer<typeof ModelBindingInputSchema>): {
  binding?: ModelBinding;
  error?: string;
} {
  const pool = getProviderPool(input.providerPoolId);
  if (!pool) return { error: `Unknown provider pool: ${input.providerPoolId}` };
  if (!pool.enabled)
    return { error: `Provider pool is disabled: ${input.providerPoolId}` };

  const selectedModel =
    input.model && input.model !== 'default' ? input.model : null;
  let modelKind: ModelSelectionKind =
    input.modelKind ?? (selectedModel ? 'custom' : 'provider_default');
  let resolvedModel: string | null = null;

  if (selectedModel) {
    const options = listProviderPoolModelOptions(input.providerPoolId, true);
    const option = input.modelKind
      ? options.find(
          (item) =>
            item.model_id === selectedModel && item.model_kind === modelKind,
        )
      : options.find(
          (item) => item.model_id === selectedModel && item.status !== 'hidden',
        );
    if (!option || option.status === 'hidden') {
      return {
        error:
          `Model ${selectedModel} is not configured for pool ${input.providerPoolId}. ` +
          'Configure it in the pool model catalog first.',
      };
    }
    if (option.status === 'unsupported') {
      return {
        error: `Model ${selectedModel} is marked unsupported for pool ${input.providerPoolId}`,
      };
    }
    modelKind = option.model_kind;
    resolvedModel = resolvedModelFromOption(option);
  }

  return {
    binding: {
      runtime: pool.runtime,
      provider_family: pool.provider_family,
      provider_pool_id: pool.provider_pool_id,
      selected_model: selectedModel,
      model_kind: modelKind,
      resolved_model: resolvedModel,
    },
  };
}

function resolvedModelFromOption(option?: ProviderPoolModelOption): string | null {
  if (!option?.metadata_json) return null;
  try {
    const metadata = JSON.parse(option.metadata_json) as Record<string, unknown>;
    const resolved = metadata.resolved_model ?? metadata.resolvedModel;
    return typeof resolved === 'string' && resolved.trim()
      ? resolved.trim()
      : null;
  } catch {
    return null;
  }
}

function assertWorkspaceAccess(
  user: AuthUser,
  workspace: CanonicalWorkspace,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (!canAccessGroup(user, workspace.group)) {
    return { ok: false, status: 403, error: 'Access denied' };
  }
  return { ok: true };
}

function assertWorkspaceOwner(
  user: AuthUser,
  workspace: CanonicalWorkspace,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (!canModifyGroup(user, workspace.group)) {
    return {
      ok: false,
      status: 403,
      error: 'Only the workspace owner can change model settings',
    };
  }
  return { ok: true };
}

modelRoutes.get('/pools', authMiddleware, (c) => {
  const includeAll = c.req.query('includeAll') === 'true';
  return c.json({
    pools: getProviderPools(),
    options: listProviderPoolModelOptions(undefined, includeAll),
  });
});

modelRoutes.put(
  '/pools/:providerPoolId/options',
  authMiddleware,
  requirePermission('manage_system_config'),
  async (c) => {
    const providerPoolId = c.req.param('providerPoolId');
    const body = await c.req.json().catch(() => ({}));
    const validation = PoolOptionInputSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const pool = getProviderPool(providerPoolId);
    if (!pool) return c.json({ error: 'Provider pool not found' }, 404);

    const user = c.get('user') as AuthUser;
    const saved = upsertProviderPoolModelOption({
      runtime: pool.runtime,
      provider_family: pool.provider_family,
      provider_pool_id: pool.provider_pool_id,
      model_id: validation.data.modelId,
      model_kind: validation.data.modelKind,
      display_name: validation.data.displayName ?? null,
      source: 'admin_configured',
      status: validation.data.status,
      metadata_json: validation.data.metadataJson ?? null,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    });

    return c.json({ option: saved });
  },
);

modelRoutes.get('/system/default', authMiddleware, (c) => {
  return c.json({ default: getSystemModelDefault() });
});

modelRoutes.put(
  '/system/default',
  authMiddleware,
  requirePermission('manage_system_config'),
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ModelBindingInputSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }
    const parsed = parseBindingInput(validation.data);
    if (!parsed.binding) return c.json({ error: parsed.error }, 400);
    const user = c.get('user') as AuthUser;
    return c.json({ default: setSystemModelDefault(parsed.binding, user.id) });
  },
);

modelRoutes.get('/workspaces/:workspaceJid', authMiddleware, (c) => {
  const workspace = resolveCanonicalWorkspace(c.req.param('workspaceJid'));
  if ('error' in workspace)
    return c.json({ error: workspace.error }, workspace.status);
  const user = c.get('user') as AuthUser;
  const access = assertWorkspaceAccess(user, workspace);
  if (!access.ok) return c.json({ error: access.error }, access.status);

  const agentId = c.req.query('agentId') || '';
  return c.json({
    workspace: {
      jid: workspace.jid,
      folder: workspace.folder,
      ownerId: workspace.ownerId,
    },
    systemDefault: getSystemModelDefault(),
    workspaceDefault: ensureWorkspaceModelDefault(workspace.folder, user.id),
    scope: ensureConversationRuntimeState(workspace.folder, agentId, user.id),
    pools: getProviderPools(),
    options: listProviderPoolModelOptions(undefined, false),
  });
});

modelRoutes.put(
  '/workspaces/:workspaceJid/default',
  authMiddleware,
  async (c) => {
    const workspace = resolveCanonicalWorkspace(c.req.param('workspaceJid'));
    if ('error' in workspace)
      return c.json({ error: workspace.error }, workspace.status);
    const user = c.get('user') as AuthUser;
    const owner = assertWorkspaceOwner(user, workspace);
    if (!owner.ok) return c.json({ error: owner.error }, owner.status);

    const body = await c.req.json().catch(() => ({}));
    const validation = ModelBindingInputSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }
    const parsed = parseBindingInput(validation.data);
    if (!parsed.binding) return c.json({ error: parsed.error }, 400);

    const workspaceDefault = setWorkspaceModelDefault(
      workspace.folder,
      parsed.binding,
      user.id,
    );
    const mainState = getConversationRuntimeState(workspace.folder, '');
    let updatedMain = mainState;
    if (!mainState || mainState.binding_source === 'workspace_default') {
      updatedMain = setConversationRuntimeBinding(
        workspace.folder,
        '',
      parsed.binding,
      'workspace_default',
      user.id,
      { markPending: true },
    );
  }

    return c.json({ workspaceDefault, mainScope: updatedMain });
  },
);

async function setScopeBindingForWorkspace(
  c: any,
  workspaceJid: string,
  agentId: string,
) {
  const workspace = resolveCanonicalWorkspace(workspaceJid);
  if ('error' in workspace)
    return c.json({ error: workspace.error }, workspace.status);
  const user = c.get('user') as AuthUser;
  const owner = assertWorkspaceOwner(user, workspace);
  if (!owner.ok) return c.json({ error: owner.error }, owner.status);

  const body = await c.req.json().catch(() => ({}));
  const validation = ModelBindingInputSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  const parsed = parseBindingInput(validation.data);
  if (!parsed.binding) return c.json({ error: parsed.error }, 400);

  const scope = setConversationRuntimeBinding(
    workspace.folder,
    agentId,
    parsed.binding,
    'user_pinned',
    user.id,
    { markPending: true },
  );
  return c.json({ scope });
}

modelRoutes.put('/workspaces/:workspaceJid/scopes/main', authMiddleware, (c) =>
  setScopeBindingForWorkspace(c, c.req.param('workspaceJid'), ''),
);

modelRoutes.put(
  '/workspaces/:workspaceJid/agents/:agentId/model',
  authMiddleware,
  (c) =>
    setScopeBindingForWorkspace(
      c,
      c.req.param('workspaceJid'),
      c.req.param('agentId'),
    ),
);

modelRoutes.put('/scopes/:groupFolder', authMiddleware, async (c) => {
  const groupFolder = c.req.param('groupFolder');
  const webJids = getJidsByFolder(groupFolder).filter((jid) =>
    jid.startsWith('web:'),
  );
  if (webJids.length !== 1) {
    return c.json(
      { error: 'Legacy folder route is ambiguous; use workspaceJid route' },
      409,
    );
  }
  try {
    return await setScopeBindingForWorkspace(c, webJids[0], '');
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Legacy model scope route failed');
    return c.json({ error: 'Failed to set model scope' }, 500);
  }
});

export default modelRoutes;
