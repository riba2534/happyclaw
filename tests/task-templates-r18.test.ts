import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-templates-r18-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

let currentAuthUserId = 'alice';
let currentAuthRole = 'member';

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: currentAuthUserId,
        username: currentAuthUserId,
        role: currentAuthRole,
        status: 'active',
        permissions: [],
      });
      return next();
    },
  };
});

const db = await import('../src/db.js');
const { taskTemplatesRoutes } = await import('../src/routes/task-templates.js');
const {
  validateParameterDefinitions,
  renderTemplate,
  buildDraftFromRun,
  extractCandidateParametersFromPrompt,
} = await import('../src/task-template-service.js');
import type { TaskRun, TemplateParameterDefinition } from '../src/types.js';

describe('R18: 任务模板体系、参数声明校验与草稿复用', () => {
  beforeAll(() => {
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      role: 'member',
      status: 'active',
      password_hash: 'hash_alice',
      display_name: 'Alice',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.createUser({
      id: 'bob',
      username: 'bob',
      role: 'member',
      status: 'active',
      password_hash: 'hash_bob',
      display_name: 'Bob',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
  });

  beforeEach(() => {
    currentAuthUserId = 'alice';
    currentAuthRole = 'member';
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('1. 参数声明与类型校验单元逻辑 (renderTemplate & validateParameterDefinitions)', () => {
    const sampleDefs: TemplateParameterDefinition[] = [
      {
        name: 'project',
        label: '项目',
        type: 'string',
        required: true,
      },
      {
        name: 'date',
        label: '巡检日期',
        type: 'date',
        required: true,
      },
      {
        name: 'input_dir',
        label: '目录',
        type: 'path',
        required: true,
      },
      {
        name: 'threshold',
        label: '阈值',
        type: 'number',
        required: false,
        default_value: '10',
      },
    ];

    test('参数定义合法性校验：拦截非法变量名与重复名', () => {
      const invalidDefs: TemplateParameterDefinition[] = [
        {
          name: '123_bad',
          label: '以数字开头',
          type: 'string',
          required: true,
        },
        { name: 'project', label: '合法', type: 'string', required: true },
        { name: 'project', label: '重复', type: 'string', required: true },
      ];
      const res = validateParameterDefinitions(invalidDefs);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('123_bad'))).toBe(true);
      expect(res.errors.some((e) => e.includes('重复定义'))).toBe(true);
    });

    test('正常参数渲染与默认值回退', () => {
      const tpl =
        '分析 {{project}} 在 {{date}} 的指标，输入路径 {{input_dir}}，阈值 {{threshold}}';
      const values = {
        project: 'happyclaw',
        date: '2026-09-07',
        input_dir: 'logs/production',
        // threshold 留空，应使用 default_value: '10'
      };
      const result = renderTemplate(tpl, sampleDefs, values);
      expect(result.success).toBe(true);
      expect(result.renderedPrompt).toBe(
        '分析 happyclaw 在 2026-09-07 的指标，输入路径 logs/production，阈值 10',
      );
      expect(result.missingParameters.length).toBe(0);
    });

    test('缺少必要参数时准确报错', () => {
      const tpl = '项目 {{project}}，日期 {{date}}';
      const result = renderTemplate(tpl, sampleDefs, { project: 'happyclaw' });
      expect(result.success).toBe(false);
      expect(result.missingParameters).toContain('date');
      expect(result.validationErrors.some((e) => e.includes('date'))).toBe(
        true,
      );
    });

    test('非法类型拦截：非数字与非法日期（含语义日期如 2026-99-99、2026-02-31）', () => {
      const tpl =
        '项目 {{project}} 日期 {{date}} 阈值 {{threshold}} 路径 {{input_dir}}';
      const badResult = renderTemplate(tpl, sampleDefs, {
        project: 'happyclaw',
        date: '2026-99-99',
        threshold: 'not-a-number',
        input_dir: 'valid/path',
      });
      expect(badResult.success).toBe(false);
      expect(
        badResult.validationErrors.some((e) => e.includes('合法日历日期')),
      ).toBe(true);
      expect(
        badResult.validationErrors.some((e) => e.includes('必须为有效数字')),
      );

      // 验证 2 月 31 日等日历溢出假日期
      const febResult = renderTemplate(tpl, sampleDefs, {
        project: 'happyclaw',
        date: '2026-02-31',
        threshold: '10',
        input_dir: 'valid/path',
      });
      expect(febResult.success).toBe(false);
      expect(
        febResult.validationErrors.some((e) => e.includes('合法日历日期')),
      ).toBe(true);
    });

    test('参数定义默认值同等校验：拒绝不合法的默认值 (如 number 默认 abc)', () => {
      const badDefaultDefs: TemplateParameterDefinition[] = [
        {
          name: 'count',
          label: '数量',
          type: 'number',
          required: false,
          default_value: 'abc', // 非法数字默认值
        },
        {
          name: 'created_date',
          label: '日期',
          type: 'date',
          required: false,
          default_value: '2026-99-99', // 非法日期默认值
        },
      ];
      const res = validateParameterDefinitions(badDefaultDefs);
      expect(res.valid).toBe(false);
      expect(
        res.errors.some((e) => e.includes('默认值非法') && e.includes('count')),
      ).toBe(true);
      expect(
        res.errors.some(
          (e) => e.includes('默认值非法') && e.includes('created_date'),
        ),
      ).toBe(true);
    });

    test('单次 Token 替换安全：保留替换元字符 ($&, $1) 字面量，彻底防止二次展开', () => {
      // 场景 1：用户输入值包含 JavaScript 替换元字符 $&
      const tpl1 = 'Value {{x}}';
      const defs1: TemplateParameterDefinition[] = [
        { name: 'x', label: 'X', type: 'string', required: true },
      ];
      const res1 = renderTemplate(tpl1, defs1, { x: '$&' });
      expect(res1.success).toBe(true);
      expect(res1.renderedPrompt).toBe('Value $&'); // 绝不能变成 "Value {{x}}"

      // 场景 2：用户输入包含嵌套占位符 {{b}}，杜绝二次展开
      const tpl2 = 'Value {{a}} then {{b}}';
      const defs2: TemplateParameterDefinition[] = [
        { name: 'a', label: 'A', type: 'string', required: true },
        { name: 'b', label: 'B', type: 'string', required: true },
      ];
      const res2 = renderTemplate(tpl2, defs2, { a: '{{b}}', b: 'FINAL' });
      expect(res2.success).toBe(true);
      expect(res2.renderedPrompt).toBe('Value {{b}} then FINAL'); // 绝不能二次展开变成 "Value FINAL then FINAL"
    });

    test('安全防护：拦截路径穿越 (..) 攻击', () => {
      const tpl = '分析输入路径 {{input_dir}}';
      const evilResult = renderTemplate(tpl, sampleDefs, {
        project: 'happyclaw',
        date: '2026-09-07',
        input_dir: '../../etc/shadow',
      });
      expect(evilResult.success).toBe(false);
      expect(
        evilResult.validationErrors.some((e) => e.includes('越界符')),
      ).toBe(true);
    });
  });

  describe('2. 模板私有 CRUD 与用户隔离 (REST API)', () => {
    let createdTemplateId: string;

    test('POST / 成功创建当前用户私有模板', async () => {
      const req = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '每日巡检模板',
          description: '巡检日志并输出报告',
          prompt_template: '请检查 {{project}} 在 {{date}} 的运行日志。',
          parameter_definitions: [
            { name: 'project', label: '项目', type: 'string', required: true },
            { name: 'date', label: '日期', type: 'date', required: true },
          ],
          default_schedule_type: 'cron',
          default_schedule_value: '0 9 * * *',
        }),
      });

      const res = await taskTemplatesRoutes.fetch(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.template.name).toBe('每日巡检模板');
      expect(data.template.owner_user_id).toBe('alice');
      createdTemplateId = data.template.id;
    });

    test('GET / 列出当前用户模板', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await taskTemplatesRoutes.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.templates.length).toBeGreaterThanOrEqual(1);
      expect(data.templates.some((t: any) => t.id === createdTemplateId)).toBe(
        true,
      );
    });

    test('跨用户数据隔离：Bob 无法查看/修改/删除 Alice 的私有模板', async () => {
      currentAuthUserId = 'bob';

      // 1. Bob 查 Alice 模板 -> 404
      const getReq = new Request(`http://localhost/${createdTemplateId}`, {
        method: 'GET',
      });
      const getRes = await taskTemplatesRoutes.fetch(getReq);
      expect(getRes.status).toBe(404);

      // 2. Bob 尝试更新 Alice 模板 -> 404
      const putReq = new Request(`http://localhost/${createdTemplateId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bob篡改' }),
      });
      const putRes = await taskTemplatesRoutes.fetch(putReq);
      expect(putRes.status).toBe(404);

      // 3. Bob 尝试删除 Alice 模板 -> 404
      const delReq = new Request(`http://localhost/${createdTemplateId}`, {
        method: 'DELETE',
      });
      const delRes = await taskTemplatesRoutes.fetch(delReq);
      expect(delRes.status).toBe(404);
    });

    test('POST /:id/instantiate: 模板预览与参数实例化端到端校验', async () => {
      currentAuthUserId = 'alice';

      // 缺失必填参数时报 400
      const badReq = new Request(
        `http://localhost/${createdTemplateId}/instantiate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parameters: { project: 'happyclaw' } }),
        },
      );
      const badRes = await taskTemplatesRoutes.fetch(badReq);
      expect(badRes.status).toBe(400);
      const badData = await badRes.json();
      expect(badData.missing_parameters).toContain('date');

      // 正确传入参数时返回渲染后 prompt
      const okReq = new Request(
        `http://localhost/${createdTemplateId}/instantiate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parameters: { project: 'happyclaw', date: '2026-09-07' },
          }),
        },
      );
      const okRes = await taskTemplatesRoutes.fetch(okReq);
      expect(okRes.status).toBe(200);
      const okData = await okRes.json();
      expect(okData.success).toBe(true);
      expect(okData.rendered_prompt).toBe(
        '请检查 happyclaw 在 2026-09-07 的运行日志。',
      );
    });
  });

  describe('3. 以本次运行创建任务草稿 (buildDraftFromRun) 权限与边界安全', () => {
    test('草稿预填必须清除旧渠道绑定与通知目标，严禁继承他人权限', () => {
      const mockRun: TaskRun = {
        id: 'run-123456',
        task_id: 'task-999',
        trigger_type: 'scheduled',
        idempotency_key: null,
        scheduled_for: '2026-09-07T08:00:00Z',
        definition_revision: 1,
        definition_snapshot: {
          prompt: '执行历史任务 Prompt 2026-09-07',
          group_folder: 'ws-secret',
          chat_jid: 'web:secret_channel_jid',
          delivery_route_jid: 'feishu:group:oc_12345678#thread:98765', // 旧渠道外部真实会话
          context_mode: 'isolated',
          execution_type: 'agent',
          execution_mode: 'container',
          script_command: null,
          notify_channels: ['feishu', 'telegram'], // 旧通知渠道
        },
        status: 'success',
        attempt: 1,
        available_at: '2026-09-07T08:00:00Z',
        lease_owner: null,
        lease_token: 0,
        lease_expires_at: null,
        started_at: '2026-09-07T08:00:01Z',
        completed_at: '2026-09-07T08:00:10Z',
        created_at: '2026-09-07T08:00:00Z',
        updated_at: '2026-09-07T08:00:10Z',
        duration_ms: 9000,
        result: '任务执行完毕，生成报告。',
        error: null,
        notification_status: 'success',
        notification_error: null,
        notification_summary: null,
        notification_attempt: 1,
        notification_available_at: null,
      };

      const userWorkspaces = [
        { jid: 'web:my_workspace', name: '我的合法工作区' },
      ];

      const draft = buildDraftFromRun(mockRun, userWorkspaces);

      // 安全要求验证：
      expect(draft.prompt).toBe('执行历史任务 Prompt 2026-09-07');
      expect(draft.delivery_route_jid).toBeNull(); // 绝不继承旧交付路径
      expect(draft.notify_channels).toBeNull(); // 绝不继承旧渠道通知
      expect(draft.chat_jid).toBe(''); // 旧工作区用户无权访问时置空，要求显式选择
    });

    test('从运行 Prompt 自动提取参数候选 (extractCandidateParametersFromPrompt)', () => {
      const prompt = '检查项目 2026-09-07 的巡检报告并存入 {{output_dir}}';
      const candidates = extractCandidateParametersFromPrompt(prompt);
      expect(candidates.candidateDefs.some((d) => d.name === 'date')).toBe(
        true,
      );
      expect(
        candidates.candidateDefs.some((d) => d.name === 'output_dir'),
      ).toBe(true);
      expect(candidates.templatePrompt).toContain('{{date}}');
    });

    test('POST /from-run/:runId 权限 fail-closed：历史工作区删除或无权访问时严格返回 404', async () => {
      const now = new Date().toISOString();
      const ghostRunId = 'run-ghost-workspace';
      const secretTaskId = 'task-secret-other';
      db.createTask({
        id: secretTaskId,
        group_folder: 'ws-deleted',
        chat_jid: 'web:deleted_workspace',
        prompt: '机密任务',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        status: 'active',
        created_at: now,
        created_by: 'charlie', // created by charlie
      });

      db.getRawDb()
        .prepare(
          `
        INSERT INTO task_runs (
          id, task_id, occurrence_key, trigger_type, scheduled_for,
          definition_revision, definition_snapshot, status, attempt,
          available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'success', 1, ?, ?, ?)
      `,
        )
        .run(
          ghostRunId,
          secretTaskId,
          'key:ghost',
          'manual',
          now,
          JSON.stringify({
            prompt: '机密运行记录',
            group_folder: 'ws-deleted',
            chat_jid: 'web:deleted_workspace',
            execution_mode: 'container',
          }),
          now,
          now,
          now,
        );

      // 用户 Bob 并非该任务创建者，且工作区已不存在 -> 必须 fail-closed 返回 404
      currentAuthUserId = 'bob';
      const res = await taskTemplatesRoutes.fetch(
        new Request(`http://localhost/from-run/${ghostRunId}`, {
          method: 'POST',
        }),
      );
      expect(res.status).toBe(404);

      // 非管理员试图查看 host execution_mode 运行记录 -> 必须返回 404
      const hostTaskId = 'task-host';
      const hostRunId = 'run-host-admin';
      db.createTask({
        id: hostTaskId,
        group_folder: 'ws-host',
        chat_jid: 'web:ws_host',
        prompt: '宿主机执行脚本',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'host',
        status: 'active',
        created_at: now,
        created_by: 'alice',
      });

      db.getRawDb()
        .prepare(
          `
        INSERT INTO task_runs (
          id, task_id, occurrence_key, trigger_type, scheduled_for,
          definition_revision, definition_snapshot, status, attempt,
          available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'success', 1, ?, ?, ?)
      `,
        )
        .run(
          hostRunId,
          hostTaskId,
          'key:host',
          'manual',
          now,
          JSON.stringify({
            prompt: '宿主机执行脚本',
            group_folder: 'ws-host',
            chat_jid: 'web:ws_host',
            execution_mode: 'host',
          }),
          now,
          now,
          now,
        );

      currentAuthUserId = 'alice'; // alice is member
      const hostRes = await taskTemplatesRoutes.fetch(
        new Request(`http://localhost/from-run/${hostRunId}`, {
          method: 'POST',
        }),
      );
      expect(hostRes.status).toBe(404);
    });
  });
});
