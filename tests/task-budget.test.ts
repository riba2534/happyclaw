import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-budget-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
fs.mkdirSync(tmpStoreDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const db = await import('../src/db.js');
const { TaskBudgetService } = await import('../src/task-budget-service.js');
const { RunnerBudgetTracker } =
  await import('../container/agent-runner/src/runner-budget.js');

let budgetService: InstanceType<typeof TaskBudgetService>;

beforeAll(() => {
  db.initDatabase();
  budgetService = new TaskBudgetService();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HappyClaw R16 Task Budget Service & Invariants', () => {
  test('1. Default behavior: tasks without budget run unrestricted without interference', () => {
    const runId = 'test-run-unrestricted';
    const record = budgetService.initBudget({
      runId,
      taskId: 'task-no-budget',
      config: null,
    });
    expect(record.max_duration_ms).toBeNull();
    expect(record.max_tool_calls).toBeNull();
    expect(record.max_cost_usd).toBeNull();

    // Tool calls and cost should always be allowed
    for (let i = 0; i < 50; i++) {
      const toolCheck = budgetService.checkAndConsumeToolCall(
        runId,
        'read_file',
      );
      expect(toolCheck.allowed).toBe(true);
    }
    const costCheck = budgetService.recordCost(runId, 10.5);
    expect(costCheck.exceeded).toBe(false);

    const status = budgetService.getStatus(runId);
    expect(status?.configured).toBe(false);
    expect(status?.status).toBe('active');
    expect(status?.currentToolCalls).toBe(50);
  });

  test('2. Parent and child spawn delegation share consumption atomically', () => {
    const parentRunId = 'parent-run-spawn-1';
    const childRunId = 'child-run-spawn-1';

    // Parent has a strict limit of 5 tool calls total
    budgetService.initBudget({
      runId: parentRunId,
      config: { maxToolCalls: 5 },
    });

    // Child task is spawned and linked to parent
    budgetService.initBudget({
      runId: childRunId,
      parentRunId,
      config: { maxToolCalls: 10 },
    });

    // Parent makes 2 tool calls
    expect(
      budgetService.checkAndConsumeToolCall(parentRunId, 'bash').allowed,
    ).toBe(true);
    expect(
      budgetService.checkAndConsumeToolCall(parentRunId, 'edit').allowed,
    ).toBe(true);

    // Child makes 2 tool calls -> propagated to parent
    expect(
      budgetService.checkAndConsumeToolCall(childRunId, 'web_search').allowed,
    ).toBe(true);
    expect(
      budgetService.checkAndConsumeToolCall(childRunId, 'read_file').allowed,
    ).toBe(true);

    let parentStatus = budgetService.getStatus(parentRunId);
    let childStatus = budgetService.getStatus(childRunId);
    // Parent total = 2 (own) + 2 (child) = 4
    expect(parentStatus?.currentToolCalls).toBe(4);
    expect(childStatus?.currentToolCalls).toBe(2);

    // Child makes 5th tool call -> reaches parent limit of 5
    expect(
      budgetService.checkAndConsumeToolCall(childRunId, 'read_file').allowed,
    ).toBe(true);

    parentStatus = budgetService.getStatus(parentRunId);
    expect(parentStatus?.currentToolCalls).toBe(5);

    // Now parent has reached limit (5/5). Child making 6th call should be blocked by parent budget!
    const blockedCall = budgetService.checkAndConsumeToolCall(
      childRunId,
      'another_tool',
    );
    expect(blockedCall.allowed).toBe(false);
    expect(blockedCall.reason).toBe('tool_calls');
    expect(blockedCall.message).toMatch(/(Parent|Ancestor) task budget/);

    parentStatus = budgetService.getStatus(parentRunId);
    expect(parentStatus?.status).toBe('exceeded');
  });

  test('3. Warm runner isolation: next input does not inherit prior input consumption', () => {
    const tracker = new RunnerBudgetTracker({
      runId: 'turn-1',
      config: { maxToolCalls: 3, maxCostUsd: 1.0 },
    });

    // Turn 1 executes 2 tool calls and incurs cost
    expect(tracker.checkToolCall('bash').allowed).toBe(true);
    expect(tracker.checkToolCall('edit').allowed).toBe(true);
    tracker.recordUsageCost(0.45);

    const snapshot1 = tracker.getSnapshot();
    expect(snapshot1.currentToolCalls).toBe(2);
    expect(snapshot1.currentCostUsd).toBeCloseTo(0.45);

    // Warm runner finishes turn 1 and activates turn 2 (IPC message arrives)
    tracker.resetForNextInput('turn-2', { maxToolCalls: 3, maxCostUsd: 1.0 });

    const snapshot2 = tracker.getSnapshot();
    expect(snapshot2.currentToolCalls).toBe(0);
    expect(snapshot2.currentCostUsd).toBe(0);
    expect(snapshot2.status).toBe('active');
    expect(snapshot2.exceededReason).toBeNull();

    // Turn 2 can now safely perform 3 tool calls without being blocked by Turn 1
    expect(tracker.checkToolCall('tool_a').allowed).toBe(true);
    expect(tracker.checkToolCall('tool_b').allowed).toBe(true);
    expect(tracker.checkToolCall('tool_c').allowed).toBe(true);
    expect(tracker.checkToolCall('tool_d').allowed).toBe(false);

    tracker.dispose();
  });

  test('4. Provider retry accounting: retries increment retryCount and preserve consumption', () => {
    const runId = 'retry-test-run';
    budgetService.initBudget({
      runId,
      config: { maxToolCalls: 10, maxCostUsd: 2.0 },
    });

    // Initial attempt makes 3 tool calls and incurs $0.30
    budgetService.checkAndConsumeToolCall(runId, 'tool1');
    budgetService.checkAndConsumeToolCall(runId, 'tool2');
    budgetService.checkAndConsumeToolCall(runId, 'tool3');
    budgetService.recordCost(runId, 0.3);

    // Provider transient failure triggers retry
    budgetService.recordRetry(runId);

    const statusAfterRetry = budgetService.getStatus(runId);
    expect(statusAfterRetry?.retryCount).toBe(1);
    expect(statusAfterRetry?.currentToolCalls).toBe(3);
    expect(statusAfterRetry?.currentCostUsd).toBeCloseTo(0.3);

    // Retry continues and uses more resources
    budgetService.checkAndConsumeToolCall(runId, 'tool4');
    budgetService.recordCost(runId, 0.2);

    const statusFinal = budgetService.getStatus(runId);
    expect(statusFinal?.currentToolCalls).toBe(4);
    expect(statusFinal?.currentCostUsd).toBeCloseTo(0.5);
  });

  test('5. Restart recovery: persistent store preserves partial state and limits', () => {
    const runId = 'restart-recovery-run';
    budgetService.initBudget({
      runId,
      config: { maxDurationMs: 60000, maxToolCalls: 8, maxCostUsd: 1.5 },
    });

    budgetService.checkAndConsumeToolCall(runId, 'toolA');
    budgetService.checkAndConsumeToolCall(runId, 'toolB');
    budgetService.recordCost(runId, 0.75);
    budgetService.recordDuration(runId, 12000);

    // Simulate process restart by recreating a brand new service instance reading from DB
    const restartedService = new TaskBudgetService();
    const recovered = restartedService.initBudget({
      runId,
      config: { maxDurationMs: 60000, maxToolCalls: 8, maxCostUsd: 1.5 },
    });

    expect(recovered.run_id).toBe(runId);
    expect(recovered.current_tool_calls).toBe(2);
    expect(recovered.current_cost_usd).toBeCloseTo(0.75);
    expect(recovered.current_duration_ms).toBe(12000);
    expect(recovered.max_tool_calls).toBe(8);
    expect(recovered.status).toBe('active');
  });

  test('6. Limits reached: stops further execution, preserves partial results with clear reason', async () => {
    const runId = 'limit-reached-run';
    budgetService.initBudget({
      runId,
      config: { maxToolCalls: 2 },
    });

    budgetService.checkAndConsumeToolCall(runId, 'tool1');
    budgetService.checkAndConsumeToolCall(runId, 'tool2');

    // 3rd tool call is blocked
    const thirdCall = budgetService.checkAndConsumeToolCall(runId, 'tool3');
    expect(thirdCall.allowed).toBe(false);
    expect(thirdCall.reason).toBe('tool_calls');

    // Save partial results and mark exceeded
    const partialResult = 'Partially generated report before tool call limit.';
    const exceededStatus = budgetService.markExceededAndSavePartial(
      runId,
      'tool_calls',
      partialResult,
    );
    expect(exceededStatus.status).toBe('exceeded');
    expect(exceededStatus.exceededReason).toBe('tool_calls');
    expect(exceededStatus.partialResult).toBe(partialResult);

    // Check PreToolUse hook behavior in runner
    const tracker = new RunnerBudgetTracker({
      runId: 'runner-limit-run',
      config: { maxToolCalls: 1 },
    });
    const hook = tracker.createPreToolUseHook();

    // 1st tool call allowed
    let hookRes = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
    } as any);
    expect(hookRes).toEqual({});

    // 2nd tool call denied
    hookRes = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
    } as any);
    expect((hookRes as any).hookSpecificOutput?.permissionDecision).toBe(
      'deny',
    );
    expect(
      (hookRes as any).hookSpecificOutput?.permissionDecisionReason,
    ).toContain('Task budget exceeded');

    tracker.dispose();
  });

  test('7. Explicit resume: grants additional quota and resumes execution seamlessly', () => {
    const runId = 'resume-test-run';
    budgetService.initBudget({
      runId,
      config: { maxToolCalls: 2, maxCostUsd: 0.5 },
    });

    budgetService.checkAndConsumeToolCall(runId, 'call1');
    budgetService.checkAndConsumeToolCall(runId, 'call2');
    expect(budgetService.checkAndConsumeToolCall(runId, 'call3').allowed).toBe(
      false,
    );

    budgetService.markExceededAndSavePartial(
      runId,
      'tool_calls',
      'partial findings',
    );
    expect(budgetService.getStatus(runId)?.status).toBe('exceeded');

    // User explicitly resumes with 5 more tool calls and $0.50 more budget
    const resumed = budgetService.resumeBudget(runId, {
      additionalToolCalls: 5,
      additionalCostUsd: 0.5,
    });

    expect(resumed?.status).toBe('active');
    expect(resumed?.exceededReason).toBeNull();
    // maxToolCalls should now be 2 + 5 = 7
    expect(resumed?.maxToolCalls).toBe(7);
    expect(resumed?.maxCostUsd).toBeCloseTo(1.0);
    expect(resumed?.resumedAt).toBeTruthy();

    // Can now successfully call tools again
    const nextCall = budgetService.checkAndConsumeToolCall(runId, 'call3');
    expect(nextCall.allowed).toBe(true);
    expect(budgetService.getStatus(runId)?.currentToolCalls).toBe(3);
  });

  test('8. ScheduledTask definition snapshots freeze budget and completeIsolatedTask preserves partial result', () => {
    const taskId = 'task-with-budget-1';
    db.createTask({
      id: taskId,
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'do some complex analysis',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      budget: { maxDurationMs: 300000, maxToolCalls: 15, maxCostUsd: 2.5 },
    });

    const task = db.getTaskById(taskId);
    expect(task?.budget?.maxToolCalls).toBe(15);
    expect(task?.budget?.maxCostUsd).toBe(2.5);

    // Materialize occurrence -> creates a task_run
    const createdRun = db.createTaskRun({ task: task!, triggerType: 'manual' });
    expect(createdRun.created).toBe(true);

    const claimed = db.claimNextTaskRun(
      'test-worker-1',
      60000,
      new Date().toISOString(),
    );
    expect(claimed).toBeTruthy();
    if (!claimed) return;

    expect(claimed.definition_snapshot.budget).toEqual({
      maxDurationMs: 300000,
      maxToolCalls: 15,
      maxCostUsd: 2.5,
    });

    // Settle with budget_exceeded
    const partialResultText = 'Partial analysis finished before timeout.';
    const completed = db.completeIsolatedTaskRunWithWorkspaceResultIntent({
      runId: claimed.id,
      taskId: claimed.task_id,
      leaseOwner: claimed.lease_owner,
      leaseToken: claimed.lease_token,
      status: 'budget_exceeded',
      result: `${partialResultText}\n\n[任务已达到单次运行预算上限 (duration)，已保留当前部分成果。可调整预算后显式恢复继续。]`,
      payload: {
        kind: 'workspace_result',
        chatJid: 'web:workspace',
        text: 'Formatted message',
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-task-result:${claimed.id}`,
        },
      },
    });
    expect(completed).toBe(true);

    const runAfter = db.getTaskRunById(claimed.id);
    expect(runAfter?.status).toBe('budget_exceeded');
    expect(runAfter?.result).toContain(partialResultText);
    expect(runAfter?.result).toContain('任务已达到单次运行预算上限');
  });

  test('9. Budget query and resume workflow persists and updates definitions correctly', () => {
    const taskId = 'task-budget-lifecycle-1';
    db.createTask({
      id: taskId,
      group_folder: 'workspace-lifecycle',
      chat_jid: 'web:workspace-lifecycle',
      prompt: 'test prompt',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 60000).toISOString(),
      context_mode: 'isolated',
      execution_type: 'agent',
      status: 'active',
      created_at: new Date().toISOString(),
      budget: { maxToolCalls: 5, maxDurationMs: 60000 },
    });

    // Verify task budget stored in DB
    const fetched = db.getTaskById(taskId);
    expect(fetched?.budget?.maxToolCalls).toBe(5);
    expect(fetched?.budget?.maxDurationMs).toBe(60000);

    // Initialize budget run record
    const runId = `task-run-for-${taskId}`;
    budgetService.initBudget({
      runId,
      taskId,
      chatJid: 'web:workspace-lifecycle',
      groupFolder: 'workspace-lifecycle',
      config: fetched?.budget,
    });

    const budgets = db.getTaskBudgetsByTaskId(taskId);
    expect(budgets.length).toBe(1);
    expect(budgets[0].run_id).toBe(runId);
    expect(budgets[0].max_tool_calls).toBe(5);

    // Simulate reaching limit and stopping
    budgetService.markExceededAndSavePartial(
      runId,
      'tool_calls',
      'partial draft',
    );
    expect(budgetService.getStatus(runId)?.status).toBe('exceeded');

    // Resume budget explicitly with additional quota
    const resumed = budgetService.resumeBudget(runId, {
      additionalToolCalls: 10,
      additionalCostUsd: 1.0,
    });
    expect(resumed?.status).toBe('active');
    expect(resumed?.maxToolCalls).toBe(15);
    expect(resumed?.maxCostUsd).toBe(1.0);

    // Update task budget via revision
    const updated = db.updateTaskWithRevision(taskId, fetched!.revision, {
      budget: { maxToolCalls: 20, maxDurationMs: 120000, maxCostUsd: 3.0 },
    });
    expect(updated.status).toBe('updated');
    if (updated.status === 'updated') {
      expect(updated.task.budget?.maxToolCalls).toBe(20);
      expect(updated.task.budget?.maxCostUsd).toBe(3.0);
    }
  });
});
