import crypto from 'node:crypto';
import type {
  EvalCase,
  EvalHumanFeedback,
  EvalRun,
  EvalRunCase,
  EvalSuite,
} from './types.js';
import {
  BUILTIN_EVAL_CASES,
  SYSTEM_EVAL_SUITE_DESCRIPTION,
  SYSTEM_EVAL_SUITE_ID,
  SYSTEM_EVAL_SUITE_NAME,
} from './eval-builtin-suite.js';

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

export function bindEvalDatabase(db: SqliteDatabase): void {
  database = db;
}

function getDb(): SqliteDatabase {
  if (!database) {
    throw new Error('Eval database has not been initialized');
  }
  return database;
}

export function createEvalSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_suites (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_system INTEGER NOT NULL DEFAULT 0,
      case_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eval_suites_owner
      ON eval_suites(owner_user_id, is_system);

    CREATE TABLE IF NOT EXISTS eval_cases (
      id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      input_prompt TEXT NOT NULL,
      expected_output TEXT NOT NULL DEFAULT '',
      eval_rules TEXT NOT NULL DEFAULT '{}',
      timeout_ms INTEGER NOT NULL DEFAULT 60000,
      order_num INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (suite_id) REFERENCES eval_suites(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_cases_suite
      ON eval_cases(suite_id, order_num);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      suite_id TEXT NOT NULL,
      suite_version INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'compare',
      base_version INTEGER,
      base_prompt_hash TEXT,
      target_version INTEGER,
      target_prompt_hash TEXT,
      model TEXT NOT NULL,
      capability_snapshot TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      total_cases INTEGER NOT NULL DEFAULT 0,
      completed_cases INTEGER NOT NULL DEFAULT 0,
      base_pass_count INTEGER NOT NULL DEFAULT 0,
      target_pass_count INTEGER NOT NULL DEFAULT 0,
      base_avg_duration_ms REAL NOT NULL DEFAULT 0,
      target_avg_duration_ms REAL NOT NULL DEFAULT 0,
      base_total_tokens INTEGER NOT NULL DEFAULT 0,
      target_total_tokens INTEGER NOT NULL DEFAULT 0,
      base_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      target_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_eval_runs_agent
      ON eval_runs(agent_profile_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_eval_runs_owner
      ON eval_runs(owner_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS eval_run_cases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      case_name TEXT NOT NULL,
      version_tag TEXT NOT NULL,
      prompt_version INTEGER NOT NULL,
      prompt_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      actual_output TEXT NOT NULL DEFAULT '',
      auto_score REAL NOT NULL DEFAULT 0,
      auto_verdict TEXT NOT NULL DEFAULT 'fail',
      eval_details TEXT NOT NULL DEFAULT '{}',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_total INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      tools_used TEXT NOT NULL DEFAULT '[]',
      human_feedback TEXT,
      human_notes TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_run_cases_run
      ON eval_run_cases(run_id, version_tag, case_id);
  `);
}

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (typeof val !== 'string' || !val.trim()) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

function mapSuiteRow(row: Record<string, unknown>): EvalSuite {
  return {
    id: String(row.id),
    owner_user_id: String(row.owner_user_id),
    name: String(row.name),
    description: String(row.description || ''),
    version: Number(row.version || 1),
    is_system: Boolean(row.is_system),
    case_count: Number(row.case_count || 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapCaseRow(row: Record<string, unknown>): EvalCase {
  return {
    id: String(row.id),
    suite_id: String(row.suite_id),
    name: String(row.name),
    category: String(row.category || 'general'),
    input_prompt: String(row.input_prompt),
    expected_output: String(row.expected_output || ''),
    eval_rules: parseJsonSafe(row.eval_rules, {}),
    timeout_ms: Number(row.timeout_ms || 60000),
    order_num: Number(row.order_num || 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapRunRow(row: Record<string, unknown>): EvalRun {
  return {
    id: String(row.id),
    owner_user_id: String(row.owner_user_id),
    agent_profile_id: String(row.agent_profile_id),
    agent_name: String(row.agent_name),
    suite_id: String(row.suite_id),
    suite_version: Number(row.suite_version || 1),
    mode: row.mode as EvalRun['mode'],
    base_version:
      row.base_version !== null && row.base_version !== undefined
        ? Number(row.base_version)
        : null,
    base_prompt_hash:
      row.base_prompt_hash !== null && row.base_prompt_hash !== undefined
        ? String(row.base_prompt_hash)
        : null,
    target_version:
      row.target_version !== null && row.target_version !== undefined
        ? Number(row.target_version)
        : null,
    target_prompt_hash:
      row.target_prompt_hash !== null && row.target_prompt_hash !== undefined
        ? String(row.target_prompt_hash)
        : null,
    model: String(row.model),
    capability_snapshot: parseJsonSafe(row.capability_snapshot, {}),
    status: row.status as EvalRun['status'],
    total_cases: Number(row.total_cases || 0),
    completed_cases: Number(row.completed_cases || 0),
    base_pass_count: Number(row.base_pass_count || 0),
    target_pass_count: Number(row.target_pass_count || 0),
    base_avg_duration_ms: Number(row.base_avg_duration_ms || 0),
    target_avg_duration_ms: Number(row.target_avg_duration_ms || 0),
    base_total_tokens: Number(row.base_total_tokens || 0),
    target_total_tokens: Number(row.target_total_tokens || 0),
    base_estimated_cost_usd: Number(row.base_estimated_cost_usd || 0),
    target_estimated_cost_usd: Number(row.target_estimated_cost_usd || 0),
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapRunCaseRow(row: Record<string, unknown>): EvalRunCase {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    case_id: String(row.case_id),
    case_name: String(row.case_name),
    version_tag: row.version_tag as EvalRunCase['version_tag'],
    prompt_version: Number(row.prompt_version || 0),
    prompt_hash: String(row.prompt_hash || ''),
    status: row.status as EvalRunCase['status'],
    actual_output: String(row.actual_output || ''),
    auto_score: Number(row.auto_score || 0),
    auto_verdict: row.auto_verdict as EvalRunCase['auto_verdict'],
    eval_details: parseJsonSafe(row.eval_details, {}),
    duration_ms: Number(row.duration_ms || 0),
    tokens_input: Number(row.tokens_input || 0),
    tokens_output: Number(row.tokens_output || 0),
    tokens_total: Number(row.tokens_total || 0),
    estimated_cost_usd: Number(row.estimated_cost_usd || 0),
    tools_used: parseJsonSafe(row.tools_used, []),
    human_feedback: (row.human_feedback as EvalHumanFeedback) || null,
    human_notes: row.human_notes ? String(row.human_notes) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Ensure the system-level 15 benchmark cases exist and are up to date. */
export function ensureBuiltinEvalSuite(): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM eval_suites WHERE id = ?')
      .get(SYSTEM_EVAL_SUITE_ID) as { id: string } | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO eval_suites (
          id, owner_user_id, name, description, version, is_system, case_count, created_at, updated_at
        ) VALUES (?, 'system', ?, ?, 1, 1, ?, ?, ?)`,
      ).run(
        SYSTEM_EVAL_SUITE_ID,
        SYSTEM_EVAL_SUITE_NAME,
        SYSTEM_EVAL_SUITE_DESCRIPTION,
        BUILTIN_EVAL_CASES.length,
        now,
        now,
      );
    } else {
      db.prepare(
        `UPDATE eval_suites SET
          name = ?, description = ?, case_count = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        SYSTEM_EVAL_SUITE_NAME,
        SYSTEM_EVAL_SUITE_DESCRIPTION,
        BUILTIN_EVAL_CASES.length,
        now,
        SYSTEM_EVAL_SUITE_ID,
      );
    }

    const insertOrReplaceCase = db.prepare(`
      INSERT OR REPLACE INTO eval_cases (
        id, suite_id, name, category, input_prompt, expected_output, eval_rules, timeout_ms, order_num, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of BUILTIN_EVAL_CASES) {
      insertOrReplaceCase.run(
        c.id,
        SYSTEM_EVAL_SUITE_ID,
        c.name,
        c.category,
        c.input_prompt,
        c.expected_output,
        JSON.stringify(c.eval_rules),
        c.timeout_ms,
        c.order_num,
        now,
        now,
      );
    }
  })();
}

export function listEvalSuites(ownerUserId: string): EvalSuite[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM eval_suites
       WHERE is_system = 1 OR owner_user_id = ?
       ORDER BY is_system DESC, created_at DESC`,
    )
    .all(ownerUserId) as Array<Record<string, unknown>>;
  return rows.map(mapSuiteRow);
}

export function getEvalSuite(
  id: string,
  ownerUserId?: string,
): EvalSuite | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM eval_suites WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const suite = mapSuiteRow(row);
  if (!suite.is_system && ownerUserId && suite.owner_user_id !== ownerUserId) {
    return null;
  }
  return suite;
}

export function listEvalCases(suiteId: string): EvalCase[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM eval_cases WHERE suite_id = ? ORDER BY order_num ASC, created_at ASC',
    )
    .all(suiteId) as Array<Record<string, unknown>>;
  return rows.map(mapCaseRow);
}

export function getEvalCase(id: string): EvalCase | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCaseRow(row) : null;
}

export function getEvalSuiteWithCases(
  id: string,
  ownerUserId?: string,
): (EvalSuite & { cases: EvalCase[] }) | null {
  const suite = getEvalSuite(id, ownerUserId);
  if (!suite) return null;
  const cases = listEvalCases(suite.id);
  return { ...suite, cases };
}

export function createEvalSuite(suite: {
  id?: string;
  owner_user_id: string;
  name: string;
  description?: string;
}): EvalSuite {
  const db = getDb();
  const id = suite.id || `eval-suite-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_suites (
      id, owner_user_id, name, description, version, is_system, case_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)`,
  ).run(id, suite.owner_user_id, suite.name, suite.description || '', now, now);
  return getEvalSuite(id)!;
}

export function updateEvalSuite(
  id: string,
  ownerUserId: string,
  patch: { name?: string; description?: string },
): EvalSuite | null {
  const db = getDb();
  const suite = getEvalSuite(id, ownerUserId);
  if (!suite || suite.is_system) return null;
  const now = new Date().toISOString();
  const newName = patch.name !== undefined ? patch.name : suite.name;
  const newDesc =
    patch.description !== undefined ? patch.description : suite.description;
  db.prepare(
    'UPDATE eval_suites SET name = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ?',
  ).run(newName, newDesc, now, id);
  return getEvalSuite(id, ownerUserId);
}

export function deleteEvalSuite(id: string, ownerUserId: string): boolean {
  const db = getDb();
  const suite = getEvalSuite(id, ownerUserId);
  if (!suite || suite.is_system) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM eval_cases WHERE suite_id = ?').run(id);
    db.prepare('DELETE FROM eval_suites WHERE id = ?').run(id);
  })();
  return true;
}

export function createEvalCase(
  data: Omit<EvalCase, 'id' | 'created_at' | 'updated_at'> & { id?: string },
): EvalCase {
  const db = getDb();
  const id = data.id || `eval-case-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO eval_cases (
        id, suite_id, name, category, input_prompt, expected_output, eval_rules, timeout_ms, order_num, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.suite_id,
      data.name,
      data.category || 'general',
      data.input_prompt,
      data.expected_output || '',
      JSON.stringify(data.eval_rules || {}),
      data.timeout_ms || 60000,
      data.order_num || 0,
      now,
      now,
    );
    db.prepare(
      'UPDATE eval_suites SET case_count = (SELECT COUNT(*) FROM eval_cases WHERE suite_id = ?), version = version + 1, updated_at = ? WHERE id = ?',
    ).run(data.suite_id, now, data.suite_id);
  })();
  const row = db
    .prepare('SELECT * FROM eval_cases WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return mapCaseRow(row);
}

export function updateEvalCase(
  id: string,
  suiteId: string,
  patch: Partial<
    Omit<EvalCase, 'id' | 'suite_id' | 'created_at' | 'updated_at'>
  >,
): EvalCase | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM eval_cases WHERE id = ? AND suite_id = ?')
    .get(id, suiteId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const current = mapCaseRow(row);
  const now = new Date().toISOString();

  const name = patch.name ?? current.name;
  const category = patch.category ?? current.category;
  const input_prompt = patch.input_prompt ?? current.input_prompt;
  const expected_output = patch.expected_output ?? current.expected_output;
  const eval_rules = patch.eval_rules ?? current.eval_rules;
  const timeout_ms = patch.timeout_ms ?? current.timeout_ms;
  const order_num = patch.order_num ?? current.order_num;

  db.transaction(() => {
    db.prepare(
      `UPDATE eval_cases SET
        name = ?, category = ?, input_prompt = ?, expected_output = ?, eval_rules = ?, timeout_ms = ?, order_num = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      category,
      input_prompt,
      expected_output,
      JSON.stringify(eval_rules),
      timeout_ms,
      order_num,
      now,
      id,
    );
    db.prepare(
      'UPDATE eval_suites SET version = version + 1, updated_at = ? WHERE id = ?',
    ).run(now, suiteId);
  })();

  const updatedRow = db
    .prepare('SELECT * FROM eval_cases WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return mapCaseRow(updatedRow);
}

export function deleteEvalCase(id: string, suiteId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  let deleted = false;
  db.transaction(() => {
    const res = db
      .prepare('DELETE FROM eval_cases WHERE id = ? AND suite_id = ?')
      .run(id, suiteId);
    if (res.changes > 0) {
      deleted = true;
      db.prepare(
        'UPDATE eval_suites SET case_count = (SELECT COUNT(*) FROM eval_cases WHERE suite_id = ?), version = version + 1, updated_at = ? WHERE id = ?',
      ).run(suiteId, now, suiteId);
    }
  })();
  return deleted;
}

export function createEvalRun(
  run: Omit<EvalRun, 'created_at' | 'updated_at' | 'completed_at'>,
): EvalRun {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_runs (
      id, owner_user_id, agent_profile_id, agent_name, suite_id, suite_version, mode,
      base_version, base_prompt_hash, target_version, target_prompt_hash, model,
      capability_snapshot, status, total_cases, completed_cases, base_pass_count, target_pass_count,
      base_avg_duration_ms, target_avg_duration_ms, base_total_tokens, target_total_tokens,
      base_estimated_cost_usd, target_estimated_cost_usd, error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )`,
  ).run(
    run.id,
    run.owner_user_id,
    run.agent_profile_id,
    run.agent_name,
    run.suite_id,
    run.suite_version,
    run.mode,
    run.base_version,
    run.base_prompt_hash,
    run.target_version,
    run.target_prompt_hash,
    run.model,
    JSON.stringify(run.capability_snapshot || {}),
    run.status || 'pending',
    run.total_cases,
    run.completed_cases || 0,
    run.base_pass_count || 0,
    run.target_pass_count || 0,
    run.base_avg_duration_ms || 0,
    run.target_avg_duration_ms || 0,
    run.base_total_tokens || 0,
    run.target_total_tokens || 0,
    run.base_estimated_cost_usd || 0,
    run.target_estimated_cost_usd || 0,
    run.error_message || null,
    now,
    now,
  );
  return getEvalRun(run.id)!;
}

export function getEvalRun(id: string, ownerUserId?: string): EvalRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const run = mapRunRow(row);
  if (ownerUserId && run.owner_user_id !== ownerUserId) return null;
  return run;
}

export function listEvalRuns(
  ownerUserId: string,
  agentProfileId?: string,
): EvalRun[] {
  const db = getDb();
  let sql = 'SELECT * FROM eval_runs WHERE owner_user_id = ?';
  const params: unknown[] = [ownerUserId];
  if (agentProfileId) {
    sql += ' AND agent_profile_id = ?';
    params.push(agentProfileId);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRunRow);
}

export function updateEvalRun(
  id: string,
  patch: Partial<EvalRun>,
): EvalRun | null {
  const db = getDb();
  const existing = getEvalRun(id);
  if (!existing) return null;
  const now = new Date().toISOString();

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
    if (
      ['completed', 'failed', 'cancelled'].includes(patch.status) &&
      !existing.completed_at
    ) {
      sets.push('completed_at = ?');
      params.push(patch.completed_at || now);
    }
  }
  if (patch.completed_cases !== undefined) {
    sets.push('completed_cases = ?');
    params.push(patch.completed_cases);
  }
  if (patch.base_pass_count !== undefined) {
    sets.push('base_pass_count = ?');
    params.push(patch.base_pass_count);
  }
  if (patch.target_pass_count !== undefined) {
    sets.push('target_pass_count = ?');
    params.push(patch.target_pass_count);
  }
  if (patch.base_avg_duration_ms !== undefined) {
    sets.push('base_avg_duration_ms = ?');
    params.push(patch.base_avg_duration_ms);
  }
  if (patch.target_avg_duration_ms !== undefined) {
    sets.push('target_avg_duration_ms = ?');
    params.push(patch.target_avg_duration_ms);
  }
  if (patch.base_total_tokens !== undefined) {
    sets.push('base_total_tokens = ?');
    params.push(patch.base_total_tokens);
  }
  if (patch.target_total_tokens !== undefined) {
    sets.push('target_total_tokens = ?');
    params.push(patch.target_total_tokens);
  }
  if (patch.base_estimated_cost_usd !== undefined) {
    sets.push('base_estimated_cost_usd = ?');
    params.push(patch.base_estimated_cost_usd);
  }
  if (patch.target_estimated_cost_usd !== undefined) {
    sets.push('target_estimated_cost_usd = ?');
    params.push(patch.target_estimated_cost_usd);
  }
  if (patch.error_message !== undefined) {
    sets.push('error_message = ?');
    params.push(patch.error_message);
  }

  params.push(id);
  db.prepare(`UPDATE eval_runs SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );
  return getEvalRun(id);
}

export function deleteEvalRun(id: string, ownerUserId: string): boolean {
  const db = getDb();
  const existing = getEvalRun(id, ownerUserId);
  if (!existing) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM eval_run_cases WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM eval_runs WHERE id = ?').run(id);
  })();
  return true;
}

export function createEvalRunCase(
  data: Omit<EvalRunCase, 'id' | 'created_at' | 'updated_at'> & { id?: string },
): EvalRunCase {
  const db = getDb();
  const id = data.id || `eval-rcase-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO eval_run_cases (
      id, run_id, case_id, case_name, version_tag, prompt_version, prompt_hash,
      status, actual_output, auto_score, auto_verdict, eval_details, duration_ms,
      tokens_input, tokens_output, tokens_total, estimated_cost_usd, tools_used,
      human_feedback, human_notes, error_message, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )`,
  ).run(
    id,
    data.run_id,
    data.case_id,
    data.case_name,
    data.version_tag,
    data.prompt_version,
    data.prompt_hash,
    data.status,
    data.actual_output || '',
    data.auto_score || 0,
    data.auto_verdict || 'fail',
    JSON.stringify(data.eval_details || {}),
    data.duration_ms || 0,
    data.tokens_input || 0,
    data.tokens_output || 0,
    data.tokens_total || 0,
    data.estimated_cost_usd || 0,
    JSON.stringify(data.tools_used || []),
    data.human_feedback || null,
    data.human_notes || null,
    data.error_message || null,
    now,
    now,
  );

  const row = db
    .prepare('SELECT * FROM eval_run_cases WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return mapRunCaseRow(row);
}

export function getEvalRunCase(id: string): EvalRunCase | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM eval_run_cases WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRunCaseRow(row) : null;
}

export function listEvalRunCases(runId: string): EvalRunCase[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM eval_run_cases WHERE run_id = ? ORDER BY case_id ASC, version_tag ASC',
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapRunCaseRow);
}

export function updateEvalRunCase(
  id: string,
  patch: Partial<EvalRunCase>,
): EvalRunCase | null {
  const db = getDb();
  const existing = getEvalRunCase(id);
  if (!existing) return null;
  const now = new Date().toISOString();

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.actual_output !== undefined) {
    sets.push('actual_output = ?');
    params.push(patch.actual_output);
  }
  if (patch.auto_score !== undefined) {
    sets.push('auto_score = ?');
    params.push(patch.auto_score);
  }
  if (patch.auto_verdict !== undefined) {
    sets.push('auto_verdict = ?');
    params.push(patch.auto_verdict);
  }
  if (patch.eval_details !== undefined) {
    sets.push('eval_details = ?');
    params.push(JSON.stringify(patch.eval_details));
  }
  if (patch.duration_ms !== undefined) {
    sets.push('duration_ms = ?');
    params.push(patch.duration_ms);
  }
  if (patch.tokens_input !== undefined) {
    sets.push('tokens_input = ?');
    params.push(patch.tokens_input);
  }
  if (patch.tokens_output !== undefined) {
    sets.push('tokens_output = ?');
    params.push(patch.tokens_output);
  }
  if (patch.tokens_total !== undefined) {
    sets.push('tokens_total = ?');
    params.push(patch.tokens_total);
  }
  if (patch.estimated_cost_usd !== undefined) {
    sets.push('estimated_cost_usd = ?');
    params.push(patch.estimated_cost_usd);
  }
  if (patch.tools_used !== undefined) {
    sets.push('tools_used = ?');
    params.push(JSON.stringify(patch.tools_used));
  }
  if (patch.human_feedback !== undefined) {
    sets.push('human_feedback = ?');
    params.push(patch.human_feedback);
  }
  if (patch.human_notes !== undefined) {
    sets.push('human_notes = ?');
    params.push(patch.human_notes);
  }
  if (patch.error_message !== undefined) {
    sets.push('error_message = ?');
    params.push(patch.error_message);
  }

  params.push(id);
  db.prepare(`UPDATE eval_run_cases SET ${sets.join(', ')} WHERE id = ?`).run(
    ...params,
  );
  return getEvalRunCase(id);
}

export function updateEvalRunCaseFeedback(
  id: string,
  feedback: EvalHumanFeedback,
  notes?: string | null,
): EvalRunCase | null {
  const db = getDb();
  const existing = getEvalRunCase(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updatedNotes = notes !== undefined ? notes : existing.human_notes;

  db.prepare(
    `UPDATE eval_run_cases SET
      human_feedback = ?, human_notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(feedback, updatedNotes, now, id);

  return getEvalRunCase(id);
}
