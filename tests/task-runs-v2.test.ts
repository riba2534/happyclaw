import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runs-v2-'));
const tmpStoreDir = path.join(tmpDir, 'db');
fs.mkdirSync(tmpStoreDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createDefinition(id: string, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date().toISOString();
  db.createTask({
    id,
    group_folder: 'workspace',
    chat_jid: 'web:workspace',
    prompt: 'report status',
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() - 1_000).toISOString(),
    status: 'active',
    created_at: createdAt,
    notify_channels: ['feishu'],
    ...overrides,
  } as Parameters<typeof db.createTask>[0]);
  return db.getTaskById(id)!;
}

describe('scheduled task definition revisions', () => {
  test('uses CAS and preserves soft-deleted definitions for restore/history', () => {
    const onceAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const task = createDefinition('revision-task', {
      schedule_type: 'once',
      schedule_value: onceAt,
      next_run: onceAt,
    });
    expect(task.revision).toBe(1);
    expect(task.updated_at).toBe(task.created_at);

    const updated = db.updateTaskWithRevision(task.id, 1, { prompt: 'new' });
    expect(updated.status).toBe('updated');
    if (updated.status !== 'updated') return;
    expect(updated.task.revision).toBe(2);
    expect(
      db.updateTaskWithRevision(task.id, 1, { prompt: 'stale' }).status,
    ).toBe('conflict');

    const deleted = db.softDeleteTaskWithRevision(task.id, 2);
    expect(deleted.status).toBe('updated');
    expect(db.getAllTasks().map((item) => item.id)).not.toContain(task.id);
    expect(db.getDeletedTasks().map((item) => item.id)).toContain(task.id);
    if (deleted.status !== 'updated') return;
    const restored = db.restoreTaskWithRevision(task.id, deleted.task.revision);
    expect(restored.status).toBe('updated');
    if (restored.status === 'updated') {
      expect(restored.task.status).toBe('paused');
      expect(restored.task.next_run).toBeNull();
      expect(restored.task.deleted_at).toBeNull();
      expect(restored.task.schedule_type).toBe('once');
      expect(restored.task.schedule_value).toBe(onceAt);
    }
  });

  test('soft delete atomically rejects active runs and execution boundary rejects deleted tasks', () => {
    const task = createDefinition('delete-execution-race');
    const active = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'active-before-delete',
    });
    const blocked = db.softDeleteTaskWithRevision(task.id, task.revision);
    expect(blocked.status).toBe('active_run');
    if (blocked.status === 'active_run') {
      expect(blocked.run.id).toBe(active.run.id);
    }
    db.cancelTaskRun(active.run.id);

    const deleted = db.softDeleteTaskWithRevision(task.id, task.revision);
    expect(deleted.status).toBe('updated');
    const late = db.createTaskRun({
      // Simulate a stale definition captured immediately before deletion.
      task,
      triggerType: 'manual',
      idempotencyKey: 'late-after-delete',
    });
    expect(late.created).toBe(true);
    let claim;
    do {
      claim = db.claimNextTaskRun('race-worker', 60_000);
      expect(claim).toBeTruthy();
      if (claim && claim.id !== late.run.id) db.cancelTaskRun(claim.id);
    } while (claim && claim.id !== late.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        late.run.id,
        claim!.lease_owner,
        claim!.lease_token,
      ),
    ).toBe(false);
  });
});

