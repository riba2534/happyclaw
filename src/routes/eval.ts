import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import type { AuthUser, EvalCaseRule, EvalHumanFeedback } from '../types.js';
import {
  createEvalCase,
  createEvalSuite,
  deleteEvalCase,
  deleteEvalRun,
  deleteEvalSuite,
  getEvalCase,
  getEvalRun,
  getEvalSuite,
  getEvalSuiteWithCases,
  listEvalRuns,
  listEvalSuites,
  updateEvalCase,
  updateEvalSuite,
} from '../db.js';
import {
  cancelEvalRunAsync,
  isEvalRunActive,
  generateEvalJsonReport,
  generateEvalMarkdownReport,
  getEvalRunSummary,
  startEvalRun,
  submitCaseFeedback,
} from '../eval-service.js';

export const evalRoutes = new Hono<{ Variables: Variables }>();

// All eval routes require authenticated session
evalRoutes.use('*', authMiddleware);

function validateRegexPatterns(rules: unknown): string | null {
  if (!rules || typeof rules !== 'object') return null;
  const patterns = (rules as Record<string, unknown>).regexPatterns;
  if (!patterns) return null;
  if (!Array.isArray(patterns)) return 'regexPatterns 必须为数组格式';
  for (const p of patterns) {
    if (typeof p !== 'string') return '正则表达式必须为字符串';
    if (p.length > 200) {
      return `正则表达式超出200字符限制: ${p.slice(0, 30)}...`;
    }
    try {
      new RegExp(p, 'i');
    } catch {
      return `非法的正则表达式语法: ${p}`;
    }
  }
  return null;
}

// --- 1. Eval Suites ---

// List all suites visible to current user (system benchmark + user's own)
evalRoutes.get('/suites', (c) => {
  const user = c.get('user') as AuthUser;
  const suites = listEvalSuites(user.id);
  return c.json({ suites });
});

// Get suite detail with cases
evalRoutes.get('/suites/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const suite = getEvalSuiteWithCases(id, user.id);
  if (!suite) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  return c.json({ suite });
});

// Create a custom suite
evalRoutes.post('/suites', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json({ error: '评测集名称不能为空' }, 400);
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const suite = createEvalSuite({
    owner_user_id: user.id,
    name,
    description,
  });
  return c.json({ suite }, 201);
});

