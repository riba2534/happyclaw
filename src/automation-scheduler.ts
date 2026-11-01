/**
 * The automation scheduler: one loop per process that fires due
 * automations, carries each run to a terminal state and sends the notices.
 *
 * Every fire is claimed in a single transaction that re-reads the
 * definition, writes the run row and computes the next fire, so a crash
 * can never leave an automation claimed without a run (or a run without an
 * advanced schedule). The partial unique index on live runs backs the
 * overlap rule: an automation never has two queued/running runs.
 *
 * The loop sleeps until the earliest next fire or end time, capped at a 60 s
 * reconcile; changes poke it awake. Agent runs are handed to the runtime as
 * session inputs (deps.injectAutomationInput) and come back through the run
 * sink; scripts and pre-run checks run here.
 */
import crypto from 'node:crypto';

import { CronExpressionParser } from 'cron-parser';

import {
  AUTOMATION_LIMITS,
  AUTOMATION_TERMINAL_RUN_STATUSES,
  buildAutomationRunContext,
  formatAutomationTime,
  type Automation,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
} from './automation.js';
import type {
  AutomationRunOutcome,
  AutomationRunSink,
  AutomationRuntimeDeps,
  AutomationScheduler,
} from './automation-contract.js';
import {
  describePreRunCheckFailure,
  runAutomationScript,
  runPreRunCheck,
} from './automation-precheck.js';
import {
  clearAutomationFailure,
  getAutomation,
  getAutomationRun,
  getLiveAutomationRun,
  getNextAutomationWakeAt,
  inAutomationTransaction,
  insertAutomationRun,
  listActiveAutomations,
  listDueAutomations,
  listEndedAutomationIds,
  listLiveAutomationRuns,
  recordAutomationFailure,
  saveAutomation,
  saveAutomationRun,
  trimAutomationRuns,
} from './automation-store.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

const RECONCILE_INTERVAL_MS = 60_000;
const OVERDUE_RETRY_MS = 1_000;

export const OVERLAP_SKIP_ERROR = '上一次运行还没结束';
const END_AT_REACHED_REASON = '已到结束时间';
const ONCE_DONE_REASON = '一次性运行已完成';
const RESTART_INTERRUPTED_ERROR = '服务重启，运行已中断';
const BOUND_SESSION_GONE_REASON = '绑定的会话已不存在';
const HOST_COMMANDS_DENIED_ERROR =
  '脚本和前置检查只能在管理员的宿主机工作区使用';

const CANCEL_REASON_TEXT: Record<
  Extract<AutomationRunOutcome, { status: 'cancelled' }>['reason'],
  string
> = {
  break: '已停止',
  clear: '会话已清空',
  fresh: '会话已换窗',
  withdrawn: '输入已撤回',
  deleted: '会话或自动化已删除',
};

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return AUTOMATION_TERMINAL_RUN_STATUSES.includes(status);
}

function automationTimezone(automation: Pick<Automation, 'schedule'>) {
  return automation.schedule.timezone || TIMEZONE;
}

/** Whether `expr` is a 5-field cron expression valid in `timezone`. */
export function isValidCronExpression(
  expr: string,
  timezone: string = TIMEZONE,
): boolean {
  if (expr.trim().split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(expr.trim(), { tz: timezone }).next();
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    CronExpressionParser.parse('0 0 * * *', { tz: zone }).next();
    return true;
  } catch {
    return false;
  }
}

/**
 * When the automation fires next, or null for none.
 *
 * - `previous`: the steady state. cron → next slot after the later of now
 *   and the last finish; interval → last finish (or creation) + interval.
 * - `now`: resume, cadence edits and startup recovery. cron → next slot
 *   after now; interval → now + interval.
 *
 * once → its run time; manual → none. Nothing fires after `endAt`.
 */
