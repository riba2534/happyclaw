// MCP Servers management routes

import { Hono } from 'hono';
import fs from 'fs/promises';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkMcpServerLimit } from '../billing.js';
import {
  getAllUsers,
  listAgentProfilesForUser,
  recordAuthAuditLog,
} from '../db.js';
import { getEffectiveExternalDir } from '../runtime-config.js';
import { loadHostClaudeMcpServers } from '../mcp-context.js';
import {
  getUserMcpSecretsFilePath,
  getUserMcpServersDir,
  getUserMcpServersFilePath,
  readStoredUserMcpServers,
  type StoredMcpServerDefinition,
  type StoredMcpServerSecrets,
  type StoredMcpServersFile,
  type StoredMcpSecretsFile,
  type ManagedMcpScope,
  type McpMemberAccess,
} from '../mcp-utils.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import {
  CapabilityRuntimeCommitError,
  mutateCapabilityAroundRuntimeQuiesce,
  repairCapabilityRuntimeSafetyBlock,
  type CapabilityMutationImpact,
} from '../capability-runtime-mutation.js';
import { WorkspaceRuntimeQuiesceError } from '../agent-profile-runtime.js';

// --- Types ---

type McpServerEntry = StoredMcpServerDefinition;
type McpServersFile = StoredMcpServersFile;
type McpSecretsFile = StoredMcpSecretsFile;

// --- Utility Functions ---

function validateServerId(id: string): boolean {
  // Length cap mirrors MAX_MCP_KEY_LEN (256) — id is the JSON object key
  // inside servers.json, an unbounded length there can balloon the file
  // into multi-MB and slow every container spawn that JSON.parses it.
  return (
    id.length > 0 &&
    id.length <= 256 &&
    /^[\w\-]+$/.test(id) &&
    id !== 'happyclaw'
  );
}

async function readMcpServersFile(userId: string): Promise<{
  definitions: McpServersFile;
  secrets: McpSecretsFile;
}> {
  return readStoredUserMcpServers(userId);
}

