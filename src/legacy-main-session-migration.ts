/**
 * v87 -> v88: every workspace's implicit main session becomes an ordinary
 * conversation session.
 *
 * Up to v87 the main session had no row of its own: its state was keyed by
 * the workspace JID (messages, cursors, waits, traces), by `agent_id = ''`
 * (SDK resume rows, model selection, history hand-off) or by a NULL agent id
 * (usage, channel turns), and chats bound to it carried `target_main_jid`.
 * For each registered workspace with any of that state this creates an
 * `agents` row (`source_kind = 'legacy_main'`) and moves the state onto it,
 * so `<workspace>#agent:<id>` is the session's only address afterwards.
 * A Home's main view also showed the legacy messages stored under the IM
 * chats of the same folder and owner; those move with it.
 *
 * initDatabase runs this after creating every table it touches. The v87
 * lookups it needs are copied here rather than imported: the runtime ones
 * are being rewritten without the main session.
 *
 * The SDK state directory moves separately (relocateLegacyMainSessionDirectories)
 * because a database transaction cannot cover a rename.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { generateAutoTitle } from './session-title.js';
import { keyPrefixRange } from './sql-key-prefix.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';

type Db = Database.Database;

/** router_state `legacy_main_session:<workspace JID>` = new session id. */
export const LEGACY_MAIN_SESSION_KEY_PREFIX = 'legacy_main_session:';

const OWNER_KEY_PREFIX = 'channel_session_owner:';
const HISTORY_ISOLATION_PREFIX = 'conversation_history_isolation:';
/** Inputs not typed by a person; never a session title. */
const SYNTHETIC_INPUT_KINDS = [
  'user_command',
  'scheduled_task_prompt',
  'automation_prompt',
  'work_item_input',
];
/** Folder-keyed rows whose `''` agent id meant the main session. */
const FOLDER_AGENT_ROWS = [
  ['sdkSession', 'sessions', 'agent_id'],
  ['runtimeSession', 'workspace_runtime_sessions', 'runtime_agent_id'],
  ['modelSelection', 'session_model_selections', 'agent_id'],
  ['historyReinjection', 'session_history_reinjections', 'agent_id'],
] as const;

export interface LegacyMainSessionCursor {
  timestamp: string;
  id: string;
  sequence: number;
}

export interface LegacyMainSessionSource {
  chatJid: string;
  kind: 'workspace' | 'home_im';
  /** Rows found under this address. */
  messages: number;
  moved: number;
  /** Rows dropped because another source already held the same message id. */
  duplicates: number;
  lastInboundSequence: number | null;
  /** Inbound rows after this ingest sequence count as unprocessed. */
  processedThrough: number;
  processedThroughFrom: 'committed' | 'next_pull_only' | 'global';
}

type BindingEntry = { channelJid: string; previousTarget: string };

export interface LegacyMainSessionWorkspaceReport {
  workspaceJid: string;
  folder: string;
  isHome: boolean;
  sessionId: string;
  sessionJid: string;
  sessionName: string;
  /** The mapping already existed (a re-run); no session was created. */
  reused: boolean;
  /** Owns the folder's `agent_id = ''` rows and `.claude` directory. */
  ownsFolderState: boolean;
  sources: LegacyMainSessionSource[];
  messagesMoved: number;
  duplicatesRemoved: number;
  cursor: {
    state: 'none' | 'caught_up' | 'pending';
    value: LegacyMainSessionCursor | null;
    pendingMessageIds: string[];
  };
  bindings: BindingEntry[];
  channelMountsUpdated: number;
  agentChannelMountsUpdated: number;
  automations: string[];
  automationRuns: number;
  sdkSession: boolean;
  runtimeSession: boolean;
  modelSelection: boolean;
  historyReinjection: boolean;
  usageRecords: number;
  usageEvents: number;
  turnRuns: number;
  turnTraces: { moved: number; duplicates: number };
  subagentCheckpoints: { moved: number; duplicates: number };
  usageLimitWaits: { moved: number; duplicates: number };
  webMessageDedup: number;
  spawnedFrom: number;
  channelSessionOwner: boolean;
  historyIsolationMarker: boolean;
}

export interface LegacyMainSessionMigrationReport {
  workspaces: LegacyMainSessionWorkspaceReport[];
  /** Registered workspaces without any main-session state. */
  skippedWorkspaces: string[];
  /** Mapped workspaces whose session row is gone; left untouched. */
  missingMappedSessions: Array<{ workspaceJid: string; sessionId: string }>;
  /** Non-topic `target_main_jid` that resolved to no workspace (never routed). */
  staleBindingsCleared: BindingEntry[];
  /** `target_main_jid` left beside a `target_agent_id`, which always won. */
  redundantMainTargetsCleared: BindingEntry[];
  /** Non-topic `target_main_jid` naming a registered non-web chat; left as is. */
  unresolvedBindings: BindingEntry[];
  duplicatesRemoved: number;
  pendingMessageIds: string[];
}

interface WorkspaceRow {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  created_by: string | null;
  is_home: number | null;
}

interface ChatBindingRow {
  jid: string;
  created_by: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
}

const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