// Update a custom suite
evalRoutes.put('/suites/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const existing = getEvalSuite(id, user.id);
  if (!existing) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  if (existing.is_system) {
    return c.json({ error: '系统内置评测基准不允许修改' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const description =
    typeof body.description === 'string' ? body.description.trim() : undefined;

  const updated = updateEvalSuite(id, user.id, { name, description });
  return c.json({ suite: updated });
});

// Delete a custom suite
evalRoutes.delete('/suites/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const existing = getEvalSuite(id, user.id);
  if (!existing) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  if (existing.is_system) {
    return c.json({ error: '系统内置评测基准不允许删除' }, 403);
  }

  const ok = deleteEvalSuite(id, user.id);
  return c.json({ success: ok });
});

// --- 2. Eval Cases ---

// Add a case to a suite
evalRoutes.post('/suites/:suiteId/cases', async (c) => {
  const user = c.get('user') as AuthUser;
  const suiteId = c.req.param('suiteId');
  const suite = getEvalSuite(suiteId, user.id);
  if (!suite) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  if (suite.is_system) {
    return c.json({ error: '系统内置评测基准不允许直接添加案例' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const inputPrompt =
    typeof body.input_prompt === 'string' ? body.input_prompt.trim() : '';
  if (!name || !inputPrompt) {
    return c.json({ error: '案例名称与输入 Prompt 不能为空' }, 400);
  }

  const regexErr = validateRegexPatterns(body.eval_rules);
  if (regexErr) {
    return c.json({ error: regexErr }, 400);
  }

  const created = createEvalCase({
    suite_id: suiteId,
    name,
    category:
      typeof body.category === 'string' ? body.category.trim() : 'general',
    input_prompt: inputPrompt,
    expected_output:
      typeof body.expected_output === 'string'
        ? body.expected_output.trim()
        : '',
    eval_rules: (body.eval_rules as EvalCaseRule) || {},
    timeout_ms:
      typeof body.timeout_ms === 'number' && body.timeout_ms > 0
        ? body.timeout_ms
        : 60000,
    order_num: typeof body.order_num === 'number' ? body.order_num : 0,
  });

  return c.json({ case: created }, 201);
});

// Update a case
evalRoutes.put('/suites/:suiteId/cases/:caseId', async (c) => {
  const user = c.get('user') as AuthUser;
  const suiteId = c.req.param('suiteId');
  const caseId = c.req.param('caseId');

  const suite = getEvalSuite(suiteId, user.id);
  if (!suite) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  if (suite.is_system) {
    return c.json({ error: '系统内置评测基准不允许直接修改案例' }, 403);
  }

  const existingCase = getEvalCase(caseId);
  if (!existingCase || existingCase.suite_id !== suiteId) {
    return c.json({ error: '评测案例不存在' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  if (body.eval_rules !== undefined) {
    const regexErr = validateRegexPatterns(body.eval_rules);
    if (regexErr) {
      return c.json({ error: regexErr }, 400);
    }
  }

  const updated = updateEvalCase(caseId, suiteId, {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    category:
      typeof body.category === 'string' ? body.category.trim() : undefined,
    input_prompt:
      typeof body.input_prompt === 'string'
        ? body.input_prompt.trim()
        : undefined,
    expected_output:
      typeof body.expected_output === 'string'
        ? body.expected_output.trim()
        : undefined,
    eval_rules: body.eval_rules !== undefined ? body.eval_rules : undefined,
    timeout_ms:
      typeof body.timeout_ms === 'number' && body.timeout_ms > 0
        ? body.timeout_ms
        : undefined,
    order_num: typeof body.order_num === 'number' ? body.order_num : undefined,
  });

  return c.json({ case: updated });
});

// Delete a case
evalRoutes.delete('/suites/:suiteId/cases/:caseId', (c) => {
  const user = c.get('user') as AuthUser;
  const suiteId = c.req.param('suiteId');
  const caseId = c.req.param('caseId');

  const suite = getEvalSuite(suiteId, user.id);
  if (!suite) {
    return c.json({ error: '评测集不存在或无权访问' }, 404);
  }
  if (suite.is_system) {
    return c.json({ error: '系统内置评测基准不允许删除案例' }, 403);
  }

  const ok = deleteEvalCase(caseId, suiteId);
  return c.json({ success: ok });
});

// --- 3. Eval Runs ---

// List runs
evalRoutes.get('/runs', (c) => {
  const user = c.get('user') as AuthUser;
  const profileId = c.req.query('agent_profile_id');
  const runs = listEvalRuns(user.id, profileId);
  return c.json({ runs });
});

// Start a new eval run
evalRoutes.post('/runs', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const agentProfileId =
    typeof body.agent_profile_id === 'string'
      ? body.agent_profile_id.trim()
      : '';
  if (!agentProfileId) {
    return c.json({ error: '缺少必需参数: agent_profile_id' }, 400);
  }

  try {
    const run = await startEvalRun({
      ownerUserId: user.id,
      agentProfileId,
      suiteId: typeof body.suite_id === 'string' ? body.suite_id : undefined,
      mode: body.mode === 'single' ? 'single' : 'compare',
      baseVersion:
        typeof body.base_version === 'number' ? body.base_version : undefined,
      targetVersion:
        typeof body.target_version === 'number'
          ? body.target_version
          : undefined,
      model: typeof body.model === 'string' ? body.model.trim() : undefined,
    });
    return c.json({ run }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message || '触发评测失败' }, 400);
  }
});

// Get run details with compare summary and case breakdown
evalRoutes.get('/runs/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const summary = getEvalRunSummary(id, user.id);
  if (!summary) {
    return c.json({ error: '评测运行记录不存在或无权访问' }, 404);
  }
  return c.json({ summary });
});

// Cancel a run
evalRoutes.post('/runs/:id/cancel', async (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const ok = await cancelEvalRunAsync(id, user.id);
  if (!ok) {
    return c.json({ error: '无法取消该评测运行（可能已终态或不存在）' }, 400);
  }
  return c.json({ success: true });
});

// Delete a run
evalRoutes.delete('/runs/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const run = getEvalRun(id, user.id);
  if (!run) {
    return c.json({ error: '评测记录不存在或无权删除' }, 404);
  }
  if (
    isEvalRunActive(id) ||
    ['pending', 'running', 'cancelling'].includes(run.status)
  ) {
    return c.json(
      { error: '评测正在执行或正在收尾中，请等待其完全停止后再删除记录' },
      409,
    );
  }

  const ok = deleteEvalRun(id, user.id);
  return c.json({ success: ok });
});

// --- 4. Downloadable Reports ---

// Markdown Report Download
evalRoutes.get('/runs/:id/report.md', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const markdown = generateEvalMarkdownReport(id, user.id);
  if (!markdown) {
    return c.json({ error: '评测报告不存在或无权访问' }, 404);
  }
  const filename = `eval-report-${id}.md`;
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(markdown);
});

// JSON Report Download
evalRoutes.get('/runs/:id/report.json', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const jsonReport = generateEvalJsonReport(id, user.id);
  if (!jsonReport) {
    return c.json({ error: '评测报告不存在或无权访问' }, 404);
  }
  const filename = `eval-report-${id}.json`;
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(JSON.stringify(jsonReport, null, 2));
});

// Generic report endpoint with format query param (?format=markdown|json)
evalRoutes.get('/runs/:id/report', (c) => {
  const user = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const format = c.req.query('format') || 'markdown';

  if (format === 'json') {
    const jsonReport = generateEvalJsonReport(id, user.id);
    if (!jsonReport) {
      return c.json({ error: '评测报告不存在或无权访问' }, 404);
    }
    const filename = `eval-report-${id}.json`;
    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(JSON.stringify(jsonReport, null, 2));
  }

  const markdown = generateEvalMarkdownReport(id, user.id);
  if (!markdown) {
    return c.json({ error: '评测报告不存在或无权访问' }, 404);
  }
  const filename = `eval-report-${id}.md`;
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(markdown);
});

// --- 5. Human Feedback ---

evalRoutes.post('/cases/:caseRunId/feedback', async (c) => {
  const user = c.get('user') as AuthUser;
  const caseRunId = c.req.param('caseRunId');
  const body = await c.req.json().catch(() => ({}));

  const feedback = body.feedback as EvalHumanFeedback;
  if (
    feedback !== 'accepted' &&
    feedback !== 'rejected' &&
    feedback !== 'unresolved' &&
    feedback !== null
  ) {
    return c.json(
      {
        error:
          'Invalid feedback value (must be accepted, rejected, unresolved, or null)',
      },
      400,
    );
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim() : undefined;

  const updated = submitCaseFeedback({
    caseRunId,
    ownerUserId: user.id,
    feedback,
    notes,
  });

  if (!updated) {
    return c.json({ error: '案例评测记录不存在或无权访问' }, 404);
  }

  return c.json({ case: updated });
});