async function writeMcpServersFile(
  userId: string,
  definitions: McpServersFile,
  secrets: McpSecretsFile,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const definitionPath = getUserMcpServersFilePath(userId);
  const secretPath = getUserMcpSecretsFilePath(userId);
  const suffix = `${process.pid}.${Date.now()}.tmp`;
  const definitionTmp = `${definitionPath}.${suffix}`;
  const secretTmp = `${secretPath}.${suffix}`;
  try {
    await fs.writeFile(
      definitionTmp,
      `${JSON.stringify(definitions, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(secretTmp, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(secretTmp, secretPath);
    await fs.rename(definitionTmp, definitionPath);
    await Promise.all([
      fs.chmod(definitionPath, 0o600),
      fs.chmod(secretPath, 0o600),
    ]);
  } finally {
    await Promise.all([
      fs.rm(definitionTmp, { force: true }),
      fs.rm(secretTmp, { force: true }),
    ]);
  }
}

// --- Routes ---

// 单个 MCP server 字段上限：避免认证用户用一个深度对象 / 巨型 args 把
// data/mcp-servers/{userId}/servers.json 撑成多 MB（每次容器启动会 JSON.parse
// 整个文件，OOM-class 退化）。配额同 ContainerEnvSchema 的口径。
const MAX_MCP_STRING_LEN = 4096;
const MAX_MCP_ARG_LEN = 2048;
const MAX_MCP_ARGS = 50;
const MAX_MCP_ENV_ENTRIES = 50;
const MAX_MCP_HEADERS = 50;
const MAX_MCP_KEY_LEN = 256;

function validateMcpStringArrayLikeArgs(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(value))
    return { ok: false, reason: 'args must be an array of strings' };
  if (value.length > MAX_MCP_ARGS)
    return {
      ok: false,
      reason: `args has too many entries (max ${MAX_MCP_ARGS})`,
    };
  for (const v of value) {
    if (typeof v !== 'string')
      return { ok: false, reason: 'args entries must be strings' };
    if (v.length > MAX_MCP_ARG_LEN)
      return {
        ok: false,
        reason: `args entry exceeds ${MAX_MCP_ARG_LEN} chars`,
      };
  }
  return { ok: true };
}

function validateMcpKeyValueRecord(
  value: unknown,
  fieldName: string,
  maxEntries: number,
): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${fieldName} must be a plain object` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEntries) {
    return {
      ok: false,
      reason: `${fieldName} has too many entries (max ${maxEntries})`,
    };
  }
  for (const [k, v] of entries) {
    if (k.length > MAX_MCP_KEY_LEN) {
      return {
        ok: false,
        reason: `${fieldName} key exceeds ${MAX_MCP_KEY_LEN} chars`,
      };
    }
    if (typeof v !== 'string') {
      return {
        ok: false,
        reason: `${fieldName} value for "${k}" must be a string`,
      };
    }
    if (v.length > MAX_MCP_STRING_LEN) {
      return {
        ok: false,
        reason: `${fieldName} value for "${k}" exceeds ${MAX_MCP_STRING_LEN} chars`,
      };
    }
  }
  return { ok: true };
}

const mcpServersRoutes = new Hono<{ Variables: Variables }>();

function requestedScope(value: unknown): ManagedMcpScope | null {
  if (value === undefined || value === null || value === '') return 'user';
  return value === 'system' || value === 'user' ? value : null;
}

function scopeOwnerId(scope: ManagedMcpScope, userId: string): string {
  return scope === 'system' ? 'system' : userId;
}

function canMutateScope(user: AuthUser, scope: ManagedMcpScope): boolean {
  return scope === 'user' || user.role === 'admin';
}

function isMcpMemberAccess(value: unknown): value is McpMemberAccess {
  return value === 'admin_only' || value === 'shared';
}

function mcpMutationImpact(
  userId: string,
  scope: ManagedMcpScope,
  ids?: string[],
): CapabilityMutationImpact {
  return { kind: 'mcp', ownerUserId: userId, scope, ids };
}

function runtimeMutationFailure(error: unknown, action: string) {
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

async function repairPreviousMcpCleanup(
  userId: string,
  scope: ManagedMcpScope,
  ids: string[] | undefined,
  action: string,
): Promise<number> {
  return repairCapabilityRuntimeSafetyBlock(
    mcpMutationImpact(userId, scope, ids),
    action,
  );
}

// All managed MCP mutations share the same scope locks as Agent policy
// validation/commit. Locking system + current user also makes cross-scope name
// collisions deterministic for list/update operations.
mcpServersRoutes.use('*', authMiddleware, async (c, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(c.req.method)) return next();
  const user = c.get('user') as AuthUser;
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(user.id)],
    next,
  );
});

function toMcpServerSummary(
  id: string,
  entry: McpServerEntry,
  secrets?: StoredMcpServerSecrets,
  source: ManagedMcpScope = 'user',
  readonly = false,
) {
  const hasEnvSecrets = Object.keys(secrets?.env ?? {}).length > 0;
  const hasHeaderSecrets = Object.keys(secrets?.headers ?? {}).length > 0;
  const memberAccess: McpMemberAccess | undefined =
    source === 'system'
      ? entry.memberAccess === 'shared'
        ? 'shared'
        : 'admin_only'
      : undefined;
  const systemMemberView = source === 'system' && readonly;
  const runtimeAvailable =
    source !== 'system' || !readonly || memberAccess === 'shared';
  const { memberAccess: _storedMemberAccess, ...definition } = entry;
  const visibleDefinition =
    systemMemberView && memberAccess === 'admin_only'
      ? {
          enabled: definition.enabled,
          ...(definition.type ? { type: definition.type } : {}),
          ...(definition.importedFromHost ? { importedFromHost: true } : {}),
          ...(definition.syncedFromHost ? { syncedFromHost: true } : {}),
          addedAt: definition.addedAt,
        }
      : definition;
  return {
    id,
    source,
    sourceKey: `${source}:${id}`,
    readonly,
    ...visibleDefinition,
    ...(memberAccess ? { memberAccess } : {}),
    // System secret key names stay inside the administrator boundary even
    // when the server is explicitly shared for member Agent runtimes.
    envKeys: systemMemberView ? [] : Object.keys(secrets?.env ?? {}),
    headerKeys: systemMemberView ? [] : Object.keys(secrets?.headers ?? {}),
    hasEnvSecrets,
    hasHeaderSecrets,
    runtimeAvailable,
    ...(!runtimeAvailable
      ? { unavailableReason: 'system_admin_only' as const }
      : {}),
  };
}

