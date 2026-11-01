import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-migration-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  TIMEZONE: 'Asia/Shanghai',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { formerMainSession } = await import('./helpers/legacy-main-session.js');
const { logger } = await import('../src/logger.js');
const store = await import('../src/automation-store.js');

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

const LEGACY_SCHEMA = `
  CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    context_mode TEXT DEFAULT 'isolated',
    execution_type TEXT DEFAULT 'agent',
    script_command TEXT,
    next_run TEXT,
    last_run TEXT,
    last_result TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL,
    created_by TEXT,
    notify_channels TEXT,
    execution_mode TEXT,
    workspace_jid TEXT,
    workspace_folder TEXT,
    running_until TEXT,
    runner_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT,
    delivery_route_jid TEXT
  );
  CREATE TABLE task_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
  );
  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
  );
  CREATE TABLE IF NOT EXISTS task_failure_notices (
    task_id TEXT PRIMARY KEY,
    error_key TEXT NOT NULL,
    error_text TEXT NOT NULL,
    failure_count INTEGER NOT NULL,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL
  );
`;

interface LegacyTask {
  id: string;
  folder?: string;
  prompt: string;
  type: 'cron' | 'interval' | 'once';
  value: string;
  context?: 'group' | 'isolated';
  execution?: 'agent' | 'script';
  script?: string | null;
  status?: string;
  deletedAt?: string | null;
  chatJid?: string;
  route?: string | null;
  lastRun?: string | null;
  createdBy?: string | null;
}

/** A current database rewound to the v84 shape with legacy task rows. */
function buildV84Database(tasks: LegacyTask[]): void {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.setRegisteredGroup('web:alpha', {
    name: 'Alpha',
    folder: 'alpha',
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: 'owner-a',
  } as never);
  db.setRegisteredGroup('feishu:oc_alpha', {
    name: 'Alpha Feishu',
    folder: 'alpha',
    added_at: '2025-12-01T00:00:00.000Z',
    created_by: 'owner-a',
  } as never);
  db.closeDatabase();

  const raw = new Database(databasePath);
  raw.exec(`
    DROP TABLE automation_runs;
    DROP TABLE automation_failure_streaks;
    DROP TABLE automations;
  `);
  raw.exec(LEGACY_SCHEMA);
  const insert = raw.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
      context_mode, execution_type, script_command, status, created_at,
      created_by, deleted_at, delivery_route_jid, last_run, updated_at
    ) VALUES (
      @id, @folder, @chatJid, @prompt, @type, @value, @context, @execution,
      @script, @status, '2026-02-01T00:00:00.000Z', @createdBy, @deletedAt,
      @route, @lastRun, '2026-02-02T00:00:00.000Z'
    )`);
  for (const task of tasks) {
    insert.run({
      folder: 'alpha',
      context: 'isolated',
      execution: 'agent',
      script: null,
      status: 'active',
      deletedAt: null,
      chatJid: 'web:alpha',
      route: null,
      lastRun: null,
      createdBy: 'owner-a',
      ...task,
    });
  }
  raw
    .prepare(
      "INSERT INTO task_runs (id, task_id, status) VALUES ('tr1', ?, 'success')",
    )
    .run(tasks[0].id);
  raw
    .prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status)
       VALUES (?, '2026-02-03T00:00:00Z', 1, 'success')`,
    )
    .run(tasks[0].id);
  const wait = raw.prepare(`
    INSERT INTO usage_limit_waits (
      scope_key, input_key, wait_count, reset_at, resume_at, state,
      created_at, updated_at
    ) VALUES (?, 'k', 1, 'x', 'x', 'waiting', 'x', 'x')`);
  wait.run('task-run:tr1');
  wait.run('web:alpha');
  raw
    .prepare(
      "UPDATE router_state SET value = '84' WHERE key = 'schema_version'",
    )
    .run();
  raw.close();
}

