/**
 * Automation service: who may see and change which automation, and the
 * definition writes (create, edit, pause, resume, complete, delete, run now).
 * Run lifecycle and scheduling live in automation-scheduler.ts; both share
 * one engine so every write goes through the same place.
 *
 * Permissions: the Web sees only the automations a user created (404 for
 * anyone else's, no admin bypass) and Host workspaces need an admin. Agent
 * turns see the automations of their own workspace: owner turns may change
 * them, delegate turns too (no host commands, no Host workspaces, created
 * automations belong to the owner), a run may pause/complete/delete only its
 * own automation, any other turn may only list. Errors are Chinese and never carry a raw JID.
 */
import crypto from 'node:crypto';

import {
  AUTOMATION_TERMINAL_RUN_STATUSES,
  validateAutomationDraft,
  type Automation,
  type AutomationDraft,
  type AutomationIpcRequest,
  type AutomationIpcResult,
  type AutomationRun,
} from './automation.js';
import {
  AutomationError,
  type AutomationActor,
  type AutomationCreateInput,
  type AutomationPatch,
  type AutomationRuntimeDeps,
  type AutomationScheduler,
  type AutomationService,
  type AutomationSessionDisposal,
} from './automation-contract.js';
import {
  AutomationEngine,
  computeNextFireAt,
  isImRoute,
  isValidCronExpression,
  isValidTimezone,
  OVERLAP_SKIP_ERROR,
  type AutomationEngineOptions,
} from './automation-scheduler.js';
import {
  countUnreadAutomationRuns,
  deleteAutomations,
  deleteWorkspaceAutomations,
  getAutomation,
  getAutomationRun,
  getLastAutomationRunStatus,
  getLiveAutomationRun,
  inAutomationTransaction,
  insertAutomation,
  listAutomationRuns,
  listAutomations,
  listAutomationsTargeting,
  listRunsInSession,
  markAutomationRunsRead,
  saveAutomation,
  saveAutomationRun,
} from './automation-store.js';
import { getRegisteredGroup } from './db.js';
import { canModifyGroup } from './group-acl.js';
import {
  redactAutomationForGuest,
  redactAutomationRunForGuest,
} from './guest-access.js';
import { logger } from './logger.js';

export interface AutomationCore {
  service: AutomationService;
  scheduler: AutomationScheduler;
}

const OWNER_ONLY_ERROR = '只有工作区主人可以创建或修改自动化';
const VIEWER_ERROR = '访客只能查看自动化';
const RUN_SCOPE_ERROR = '自动化运行只能暂停、结束或删除它自己所属的自动化';
const RUN_CANNOT_CREATE_ERROR = '自动化运行中不能再创建新的自动化';
const NOT_FOUND_ERROR = '自动化不存在';
const WORKSPACE_NOT_FOUND_ERROR = '工作区不存在';
const HOST_ADMIN_ERROR = '宿主机工作区的自动化需要管理员权限';
const DELEGATE_HOST_ERROR =
  '宿主机工作区的自动化只能由工作区主人管理，被委托的对象不能操作';
const DELEGATE_COMMAND_ERROR =
  '被委托的对象不能设置或修改脚本与前置检查，也不能操作带有脚本或前置检查的自动化，请让工作区主人处理';
const STALE_REVISION_ERROR = '自动化已被修改，请刷新后重试';
const NOT_A_RUN_ERROR = '当前不是自动化运行，无法使用这个工具';
const SESSION_REQUIRED_ERROR = '请选择要绑定的会话';
const SESSION_MISSING_ERROR = '绑定的会话不存在或不属于这个工作区';
const SESSION_DELETED_REASON = '绑定的会话已删除';
const SUSPENDED_REASON = '工作区重建中';
const MANUAL_CANCEL_ERROR = '已手动终止';
/** interval upper bound: beyond a year `Date` arithmetic gets close to its range. */
const INTERVAL_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const RUNS_DEFAULT_LIMIT = 50;
const RUNS_MAX_LIMIT = 200;

type Operation =
  | 'update'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'delete'
  | 'run_now'
  | 'cancel_run';

const RUN_OWN_OPERATIONS: ReadonlySet<Operation> = new Set([
  'pause',
  'complete',
  'delete',
]);

