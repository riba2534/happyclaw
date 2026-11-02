/**
 * What v88 leaves in the database, read without side effects: the mapping
 * keys, the legacy_main sessions and the invariant checks. Imports nothing
 * that touches the filesystem on load (config.js does), so the post-deploy
 * check can open the live database read-only next to a running server.
 */
import type Database from 'better-sqlite3';

import type { LegacyMainSessionMigrationReport } from './legacy-main-session-migration.js';
import { keyPrefixRange } from './sql-key-prefix.js';

type Db = Database.Database;

/** router_state `legacy_main_session:<workspace JID>` = new session id. */
export const LEGACY_MAIN_SESSION_KEY_PREFIX = 'legacy_main_session:';
export const OWNER_KEY_PREFIX = 'channel_session_owner:';

/** Folder-keyed rows whose `''` agent id meant the main session. */
export const FOLDER_AGENT_ROWS = [
  ['sdkSession', 'sessions', 'agent_id'],
  ['runtimeSession', 'workspace_runtime_sessions', 'runtime_agent_id'],
  ['modelSelection', 'session_model_selections', 'agent_id'],
  ['historyReinjection', 'session_history_reinjections', 'agent_id'],
] as const;

const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

/** Prepare once per connection. */
export function prep(db: Db, sql: string): Database.Statement {
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

export function exists(db: Db, sql: string, ...params: unknown[]): boolean {
  return prep(db, sql).get(...params) !== undefined;
}

export function countRows(db: Db, sql: string, ...params: unknown[]): number {
  return Number((prep(db, sql).get(...params) as { n: number }).n);
}

export function routerState(db: Db, key: string): string | undefined {
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

/** Drop the cached statements, e.g. after the tables they read are gone. */
export function forgetStatements(db: Db): void {
  statementCache.delete(db);
}

/**
 * better-sqlite3 options for reading a live database: no writes, no
 * checkpoint. A WAL reader still takes read marks in -shm, and opening a
 * WAL database whose server is stopped creates an empty -wal and the -shm.
 */
export const READ_ONLY_OPEN = { readonly: true, fileMustExist: true } as const;

/** The v88 mappings: workspace JID -> the session its main session became. */
export function legacyMainMappings(
  db: Db,
): Array<{ workspaceJid: string; sessionId: string }> {
  return routerStateByPrefix(db, LEGACY_MAIN_SESSION_KEY_PREFIX).map(
    ({ key, value }) => ({
      workspaceJid: key.slice(LEGACY_MAIN_SESSION_KEY_PREFIX.length),
      sessionId: value,
    }),
  );
}

function countChatMessages(db: Db, chatJid: string): number {
  return countRows(
    db,
    'SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?',
    chatJid,
  );
}

export interface LegacyMainSession {
  workspaceJid: string;
  sessionId: string;
  /** Messages the session holds now. */
  messages: number;
}

/** Every v88 mapping with its session's current message count. */
export function listLegacyMainSessions(db: Db): LegacyMainSession[] {
  return legacyMainMappings(db).map((mapping) => ({
    ...mapping,
    messages: countChatMessages(
      db,
      `${mapping.workspaceJid}#agent:${mapping.sessionId}`,
    ),
  }));
}

export interface LegacyMainSessionCheck {
  id: string;
  ok: boolean;
  detail: string;
  violations: unknown[];
}

/**
 * The v88 guarantees (contract I1-I7) plus the history checks the migration
 * report gates on. Read-only. The message count is compared only when the
 * pre-migration count and the report are given.
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
        messages: countChatMessages(db, s.chatJid),
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
  for (const { workspaceJid, sessionId } of legacyMainMappings(db)) {
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

  // Only a pass that just migrated knows the count to compare against.
  if (input.messagesBefore !== undefined && input.report) {
    const messagesAfter = countRows(db, 'SELECT COUNT(*) AS n FROM messages');
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