function prep(db: Db, sql: string): Database.Statement {
  let statements = statementCache.get(db);
  if (!statements) {
    statements = new Map();
    statementCache.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

function exists(db: Db, sql: string, ...params: unknown[]): boolean {
  return prep(db, sql).get(...params) !== undefined;
}

function countRows(db: Db, sql: string, ...params: unknown[]): number {
  return Number((prep(db, sql).get(...params) as { n: number }).n);
}

function routerState(db: Db, key: string): string | undefined {
  const row = prep(db, 'SELECT value FROM router_state WHERE key = ?').get(
    key,
  ) as { value: string } | undefined;
  return row?.value;
}

function routerStateByPrefix(
  db: Db,
  prefix: string,
): Array<{ key: string; value: string }> {
  return prep(
    db,
    'SELECT key, value FROM router_state WHERE key >= @from AND key < @to',
  ).all(keyPrefixRange(prefix)) as Array<{ key: string; value: string }>;
}

function isWorkspaceJid(jid: string): boolean {
  return jid.startsWith('web:');
}

/** The workspace that owns a folder's folder-keyed rows (as getWorkspaceJidForFolder). */
function folderOwnerJid(db: Db, folder: string): string | null {
  const row = prep(
    db,
    "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%' ORDER BY is_home DESC, added_at ASC LIMIT 1",
  ).get(folder) as { jid: string } | undefined;
  return row?.jid ?? null;
}

function isRegistered(db: Db, jid: string): boolean {
  return exists(db, 'SELECT 1 FROM registered_groups WHERE jid = ?', jid);
}

/** v87 resolveWorkspaceJidForMount: the workspace a `target_main_jid` routed to. */
function resolveMainTarget(db: Db, target: string): string | null {
  if (isRegistered(db, target)) return target;
  if (!isWorkspaceJid(target)) return null;
  return folderOwnerJid(db, target.slice(4));
}

/**
 * v87 resolveBoundWorkspaceJid (null when unbound or stale) and whether the
 * chat declares any binding, as the Home history merge used them.
 */
function boundWorkspaceOf(
  db: Db,
  chat: ChatBindingRow,
): { workspaceJid: string | null; hasReference: boolean } {
  const agentChatJid = (id: string) =>
    (
      prep(db, 'SELECT chat_jid FROM agents WHERE id = ?').get(id) as
        | { chat_jid: string }
        | undefined
    )?.chat_jid ?? null;
  const mount = prep(
    db,
    'SELECT workspace_jid, session_id FROM channel_mounts WHERE channel_jid = ?',
  ).get(chat.jid) as
    | { workspace_jid: string; session_id: string | null }
    | undefined;
  if (mount) {
    const jid = mount.session_id
      ? agentChatJid(mount.session_id)
      : mount.workspace_jid;
    return {
      workspaceJid: jid && isRegistered(db, jid) ? jid : null,
      hasReference: true,
    };
  }
  if (chat.target_agent_id) {
    return {
      workspaceJid: agentChatJid(chat.target_agent_id),
      hasReference: true,
    };
  }
  if (!chat.target_main_jid) return { workspaceJid: null, hasReference: false };
  // foldLegacyWorkspaceJid: first web: JID of the folder in row order.
  let workspaceJid: string | null = null;
  if (isRegistered(db, chat.target_main_jid)) {
    workspaceJid = chat.target_main_jid;
  } else if (isWorkspaceJid(chat.target_main_jid)) {
    const sameFolder = prep(
      db,
      'SELECT jid FROM registered_groups WHERE folder = ?',
    ).all(chat.target_main_jid.slice(4)) as Array<{ jid: string }>;
    workspaceJid =
      sameFolder.find((row) => isWorkspaceJid(row.jid))?.jid ?? null;
  }
  return { workspaceJid, hasReference: true };
}

/** IM chats whose messages a Home's main view merged (v87 resolveMessageQueryJids). */
function homeMergedChatJids(db: Db, workspace: WorkspaceRow): string[] {
  if (!workspace.is_home || !workspace.created_by) return [];
  const siblings = prep(
    db,
    `SELECT jid, created_by, target_agent_id, target_main_jid
     FROM registered_groups WHERE folder = ? AND jid <> ? ORDER BY jid`,
  ).all(workspace.folder, workspace.jid) as ChatBindingRow[];
  return siblings
    .filter((sibling) => {
      if (isWorkspaceJid(sibling.jid)) return false;
      if (sibling.created_by !== workspace.created_by) return false;
      const bound = boundWorkspaceOf(db, sibling);
      if (bound.workspaceJid) return bound.workspaceJid === workspace.jid;
      return !bound.hasReference;
    })
    .map((sibling) => sibling.jid);
}

/** v87 normalizeCursor + resolveMessageCursorSequence: a lost anchor is zero. */
function parseCursorSequence(db: Db, chatJid: string, raw: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!value || typeof value !== 'object') return 0;
  const { sequence, id } = value as { sequence?: unknown; id?: unknown };
  if (
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
  ) {
    return sequence;
  }
  if (typeof id !== 'string' || !id) return 0;
  const row = prep(
    db,
    'SELECT sequence FROM message_ingest_sequences WHERE chat_jid = ? AND message_id = ?',
  ).get(chatJid, id) as { sequence: number } | undefined;
  return row?.sequence ?? 0;
}

function cursorRow(
  db: Db,
  kind: 'committed' | 'next_pull',
  chatJid: string,
): string | undefined {
  const row = prep(
    db,
    'SELECT cursor FROM router_cursors WHERE kind = ? AND chat_jid = ?',
  ).get(kind, chatJid) as { cursor: string } | undefined;
  return row?.cursor;
}

/** The poller's global position, which bounds chats that never committed. */
function globalIngestSequence(db: Db): number {
  const persisted = Number(routerState(db, 'last_ingest_sequence'));
  if (Number.isSafeInteger(persisted) && persisted >= 0) return persisted;
  const id = routerState(db, 'last_timestamp_id');
  const timestamp = routerState(db, 'last_timestamp');
  if (!id || !timestamp) return 0;
  const row = prep(
    db,
    `SELECT seq.sequence FROM message_ingest_sequences seq
     JOIN messages m ON m.chat_jid = seq.chat_jid AND m.id = seq.message_id
     WHERE m.id = ? AND m.timestamp = ?
     ORDER BY seq.sequence DESC LIMIT 1`,
  ).get(id, timestamp) as { sequence: number } | undefined;
  return row?.sequence ?? 0;
}

/**
 * Where a source's inputs stop counting as processed: its committed cursor;
 * without one, a lone next-pull cursor means an accepted but uncommitted
 * delivery (v87 startup recovery replayed the whole chat); with neither, only
 * what the poller has not yet seen is pending.
 */
function processedThrough(
  db: Db,
  chatJid: string,
  globalSequence: number,
): Pick<LegacyMainSessionSource, 'processedThrough' | 'processedThroughFrom'> {
  const committed = cursorRow(db, 'committed', chatJid);
  if (committed !== undefined) {
    return {
      processedThrough: parseCursorSequence(db, chatJid, committed),
      processedThroughFrom: 'committed',
    };
  }
  if (cursorRow(db, 'next_pull', chatJid) !== undefined) {
    return { processedThrough: 0, processedThroughFrom: 'next_pull_only' };
  }
  return { processedThrough: globalSequence, processedThroughFrom: 'global' };
}

function moveKeyedRows(
  db: Db,
  table: string,
  column: string,
  sources: readonly string[],
  target: string,
): { moved: number; duplicates: number } {
  const result = { moved: 0, duplicates: 0 };
  for (const source of sources) {
    result.moved += prep(
      db,
      `UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`,
    ).run(target, source).changes;
    result.duplicates += prep(
      db,
      `DELETE FROM ${table} WHERE ${column} = ?`,
    ).run(source).changes;
  }
  return result;
}

function renameRouterStateKey(db: Db, from: string, to: string): boolean {
  return (
    prep(db, 'UPDATE OR IGNORE router_state SET key = ? WHERE key = ?').run(
      to,
      from,
    ).changes > 0
  );
}

interface MainTargetPlan {
  byWorkspace: Map<string, BindingEntry[]>;
  stale: BindingEntry[];
  redundant: BindingEntry[];
  unresolved: BindingEntry[];
}

function planMainTargets(db: Db): MainTargetPlan {
  const plan: MainTargetPlan = {
    byWorkspace: new Map(),
    stale: [],
    redundant: [],
    unresolved: [],
  };
  const rows = prep(
    db,
    `SELECT jid, created_by, target_agent_id, target_main_jid
     FROM registered_groups
     WHERE jid NOT LIKE 'web:%'
       AND target_main_jid IS NOT NULL AND target_main_jid <> ''
       AND COALESCE(binding_mode, '') <> 'thread_map'
     ORDER BY jid`,
  ).all() as ChatBindingRow[];
  for (const row of rows) {
    const entry = { channelJid: row.jid, previousTarget: row.target_main_jid! };
    if (row.target_agent_id) {
      plan.redundant.push(entry);
      continue;
    }
    const workspaceJid = resolveMainTarget(db, row.target_main_jid!);
    if (!workspaceJid) {
      plan.stale.push(entry);
    } else if (!isWorkspaceJid(workspaceJid)) {
      plan.unresolved.push(entry);
    } else {
      const list = plan.byWorkspace.get(workspaceJid) ?? [];
      list.push(entry);
      plan.byWorkspace.set(workspaceJid, list);
    }
  }
  return plan;
}

function firstTitle(db: Db): string | null {
  const rows = prep(
    db,
    `SELECT m.content FROM legacy_main_moves t
     JOIN messages m ON m.chat_jid = t.src AND m.id = t.id
     WHERE COALESCE(m.is_from_me, 0) = 0
       AND COALESCE(m.source_kind, '') NOT IN (SELECT value FROM json_each(?))
       AND COALESCE(m.delivery_status, '') <> 'cancelled'
     ORDER BY t.ts, t.old_seq IS NULL, t.old_seq, t.id
     LIMIT 50`,
  ).all(JSON.stringify(SYNTHETIC_INPUT_KINDS)) as Array<{ content: unknown }>;
  for (const row of rows) {
    if (typeof row.content !== 'string') continue;
    const title = generateAutoTitle(row.content);
    if (title) return title;
  }
  return null;
}

function hasMainState(
  db: Db,
  workspace: WorkspaceRow,
  sourceJids: readonly string[],
  ownsFolderState: boolean,
  bindings: readonly BindingEntry[],
): boolean {
  const keyed = (table: string, column: string) =>
    exists(
      db,
      `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
      workspace.jid,
    );
  return (
    bindings.length > 0 ||
    exists(
      db,
      'SELECT 1 FROM messages WHERE chat_jid IN (SELECT value FROM json_each(?)) LIMIT 1',
      JSON.stringify(sourceJids),
    ) ||
    (ownsFolderState &&
      (FOLDER_AGENT_ROWS.some(([, table, column]) =>
        exists(
          db,
          `SELECT 1 FROM ${table} WHERE group_folder = ? AND ${column} = '' LIMIT 1`,
          workspace.folder,
        ),
      ) ||
        routerState(db, `${OWNER_KEY_PREFIX}${workspace.folder}:main`) !==
          undefined)) ||
    keyed('automations', 'target_session_jid') ||
    keyed('usage_limit_waits', 'scope_key') ||
    keyed('subagent_checkpoints', 'chat_jid') ||
    keyed('router_cursors', 'chat_jid')
  );
}

function migrateWorkspace(
  db: Db,
  workspace: WorkspaceRow,
  bindings: BindingEntry[],
  globalSequence: number,
  report: LegacyMainSessionMigrationReport,
): void {
  const ownsFolderState =
    folderOwnerJid(db, workspace.folder) === workspace.jid;
  const sourceJids = [
    workspace.jid,
    ...homeMergedChatJids(db, workspace).filter((jid) =>
      exists(db, 'SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1', jid),
    ),
  ];
  if (!hasMainState(db, workspace, sourceJids, ownsFolderState, bindings)) {
    report.skippedWorkspaces.push(workspace.jid);
    return;
  }

  const mappingKey = `${LEGACY_MAIN_SESSION_KEY_PREFIX}${workspace.jid}`;
  const mappedId = routerState(db, mappingKey);
  const mappedName = mappedId
    ? (
        prep(db, 'SELECT name FROM agents WHERE id = ?').get(mappedId) as
          | { name: string }
          | undefined
      )?.name
    : undefined;
  if (mappedId && mappedName === undefined) {
    report.missingMappedSessions.push({
      workspaceJid: workspace.jid,
      sessionId: mappedId,
    });
    logger.warn(
      { workspaceJid: workspace.jid, sessionId: mappedId },
      'Legacy main session mapping points at a missing session; workspace left untouched',
    );
    return;
  }
  const sessionId = mappedId ?? crypto.randomUUID();
  const sessionJid = `${workspace.jid}#agent:${sessionId}`;

  // One row per message id: the workspace address wins, then IM chats by JID.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS legacy_main_moves (
      id TEXT PRIMARY KEY,
      src TEXT NOT NULL,
      ts TEXT,
      old_seq INTEGER,
      pending INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS temp.legacy_main_moves_src
      ON legacy_main_moves(src);
    DELETE FROM legacy_main_moves;
  `);
  const sources: LegacyMainSessionSource[] = [];
  for (const chatJid of sourceJids) {
    const through = processedThrough(db, chatJid, globalSequence);
    prep(
      db,
      `INSERT OR IGNORE INTO legacy_main_moves (id, src, ts, old_seq, pending)
       SELECT m.id, m.chat_jid, m.timestamp, seq.sequence,
         CASE WHEN COALESCE(m.is_from_me, 0) = 0 AND (
           COALESCE(m.delivery_status, '') IN ('queued', 'promoting', 'awaiting_companion')
           OR (COALESCE(m.delivery_status, '') NOT IN ('cancelled', 'subsumed')
               AND seq.sequence > ?)
         ) THEN 1 ELSE 0 END
       FROM messages m
       LEFT JOIN message_ingest_sequences seq
         ON seq.chat_jid = m.chat_jid AND seq.message_id = m.id
       WHERE m.chat_jid = ?`,
    ).run(through.processedThrough, chatJid);
    const lastInbound = prep(
      db,
      `SELECT MAX(seq.sequence) AS s FROM messages m
       JOIN message_ingest_sequences seq
         ON seq.chat_jid = m.chat_jid AND seq.message_id = m.id
       WHERE m.chat_jid = ? AND COALESCE(m.is_from_me, 0) = 0
         AND COALESCE(m.delivery_status, '') NOT IN ('cancelled', 'subsumed')`,
    ).get(chatJid) as { s: number | null };
    sources.push({
      chatJid,
      kind: chatJid === workspace.jid ? 'workspace' : 'home_im',
      messages: 0,
      moved: 0,
      duplicates: 0,
      lastInboundSequence: lastInbound.s,
      ...through,
    });
  }

  const span = prep(
    db,
    'SELECT MIN(ts) AS first, MAX(ts) AS last FROM legacy_main_moves',
  ).get() as { first: string | null; last: string | null };
  const sessionName = mappedName ?? firstTitle(db) ?? workspace.name;
  if (!mappedId) {
    prep(
      db,
      `INSERT INTO agents (
        id, group_folder, chat_jid, name, prompt, status, kind, created_by,
        created_at, source_kind, title_source, last_active_at
      ) VALUES (?, ?, ?, ?, '', 'idle', 'conversation', ?, ?, 'legacy_main', 'auto', ?)`,
    ).run(
      sessionId,
      workspace.folder,
      workspace.jid,
      sessionName,
      workspace.created_by,
      span.first ?? workspace.added_at,
      span.last,
    );
  }
  prep(
    db,
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       last_message_time = MAX(COALESCE(last_message_time, ''), excluded.last_message_time)`,
  ).run(sessionJid, sessionName, span.last ?? workspace.added_at);

  // Arrival order of the merged history: provider time, then old position.
  prep(
    db,
    `INSERT OR IGNORE INTO message_ingest_sequences (chat_jid, message_id)
     SELECT ?, id FROM legacy_main_moves
     ORDER BY ts, old_seq IS NULL, old_seq, id`,
  ).run(sessionJid);
  for (const source of sources) {
    if (source.kind === 'home_im') {
      // Only the workspace's own rows were ever replayed into the model.
      prep(
        db,
        `UPDATE messages SET source_jid = COALESCE(source_jid, chat_jid),
           history_recovery_allowed = 0
         WHERE chat_jid = ?`,
      ).run(source.chatJid);
    }
    source.moved = prep(
      db,
      `UPDATE messages SET chat_jid = ? WHERE chat_jid = ?
       AND id IN (SELECT id FROM legacy_main_moves WHERE src = ?)`,
    ).run(sessionJid, source.chatJid, source.chatJid).changes;
    source.duplicates = prep(db, 'DELETE FROM messages WHERE chat_jid = ?').run(
      source.chatJid,
    ).changes;
    source.messages = source.moved + source.duplicates;
    prep(db, 'DELETE FROM message_ingest_sequences WHERE chat_jid = ?').run(
      source.chatJid,
    );
  }

  const cursor = settleCursors(db, sessionJid, sourceJids);

  const turnTraces = moveKeyedRows(
    db,
    'turn_traces',
    'chat_jid',
    sourceJids,
    sessionJid,
  );
  const subagentCheckpoints = moveKeyedRows(
    db,
    'subagent_checkpoints',
    'chat_jid',
    sourceJids,
    sessionJid,
  );
  const usageLimitWaits = moveKeyedRows(
    db,
    'usage_limit_waits',
    'scope_key',
    sourceJids,
    sessionJid,
  );
  // Web sends key their idempotency record by the request's workspace JID,
  // sessions included; only the records of main-session inputs move.
  const webMessageDedup = prep(
    db,
    `UPDATE OR IGNORE web_message_dedup SET chat_jid = ?
     WHERE chat_jid = ?
       AND CASE WHEN json_valid(response_json)
             THEN json_extract(response_json, '$.messageId') END
           IN (SELECT id FROM messages WHERE chat_jid = ?)`,
  ).run(sessionJid, workspace.jid, sessionJid).changes;
  const spawnedFrom = prep(
    db,
    'UPDATE agents SET spawned_from_jid = ? WHERE spawned_from_jid = ?',
  ).run(sessionJid, workspace.jid).changes;

  let channelMountsUpdated = 0;
  let agentChannelMountsUpdated = 0;
  for (const binding of bindings) {
    prep(
      db,
      'UPDATE registered_groups SET target_agent_id = ?, target_main_jid = NULL WHERE jid = ?',
    ).run(sessionId, binding.channelJid);
    const setMountSession = (table: string) =>
      prep(
        db,
        `UPDATE ${table} SET session_id = ?
         WHERE channel_jid = ? AND session_id IS NULL AND routing_mode = 'single_session'`,
      ).run(sessionId, binding.channelJid).changes;
    channelMountsUpdated += setMountSession('channel_mounts');
    agentChannelMountsUpdated += setMountSession('agent_channel_mounts');
  }

  const automations = (
    prep(
      db,
      'SELECT id FROM automations WHERE target_session_jid = ? ORDER BY id',
    ).all(workspace.jid) as Array<{ id: string }>
  ).map((row) => row.id);
  prep(
    db,
    'UPDATE automations SET target_session_jid = ? WHERE target_session_jid = ?',
  ).run(sessionJid, workspace.jid);
  const automationRuns = prep(
    db,
    'UPDATE automation_runs SET session_jid = ? WHERE session_jid = ?',
  ).run(sessionJid, workspace.jid).changes;

  const folderRows = Object.fromEntries(
    FOLDER_AGENT_ROWS.map(([field, table, column]) => [
      field,
      ownsFolderState &&
        prep(
          db,
          `UPDATE ${table} SET ${column} = ? WHERE group_folder = ? AND ${column} = ''`,
        ).run(sessionId, workspace.folder).changes > 0,
    ]),
  ) as Record<(typeof FOLDER_AGENT_ROWS)[number][0], boolean>;
  const moveUsage = (table: string) =>
    ownsFolderState
      ? prep(
          db,
          `UPDATE ${table} SET agent_id = ?
           WHERE group_folder = ? AND (agent_id IS NULL OR agent_id = '')`,
        ).run(sessionId, workspace.folder).changes
      : 0;
  const usageRecords = moveUsage('usage_records');
  const usageEvents = moveUsage('usage_events');
  // A channel turn names its input message, which now lives in the session.
  const turnRuns = prep(
    db,
    `UPDATE turn_runs SET agent_id = ?
     WHERE (agent_id IS NULL OR agent_id = '')
       AND correlation_id IN (SELECT id FROM messages WHERE chat_jid = ?)`,
  ).run(sessionId, sessionJid).changes;

  const channelSessionOwner =
    ownsFolderState &&
    renameRouterStateKey(
      db,
      `${OWNER_KEY_PREFIX}${workspace.folder}:main`,
      `${OWNER_KEY_PREFIX}${workspace.folder}:${sessionId}`,
    );
  const historyIsolationMarker = renameRouterStateKey(
    db,
    `${HISTORY_ISOLATION_PREFIX}${workspace.jid}`,
    `${HISTORY_ISOLATION_PREFIX}${sessionJid}`,
  );
  prep(db, 'INSERT OR IGNORE INTO router_state (key, value) VALUES (?, ?)').run(
    mappingKey,
    sessionId,
  );

  report.workspaces.push({
    workspaceJid: workspace.jid,
    folder: workspace.folder,
    isHome: !!workspace.is_home,
    sessionId,
    sessionJid,
    sessionName,
    reused: !!mappedId,
    ownsFolderState,
    sources,
    messagesMoved: sources.reduce((n, s) => n + s.moved, 0),
    duplicatesRemoved: sources.reduce((n, s) => n + s.duplicates, 0),
    cursor,
    bindings,
    channelMountsUpdated,
    agentChannelMountsUpdated,
    automations,
    automationRuns,
    ...folderRows,
    usageRecords,
    usageEvents,
    turnRuns,
    turnTraces,
    subagentCheckpoints,
    usageLimitWaits,
    webMessageDedup,
    spawnedFrom,
    channelSessionOwner,
    historyIsolationMarker,
  });
}

/**
 * Both cursors of the session: after its last message when every source had
 * processed all of its inputs, otherwise just before the earliest pending
 * input. The sources' own cursors go.
 */
function settleCursors(
  db: Db,
  sessionJid: string,
  sourceJids: readonly string[],
): LegacyMainSessionWorkspaceReport['cursor'] {
  const ordered = `FROM message_ingest_sequences seq
    JOIN messages m ON m.chat_jid = seq.chat_jid AND m.id = seq.message_id
    WHERE seq.chat_jid = ?`;
  const pending = prep(
    db,
    `SELECT m.id AS id, seq.sequence AS sequence ${ordered}
     AND m.id IN (SELECT id FROM legacy_main_moves WHERE pending = 1)
     ORDER BY seq.sequence`,
  ).all(sessionJid) as Array<{ id: string; sequence: number }>;
  const pendingMessageIds = pending.map((row) => row.id);
  const lastBefore = prep(
    db,
    `SELECT m.timestamp AS timestamp, m.id AS id, seq.sequence AS sequence
     ${ordered} AND seq.sequence < ? ORDER BY seq.sequence DESC LIMIT 1`,
  );
  const value =
    pending.length > 0
      ? ((lastBefore.get(sessionJid, pending[0].sequence) as
          | LegacyMainSessionCursor
          | undefined) ?? { timestamp: '', id: '', sequence: 0 })
      : ((lastBefore.get(sessionJid, Number.MAX_SAFE_INTEGER) as
          | LegacyMainSessionCursor
          | undefined) ?? null);
  for (const jid of sourceJids) {
    prep(db, 'DELETE FROM router_cursors WHERE chat_jid = ?').run(jid);
  }
  if (!value) return { state: 'none', value: null, pendingMessageIds };
  const serialized = JSON.stringify({
    timestamp: value.timestamp ?? '',
    id: value.id,
    sequence: value.sequence,
  });
  for (const kind of ['committed', 'next_pull']) {
    prep(
      db,
      'INSERT OR REPLACE INTO router_cursors (kind, chat_jid, cursor) VALUES (?, ?, ?)',
    ).run(kind, sessionJid, serialized);
  }
  return {
    state: pending.length > 0 ? 'pending' : 'caught_up',
    value,
    pendingMessageIds,
  };
}

/**
 * Run the v88 migration in one immediate transaction. Re-running is a no-op
 * for workspaces already mapped: their session is reused and nothing is left
 * to move.
 */
export function migrateLegacyMainSessions(
  db: Db,
): LegacyMainSessionMigrationReport {
  const report: LegacyMainSessionMigrationReport = {
    workspaces: [],
    skippedWorkspaces: [],
    missingMappedSessions: [],
    staleBindingsCleared: [],
    redundantMainTargetsCleared: [],
    unresolvedBindings: [],
    duplicatesRemoved: 0,
    pendingMessageIds: [],
  };
  db.transaction(() => {
    const plan = planMainTargets(db);
    const globalSequence = globalIngestSequence(db);
    const workspaces = prep(
      db,
      `SELECT jid, name, folder, added_at, created_by, is_home
       FROM registered_groups WHERE jid LIKE 'web:%'
       ORDER BY is_home DESC, added_at ASC, jid ASC`,
    ).all() as WorkspaceRow[];
    for (const workspace of workspaces) {
      migrateWorkspace(
        db,
        workspace,
        plan.byWorkspace.get(workspace.jid) ?? [],
        globalSequence,
        report,
      );
    }
    for (const entry of [...plan.stale, ...plan.redundant]) {
      prep(
        db,
        'UPDATE registered_groups SET target_main_jid = NULL WHERE jid = ?',
      ).run(entry.channelJid);
    }
    report.staleBindingsCleared = plan.stale;
    report.redundantMainTargetsCleared = plan.redundant;
    report.unresolvedBindings = plan.unresolved;
    db.exec('DROP TABLE IF EXISTS temp.legacy_main_moves');
  }).immediate();
  // The temp table's statements are invalid now.
  statementCache.delete(db);

  for (const workspace of report.workspaces) {
    report.duplicatesRemoved += workspace.duplicatesRemoved;
    report.pendingMessageIds.push(...workspace.cursor.pendingMessageIds);
    logger.info(
      {
        workspaceJid: workspace.workspaceJid,
        sessionId: workspace.sessionId,
        messagesMoved: workspace.messagesMoved,
        duplicatesRemoved: workspace.duplicatesRemoved,
        bindings: workspace.bindings.length,
        automations: workspace.automations.length,
        sdkSession: workspace.sdkSession,
      },
      'Legacy main session became a conversation session',
    );
    if (workspace.cursor.pendingMessageIds.length > 0) {
      logger.warn(
        {
          workspaceJid: workspace.workspaceJid,
          sessionId: workspace.sessionId,
          pendingMessageIds: workspace.cursor.pendingMessageIds,
        },
        'Legacy main session had unprocessed inputs; the session picks them up',
      );
    }
  }
  for (const entry of report.unresolvedBindings) {
    logger.warn(
      entry,
      'Main-session binding names a non-workspace chat; left as is',
    );
  }
  return report;
}

export interface LegacySessionDirectoryMove {
  workspaceJid: string;
  sessionId: string;
  from: string;
  to: string;
  status:
    | 'moved'
    | 'would_move'
    | 'already_moved'
    | 'nothing_to_move'
    | 'conflict'
    | 'failed'
    | 'not_inspected';
}

/**
 * Move each migrated main session's SDK state directory under its session:
 * `sessions/<folder>/.claude` -> `sessions/<folder>/agents/<id>/.claude`.
 * Runs at every startup so a crash between the database commit and the
 * rename is finished next time; both present is left alone and reported.
 * `dryRun` only plans; `inspect: false` plans without reading the disk.
 */
export function relocateLegacyMainSessionDirectories(
  db: Db,
  options: { dataDir?: string; dryRun?: boolean; inspect?: boolean } = {},
): LegacySessionDirectoryMove[] {
  const mappings = routerStateByPrefix(db, LEGACY_MAIN_SESSION_KEY_PREFIX);
  if (mappings.length === 0) return [];
  const sessionsRoot = path.join(options.dataDir ?? DATA_DIR, 'sessions');
  const moves: LegacySessionDirectoryMove[] = [];
  for (const { key, value: sessionId } of mappings) {
    const workspaceJid = key.slice(LEGACY_MAIN_SESSION_KEY_PREFIX.length);
    const workspace = prep(
      db,
      'SELECT folder FROM registered_groups WHERE jid = ?',
    ).get(workspaceJid) as { folder: string } | undefined;
    if (
      !workspace ||
      !isValidWorkspaceFolderName(workspace.folder) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      folderOwnerJid(db, workspace.folder) !== workspaceJid
    ) {
      continue;
    }
    const from = path.join(sessionsRoot, workspace.folder, '.claude');
    const to = path.join(
      sessionsRoot,
      workspace.folder,
      'agents',
      sessionId,
      '.claude',
    );
    const move = { workspaceJid, sessionId, from, to };
    if (options.inspect === false) {
      moves.push({ ...move, status: 'not_inspected' });
      continue;
    }
    const fromExists = fs.existsSync(from);
    const toExists = fs.existsSync(to);
    if (!fromExists) {
      moves.push({
        ...move,
        status: toExists ? 'already_moved' : 'nothing_to_move',
      });
      continue;
    }
    if (toExists) {
      logger.warn(
        move,
        'Legacy main session directory and its new location both exist; left as is',
      );
      moves.push({ ...move, status: 'conflict' });
      continue;
    }
    if (options.dryRun) {
      moves.push({ ...move, status: 'would_move' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      logger.info(move, 'Moved legacy main session directory to its session');
      moves.push({ ...move, status: 'moved' });
    } catch (err) {
      // The session still runs, from a fresh SDK session; never block startup.
      logger.error(
        { err, ...move },
        'Failed to move legacy main session directory',
      );
      moves.push({ ...move, status: 'failed' });
    }
  }
  return moves;
}

export interface LegacyMainSessionCheck {
  id: string;
  ok: boolean;
  detail: string;
  violations: unknown[];
}

/**
 * The v88 guarantees (contract I1-I7) plus the history checks the migration
 * report gates on. Read-only.
 */
export function checkLegacyMainSessionInvariants(
  db: Db,
  input: {
    expectedSchemaVersion: number;
    messagesBefore?: number;
    report?: LegacyMainSessionMigrationReport | null;
  },
): LegacyMainSessionCheck[] {
  const checks: LegacyMainSessionCheck[] = [];
  const add = (id: string, detail: string, violations: unknown[]) =>
    checks.push({ id, ok: violations.length === 0, detail, violations });
  const countMessagesIn = (chatJid: string) =>
    countRows(
      db,
      'SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?',
      chatJid,
    );

  const leftOnWorkspace = prep(
    db,
    `SELECT rg.jid AS chatJid, COUNT(*) AS messages
     FROM registered_groups rg JOIN messages m ON m.chat_jid = rg.jid
     WHERE rg.jid LIKE 'web:%' GROUP BY rg.jid`,
  ).all();
  const leftOnMergedChats = (input.report?.workspaces ?? []).flatMap((w) =>
    w.sources
      .filter((s) => s.kind === 'home_im')
      .map((s) => ({
        chatJid: s.chatJid,
        messages: countMessagesIn(s.chatJid),
      }))
      .filter((s) => s.messages > 0),
  );
  add(
    'I1_no_workspace_jid_messages',
    'No messages under a workspace JID or a merged Home IM chat',
    [...leftOnWorkspace, ...leftOnMergedChats],
  );

  const mainTargets = prep(
    db,
    `SELECT jid, target_main_jid AS targetMainJid, binding_mode AS bindingMode
     FROM registered_groups
     WHERE target_main_jid IS NOT NULL AND target_main_jid <> ''
       AND COALESCE(binding_mode, '') <> 'thread_map'`,
  ).all();
  const sessionlessMounts = ['channel_mounts', 'agent_channel_mounts'].flatMap(
    (table) =>
      (
        prep(
          db,
          `SELECT channel_jid AS channelJid FROM ${table}
           WHERE routing_mode = 'single_session' AND session_id IS NULL`,
        ).all() as Array<{ channelJid: string }>
      ).map((row) => ({ table, ...row })),
  );
  add(
    'I2_bindings_target_sessions',
    'Direct and group bindings name a session; target_main_jid only on thread_map',
    [...mainTargets, ...sessionlessMounts],
  );

  const emptyAgentRows = FOLDER_AGENT_ROWS.flatMap(([, table, column]) =>
    (
      prep(
        db,
        `SELECT group_folder AS folder FROM ${table}
         WHERE ${column} = '' AND group_folder IN (
           SELECT folder FROM registered_groups WHERE jid LIKE 'web:%')`,
      ).all() as Array<{ folder: string }>
    ).map((row) => ({ table, ...row })),
  );
  add(
    'I3_no_empty_agent_rows',
    "No agent_id = '' runtime rows for an active workspace",
    emptyAgentRows,
  );

  const automationViolations = (
    prep(
      db,
      `SELECT a.id, a.status, a.session_mode AS sessionMode,
              a.workspace_jid AS workspaceJid, a.target_session_jid AS target,
              EXISTS (
                SELECT 1 FROM agents s
                WHERE s.chat_jid = a.workspace_jid
                  AND a.target_session_jid = a.workspace_jid || '#agent:' || s.id
              ) AS resolves,
              EXISTS (
                SELECT 1 FROM registered_groups rg
                WHERE rg.jid = a.target_session_jid
              ) AS workspaceTarget
       FROM automations a`,
    ).all() as Array<{
      id: string;
      status: string;
      sessionMode: string;
      workspaceJid: string;
      target: string | null;
      resolves: number;
      workspaceTarget: number;
    }>
  ).filter(
    (a) =>
      a.workspaceTarget === 1 ||
      (a.sessionMode === 'bound' &&
        (!a.target?.startsWith(`${a.workspaceJid}#agent:`) ||
          (a.status === 'active' && a.resolves !== 1))),
  );
  add(
    'I4_bound_automations_target_sessions',
    'Bound automations target <workspace>#agent:<id>; active ones an existing session',
    automationViolations,
  );

  const mainOwnerKeys = prep(
    db,
    `SELECT key FROM router_state
     WHERE key >= @from AND key < @to
       AND substr(key, length(@from) + 1) IN (
         SELECT folder || ':main' FROM registered_groups WHERE jid LIKE 'web:%')`,
  ).all(keyPrefixRange(OWNER_KEY_PREFIX));
  add(
    'I5_no_main_channel_owner_keys',
    'channel_session_owner:<folder>:main is gone for active workspaces',
    mainOwnerKeys,
  );

  const legacyRows = prep(
    db,
    `SELECT a.id, a.kind, a.title_source AS titleSource, a.chat_jid AS chatJid,
            a.group_folder AS folder, rg.folder AS workspaceFolder,
            EXISTS (
              SELECT 1 FROM chats c WHERE c.jid = a.chat_jid || '#agent:' || a.id
            ) AS hasChat
     FROM agents a LEFT JOIN registered_groups rg ON rg.jid = a.chat_jid
     WHERE a.source_kind = 'legacy_main'`,
  ).all() as Array<{
    id: string;
    kind: string;
    titleSource: string | null;
    chatJid: string;
    folder: string;
    workspaceFolder: string | null;
    hasChat: number;
  }>;
  const sdkSessionsMissing = (input.report?.workspaces ?? [])
    .filter(
      (w) =>
        w.sdkSession &&
        !exists(
          db,
          'SELECT 1 FROM sessions WHERE group_folder = ? AND agent_id = ?',
          w.folder,
          w.sessionId,
        ),
    )
    .map((w) => ({ sessionId: w.sessionId, missing: 'sessions row' }));
  add(
    'I6_legacy_main_session_rows',
    'legacy_main sessions are conversation rows of their workspace, with a chat and their SDK session',
    [
      ...legacyRows.filter(
        (row) =>
          row.kind !== 'conversation' ||
          row.titleSource !== 'auto' ||
          !row.workspaceFolder ||
          row.folder !== row.workspaceFolder ||
          row.hasChat !== 1,
      ),
      ...sdkSessionsMissing,
    ],
  );

  const legacyById = new Map(legacyRows.map((row) => [row.id, row]));
  const mappedIds = new Set<string>();
  const mappingViolations: unknown[] = [];
  for (const { key, value: sessionId } of routerStateByPrefix(
    db,
    LEGACY_MAIN_SESSION_KEY_PREFIX,
  )) {
    const workspaceJid = key.slice(LEGACY_MAIN_SESSION_KEY_PREFIX.length);
    if (legacyById.get(sessionId)?.chatJid !== workspaceJid) {
      mappingViolations.push({
        workspaceJid,
        sessionId,
        problem: 'no legacy_main session of this workspace',
      });
    }
    if (mappedIds.has(sessionId)) {
      mappingViolations.push({
        workspaceJid,
        sessionId,
        problem: 'mapped twice',
      });
    }
    mappedIds.add(sessionId);
  }
  for (const row of legacyRows) {
    if (!mappedIds.has(row.id)) {
      mappingViolations.push({ sessionId: row.id, problem: 'unmapped' });
    }
  }
  add(
    'I7_mapping_keys',
    'legacy_main_session:<workspace> maps one-to-one onto legacy_main sessions',
    mappingViolations,
  );

  const messagesAfter = countRows(db, 'SELECT COUNT(*) AS n FROM messages');
  if (input.messagesBefore === undefined || !input.report) {
    checks.push({
      id: 'message_count_preserved',
      ok: true,
      detail: 'Skipped: the migration did not run in this pass',
      violations: [],
    });
  } else {
    const expected = input.messagesBefore - input.report.duplicatesRemoved;
    add(
      'message_count_preserved',
      `Messages before (${input.messagesBefore}) minus duplicates (${input.report.duplicatesRemoved}) equals messages after (${messagesAfter})`,
      expected === messagesAfter ? [] : [{ expected, actual: messagesAfter }],
    );
  }

  const sequenceViolations: unknown[] = [];
  for (const row of legacyRows) {
    const sessionJid = `${row.chatJid}#agent:${row.id}`;
    const unsequenced = countRows(
      db,
      `SELECT COUNT(*) AS n FROM messages m
       WHERE m.chat_jid = ? AND NOT EXISTS (
         SELECT 1 FROM message_ingest_sequences seq
         WHERE seq.chat_jid = m.chat_jid AND seq.message_id = m.id)`,
      sessionJid,
    );
    if (unsequenced > 0) sequenceViolations.push({ sessionJid, unsequenced });
    const outOfOrder = prep(
      db,
      `SELECT id FROM (
         SELECT m.id, m.timestamp,
                LAG(m.timestamp) OVER (ORDER BY seq.sequence) AS previous
         FROM message_ingest_sequences seq
         JOIN messages m ON m.chat_jid = seq.chat_jid AND m.id = seq.message_id
         WHERE seq.chat_jid = ?)
       WHERE COALESCE(timestamp, '') < COALESCE(previous, '')
       LIMIT 1`,
    ).get(sessionJid) as { id: string } | undefined;
    if (outOfOrder) {
      sequenceViolations.push({ sessionJid, messageId: outOfOrder.id });
    }
  }
  add(
    'session_sequences_monotonic',
    'Every legacy_main message has a sequence, in time order',
    sequenceViolations,
  );

  const schemaVersion = routerState(db, 'schema_version');
  add(
    'schema_version',
    `schema_version is ${input.expectedSchemaVersion}`,
    schemaVersion === String(input.expectedSchemaVersion)
      ? []
      : [{ schemaVersion }],
  );
  return checks;
}
