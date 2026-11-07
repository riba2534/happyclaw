/**
 * Durable state of team mode (团队模式): work items, the threads they
 * subscribe to, their event log, the replies the host owes a group and the
 * router's decisions. Multi-task mode's delegated items share the work item
 * table (origin 'delegated'); the queries of a group read team items only.
 *
 * db.ts binds this module to its connection. The work item service is the
 * only writer; REST and views read through it as well.
 */
export type { WorkEvent, WorkEventKind } from './work-items.js';
import {
  parseTeamSettings,
  type TeamSettings,
  type WorkDecision,
  type WorkDecisionKind,
  type WorkEvent,
  type WorkEventKind,
  type WorkItem,
  type WorkItemOrigin,
  type WorkItemOutcome,
  type WorkItemStatus,
  type WorkMandate,
  type WorkReportState,
  type WorkStrength,
} from './work-items.js';

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
  if (!database) throw new Error('Work item store is not initialized');
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
export function initWorkItemStore(db: SqliteDatabase | null): void {
  database = db;
  statements.clear();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_mounts (
      channel_jid TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      router_agent_id TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_mounts_workspace
      ON team_mounts(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_team_mounts_router
      ON team_mounts(router_agent_id);

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      seq INTEGER NOT NULL,
      channel_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_route_jid TEXT NOT NULL,
      mandate_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      last_report TEXT,
      last_summary TEXT,
      attention TEXT,
      attention_message_id TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      origin TEXT NOT NULL DEFAULT 'team' CHECK (origin IN ('team', 'delegated')),
      origin_agent_id TEXT,
      origin_input_id TEXT,
      UNIQUE (workspace_jid, seq),
      UNIQUE (channel_jid, source_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_workspace
      ON work_items(workspace_jid, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_agent
      ON work_items(agent_id);

    CREATE TABLE IF NOT EXISTS work_item_subscriptions (
      work_item_id TEXT NOT NULL,
      channel_jid TEXT NOT NULL,
      sub_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (work_item_id, channel_jid, sub_key)
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_subscriptions_key
      ON work_item_subscriptions(channel_jid, sub_key);

    CREATE TABLE IF NOT EXISTS work_item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT,
      text TEXT NOT NULL DEFAULT '',
      trigger_message_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_events_item
      ON work_item_events(work_item_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_events_ack
      ON work_item_events(trigger_message_id)
      WHERE kind = 'ack' AND trigger_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_work_item_events_trigger
      ON work_item_events(work_item_id, kind, trigger_message_id);

    CREATE TABLE IF NOT EXISTS work_decisions (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      channel_jid TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      strength TEXT NOT NULL,
      kind TEXT NOT NULL,
      work_item_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      matched_rule_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_decisions_workspace
      ON work_decisions(workspace_jid, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_decisions_trigger
      ON work_decisions(channel_jid, trigger_message_id);

    CREATE TABLE IF NOT EXISTS work_item_replies (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      work_item_id TEXT,
      channel_jid TEXT NOT NULL,
      quote_message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      purpose TEXT NOT NULL,
      lane_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_replies_status
      ON work_item_replies(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_item_replies_posted
      ON work_item_replies(channel_jid, provider_message_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_channel
      ON work_items(channel_jid, status, updated_at);
  `);
  // v88 -> v89: multi-task mode. Items of databases made before it are all
  // team items.
  ensureColumn(
    db,
    'work_items',
    'origin',
    "TEXT NOT NULL DEFAULT 'team' CHECK (origin IN ('team', 'delegated'))",
  );
  ensureColumn(db, 'work_items', 'origin_agent_id', 'TEXT');
  ensureColumn(db, 'work_items', 'origin_input_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_origin_agent
      ON work_items(origin_agent_id, status);
  `);
}

function ensureColumn(
  db: SqliteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ── Team mode settings ─────────────────────────────────────────────────

/**
 * Team settings live beside the mount, not on it: channel_mounts is rebuilt
 * from registered_groups. A row whose workspace no longer matches the
 * mount's is ignored by callers (they check the live mount).
 */
export interface TeamMount {
  channelJid: string;
  workspaceJid: string;
  settings: TeamSettings;
  /** The Runtime Session that routes this group (source_kind 'team_router'). */
  routerAgentId: string | null;
  updatedAt: string;
}

interface TeamMountRow {
  channel_jid: string;
  workspace_jid: string;
  settings_json: string;
  router_agent_id: string | null;
  updated_at: string;
}

function mapTeamMount(row: TeamMountRow): TeamMount {
  return {
    channelJid: row.channel_jid,
    workspaceJid: row.workspace_jid,
    settings: parseTeamSettings(row.settings_json),
    routerAgentId: row.router_agent_id,
    updatedAt: row.updated_at,
  };
}

export function getTeamMount(channelJid: string): TeamMount | undefined {
  const row = stmt('SELECT * FROM team_mounts WHERE channel_jid = ?').get(
    channelJid,
  ) as TeamMountRow | undefined;
  return row ? mapTeamMount(row) : undefined;
}

export function getTeamMountByRouter(
  routerAgentId: string,
): TeamMount | undefined {
  const row = stmt('SELECT * FROM team_mounts WHERE router_agent_id = ?').get(
    routerAgentId,
  ) as TeamMountRow | undefined;
  return row ? mapTeamMount(row) : undefined;
}

export function listAllTeamMounts(): TeamMount[] {
  return (stmt('SELECT * FROM team_mounts').all() as TeamMountRow[]).map(
    mapTeamMount,
  );
}

export function listTeamMounts(workspaceJid: string): TeamMount[] {
  return (
    stmt('SELECT * FROM team_mounts WHERE workspace_jid = ?').all(
      workspaceJid,
    ) as TeamMountRow[]
  ).map(mapTeamMount);
}

export function saveTeamMountSettings(input: {
  channelJid: string;
  workspaceJid: string;
  settings: TeamSettings;
  /** Undefined keeps the stored router. */
  routerAgentId?: string | null;
  updatedBy: string | null;
  now: string;
}): TeamMount {
  const existing = getTeamMount(input.channelJid);
  const routerAgentId =
    input.routerAgentId !== undefined
      ? input.routerAgentId
      : existing?.workspaceJid === input.workspaceJid
        ? existing.routerAgentId
        : null;
  stmt(
    `INSERT INTO team_mounts (channel_jid, workspace_jid, settings_json, router_agent_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_jid) DO UPDATE SET
       workspace_jid = excluded.workspace_jid,
       settings_json = excluded.settings_json,
       router_agent_id = excluded.router_agent_id,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    input.channelJid,
    input.workspaceJid,
    JSON.stringify(input.settings),
    routerAgentId,
    input.updatedBy,
    input.now,
  );
  return getTeamMount(input.channelJid)!;
}

export function deleteTeamMount(channelJid: string): void {
  stmt('DELETE FROM team_mounts WHERE channel_jid = ?').run(channelJid);
}

// ── Work items ─────────────────────────────────────────────────────────

interface WorkItemRow {
  id: string;
  workspace_jid: string;
  workspace_folder: string;
  seq: number;
  channel_jid: string;
  agent_id: string;
  title: string;
  source_message_id: string;
  source_route_jid: string;
  mandate_json: string;
  status: string;
  outcome: string | null;
  last_report: string | null;
  last_summary: string | null;
  attention: string | null;
  attention_message_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  origin: string;
  origin_agent_id: string | null;
  origin_input_id: string | null;
}

function mapItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    seq: row.seq,
    workspaceJid: row.workspace_jid,
    workspaceFolder: row.workspace_folder,
    channelJid: row.channel_jid,
    agentId: row.agent_id,
    title: row.title,
    sourceMessageId: row.source_message_id,
    sourceRouteJid: row.source_route_jid,
    origin: (row.origin === 'delegated'
      ? 'delegated'
      : 'team') as WorkItemOrigin,
    originAgentId: row.origin_agent_id,
    originInputId: row.origin_input_id,
    mandate: JSON.parse(row.mandate_json) as WorkMandate,
    status: (row.status === 'ended' ? 'ended' : 'open') as WorkItemStatus,
    outcome: (row.outcome ?? null) as WorkItemOutcome,
    lastReport: (row.last_report ?? null) as WorkReportState | null,
    lastSummary: row.last_summary,
    attention: row.attention,
    attentionMessageId: row.attention_message_id,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

export interface NewWorkItem {
  id: string;
  workspaceJid: string;
  workspaceFolder: string;
  channelJid: string;
  agentId: string;
  title: string;
  sourceMessageId: string;
  sourceRouteJid: string;
  mandate: WorkMandate;
  now: string;
  /** Delegated items only: the session that delegated it and its input. */
  delegatedBy?: { agentId: string; inputId: string | null };
}

/**
 * Insert an item with the next per-workspace number (team and delegated
 * items share it). Idempotent by its source message: a second insert for the
 * same trigger returns the first.
 */
export function insertWorkItem(input: NewWorkItem): WorkItem {
  const db = requireDatabase();
  return db.transaction(() => {
    const existing = getWorkItemBySource(
      input.channelJid,
      input.sourceMessageId,
    );
    if (existing) return existing;
    const row = stmt(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM work_items WHERE workspace_jid = ?',
    ).get(input.workspaceJid) as { next: number };
    stmt(
      `INSERT INTO work_items (id, workspace_jid, workspace_folder, seq, channel_jid, agent_id, title,
         source_message_id, source_route_jid, mandate_json, status, created_at, updated_at,
         origin, origin_agent_id, origin_input_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspaceJid,
      input.workspaceFolder,
      row.next,
      input.channelJid,
      input.agentId,
      input.title,
      input.sourceMessageId,
      input.sourceRouteJid,
      JSON.stringify(input.mandate),
      input.now,
      input.now,
      input.delegatedBy ? 'delegated' : 'team',
      input.delegatedBy?.agentId ?? null,
      input.delegatedBy?.inputId ?? null,
    );
    return getWorkItem(input.id)!;
  })();
}

export function getWorkItem(id: string): WorkItem | undefined {
  const row = stmt('SELECT * FROM work_items WHERE id = ?').get(id) as
    | WorkItemRow
    | undefined;
  return row ? mapItem(row) : undefined;
}

export function getWorkItemBySource(
  channelJid: string,
  sourceMessageId: string,
): WorkItem | undefined {
  const row = stmt(
    'SELECT * FROM work_items WHERE channel_jid = ? AND source_message_id = ?',
  ).get(channelJid, sourceMessageId) as WorkItemRow | undefined;
  return row ? mapItem(row) : undefined;
}

export function getWorkItemByAgent(agentId: string): WorkItem | undefined {
  const row = stmt('SELECT * FROM work_items WHERE agent_id = ?').get(
    agentId,
  ) as WorkItemRow | undefined;
  return row ? mapItem(row) : undefined;
}

/** The work item of each of these sessions that has one, in one read. */
export function getWorkItemsByAgents(
  agentIds: string[],
): Map<string, WorkItem> {
  const items = new Map<string, WorkItem>();
  if (agentIds.length === 0) return items;
  const rows = stmt(
    'SELECT * FROM work_items WHERE agent_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
  ).all(JSON.stringify(agentIds)) as WorkItemRow[];
  for (const row of rows) {
    const item = mapItem(row);
    if (item.agentId && !items.has(item.agentId)) items.set(item.agentId, item);
  }
  return items;
}

export function listWorkItems(
  workspaceJid: string,
  options: { status?: WorkItemStatus; limit?: number } = {},
): WorkItem[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = (
    options.status
      ? stmt(
          'SELECT * FROM work_items WHERE workspace_jid = ? AND status = ? ORDER BY updated_at DESC LIMIT ?',
        ).all(workspaceJid, options.status, limit)
      : stmt(
          'SELECT * FROM work_items WHERE workspace_jid = ? ORDER BY updated_at DESC LIMIT ?',
        ).all(workspaceJid, limit)
  ) as WorkItemRow[];
  return rows.map(mapItem);
}

/** A group's (team) items, newest first. */
export function listWorkItemsByChannel(
  channelJid: string,
  options: { status?: WorkItemStatus; limit?: number } = {},
): WorkItem[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = (
    options.status
      ? stmt(
          "SELECT * FROM work_items WHERE channel_jid = ? AND status = ? AND origin = 'team' ORDER BY updated_at DESC LIMIT ?",
        ).all(channelJid, options.status, limit)
      : stmt(
          "SELECT * FROM work_items WHERE channel_jid = ? AND origin = 'team' ORDER BY updated_at DESC LIMIT ?",
        ).all(channelJid, limit)
  ) as WorkItemRow[];
  return rows.map(mapItem);
}

export function countWorkItemsByChannel(
  channelJid: string,
  status: WorkItemStatus,
): number {
  const row = stmt(
    "SELECT COUNT(*) AS n FROM work_items WHERE channel_jid = ? AND status = ? AND origin = 'team'",
  ).get(channelJid, status) as { n: number };
  return row.n;
}

/**
 * Open delegated items, newest first: one session's, or every workspace's
 * (startup reconciliation).
 */
export function listOpenDelegatedWorkItems(originAgentId?: string): WorkItem[] {
  const rows = (
    originAgentId
      ? stmt(
          "SELECT * FROM work_items WHERE origin_agent_id = ? AND status = 'open' AND origin = 'delegated' ORDER BY created_at DESC, seq DESC",
        ).all(originAgentId)
      : stmt(
          "SELECT * FROM work_items WHERE status = 'open' AND origin = 'delegated' ORDER BY created_at DESC, seq DESC",
        ).all()
  ) as WorkItemRow[];
  return rows.map(mapItem);
}

/** Whether a session ever delegated an item, open or ended. */
export function hasDelegatedWorkItems(originAgentId: string): boolean {
  return !!stmt(
    "SELECT 1 FROM work_items WHERE origin_agent_id = ? AND origin = 'delegated' LIMIT 1",
  ).get(originAgentId);
}

/** Open delegated items of a session, or of a whole workspace. */
export function countOpenDelegatedWorkItems(
  scope: { originAgentId: string } | { workspaceJid: string },
): number {
  const row = (
    'originAgentId' in scope
      ? stmt(
          "SELECT COUNT(*) AS n FROM work_items WHERE origin_agent_id = ? AND status = 'open' AND origin = 'delegated'",
        ).get(scope.originAgentId)
      : stmt(
          "SELECT COUNT(*) AS n FROM work_items WHERE workspace_jid = ? AND status = 'open' AND origin = 'delegated'",
        ).get(scope.workspaceJid)
  ) as { n: number };
  return row.n;
}

/** A workspace's item by its `#seq`. */
export function getWorkItemBySeq(
  workspaceJid: string,
  seq: number,
): WorkItem | undefined {
  const row = stmt(
    'SELECT * FROM work_items WHERE workspace_jid = ? AND seq = ?',
  ).get(workspaceJid, seq) as WorkItemRow | undefined;
  return row ? mapItem(row) : undefined;
}

export interface WorkItemPatch {
  title?: string;
  status?: WorkItemStatus;
  outcome?: WorkItemOutcome;
  lastReport?: WorkReportState | null;
  lastSummary?: string | null;
  attention?: string | null;
  attentionMessageId?: string | null;
  approvedAt?: string | null;
  endedAt?: string | null;
}

const PATCH_COLUMNS: Record<keyof WorkItemPatch, string> = {
  title: 'title',
  status: 'status',
  outcome: 'outcome',
  lastReport: 'last_report',
  lastSummary: 'last_summary',
  attention: 'attention',
  attentionMessageId: 'attention_message_id',
  approvedAt: 'approved_at',
  endedAt: 'ended_at',
};

export function updateWorkItem(
  id: string,
  patch: WorkItemPatch,
  now: string,
): WorkItem | undefined {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
    keyof WorkItemPatch,
    string,
  ][]) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key]);
  }
  sets.push('updated_at = ?');
  values.push(now, id);
  // Dynamic column lists are not cached: there are few combinations and the
  // statement cache keys on the SQL text anyway.
  stmt(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getWorkItem(id);
}

// ── Subscriptions ──────────────────────────────────────────────────────

export function subscribeWorkItem(
  workItemId: string,
  channelJid: string,
  subKey: string,
  now: string,
): void {
  stmt(
    `INSERT OR IGNORE INTO work_item_subscriptions (work_item_id, channel_jid, sub_key, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(workItemId, channelJid, subKey, now);
}

export function unsubscribeWorkItem(
  workItemId: string,
  channelJid: string,
  subKey: string,
): void {
  stmt(
    'DELETE FROM work_item_subscriptions WHERE work_item_id = ? AND channel_jid = ? AND sub_key = ?',
  ).run(workItemId, channelJid, subKey);
}

export function listWorkItemSubscriptions(
  workItemId: string,
): { channelJid: string; subKey: string }[] {
  return (
    stmt(
      'SELECT channel_jid, sub_key FROM work_item_subscriptions WHERE work_item_id = ? ORDER BY created_at',
    ).all(workItemId) as { channel_jid: string; sub_key: string }[]
  ).map((row) => ({ channelJid: row.channel_jid, subKey: row.sub_key }));
}

/**
 * The items a message reaches through its keys, oldest first. Items a
 * person stopped receive nothing; other ended items are returned so a
 * person's message can resume them.
 */
export function findSubscribedWorkItems(
  channelJid: string,
  keys: readonly string[],
  /** The workspace the group is mounted on now; items of another are skipped. */
  workspaceJid: string,
): WorkItem[] {
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => '?').join(', ');
  const rows = requireDatabase()
    .prepare(
      `SELECT DISTINCT w.* FROM work_item_subscriptions s
         JOIN work_items w ON w.id = s.work_item_id
        WHERE s.channel_jid = ? AND s.sub_key IN (${placeholders})
          AND w.workspace_jid = ?
          AND w.origin = 'team'
          AND (w.status = 'open' OR w.outcome IS NOT 'stopped')
        ORDER BY w.created_at`,
    )
    .all(channelJid, ...keys, workspaceJid) as WorkItemRow[];
  return rows.map(mapItem);
}

// ── Events ─────────────────────────────────────────────────────────────

/**
 * Append an event. An `ack` is unique per trigger across items, so a
 * retried or duplicated acknowledgement is refused (returns null).
 */
export function recordWorkEvent(input: {
  workItemId: string;
  kind: WorkEventKind;
  state?: string | null;
  text?: string;
  triggerMessageId?: string | null;
  now: string;
}): number | null {
  try {
    const result = stmt(
      `INSERT INTO work_item_events (work_item_id, kind, state, text, trigger_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workItemId,
      input.kind,
      input.state ?? null,
      input.text ?? '',
      input.triggerMessageId ?? null,
      input.now,
    ) as SqliteRunResult & { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid ?? 0);
  } catch (error) {
    if (
      input.kind === 'ack' &&
      String((error as Error).message).includes('UNIQUE')
    )
      return null;
    throw error;
  }
}

/** Whether the item has an event of `kind` for this trigger. */
export function hasWorkEvent(
  workItemId: string,
  kind: WorkEventKind,
  triggerMessageId: string,
): boolean {
  return !!stmt(
    'SELECT 1 FROM work_item_events WHERE work_item_id = ? AND kind = ? AND trigger_message_id = ? LIMIT 1',
  ).get(workItemId, kind, triggerMessageId);
}

/** The item's last report that is not an undelivered marker, if any. */
export function getLastWorkReport(
  workItemId: string,
): { id: number; state: string | null } | undefined {
  return stmt(
    `SELECT id, state FROM work_item_events
      WHERE work_item_id = ? AND kind = 'report' AND COALESCE(state, '') <> 'undelivered'
      ORDER BY id DESC LIMIT 1`,
  ).get(workItemId) as { id: number; state: string | null } | undefined;
}

export function listWorkEvents(workItemId: string, limit = 200): WorkEvent[] {
  return (
    stmt(
      'SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY id DESC LIMIT ?',
    ).all(workItemId, Math.min(Math.max(limit, 1), 1000)) as {
      id: number;
      work_item_id: string;
      kind: WorkEventKind;
      state: string | null;
      text: string;
      trigger_message_id: string | null;
      created_at: string;
    }[]
  )
    .reverse()
    .map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      kind: row.kind,
      state: row.state,
      text: row.text,
      triggerMessageId: row.trigger_message_id,
      createdAt: row.created_at,
    }));
}

// ── Replies in the group ───────────────────────────────────────────────

export type WorkItemReplyStatus = 'pending' | 'delivered' | 'failed';

/**
 * A reply the host owes a group (an acknowledgement, a result, a question or
 * an answer), recorded before the tool that asked for it returns, so a
 * restart sends it still. The id is the reply's delivery key.
 */
export interface WorkItemReply {
  id: string;
  workspaceJid: string;
  workItemId: string | null;
  channelJid: string;
  quoteMessageId: string;
  text: string;
  purpose: string;
  /** The lane that said it: the delivered reply is stored there. */
  laneJid: string;
  status: WorkItemReplyStatus;
  attempt: number;
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkItemReplyRow {
  id: string;
  workspace_jid: string;
  work_item_id: string | null;
  channel_jid: string;
  quote_message_id: string;
  text: string;
  purpose: string;
  lane_jid: string;
  status: string;
  attempt: number;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapReply(row: WorkItemReplyRow): WorkItemReply {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    workItemId: row.work_item_id,
    channelJid: row.channel_jid,
    quoteMessageId: row.quote_message_id,
    text: row.text,
    purpose: row.purpose,
    laneJid: row.lane_jid,
    status: row.status as WorkItemReplyStatus,
    attempt: row.attempt,
    providerMessageId: row.provider_message_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record a reply; the same id again returns the first record. */
export function insertWorkItemReply(input: {
  id: string;
  workspaceJid: string;
  workItemId: string | null;
  channelJid: string;
  quoteMessageId: string;
  text: string;
  purpose: string;
  laneJid: string;
  now: string;
}): WorkItemReply {
  stmt(
    `INSERT OR IGNORE INTO work_item_replies (id, workspace_jid, work_item_id, channel_jid, quote_message_id,
       text, purpose, lane_jid, status, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    input.id,
    input.workspaceJid,
    input.workItemId,
    input.channelJid,
    input.quoteMessageId,
    input.text,
    input.purpose,
    input.laneJid,
    input.now,
    input.now,
  );
  return getWorkItemReply(input.id)!;
}

export function getWorkItemReply(id: string): WorkItemReply | undefined {
  const row = stmt('SELECT * FROM work_item_replies WHERE id = ?').get(id) as
    | WorkItemReplyRow
    | undefined;
  return row ? mapReply(row) : undefined;
}

/** A message the host posted in the group as a team reply. */
export function isWorkItemReplyMessage(
  channelJid: string,
  providerMessageId: string,
): boolean {
  return !!stmt(
    'SELECT 1 FROM work_item_replies WHERE channel_jid = ? AND provider_message_id = ? LIMIT 1',
  ).get(channelJid, providerMessageId);
}

/** Replies not delivered yet, oldest first; of one group when given. */
export function listPendingWorkItemReplies(
  channelJid?: string,
): WorkItemReply[] {
  const rows = channelJid
    ? stmt(
        "SELECT * FROM work_item_replies WHERE status = 'pending' AND channel_jid = ? ORDER BY created_at",
      ).all(channelJid)
    : stmt(
        "SELECT * FROM work_item_replies WHERE status = 'pending' ORDER BY created_at",
      ).all();
  return (rows as WorkItemReplyRow[]).map(mapReply);
}

export function updateWorkItemReply(
  id: string,
  patch: {
    status?: WorkItemReplyStatus;
    attempt?: number;
    providerMessageId?: string | null;
    error?: string | null;
  },
  now: string,
): WorkItemReply | undefined {
  const current = getWorkItemReply(id);
  if (!current) return undefined;
  stmt(
    `UPDATE work_item_replies SET status = ?, attempt = ?, provider_message_id = ?, error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.attempt ?? current.attempt,
    patch.providerMessageId !== undefined
      ? patch.providerMessageId
      : current.providerMessageId,
    patch.error !== undefined ? patch.error : current.error,
    now,
    id,
  );
  return getWorkItemReply(id);
}

// ── Decisions ──────────────────────────────────────────────────────────

export function recordWorkDecision(decision: WorkDecision): void {
  stmt(
    `INSERT OR REPLACE INTO work_decisions (id, workspace_jid, channel_jid, trigger_message_id, strength,
       kind, work_item_id, reason, matched_rule_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decision.id,
    decision.workspaceJid,
    decision.channelJid,
    decision.triggerMessageId,
    decision.strength,
    decision.kind,
    decision.workItemId,
    decision.reason,
    JSON.stringify(decision.matchedRuleIds),
    decision.createdAt,
  );
}

interface WorkDecisionRow {
  id: string;
  workspace_jid: string;
  channel_jid: string;
  trigger_message_id: string;
  strength: WorkStrength;
  kind: WorkDecisionKind;
  work_item_id: string | null;
  reason: string;
  matched_rule_ids_json: string;
  created_at: string;
}

function mapDecision(row: WorkDecisionRow): WorkDecision {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    channelJid: row.channel_jid,
    triggerMessageId: row.trigger_message_id,
    strength: row.strength,
    kind: row.kind,
    workItemId: row.work_item_id,
    reason: row.reason,
    matchedRuleIds: JSON.parse(row.matched_rule_ids_json) as string[],
    createdAt: row.created_at,
  };
}

export function listWorkDecisions(
  workspaceJid: string,
  options: { kind?: WorkDecisionKind; limit?: number } = {},
): WorkDecision[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = (
    options.kind
      ? stmt(
          'SELECT * FROM work_decisions WHERE workspace_jid = ? AND kind = ? ORDER BY created_at DESC LIMIT ?',
        ).all(workspaceJid, options.kind, limit)
      : stmt(
          'SELECT * FROM work_decisions WHERE workspace_jid = ? ORDER BY created_at DESC LIMIT ?',
        ).all(workspaceJid, limit)
  ) as WorkDecisionRow[];
  return rows.map(mapDecision);
}

/** The latest decision on a trigger, so a candidate is decided once. */
export function getWorkDecisionForTrigger(
  channelJid: string,
  triggerMessageId: string,
): WorkDecision | undefined {
  const row = stmt(
    'SELECT * FROM work_decisions WHERE channel_jid = ? AND trigger_message_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(channelJid, triggerMessageId) as WorkDecisionRow | undefined;
  return row ? mapDecision(row) : undefined;
}

/** Remove a workspace's team-mode rows (workspace deletion). */
export function deleteWorkspaceWorkItems(workspaceJid: string): void {
  const db = requireDatabase();
  db.transaction(() => {
    stmt(
      `DELETE FROM work_item_events WHERE work_item_id IN (SELECT id FROM work_items WHERE workspace_jid = ?)`,
    ).run(workspaceJid);
    stmt(
      `DELETE FROM work_item_subscriptions WHERE work_item_id IN (SELECT id FROM work_items WHERE workspace_jid = ?)`,
    ).run(workspaceJid);
    stmt('DELETE FROM work_item_replies WHERE workspace_jid = ?').run(
      workspaceJid,
    );
    stmt('DELETE FROM work_items WHERE workspace_jid = ?').run(workspaceJid);
    stmt('DELETE FROM work_decisions WHERE workspace_jid = ?').run(
      workspaceJid,
    );
    stmt('DELETE FROM team_mounts WHERE workspace_jid = ?').run(workspaceJid);
  })();
}
