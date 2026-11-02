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
 * legacy-main-session-plan.ts decides what moves where; this module writes.
 *
 * initDatabase runs this after creating every table it touches. The SDK
 * state directory moves separately (relocateLegacyMainSessionDirectories)
 * because a database transaction cannot cover a rename.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { DATA_DIR } from './config.js';
import {
  FOLDER_AGENT_ROWS,
  forgetStatements,
  LEGACY_MAIN_SESSION_KEY_PREFIX,
  legacyMainMappings,
  OWNER_KEY_PREFIX,
  prep,
  routerState,
} from './legacy-main-session-checks.js';
import {
  folderOwnerJid,
  listWorkspaces,
  lstatOrNull,
  planMainTargets,
  planWorkspace,
  type BindingEntry,
  type LegacyMainSessionSourcePlan,
  type WorkspaceMessagePlan,
  type WorkspaceRow,
} from './legacy-main-session-plan.js';

type MainTargetPlan = ReturnType<typeof planMainTargets>;
import { logger } from './logger.js';
import { keyPrefixRange } from './sql-key-prefix.js';
import { generateAutoTitle } from './session-title.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';

type Db = Database.Database;

const HISTORY_ISOLATION_PREFIX = 'conversation_history_isolation:';
/** Inputs not typed by a person; never a session title. */
const SYNTHETIC_INPUT_KINDS = new Set([
  'user_command',
  'scheduled_task_prompt',
  'automation_prompt',
  'work_item_input',
]);