function tableNames(): string[] {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

describe('v84 → v85', () => {
  test('live tasks become automations and the task tables go', () => {
    buildV84Database([
      {
        id: 'group-cron',
        prompt:
          '\n  每天早上汇总一下昨天合入的 PR，并列出需要我处理的评论和失败的 CI 任务\n第二行',
        type: 'cron',
        value: '0 9 * * *',
        context: 'group',
        chatJid: 'feishu:oc_alpha',
        route: 'feishu:oc_alpha#thread:omt_1',
        lastRun: '2026-02-03T01:00:00.000Z',
      },
      {
        id: 'isolated-interval',
        prompt: '检查磁盘',
        type: 'interval',
        value: '1800000',
        context: 'isolated',
        route: 'web:alpha',
      },
      {
        id: 'script-task',
        prompt: '',
        type: 'cron',
        value: '*/10 * * * *',
        execution: 'script',
        script: 'backup.sh --all',
      },
      {
        id: 'once-local',
        prompt: '提醒我开会',
        type: 'once',
        value: '2026-03-01T09:30:00',
      },
      {
        id: 'deleted-task',
        prompt: '已删除',
        type: 'cron',
        value: '0 * * * *',
        deletedAt: '2026-02-05T00:00:00.000Z',
      },
      {
        id: 'paused-task',
        prompt: '暂停中',
        type: 'interval',
        value: '30000',
        status: 'paused',
      },
      {
        id: 'completed-task',
        prompt: '做完了',
        type: 'once',
        value: '2026-01-01T00:00:00Z',
        status: 'completed',
      },
      {
        id: 'foreign-creator',
        prompt: '别人建的',
        type: 'cron',
        value: '0 * * * *',
        createdBy: 'member-b',
      },
      {
        id: 'no-creator',
        prompt: '老任务',
        type: 'cron',
        value: '0 * * * *',
        createdBy: null,
      },
      {
        id: 'orphan-folder',
        prompt: '没有工作区',
        type: 'cron',
        value: '0 * * * *',
        folder: 'gone',
      },
    ]);

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(
      fs
        .readdirSync(backupDir)
        .some((f) => f.includes(`v84-to-v${db.CURRENT_SCHEMA_VERSION}-`)),
    ).toBe(true);

    // v88 then retargets the main-session automations onto the session the
    // main session became.
    const alphaSession = formerMainSession(db, 'web:alpha').jid;
    const byId = new Map(
      store
        .listAutomations({})
        .map((automation) => [automation.id, automation]),
    );
    expect([...byId.keys()].sort()).toEqual(
      [
        'foreign-creator',
        'group-cron',
        'isolated-interval',
        'no-creator',
        'once-local',
        'paused-task',
        'script-task',
      ].sort(),
    );
    // Every automation belongs to the workspace owner.
    expect(byId.get('foreign-creator')?.createdBy).toBe('owner-a');
    expect(byId.get('no-creator')?.createdBy).toBe('owner-a');
    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: 'foreign-creator', from: 'member-b', to: 'owner-a' },
      expect.stringContaining('not the workspace owner'),
    );
    expect(byId.get('group-cron')).toMatchObject({
      workspaceJid: 'web:alpha',
      workspaceFolder: 'alpha',
      createdBy: 'owner-a',
      name: '每天早上汇总一下昨天合入的 PR，并列出需要我处理的评论和失败的 CI 任务'.slice(
        0,
        40,
      ),
      sessionMode: 'bound',
      targetSessionJid: alphaSession,
      deliveryRouteJid: 'feishu:oc_alpha#thread:omt_1',
      schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: null },
      execution: 'agent',
      status: 'active',
      nextFireAt: null,
      lastFinishedAt: '2026-02-03T01:00:00.000Z',
    });
    expect(byId.get('isolated-interval')).toMatchObject({
      sessionMode: 'fresh',
      targetSessionJid: null,
      deliveryRouteJid: null,
      schedule: { kind: 'interval', intervalMs: 1_800_000 },
    });
    expect(byId.get('script-task')).toMatchObject({
      execution: 'script',
      scriptCommand: 'backup.sh --all',
      prompt: '',
      name: 'backup.sh --all',
      sessionMode: 'bound',
      targetSessionJid: alphaSession,
    });
    // Local time in the scheduler zone (UTC+8).
    expect(byId.get('once-local')).toMatchObject({
      schedule: { kind: 'once', runAt: '2026-03-01T01:30:00.000Z' },
      nextFireAt: '2026-03-01T01:30:00.000Z',
    });
    expect(byId.get('paused-task')).toMatchObject({
      status: 'paused',
      schedule: { kind: 'interval', intervalMs: 60_000 },
    });

    const tables = tableNames();
    for (const gone of [
      'scheduled_tasks',
      'task_runs',
      'task_run_logs',
      'task_failure_notices',
    ]) {
      expect(tables).not.toContain(gone);
    }
    expect(tables).toEqual(
      expect.arrayContaining([
        'automations',
        'automation_runs',
        'automation_failure_streaks',
      ]),
    );

    db.closeDatabase();
    const raw = new Database(databasePath, { readonly: true });
    expect(
      raw.prepare('SELECT scope_key FROM usage_limit_waits').all(),
    ).toEqual([{ scope_key: alphaSession }]);
    expect(
      raw
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: String(db.CURRENT_SCHEMA_VERSION) });
    raw.close();
  });

  test('a restart after the upgrade changes nothing', () => {
    db.initDatabase();
    const before = store.listAutomations({});
    db.closeDatabase();
    db.initDatabase();
    expect(store.listAutomations({})).toEqual(before);
    expect(tableNames()).not.toContain('scheduled_tasks');
    db.closeDatabase();
  });

  test('a newer database is refused', () => {
    const raw = new Database(databasePath);
    raw
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    raw.close();
    expect(() => db.initDatabase()).toThrow(/refusing downgrade/);
  });
});

describe('parseLegacyInstant', () => {
  test('keeps explicit offsets and reads bare times in the zone', () => {
    expect(
      store.parseLegacyInstant('2026-03-01T09:30:00Z', 'Asia/Shanghai'),
    ).toBe('2026-03-01T09:30:00.000Z');
    expect(
      store.parseLegacyInstant('2026-03-01T09:30:00+02:00', 'Asia/Shanghai'),
    ).toBe('2026-03-01T07:30:00.000Z');
    // New York is UTC-5 in winter and UTC-4 in summer.
    expect(
      store.parseLegacyInstant('2026-01-15T09:00', 'America/New_York'),
    ).toBe('2026-01-15T14:00:00.000Z');
    expect(
      store.parseLegacyInstant('2026-07-15T09:00', 'America/New_York'),
    ).toBe('2026-07-15T13:00:00.000Z');
    expect(store.parseLegacyInstant('tomorrow', 'UTC')).toBeNull();
  });
});
