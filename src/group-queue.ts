import { ChildProcess, exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { killProcessTree } from './container-runner.js';
import { getTaskById } from './db.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
export type SendMessageResult = 'sent' | 'no_active';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  /** True when the active runner is executing a scheduled task (not user messages). */
  activeRunnerIsTask: boolean;
  /** Last time this runner produced any observable output. */
  lastActivityAt: number | null;
  /** True while the runner is inside an active query turn. */
  queryInFlight: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  displayName: string | null;
  groupFolder: string | null;
  agentId: string | null;
  /** Isolated task run ID — used for tasks-run/{taskRunId}/ IPC namespace. */
  taskRunId: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restarting: boolean;
  /** Provider profile ID selected for the current active runner (null = default/override). */
  selectedProviderId: string | null;
  /** True when a _drain sentinel has been written for the current active runner. */
  drainSentinelWritten: boolean;
  /** True when messages have been IPC-injected into the running agent via sendMessage().
   *  Used to detect lost messages on abnormal exit: if the agent crashes after IPC
   *  injection, the caller already advanced the cursor so processGroupMessages won't
   *  re-read those messages.  The close handler uses this flag to force pendingMessages
   *  so drainGroup triggers a fresh run. */
  hasIpcInjectedMessages: boolean;
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
  private onRunnerStateChangeFn:
    | ((chatJid: string, state: 'idle' | 'running') => void)
    | null = null;
  private userConcurrentLimitFn:
    | ((groupJid: string) => { allowed: boolean })
    | null = null;
  private onUnconsumedAgentIpcFn:
    | ((groupJid: string, agentId: string) => void)
    | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeRunnerIsTask: false,
        lastActivityAt: null,
        queryInFlight: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        displayName: null,
        groupFolder: null,
        agentId: null,
        taskRunId: null,
        retryCount: 0,
        retryTimer: null,
        restarting: false,
        selectedProviderId: null,
        drainSentinelWritten: false,
        hasIpcInjectedMessages: false,
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

  setOnRunnerStateChange(
    fn: (chatJid: string, state: 'idle' | 'running') => void,
  ): void {
    this.onRunnerStateChangeFn = fn;
  }

  setUserConcurrentLimitChecker(
    fn: (groupJid: string) => { allowed: boolean },
  ): void {
    this.userConcurrentLimitFn = fn;
  }

  /**
   * Called when an agent runner exits with unconsumed IPC message files.
   * The callback should re-enqueue processAgentConversation for the agent.
   * See GitHub issue #240.
   */
  setOnUnconsumedAgentIpc(
    fn: (groupJid: string, agentId: string) => void,
  ): void {
    this.onUnconsumedAgentIpcFn = fn;
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

  private clearRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryCount = 0;
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
    const systemCapacity = isHost
      ? this.activeHostProcessCount <
          getSystemSettings().maxConcurrentHostProcesses
      : this.activeContainerCount < getSystemSettings().maxConcurrentContainers;
    if (!systemCapacity) return false;

    // User-level concurrent container limit (billing)
    if (this.userConcurrentLimitFn) {
      const result = this.userConcurrentLimitFn(groupJid);
      if (!result.allowed) return false;
    }
    return true;
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

  /**
   * Write a single _drain sentinel to the actual active main-agent runner that
   * owns this serialization key. This must target the runner state rather than
   * the caller's group state because sibling JIDs can share one process.
   */
  private requestDrainForActiveRunner(
    groupJid: string,
    reason: string,
  ): boolean {
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return false;

    const runnerState = this.getGroup(activeRunner);
    if (
      !runnerState.active ||
      !runnerState.groupFolder ||
      runnerState.agentId !== null
    ) {
      return false;
    }

    if (runnerState.drainSentinelWritten) {
      return true;
    }

    const wrote = this.writeDrainSentinel(runnerState as ActiveGroupState);
    if (!wrote) return false;
    runnerState.drainSentinelWritten = true;
    logger.info({ groupJid, activeRunner }, reason);
    return true;
  }

  /** 检查指定 JID 是否有自己直接启动的活跃 runner（非通过 folder 共享匹配） */
  hasDirectActiveRunner(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return state?.active === true;
  }

  /** Count active task runners whose JID starts with the given base JID + '#task:' */
  countActiveTaskRunners(baseJid: string): number {
    const prefix = baseJid + '#task:';
    let count = 0;
    for (const [jid, state] of this.groups.entries()) {
      if (state.active && jid.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  /**
   * List all active virtual-JID runners that belong to the same folder family
   * as `baseJid` (i.e. sub-agents `{...}#agent:{id}` and scheduled tasks
   * `{...}#task:{id}`), excluding the base JID itself. Used by workspace-level
   * operations (e.g. clear-history) that need to stop every descendant process
   * before wiping the folder's filesystem.
   *
   * Matching is done via serializationKey (folder-based), so descendants
   * launched from any sibling JID sharing the same folder are all returned.
   */
  listActiveDescendantJids(baseJid: string): string[] {
    const baseKey = this.getSerializationKey(baseJid);
    const prefix = baseKey + '#';
    const result: string[] = [];
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      const key = this.getSerializationKey(jid);
      if (key.startsWith(prefix)) result.push(jid);
    }
    return result;
  }

  /**
   * Returns true if the active runner for this group (or its serialization
   * sibling) is currently executing a scheduled task rather than user messages.
   * Used by the message loop to avoid prematurely interrupting task containers.
   */
  isActiveRunnerTask(groupJid: string): boolean {
    const state = this.resolveActiveState(groupJid);
    return state?.activeRunnerIsTask === true;
  }

  markRunnerActivity(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.lastActivityAt = Date.now();
  }

  /**
   * Mark that a message was IPC-injected into the running agent.
   * The caller (web.ts) has already advanced the per-group cursor for this
   * message.  If the agent crashes without processing it, the close handler
   * uses this flag to force pendingMessages so drainGroup re-reads from DB.
   */
  markIpcInjectedMessage(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.hasIpcInjectedMessages = true;
  }

  markRunnerQueryIdle(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active) return;
    state.queryInFlight = false;
  }

  getStuckPendingGroups(
    idleThresholdMs: number,
  ): Array<{ jid: string; idleMs: number }> {
    const now = Date.now();
    const stuck: Array<{ jid: string; idleMs: number }> = [];
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      if (state.activeRunnerIsTask) continue;
      if (!state.pendingMessages) continue;
      if (state.agentId !== null) continue;
      if (state.restarting) continue;
      const lastActivityAt = state.lastActivityAt ?? 0;
      if (lastActivityAt <= 0) continue;
      const idleMs = now - lastActivityAt;
      if (idleMs < idleThresholdMs) continue;
      stuck.push({ jid, idleMs });
    }
    return stuck;
  }

  /**
   * Get the PID of the active runner process for a group.
   * Returns undefined if no active process or running in container mode.
   */
  getRunnerPid(groupJid: string): number | undefined {
    const state = this.groups.get(groupJid);
    return state?.process?.pid;
  }

  /**
   * Resolve the active docker container name for a group, honoring the same
   * sibling-JID / serialization-key rules as `sendMessage()`. Returns null
   * when there is no active runner *or* the active runner is a host process.
   *
   * Used by the plugin-expander-core to decide whether an inline `!` bash
   * template can run inside the user's container.
   */
  getActiveContainerName(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    return state?.containerName ?? null;
  }

  /**
   * Returns true iff `sendMessage(groupJid, ...)` would return 'sent' right
   * now — i.e. there is an active runner and it is compatible with piping a
   * user message in. Specifically:
   *   - `resolveActiveState(groupJid)` returns non-null (active state, own
   *     or via serialization sibling), AND
   *   - the active runner is NOT a scheduled-task runner unless the caller
   *     IS a `#agent:` conversation virtual JID (those are user-message
   *     handlers started via `enqueueTask`).
   *
   * This predicate exists ONLY to gate web.ts eager plugin-command expansion
   * against the same compatibility rules `sendMessage` uses internally.
   * Returning `true` when `sendMessage` would actually return `no_active`
   * causes a double-fire: eager expand runs inline `!` here, sendMessage
   * rejects, cold-start re-reads the original DB row, expands a SECOND time,
   * and inline `!` runs again under the wrong runner context (#21 round-13
   * P1-1). The name is deliberately specific to discourage accidental reuse
   * for "is a runner up at all?" semantics — that's `resolveActiveState() !==
   * null`, which doesn't match `sendMessage`'s acceptance set.
   */
  hasActiveMainRunnerForMessage(groupJid: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;
    // Task-runner exclusion mirrors sendMessage(). Conversation agents
    // (`#agent:` virtual JIDs) DO accept IPC messages — exempt them.
    if (state.activeRunnerIsTask && !groupJid.includes('#agent:')) {
      return false;
    }
    return true;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      // Write _drain to the actual active runner so sibling JIDs sharing one
      // folder also unblock immediately instead of waiting for idle timeout.
      this.requestDrainForActiveRunner(
        groupJid,
        'Drain sentinel written during enqueueMessageCheck to unblock pending messages',
      );
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
    opts: {
      containerName: string | null;
      groupFolder?: string;
      displayName?: string;
      agentId?: string;
      taskRunId?: string;
      selectedProviderId?: string | null;
    },
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = opts.containerName;
    state.displayName = opts.displayName || null;
    if (opts.groupFolder) state.groupFolder = opts.groupFolder;
    state.agentId = opts.agentId || null;
    state.taskRunId = opts.taskRunId || null;
    state.selectedProviderId = opts.selectedProviderId ?? null;
  }

  /**
   * Resolve IPC input directory for a group state.
   * Sub-agents use a nested path: data/ipc/{folder}/agents/{agentId}/input/
   */
  private resolveIpcInputDir(state: ActiveGroupState): string {
    if (state.taskRunId) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        'tasks-run',
        state.taskRunId,
        'input',
      );
    }
    if (state.agentId) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        'agents',
        state.agentId,
        'input',
      );
    }
    return path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   *
   * Returns:
   * - 'sent': message written to IPC (包括 queryInFlight 时的排队写入)
   * - 'no_active': no active container/process for this group
   */
  sendMessage(
    groupJid: string,
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    onInjected?: () => void,
    sourceJid?: string,
  ): SendMessageResult {
    const state = this.resolveActiveState(groupJid);
    if (!state) return 'no_active';

    // If the active runner is a scheduled task (not a user-message handler),
    // do NOT pipe user messages into it.  The task container has no knowledge
    // of the user conversation context, so any IPC message injected here would
    // be silently consumed (or confusingly processed) by the task agent and the
    // reply would never reach the user.  Returning 'no_active' causes the
    // caller to enqueue a fresh message-processing run that will execute once
    // the task finishes.  See GitHub issue riba2534/happyclaw#151.
    //
    // Exception: conversation agent tasks (virtual JIDs with #agent:) are
    // user-message handlers started via enqueueTask.  They DO accept IPC
    // messages — blocking them causes a deadlock where the agent waits for
    // IPC input that never arrives.
    if (state.activeRunnerIsTask && !groupJid.includes('#agent:')) {
      logger.debug(
        { groupJid },
        'Active runner is a scheduled task; deferring user message until task completes',
      );
      return 'no_active';
    }

    // queryInFlight=true：当前 query 正在执行，将消息写入 IPC 文件排队。
    // 当前 query 完成后 waitForIpcMessage() → drainIpcInput() 会合并所有
    // 待处理的 IPC 消息为一个 prompt，实现自然聚合（如飞书转发+评论场景）。
    // 不再写 _drain：容器无需退出重启，复用当前进程即可。

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', text, images, sourceJid }),
      );
      fs.renameSync(tempPath, filepath);
      state.queryInFlight = true;
      onInjected?.();
      return 'sent';
    } catch {
      return 'no_active';
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state) return;

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Remove leftover _drain and _close sentinel files from the IPC input
   * directory.  Called in finally blocks after a runner exits so that a
   * subsequent runner for the same folder does not immediately see stale
   * sentinels and exit prematurely.
   */
  private cleanupIpcSentinels(
    groupFolder: string,
    agentId?: string | null,
    taskRunId?: string | null,
  ): void {
    const inputDir = taskRunId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'tasks-run', taskRunId, 'input')
      : agentId
        ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
        : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    for (const name of ['_drain', '_close']) {
      try {
        fs.unlinkSync(path.join(inputDir, name));
      } catch {
        // file may not exist – that's fine
      }
    }
  }

  /**
   * Check if there are unconsumed IPC message files (.json) in the input directory.
   * Called after process exit to detect messages written via sendMessage() that were
   * never consumed due to a race condition (process exiting before reading IPC).
   * See GitHub issue #240.
   */
  /**
   * Check for unconsumed IPC messages after agent/task exit and recover.
   * Handles the race where sendMessage() wrote a file but the process
   * exited before reading it (issue #240).
   */
  private recoverUnconsumedIpc(
    groupJid: string,
    state: GroupState,
    context: string,
  ): void {
    if (!state.groupFolder) return;
    try {
      if (!this.hasRemainingIpcMessages(state.groupFolder, state.agentId, state.taskRunId)) return;

      if (state.agentId && this.onUnconsumedAgentIpcFn) {
        logger.warn(
          { groupJid, agentId: state.agentId },
          `Unconsumed IPC messages found after ${context}, re-enqueuing`,
        );
        this.onUnconsumedAgentIpcFn(groupJid, state.agentId);
      } else if (!state.taskRunId) {
        state.pendingMessages = true;
        logger.warn(
          { groupJid },
          `Unconsumed IPC messages found after ${context}, marking pending`,
        );
      }
    } catch (err) {
      logger.warn({ groupJid, err }, 'Failed to check remaining IPC messages');
    }
  }

  private hasRemainingIpcMessages(
    groupFolder: string,
    agentId?: string | null,
    taskRunId?: string | null,
  ): boolean {
    const inputDir = taskRunId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'tasks-run', taskRunId, 'input')
      : agentId
        ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
        : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      const files = fs.readdirSync(inputDir);
      return files.some(f => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to finish the current query and then exit.
   * Unlike _close which exits immediately from waitForIpcMessage, _drain
   * is only checked after the current query completes, ensuring one-question-
   * one-answer semantics.
   */
  private writeDrainSentinel(state: ActiveGroupState): boolean {
    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_drain'), '');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal a specific group's active container to gracefully exit.
   * Used by provider switch: after the container exits, processGroupMessages
   * will automatically restart it (picking up the new provider via override).
   * Uses _drain (not _close) so the current query finishes before exit.
   */
  requestGracefulRestart(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.active || !state.groupFolder) return false;
    const written = this.writeDrainSentinel(state as ActiveGroupState);
    if (written) {
      // Ensure close handler triggers a new run even if no messages are pending
      state.pendingMessages = true;
      logger.info(
        { groupJid, groupFolder: state.groupFolder },
        'Sent drain signal for provider switch',
      );
    }
    return written;
  }

  /**
   * Close all active containers/processes so they restart with fresh credentials.
   * Called after OAuth token refresh to ensure running agents pick up new tokens.
   */
  closeAllActiveForCredentialRefresh(): number {
    let closed = 0;
    for (const [jid, state] of this.groups) {
      if (state.active && state.groupFolder) {
        const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(path.join(inputDir, '_close'), '');
          closed++;
          logger.info(
            { groupJid: jid, groupFolder: state.groupFolder },
            'Sent close signal for credential refresh',
          );
        } catch {
          // ignore
        }
      }
    }
    if (closed > 0) {
      logger.info(
        { closed },
        'Closed active containers/processes for credential refresh',
      );
    }
    return closed;
  }

  /**
   * Interrupt the current query for the same chat only (do not cross-interrupt
   * sibling chats that share a serialized runner/folder).
   *
   * Writes a _interrupt sentinel that agent-runner detects and calls
   * query.interrupt(). The container stays alive and accepts new messages.
   */
  interruptQuery(groupJid: string): boolean {
    // Use resolveActiveState so sibling JIDs (feishu/telegram sharing the
    // same folder as a web group) are correctly resolved to the active runner.
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    this.clearRetryTimer(state);

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      try {
        fs.chmodSync(inputDir, 0o777);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(path.join(inputDir, '_interrupt'), '');
      logger.info({ groupJid, inputDir }, 'Interrupt sentinel written');
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, inputDir, err },
        'Failed to write interrupt sentinel',
      );
      return false;
    }
  }


  /**
   * Force-stop a group's active container and clear queued work.
   * Returns a promise that resolves when the container has fully exited
   * (state.active becomes false), not just when docker stop completes.
   */
  async stopGroup(
    groupJid: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const force = options?.force ?? false;
    const requestedState = this.getGroup(groupJid);
    requestedState.pendingMessages = false;
    requestedState.pendingTasks = [];
    this.clearRetryTimer(requestedState);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    if (targetJid !== groupJid) {
      state.pendingMessages = false;
      state.pendingTasks = [];
      this.clearRetryTimer(state);
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
          execFile('docker', ['kill', name], { timeout: 5000 }, () =>
            resolve(),
          );
        });
      } else if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGKILL');
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
          execFile('docker', ['stop', name], { timeout: 10000 }, () =>
            resolve(),
          );
        });
      } else if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
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
        killProcessTree(state.process, 'SIGKILL');
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
      logger.warn(
        { groupJid: targetJid },
        'Restart already in progress, skipping',
      );
      return;
    }
    state.restarting = true;

    try {
      if (state.groupFolder) {
        this.closeStdin(targetJid);
      }

      // Give agent-runner time to detect _close sentinel and exit gracefully
      // before sending SIGTERM.  The IPC poll interval is 500ms, so 2s is
      // generous enough for the agent to finish its current operation and
      // emit the final session ID.
      if (state.groupFolder && !state.containerName) {
        const graceStart = Date.now();
        while (state.active && Date.now() - graceStart < 2000) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Stop docker container / host process
      if (state.containerName) {
        const name = state.containerName;
        await new Promise<void>((resolve) => {
          execFile('docker', ['stop', name], { timeout: 15000 }, () =>
            resolve(),
          );
        });
      } else if (state.active && state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
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
          killProcessTree(state.process, 'SIGKILL');
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
    state.activeRunnerIsTask = false;
    state.lastActivityAt = Date.now();
    state.queryInFlight = true;
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
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
          // Defensive: clear any lingering retry timer from a previous failed
          // run that was superseded by a successful drain-triggered run.
          this.clearRetryTimer(state);
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(state.groupFolder, state.agentId, state.taskRunId);
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        this.recoverUnconsumedIpc(groupJid, state, 'agent exit');
      }
      // If messages were IPC-injected during this run, always mark pending
      // so drainGroup triggers a fresh processGroupMessages.  If the agent
      // already replied to them, processGroupMessages will find 0 new messages
      // (cursor was committed) and return immediately — harmless.  If the
      // agent crashed, this ensures the messages are re-read from DB.
      if (state.hasIpcInjectedMessages) {
        state.pendingMessages = true;
        logger.debug(
          { groupJid },
          'IPC-injected messages detected, marking pending for safety re-check',
        );
      }
      state.active = false;
      state.drainSentinelWritten = false;
      state.hasIpcInjectedMessages = false;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      state.agentId = null;
      state.taskRunId = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onRunnerStateChangeFn?.(groupJid, 'idle');
      } catch (err) {
        logger.error({ groupJid, err }, 'onRunnerStateChange(idle) failed');
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
    state.activeRunnerIsTask = true;
    state.lastActivityAt = Date.now();
    state.queryInFlight = false;
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
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(state.groupFolder, state.agentId, state.taskRunId);
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        this.recoverUnconsumedIpc(groupJid, state, 'task exit');
      }
      state.active = false;
      state.activeRunnerIsTask = false;
      state.drainSentinelWritten = false;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.process = null;
      state.containerName = null;
      state.displayName = null;
      state.groupFolder = null;
      state.agentId = null;
      state.taskRunId = null;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      try {
        this.onRunnerStateChangeFn?.(groupJid, 'idle');
      } catch (err) {
        logger.error({ groupJid, err }, 'onRunnerStateChange(idle) failed');
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
    // 清除可能存在的旧定时器（不重置 retryCount，因为这里在递增）
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

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
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
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
    while (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      // Check if scheduled task is still active before occupying a slot.
      // Only skip tasks that exist in the DB and are no longer active.
      // Dynamic tasks (agent conversations, etc.) don't have DB entries
      // and must always be allowed to run.
      const dbTask = getTaskById(task.id);
      if (dbTask && dbTask.status !== 'active') {
        logger.info(
          { groupJid, taskId: task.id },
          'Skipping cancelled/deleted task during drain',
        );
        continue;
      }
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages — but NOT if a retry timer is already scheduled.
    // When processMessagesFn() fails, both scheduleRetry() and drainGroup() fire.
    // Without this guard, drainGroup would start a new container while the retry
    // timer later starts another, causing duplicate processing of the same messages.
    if (state.pendingMessages && !state.retryTimer) {
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
        // Skip cancelled/deleted scheduled tasks (but allow dynamic tasks
        // like agent conversations that have no DB entry).
        let validTask: QueuedTask | undefined;
        while (state.pendingTasks.length > 0) {
          const candidate = state.pendingTasks.shift()!;
          const dbTask = getTaskById(candidate.id);
          if (dbTask && dbTask.status !== 'active') {
            logger.info(
              { groupJid: jid, taskId: candidate.id },
              'Skipping cancelled/deleted task during drainWaiting',
            );
            continue;
          }
          validTask = candidate;
          break;
        }
        if (validTask) {
          this.runTask(jid, validTask);
        } else if (state.pendingMessages && !state.retryTimer) {
          // All tasks were stale, fall through to messages
          // (skip if retry timer is pending to avoid duplicate processing)
          this.runForGroup(jid, 'drain');
        }
      } else if (state.pendingMessages && !state.retryTimer) {
        // Skip if retry timer is pending to avoid duplicate processing
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
    waitingGroupJids: string[];
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
      groupFolder: string | null;
      selectedProviderId: string | null;
    }>;
  } {
    const groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      containerName: string | null;
      displayName: string | null;
      groupFolder: string | null;
      selectedProviderId: string | null;
    }> = [];

    for (const [jid, state] of this.groups) {
      groups.push({
        jid,
        active: state.active,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
        containerName: state.containerName,
        displayName: state.displayName,
        groupFolder: state.groupFolder,
        selectedProviderId: state.selectedProviderId,
      });
    }

    return {
      activeCount: this.activeCount,
      activeContainerCount: this.activeContainerCount,
      activeHostProcessCount: this.activeHostProcessCount,
      waitingCount: this.waitingGroups.size,
      waitingGroupJids: Array.from(this.waitingGroups),
      groups,
    };
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // 清除所有待执行的重试定时器，防止关闭期间容器重启
    for (const state of this.groups.values()) {
      this.clearRetryTimer(state);
    }

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
            if (!killProcessTree(proc, 'SIGTERM')) {
              resolve();
              return;
            }
            setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                killProcessTree(proc, 'SIGKILL');
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
