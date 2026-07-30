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
      const runtimeEnvDirs = [
        path.join(
          tmpDir,
          'env',
          input.groupFolder,
          'default',
          'tasks-run',
          input.taskRunId,
        ),
        path.join(
          tmpDir,
          'env',
          input.groupFolder,
          'channel-accounts',
          'account-a',
          'tasks-run',
          input.taskRunId,
        ),
      ];
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(ipcDir, { recursive: true });
      for (const runtimeEnvDir of runtimeEnvDirs) {
        fs.mkdirSync(runtimeEnvDir, { recursive: true });
        fs.writeFileSync(path.join(runtimeEnvDir, 'env'), 'SECRET=value');
      }
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
  runScript: runScriptMock,
}));

const db = await import('../src/db.js');
const {
  cancelTaskRunNow,
  computeNextRunForTaskResume,
  deliverPersistedNotificationPayload,
  enqueueIsolatedScheduledTask,
  getRunningTaskIds,
  hasAuthoritativeScheduledGroupTerminal,
  processClaimedTaskRunNotification,
  resolveScheduledGroupRunsForOutput,
  resolveTerminalScheduledGroupPromptRun,
  scheduledGroupPromptMessageId,
  shouldFinalizeScheduledRunOutput,
  triggerTaskNow,
} = await import('../src/task-scheduler.js');

const GROUP_JID = 'web:task-contract';
const GROUP_FOLDER = 'task-contract';