function referencedByCustomMcpProfiles(
  userId: string,
  id: string,
  scope: ManagedMcpScope,
): string[] {
  const userIds =
    scope === 'system' ? getAllUsers().map((user) => user.id) : [userId];
  return userIds.flatMap((ownerId) =>
    listAgentProfilesForUser(ownerId)
      .filter((profile) => {
        if (profile.runtime_policy.mcp.mode !== 'custom') return false;
        return profile.runtime_policy.mcp.ids.some((reference) =>
          scope === 'system'
            ? reference === `system:${id}`
            : reference === id || reference === `user:${id}`,
        );
      })
      .map((profile) => profile.name),
  );
}

// GET / — list all MCP servers for the current user
mcpServersRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const [systemStore, userStore] = await Promise.all([
    readMcpServersFile('system'),
    readMcpServersFile(authUser.id),
  ]);
  const servers = [
    ...Object.entries(systemStore.definitions.servers).map(([id, entry]) =>
      toMcpServerSummary(
        id,
        entry,
        systemStore.secrets.servers[id],
        'system',
        authUser.role !== 'admin',
      ),
    ),
    ...Object.entries(userStore.definitions.servers).map(([id, entry]) =>
      toMcpServerSummary(id, entry, userStore.secrets.servers[id], 'user'),
    ),
  ];
  return c.json({ servers });
});

// GET /:id — load one server definition. Secret values are never returned.
mcpServersRoutes.get('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }
  const scope = requestedScope(c.req.query('source'));
  if (!scope) return c.json({ error: 'Invalid MCP source' }, 400);

  const store = await readMcpServersFile(scopeOwnerId(scope, authUser.id));
  const entry = store.definitions.servers[id];
  if (!entry) return c.json({ error: 'Server not found' }, 404);
  return c.json({
    server: toMcpServerSummary(
      id,
      entry,
      store.secrets.servers[id],
      scope,
      scope === 'system' && authUser.role !== 'admin',
    ),
  });
});

