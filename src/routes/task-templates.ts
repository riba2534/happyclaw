// Task Template Management Routes (R18)

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, TemplateParameterDefinition } from '../types.js';
import {
  createTaskTemplate,
  getTaskTemplateById,
  listTaskTemplatesByOwner,
  updateTaskTemplate,
  deleteTaskTemplate,
  getTaskRunById,
  getAllRegisteredGroups,
} from '../db.js';
import { canAccessGroup } from '../group-acl.js';
import {
  validateParameterDefinitions,
  renderTemplate,
  buildDraftFromRun,
  extractCandidateParametersFromPrompt,
} from '../task-template-service.js';
import { canUserAccessHistoricRun } from '../task-artifact-service.js';

export const taskTemplatesRoutes = new Hono<{ Variables: Variables }>();

taskTemplatesRoutes.use('*', authMiddleware);

/**
 * List all templates owned by the current user.
 */
taskTemplatesRoutes.get('/', (c) => {
  const authUser = c.get('user') as AuthUser;
  const templates = listTaskTemplatesByOwner(authUser.id);
  return c.json({ templates });
});

/**
 * Get a single template by ID.
 */
taskTemplatesRoutes.get('/:id', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const template = getTaskTemplateById(id);

  if (!template || template.owner_user_id !== authUser.id) {
    return c.json({ error: '模板未找到' }, 404);
  }

  return c.json({ template });
});

/**
 * Create a new task template.
 */
taskTemplatesRoutes.post('/', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json({ error: '模板名称不能为空' }, 400);
  }

  const promptTemplate =
    typeof body.prompt_template === 'string' ? body.prompt_template.trim() : '';
  if (!promptTemplate) {
    return c.json({ error: '提示词模板 (prompt_template) 不能为空' }, 400);
  }

  const parameterDefinitions = Array.isArray(body.parameter_definitions)
    ? (body.parameter_definitions as TemplateParameterDefinition[])
    : [];

  const validation = validateParameterDefinitions(parameterDefinitions);
  if (!validation.valid) {
    return c.json({ error: '参数定义不合法', details: validation.errors }, 400);
  }

  const scheduleType =
    body.default_schedule_type === 'interval' ||
    body.default_schedule_type === 'once'
      ? body.default_schedule_type
      : 'cron';

  const scheduleValue =
    typeof body.default_schedule_value === 'string' &&
    body.default_schedule_value.trim()
      ? body.default_schedule_value.trim()
      : '0 9 * * *';

  const contextMode =
    body.default_context_mode === 'group' ? 'group' : 'isolated';

  const executionType =
    body.default_execution_type === 'script' ? 'script' : 'agent';

  // Non-admins cannot create script templates
  if (executionType === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建脚本模板' }, 403);
  }

  const executionMode =
    body.default_execution_mode === 'host' ? 'host' : 'container';
  if (executionMode === 'host' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以选择宿主机模式' }, 403);
  }

  const template = createTaskTemplate({
    owner_user_id: authUser.id,
    name,
    description:
      typeof body.description === 'string' ? body.description.trim() : '',
    prompt_template: promptTemplate,
    parameter_definitions: parameterDefinitions,
    default_schedule_type: scheduleType,
    default_schedule_value: scheduleValue,
    default_context_mode: contextMode,
    default_execution_type: executionType,
    default_execution_mode: executionMode,
  });

  return c.json({ success: true, template }, 201);
});

/**
 * Update a task template.
 */
