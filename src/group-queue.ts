import { ChildProcess, exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from './config.js';
import { killProcessTree } from './container-runner.js';
import { getTaskById } from './db.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import { resolveFeishuCliBoundAccountId } from './feishu-cli-runtime.js';
import type { ChannelTurnContext } from './types.js';
export type SendMessageResult = 'sent' | 'no_active';
export interface IpcMessageCursor {
  timestamp: string;
  id: string;
  /** Immutable provider route that owns this exact original input's side
   * effects. Omitted for Web/legacy inputs. */
  sourceJid?: string;
}
export interface IpcDeliveryReceipt {
  deliveryId: string;
  chatJid: string;
  /** Exact DB cursors handled by this IPC turn. Older runners may omit this,
   * in which case the host treats the terminal cursor as the sole member. */
  coveredCursors?: IpcMessageCursor[];
  cursor: IpcMessageCursor;
}
export interface IpcDeliveryTarget {
  chatJid: string;
  coveredCursors: IpcMessageCursor[];
  cursor: IpcMessageCursor;
}
/** Immutable DB-message batch owned by one concrete message-lane attempt. */
export interface MessageRetrySnapshot {
  coveredCursors: IpcMessageCursor[];
  cursor: IpcMessageCursor;
}
export interface IpcPrePublishAdmission {
  /** Undo host-side Turn/Card/Outbox reservations if disk publish fails. */
  rollback?: () => void;
}
export interface RunnerMessageRequirements {
  /**
   * Bot identity whose App credentials must already be present in a Docker
   * runner. An explicit null means the request must run without an injected
   * Bot; omission means this internal caller is not imposing an identity
   * constraint. Ignored for host-mode processes.
   */
  feishuCliAccountId?: string | null;
}

interface FeishuCliIdentityRequirement {
  specified: boolean;
  accountId: string | null;
}

function resolveFeishuCliIdentityRequirement(
  requirements?: RunnerMessageRequirements,
  channelContext?: ChannelTurnContext,
): FeishuCliIdentityRequirement {
  if (
    requirements !== undefined &&
    Object.prototype.hasOwnProperty.call(requirements, 'feishuCliAccountId')
  ) {
    return {
      specified: true,
      accountId: requirements.feishuCliAccountId ?? null,
    };
  }
  if (channelContext !== undefined) {
    return {
      specified: true,
      accountId: resolveFeishuCliBoundAccountId({ channelContext }),
    };
  }
  return { specified: false, accountId: null };
}

export interface MutationPauseToken {
  readonly id: number;
}

function compareIpcMessageCursors(
  a: IpcMessageCursor,
  b: IpcMessageCursor,
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

interface QueuedTask {
  id: string;
  groupJid: string;
  /** Returning false asks GroupQueue to replay this exact task with the same
   * bounded backoff used by message runs. Void/true remain one-shot success. */
  fn: () => Promise<void | boolean>;
  /** Manual runs may execute even when the task config is paused. */
  allowInactive?: boolean;
  /** Release caller-owned reservations when queued work is discarded. */
  onDropped?: () => void;
}

export type QueryFinishReason =
  | 'completed'
  | 'released'
  | 'runner_exit'
  | 'stopped';

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const RUNNER_TEARDOWN_TIMEOUT_MS = 15_000;

interface GroupState {
  /** Serialization-family key captured while a mutation token is live. It
   * remains stable even if the external group/cache resolver is deleted. */
  mutationKey: string | null;
  /** Set synchronously by stopGroup and cleared only when a later run starts.
   * Prevents the killed run from scheduling a retry during its close handler. */
  stopRequested: boolean;
  /** stopGroup waits on the runForGroup/runTask finally handshake instead of
   * guessing from docker-kill completion or polling child-process state. */
  teardownWaiters: Set<() => void>;
  active: boolean;
  /** True when the active runner is executing a scheduled task (not user messages). */
  activeRunnerIsTask: boolean;
  /** Exact task currently owning this state. Mutation stops park this task so
   * resume cannot accidentally route a conversation-agent turn through the
   * ordinary processGroupMessages lane. */
  activeTask: QueuedTask | null;
  /** Last time this runner produced any observable output. */
  lastActivityAt: number | null;
  /** True while the runner is inside an active query turn. */
  queryInFlight: boolean;
  /** Host-generated identity for the current logical query. It changes at
   * every idle→running transition, including warm-runner follow-ups. */
  queryId: string | null;
  /** Wall-clock time for the current logical query. Used by Web reconnect
   * snapshots so the UI can restore a run before the first stream event. */
  queryStartedAt: number | null;
  /** Prevent duplicate query-start broadcasts when several delivery paths
   * observe the same reserved query. */
  announcedQueryId: string | null;
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
  /** Exact task captured by a retry timer; null means a message-lane retry. */
  retryTask: QueuedTask | null;
  /** Exact message batch captured by the current message-lane attempt. */
  messageRetrySnapshot: MessageRetrySnapshot | null;
  restarting: boolean;
  /** Provider profile ID selected for the current active runner (null = default/override). */
  selectedProviderId: string | null;
  /** Exact Feishu Bot whose credentials were injected at container startup.
   * Host processes always keep this null because their native feishu-cli
   * environment/config is authoritative. */
  feishuCliAccountId: string | null;
  /** True when a _drain sentinel has been written for the current active runner. */
  drainSentinelWritten: boolean;
  /** True when messages have been IPC-injected into the running agent via sendMessage().
   *  Used to detect lost messages on abnormal exit: if the agent crashes after IPC
   *  injection, the caller already advanced the cursor so processGroupMessages won't
   *  re-read those messages.  The close handler uses this flag to force pendingMessages
   *  so drainGroup triggers a fresh run. */
  hasIpcInjectedMessages: boolean;
  /** IPC deliveries written to this runner but not yet acknowledged by a
   * healthy agent query result. Keyed by deliveryId for out-of-order acks. */
  pendingIpcDeliveries: Map<string, IpcDeliveryReceipt>;
  /** Receipts observed from stdout but blocked behind an earlier unacknowledged
   * delivery for the same chat. They remain replayable until the contiguous
   * prefix is durably committed. */
  acknowledgedIpcDeliveryIds: Set<string>;
}

type ActiveGroupState = GroupState & { groupFolder: string };

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeContainerCount = 0;
  private activeHostProcessCount = 0;
  private waitingGroups = new Set<string>();
  private mutationPauseCounts = new Map<string, number>();
  /** Persistent fail-closed gates used when a security-sensitive mutation was
   * committed but the old runtime could not be confirmed stopped. Each
   * mutation source independently owns its gate so one subsystem cannot
   * release another subsystem's fail-closed state. */
  private runtimeSafetyBlocks = new Map<string, Map<string, string>>();
  private mutationPauseTokens = new Map<number, string[]>();
  private terminalDiscardMutationKeys = new Set<string>();
  private mutationBaseKeyAliases = new Map<string, string>();
  private nextMutationPauseTokenId = 1;
  private mutationPreserveStopJids = new Set<string>();
  private mutationStoppedFolders = new Set<string>();
  private contextOverflowGroups = new Set<string>(); // 跟踪发生上下文溢出的 group
  // 记录最近一次 stopGroup 的时间戳（毫秒）。runForGroup finally 块会用它来
  // 决定是否跳过自动 drainGroup —— stopGroup 中清空 pendingMessages 之后，
  // hasIpcInjectedMessages 重新置 pendingMessages=true，会让用户的 'stop' 之后
  // 容器立即又被拉起来。同时让主消息循环在 OOM 计数前看一眼这个标志，避免
  // 把 user-stopped (SIGKILL → 137) 误判为真实 OOM 触发会话重置。
  private recentlyStoppedFolders = new Map<string, number>();
  private static RECENTLY_STOPPED_WINDOW_MS = 30_000;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private hostModeChecker: ((groupJid: string) => boolean) | null = null;
  private serializationKeyResolver: ((groupJid: string) => string) | null =
    null;
  private onMaxRetriesExceededFn:
    | ((
        groupJid: string,
        snapshot: MessageRetrySnapshot | null,
      ) => void | Promise<void>)
    | null = null;
  private onContainerExitFn: ((groupJid: string) => void) | null = null;
  private onRunnerStateChangeFn:
    | ((chatJid: string, state: 'idle' | 'running') => void)
    | null = null;
  private onQueryStartFn:
    | ((chatJid: string, queryId: string, startedAt: number) => void)
    | null = null;
  private onQueryIdleFn:
    | ((chatJid: string, completedQueryId: string) => void)
    | null = null;
  private onQueryFinishFn:
    | ((
        chatJid: string,
        completedQueryId: string,
        reason: QueryFinishReason,
        finishedAt: number,
      ) => void)
    | null = null;
  private userConcurrentLimitFn:
    | ((groupJid: string) => { allowed: boolean })
    | null = null;
  private onUnconsumedAgentIpcFn:
    | ((groupJid: string, agentId: string) => void)
    | null = null;
  private onUnacknowledgedIpcDeliveriesFn:
    | ((groupJid: string, receipts: IpcDeliveryReceipt[]) => void)
    | null = null;
  private onAbandonedIpcDeliveriesFn:
    | ((groupJid: string, receipts: IpcDeliveryReceipt[]) => void)
    | null = null;
  private isIpcDeliveryCommitEligibleFn:
    | ((receipt: IpcDeliveryReceipt) => boolean)
    | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        mutationKey: null,
        stopRequested: false,
        teardownWaiters: new Set(),
        active: false,
        activeRunnerIsTask: false,
        activeTask: null,
        lastActivityAt: null,
        queryInFlight: false,
        queryId: null,
        queryStartedAt: null,
        announcedQueryId: null,
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
        retryTask: null,
        messageRetrySnapshot: null,
        restarting: false,
        selectedProviderId: null,
        feishuCliAccountId: null,
        drainSentinelWritten: false,
        hasIpcInjectedMessages: false,
        pendingIpcDeliveries: new Map(),
        acknowledgedIpcDeliveryIds: new Set(),
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private getMutationBaseJid(groupJid: string): string {
    const taskSep = groupJid.indexOf('#task:');
    const agentSep = groupJid.indexOf('#agent:');
    const separators = [taskSep, agentSep].filter((index) => index >= 0);
    return separators.length > 0
      ? groupJid.slice(0, Math.min(...separators))
      : groupJid;
  }

  private getMutationPauseKey(groupJid: string): string {
    const stamped = this.groups.get(groupJid)?.mutationKey;
    if (stamped) return stamped;
    const baseJid = this.getMutationBaseJid(groupJid);
    return (
      this.mutationBaseKeyAliases.get(baseJid) ??
      this.getSerializationKey(baseJid)
    );
  }

  private clearMutationAliasesForKeys(keys: Set<string>): void {
    for (const [baseJid, key] of this.mutationBaseKeyAliases) {
      if (keys.has(key)) this.mutationBaseKeyAliases.delete(baseJid);
    }
  }

  private isMutationPaused(groupJid: string): boolean {
    const key = this.getMutationPauseKey(groupJid);
    const paused =
      (this.mutationPauseCounts.get(key) ?? 0) > 0 ||
      this.runtimeSafetyBlocks.has(key);
    if (paused) {
      const state = this.groups.get(groupJid);
      if (state) state.mutationKey = key;
    }
    return paused;
  }

  /**
   * Report whether a workspace serialization family is behind a mutation gate.
   * Detached schedulers must consult this before starting work because script
   * executions do not pass through enqueueTask().
   */
  isGroupMutationPaused(groupJid: string): boolean {
    return this.isMutationPaused(groupJid);
  }

  blockGroupsForRuntimeSafety(
    groupJids: string[],
    reason: string,
    source = 'default',
  ): void {
    for (const jid of groupJids) {
      const key = this.getMutationPauseKey(jid);
      this.getGroup(jid).mutationKey = key;
      this.mutationBaseKeyAliases.set(this.getMutationBaseJid(jid), key);
      let sourceBlocks = this.runtimeSafetyBlocks.get(key);
      if (!sourceBlocks) {
        sourceBlocks = new Map<string, string>();
        this.runtimeSafetyBlocks.set(key, sourceBlocks);
      }
      // Re-blocking the same source is idempotent (for example repeated deps
      // injection during startup); only the latest diagnostic reason changes.
      sourceBlocks.set(source, reason);
    }
  }

  unblockGroupsForRuntimeSafety(groupJids: string[], source = 'default'): void {
    const released = new Set<string>();
    for (const jid of groupJids) {
      const key = this.getMutationPauseKey(jid);
      const sourceBlocks = this.runtimeSafetyBlocks.get(key);
      if (!sourceBlocks?.delete(source)) continue;
      if (sourceBlocks.size === 0) {
        this.runtimeSafetyBlocks.delete(key);
        released.add(key);
      }
    }
    if (released.size === 0) return;
    for (const [jid, state] of this.groups) {
      if (!released.has(this.getMutationPauseKey(jid))) continue;
      if (state.pendingMessages || state.pendingTasks.length > 0) {
        this.waitingGroups.add(jid);
      }
      state.mutationKey = null;
    }
    this.clearMutationAliasesForKeys(released);
    this.drainWaiting();
  }

  isGroupRuntimeSafetyBlocked(groupJid: string): boolean {
    return this.runtimeSafetyBlocks.has(this.getMutationPauseKey(groupJid));
  }

  private isTerminalMutationDiscarded(groupJid: string): boolean {
    return this.terminalDiscardMutationKeys.has(
      this.getMutationPauseKey(groupJid),
    );
  }

  private waitForRunnerTeardown(
    state: GroupState,
    timeoutMs = RUNNER_TEARDOWN_TIMEOUT_MS,
  ): Promise<boolean> {
    if (!state.active) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.teardownWaiters.delete(onTeardown);
        resolve(completed);
      };
      const onTeardown = () => finish(true);
      const timer = setTimeout(() => finish(!state.active), timeoutMs);
      state.teardownWaiters.add(onTeardown);
      // The runner may have completed between the initial check and waiter
      // registration through a synchronous test/mocked callback.
      if (!state.active) onTeardown();
    });
  }

  private resolveRunnerTeardownWaiters(state: GroupState): void {
    if (state.active || state.teardownWaiters.size === 0) return;
    const waiters = [...state.teardownWaiters];
    state.teardownWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /**
   * Atomically pause every workspace serialization family before a mutation's
   * first await. New sibling/descendant work remains queued until the returned
   * token is released.
   */
  pauseGroupsForMutation(groupJids: string[]): MutationPauseToken {
    const keys = Array.from(
      new Set(
        groupJids.map((jid) => {
          const key = this.getMutationPauseKey(jid);
          this.getGroup(jid).mutationKey = key;
          this.mutationBaseKeyAliases.set(this.getMutationBaseJid(jid), key);
          return key;
        }),
      ),
    );
    for (const key of keys) {
      this.mutationPauseCounts.set(
        key,
        (this.mutationPauseCounts.get(key) ?? 0) + 1,
      );
    }
    const token = { id: this.nextMutationPauseTokenId++ };
    this.mutationPauseTokens.set(token.id, keys);
    return token;
  }

  /** Release one mutation pause and drain work whose final pause was removed. */
  resumeGroupsAfterMutation(token: MutationPauseToken): void {
    const keys = this.mutationPauseTokens.get(token.id);
    if (!keys) return;
    this.mutationPauseTokens.delete(token.id);

    const releasedKeys = new Set<string>();
    for (const key of keys) {
      const nextCount = (this.mutationPauseCounts.get(key) ?? 1) - 1;
      if (nextCount <= 0) {
        this.mutationPauseCounts.delete(key);
        releasedKeys.add(key);
      } else {
        this.mutationPauseCounts.set(key, nextCount);
      }
    }
    if (releasedKeys.size === 0) return;

    const terminalReleasedKeys = new Set<string>();
    for (const key of releasedKeys) {
      if (this.terminalDiscardMutationKeys.has(key)) {
        terminalReleasedKeys.add(key);
      }
    }
    this.clearMutationAliasesForKeys(
      new Set(
        [...releasedKeys].filter((key) => !terminalReleasedKeys.has(key)),
      ),
    );

    // Mutation stop markers are only needed while the gate is held (OOM/user-
    // stop classification during forced quiesce). Clear them before draining
    // the replacement runner; otherwise its normal exit within 30s would be
    // mistaken for the old mutation stop and skip IPC recovery/auto-drain.
    for (const key of releasedKeys) {
      if (!this.mutationStoppedFolders.delete(key)) continue;
      this.recentlyStoppedFolders.delete(key);
    }

    for (const [jid, state] of this.groups) {
      if (!releasedKeys.has(this.getMutationPauseKey(jid))) continue;
      if (terminalReleasedKeys.has(this.getMutationPauseKey(jid))) {
        state.pendingMessages = false;
        this.discardPendingTasks(state, jid);
        this.clearRetryTimer(state);
        this.waitingGroups.delete(jid);
        continue;
      }
      if (state.pendingMessages || state.pendingTasks.length > 0) {
        this.waitingGroups.add(jid);
      }
      state.mutationKey = null;
    }
    if (releasedKeys.size > terminalReleasedKeys.size) this.drainWaiting();
  }

  /** Consume a mutation token after a terminal delete and permanently discard
   * work parked under that token's serialization families. Other overlapping
   * pause tokens retain their refcounts, but the process-lifetime tombstone
   * rejects stale work both before and after their final release. */
  discardGroupsAfterMutation(token: MutationPauseToken): void {
    const keys = this.mutationPauseTokens.get(token.id);
    if (!keys) return;
    this.mutationPauseTokens.delete(token.id);
    const keySet = new Set(keys);
    for (const key of keys) this.terminalDiscardMutationKeys.add(key);
    const releasedKeys = new Set<string>();
    for (const key of keys) {
      const nextCount = (this.mutationPauseCounts.get(key) ?? 1) - 1;
      if (nextCount <= 0) {
        this.mutationPauseCounts.delete(key);
        releasedKeys.add(key);
      } else {
        this.mutationPauseCounts.set(key, nextCount);
      }
    }

    for (const [jid, state] of this.groups) {
      if (!keySet.has(this.getMutationPauseKey(jid))) continue;
      if (state.active) {
        logger.warn(
          { jid },
          'discardGroupsAfterMutation found an active runner; caller should stop the family first',
        );
      }
      state.pendingMessages = false;
      this.discardPendingTasks(state, jid);
      this.clearRetryTimer(state);
      this.waitingGroups.delete(jid);
      this.mutationPreserveStopJids.delete(jid);
    }

    for (const key of releasedKeys) {
      if (this.mutationStoppedFolders.delete(key)) {
        this.recentlyStoppedFolders.delete(key);
      }
    }
    // Terminal tombstones and base aliases intentionally survive final token
    // release for this process lifetime. Late scheduler callbacks that passed
    // old DB checks must still be rejected after the workspace row is gone.
  }

  private discardPendingTasks(state: GroupState, groupJid: string): void {
    const pendingTasks = state.pendingTasks;
    state.pendingTasks = [];
    for (const task of pendingTasks) {
      try {
        task.onDropped?.();
      } catch (err) {
        logger.warn(
          { groupJid, taskId: task.id, err },
          'Queued task drop callback failed',
        );
      }
    }
  }

  /** 当前重试轮次（0 = 首次尝试）。供 processMessages 侧识别静默重试轮。 */
  getRetryCount(groupJid: string): number {
    return this.groups.get(groupJid)?.retryCount ?? 0;
  }

  /** 本轮失败后队列是否还会再次重试（决定错误提示发本轮还是等最终失败）。 */
  willRetryAfterFailure(groupJid: string): boolean {
    if (this.contextOverflowGroups.has(groupJid)) return false;
    return (this.groups.get(groupJid)?.retryCount ?? 0) < MAX_RETRIES;
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

  setOnMaxRetriesExceeded(
    fn: (
      groupJid: string,
      snapshot: MessageRetrySnapshot | null,
    ) => void | Promise<void>,
  ): void {
    this.onMaxRetriesExceededFn = fn;
  }

  /**
   * Fence retry exhaustion to the immutable DB batch read by the current
   * message-lane attempt. Messages arriving after this snapshot must remain
   * pending work and cannot be attributed to the failed attempt.
   */
  setMessageRetrySnapshot(
    groupJid: string,
    snapshot: MessageRetrySnapshot,
  ): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.active || state.activeRunnerIsTask) return false;
    const coveredCursors = [...snapshot.coveredCursors]
      .map((cursor) => ({ ...cursor }))
      .sort(compareIpcMessageCursors);
    if (coveredCursors.length === 0) return false;
    state.messageRetrySnapshot = {
      coveredCursors,
      cursor: { ...coveredCursors[coveredCursors.length - 1] },
    };
    return true;
  }

  setOnContainerExit(fn: (groupJid: string) => void): void {
    this.onContainerExitFn = fn;
  }

  setOnRunnerStateChange(
    fn: (chatJid: string, state: 'idle' | 'running') => void,
  ): void {
    this.onRunnerStateChangeFn = fn;
  }

  setOnQueryStart(
    fn: (chatJid: string, queryId: string, startedAt: number) => void,
  ): void {
    this.onQueryStartFn = fn;
  }

  private announceQueryStart(groupJid: string, state: GroupState): boolean {
    if (!state.queryInFlight || !state.queryId) return false;
    if (state.announcedQueryId === state.queryId) return false;
    const startedAt = state.queryStartedAt ?? Date.now();
    state.queryStartedAt = startedAt;
    state.announcedQueryId = state.queryId;
    try {
      this.onQueryStartFn?.(groupJid, state.queryId, startedAt);
    } catch (err) {
      logger.error({ groupJid, err }, 'onQueryStart callback failed');
    }
    return true;
  }

  /** Announce a previously reserved query once its durable follow-up has been
   * claimed. Keeping this separate from reserveNextQuery avoids a false
   * running flash when the durable queue turns out to be empty. */
  announceReservedQuery(groupJid: string, expectedQueryId: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (
      !state?.active ||
      !state.queryInFlight ||
      state.queryId !== expectedQueryId
    ) {
      return false;
    }
    return this.announceQueryStart(groupJid, state);
  }

  setOnQueryIdle(
    fn: (chatJid: string, completedQueryId: string) => void,
  ): void {
    this.onQueryIdleFn = fn;
  }

  /**
   * Observe the exact logical query terminal boundary.
   *
   * This is intentionally separate from setOnQueryIdle: the latter dispatches
   * durable queued follow-ups and must retain its single owner in index.ts.
   * Web lifecycle projection consumes this callback without changing queue
   * release/steer behaviour.
   */
  setOnQueryFinish(
    fn: (
      chatJid: string,
      completedQueryId: string,
      reason: QueryFinishReason,
      finishedAt: number,
    ) => void,
  ): void {
    this.onQueryFinishFn = fn;
  }

  private announceQueryFinish(
    groupJid: string,
    queryId: string,
    reason: QueryFinishReason,
  ): void {
    try {
      this.onQueryFinishFn?.(groupJid, queryId, reason, Date.now());
    } catch (err) {
      logger.error(
        { groupJid, queryId, reason, err },
        'onQueryFinish callback failed',
      );
    }
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

  setOnUnacknowledgedIpcDeliveries(
    fn: (groupJid: string, receipts: IpcDeliveryReceipt[]) => void,
  ): void {
    this.onUnacknowledgedIpcDeliveriesFn = fn;
  }

  /** Explicit user cancellation/deletion abandons accepted deliveries instead
   * of replaying them on runner exit. The host advances/tombstones their DB
   * cursors in this callback. Mutation restarts never use this path. */
  setOnAbandonedIpcDeliveries(
    fn: (groupJid: string, receipts: IpcDeliveryReceipt[]) => void,
  ): void {
    this.onAbandonedIpcDeliveriesFn = fn;
  }

  setIpcDeliveryCommitEligibilityChecker(
    fn: (receipt: IpcDeliveryReceipt) => boolean,
  ): void {
    this.isIpcDeliveryCommitEligibleFn = fn;
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

  /**
   * 公开 shutdown 状态供 scheduler 等子系统避免在关停过程中再启动新工作。
   * 调度器主循环 tick 期间若已 shutdown，应直接 skip 这次 tick，避免在
   * grace 窗口内 spawn 新脚本子进程导致孤儿。
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private clearRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryTask = null;
    state.retryCount = 0;
    state.messageRetrySnapshot = null;
  }

  /**
   * 仅取消正在排队的 retry 定时器，不重置 retryCount。
   * interruptQuery 用这个：用户中断当前查询不应抹掉之前的 backoff 进度，
   * 否则 N 次失败后正在退避的 runner 一被 interrupt 就回到 retry=0，
   * 死循环重试同一个失败请求。
   */
  private cancelRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryTask = null;
  }

  /** Preserve the exact task lane across a policy mutation stop. Returning
   * true tells stopGroup not to synthesize pendingMessages for this state. */
  private parkTaskForMutation(state: GroupState, groupJid: string): boolean {
    const retryTask = state.retryTask;
    const task = state.activeTask ?? retryTask;
    const isVirtualTaskLane =
      this.isVirtualJid(groupJid) &&
      !state.active &&
      state.pendingTasks.length > 0;
    if (!task && !isVirtualTaskLane) return false;

    if (
      task &&
      !state.pendingTasks.some((candidate) => candidate.id === task.id)
    ) {
      state.pendingTasks.unshift(task);
    }
    if (retryTask) this.cancelRetryTimer(state);
    this.waitingGroups.add(groupJid);
    return true;
  }

  /**
   * Whether stopGroup was issued for this folder in the recent window.
   * Used by:
   *   1. runForGroup finally — skip pendingMessages re-arm + drainGroup
   *   2. main loop OOM handler — don't count user-stopped 137 as OOM
   *   3. anything else that needs to suppress auto-restart shortly after a stop
   */
  isRecentlyStopped(folder: string): boolean {
    const ts = this.recentlyStoppedFolders.get(folder);
    if (!ts) return false;
    if (Date.now() - ts > GroupQueue.RECENTLY_STOPPED_WINDOW_MS) {
      this.recentlyStoppedFolders.delete(folder);
      return false;
    }
    return true;
  }

  /**
   * Describe the latest explicit stop for the active folder. Ordinary user or
   * lifecycle stops discard the interrupted input; capability mutations park
   * it so the replacement runtime can replay under the committed policy.
   */
  getRecentStopDisposition(folder: string): 'none' | 'discard' | 'preserve' {
    if (!this.isRecentlyStopped(folder)) return 'none';
    return this.mutationStoppedFolders.has(folder) ? 'preserve' : 'discard';
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
    // Host mode mirrors the Claude Agent SDK's natural process model: the
    // serialization key is the only admission boundary. Different sessions
    // must be able to start immediately and run concurrently; applying a
    // process-wide slot count here lets warm, idle sessions block unrelated
    // Feishu topics for up to IDLE_TIMEOUT.
    //
    // Container mode keeps its explicit resource/billing limits because each
    // turn consumes a managed Docker allocation. Host processes are governed
    // by the operating system instead of an application-level capacity pool.
    if (this.isHostMode(groupJid)) return true;

    const systemCapacity =
      this.activeContainerCount < getSystemSettings().maxConcurrentContainers;
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
   * List every virtual-JID runner that belongs to the same folder family as
   * `baseJid` (i.e. sub-agents `{...}#agent:{id}` and scheduled tasks
   * `{...}#task:{id}`), excluding the base JID itself — whether it is actively
   * running OR merely QUEUED (capacity-blocked: in pendingTasks / waitingGroups,
   * not yet active). Used by workspace-level operations (delete / clear-history)
   * that stop every descendant before wiping the folder's filesystem.
   *
   * Including queued descendants is essential: a capacity-blocked sub-agent left
   * out of the stop set would be picked up by drainWaiting after a slot frees and
   * launch against a folder/session dir that was already deleted (container/
   * process leak + ENOENT). stopGroup() on a queued descendant clears its
   * pendingTasks and removes it from waitingGroups, so it never launches.
   *
   * Matching is done via serializationKey (folder-based), so descendants
   * launched from any sibling JID sharing the same folder are all returned.
   */
  listDescendantJids(baseJid: string): string[] {
    const baseKey = this.getSerializationKey(baseJid);
    const prefix = baseKey + '#';
    const result: string[] = [];
    for (const [jid, state] of this.groups.entries()) {
      if (!this.getSerializationKey(jid).startsWith(prefix)) continue;
      if (
        state.active ||
        state.pendingTasks.length > 0 ||
        this.waitingGroups.has(jid)
      ) {
        result.push(jid);
      }
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

  acknowledgeIpcDeliveries(
    groupJid: string,
    receipts: IpcDeliveryReceipt[],
    commit: (confirmed: IpcDeliveryReceipt[]) => void,
  ): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || receipts.length === 0) return;
    state.pendingIpcDeliveries ??= new Map();
    state.acknowledgedIpcDeliveryIds ??= new Set();
    const confirmed = receipts.filter((receipt) => {
      const pending = state.pendingIpcDeliveries.get(receipt.deliveryId);
      return (
        pending?.chatJid === receipt.chatJid &&
        pending.cursor.timestamp === receipt.cursor.timestamp &&
        pending.cursor.id === receipt.cursor.id
      );
    });
    if (confirmed.length === 0) return;

    for (const receipt of confirmed) {
      state.acknowledgedIpcDeliveryIds.add(receipt.deliveryId);
    }
    this.flushAcknowledgedIpcDeliveries(groupJid, commit);
  }

  /** Re-evaluate already-acknowledged deliveries after any cursor chokepoint
   * advances durable state (receipt, cold turn, or out-of-band completion).
   * Ordering is by DB cursor, never request/Map registration order. */
  flushAcknowledgedIpcDeliveries(
    groupJid: string,
    commit: (confirmed: IpcDeliveryReceipt[]) => void,
  ): IpcDeliveryReceipt[] {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || !state.pendingIpcDeliveries) return [];
    state.acknowledgedIpcDeliveryIds ??= new Set();
    const committed: IpcDeliveryReceipt[] = [];
    const chatJids = new Set(
      [...state.pendingIpcDeliveries.values()].map(
        (receipt) => receipt.chatJid,
      ),
    );
    for (const chatJid of chatJids) {
      while (true) {
        const first = [...state.pendingIpcDeliveries.values()]
          .filter((receipt) => receipt.chatJid === chatJid)
          .sort((a, b) => {
            const cursorOrder = compareIpcMessageCursors(a.cursor, b.cursor);
            if (cursorOrder !== 0) return cursorOrder;
            return a.deliveryId.localeCompare(b.deliveryId);
          })[0];
        if (!first) break;
        if (!state.acknowledgedIpcDeliveryIds.has(first.deliveryId)) break;
        // Fail closed when the host has not installed its DB-backed checker.
        if (!this.isIpcDeliveryCommitEligibleFn?.(first)) break;

        // Commit first. If persistence throws, keep the delivery pending so
        // exit/startup recovery replays it rather than silently losing it.
        commit([first]);
        state.pendingIpcDeliveries.delete(first.deliveryId);
        state.acknowledgedIpcDeliveryIds.delete(first.deliveryId);
        committed.push(first);
      }
    }
    return committed;
  }

  markRunnerQueryIdle(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || !state.queryInFlight) return;
    const completedQueryId = state.queryId;
    state.queryInFlight = false;
    state.queryId = null;
    state.queryStartedAt = null;
    state.announcedQueryId = null;
    if (!completedQueryId) return;
    // Publish the terminal event before the legacy idle callback. The callback
    // may synchronously reserve/announce the next queued query; ordering the
    // old terminal first prevents a late idle from clearing that new run.
    this.announceQueryFinish(groupJid, completedQueryId, 'completed');
    try {
      this.onQueryIdleFn?.(groupJid, completedQueryId);
    } catch (err) {
      logger.error({ groupJid, err }, 'onQueryIdle callback failed');
    }
  }

  getActiveQueryId(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    return state?.active && state.queryInFlight ? state.queryId : null;
  }

  /** Reserve the next logical query before asynchronous prompt expansion.
   * This closes the idle race where a newly-arriving message could bypass a
   * durable queued follow-up while it is being prepared for IPC injection. */
  reserveNextQuery(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || state.queryInFlight) return null;
    state.queryInFlight = true;
    state.queryId = randomUUID();
    state.queryStartedAt = Date.now();
    state.announcedQueryId = null;
    return state.queryId;
  }

  releaseQueryReservation(
    groupJid: string,
    expectedQueryId: string,
    notifyIdle = false,
  ): boolean {
    const state = this.resolveActiveState(groupJid);
    if (
      !state?.active ||
      !state.queryInFlight ||
      state.queryId !== expectedQueryId
    ) {
      return false;
    }
    state.queryInFlight = false;
    state.queryId = null;
    state.queryStartedAt = null;
    state.announcedQueryId = null;
    this.announceQueryFinish(
      groupJid,
      expectedQueryId,
      notifyIdle ? 'completed' : 'released',
    );
    if (notifyIdle) {
      try {
        this.onQueryIdleFn?.(groupJid, expectedQueryId);
      } catch (err) {
        logger.error({ groupJid, err }, 'onQueryIdle callback failed');
      }
    }
    return true;
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
    if (this.isTerminalMutationDiscarded(groupJid)) return false;
    if (this.isMutationPaused(groupJid)) return false;
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;
    // Task-runner exclusion mirrors sendMessage(). Conversation agents
    // (`#agent:` virtual JIDs) DO accept IPC messages — exempt them.
    if (state.activeRunnerIsTask && !groupJid.includes('#agent:')) {
      return false;
    }
    return true;
  }

  requiresFeishuCliContainerRestart(
    groupJid: string,
    requirements: RunnerMessageRequirements,
  ): boolean {
    const state = this.resolveActiveState(groupJid);
    const identityRequirement =
      resolveFeishuCliIdentityRequirement(requirements);
    return (
      state !== null &&
      state.containerName !== null &&
      identityRequirement.specified &&
      identityRequirement.accountId !== state.feishuCliAccountId
    );
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const mutationKey = this.getMutationPauseKey(groupJid);
    if (this.terminalDiscardMutationKeys.has(mutationKey)) {
      state.mutationKey = mutationKey;
      state.pendingMessages = false;
      this.waitingGroups.delete(groupJid);
      logger.debug(
        { groupJid, mutationKey },
        'Terminal mutation discard active, dropping message check',
      );
      return;
    }

    if (this.isMutationPaused(groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      logger.debug({ groupJid }, 'Mutation pause active, message queued');
      return;
    }

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

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void | boolean>,
    options?: { allowInactive?: boolean; onDropped?: () => void },
  ): boolean {
    if (this.shuttingDown) return false;

    const state = this.getGroup(groupJid);
    const mutationKey = this.getMutationPauseKey(groupJid);
    if (this.terminalDiscardMutationKeys.has(mutationKey)) {
      state.mutationKey = mutationKey;
      try {
        options?.onDropped?.();
      } catch (err) {
        logger.warn(
          { groupJid, taskId, err },
          'Terminal mutation task drop callback failed',
        );
      }
      logger.debug(
        { groupJid, taskId, mutationKey },
        'Terminal mutation discard active, dropping task',
      );
      return false;
    }

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return false;
    }

    if (this.isMutationPaused(groupJid)) {
      state.pendingTasks.push({
        id: taskId,
        groupJid,
        fn,
        allowInactive: options?.allowInactive,
        onDropped: options?.onDropped,
      });
      this.waitingGroups.add(groupJid);
      logger.debug({ groupJid, taskId }, 'Mutation pause active, task queued');
      return true;
    }

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingTasks.push({
        id: taskId,
        groupJid,
        fn,
        allowInactive: options?.allowInactive,
        onDropped: options?.onDropped,
      });
      this.waitingGroups.add(groupJid);
      logger.debug(
        { groupJid, taskId, activeRunner: activeRunner || groupJid },
        'Group runner active, task queued',
      );
      return true;
    }

    if (!this.hasCapacityFor(groupJid)) {
      const isHost = this.isHostMode(groupJid);
      state.pendingTasks.push({
        id: taskId,
        groupJid,
        fn,
        allowInactive: options?.allowInactive,
        onDropped: options?.onDropped,
      });
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
      return true;
    }

    // Run immediately
    this.waitingGroups.delete(groupJid);
    this.runTask(groupJid, {
      id: taskId,
      groupJid,
      fn,
      allowInactive: options?.allowInactive,
      onDropped: options?.onDropped,
    });
    return true;
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
      feishuCliAccountId?: string | null;
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
    state.feishuCliAccountId = opts.feishuCliAccountId ?? null;
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
    onInjected?: (receipt?: IpcDeliveryReceipt) => void,
    sourceJid?: string,
    taskId?: string,
    deliveryTarget?: IpcDeliveryTarget,
    channelContext?: ChannelTurnContext,
    beforePublish?: (
      receipt?: IpcDeliveryReceipt,
    ) => IpcPrePublishAdmission | false | void,
    requirements?: RunnerMessageRequirements,
  ): SendMessageResult {
    if (this.isTerminalMutationDiscarded(groupJid)) return 'no_active';
    if (this.isMutationPaused(groupJid)) return 'no_active';
    const state = this.resolveActiveState(groupJid);
    if (!state) return 'no_active';

    // Container credentials are immutable process environment. Never inject a
    // turn from Bot B into a warm runner that started with Bot A (or with no
    // bound Bot): drain it and let the normal cold-start path launch a runner
    // carrying B's credentials. Host mode is intentionally exempt because
    // feishu-cli there is governed entirely by the host's native configuration.
    const identityRequirement = resolveFeishuCliIdentityRequirement(
      requirements,
      channelContext,
    );
    if (
      state.containerName !== null &&
      identityRequirement.specified &&
      identityRequirement.accountId !== state.feishuCliAccountId
    ) {
      this.requestDrainForActiveRunner(
        groupJid,
        'Draining container before switching Feishu CLI Bot identity',
      );
      logger.info(
        {
          groupJid,
          activeFeishuCliAccountId: state.feishuCliAccountId,
          requiredFeishuCliAccountId: identityRequirement.accountId,
        },
        'Rejected warm IPC injection across Feishu Bot identities',
      );
      return 'no_active';
    }

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
    //
    // Capture the exact query attempt before publishing the IPC file. The
    // child echoes this identity on every stream event, which lets Web reject
    // late A output without confusing a legitimate retry B that reuses the
    // same durable input/turn ID.
    const queryRunId =
      state.queryInFlight && state.queryId ? state.queryId : randomUUID();

    const inputDir = this.resolveIpcInputDir(state);
    let tempPath: string | undefined;
    let admission: IpcPrePublishAdmission | undefined;
    let published = false;
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      tempPath = `${filepath}.tmp`;
      if (deliveryTarget) {
        const maximum = [...deliveryTarget.coveredCursors].sort(
          compareIpcMessageCursors,
        )[deliveryTarget.coveredCursors.length - 1];
        if (
          !maximum ||
          maximum.timestamp !== deliveryTarget.cursor.timestamp ||
          maximum.id !== deliveryTarget.cursor.id
        ) {
          throw new Error(
            'IPC delivery target must end at its maximum covered cursor',
          );
        }
      }
      const receipt: IpcDeliveryReceipt | undefined = deliveryTarget
        ? {
            deliveryId: randomUUID(),
            chatJid: deliveryTarget.chatJid,
            coveredCursors: deliveryTarget.coveredCursors.map((cursor) => ({
              ...cursor,
            })),
            cursor: deliveryTarget.cursor,
          }
        : undefined;
      // Durable host admission is a strict precondition for visibility to the
      // SDK runner. A rejected Turn fence/card reservation therefore creates
      // neither an IPC file nor an in-memory pending receipt.
      const admissionResult = beforePublish?.(receipt);
      if (admissionResult === false) {
        logger.warn(
          { groupJid, deliveryId: receipt?.deliveryId },
          'GroupQueue.sendMessage: pre-publish admission rejected IPC input',
        );
        return 'no_active';
      }
      admission = admissionResult || undefined;
      // Stamp taskId when this injection carries a scheduled-task prompt so the
      // agent-runner can attribute the resulting send_message output to the task
      // (drives notify_channels broadcast on the host). Omitted for regular
      // user messages, matching the cold-start path's messageTaskId handling.
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          images,
          queryRunId,
          sourceJid,
          channelContext,
          taskId,
          receipt,
        }),
      );
      fs.renameSync(tempPath, filepath);
      tempPath = undefined;
      published = true;
      // Rename + in-memory delivery registration are one synchronous critical
      // section. Mutation pause/stop cannot observe a written file without its
      // recovery metadata (the old callback→mark race window).
      state.hasIpcInjectedMessages = true;
      if (receipt) {
        state.pendingIpcDeliveries ??= new Map();
        state.pendingIpcDeliveries.set(receipt.deliveryId, receipt);
        // Claim eligibility is observed synchronously in the same stack as
        // rename+registration. A blocked claim remains in both the file/ledger
        // until a later durable cursor advance makes it provably contiguous.
        this.isIpcDeliveryCommitEligibleFn?.(receipt);
      }
      if (!state.queryInFlight || !state.queryId) {
        state.queryInFlight = true;
        state.queryId = queryRunId;
        state.queryStartedAt = Date.now();
        state.announcedQueryId = null;
        this.announceQueryStart(groupJid, state);
      }
      try {
        onInjected?.(receipt);
      } catch (callbackError) {
        // The file and receipt are already published. Callback diagnostics
        // must never lie to the caller and trigger a duplicate cold-start.
        logger.error(
          { groupJid, deliveryId: receipt?.deliveryId, callbackError },
          'GroupQueue.sendMessage: post-publish callback failed',
        );
      }
      return 'sent';
    } catch (err) {
      // Once rename succeeds the runner can observe the message. From that
      // point onward we must preserve its durable admission and report
      // `sent`; rolling it back or returning `no_active` would let the caller
      // cold-start a duplicate while the published IPC file is still live.
      if (published) {
        logger.error(
          { groupJid, inputDir, err },
          'GroupQueue.sendMessage: post-publish bookkeeping failed; preserving admission',
        );
        return 'sent';
      }
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // temp file may not have been created yet
        }
      }
      try {
        admission?.rollback?.();
      } catch (rollbackError) {
        logger.error(
          { groupJid, rollbackError },
          'GroupQueue.sendMessage: pre-publish admission rollback failed',
        );
      }
      // 不静默：磁盘满 / 权限错 / inode 耗尽这些根因不应该被伪装成
      // 'no_active'。下游会重新 enqueueMessageCheck 走 fallback 路径，
      // 但运维需要看到根因日志。
      logger.warn(
        { groupJid, inputDir, err },
        'GroupQueue.sendMessage: failed to write IPC input file, falling back to no_active',
      );
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
    for (const name of ['_drain', '_close', '_interrupt']) {
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
    // 与 runForGroup finally 的逻辑保持一致：刚被 stopGroup 标记的 folder 不
    // 应该在这里重新点亮 pendingMessages，否则 stopGroup 之后的 drainGroup 路径
    // 会拉起一个新 runner。
    if (
      this.isRecentlyStopped(state.groupFolder) &&
      !this.mutationPreserveStopJids.has(groupJid)
    ) {
      return;
    }
    try {
      if (
        !this.hasRemainingIpcMessages(
          state.groupFolder,
          state.agentId,
          state.taskRunId,
        )
      )
        return;

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

  private recoverUnacknowledgedIpcDeliveries(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!state.pendingIpcDeliveries || state.pendingIpcDeliveries.size === 0)
      return;
    state.acknowledgedIpcDeliveryIds ??= new Set();
    const receipts = [...state.pendingIpcDeliveries.values()];
    try {
      // Once the host rewinds to the durable DB cursor, DB is the sole replay
      // source. Remove any still-on-disk copies first so the next runner cannot
      // receive both a stale IPC file and the DB replay.
      this.discardDeliveryIpcFiles(
        state,
        new Set(receipts.map((r) => r.deliveryId)),
      );
      if (!this.onUnacknowledgedIpcDeliveriesFn) {
        throw new Error(
          'unacknowledged IPC delivery recovery callback is not configured',
        );
      }
      this.onUnacknowledgedIpcDeliveriesFn(groupJid, receipts);
      state.pendingIpcDeliveries.clear();
      state.acknowledgedIpcDeliveryIds.clear();
    } catch (err) {
      logger.error(
        { groupJid, receipts, err },
        'Failed to recover unacknowledged IPC deliveries',
      );
    }
  }

  private discardDeliveryIpcFiles(
    state: GroupState,
    deliveryIds: Set<string>,
  ): void {
    if (!state.groupFolder || deliveryIds.size === 0) return;
    const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
    let filenames: string[];
    try {
      filenames = fs
        .readdirSync(inputDir)
        .filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const filename of filenames) {
      const filepath = path.join(inputDir, filename);
      try {
        const payload = JSON.parse(fs.readFileSync(filepath, 'utf8')) as {
          receipt?: { deliveryId?: unknown };
        };
        const deliveryId = payload.receipt?.deliveryId;
        if (typeof deliveryId === 'string' && deliveryIds.has(deliveryId)) {
          fs.unlinkSync(filepath);
        }
      } catch (err) {
        logger.warn(
          { filepath, err },
          'Failed to inspect/discard unacknowledged IPC delivery file',
        );
      }
    }
  }

  private abandonUnacknowledgedIpcDeliveries(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!state.pendingIpcDeliveries || state.pendingIpcDeliveries.size === 0)
      return;
    state.acknowledgedIpcDeliveryIds ??= new Set();
    const receipts = [...state.pendingIpcDeliveries.values()];
    this.discardDeliveryIpcFiles(
      state,
      new Set(receipts.map((r) => r.deliveryId)),
    );
    if (!this.onAbandonedIpcDeliveriesFn) {
      logger.error(
        { groupJid, receipts },
        'Cannot abandon IPC deliveries: callback is not configured',
      );
      return;
    }
    // Callback commits/tombstones first. On failure leave the ledger intact so
    // the exit path falls back to replay rather than silently dropping work.
    this.onAbandonedIpcDeliveriesFn(groupJid, receipts);
    state.pendingIpcDeliveries.clear();
    state.acknowledgedIpcDeliveryIds.clear();
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
      return files.some((f) => f.endsWith('.json'));
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
  interruptQuery(groupJid: string, expectedQueryId?: string): boolean {
    // Use resolveActiveState so sibling JIDs (feishu/telegram sharing the
    // same folder as a web group) are correctly resolved to the active runner.
    const state = this.resolveActiveState(groupJid);
    if (!state || !state.queryInFlight) return false;
    if (expectedQueryId && state.queryId !== expectedQueryId) return false;

    // 只取消等待中的 retry 定时器（如果有），不重置 retryCount —— 不让用户
    // 中断把已积累的 backoff 进度归零。
    this.cancelRetryTimer(state);

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
    options?: { force?: boolean; preserveQueuedWork?: boolean },
  ): Promise<void> {
    const force = options?.force ?? false;
    const preserveQueuedWork = options?.preserveQueuedWork ?? false;
    if (preserveQueuedWork && !this.isMutationPaused(groupJid)) {
      throw new Error(
        'preserveQueuedWork requires an active mutation pause token',
      );
    }
    const requestedState = this.getGroup(groupJid);
    requestedState.stopRequested = true;
    if (!preserveQueuedWork) {
      requestedState.pendingMessages = false;
      this.discardPendingTasks(requestedState, groupJid);
      this.clearRetryTimer(requestedState);
    } else if (!this.parkTaskForMutation(requestedState, groupJid)) {
      requestedState.pendingMessages = true;
      this.waitingGroups.add(groupJid);
    }
    // 标记 stop 时间：runForGroup finally + index.ts OOM 计数 + 主消息循环
    // 都用这个时间窗判断 user-stopped vs 真 OOM / IPC-injected drain。
    if (requestedState.groupFolder) {
      if (preserveQueuedWork) {
        this.mutationStoppedFolders.add(requestedState.groupFolder);
      } else {
        this.mutationStoppedFolders.delete(requestedState.groupFolder);
      }
      this.recentlyStoppedFolders.set(requestedState.groupFolder, Date.now());
    }
    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    state.stopRequested = true;
    if (targetJid !== groupJid) {
      if (!preserveQueuedWork) {
        state.pendingMessages = false;
        this.discardPendingTasks(state, targetJid);
        this.clearRetryTimer(state);
      } else if (!this.parkTaskForMutation(state, targetJid)) {
        state.pendingMessages = true;
        this.waitingGroups.add(targetJid);
      }
    }
    if (preserveQueuedWork) {
      this.mutationPreserveStopJids.add(targetJid);
    }
    if (state.groupFolder) {
      if (preserveQueuedWork) {
        this.mutationStoppedFolders.add(state.groupFolder);
      } else {
        this.mutationStoppedFolders.delete(state.groupFolder);
      }
      this.recentlyStoppedFolders.set(state.groupFolder, Date.now());
    }
    if (!preserveQueuedWork) {
      this.waitingGroups.delete(groupJid);
      this.waitingGroups.delete(targetJid);
      this.abandonUnacknowledgedIpcDeliveries(targetJid, state);
    }

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
        await this.waitForRunnerTeardown(state);
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
        await this.waitForRunnerTeardown(state, 10_000);
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
        await this.waitForRunnerTeardown(state);
      } else if (state.active && state.process) {
        killProcessTree(state.process, 'SIGKILL');
        await this.waitForRunnerTeardown(state);
      }
    }

    if (preserveQueuedWork) {
      this.mutationPreserveStopJids.delete(targetJid);
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
    // restartGroup owns the replacement launch. Cancel any older failed-run
    // timer up front so it cannot fire while the fresh runner is still active
    // and turn that replacement into a second pending/drain cycle.
    this.clearRetryTimer(state);

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
    if (this.isMutationPaused(groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      return;
    }
    // Defensive re-entrancy guard: never start a second runner on a GroupState
    // that is already active. Pending work is picked up by the active runner's
    // finally → drainGroup, so returning here loses nothing.
    if (state.active) {
      logger.warn(
        { groupJid, reason },
        'runForGroup called on already-active group, ignoring re-entry',
      );
      return;
    }
    // A fresh user message may legitimately start a replacement before the
    // previous failed run's backoff expires. That launch supersedes the old
    // timer; leaving it armed would enqueue/drain the new active runner when
    // it fires and can cause a second close cycle. Preserve retryCount so a
    // sequence of closed/no-reply outcomes still reaches MAX_RETRIES.
    this.cancelRetryTimer(state);
    // A new user request after an ordinary Stop owns a fresh lifecycle. Clear
    // the old discard marker before processGroupMessages starts; mutation
    // markers are removed by resumeGroupsAfterMutation before reaching here.
    if (state.stopRequested) {
      this.recentlyStoppedFolders.delete(this.getSerializationKey(groupJid));
    }
    state.stopRequested = false;
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    state.activeRunnerIsTask = false;
    state.lastActivityAt = Date.now();
    state.queryInFlight = true;
    state.queryId = randomUUID();
    state.queryStartedAt = Date.now();
    state.announcedQueryId = null;
    state.pendingMessages = false;
    state.messageRetrySnapshot = null;
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
      this.announceQueryStart(groupJid, state);
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
          state.messageRetrySnapshot = null;
          // Defensive: clear any lingering retry timer from a previous failed
          // run that was superseded by a successful drain-triggered run.
          this.clearRetryTimer(state);
        } else if (this.canScheduleRetry(state)) {
          await this.scheduleRetry(groupJid, state);
        } else {
          logger.info(
            {
              groupJid,
              stopRequested: state.stopRequested,
              restarting: state.restarting,
            },
            'Runner stop/restart in progress; suppressing failed-run retry',
          );
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      if (this.canScheduleRetry(state)) {
        await this.scheduleRetry(groupJid, state);
      } else {
        logger.info(
          {
            groupJid,
            stopRequested: state.stopRequested,
            restarting: state.restarting,
          },
          'Runner stop/restart in progress; suppressing exception retry',
        );
      }
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      const exitFolder = state.groupFolder;
      const isStopRequested =
        state.stopRequested ||
        (exitFolder ? this.isRecentlyStopped(exitFolder) : false);
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(
            state.groupFolder,
            state.agentId,
            state.taskRunId,
          );
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
        this.recoverUnconsumedIpc(groupJid, state, 'agent exit');
      }
      // If messages were IPC-injected during this run, always mark pending
      // so drainGroup triggers a fresh processGroupMessages.  If the agent
      // already replied to them, processGroupMessages will find 0 new messages
      // (cursor was committed) and return immediately — harmless.  If the
      // agent crashed, this ensures the messages are re-read from DB.
      //
      // BUT: when the user just clicked Stop, this re-armed pendingMessages
      // was racing stopGroup's clear → the agent restarted itself instantly.
      // Honor stopGroup's intent by skipping this re-arm if a stop was issued
      // for this folder in the last RECENTLY_STOPPED_WINDOW_MS.
      const preserveMutationWork = this.mutationPreserveStopJids.has(groupJid);
      if (
        state.hasIpcInjectedMessages &&
        (!isStopRequested || preserveMutationWork)
      ) {
        state.pendingMessages = true;
        logger.debug(
          { groupJid },
          'IPC-injected messages detected, marking pending for safety re-check',
        );
      } else if (state.hasIpcInjectedMessages && isStopRequested) {
        logger.info(
          { groupJid, folder: exitFolder },
          'Stop requested recently, skipping pendingMessages re-arm',
        );
      }
      const unfinishedQueryId = state.queryId;
      state.active = false;
      state.drainSentinelWritten = false;
      state.hasIpcInjectedMessages = false;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.queryId = null;
      state.queryStartedAt = null;
      state.announcedQueryId = null;
      if (unfinishedQueryId) {
        this.announceQueryFinish(
          groupJid,
          unfinishedQueryId,
          isStopRequested ? 'stopped' : 'runner_exit',
        );
      }
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
      // Skip auto-drain when a stop was just requested — drainGroup would
      // start a fresh runForGroup if any pending* slipped through.
      if (!isStopRequested || preserveMutationWork) {
        try {
          this.drainGroup(groupJid);
        } catch (err) {
          logger.error({ groupJid, err }, 'drainGroup failed');
        }
      } else {
        logger.info(
          { groupJid, folder: exitFolder },
          'Stop requested recently, skipping drainGroup',
        );
      }
      this.resolveRunnerTeardownWaiters(state);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    if (this.isMutationPaused(groupJid)) {
      state.pendingTasks.unshift(task);
      this.waitingGroups.add(groupJid);
      return;
    }
    // Defensive re-entrancy guard (see runForGroup): a task must never start on
    // an already-active GroupState, or it would overwrite the live process
    // handle and double-count the concurrency slot.
    if (state.active) {
      logger.warn(
        { groupJid, taskId: task.id },
        'runTask called on already-active group, re-queuing task',
      );
      state.pendingTasks.unshift(task);
      this.waitingGroups.add(groupJid);
      return;
    }
    // A newly-arrived conversation turn supersedes an older pending retry for
    // the same virtual lane. Preserve retryCount until this run succeeds.
    this.cancelRetryTimer(state);
    const isHostMode = this.isHostMode(groupJid);
    state.stopRequested = false;
    state.active = true;
    state.activeRunnerIsTask = true;
    state.activeTask = task;
    state.lastActivityAt = Date.now();
    state.queryInFlight = groupJid.includes('#agent:');
    state.queryId = state.queryInFlight ? randomUUID() : null;
    state.queryStartedAt = state.queryInFlight ? Date.now() : null;
    state.announcedQueryId = null;
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
      if (state.queryInFlight) this.announceQueryStart(groupJid, state);
      this.onRunnerStateChangeFn?.(groupJid, 'running');
    } catch (err) {
      logger.error({ groupJid, err }, 'onRunnerStateChange(running) failed');
    }

    try {
      const success = await task.fn();
      if (success === false) {
        if (this.canScheduleRetry(state)) {
          await this.scheduleRetry(groupJid, state, task);
        } else {
          logger.info(
            {
              groupJid,
              taskId: task.id,
              stopRequested: state.stopRequested,
              restarting: state.restarting,
            },
            'Task retry suppressed because the runner is stopping or restarting',
          );
        }
      } else {
        this.clearRetryTimer(state);
      }
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      // Clean up stale sentinel files before clearing groupFolder/agentId
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(
            state.groupFolder,
            state.agentId,
            state.taskRunId,
          );
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
        this.recoverUnconsumedIpc(groupJid, state, 'task exit');
      }
      const unfinishedQueryId = state.queryId;
      state.active = false;
      state.activeRunnerIsTask = false;
      state.activeTask = null;
      state.drainSentinelWritten = false;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.queryId = null;
      state.queryStartedAt = null;
      state.announcedQueryId = null;
      if (unfinishedQueryId) {
        this.announceQueryFinish(
          groupJid,
          unfinishedQueryId,
          state.stopRequested ? 'stopped' : 'runner_exit',
        );
      }
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
      if (!state.stopRequested) {
        try {
          this.drainGroup(groupJid);
        } catch (err) {
          logger.error({ groupJid, err }, 'drainGroup failed');
        }
      }
      this.resolveRunnerTeardownWaiters(state);
    }
  }

  private canScheduleRetry(state: GroupState): boolean {
    return !this.shuttingDown && !state.stopRequested && !state.restarting;
  }

  private async scheduleRetry(
    groupJid: string,
    state: GroupState,
    retryTask: QueuedTask | null = null,
  ): Promise<void> {
    if (!this.canScheduleRetry(state)) {
      logger.info(
        {
          groupJid,
          stopRequested: state.stopRequested,
          restarting: state.restarting,
          shuttingDown: this.shuttingDown,
        },
        'Retry suppressed because the runner is stopping or restarting',
      );
      return;
    }

    // 清除可能存在的旧定时器（不重置 retryCount，因为这里在递增）
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryTask = null;

    // 检查是否为上下文溢出错误，如果是则跳过重试
    if (this.contextOverflowGroups.has(groupJid)) {
      logger.warn(
        { groupJid },
        'Skipping retry for context overflow error (agent already retried 3 times)',
      );
      state.retryCount = 0;
      state.retryTask = null;
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
      state.retryTask = null;
      try {
        await this.onMaxRetriesExceededFn?.(
          groupJid,
          retryTask ? null : state.messageRetrySnapshot,
        );
      } catch (err) {
        logger.error({ groupJid, err }, 'onMaxRetriesExceeded callback failed');
      }
      state.messageRetrySnapshot = null;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      {
        groupJid,
        taskId: retryTask?.id,
        retryCount: state.retryCount,
        delayMs,
      },
      'Scheduling retry with backoff',
    );
    state.retryTask = retryTask;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryTask = null;
      if (this.canScheduleRetry(state)) {
        if (retryTask) {
          this.enqueueTask(groupJid, retryTask.id, retryTask.fn, {
            allowInactive: retryTask.allowInactive,
            onDropped: retryTask.onDropped,
          });
        } else {
          this.enqueueMessageCheck(groupJid);
        }
      } else {
        logger.info(
          {
            groupJid,
            stopRequested: state.stopRequested,
            restarting: state.restarting,
            shuttingDown: this.shuttingDown,
          },
          'Scheduled retry cancelled because the runner is stopping or restarting',
        );
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (this.isMutationPaused(groupJid)) {
      if (state.pendingMessages || state.pendingTasks.length > 0) {
        this.waitingGroups.add(groupJid);
      }
      return;
    }
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
      if (dbTask && dbTask.status !== 'active' && !task.allowInactive) {
        logger.info(
          { groupJid, taskId: task.id },
          'Skipping cancelled/deleted task during drain',
        );
        task.onDropped?.();
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

    // GC one-shot virtual JIDs (#task:/#agent:) once fully idle. Each task run
    // uses a unique taskRunId → a unique JID, so without this the groups Map
    // grows without bound. Only virtual JIDs are collected; real chat JIDs are
    // bounded by the number of registered groups and keep useful state. We only
    // reach here when there are no pending tasks and no runnable messages.
    if (this.isVirtualJid(groupJid)) {
      const s = this.groups.get(groupJid);
      if (
        s &&
        !s.active &&
        !s.queryInFlight &&
        !s.pendingMessages &&
        s.pendingTasks.length === 0 &&
        !s.retryTimer &&
        !s.restarting &&
        !this.waitingGroups.has(groupJid)
      ) {
        this.groups.delete(groupJid);
        this.contextOverflowGroups.delete(groupJid);
        // fall through to drainWaiting so other waiting groups still get a slot
      }
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  /** Virtual JIDs are one-shot per run (`{jid}#task:{id}` / `{jid}#agent:{id}`). */
  private isVirtualJid(jid: string): boolean {
    return jid.includes('#task:') || jid.includes('#agent:');
  }

  private drainWaiting(): void {
    // Drain waiting groups one at a time, re-checking capacity after each launch.
    // runTask/runForGroup increment counters synchronously, so capacity checks
    // stay accurate even though the async work is not awaited.
    const candidates = [...this.waitingGroups];

    for (const jid of candidates) {
      if (this.isMutationPaused(jid)) continue;
      const activeRunner = this.findActiveRunnerFor(jid);
      // Any active runner sharing this serialization key — including jid's OWN
      // runner — means no new runner may start. enqueueMessageCheck adds a jid
      // to waitingGroups even while its own runner is active (state.active), so
      // without checking self-active we would start a SECOND concurrent runner
      // on the same GroupState (duplicate replies, orphaned containers, broken
      // counters). Pending work is drained by the active runner's
      // finally → drainGroup, so skipping here is safe (no starvation).
      if (activeRunner) continue;
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
          if (
            dbTask &&
            dbTask.status !== 'active' &&
            !candidate.allowInactive
          ) {
            logger.info(
              { groupJid: jid, taskId: candidate.id },
              'Skipping cancelled/deleted task during drainWaiting',
            );
            candidate.onDropped?.();
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
      queryInFlight: boolean;
      queryId: string | null;
      queryStartedAt: number | null;
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
      queryInFlight: boolean;
      queryId: string | null;
      queryStartedAt: number | null;
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
        queryInFlight: state.queryInFlight,
        queryId: state.queryId,
        queryStartedAt: state.queryStartedAt,
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
    for (const [jid, state] of this.groups) {
      this.clearRetryTimer(state);
      this.discardPendingTasks(state, jid);
    }
    this.waitingGroups.clear();

    logger.info(
      {
        activeCount: this.activeCount,
        activeContainerCount: this.activeContainerCount,
        gracePeriodMs,
      },
      'GroupQueue shutting down, waiting for containers',
    );

    // 主动写 _close sentinel：runForGroup 的 query() loop 一直在等 IPC 输入，
    // 没有 sentinel 就需要等到 grace 用完再被 SIGTERM/docker stop 强制结束。
    // 写入后 agent 看到 sentinel 自然 break loop、走 finally 清理、conversation
    // archive 完成。和 closeAllActiveForCredentialRefresh 的策略一致。
    for (const [, state] of this.groups) {
      if (!state.active || !state.groupFolder) continue;
      const inputDir = state.taskRunId
        ? path.join(
            DATA_DIR,
            'ipc',
            state.groupFolder,
            'tasks-run',
            state.taskRunId,
            'input',
          )
        : state.agentId
          ? path.join(
              DATA_DIR,
              'ipc',
              state.groupFolder,
              'agents',
              state.agentId,
              'input',
            )
          : path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
      try {
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      } catch {
        // best effort — fall back to SIGTERM/docker stop later
      }
    }

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
