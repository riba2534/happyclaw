import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'task-scheduler-contract-'),
);
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { runContainerAgentMock, runHostAgentMock, runScriptMock } = vi.hoisted(
  () => ({
    runContainerAgentMock: vi.fn(async (_group, input, onProcess, onOutput) => {
      const sessionDir = path.join(
        tmpDir,
        'sessions',
        input.groupFolder,
        'agents',
        input.sessionAgentId,
        '.claude',
      );
      const ipcDir = path.join(
        tmpDir,
        'ipc',
        input.groupFolder,
        'tasks-run',
        input.taskRunId,
        'input',
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(ipcDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'transcript.jsonl'), '{}');
      fs.writeFileSync(path.join(ipcDir, 'request.json'), '{}');
      onProcess?.({} as never, `container-${input.taskRunId}`, null);
      await onOutput?.({
        status: 'stream',
        result: 'partial',
        streamEvent: { type: 'text', text: 'partial' },
      });
      return {
        status: 'success',
        result: 'task result',
        newSessionId: `task-session:${input.taskRunId}`,
        inputTurnCompleted: true,
      };
    }),
    runHostAgentMock: vi.fn(async () => ({
      status: 'success',
      result: 'host result',
    })),
    runScriptMock: vi.fn(async () => ({
      stdout: 'script result',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      durationMs: 10,
    })),
  }),
);

vi.mock('../src/container-runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: runContainerAgentMock,
    runHostAgent: runHostAgentMock,
  };
});

vi.mock('../src/script-runner.js', () => ({
  hasScriptCapacity: () => true,
  runScript: runScriptMock,
}));

const db = await import('../src/db.js');
const {
  cancelTaskRunNow,
  computeNextRunForTaskResume,
  deliverPersistedNotificationPayload,
  enqueueIsolatedScheduledTask,
  getRunningTaskIds,
  processClaimedTaskRunNotification,
  shouldFinalizeScheduledRunOutput,
  triggerTaskNow,
} = await import('../src/task-scheduler.js');

const GROUP_JID = 'web:task-contract';
const GROUP_FOLDER = 'task-contract';

function makeDeps(groups: Record<string, any>) {
  let runPromise: Promise<void> | null = null;
  const queue = {
    enqueueTask: vi.fn(
      (_jid: string, _taskId: string, fn: () => Promise<void>) => {
        runPromise = fn();
        return true;
      },
    ),
    closeStdin: vi.fn(),
    enqueueMessageCheck: vi.fn(),
    isShuttingDown: () => false,
  };

  return {
    deps: {
      registeredGroups: () => groups,
      getSessions: () => ({}),
      queue,
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      broadcastStreamEvent: vi.fn(),
      storePromptMessage: vi.fn(),
      storeResultAndNotify: vi.fn(),
      assistantName: 'HappyClaw',
    } as any,
    queue,
    waitForRun: async () => {
      await runPromise;
    },
  };
}

