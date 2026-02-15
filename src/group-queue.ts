import { ChildProcess, exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  MAX_CONCURRENT_HOST_PROCESSES,
} from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  displayName: string | null;
  groupFolder: string | null;
  retryCount: number;
  restarting: boolean;
}

type ActiveGroupState = GroupState & { groupFolder: string };

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeContainerCount = 0;
  private activeHostProcessCount = 0;
  private waitingGroups = new Set<string>();
  private contextOverflowGroups = new Set<string>(); // 跟踪发生上下文溢出的 group
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private hostModeChecker: ((groupJid: string) => boolean) | null = null;
  private serializationKeyResolver: ((groupJid: string) => string) | null =
    null;
  private onMaxRetriesExceededFn: ((groupJid: string) => void) | null = null;
  private onContainerExitFn: ((groupJid: string) => void) | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        displayName: null,
        groupFolder: null,
        retryCount: 0,
        restarting: false,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setHostModeChecker(fn: (groupJid: string) => boolean): void {
    this.hostModeChecker = fn;
  }

  setSerializationKeyResolver(fn: (groupJid: string) => string): void {
    this.serializationKeyResolver = fn;
  }

  setOnMaxRetriesExceeded(fn: (groupJid: string) => void): void {
    this.onMaxRetriesExceededFn = fn;
  }

  setOnContainerExit(fn: (groupJid: string) => void): void {
    this.onContainerExitFn = fn;
  }

  /**
   * 标记 group 发生了上下文溢出错误，跳过指数退避重试
   */
  markContextOverflow(groupJid: string): void {
    this.contextOverflowGroups.add(groupJid);
    logger.warn(
      { groupJid },
      'Marked group as context overflow - will skip retry backoff',
    );
  }

  private isHostMode(groupJid: string): boolean {
    return this.hostModeChecker?.(groupJid) ?? false;
  }

  private getSerializationKey(groupJid: string): string {
    const key = this.serializationKeyResolver?.(groupJid)?.trim();
    return key || groupJid;
  }

  private findActiveRunnerFor(groupJid: string): string | null {
    const key = this.getSerializationKey(groupJid);
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      if (this.getSerializationKey(jid) === key) return jid;
    }
    return null;
  }

  private hasCapacityFor(groupJid: string): boolean {
    const isHost = this.isHostMode(groupJid);
    return isHost
      ? this.activeHostProcessCount < MAX_CONCURRENT_HOST_PROCESSES
      : this.activeContainerCount < MAX_CONCURRENT_CONTAINERS;
  }

  private resolveActiveState(groupJid: string): ActiveGroupState | null {
    const own = this.getGroup(groupJid);
    if (own.active && own.groupFolder) return own as ActiveGroupState;

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return null;
    const shared = this.getGroup(activeRunner);
    if (!shared.active || !shared.groupFolder) return null;
    return shared as ActiveGroupState;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      logger.debug(
        { groupJid, activeRunner: activeRunner || groupJid },
        'Group runner active, message queued',
      );
      return;
    }

    if (!this.hasCapacityFor(groupJid)) {
      const isHost = this.isHostMode(groupJid);
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      logger.debug(
        {
          groupJid,
          activeContainerCount: this.activeContainerCount,
          activeHostProcessCount: this.activeHostProcessCount,
          mode: isHost ? 'host' : 'container',
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.waitingGroups.delete(groupJid);
    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      logger.debug(
        { groupJid, taskId, activeRunner: activeRunner || groupJid },
        'Group runner active, task queued',
      );
      return;
    }

    if (!this.hasCapacityFor(groupJid)) {
      const isHost = this.isHostMode(groupJid);
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      logger.debug(
        {
          groupJid,
          taskId,
          activeContainerCount: this.activeContainerCount,
          activeHostProcessCount: this.activeHostProcessCount,
          mode: isHost ? 'host' : 'container',
        },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.waitingGroups.delete(groupJid);
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder?: string,
    displayName?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    state.displayName = displayName || null;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
  ): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', text, images }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Force-stop a group's active container and clear queued work.
   * Returns a promise that resolves when the container has fully exited
   * (state.active becomes false), not just when docker stop completes.
   */
  async stopGroup(groupJid: string, options?: { force?: boolean }): Promise<void> {
    const force = options?.force ?? false;
    const requestedState = this.getGroup(groupJid);
    requestedState.pendingMessages = false;
    requestedState.pendingTasks = [];

    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    if (targetJid !== groupJid) {
      state.pendingMessages = false;
      state.pendingTasks = [];
    }
    this.waitingGroups.delete(groupJid);
    this.waitingGroups.delete(targetJid);

    if (state.groupFolder) {
      this.closeStdin(targetJid);
    }

    if (force) {
      // Force mode: skip graceful stop, go straight to kill
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['kill', name], { timeout: 5000 }, () => resolve());
        });
      } else if (state.process && !state.process.killed) {
        try {
          state.process.kill('SIGKILL');
        } catch {
          // ignore
        }
      }

      if (state.active) {
        const start = Date.now();
        while (state.active && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } else {
      // Graceful mode: try SIGTERM/docker stop first
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['stop', name], { timeout: 10000 }, () => resolve());
        });
      } else if (state.process && !state.process.killed) {
        try {
          state.process.kill('SIGTERM');
        } catch {
          // ignore
        }
      }

      // Wait for state.active to become false (runForGroup/runTask finally block)
      if (state.active) {
        const maxWait = 10000;
        const start = Date.now();
        while (state.active && Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Graceful stop timed out — force-kill the container
      if (state.active && state.containerName) {
        const killName = state.containerName;
        logger.warn(
          { groupJid: targetJid, containerName: killName },
          'Graceful stop timed out, force-killing container',
        );
        await new Promise<void>((resolve) => {
          execFile('docker', ['kill', killName], { timeout: 5000 }, () =>
            resolve(),
          );
        });
        const killStart = Date.now();
        while (state.active && Date.now() - killStart < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } else if (state.active && state.process) {
        try {
          state.process.kill('SIGKILL');
        } catch {
          // ignore
        }
        const killStart = Date.now();
        while (state.active && Date.now() - killStart < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    if (state.active) {
      logger.error(
        { groupJid: targetJid },
        'Container still active after force-kill in stopGroup',
      );
      throw new Error(`Failed to stop container for group ${targetJid}`);
    }
  }

  /**
   * Stop the running container, wait for it to finish, then start a new one.
   */
  async restartGroup(groupJid: string): Promise<void> {
    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);

    if (state.restarting) {
      logger.warn({ groupJid: targetJid }, 'Restart already in progress, skipping');
      return;
    }
    state.restarting = true;

    try {
      if (state.groupFolder) {
        this.closeStdin(targetJid);
      }

      // Stop docker container and wait for it
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['stop', name], { timeout: 15000 }, () =>
            resolve(),
          );
        });
      } else if (state.process && !state.process.killed) {
        try {
          state.process.kill('SIGTERM');
        } catch {
          // ignore
        }
      }

      // Wait for runForGroup to finish and reset state
      const maxWait = 20000;
      const start = Date.now();
      while (state.active && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (state.active) {
        logger.warn(
          { groupJid: targetJid },
          'Timeout waiting for container to stop, force-killing',
        );
        // Force-kill the container to avoid conflicts with the new one
        if (state.containerName) {
          const killName = state.containerName;
          await new Promise<void>((resolve) => {
            execFile('docker', ['kill', killName], { timeout: 5000 }, () =>
              resolve(),
            );
          });
          // Brief wait for process cleanup after force-kill
          const killStart = Date.now();
          while (state.active && Date.now() - killStart < 5000) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } else if (state.process) {
          try {
            state.process.kill('SIGKILL');
          } catch {
            // ignore
          }
          const killStart = Date.now();
          while (state.active && Date.now() - killStart < 5000) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      if (state.active) {
        logger.error(
          { groupJid: targetJid },
          'Container still active after force-kill in restartGroup',
        );
        throw new Error(`Failed to restart container for group ${targetJid}`);
      }

      // Trigger a fresh container start
      logger.info({ groupJid: targetJid }, 'Restarting container');
      this.enqueueMessageCheck(groupJid);
    } finally {
      state.restarting = false;
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    state.pendingMessages = false;
    this.waitingGroups.delete(groupJid);
    this.activeCount++;
    if (isHostMode) {
      this.activeHostProcessCount++;
    } else {
      this.activeContainerCount++;
    }

    logger.debug(
      {
        groupJid,
        reason,
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
      },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onContainerExitFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onContainerExit callback failed');
      }
      try {
        this.drainGroup(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'drainGroup failed');
      }
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    this.waitingGroups.delete(groupJid);
    this.activeCount++;
    if (isHostMode) {
      this.activeHostProcessCount++;
    } else {
      this.activeContainerCount++;
    }

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
      },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onContainerExitFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onContainerExit callback failed');
      }
      try {
        this.drainGroup(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'drainGroup failed');
      }
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    // 检查是否为上下文溢出错误，如果是则跳过重试
    if (this.contextOverflowGroups.has(groupJid)) {
      logger.warn(
        { groupJid },
        'Skipping retry for context overflow error (agent already retried 3 times)',
      );
      state.retryCount = 0;
      this.contextOverflowGroups.delete(groupJid); // 清除标记
      return;
    }

    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      try {
        this.onMaxRetriesExceededFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onMaxRetriesExceeded callback failed');
      }
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (activeRunner && activeRunner !== groupJid) {
      this.waitingGroups.add(groupJid);
      return;
    }
    if (!this.hasCapacityFor(groupJid)) {
      this.waitingGroups.add(groupJid);
      return;
    }

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    this.waitingGroups.delete(groupJid);

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    // Drain waiting groups one at a time, re-checking capacity after each launch.
    // runTask/runForGroup increment counters synchronously, so capacity checks
    // stay accurate even though the async work is not awaited.
    const candidates = [...this.waitingGroups];

    for (const jid of candidates) {
      const activeRunner = this.findActiveRunnerFor(jid);
      if (activeRunner && activeRunner !== jid) continue;
      if (!this.hasCapacityFor(jid)) continue;

      this.waitingGroups.delete(jid);
      const state = this.getGroup(jid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(jid, task);
      } else if (state.pendingMessages) {
        this.runForGroup(jid, 'drain');
      }
      // If neither pending, skip this group
    }
  }

  getStatus(): {
    activeCount: number;
    activeContainerCount: number;
    activeHostProcessCount: number;
    waitingCount: number;
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
    }>;
  } {
    const groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
    }> = [];

    for (const [jid, state] of this.groups) {
      groups.push({
        jid,
        active: state.active,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
        containerName: state.containerName,
        displayName: state.displayName,
      });
    }

    return {
      activeCount: this.activeCount,
      activeContainerCount: this.activeContainerCount,
      activeHostProcessCount: this.activeHostProcessCount,
      waitingCount: this.waitingGroups.size,
      groups,
    };
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    logger.info(
      {
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
        gracePeriodMs,
      },
      'GroupQueue shutting down, waiting for containers',
    );

    // Wait for activeCount to reach zero or timeout
    const startTime = Date.now();
    while (this.activeCount > 0 && Date.now() - startTime < gracePeriodMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If still active after grace period, force stop all containers
    if (this.activeCount > 0) {
      logger.warn(
        {
          activeCount: this.activeCount,
          activeContainerCount: this.activeContainerCount,
        },
        'Grace period expired, force stopping containers',
      );

      const stopPromises: Promise<void>[] = [];
      for (const [jid, state] of this.groups) {
        if (state.containerName) {
          const containerName = state.containerName;
          const promise = new Promise<void>((resolve) => {
            execFile(
              'docker',
              ['stop', '-t', '5', containerName],
              { timeout: 10000 },
              (err) => {
                if (err) {
                  logger.error(
                    { jid, containerName, err },
                    'Failed to stop container',
                  );
                }
                resolve();
              },
            );
          });
          stopPromises.push(promise);
        } else if (state.process && !state.process.killed) {
          const proc = state.process;
          const promise = new Promise<void>((resolve) => {
            try {
              proc.kill('SIGTERM');
            } catch {
              resolve();
              return;
            }
            setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                try {
                  proc.kill('SIGKILL');
                } catch {
                  // ignore
                }
              }
              resolve();
            }, 3000);
          });
          stopPromises.push(promise);
        }
      }

      await Promise.all(stopPromises);
    }

    logger.info(
      { activeCount: this.activeCount },
      'GroupQueue shutdown complete',
    );
  }
}
