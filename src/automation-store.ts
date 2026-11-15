/**
 * Durable state of automations (自动化): definitions, runs and failure
 * streaks.
 *
 * db.ts binds this module to its connection; the scheduler and the service
 * are the only callers. Rows map 1:1 onto the shared `Automation` and
 * `AutomationRun` shapes; list-only decorations (workspace name, unread
 * count) are added by the service.
 */
import type {
  Automation,
  AutomationPreCheckResult,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTrigger,
} from './automation.js';

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let database: SqliteDatabase | null = null;
const statements = new Map<string, SqliteStatement>();

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Automation store is not initialized');
  return database;
}

function stmt(sql: string): SqliteStatement {
  let statement = statements.get(sql);
  if (!statement) {
    statement = requireDatabase().prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/** Create the tables (idempotent) and bind the store; null unbinds it. */
export function initAutomationStore(db: SqliteDatabase | null): void {
  database = db;
  statements.clear();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      created_by TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      stop_when TEXT,
      schedule_kind TEXT NOT NULL,
      cron_expr TEXT,
      timezone TEXT,
      interval_ms INTEGER,
      run_at TEXT,
      end_at TEXT,
      session_mode TEXT NOT NULL,
      target_session_jid TEXT,
      delivery_route_jid TEXT,
      silent_when_idle INTEGER NOT NULL DEFAULT 0,
      pre_run_check_command TEXT,
      pre_run_check_timeout_ms INTEGER,
      execution TEXT NOT NULL DEFAULT 'agent',
      script_command TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      next_fire_at TEXT,
      last_fired_at TEXT,
      last_finished_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_due
      ON automations(status, next_fire_at);
    CREATE INDEX IF NOT EXISTS idx_automations_workspace
      ON automations(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_automations_target_session
      ON automations(target_session_jid);
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL
        REFERENCES automations(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      session_jid TEXT,
      input_message_id TEXT,
      scheduled_for TEXT NOT NULL,
      fired_at TEXT,
      finished_at TEXT,
      result_text TEXT,
      error TEXT,
      pre_check_json TEXT,
      silenced INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_created
      ON automation_runs(automation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_session
      ON automation_runs(session_jid);
    -- One live run per automation: the overlap rule holds even if two
    -- writers race past the in-memory checks.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_one_live
      ON automation_runs(automation_id)
      WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS automation_failure_streaks (
      automation_id TEXT PRIMARY KEY,
      error_key TEXT NOT NULL,
      error_text TEXT NOT NULL,
      failure_count INTEGER NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL
    );
  `);
}

export function inAutomationTransaction<T>(fn: () => T): T {
  return requireDatabase().transaction(fn)();
}

// ─── Automations ────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toAutomation(row: Record<string, unknown>): Automation {
  const preRunCommand = str(row.pre_run_check_command);
  return {
    id: String(row.id),
    workspaceJid: String(row.workspace_jid),
    workspaceFolder: String(row.workspace_folder),
    createdBy: String(row.created_by),
    name: String(row.name),
    prompt: String(row.prompt ?? ''),
    stopWhen: str(row.stop_when),
    schedule: {
      kind: String(row.schedule_kind) as Automation['schedule']['kind'],
      cronExpr: str(row.cron_expr),
      timezone: str(row.timezone),
      intervalMs: num(row.interval_ms),
      runAt: str(row.run_at),
    },
    endAt: str(row.end_at),
    sessionMode: String(row.session_mode) as Automation['sessionMode'],
    targetSessionJid: str(row.target_session_jid),
    model: null,
    deliveryRouteJid: str(row.delivery_route_jid),
    silentWhenIdle: Number(row.silent_when_idle) === 1,
    preRunCheck: preRunCommand
      ? {
          command: preRunCommand,
          timeoutMs: num(row.pre_run_check_timeout_ms),
        }
      : null,
    execution: String(row.execution) as Automation['execution'],
    scriptCommand: str(row.script_command),
    status: String(row.status) as Automation['status'],
    statusReason: str(row.status_reason),
    nextFireAt: str(row.next_fire_at),
    lastFiredAt: str(row.last_fired_at),
    lastFinishedAt: str(row.last_finished_at),
    revision: Number(row.revision) || 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function automationColumns(a: Automation): Record<string, unknown> {
  return {
    id: a.id,
    workspace_jid: a.workspaceJid,
    workspace_folder: a.workspaceFolder,
    created_by: a.createdBy,
    name: a.name,
    prompt: a.prompt,
    stop_when: a.stopWhen,
    schedule_kind: a.schedule.kind,
    cron_expr: a.schedule.cronExpr ?? null,
    timezone: a.schedule.timezone ?? null,
    interval_ms: a.schedule.intervalMs ?? null,
    run_at: a.schedule.runAt ?? null,
    end_at: a.endAt,
    session_mode: a.sessionMode,
    target_session_jid: a.targetSessionJid,
    delivery_route_jid: a.deliveryRouteJid,
    silent_when_idle: a.silentWhenIdle ? 1 : 0,
    pre_run_check_command: a.preRunCheck?.command ?? null,
    pre_run_check_timeout_ms: a.preRunCheck?.timeoutMs ?? null,
    execution: a.execution,
    script_command: a.scriptCommand,
    status: a.status,
    status_reason: a.statusReason,
    next_fire_at: a.nextFireAt,
    last_fired_at: a.lastFiredAt,
    last_finished_at: a.lastFinishedAt,
    revision: a.revision,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

/** INSERT and full-row UPDATE statements for a column mapping. */
function rowStatements(table: string, columns: string[]) {
  return {
    insert: `INSERT INTO ${table} (${columns.join(', ')})
      VALUES (${columns.map((name) => `@${name}`).join(', ')})`,
    update: `UPDATE ${table} SET ${columns
      .filter((name) => name !== 'id')
      .map((name) => `${name} = @${name}`)
      .join(', ')} WHERE id = @id`,
  };
}

const AUTOMATION_SQL = rowStatements(
  'automations',
  Object.keys(automationColumns({ schedule: {} } as unknown as Automation)),
);

export function insertAutomation(automation: Automation): void {
  stmt(AUTOMATION_SQL.insert).run(automationColumns(automation));
}

/**
 * Write the whole row back. With `expectedRevision` the write only lands on
 * that revision (optimistic concurrency); returns whether it landed.
 */
export function saveAutomation(
  automation: Automation,
  expectedRevision?: number,
): boolean {
  const params = automationColumns(automation);
  if (expectedRevision === undefined) {
    return stmt(AUTOMATION_SQL.update).run(params).changes > 0;
  }
  return (
    stmt(`${AUTOMATION_SQL.update} AND revision = @expected_revision`).run({
      ...params,
      expected_revision: expectedRevision,
    }).changes > 0
  );
}

export function getAutomation(id: string): Automation | null {
  const row = stmt('SELECT * FROM automations WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toAutomation(row) : null;
}

export function listAutomations(filter: {
  workspaceJid?: string;
  createdBy?: string;
}): Automation[] {
  const rows = stmt(
    `SELECT * FROM automations
     WHERE (@workspace IS NULL OR workspace_jid = @workspace)
       AND (@owner IS NULL OR created_by = @owner)
     ORDER BY created_at DESC, id`,
  ).all({
    workspace: filter.workspaceJid ?? null,
    owner: filter.createdBy ?? null,
  }) as Record<string, unknown>[];
  return rows.map(toAutomation);
}

/** Automations whose runs go into this session (bound target or persistent). */
export function listAutomationsTargeting(sessionJid: string): Automation[] {
  return (
    stmt(
      'SELECT * FROM automations WHERE target_session_jid = ? ORDER BY created_at',
    ).all(sessionJid) as Record<string, unknown>[]
  ).map(toAutomation);
}

export function listActiveAutomations(): Automation[] {
  return (
    stmt(
      "SELECT * FROM automations WHERE status = 'active' ORDER BY next_fire_at, id",
    ).all() as Record<string, unknown>[]
  ).map(toAutomation);
}

export function listDueAutomations(now: string): Automation[] {
  return (
    stmt(
      `SELECT * FROM automations
       WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
       ORDER BY next_fire_at, id`,
    ).all(now) as Record<string, unknown>[]
  ).map(toAutomation);
}

/** Active automations whose end time has come. */
export function listEndedAutomationIds(now: string): string[] {
  return (
    stmt(
      `SELECT id FROM automations
       WHERE status = 'active' AND end_at IS NOT NULL AND end_at <= ?`,
    ).all(now) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Earliest instant the scheduler has to look at: a fire or an end time. */
export function getNextAutomationWakeAt(): string | null {
  const row = stmt(
    `SELECT MIN(t) AS wake FROM (
       SELECT next_fire_at AS t FROM automations
         WHERE status = 'active' AND next_fire_at IS NOT NULL
       UNION ALL
       SELECT end_at AS t FROM automations
         WHERE status = 'active' AND end_at IS NOT NULL
     )`,
  ).get() as { wake: string | null } | undefined;
  return row?.wake ?? null;
}

/** Remove automations with their runs and failure streaks. */
export function deleteAutomations(ids: readonly string[]): void {
  if (ids.length === 0) return;
  inAutomationTransaction(() => {
    for (const id of ids) {
      // Explicit: ON DELETE CASCADE is a no-op while foreign keys are off.
      stmt('DELETE FROM automation_runs WHERE automation_id = ?').run(id);
      stmt(
        'DELETE FROM automation_failure_streaks WHERE automation_id = ?',
      ).run(id);
      stmt('DELETE FROM automations WHERE id = ?').run(id);
    }
  });
}

/** Workspace deletion cascade. */
export function deleteWorkspaceAutomations(workspaceJid: string): void {
  deleteAutomations(
    (
      stmt('SELECT id FROM automations WHERE workspace_jid = ?').all(
        workspaceJid,
      ) as Array<{ id: string }>
    ).map((row) => row.id),
  );
}

// ─── Runs ───────────────────────────────────────────────────────────────

function toRun(row: Record<string, unknown>): AutomationRun {
  let preCheck: AutomationPreCheckResult | null = null;
  if (row.pre_check_json) {
    try {
      preCheck = JSON.parse(String(row.pre_check_json));
    } catch {
      preCheck = null;
    }
  }
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    trigger: String(row.trigger) as AutomationRunTrigger,
    status: String(row.status) as AutomationRunStatus,
    sessionJid: str(row.session_jid),
    inputMessageId: str(row.input_message_id),
    scheduledFor: String(row.scheduled_for),
    firedAt: str(row.fired_at),
    finishedAt: str(row.finished_at),
    resultText: str(row.result_text),
    error: str(row.error),
    preCheck,
    silenced: Number(row.silenced) === 1,
    readAt: str(row.read_at),
    createdAt: String(row.created_at),
  };
}

function runColumns(run: AutomationRun): Record<string, unknown> {
  return {
    id: run.id,
    automation_id: run.automationId,
    trigger: run.trigger,
    status: run.status,
    session_jid: run.sessionJid,
    input_message_id: run.inputMessageId,
    scheduled_for: run.scheduledFor,
    fired_at: run.firedAt,
    finished_at: run.finishedAt,
    result_text: run.resultText,
    error: run.error,
    pre_check_json: run.preCheck ? JSON.stringify(run.preCheck) : null,
    silenced: run.silenced ? 1 : 0,
    read_at: run.readAt,
    created_at: run.createdAt,
  };
}

const RUN_SQL = rowStatements(
  'automation_runs',
  Object.keys(runColumns({ preCheck: null } as unknown as AutomationRun)),
);

/** Throws on a second live run of the same automation (unique index). */
export function insertAutomationRun(run: AutomationRun): void {
  stmt(RUN_SQL.insert).run(runColumns(run));
}

export function saveAutomationRun(run: AutomationRun): void {
  stmt(RUN_SQL.update).run(runColumns(run));
}

/** Drop terminal runs beyond the newest `keep` of an automation. */
export function trimAutomationRuns(automationId: string, keep: number): void {
  stmt(
    `DELETE FROM automation_runs
     WHERE automation_id = @automationId
       AND status NOT IN ('queued', 'running')
       AND id NOT IN (
         SELECT id FROM automation_runs WHERE automation_id = @automationId
         ORDER BY created_at DESC, rowid DESC LIMIT @keep)`,
  ).run({ automationId, keep });
}

export function getAutomationRun(runId: string): AutomationRun | null {
  const row = stmt('SELECT * FROM automation_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? toRun(row) : null;
}

export function getLiveAutomationRun(
  automationId: string,
): AutomationRun | null {
  const row = stmt(
    `SELECT * FROM automation_runs
     WHERE automation_id = ? AND status IN ('queued', 'running')`,
  ).get(automationId) as Record<string, unknown> | undefined;
  return row ? toRun(row) : null;
}

export function listLiveAutomationRuns(): AutomationRun[] {
  return (
    stmt(
      `SELECT * FROM automation_runs WHERE status IN ('queued', 'running')
       ORDER BY created_at, id`,
    ).all() as Record<string, unknown>[]
  ).map(toRun);
}

export function listAutomationRuns(
  automationId: string,
  limit: number,
): AutomationRun[] {
  return (
    stmt(
      `SELECT * FROM automation_runs WHERE automation_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(automationId, limit) as Record<string, unknown>[]
  ).map(toRun);
}

export function listRunsInSession(sessionJid: string): AutomationRun[] {
  return (
    stmt(
      `SELECT * FROM automation_runs WHERE session_jid = ?
         AND status IN ('queued', 'running')`,
    ).all(sessionJid) as Record<string, unknown>[]
  ).map(toRun);
}

export function countUnreadAutomationRuns(automationId: string): number {
  const row = stmt(
    `SELECT COUNT(*) AS count FROM automation_runs
     WHERE automation_id = ? AND read_at IS NULL AND silenced = 0
       AND status IN ('success', 'failed', 'interrupted')`,
  ).get(automationId) as { count: number };
  return Number(row.count) || 0;
}

export function getLastAutomationRunStatus(
  automationId: string,
): AutomationRunStatus | null {
  const row = stmt(
    `SELECT status FROM automation_runs WHERE automation_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(automationId) as { status: AutomationRunStatus } | undefined;
  return row?.status ?? null;
}

/** Mark terminal runs read; all of them when `runIds` is omitted. */
export function markAutomationRunsRead(
  automationId: string,
  runIds: readonly string[] | undefined,
  now: string,
): void {
  const terminal = `status NOT IN ('queued', 'running')`;
  if (!runIds) {
    stmt(
      `UPDATE automation_runs SET read_at = ?
       WHERE automation_id = ? AND read_at IS NULL AND ${terminal}`,
    ).run(now, automationId);
    return;
  }
  const mark = stmt(
    `UPDATE automation_runs SET read_at = ?
     WHERE automation_id = ? AND id = ? AND read_at IS NULL AND ${terminal}`,
  );
  inAutomationTransaction(() => {
    for (const runId of runIds) mark.run(now, automationId, runId);
  });
}

// ─── Failure streaks ────────────────────────────────────────────────────

interface AutomationFailureStreak {
  automationId: string;
  errorKey: string;
  errorText: string;
  failureCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

function toStreak(row: Record<string, unknown>): AutomationFailureStreak {
  return {
    automationId: String(row.automation_id),
    errorKey: String(row.error_key),
    errorText: String(row.error_text),
    failureCount: Number(row.failure_count) || 0,
    firstFailedAt: String(row.first_failed_at),
    lastFailedAt: String(row.last_failed_at),
  };
}

const SELECT_STREAK =
  'SELECT * FROM automation_failure_streaks WHERE automation_id = ?';

/**
 * Count a failure. `notify` is true for the first failure of a streak and
 * when the normalized error changes; a repeat is only counted.
 */
export function recordAutomationFailure(
  automationId: string,
  errorKey: string,
  errorText: string,
  now: string,
): { notify: boolean; streak: AutomationFailureStreak } {
  return inAutomationTransaction(() => {
    const row = stmt(SELECT_STREAK).get(automationId) as
      | Record<string, unknown>
      | undefined;
    const repeat = !!row && String(row.error_key) === errorKey;
    if (repeat) {
      stmt(
        `UPDATE automation_failure_streaks
         SET failure_count = failure_count + 1, last_failed_at = ?
         WHERE automation_id = ?`,
      ).run(now, automationId);
    } else {
      stmt(
        `INSERT INTO automation_failure_streaks (
           automation_id, error_key, error_text, failure_count,
           first_failed_at, last_failed_at
         ) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           error_key = excluded.error_key,
           error_text = excluded.error_text,
           failure_count = 1,
           first_failed_at = excluded.first_failed_at,
           last_failed_at = excluded.last_failed_at`,
      ).run(automationId, errorKey, errorText, now, now);
    }
    return {
      notify: !repeat,
      streak: toStreak(
        stmt(SELECT_STREAK).get(automationId) as Record<string, unknown>,
      ),
    };
  });
}

/** End a failure streak; returns it so the caller can announce recovery. */
export function clearAutomationFailure(
  automationId: string,
): AutomationFailureStreak | null {
  return inAutomationTransaction(() => {
    const row = stmt(SELECT_STREAK).get(automationId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    stmt('DELETE FROM automation_failure_streaks WHERE automation_id = ?').run(
      automationId,
    );
    return toStreak(row);
  });
}

// ─── v84 → v85: scheduled tasks become automations ─────────────────────

/**
 * An instant from a legacy once-task value. Values with an offset or `Z`
 * are taken as is; bare local times (`2026-10-30T21:00[:00]`) are read in
 * `timeZone`, the zone the old scheduler used.
 */
export function parseLegacyInstant(
  value: string,
  timeZone: string,
): string | null {
  const trimmed = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      trimmed,
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // The zone's offset at that wall time; a second pass settles DST edges.
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    return (
      Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      ) - instant
    );
  };
  try {
    let instant = wall - offsetAt(wall);
    instant = wall - offsetAt(instant);
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}

function legacyName(prompt: string, scriptCommand: string | null): string {
  const firstLine = (text: string | null) =>
    text
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  const line = firstLine(prompt) || firstLine(scriptCommand) || '自动化';
  return line.length > 40 ? line.slice(0, 40) : line;
}

interface LegacyTaskMigrationResult {
  converted: number;
  skipped: Array<{ taskId: string; reason: string }>;
  /** Tasks created by someone other than the workspace owner. */
  reassigned: Array<{ taskId: string; from: string; to: string }>;
}

/**
 * Convert the live (not deleted, active or paused) rows of the legacy
 * `scheduled_tasks` table. Idempotent: a task keeps its id, and an id that
 * already exists is left alone. Next fires of recurring automations are
 * computed by the scheduler at startup; a once automation keeps its run time
 * so one that came due while the service was down still runs.
 */
export function migrateLegacyScheduledTasks(options: {
  timezone: string;
}): LegacyTaskMigrationResult {
  const db = requireDatabase();
  const result: LegacyTaskMigrationResult = {
    converted: 0,
    skipped: [],
    reassigned: [],
  };
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const col = (row: Record<string, unknown>, name: string): string | null =>
    columns.has(name) ? str(row[name]) : null;
  const rows = db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status IN ('active', 'paused')
         ${columns.has('deleted_at') ? 'AND deleted_at IS NULL' : ''}
       ORDER BY created_at, id`,
    )
    .all() as Record<string, unknown>[];
  const findWorkspace = db.prepare(
    `SELECT jid, folder, created_by FROM registered_groups
     WHERE folder = ? AND jid LIKE 'web:%'
     ORDER BY CASE WHEN jid = 'web:' || folder THEN 0 ELSE 1 END, added_at
     LIMIT 1`,
  );

  for (const row of rows) {
    const taskId = String(row.id);
    const skip = (reason: string) => result.skipped.push({ taskId, reason });
    const workspace = findWorkspace.get(String(row.group_folder)) as
      | { jid: string; folder: string; created_by: string | null }
      | undefined;
    if (!workspace) {
      skip('no web workspace for the task folder');
      continue;
    }
    // An automation belongs to its workspace's owner: REST isolation and
    // owner turns are keyed on it.
    const taskCreator = col(row, 'created_by');
    const createdBy = workspace.created_by ?? taskCreator;
    if (!createdBy) {
      skip('no owner');
      continue;
    }
    if (taskCreator && taskCreator !== createdBy)
      result.reassigned.push({ taskId, from: taskCreator, to: createdBy });
    const execution: Automation['execution'] =
      col(row, 'execution_type') === 'script' ? 'script' : 'agent';
    const prompt = String(row.prompt ?? '');
    const scriptCommand = col(row, 'script_command');
    const route = col(row, 'delivery_route_jid') ?? str(row.chat_jid);
    const deliveryRouteJid = route && !route.startsWith('web:') ? route : null;
    const sessionMode: Automation['sessionMode'] =
      execution === 'script' || row.context_mode === 'group'
        ? 'bound'
        : 'fresh';

    const kind = String(row.schedule_type);
    const value = String(row.schedule_value ?? '');
    let schedule: Automation['schedule'];
    let nextFireAt: string | null = null;
    if (kind === 'cron') {
      schedule = { kind: 'cron', cronExpr: value.trim(), timezone: null };
    } else if (kind === 'interval') {
      const intervalMs = Math.max(Number(value) || 0, 60_000);
      schedule = { kind: 'interval', intervalMs };
    } else if (kind === 'once') {
      const runAt = parseLegacyInstant(value, options.timezone);
      if (!runAt) {
        skip('unreadable once time');
        continue;
      }
      schedule = { kind: 'once', runAt };
      nextFireAt = runAt;
    } else {
      skip(`unknown schedule type ${kind}`);
      continue;
    }

    const createdAt = str(row.created_at) ?? new Date().toISOString();
    const lastRun = str(row.last_run);
    const automation: Automation = {
      id: taskId,
      workspaceJid: workspace.jid,
      workspaceFolder: workspace.folder,
      createdBy,
      name: legacyName(prompt, scriptCommand),
      prompt: execution === 'agent' ? prompt : '',
      stopWhen: null,
      schedule,
      endAt: null,
      sessionMode,
      targetSessionJid: sessionMode === 'bound' ? workspace.jid : null,
      model: null,
      deliveryRouteJid,
      silentWhenIdle: false,
      preRunCheck: null,
      execution,
      scriptCommand: execution === 'script' ? scriptCommand : null,
      status: row.status === 'paused' ? 'paused' : 'active',
      statusReason: null,
      nextFireAt: row.status === 'paused' ? null : nextFireAt,
      lastFiredAt: lastRun,
      lastFinishedAt: lastRun,
      revision: 1,
      createdAt,
      updatedAt: col(row, 'updated_at') || createdAt,
    };
    if (getAutomation(taskId)) continue;
    insertAutomation(automation);
    result.converted += 1;
  }
  return result;
}
