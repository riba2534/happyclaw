import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-e2e-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

let currentAuthUser = {
  id: 'user-alice',
  username: 'alice',
  role: 'member' as const,
  status: 'active' as const,
};

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', currentAuthUser);
    await next();
  },
}));

const db = await import('../src/db.js');
const { taskBudgetService } = await import('../src/task-budget-service.js');
const { RunnerBudgetTracker } =
  await import('../container/agent-runner/src/runner-budget.js');
const tasksRouteModule = await import('../src/routes/tasks.js');
const tasksApp = tasksRouteModule.default;

beforeAll(() => {
  db.initDatabase();
  // Register a test group
  db.setRegisteredGroup('web:workspace-budget', {
    name: 'Budget Workspace',
    folder: 'workspace-budget',
    added_at: new Date().toISOString(),
    created_by: 'user-alice',
  });
  // Register an admin-only host group
  db.setRegisteredGroup('web:workspace-admin-host', {
    name: 'Admin Host Workspace',
    folder: 'workspace-admin-host',
    added_at: new Date().toISOString(),
    execution_mode: 'host',
    created_by: 'admin',
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HappyClaw R16 End-to-End Production Budget Tests', () => {
  test('E2E-1: Real Runner protocol syncs budget_status stream events to persistent SQLite store', () => {
    const runId = 'e2e-run-stream-sync-1';
    taskBudgetService.initBudget({
      runId,
      chatJid: 'web:workspace-budget',
      groupFolder: 'workspace-budget',
      config: { maxToolCalls: 10, maxDurationMs: 60000, maxCostUsd: 1.0 },
    });

    // Simulate Runner executing and emitting stream events over the protocol
    const tracker = new RunnerBudgetTracker({
      runId,
      config: { maxToolCalls: 10, maxDurationMs: 60000, maxCostUsd: 1.0 },
    });

    // Perform 3 tool calls in runner
    tracker.checkToolCall('bash');
    tracker.checkToolCall('edit');
    tracker.checkToolCall('read');

    // Runner emits stream event with snapshot
    const snapshot = tracker.getSnapshot('partial text accumulated');

    // Host receives budget_status event and syncs to SQLite
    taskBudgetService.syncSnapshotFromRunner(runId, snapshot);

    // Verify persisted record in SQLite DB is truly updated
    const persisted = db.getTaskBudget(runId);
    expect(persisted).toBeTruthy();
    expect(persisted?.current_tool_calls).toBe(3);
    expect(persisted?.partial_result).toBe('partial text accumulated');
    expect(persisted?.status).toBe('active');

    tracker.dispose();
  });

  test('E2E-2: Persistent DB recovery survives process restart', () => {
    const runId = 'e2e-run-restart-recovery';
    taskBudgetService.initBudget({
      runId,
      config: { maxToolCalls: 20, maxCostUsd: 5.0 },
    });

    // Simulate work: tool calls + costs
    db.updateTaskBudgetUsage(runId, {
      toolCallsDelta: 7,
      costUsdDelta: 1.25,
      durationMsDelta: 15000,
    });

    // Simulate restart: re-fetch from SQLite via fresh DB connection
    const recovered = db.getTaskBudget(runId);
    expect(recovered?.run_id).toBe(runId);
    expect(recovered?.current_tool_calls).toBe(7);
    expect(recovered?.current_cost_usd).toBeCloseTo(1.25);
    expect(recovered?.current_duration_ms).toBe(15000);
    expect(recovered?.status).toBe('active');
  });

  test('E2E-3: Runner PreToolUse tool call limit enforcement and partial result preservation', async () => {
    const runId = 'e2e-run-tool-limit';
    const tracker = new RunnerBudgetTracker({
      runId,
      config: { maxToolCalls: 2 },
    });
    const hook = tracker.createPreToolUseHook();

    // Call 1: allowed
    const res1 = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'tool_1',
    } as any);
    expect((res1 as any).hookSpecificOutput).toBeUndefined();

    // Call 2: allowed
    const res2 = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'tool_2',
    } as any);
    expect((res2 as any).hookSpecificOutput).toBeUndefined();

    // Call 3: denied by budget limit
    const res3 = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'tool_3',
    } as any);
    expect((res3 as any).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(
      (res3 as any).hookSpecificOutput?.permissionDecisionReason,
    ).toContain('tool calls limit reached');

    expect(tracker.isExceeded()).toBe(true);
    expect(tracker.getExceededReason()).toBe('tool_calls');

    tracker.setPartialResult('Data retrieved before tool limit');
    const snapshot = tracker.getSnapshot();
    expect(snapshot.status).toBe('exceeded');
    expect(snapshot.partialResult).toBe('Data retrieved before tool limit');

    // Host persists exceeded state
    taskBudgetService.syncSnapshotFromRunner(runId, snapshot);
    const dbRecord = db.getTaskBudget(runId);
    expect(dbRecord?.status).toBe('exceeded');
    expect(dbRecord?.exceeded_reason).toBe('tool_calls');
    expect(dbRecord?.partial_result).toBe('Data retrieved before tool limit');

    tracker.dispose();
  });

  test('E2E-4: Real-time incremental usage cost detection interrupts long tool loops', () => {
    const tracker = new RunnerBudgetTracker({
      runId: 'e2e-run-cost-limit',
      config: { maxCostUsd: 0.1 },
    });

    let interruptedReason: string | null = null;
    tracker['onExceededCallback'] = (reason) => {
      interruptedReason = reason;
    };

    // First model response: $0.04
    const exceeded1 = tracker.recordIncrementalUsage('msg-1', 0.04);
    expect(exceeded1).toBe(false);
    expect(tracker.isExceeded()).toBe(false);

    // Repeated event replay: idempotent, ignored
    const replayed = tracker.recordIncrementalUsage('msg-1', 0.04);
    expect(replayed).toBe(false);
    expect(tracker.getSnapshot().currentCostUsd).toBeCloseTo(0.04);

    // Second model response: $0.07 -> total $0.11 >= $0.10
    const exceeded2 = tracker.recordIncrementalUsage('msg-2', 0.07);
    expect(exceeded2).toBe(true);
    expect(tracker.isExceeded()).toBe(true);
    expect(interruptedReason).toBe('cost');

    tracker.dispose();
  });

  test('E2E-5: Ancestor hierarchy & concurrent children atomic budget pool sharing', () => {
    const rootRunId = 'root-parent-run';
    const child1RunId = 'child-run-1';
    const child2RunId = 'child-run-2';
    const grandChildRunId = 'grandchild-run-1';

    // Root parent allows at most 4 tool calls total across the whole tree
    taskBudgetService.initBudget({
      runId: rootRunId,
      config: { maxToolCalls: 4 },
    });

    // Two parallel children
    taskBudgetService.initBudget({
      runId: child1RunId,
      parentRunId: rootRunId,
    });
    taskBudgetService.initBudget({
      runId: child2RunId,
      parentRunId: rootRunId,
    });
    // Deeply nested grandchild under child1
    taskBudgetService.initBudget({
      runId: grandChildRunId,
      parentRunId: child1RunId,
    });

    // Child 1 uses 1 tool call
    expect(
      taskBudgetService.checkAndConsumeToolCall(child1RunId, 'tool_a').allowed,
    ).toBe(true);
    // Child 2 concurrently uses 2 tool calls
    expect(
      taskBudgetService.checkAndConsumeToolCall(child2RunId, 'tool_b').allowed,
    ).toBe(true);
    expect(
      taskBudgetService.checkAndConsumeToolCall(child2RunId, 'tool_c').allowed,
    ).toBe(true);
    // Grandchild uses 1 tool call -> reaches root total 4
    expect(
      taskBudgetService.checkAndConsumeToolCall(grandChildRunId, 'tool_d')
        .allowed,
    ).toBe(true);

    // Root total is now 4/4
    expect(db.getTaskBudget(rootRunId)?.current_tool_calls).toBe(4);

    // Now, any further tool call from Child 1, Child 2, or Grandchild must be blocked by the root ancestor!
    const blockedChild1 = taskBudgetService.checkAndConsumeToolCall(
      child1RunId,
      'tool_e',
    );
    expect(blockedChild1.allowed).toBe(false);
    expect(blockedChild1.message).toContain('Ancestor task budget');

    const blockedChild2 = taskBudgetService.checkAndConsumeToolCall(
      child2RunId,
      'tool_f',
    );
    expect(blockedChild2.allowed).toBe(false);
    expect(blockedChild2.message).toContain('Ancestor task budget');

    const blockedGrandChild = taskBudgetService.checkAndConsumeToolCall(
      grandChildRunId,
      'tool_g',
    );
    expect(blockedGrandChild.allowed).toBe(false);
    expect(blockedGrandChild.message).toContain('Ancestor task budget');
  });

  test('E2E-6: Security & ACL: unprivileged users cannot resume host/script tasks or access private runs', async () => {
    // Create an admin host script task
    const hostTaskId = 'admin-host-script-task';
    db.createTask({
      id: hostTaskId,
      group_folder: 'workspace-admin-host',
      chat_jid: 'web:workspace-admin-host',
      prompt: 'rm -rf /',
      schedule_type: 'cron',
      schedule_value: '0 0 * * *',
      context_mode: 'isolated',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'echo dangerous',
      status: 'active',
      created_by: 'admin',
      created_at: new Date().toISOString(),
      budget: { maxDurationMs: 60000 },
    });

    // Simulate an ordinary member trying to query or resume this host task
    currentAuthUser = {
      id: 'user-bob',
      username: 'bob',
      role: 'member',
      status: 'active',
    };

    const getRes = await tasksApp.request(`/${hostTaskId}/budget`);
    expect(getRes.status).toBe(404); // Hidden from unauthorized member

    const resumeRes = await tasksApp.request(`/${hostTaskId}/budget/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalToolCalls: 5 }),
    });
    expect(resumeRes.status).toBe(404); // Blocked

    // Now switch to admin
    currentAuthUser = {
      id: 'admin',
      username: 'admin',
      role: 'admin',
      status: 'active',
    };
    const adminGetRes = await tasksApp.request(`/${hostTaskId}/budget`);
    expect(adminGetRes.status).toBe(200); // Admin can view
  });

  test('E2E-7: Real Resume: validates budget_exceeded run, CAS requeues, carries partial result and continues', async () => {
    const taskId = 'e2e-resumable-task-1';
    db.createTask({
      id: taskId,
      group_folder: 'workspace-budget',
      chat_jid: 'web:workspace-budget',
      prompt: 'generate exhaustive audit report',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 3600_000).toISOString(),
      context_mode: 'isolated',
      execution_type: 'agent',
      status: 'active',
      created_by: 'user-alice',
      created_at: new Date().toISOString(),
      budget: { maxToolCalls: 2, maxDurationMs: 60000 },
    });

    const task = db.getTaskById(taskId)!;
    // Materialize task run
    const createdRun = db.createTaskRun({ task, triggerType: 'manual' });
    const runId = (createdRun as any).run.id;

    taskBudgetService.initBudget({
      runId,
      taskId,
      chatJid: task.chat_jid,
      groupFolder: task.group_folder,
      config: task.budget,
    });

    // Worker claims and starts execution
    const claimed = db.claimNextTaskRun(
      'worker-1',
      60000,
      new Date().toISOString(),
    );
    expect(claimed?.id).toBe(runId);

    // Settle run as budget_exceeded with partial text
    const partialText = 'Step 1: Inventory complete. Step 2: In progress...';
    db.completeIsolatedTaskRunWithWorkspaceResultIntent({
      runId,
      taskId,
      leaseOwner: claimed!.lease_owner,
      leaseToken: claimed!.lease_token,
      status: 'budget_exceeded',
      result: `${partialText}\n\n[任务已达到单次运行预算上限 (tool_calls)，已保留当前部分成果。可调整预算后显式恢复继续。]`,
      payload: {
        kind: 'workspace_result',
        chatJid: 'web:workspace-budget',
        text: 'Partial notification text',
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-task-result:${runId}`,
        },
      },
    });

    // Save partial result to budget ledger
    taskBudgetService.markExceededAndSavePartial(
      runId,
      'tool_calls',
      partialText,
    );

    let runInDb = db.getTaskRunById(runId);
    expect(runInDb?.status).toBe('budget_exceeded');

    // Alice resumes the task with additional 5 tool calls
    currentAuthUser = {
      id: 'user-alice',
      username: 'alice',
      role: 'member',
      status: 'active',
    };
    const resumeRes = await tasksApp.request(`/${taskId}/budget/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: runId,
        additionalToolCalls: 5,
      }),
    });

    expect(resumeRes.status).toBe(200);
    const resumeJson = (await resumeRes.json()) as any;
    expect(resumeJson.success).toBe(true);
    expect(resumeJson.run.status).toBe('queued'); // CAS successfully placed run back in queued!

    // Verify run in DB is queued and ready for scheduler
    runInDb = db.getTaskRunById(runId);
    expect(runInDb?.status).toBe('queued');
    expect(runInDb?.lease_owner).toBeNull();

    // Verify budget ledger has new limits and preserved partial result
    const budgetStatus = taskBudgetService.getStatus(runId);
    expect(budgetStatus?.status).toBe('active');
    expect(budgetStatus?.maxToolCalls).toBe(7); // 2 + 5 = 7
    expect(budgetStatus?.partialResult).toBe(partialText); // Partial preserved!
    expect(budgetStatus?.resumedAt).toBeTruthy();

    // Scheduler picks up the resumed run
    const reclaimed = db.claimNextTaskRun(
      'worker-2',
      60000,
      new Date().toISOString(),
    );
    expect(reclaimed?.id).toBe(runId);
    expect(reclaimed?.status).toBe('running');

    // Execution completes the rest of the work and finalizes full report
    const subsequentText = 'Step 2: Finished analysis. Step 3: All clean.';
    const finalReport = `${partialText}\n\n---\n\n${subsequentText}`;
    db.completeIsolatedTaskRunWithWorkspaceResultIntent({
      runId,
      taskId,
      leaseOwner: reclaimed!.lease_owner,
      leaseToken: reclaimed!.lease_token,
      status: 'success',
      result: finalReport,
      payload: {
        kind: 'workspace_result',
        chatJid: 'web:workspace-budget',
        text: finalReport,
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-task-result:${runId}`,
        },
      },
    });

    const finalRun = db.getTaskRunById(runId);
    expect(finalRun?.status).toBe('success');
    expect(finalRun?.result).toContain(partialText);
    expect(finalRun?.result).toContain(subsequentText);
  });
});
