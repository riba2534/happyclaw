import { ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from './config.js';
import { killProcessTree } from './container-runner.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import { resolveFeishuCliBoundAccountId } from './feishu-cli-runtime.js';
import { isIpcInputPayloadFilename } from './ipc-delivery-recovery.js';
import type {
  RunnerRuntime,
  StuckRecoveryCandidate,
} from './stuck-runner-recovery.js';
import type { ChannelTurnContext, InteractionMode } from './types.js';
export type SendMessageResult = 'sent' | 'no_active';
export interface IpcMessageCursor {
  timestamp: string;
  id: string;
  /** Host-assigned durable arrival order. */
  sequence?: number;
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
  /** Delivery contract fixed in the runner system prompt and MCP tools. */
  interactionMode?: InteractionMode;
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
  // Only a Feishu turn names a Bot. Another channel's turn context (Telegram,
  // QQ, ...) imposes no Feishu CLI identity, exactly like an input without
  // one: it must not drain a runner started with the workspace's Bot.
  if (channelContext?.provider === 'feishu') {
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
  if (a.sequence !== undefined && b.sequence !== undefined) {
    return a.sequence - b.sequence;
  }
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
  /** Release caller-owned reservations when queued work is discarded. */
  onDropped?: () => void;
}

export type QueryFinishReason =
  | 'completed'
  | 'released'
  | 'runner_exit'
  | 'stopped';

/**
 * Why a query is interrupted: `stop` (`/break`, a stop button, a recall) or
 * `steer` (`/steer`, 「发送」). Both interrupt the turn; after a stop the
 * runner also closes the query if a sub-agent outlasts the interrupt.
 */
export type InterruptReason = 'stop' | 'steer';

/**
 * Companion of `_interrupt` for an explicit stop, written just before it as
 * `{"queryId":"<the _interrupt content>","reason":"stop"}`. `_interrupt`
 * itself keeps its content so runners that predate the reason still read it;
 * a runner treats an interrupt without this file as a steer. The runner's
 * `turn-interrupt.ts` reads it under the same name.
 */
const INTERRUPT_REASON_SENTINEL = '_interrupt_reason';

/**
 * Write an IPC sentinel whole: the runner's directory watch fires as soon as
 * a file is created, so it must never see one half written.
 */
function publishSentinel(dir: string, name: string, content: string): void {
  const file = path.join(dir, name);
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const RETRY_JITTER_RATIO = 0.2;
let retryJitterSource: () => number = Math.random;

/** Test hook: make retry delays deterministic (0 = exact base backoff). */
export function setRetryJitterSourceForTesting(
  source: (() => number) | null,
): void {
  retryJitterSource = source ?? Math.random;
}
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
  /** Monotonic identity for each concrete runForGroup/runTask lifecycle. */
  runnerGeneration: number;
  /** Runtime actually assigned when this runner was launched. */
  runnerRuntime: RunnerRuntime | null;
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
  /** Query that requested an interrupt before its IPC directory existed. */
  pendingInterruptQueryId: string | null;
  /** Why that deferred interrupt was requested; a stop outranks a steer. */
  pendingInterruptReason: InterruptReason;
  /** Host callback when a deferred cold-boot interrupt cannot be published. */
  deferredInterruptFailure?: (queryId: string) => void;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  displayName: string | null;
  groupFolder: string | null;
  agentId: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Exact task captured by a retry timer; null means a message-lane retry. */
  retryTask: QueuedTask | null;
  /** Exact message batch captured by the current message-lane attempt. */
  messageRetrySnapshot: MessageRetrySnapshot | null;
  /** Physical inputs owned by the current logical query only. Unlike the
   * runner-attempt retry snapshot, this is cleared at every query boundary. */
  currentQueryCoveredMessageIds: Set<string>;
  restarting: boolean;
  /** Provider profile ID selected for the current active runner (null = default/override). */
  selectedProviderId: string | null;
  /** Exact Feishu Bot whose credentials were injected at container startup.
   * Host processes always keep this null because their native feishu-cli
   * environment/config is authoritative. */
  feishuCliAccountId: string | null;
  /** Main runner contract; null for task/legacy runners. */
  interactionMode: InteractionMode | null;
  /** True when a _drain sentinel has been written for the current active runner. */
  drainSentinelWritten: boolean;
  /** True when messages have been IPC-injected into the running agent via sendMessage().
   *  Used to detect lost messages on abnormal exit: if the agent crashes after IPC
   *  injection, the caller already advanced the cursor so processGroupMessages won't
   *  re-read those messages.  The close handler uses this flag to force pendingMessages
   *  so drainGroup triggers a fresh run. */
  hasIpcInjectedMessages: boolean;
  /** Oldest IPC inject still owed by the current logical query. Unlike
   * lastActivityAt, ordinary runner output must never refresh this timestamp. */
  ipcOwedSinceAt: number | null;
  /** IPC deliveries written to this runner but not yet acknowledged by a
   * healthy agent query result. Keyed by deliveryId for out-of-order acks. */
  pendingIpcDeliveries: Map<string, IpcDeliveryReceipt>;
  /** Immutable query identity stamped when each durable input was published. */
  pendingIpcQueryIds?: Map<string, string>;
  /** Receipts observed from stdout but blocked behind an earlier unacknowledged
   * delivery for the same chat. They remain replayable until the contiguous
   * prefix is durably committed. */
  acknowledgedIpcDeliveryIds: Set<string>;
  /** When the runner's last query went idle; null while a query runs. */
  idleSince?: number | null;
  /** The last idle came from a truncation/auto continuation, which may still
   * be finishing inside the runner. Never reclaimed then. */
  idleFromContinuation?: boolean;
  /** Query that went idle with only the runner's background tasks left (see
   * markRunnerBackgroundOnly). An explicit stop still reaches those tasks
   * through it; the runner is neither reclaimed nor closed after its query
   * while it is set. Null otherwise. */
  backgroundQueryId?: string | null;
  /**
   * The runner was asked to exit and takes no further query: `reclaim` freed
   * its idle container slot for waiting work, `after_query` closes it once
   * the query in flight ends.
   */
  closing?: 'reclaim' | 'after_query' | null;
  /** Runs with the runner's JID after its teardown, before the next drain. */
  afterRunnerExit?: ((runnerJid: string) => void) | null;
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
  /** Lanes (serialization keys) whose latest stop kept their work. */
  private mutationStoppedLanes = new Set<string>();
  /**
   * Exact lanes held by holdLane(), with how many holders each has. Unlike a
   * mutation pause this holds one lane, never its workspace family.
   */
  private heldLanes = new Map<string, number>();
  // 记录每个 lane（序列化 key）最近一次 stopGroup 的时间戳（毫秒）。runForGroup
  // finally 块会用它来决定是否跳过自动 drainGroup —— stopGroup 中清空
  // pendingMessages 之后，hasIpcInjectedMessages 重新置 pendingMessages=true，
  // 会让用户的 'stop' 之后容器立即又被拉起来。同时让主消息循环在 OOM 计数前
  // 看一眼这个标志，避免把 user-stopped (SIGKILL → 137) 误判为真实 OOM 触发
  // 会话重置。按 lane 记录：停一个会话不影响同一工作区的其他 lane。
  private recentlyStoppedLanes = new Map<string, number>();
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
  private onRunnerQueryTeardownFn: ((groupJid: string) => void) | null = null;
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
    | ((groupJid: string) => { allowed: boolean; userId?: string | null })
    | null = null;
  private onUnconsumedAgentIpcFn:
    | ((groupJid: string, agentId: string) => void)
    | null = null;
  private onUnacknowledgedIpcDeliveriesFn:
    | ((groupJid: string, receipts: IpcDeliveryReceipt[]) => void)
    | null = null;
  /** Host cleanup for a lane whose work an ordinary stop discards. */
  private onLaneDiscardedFn: ((groupJid: string) => void) | null = null;
  /** Host veto for reclaiming an idle runner: work it still owes a lane. */
  private idleReclaimBlockerFn: ((groupJid: string) => boolean) | null = null;
  /** Serialization keys whose stops wait for the current query to end. */
  private queryEndStopDeferrals = new Map<
    string,
    { count: number; onRunnerExit: (runnerJid: string) => void }
  >();
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
        runnerGeneration: 0,
        runnerRuntime: null,
        activeRunnerIsTask: false,
        activeTask: null,
        lastActivityAt: null,
        queryInFlight: false,
        queryId: null,
        queryStartedAt: null,
        announcedQueryId: null,
        pendingInterruptQueryId: null,
        pendingInterruptReason: 'steer',
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        displayName: null,
        groupFolder: null,
        agentId: null,
        retryCount: 0,
        retryTimer: null,
        retryTask: null,
        messageRetrySnapshot: null,
        currentQueryCoveredMessageIds: new Set(),
        restarting: false,
        selectedProviderId: null,
        feishuCliAccountId: null,
        interactionMode: null,
        drainSentinelWritten: false,
        hasIpcInjectedMessages: false,
        ipcOwedSinceAt: null,
        pendingIpcDeliveries: new Map(),
        acknowledgedIpcDeliveryIds: new Set(),
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private getMutationBaseJid(groupJid: string): string {
    const agentSep = groupJid.indexOf('#agent:');
    return agentSep >= 0 ? groupJid.slice(0, agentSep) : groupJid;
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
    if (this.heldLanes.has(groupJid)) return true;
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

  /**
   * Hold one lane (a Runtime Session being deleted) without pausing its
   * workspace: the lane's queued and newly arriving work waits instead of
   * starting a runner, and stopGroup(..., { preserveQueuedWork: true }) keeps
   * it, while the main session and the other sessions keep running.
   */
  holdLane(groupJid: string): void {
    this.heldLanes.set(groupJid, (this.heldLanes.get(groupJid) ?? 0) + 1);
  }

  /**
   * Release one hold. With none left the lane is as it was: deliveries its
   * stopped runner had not acknowledged are replayed and its work runs.
   */
  releaseLane(groupJid: string): void {
    if (!this.releaseLaneHold(groupJid)) return;
    const state = this.groups.get(groupJid);
    if (state && !state.active) {
      this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
    }
    if (state && (state.pendingMessages || state.pendingTasks.length > 0)) {
      this.waitingGroups.add(groupJid);
    }
    this.drainWaiting();
  }

  /**
   * A held lane's session is gone: drop its work and run its discard hook
   * (ending a usage-limit wait, cancelling parked input), as a plain stop
   * does. The lane stays held while another holder has it.
   */
  discardHeldLane(groupJid: string): void {
    if (!this.heldLanes.has(groupJid)) return;
    try {
      this.discardLaneWork(groupJid, this.getGroup(groupJid));
    } finally {
      this.releaseLaneHold(groupJid);
    }
    this.drainWaiting();
  }

  /** Drop one hold; true when it was the last. */
  private releaseLaneHold(groupJid: string): boolean {
    const holders = this.heldLanes.get(groupJid);
    if (!holders) return false;
    if (holders > 1) {
      this.heldLanes.set(groupJid, holders - 1);
      return false;
    }
    this.heldLanes.delete(groupJid);
    this.mutationPreserveStopJids.delete(groupJid);
    // The stop's markers outlive the hold only while a workspace mutation
    // also holds the lane; otherwise its next runner starts afresh.
    if (!this.mutationPauseCounts.has(this.getMutationPauseKey(groupJid))) {
      this.clearStopMarkers(groupJid);
    }
    return true;
  }

  private clearStopMarkers(groupJid: string): void {
    const lane = this.getSerializationKey(groupJid);
    this.mutationStoppedLanes.delete(lane);
    this.recentlyStoppedLanes.delete(lane);
  }

  /**
   * After a stop that kept the lane's work: remove the files of IPC
   * deliveries the runner had not acknowledged but keep their receipts, so
   * the outcome decides — replayed when the lane is released, committed as
   * abandoned when its work is discarded. Falls back to replaying now when
   * the files cannot be removed.
   */
  private parkUnacknowledgedIpcDeliveries(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!state.pendingIpcDeliveries || state.pendingIpcDeliveries.size === 0)
      return;
    const ids = new Set(state.pendingIpcDeliveries.keys());
    if (!this.discardDeliveryIpcFiles(state, ids)) {
      this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
    }
  }

  /** Drop a lane's queued work and run its discard hook, as stopGroup does. */
  private discardLaneWork(groupJid: string, state: GroupState): void {
    state.pendingMessages = false;
    this.discardPendingTasks(state, groupJid);
    this.clearRetryTimer(state);
    this.waitingGroups.delete(groupJid);
    try {
      this.abandonUnacknowledgedIpcDeliveries(groupJid, state);
    } catch (err) {
      logger.error(
        { groupJid, err },
        'Failed to abandon IPC deliveries of a discarded lane',
      );
    }
    try {
      this.onLaneDiscardedFn?.(groupJid);
    } catch (err) {
      logger.error({ groupJid, err }, 'onLaneDiscarded callback failed');
    }
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
    for (const [jid, state] of this.groups) {
      if (!releasedKeys.has(this.getMutationPauseKey(jid))) continue;
      if (this.heldLanes.has(jid)) continue;
      const lane = this.getSerializationKey(jid);
      if (this.mutationStoppedLanes.delete(lane)) {
        this.recentlyStoppedLanes.delete(lane);
      }
      if (!state.active) this.recoverUnacknowledgedIpcDeliveries(jid, state);
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
      this.discardLaneWork(jid, state);
      this.mutationPreserveStopJids.delete(jid);
      if (releasedKeys.has(this.getMutationPauseKey(jid))) {
        const lane = this.getSerializationKey(jid);
        if (this.mutationStoppedLanes.delete(lane)) {
          this.recentlyStoppedLanes.delete(lane);
        }
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
    // A cold message runner becomes active before it registers its folder and
    // process handle. Prefer that exact state during the boot window; sibling
    // JIDs still fall back to the fully registered shared runner.
    const ownState = this.groups.get(groupJid);
    const state = ownState?.active
      ? ownState
      : this.resolveActiveState(groupJid);
    if (!state?.active) return false;
    const coveredCursors = [...snapshot.coveredCursors]
      .map((cursor) => ({ ...cursor }))
      .sort(compareIpcMessageCursors);
    if (coveredCursors.length === 0) return false;
    // Conversation-agent lanes are implemented with runTask but still own
    // user-message queries. Track their coverage without turning it into a
    // message-lane retry snapshot. Scheduled task runners remain excluded.
    if (state.activeRunnerIsTask) {
      return groupJid.includes('#agent:');
    }
    state.messageRetrySnapshot = {
      coveredCursors,
      cursor: { ...coveredCursors[coveredCursors.length - 1] },
    };
    return true;
  }

  /**
   * Bind physical inputs to the query that is current at this exact moment.
   * Unlike setMessageRetrySnapshot, this never changes runner-attempt retry
   * ownership and refuses a warm append that belongs to a later SDK turn.
   */
  setCurrentQueryCoverage(
    groupJid: string,
    expectedQueryId: string,
    snapshot: MessageRetrySnapshot,
  ): boolean {
    const ownState = this.groups.get(groupJid);
    const state =
      ownState?.active && ownState.queryInFlight
        ? ownState
        : this.resolveActiveState(groupJid);
    if (
      !state?.active ||
      !state.queryInFlight ||
      state.queryId !== expectedQueryId
    ) {
      return false;
    }
    const coveredCursors = [...snapshot.coveredCursors]
      .map((cursor) => ({ ...cursor }))
      .sort(compareIpcMessageCursors);
    if (coveredCursors.length === 0) return false;
    state.currentQueryCoveredMessageIds = new Set(
      coveredCursors.map((cursor) => cursor.id),
    );
    return true;
  }

  setOnContainerExit(fn: (groupJid: string) => void): void {
    this.onContainerExitFn = fn;
  }

  /** Observe the synchronous point where a runner can no longer emit output.
   * Kept separate from onContainerExit, whose single owner is the Web runtime. */
  setOnRunnerQueryTeardown(fn: (groupJid: string) => void): void {
    this.onRunnerQueryTeardownFn = fn;
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
    fn: (groupJid: string) => { allowed: boolean; userId?: string | null },
  ): void {
    this.userConcurrentLimitFn = fn;
  }

  /**
   * Work an idle runner still owes its lane that GroupQueue cannot see:
   * durable queued input, running background agents. Such a runner is never
   * reclaimed for another lane's container slot.
   */
  setIdleRunnerReclaimBlocker(fn: (groupJid: string) => boolean): void {
    this.idleReclaimBlockerFn = fn;
  }

  /**
   * An ordinary stop (Stop button, /clear, /fresh, deleting a workspace or
   * Session) discards the lane's work, including work the host keeps outside
   * GroupQueue such as an input waiting for a usage-limit reset.
   */
  setOnLaneDiscarded(fn: (groupJid: string) => void): void {
    this.onLaneDiscardedFn = fn;
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
   * Whether stopGroup was issued for this lane (its serialization key, so
   * the JIDs sharing one runner count as one lane) in the recent window.
   * Used by:
   *   1. runForGroup finally — skip pendingMessages re-arm + drainGroup
   *   2. main loop OOM handler — don't count user-stopped 137 as OOM
   *   3. anything else that needs to suppress auto-restart shortly after a stop
   */
  isRecentlyStopped(groupJid: string): boolean {
    const lane = this.getSerializationKey(groupJid);
    const ts = this.recentlyStoppedLanes.get(lane);
    if (!ts) return false;
    if (Date.now() - ts > GroupQueue.RECENTLY_STOPPED_WINDOW_MS) {
      this.recentlyStoppedLanes.delete(lane);
      return false;
    }
    return true;
  }

  /**
   * Describe the latest explicit stop of this lane. Ordinary user or
   * lifecycle stops discard the interrupted input; capability mutations and
   * held lanes park it so the replacement runtime can replay it.
   */
  getRecentStopDisposition(groupJid: string): 'none' | 'discard' | 'preserve' {
    if (!this.isRecentlyStopped(groupJid)) return 'none';
    return this.mutationStoppedLanes.has(this.getSerializationKey(groupJid))
      ? 'preserve'
      : 'discard';
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

  private getUserId(groupJid: string): string | null {
    return this.userConcurrentLimitFn?.(groupJid)?.userId ?? null;
  }

  /**
   * Container slots bound execution, not warm runners. When work waits for a
   * slot and the container pool is full, close the runner that has been idle
   * the longest (an early idle timeout) so the waiting work can start once it
   * exits. Host runners are never reclaimed: Host mode has no global process
   * pool (CLAUDE.md §4). Returns true when a runner was asked to close.
   */
  private reclaimIdleContainerRunner(waitingGroupJid?: string): boolean {
    if (this.shuttingDown) return false;
    const globalAtLimit =
      this.activeContainerCount >= getSystemSettings().maxConcurrentContainers;
    const blockedJid =
      waitingGroupJid ??
      [...this.waitingGroups].find(
        (jid) => !this.isHostMode(jid) && !this.hasCapacityFor(jid),
      );
    const userLimitCheck =
      blockedJid && !this.isHostMode(blockedJid) && this.userConcurrentLimitFn
        ? this.userConcurrentLimitFn(blockedJid)
        : undefined;
    const userAtLimit = userLimitCheck ? !userLimitCheck.allowed : false;
    if (!globalAtLimit && !userAtLimit) {
      return false;
    }
    const waitingUserId = userAtLimit ? (userLimitCheck?.userId ?? null) : null;
    // getUserId runs the whole per-user limit check, which walks every
    // workspace; resolve each lane once, not in every loop and comparison.
    const sameUser = new Map<string, boolean>();
    const ownedByWaitingUser = (jid: string): boolean => {
      let same = sameUser.get(jid);
      if (same === undefined) {
        same = this.getUserId(jid) === waitingUserId;
        sameUser.set(jid, same);
      }
      return same;
    };
    // A runner or lane that competes for the slot the waiting work needs.
    const competes = (jid: string): boolean =>
      globalAtLimit || !waitingUserId || ownedByWaitingUser(jid);
    let closing = 0;
    const idle: Array<{ jid: string; state: GroupState }> = [];
    for (const [jid, state] of this.groups) {
      if (state.active && state.closing === 'reclaim' && competes(jid)) {
        closing++;
      }
      if (this.isIdleContainerRunner(jid, state)) idle.push({ jid, state });
    }
    if (idle.length === 0) return false;
    // Only lanes with no runner of their own need a new slot, and each runner
    // already closing frees one.
    const runnerKeys = new Set<string>();
    for (const [jid, state] of this.groups) {
      if (state.active) runnerKeys.add(this.getSerializationKey(jid));
    }
    let demand = 0;
    for (const jid of this.waitingGroups) {
      const state = this.groups.get(jid);
      if (
        state &&
        (state.pendingMessages || state.pendingTasks.length > 0) &&
        !runnerKeys.has(this.getSerializationKey(jid)) &&
        !this.isHostMode(jid) &&
        !this.isMutationPaused(jid) &&
        competes(jid)
      ) {
        demand++;
      }
    }
    if (closing >= demand) return false;
    // Longest idle first; the costlier checks run only until one passes.
    idle.sort((a, b) => {
      if (waitingUserId) {
        const aSameUser = ownedByWaitingUser(a.jid) ? 0 : 1;
        const bSameUser = ownedByWaitingUser(b.jid) ? 0 : 1;
        if (aSameUser !== bSameUser) return aSameUser - bSameUser;
      }
      return (a.state.idleSince ?? 0) - (b.state.idleSince ?? 0);
    });
    const victim = idle.find(
      ({ jid, state }) =>
        competes(jid) && this.owesNoWorkOutsideQueue(jid, state),
    );
    if (!victim) return false;
    victim.state.closing = 'reclaim';
    logger.info(
      {
        groupJid: victim.jid,
        idleMs: Date.now() - (victim.state.idleSince ?? Date.now()),
        waitingCount: demand,
      },
      'Closing the longest-idle container runner to free a slot for waiting work',
    );
    this.closeStdin(victim.jid);
    return true;
  }

  /** An idle warm container runner whose GroupQueue state owes nothing. */
  private isIdleContainerRunner(jid: string, state: GroupState): boolean {
    return (
      state.active &&
      state.runnerRuntime === 'container' &&
      // Scheduled-task runners close themselves when their run ends.
      (!state.activeRunnerIsTask || jid.includes('#agent:')) &&
      !state.queryInFlight &&
      state.idleSince != null &&
      !state.idleFromContinuation &&
      !state.backgroundQueryId &&
      !state.closing &&
      !state.stopRequested &&
      !state.restarting &&
      !state.drainSentinelWritten &&
      !state.pendingMessages &&
      state.pendingTasks.length === 0 &&
      !state.hasIpcInjectedMessages &&
      state.ipcOwedSinceAt === null &&
      state.pendingIpcDeliveries.size === 0 &&
      !!state.groupFolder &&
      !this.isMutationPaused(jid)
    );
  }

  /** No IPC input left on disk and nothing the host reports for the lane. */
  private owesNoWorkOutsideQueue(jid: string, state: GroupState): boolean {
    if (this.hasRemainingIpcMessages(state.groupFolder!, state.agentId)) {
      return false;
    }
    try {
      return !(this.idleReclaimBlockerFn?.(jid) ?? false);
    } catch (err) {
      logger.warn({ groupJid: jid, err }, 'Idle reclaim blocker failed');
      return false;
    }
  }

  /**
   * Run `fn` while stops aimed at the runner serving `runtimeJid` wait for
   * its current query to end: that runner finishes and delivers the turn,
   * then closes instead of serving another query, and `onRunnerExit` runs
   * after its teardown and before the lane drains again. Used when a runner's
   * own tool call commits a change that would otherwise stop it mid-turn.
   */
  async deferStopsToQueryEnd<T>(
    runtimeJid: string,
    onRunnerExit: (runnerJid: string) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.getSerializationKey(runtimeJid);
    const current = this.queryEndStopDeferrals.get(key);
    this.queryEndStopDeferrals.set(key, {
      count: (current?.count ?? 0) + 1,
      onRunnerExit,
    });
    try {
      return await fn();
    } finally {
      const entry = this.queryEndStopDeferrals.get(key);
      if (entry && entry.count > 1) entry.count -= 1;
      else this.queryEndStopDeferrals.delete(key);
    }
  }

  /** Close `runnerJid` after its current query; idle runners close now. */
  private closeAfterQuery(
    runnerJid: string,
    onRunnerExit: (runnerJid: string) => void,
  ): void {
    const state = this.getGroup(runnerJid);
    state.closing = 'after_query';
    // Repeated deferrals in one turn all want the same clean-up once.
    state.afterRunnerExit ??= onRunnerExit;
    if (!state.queryInFlight && !state.backgroundQueryId) {
      this.closeStdin(runnerJid);
    }
  }

  /** Reset per-runner close bookkeeping and run the after-exit callbacks. */
  private settleRunnerExit(groupJid: string, state: GroupState): void {
    const callback = state.afterRunnerExit;
    state.afterRunnerExit = null;
    state.closing = null;
    state.idleSince = null;
    state.idleFromContinuation = false;
    state.backgroundQueryId = null;
    try {
      callback?.(groupJid);
    } catch (err) {
      logger.error({ groupJid, err }, 'After-runner-exit callback failed');
    }
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
   * Write _drain to the exact conversation runner, or the main runner that
   * owns this serialization key. This must target the runner state rather than
   * the caller's group state because sibling JIDs can share one process.
   */
  private requestDrainForActiveRunner(
    groupJid: string,
    reason: string,
  ): boolean {
    const directState = this.groups.get(groupJid);
    const exactConversationRunner =
      directState?.active &&
      directState.agentId !== null &&
      groupJid.endsWith(`#agent:${directState.agentId}`);
    const activeRunner = exactConversationRunner
      ? groupJid
      : this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return false;

    const runnerState = this.getGroup(activeRunner);
    if (
      !runnerState.active ||
      !runnerState.groupFolder ||
      (runnerState.agentId !== null && !exactConversationRunner)
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

  /**
   * List every virtual-JID runner that belongs to the same folder family as
   * `baseJid` (i.e. sessions `{...}#agent:{id}`), excluding the base JID itself — whether it is actively
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
    // Restart the idle window at the user's latest message: stuck detection
    // must measure silence *after* the inject, not since the previous turn's
    // last output — otherwise a follow-up injected into a long-idle warm
    // runner would look instantly stuck (#618).
    const injectedAt = Date.now();
    state.lastActivityAt = injectedAt;
    state.ipcOwedSinceAt ??= injectedAt;
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

        // Remove every Runner-visible copy before committing the DB cursor.
        // A failed Runner unlink can otherwise leave a claim that is replayed
        // after this healthy receipt has already advanced durable state.
        if (!this.discardDeliveryIpcFiles(state, new Set([first.deliveryId]))) {
          throw new Error(
            `Failed to remove acknowledged IPC claim ${first.deliveryId}`,
          );
        }
        commit([first]);
        state.pendingIpcDeliveries.delete(first.deliveryId);
        state.pendingIpcQueryIds?.delete(first.deliveryId);
        state.acknowledgedIpcDeliveryIds.delete(first.deliveryId);
        committed.push(first);
      }
    }
    return committed;
  }

  markRunnerQueryIdle(
    groupJid: string,
    options?: { preserveIpcDebt?: boolean; backgroundWork?: boolean },
  ): void {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || !state.queryInFlight) return;
    // Truncation/compaction continues report queryIdle even though they
    // refused later user IPC (acceptIpc=false). Wiping the #618/#622 debt
    // clock here hides a leftover IPC file from stuck recovery.
    if (options?.preserveIpcDebt) {
      const hasPendingReceipts = state.pendingIpcDeliveries?.size > 0;
      const hasPendingFiles = Boolean(
        state.groupFolder &&
        this.hasRemainingIpcMessages(state.groupFolder, state.agentId),
      );
      if (hasPendingReceipts || hasPendingFiles) return;
    }
    const completedQueryId = state.queryId;
    state.queryInFlight = false;
    state.ipcOwedSinceAt = null;
    state.queryId = null;
    state.queryStartedAt = null;
    state.announcedQueryId = null;
    state.pendingInterruptQueryId = null;
    state.currentQueryCoveredMessageIds = new Set();
    state.idleSince = Date.now();
    state.idleFromContinuation = options?.preserveIpcDebt === true;
    state.backgroundQueryId =
      options?.backgroundWork === true ? completedQueryId : null;
    if (state.closing === 'after_query' && !state.backgroundQueryId) {
      this.closeStdin(groupJid);
    }
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
    // Work already waiting for a container slot can take this one now.
    if (this.waitingGroups.size > 0) this.reclaimIdleContainerRunner();
  }

  /**
   * The runner answered `inputTurnId` and only its background tasks keep that
   * input open. End the query for the lane, so the next input is delivered
   * now instead of waiting for every task, while the input itself stays
   * unacknowledged until the runner settles it. Refused once the host has
   * published a later input under the current query: then that input, not
   * the held one, is what the query is waiting on.
   */
  markRunnerBackgroundOnly(groupJid: string, inputTurnId: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || !state.queryInFlight || !state.queryId) return false;
    for (const [deliveryId, queryId] of state.pendingIpcQueryIds ?? []) {
      if (queryId === state.queryId && deliveryId !== inputTurnId) {
        return false;
      }
    }
    this.markRunnerQueryIdle(groupJid, { backgroundWork: true });
    return true;
  }

  /** Query whose input is answered but still held open by background tasks
   * while no query is in flight; null otherwise. */
  getBackgroundQueryId(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || state.queryInFlight) return null;
    return state.backgroundQueryId ?? null;
  }

  getActiveQueryId(groupJid: string): string | null {
    const ownState = this.groups.get(groupJid);
    const state =
      ownState?.active && ownState.queryInFlight
        ? ownState
        : this.resolveActiveState(groupJid);
    return state?.active && state.queryInFlight ? state.queryId : null;
  }

  /** Terminal DB message id covered by a still-pending IPC input delivery. */
  getPendingIpcDeliveryMessageId(
    groupJid: string,
    deliveryId: string,
  ): string | null {
    return (
      this.groups.get(groupJid)?.pendingIpcDeliveries?.get(deliveryId)?.cursor
        .id ?? null
    );
  }

  getPublishedIpcQueryId(groupJid: string, deliveryId: string): string | null {
    const state = this.groups.get(groupJid);
    if (!state?.active || !state.pendingIpcDeliveries.has(deliveryId))
      return null;
    return state.pendingIpcQueryIds?.get(deliveryId) ?? null;
  }

  /** True only when the immutable DB batch owned by the active query includes
   * this physical input. Used by provider-level semantic coalescing so an
   * unrelated query can never be interrupted merely because it shares a lane. */
  activeQueryExclusivelyCoversMessage(
    groupJid: string,
    messageId: string,
  ): boolean {
    const ownState = this.groups.get(groupJid);
    const state =
      ownState?.active && ownState.queryInFlight
        ? ownState
        : this.resolveActiveState(groupJid);
    if (!state?.active || !state.queryInFlight || !state.queryId) return false;
    const covered = state.currentQueryCoveredMessageIds;
    return covered?.size === 1 && covered.has(messageId);
  }

  /** Reserve the next logical query before asynchronous prompt expansion.
   * This closes the idle race where a newly-arriving message could bypass a
   * durable queued follow-up while it is being prepared for IPC injection. */
  reserveNextQuery(groupJid: string): string | null {
    const state = this.resolveActiveState(groupJid);
    if (!state?.active || state.queryInFlight || state.closing) {
      return null;
    }
    state.queryInFlight = true;
    state.idleSince = null;
    state.queryId = randomUUID();
    state.queryStartedAt = Date.now();
    state.announcedQueryId = null;
    state.pendingInterruptQueryId = null;
    state.currentQueryCoveredMessageIds = new Set();
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
    // A reservation released before announceReservedQuery was never shown
    // to clients: publishing its terminal only sends a run_finished for a
    // runId no client knows.
    const wasAnnounced = state.announcedQueryId === expectedQueryId;
    state.queryInFlight = false;
    state.ipcOwedSinceAt = null;
    state.queryId = null;
    state.queryStartedAt = null;
    state.announcedQueryId = null;
    state.pendingInterruptQueryId = null;
    state.currentQueryCoveredMessageIds = new Set();
    if (wasAnnounced) {
      this.announceQueryFinish(
        groupJid,
        expectedQueryId,
        notifyIdle ? 'completed' : 'released',
      );
    }
    if (notifyIdle) {
      try {
        this.onQueryIdleFn?.(groupJid, expectedQueryId);
      } catch (err) {
        logger.error({ groupJid, err }, 'onQueryIdle callback failed');
      }
    }
    return true;
  }

  private snapshotStuckRecoveryCandidate(
    jid: string,
    state: GroupState,
    now: number,
    idleThresholdMs: number,
    ipcForceThresholdMs = Number.POSITIVE_INFINITY,
  ): StuckRecoveryCandidate | null {
    if (!state.active) return null;
    if (state.activeRunnerIsTask) return null;
    // Warm follow-ups are IPC-injected without re-arming pendingMessages, so
    // a wedged in-flight turn with injected input was invisible here (#618).
    // The dedicated debt timestamp is cleared when the query reports idle;
    // unlike hasIpcInjectedMessages, it does not persist for the runner's
    // lifetime and ordinary output never refreshes it.
    const ipcOwedSinceAt = state.ipcOwedSinceAt ?? null;
    const hasIpcOwed = ipcOwedSinceAt !== null && state.queryInFlight;
    if (!state.pendingMessages && !hasIpcOwed) return null;
    if (state.agentId !== null) return null;
    if (state.restarting) return null;
    const lastActivityAt = state.lastActivityAt ?? 0;
    if (lastActivityAt <= 0) return null;
    const idleMs = now - lastActivityAt;
    const ipcOwedMs = hasIpcOwed ? Math.max(0, now - ipcOwedSinceAt) : null;
    const reachedIdleThreshold = idleMs >= idleThresholdMs;
    const reachedAbsoluteIpcCeiling =
      ipcOwedMs !== null && ipcOwedMs >= ipcForceThresholdMs;
    if (!reachedIdleThreshold && !reachedAbsoluteIpcCeiling) return null;
    return {
      jid,
      idleMs,
      reason: hasIpcOwed ? 'ipc_injected' : 'pending_messages',
      runtime:
        state.runnerRuntime ??
        (state.containerName !== null ? 'container' : 'host'),
      runnerGeneration: state.runnerGeneration ?? 0,
      queryId: state.queryId,
      runnerPid: state.process?.pid ?? null,
      ipcOwedSinceAt,
      ipcOwedMs,
    };
  }

  getStuckPendingGroups(
    idleThresholdMs: number,
    ipcForceThresholdMs = Number.POSITIVE_INFINITY,
  ): StuckRecoveryCandidate[] {
    const now = Date.now();
    const stuck: StuckRecoveryCandidate[] = [];
    for (const [jid, state] of this.groups.entries()) {
      const candidate = this.snapshotStuckRecoveryCandidate(
        jid,
        state,
        now,
        idleThresholdMs,
        ipcForceThresholdMs,
      );
      if (candidate) stuck.push(candidate);
    }
    return stuck;
  }

  /**
   * Re-snapshot a candidate after an asynchronous CPU probe and accept it only
   * if the exact runner/query/debt identity is unchanged. This synchronous
   * check closes the probe-to-restart TOCTOU window: a completed old turn or a
   * newly-started healthy turn must never be killed by its predecessor's stale
   * recovery decision.
   */
  revalidateStuckRecoveryCandidate(
    candidate: StuckRecoveryCandidate,
    idleThresholdMs: number,
    ipcForceThresholdMs = Number.POSITIVE_INFINITY,
  ): StuckRecoveryCandidate | null {
    const state = this.groups.get(candidate.jid);
    if (!state) return null;
    const current = this.snapshotStuckRecoveryCandidate(
      candidate.jid,
      state,
      Date.now(),
      idleThresholdMs,
      ipcForceThresholdMs,
    );
    if (!current) return null;
    if (
      current.runnerGeneration !== candidate.runnerGeneration ||
      current.queryId !== candidate.queryId ||
      current.runtime !== candidate.runtime ||
      current.runnerPid !== candidate.runnerPid ||
      current.reason !== candidate.reason ||
      current.ipcOwedSinceAt !== candidate.ipcOwedSinceAt
    ) {
      return null;
    }
    return current;
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
    if (state.closing) return false;
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

  requiresInteractionModeRestart(
    groupJid: string,
    interactionMode: InteractionMode,
  ): boolean {
    const state = this.resolveActiveState(groupJid);
    return state !== null && state.interactionMode !== interactionMode;
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
      this.reclaimIdleContainerRunner(groupJid);
      return;
    }

    this.waitingGroups.delete(groupJid);
    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void | boolean>,
    options?: { onDropped?: () => void },
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
      this.reclaimIdleContainerRunner(groupJid);
      return true;
    }

    // Run immediately
    this.waitingGroups.delete(groupJid);
    this.runTask(groupJid, {
      id: taskId,
      groupJid,
      fn,
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
      selectedProviderId?: string | null;
      feishuCliAccountId?: string | null;
      interactionMode?: InteractionMode;
      onDeferredInterruptFailure?: (queryId: string) => void;
    },
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = opts.containerName;
    state.runnerRuntime = opts.containerName === null ? 'host' : 'container';
    state.displayName = opts.displayName || null;
    if (opts.groupFolder) state.groupFolder = opts.groupFolder;
    state.agentId = opts.agentId || null;
    state.selectedProviderId = opts.selectedProviderId ?? null;
    state.feishuCliAccountId = opts.feishuCliAccountId ?? null;
    state.interactionMode = opts.interactionMode ?? null;
    state.deferredInterruptFailure = opts.onDeferredInterruptFailure;
    const pendingInterruptQueryId = state.pendingInterruptQueryId;
    if (
      pendingInterruptQueryId &&
      state.queryInFlight &&
      state.queryId === pendingInterruptQueryId
    ) {
      // The companion note can arrive while the cold runner is still being
      // prepared and has no IPC path. Materialize that query-bound interrupt
      // as soon as registration creates a stable path; a later query can never
      // inherit it because every query boundary clears the pending identity.
      state.pendingInterruptQueryId = null;
      if (
        !this.interruptQuery(
          groupJid,
          pendingInterruptQueryId,
          state.pendingInterruptReason,
        )
      ) {
        state.deferredInterruptFailure?.(pendingInterruptQueryId);
        logger.warn(
          { groupJid, pendingInterruptQueryId },
          'Failed to publish deferred query interrupt after runner registration',
        );
      }
    } else if (pendingInterruptQueryId) {
      state.pendingInterruptQueryId = null;
    }
    // An incompatible suffix or a new message can be queued after runForGroup
    // marks the lane active but before the child process registers. The first
    // drain attempt has no groupFolder/input path yet; close that boot window
    // here so pending work does not wait for the warm runner's idle timeout.
    if (
      state.pendingMessages &&
      !state.activeRunnerIsTask &&
      !state.drainSentinelWritten
    ) {
      const wrote = this.writeDrainSentinel(state as ActiveGroupState);
      if (wrote) state.drainSentinelWritten = true;
    }
  }

  /**
   * Resolve IPC input directory for a group state.
   * Sub-agents use a nested path: data/ipc/{folder}/agents/{agentId}/input/
   */
  private resolveIpcInputDir(state: ActiveGroupState): string {
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
    // A runner on its way out must not take a new turn; the caller's cold
    // start runs once it has exited.
    if (state.closing) return 'no_active';

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

    if (
      requirements?.interactionMode !== undefined &&
      state.interactionMode !== requirements.interactionMode
    ) {
      this.requestDrainForActiveRunner(
        groupJid,
        'Draining runner before switching interaction mode',
      );
      logger.info(
        {
          groupJid,
          activeInteractionMode: state.interactionMode,
          requiredInteractionMode: requirements.interactionMode,
        },
        'Rejected warm IPC injection across interaction modes',
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
    const startsCurrentQuery = !state.queryInFlight || !state.queryId;
    const queryRunId = startsCurrentQuery ? randomUUID() : state.queryId!;

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
        const coveredHaveAnySequence = deliveryTarget.coveredCursors.some(
          (cursor) => cursor.sequence !== undefined,
        );
        const coveredAllHaveSequence = deliveryTarget.coveredCursors.every(
          (cursor) => cursor.sequence !== undefined,
        );
        const sequenceShapeInvalid =
          coveredHaveAnySequence || deliveryTarget.cursor.sequence !== undefined
            ? !coveredAllHaveSequence ||
              deliveryTarget.cursor.sequence === undefined ||
              maximum?.sequence !== deliveryTarget.cursor.sequence
            : false;
        if (
          !maximum ||
          maximum.timestamp !== deliveryTarget.cursor.timestamp ||
          maximum.id !== deliveryTarget.cursor.id ||
          sequenceShapeInvalid
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
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          images,
          queryRunId,
          sourceJid,
          channelContext,
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
      // Idle window restarts at the user's latest injected message (#618).
      const injectedAt = Date.now();
      state.lastActivityAt = injectedAt;
      state.ipcOwedSinceAt ??= injectedAt;
      if (receipt) {
        state.pendingIpcDeliveries ??= new Map();
        state.pendingIpcDeliveries.set(receipt.deliveryId, receipt);
        state.pendingIpcQueryIds ??= new Map();
        state.pendingIpcQueryIds.set(receipt.deliveryId, queryRunId);
        // Claim eligibility is observed synchronously in the same stack as
        // rename+registration. A blocked claim remains in both the file/ledger
        // until a later durable cursor advance makes it provably contiguous.
        this.isIpcDeliveryCommitEligibleFn?.(receipt);
      }
      if (!state.queryInFlight || !state.queryId) {
        state.queryInFlight = true;
        state.idleSince = null;
        state.queryId = queryRunId;
        state.queryStartedAt = Date.now();
        state.announcedQueryId = null;
        state.pendingInterruptQueryId = null;
        state.currentQueryCoveredMessageIds = new Set(
          receipt
            ? (receipt.coveredCursors ?? [receipt.cursor]).map(
                (cursor) => cursor.id,
              )
            : [],
        );
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
  ): void {
    const inputDir = agentId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
      : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    for (const name of [
      '_drain',
      '_close',
      '_interrupt',
      INTERRUPT_REASON_SENTINEL,
    ]) {
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
      this.isRecentlyStopped(groupJid) &&
      !this.mutationPreserveStopJids.has(groupJid)
    ) {
      return;
    }
    try {
      if (!this.hasRemainingIpcMessages(state.groupFolder, state.agentId))
        return;

      if (state.agentId && this.onUnconsumedAgentIpcFn) {
        logger.warn(
          { groupJid, agentId: state.agentId },
          `Unconsumed IPC messages found after ${context}, re-enqueuing`,
        );
        this.onUnconsumedAgentIpcFn(groupJid, state.agentId);
      } else {
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
      if (
        !this.discardDeliveryIpcFiles(
          state,
          new Set(receipts.map((r) => r.deliveryId)),
        )
      ) {
        throw new Error('Failed to remove unacknowledged IPC delivery files');
      }
      if (!this.onUnacknowledgedIpcDeliveriesFn) {
        throw new Error(
          'unacknowledged IPC delivery recovery callback is not configured',
        );
      }
      this.onUnacknowledgedIpcDeliveriesFn(groupJid, receipts);
      state.pendingIpcDeliveries.clear();
      state.pendingIpcQueryIds?.clear();
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
  ): boolean {
    if (!state.groupFolder || deliveryIds.size === 0) return true;
    const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
    let filenames: string[];
    try {
      filenames = fs.readdirSync(inputDir).filter(isIpcInputPayloadFilename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      logger.warn(
        { inputDir, err },
        'Failed to list IPC input directory while discarding delivery files',
      );
      return false;
    }
    let complete = true;
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
        complete = false;
        logger.warn(
          { filepath, err },
          'Failed to inspect/discard unacknowledged IPC delivery file',
        );
      }
    }
    return complete;
  }

  private abandonUnacknowledgedIpcDeliveries(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!state.pendingIpcDeliveries || state.pendingIpcDeliveries.size === 0)
      return;
    state.acknowledgedIpcDeliveryIds ??= new Set();
    const receipts = [...state.pendingIpcDeliveries.values()];
    if (
      !this.discardDeliveryIpcFiles(
        state,
        new Set(receipts.map((r) => r.deliveryId)),
      )
    ) {
      throw new Error('Failed to remove abandoned IPC delivery files');
    }
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
    state.pendingIpcQueryIds?.clear();
    state.acknowledgedIpcDeliveryIds.clear();
  }

  private hasRemainingIpcMessages(
    groupFolder: string,
    agentId?: string | null,
  ): boolean {
    const inputDir = agentId
      ? path.join(DATA_DIR, 'ipc', groupFolder, 'agents', agentId, 'input')
      : path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      const files = fs.readdirSync(inputDir);
      return files.some(isIpcInputPayloadFilename);
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
   * Gracefully retire only runners using the refreshed Provider. The drain
   * sentinel is consumed after the current query, so a read-only usage poll
   * can rotate credentials without interrupting unrelated or in-flight work.
   * A lane that is active but has not registered its process yet is still
   * launching: it reads the rotated credentials when it spawns, and its
   * selectedProviderId may be left over from the previous run.
   */
  drainProviderRunnersForCredentialRefresh(providerId: string): number {
    let drained = 0;
    for (const [jid, state] of this.groups) {
      if (
        !state.active ||
        !state.process ||
        !state.groupFolder ||
        state.selectedProviderId !== providerId ||
        state.drainSentinelWritten
      ) {
        continue;
      }
      if (!this.writeDrainSentinel(state as ActiveGroupState)) continue;
      state.drainSentinelWritten = true;
      drained++;
      logger.info(
        { groupJid: jid, groupFolder: state.groupFolder, providerId },
        'Sent drain signal after provider credential refresh',
      );
    }
    return drained;
  }

  /**
   * Retire the runners of one conversation after its model selection changed.
   * A warm runner keeps the provider environment it was spawned with, so the
   * next message must reach a fresh one. The drain sentinel lets an in-flight
   * query finish first. With a concrete target, runners already on it are
   * left alone; a null target (back to the default) cannot be predicted
   * before pool selection, so every active runner is drained.
   */
  drainRunnersForModelSelection(
    groupJids: readonly string[],
    targetProviderId: string | null,
  ): number {
    let drained = 0;
    for (const jid of new Set(groupJids)) {
      const state = this.groups.get(jid);
      if (
        !state?.active ||
        !state.groupFolder ||
        state.drainSentinelWritten ||
        (targetProviderId !== null &&
          state.selectedProviderId === targetProviderId)
      ) {
        continue;
      }
      if (!this.writeDrainSentinel(state as ActiveGroupState)) continue;
      state.drainSentinelWritten = true;
      drained++;
      logger.info(
        { groupJid: jid, groupFolder: state.groupFolder, targetProviderId },
        'Sent drain signal after conversation model selection changed',
      );
    }
    return drained;
  }

  /**
   * Interrupt the current query for the same chat only (do not cross-interrupt
   * sibling chats that share a serialized runner/folder).
   *
   * Writes a _interrupt sentinel that agent-runner detects and calls
   * query.interrupt(). The container stays alive and accepts new messages.
   * An explicit `stop` also writes the reason; without it the runner treats
   * the interrupt as a steer.
   */
  interruptQuery(
    groupJid: string,
    expectedQueryId?: string,
    reason: InterruptReason = 'steer',
  ): boolean {
    // During cold boot the exact JID is active before registerProcess supplies
    // groupFolder. Prefer it so a provider companion cannot miss the brief
    // pre-IPC interrupt window; registered sibling JIDs still resolve through
    // their shared runner as before.
    const ownState = this.groups.get(groupJid);
    const state =
      ownState?.active && ownState.queryInFlight
        ? ownState
        : this.resolveActiveState(groupJid);
    if (!state) return false;
    // An explicit stop also reaches background tasks that outlived their
    // answered query; a steer has nothing to redirect there.
    const backgroundQueryId =
      !state.queryInFlight && reason === 'stop' && state.groupFolder
        ? (state.backgroundQueryId ?? null)
        : null;
    if (!state.queryInFlight && !backgroundQueryId) return false;
    const targetQueryId = backgroundQueryId ?? state.queryId;
    if (expectedQueryId && targetQueryId !== expectedQueryId) return false;

    // 只取消等待中的 retry 定时器（如果有），不重置 retryCount —— 不让用户
    // 中断把已积累的 backoff 进度归零。
    this.cancelRetryTimer(state);

    if (!state.groupFolder) {
      if (!state.queryId) return false;
      const stopPending =
        state.pendingInterruptQueryId === state.queryId &&
        state.pendingInterruptReason === 'stop';
      state.pendingInterruptQueryId = state.queryId;
      state.pendingInterruptReason = stopPending ? 'stop' : reason;
      logger.info(
        { groupJid, queryId: state.queryId },
        'Deferred query interrupt until runner registration',
      );
      return true;
    }
    state.pendingInterruptQueryId = null;

    const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      try {
        fs.chmodSync(inputDir, 0o700);
      } catch {
        /* ignore */
      }
      // Bind the sentinel to this exact host query. The runner may start after
      // a long cold-image delay, while an old file can survive a host crash;
      // query identity—not mtime—distinguishes those cases safely.
      const queryId = targetQueryId ?? '';
      if (reason === 'stop') {
        // Before `_interrupt`: the runner reads the reason once it sees it.
        // A steer leaves a stop not yet consumed for this query in place.
        publishSentinel(
          inputDir,
          INTERRUPT_REASON_SENTINEL,
          JSON.stringify({ queryId, reason }),
        );
      }
      publishSentinel(inputDir, '_interrupt', queryId);
      logger.info({ groupJid, inputDir, reason }, 'Interrupt sentinel written');
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, inputDir, err },
        'Failed to write interrupt sentinel',
      );
      return false;
    }
  }

  private markStopped(groupJid: string, preserveQueuedWork: boolean): void {
    const lane = this.getSerializationKey(groupJid);
    if (preserveQueuedWork) this.mutationStoppedLanes.add(lane);
    else this.mutationStoppedLanes.delete(lane);
    this.recentlyStoppedLanes.set(lane, Date.now());
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
    // A runner whose own tool call is committing this mutation finishes and
    // delivers its turn first; it closes afterwards (deferStopsToQueryEnd).
    const deferral = preserveQueuedWork
      ? this.queryEndStopDeferrals.get(this.getSerializationKey(groupJid))
      : undefined;
    const deferredRunner = deferral ? this.findActiveRunnerFor(groupJid) : null;
    if (deferral && deferredRunner) {
      this.closeAfterQuery(deferredRunner, deferral.onRunnerExit);
      logger.info(
        { groupJid, runnerJid: deferredRunner },
        'Mutation stop deferred until the runner finishes its current query',
      );
      return;
    }
    const requestedState = this.getGroup(groupJid);
    requestedState.stopRequested = true;
    if (!preserveQueuedWork) {
      requestedState.pendingMessages = false;
      this.discardPendingTasks(requestedState, groupJid);
      this.clearRetryTimer(requestedState);
      try {
        this.onLaneDiscardedFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onLaneDiscarded callback failed');
      }
    } else if (!this.parkTaskForMutation(requestedState, groupJid)) {
      requestedState.pendingMessages = true;
      this.waitingGroups.add(groupJid);
    }
    // 标记 stop 时间：runForGroup finally + index.ts OOM 计数 + 主消息循环
    // 都用这个时间窗判断 user-stopped vs 真 OOM / IPC-injected drain。
    if (requestedState.groupFolder)
      this.markStopped(groupJid, preserveQueuedWork);
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
    if (state.groupFolder) this.markStopped(targetJid, preserveQueuedWork);
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
        await this.waitForRunnerTeardown(state, 2000);
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
      await this.waitForRunnerTeardown(state, 20000);

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
          await this.waitForRunnerTeardown(state, 5000);
        } else if (state.process) {
          killProcessTree(state.process, 'SIGKILL');
          await this.waitForRunnerTeardown(state, 5000);
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
      this.recentlyStoppedLanes.delete(this.getSerializationKey(groupJid));
    }
    state.stopRequested = false;
    const isHostMode = this.isHostMode(groupJid);
    state.active = true;
    state.runnerGeneration = (state.runnerGeneration ?? 0) + 1;
    state.runnerRuntime = isHostMode ? 'host' : 'container';
    state.activeRunnerIsTask = false;
    state.lastActivityAt = Date.now();
    state.queryInFlight = true;
    state.ipcOwedSinceAt = null;
    state.queryId = randomUUID();
    state.queryStartedAt = Date.now();
    state.announcedQueryId = null;
    state.pendingInterruptQueryId = null;
    state.pendingMessages = false;
    state.messageRetrySnapshot = null;
    state.currentQueryCoveredMessageIds = new Set();
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
        (exitFolder ? this.isRecentlyStopped(groupJid) : false);
      if (state.groupFolder) {
        try {
          this.cleanupIpcSentinels(state.groupFolder, state.agentId);
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        if (
          this.mutationPreserveStopJids.has(groupJid) &&
          this.isMutationPaused(groupJid)
        ) {
          this.parkUnacknowledgedIpcDeliveries(groupJid, state);
        } else {
          this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
        }
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
      state.ipcOwedSinceAt = null;
      state.lastActivityAt = null;
      state.queryInFlight = false;
      state.backgroundQueryId = null;
      state.queryId = null;
      state.queryStartedAt = null;
      state.announcedQueryId = null;
      state.pendingInterruptQueryId = null;
      state.currentQueryCoveredMessageIds = new Set();
      try {
        this.onRunnerQueryTeardownFn?.(groupJid);
      } catch (err) {
        logger.error(
          { groupJid, err },
          'onRunnerQueryTeardown callback failed',
        );
      }
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
      state.runnerRuntime = null;
      state.interactionMode = null;
      state.deferredInterruptFailure = undefined;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      this.settleRunnerExit(groupJid, state);
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
      if (state.restarting) {
        logger.debug(
          { groupJid, folder: exitFolder },
          'Restart in progress; deferring replacement launch to restartGroup',
        );
      } else if (!isStopRequested || preserveMutationWork) {
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
    state.runnerGeneration = (state.runnerGeneration ?? 0) + 1;
    state.runnerRuntime = isHostMode ? 'host' : 'container';
    state.activeRunnerIsTask = true;
    state.activeTask = task;
    state.lastActivityAt = Date.now();
    state.queryInFlight = groupJid.includes('#agent:');
    state.ipcOwedSinceAt = null;
    state.queryId = state.queryInFlight ? randomUUID() : null;
    state.queryStartedAt = state.queryInFlight ? Date.now() : null;
    state.announcedQueryId = null;
    state.pendingInterruptQueryId = null;
    state.currentQueryCoveredMessageIds = new Set();
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
          this.cleanupIpcSentinels(state.groupFolder, state.agentId);
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to clean up IPC sentinels');
        }
        if (
          this.mutationPreserveStopJids.has(groupJid) &&
          this.isMutationPaused(groupJid)
        ) {
          this.parkUnacknowledgedIpcDeliveries(groupJid, state);
        } else {
          this.recoverUnacknowledgedIpcDeliveries(groupJid, state);
        }
        this.recoverUnconsumedIpc(groupJid, state, 'task exit');
      }
      const unfinishedQueryId = state.queryId;
      state.active = false;
      state.activeRunnerIsTask = false;
      state.activeTask = null;
      state.drainSentinelWritten = false;
      state.lastActivityAt = null;
      state.ipcOwedSinceAt = null;
      state.queryInFlight = false;
      state.backgroundQueryId = null;
      state.queryId = null;
      state.queryStartedAt = null;
      state.announcedQueryId = null;
      state.pendingInterruptQueryId = null;
      state.currentQueryCoveredMessageIds = new Set();
      try {
        this.onRunnerQueryTeardownFn?.(groupJid);
      } catch (err) {
        logger.error(
          { groupJid, err },
          'onRunnerQueryTeardown callback failed',
        );
      }
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
      state.runnerRuntime = null;
      state.interactionMode = null;
      state.deferredInterruptFailure = undefined;
      this.activeCount--;
      if (isHostMode) {
        this.activeHostProcessCount--;
      } else {
        this.activeContainerCount--;
      }
      this.settleRunnerExit(groupJid, state);
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
      } else if (this.isMutationPaused(groupJid)) {
        // The slot a paused lane's runner just gave up serves the others.
        this.drainWaiting();
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

    // Up to +20% jitter: a provider outage fails many workspaces at once, and
    // identical delays would replay them all in the same instant.
    const delayMs = Math.round(
      BASE_RETRY_MS *
        Math.pow(2, state.retryCount - 1) *
        (1 + RETRY_JITTER_RATIO * retryJitterSource()),
    );
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
      // The slot a paused lane's runner just gave up serves the others.
      this.drainWaiting();
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
    const task = state.pendingTasks.shift();
    if (task) {
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

    // GC virtual session JIDs (#agent:) once fully idle; without this the
    // groups Map grows with every session ever run. Only virtual JIDs are collected; real chat JIDs are
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
        // fall through to drainWaiting so other waiting groups still get a slot
      }
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  /** Session JIDs (`{jid}#agent:{id}`). */
  private isVirtualJid(jid: string): boolean {
    return jid.includes('#agent:');
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
      const task = state.pendingTasks.shift();
      if (task) {
        this.runTask(jid, task);
      } else if (state.pendingMessages && !state.retryTimer) {
        // Skip if retry timer is pending to avoid duplicate processing
        this.runForGroup(jid, 'drain');
      }
      // If neither pending, skip this group
    }
    if (this.waitingGroups.size > 0) this.reclaimIdleContainerRunner();
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
      const inputDir = state.agentId
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