function createTask(
  overrides: Partial<Parameters<typeof db.createTask>[0]> = {},
) {
  const id = overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  db.createTask({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    prompt: 'write a short status',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    created_by: undefined,
    ...overrides,
  });
  return id;
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  runContainerAgentMock.mockClear();
  runHostAgentMock.mockClear();
  runScriptMock.mockClear();
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Task Contract Workspace',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    is_home: false,
  } as any);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduled task workspace/session contract', () => {
  test('finalizes only at a durable scheduled-input boundary', () => {
    expect(
      shouldFinalizeScheduledRunOutput({
        status: 'success',
        inputTurnCompleted: false,
      }),
    ).toBe(false);
    expect(
      shouldFinalizeScheduledRunOutput({
        status: 'success',
        inputTurnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldFinalizeScheduledRunOutput({
        status: 'error',
      }),
    ).toBe(true);
    expect(
      shouldFinalizeScheduledRunOutput({
        status: 'closed',
      }),
    ).toBe(false);
    expect(
      shouldFinalizeScheduledRunOutput(
        {
          status: 'closed',
        },
        true,
      ),
    ).toBe(true);
  });

  test('records an early close after an incomplete partial as an error', async () => {
    const taskId = createTask({ id: 'task-incomplete-close-error' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess, onOutput) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        await onOutput?.({
          status: 'success',
          result: 'partial only',
          inputTurnCompleted: false,
        });
        await onOutput?.({
          status: 'closed',
          result: null,
        });
        return {
          status: 'closed',
          result: null,
        };
      },
    );
    const { deps, waitForRun } = makeDeps(groups);

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await waitForRun();

    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'error',
      result: 'partial only',
      error: expect.stringContaining('before completing'),
    });
  });

  test('resume accepts only future one-shot schedules', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    expect(computeNextRunForTaskResume('once', future)).toBe(future);
    expect(() => computeNextRunForTaskResume('once', past)).toThrow(
      '执行时间已过',
    );
  });

  test('legacy container-mode script is paused without invoking the host runner', () => {
    const taskId = createTask({
      id: 'unsafe-container-script',
      execution_type: 'script',
      execution_mode: 'container',
      script_command: 'touch must-not-run',
      next_run: new Date(Date.now() + 60_000).toISOString(),
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps } = makeDeps(groups);

    const result = triggerTaskNow(taskId, deps);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('host'),
    });
    expect(runScriptMock).not.toHaveBeenCalled();
    expect(db.getTaskById(taskId)).toMatchObject({
      status: 'paused',
      next_run: null,
    });
    expect(db.getTaskRunsForTask(taskId)).toHaveLength(0);
  });

  test('isolated task runs in the source workspace with a task-scoped Claude session', async () => {
    const taskId = createTask({ id: 'task-session-contract' });
    db.setSession(GROUP_FOLDER, 'main-session');
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, queue, waitForRun } = makeDeps(groups);
    let virtualChatJid = '';
    deps.storePromptMessage.mockImplementation(
      (chatJid: string, senderId: string, senderName: string, text: string) => {
        virtualChatJid = chatJid;
        db.ensureChatExists(chatJid);
        db.storeMessageDirect(
          `prompt-${taskId}`,
          chatJid,
          senderId,
          senderName,
          text,
          new Date().toISOString(),
          false,
        );
      },
    );
    deps.storeResultAndNotify.mockImplementation(
      async (chatJid: string, text: string) => {
        db.ensureChatExists(chatJid);
        db.storeMessageDirect(
          `result-${taskId}`,
          chatJid,
          'assistant',
          'HappyClaw',
          text,
          new Date().toISOString(),
          true,
        );
      },
    );

    const result = triggerTaskNow(taskId, deps);
    expect(result.success).toBe(true);
    await waitForRun();

    expect(queue.enqueueTask).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${GROUP_JID}#task:task-run-[a-f0-9-]+-attempt-1$`),
      ),
      taskId,
      expect.any(Function),
      { allowInactive: true, onDropped: expect.any(Function) },
    );
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    const input = runContainerAgentMock.mock.calls[0][1];
    expect(input.groupFolder).toBe(GROUP_FOLDER);
    expect(input.chatJid).toBe(GROUP_JID);
    expect(input.taskRunId).toBe(`task-run-${result.runId}-attempt-1`);
    expect(input.taskRunId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(input.sessionAgentId).toBe(`task-${input.taskRunId}`);
    expect(input.sessionAgentId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(input.isScheduledTask).toBe(true);
    expect(input.messageTaskId).toBe(taskId);

    expect(db.getSession(GROUP_FOLDER)).toBe('main-session');
    expect(db.getSession(GROUP_FOLDER, input.sessionAgentId)).toBeUndefined();
    expect(
      db.getWorkspaceRuntimeSession(GROUP_FOLDER, input.sessionAgentId),
    ).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'sessions',
          GROUP_FOLDER,
          'agents',
          input.sessionAgentId,
        ),
      ),
    ).toBe(false);
    expect(virtualChatJid).toBe(`${GROUP_JID}#task:${input.taskRunId}`);
    expect(db.getMessagesPage(virtualChatJid)).toEqual([]);
    expect(db.getAllChats().some((chat) => chat.jid === virtualChatJid)).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(tmpDir, 'ipc', GROUP_FOLDER, 'tasks-run', input.taskRunId),
      ),
    ).toBe(false);
    const storedTask = db.getTaskById(taskId)!;
    expect(storedTask.workspace_jid).toBeNull();
    expect(storedTask.workspace_folder).toBeNull();
  });

  test('isolated manual runs get distinct Claude session namespaces', async () => {
    const taskId = createTask({ id: 'task-per-run-session' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const first = makeDeps(groups);
    expect(triggerTaskNow(taskId, first.deps).success).toBe(true);
    await first.waitForRun();

    const second = makeDeps(groups);
    expect(triggerTaskNow(taskId, second.deps).success).toBe(true);
    await second.waitForRun();

    const firstInput = runContainerAgentMock.mock.calls[0][1];
    const secondInput = runContainerAgentMock.mock.calls[1][1];
    expect(firstInput.taskRunId).toMatch(/^task-run-[a-f0-9-]+-attempt-1$/);
    expect(secondInput.taskRunId).toMatch(/^task-run-[a-f0-9-]+-attempt-1$/);
    expect(secondInput.taskRunId).not.toBe(firstInput.taskRunId);
    expect(firstInput.sessionAgentId).toBe(`task-${firstInput.taskRunId}`);
    expect(secondInput.sessionAgentId).toBe(`task-${secondInput.taskRunId}`);
  });

  test('group-mode delivery is logged as queued, not falsely completed', async () => {
    const taskId = createTask({
      id: 'task-group-queued-status',
      context_mode: 'group',
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, queue } = makeDeps(groups);

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith(GROUP_JID);
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'queued',
      result: '已排队到源工作区，等待 Agent 执行',
      error: null,
    });
  });

  test('host task cannot use an admin creator to bypass a downgraded workspace owner', async () => {
    const now = new Date().toISOString();
    for (const id of ['host-workspace-owner', 'host-task-creator']) {
      db.createUser({
        id,
        username: id,
        password_hash: 'hash',
        display_name: id,
        role: 'admin',
        status: 'active',
        must_change_password: false,
        created_at: now,
        updated_at: now,
      });
    }
    const hostGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      created_by: 'host-workspace-owner',
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(GROUP_JID, hostGroup);
    db.updateUserFields('host-workspace-owner', { role: 'member' });
    const taskId = createTask({
      id: 'host-owner-revoked-task',
      execution_mode: 'host',
      created_by: 'host-task-creator',
    });
    const { deps, waitForRun } = makeDeps({ [GROUP_JID]: hostGroup });

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await waitForRun();

    expect(runHostAgentMock).not.toHaveBeenCalled();
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('active administrator'),
    });
  });

  test('script source failure falls back without false delivered state', async () => {
    const ownerId = 'script-notification-owner';
    const sourceJid = 'feishu:script-notification-source';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const scriptGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: sourceJid,
      created_by: ownerId,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(sourceJid, scriptGroup);
    const taskId = createTask({
      id: 'script-notification-independent',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'printf ok',
      created_by: ownerId,
      chat_jid: sourceJid,
      notify_channels: ['feishu', 'telegram'],
    });
    const { deps, waitForRun } = makeDeps({ [sourceJid]: scriptGroup });
    deps.sendMessage.mockRejectedValue(new Error('channel unavailable'));
    deps.storeResultAndNotify.mockResolvedValue({
      status: 'success',
      summary: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      },
    });

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger).toMatchObject({ success: true, runId: expect.any(String) });
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });

    expect(runScriptMock).toHaveBeenCalledOnce();
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'success',
      notification_status: 'success',
      result: 'script result',
    });
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      sourceJid,
      expect.stringContaining('[脚本] script result'),
      expect.objectContaining({
        skipStore: true,
        sourceAlreadyDelivered: false,
      }),
    );
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'success',
      result: 'script result',
    });
  });

  test('an owner-revoked script abort is recorded as failed and never sends a success notification', async () => {
    const ownerId = 'revoked-running-script-owner';
    const sourceJid = 'web:revoked-running-script';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const scriptGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: sourceJid,
      created_by: ownerId,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(sourceJid, scriptGroup);
    const taskId = createTask({
      id: 'owner-revoked-running-script',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'sleep 60',
      created_by: ownerId,
      chat_jid: sourceJid,
    });
    runScriptMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
      durationMs: 25,
    });
    const { deps, waitForRun } = makeDeps({ [sourceJid]: scriptGroup });

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });

    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'failed',
      error: '脚本执行已取消',
      notification_status: 'skipped',
    });
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'error',
      error: '脚本执行已取消',
    });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.storeResultAndNotify).not.toHaveBeenCalled();
  });

  test('persists a strict source failure before finish and fallback success consumes only that retry item', async () => {
    const ownerId = 'script-source-crash-window-owner';
    const sourceJid = 'feishu:script-source-crash-window';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const scriptGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: sourceJid,
      created_by: ownerId,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(sourceJid, scriptGroup);
    const taskId = createTask({
      id: 'script-source-crash-window',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'printf ok',
      created_by: ownerId,
      chat_jid: sourceJid,
      notify_channels: ['feishu', 'telegram'],
    });
    const { deps, waitForRun } = makeDeps({ [sourceJid]: scriptGroup });
    deps.sendMessage.mockRejectedValue(new Error('strict source ACK failed'));
    let resolveFallback!: (receipt: db.TaskRunNotificationReceipt) => void;
    deps.storeResultAndNotify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFallback = resolve;
        }),
    );

    const trigger = triggerTaskNow(taskId, deps);
    await vi.waitFor(() => {
      expect(deps.storeResultAndNotify).toHaveBeenCalledOnce();
    });

    const beforeFinish = db.getTaskRunById(trigger.runId!)!;
    expect(beforeFinish).toMatchObject({
      status: 'running',
      notification_status: 'failed',
      notification_error: 'strict source ACK failed',
    });
    const rawBefore = beforeFinish as unknown as {
      notification_payload: string;
    };
    expect(JSON.parse(rawBefore.notification_payload)).toMatchObject({
      kind: 'send_message',
      chatJid: sourceJid,
    });

    const ipcPayload: db.TaskRunNotificationPayload = {
      kind: 'im_image',
      targetJid: 'telegram:unrelated-ipc',
      workspaceFolder: GROUP_FOLDER,
      filePath: 'unrelated.png',
      mimeType: 'image/png',
      fileName: 'unrelated.png',
    };
    expect(
      db.recordTaskRunNotificationReceipt(
        trigger.runId!,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'unrelated IPC failure',
        },
        ipcPayload,
      ),
    ).toBe(true);

    resolveFallback({
      status: 'success',
      summary: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      },
    });
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });

    const finished = db.getTaskRunById(trigger.runId!)!;
    expect(finished).toMatchObject({
      status: 'success',
      notification_status: 'partial_failed',
      notification_summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['telegram'],
      },
    });
    const rawFinished = finished as unknown as {
      notification_payload: string;
    };
    expect(JSON.parse(rawFinished.notification_payload)).toEqual(ipcPayload);
    expect(
      db.replaceTaskRunNotificationReceipt(
        trigger.runId!,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: ['telegram'],
          },
          error: 'unrelated IPC failure',
        },
        ipcPayload,
        {
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        },
      ),
    ).toBe(true);
  });

  test('script notification failure persists retry-only fallback work', async () => {
    const ownerId = 'script-notification-retry-owner';
    const sourceJid = 'feishu:script-notification-retry-source';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const scriptGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: sourceJid,
      created_by: ownerId,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(sourceJid, scriptGroup);
    const taskId = createTask({
      id: 'script-notification-retry-only',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'printf ok',
      created_by: ownerId,
      chat_jid: sourceJid,
      notify_channels: ['feishu', 'telegram'],
    });
    const { deps, waitForRun } = makeDeps({ [sourceJid]: scriptGroup });
    deps.sendMessage.mockRejectedValue(new Error('source connector failed'));
    deps.storeResultAndNotify.mockResolvedValue({
      status: 'partial_failed',
      summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['feishu'],
      },
      error: 'fallback connector failed',
    });

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });
    const finished = db.getTaskRunById(trigger.runId!)!;
    expect(finished).toMatchObject({
      status: 'success',
      notification_status: 'partial_failed',
      result: 'script result',
    });
    expect(finished.notification_summary).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failed_channels: ['feishu'],
    });

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const retryClaim = db.claimNextTaskRunNotification(
      'script-notification-retry-worker',
      60_000,
    )!;
    expect(retryClaim.payload).toMatchObject({
      kind: 'store_result_and_notify',
      chatJid: sourceJid,
      options: {
        skipStore: true,
        sourceAlreadyDelivered: false,
        notifyChannels: ['feishu'],
      },
    });

    deps.storeResultAndNotify.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        status: 'success',
        summary: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          failed_channels: [],
        },
      };
    });
    const retrying = processClaimedTaskRunNotification(retryClaim, deps, 60);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      db.claimNextTaskRunNotification('competing-retry-worker', 60),
    ).toBeUndefined();
    expect(await retrying).toBe(true);
    expect(deps.storeResultAndNotify).toHaveBeenLastCalledWith(
      sourceJid,
      expect.stringContaining('[脚本] script result'),
      expect.objectContaining({ skipStore: true }),
    );
    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(runScriptMock).toHaveBeenCalledOnce();
    expect(db.getTaskRunById(trigger.runId!)?.notification_status).toBe(
      'success',
    );
  });

  test('generic persisted fallback exceptions retain the original channel filter', async () => {
    const payload: db.TaskRunNotificationPayload = {
      kind: 'store_result_and_notify',
      chatJid: 'web:notification-retry-source',
      text: 'scheduled output',
      options: {
        ownerId: 'notification-retry-owner',
        notifyChannels: ['feishu', 'telegram'],
        skipStore: true,
      },
    };
    const result = await deliverPersistedNotificationPayload(payload, {
      storeResultAndNotify: vi.fn(async () => {
        throw new Error('broadcast transport crashed');
      }),
      sendMessage: vi.fn(),
    } as never);

    expect(result.receipt).toMatchObject({
      status: 'failed',
      summary: { failed_channels: ['web:notification-retry-source'] },
    });
    expect(result.retryPayload).toEqual(payload);
  });

  test('strictly acknowledged script source is excluded from fallback', async () => {
    const ownerId = 'script-notification-ack-owner';
    const sourceJid = 'feishu:script-notification-ack-source';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const scriptGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: sourceJid,
      created_by: ownerId,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(sourceJid, scriptGroup);
    const taskId = createTask({
      id: 'script-notification-no-duplicate',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'printf ok',
      created_by: ownerId,
      chat_jid: sourceJid,
    });
    const { deps, waitForRun } = makeDeps({ [sourceJid]: scriptGroup });
    deps.sendMessage.mockResolvedValue('message-id');
    deps.storeResultAndNotify.mockResolvedValue({
      status: 'skipped',
      summary: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failed_channels: [],
      },
    });

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });

    expect(deps.sendMessage).toHaveBeenCalledOnce();
    expect(deps.storeResultAndNotify).toHaveBeenCalledOnce();
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      sourceJid,
      expect.stringContaining('[脚本] script result'),
      expect.objectContaining({ sourceAlreadyDelivered: true }),
    );
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'success',
      notification_status: 'success',
      notification_summary: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      },
    });
  });

  test('successful final-error fallback cannot hide an earlier IPC retry payload', async () => {
    const ownerId = 'isolated-ipc-before-final-owner';
    const now = new Date().toISOString();
    db.createUser({
      id: ownerId,
      username: ownerId,
      password_hash: 'hash',
      display_name: ownerId,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const group = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      created_by: ownerId,
    };
    db.setRegisteredGroup(GROUP_JID, group);
    const taskId = createTask({
      id: 'isolated-ipc-failure-before-final-fallback',
      created_by: ownerId,
    });
    const ipcPayload: db.TaskRunNotificationPayload = {
      kind: 'im_image',
      targetJid: 'feishu:ipc-target',
      workspaceFolder: GROUP_FOLDER,
      filePath: 'failed-image.png',
      mimeType: 'image/png',
      fileName: 'failed-image.png',
    };
    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        const prefix = 'task-run-';
        const suffix = '-attempt-1';
        const durableRunId = input.taskRunId.slice(
          prefix.length,
          -suffix.length,
        );
        expect(
          db.recordTaskRunNotificationReceipt(
            durableRunId,
            {
              status: 'failed',
              summary: {
                attempted: 1,
                succeeded: 0,
                failed: 1,
                failed_channels: ['feishu'],
              },
              error: 'IPC image delivery failed',
            },
            ipcPayload,
          ),
        ).toBe(true);
        return { status: 'error', error: 'Agent failed after IPC output' };
      },
    );
    const { deps, waitForRun } = makeDeps({ [GROUP_JID]: group });
    deps.storeResultAndNotify.mockResolvedValue({
      status: 'success',
      summary: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failed_channels: [],
      },
    });

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });

    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'failed',
      notification_status: 'partial_failed',
      notification_summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['feishu'],
      },
    });
    expect(
      JSON.parse(
        (
          db.getTaskRunById(trigger.runId!) as unknown as {
            notification_payload: string;
          }
        ).notification_payload,
      ),
    ).toEqual(ipcPayload);
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Agent failed after IPC output'),
      expect.objectContaining({ ownerId }),
    );
  });

  test('admin-created cross-group container task does not inherit isAdminHome from its creator', async () => {
    const now = new Date().toISOString();
    for (const id of ['xgroup-admin-creator', 'xgroup-member-owner']) {
      db.createUser({
        id,
        username: id,
        password_hash: 'hash',
        display_name: id,
        role: id === 'xgroup-admin-creator' ? 'admin' : 'member',
        status: 'active',
        must_change_password: false,
        created_at: now,
        updated_at: now,
      });
    }
    const memberHomeJid = 'web:home-xgroup-member-owner';
    const memberHomeGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      jid: memberHomeJid,
      folder: 'home-xgroup-member-owner',
      created_by: 'xgroup-member-owner',
      is_home: true,
      executionMode: 'container' as const,
    };
    db.setRegisteredGroup(memberHomeJid, memberHomeGroup);
    // The task is created_by the admin (as an MCP schedule_task call with
    // target_group_jid would produce), but it targets the member's own
    // home workspace. isAdminHome, the owner-active gate, and the billing
    // gate must all key off the workspace's real owner (the member), not
    // the admin who happened to create the task — otherwise the run would
    // get an admin-privileged container mount inside the member's sandbox.
    const taskId = createTask({
      id: 'xgroup-admin-task',
      group_folder: memberHomeGroup.folder,
      chat_jid: memberHomeJid,
      execution_mode: 'container',
      created_by: 'xgroup-admin-creator',
    });
    const { deps, waitForRun } = makeDeps({ [memberHomeJid]: memberHomeGroup });

    runContainerAgentMock.mockClear();
    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await waitForRun();

    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    const input = runContainerAgentMock.mock.calls[0][1];
    expect(input.isHome).toBe(true);
    expect(input.isAdminHome).toBe(false);
    expect(input.isMain).toBe(false);

    // Security/execution-context fields must use the workspace's real
    // owner (verified above), but the prompt message's sender attribution
    // must still credit the actual task creator (the admin) — otherwise
    // the chat history/audit trail would misattribute the admin's
    // cross-group automation as if the member had typed it themselves.
    expect(deps.storePromptMessage).toHaveBeenCalledWith(
      expect.stringContaining(memberHomeJid),
      'xgroup-admin-creator',
      'xgroup-admin-creator',
      expect.any(String),
      taskId,
    );
  });

  test('manual trigger reserves a capacity-blocked task and releases after execution', async () => {
    const taskId = createTask({ id: 'task-manual-idempotency' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let queuedRun: (() => Promise<void>) | null = null;
    const queue = {
      enqueueTask: vi.fn(
        (_jid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedRun = fn;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = {
      ...makeDeps(groups).deps,
      queue,
    } as any;

    const firstTrigger = triggerTaskNow(taskId, deps);
    expect(firstTrigger).toEqual({
      success: true,
      runId: expect.any(String),
    });
    expect(JSON.parse(JSON.stringify(firstTrigger))).toEqual(firstTrigger);
    expect(triggerTaskNow(taskId, deps)).toEqual({
      success: false,
      error: 'Task is already running',
      runId: firstTrigger.runId,
    });
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);

    await queuedRun!();
    expect(triggerTaskNow(taskId, deps)).toEqual({
      success: true,
      runId: expect.any(String),
    });
    await queuedRun!();
  });

  test('manual reservation is released when the queue drops work before start', () => {
    const taskId = createTask({ id: 'task-manual-drop' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let onDropped: (() => void) | undefined;
    const queue = {
      enqueueTask: vi.fn(
        (
          _jid: string,
          _taskId: string,
          _fn: () => Promise<void>,
          options?: { onDropped?: () => void },
        ) => {
          onDropped = options?.onDropped;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = { ...makeDeps(groups).deps, queue } as any;

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    expect(triggerTaskNow(taskId, deps).success).toBe(false);
    onDropped?.();
    expect(triggerTaskNow(taskId, deps).success).toBe(true);
  });

  test('cancel fences a queued callback before Agent execution starts', async () => {
    const taskId = createTask({ id: 'task-cancel-before-start' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let queuedRun: (() => Promise<void>) | null = null;
    const deps = {
      ...makeDeps(groups).deps,
      queue: {
        enqueueTask: vi.fn(
          (_jid: string, _taskId: string, fn: () => Promise<void>) => {
            queuedRun = fn;
            return true;
          },
        ),
        closeStdin: vi.fn(),
        stopGroup: vi.fn(async () => undefined),
        isShuttingDown: () => false,
      },
    } as any;
    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger).toMatchObject({ success: true, runId: expect.any(String) });
    expect(cancelTaskRunNow(trigger.runId!)).toEqual({ success: true });

    await queuedRun!();
    expect(runContainerAgentMock).not.toHaveBeenCalled();
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'cancelled',
      notification_status: 'skipped',
    });
  });

  test('capacity-queued scheduled run keeps one reservation and one pinned JID', async () => {
    const taskId = createTask({
      id: 'task-scheduled-queued-jid',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const originalGroup = db.getRegisteredGroup(GROUP_JID)!;
    const movedJid = 'web:task-contract-moved';
    const movedFolder = 'task-contract-moved';
    db.setRegisteredGroup(movedJid, {
      ...originalGroup,
      name: 'Moved Workspace',
      folder: movedFolder,
    } as any);
    const groups = {
      [GROUP_JID]: originalGroup,
      [movedJid]: db.getRegisteredGroup(movedJid)!,
    };
    let queuedJid = '';
    let queuedRun: (() => Promise<void>) | null = null;
    const queue = {
      enqueueTask: vi.fn(
        (jid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedJid = jid;
          queuedRun = fn;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = { ...makeDeps(groups).deps, queue } as any;
    const snapshot = db.getTaskById(taskId)!;

    expect(enqueueIsolatedScheduledTask(snapshot, deps)).toBe(true);
    expect(enqueueIsolatedScheduledTask(snapshot, deps)).toBe(false);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(getRunningTaskIds()).toContain(taskId);

    // Even an out-of-band DB mutation cannot split GroupQueue tracking from
    // runTask's effective/onProcess JID. Supported PATCH is separately blocked
    // by the reservation contract in routes-tasks-contract.test.ts.
    db.updateTask(taskId, {
      chat_jid: movedJid,
      group_folder: movedFolder,
    } as any);
    await queuedRun!();

    const input = runContainerAgentMock.mock.calls[0][1];
    expect(input.chatJid).toBe(GROUP_JID);
    expect(input.groupFolder).toBe(GROUP_FOLDER);
    expect(deps.onProcess).toHaveBeenCalledWith(
      queuedJid,
      expect.anything(),
      expect.stringContaining(input.taskRunId),
      GROUP_FOLDER,
      expect.any(String),
      input.taskRunId,
      null,
    );
    expect(getRunningTaskIds()).not.toContain(taskId);
  });

  test('scheduled reservation releases on enqueue rejection, throw, and claim loss', async () => {
    const taskId = createTask({
      id: 'task-scheduled-release-paths',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const baseDeps = makeDeps(groups).deps;
    const snapshot = db.getTaskById(taskId)!;

    const rejectedDeps = {
      ...baseDeps,
      queue: { enqueueTask: () => false },
    } as any;
    expect(enqueueIsolatedScheduledTask(snapshot, rejectedDeps)).toBe(false);
    expect(getRunningTaskIds()).not.toContain(taskId);

    const throwingDeps = {
      ...baseDeps,
      queue: {
        enqueueTask: () => {
          throw new Error('queue failed');
        },
      },
    } as any;
    expect(() => enqueueIsolatedScheduledTask(snapshot, throwingDeps)).toThrow(
      'queue failed',
    );
    expect(getRunningTaskIds()).not.toContain(taskId);

    let queuedRun: (() => Promise<void>) | null = null;
    const claimLostDeps = {
      ...baseDeps,
      queue: {
        enqueueTask: (
          _jid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          queuedRun = fn;
          return true;
        },
      },
    } as any;
    expect(db.claimTaskForRun(taskId, 'another-scheduler', 60_000)).toBe(true);
    expect(enqueueIsolatedScheduledTask(snapshot, claimLostDeps)).toBe(true);
    await queuedRun!();
    expect(getRunningTaskIds()).not.toContain(taskId);
    expect(runContainerAgentMock).not.toHaveBeenCalled();
    db.updateTaskAfterRun(
      taskId,
      new Date(Date.now() + 60_000).toISOString(),
      'released competing lease',
    );
  });

  test('paused tasks can still be run manually once', async () => {
    const taskId = createTask({
      id: 'paused-manual-task',
      status: 'paused',
      next_run: null,
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, waitForRun } = makeDeps(groups);

    const result = triggerTaskNow(taskId, deps);
    expect(result.success).toBe(true);
    await waitForRun();

    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    expect(db.getTaskById(taskId)?.status).toBe('paused');
  });
});