// POST / — add a new MCP server
mcpServersRoutes.post('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const {
    id,
    command,
    args,
    env,
    description,
    type,
    url,
    headers,
    scope: rawScope,
    memberAccess,
  } = body as {
    id?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
    type?: string;
    url?: string;
    headers?: Record<string, string>;
    scope?: string;
    memberAccess?: McpMemberAccess;
  };
  const scope = requestedScope(rawScope);
  if (!scope) return c.json({ error: 'Invalid MCP scope' }, 400);
  if (!canMutateScope(authUser, scope)) {
    return c.json({ error: 'Only admin can manage system MCP servers' }, 403);
  }
  if (memberAccess !== undefined && !isMcpMemberAccess(memberAccess)) {
    return c.json(
      { error: 'memberAccess must be "admin_only" or "shared"' },
      400,
    );
  }
  if (scope === 'user' && memberAccess !== undefined) {
    return c.json(
      { error: 'memberAccess is only valid for system MCP servers' },
      400,
    );
  }
  const ownerId = scopeOwnerId(scope, authUser.id);

  if (!id || typeof id !== 'string') {
    return c.json({ error: 'id is required and must be a string' }, 400);
  }
  if (!validateServerId(id)) {
    return c.json(
      {
        error:
          'Invalid server ID: must match /^[\\w\\-]+$/ and cannot be "happyclaw"',
      },
      400,
    );
  }

  try {
    await repairPreviousMcpCleanup(authUser.id, scope, [id], 'Create MCP');
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP creation cleanup');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  // Billing: check MCP server limit
  const existingStore = await readMcpServersFile(ownerId);
  const currentCount = Object.keys(existingStore.definitions.servers).length;
  if (scope === 'user' && !existingStore.definitions.servers[id]) {
    // Only check limit for new servers, not updates
    const limit = checkMcpServerLimit(authUser.id, authUser.role, currentCount);
    if (!limit.allowed) {
      return c.json({ error: limit.reason }, 403);
    }
  }

  const isHttpType = type === 'http' || type === 'sse';

  if (isHttpType) {
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required for http/sse type' }, 400);
    }
    if (url.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `url exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    if (headers !== undefined) {
      const r = validateMcpKeyValueRecord(headers, 'headers', MAX_MCP_HEADERS);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  } else {
    if (!command || typeof command !== 'string') {
      return c.json({ error: 'command is required and must be a string' }, 400);
    }
    if (command.length > MAX_MCP_STRING_LEN) {
      return c.json(
        { error: `command exceeds ${MAX_MCP_STRING_LEN} chars` },
        400,
      );
    }
    if (args !== undefined) {
      const r = validateMcpStringArrayLikeArgs(args);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
    if (env !== undefined) {
      const r = validateMcpKeyValueRecord(env, 'env', MAX_MCP_ENV_ENTRIES);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  }
  if (description !== undefined) {
    if (typeof description !== 'string') {
      return c.json({ error: 'description must be a string' }, 400);
    }
    if (description.length > MAX_MCP_STRING_LEN) {
      return c.json(
        { error: `description exceeds ${MAX_MCP_STRING_LEN} chars` },
        400,
      );
    }
  }

  const store = await readMcpServersFile(ownerId);
  if (store.definitions.servers[id]) {
    return c.json({ error: `Server "${id}" already exists` }, 409);
  }

  const entry: McpServerEntry = {
    enabled: true,
    ...(description ? { description } : {}),
    ...(scope === 'system'
      ? { memberAccess: memberAccess ?? 'admin_only' }
      : {}),
    addedAt: new Date().toISOString(),
  };

  if (isHttpType) {
    entry.type = type as 'http' | 'sse';
    entry.url = url;
  } else {
    entry.command = command;
    if (args && args.length > 0) entry.args = args;
  }

  store.definitions.servers[id] = entry;
  const secretEntry: StoredMcpServerSecrets = {};
  if (env && Object.keys(env).length > 0) secretEntry.env = env;
  if (headers && Object.keys(headers).length > 0) secretEntry.headers = headers;
  if (secretEntry.env || secretEntry.headers) {
    store.secrets.servers[id] = secretEntry;
  }

  let invalidatedRuntimeJids = 0;
  try {
    invalidatedRuntimeJids = (
      await mutateCapabilityAroundRuntimeQuiesce(
        mcpMutationImpact(authUser.id, scope, [id]),
        `MCP ${scope}:${id} created`,
        () => writeMcpServersFile(ownerId, store.definitions, store.secrets),
      )
    ).invalidatedRuntimeJids;
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP creation');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  try {
    if (scope === 'system' && memberAccess !== undefined) {
      recordAuthAuditLog({
        event_type: 'mcp_shared',
        username: authUser.username,
        actor_username: authUser.username,
        ip_address: c.req.header('x-forwarded-for') || null,
        user_agent: c.req.header('user-agent') || null,
        details: {
          targetId: id,
          scope,
          action: 'created',
          memberAccess: memberAccess ?? 'admin_only',
          runtimeResult: {
            success: true,
            invalidatedJids: invalidatedRuntimeJids,
          },
        },
      });
    }
    if (
      (env && Object.keys(env).length > 0) ||
      (headers && Object.keys(headers).length > 0)
    ) {
      recordAuthAuditLog({
        event_type: 'mcp_credential_updated',
        username: authUser.username,
        actor_username: authUser.username,
        ip_address: c.req.header('x-forwarded-for') || null,
        user_agent: c.req.header('user-agent') || null,
        details: {
          targetId: id,
          scope,
          action: 'created_with_credentials',
          sanitizedChanges: {
            envKeys: Object.keys(env ?? {}),
            headerKeys: Object.keys(headers ?? {}),
          },
          runtimeResult: {
            success: true,
            invalidatedJids: invalidatedRuntimeJids,
          },
        },
      });
    }
  } catch {}

  return c.json({
    success: true,
    invalidated_runtime_jids: invalidatedRuntimeJids,
    server: toMcpServerSummary(
      id,
      store.definitions.servers[id],
      store.secrets.servers[id],
      scope,
    ),
  });
});

// PATCH /:id — update config / enable / disable
mcpServersRoutes.patch('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }
  const scope = requestedScope(c.req.query('source'));
  if (!scope) return c.json({ error: 'Invalid MCP source' }, 400);
  if (!canMutateScope(authUser, scope)) {
    return c.json({ error: 'Only admin can manage system MCP servers' }, 403);
  }
  const ownerId = scopeOwnerId(scope, authUser.id);

  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const {
    command,
    args,
    env,
    enabled,
    description,
    url,
    headers,
    memberAccess,
  } = body as {
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    enabled?: boolean;
    description?: string | null;
    url?: string;
    headers?: Record<string, string> | null;
    memberAccess?: McpMemberAccess;
  };

  if (Object.prototype.hasOwnProperty.call(body, 'memberAccess')) {
    if (!isMcpMemberAccess(memberAccess)) {
      return c.json(
        { error: 'memberAccess must be "admin_only" or "shared"' },
        400,
      );
    }
    if (scope !== 'system') {
      return c.json(
        { error: 'memberAccess is only valid for system MCP servers' },
        400,
      );
    }
  }

  try {
    await repairPreviousMcpCleanup(authUser.id, scope, [id], 'Update MCP');
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP update cleanup');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  const store = await readMcpServersFile(ownerId);
  const entry = store.definitions.servers[id];
  if (!entry) {
    return c.json({ error: 'Server not found' }, 404);
  }

  // stdio fields
  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      return c.json({ error: 'command must be a non-empty string' }, 400);
    }
    if (command.length > MAX_MCP_STRING_LEN) {
      return c.json(
        { error: `command exceeds ${MAX_MCP_STRING_LEN} chars` },
        400,
      );
    }
    entry.command = command;
  }
  if (args !== undefined) {
    const r = validateMcpStringArrayLikeArgs(args);
    if (!r.ok) return c.json({ error: r.reason }, 400);
    entry.args = args;
  }
  if (env !== undefined) {
    if (env !== null) {
      const r = validateMcpKeyValueRecord(env, 'env', MAX_MCP_ENV_ENTRIES);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  }
  // http/sse fields
  if (url !== undefined) {
    if (typeof url !== 'string' || !url) {
      return c.json({ error: 'url must be a non-empty string' }, 400);
    }
    if (url.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `url exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    entry.url = url;
  }
  if (headers !== undefined) {
    if (headers !== null) {
      const r = validateMcpKeyValueRecord(headers, 'headers', MAX_MCP_HEADERS);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  }
  // common fields
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    if (!enabled) {
      const referencedByProfiles = referencedByCustomMcpProfiles(
        authUser.id,
        id,
        scope,
      );
      if (referencedByProfiles.length > 0) {
        return c.json(
          {
            error: '一个或多个智能体正在使用该 MCP 服务器',
            referencedByProfiles,
          },
          409,
        );
      }
    }
    entry.enabled = enabled;
  }
  if (description !== undefined) {
    if (typeof description !== 'string' && description !== null) {
      return c.json({ error: 'description must be a string' }, 400);
    }
    if (
      typeof description === 'string' &&
      description.length > MAX_MCP_STRING_LEN
    ) {
      return c.json(
        { error: `description exceeds ${MAX_MCP_STRING_LEN} chars` },
        400,
      );
    }
    entry.description =
      typeof description === 'string' ? description : undefined;
  }
  if (memberAccess !== undefined) {
    entry.memberAccess = memberAccess;
  }

  const secretEntry = { ...(store.secrets.servers[id] ?? {}) };
  if (Object.prototype.hasOwnProperty.call(body, 'env')) {
    if (env === null || Object.keys(env ?? {}).length === 0) {
      delete secretEntry.env;
    } else {
      secretEntry.env = env;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'headers')) {
    if (headers === null || Object.keys(headers ?? {}).length === 0) {
      delete secretEntry.headers;
    } else {
      secretEntry.headers = headers;
    }
  }
  if (secretEntry.env || secretEntry.headers) {
    store.secrets.servers[id] = secretEntry;
  } else {
    delete store.secrets.servers[id];
  }

  let invalidatedRuntimeJids = 0;
  try {
    invalidatedRuntimeJids = (
      await mutateCapabilityAroundRuntimeQuiesce(
        mcpMutationImpact(authUser.id, scope, [id]),
        `MCP ${scope}:${id} updated`,
        () => writeMcpServersFile(ownerId, store.definitions, store.secrets),
      )
    ).invalidatedRuntimeJids;
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP update');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  // 审计记录：严格不包含凭据明文
  try {
    if (memberAccess !== undefined) {
      recordAuthAuditLog({
        event_type: 'mcp_shared',
        username: authUser.username,
        actor_username: authUser.username,
        ip_address: c.req.header('x-forwarded-for') || null,
        user_agent: c.req.header('user-agent') || null,
        details: {
          targetId: id,
          scope,
          action: 'member_access_updated',
          memberAccess,
          runtimeResult: {
            success: true,
            invalidatedJids: invalidatedRuntimeJids,
          },
        },
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'env') ||
      Object.prototype.hasOwnProperty.call(body, 'headers')
    ) {
      const changedEnvKeys = Object.keys(env ?? {});
      const changedHeaderKeys = Object.keys(headers ?? {});
      recordAuthAuditLog({
        event_type: 'mcp_credential_updated',
        username: authUser.username,
        actor_username: authUser.username,
        ip_address: c.req.header('x-forwarded-for') || null,
        user_agent: c.req.header('user-agent') || null,
        details: {
          targetId: id,
          scope,
          action: 'credential_updated',
          sanitizedChanges: {
            envKeys: changedEnvKeys,
            headerKeys: changedHeaderKeys,
          },
          runtimeResult: {
            success: true,
            invalidatedJids: invalidatedRuntimeJids,
          },
        },
      });
    }
  } catch (auditErr) {
    // Audit write failures must not break operational flow
  }

  return c.json({
    success: true,
    invalidated_runtime_jids: invalidatedRuntimeJids,
    server: toMcpServerSummary(id, entry, store.secrets.servers[id], scope),
  });
});

// DELETE /:id — delete a server
mcpServersRoutes.delete('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }
  const scope = requestedScope(c.req.query('source'));
  if (!scope) return c.json({ error: 'Invalid MCP source' }, 400);
  if (!canMutateScope(authUser, scope)) {
    return c.json({ error: 'Only admin can manage system MCP servers' }, 403);
  }
  const ownerId = scopeOwnerId(scope, authUser.id);

  let repairedRuntimeJids = 0;
  try {
    repairedRuntimeJids = await repairPreviousMcpCleanup(
      authUser.id,
      scope,
      [id],
      'Delete MCP',
    );
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP deletion cleanup');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  const store = await readMcpServersFile(ownerId);
  if (!store.definitions.servers[id]) {
    if (repairedRuntimeJids > 0) {
      return c.json({
        success: true,
        recovered_runtime_cleanup: true,
        invalidated_runtime_jids: repairedRuntimeJids,
      });
    }
    return c.json({ error: 'Server not found' }, 404);
  }

  const referencedByProfiles = referencedByCustomMcpProfiles(
    authUser.id,
    id,
    scope,
  );
  if (referencedByProfiles.length > 0) {
    return c.json(
      {
        error: '一个或多个智能体正在使用该 MCP 服务器',
        referencedByProfiles,
      },
      409,
    );
  }

  delete store.definitions.servers[id];
  delete store.secrets.servers[id];
  try {
    const result = await mutateCapabilityAroundRuntimeQuiesce(
      mcpMutationImpact(authUser.id, scope, [id]),
      `MCP ${scope}:${id} deleted`,
      () => writeMcpServersFile(ownerId, store.definitions, store.secrets),
    );
    return c.json({
      success: true,
      invalidated_runtime_jids: result.invalidatedRuntimeJids,
    });
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'MCP deletion');
    if (failure) return c.json(failure, 503);
    throw error;
  }
});