taskTemplatesRoutes.put('/:id', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const existing = getTaskTemplateById(id);

  if (!existing || existing.owner_user_id !== authUser.id) {
    return c.json({ error: '模板未找到' }, 404);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (
    body.name !== undefined &&
    (typeof body.name !== 'string' || !body.name.trim())
  ) {
    return c.json({ error: '模板名称不能为空' }, 400);
  }

  if (
    body.prompt_template !== undefined &&
    (typeof body.prompt_template !== 'string' || !body.prompt_template.trim())
  ) {
    return c.json({ error: '提示词模板不能为空' }, 400);
  }

  if (body.parameter_definitions !== undefined) {
    if (!Array.isArray(body.parameter_definitions)) {
      return c.json({ error: 'parameter_definitions 必须是数组' }, 400);
    }
    const validation = validateParameterDefinitions(
      body.parameter_definitions as TemplateParameterDefinition[],
    );
    if (!validation.valid) {
      return c.json(
        { error: '参数定义不合法', details: validation.errors },
        400,
      );
    }
  }

  if (body.default_execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以设置脚本模板' }, 403);
  }
  if (body.default_execution_mode === 'host' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以设置宿主机模式' }, 403);
  }

  const updated = updateTaskTemplate(id, authUser.id, {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    description:
      typeof body.description === 'string'
        ? body.description.trim()
        : undefined,
    prompt_template:
      typeof body.prompt_template === 'string'
        ? body.prompt_template.trim()
        : undefined,
    parameter_definitions: Array.isArray(body.parameter_definitions)
      ? (body.parameter_definitions as TemplateParameterDefinition[])
      : undefined,
    default_schedule_type:
      body.default_schedule_type === 'interval' ||
      body.default_schedule_type === 'once' ||
      body.default_schedule_type === 'cron'
        ? body.default_schedule_type
        : undefined,
    default_schedule_value:
      typeof body.default_schedule_value === 'string'
        ? body.default_schedule_value.trim()
        : undefined,
    default_context_mode:
      body.default_context_mode === 'group' ||
      body.default_context_mode === 'isolated'
        ? body.default_context_mode
        : undefined,
    default_execution_type:
      body.default_execution_type === 'agent' ||
      body.default_execution_type === 'script'
        ? body.default_execution_type
        : undefined,
    default_execution_mode:
      body.default_execution_mode === 'host' ||
      body.default_execution_mode === 'container'
        ? body.default_execution_mode
        : undefined,
  });

  return c.json({ success: true, template: updated });
});

/**
 * Delete a task template.
 */
taskTemplatesRoutes.delete('/:id', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const existing = getTaskTemplateById(id);

  if (!existing || existing.owner_user_id !== authUser.id) {
    return c.json({ error: '模板未找到' }, 404);
  }

  const deleted = deleteTaskTemplate(id, authUser.id);
  return c.json({ success: deleted });
});

/**
 * Instantiate / preview a template with user-supplied parameter values.
 * Returns rendered prompt or detailed parameter errors.
 */
taskTemplatesRoutes.post('/:id/instantiate', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const template = getTaskTemplateById(id);

  if (!template || template.owner_user_id !== authUser.id) {
    return c.json({ error: '模板未找到' }, 404);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    parameters?: Record<string, unknown>;
  };
  const parameters = body.parameters || {};

  const result = renderTemplate(
    template.prompt_template,
    template.parameter_definitions,
    parameters,
  );

  if (!result.success) {
    return c.json(
      {
        error: '模板参数校验未通过',
        missing_parameters: result.missingParameters,
        validation_errors: result.validationErrors,
        rendered_prompt: result.renderedPrompt,
      },
      400,
    );
  }

  return c.json({
    success: true,
    rendered_prompt: result.renderedPrompt,
    applied_parameters: result.appliedParameters,
    default_config: {
      schedule_type: template.default_schedule_type,
      schedule_value: template.default_schedule_value,
      context_mode: template.default_context_mode,
      execution_type: template.default_execution_type,
      execution_mode: template.default_execution_mode,
    },
  });
});

/**
 * Generate a task draft and candidate template from a historical task run.
 * Ensures strict security: no inherited channel binds, routes, or other user targets.
 */
taskTemplatesRoutes.post('/from-run/:runId', (c) => {
  const authUser = c.get('user') as AuthUser;
  const runId = c.req.param('runId');
  const run = getTaskRunById(runId);

  if (!run) {
    return c.json({ error: '运行记录未找到' }, 404);
  }

  // Permission check: fail closed via canUserAccessHistoricRun
  if (!canUserAccessHistoricRun(run, authUser)) {
    return c.json({ error: '运行记录未找到' }, 404);
  }

  // Host mode check: non-admin cannot view/use host execution run details
  if (
    run.definition_snapshot.execution_mode === 'host' &&
    authUser.role !== 'admin'
  ) {
    return c.json({ error: '运行记录未找到' }, 404);
  }

  // Get user-accessible workspaces
  const allGroups = getAllRegisteredGroups();
  const userWorkspaces = Object.entries(allGroups)
    .map(([jid, g]) => ({ ...g, jid }))
    .filter((g) => canAccessGroup({ id: authUser.id, role: authUser.role }, g))
    .map((g) => ({ jid: g.jid, name: g.name || g.folder }));

  const draft = buildDraftFromRun(run, userWorkspaces);
  const candidates = extractCandidateParametersFromPrompt(draft.prompt);

  return c.json({
    success: true,
    draft,
    template_candidate: {
      prompt_template: candidates.templatePrompt,
      parameter_definitions: candidates.candidateDefs,
    },
  });
});