export function computeNextFireAt(
  automation: Pick<
    Automation,
    'schedule' | 'endAt' | 'lastFinishedAt' | 'createdAt'
  >,
  now: Date,
  basis: 'previous' | 'now' = 'previous',
): string | null {
  const { schedule } = automation;
  let next: number | null = null;
  switch (schedule.kind) {
    case 'cron': {
      if (!schedule.cronExpr) return null;
      const lastFinished =
        basis === 'previous' && automation.lastFinishedAt
          ? Date.parse(automation.lastFinishedAt)
          : NaN;
      const base = Number.isFinite(lastFinished)
        ? Math.max(now.getTime(), lastFinished)
        : now.getTime();
      try {
        next = CronExpressionParser.parse(schedule.cronExpr, {
          tz: automationTimezone(automation),
          currentDate: new Date(base),
        })
          .next()
          .getTime();
      } catch {
        return null;
      }
      break;
    }
    case 'interval': {
      if (!schedule.intervalMs) return null;
      const from =
        basis === 'now'
          ? now.getTime()
          : Date.parse(automation.lastFinishedAt ?? automation.createdAt);
      next = from + schedule.intervalMs;
      break;
    }
    case 'once':
      next = schedule.runAt ? Date.parse(schedule.runAt) : null;
      break;
    case 'manual':
      return null;
  }
  if (next === null || !Number.isFinite(next)) return null;
  if (automation.endAt && next > Date.parse(automation.endAt)) return null;
  return new Date(next).toISOString();
}

/**
 * Reduce an error to what stays the same when an automation keeps failing
 * for the same reason: ids, timestamps, durations and counts change on every
 * run; HTTP statuses, exit codes and signal numbers tell failures apart.
 */
