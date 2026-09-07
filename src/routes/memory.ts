import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  WorkspaceMemoryCreateSchema,
  WorkspaceMemoryForgetSchema,
  WorkspaceMemoryListQuerySchema,
  WorkspaceMemoryPatchSchema,
  WorkspaceMemorySearchQuerySchema,
  WorkspaceMemoryVersionsQuerySchema,
} from '../schemas.js';
import {
  createWorkspaceMemory,
  forgetWorkspaceMemory,
  getWorkspaceMemory,
  listWorkspaceMemory,
  listWorkspaceMemoryVersions,
  searchWorkspaceMemory,
  updateWorkspaceMemory,
  WorkspaceMemoryServiceError,
} from '../memory-service.js';
import { logger } from '../logger.js';
import type { AuthUser } from '../types.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

function actor(user: AuthUser) {
  return { id: user.id, role: user.role };
}

function validationError(c: Context, details: unknown) {
  return c.json({ error: 'Invalid request', details }, 400);
}

function serviceError(c: Context, error: unknown): Response {
  if (error instanceof WorkspaceMemoryServiceError) {
    if (error.code === 'not_found') {
      return c.json({ error: 'Workspace memory not found' }, 404);
    }
    if (
      error.code === 'revision_conflict' ||
      error.code === 'idempotency_conflict'
    ) {
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
    return c.json({ error: error.code, message: error.message }, 400);
  }
  logger.error({ err: error }, 'Workspace memory request failed');
  return c.json({ error: 'Workspace memory request failed' }, 500);
}

memoryRoutes.use('/workspaces/*', authMiddleware);
memoryRoutes.use(
  '/workspaces/*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        { error: 'request_too_large', message: 'Memory request is too large' },
        413,
      ),
  }),
);

memoryRoutes.get('/workspaces/:workspaceJid/items/search', (c) => {
  const parsed = WorkspaceMemorySearchQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      searchWorkspaceMemory({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        query: parsed.data.q,
        kind: parsed.data.kind,
        status: parsed.data.status,
        scope: parsed.data.scope ?? 'recall',
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.get('/workspaces/:workspaceJid/items/:itemId/versions', (c) => {
  const parsed = WorkspaceMemoryVersionsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      listWorkspaceMemoryVersions({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        itemId: c.req.param('itemId'),
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.get('/workspaces/:workspaceJid/items/:itemId', (c) => {
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      getWorkspaceMemory({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        itemId: c.req.param('itemId'),
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.get('/workspaces/:workspaceJid/items', (c) => {
  const parsed = WorkspaceMemoryListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      listWorkspaceMemory({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        status: parsed.data.status,
        kind: parsed.data.kind,
        query: parsed.data.q,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.post('/workspaces/:workspaceJid/items', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = WorkspaceMemoryCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    const result = createWorkspaceMemory({
      actor: actor(user),
      workspaceJid: c.req.param('workspaceJid'),
      sourceType: 'web_user',
      ...parsed.data,
    });
    return c.json(result, result.replayed ? 200 : 201);
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.patch('/workspaces/:workspaceJid/items/:itemId', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = WorkspaceMemoryPatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      updateWorkspaceMemory({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        itemId: c.req.param('itemId'),
        sourceType: 'web_user',
        ...parsed.data,
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

memoryRoutes.delete('/workspaces/:workspaceJid/items/:itemId', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = WorkspaceMemoryForgetSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.format());
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      forgetWorkspaceMemory({
        actor: actor(user),
        workspaceJid: c.req.param('workspaceJid'),
        itemId: c.req.param('itemId'),
        sourceType: 'web_user',
        ...parsed.data,
      }),
    );
  } catch (error) {
    return serviceError(c, error);
  }
});

const legacyMemoryGone = (c: Context) =>
  c.json(
    {
      error: 'legacy_memory_api_retired',
      message:
        'Path-based global/date memory is archived. Use Workspace Memory v2.',
    },
    410,
  );

// Path-based endpoints are intentionally retired rather than left as a second
// writable truth. Legacy files stay untouched on disk for explicit offline
// export/migration, but runtime and Web cannot read or mutate them through HTTP.
memoryRoutes.all('/sources', authMiddleware, legacyMemoryGone);
memoryRoutes.all('/search', authMiddleware, legacyMemoryGone);
memoryRoutes.all('/file', authMiddleware, legacyMemoryGone);
memoryRoutes.all('/global', authMiddleware, legacyMemoryGone);

export default memoryRoutes;