// POST /sync-host — explicitly import copies from the configured host Claude
// directory (admin only). Despite the legacy route name this is intentionally
// not a live sync: existing managed definitions are never overwritten or
// deleted when the host changes.
mcpServersRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host MCP servers' }, 403);
  }
  try {
    await repairPreviousMcpCleanup(
      authUser.id,
      'user',
      undefined,
      'Import host MCP',
    );
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'Host MCP import cleanup');
    if (failure) return c.json(failure, 503);
    throw error;
  }

  const externalClaudeDir = getEffectiveExternalDir();
  const hostServers = loadHostClaudeMcpServers(externalClaudeDir);

  if (Object.keys(hostServers).length === 0) {
    return c.json({
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      importedFrom: externalClaudeDir,
      message: 'No MCP servers found in the configured host Claude directory',
    });
  }

  const store = await readMcpServersFile(authUser.id);
  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  for (const [id, hostEntry] of Object.entries(hostServers)) {
    if (!validateServerId(id)) {
      stats.skipped++;
      continue;
    }
    if (store.definitions.servers[id]) {
      stats.skipped++;
      continue;
    }
    const limit = checkMcpServerLimit(
      authUser.id,
      authUser.role,
      Object.keys(store.definitions.servers).length,
    );
    if (!limit.allowed) {
      stats.skipped++;
      continue;
    }

    const isHttpType = hostEntry.type === 'http' || hostEntry.type === 'sse';
    const entry: McpServerEntry = {
      enabled: true,
      importedFromHost: true,
      syncedFromHost: true,
      addedAt: new Date().toISOString(),
    };
    if (isHttpType) {
      if (
        (hostEntry.type !== 'http' && hostEntry.type !== 'sse') ||
        typeof hostEntry.url !== 'string' ||
        !hostEntry.url
      ) {
        stats.skipped++;
        continue;
      }
      const headersResult = hostEntry.headers
        ? validateMcpKeyValueRecord(
            hostEntry.headers,
            'headers',
            MAX_MCP_HEADERS,
          )
        : { ok: true as const };
      if (!headersResult.ok) {
        stats.skipped++;
        continue;
      }
      entry.type = hostEntry.type;
      entry.url = hostEntry.url;
    } else {
      if (typeof hostEntry.command !== 'string' || !hostEntry.command) {
        stats.skipped++;
        continue;
      }
      const argsResult = hostEntry.args
        ? validateMcpStringArrayLikeArgs(hostEntry.args)
        : { ok: true as const };
      const envResult = hostEntry.env
        ? validateMcpKeyValueRecord(hostEntry.env, 'env', MAX_MCP_ENV_ENTRIES)
        : { ok: true as const };
      if (!argsResult.ok || !envResult.ok) {
        stats.skipped++;
        continue;
      }
      entry.command = hostEntry.command;
      if (Array.isArray(hostEntry.args))
        entry.args = hostEntry.args as string[];
    }
    store.definitions.servers[id] = entry;
    const secretEntry: StoredMcpServerSecrets = {};
    if (hostEntry.env && typeof hostEntry.env === 'object') {
      secretEntry.env = hostEntry.env as Record<string, string>;
    }
    if (hostEntry.headers && typeof hostEntry.headers === 'object') {
      secretEntry.headers = hostEntry.headers as Record<string, string>;
    }
    if (secretEntry.env || secretEntry.headers)
      store.secrets.servers[id] = secretEntry;
    stats.added++;
  }

  try {
    const result = await mutateCapabilityAroundRuntimeQuiesce(
      mcpMutationImpact(authUser.id, 'user'),
      'Host MCP copies imported into managed user scope',
      () => writeMcpServersFile(authUser.id, store.definitions, store.secrets),
    );
    return c.json({
      ...stats,
      importedFrom: externalClaudeDir,
      invalidated_runtime_jids: result.invalidatedRuntimeJids,
    });
  } catch (error) {
    const failure = runtimeMutationFailure(error, 'Host MCP import');
    if (failure) return c.json(failure, 503);
    throw error;
  }
});

export { getUserMcpServersDir, readMcpServersFile };
export default mcpServersRoutes;