function makeDeps(
  groups: Record<string, any>,
  options: { autoDrainNotifications?: boolean } = {},
) {
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
    isGroupMutationPaused: vi.fn(() => false),
  };

  const deps = {
    registeredGroups: () => groups,
    getSessions: () => ({}),
    queue,
    onProcess: vi.fn(),
    sendMessage: vi.fn(),
    broadcastStreamEvent: vi.fn(),
    storePromptMessage: vi.fn(),
    storeGroupPromptAndDeliverRun: vi.fn((input: any) =>
      db.storeScheduledGroupPromptAndCompleteRun({
        runId: input.run.id,
        taskId: input.taskId,
        leaseOwner: input.run.lease_owner,
        leaseToken: input.run.lease_token,
        messageId: input.messageId,
        chatJid: input.chatJid,
        senderId: input.senderId,
        senderName: input.senderName,
        text: input.text,
        queuedResult: input.queuedResult,
      }),
    ),
    storeResultAndNotify: vi.fn(),
    assistantName: 'HappyClaw',
  } as any;
  return {
    deps,
    queue,
    waitForRun: async () => {
      await runPromise;
      if (options.autoDrainNotifications === false) return;
      for (let index = 0; index < 8; index++) {
        const claim = db.claimNextTaskRunNotification(
          `task-contract-auto-notifier-${index}`,
          60_000,
        );
        if (!claim) break;
        await processClaimedTaskRunNotification(claim, deps, 60_000);
      }
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

  test('fails an isolated occurrence whose completed Agent turn has no full business result', async () => {
    const taskId = createTask({ id: 'task-empty-isolated-result' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        return {
          status: 'success',
          result: null,
          inputTurnCompleted: true,
        };
      },
    );
    const { deps, waitForRun } = makeDeps(groups);

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();

    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'failed',
      result: null,
      error: expect.stringContaining('没有返回可展示的完整业务结果'),
      notification_status: 'success',
    });
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      GROUP_JID,
      expect.stringContaining('没有返回可展示的完整业务结果'),
      expect.objectContaining({
        sourceKind: 'scheduled_task_result',
        messageId: `scheduled-task-result:${trigger.runId}`,
        skipStore: false,
      }),
    );
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
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      GROUP_JID,
      expect.stringMatching(
        /## ✅ 定时任务执行完成[\s\S]*\*\*运行 ID\*\*[\s\S]*task result/,
      ),
      expect.objectContaining({
        sourceKind: 'scheduled_task_result',
        messageId: `scheduled-task-result:${result.runId}`,
        workspaceFolder: GROUP_FOLDER,
      }),
    );
    expect(db.getMessagesPage(GROUP_JID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('task result'),
          is_from_me: true,
        }),
      ]),
    );
    expect(
      fs.existsSync(
        path.join(tmpDir, 'ipc', GROUP_FOLDER, 'tasks-run', input.taskRunId),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'env',
          GROUP_FOLDER,
          'default',
          'tasks-run',
          input.taskRunId,
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'env',
          GROUP_FOLDER,
          'channel-accounts',
          'account-a',
          'tasks-run',
          input.taskRunId,
        ),
      ),
    ).toBe(false);
    const storedTask = db.getTaskById(taskId)!;
    expect(storedTask.workspace_jid).toBeNull();
    expect(storedTask.workspace_folder).toBeNull();
  });

  test('commits the isolated terminal and workspace intent inside the SDK terminal callback', async () => {
    const taskId = createTask({ id: 'task-terminal-callback-handoff' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let observedTerminalInsideRunner = false;
    runContainerAgentMock.mockImplementationOnce(
      async (_group, input, onProcess, onOutput) => {
        onProcess?.({} as never, `container-${input.taskRunId}`, null);
        await onOutput?.({
          status: 'success',
          result: 'callback terminal result',
          inputTurnCompleted: true,
        });
        const durableRunId = input.taskRunId
          .replace(/^task-run-/, '')
          .replace(/-attempt-1$/, '');
        const duringCallbackReturn = db.getTaskRunById(durableRunId)!;
        observedTerminalInsideRunner =
          duringCallbackReturn.status === 'success' &&
          duringCallbackReturn.result === 'callback terminal result' &&
          JSON.parse(
            (
              duringCallbackReturn as unknown as {
                notification_payload: string;
              }
            ).notification_payload,
          ).options.messageId === `scheduled-task-result:${durableRunId}`;
        return {
          status: 'success',
          result: 'callback terminal result',
          inputTurnCompleted: true,
        };
      },
    );
    const { deps, waitForRun } = makeDeps(groups);

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();

    expect(observedTerminalInsideRunner).toBe(true);
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'success',
      result: 'callback terminal result',
      notification_status: 'success',
    });
    expect(runContainerAgentMock).toHaveBeenCalledOnce();
  });

  test('persists and retries a failed canonical workspace result without rerunning isolated Agent work', async () => {
    const taskId = createTask({ id: 'task-workspace-projection-retry' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, waitForRun } = makeDeps(groups);
    deps.storeResultAndNotify.mockImplementation(
      async (_chatJid: string, _text: string, options: any) => {
        if (options.sourceKind === 'scheduled_task_result') {
          throw new Error('workspace broadcast unavailable');
        }
      },
    );

    const trigger = triggerTaskNow(taskId, deps);
    await waitForRun();
    await vi.waitFor(() => {
      expect(db.getTaskRunById(trigger.runId!)?.status).not.toBe('running');
    });
    const finished = db.getTaskRunById(trigger.runId!)!;
    expect(finished).toMatchObject({
      status: 'success',
      result: 'task result',
      notification_status: 'failed',
    });
    expect(finished.notification_error).toContain(
      'workspace broadcast unavailable',
    );

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const retry = db.claimNextTaskRunNotification(
      'workspace-projection-retry-worker',
      60_000,
    )!;
    expect(retry.payload).toMatchObject({
      kind: 'workspace_result',
      chatJid: GROUP_JID,
      options: {
        messageId: `scheduled-task-result:${trigger.runId}`,
        skipStore: false,
      },
    });

    deps.storeResultAndNotify.mockResolvedValueOnce(undefined);
    expect(await processClaimedTaskRunNotification(retry, deps, 60_000)).toBe(
      true,
    );
    expect(db.getTaskRunById(trigger.runId!)?.notification_status).toBe(
      'success',
    );
    expect(runContainerAgentMock).toHaveBeenCalledOnce();
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
      result: '已排队到源工作区，等待智能体执行',
      error: null,
    });
    expect(deps.storeGroupPromptAndDeliverRun).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: GROUP_JID,
        senderId: 'system',
        senderName: '定时任务',
        text: expect.stringContaining('write a short status'),
        taskId,
        messageId: expect.stringMatching(/^scheduled-task-prompt:/),
      }),
    );
    const storedPrompt = (deps.storeGroupPromptAndDeliverRun as any).mock
      .calls[0][0].text as string;
    expect(storedPrompt).toContain('完整、可独立阅读的业务结果');
    expect(storedPrompt).toContain('所有结论、报告和数据都要写在最终文本中');
    expect(storedPrompt).toContain('不得只回复“已完成”“已发送”');
    expect(storedPrompt).toContain('feishu-cli');
    expect(storedPrompt).toContain('工具投递不能替代上述完整最终文本');
  });

  test('cancels a delivered group run and durably projects the cancellation into its workspace', async () => {
    const baseJid = 'feishu:oc_cancel#account:bot-a';
    const deliveryRouteJid = `${baseJid}#thread:thread-a#root:root-a`;
    db.setRegisteredGroup(baseJid, {
      ...db.getRegisteredGroup(GROUP_JID)!,
      folder: GROUP_FOLDER,
    });
    const taskId = createTask({
      id: 'task-group-delivered-cancel',
      context_mode: 'group',
      chat_jid: baseJid,
      delivery_route_jid: deliveryRouteJid,
    });
    const groups = {
      [baseJid]: db.getRegisteredGroup(baseJid)!,
    };
    const { deps } = makeDeps(groups);

    const trigger = triggerTaskNow(taskId, deps);
    expect(trigger).toMatchObject({
      success: true,
      runId: expect.any(String),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'delivered',
      notification_status: 'skipped',
    });

    expect(
      db.cancelDeliveredGroupTaskRunWithWorkspaceIntent({
        runId: trigger.runId!,
        taskId,
        reason: 'Cancelled by user',
        payload: {
          kind: 'workspace_result',
          chatJid: baseJid,
          text: 'must not commit on the wrong route',
          groupRunId: trigger.runId!,
          groupTaskId: taskId,
          groupStatus: 'cancelled',
          groupResult: null,
          groupError: 'Cancelled by user',
          options: {
            sourceKind: 'scheduled_task_result',
            messageId: `scheduled-group-terminal:${trigger.runId}`,
            skipStore: false,
            workspaceFolder: GROUP_FOLDER,
          },
        },
      }),
    ).toBe(false);
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'delivered',
      notification_status: 'skipped',
    });

    db.updateTask(taskId, { prompt: 'edited prompt must not leak' });
    expect(cancelTaskRunNow(trigger.runId!)).toEqual({ success: true });
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'cancelled',
      result: null,
      error: 'Cancelled by user',
      notification_status: 'pending',
    });

    const lateMessageId = `scheduled-group-late:${trigger.runId}`;
    expect(() =>
      db.storeScheduledGroupWorkspaceResultAndFinalize({
        messageId: lateMessageId,
        chatJid: deliveryRouteJid,
        senderId: 'happyclaw-agent',
        senderName: 'HappyClaw',
        text: '迟到的成功结果',
        timestamp: new Date().toISOString(),
        messageMeta: { sourceKind: 'scheduled_task_result' },
        finalizations: [
          {
            runId: trigger.runId!,
            taskId,
            status: 'success',
            result: '迟到的成功结果',
            error: null,
          },
        ],
      }),
    ).toThrow(/could not atomically accept/);
    expect(db.getMessage(deliveryRouteJid, lateMessageId)).toBeNull();
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'cancelled',
      result: null,
      error: 'Cancelled by user',
      notification_status: 'pending',
    });

    const notification = db.claimTaskRunNotificationById(
      trigger.runId!,
      'group-cancel-workspace-projector',
      60_000,
    )!;
    expect(notification.payload).toMatchObject({
      kind: 'workspace_result',
      chatJid: deliveryRouteJid,
      groupRunId: trigger.runId,
      groupTaskId: taskId,
      groupStatus: 'cancelled',
      groupResult: null,
      groupError: 'Cancelled by user',
      options: {
        sourceKind: 'scheduled_task_result',
        messageId: `scheduled-group-terminal:${trigger.runId}`,
        skipStore: false,
        workspaceFolder: GROUP_FOLDER,
      },
    });
    expect(notification.payload).toMatchObject({
      text: expect.stringContaining('定时任务已取消'),
    });
    expect(notification.payload).toMatchObject({
      text: expect.stringContaining('write a short status'),
    });
    expect(notification.payload).toMatchObject({
      text: expect.stringContaining('Cancelled by user'),
    });
    expect((notification.payload as { text: string }).text).not.toContain(
      '执行失败',
    );
    expect((notification.payload as { text: string }).text).not.toContain(
      'edited prompt must not leak',
    );
    expect(
      await processClaimedTaskRunNotification(notification, deps, 60_000),
    ).toBe(true);
    expect(deps.storeResultAndNotify).toHaveBeenCalledWith(
      deliveryRouteJid,
      expect.stringContaining('Cancelled by user'),
      expect.objectContaining({
        messageId: `scheduled-group-terminal:${trigger.runId}`,
        skipStore: false,
      }),
    );
    expect(db.getTaskRunById(trigger.runId!)).toMatchObject({
      status: 'cancelled',
      notification_status: 'success',
      notification_error: null,
    });
  });

  test('resolves exact cold and warm group runs, including multi-prompt batches, without guessing from ordinary messages', () => {
    const run = (
      id: string,
      taskId: string,
      status: 'delivered' | 'success' | 'failed' | 'cancelled' = 'delivered',
    ) =>
      ({
        id,
        task_id: taskId,
        status,
        definition_snapshot: { context_mode: 'group' },
      }) as any;
    const runA = run('11111111-1111-4111-8111-111111111111', 'group-task-a');
    const runB = run('22222222-2222-4222-8222-222222222222', 'group-task-b');
    const runC = run(
      '33333333-3333-4333-8333-333333333333',
      'group-task-c',
      'cancelled',
    );
    const promptA = {
      id: scheduledGroupPromptMessageId(runA.id),
      chat_jid: GROUP_JID,
      source_kind: 'scheduled_task_prompt',
      task_id: runA.task_id,
    };
    const promptB = {
      id: scheduledGroupPromptMessageId(runB.id),
      chat_jid: GROUP_JID,
      source_kind: 'scheduled_task_prompt',
      task_id: runB.task_id,
    };
    const promptC = {
      id: scheduledGroupPromptMessageId(runC.id),
      chat_jid: GROUP_JID,
      source_kind: 'scheduled_task_prompt',
      task_id: runC.task_id,
    };
    const ordinary = {
      id: 'ordinary-user-input',
      chat_jid: GROUP_JID,
      source_kind: 'legacy',
      task_id: null,
    };
    const messages = new Map(
      [promptA, ordinary, promptB, promptC].map((message) => [
        message.id,
        message,
      ]),
    );
    const runs = new Map([
      [runA.id, runA],
      [runB.id, runB],
      [runC.id, runC],
    ]);
    const common = {
      chatJid: GROUP_JID,
      getMessage: (_chatJid: string, messageId: string) =>
        messages.get(messageId) ?? null,
      getRun: (runId: string) => runs.get(runId),
    };

    const cold = resolveScheduledGroupRunsForOutput({
      ...common,
      fallbackInputTurnId: promptB.id,
      coldMessages: [promptA, ordinary, promptB],
      output: { inputTurnId: promptB.id },
    });
    expect(cold.map((item) => item.id)).toEqual([runA.id, runB.id]);

    const coldFromNarrowProjection = resolveScheduledGroupRunsForOutput({
      ...common,
      fallbackInputTurnId: promptB.id,
      coldMessages: [
        {
          id: promptB.id,
          chat_jid: GROUP_JID,
          task_id: promptB.task_id,
        },
      ],
      output: { inputTurnId: promptB.id },
    });
    expect(coldFromNarrowProjection.map((item) => item.id)).toEqual([runB.id]);

    const warm = resolveScheduledGroupRunsForOutput({
      ...common,
      fallbackInputTurnId: 'unrelated-cold-input',
      coldMessages: [],
      output: {
        inputTurnId: 'ipc-delivery-turn',
        ipcReceipts: [
          {
            chatJid: GROUP_JID,
            deliveryId: 'ipc-delivery-turn',
            cursor: { timestamp: '2026-07-30T00:00:00.000Z', id: promptB.id },
            coveredCursors: [
              {
                timestamp: '2026-07-30T00:00:00.000Z',
                id: promptA.id,
              },
              {
                timestamp: '2026-07-30T00:00:01.000Z',
                id: ordinary.id,
              },
              {
                timestamp: '2026-07-30T00:00:02.000Z',
                id: promptB.id,
              },
              {
                timestamp: '2026-07-30T00:00:03.000Z',
                id: promptC.id,
              },
            ],
          } as any,
        ],
      },
    });
    expect(warm.map((item) => item.id)).toEqual([runA.id, runB.id, runC.id]);
    expect(hasAuthoritativeScheduledGroupTerminal(runC)).toBe(true);
    expect(hasAuthoritativeScheduledGroupTerminal(runA)).toBe(false);

    const ordinaryOnly = resolveScheduledGroupRunsForOutput({
      ...common,
      fallbackInputTurnId: ordinary.id,
      coldMessages: [ordinary],
      output: { inputTurnId: ordinary.id },
    });
    expect(ordinaryOnly).toEqual([]);
  });

  test('resolves a cold group run from the real incremental message projection', () => {
    const chatJid = 'web:task-contract-cold-db-projection';
    db.setRegisteredGroup(chatJid, {
      ...db.getRegisteredGroup(GROUP_JID)!,
      folder: 'task-contract-cold-db-projection',
    });
    const taskId = createTask({
      id: 'task-group-cold-db-projection',
      chat_jid: chatJid,
      group_folder: 'task-contract-cold-db-projection',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-cold-db-projection',
    });
    const claim = db.claimNextTaskRun(
      'group-cold-db-projection-worker',
      60_000,
    )!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    const promptId = scheduledGroupPromptMessageId(claim.id);
    db.storeScheduledGroupPromptAndCompleteRun({
      runId: claim.id,
      taskId,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      messageId: promptId,
      chatJid,
      senderId: 'system',
      senderName: '定时任务',
      text: 'run the production-shaped cold report',
      queuedResult: '已排队',
    });

    const coldMessages = db.getMessagesSince(chatJid, {
      timestamp: '',
      id: '',
    });
    expect(coldMessages).toEqual([
      expect.objectContaining({
        id: promptId,
        source_kind: 'scheduled_task_prompt',
        task_id: taskId,
      }),
    ]);
    expect(
      resolveScheduledGroupRunsForOutput({
        chatJid,
        fallbackInputTurnId: promptId,
        coldMessages,
        output: { inputTurnId: promptId },
        getMessage: (targetJid, messageId) =>
          db.getMessage(targetJid, messageId) as any,
        getRun: db.getTaskRunById,
      }).map((run) => run.id),
    ).toEqual([claim.id]);
  });

  test('upgrades a delivered group run with the full result exactly once', () => {
    const taskId = createTask({
      id: 'task-group-result-idempotency',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-result-idempotency',
    });
    const claim = db.claimNextTaskRun('group-result-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'delivered',
        result: '已排队到源工作区，等待智能体执行',
        notificationStatus: 'skipped',
      }),
    ).toBe(true);

    expect(
      db.finalizeDeliveredGroupTaskRun(claim.id, taskId, {
        result: '完整业务结果',
      }),
    ).toBe(true);
    expect(
      db.finalizeDeliveredGroupTaskRun(claim.id, taskId, {
        result: '完整业务结果',
      }),
    ).toBe(true);
    expect(
      db.finalizeDeliveredGroupTaskRun(claim.id, taskId, {
        result: '迟到的不同回调',
      }),
    ).toBe(false);
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'success',
      result: '完整业务结果',
      error: null,
    });
    expect(cancelTaskRunNow(claim.id)).toEqual({
      success: false,
      error: 'Task run is already success',
    });
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'success',
      result: '完整业务结果',
      error: null,
    });
  });

  test('atomically rolls back the group prompt when the run fence cannot enter delivered state', () => {
    const taskId = createTask({
      id: 'task-group-prompt-atomicity',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-prompt-atomicity',
    });
    const claim = db.claimNextTaskRun('group-atomic-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    const messageId = scheduledGroupPromptMessageId(claim.id);

    expect(() =>
      db.storeScheduledGroupPromptAndCompleteRun({
        runId: claim.id,
        taskId,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token + 1,
        messageId,
        chatJid: GROUP_JID,
        senderId: 'system',
        senderName: '定时任务',
        text: 'atomic prompt',
        queuedResult: '已排队',
      }),
    ).toThrow(/lost its execution fence/);
    expect(db.getMessage(GROUP_JID, messageId)).toBeNull();
    expect(db.getTaskRunById(claim.id)?.status).toBe('running');

    expect(
      db.storeScheduledGroupPromptAndCompleteRun({
        runId: claim.id,
        taskId,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token,
        messageId,
        chatJid: GROUP_JID,
        senderId: 'system',
        senderName: '定时任务',
        text: 'atomic prompt',
        queuedResult: '已排队',
      }),
    ).toBe(messageId);
    expect(db.getMessage(GROUP_JID, messageId)).toMatchObject({
      id: messageId,
      is_from_me: 0,
    });
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'delivered',
      result: '已排队',
      notification_status: 'skipped',
    });
  });

  test('atomically stores one canonical group result and terminalizes every represented run', () => {
    const taskA = createTask({
      id: 'task-group-result-atomic-a',
      context_mode: 'group',
    });
    const taskB = createTask({
      id: 'task-group-result-atomic-b',
      context_mode: 'group',
    });
    const deliveredRuns = [taskA, taskB].map((taskId, index) => {
      const task = db.getTaskById(taskId)!;
      const created = db.createTaskRun({
        task,
        triggerType: 'manual',
        idempotencyKey: `group-result-atomic-${index}`,
      });
      const claim = db.claimNextTaskRun(
        `group-result-atomic-worker-${index}`,
        60_000,
      )!;
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'delivered',
        result: '已排队',
        notificationStatus: 'skipped',
      });
      return { runId: created.run.id, taskId };
    });
    const messageId = 'scheduled-group-result:atomic-two-runs';

    expect(
      db.storeScheduledGroupWorkspaceResultAndFinalize({
        messageId,
        chatJid: GROUP_JID,
        senderId: 'happyclaw-agent',
        senderName: 'HappyClaw',
        text: '两个任务共享的完整结果',
        timestamp: new Date().toISOString(),
        messageMeta: { sourceKind: 'scheduled_task_result' },
        finalizations: deliveredRuns.map((run) => ({
          ...run,
          status: 'success',
          result: '两个任务共享的完整结果',
          error: null,
        })),
      }),
    ).toBe(messageId);
    expect(db.getMessagesPage(GROUP_JID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: messageId,
          content: '两个任务共享的完整结果',
          source_kind: 'scheduled_task_result',
        }),
      ]),
    );
    for (const run of deliveredRuns) {
      expect(db.getTaskRunById(run.runId)).toMatchObject({
        status: 'success',
        result: '两个任务共享的完整结果',
      });
    }
  });

  test('upgrades one held sdk_final row to the complete scheduled result', () => {
    const taskId = createTask({
      id: 'task-group-truncation-merge',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-truncation-merge',
    });
    const claim = db.claimNextTaskRun('group-truncation-merge-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'delivered',
        result: '已排队',
        notificationStatus: 'skipped',
      }),
    ).toBe(true);

    const turnId = 'scheduled-truncated-logical-input';
    const heldMessageId = db.storeMessageDirect(
      'scheduled-truncated-held',
      GROUP_JID,
      'happyclaw-agent',
      'HappyClaw',
      '首段业务数据\n\n> ⚠️ 回复在生成中被上游截断，正在自动续写…',
      new Date().toISOString(),
      true,
      {
        meta: {
          turnId,
          sourceKind: 'sdk_final',
          finalizationReason: 'truncated',
        },
      },
    );
    const completeResult = '首段业务数据\n\n---\n\n续写后的最终结论';

    expect(
      db.storeScheduledGroupWorkspaceResultAndFinalize({
        messageId: 'scheduled-group-result:truncation-merge',
        chatJid: GROUP_JID,
        senderId: 'happyclaw-agent',
        senderName: 'HappyClaw',
        text: completeResult,
        timestamp: new Date().toISOString(),
        messageMeta: {
          turnId,
          sourceKind: 'scheduled_task_result',
          finalizationReason: 'completed',
        },
        finalizations: [
          {
            runId: created.run.id,
            taskId,
            status: 'success',
            result: completeResult,
            error: null,
          },
        ],
      }),
    ).toBe(heldMessageId);

    const rows = db
      .getMessagesPage(GROUP_JID)
      .filter((message) => message.turn_id === turnId);
    expect(rows).toEqual([
      expect.objectContaining({
        id: heldMessageId,
        content: completeResult,
        source_kind: 'scheduled_task_result',
        finalization_reason: 'completed',
      }),
    ]);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      status: 'success',
      result: completeResult,
    });
  });

  test('rolls back the canonical group message and earlier run transitions when any represented run rejects', () => {
    const taskA = createTask({
      id: 'task-group-result-rollback-a',
      context_mode: 'group',
    });
    const taskB = createTask({
      id: 'task-group-result-rollback-b',
      context_mode: 'group',
    });
    const deliveredRuns = [taskA, taskB].map((taskId, index) => {
      const task = db.getTaskById(taskId)!;
      const created = db.createTaskRun({
        task,
        triggerType: 'manual',
        idempotencyKey: `group-result-rollback-${index}`,
      });
      const claim = db.claimNextTaskRun(
        `group-result-rollback-worker-${index}`,
        60_000,
      )!;
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'delivered',
        result: '已排队',
        notificationStatus: 'skipped',
      });
      return { runId: created.run.id, taskId };
    });
    const messageId = 'scheduled-group-result:must-rollback';

    expect(() =>
      db.storeScheduledGroupWorkspaceResultAndFinalize({
        messageId,
        chatJid: GROUP_JID,
        senderId: 'happyclaw-agent',
        senderName: 'HappyClaw',
        text: '不得留下的结果',
        timestamp: new Date().toISOString(),
        messageMeta: { sourceKind: 'scheduled_task_result' },
        finalizations: [
          {
            ...deliveredRuns[0],
            status: 'success',
            result: '不得留下的结果',
          },
          {
            ...deliveredRuns[1],
            taskId: `${deliveredRuns[1].taskId}-wrong-fence`,
            status: 'success',
            result: '不得留下的结果',
          },
        ],
      }),
    ).toThrow(/could not atomically accept/);
    expect(db.getMessage(GROUP_JID, messageId)).toBeNull();
    for (const run of deliveredRuns) {
      expect(db.getTaskRunById(run.runId)).toMatchObject({
        status: 'delivered',
        result: '已排队',
      });
    }
  });

  test('atomically terminalizes an isolated run with a pending canonical workspace intent', () => {
    const taskId = createTask({ id: 'task-isolated-result-atomic' });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'isolated-result-atomic',
    });
    const claim = db.claimNextTaskRun('isolated-result-atomic-worker', 60_000)!;
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    );
    const payload: db.TaskRunTextNotificationPayload = {
      kind: 'workspace_result',
      chatJid: GROUP_JID,
      text: '完整隔离任务结果',
      options: {
        sourceKind: 'scheduled_task_result',
        messageId: `scheduled-task-result:${created.run.id}`,
        skipStore: false,
        workspaceFolder: GROUP_FOLDER,
      },
    };

    expect(
      db.completeIsolatedTaskRunWithWorkspaceResultIntent({
        runId: created.run.id,
        taskId,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token + 1,
        status: 'success',
        result: '完整隔离任务结果',
        error: null,
        payload,
      }),
    ).toBe(false);
    expect(db.getTaskRunById(created.run.id)).toMatchObject({
      status: 'running',
      notification_payload: null,
    });

    expect(
      db.completeIsolatedTaskRunWithWorkspaceResultIntent({
        runId: created.run.id,
        taskId,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token,
        status: 'success',
        result: '完整隔离任务结果',
        error: null,
        payload,
      }),
    ).toBe(true);
    const stored = db.getTaskRunById(created.run.id)!;
    expect(stored).toMatchObject({
      status: 'success',
      result: '完整隔离任务结果',
      notification_status: 'pending',
      lease_owner: null,
    });
    expect(
      JSON.parse(
        (stored as unknown as { notification_payload: string })
          .notification_payload,
      ),
    ).toEqual(payload);
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
    const projectionClaim = db.claimTaskRunNotificationById(
      created.run.id,
      'isolated-result-projector',
      60_000,
    )!;
    expect(projectionClaim).toMatchObject({ payload, attempt: 1 });
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
      db.completeTaskRunNotificationAttempt(projectionClaim, {
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
      notification_status: 'success',
      notification_error: null,
      notification_summary: {
        attempted: 3,
        succeeded: 3,
        failed: 0,
        failed_channels: [],
      },
    });
  });

  test('retries a failed group workspace projection before upgrading delivered to success', async () => {
    const taskId = createTask({
      id: 'task-group-workspace-retry',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-workspace-retry',
    });
    const claim = db.claimNextTaskRun('group-workspace-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    const promptId = scheduledGroupPromptMessageId(claim.id);
    db.storeScheduledGroupPromptAndCompleteRun({
      runId: claim.id,
      taskId,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      messageId: promptId,
      chatJid: GROUP_JID,
      senderId: 'system',
      senderName: '定时任务',
      text: 'run the report',
      queuedResult: '已排队',
    });
    const resultMessageId = `scheduled-group-result:${claim.id}`;
    const retryPayload: db.TaskRunNotificationPayload = {
      kind: 'workspace_result',
      chatJid: GROUP_JID,
      text: '完整调研结果',
      groupRunId: claim.id,
      groupTaskId: taskId,
      groupResult: '完整调研结果',
      options: {
        sourceKind: 'scheduled_task_result',
        messageId: resultMessageId,
        skipStore: false,
        workspaceFolder: GROUP_FOLDER,
      },
    };
    expect(
      db.recordTaskRunNotificationReceipt(
        claim.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: [`workspace:${GROUP_JID}`],
          },
          error: 'broadcast unavailable',
        },
        retryPayload,
      ),
    ).toBe(true);
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'delivered',
      notification_status: 'failed',
      result: '已排队',
    });

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const retry = db.claimNextTaskRunNotification(
      'group-workspace-retry-worker',
      60_000,
    )!;
    const storeResultAndNotify = vi.fn(async () => undefined);
    expect(
      await processClaimedTaskRunNotification(
        retry,
        {
          storeResultAndNotify,
          sendMessage: vi.fn(),
        } as never,
        60_000,
      ),
    ).toBe(true);
    expect(storeResultAndNotify).toHaveBeenCalledWith(
      GROUP_JID,
      '完整调研结果',
      expect.objectContaining({
        messageId: resultMessageId,
        skipStore: false,
      }),
    );
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'success',
      result: '完整调研结果',
      notification_status: 'success',
    });
  });

  test('keeps a group run delivered during retry and durably settles a terminal workspace failure', async () => {
    const taskId = createTask({
      id: 'task-group-terminal-workspace-retry',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'group-terminal-workspace-retry',
    });
    const claim = db.claimNextTaskRun('group-terminal-worker', 60_000)!;
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    );
    db.storeScheduledGroupPromptAndCompleteRun({
      runId: claim.id,
      taskId,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      messageId: scheduledGroupPromptMessageId(claim.id),
      chatJid: GROUP_JID,
      senderId: 'system',
      senderName: '定时任务',
      text: 'run terminal report',
      queuedResult: '已排队',
    });
    const error = '处理失败，已达最大重试次数';
    const messageId = `scheduled-group-terminal:${claim.id}`;
    expect(
      db.recordTaskRunNotificationReceipt(
        claim.id,
        {
          status: 'failed',
          summary: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failed_channels: [`workspace:${GROUP_JID}`],
          },
          error: 'workspace unavailable',
        },
        {
          kind: 'workspace_result',
          chatJid: GROUP_JID,
          text: `## ❌ 定时任务执行失败\n\n${error}`,
          groupRunId: claim.id,
          groupTaskId: taskId,
          groupStatus: 'failed',
          groupResult: null,
          groupError: error,
          options: {
            sourceKind: 'scheduled_task_result',
            messageId,
            skipStore: false,
            workspaceFolder: GROUP_FOLDER,
          },
        },
      ),
    ).toBe(true);

    // A retryable/intermediate failure must not falsely terminate the run
    // before the visible workspace result is durable.
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'delivered',
      notification_status: 'failed',
    });

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const retry = db.claimNextTaskRunNotification(
      'group-terminal-retry-worker',
      60_000,
    )!;
    const storeResultAndNotify = vi.fn(async () => undefined);
    expect(
      await processClaimedTaskRunNotification(
        retry,
        {
          storeResultAndNotify,
          sendMessage: vi.fn(),
        } as never,
        60_000,
      ),
    ).toBe(true);
    expect(storeResultAndNotify).toHaveBeenCalledWith(
      GROUP_JID,
      expect.stringContaining(error),
      expect.objectContaining({ messageId, skipStore: false }),
    );
    expect(db.getTaskRunById(claim.id)).toMatchObject({
      status: 'failed',
      result: null,
      error,
      notification_status: 'success',
    });
  });

  test('skips only exact terminal group prompts after max retry', () => {
    const taskId = createTask({
      id: 'task-group-terminal-prompt-skip',
      context_mode: 'group',
    });
    const task = db.getTaskById(taskId)!;
    const oldCreated = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'old-terminal-prompt',
    });
    const oldClaim = db.claimNextTaskRun('old-terminal-worker', 60_000)!;
    db.markTaskRunExecutionStarted(
      oldClaim.id,
      oldClaim.lease_owner,
      oldClaim.lease_token,
    );
    db.completeTaskRun(
      oldClaim.id,
      oldClaim.lease_owner,
      oldClaim.lease_token,
      {
        status: 'delivered',
        result: '已排队',
        notificationStatus: 'skipped',
      },
    );
    db.finalizeDeliveredGroupTaskRun(oldCreated.run.id, taskId, {
      status: 'failed',
      error: 'max retries',
    });

    const laterCreated = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'later-live-prompt',
    });
    const laterClaim = db.claimNextTaskRun('later-live-worker', 60_000)!;
    db.markTaskRunExecutionStarted(
      laterClaim.id,
      laterClaim.lease_owner,
      laterClaim.lease_token,
    );
    db.completeTaskRun(
      laterClaim.id,
      laterClaim.lease_owner,
      laterClaim.lease_token,
      {
        status: 'delivered',
        result: '已排队',
        notificationStatus: 'skipped',
      },
    );

    const oldPrompt = {
      id: scheduledGroupPromptMessageId(oldCreated.run.id),
      chat_jid: GROUP_JID,
      source_kind: 'scheduled_task_prompt',
      task_id: taskId,
    };
    const laterPrompt = {
      id: scheduledGroupPromptMessageId(laterCreated.run.id),
      chat_jid: GROUP_JID,
      source_kind: 'scheduled_task_prompt',
      task_id: taskId,
    };
    expect(
      resolveTerminalScheduledGroupPromptRun(oldPrompt, db.getTaskRunById),
    ).toMatchObject({ id: oldCreated.run.id, status: 'failed' });
    expect(
      resolveTerminalScheduledGroupPromptRun(laterPrompt, db.getTaskRunById),
    ).toBeNull();
    expect(
      resolveTerminalScheduledGroupPromptRun(
        { ...oldPrompt, id: laterPrompt.id },
        db.getTaskRunById,
      ),
    ).toBeNull();
    expect(
      db.finalizeDeliveredGroupTaskRun(laterCreated.run.id, taskId, {
        status: 'cancelled',
        error: 'Cancelled by user',
      }),
    ).toBe(true);
    expect(
      resolveTerminalScheduledGroupPromptRun(laterPrompt, db.getTaskRunById),
    ).toMatchObject({ id: laterCreated.run.id, status: 'cancelled' });
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
    const { deps, waitForRun } = makeDeps(
      { [GROUP_JID]: group },
      { autoDrainNotifications: false },
    );
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
    ).toMatchObject({
      kind: 'batch',
      items: expect.arrayContaining([
        ipcPayload,
        expect.objectContaining({
          kind: 'workspace_result',
          options: expect.objectContaining({
            messageId: `scheduled-task-result:${trigger.runId}`,
          }),
        }),
      ]),
    });
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

  test('does not start a detached task process behind a workspace mutation gate', () => {
    const ownerId = 'mutation-gated-script-owner';
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
    db.setRegisteredGroup(GROUP_JID, {
      name: 'Task Contract Host Workspace',
      folder: GROUP_FOLDER,
      added_at: now,
      executionMode: 'host',
      created_by: ownerId,
      is_home: false,
    } as any);
    const taskId = createTask({
      id: 'mutation-gated-script-task',
      execution_type: 'script',
      execution_mode: 'host',
      script_command: 'echo gated',
      created_by: ownerId,
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, queue } = makeDeps(groups);
    queue.isGroupMutationPaused.mockReturnValue(true);

    const result = triggerTaskNow(taskId, deps);

    expect(result.success).toBe(true);
    expect(queue.isGroupMutationPaused).toHaveBeenCalledWith(GROUP_JID);
    expect(runScriptMock).not.toHaveBeenCalled();
    expect(db.getTaskRunById(result.runId!)).toMatchObject({
      status: 'retry_wait',
      error: 'Workspace mutation is in progress',
    });
  });
});