describe('durable task occurrences', () => {
  test('treats only delivered group runs as active and prioritizes executable work', () => {
    const groupTask = createDefinition('active-delivered-group', {
      context_mode: 'group',
    });
    const delivered = db.createTaskRun({
      task: groupTask,
      triggerType: 'manual',
      idempotencyKey: 'active-delivered-group-first',
    });
    const groupClaim = db.claimNextTaskRun(
      'active-delivered-group-worker',
      60_000,
    )!;
    expect(groupClaim.id).toBe(delivered.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        groupClaim.id,
        groupClaim.lease_owner,
        groupClaim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(
        groupClaim.id,
        groupClaim.lease_owner,
        groupClaim.lease_token,
        {
          status: 'delivered',
          result: 'queued in workspace',
          notificationStatus: 'skipped',
        },
      ),
    ).toBe(true);
    expect(db.getActiveTaskRunForTask(groupTask.id)?.id).toBe(delivered.run.id);

    const queued = db.createTaskRun({
      task: groupTask,
      triggerType: 'manual',
      idempotencyKey: 'active-delivered-group-second',
    });
    expect(queued.created).toBe(true);
    expect(db.getActiveTaskRunForTask(groupTask.id)?.id).toBe(queued.run.id);
    expect(db.cancelTaskRun(queued.run.id)).toBe(true);
    expect(db.getActiveTaskRunForTask(groupTask.id)?.id).toBe(delivered.run.id);
    expect(
      db.finalizeDeliveredGroupTaskRun(delivered.run.id, groupTask.id, {
        status: 'cancelled',
        error: 'test cleanup',
      }),
    ).toBe(true);

    const isolatedTask = createDefinition('inactive-delivered-isolated');
    const isolated = db.createTaskRun({
      task: isolatedTask,
      triggerType: 'manual',
      idempotencyKey: 'inactive-delivered-isolated-run',
    });
    const isolatedClaim = db.claimNextTaskRun(
      'inactive-delivered-isolated-worker',
      60_000,
    )!;
    expect(isolatedClaim.id).toBe(isolated.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        isolatedClaim.id,
        isolatedClaim.lease_owner,
        isolatedClaim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(
        isolatedClaim.id,
        isolatedClaim.lease_owner,
        isolatedClaim.lease_token,
        {
          status: 'delivered',
          result: 'legacy isolated delivery',
          notificationStatus: 'skipped',
        },
      ),
    ).toBe(true);
    expect(db.getActiveTaskRunForTask(isolatedTask.id)).toBeUndefined();
    expect(
      db.finalizeDeliveredGroupTaskRun(isolated.run.id, isolatedTask.id, {
        status: 'failed',
        error: 'test cleanup',
      }),
    ).toBe(true);
  });

  test('freezes the concrete delivery route in each run snapshot', () => {
    const originalRoute =
      'feishu:oc_snapshot#account:bot-a#thread:t-1#root:m-1';
    const task = createDefinition('route-snapshot', {
      chat_jid: 'feishu:oc_snapshot#account:bot-a',
      delivery_route_jid: originalRoute,
    });
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'route-snapshot-run',
    });
    expect(created.run.definition_snapshot.delivery_route_jid).toBe(
      originalRoute,
    );

    const updated = db.updateTaskWithRevision(task.id, task.revision, {
      chat_jid: 'web:other-workspace',
      group_folder: 'other-workspace',
      delivery_route_jid: 'web:other-workspace',
    });
    expect(updated.status).toBe('updated');
    expect(
      db.getTaskRunById(created.run.id)?.definition_snapshot.delivery_route_jid,
    ).toBe(originalRoute);
    db.cancelTaskRun(created.run.id);
  });

  test('deduplicates manual idempotency keys and blocks overlap', () => {
    const task = createDefinition('manual-dedupe');
    const first = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'request-1',
    });
    expect(first.created).toBe(true);
    const duplicate = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'request-1',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.id).toBe(first.run.id);

    const overlap = db.createTaskRun({ task, triggerType: 'manual' });
    expect(overlap.created).toBe(false);
    expect(overlap.reason).toBe('active_conflict');
    db.cancelTaskRun(first.run.id);
  });

  test('materializes and advances a definition atomically; overlap is missed', () => {
    const task = createDefinition('scheduled-materialize');
    const scheduledFor = task.next_run!;
    const nextRun = new Date(Date.now() + 60_000).toISOString();
    const first = db.materializeTaskOccurrence({
      taskId: task.id,
      scheduledFor,
      nextRun,
      triggerType: 'scheduled',
    });
    expect(first?.run.status).toBe('queued');
    expect(db.getTaskById(task.id)?.next_run).toBe(nextRun);

    const afterFirst = db.getTaskById(task.id)!;
    const nextAfterOverlap = new Date(Date.now() + 120_000).toISOString();
    const overlap = db.materializeTaskOccurrence({
      taskId: task.id,
      scheduledFor: afterFirst.next_run!,
      nextRun: nextAfterOverlap,
      triggerType: 'scheduled',
    });
    expect(overlap?.run.status).toBe('missed');
    expect(overlap?.run.error).toContain('still active');
    expect(db.getTaskById(task.id)?.next_run).toBe(nextAfterOverlap);
    db.cancelTaskRun(first!.run.id);
  });

  test('fences renew/release/complete and cancellation invalidates old worker', () => {
    const task = createDefinition('fencing-task');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const claim = db.claimNextTaskRun('worker-a', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.renewTaskRunLease(claim.id, 'worker-b', claim.lease_token, 60_000),
    ).toBe(false);
    expect(
      db.releaseTaskRunForRetry(
        claim.id,
        'worker-a',
        claim.lease_token + 1,
        new Date().toISOString(),
        'wrong token',
      ),
    ).toBe(false);
    expect(db.cancelTaskRun(claim.id)).toBe(true);
    expect(
      db.completeTaskRun(claim.id, 'worker-a', claim.lease_token, {
        status: 'success',
        result: 'late',
      }),
    ).toBe(false);
    expect(db.getTaskRunById(claim.id)?.status).toBe('cancelled');
  });

  test('cancellation preserves the materialized cursor and rejects late receipts', async () => {
    const task = createDefinition('cancel-preserves-cursor');
    const scheduledFor = task.next_run!;
    const futureCursor = new Date(Date.now() + 3_600_000).toISOString();
    const created = db.materializeTaskOccurrence({
      taskId: task.id,
      scheduledFor,
      nextRun: futureCursor,
      triggerType: 'scheduled',
    })!;
    const claim = db.claimNextTaskRun('worker-cancel', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(db.cancelTaskRun(claim.id)).toBe(true);
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'late result',
      }),
    ).toBe(false);
    expect(
      db.recordTaskRunNotificationReceipt(
        claim.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'late failure',
        },
        {
          kind: 'im_message',
          targetJid: 'feishu:late',
          text: 'late',
          localImagePaths: [],
        },
      ),
    ).toBe(false);
    expect(
      db.updateTaskRunNotification(claim.id, 'success', null, {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      }),
    ).toBe(false);

    const finished = db.getTaskRunById(claim.id)!;
    expect(finished.status).toBe('cancelled');
    expect(finished.notification_status).toBe('skipped');
    expect(db.getTaskById(task.id)).toMatchObject({
      next_run: futureCursor,
      last_result: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(
      db.claimNextTaskRunNotification('late-notifier', 60_000),
    ).toBeUndefined();
  });

  test('cancellation and crash close a materialized once definition', async () => {
    const cancelledTask = createDefinition('cancelled-once', {
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 1_000).toISOString(),
    });
    const cancelled = db.materializeTaskOccurrence({
      taskId: cancelledTask.id,
      scheduledFor: cancelledTask.next_run!,
      nextRun: null,
      triggerType: 'backfill',
    })!;
    db.updateTask(cancelledTask.id, { status: 'paused' });
    expect(db.cancelTaskRun(cancelled.run.id)).toBe(true);
    expect(db.getTaskById(cancelledTask.id)?.status).toBe('completed');

    const crashedTask = createDefinition('crashed-once', {
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 1_000).toISOString(),
    });
    const crashed = db.materializeTaskOccurrence({
      taskId: crashedTask.id,
      scheduledFor: crashedTask.next_run!,
      nextRun: null,
      triggerType: 'backfill',
    })!;
    const claim = db.claimNextTaskRun('worker-crash', 50)!;
    expect(claim.id).toBe(crashed.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    db.updateTask(crashedTask.id, { status: 'paused' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(db.failExpiredStartedTaskRuns()).toBeGreaterThanOrEqual(1);
    expect(db.getTaskById(crashedTask.id)?.status).toBe('completed');
  });

  test('reclaims only a pre-execution expired lease', async () => {
    const prestartTask = createDefinition('prestart-reclaim');
    const prestart = db.createTaskRun({
      task: prestartTask,
      triggerType: 'manual',
    });
    const claimA = db.claimNextTaskRun('worker-a', 1)!;
    expect(claimA.id).toBe(prestart.run.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const claimB = db.claimNextTaskRun('worker-b', 60_000)!;
    expect(claimB.id).toBe(prestart.run.id);
    expect(claimB.lease_token).toBeGreaterThan(claimA.lease_token);
    db.cancelTaskRun(claimB.id);

    const startedTask = createDefinition('started-no-replay');
    const started = db.createTaskRun({
      task: startedTask,
      triggerType: 'manual',
    });
    const claimC = db.claimNextTaskRun('worker-c', 10)!;
    expect(claimC.id).toBe(started.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claimC.id,
        claimC.lease_owner,
        claimC.lease_token,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(db.failExpiredStartedTaskRuns()).toBeGreaterThanOrEqual(1);
    expect(db.getTaskRunById(started.run.id)?.status).toBe('failed');
  });
});

describe('notification-only retry state', () => {
  const retryPayload = (label: string): db.TaskRunNotificationPayload => ({
    kind: 'im_message',
    targetJid: `feishu:${label}`,
    text: label,
    localImagePaths: [],
  });

  const storedRetryPayload = (runId: string): db.TaskRunNotificationPayload =>
    JSON.parse(
      (
        db.getTaskRunById(runId) as unknown as {
          notification_payload: string;
        }
      ).notification_payload,
    ) as db.TaskRunNotificationPayload;

  test('failure receipt survives a crash before execution completion', async () => {
    const task = createDefinition('notification-crash-durability');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('crashing-worker', 20)!;
    expect(
      db.markTaskRunExecutionStarted(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
      ),
    ).toBe(true);
    const payload = retryPayload('crash-durable');
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'connector failed before process crash',
        },
        payload,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));

    expect(db.failExpiredStartedTaskRuns()).toBeGreaterThanOrEqual(1);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      status: 'failed',
      notification_status: 'failed',
      notification_error: 'connector failed before process crash',
    });
    expect(storedRetryPayload(created.run.id)).toEqual(payload);
    const retry = db.claimTaskRunNotificationById(
      created.run.id,
      'restart-notification-worker',
      60_000,
    )!;
    expect(retry.payload).toEqual(payload);
    expect(
      db.completeTaskRunNotificationAttempt(retry, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);
  });

  test('persists failure then commits a successful retry without rerunning work', async () => {
    const task = createDefinition('notification-retry');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const claim = db.claimNextTaskRun('worker', 60_000)!;
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'work finished',
        notificationStatus: 'pending',
      }),
    ).toBe(true);
    const payload: db.TaskRunNotificationPayload = {
      kind: 'store_result_and_notify',
      chatJid: task.chat_jid,
      text: 'work finished',
      options: { ownerId: 'owner', notifyChannels: ['feishu'] },
    };
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'temporary channel outage',
        },
        payload,
      ),
    ).toBe(true);

    // First retry is intentionally delayed by one second.
    expect(db.claimNextTaskRunNotification('notifier', 60_000)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const notificationClaim = db.claimTaskRunNotificationById(
      created.run.id,
      'notifier',
      60_000,
    )!;
    expect(notificationClaim.runId).toBe(created.run.id);
    expect(
      db.completeTaskRunNotificationAttempt(notificationClaim, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);
    const finished = db.getTaskRunById(created.run.id)!;
    expect(finished.status).toBe('success');
    expect(finished.attempt).toBe(1);
    expect(finished.notification_status).toBe('success');
  });

  test('stores partial and all-failed summaries truthfully', () => {
    const task = createDefinition('notification-summary');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    expect(
      db.updateTaskRunNotification(
        created.run.id,
        'partial_failed',
        'telegram failed',
        {
          attempted: 2,
          succeeded: 1,
          failed: 1,
          failed_channels: ['telegram'],
        },
      ),
    ).toBe(true);
    expect(db.getTaskRunById(created.run.id)?.notification_status).toBe(
      'partial_failed',
    );
    expect(db.getTaskRunById(created.run.id)?.notification_summary).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failed_channels: ['telegram'],
    });
    expect(db.cancelTaskRun(created.run.id)).toBe(true);
  });

  test('a coarse success update cannot hide durable retry work', () => {
    const task = createDefinition('notification-success-cannot-hide-retry');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const payload = retryPayload('still-pending');
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'connector unavailable',
        },
        payload,
      ),
    ).toBe(true);

    expect(
      db.updateTaskRunNotification(created.run.id, 'success', null, {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      }),
    ).toBe(true);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'failed',
      notification_error: 'connector unavailable',
      notification_summary: {
        attempted: 1,
        succeeded: 0,
        failed: 1,
        failed_channels: ['feishu'],
      },
    });
    expect(storedRetryPayload(created.run.id)).toEqual(payload);
    expect(db.cancelTaskRun(created.run.id)).toBe(true);
  });

  test('successful claim consumes only A while a late IPC payload B remains retryable', async () => {
    const task = createDefinition('notification-generation-success');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('generation-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    const payloadA = retryPayload('payload-a');
    const payloadB = retryPayload('payload-b');
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A initial failure',
        },
        payloadA,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const claimA = db.claimTaskRunNotificationById(
      created.run.id,
      'notification-a',
      60_000,
    )!;
    expect(claimA.payload).toEqual(payloadA);

    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'B late failure',
        },
        payloadB,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRunNotificationAttempt(claimA, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);

    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'partial_failed',
      notification_summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['feishu'],
      },
    });
    expect(storedRetryPayload(created.run.id)).toEqual(payloadB);
    expect(
      (
        db.getTaskRunById(created.run.id) as unknown as {
          notification_attempt: number;
        }
      ).notification_attempt,
    ).toBe(0);
    expect(
      db.completeTaskRunNotificationAttempt(claimA, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(false);
  });

  test('failed claim merges its retry A with a concurrently appended B', async () => {
    const task = createDefinition('notification-generation-failure');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('generation-worker-fail', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    const payloadA = retryPayload('failed-a');
    const payloadB = retryPayload('late-b');
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A initial failure',
        },
        payloadA,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const claimA = db.claimTaskRunNotificationById(
      created.run.id,
      'notification-a-failed',
      60_000,
    )!;
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'B late failure',
        },
        payloadB,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRunNotificationAttempt(
        claimA,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A retry failed',
        },
        payloadA,
      ),
    ).toBe(true);

    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'failed',
      notification_summary: {
        attempted: 2,
        succeeded: 0,
        failed: 2,
        failed_channels: expect.arrayContaining(['feishu', 'telegram']),
      },
    });
    const stored = storedRetryPayload(created.run.id);
    expect(stored.kind).toBe('batch');
    expect(stored.kind === 'batch' ? stored.items : []).toEqual(
      expect.arrayContaining([payloadA, payloadB]),
    );
  });

  test('a late payload gets a fresh retry budget after the prior batch is exhausted', async () => {
    const task = createDefinition('notification-fresh-late-budget');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('budget-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    const payloadA = retryPayload('exhausted-a');
    const payloadB = retryPayload('fresh-b');
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A initial failure',
        },
        payloadA,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    for (let attempt = 1; attempt < 5; attempt++) {
      const expired = db.claimTaskRunNotificationById(
        created.run.id,
        `expired-worker-${attempt}`,
        2,
      )!;
      expect(expired.attempt).toBe(attempt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const exhausted = db.claimTaskRunNotificationById(
      created.run.id,
      'final-budget-worker',
      60_000,
    )!;
    expect(exhausted.attempt).toBe(5);
    expect(
      db.completeTaskRunNotificationAttempt(
        exhausted,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['feishu'],
          },
          error: 'A exhausted',
        },
        payloadA,
      ),
    ).toBe(true);
    expect(
      (
        db.getTaskRunById(created.run.id) as unknown as {
          notification_payload: string | null;
        }
      ).notification_payload,
    ).toBeNull();

    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'B arrived later',
        },
        payloadB,
      ),
    ).toBe(true);
    expect(
      (
        db.getTaskRunById(created.run.id) as unknown as {
          notification_attempt: number;
        }
      ).notification_attempt,
    ).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const fresh = db.claimTaskRunNotificationById(
      created.run.id,
      'fresh-budget-worker',
      60_000,
    )!;
    expect(fresh.attempt).toBe(1);
    expect(fresh.payload).toEqual(payloadB);
  });

  test('aggregates multiple IPC outputs and retains only failed delivery work', () => {
    const task = createDefinition('notification-multiple-outputs');
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const claim = db.claimNextTaskRun('multi-output-worker', 60_000)!;
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'done',
        notificationStatus: 'pending',
      }),
    ).toBe(true);
    expect(
      db.recordTaskRunNotificationReceipt(created.run.id, {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      }),
    ).toBe(true);
    expect(
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'file failed',
        },
        {
          kind: 'im_file',
          targetJid: 'telegram:target',
          workspaceFolder: 'workspace',
          filePath: 'report.pdf',
          fileName: 'report.pdf',
        },
      ),
    ).toBe(true);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'partial_failed',
      notification_summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['telegram'],
      },
    });
  });
});