function isHostWorkspace(workspaceJid: string): boolean {
  const group = getRegisteredGroup(workspaceJid);
  return (group?.executionMode || 'container') === 'host';
}

function belongsToWorkspace(sessionJid: string, workspaceJid: string): boolean {
  return (
    sessionJid === workspaceJid ||
    sessionJid.startsWith(`${workspaceJid}#agent:`)
  );
}

function hasHostCommands(
  draft: Pick<
    Partial<AutomationDraft>,
    'preRunCheck' | 'execution' | 'scriptCommand'
  >,
): boolean {
  return (
    !!draft.preRunCheck ||
    draft.execution === 'script' ||
    !!draft.scriptCommand?.trim()
  );
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** One instance per process; index.ts wires it after the DB is open. */
export function createAutomationCore(
  deps: AutomationRuntimeDeps,
  options: AutomationEngineOptions = {},
): AutomationCore {
  const engine = new AutomationEngine(deps, options);
  const now = () => engine.now();

  // ─── Visibility and permission ─────────────────────────────────────────

  function canSee(actor: AutomationActor, automation: Automation): boolean {
    switch (actor.kind) {
      case 'web':
        return automation.createdBy === actor.userId;
      case 'viewer':
        return actor.workspaceJids.includes(automation.workspaceJid);
      default:
        return automation.workspaceJid === actor.workspaceJid;
    }
  }

  function load(actor: AutomationActor, id: string): Automation {
    const automation = getAutomation(id);
    if (!automation || !canSee(actor, automation))
      throw new AutomationError(404, NOT_FOUND_ERROR);
    return automation;
  }

  function assertHostAllowed(
    actor: AutomationActor,
    workspaceJid: string,
  ): void {
    if (actor.kind === 'delegate_turn') {
      if (isHostWorkspace(workspaceJid))
        throw new AutomationError(403, DELEGATE_HOST_ERROR);
      return;
    }
    if (actor.kind !== 'web' && actor.kind !== 'owner_turn') return;
    if (!actor.isAdmin && isHostWorkspace(workspaceJid))
      throw new AutomationError(403, HOST_ADMIN_ERROR);
  }

  /** Load an automation the actor may apply `operation` to. */
  function loadForWrite(
    actor: AutomationActor,
    id: string,
    operation: Operation,
  ): Automation {
    const automation = load(actor, id);
    switch (actor.kind) {
      case 'web':
      case 'owner_turn':
        assertHostAllowed(actor, automation.workspaceJid);
        return automation;
      case 'delegate_turn':
        assertHostAllowed(actor, automation.workspaceJid);
        if (hasHostCommands(automation))
          throw new AutomationError(403, DELEGATE_COMMAND_ERROR);
        return automation;
      case 'automation_run':
        if (
          automation.id !== actor.automationId ||
          !RUN_OWN_OPERATIONS.has(operation)
        )
          throw new AutomationError(403, RUN_SCOPE_ERROR);
        return automation;
      case 'other_turn':
        throw new AutomationError(403, OWNER_ONLY_ERROR);
      case 'viewer':
        throw new AutomationError(403, VIEWER_ERROR);
    }
  }

  /** Decorate a list, looking each workspace name up once. */
  function decorateAll(automations: Automation[]): Automation[] {
    const workspaceNames = new Map<string, string | null>();
    return automations.map((automation) =>
      decorate(automation, workspaceNames),
    );
  }

  function decorate(
    automation: Automation,
    workspaceNames = new Map<string, string | null>(),
  ): Automation {
    let workspaceName = workspaceNames.get(automation.workspaceJid);
    if (workspaceName === undefined) {
      workspaceName = getRegisteredGroup(automation.workspaceJid)?.name ?? null;
      workspaceNames.set(automation.workspaceJid, workspaceName);
    }
    return {
      ...automation,
      workspaceName,
      unreadRuns: countUnreadAutomationRuns(automation.id),
      lastRunStatus: getLastAutomationRunStatus(automation.id),
    };
  }

  // ─── Validation ────────────────────────────────────────────────────────

  function validate(
    draft: AutomationDraft,
    workspaceJid: string,
    actor: AutomationActor,
    checkPast: { schedule: boolean; endAt: boolean },
  ): void {
    const isAdmin = 'isAdmin' in actor && actor.isAdmin;
    const errors = validateAutomationDraft(draft, {
      allowHostCommands: isAdmin && deps.allowsHostCommands(workspaceJid),
    });
    const at = now().getTime();
    const { schedule } = draft;
    if (
      checkPast.schedule &&
      schedule?.kind === 'once' &&
      schedule.runAt &&
      Date.parse(schedule.runAt) <= at
    )
      errors.push('运行时间已经过去');
    if (checkPast.endAt && draft.endAt && Date.parse(draft.endAt) <= at)
      errors.push('结束时间已经过去');
    if (schedule?.timezone && !isValidTimezone(schedule.timezone))
      errors.push('时区无效');
    else if (
      schedule?.kind === 'cron' &&
      schedule.cronExpr?.trim() &&
      !isValidCronExpression(schedule.cronExpr, schedule.timezone ?? undefined)
    )
      errors.push('Cron 表达式无效，需要 5 段：分 时 日 月 周');
    if (
      schedule?.kind === 'interval' &&
      (schedule.intervalMs ?? 0) > INTERVAL_MAX_MS
    )
      errors.push('间隔不能超过 365 天');
    if (errors.length > 0) throw new AutomationError(400, errors.join('；'));
  }

  function normalizeSchedule(
    schedule: AutomationDraft['schedule'],
  ): Automation['schedule'] {
    return {
      kind: schedule.kind,
      cronExpr:
        schedule.kind === 'cron' ? (schedule.cronExpr?.trim() ?? null) : null,
      timezone:
        schedule.kind === 'cron' || schedule.kind === 'once'
          ? trimOrNull(schedule.timezone)
          : null,
      intervalMs:
        schedule.kind === 'interval' ? (schedule.intervalMs ?? null) : null,
      runAt:
        schedule.kind === 'once'
          ? new Date(Date.parse(schedule.runAt!)).toISOString()
          : null,
    };
  }

  /** The draft's user-editable fields as stored. */
  function normalizeDraft(
    draft: AutomationDraft,
    execution: Automation['execution'],
  ) {
    return {
      name: draft.name.trim(),
      prompt: execution === 'agent' ? (draft.prompt ?? '').trim() : '',
      stopWhen: trimOrNull(draft.stopWhen),
      endAt: draft.endAt
        ? new Date(Date.parse(draft.endAt)).toISOString()
        : null,
      silentWhenIdle: draft.silentWhenIdle ?? false,
      preRunCheck: draft.preRunCheck
        ? {
            command: draft.preRunCheck.command.trim(),
            timeoutMs: draft.preRunCheck.timeoutMs ?? null,
          }
        : null,
      scriptCommand:
        execution === 'script' ? trimOrNull(draft.scriptCommand) : null,
    };
  }

  /**
   * The session runs go to: bound needs one, persistent may name one to
   * start with, fresh never has one. A named session must be a live session
   * of the same workspace.
   */
  function resolveTarget(
    sessionMode: Automation['sessionMode'],
    sessionJid: string | null | undefined,
    workspaceJid: string,
  ): string | null {
    if (sessionMode === 'fresh') return null;
    if (sessionMode === 'persistent' && !sessionJid) return null;
    if (!sessionJid) throw new AutomationError(400, SESSION_REQUIRED_ERROR);
    if (
      !belongsToWorkspace(sessionJid, workspaceJid) ||
      !deps.sessionExists(sessionJid)
    )
      throw new AutomationError(400, SESSION_MISSING_ERROR);
    return sessionJid;
  }

  // ─── Writes ────────────────────────────────────────────────────────────

  function insert(
    actor: AutomationActor,
    input: AutomationCreateInput,
    createdBy: string,
    deliveryRouteJid: string | null,
  ): Automation {
    const workspace = getRegisteredGroup(input.workspaceJid);
    if (!workspace || !input.workspaceJid.startsWith('web:'))
      throw new AutomationError(404, WORKSPACE_NOT_FOUND_ERROR);
    assertHostAllowed(actor, input.workspaceJid);
    validate(input, input.workspaceJid, actor, { schedule: true, endAt: true });
    const execution = input.execution ?? 'agent';
    const targetSessionJid = resolveTarget(
      input.sessionMode,
      input.targetSessionJid,
      input.workspaceJid,
    );
    const nowIso = now().toISOString();
    const automation: Automation = {
      id: crypto.randomUUID(),
      workspaceJid: input.workspaceJid,
      workspaceFolder: workspace.folder,
      createdBy,
      ...normalizeDraft(input, execution),
      schedule: normalizeSchedule(input.schedule),
      sessionMode: input.sessionMode,
      targetSessionJid,
      deliveryRouteJid,
      execution,
      status: 'active',
      statusReason: null,
      nextFireAt: null,
      lastFiredAt: null,
      lastFinishedAt: null,
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    automation.nextFireAt = computeNextFireAt(automation, now());
    insertAutomation(automation);
    engine.emitChanged(automation);
    engine.poke();
    return decorate(automation);
  }

  function update(
    actor: AutomationActor,
    id: string,
    expectedRevision: number,
    patch: AutomationPatch,
  ): Automation {
    const current = loadForWrite(actor, id, 'update');
    if (actor.kind === 'delegate_turn' && hasHostCommands(patch))
      throw new AutomationError(403, DELEGATE_COMMAND_ERROR);
    if (current.revision !== expectedRevision)
      throw new AutomationError(409, STALE_REVISION_ERROR);
    const has = (key: keyof AutomationPatch) =>
      Object.prototype.hasOwnProperty.call(patch, key) &&
      patch[key] !== undefined;
    const draft: AutomationDraft = {
      name: has('name') ? patch.name! : current.name,
      prompt: has('prompt') ? patch.prompt : current.prompt,
      stopWhen: has('stopWhen') ? patch.stopWhen : current.stopWhen,
      schedule: has('schedule') ? patch.schedule! : current.schedule,
      endAt: has('endAt') ? patch.endAt : current.endAt,
      sessionMode: has('sessionMode')
        ? patch.sessionMode!
        : current.sessionMode,
      silentWhenIdle: has('silentWhenIdle')
        ? patch.silentWhenIdle
        : current.silentWhenIdle,
      preRunCheck: has('preRunCheck') ? patch.preRunCheck : current.preRunCheck,
      execution: current.execution,
      scriptCommand: has('scriptCommand')
        ? patch.scriptCommand
        : current.scriptCommand,
    };
    validate(draft, current.workspaceJid, actor, {
      schedule: has('schedule'),
      endAt: has('endAt'),
    });

    const targetSessionJid =
      has('sessionMode') || has('targetSessionJid')
        ? resolveTarget(
            draft.sessionMode,
            has('targetSessionJid')
              ? patch.targetSessionJid
              : current.targetSessionJid,
            current.workspaceJid,
          )
        : current.targetSessionJid;
    // The creating turn's route belonged to the old target; the new one
    // answers wherever its own IM binding points.
    const deliveryRouteJid =
      draft.sessionMode !== current.sessionMode ||
      targetSessionJid !== current.targetSessionJid
        ? null
        : current.deliveryRouteJid;

    const nowDate = now();
    const next: Automation = {
      ...current,
      ...normalizeDraft(draft, current.execution),
      schedule: has('schedule')
        ? normalizeSchedule(draft.schedule)
        : current.schedule,
      sessionMode: draft.sessionMode,
      targetSessionJid,
      deliveryRouteJid,
      revision: current.revision + 1,
      updatedAt: nowDate.toISOString(),
    };
    if ((has('schedule') || has('endAt')) && next.status === 'active') {
      next.nextFireAt = nextFireFromNow(next, nowDate);
    }
    if (!saveAutomation(next, expectedRevision))
      throw new AutomationError(409, STALE_REVISION_ERROR);
    engine.emitChanged(next);
    engine.poke();
    return decorate(next);
  }

  function resume(actor: AutomationActor, id: string): Automation {
    const current = loadForWrite(actor, id, 'resume');
    if (current.status === 'active') return decorate(current);
    return decorate(activate(current));
  }

  /**
   * Resume and cadence edits count from now; a live interval run sets the
   * next fire itself when it finishes.
   */
  function nextFireFromNow(automation: Automation, at: Date): string | null {
    return automation.schedule.kind === 'interval' &&
      getLiveAutomationRun(automation.id)
      ? null
      : computeNextFireAt(automation, at, 'now');
  }

  /** Back to active with the next fire counted from now. */
  function activate(current: Automation): Automation {
    const nowDate = now();
    if (current.endAt && Date.parse(current.endAt) <= nowDate.getTime())
      throw new AutomationError(400, '结束时间已经过去，请先修改结束时间');
    if (
      current.schedule.kind === 'once' &&
      (!current.schedule.runAt ||
        Date.parse(current.schedule.runAt) <= nowDate.getTime())
    )
      throw new AutomationError(400, '运行时间已经过去，请先修改运行时间');
    const next: Automation = {
      ...current,
      status: 'active',
      statusReason: null,
      revision: current.revision + 1,
      updatedAt: nowDate.toISOString(),
    };
    next.nextFireAt = nextFireFromNow(next, nowDate);
    saveAutomation(next);
    engine.emitChanged(next);
    engine.poke();
    return next;
  }

  /** What `actor` may see of an automation: viewers miss host commands. */
  function present(actor: AutomationActor, automation: Automation): Automation {
    return actor.kind === 'viewer'
      ? redactAutomationForGuest(automation)
      : automation;
  }

  /** A user stop or delete also interrupts a turn already running it. */
  function cancelLiveRun(run: AutomationRun, error: string) {
    return engine.cancelRun(run.id, error, { interrupt: true });
  }

  // ─── Service ───────────────────────────────────────────────────────────

  const service: AutomationService = {
    list(actor, filter = {}) {
      const rows =
        actor.kind === 'web'
          ? listAutomations({
              createdBy: actor.userId,
              workspaceJid: filter.workspaceJid,
            })
          : actor.kind === 'viewer'
            ? actor.workspaceJids
                .filter(
                  (jid) => !filter.workspaceJid || jid === filter.workspaceJid,
                )
                .flatMap((workspaceJid) => listAutomations({ workspaceJid }))
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            : listAutomations({ workspaceJid: actor.workspaceJid });
      return decorateAll(rows).map((automation) => present(actor, automation));
    },

    get(actor, automationId) {
      return present(actor, decorate(load(actor, automationId)));
    },

    listRuns(actor, automationId, limit = RUNS_DEFAULT_LIMIT) {
      load(actor, automationId);
      const capped = Math.min(
        Math.max(Math.trunc(limit) || RUNS_DEFAULT_LIMIT, 1),
        RUNS_MAX_LIMIT,
      );
      const runs = listAutomationRuns(automationId, capped);
      return actor.kind === 'viewer'
        ? runs.map(redactAutomationRunForGuest)
        : runs;
    },

    create(actor, input) {
      if (actor.kind === 'web') {
        const group = getRegisteredGroup(input.workspaceJid);
        if (
          !group ||
          !canModifyGroup(
            { id: actor.userId, role: actor.isAdmin ? 'admin' : 'member' },
            group,
          )
        )
          throw new AutomationError(404, WORKSPACE_NOT_FOUND_ERROR);
        return insert(actor, input, actor.userId, null);
      }
      if (actor.kind === 'automation_run')
        throw new AutomationError(403, RUN_CANNOT_CREATE_ERROR);
      if (actor.kind === 'other_turn')
        throw new AutomationError(403, OWNER_ONLY_ERROR);
      if (actor.kind === 'viewer') throw new AutomationError(403, VIEWER_ERROR);
      if (actor.kind === 'delegate_turn' && hasHostCommands(input))
        throw new AutomationError(403, DELEGATE_COMMAND_ERROR);
      return insert(
        actor,
        { ...input, workspaceJid: actor.workspaceJid },
        // A delegate's automation is the owner's: it shows on their Web page.
        actor.kind === 'delegate_turn' ? actor.ownerUserId : actor.userId,
        input.sessionMode === 'bound' || isImRoute(actor.sourceRouteJid)
          ? actor.sourceRouteJid
          : null,
      );
    },

    update,

    pause(actor, automationId, reason) {
      const current = loadForWrite(actor, automationId, 'pause');
      if (current.status === 'paused') return decorate(current);
      return decorate(
        engine.pauseAutomation(automationId, trimOrNull(reason)) ?? current,
      );
    },

    resume,

    complete(actor, automationId, reason) {
      const current = loadForWrite(actor, automationId, 'complete');
      const text = reason?.trim();
      if (!text) throw new AutomationError(400, '请说明结束的原因');
      return decorate(engine.completeAutomation(automationId, text) ?? current);
    },

    async delete(actor, automationId, sessions) {
      const automation = loadForWrite(actor, automationId, 'delete');
      const ownRunId = actor.kind === 'automation_run' ? actor.runId : null;
      const live = getLiveAutomationRun(automationId);
      if (live && live.id !== ownRunId)
        await cancelLiveRun(live, '自动化已删除');
      await disposeSessions(automation, sessions, actor);
      deleteAutomations([automationId]);
      engine.emitChanged(automation, true);
      engine.poke();
    },

    async runNow(actor, automationId) {
      loadForWrite(actor, automationId, 'run_now');
      const run = engine.startManualRun(automationId);
      if (!run) throw new AutomationError(409, OVERLAP_SKIP_ERROR);
      return run;
    },

    async cancelRun(actor, automationId, runId) {
      loadForWrite(actor, automationId, 'cancel_run');
      const run = getAutomationRun(runId);
      if (!run || run.automationId !== automationId)
        throw new AutomationError(404, '运行记录不存在');
      if (AUTOMATION_TERMINAL_RUN_STATUSES.includes(run.status)) return;
      await cancelLiveRun(run, MANUAL_CANCEL_ERROR);
    },

    markRunsRead(actor, automationId, runIds) {
      load(actor, automationId);
      if (actor.kind === 'viewer') throw new AutomationError(403, VIEWER_ERROR);
      markAutomationRunsRead(automationId, runIds, now().toISOString());
      const automation = getAutomation(automationId);
      if (automation) engine.emitChanged(automation);
    },

    async handleIpc(actor, request) {
      try {
        return {
          requestId: request.requestId,
          success: true,
          ...(await ipc(actor, request)),
        };
      } catch (error) {
        if (error instanceof AutomationError)
          return {
            requestId: request.requestId,
            success: false,
            error: error.message,
          };
        logger.error(
          { err: error, type: request.type },
          'Automation IPC request failed',
        );
        return {
          requestId: request.requestId,
          success: false,
          error: '操作失败，请稍后重试',
        };
      }
    },

    onSessionDeleted(sessionJid) {
      for (const automation of listAutomationsTargeting(sessionJid)) {
        if (automation.sessionMode === 'bound') {
          engine.pauseAutomation(automation.id, SESSION_DELETED_REASON);
        } else {
          inAutomationTransaction(() => {
            const current = getAutomation(automation.id);
            if (!current || current.targetSessionJid !== sessionJid) return;
            current.targetSessionJid = null;
            saveAutomation(current);
          });
        }
      }
      for (const run of listRunsInSession(sessionJid)) {
        void engine.cancelRun(run.id, '会话已删除');
      }
    },

    onWorkspaceDeleted(workspaceJid) {
      const automations = listAutomations({ workspaceJid });
      for (const automation of automations) {
        const live = getLiveAutomationRun(automation.id);
        if (live) engine.abortCommand(live.id);
      }
      deleteWorkspaceAutomations(workspaceJid);
      for (const automation of automations)
        engine.emitChanged(automation, true);
      engine.poke();
    },

    suspendWorkspace(workspaceJid) {
      const paused: string[] = [];
      for (const automation of listAutomations({ workspaceJid })) {
        const live = getLiveAutomationRun(automation.id);
        if (live) void engine.cancelRun(live.id, SUSPENDED_REASON);
        if (
          automation.status === 'active' &&
          engine.pauseAutomation(automation.id, SUSPENDED_REASON)
        )
          paused.push(automation.id);
      }
      return paused;
    },

    restoreWorkspace(automationIds) {
      for (const automationId of automationIds) {
        const automation = getAutomation(automationId);
        // Paused for another reason meanwhile (its bound session is gone):
        // that reason wins.
        if (
          automation?.status !== 'paused' ||
          automation.statusReason !== SUSPENDED_REASON
        )
          continue;
        try {
          activate(automation);
        } catch (error) {
          if (!(error instanceof AutomationError)) throw error;
          // The end or run time passed during the rebuild; leave it paused.
        }
      }
    },

    listForSession(sessionJid) {
      return decorateAll(
        listAutomationsTargeting(sessionJid).filter(
          (automation) => automation.sessionMode === 'bound',
        ),
      );
    },

    runSink: engine.runSink,
  };

  async function disposeSessions(
    automation: Automation,
    disposal: AutomationSessionDisposal,
    actor: AutomationActor,
  ): Promise<void> {
    // A bound automation borrows the user's session; it is never touched.
    if (disposal === 'keep' || automation.sessionMode === 'bound') return;
    const sessions = new Set(
      deps
        .listAutomationSessions(automation.id)
        .filter((session) => disposal === 'delete' || !session.archived)
        .map((session) => session.sessionJid),
    );
    if (automation.targetSessionJid) sessions.add(automation.targetSessionJid);
    // A run deleting its own automation keeps the session it is talking in.
    if (actor.kind === 'automation_run') sessions.delete(actor.sessionJid);
    for (const sessionJid of sessions) {
      if (!belongsToWorkspace(sessionJid, automation.workspaceJid)) continue;
      try {
        if (disposal === 'archive')
          await deps.archiveAutomationSession(sessionJid);
        else await deps.deleteAutomationSession(sessionJid);
      } catch (error) {
        logger.warn(
          { err: error, automationId: automation.id },
          'Disposing an automation session failed',
        );
      }
    }
  }

  function currentRun(actor: AutomationActor): AutomationRun {
    if (actor.kind !== 'automation_run')
      throw new AutomationError(400, NOT_A_RUN_ERROR);
    const run = getAutomationRun(actor.runId);
    if (!run || run.automationId !== actor.automationId)
      throw new AutomationError(404, '运行记录不存在');
    return run;
  }

  async function ipc(
    actor: AutomationActor,
    request: AutomationIpcRequest,
  ): Promise<Omit<AutomationIpcResult, 'requestId' | 'success'>> {
    switch (request.type) {
      case 'automation_create': {
        const choice = request.session ?? 'current';
        const sessionMode = choice === 'current' ? 'bound' : choice;
        const workspaceJid =
          actor.kind === 'web' || actor.kind === 'viewer'
            ? ''
            : actor.workspaceJid;
        const automation = service.create(actor, {
          workspaceJid,
          name: request.name,
          prompt: request.prompt,
          stopWhen: request.stopWhen,
          schedule: request.schedule,
          endAt: request.endAt,
          sessionMode,
          silentWhenIdle: request.silentWhenIdle,
          preRunCheck: request.preRunCheck,
          execution: request.execution,
          scriptCommand: request.scriptCommand,
          targetSessionJid:
            sessionMode === 'bound' &&
            actor.kind !== 'web' &&
            actor.kind !== 'viewer'
              ? actor.sessionJid
              : null,
        });
        return { automation };
      }
      case 'automation_update':
        return {
          automation: update(actor, request.id, request.expectedRevision, {
            ...request.patch,
          }),
        };
      case 'automation_pause':
        return { automation: service.pause(actor, request.id) };
      case 'automation_resume':
        return { automation: resume(actor, request.id) };
      case 'automation_complete':
        return {
          automation: service.complete(actor, request.id, request.reason),
        };
      case 'automation_delete':
        // The agent cannot answer the delete dialog: keep the sessions.
        await service.delete(actor, request.id, 'keep');
        return {};
      case 'automation_run_now':
        return { run: await service.runNow(actor, request.id) };
      case 'automation_list':
        return { automations: service.list(actor) };
      case 'automation_list_runs':
        return { runs: service.listRuns(actor, request.id, request.limit) };
      case 'automation_notify_current_run':
      case 'automation_silence_current_run': {
        const run = currentRun(actor);
        const silenced = request.type === 'automation_silence_current_run';
        if (run.silenced !== silenced) {
          run.silenced = silenced;
          saveAutomationRun(run);
          const automation = getAutomation(run.automationId);
          if (automation) engine.emitRun(automation, run);
        }
        return { run };
      }
    }
  }

  return { service, scheduler: engine };
}
