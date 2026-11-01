import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-main-session-'));
const storeDir = path.join(root, 'db');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
const repositoryRoot = path.resolve(import.meta.dirname, '..');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const migration = await import('../src/legacy-main-session-migration.js');

afterEach(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T = (minute: number) =>
  new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

type Conn = Database.Database;

/** A head database rewound to v87, with legacy rows written by `seed`. */
function buildV87(seed: (conn: Conn) => void): void {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  for (const dir of [storeDir, path.join(root, 'sessions')]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  db.closeDatabase();
  const conn = new Database(databasePath);
  try {
    seed(conn);
    conn
      .prepare(
        "UPDATE router_state SET value = '87' WHERE key = 'schema_version'",
      )
      .run();
  } finally {
    conn.close();
  }
}

function inspect<T>(read: (conn: Conn) => T): T {
  const conn = new Database(databasePath, { readonly: true });
  try {
    return read(conn);
  } finally {
    conn.close();
  }
}

function group(
  conn: Conn,
  jid: string,
  fields: {
    folder: string;
    name?: string;
    createdBy?: string | null;
    isHome?: boolean;
    addedAt?: string;
    targetMainJid?: string | null;
    targetAgentId?: string | null;
    bindingMode?: string | null;
  },
): void {
  conn
    .prepare(
      `INSERT INTO registered_groups (
        jid, name, folder, added_at, created_by, is_home,
        target_main_jid, target_agent_id, binding_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jid,
      fields.name ?? jid,
      fields.folder,
      fields.addedAt ?? T(0),
      fields.createdBy === undefined ? 'u1' : fields.createdBy,
      fields.isHome ? 1 : 0,
      fields.targetMainJid ?? null,
      fields.targetAgentId ?? null,
      fields.bindingMode ?? null,
    );
}

function message(
  conn: Conn,
  chatJid: string,
  id: string,
  timestamp: string,
  fields: {
    content?: string;
    fromMe?: boolean;
    sourceJid?: string | null;
    sourceKind?: string | null;
    deliveryStatus?: string | null;
  } = {},
): number {
  conn
    .prepare(
      'INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)',
    )
    .run(chatJid, chatJid, timestamp);
  conn
    .prepare(
      `INSERT INTO messages (
        id, chat_jid, source_jid, sender, sender_name, content, timestamp,
        is_from_me, source_kind, delivery_status
      ) VALUES (?, ?, ?, 'u1', 'User', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      chatJid,
      fields.sourceJid ?? null,
      fields.content ?? `text of ${id}`,
      timestamp,
      fields.fromMe ? 1 : 0,
      fields.sourceKind ?? null,
      fields.deliveryStatus ?? null,
    );
  return sequenceOf(conn, chatJid, id)!;
}

function sequenceOf(conn: Conn, chatJid: string, id: string): number | null {
  const row = conn
    .prepare(
      'SELECT sequence FROM message_ingest_sequences WHERE chat_jid = ? AND message_id = ?',
    )
    .get(chatJid, id) as { sequence: number } | undefined;
  return row?.sequence ?? null;
}

function cursor(
  conn: Conn,
  kind: 'committed' | 'next_pull',
  chatJid: string,
  value: { timestamp: string; id: string; sequence?: number },
): void {
  conn
    .prepare(
      'INSERT OR REPLACE INTO router_cursors (kind, chat_jid, cursor) VALUES (?, ?, ?)',
    )
    .run(kind, chatJid, JSON.stringify(value));
}

function routerState(conn: Conn, key: string, value: string): void {
  conn
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(key, value);
}

function mappedSession(conn: Conn, workspaceJid: string): string | undefined {
  return (
    conn
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(`${migration.LEGACY_MAIN_SESSION_KEY_PREFIX}${workspaceJid}`) as
      | { value: string }
      | undefined
  )?.value;
}

function messageIds(conn: Conn, chatJid: string): string[] {
  return (
    conn
      .prepare(
        `SELECT m.id FROM message_ingest_sequences seq
         JOIN messages m ON m.chat_jid = seq.chat_jid AND m.id = seq.message_id
         WHERE seq.chat_jid = ? ORDER BY seq.sequence`,
      )
      .all(chatJid) as Array<{ id: string }>
  ).map((row) => row.id);
}

function cursorOf(conn: Conn, kind: string, chatJid: string): unknown {
  const row = conn
    .prepare(
      'SELECT cursor FROM router_cursors WHERE kind = ? AND chat_jid = ?',
    )
    .get(kind, chatJid) as { cursor: string } | undefined;
  return row ? JSON.parse(row.cursor) : undefined;
}

const HOME = 'web:main';
const WORK = 'web:5f0c7a2e-work';
const EMPTY = 'web:9d1e-empty';
const DM = 'feishu:ou_dm_owner';
const BOUND_GROUP = 'feishu:oc_bound_group';
const OTHER_OWNER_DM = 'feishu:ou_dm_other';
const WORK_GROUP = 'feishu:oc_work_group';
const TOPIC_GROUP = 'feishu:oc_topic_group';
const WORK_DM = 'feishu:ou_work_dm';
const ORPHAN = 'web:deleted-workspace';
const EXISTING_SESSION = 'existing-session';

/**
 * Home with merged IM history (one duplicate id), a bound group, a topic
 * group, another owner's DM; a second workspace with a pending input and an
 * unmerged DM; an empty workspace; an orphan workspace JID.
 */
function seedRich(conn: Conn): void {
  group(conn, HOME, { folder: 'main', name: 'Home', isHome: true });
  group(conn, WORK, {
    folder: 'flow-work',
    name: 'Work',
    addedAt: T(1),
  });
  group(conn, EMPTY, { folder: 'flow-empty', name: 'Empty', addedAt: T(2) });
  group(conn, DM, { folder: 'main' });
  group(conn, BOUND_GROUP, {
    folder: 'main',
    targetMainJid: HOME,
    bindingMode: 'single_context',
  });
  group(conn, OTHER_OWNER_DM, { folder: 'main', createdBy: 'u2' });
  group(conn, WORK_GROUP, {
    folder: 'main',
    targetMainJid: WORK,
    bindingMode: 'single_context',
  });
  group(conn, TOPIC_GROUP, {
    folder: 'main',
    targetMainJid: HOME,
    bindingMode: 'thread_map',
  });
  group(conn, WORK_DM, { folder: 'flow-work' });

  conn
    .prepare(
      `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_at)
       VALUES (?, 'flow-work', ?, 'Existing', '', 'idle', 'conversation', ?)`,
    )
    .run(EXISTING_SESSION, WORK, T(1));
  conn
    .prepare(
      `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_at, spawned_from_jid)
       VALUES ('spawn-1', 'main', ?, 'Spawn', '', 'running', 'spawn', ?, ?)`,
    )
    .run(HOME, T(3), HOME);

  // Old arrival order differs from provider time: the DM rows arrive after
  // home-3 but are older, so the merged history puts them before it.
  message(conn, HOME, 'home-1', T(1), {
    content: '/status',
    sourceKind: 'user_command',
  });
  message(conn, HOME, 'home-2', T(2), { content: '**帮我**写一个周报模板' });
  message(conn, HOME, 'home-3', T(12), { fromMe: true, content: 'Sure' });
  const homeLast = message(conn, HOME, 'dup-1', T(20), { sourceJid: DM });
  message(conn, DM, 'dm-1', T(5), { content: 'legacy dm' });
  const dmLast = message(conn, DM, 'dup-1', T(20));
  message(conn, DM, 'dm-2', T(21), { fromMe: true, content: 'legacy reply' });
  message(conn, BOUND_GROUP, 'group-1', T(6), {
    sourceJid: BOUND_GROUP,
  });
  message(conn, OTHER_OWNER_DM, 'other-1', T(7));
  message(conn, WORK, 'work-1', T(30));
  const workPendingSeq = message(conn, WORK, 'work-2', T(31), {
    content: 'deploy the thing',
  });
  message(conn, WORK, 'work-3', T(32), { fromMe: true });
  message(conn, WORK_DM, 'work-dm-1', T(33));
  message(conn, ORPHAN, 'orphan-1', T(34));
  message(conn, `${WORK}#agent:${EXISTING_SESSION}`, 'existing-1', T(35));

  cursor(conn, 'committed', HOME, {
    timestamp: T(20),
    id: 'dup-1',
    sequence: homeLast,
  });
  cursor(conn, 'next_pull', HOME, {
    timestamp: T(20),
    id: 'dup-1',
    sequence: homeLast,
  });
  cursor(conn, 'committed', DM, {
    timestamp: T(20),
    id: 'dup-1',
    sequence: dmLast,
  });
  // A legacy cursor without a sequence still resolves by message id.
  cursor(conn, 'committed', BOUND_GROUP, { timestamp: T(6), id: 'group-1' });
  cursor(conn, 'committed', WORK, {
    timestamp: T(30),
    id: 'work-1',
    sequence: workPendingSeq - 1,
  });
  cursor(conn, 'next_pull', WORK, {
    timestamp: T(31),
    id: 'work-2',
    sequence: workPendingSeq,
  });
  // Idempotency records older than a day are pruned at startup.
  const recent = new Date().toISOString();

  conn.exec(`
    INSERT INTO sessions (group_folder, session_id, agent_id) VALUES
      ('main', 'sdk-home', ''), ('flow-work', 'sdk-work', ''),
      ('flow-work', 'sdk-existing', '${EXISTING_SESSION}');
    INSERT INTO workspace_runtime_sessions (
      group_folder, runtime_agent_id, workspace_jid, sdk_session_id, created_at, updated_at
    ) VALUES ('main', '', '${HOME}', 'sdk-home', '${T(0)}', '${T(0)}');
    INSERT INTO session_model_selections (group_folder, agent_id, model_config_id, updated_at)
      VALUES ('main', '', 'cfg-1', '${T(0)}');
    INSERT INTO session_history_reinjections (group_folder, agent_id, created_at)
      VALUES ('main', '', '${T(0)}');
    INSERT INTO usage_limit_waits (
      scope_key, input_key, wait_count, reset_at, resume_at, created_at, updated_at
    ) VALUES ('${HOME}', 'home-2', 1, '${T(40)}', '${T(41)}', '${T(0)}', '${T(0)}');
    INSERT INTO subagent_checkpoints (
      task_id, group_folder, chat_jid, input_message_id, created_at, updated_at
    ) VALUES ('task-1', 'main', '${HOME}', 'home-2', '${T(0)}', '${T(0)}');
    INSERT INTO turn_traces (chat_jid, turn_id, created_at)
      VALUES ('${HOME}', 'turn-1', '${T(0)}'), ('${DM}', 'turn-dm', '${T(0)}');
    INSERT INTO web_message_dedup (
      user_id, chat_jid, client_message_id, fingerprint, response_json, created_at
    ) VALUES
      ('u1', '${HOME}', 'client-1', 'f', '{"messageId":"home-2"}', '${recent}'),
      ('u1', '${WORK}', 'client-2', 'f', '{"messageId":"existing-1"}', '${recent}'),
      ('u1', '${WORK}', 'client-3', 'f', 'not json', '${recent}');
    INSERT INTO usage_records (id, user_id, group_folder, agent_id, created_at)
      VALUES ('usage-main', 'u1', 'main', NULL, '${T(0)}'),
             ('usage-other', 'u1', 'main', 'spawn-1', '${T(0)}');
    INSERT INTO usage_events (event_id, user_id, group_folder, agent_id, created_at)
      VALUES ('event-main', 'u1', 'main', NULL, '${T(0)}');
    INSERT INTO turn_runs (
      id, idempotency_key, provider, account_id, source_jid, correlation_id,
      status, available_at, created_at, updated_at
    ) VALUES
      ('turn-group', 'k1', 'feishu', 'acct', '${BOUND_GROUP}', 'group-1',
       'completed', '${T(0)}', '${T(0)}', '${T(0)}'),
      ('turn-unknown', 'k2', 'feishu', 'acct', '${BOUND_GROUP}', 'gone',
       'completed', '${T(0)}', '${T(0)}', '${T(0)}');
    INSERT INTO automations (
      id, workspace_jid, workspace_folder, created_by, name, schedule_kind,
      session_mode, target_session_jid, created_at, updated_at
    ) VALUES
      ('auto-main', '${HOME}', 'main', 'u1', 'Daily', 'cron', 'bound', '${HOME}', '${T(0)}', '${T(0)}'),
      ('auto-session', '${WORK}', 'flow-work', 'u1', 'Other', 'cron', 'bound',
       '${WORK}#agent:${EXISTING_SESSION}', '${T(0)}', '${T(0)}');
    INSERT INTO automation_runs (id, automation_id, trigger, status, session_jid, scheduled_for, created_at)
      VALUES ('run-1', 'auto-main', 'schedule', 'succeeded', '${HOME}', '${T(0)}', '${T(0)}');
  `);
  routerState(conn, 'channel_session_owner:main:main', BOUND_GROUP);
  routerState(
    conn,
    `channel_session_owner:flow-work:${EXISTING_SESSION}`,
    WORK_DM,
  );
  routerState(conn, `conversation_history_isolation:${HOME}`, T(15));
}

describe('v88 legacy main session migration', () => {
  test('turns each main session into a legacy_main session with its state', () => {
    buildV87(seedRich);
    const report = db.initDatabase().legacyMainSessions!;

    inspect((conn) => {
      const homeId = mappedSession(conn, HOME)!;
      const workId = mappedSession(conn, WORK)!;
      expect(homeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(workId).toMatch(/^[0-9a-f-]{36}$/);
      expect(mappedSession(conn, EMPTY)).toBeUndefined();
      const homeJid = `${HOME}#agent:${homeId}`;
      const workJid = `${WORK}#agent:${workId}`;

      const home = conn
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(homeId);
      expect(home).toMatchObject({
        kind: 'conversation',
        source_kind: 'legacy_main',
        title_source: 'auto',
        status: 'idle',
        chat_jid: HOME,
        group_folder: 'main',
        created_by: 'u1',
        prompt: '',
        // The command is skipped; markdown is stripped.
        name: '帮我写一个周报模板',
        created_at: T(1),
        last_active_at: T(21),
      });
      expect(
        conn.prepare('SELECT name FROM agents WHERE id = ?').get(workId),
      ).toEqual({ name: 'text of work-1' });
      expect(
        conn
          .prepare(
            "SELECT COUNT(*) AS n FROM agents WHERE source_kind = 'legacy_main'",
          )
          .get(),
      ).toEqual({ n: 2 });
      expect(
        conn.prepare('SELECT name FROM chats WHERE jid = ?').get(homeJid),
      ).toEqual({ name: '帮我写一个周报模板' });

      // Home merges its owner's unbound DM and the group bound to it, in
      // provider time; the duplicate id keeps the workspace copy.
      expect(messageIds(conn, homeJid)).toEqual([
        'home-1',
        'home-2',
        'dm-1',
        'group-1',
        'home-3',
        'dup-1',
        'dm-2',
      ]);
      const dup = conn
        .prepare(
          'SELECT source_jid, history_recovery_allowed FROM messages WHERE id = ?',
        )
        .all('dup-1');
      expect(dup).toEqual([{ source_jid: DM, history_recovery_allowed: 1 }]);
      // IM rows keep their origin and stay out of model-history replay.
      expect(
        conn
          .prepare(
            'SELECT source_jid, history_recovery_allowed FROM messages WHERE id = ?',
          )
          .get('dm-2'),
      ).toEqual({ source_jid: DM, history_recovery_allowed: 0 });
      // Nothing stays at the old addresses: rows, sequences, cursors.
      for (const jid of [HOME, DM, BOUND_GROUP, WORK]) {
        for (const table of [
          'messages',
          'message_ingest_sequences',
          'router_cursors',
        ]) {
          expect(
            conn
              .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chat_jid = ?`)
              .get(jid),
          ).toEqual({ n: 0 });
        }
      }
      // Not merged: another owner's DM, a non-Home workspace's DM, orphans.
      expect(messageIds(conn, OTHER_OWNER_DM)).toEqual(['other-1']);
      expect(messageIds(conn, WORK_DM)).toEqual(['work-dm-1']);
      expect(messageIds(conn, ORPHAN)).toEqual(['orphan-1']);
      expect(messageIds(conn, workJid)).toEqual(['work-1', 'work-2', 'work-3']);
      expect(messageIds(conn, `${WORK}#agent:${EXISTING_SESSION}`)).toEqual([
        'existing-1',
      ]);

      // Caught up: both cursors after the last merged message.
      const homeLast = {
        timestamp: T(21),
        id: 'dm-2',
        sequence: sequenceOf(conn, homeJid, 'dm-2'),
      };
      expect(cursorOf(conn, 'committed', homeJid)).toEqual(homeLast);
      expect(cursorOf(conn, 'next_pull', homeJid)).toEqual(homeLast);
      // Pending: just before the earliest unprocessed input.
      const beforePending = {
        timestamp: T(30),
        id: 'work-1',
        sequence: sequenceOf(conn, workJid, 'work-1'),
      };
      expect(cursorOf(conn, 'committed', workJid)).toEqual(beforePending);
      expect(cursorOf(conn, 'next_pull', workJid)).toEqual(beforePending);

      // Bindings: the group bound to main now names the session; topic
      // groups keep their workspace binding.
      const binding = (jid: string) =>
        conn
          .prepare(
            'SELECT target_agent_id, target_main_jid, binding_mode FROM registered_groups WHERE jid = ?',
          )
          .get(jid);
      expect(binding(BOUND_GROUP)).toEqual({
        target_agent_id: homeId,
        target_main_jid: null,
        binding_mode: 'single_context',
      });
      expect(binding(WORK_GROUP)).toMatchObject({
        target_agent_id: workId,
        target_main_jid: null,
      });
      expect(binding(TOPIC_GROUP)).toEqual({
        target_agent_id: null,
        target_main_jid: HOME,
        binding_mode: 'thread_map',
      });
      for (const table of ['channel_mounts', 'agent_channel_mounts']) {
        const mount = (jid: string) =>
          conn
            .prepare(
              `SELECT workspace_jid, session_id, routing_mode FROM ${table} WHERE channel_jid = ?`,
            )
            .get(jid);
        expect(mount(BOUND_GROUP)).toEqual({
          workspace_jid: HOME,
          session_id: homeId,
          routing_mode: 'single_session',
        });
        expect(mount(TOPIC_GROUP)).toEqual({
          workspace_jid: HOME,
          session_id: null,
          routing_mode: 'thread_map',
        });
      }

      expect(
        conn
          .prepare('SELECT id, target_session_jid FROM automations ORDER BY id')
          .all(),
      ).toEqual([
        { id: 'auto-main', target_session_jid: homeJid },
        {
          id: 'auto-session',
          target_session_jid: `${WORK}#agent:${EXISTING_SESSION}`,
        },
      ]);
      expect(
        conn.prepare('SELECT session_jid FROM automation_runs').get(),
      ).toEqual({ session_jid: homeJid });

      expect(
        conn
          .prepare(
            'SELECT group_folder, agent_id, session_id FROM sessions ORDER BY group_folder, session_id',
          )
          .all(),
      ).toEqual([
        {
          group_folder: 'flow-work',
          agent_id: EXISTING_SESSION,
          session_id: 'sdk-existing',
        },
        { group_folder: 'flow-work', agent_id: workId, session_id: 'sdk-work' },
        { group_folder: 'main', agent_id: homeId, session_id: 'sdk-home' },
      ]);
      expect(
        conn
          .prepare(
            "SELECT runtime_agent_id, sdk_session_id FROM workspace_runtime_sessions WHERE group_folder = 'main'",
          )
          .all(),
      ).toEqual([{ runtime_agent_id: homeId, sdk_session_id: 'sdk-home' }]);
      expect(
        conn
          .prepare(
            'SELECT agent_id, model_config_id FROM session_model_selections',
          )
          .all(),
      ).toEqual([{ agent_id: homeId, model_config_id: 'cfg-1' }]);
      expect(
        conn.prepare('SELECT agent_id FROM session_history_reinjections').all(),
      ).toEqual([{ agent_id: homeId }]);

      expect(
        conn.prepare('SELECT scope_key FROM usage_limit_waits').all(),
      ).toEqual([{ scope_key: homeJid }]);
      expect(
        conn
          .prepare('SELECT chat_jid, group_folder FROM subagent_checkpoints')
          .all(),
      ).toEqual([{ chat_jid: homeJid, group_folder: 'main' }]);
      expect(
        conn
          .prepare('SELECT chat_jid, turn_id FROM turn_traces ORDER BY turn_id')
          .all(),
      ).toEqual([
        { chat_jid: homeJid, turn_id: 'turn-1' },
        { chat_jid: homeJid, turn_id: 'turn-dm' },
      ]);
      expect(
        conn
          .prepare(
            'SELECT client_message_id, chat_jid FROM web_message_dedup ORDER BY client_message_id',
          )
          .all(),
      ).toEqual([
        { client_message_id: 'client-1', chat_jid: homeJid },
        { client_message_id: 'client-2', chat_jid: WORK },
        { client_message_id: 'client-3', chat_jid: WORK },
      ]);
      expect(
        conn
          .prepare('SELECT id, agent_id FROM usage_records ORDER BY id')
          .all(),
      ).toEqual([
        { id: 'usage-main', agent_id: homeId },
        { id: 'usage-other', agent_id: 'spawn-1' },
      ]);
      expect(conn.prepare('SELECT agent_id FROM usage_events').get()).toEqual({
        agent_id: homeId,
      });
      expect(
        conn.prepare('SELECT id, agent_id FROM turn_runs ORDER BY id').all(),
      ).toEqual([
        { id: 'turn-group', agent_id: homeId },
        { id: 'turn-unknown', agent_id: null },
      ]);
      expect(
        conn
          .prepare("SELECT spawned_from_jid FROM agents WHERE id = 'spawn-1'")
          .get(),
      ).toEqual({ spawned_from_jid: homeJid });

      const state = (key: string) =>
        (
          conn
            .prepare('SELECT value FROM router_state WHERE key = ?')
            .get(key) as { value: string } | undefined
        )?.value;
      expect(state('channel_session_owner:main:main')).toBeUndefined();
      expect(state(`channel_session_owner:main:${homeId}`)).toBe(BOUND_GROUP);
      expect(state(`channel_session_owner:flow-work:${EXISTING_SESSION}`)).toBe(
        WORK_DM,
      );
      expect(state(`conversation_history_isolation:${HOME}`)).toBeUndefined();
      expect(state(`conversation_history_isolation:${homeJid}`)).toBe(T(15));
      expect(state('schema_version')).toBe('88');
    });

    expect(report.skippedWorkspaces).toEqual([EMPTY]);
    expect(report.duplicatesRemoved).toBe(1);
    expect(report.pendingMessageIds).toEqual(['work-2']);
    const homeReport = report.workspaces.find((w) => w.workspaceJid === HOME)!;
    expect(
      homeReport.sources.map(
        ({ chatJid, kind, messages, moved, duplicates }) => ({
          chatJid,
          kind,
          messages,
          moved,
          duplicates,
        }),
      ),
    ).toEqual([
      {
        chatJid: HOME,
        kind: 'workspace',
        messages: 4,
        moved: 4,
        duplicates: 0,
      },
      {
        chatJid: BOUND_GROUP,
        kind: 'home_im',
        messages: 1,
        moved: 1,
        duplicates: 0,
      },
      { chatJid: DM, kind: 'home_im', messages: 3, moved: 2, duplicates: 1 },
    ]);
    expect(homeReport.cursor.state).toBe('caught_up');
    expect(
      report.workspaces.find((w) => w.workspaceJid === WORK)!.cursor.state,
    ).toBe('pending');

    const checks = inspect((conn) =>
      migration.checkLegacyMainSessionInvariants(conn, {
        expectedSchemaVersion: db.CURRENT_SCHEMA_VERSION,
        messagesBefore: 15,
        report,
      }),
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      'I1_no_workspace_jid_messages',
      'I2_bindings_target_sessions',
      'I3_no_empty_agent_rows',
      'I4_bound_automations_target_sessions',
      'I5_no_main_channel_owner_keys',
      'I6_legacy_main_session_rows',
      'I7_mapping_keys',
      'message_count_preserved',
      'session_sequences_monotonic',
      'schema_version',
    ]);
  });

  test('a restart or a forced re-run creates and moves nothing again', () => {
    buildV87(seedRich);
    db.initDatabase();
    db.closeDatabase();
    const snapshot = () =>
      inspect((conn) => ({
        agents: conn.prepare('SELECT * FROM agents ORDER BY id').all(),
        messages: conn
          .prepare('SELECT * FROM messages ORDER BY chat_jid, id')
          .all(),
        sequences: conn
          .prepare('SELECT * FROM message_ingest_sequences ORDER BY sequence')
          .all(),
        cursors: conn
          .prepare('SELECT * FROM router_cursors ORDER BY kind, chat_jid')
          .all(),
        groups: conn
          .prepare('SELECT * FROM registered_groups ORDER BY jid')
          .all(),
        sessions: conn
          .prepare('SELECT * FROM sessions ORDER BY group_folder, agent_id')
          .all(),
        state: conn
          .prepare(
            "SELECT * FROM router_state WHERE key NOT IN ('schema_version', 'foreign_key_check_clean_at') ORDER BY key",
          )
          .all(),
      }));
    const first = snapshot();

    expect(db.initDatabase().legacyMainSessions).toBeNull();
    db.closeDatabase();
    expect(snapshot()).toEqual(first);

    const conn = new Database(databasePath);
    conn
      .prepare(
        "UPDATE router_state SET value = '87' WHERE key = 'schema_version'",
      )
      .run();
    conn.close();
    const rerun = db.initDatabase().legacyMainSessions!;
    expect(rerun.workspaces).toEqual([]);
    expect(rerun.skippedWorkspaces).toEqual([HOME, WORK, EMPTY]);
    db.closeDatabase();
    expect(snapshot()).toEqual(first);
  });

  test('workspaces without main state get no session; a binding alone creates one', () => {
    buildV87((conn) => {
      group(conn, HOME, { folder: 'main', isHome: true });
      group(conn, WORK, { folder: 'flow-work', name: 'Work' });
      group(conn, BOUND_GROUP, { folder: 'main', targetMainJid: WORK });
      // A thread_map binding alone is not main-session state.
      group(conn, TOPIC_GROUP, {
        folder: 'main',
        targetMainJid: HOME,
        bindingMode: 'thread_map',
      });
      message(conn, ORPHAN, 'orphan-1', T(1));
      conn
        .prepare(
          "INSERT INTO sessions (group_folder, session_id, agent_id) VALUES ('flow-gone', 'sdk', '')",
        )
        .run();
    });
    db.initDatabase();
    inspect((conn) => {
      expect(mappedSession(conn, HOME)).toBeUndefined();
      const workId = mappedSession(conn, WORK)!;
      expect(
        conn
          .prepare(
            'SELECT name, created_at, last_active_at FROM agents WHERE id = ?',
          )
          .get(workId),
      ).toEqual({
        name: 'Work',
        created_at: T(0),
        last_active_at: null,
      });
      expect(
        cursorOf(conn, 'committed', `${WORK}#agent:${workId}`),
      ).toBeUndefined();
      expect(messageIds(conn, ORPHAN)).toEqual(['orphan-1']);
      // Orphan folders keep their rows; they are not active workspaces.
      expect(
        conn
          .prepare(
            "SELECT agent_id FROM sessions WHERE group_folder = 'flow-gone'",
          )
          .get(),
      ).toEqual({ agent_id: '' });
    });
  });

  test('stale and redundant main targets are cleared, non-workspace targets reported', () => {
    buildV87((conn) => {
      group(conn, WORK, { folder: 'flow-work' });
      conn
        .prepare(
          `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_at)
           VALUES ('s1', 'flow-work', ?, 'S', '', 'idle', 'conversation', ?)`,
        )
        .run(WORK, T(0));
      group(conn, 'feishu:oc_stale', {
        folder: 'x',
        targetMainJid: 'web:gone',
      });
      group(conn, 'feishu:oc_both', {
        folder: 'flow-work',
        targetMainJid: WORK,
        targetAgentId: 's1',
      });
      group(conn, 'feishu:oc_weird', {
        folder: 'x',
        targetMainJid: 'feishu:oc_stale',
      });
      // Legacy web:<folder> targets fold onto the folder's workspace.
      group(conn, 'feishu:oc_folded', {
        folder: 'x',
        targetMainJid: 'web:flow-work',
      });
    });
    const report = db.initDatabase().legacyMainSessions!;
    expect(report.staleBindingsCleared).toEqual([
      { channelJid: 'feishu:oc_stale', previousTarget: 'web:gone' },
    ]);
    expect(report.redundantMainTargetsCleared).toEqual([
      { channelJid: 'feishu:oc_both', previousTarget: WORK },
    ]);
    expect(report.unresolvedBindings).toEqual([
      { channelJid: 'feishu:oc_weird', previousTarget: 'feishu:oc_stale' },
    ]);
    inspect((conn) => {
      const workId = mappedSession(conn, WORK)!;
      const rows = conn
        .prepare(
          'SELECT jid, target_agent_id, target_main_jid FROM registered_groups WHERE jid LIKE ? ORDER BY jid',
        )
        .all('feishu:%');
      expect(rows).toEqual([
        { jid: 'feishu:oc_both', target_agent_id: 's1', target_main_jid: null },
        {
          jid: 'feishu:oc_folded',
          target_agent_id: workId,
          target_main_jid: null,
        },
        {
          jid: 'feishu:oc_stale',
          target_agent_id: null,
          target_main_jid: null,
        },
        {
          jid: 'feishu:oc_weird',
          target_agent_id: null,
          target_main_jid: 'feishu:oc_stale',
        },
      ]);
      const checks = migration.checkLegacyMainSessionInvariants(conn, {
        expectedSchemaVersion: db.CURRENT_SCHEMA_VERSION,
      });
      const bindingCheck = checks.find(
        (c) => c.id === 'I2_bindings_target_sessions',
      )!;
      expect(bindingCheck.ok).toBe(false);
      expect(bindingCheck.violations).toContainEqual(
        expect.objectContaining({ jid: 'feishu:oc_weird' }),
      );
    });
  });

  test('cursor fallback without a committed cursor: next-pull only replays, neither uses the poller position', () => {
    buildV87((conn) => {
      group(conn, HOME, { folder: 'main', isHome: true });
      group(conn, WORK, { folder: 'flow-work', addedAt: T(1) });
      message(conn, HOME, 'h-1', T(1));
      message(conn, HOME, 'h-2', T(2));
      cursor(conn, 'next_pull', HOME, { timestamp: T(2), id: 'h-2' });
      message(conn, WORK, 'w-1', T(3));
      const seen = message(conn, WORK, 'w-2', T(4));
      message(conn, WORK, 'w-3', T(5));
      message(conn, WORK, 'w-4', T(6), { fromMe: true });
      // Queued inputs are pending whatever the cursor says.
      message(conn, WORK, 'w-5', T(7), { deliveryStatus: 'queued' });
      routerState(conn, 'last_ingest_sequence', String(seen));
    });
    const report = db.initDatabase().legacyMainSessions!;
    const home = report.workspaces.find((w) => w.workspaceJid === HOME)!;
    expect(home.sources[0]).toMatchObject({
      processedThroughFrom: 'next_pull_only',
      processedThrough: 0,
    });
    expect(home.cursor).toEqual({
      state: 'pending',
      value: { timestamp: '', id: '', sequence: 0 },
      pendingMessageIds: ['h-1', 'h-2'],
    });
    const work = report.workspaces.find((w) => w.workspaceJid === WORK)!;
    expect(work.sources[0].processedThroughFrom).toBe('global');
    expect(work.cursor.pendingMessageIds).toEqual(['w-3', 'w-5']);
    inspect((conn) => {
      const workJid = `${WORK}#agent:${work.sessionId}`;
      expect(cursorOf(conn, 'committed', workJid)).toEqual({
        timestamp: T(4),
        id: 'w-2',
        sequence: sequenceOf(conn, workJid, 'w-2'),
      });
      expect(
        cursorOf(conn, 'committed', `${HOME}#agent:${home.sessionId}`),
      ).toEqual({
        timestamp: '',
        id: '',
        sequence: 0,
      });
    });
  });

  test('moves the folder .claude under the session once, and leaves a conflict alone', () => {
    const sessionsRoot = path.join(root, 'sessions');
    const seed = (conn: Conn) => {
      group(conn, HOME, { folder: 'main', isHome: true });
      message(conn, HOME, 'h-1', T(1));
      // A second workspace on the same folder does not own its rows.
      group(conn, 'web:main-twin', { folder: 'main', addedAt: T(5) });
      message(conn, 'web:main-twin', 't-1', T(2));
    };
    buildV87(seed);
    const legacyDir = path.join(sessionsRoot, 'main', '.claude');
    fs.mkdirSync(path.join(legacyDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'projects', 'resume.jsonl'), 'sdk');
    const report = db.initDatabase().legacyMainSessions!;
    const homeId = inspect((conn) => mappedSession(conn, HOME)!);
    const target = path.join(sessionsRoot, 'main', 'agents', homeId, '.claude');
    expect(
      fs.readFileSync(path.join(target, 'projects', 'resume.jsonl'), 'utf8'),
    ).toBe('sdk');
    expect(fs.existsSync(legacyDir)).toBe(false);
    const twinReport = report.workspaces.find(
      (w) => w.workspaceJid === 'web:main-twin',
    )!;
    expect(twinReport.ownsFolderState).toBe(false);
    db.closeDatabase();

    const plan = () =>
      inspect((conn) =>
        migration.relocateLegacyMainSessionDirectories(conn, { dryRun: true }),
      ).map((move) => move.status);
    expect(plan()).toEqual(['already_moved']);
    db.initDatabase();
    db.closeDatabase();
    expect(plan()).toEqual(['already_moved']);

    // Both locations present: neither is touched.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'stray'), 'x');
    db.initDatabase();
    db.closeDatabase();
    expect(fs.existsSync(path.join(legacyDir, 'stray'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'projects', 'resume.jsonl'))).toBe(
      true,
    );
    expect(plan()).toEqual(['conflict']);
    expect(
      inspect((conn) =>
        migration.relocateLegacyMainSessionDirectories(conn, {
          inspect: false,
        }),
      ).map((move) => move.status),
    ).toEqual(['not_inspected']);
  });

  test('a directory move interrupted by a crash finishes at the next start', () => {
    buildV87((conn) => {
      group(conn, HOME, { folder: 'main', isHome: true });
      message(conn, HOME, 'h-1', T(1));
    });
    db.initDatabase({ relocateLegacySessionDirectories: false });
    db.closeDatabase();
    const legacyDir = path.join(root, 'sessions', 'main', '.claude');
    fs.mkdirSync(legacyDir, { recursive: true });
    const homeId = inspect((conn) => mappedSession(conn, HOME)!);
    // A maintenance bootstrap leaves the filesystem alone.
    db.initDatabase({ requireCurrentSchema: true });
    db.closeDatabase();
    expect(fs.existsSync(legacyDir)).toBe(true);
    db.initDatabase();
    expect(
      fs.existsSync(
        path.join(root, 'sessions', 'main', 'agents', homeId, '.claude'),
      ),
    ).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  test('the invariant checks fail on main-session state left behind', () => {
    buildV87(seedRich);
    const report = db.initDatabase().legacyMainSessions!;
    db.closeDatabase();
    const conn = new Database(databasePath);
    const homeId = mappedSession(conn, HOME)!;
    conn.exec(`
      INSERT INTO messages (id, chat_jid, content, timestamp, is_from_me)
        VALUES ('late', '${HOME}', 'x', '${T(50)}', 0);
      UPDATE registered_groups SET target_main_jid = '${HOME}' WHERE jid = '${DM}';
      INSERT INTO channel_mounts (channel_jid, channel_type, workspace_jid, created_at, updated_at)
        VALUES ('${OTHER_OWNER_DM}', 'feishu', '${HOME}', '${T(0)}', '${T(0)}');
      INSERT INTO sessions (group_folder, session_id, agent_id) VALUES ('main', 'again', '');
      UPDATE automations SET target_session_jid = '${HOME}' WHERE id = 'auto-main';
      UPDATE automations SET status = 'active', target_session_jid = '${WORK}#agent:deleted'
        WHERE id = 'auto-session';
      INSERT INTO router_state (key, value) VALUES ('channel_session_owner:main:main', 'x');
      UPDATE agents SET title_source = 'manual' WHERE id = '${homeId}';
      INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_at, source_kind)
        VALUES ('unmapped', 'main', '${HOME}', 'U', '', 'idle', 'conversation', '${T(0)}', 'legacy_main');
      UPDATE messages SET timestamp = '${T(0)}'
        WHERE id = 'dm-2';
      UPDATE router_state SET value = '87' WHERE key = 'schema_version';
    `);
    const checks = migration.checkLegacyMainSessionInvariants(conn, {
      expectedSchemaVersion: db.CURRENT_SCHEMA_VERSION,
      messagesBefore: 15,
      report,
    });
    conn.close();
    expect(checks.filter((c) => c.ok).map((c) => c.id)).toEqual([]);
  });

  test('the report script migrates a copy and exits non-zero on a failed check', () => {
    const tsxCli = path.join(
      repositoryRoot,
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    const scriptPath = path.join(
      repositoryRoot,
      'scripts',
      'legacy-main-session-report.ts',
    );
    const runOn = (seed: (conn: Conn) => void, name: string) => {
      buildV87(seed);
      const checkout = path.join(root, name);
      fs.mkdirSync(path.join(checkout, 'data', 'db'), { recursive: true });
      for (const suffix of ['', '-wal']) {
        if (fs.existsSync(databasePath + suffix)) {
          fs.copyFileSync(
            databasePath + suffix,
            path.join(checkout, 'data', 'db', `messages.db${suffix}`),
          );
        }
      }
      fs.mkdirSync(path.join(checkout, 'data', 'sessions', 'main', '.claude'), {
        recursive: true,
      });
      const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          HAPPYCLAW_MIGRATION_BACKUP_DIR: path.join(root, 'nope'),
        },
      });
      return { result, checkout };
    };

    const good = runOn(seedRich, 'checkout-good');
    expect(good.result.status, good.result.stderr).toBe(0);
    const output = JSON.parse(good.result.stdout);
    expect(output).toMatchObject({
      ok: true,
      schemaVersionBefore: '87',
      migrated: true,
      messagesBefore: 15,
      messagesAfter: 14,
      summary: {
        sessionsCreated: 2,
        messagesMoved: 10,
        duplicatesRemoved: 1,
        bindingsRebound: 2,
        automationsRetargeted: 1,
        pendingInputs: 1,
      },
      pendingMessageIds: ['work-2'],
      directories: expect.arrayContaining([
        expect.objectContaining({ workspaceJid: HOME, status: 'would_move' }),
      ]),
    });
    // Planned only: the session directory stays where it was.
    expect(
      fs.existsSync(
        path.join(good.checkout, 'data', 'sessions', 'main', '.claude'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);

    const bad = runOn((conn) => {
      seedRich(conn);
      group(conn, 'feishu:oc_weird', { folder: 'x', targetMainJid: DM });
    }, 'checkout-bad');
    expect(bad.result.status).toBe(1);
    const failed = JSON.parse(bad.result.stdout);
    expect(failed.ok).toBe(false);
    expect(
      failed.checks
        .filter((c: { ok: boolean }) => !c.ok)
        .map((c: { id: string }) => c.id),
    ).toEqual(['I2_bindings_target_sessions']);
  }, 60_000);
});
