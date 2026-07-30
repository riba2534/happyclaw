import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-notify-wake-'));
const storeDir = path.join(tmpDir, 'db');
fs.mkdirSync(storeDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('notification retry wake scheduling', () => {
  test('workspace projection exhaustion settles the exact group business result', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    try {
      const createdAt = new Date().toISOString();
      db.createTask({
        id: 'group-workspace-exhausted-success',
        group_folder: 'workspace',
        chat_jid: 'web:workspace',
        prompt: 'build report',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        context_mode: 'group',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        next_run: new Date(Date.now() + 3_600_000).toISOString(),
        status: 'active',
        created_at: createdAt,
        notify_channels: null,
      });
      const task = db.getTaskById('group-workspace-exhausted-success')!;
      const created = db.createTaskRun({ task, triggerType: 'manual' });
      const execution = db.claimNextTaskRun('group-exhaust-worker', 60_000)!;
      db.markTaskRunExecutionStarted(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
      );
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        {
          status: 'delivered',
          result: '已排队',
          notificationStatus: 'skipped',
        },
      );
      const payload: db.TaskRunNotificationPayload = {
        kind: 'workspace_result',
        chatJid: task.chat_jid,
        text: '完整业务结果',
        groupRunId: created.run.id,
        groupTaskId: task.id,
        groupStatus: 'success',
        groupResult: '完整业务结果',
        groupError: null,
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-group-result:${created.run.id}`,
          skipStore: false,
          workspaceFolder: task.group_folder,
        },
      };
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['workspace'],
          },
          error: 'workspace unavailable',
        },
        payload,
      );

      vi.advanceTimersByTime(1_000);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const claim = db.claimTaskRunNotificationById(
          created.run.id,
          `workspace-exhaust-worker-${attempt}`,
          60_000,
        )!;
        expect(claim.attempt).toBe(attempt);
        expect(
          db.completeTaskRunNotificationAttempt(
            claim,
            {
              status: 'failed',
              summary: {
                attempted: 1,
                succeeded: 0,
                failed: 1,
                failed_channels: ['workspace'],
              },
              error: 'workspace unavailable',
            },
            payload,
          ),
        ).toBe(true);
        vi.advanceTimersByTime(1_000 * 2 ** Math.max(0, attempt - 1));
      }

      expect(db.getTaskRunById(created.run.id)).toMatchObject({
        status: 'success',
        result: '完整业务结果',
        error: null,
        notification_status: 'failed',
        notification_attempt: 5,
      });
      const raw = db.getTaskRunById(created.run.id) as unknown as {
        notification_payload: string | null;
      };
      expect(raw.notification_payload).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('expired final workspace lease settles terminal group outcome without replay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T13:00:00.000Z'));
    try {
      const createdAt = new Date().toISOString();
      db.createTask({
        id: 'group-workspace-expired-failure',
        group_folder: 'workspace',
        chat_jid: 'web:workspace',
        prompt: 'build failing report',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        context_mode: 'group',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        next_run: new Date(Date.now() + 3_600_000).toISOString(),
        status: 'active',
        created_at: createdAt,
        notify_channels: null,
      });
      const task = db.getTaskById('group-workspace-expired-failure')!;
      const created = db.createTaskRun({ task, triggerType: 'manual' });
      const execution = db.claimNextTaskRun('group-expiry-worker', 60_000)!;
      db.markTaskRunExecutionStarted(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
      );
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        {
          status: 'delivered',
          result: '已排队',
          notificationStatus: 'skipped',
        },
      );
      const payload: db.TaskRunNotificationPayload = {
        kind: 'workspace_result',
        chatJid: task.chat_jid,
        text: '执行失败',
        groupRunId: created.run.id,
        groupTaskId: task.id,
        groupStatus: 'failed',
        groupResult: null,
        groupError: 'business failed',
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-group-terminal:${created.run.id}`,
          skipStore: false,
          workspaceFolder: task.group_folder,
        },
      };
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['workspace'],
          },
          error: 'workspace unavailable',
        },
        payload,
      );
      vi.advanceTimersByTime(1_000);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const claim = db.claimTaskRunNotificationById(
          created.run.id,
          `workspace-expiry-worker-${attempt}`,
          2,
        )!;
        expect(claim.attempt).toBe(attempt);
        vi.advanceTimersByTime(5);
      }

      expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
      expect(db.getTaskRunById(created.run.id)).toMatchObject({
        status: 'failed',
        result: null,
        error: 'business failed',
        notification_status: 'failed',
        notification_error: expect.stringContaining(
          'delivery outcome is unknown',
        ),
        notification_attempt: 5,
      });
      expect(
        db.claimTaskRunNotificationById(
          created.run.id,
          'must-not-replay-workspace',
          60_000,
        ),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('expired exact cancelled workspace lease clears its payload without reopening the run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T14:00:00.000Z'));
    try {
      const createdAt = new Date().toISOString();
      db.createTask({
        id: 'group-workspace-expired-cancelled',
        group_folder: 'workspace',
        chat_jid: 'web:workspace',
        prompt: 'cancel report',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        context_mode: 'group',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        next_run: new Date(Date.now() + 3_600_000).toISOString(),
        status: 'active',
        created_at: createdAt,
        notify_channels: null,
      });
      const task = db.getTaskById('group-workspace-expired-cancelled')!;
      const created = db.createTaskRun({ task, triggerType: 'manual' });
      const execution = db.claimNextTaskRun('group-cancel-worker', 60_000)!;
      db.markTaskRunExecutionStarted(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
      );
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        {
          status: 'delivered',
          result: '已排队',
          notificationStatus: 'skipped',
        },
      );
      const payload: db.TaskRunNotificationPayload = {
        kind: 'workspace_result',
        chatJid: task.chat_jid,
        text: '任务已取消',
        groupRunId: created.run.id,
        groupTaskId: task.id,
        groupStatus: 'cancelled',
        groupResult: null,
        groupError: 'cancelled by user',
        options: {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-group-terminal:${created.run.id}`,
          skipStore: false,
          workspaceFolder: task.group_folder,
        },
      };
      db.recordTaskRunNotificationReceipt(
        created.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['workspace'],
          },
          error: 'workspace unavailable',
        },
        payload,
      );
      vi.advanceTimersByTime(1_000);
      for (let attempt = 1; attempt < 5; attempt++) {
        const claim = db.claimTaskRunNotificationById(
          created.run.id,
          `workspace-cancel-worker-${attempt}`,
          60_000,
        )!;
        db.completeTaskRunNotificationAttempt(
          claim,
          {
            status: 'failed',
            summary: {
              attempted: 1,
              succeeded: 0,
              failed: 1,
              failed_channels: ['workspace'],
            },
            error: 'workspace unavailable',
          },
          payload,
        );
        vi.advanceTimersByTime(1_000 * 2 ** Math.max(0, attempt - 1));
      }
      const finalClaim = db.claimTaskRunNotificationById(
        created.run.id,
        'workspace-cancel-worker-5',
        2,
      )!;
      expect(finalClaim.attempt).toBe(5);

      // Simulate the crash window after Web projection finalized the business
      // run but before the notification lease completion write.
      expect(
        db.finalizeDeliveredGroupTaskRun(created.run.id, task.id, {
          status: 'cancelled',
          error: 'cancelled by user',
        }),
      ).toBe(true);
      vi.advanceTimersByTime(5);
      expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
      expect(db.getTaskRunById(created.run.id)).toMatchObject({
        status: 'cancelled',
        error: 'cancelled by user',
        notification_status: 'failed',
        notification_error: expect.stringContaining(
          'delivery outcome is unknown',
        ),
      });
      const raw = db.getTaskRunById(created.run.id) as unknown as {
        notification_payload: string | null;
        notification_lease_owner: string | null;
      };
      expect(raw.notification_payload).toBeNull();
      expect(raw.notification_lease_owner).toBeNull();

      const completed = db.createTaskRun({ task, triggerType: 'manual' });
      const completedExecution = db.claimNextTaskRun(
        'group-cancel-complete-worker',
        60_000,
      )!;
      db.markTaskRunExecutionStarted(
        completedExecution.id,
        completedExecution.lease_owner,
        completedExecution.lease_token,
      );
      db.completeTaskRun(
        completedExecution.id,
        completedExecution.lease_owner,
        completedExecution.lease_token,
        {
          status: 'delivered',
          result: '已排队',
          notificationStatus: 'skipped',
        },
      );
      const completedPayload: db.TaskRunNotificationPayload = {
        ...payload,
        groupRunId: completed.run.id,
        options: {
          ...payload.options!,
          messageId: `scheduled-group-terminal:${completed.run.id}`,
        },
      };
      db.recordTaskRunNotificationReceipt(
        completed.run.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['workspace'],
          },
          error: 'temporary workspace outage',
        },
        completedPayload,
      );
      vi.advanceTimersByTime(1_000);
      const completedClaim = db.claimTaskRunNotificationById(
        completed.run.id,
        'group-cancel-completion-notifier',
        60_000,
      )!;
      db.finalizeDeliveredGroupTaskRun(completed.run.id, task.id, {
        status: 'cancelled',
        error: 'cancelled by user',
      });
      expect(
        db.completeTaskRunNotificationAttempt(completedClaim, {
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        }),
      ).toBe(true);
      expect(db.getTaskRunById(completed.run.id)).toMatchObject({
        status: 'cancelled',
        notification_status: 'success',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('exact cancelled workspace repair survives a normal failure and an early worker crash', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T14:30:00.000Z'));
    try {
      const createdAt = new Date().toISOString();
      db.createTask({
        id: 'group-workspace-cancelled-retry',
        group_folder: 'workspace',
        chat_jid: 'web:workspace',
        prompt: 'cancelled retry report',
        schedule_type: 'cron',
        schedule_value: '0 * * * *',
        context_mode: 'group',
        execution_type: 'agent',
        execution_mode: 'container',
        script_command: null,
        next_run: new Date(Date.now() + 3_600_000).toISOString(),
        status: 'active',
        created_at: createdAt,
        notify_channels: null,
      });
      const task = db.getTaskById('group-workspace-cancelled-retry')!;
      const prepare = (suffix: string) => {
        const created = db.createTaskRun({
          task,
          triggerType: 'manual',
          idempotencyKey: `cancelled-retry-${suffix}`,
        });
        const execution = db.claimNextTaskRun(
          `cancelled-retry-execution-${suffix}`,
          60_000,
        )!;
        db.markTaskRunExecutionStarted(
          execution.id,
          execution.lease_owner,
          execution.lease_token,
        );
        db.completeTaskRun(
          execution.id,
          execution.lease_owner,
          execution.lease_token,
          {
            status: 'delivered',
            result: '已排队',
            notificationStatus: 'skipped',
          },
        );
        const payload: db.TaskRunNotificationPayload = {
          kind: 'workspace_result',
          chatJid: task.chat_jid,
          text: '任务已取消',
          groupRunId: created.run.id,
          groupTaskId: task.id,
          groupStatus: 'cancelled',
          groupResult: null,
          groupError: 'cancelled by user',
          options: {
            sourceKind: 'scheduled_task_result',
            messageId: `scheduled-group-terminal:${created.run.id}`,
            skipStore: false,
            workspaceFolder: task.group_folder,
          },
        };
        db.recordTaskRunNotificationReceipt(
          created.run.id,
          {
            status: 'failed',
            summary: {
              attempted: 1,
              succeeded: 0,
              failed: 1,
              failed_channels: ['workspace'],
            },
            error: 'workspace unavailable',
          },
          payload,
        );
        return { created, payload };
      };

      const normal = prepare('normal-failure');
      vi.advanceTimersByTime(1_000);
      const first = db.claimTaskRunNotificationById(
        normal.created.run.id,
        'cancelled-normal-attempt-1',
        60_000,
      )!;
      expect(
        db.finalizeDeliveredGroupTaskRun(normal.created.run.id, task.id, {
          status: 'cancelled',
          error: 'cancelled by user',
        }),
      ).toBe(true);
      expect(
        db.completeTaskRunNotificationAttempt(
          first,
          {
            status: 'failed',
            summary: {
              attempted: 1,
              succeeded: 0,
              failed: 1,
              failed_channels: ['workspace'],
            },
            error: 'workspace still unavailable',
          },
          normal.payload,
        ),
      ).toBe(true);
      const retryWake = db.getNextTaskRunWakeAt();
      expect(retryWake).not.toBeNull();
      expect(new Date(retryWake!).getTime()).toBeGreaterThan(Date.now());
      vi.advanceTimersByTime(1_000);
      const second = db.claimTaskRunNotificationById(
        normal.created.run.id,
        'cancelled-normal-attempt-2',
        60_000,
      )!;
      expect(second.attempt).toBe(2);
      expect(
        db.completeTaskRunNotificationAttempt(second, {
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        }),
      ).toBe(true);
      expect(db.getTaskRunById(normal.created.run.id)).toMatchObject({
        status: 'cancelled',
        notification_status: 'success',
        notification_payload: null,
        notification_lease_owner: null,
      });

      const crashed = prepare('early-crash');
      vi.advanceTimersByTime(1_000);
      const crashedFirst = db.claimTaskRunNotificationById(
        crashed.created.run.id,
        'cancelled-crash-attempt-1',
        2,
      )!;
      expect(crashedFirst.attempt).toBe(1);
      expect(
        db.finalizeDeliveredGroupTaskRun(crashed.created.run.id, task.id, {
          status: 'cancelled',
          error: 'cancelled by user',
        }),
      ).toBe(true);
      vi.advanceTimersByTime(5);
      expect(db.getNextTaskRunWakeAt()).not.toBeNull();
      const crashedSecond = db.claimTaskRunNotificationById(
        crashed.created.run.id,
        'cancelled-crash-attempt-2',
        60_000,
      )!;
      expect(crashedSecond.attempt).toBe(2);
      expect(
        db.completeTaskRunNotificationAttempt(crashedSecond, {
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        }),
      ).toBe(true);
      expect(db.getTaskRunById(crashed.created.run.id)).toMatchObject({
        status: 'cancelled',
        notification_status: 'success',
        notification_payload: null,
        notification_lease_owner: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('an active slow-delivery lease wakes at lease expiry, not stale available_at', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'slow-notification-wake',
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('slow-notification-wake')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
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
            failed_channels: ['feishu'],
          },
          error: 'slow connector',
        },
        {
          kind: 'im_message',
          targetJid: 'feishu:slow',
          text: 'slow',
          localImagePaths: [],
        },
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const claim = db.claimNextTaskRunNotification('slow-worker', 60_000)!;
    const wakeAt = db.getNextTaskRunWakeAt();

    expect(wakeAt).toBe(claim.expiresAt);
    expect(new Date(wakeAt!).getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(
      db.claimNextTaskRunNotification('competing-worker', 60_000),
    ).toBeUndefined();
    expect(
      db.completeTaskRunNotificationAttempt(claim, {
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

  test('a crashed final attempt becomes terminal without replay or past wake', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'final-attempt-crash',
      group_folder: 'workspace-final',
      chat_jid: 'web:workspace-final',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('final-attempt-crash')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('final-execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
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
            failed_channels: ['feishu'],
          },
          error: 'initial failure',
        },
        {
          kind: 'im_message',
          targetJid: 'feishu:final',
          text: 'final',
          localImagePaths: [],
        },
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = db.claimTaskRunNotificationById(
        created.run.id,
        `crashed-worker-${attempt}`,
        2,
      )!;
      expect(claim.attempt).toBe(attempt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      notification_status: 'failed',
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_attempt: 5,
    });
    expect(
      db.claimTaskRunNotificationById(
        created.run.id,
        'must-not-replay',
        60_000,
      ),
    ).toBeUndefined();
    const raw = db.getTaskRunById(created.run.id) as unknown as {
      notification_payload: string | null;
      notification_lease_owner: string | null;
    };
    expect(raw.notification_payload).toBeNull();
    expect(raw.notification_lease_owner).toBeNull();
    expect(db.getNextTaskRunWakeAt()).toBeNull();
  });

  test('a crashed final A claim is terminal while late B keeps a fresh budget', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'final-attempt-late-payload',
      group_folder: 'workspace-late',
      chat_jid: 'web:workspace-late',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('final-attempt-late-payload')!;
    const created = db.createTaskRun({ task, triggerType: 'manual' });
    const execution = db.claimNextTaskRun('late-execution-worker', 60_000)!;
    expect(
      db.completeTaskRun(
        execution.id,
        execution.lease_owner,
        execution.lease_token,
        { status: 'success', notificationStatus: 'pending' },
      ),
    ).toBe(true);
    const payloadA: db.TaskRunNotificationPayload = {
      kind: 'im_message',
      targetJid: 'feishu:final-a',
      text: 'A',
      localImagePaths: [],
    };
    const payloadB: db.TaskRunNotificationPayload = {
      kind: 'im_file',
      targetJid: 'telegram:late-b',
      workspaceFolder: 'workspace-late',
      filePath: 'late-b.pdf',
      fileName: 'late-b.pdf',
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
          error: 'A initial failure',
        },
        payloadA,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    for (let attempt = 1; attempt < 5; attempt++) {
      const claim = db.claimTaskRunNotificationById(
        created.run.id,
        `late-crashed-worker-${attempt}`,
        2,
      )!;
      expect(claim.attempt).toBe(attempt);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finalClaim = db.claimTaskRunNotificationById(
      created.run.id,
      'late-crashed-worker-5',
      2,
    )!;
    expect(finalClaim).toMatchObject({ attempt: 5, payload: payloadA });

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
          error: 'B arrived during final A attempt',
        },
        payloadB,
      ),
    ).toBe(true);
    const beforeExpiry = db.getTaskRunById(created.run.id) as unknown as {
      notification_attempt: number;
      notification_payload: string;
      notification_lease_payload: string;
    };
    expect(beforeExpiry.notification_attempt).toBe(5);
    expect(JSON.parse(beforeExpiry.notification_lease_payload)).toEqual(
      payloadA,
    );
    expect(JSON.parse(beforeExpiry.notification_payload)).toMatchObject({
      kind: 'batch',
      items: expect.arrayContaining([payloadA, payloadB]),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.finalizeExpiredTaskRunNotificationAttempts()).toBe(1);
    const recovered = db.getTaskRunById(created.run.id) as unknown as {
      notification_status: string;
      notification_error: string;
      notification_attempt: number;
      notification_payload: string;
      notification_lease_owner: string | null;
      notification_lease_payload: string | null;
    };
    expect(recovered).toMatchObject({
      notification_status: 'failed',
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_attempt: 0,
      notification_lease_owner: null,
      notification_lease_payload: null,
    });
    expect(JSON.parse(recovered.notification_payload)).toEqual(payloadB);
    const wakeAt = db.getNextTaskRunWakeAt();
    expect(wakeAt).not.toBeNull();
    expect(new Date(wakeAt!).getTime()).toBeGreaterThan(Date.now());

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const freshB = db.claimTaskRunNotificationById(
      created.run.id,
      'fresh-b-worker',
      60_000,
    )!;
    expect(freshB).toMatchObject({ attempt: 1, payload: payloadB });
    expect(
      db.completeTaskRunNotificationAttempt(freshB, {
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
      notification_error: expect.stringContaining(
        'delivery outcome is unknown',
      ),
      notification_summary: {
        attempted: 4,
        succeeded: 1,
        failed: 3,
        failed_channels: expect.arrayContaining(['feishu', 'telegram']),
      },
    });
    expect(db.getNextTaskRunWakeAt()).toBeNull();
  });
});