export interface LegacyMainSessionCursor {
  timestamp: string;
  id: string;
  sequence: number;
}

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
  sources: LegacyMainSessionSourcePlan[];
  messagesMoved: number;
  duplicatesRemoved: number;
  renamedDuplicates: WorkspaceMessagePlan['renamed'];
  cursor: {
    state: 'none' | 'caught_up' | 'pending' | 'pending_not_replayed';
    value: LegacyMainSessionCursor | null;
    /** Replayed by the session. */
    pendingMessageIds: string[];
    /** Left behind the cursor so no processed input replays. */
    pendingNotReplayed: string[];
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
  /** Of those, the runs whose ids and keys named the main lane. */
  turnRunsRekeyed: number;
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
  /** Topic containers kept on their workspace, now recorded as thread_map. */
  topicContainersKept: BindingEntry[];
  /** Non-topic `target_main_jid` that resolved to no workspace (never routed). */
  staleBindingsCleared: BindingEntry[];
  /** `target_main_jid` left beside a `target_agent_id`, which always won. */
  redundantMainTargetsCleared: BindingEntry[];
  /** Non-topic `target_main_jid` naming a registered non-web chat; left as is. */
  unresolvedBindings: BindingEntry[];
  duplicatesRemoved: number;
  pendingMessageIds: string[];
  pendingNotReplayed: string[];
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

function firstTitle(db: Db, plan: WorkspaceMessagePlan): string | null {
  const read = prep(
    db,
    `SELECT content, source_kind AS sourceKind FROM messages
     WHERE chat_jid = ? AND id = ?`,
  );
  let tried = 0;
  for (const message of plan.order) {
    if (!message.inbound) continue;
    if (++tried > 50) break;
    const row = read.get(message.chatJid, message.sourceId) as {
      content: unknown;
      sourceKind: string | null;
    };
    if (SYNTHETIC_INPUT_KINDS.has(row.sourceKind ?? '')) continue;
    if (typeof row.content !== 'string') continue;
    const title = generateAutoTitle(row.content);
    if (title) return title;
  }
  return null;
}

/** channel-turn-runtime.ts: run and card ids are digests of the run key. */
function turnDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Point the session's channel turns at it. A turn's key ends in its lane
 * (`main` for the main session) and its id, card id and outbox keys derive
 * from the key, so a replayed input must find the same run under the new
 * lane: those are rewritten together.
 */
function rekeyTurnRuns(
  db: Db,
  sessionId: string,
  sessionJid: string,
): { moved: number; rekeyed: number } {
  const runs = prep(
    db,
    `SELECT id, idempotency_key AS key, inbox_id AS inboxId FROM turn_runs
     WHERE (agent_id IS NULL OR agent_id = '')
       AND correlation_id IN (SELECT id FROM messages WHERE chat_jid = ?)`,
  ).all(sessionJid) as Array<{
    id: string;
    key: string;
    inboxId: string | null;
  }>;
  const columns = (
    db.prepare('PRAGMA table_info(turn_runs)').all() as Array<{ name: string }>
  )
    .map((c) => c.name)
    .filter(
      (name) =>
        !['id', 'idempotency_key', 'agent_id', 'inbox_id'].includes(name),
    );
  const copy = prep(
    db,
    `INSERT INTO turn_runs (id, idempotency_key, agent_id, inbox_id, ${columns.join(', ')})
     SELECT ?, ?, ?, NULL, ${columns.join(', ')} FROM turn_runs WHERE id = ?`,
  );
  let rekeyed = 0;
  for (const run of runs) {
    if (!run.key.endsWith(':main')) {
      prep(db, 'UPDATE turn_runs SET agent_id = ? WHERE id = ?').run(
        sessionId,
        run.id,
      );
      continue;
    }
    const key = `${run.key.slice(0, -'main'.length)}${sessionId}`;
    const id = `turn_${turnDigest(key)}`;
    const oldCard = `stream_${turnDigest(`${run.id}:primary`)}`;
    const card = `stream_${turnDigest(`${id}:primary`)}`;
    copy.run(id, key, sessionId, run.id);
    prep(
      db,
      `UPDATE streaming_cards SET turn_run_id = ?,
         id = CASE WHEN id = ? THEN ? ELSE id END
       WHERE turn_run_id = ?`,
    ).run(id, oldCard, card, run.id);
    // Keys can contain NUL-delimited delivery identities. SQLite's TEXT
    // substr truncates at NUL, so replace the prefix in JS to keep the full
    // suffix (and distinct deliveries) intact.
    const outbox = prep(
      db,
      'SELECT id, idempotency_key AS key FROM channel_outbox WHERE turn_run_id = ?',
    ).all(run.id) as Array<{ id: string; key: string }>;
    const moveOutbox = prep(
      db,
      'UPDATE channel_outbox SET turn_run_id = ?, idempotency_key = ? WHERE id = ?',
    );
    for (const row of outbox) {
      const key = row.key.startsWith(run.id)
        ? `${id}${row.key.slice(run.id.length)}`
        : row.key.startsWith(oldCard)
          ? `${card}${row.key.slice(oldCard.length)}`
          : row.key;
      moveOutbox.run(id, key, row.id);
    }
    prep(db, 'DELETE FROM turn_runs WHERE id = ?').run(run.id);
    prep(db, 'UPDATE turn_runs SET inbox_id = ? WHERE id = ?').run(
      run.inboxId,
      id,
    );
    rekeyed += 1;
  }
  return { moved: runs.length, rekeyed };
}

/** Both cursors of the session, at the place the plan chose. */
function writeCursors(
  db: Db,
  sessionJid: string,
  sourceJids: readonly string[],
  plan: WorkspaceMessagePlan,
): LegacyMainSessionWorkspaceReport['cursor'] {
  for (const jid of sourceJids) {
    prep(db, 'DELETE FROM router_cursors WHERE chat_jid = ?').run(jid);
  }
  const report = {
    pendingMessageIds: plan.pendingReplayed,
    pendingNotReplayed: plan.pendingNotReplayed,
  };
  if (plan.cursorAfter === null) {
    return { state: 'none', value: null, ...report };
  }
  const anchor = plan.order[plan.cursorAfter];
  const value: LegacyMainSessionCursor = anchor
    ? {
        timestamp: anchor.timestamp ?? '',
        id: anchor.id,
        sequence: (
          prep(
            db,
            'SELECT sequence FROM message_ingest_sequences WHERE chat_jid = ? AND message_id = ?',
          ).get(sessionJid, anchor.id) as { sequence: number }
        ).sequence,
      }
    : { timestamp: '', id: '', sequence: 0 };
  for (const kind of ['committed', 'next_pull']) {
    prep(
      db,
      'INSERT OR REPLACE INTO router_cursors (kind, chat_jid, cursor) VALUES (?, ?, ?)',
    ).run(kind, sessionJid, JSON.stringify(value));
  }
  return {
    state:
      plan.pendingNotReplayed.length > 0
        ? 'pending_not_replayed'
        : plan.pendingReplayed.length > 0
          ? 'pending'
          : 'caught_up',
    value,
    ...report,
  };
}

/** Move the planned rows under the session, in the planned order. */
function moveMessages(
  db: Db,
  sessionJid: string,
  plan: WorkspaceMessagePlan,
): void {
  const sequence = prep(
    db,
    'INSERT INTO message_ingest_sequences (chat_jid, message_id) VALUES (?, ?)',
  );
  for (const message of plan.order) sequence.run(sessionJid, message.id);
  for (const source of plan.sources) {
    if (source.kind === 'home_im') {
      // Only the workspace's own rows were ever replayed into the model.
      prep(
        db,
        `UPDATE messages SET source_jid = COALESCE(source_jid, chat_jid),
           history_recovery_allowed = 0
         WHERE chat_jid = ?`,
      ).run(source.chatJid);
    }
  }
  const move = prep(
    db,
    'UPDATE messages SET chat_jid = ?, id = ? WHERE chat_jid = ? AND id = ?',
  );
  for (const message of plan.order) {
    move.run(sessionJid, message.id, message.chatJid, message.sourceId);
  }
  for (const source of plan.sources) {
    const dropped = prep(db, 'DELETE FROM messages WHERE chat_jid = ?').run(
      source.chatJid,
    ).changes;
    if (dropped !== source.duplicates) {
      throw new Error(
        `Legacy main session migration left ${dropped - source.duplicates} unplanned rows in ${source.chatJid}`,
      );
    }
    prep(db, 'DELETE FROM message_ingest_sequences WHERE chat_jid = ?').run(
      source.chatJid,
    );
  }
}

function migrateWorkspace(
  db: Db,
  workspace: WorkspaceRow,
  targets: MainTargetPlan,
  report: LegacyMainSessionMigrationReport,
): void {
  const {
    ownsFolderState,
    sourceJids,
    bindings,
    migrates,
    messages: plan,
  } = planWorkspace(db, workspace, targets);
  if (!migrates) {
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

  // The order puts missing times first and the latest time last.
  const first = plan.order.find((m) => m.timestamp !== null)?.timestamp ?? null;
  const last = plan.order.at(-1)?.timestamp ?? null;
  const sessionName = mappedName ?? firstTitle(db, plan) ?? workspace.name;
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
      first ?? workspace.added_at,
      last,
    );
  }
  prep(
    db,
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       last_message_time = MAX(COALESCE(last_message_time, ''), excluded.last_message_time)`,
  ).run(sessionJid, sessionName, last ?? workspace.added_at);

  moveMessages(db, sessionJid, plan);
  const cursor = writeCursors(db, sessionJid, sourceJids, plan);

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
  const turnRuns = rekeyTurnRuns(db, sessionId, sessionJid);

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
    sources: plan.sources,
    messagesMoved: plan.order.length,
    duplicatesRemoved: plan.duplicates.length,
    renamedDuplicates: plan.renamed,
    cursor,
    bindings,
    channelMountsUpdated,
    agentChannelMountsUpdated,
    automations,
    automationRuns,
    ...folderRows,
    usageRecords,
    usageEvents,
    turnRuns: turnRuns.moved,
    turnRunsRekeyed: turnRuns.rekeyed,
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
    topicContainersKept: [],
    staleBindingsCleared: [],
    redundantMainTargetsCleared: [],
    unresolvedBindings: [],
    duplicatesRemoved: 0,
    pendingMessageIds: [],
    pendingNotReplayed: [],
  };
  db.transaction(() => {
    const targets = planMainTargets(db);
    for (const workspace of listWorkspaces(db)) {
      migrateWorkspace(db, workspace, targets, report);
    }
    // What the router does on a topic container's first thread message.
    for (const entry of targets.topicContainers) {
      prep(
        db,
        "UPDATE registered_groups SET binding_mode = 'thread_map', target_main_jid = ? WHERE jid = ?",
      ).run(entry.workspaceJid, entry.channelJid);
      for (const table of ['channel_mounts', 'agent_channel_mounts']) {
        prep(
          db,
          `UPDATE ${table} SET routing_mode = 'thread_map'
           WHERE channel_jid = ? AND session_id IS NULL`,
        ).run(entry.channelJid);
      }
    }
    for (const entry of [...targets.stale, ...targets.redundant]) {
      prep(
        db,
        'UPDATE registered_groups SET target_main_jid = NULL WHERE jid = ?',
      ).run(entry.channelJid);
    }
    report.topicContainersKept = targets.topicContainers;
    report.staleBindingsCleared = targets.stale;
    report.redundantMainTargetsCleared = targets.redundant;
    report.unresolvedBindings = targets.unresolved;
  }).immediate();
  forgetStatements(db);

  for (const workspace of report.workspaces) {
    report.duplicatesRemoved += workspace.duplicatesRemoved;
    report.pendingMessageIds.push(...workspace.cursor.pendingMessageIds);
    report.pendingNotReplayed.push(...workspace.cursor.pendingNotReplayed);
    logger.info(
      {
        workspaceJid: workspace.workspaceJid,
        sessionId: workspace.sessionId,
        messagesMoved: workspace.messagesMoved,
        duplicatesRemoved: workspace.duplicatesRemoved,
        renamedDuplicates: workspace.renamedDuplicates.length,
        bindings: workspace.bindings.length,
        automations: workspace.automations.length,
        sdkSession: workspace.sdkSession,
      },
      'Legacy main session became a conversation session',
    );
    for (const [pending, message] of [
      [
        workspace.cursor.pendingMessageIds,
        'Legacy main session had unprocessed inputs; the session picks them up',
      ],
      [
        workspace.cursor.pendingNotReplayed,
        'Legacy main session had unprocessed inputs before processed ones; they are not replayed',
      ],
    ] as const) {
      if (pending.length === 0) continue;
      logger.warn(
        {
          workspaceJid: workspace.workspaceJid,
          sessionId: workspace.sessionId,
          pending,
        },
        message,
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
    | 'relinked'
    | 'would_relink'
    | 'merged'
    | 'would_merge'
    | 'already_moved'
    | 'nothing_to_move'
    | 'conflict'
    | 'failed'
    | 'not_inspected';
}

const DONE = { relink: 'relinked', merge: 'merged', move: 'moved' } as const;

/** An SDK state directory with a transcript, not a runner's fresh skeleton. */
function hasTranscript(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'projects'));
}

/**
 * Forget v88 state whose session is gone: a `legacy_main_session:<workspace>`
 * mapping that does not name a legacy_main session of that workspace (the
 * rule the I7 check applies), and an `oom_exits:<folder>#<id>` counter of a
 * session that no longer exists. Deleting a session or a workspace forgets
 * its own; this clears what deletions left before they did.
 */
export function forgetOrphanedLegacyMainState(db: Db): {
  mappings: number;
  oomCounters: number;
} {
  const mappings = prep(
    db,
    `DELETE FROM router_state
     WHERE key >= @from AND key < @to
       AND NOT EXISTS (
         SELECT 1 FROM agents a
         WHERE a.id = router_state.value
           AND a.source_kind = 'legacy_main'
           AND a.chat_jid = substr(router_state.key, length(@from) + 1))`,
  ).run(keyPrefixRange(LEGACY_MAIN_SESSION_KEY_PREFIX)).changes;
  const oomCounters = prep(
    db,
    `DELETE FROM router_state
     WHERE key >= @from AND key < @to
       AND NOT EXISTS (
         SELECT 1 FROM agents a
         WHERE a.id = substr(router_state.key, instr(router_state.key, '#') + 1))`,
  ).run(keyPrefixRange('oom_exits:')).changes;
  if (mappings > 0 || oomCounters > 0) {
    logger.info(
      { mappings, oomCounters },
      'Forgot v88 state of sessions that no longer exist',
    );
  }
  return { mappings, oomCounters };
}

/**
 * Move each migrated main session's SDK state directory under its session:
 * `sessions/<folder>/.claude` -> `sessions/<folder>/agents/<id>/.claude`.
 * Runs at every startup so an interrupted or failed move is finished next
 * time. A symlink is re-created at the new path with the same absolute
 * target. When the session's first run already created a skeleton there,
 * the old transcript moves into it; two transcripts are left alone.
 * `dryRun` only plans; `inspect: false` plans without reading the disk.
 */
export function relocateLegacyMainSessionDirectories(
  db: Db,
  options: { dataDir?: string; dryRun?: boolean; inspect?: boolean } = {},
): LegacySessionDirectoryMove[] {
  const mappings = legacyMainMappings(db);
  if (mappings.length === 0) return [];
  const sessionsRoot = path.join(options.dataDir ?? DATA_DIR, 'sessions');
  const moves: LegacySessionDirectoryMove[] = [];
  for (const { workspaceJid, sessionId } of mappings) {
    const workspace = prep(
      db,
      `SELECT rg.folder FROM registered_groups rg
       JOIN agents a ON a.id = ? AND a.chat_jid = rg.jid
       WHERE rg.jid = ?`,
    ).get(sessionId, workspaceJid) as { folder: string } | undefined;
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
    const done = (status: LegacySessionDirectoryMove['status']) =>
      moves.push({ ...move, status });
    if (options.inspect === false) {
      done('not_inspected');
      continue;
    }
    const source = lstatOrNull(from);
    const target = lstatOrNull(to);
    if (!source) {
      done(target ? 'already_moved' : 'nothing_to_move');
      continue;
    }
    const linked = source.isSymbolicLink();
    const sourceTranscript = linked || hasTranscript(from);
    if (target && (hasTranscript(to) || !sourceTranscript)) {
      const message =
        'Legacy main session directory and its new location both exist; left as is';
      if (sourceTranscript) logger.error(move, message);
      else logger.warn(move, message);
      done('conflict');
      continue;
    }
    const action = linked ? 'relink' : target ? 'merge' : 'move';
    if (options.dryRun) {
      done(`would_${action}`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (action === 'relink') {
        // The runner's skeleton holds nothing the next run does not recreate.
        if (target) fs.rmSync(to, { recursive: true, force: true });
        fs.symlinkSync(
          path.resolve(path.dirname(from), fs.readlinkSync(from)),
          to,
        );
        fs.unlinkSync(from);
      } else if (action === 'merge') {
        for (const entry of fs.readdirSync(from)) {
          fs.rmSync(path.join(to, entry), { recursive: true, force: true });
          fs.renameSync(path.join(from, entry), path.join(to, entry));
        }
        fs.rmdirSync(from);
      } else {
        fs.renameSync(from, to);
      }
      const status = DONE[action];
      logger.info(
        { ...move, status },
        'Moved legacy main session directory to its session',
      );
      done(status);
    } catch (err) {
      // The session still runs, from a fresh SDK session; never block startup.
      logger.error(
        { err, ...move },
        'Failed to move legacy main session directory',
      );
      done('failed');
    }
  }
  return moves;
}
