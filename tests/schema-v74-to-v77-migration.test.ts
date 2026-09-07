import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v74-v77-test-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: dataDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function getColumns(sqlite: Database.Database, tableName: string): Set<string> {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

describe('schema migration chain v74 -> v75 -> v76 -> v77', () => {
  test('migrates legacy v74 database incrementally through v75, v76 to v77', () => {
    // 1. First initialize fresh to create full base schema, then drop v75/v76/v77 artifacts and reset to 74
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE IF EXISTS eval_run_cases;
      DROP TABLE IF EXISTS eval_runs;
      DROP TABLE IF EXISTS eval_cases;
      DROP TABLE IF EXISTS eval_suites;
      DROP TABLE IF EXISTS task_run_artifacts;
      DROP TABLE IF EXISTS task_templates;
      DROP TABLE IF EXISTS task_budgets;
      UPDATE router_state SET value = '74' WHERE key = 'schema_version';
    `);
    legacy.close();

    // Verify v74 state before migration
    const beforeDb = new Database(databasePath, { readonly: true });
    expect(tableExists(beforeDb, 'eval_suites')).toBe(false);
    expect(tableExists(beforeDb, 'eval_runs')).toBe(false);
    expect(tableExists(beforeDb, 'task_templates')).toBe(false);
    expect(tableExists(beforeDb, 'task_run_artifacts')).toBe(false);
    expect(tableExists(beforeDb, 'task_budgets')).toBe(false);
    beforeDb.close();

    // 2. Perform migration via initDatabase()
    db.initDatabase();
    expect(db.CURRENT_SCHEMA_VERSION).toBe(77);
    expect(db.getRouterState('schema_version')).toBe('77');

    // 3. Verify all tables, columns and seed data
    const afterDb = new Database(databasePath, { readonly: true });

    // v75 tables (Eval R17)
    expect(tableExists(afterDb, 'eval_suites')).toBe(true);
    expect(tableExists(afterDb, 'eval_cases')).toBe(true);
    expect(tableExists(afterDb, 'eval_runs')).toBe(true);
    expect(tableExists(afterDb, 'eval_run_cases')).toBe(true);

    const evalRunCols = getColumns(afterDb, 'eval_runs');
    expect(evalRunCols.has('provider_source')).toBe(true);
    expect(evalRunCols.has('provider_id')).toBe(true);

    const evalRunCaseCols = getColumns(afterDb, 'eval_run_cases');
    expect(evalRunCaseCols.has('category')).toBe(true);
    expect(evalRunCaseCols.has('case_input_snapshot')).toBe(true);
    expect(evalRunCaseCols.has('cache_read_tokens')).toBe(true);
    expect(evalRunCaseCols.has('reasoning_tokens')).toBe(true);

    const builtinSuite = afterDb
      .prepare(
        "SELECT * FROM eval_suites WHERE id = 'eval-suite-system-benchmark-15'",
      )
      .get() as { id: string } | undefined;
    expect(builtinSuite?.id).toBe('eval-suite-system-benchmark-15');

    // v76 tables (Artifacts R18/R19)
    expect(tableExists(afterDb, 'task_templates')).toBe(true);
    expect(tableExists(afterDb, 'task_run_artifacts')).toBe(true);

    const templateCols = getColumns(afterDb, 'task_templates');
    expect(templateCols.has('prompt_template')).toBe(true);
    expect(templateCols.has('parameter_definitions')).toBe(true);

    const artifactCols = getColumns(afterDb, 'task_run_artifacts');
    expect(artifactCols.has('run_id')).toBe(true);
    expect(artifactCols.has('file_hash')).toBe(true);
    expect(artifactCols.has('storage_path')).toBe(true);

    // v77 tables (Budget R16)
    expect(tableExists(afterDb, 'task_budgets')).toBe(true);
    const budgetCols = getColumns(afterDb, 'task_budgets');
    expect(budgetCols.has('run_id')).toBe(true);
    expect(budgetCols.has('max_duration_ms')).toBe(true);
    expect(budgetCols.has('max_tool_calls')).toBe(true);
    expect(budgetCols.has('max_cost_usd')).toBe(true);
    expect(budgetCols.has('current_duration_ms')).toBe(true);
    expect(budgetCols.has('partial_result')).toBe(true);

    const scheduledTaskCols = getColumns(afterDb, 'scheduled_tasks');
    expect(scheduledTaskCols.has('budget_config')).toBe(true);

    const agentCols = getColumns(afterDb, 'agents');
    expect(agentCols.has('parent_budget_run_id')).toBe(true);

    afterDb.close();
    db.closeDatabase();
  });

  test('is idempotent when re-initialized on v77', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('77');
    db.closeDatabase();

    // Re-initialize should succeed without error
    expect(() => {
      db.initDatabase();
      db.closeDatabase();
    }).not.toThrow();
  });

  test('refuses downgrade when database schema is newer than v77', () => {
    // Manually bump schema_version in router_state to 78 (future version)
    const futureDb = new Database(databasePath);
    futureDb.exec(
      "UPDATE router_state SET value = '78' WHERE key = 'schema_version';",
    );
    futureDb.close();

    expect(() => db.initDatabase()).toThrow(
      /Database schema v78 is newer than supported v77; refusing downgrade/,
    );
  });
});