function normalizeAutomationError(error: string): string {
  return error
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '#',
    )
    .replace(/\b[0-9a-f]{12,}\b/gi, '#')
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
      '#',
    )
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|sec|seconds?|m|min|minutes?|h|hr|hours?)\b/gi,
      '#',
    )
    .replace(
      /((?:\b(?:https?(?:\/\d(?:\.\d)?)?|status|code|signal)|退出码)\s*[:=]?\s*\d{1,3}\b)|\b\d+(?:\.\d+)?\b/gi,
      (_match, code: string | undefined) => code ?? '#',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

function errorKey(error: string): string {
  return crypto
    .createHash('sha256')
    .update(normalizeAutomationError(error))
    .digest('hex')
    .slice(0, 32);
}

export function isImRoute(jid: string | null | undefined): jid is string {
  return !!jid && !jid.startsWith('web:');
}

function summarize(text: string | null, max = 300): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export interface AutomationEngineOptions {
  now?: () => Date;
  /** No-output watchdog for scripts; CONTAINER_TIMEOUT by default. */
  scriptIdleTimeoutMs?: () => number;
}

class RunAbort extends Error {}

/** Run history kept per automation; the Web shows the latest 50. */
const RUNS_KEPT = 200;

function setStatusFields(
  automation: Automation,
  status: 'paused' | 'completed',
  reason: string | null,
  nowIso: string,
): void {
  automation.status = status;
  automation.statusReason = reason;
  automation.nextFireAt = null;
  automation.revision += 1;
  automation.updatedAt = nowIso;
}

/**
 * Scheduler and run lifecycle. The service uses the same instance for
 * manual runs, cancellation and status changes so every write goes through
 * one place.
 */
export class AutomationEngine implements AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  /** Pre-run checks and scripts in flight, by run id. */
  private readonly commands = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  readonly now: () => Date;
  private readonly scriptIdleTimeoutMs: () => number;

  constructor(
    private readonly deps: AutomationRuntimeDeps,
    options: AutomationEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scriptIdleTimeoutMs = options.scriptIdleTimeoutMs ?? (() => 1_800_000);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    try {
      this.recover();
    } catch (error) {
      logger.error({ err: error }, 'Automation startup recovery failed');
    }
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Kill commands; the restart marks their runs interrupted.
    for (const controller of this.commands.values()) controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  poke(): void {
    if (!this.started || this.stopped) return;
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const wake = getNextAutomationWakeAt();
    const untilWake = wake
      ? Date.parse(wake) - this.now().getTime()
      : RECONCILE_INTERVAL_MS;
    // Still due after a pass means a fire kept failing: retry, but not in a
    // tight loop.
    const delay =
      untilWake <= 0
        ? OVERDUE_RETRY_MS
        : Math.min(untilWake, RECONCILE_INTERVAL_MS);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  /** One pass: end what reached its end time, fire what is due. */
  tick(): void {
    if (this.stopped) return;
    try {
      const now = this.now();
      const nowIso = now.toISOString();
      for (const id of listEndedAutomationIds(nowIso)) {
        this.completeAutomation(id, END_AT_REACHED_REASON);
      }
      for (const automation of listDueAutomations(nowIso)) {
        try {
          this.fire(automation.id, 'schedule');
        } catch (error) {
          logger.error(
            { err: error, automationId: automation.id },
            'Firing an automation failed',
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Automation scheduler tick failed');
    }
    if (this.started && !this.stopped) this.arm();
  }

  /**
   * Startup: settle runs whose input is gone, record one `missed` run per
   * recurring automation that came due while the service was down (a due
   * `once` still runs, as a backfill), and give automations without a next
   * fire (migrated ones) one computed from now.
   */
  private recover(): void {
    const liveRuns = listLiveAutomationRuns();
    for (const run of liveRuns) {
      const pending =
        getAutomation(run.automationId)?.execution === 'agent' &&
        !!run.inputMessageId &&
        !!run.sessionJid &&
        this.deps.sessionExists(run.sessionJid) &&
        this.deps.isAutomationInputPending({
          sessionJid: run.sessionJid,
          inputMessageId: run.inputMessageId,
        });
      if (!pending) {
        this.finishRun(run.id, 'interrupted', {
          error: RESTART_INTERRUPTED_ERROR,
        });
      }
    }

    const now = this.now();
    const nowIso = now.toISOString();
    for (const automation of listActiveAutomations()) {
      if (automation.endAt && automation.endAt <= nowIso) continue;
      if (automation.nextFireAt && automation.nextFireAt <= nowIso) {
        if (automation.schedule.kind === 'once') {
          this.fire(automation.id, 'backfill');
        } else {
          this.recordMissed(automation.id);
        }
      } else if (
        !automation.nextFireAt &&
        automation.schedule.kind !== 'manual' &&
        !getLiveAutomationRun(automation.id)
      ) {
        // Migrated rows carry no next fire; an interval's live run sets its
        // own when it settles.
        inAutomationTransaction(() => {
          const current = getAutomation(automation.id);
          if (!current || current.status !== 'active') return;
          current.nextFireAt = computeNextFireAt(current, now, 'now');
          saveAutomation(current);
        });
      }
    }
  }

  private recordMissed(automationId: string): void {
    const now = this.now();
    const run = inAutomationTransaction(() => {
      const automation = getAutomation(automationId);
      if (!automation?.nextFireAt) return null;
      const nowIso = now.toISOString();
      const missed = this.newRun(
        automation,
        'schedule',
        'missed',
        nowIso,
        automation.nextFireAt,
      );
      missed.firedAt = null;
      missed.readAt = nowIso;
      insertAutomationRun(missed);
      automation.nextFireAt = computeNextFireAt(automation, now, 'now');
      saveAutomation(automation);
      return { automation, missed };
    });
    if (run) this.emitRun(run.automation, run.missed);
  }

  // ─── Firing ───────────────────────────────────────────────────────────

  private newRun(
    automation: Automation,
    trigger: AutomationRunTrigger,
    status: AutomationRunStatus,
    nowIso: string,
    scheduledFor: string,
  ): AutomationRun {
    return {
      id: crypto.randomUUID(),
      automationId: automation.id,
      trigger,
      status,
      sessionJid: null,
      inputMessageId: null,
      scheduledFor,
      firedAt: nowIso,
      finishedAt: null,
      resultText: null,
      error: null,
      preCheck: null,
      silenced: automation.silentWhenIdle,
      readAt: null,
      createdAt: nowIso,
    };
  }

  /**
   * Claim a scheduled fire: in one transaction re-check that it is still
   * due, write the run (or a `skipped` run when one is still live) and move
   * the schedule on.
   */
  private fire(automationId: string, trigger: 'schedule' | 'backfill'): void {
    const now = this.now();
    const nowIso = now.toISOString();
    const claimed = inAutomationTransaction(() => {
      const automation = getAutomation(automationId);
      if (
        !automation ||
        automation.status !== 'active' ||
        !automation.nextFireAt ||
        automation.nextFireAt > nowIso
      )
        return null;
      const scheduledFor = automation.nextFireAt;
      if (getLiveAutomationRun(automation.id)) {
        if (automation.schedule.kind === 'once') {
          // A once has a single fire: park it until the live (manual) run
          // settles, which puts its run time back, instead of skipping it.
          automation.nextFireAt = null;
          saveAutomation(automation);
          return null;
        }
        const skipped = this.newRun(
          automation,
          trigger,
          'skipped',
          nowIso,
          scheduledFor,
        );
        skipped.error = OVERLAP_SKIP_ERROR;
        skipped.finishedAt = nowIso;
        skipped.readAt = nowIso;
        insertAutomationRun(skipped);
        automation.nextFireAt = computeNextFireAt(automation, now, 'now');
        saveAutomation(automation);
        return { automation, run: skipped };
      }
      const run = this.newRun(
        automation,
        trigger,
        'queued',
        nowIso,
        scheduledFor,
      );
      insertAutomationRun(run);
      automation.lastFiredAt = nowIso;
      // interval counts from the finish and once ends with its run; both
      // get their next fire (if any) when the run settles.
      automation.nextFireAt =
        automation.schedule.kind === 'cron'
          ? computeNextFireAt(automation, now, 'previous')
          : null;
      saveAutomation(automation);
      return { automation, run };
    });
    if (!claimed) return;
    this.emitChanged(claimed.automation);
    this.emitRun(claimed.automation, claimed.run);
    if (claimed.run.status === 'queued') this.launch(claimed.run.id);
  }

  /** Manual run (Web or agent). Throws if a run is still live. */
  startManualRun(automationId: string): AutomationRun | null {
    const nowIso = this.now().toISOString();
    const claimed = inAutomationTransaction(() => {
      const automation = getAutomation(automationId);
      if (!automation || getLiveAutomationRun(automation.id)) return null;
      const run = this.newRun(automation, 'manual', 'queued', nowIso, nowIso);
      insertAutomationRun(run);
      automation.lastFiredAt = nowIso;
      saveAutomation(automation);
      return { automation, run };
    });
    if (!claimed) return null;
    this.emitChanged(claimed.automation);
    this.emitRun(claimed.automation, claimed.run);
    this.launch(claimed.run.id);
    return claimed.run;
  }

  private launch(runId: string): void {
    const task = this.execute(runId).catch((error) => {
      logger.error({ err: error, runId }, 'Automation run failed to start');
      this.finishRun(runId, 'failed', {
        error: `运行启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** The run's row, or RunAbort once it was cancelled or settled elsewhere. */
  private liveRun(runId: string): AutomationRun {
    if (this.stopped) throw new RunAbort();
    const run = getAutomationRun(runId);
    if (!run || isTerminalRunStatus(run.status)) throw new RunAbort();
    return run;
  }

  private async execute(runId: string): Promise<void> {
    try {
      await this.executeSteps(runId);
    } catch (error) {
      if (error instanceof RunAbort) return;
      throw error;
    }
  }

  private async executeSteps(runId: string): Promise<void> {
    let run = this.liveRun(runId);
    const automation = getAutomation(run.automationId);
    if (!automation) throw new RunAbort();

    const billing = this.deps.checkBilling(automation.createdBy);
    if (!billing.ok) {
      this.finishRun(runId, 'failed', { error: billing.reason });
      return;
    }
    const needsHost =
      automation.execution === 'script' || !!automation.preRunCheck;
    if (needsHost && !this.deps.allowsHostCommands(automation.workspaceJid)) {
      this.finishRun(runId, 'failed', { error: HOST_COMMANDS_DENIED_ERROR });
      return;
    }

    // The check decides whether the run happens at all, so it runs before
    // any session is created.
    const firedAt = run.firedAt ?? run.createdAt;
    let preCheckOutput: string | null = null;
    const check = automation.preRunCheck;
    if (check && automation.execution === 'agent') {
      const timeoutMs =
        check.timeoutMs ?? AUTOMATION_LIMITS.preRunCheckDefaultTimeoutMs;
      const result = await this.withCommand(runId, (signal) =>
        runPreRunCheck({
          automationId: automation.id,
          automationName: automation.name,
          runId,
          command: check.command,
          // A bound or persistent run checks in its session's directory (a
          // session worktree if it has one); fresh has no session yet.
          cwd: this.deps.resolveWorkdir(
            automation,
            automation.sessionMode === 'fresh'
              ? null
              : automation.targetSessionJid,
          ),
          timeoutMs,
          firedAt,
          lastFinishedAt: automation.lastFinishedAt,
          signal,
        }),
      );
      run = this.liveRun(runId);
      run.preCheck = result;
      saveAutomationRun(run);
      if (result.decision === 'skip') {
        this.finishRun(runId, 'skipped', { error: '前置检查决定跳过本次运行' });
        return;
      }
      if (result.decision === 'block') {
        this.finishRun(runId, 'failed', {
          error: describePreRunCheckFailure(result, timeoutMs),
        });
        return;
      }
      preCheckOutput = result.stdout;
    }

    const sessionJid = await this.resolveSession(automation, run);
    if (!sessionJid) return;
    run = this.liveRun(runId);
    run.sessionJid = sessionJid;
    saveAutomationRun(run);
    this.emitRun(automation, run);

    if (automation.execution === 'script') {
      await this.executeScript(
        automation,
        run,
        this.deps.resolveWorkdir(automation, sessionJid),
      );
      return;
    }

    const contextSuffix = buildAutomationRunContext({
      automation,
      run,
      firedAt,
      timezone: automationTimezone(automation),
      preCheckOutput,
    });
    const { inputMessageId } = await this.deps.injectAutomationInput({
      automation,
      run,
      sessionJid,
      // Only bound runs answer on an IM route; fresh/persistent results
      // reach IM as notices.
      deliveryRouteJid:
        automation.sessionMode === 'bound'
          ? this.deps.resolveDeliveryRoute({
              automation,
              sessionJid,
              preferredRouteJid: automation.deliveryRouteJid,
            })
          : null,
      displayContent: automation.prompt,
      contextSuffix,
    });
    const current = getAutomationRun(runId);
    if (!current || isTerminalRunStatus(current.status)) {
      // Cancelled while the input was being written: withdraw it again.
      await this.deps
        .cancelAutomationInput({ sessionJid, inputMessageId })
        .catch(() => {});
      return;
    }
    current.inputMessageId = inputMessageId;
    saveAutomationRun(current);
    this.emitRun(automation, current);
    if (automation.sessionMode === 'fresh')
      await this.archiveOldFreshSessions(automation);
  }

  /** Run a command of `runId` that cancel, delete and stop() can kill. */
  private async withCommand<T>(
    runId: string,
    command: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.commands.set(runId, controller);
    try {
      return await command(controller.signal);
    } finally {
      this.commands.delete(runId);
    }
  }

  private async executeScript(
    automation: Automation,
    queued: AutomationRun,
    cwd: string,
  ): Promise<void> {
    const run = { ...queued, status: 'running' as const };
    saveAutomationRun(run);
    this.emitRun(automation, run);
    const result = await this.withCommand(run.id, (signal) =>
      runAutomationScript({
        automationId: automation.id,
        automationName: automation.name,
        runId: run.id,
        command: automation.scriptCommand ?? '',
        cwd,
        idleTimeoutMs: this.scriptIdleTimeoutMs(),
        signal,
      }),
    );
    if (this.stopped || result.status === 'cancelled') return;
    const sessionJid = run.sessionJid!;
    const text =
      result.status === 'success'
        ? result.output || '（脚本没有输出）'
        : [`⚠️ ${result.error}`, result.output].filter(Boolean).join('\n\n');
    try {
      await this.deps.postScriptOutput({ automation, sessionJid, text });
    } catch (error) {
      logger.warn(
        { err: error, runId: run.id },
        'Posting script output failed',
      );
    }
    if (result.status === 'success') {
      this.finishRun(run.id, 'success', { resultText: result.output || null });
    } else {
      this.finishRun(run.id, 'failed', { error: result.error });
    }
  }

  /** Session the run goes to; null after failing the run. */
  private async resolveSession(
    automation: Automation,
    run: AutomationRun,
  ): Promise<string | null> {
    if (automation.sessionMode === 'bound') {
      const target = automation.targetSessionJid;
      if (target && this.deps.sessionExists(target)) return target;
      this.finishRun(run.id, 'failed', { error: BOUND_SESSION_GONE_REASON });
      this.pauseAutomation(automation.id, BOUND_SESSION_GONE_REASON);
      return null;
    }
    if (
      automation.sessionMode === 'persistent' &&
      automation.targetSessionJid &&
      this.deps.sessionExists(automation.targetSessionJid)
    ) {
      return automation.targetSessionJid;
    }
    const firedAt = run.firedAt ?? run.createdAt;
    const title =
      automation.sessionMode === 'fresh'
        ? `${automation.name} · ${formatAutomationTime(firedAt, automationTimezone(automation))}`
        : automation.name;
    const { sessionJid } = await this.deps.createAutomationSession({
      automation,
      title,
    });
    if (automation.sessionMode === 'persistent') {
      inAutomationTransaction(() => {
        const current = getAutomation(automation.id);
        if (!current) return;
        current.targetSessionJid = sessionJid;
        saveAutomation(current);
      });
    }
    return sessionJid;
  }

  /** fresh mode keeps the newest sessions; older ones are archived. */
  private async archiveOldFreshSessions(automation: Automation): Promise<void> {
    const stale = this.deps
      .listAutomationSessions(automation.id)
      .slice(AUTOMATION_LIMITS.freshSessionsKept)
      .filter((session) => !session.archived);
    for (const { sessionJid } of stale) {
      try {
        await this.deps.archiveAutomationSession(sessionJid);
      } catch (error) {
        logger.warn(
          { err: error, automationId: automation.id },
          'Archiving an old automation session failed',
        );
      }
    }
  }

  // ─── Settling ─────────────────────────────────────────────────────────

  /** Stop a live run's pre-run check or script, if one is running. */
  abortCommand(runId: string): void {
    this.commands.get(runId)?.abort();
  }

  /**
   * Cancel a live run: kill its command, record it cancelled (born read),
   * then withdraw its input from the session queue. A run whose turn is
   * already executing is only interrupted when `interrupt` is set; the
   * runtime drops the input of a run that is no longer live either way.
   */
  async cancelRun(
    runId: string,
    error: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    const before = getAutomationRun(runId);
    this.abortCommand(runId);
    if (!this.finishRun(runId, 'cancelled', { error })) return;
    const { inputMessageId, sessionJid } = before ?? {};
    if (!inputMessageId || !sessionJid) return;
    if (before?.status !== 'queued' && !options.interrupt) return;
    try {
      await this.deps.cancelAutomationInput({ sessionJid, inputMessageId });
    } catch (err) {
      logger.warn({ err, runId }, 'Withdrawing an automation input failed');
    }
  }

  /**
   * Move a live run to a terminal state, advance the schedule and send the
   * notices. A run that is already terminal is left alone, so a late
   * settlement after a cancel is a no-op.
   */
  finishRun(
    runId: string,
    status: AutomationRunStatus,
    fields: { resultText?: string | null; error?: string | null } = {},
  ): AutomationRun | null {
    const now = this.now();
    const nowIso = now.toISOString();
    const settled = inAutomationTransaction(() => {
      const run = getAutomationRun(runId);
      if (!run || isTerminalRunStatus(run.status)) return null;
      run.status = status;
      run.finishedAt = nowIso;
      run.resultText = fields.resultText ?? run.resultText;
      run.error = fields.error ?? run.error;
      if (
        status === 'skipped' ||
        status === 'cancelled' ||
        (status === 'success' && run.silenced)
      ) {
        run.readAt = nowIso;
      }
      saveAutomationRun(run);
      const automation = getAutomation(run.automationId);
      if (!automation) return { run, automation: null };
      automation.lastFinishedAt = nowIso;
      if (automation.status === 'active') {
        if (automation.schedule.kind === 'once' && run.trigger !== 'manual') {
          setStatusFields(automation, 'completed', ONCE_DONE_REASON, nowIso);
        } else {
          // Also puts back a once parked behind this (manual) run.
          automation.nextFireAt = computeNextFireAt(automation, now);
        }
      }
      saveAutomation(automation);
      trimAutomationRuns(automation.id, RUNS_KEPT);
      return { run, automation };
    });
    if (!settled) return null;
    const { run, automation } = settled;
    if (automation) {
      this.emitChanged(automation);
      this.emitRun(automation, run);
      void this.notify(automation, run).catch((error) => {
        logger.warn(
          { err: error, automationId: automation.id },
          'Sending an automation notice failed',
        );
      });
    }
    this.poke();
    return run;
  }

  private async notify(
    automation: Automation,
    run: AutomationRun,
  ): Promise<void> {
    const sessionJid = run.sessionJid ?? automation.targetSessionJid;
    const resolved = this.deps.resolveDeliveryRoute({
      automation,
      sessionJid,
      preferredRouteJid: automation.deliveryRouteJid,
    });
    const imRoute = isImRoute(resolved) ? resolved : null;
    const send = (routeJid: string, text: string) =>
      this.deps.sendAutomationNotice({ automation, routeJid, text });

    // Failure and recovery notices go out only over an IM route; without one
    // the run record and the automation's status carry them, and nothing is
    // written into any session.
    if (run.status === 'failed') {
      const error = run.error ?? '未知错误';
      const { notify } = recordAutomationFailure(
        automation.id,
        errorKey(error),
        error,
        run.finishedAt ?? this.now().toISOString(),
      );
      if (notify && imRoute)
        await send(imRoute, `自动化「${automation.name}」运行失败：${error}`);
      return;
    }
    if (run.status !== 'success') return;
    const recovered = clearAutomationFailure(automation.id);
    if (!imRoute) return;
    if (recovered) {
      await send(imRoute, `自动化「${automation.name}」已恢复正常`);
    }
    if (automation.sessionMode !== 'bound' && !run.silenced) {
      const summary = summarize(run.resultText);
      await send(
        imRoute,
        summary
          ? `自动化「${automation.name}」已完成：${summary}`
          : `自动化「${automation.name}」已完成，结果见会话`,
      );
    }
  }

  readonly runSink: AutomationRunSink = {
    onRunInputStarted: (runId) => {
      const run = getAutomationRun(runId);
      if (!run || run.status !== 'queued') return;
      run.status = 'running';
      saveAutomationRun(run);
      const automation = getAutomation(run.automationId);
      if (automation) this.emitRun(automation, run);
    },
    onRunInputSettled: (runId, outcome) => {
      switch (outcome.status) {
        case 'success':
          this.finishRun(runId, 'success', { resultText: outcome.resultText });
          break;
        case 'failed':
        case 'interrupted':
          this.finishRun(runId, outcome.status, { error: outcome.error });
          break;
        case 'cancelled':
          this.finishRun(runId, 'cancelled', {
            error: CANCEL_REASON_TEXT[outcome.reason],
          });
          break;
      }
    },
    isRunSilenced: (runId) => getAutomationRun(runId)?.silenced ?? false,
    isRunLive: (runId) => {
      const run = getAutomationRun(runId);
      return !!run && !isTerminalRunStatus(run.status);
    },
  };

  // ─── Status changes shared with the service ──────────────────────────

  pauseAutomation(id: string, reason: string | null): Automation | null {
    return this.setStatus(id, 'paused', reason);
  }

  completeAutomation(id: string, reason: string): Automation | null {
    return this.setStatus(id, 'completed', reason);
  }

  private setStatus(
    id: string,
    status: 'paused' | 'completed',
    reason: string | null,
  ): Automation | null {
    const nowIso = this.now().toISOString();
    const updated = inAutomationTransaction(() => {
      const automation = getAutomation(id);
      if (
        !automation ||
        (automation.status === status && automation.statusReason === reason)
      )
        return null;
      setStatusFields(automation, status, reason, nowIso);
      saveAutomation(automation);
      return automation;
    });
    if (updated) {
      this.emitChanged(updated);
      this.poke();
    }
    return updated;
  }

  // ─── Events ───────────────────────────────────────────────────────────

  emitChanged(automation: Automation, deleted = false): void {
    this.deps.broadcast({
      type: 'automation_changed',
      automationId: automation.id,
      workspaceJid: automation.workspaceJid,
      ownerId: automation.createdBy,
      ...(deleted ? { deleted: true } : {}),
    });
  }

  emitRun(automation: Automation, run: AutomationRun): void {
    this.deps.broadcast({
      type: 'automation_run_updated',
      automationId: automation.id,
      workspaceJid: automation.workspaceJid,
      ownerId: automation.createdBy,
      run,
    });
  }

  /** Test helper: wait for run executions started so far. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
