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
  prepareTaskContinuationArtifacts,
} = await import('../src/task-artifact-service.js');
const { createMcpTools } =
  await import('../container/agent-runner/src/mcp-tools.js');
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
    expect(evilResult.errorCode).toBe('PATH_TRAVERSAL');
  });

  test('安全边界：拦截指向工作区外部的符号链接 (Symlink Escape 防御)', async () => {
    // 在临时目录外创建一个秘密文件
    const outsideSecretDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'outside-secret-'),
    );
    const outsideSecretFile = path.join(
      outsideSecretDir,
      'host-confidential.txt',
    );
    fs.writeFileSync(
      outsideSecretFile,
      'HOST_SECRET_TOKEN=1234567890',
      'utf-8',
    );

    // 在工作区内创建一个指向该外部文件的软链接
    const symlinkPathInWorkspace = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'reports',
      'symlink_to_secret.txt',
    );
    try {
      fs.symlinkSync(outsideSecretFile, symlinkPathInWorkspace);
    } catch {
      /* ignore */
    }

    const runId = 'run-symlink-test';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:symlink`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T13:30:00Z',
      definition_snapshot: {
        prompt: '测试软链接逃逸',
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

    const symlinkResult = await registerArtifactForRun({
      runId,
      relativePath: 'reports/symlink_to_secret.txt',
      name: 'symlink_secret.txt',
    });

    // 必须安全拦截，绝不能将外部敏感文件读入可下载 archive！
    expect(symlinkResult.success).toBe(false);
    expect(symlinkResult.errorCode).toBe('PATH_TRAVERSAL');
    expect(symlinkResult.error).toContain('符号链接');

    // 清理测试用的外部文件与软链接
    try {
      fs.unlinkSync(symlinkPathInWorkspace);
      fs.rmSync(outsideSecretDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('并发与精确归属隔离：Run A 绝不消费或删除 Run B 的 IPC 声明文件', async () => {
    const ipcDir = path.join(tmpDir, 'ipc', workspaceAFolder);
    const artifactsIpcDir = path.join(ipcDir, 'artifacts');
    fs.mkdirSync(artifactsIpcDir, { recursive: true });

    // 准备真实交付文件
    const fileA = 'reports/task_a.md';
    const fileB = 'reports/task_b.md';
    fs.writeFileSync(
      path.join(tmpGroupsDir, workspaceAFolder, fileA),
      'Result A',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpGroupsDir, workspaceAFolder, fileB),
      'Result B',
      'utf-8',
    );

    const runAId = 'run-concurrent-A';
    const runBId = 'run-concurrent-B';

    insertTestRun({
      id: runAId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:concurrentA`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T13:40:00Z',
      definition_snapshot: {
        prompt: 'Task A',
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

    insertTestRun({
      id: runBId,
      task_id: taskId,
      occurrence_key: `task:${taskId}:run:concurrentB`,
      trigger_type: 'scheduled',
      scheduled_for: '2026-09-07T13:45:00Z',
      definition_snapshot: {
        prompt: 'Task B',
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

    // 分别写入属于 Run A 和 Run B 的 IPC 声明文件
    const ipcA = path.join(artifactsIpcDir, 'artifact-runA.json');
    const ipcB = path.join(artifactsIpcDir, 'artifact-runB.json');
    fs.writeFileSync(
      ipcA,
      JSON.stringify({
        runId: runAId,
        taskId,
        path: fileA,
        name: 'Report A',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      ipcB,
      JSON.stringify({
        runId: runBId,
        taskId,
        path: fileB,
        name: 'Report B',
      }),
      'utf-8',
    );

    // 1. Run A 运行完成，执行消费归档
    const archivedA = await processCompletedRunArtifacts({
      runId: runAId,
      ipcDirs: [ipcDir],
      createdBy: 'alice',
    });

    // 验证 Run A 归档成功，ipcA 已被消费删除
    expect(archivedA.length).toBe(1);
    expect(archivedA[0].name).toBe('Report A');
    expect(fs.existsSync(ipcA)).toBe(false);

    // 核心隔离断言：Run B 的声明文件绝未被删除、绝未被误吞，依然完好留在磁盘上！
    expect(fs.existsSync(ipcB)).toBe(true);

    // 2. Run B 运行完成，执行消费归档
    const archivedB = await processCompletedRunArtifacts({
      runId: runBId,
      ipcDirs: [ipcDir],
      createdBy: 'alice',
    });

    // 验证 Run B 归档成功，ipcB 现在已被消费
    expect(archivedB.length).toBe(1);
    expect(archivedB[0].name).toBe('Report B');
    expect(fs.existsSync(ipcB)).toBe(false);
  });

  test('下载安全：URL 中 runId 与 artifactId 归属不一致时拒绝下载', async () => {
    const artifactsA = db.listTaskRunArtifactsByRunId('run-occurrence-001');
    expect(artifactsA.length).toBeGreaterThan(0);
    const artA = artifactsA[0];

    // 尝试在 run-occurrence-002 的 URL 下下载属于 run-occurrence-001 的产物
    const mismatchRes = await tasksRoutes.fetch(
      new Request(
        `http://localhost/runs/run-occurrence-002/artifacts/${artA.id}/download`,
      ),
    );
    expect(mismatchRes.status).toBe(400);
    const body = await mismatchRes.json();
    expect(body.code).toBe('ARTIFACT_RUN_MISMATCH');
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

    // 通过 REST 接口生成接续任务草稿并物化不可变文件到目标工作区
    const draftRes = await tasksRoutes.fetch(
      new Request(`http://localhost/runs/${runId}/draft-continuation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_ids: [artifacts[0].id],
          target_workspace_jid: workspaceAJid,
        }),
      }),
    );
    expect(draftRes.status).toBe(200);
    const draftData = await draftRes.json();
    expect(draftData.success).toBe(true);

    // 验证目标工作区中的不可变接续文件真正存在，并且内容必须为原始 Version 1（不受原文件被覆盖成 Version 3 的影响！）
    const inboundPath = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'inbound_artifacts',
      `${runId}_${artifacts[0].id}`,
      artifacts[0].name,
    );
    expect(fs.existsSync(inboundPath)).toBe(true);
    const readImmutableContent = fs.readFileSync(inboundPath, 'utf-8');
    expect(readImmutableContent).toBe(
      '# Daily Summary Version 1\nTimestamp: 2026-09-07 08:00:00\nMetrics: OK',
    );
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

  test('Leader: leaf replacement after verification must not escape workspace', async () => {
    const runId = 'proof-swap';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: 'proof:swap',
      trigger_type: 'manual',
      scheduled_for: new Date().toISOString(),
      definition_snapshot: {
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        execution_mode: 'container',
      },
      status: 'success',
    });
    const outside = path.join(tmpDir, 'outside-swap-fixture.txt');
    fs.writeFileSync(outside, 'NON_SECRET_SWAPPED_OUTSIDE');
    const leaf = path.join(tmpGroupsDir, workspaceAFolder, 'swap.txt');
    fs.writeFileSync(leaf, 'SAFE_INSIDE');

    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
      file: any,
      ...args: any[]
    ) => {
      if (file === leaf && !swapped) {
        swapped = true;
        fs.unlinkSync(leaf);
        fs.symlinkSync(outside, leaf);
      }
      return realOpen(file, ...(args as [any]));
    }) as any);

    let result;
    try {
      result = await registerArtifactForRun({
        runId,
        relativePath: 'swap.txt',
        createdBy: 'alice',
      });
    } finally {
      spy.mockRestore();
    }

    if (result?.artifact) {
      const d = getArtifactForDownload(result.artifact.id, {
        id: 'alice',
        role: 'member',
      } as any);
      console.log(
        'SWAP_ARCHIVE_RESULT',
        result.success,
        d.status,
        d.status === 'ok' ? d.data.toString() : null,
      );
    }
    expect(result?.success).toBe(false);
  });

  test('Leader: display name cannot write continuation outside target workspace', async () => {
    const runId = 'proof-name';
    insertTestRun({
      id: runId,
      task_id: taskId,
      occurrence_key: 'proof:name',
      trigger_type: 'manual',
      scheduled_for: new Date().toISOString(),
      definition_snapshot: {
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
        execution_mode: 'container',
      },
      status: 'success',
    });
    const leaf = path.join(tmpGroupsDir, workspaceAFolder, 'name.txt');
    fs.writeFileSync(leaf, 'DISPLAY_NAME_ESCAPE_MARKER');
    const result = await registerArtifactForRun({
      runId,
      relativePath: 'name.txt',
      name: '../../../escaped-materialize.txt',
      createdBy: 'alice',
    });
    expect(result.success).toBe(true);

    const dest = path.join(tmpGroupsDir, 'escaped-materialize.txt');
    try {
      const { materializeContinuationArtifacts } =
        await import('../src/task-artifact-service.js');
      materializeContinuationArtifacts(workspaceAFolder, workspaceAJid, [
        result.artifact!,
      ]);
    } catch {
      /* ignore */
    }
    console.log('OUTSIDE_MATERIALIZE_EXISTS', fs.existsSync(dest));
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('Task purge 清理物理产物目录：仅删除该任务的 run 目录，绝不影响其他任务', async () => {
    // 建立一个独立任务用于测试 purge
    const purgeTaskId = 'task-to-be-purged';
    const purgeRunId = 'run-for-purge-test';
    const now = new Date().toISOString();
    db.createTask({
      id: purgeTaskId,
      group_folder: workspaceAFolder,
      chat_jid: workspaceAJid,
      prompt: '待物理清理任务',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      status: 'active',
      created_at: now,
      created_by: 'alice',
    });

    insertTestRun({
      id: purgeRunId,
      task_id: purgeTaskId,
      occurrence_key: `task:${purgeTaskId}:run:1`,
      trigger_type: 'manual',
      scheduled_for: now,
      definition_snapshot: {
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
      },
      status: 'success',
    });

    const fileRel = 'reports/purge_test.md';
    fs.writeFileSync(
      path.join(tmpGroupsDir, workspaceAFolder, fileRel),
      'Purge Content',
      'utf-8',
    );
    const reg = await registerArtifactForRun({
      runId: purgeRunId,
      relativePath: fileRel,
      name: 'purge_test.md',
      createdBy: 'alice',
    });
    expect(reg.success).toBe(true);

    const runDir = path.join(tmpStoreDir, 'artifacts', 'runs', purgeRunId);
    expect(fs.existsSync(runDir)).toBe(true);

    // 软删除
    const softDel = db.softDeleteTaskWithRevision(purgeTaskId, 1);
    expect(softDel.status).toBe('updated');
    // 软删除时不清理物理文件（供历史查询）
    expect(fs.existsSync(runDir)).toBe(true);

    // 彻底清空 (purge)
    const purgeRes = db.permanentlyDeleteTasksWithRevisions([
      { id: purgeTaskId, expectedRevision: 2 },
    ]);
    expect(purgeRes.status).toBe('deleted');

    // 物理目录被彻底受控清理！
    expect(fs.existsSync(runDir)).toBe(false);

    // 其他任务的运行物理产物目录仍然完好保留！
    const otherRunDir = path.join(
      tmpStoreDir,
      'artifacts',
      'runs',
      'run-occurrence-001',
    );
    expect(fs.existsSync(otherRunDir)).toBe(true);
  });

  test('跨用户产物越权防御：普通用户引用其他用户的 artifact_id 时严格跳过物化，零泄露，且自己的合法引用正常物化', async () => {
    const now = new Date().toISOString();
    // 1. Charlie 拥有的私有工作区和产物
    const charlieRunId = 'run-charlie-private';
    const charlieTaskId = 'task-charlie-private';
    db.createTask({
      id: charlieTaskId,
      group_folder: workspaceBFolder,
      chat_jid: workspaceBJid,
      prompt: 'Charlie 的私有任务',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      status: 'active',
      created_at: now,
      created_by: 'charlie',
    });
    insertTestRun({
      id: charlieRunId,
      task_id: charlieTaskId,
      occurrence_key: `task:${charlieTaskId}:run:1`,
      trigger_type: 'manual',
      scheduled_for: now,
      definition_snapshot: {
        group_folder: workspaceBFolder,
        chat_jid: workspaceBJid,
      },
      status: 'success',
    });
    const charlieFile = 'reports/charlie_secret.md';
    fs.mkdirSync(path.join(tmpGroupsDir, workspaceBFolder, 'reports'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpGroupsDir, workspaceBFolder, charlieFile),
      'CHARLIE_CONFIDENTIAL_DATA',
      'utf-8',
    );
    const regCharlie = await registerArtifactForRun({
      runId: charlieRunId,
      relativePath: charlieFile,
      name: 'charlie_secret.md',
      createdBy: 'charlie',
    });
    expect(regCharlie.success).toBe(true);
    const charlieArtifact = regCharlie.artifact!;

    // 2. Alice 拥有的合法产物
    const aliceRunId = 'run-alice-own';
    const aliceTaskId = 'task-alice-own';
    db.createTask({
      id: aliceTaskId,
      group_folder: workspaceAFolder,
      chat_jid: workspaceAJid,
      prompt: 'Alice 的合法任务',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      status: 'active',
      created_at: now,
      created_by: 'alice',
    });
    insertTestRun({
      id: aliceRunId,
      task_id: aliceTaskId,
      occurrence_key: `task:${aliceTaskId}:run:1`,
      trigger_type: 'manual',
      scheduled_for: now,
      definition_snapshot: {
        group_folder: workspaceAFolder,
        chat_jid: workspaceAJid,
      },
      status: 'success',
    });
    const aliceFile = 'reports/alice_public.md';
    fs.writeFileSync(
      path.join(tmpGroupsDir, workspaceAFolder, aliceFile),
      'ALICE_LEGIT_DATA',
      'utf-8',
    );
    const regAlice = await registerArtifactForRun({
      runId: aliceRunId,
      relativePath: aliceFile,
      name: 'alice_public.md',
      createdBy: 'alice',
    });
    expect(regAlice.success).toBe(true);
    const aliceArtifact = regAlice.artifact!;

    // 3. 构造越权攻击：Alice 的任务 prompt 里试图引用 Charlie 的私有产物
    const maliciousPrompt = [
      '继续处理产物：',
      `<artifact_ref id="${charlieArtifact.id}" hash="${charlieArtifact.file_hash}" path="${charlieArtifact.original_path}" name="${charlieArtifact.name}"/>`,
      `<artifact_ref id="${aliceArtifact.id}" hash="${aliceArtifact.file_hash}" path="${aliceArtifact.original_path}" name="${aliceArtifact.name}"/>`,
    ].join('\n');

    const aliceAuthUser = {
      id: 'alice',
      username: 'alice',
      role: 'member' as const,
      status: 'active' as const,
      permissions: [],
      must_change_password: false,
      display_name: 'Alice',
    };

    // 执行准备物化
    prepareTaskContinuationArtifacts(
      maliciousPrompt,
      workspaceAFolder,
      workspaceAJid,
      aliceAuthUser,
    );

    // 断言 1：Charlie 的私有产物绝对没有被拷贝/物化到 Alice 的工作区！
    const charlieInboundDir = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'inbound_artifacts',
      `${charlieArtifact.run_id}_${charlieArtifact.id}`,
    );
    expect(fs.existsSync(charlieInboundDir)).toBe(false);

    // 扫描 Alice 工作区全部 inbound_artifacts，确保不存在任何含有 Charlie 产物 ID 或秘密内容的物理文件
    const aliceInboundRoot = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'inbound_artifacts',
    );
    if (fs.existsSync(aliceInboundRoot)) {
      const allSubdirs = fs.readdirSync(aliceInboundRoot);
      expect(allSubdirs.some((sub) => sub.includes(charlieArtifact.id))).toBe(
        false,
      );
    }

    // 断言 2：Alice 自己的合法产物被正常成功物化！
    const aliceInboundDir = path.join(
      tmpGroupsDir,
      workspaceAFolder,
      'inbound_artifacts',
      `${aliceArtifact.run_id}_${aliceArtifact.id}`,
    );
    expect(fs.existsSync(aliceInboundDir)).toBe(true);
    const materializedContent = fs.readFileSync(
      path.join(aliceInboundDir, 'alice_public.md'),
      'utf-8',
    );
    expect(materializedContent).toBe('ALICE_LEGIT_DATA');
  });

  test('runGroupModeTask 目标工作区物化：当目标工作区 != task.group_folder 时，产物物化到目标工作区而不是源工作区', async () => {
    const now = new Date().toISOString();
    // 建立源工作区与独立目标工作区
    const sourceFolder = 'ws_src';
    const sourceJid = 'web:ws_src';
    const targetFolder = 'ws_dst';
    const targetJid = 'web:ws_dst';
    db.setRegisteredGroup(sourceJid, {
      name: 'Source Workspace',
      folder: sourceFolder,
      added_at: now,
      created_by: 'alice',
    });
    db.setRegisteredGroup(targetJid, {
      name: 'Target Workspace',
      folder: targetFolder,
      added_at: now,
      created_by: 'alice',
    });
    fs.mkdirSync(path.join(tmpGroupsDir, sourceFolder), { recursive: true });
    fs.mkdirSync(path.join(tmpGroupsDir, targetFolder), { recursive: true });

    // 运行产出产物
    const runId = 'run-group-target-test';
    const runTaskId = 'task-group-target';
    db.createTask({
      id: runTaskId,
      group_folder: sourceFolder,
      chat_jid: sourceJid,
      prompt: '任务定义在源工作区',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      execution_type: 'agent',
      execution_mode: 'container',
      status: 'active',
      created_at: now,
      created_by: 'alice',
    });
    insertTestRun({
      id: runId,
      task_id: runTaskId,
      occurrence_key: `task:${runTaskId}:run:1`,
      trigger_type: 'manual',
      scheduled_for: now,
      definition_snapshot: {
        group_folder: sourceFolder,
        chat_jid: sourceJid,
      },
      status: 'success',
    });
    const fileRel = 'reports/group_report.md';
    fs.mkdirSync(path.join(tmpGroupsDir, sourceFolder, 'reports'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpGroupsDir, sourceFolder, fileRel),
      'GROUP_REPORT_DATA',
      'utf-8',
    );
    const reg = await registerArtifactForRun({
      runId,
      relativePath: fileRel,
      name: 'group_report.md',
      createdBy: 'alice',
    });
    expect(reg.success).toBe(true);
    const art = reg.artifact!;

    const prompt = `<artifact_ref id="${art.id}" hash="${art.file_hash}" path="${art.original_path}" name="${art.name}"/>`;
    const aliceAuthUser = {
      id: 'alice',
      username: 'alice',
      role: 'member' as const,
      status: 'active' as const,
      permissions: [],
      must_change_password: false,
      display_name: 'Alice',
    };

    // 调用物化，目标工作区为 targetFolder / targetJid（不同于 sourceFolder）
    prepareTaskContinuationArtifacts(
      prompt,
      targetFolder,
      targetJid,
      aliceAuthUser,
    );

    // 产物必须成功物化到目标工作区 (targetFolder)！
    const targetInbound = path.join(
      tmpGroupsDir,
      targetFolder,
      'inbound_artifacts',
      `${runId}_${art.id}`,
      'group_report.md',
    );
    expect(fs.existsSync(targetInbound)).toBe(true);
    expect(fs.readFileSync(targetInbound, 'utf-8')).toBe('GROUP_REPORT_DATA');

    // 源工作区 (sourceFolder) 绝不应被错误写入！
    const sourceInbound = path.join(
      tmpGroupsDir,
      sourceFolder,
      'inbound_artifacts',
      `${runId}_${art.id}`,
    );
    expect(fs.existsSync(sourceInbound)).toBe(false);
  });

  test('read_artifact 严格匹配：消除前缀/短 ID 误命中 (art-1 vs art-10 vs art)', async () => {
    const wsFolder = 'ws_tools_test';
    const wsDir = path.join(tmpGroupsDir, wsFolder);
    const inboundRoot = path.join(wsDir, 'inbound_artifacts');
    fs.mkdirSync(path.join(inboundRoot, 'runX_art-10'), { recursive: true });
    fs.mkdirSync(path.join(inboundRoot, 'runX_art-1'), { recursive: true });

    fs.writeFileSync(
      path.join(inboundRoot, 'runX_art-10', 'file10.txt'),
      'CONTENT_FOR_ART_10',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(inboundRoot, 'runX_art-1', 'file1.txt'),
      'CONTENT_FOR_ART_1',
      'utf-8',
    );

    const mcpCtx = {
      chatJid: 'web:ws_tools_test',
      groupFolder: wsFolder,
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(tmpDir, 'ipc', wsFolder),
      workspaceGroup: wsDir,
    };

    const tools = createMcpTools(mcpCtx);
    const readTool = tools.find((t) => t.name === 'read_artifact')!;
    expect(readTool).toBeDefined();

    // 1. 查询 art-1：必须精确返回 runX_art-1 的内容，绝不能误返回 runX_art-10！
    const res1 = (await readTool.handler(
      { artifact_id: 'art-1' },
      {} as never,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res1.isError).toBeFalsy();
    expect(res1.content[0].text).toBe('CONTENT_FOR_ART_1');

    // 2. 查询 art：由于不存在名为 art 的产物，绝不能因子串匹配误命中 art-1 或 art-10！
    const resShort = (await readTool.handler(
      { artifact_id: 'art' },
      {} as never,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(resShort.isError).toBe(true);
    expect(resShort.content[0].text).toContain(
      'Artifact ID art not found in workspace inbound_artifacts',
    );

    // 3. 查询 art-10：精确返回 runX_art-10 的内容
    const res10 = (await readTool.handler(
      { artifact_id: 'art-10' },
      {} as never,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res10.isError).toBeFalsy();
    expect(res10.content[0].text).toBe('CONTENT_FOR_ART_10');
  });
});
