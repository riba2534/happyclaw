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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-r19-'));
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
const tasksRoutesModule = await import('../src/routes/tasks.js');
const {
  registerArtifactForRun,
  getArtifactForDownload,
  processCompletedRunArtifacts,
  buildContinuationDraftFromArtifacts,
} = await import('../src/task-artifact-service.js');
const tasksRoutes = tasksRoutesModule.default;

describe('R19: 每次运行产物版本化、三次同名报告隔离与接续任务', () => {
  const workspaceAFolder = 'ws_alpha';
  const workspaceAJid = 'web:ws_alpha';
  const workspaceBFolder = 'ws_beta';
  const workspaceBJid = 'web:ws_beta';
  let taskId: string;

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
      id: 'charlie',
      username: 'charlie',
      role: 'member',
      status: 'active',
      password_hash: 'hash_charlie',
      display_name: 'Charlie',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });

    // Register Workspace A (Alice owns it)
    db.setRegisteredGroup(workspaceAJid, {
      name: 'Workspace Alpha',
      folder: workspaceAFolder,
      added_at: now,
      created_by: 'alice',
    });
    fs.mkdirSync(path.join(tmpGroupsDir, workspaceAFolder), {
      recursive: true,
    });

    // Register Workspace B (Charlie owns it)
    db.setRegisteredGroup(workspaceBJid, {
      name: 'Workspace Beta',
      folder: workspaceBFolder,
      added_at: now,
      created_by: 'charlie',
    });
    fs.mkdirSync(path.join(tmpGroupsDir, workspaceBFolder), {
      recursive: true,
    });

    // Create a ScheduledTask in Workspace A
    taskId = 'task-report-gen';
    db.createTask({
      id: taskId,
      group_folder: workspaceAFolder,
      chat_jid: workspaceAJid,
      prompt: '每小时生成一份交付报告 reports/daily_summary.md',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      status: 'active',
      created_at: now,
      created_by: 'alice',
    });
  });

  function insertTestRun(run: {
    id: string;
    task_id: string;
    occurrence_key: string;
    trigger_type: string;
    scheduled_for: string;
    definition_snapshot: any;
    status: string;
    attempt?: number;
    available_at?: string;
  }) {
    const now = new Date().toISOString();
    db.getRawDb()
      .prepare(
        `INSERT INTO task_runs (
        id, task_id, occurrence_key, trigger_type, scheduled_for,
        definition_revision, definition_snapshot, status, attempt,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.task_id,
        run.occurrence_key,
        run.trigger_type,
        run.scheduled_for,
        JSON.stringify(run.definition_snapshot),
        run.status,
        run.attempt || 1,
        run.available_at || now,
        now,
        now,
      );
  }

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

  test('连续三次生成同名报告，按 runId 独立物理目录版本化保存，内容互不覆盖', async () => {
    const reportRelativePath = 'reports/daily_summary.md';
    const workspaceReportsDir = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'reports',
    );
    fs.mkdirSync(workspaceReportsDir, { recursive: true });
    const fullSourcePath = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      reportRelativePath,
    );

    // --- 运行 1: 生成版本 1 ---
    const runId1 = 'run-occurrence-001';
    insertTestRun({
      id: runId1,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:1`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T08:00:00Z',
      definition_snapshot: {
        prompt: '每小时生成一份交付报告',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });
    const contentV1 =
      '# Daily Summary Version 1\nTimestamp: 2026-09-07 08:00:00\nMetrics: OK';
    fs.writeFileSync(fullSourcePath, contentV1, 'utf-8');

    const reg1 = await registerArtifactForRun({
      runId: runId1,
      relativePath: reportRelativePath,
      name: 'daily_summary.md',
      createdBy: 'alice',
    });
    expect(reg1.success).toBe(true);
    const art1 = reg1.artifact!;
    expect(art1.name).toBe('daily_summary.md');

    // --- 运行 2: 在工作区覆盖写入同名报告版本 2 ---
    const runId2 = 'run-occurrence-002';
    insertTestRun({
      id: runId2,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:2`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T09:00:00Z',
      definition_snapshot: {
        prompt: '每小时生成一份交付报告',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });
    const contentV2 =
      '# Daily Summary Version 2\nTimestamp: 2026-09-07 09:00:00\nMetrics: WARN';
    fs.writeFileSync(fullSourcePath, contentV2, 'utf-8');

    const reg2 = await registerArtifactForRun({
      runId: runId2,
      relativePath: reportRelativePath,
      name: 'daily_summary.md',
      createdBy: 'alice',
    });
    expect(reg2.success).toBe(true);
    const art2 = reg2.artifact!;

    // --- 运行 3: 在工作区再次覆盖写入同名报告版本 3 ---
    const runId3 = 'run-occurrence-003';
    insertTestRun({
      id: runId3,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:3`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T10:00:00Z',
      definition_snapshot: {
        prompt: '每小时生成一份交付报告',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });
    const contentV3 =
      '# Daily Summary Version 3\nTimestamp: 2026-09-07 10:00:00\nMetrics: CRITICAL';
    fs.writeFileSync(fullSourcePath, contentV3, 'utf-8');

    const reg3 = await registerArtifactForRun({
      runId: runId3,
      relativePath: reportRelativePath,
      name: 'daily_summary.md',
      createdBy: 'alice',
    });
    expect(reg3.success).toBe(true);
    const art3 = reg3.artifact!;

    // 验证三次同名报告各自拥有不同的独立哈希与存储路径
    expect(art1.file_hash).not.toBe(art2.file_hash);
    expect(art2.file_hash).not.toBe(art3.file_hash);
    expect(art1.storage_path).toContain(runId1);
    expect(art2.storage_path).toContain(runId2);
    expect(art3.storage_path).toContain(runId3);

    // 分别下载三个版本，验证内容完全对应且未被工作区的覆盖影响！
    const dl1 = getArtifactForDownload(art1.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(dl1.status).toBe('ok');
    if (dl1.status === 'ok') {
      expect(dl1.data.toString('utf-8')).toBe(contentV1);
    }

    const dl2 = getArtifactForDownload(art2.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(dl2.status).toBe('ok');
    if (dl2.status === 'ok') {
      expect(dl2.data.toString('utf-8')).toBe(contentV2);
    }

    const dl3 = getArtifactForDownload(art3.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(dl3.status).toBe('ok');
    if (dl3.status === 'ok') {
      expect(dl3.data.toString('utf-8')).toBe(contentV3);
    }

    // 验证 REST 接口 GET /api/tasks/runs/:runId/artifacts/:artifactId/download
    const httpRes1 = await tasksRoutes.fetch(
      new Request(
        `http://localhost/runs/${runId1}/artifacts/${art1.id}/download`,
      ),
    );
    expect(httpRes1.status).toBe(200);
    const text1 = await httpRes1.text();
    expect(text1).toBe(contentV1);
    expect(httpRes1.headers.get('X-Artifact-Hash')).toBe(art1.file_hash);
  });

  test('文件被物理篡改时，下载校验 SHA-256 不符，返回明确的哈希不符错误提示', async () => {
    const reportRel = 'reports/audit.log';
    const absSource = path.join(tmpGroupsDir, workspaceAFolder, reportRel);
    fs.mkdirSync(path.dirname(absSource), { recursive: true });
    fs.writeFileSync(absSource, 'Original Audit Log Content', 'utf-8');

    const runId = 'run-tamper-test';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:tamper`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T11:00:00Z',
      definition_snapshot: {
        prompt: '测试篡改',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });

    const reg = await registerArtifactForRun({
      runId,
      relativePath: reportRel,
      name: 'audit.log',
      createdBy: 'alice',
    });
    expect(reg.success).toBe(true);
    const art = reg.artifact!;

    // 模拟底层存储中的物理文件被意外损坏或外部恶意篡改
    const absStoragePath = path.resolve(
      path.join(tmpStoreDir, 'artifacts', art.storage_path),
    );
    fs.writeFileSync(absStoragePath, 'MALICIOUS_TAMPERED_DATA', 'utf-8');

    // 下载时触发完整性校验
    const downloadRes = getArtifactForDownload(art.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(downloadRes.status).toBe('corrupted');
    if (downloadRes.status === 'corrupted') {
      expect(downloadRes.error).toContain('产物哈希校验不符');
      expect(downloadRes.expectedHash).toBe(art.file_hash);
      expect(downloadRes.actualHash).not.toBe(art.file_hash);
    }

    // 验证 REST 路由返回 500 及 ARTIFACT_HASH_MISMATCH
    const httpRes = await tasksRoutes.fetch(
      new Request(
        `http://localhost/runs/${runId}/artifacts/${art.id}/download`,
      ),
    );
    expect(httpRes.status).toBe(500);
    const errBody = await httpRes.json();
    expect(errBody.code).toBe('ARTIFACT_HASH_MISMATCH');
  });

  test('文件被物理删除时，下载明确返回缺失提示', async () => {
    const reportRel = 'reports/deleted.txt';
    const absSource = path.join(tmpGroupsDir, workspaceAFolder, reportRel);
    fs.writeFileSync(absSource, 'Content to be deleted', 'utf-8');

    const runId = 'run-missing-test';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:missing`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T12:00:00Z',
      definition_snapshot: {
        prompt: '测试缺失',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });

    const reg = await registerArtifactForRun({
      runId,
      relativePath: reportRel,
      name: 'deleted.txt',
      createdBy: 'alice',
    });
    const art = reg.artifact!;

    // 人为移除物理归档文件
    const absStoragePath = path.resolve(
      path.join(tmpStoreDir, 'artifacts', art.storage_path),
    );
    fs.unlinkSync(absStoragePath);

    const downloadRes = getArtifactForDownload(art.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(downloadRes.status).toBe('missing');
    if (downloadRes.status === 'missing') {
      expect(downloadRes.error).toContain('产物文件缺失');
    }

    const httpRes = await tasksRoutes.fetch(
      new Request(
        `http://localhost/runs/${runId}/artifacts/${art.id}/download`,
      ),
    );
    expect(httpRes.status).toBe(404);
    const errBody = await httpRes.json();
    expect(errBody.code).toBe('ARTIFACT_MISSING');
  });

  test('安全边界：拦截路径穿越 (..) 与越界登记', async () => {
    const runId = 'run-traversal-test';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:traversal`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T13:00:00Z',
      definition_snapshot: {
        prompt: '测试越界',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });

    const evilResult = await registerArtifactForRun({
      runId,
      relativePath: '../../../../etc/passwd',
      name: 'passwd',
    });
    expect(evilResult.success).toBe(false);
    expect(evilResult.errorCode).toBe('FILE_NOT_FOUND'); // Safe resolver strips leading .. and doesn't find file in workspace
  });

  test('权限隔离：Charlie 无法下载 Alice 工作区下的产物 (跨用户横向越权防御)', async () => {
    const artifacts = db.listTaskRunArtifactsByTaskId(taskId);
    expect(artifacts.length).toBeGreaterThan(0);
    const aliceArtifact = artifacts[0];

    // Charlie 尝试通过 REST 下载 Alice 的产物
    currentAuthUserId = 'charlie';
    const httpRes = await tasksRoutes.fetch(
      new Request(
        `http://localhost/runs/${aliceArtifact.run_id}/artifacts/${aliceArtifact.id}/download`,
      ),
    );
    // Charlie 无权查看该任务或其所属工作区 -> 404 或 403
    expect([403, 404]).toContain(httpRes.status);
  });

  test('历史任务改工作区后，仍可安全访问原产物 (R19 协同 UX R09)', async () => {
    currentAuthUserId = 'alice';
    const artifacts = db.listTaskRunArtifactsByRunId('run-occurrence-001');
    expect(artifacts.length).toBeGreaterThan(0);
    const originalArtifact = artifacts[0];

    // 模拟用户修改任务的目标工作区为新建的另一个合法工作区
    const newWorkspaceFolder = 'ws_alpha_v2';
    const newWorkspaceJid = 'web:ws_alpha_v2';
    db.setRegisteredGroup(newWorkspaceJid, {
      name: 'Workspace Alpha V2',
      folder: newWorkspaceFolder,
      added_at: new Date().toISOString(),
      created_by: 'alice',
    });

    // 更新任务所属工作区
    db.updateTask(taskId, {
      chat_jid: newWorkspaceJid,
      group_folder: newWorkspaceFolder,
    });

    // 确认任务当前工作区已变
    const updatedTask = db.getTaskById(taskId)!;
    expect(updatedTask.chat_jid).toBe(newWorkspaceJid);

    // 访问历史产物：由于产物绑定了当时生成时的原 workspace_jid，且 Alice 依然拥有访问权限，依然能成功下载！
    const dl = getArtifactForDownload(originalArtifact.id, {
      id: 'alice',
      role: 'member',
    } as any);
    expect(dl.status).toBe('ok');
  });

  test('用交付产物创建接续任务草稿 (buildContinuationDraftFromArtifacts)', async () => {
    currentAuthUserId = 'alice';
    const runId = 'run-occurrence-001';
    const run = db.getTaskRunById(runId)!;
    const artifacts = db.listTaskRunArtifactsByRunId(runId);
    expect(artifacts.length).toBeGreaterThan(0);

    const userWorkspaces = [{ jid: workspaceAJid, name: 'Workspace Alpha' }];
    const draft = buildContinuationDraftFromArtifacts(
      run,
      artifacts,
      userWorkspaces,
    );

    // 验证草稿内容准确引用了产物的版本 Hash 和路径
    expect(draft.prompt).toContain(run.id);
    expect(draft.prompt).toContain(artifacts[0].name);
    expect(draft.prompt).toContain(artifacts[0].file_hash.slice(0, 12));
    expect(draft.prompt).toContain(artifacts[0].original_path);
    // 安全验证：清空旧渠道绑定与交付路由
    expect(draft.delivery_route_jid).toBeNull();
    expect(draft.notify_channels).toBeNull();
  });

  test('声明契约自动归档 (processCompletedRunArtifacts)', async () => {
    const runId = 'run-contract-declare';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:declare`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T14:00:00Z',
      definition_snapshot: {
        prompt: '测试契约声明',
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        delivery_route_jid: null,
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        notify_channels: null,
      },
      status: 'success',
    });

    // 准备真实文件
    const declaredRel = 'reports/auto_contract.md';
    const absPath = path.join(tmpGroupsDir, workspaceAFolder, declaredRel);
    fs.writeFileSync(absPath, '# Auto Declared Content\nSuccess.', 'utf-8');

    // 模拟输出中携带声明标签
    const resultText = `任务已圆满完成。\n<happyclaw-artifact path="${declaredRel}" name="自动归档报告"/>\n其他说明...`;

    const archived = await processCompletedRunArtifacts({
      runId,
      resultText,
      createdBy: 'alice',
    });

    expect(archived.length).toBe(1);
    expect(archived[0].name).toBe('自动归档报告');
    expect(archived[0].original_path).toBe(declaredRel);
  });
});
