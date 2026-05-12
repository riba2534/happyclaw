import crypto from 'crypto';
import Database from './sqlite-compat.js';
import fs from 'fs';
import path from 'path';

import { STORE_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AgentKind,
  AgentStatus,
  AuthAuditLog,
  AuthEventType,
  BalanceOperatorType,
  BalanceReferenceType,
  BalanceTransaction,
  BalanceTransactionSource,
  BalanceTransactionType,
  BillingAuditEventType,
  BillingAuditLog,
  BillingPlan,
  DailyUsage,
  ExecutionMode,
  GroupMember,
  InviteCode,
  InviteCodeWithCreator,
  MessageFinalizationReason,
  MonthlyUsage,
  NewMessage,
  MessageCursor,
  MessageSourceKind,
  ImContextBinding,
  RedeemCode,
  RegisteredGroup,
  ScheduledTask,
  SubAgent,
  TaskRunLog,
  User,
  UserBalance,
  UserPublic,
  UserStatus,
  UserRole,
  UserSubscription,
  UserSession,
  UserSessionWithUser,
  Permission,
  PermissionTemplateKey,
} from './types.js';
import { getDefaultPermissions, normalizePermissions } from './permissions.js';

let db: InstanceType<typeof Database>;

// Prepared statement cache — lazy-initialized on first use after initDatabase()
let _stmts: {
  storeMessageSelect: any;
  storeMessageInsert: any;
  insertUsageInsert: any;
  insertUsageUpsert: any;
  getSessionWithUser: any;
  deleteSession: any;
  updateSessionLastActive: any;
  updateTokenUsageById: any;
  updateTokenUsageLatest: any;
  getMessagesSince: any;
  getExpiredSessionIds: any;
} | null = null;

const _newMsgStmtCache = new Map<number, any>();

function stmts() {
  if (!_stmts) {
    _stmts = {
      storeMessageSelect: db.prepare(
        `SELECT id FROM messages
         WHERE chat_jid = ? AND turn_id = ? AND source_kind = 'sdk_final'
         ORDER BY timestamp DESC LIMIT 1`,
      ),
      storeMessageInsert: db.prepare(
        `INSERT OR REPLACE INTO messages (
          id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me,
          attachments, token_usage, turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageInsert: db.prepare(
        `INSERT INTO usage_records (id, user_id, group_folder, agent_id, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageUpsert: db.prepare(
        `INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(user_id, model, date) DO UPDATE SET
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_cost_usd = total_cost_usd + excluded.total_cost_usd,
          request_count = request_count + 1,
          updated_at = datetime('now')`,
      ),
      getSessionWithUser: db.prepare(
        `SELECT s.*, u.username, u.role, u.status, u.display_name, u.permissions, u.must_change_password
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`,
      ),
      deleteSession: db.prepare('DELETE FROM user_sessions WHERE id = ?'),
      updateSessionLastActive: db.prepare(
        'UPDATE user_sessions SET last_active_at = ? WHERE id = ?',
      ),
      updateTokenUsageById: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ? WHERE id = ? AND chat_jid = ?`,
      ),
      updateTokenUsageLatest: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ?
         WHERE rowid = (
           SELECT rowid FROM messages
           WHERE chat_jid = ? AND is_from_me = 1 AND token_usage IS NULL
             AND COALESCE(source_kind, 'legacy') != 'sdk_send_message'
           ORDER BY timestamp DESC LIMIT 1
         )`,
      ),
      getMessagesSince: db.prepare(
        `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, task_id
         FROM messages
         WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND is_from_me = 0
         ORDER BY timestamp ASC, id ASC`,
      ),
      getExpiredSessionIds: db.prepare(
        'SELECT id FROM user_sessions WHERE expires_at < ?',
      ),
    };
  }
  return _stmts;
}

function getNewMessagesStmt(jidCount: number): any {
  let s = _newMsgStmtCache.get(jidCount);
  if (!s) {
    const placeholders = Array(jidCount).fill('?').join(',');
    s = db.prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, task_id
       FROM messages
       WHERE (timestamp > ? OR (timestamp = ? AND id > ?))
         AND chat_jid IN (${placeholders})
         AND is_from_me = 0
         AND COALESCE(source_kind, '') NOT IN ('user_command', 'scheduled_task_prompt')
       ORDER BY timestamp ASC, id ASC`,
    );
    _newMsgStmtCache.set(jidCount, s);
  }
  return s;
}

interface StoredMessageMeta {
  turnId?: string | null;
  sessionId?: string | null;
  sdkMessageUuid?: string | null;
  sourceKind?: MessageSourceKind | null;
  finalizationReason?: MessageFinalizationReason | null;
  taskId?: string | null;
}

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(
  tableName: string,
  columnName: string,
  sqlTypeWithDefault: string,
): void {
  if (hasColumn(tableName, columnName)) return;
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeWithDefault}`,
  );
}

function assertSchema(
  tableName: string,
  requiredColumns: string[],
  forbiddenColumns: string[] = [],
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  const missing = requiredColumns.filter((c) => !names.has(c));
  const forbidden = forbiddenColumns.filter((c) => names.has(c));

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `Incompatible DB schema in table "${tableName}". Missing: [${missing.join(', ')}], forbidden: [${forbidden.join(', ')}]. ` +
        'Please remove data/db/messages.db (or legacy store/messages.db) and restart.',
    );
  }
}

/** Internal helper — reads router_state before initDatabase exports are available. */
function getRouterStateInternal(key: string): string | undefined {
  try {
    const row = db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Table may not exist yet on first run
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrency and performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
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
      notify_channels TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      root_message_id TEXT,
      title TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_icb_agent ON im_context_bindings(agent_id);
  `);

  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permission_template TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invite_codes(created_at);
  `);

  // Group members table for shared workspaces
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_folder, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  `);

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // Sub-agents table for multi-agent parallel execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT,
      source_kind TEXT,
      thread_id TEXT,
      root_message_id TEXT,
      title_source TEXT,
      last_active_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_group ON agents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_agents_jid ON agents(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Billing tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_cost_quota REAL,
      weekly_cost_quota REAL,
      daily_token_quota INTEGER,
      weekly_token_quota INTEGER,
      rate_multiplier REAL NOT NULL DEFAULT 1.0,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_sub_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sub_status ON user_subscriptions(status);

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_deposited_usd REAL NOT NULL DEFAULT 0,
      total_consumed_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_type TEXT,
      reference_id TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'system_adjustment',
      operator_type TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bal_tx_user ON balance_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bal_tx_created ON balance_transactions(created_at);

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_code_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_usage_user ON redeem_code_usage(user_id);

    CREATE TABLE IF NOT EXISTS billing_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bill_audit_user ON billing_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_bill_audit_created ON billing_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
  `);

  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_user_date ON usage_daily_summary(user_id, date);

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      monthly_cost_limit_usd REAL NOT NULL DEFAULT -1,
      monthly_token_limit INTEGER NOT NULL DEFAULT -1,
      daily_cost_limit_usd REAL NOT NULL DEFAULT -1,
      daily_request_limit INTEGER NOT NULL DEFAULT -1,
      billing_cycle_start TEXT,
      subscription_tier TEXT,
      subscription_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('invite_codes', 'permission_template', 'TEXT');
  ensureColumn('invite_codes', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn(
    'registered_groups',
    'execution_mode',
    "TEXT DEFAULT 'container'",
  );
  ensureColumn('registered_groups', 'custom_cwd', 'TEXT');
  ensureColumn('registered_groups', 'init_source_path', 'TEXT');
  ensureColumn('registered_groups', 'init_git_url', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('registered_groups', 'created_by', 'TEXT');
  ensureColumn('registered_groups', 'is_home', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_mode', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_jid', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_folder', 'TEXT');
  ensureColumn('registered_groups', 'selected_skills', 'TEXT');
  ensureColumn('sessions', 'agent_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agents', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn('registered_groups', 'target_agent_id', 'TEXT');
  ensureColumn('registered_groups', 'target_main_jid', 'TEXT');
  ensureColumn(
    'registered_groups',
    'reply_policy',
    "TEXT DEFAULT 'source_only'",
  );
  ensureColumn('registered_groups', 'require_mention', 'INTEGER DEFAULT 0');
  ensureColumn('registered_groups', 'mcp_mode', "TEXT DEFAULT 'inherit'");
  ensureColumn('registered_groups', 'selected_mcps', 'TEXT');
  ensureColumn('registered_groups', 'activation_mode', "TEXT DEFAULT 'auto'");
  ensureColumn('registered_groups', 'owner_im_id', 'TEXT');
  ensureColumn(
    'registered_groups',
    'conversation_source',
    "TEXT DEFAULT 'manual'",
  );
  ensureColumn(
    'registered_groups',
    'conversation_nav_mode',
    "TEXT DEFAULT 'horizontal'",
  );
  ensureColumn(
    'registered_groups',
    'binding_mode',
    "TEXT DEFAULT 'single_context'",
  );
  ensureColumn('registered_groups', 'feishu_chat_mode', 'TEXT');
  ensureColumn('registered_groups', 'feishu_group_message_type', 'TEXT');
  ensureColumn('registered_groups', 'sender_allowlist', 'TEXT');
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'sdk_message_uuid', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');
  ensureColumn('messages', 'task_id', 'TEXT');
  ensureColumn('agents', 'source_kind', 'TEXT');
  ensureColumn('agents', 'thread_id', 'TEXT');
  ensureColumn('agents', 'root_message_id', 'TEXT');
  ensureColumn('agents', 'title_source', 'TEXT');
  ensureColumn('agents', 'last_active_at', 'TEXT');

  // Add index on target_agent_id for fast lookup of IM bindings
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_agent ON registered_groups(target_agent_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_main ON registered_groups(target_main_jid)',
  );

  // Migration: remove UNIQUE constraint from registered_groups.folder
  // Multiple groups (web:main + feishu chats) share folder='main' by design.
  // The old UNIQUE constraint caused INSERT OR REPLACE to silently delete
  // the conflicting row, making web:main and feishu groups mutually exclusive.
  const hasUniqueFolder =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
         WHERE type='index' AND tbl_name='registered_groups'
         AND name='sqlite_autoindex_registered_groups_2'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;
  if (hasUniqueFolder) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          custom_cwd TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT jid, name, folder, added_at, container_config, execution_mode, custom_cwd, NULL, NULL, NULL, 0 FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    })();
  }

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'created_at',
    'created_by',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'container_config',
      'execution_mode',
      'custom_cwd',
      'init_source_path',
      'init_git_url',
      'created_by',
      'is_home',
      'selected_skills',
      'target_agent_id',
      'target_main_jid',
      'reply_policy',
    ],
    ['trigger_pattern', 'requires_trigger'],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'avatar_url',
    'ai_name',
    'ai_avatar_emoji',
    'ai_avatar_color',
    'ai_avatar_url',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ]);
  assertSchema('user_sessions', [
    'id',
    'user_id',
    'ip_address',
    'user_agent',
    'created_at',
    'expires_at',
    'last_active_at',
  ]);
  assertSchema('invite_codes', [
    'code',
    'created_by',
    'role',
    'permission_template',
    'permissions',
    'max_uses',
    'used_count',
    'expires_at',
    'created_at',
  ]);
  assertSchema('auth_audit_log', [
    'id',
    'event_type',
    'username',
    'actor_username',
    'ip_address',
    'user_agent',
    'details',
    'created_at',
  ]);

  // Store schema version after all migrations complete
  // Migrate existing web groups: assign to first admin
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid LIKE 'web:%' AND folder != 'main' AND created_by IS NULL
  `);

  // Backfill owner for legacy web:main if missing.
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid = 'web:main' AND created_by IS NULL
  `);

  // Backfill created_by for feishu/telegram groups by matching sibling groups in the same folder.
  // Only backfill when the folder has exactly one distinct owner; otherwise keep NULL
  // to avoid misrouting in ambiguous folders (e.g., shared admin main).
  db.exec(`
    UPDATE registered_groups
    SET created_by = (
      SELECT MIN(rg2.created_by)
      FROM registered_groups rg2
      WHERE rg2.folder = registered_groups.folder
        AND rg2.created_by IS NOT NULL
    )
    WHERE (jid LIKE 'feishu:%' OR jid LIKE 'telegram:%')
      AND created_by IS NULL
      AND (
        SELECT COUNT(DISTINCT rg3.created_by)
        FROM registered_groups rg3
        WHERE rg3.folder = registered_groups.folder
          AND rg3.created_by IS NOT NULL
      ) = 1
  `);

  // v13 migration: mark existing web:main group as is_home=1
  db.exec(`
    UPDATE registered_groups SET is_home = 1
    WHERE jid = 'web:main' AND folder = 'main' AND is_home = 0
  `);

  // v15 migration: backfill group_members for existing web groups
  const currentVersion = getRouterStateInternal('schema_version');
  if (!currentVersion || parseInt(currentVersion, 10) < 15) {
    db.transaction(() => {
      // Backfill owner records for all web groups with created_by set
      const webGroups = db
        .prepare(
          "SELECT DISTINCT folder, created_by FROM registered_groups WHERE jid LIKE 'web:%' AND created_by IS NOT NULL",
        )
        .all() as Array<{ folder: string; created_by: string }>;
      for (const g of webGroups) {
        db.prepare(
          `INSERT OR IGNORE INTO group_members (group_folder, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        ).run(g.folder, g.created_by, new Date().toISOString(), g.created_by);
      }
    })();
  }

  // v16→v17 migration: rebuild sessions table with composite primary key
  // Old PK was (group_folder), which cannot store multiple agent sessions per folder.
  // New PK is (group_folder, COALESCE(agent_id, '')) to support per-agent sessions.
  const curVer = getRouterStateInternal('schema_version');
  if (curVer && parseInt(curVer, 10) < 17) {
    db.transaction(() => {
      // Check if the old table has single-column PK by inspecting table_info
      const pkCols = (
        db.prepare("PRAGMA table_info('sessions')").all() as Array<{
          name: string;
          pk: number;
        }>
      ).filter((c) => c.pk > 0);
      // Old schema: single PK column 'group_folder'. New schema: composite PK needs rebuild.
      if (pkCols.length === 1 && pkCols[0].name === 'group_folder') {
        db.exec(`
          CREATE TABLE sessions_new (
            group_folder TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (group_folder, agent_id)
          );
          INSERT OR IGNORE INTO sessions_new (group_folder, session_id, agent_id)
            SELECT group_folder, session_id, COALESCE(agent_id, '') FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
    })();
  }

  // v22: Fix target_main_jid that used folder-based JID (web:${folder})
  // instead of actual registered group JID (web:${uuid}).
  // Only affects non-home workspaces where folder != uuid.
  if (curVer && parseInt(curVer, 10) < 22) {
    const rows = db
      .prepare(
        "SELECT jid, target_main_jid FROM registered_groups WHERE target_main_jid IS NOT NULL AND target_main_jid != ''",
      )
      .all() as Array<{ jid: string; target_main_jid: string }>;
    for (const row of rows) {
      const targetJid = row.target_main_jid;
      // Check if target_main_jid is a real registered group JID
      const exists = db
        .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
        .get(targetJid);
      if (exists) continue;
      // Not a valid JID — try to resolve via folder
      if (!targetJid.startsWith('web:')) continue;
      const folder = targetJid.slice(4);
      const candidates = db
        .prepare(
          "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
        )
        .all(folder) as Array<{ jid: string }>;
      if (candidates.length === 1) {
        db.prepare(
          'UPDATE registered_groups SET target_main_jid = ? WHERE jid = ?',
        ).run(candidates[0].jid, row.jid);
      }
    }
  }

  // v23→v24 migration: billing system initialization
  ensureColumn('users', 'subscription_plan_id', 'TEXT');
  const v24Ver = getRouterStateInternal('schema_version');
  if (!v24Ver || parseInt(v24Ver, 10) < 24) {
    db.transaction(() => {
      // Ensure a default free plan exists
      const existingDefault = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get();
      if (!existingDefault) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO billing_plans (id, name, description, tier, monthly_cost_usd, allow_overage, features, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'free',
          '免费版',
          '基础免费套餐',
          0,
          0,
          0,
          '[]',
          1,
          1,
          now,
          now,
        );
      }

      // Initialize balances for all existing users
      const users = db
        .prepare("SELECT id FROM users WHERE status != 'deleted'")
        .all() as Array<{ id: string }>;
      const now = new Date().toISOString();
      for (const u of users) {
        db.prepare(
          'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
        ).run(u.id, now);
      }

      // Create active subscriptions for existing users → free plan
      const freePlan = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get() as { id: string } | undefined;
      if (freePlan) {
        for (const u of users) {
          const existing = db
            .prepare(
              "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
            )
            .get(u.id);
          if (!existing) {
            const subId = `sub_${u.id}_${Date.now()}`;
            db.prepare(
              `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
               VALUES (?, ?, ?, 'active', ?, ?)`,
            ).run(subId, u.id, freePlan.id, now, now);
          }
        }
      }
    })();
  }

  // v24→v25 migration: billing system enhancement (daily/weekly quotas, rate_multiplier, trial)
  ensureColumn('billing_plans', 'daily_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'weekly_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'daily_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'weekly_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'rate_multiplier', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn('billing_plans', 'trial_days', 'INTEGER');
  ensureColumn('billing_plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('billing_plans', 'display_price', 'TEXT');
  ensureColumn('billing_plans', 'highlight', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('user_subscriptions', 'trial_ends_at', 'TEXT');
  ensureColumn('user_subscriptions', 'notes', 'TEXT');
  ensureColumn('redeem_codes', 'batch_id', 'TEXT');

  // v25→v26 migration: cost_usd on messages + idempotency key for balance transactions
  ensureColumn('messages', 'cost_usd', 'REAL');

  // idempotency key for balance transactions
  ensureColumn('balance_transactions', 'idempotency_key', 'TEXT');
  ensureColumn(
    'balance_transactions',
    'source',
    "TEXT NOT NULL DEFAULT 'system_adjustment'",
  );
  ensureColumn(
    'balance_transactions',
    'operator_type',
    "TEXT NOT NULL DEFAULT 'system'",
  );
  ensureColumn('balance_transactions', 'notes', 'TEXT');
  // Create unique index only if it doesn't exist
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // v26→v27 migration: wallet-first commercialization baseline
  const v27Ver = getRouterStateInternal('schema_version');
  if (!v27Ver || parseInt(v27Ver, 10) < 27) {
    db.transaction(() => {
      const now = new Date().toISOString();
      const users = db
        .prepare(
          "SELECT id, role FROM users WHERE status != 'deleted' AND role != 'admin'",
        )
        .all() as Array<{ id: string; role: UserRole }>;
      for (const user of users) {
        db.prepare(
          `INSERT OR IGNORE INTO user_balances (
            user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at
          ) VALUES (?, 0, 0, 0, ?)`,
        ).run(user.id, now);
        db.prepare(
          `UPDATE user_balances
           SET balance_usd = 0, total_deposited_usd = 0, total_consumed_usd = 0, updated_at = ?
           WHERE user_id = ?`,
        ).run(now, user.id);

        const hasOpening = db
          .prepare(
            "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
          )
          .get(user.id);
        if (!hasOpening) {
          db.prepare(
            `INSERT INTO balance_transactions (
              user_id, type, amount_usd, balance_after, description, reference_type,
              reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
            ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
          ).run(
            user.id,
            '商业化计费上线初始化',
            '上线迁移：普通用户默认余额归零，需充值后使用',
            now,
          );
        }
      }
    })();
  }

  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          0, 0,
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      // Build daily summary from usage_records
      db.exec(`
        INSERT OR REPLACE INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id, model, date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }

  // v29 → v30: Add last_im_jid to agents table (#225)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'last_im_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN last_im_jid TEXT');
  }

  // v31 → v32: Add spawned_from_jid to agents table (spawn parallel tasks)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'spawned_from_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN spawned_from_jid TEXT');
  }

  // v36 → v37: Add provider_id to sessions table for sticky provider binding.
  // Prevents "Invalid signature in thinking block" errors when a Claude session
  // resumed across container restarts gets routed to a different OAuth account.
  if (
    !db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .some((c: any) => c.name === 'provider_id')
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
  }

  const SCHEMA_VERSION = '37';
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Coerce a value flowing through a TEXT-affinity column into a JS string.
 *
 * SQLite is dynamically typed: a TEXT column will silently accept a
 * Buffer/Uint8Array binding and store it as BLOB. better-sqlite3 reads such
 * cells back as Buffer, which propagates through JSON.stringify as
 * `{type:"Buffer",data:[…]}` and breaks any consumer expecting a string.
 *
 * Wraps both write paths (where `warnField` surfaces the offending caller)
 * and read paths (no `warnField`, silent normalization of legacy bad data).
 */
function toUtf8String(value: unknown, warnField?: string): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const decoded = Buffer.from(value as Uint8Array).toString('utf8');
    if (warnField) {
      logger.warn(
        { field: warnField, byteLen: (value as Uint8Array).byteLength, sample: decoded.slice(0, 80) },
        'toUtf8String: Buffer on TEXT column, decoded as UTF-8',
      );
    }
    return decoded;
  }
  const coerced = String(value);
  if (warnField) {
    logger.warn(
      { field: warnField, jsType: typeof value, sample: coerced.slice(0, 80) },
      'toUtf8String: non-string on TEXT column, coerced via String()',
    );
  }
  return coerced;
}

/** Variant that preserves null (vs the default '' fallback). */
function toUtf8StringOrNull(value: unknown): string | null {
  return value == null ? null : toUtf8String(value);
}

/** Normalize a raw message row from sqlite: decode content + boolify is_from_me.
 *  The is_from_me overload must come first — TS overload resolution stops at
 *  the first match and `NewMessage & { is_from_me: number }` is a subtype of
 *  `NewMessage`. */
function normalizeMessageRow(
  row: NewMessage & { is_from_me: number },
): NewMessage & { is_from_me: boolean };
function normalizeMessageRow(row: NewMessage): NewMessage;
function normalizeMessageRow(row: NewMessage & { is_from_me?: number }): NewMessage & { is_from_me?: boolean } {
  const { is_from_me, content, ...rest } = row;
  const out: NewMessage & { is_from_me?: boolean } = {
    ...rest,
    content: toUtf8String(content),
  };
  if (typeof is_from_me === 'number') {
    out.is_from_me = is_from_me === 1;
  }
  return out;
}

/**
 * Ensure a chat row exists in the chats table (avoids FK violation on messages insert).
 */
export function ensureChatExists(chatJid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
  ).run(chatJid, chatJid, new Date().toISOString());
}

/**
 * Store a message with full content (channel-agnostic).
 * Only call this for registered groups where message history is needed.
 */
export function storeMessageDirect(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  opts?: {
    attachments?: string;
    tokenUsage?: string;
    sourceJid?: string;
    meta?: StoredMessageMeta;
  },
): string {
  const { attachments, tokenUsage, sourceJid, meta } = opts ?? {};
  const existingFinalRow =
    meta?.sourceKind === 'sdk_final' && meta.turnId
      ? (stmts().storeMessageSelect.get(chatJid, meta.turnId) as { id: string } | undefined)
      : undefined;
  const effectiveMsgId = existingFinalRow?.id || msgId;
  stmts().storeMessageInsert.run(
    effectiveMsgId,
    chatJid,
    sourceJid ?? chatJid,
    sender,
    senderName,
    toUtf8String(content, 'messages.content'),
    timestamp,
    isFromMe ? 1 : 0,
    attachments ?? null,
    tokenUsage ?? null,
    meta?.turnId ?? null,
    meta?.sessionId ?? null,
    meta?.sdkMessageUuid ?? null,
    meta?.sourceKind ?? null,
    meta?.finalizationReason ?? null,
    meta?.taskId ?? null,
  );
  return effectiveMsgId;
}

/**
 * Overwrite the `attachments` JSON column for a single message row.
 *
 * Used by the plugin-command expander to persist the expanded-prompt
 * sentinel after inline `!` commands run successfully (P1 round-14
 * crash-safety): the next recovery pass reads the sentinel and reuses
 * the stored prompt instead of re-executing inline.
 */
export function updateMessageAttachments(
  chatJid: string,
  msgId: string,
  attachmentsJson: string,
): void {
  db.prepare(
    `UPDATE messages SET attachments = ? WHERE id = ? AND chat_jid = ?`,
  ).run(attachmentsJson, msgId, chatJid);
}

/**
 * Read the `attachments` JSON column for a single message row, or null
 * if the row is missing (caller treats null as "no persisted state").
 */
export function getMessageAttachments(
  chatJid: string,
  msgId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT attachments FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(msgId, chatJid) as { attachments: string | null } | undefined;
  if (!row) return null;
  return row.attachments ?? null;
}

/**
 * Update the token_usage field on a specific agent message, or fall back to
 * the most recent agent message without token_usage for the given chat.
 * When msgId is provided, uses precise `WHERE id = ? AND chat_jid = ?` match
 * to avoid race conditions in concurrent scenarios.
 */
export function updateLatestMessageTokenUsage(
  chatJid: string,
  tokenUsage: string,
  msgId?: string,
  costUsd?: number,
): void {
  if (msgId) {
    stmts().updateTokenUsageById.run(tokenUsage, costUsd ?? null, msgId, chatJid);
  } else {
    stmts().updateTokenUsageLatest.run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Get token usage statistics aggregated by date.
 */
export function getTokenUsageStats(
  days: number,
  chatJids?: string[],
): Array<{
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  message_count: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND m.chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const baseQuery = `
    SELECT
      date(m.timestamp) as date,
      json_extract(m.token_usage, '$.modelUsage') as model_usage_json,
      json_extract(m.token_usage, '$.inputTokens') as input_tokens,
      json_extract(m.token_usage, '$.outputTokens') as output_tokens,
      json_extract(m.token_usage, '$.cacheReadInputTokens') as cache_read_tokens,
      json_extract(m.token_usage, '$.cacheCreationInputTokens') as cache_creation_tokens,
      json_extract(m.token_usage, '$.costUSD') as cost_usd
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND m.timestamp >= ?
      ${jidFilter}
    ORDER BY m.timestamp ASC
  `;

  const rows = db.prepare(baseQuery).all(...params) as Array<{
    date: string;
    model_usage_json: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate by date + model
  type AggregatedEntry = {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    message_count: number;
  };
  const aggregated = new Map<string, AggregatedEntry>();

  function addToAggregated(
    date: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.cost_usd += costUsd;
      existing.message_count += 1;
    } else {
      aggregated.set(key, {
        date,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: costUsd,
        message_count: 1,
      });
    }
  }

  for (const row of rows) {
    if (row.model_usage_json) {
      try {
        const modelUsage = JSON.parse(row.model_usage_json) as Record<
          string,
          { inputTokens: number; outputTokens: number; costUSD: number }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            0,
            0,
            usage.costUSD || 0,
          );
        }
      } catch (e) {
        logger.warn(
          { date: row.date, error: e },
          'Failed to parse model_usage_json',
        );
        // fallback: use aggregate fields
        addToAggregated(
          row.date,
          'unknown',
          row.input_tokens || 0,
          row.output_tokens || 0,
          row.cache_read_tokens || 0,
          row.cache_creation_tokens || 0,
          row.cost_usd || 0,
        );
      }
    } else {
      addToAggregated(
        row.date,
        'unknown',
        row.input_tokens || 0,
        row.output_tokens || 0,
        row.cache_read_tokens || 0,
        row.cache_creation_tokens || 0,
        row.cost_usd || 0,
      );
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Get token usage summary totals.
 */
export function getTokenUsageSummary(
  days: number,
  chatJids?: string[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(json_extract(token_usage, '$.inputTokens')), 0) as total_input,
      COALESCE(SUM(json_extract(token_usage, '$.outputTokens')), 0) as total_output,
      COALESCE(SUM(json_extract(token_usage, '$.cacheReadInputTokens')), 0) as total_cache_read,
      COALESCE(SUM(json_extract(token_usage, '$.cacheCreationInputTokens')), 0) as total_cache_creation,
      COALESCE(SUM(json_extract(token_usage, '$.costUSD')), 0) as total_cost,
      COUNT(*) as total_messages,
      COUNT(DISTINCT date(timestamp)) as total_active_days
    FROM messages
    WHERE token_usage IS NOT NULL AND timestamp >= ?
      ${jidFilter}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get a local timezone date string (YYYY-MM-DD) from a Date or ISO string.
 */
function toLocalDateString(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Insert a usage record and update daily summary.
 */
export function insertUsageRecord(record: {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const localDate = toLocalDateString();

  db.transaction(() => {
    stmts().insertUsageInsert.run(
      id,
      record.userId,
      record.groupFolder,
      record.agentId ?? null,
      record.messageId ?? null,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
      record.durationMs ?? 0,
      record.numTurns ?? 0,
      record.source ?? 'agent',
      now,
    );
    stmts().insertUsageUpsert.run(
      record.userId,
      record.model,
      localDate,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
    );
  })();
}

/**
 * Get usage stats from daily summary table (fixes timezone + token KPI issues).
 */
export function getUsageDailyStats(
  days: number,
  userId?: string,
  modelFilter?: string,
): Array<{
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  return db
    .prepare(
      `
    SELECT date, model, user_id,
      total_input_tokens as input_tokens,
      total_output_tokens as output_tokens,
      total_cache_read_tokens as cache_read_tokens,
      total_cache_creation_tokens as cache_creation_tokens,
      total_cost_usd as cost_usd,
      request_count
    FROM usage_daily_summary
    WHERE ${whereClause}
    ORDER BY date ASC
  `,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    user_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    request_count: number;
  }>;
}

/**
 * Get usage summary from daily summary table.
 */
export function getUsageDailySummary(
  days: number,
  userId?: string,
  modelFilter?: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_output_tokens), 0) as total_output,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(request_count), 0) as total_messages,
      COUNT(DISTINCT date) as total_active_days
    FROM usage_daily_summary
    WHERE ${whereClause}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get list of all models that have usage data.
 */
export function getUsageModels(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT model FROM usage_daily_summary ORDER BY model')
    .all() as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT uds.user_id as id, COALESCE(u.username, uds.user_id) as username
    FROM usage_daily_summary uds
    LEFT JOIN users u ON u.id = uds.user_id
    ORDER BY u.username
  `,
    )
    .all() as Array<{ id: string; username: string }>;
  return rows;
}

export function getNewMessages(
  jids: string[],
  cursor: MessageCursor,
): { messages: NewMessage[]; newCursor: MessageCursor } {
  if (jids.length === 0) return { messages: [], newCursor: cursor };

  const rawRows = getNewMessagesStmt(jids.length).all(
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
    ...jids,
  ) as NewMessage[];
  const rows = rawRows.map((r) => normalizeMessageRow(r));
  const last = rows[rows.length - 1];
  return {
    messages: rows,
    newCursor: last ? { timestamp: last.timestamp, id: last.id } : cursor,
  };
}

export function getMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): NewMessage[] {
  const rows = stmts().getMessagesSince.all(
    chatJid,
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
  ) as NewMessage[];
  return rows.map((row) => normalizeMessageRow(row));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, execution_mode, next_run, status, created_at, created_by, notify_channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    toUtf8String(task.prompt, 'scheduled_tasks.prompt'),
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'group',
    task.execution_type || 'agent',
    task.script_command == null
      ? null
      : toUtf8String(task.script_command, 'scheduled_tasks.script_command'),
    task.execution_mode ?? null,
    task.next_run,
    task.status,
    task.created_at,
    task.created_by ?? null,
    task.notify_channels != null ? JSON.stringify(task.notify_channels) : null,
  );
}

/** Parse notify_channels from JSON string stored in DB and normalize new fields */
function mapTaskRow(row: unknown): ScheduledTask {
  const r = row as any;
  if (typeof r.notify_channels === 'string') {
    try {
      r.notify_channels = JSON.parse(r.notify_channels);
    } catch {
      r.notify_channels = null;
    }
  } else if (r.notify_channels === undefined) {
    r.notify_channels = null;
  }
  // Normalize new nullable fields
  if (r.execution_mode === undefined) r.execution_mode = null;
  if (r.workspace_jid === undefined) r.workspace_jid = null;
  if (r.workspace_folder === undefined) r.workspace_folder = null;
  // Defensive: legacy BLOB cells in TEXT-affinity columns come back as Buffer.
  r.prompt = toUtf8String(r.prompt);
  if (r.script_command !== undefined) r.script_command = toUtf8StringOrNull(r.script_command);
  return r as ScheduledTask;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  return row ? mapTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder)
    .map(mapTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all()
    .map(mapTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'execution_type'
      | 'execution_mode'
      | 'script_command'
      | 'next_run'
      | 'status'
      | 'notify_channels'
      | 'chat_jid'
      | 'group_folder'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(toUtf8String(updates.prompt, 'scheduled_tasks.prompt'));
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.execution_type !== undefined) {
    fields.push('execution_type = ?');
    values.push(updates.execution_type);
  }
  if (updates.execution_mode !== undefined) {
    fields.push('execution_mode = ?');
    values.push(updates.execution_mode);
  }
  if (updates.script_command !== undefined) {
    fields.push('script_command = ?');
    values.push(
      updates.script_command == null
        ? null
        : toUtf8String(updates.script_command, 'scheduled_tasks.script_command'),
    );
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.notify_channels !== undefined) {
    fields.push('notify_channels = ?');
    values.push(updates.notify_channels != null ? JSON.stringify(updates.notify_channels) : null);
  }
  if (updates.chat_jid !== undefined) {
    fields.push('chat_jid = ?');
    values.push(updates.chat_jid);
  }
  if (updates.group_folder !== undefined) {
    fields.push('group_folder = ?');
    values.push(updates.group_folder);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function updateTaskWorkspace(
  id: string,
  workspaceJid: string,
  workspaceFolder: string,
): void {
  db.prepare(
    'UPDATE scheduled_tasks SET workspace_jid = ?, workspace_folder = ? WHERE id = ?',
  ).run(workspaceJid, workspaceFolder, id);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `
      DELETE FROM task_run_logs
      WHERE task_id IN (
        SELECT id FROM scheduled_tasks WHERE group_folder = ?
      )
      `,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
  });
  tx(groupFolder);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now)
    .map(mapTaskRow);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

// Advance next_run for a task we deliberately did NOT execute (e.g. overdue
// beyond the backfill grace window). Does not touch last_run, so the task
// detail view continues to reflect the last *actual* run.
export function advanceSkippedTask(id: string, nextRun: string | null): void {
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function logTaskRunStart(taskId: string): number {
  const result = db
    .prepare(
      `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, 0, 'running', NULL, NULL)
  `,
    )
    .run(taskId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateTaskRunLog(
  id: number,
  updates: { duration_ms: number; status: 'success' | 'error'; result: string | null; error: string | null },
): void {
  db.prepare(
    `
    UPDATE task_run_logs SET duration_ms = ?, status = ?, result = ?, error = ?
    WHERE id = ?
  `,
  ).run(updates.duration_ms, updates.status, updates.result, updates.error, id);
}

export function cleanupStaleRunningLogs(): number {
  const result = db
    .prepare(
      `
    UPDATE task_run_logs SET status = 'error', error = 'Process crashed before completion'
    WHERE status = 'running'
  `,
    )
    .run();
  return result.changes;
}

export function cleanupOldTaskRunLogs(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(cutoff);
  return result.changes;
}

export function cleanupOldDailyUsage(retentionDays = 90): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);
  const result = db
    .prepare('DELETE FROM daily_usage WHERE date < ?')
    .run(cutoff);
  return result.changes;
}

export function cleanupOldBillingAuditLog(retentionDays = 365): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM billing_audit_log WHERE created_at < ?')
    .run(cutoff);
  return result.changes;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

export function getRouterStateByPrefix(
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .prepare('SELECT key, value FROM router_state WHERE key LIKE ?')
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id) VALUES (?, ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, sessionId, effectiveAgentId);
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, effectiveAgentId);
}

/**
 * Get the provider_id bound to a session (group_folder + agent_id).
 * Returns undefined if no row or no binding recorded.
 *
 * Used by ProviderPool sticky-selection: when resuming a Claude session that
 * already produced thinking blocks, route back to the same provider/account so
 * thinking-block signatures validate.
 */
export function getSessionProviderId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT provider_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { provider_id: string | null }
    | undefined;
  return row?.provider_id ?? undefined;
}

/**
 * Bind a session to a specific provider_id, or clear the binding (provider_id=null).
 * Upserts a sessions row if one does not yet exist (with empty session_id).
 */
export function setSessionProviderId(
  groupFolder: string,
  agentId: string | null | undefined,
  providerId: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, provider_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET provider_id = excluded.provider_id`,
  ).run(groupFolder, effectiveAgentId, providerId);
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

/**
 * Delete all session rows bound to the given provider_id.
 *
 * Used when a provider's protocol-level fields (anthropicBaseUrl /
 * anthropicModel) change: any session whose history contains thinking blocks /
 * model-specific framing produced by this provider must restart fresh,
 * otherwise resuming under the new config can fail with "Invalid signature in
 * thinking block" or "model mismatch" errors. Sessions bound to *other*
 * providers are left intact so unrelated sticky bindings survive a partial
 * config update — see issue #476.
 *
 * Returns the affected `group_folder` values so callers can also evict the
 * in-memory sessions cache and the row count for telemetry.
 */
export function deleteSessionsByProviderId(providerId: string): {
  deletedCount: number;
  affectedFolders: string[];
} {
  const tx = db.transaction((id: string) => {
    const rows = db
      .prepare(
        'SELECT DISTINCT group_folder FROM sessions WHERE provider_id = ?',
      )
      .all(id) as Array<{ group_folder: string }>;
    const affectedFolders = rows.map((r) => r.group_folder);
    const result = db
      .prepare('DELETE FROM sessions WHERE provider_id = ?')
      .run(id);
    return {
      deletedCount: result.changes,
      affectedFolders,
    };
  });
  return tx(providerId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT group_folder, session_id FROM sessions WHERE agent_id = ''",
    )
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

function parseExecutionMode(
  raw: string | null,
  context: string,
): ExecutionMode {
  if (raw === 'container' || raw === 'host') return raw;
  if (raw !== null && raw !== '') {
    console.warn(
      `Invalid execution_mode "${raw}" for ${context}, falling back to "container"`,
    );
  }
  return 'container';
}

/** Raw row shape from registered_groups table — single source of truth for column mapping. */
type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  container_config: string | null;
  execution_mode: string | null;
  custom_cwd: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  created_by: string | null;
  is_home: number;
  selected_skills: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  reply_policy: string | null;
  require_mention: number;
  activation_mode: string | null;
  owner_im_id: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
  conversation_source: string | null;
  conversation_nav_mode: string | null;
  binding_mode: string | null;
  feishu_chat_mode: string | null;
  feishu_group_message_type: string | null;
  sender_allowlist: string | null;
};

/** Convert a raw DB row into a RegisteredGroup domain object. */
function parseGroupRow(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_agent_id: row.target_agent_id ?? undefined,
    target_main_jid: row.target_main_jid ?? undefined,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    require_mention: row.require_mention === 1,
    activation_mode: parseActivationMode(row.activation_mode),
    owner_im_id: row.owner_im_id ?? undefined,
    conversation_source:
      row.conversation_source === 'feishu_thread' ? 'feishu_thread' : 'manual',
    conversation_nav_mode:
      row.conversation_nav_mode === 'vertical_threads'
        ? 'vertical_threads'
        : 'horizontal',
    binding_mode:
      row.binding_mode === 'thread_map' ? 'thread_map' : 'single_context',
    feishu_chat_mode: row.feishu_chat_mode ?? undefined,
    feishu_group_message_type: row.feishu_group_message_type ?? undefined,
    sender_allowlist: row.sender_allowlist != null
      ? (JSON.parse(row.sender_allowlist) as string[])
      : undefined,
  };
}

export const VALID_ACTIVATION_MODES = new Set([
  'auto',
  'always',
  'when_mentioned',
  'owner_mentioned',
  'disabled',
]);

function parseActivationMode(
  raw: string | null,
): 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled' {
  if (raw && VALID_ACTIVATION_MODES.has(raw))
    return raw as 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled';
  return 'auto';
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, added_at, container_config, execution_mode, custom_cwd, init_source_path, init_git_url, created_by, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, owner_im_id, mcp_mode, selected_mcps, conversation_source, conversation_nav_mode, binding_mode, feishu_chat_mode, feishu_group_message_type, sender_allowlist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.executionMode ?? 'container',
    group.customCwd ?? null,
    group.initSourcePath ?? null,
    group.initGitUrl ?? null,
    group.created_by ?? null,
    group.is_home ? 1 : 0,
    null, // selected_skills: deprecated, always null (user-level skills apply globally)
    group.target_agent_id ?? null,
    group.target_main_jid ?? null,
    group.reply_policy ?? 'source_only',
    group.require_mention === true ? 1 : 0,
    group.activation_mode ?? 'auto',
    group.owner_im_id ?? null,
    'inherit', // mcp_mode: deprecated, always inherit (user-level MCP applies globally)
    null, // selected_mcps: deprecated, always null
    group.conversation_source ?? 'manual',
    group.conversation_nav_mode ?? 'horizontal',
    group.binding_mode ?? 'single_context',
    group.feishu_chat_mode ?? null,
    group.feishu_group_message_type ?? null,
    group.sender_allowlist != null ? JSON.stringify(group.sender_allowlist) : null,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

/**
 * Find groups owned by `userId` whose sender_allowlist is the empty array `[]` —
 * the "owner-locked trap" state where no one (not even the owner) can trigger
 * the bot. Created by buildOnNewChat when a Feishu group is auto-registered
 * before the owner has DM'd the bot. Used by Feishu owner backfill.
 */
export function findEmptyAllowlistFeishuGroupsForUser(userId: string): string[] {
  const rows = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE created_by = ? AND jid LIKE 'feishu:%' AND sender_allowlist = '[]'",
    )
    .all(userId) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/**
 * Replace empty `sender_allowlist=[]` with `[ownerOpenId]` for the user's
 * Feishu groups. Returns the JIDs that were updated. Run once when the
 * Feishu owner is first identified via P2P DM, to unstick groups that were
 * registered before the owner was known.
 */
export function backfillEmptyAllowlistsForUser(
  userId: string,
  ownerOpenId: string,
): string[] {
  const jids = findEmptyAllowlistFeishuGroupsForUser(userId);
  if (jids.length === 0) return [];
  const allowlistJson = JSON.stringify([ownerOpenId]);
  const stmt = db.prepare(
    'UPDATE registered_groups SET sender_allowlist = ? WHERE jid = ?',
  );
  const tx = db.transaction((targets: string[]) => {
    for (const jid of targets) stmt.run(allowlistJson, jid);
  });
  tx(jids);
  return jids;
}

/**
 * Clear `sender_allowlist` for a single group (set to NULL = unrestricted).
 * Used as a manual escape hatch from the owner-locked trap.
 */
export function clearSenderAllowlist(jid: string): void {
  db.prepare(
    'UPDATE registered_groups SET sender_allowlist = NULL WHERE jid = ?',
  ).run(jid);
}

/** Get all JIDs that share the same folder (e.g., all JIDs with folder='main'). */
export function getJidsByFolder(folder: string): string[] {
  const rows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/** Check if any registered group uses container execution mode (efficient targeted query). */
export function hasContainerModeGroups(): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM registered_groups WHERE execution_mode = 'container' OR execution_mode IS NULL LIMIT 1",
    )
    .get();
  return row !== undefined;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = parseGroupRow(row);
  }
  return result;
}

/**
 * Get all registered groups that route to a specific conversation agent.
 * Returns array of { jid, group } for each IM group targeting the given agentId.
 */
export function getGroupsByTargetAgent(
  agentId: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_agent_id = ?')
    .all(agentId) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Get all registered groups that route to a specific workspace's main conversation.
 */
export function getGroupsByTargetMainJid(
  webJid: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_main_jid = ?')
    .all(webJid) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

function mapImContextBindingRow(
  row: Record<string, unknown>,
): ImContextBinding {
  return {
    source_jid: String(row.source_jid),
    context_type: 'thread',
    context_id: String(row.context_id),
    workspace_jid: String(row.workspace_jid),
    agent_id: String(row.agent_id),
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title: typeof row.title === 'string' ? row.title : null,
    last_active_at: String(row.last_active_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getImContextBinding(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
): ImContextBinding | undefined {
  const row = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE source_jid = ? AND context_type = ? AND context_id = ?',
    )
    .get(sourceJid, contextType, contextId) as Record<string, unknown> | undefined;
  return row ? mapImContextBindingRow(row) : undefined;
}

export function upsertImContextBinding(binding: ImContextBinding): void {
  db.prepare(
    `INSERT INTO im_context_bindings (
      source_jid, context_type, context_id, workspace_jid, agent_id,
      root_message_id, title, last_active_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_jid, context_type, context_id) DO UPDATE SET
      workspace_jid = excluded.workspace_jid,
      agent_id = excluded.agent_id,
      -- COALESCE: 首条消息设定 root_message_id/title 后，后续消息传 null 不会覆盖
      root_message_id = COALESCE(excluded.root_message_id, im_context_bindings.root_message_id),
      title = COALESCE(excluded.title, im_context_bindings.title),
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at`,
  ).run(
    binding.source_jid,
    binding.context_type,
    binding.context_id,
    binding.workspace_jid,
    binding.agent_id,
    binding.root_message_id,
    binding.title,
    binding.last_active_at,
    binding.created_at,
    binding.updated_at,
  );
}

export function listImContextBindingsByWorkspace(
  workspaceJid: string,
): ImContextBinding[] {
  const rows = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE workspace_jid = ? ORDER BY last_active_at DESC, created_at DESC',
    )
    .all(workspaceJid) as Record<string, unknown>[];
  return rows.map(mapImContextBindingRow);
}

export function deleteImContextBindingsByWorkspace(workspaceJid: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE workspace_jid = ?').run(
    workspaceJid,
  );
}

export function deleteImContextBindingsByAgent(agentId: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE agent_id = ?').run(agentId);
}

/** Lightweight update: only touch last_active_at + updated_at on an existing binding. */
export function touchImContextBindingActivity(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
  lastActiveAt: string,
): void {
  db.prepare(
    'UPDATE im_context_bindings SET last_active_at = ?, updated_at = ? WHERE source_jid = ? AND context_type = ? AND context_id = ?',
  ).run(lastActiveAt, lastActiveAt, sourceJid, contextType, contextId);
}

/** List feishu_thread agent IDs for a workspace JID (for cleanup on unbind). */
export function listFeishuThreadAgentIds(workspaceJid: string): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM agents WHERE chat_jid = ? AND source_kind = 'feishu_thread'",
    )
    .all(workspaceJid) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Find a user's home group (is_home=1 + created_by=userId).
 * For admin users, also matches web:main even if created_by differs
 * (all admins share folder=main).
 */
export function getUserHomeGroup(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  // First try exact match: is_home=1 AND created_by=userId
  let row = db
    .prepare(
      'SELECT * FROM registered_groups WHERE is_home = 1 AND created_by = ?',
    )
    .get(userId) as RegisteredGroupRow | undefined;

  // Fallback for admin users: all admins share web:main (folder=main).
  // If no exact match, check if the user is an admin and web:main exists.
  if (!row) {
    const user = db
      .prepare("SELECT role FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { role: string } | undefined;
    if (user?.role === 'admin') {
      row = db
        .prepare(
          "SELECT * FROM registered_groups WHERE jid = 'web:main' AND is_home = 1",
        )
        .get() as RegisteredGroupRow | undefined;
    }
  }

  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Ensure a user has a home group. If not, create one.
 * Admin gets folder='main' with executionMode='host'.
 * Member gets folder='home-{userId}' with executionMode='container'.
 * Returns the JID of the home group.
 */
export function ensureUserHomeGroup(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserHomeGroup(userId);
  if (existing) return existing.jid;

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const jid = isAdmin ? 'web:main' : `web:home-${userId}`;
  const folder = isAdmin ? 'main' : `home-${userId}`;

  // For admin: check if web:main already exists (created by another admin)
  // In that case, reuse it rather than overwriting created_by
  if (isAdmin) {
    const existingMain = getRegisteredGroup(jid);
    if (existingMain) {
      // web:main already exists.
      // Ensure is_home, created_by, and executionMode are correct for owner-based routing.
      const patched = { ...existingMain };
      let changed = false;
      if (!patched.is_home) {
        patched.is_home = true;
        changed = true;
      }
      if (!patched.created_by) {
        patched.created_by = userId;
        changed = true;
      }
      // Admin home container must use host mode
      if (patched.executionMode !== 'host') {
        patched.executionMode = 'host';
        changed = true;
      }
      if (changed) {
        setRegisteredGroup(jid, patched);
      }
      ensureChatExists(jid);
      return jid;
    }
  }

  const name = username ? `${username} Home` : isAdmin ? 'Main' : 'Home';

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: userId,
    is_home: true,
  };

  setRegisteredGroup(jid, group);

  // Ensure chat row exists
  ensureChatExists(jid);

  // Create user-global memory directory and initialize CLAUDE.md from template
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  const userClaudeMd = path.join(userGlobalDir, 'CLAUDE.md');
  if (!fs.existsSync(userClaudeMd)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-claude-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.writeFileSync(userClaudeMd, fs.readFileSync(templatePath, 'utf-8'), {
          flag: 'wx',
        });
      } catch {
        // EEXIST race or read error — ignore
      }
    }
  }

  return jid;
}

export function deleteChatHistory(chatJid: string): void {
  const tx = db.transaction((jid: string) => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  });
  tx(chatJid);
}

/**
 * Delete an IM group's registered_groups entry and all jid-scoped data
 * (messages, chat record, pinned references). Does NOT touch folder-scoped
 * data (sessions, scheduled_tasks, group_members) because IM groups typically
 * share their folder with the owner's home workspace.
 *
 * Used when an IM group is detected as dead (bot removed, group disbanded,
 * health-check unreachable, or repeated send failures) and for the manual
 * "delete this IM binding" UI button.
 */
export function deleteImGroupRecord(jid: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // Feishu thread agents (source_kind='feishu_thread') and other chat-scoped
    // agents reference this jid via agents.chat_jid — without this, deleting
    // an IM group leaves orphan agent rows visible in the agents list.
    db.prepare('DELETE FROM agents WHERE chat_jid = ?').run(jid);
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

export function deleteGroupData(jid: string, folder: string): void {
  const tx = db.transaction(() => {
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除成员记录
    db.prepare('DELETE FROM group_members WHERE group_folder = ?').run(folder);
    // 3. 删除注册信息
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    // 4. 删除会话
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    // 5. 删除聊天记录
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    // 6. 删除 pin 记录
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // 7. 清除定时任务的工作区关联（任务本身不删，只断开绑定）
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

// --- User pinned groups ---

export function getUserPinnedGroups(userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT jid, pinned_at FROM user_pinned_groups WHERE user_id = ?')
    .all(userId) as Array<{ jid: string; pinned_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.jid] = row.pinned_at;
  return result;
}

export function pinGroup(userId: string, jid: string): string {
  const pinned_at = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO user_pinned_groups (user_id, jid, pinned_at) VALUES (?, ?, ?)',
  ).run(userId, jid, pinned_at);
  return pinned_at;
}

export function unpinGroup(userId: string, jid: string): void {
  db.prepare(
    'DELETE FROM user_pinned_groups WHERE user_id = ? AND jid = ?',
  ).run(userId, jid);
}

// --- Web API accessors ---

/**
 * Get paginated messages for a chat, cursor-based pagination.
 * Returns messages in descending timestamp order (newest first).
 */
export function getMessagesPage(
  chatJid: string,
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const sql = before
    ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

  const params = before ? [chatJid, before, limit] : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get messages after a given timestamp (for polling new messages).
 * Returns in ASC order (oldest first).
 */
export function getMessagesAfter(
  chatJid: string,
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, after, limit) as Array<NewMessage & { is_from_me: number }>;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 分页查询（用于主容器合并 web:main + feishu:xxx 消息）。
 */
export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;

  const params = before ? [...chatJids, before, limit] : [...chatJids, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 增量查询（用于主容器轮询合并消息）。
 */
export function getMessagesAfterMulti(
  chatJids: string[],
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesAfter(chatJids[0], after, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...chatJids, after, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get task run logs for a specific task, ordered by most recent first.
 */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT id, task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

// ===================== Daily Summary Queries =====================

/**
 * Get messages for a chat within a time range, ordered by timestamp ASC.
 */
export function getMessagesByTimeRange(
  chatJid: string,
  startTs: number,
  endTs: number,
  limit = 500,
): Array<NewMessage & { is_from_me: boolean }> {
  const startIso = new Date(startTs).toISOString();
  const endIso = new Date(endTs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get all registered groups owned by a specific user.
 */
export function getGroupsByOwner(
  userId: string,
): Array<RegisteredGroup & { jid: string }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE created_by = ?')
    .all(userId) as Array<{
    jid: string;
    name: string;
    folder: string;
    added_at: string;
    container_config: string | null;
    execution_mode: string | null;
    custom_cwd: string | null;
    init_source_path: string | null;
    init_git_url: string | null;
    created_by: string | null;
    is_home: number;
    selected_skills: string | null;
    target_main_jid: string | null;
    target_agent_id: string | null;
  }>;

  return rows.map((row) => ({
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_main_jid: row.target_main_jid ?? undefined,
    target_agent_id: row.target_agent_id ?? undefined,
  }));
}

// ===================== Auth CRUD =====================

function parseUserRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'member';
}

function parseUserStatus(value: unknown): UserStatus {
  if (value === 'deleted') return 'deleted';
  if (value === 'disabled') return 'disabled';
  return 'active';
}

function parsePermissionsFromDb(raw: unknown, role: UserRole): Permission[] {
  if (typeof raw === 'string') {
    try {
      const parsed = normalizePermissions(JSON.parse(raw));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore and fall back to role defaults
    }
  }
  return getDefaultPermissions(role);
}

function parseJsonDetails(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapUserRow(row: Record<string, unknown>): User {
  const role = parseUserRole(row.role);
  const status = parseUserStatus(row.status);
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    display_name: String(row.display_name ?? ''),
    role,
    status,
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
    disable_reason:
      typeof row.disable_reason === 'string' ? row.disable_reason : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    avatar_url:
      typeof row.avatar_url === 'string' ? row.avatar_url : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at:
      typeof row.last_login_at === 'string' ? row.last_login_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
  };
}

function toUserPublic(user: User, lastActiveAt: string | null): UserPublic {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
    disable_reason: user.disable_reason,
    notes: user.notes,
    avatar_emoji: user.avatar_emoji,
    avatar_color: user.avatar_color,
    avatar_url: user.avatar_url,
    ai_name: user.ai_name,
    ai_avatar_emoji: user.ai_avatar_emoji,
    ai_avatar_color: user.ai_avatar_color,
    ai_avatar_url: user.ai_avatar_url,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    last_active_at: lastActiveAt,
    deleted_at: user.deleted_at,
  };
}

// --- Users ---

export interface CreateUserInput {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  permissions?: Permission[];
  must_change_password?: boolean;
  disable_reason?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  deleted_at?: string | null;
}

function initializeBillingForUser(
  userId: string,
  role: UserRole,
  createdAt: string,
): void {
  const now = createdAt || new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
  ).run(userId, now);

  if (role === 'admin') return;

  const defaultPlan = getDefaultBillingPlan();
  if (!defaultPlan) return;

  const activeSubscription = db
    .prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
    )
    .get(userId) as { id: string } | undefined;
  if (activeSubscription) return;

  const subId = `sub_${userId}_${Date.now()}`;
  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(subId, userId, defaultPlan.id, now, now);
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    defaultPlan.id,
    userId,
  );

  const hasOpening = db
    .prepare(
      "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
    )
    .get(userId);
  if (!hasOpening) {
    db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
      ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
    ).run(
      userId,
      '用户钱包初始化',
      '新用户默认余额为 0，需管理员充值或兑换后方可消费',
      now,
    );
  }
}

export function createUser(user: CreateUserInput): void {
  const permissions = normalizePermissions(
    user.permissions ?? getDefaultPermissions(user.role),
  );
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions, must_change_password,
      disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.display_name,
    user.role,
    user.status,
    JSON.stringify(permissions),
    user.must_change_password ? 1 : 0,
    user.disable_reason ?? null,
    user.notes ?? null,
    user.created_at,
    user.updated_at,
    user.last_login_at ?? null,
    user.deleted_at ?? null,
  );
  initializeBillingForUser(user.id, user.role, user.created_at);
}

export type CreateInitialAdminResult =
  | { ok: true }
  | { ok: false; reason: 'already_initialized' | 'username_taken' };

export function createInitialAdminUser(
  user: CreateUserInput,
): CreateInitialAdminResult {
  const tx = db.transaction(
    (input: CreateUserInput): CreateInitialAdminResult => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      };
      if (row.count > 0) return { ok: false, reason: 'already_initialized' };
      createUser(input);
      return { ok: true };
    },
  );

  try {
    return tx(user);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as Record<string, unknown> | undefined;
  return row ? mapUserRow(row) : undefined;
}

export interface ListUsersOptions {
  query?: string;
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  users: UserPublic[];
  total: number;
  page: number;
  pageSize: number;
}

export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const role = options.role && options.role !== 'all' ? options.role : null;
  const status =
    options.status && options.status !== 'all' ? options.status : null;
  const query = options.query?.trim() || '';
  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(options.pageSize || 50)),
  );
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (role) {
    whereParts.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    whereParts.push('u.status = ?');
    params.push(status);
  } else {
    whereParts.push("u.status != 'deleted'");
  }
  if (query) {
    whereParts.push(
      "(u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.notes, '') LIKE ?)",
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `
      SELECT u.*, MAX(s.last_active_at) AS last_active_at
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY
        CASE u.status
          WHEN 'active' THEN 0
          WHEN 'disabled' THEN 1
          ELSE 2
        END,
        u.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    users: rows.map((row) => {
      const user = mapUserRow(row);
      const lastActiveAt =
        typeof row.last_active_at === 'string' ? row.last_active_at : null;
      return toUserPublic(user, lastActiveAt);
    }),
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function getAllUsers(): UserPublic[] {
  return listUsers({ role: 'all', status: 'all', page: 1, pageSize: 1000 })
    .users;
}

export function getUserCount(includeDeleted = false): number {
  const row = includeDeleted
    ? (db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      })
    : (db
        .prepare('SELECT COUNT(*) as count FROM users WHERE status != ?')
        .get('deleted') as { count: number });
  return row.count;
}

export function getActiveAdminCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE role = 'admin' AND status = 'active'`,
    )
    .get() as { count: number };
  return row.count;
}

export function updateUserFields(
  id: string,
  updates: Partial<
    Pick<
      User,
      | 'username'
      | 'display_name'
      | 'role'
      | 'status'
      | 'password_hash'
      | 'last_login_at'
      | 'permissions'
      | 'must_change_password'
      | 'disable_reason'
      | 'notes'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'avatar_url'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
      | 'deleted_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(updates.password_hash);
  }
  if (updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    values.push(updates.last_login_at);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(updates.must_change_password ? 1 : 0);
  }
  if (updates.disable_reason !== undefined) {
    fields.push('disable_reason = ?');
    values.push(updates.disable_reason);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.avatar_emoji !== undefined) {
    fields.push('avatar_emoji = ?');
    values.push(updates.avatar_emoji);
  }
  if (updates.avatar_color !== undefined) {
    fields.push('avatar_color = ?');
    values.push(updates.avatar_color);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url);
  }
  if (updates.ai_name !== undefined) {
    fields.push('ai_name = ?');
    values.push(updates.ai_name);
  }
  if (updates.ai_avatar_emoji !== undefined) {
    fields.push('ai_avatar_emoji = ?');
    values.push(updates.ai_avatar_emoji);
  }
  if (updates.ai_avatar_color !== undefined) {
    fields.push('ai_avatar_color = ?');
    values.push(updates.ai_avatar_color);
  }
  if (updates.ai_avatar_url !== undefined) {
    fields.push('ai_avatar_url = ?');
    values.push(updates.ai_avatar_url);
  }
  if (updates.deleted_at !== undefined) {
    fields.push('deleted_at = ?');
    values.push(updates.deleted_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteUser(id: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction((userId: string) => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    db.prepare(
      `UPDATE users
       SET status = 'deleted', deleted_at = ?, disable_reason = COALESCE(disable_reason, 'deleted_by_admin'), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, userId);
  });
  tx(id);
}

export function restoreUser(id: string): void {
  db.prepare(
    `UPDATE users
     SET status = 'disabled', deleted_at = NULL, disable_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

// --- User Sessions ---

export function createUserSession(session: UserSession): void {
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.ip_address,
    session.user_agent,
    session.created_at,
    session.expires_at,
    session.last_active_at,
  );
}

export function getSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const row = stmts().getSessionWithUser.get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    last_active_at: String(row.last_active_at),
    username: String(row.username),
    role,
    status: parseUserStatus(row.status),
    display_name: String(row.display_name ?? ''),
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
  };
}

export function getUserSessions(userId: string): UserSession[] {
  return db
    .prepare(
      `SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC`,
    )
    .all(userId) as UserSession[];
}

export function deleteUserSession(sessionId: string): void {
  stmts().deleteSession.run(sessionId);
}

export function deleteUserSessionsByUserId(userId: string): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

export function updateSessionLastActive(sessionId: string): void {
  stmts().updateSessionLastActive.run(new Date().toISOString(), sessionId);
}

export function getExpiredSessionIds(): string[] {
  const now = new Date().toISOString();
  return (stmts().getExpiredSessionIds.all(now) as { id: string }[]).map(
    (r) => r.id,
  );
}

export function deleteExpiredSessions(): number {
  const now = new Date().toISOString();
  const result = db
    .prepare('DELETE FROM user_sessions WHERE expires_at < ?')
    .run(now);
  return result.changes;
}

// --- Invite Codes ---

export function createInviteCode(invite: InviteCode): void {
  const permissions = normalizePermissions(invite.permissions);
  db.prepare(
    `INSERT INTO invite_codes (code, created_by, role, permission_template, permissions, max_uses, used_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invite.code,
    invite.created_by,
    invite.role,
    invite.permission_template ?? null,
    JSON.stringify(permissions),
    invite.max_uses,
    invite.used_count,
    invite.expires_at,
    invite.created_at,
  );
}

export function getInviteCode(code: string): InviteCode | undefined {
  const row = db
    .prepare('SELECT * FROM invite_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    code: String(row.code),
    created_by: String(row.created_by),
    role,
    permission_template:
      typeof row.permission_template === 'string'
        ? (row.permission_template as PermissionTemplateKey)
        : null,
    permissions: parsePermissionsFromDb(row.permissions, role),
    max_uses: Number(row.max_uses),
    used_count: Number(row.used_count),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_at: String(row.created_at),
  };
}

export type RegisterUserWithInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | {
      ok: false;
      reason:
        | 'invalid_or_expired_invite'
        | 'invite_exhausted'
        | 'username_taken';
    };

export function registerUserWithInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithInviteResult {
  const tx = db.transaction(
    (params: typeof input): RegisterUserWithInviteResult => {
      const inviteRow = db
        .prepare(
          `SELECT code, role, permissions, max_uses, expires_at
         FROM invite_codes
         WHERE code = ?`,
        )
        .get(params.invite_code) as Record<string, unknown> | undefined;

      if (!inviteRow) return { ok: false, reason: 'invalid_or_expired_invite' };
      const inviteRole = parseUserRole(inviteRow.role);
      const invitePermissions = parsePermissionsFromDb(
        inviteRow.permissions,
        inviteRole,
      );
      const inviteExpiresAt =
        typeof inviteRow.expires_at === 'string' ? inviteRow.expires_at : null;

      if (inviteExpiresAt) {
        const expiresAt = Date.parse(inviteExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
          return { ok: false, reason: 'invalid_or_expired_invite' };
        }
      }

      const existing = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(params.username) as { id: string } | undefined;
      if (existing) return { ok: false, reason: 'username_taken' };

      const inviteUsage = db
        .prepare(
          `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ?
           AND (max_uses = 0 OR used_count < max_uses)`,
        )
        .run(params.invite_code);
      if (inviteUsage.changes === 0) {
        return { ok: false, reason: 'invite_exhausted' };
      }

      const permissions = normalizePermissions(invitePermissions);
      db.prepare(
        `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.id,
        params.username,
        params.password_hash,
        params.display_name,
        inviteRole,
        'active',
        JSON.stringify(permissions),
        0,
        null,
        null,
        params.created_at,
        params.updated_at,
        null,
        null,
      );
      initializeBillingForUser(params.id, inviteRole, params.created_at);

      return { ok: true, role: inviteRole, permissions };
    },
  );

  try {
    return tx(input);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export type RegisterUserWithoutInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | { ok: false; reason: 'username_taken' };

export function registerUserWithoutInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithoutInviteResult {
  const role: UserRole = 'member';
  const permissions: Permission[] = [];

  try {
    db.prepare(
      `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.username,
      input.password_hash,
      input.display_name,
      role,
      'active',
      JSON.stringify(permissions),
      0,
      null,
      null,
      input.created_at,
      input.updated_at,
      null,
      null,
    );
    initializeBillingForUser(input.id, role, input.created_at);
    return { ok: true, role, permissions };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getAllInviteCodes(): InviteCodeWithCreator[] {
  const rows = db
    .prepare(
      `SELECT i.*, u.username as creator_username
       FROM invite_codes i
       JOIN users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const role = parseUserRole(row.role);
    return {
      code: String(row.code),
      created_by: String(row.created_by),
      creator_username: String(row.creator_username),
      role,
      permission_template:
        typeof row.permission_template === 'string'
          ? (row.permission_template as PermissionTemplateKey)
          : null,
      permissions: parsePermissionsFromDb(row.permissions, role),
      max_uses: Number(row.max_uses),
      used_count: Number(row.used_count),
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      created_at: String(row.created_at),
    };
  });
}

export function deleteInviteCode(code: string): void {
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
}

// --- Auth Audit Log ---

export function logAuthEvent(event: {
  event_type: AuthEventType;
  username: string;
  actor_username?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO auth_audit_log (event_type, username, actor_username, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_type,
    event.username,
    event.actor_username ?? null,
    event.ip_address ?? null,
    event.user_agent ?? null,
    event.details ? JSON.stringify(event.details) : null,
    new Date().toISOString(),
  );
}

export interface AuthAuditLogQuery {
  limit?: number;
  offset?: number;
  event_type?: AuthEventType | 'all';
  username?: string;
  actor_username?: string;
  from?: string;
  to?: string;
}

export interface AuthAuditLogPage {
  logs: AuthAuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export function queryAuthAuditLogs(
  query: AuthAuditLogQuery = {},
): AuthAuditLogPage {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 100)));
  const offset = Math.max(0, Math.floor(query.offset || 0));

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (query.event_type && query.event_type !== 'all') {
    whereParts.push('event_type = ?');
    params.push(query.event_type);
  }
  if (query.username?.trim()) {
    whereParts.push('username LIKE ?');
    params.push(`%${query.username.trim()}%`);
  }
  if (query.actor_username?.trim()) {
    whereParts.push('actor_username LIKE ?');
    params.push(`%${query.actor_username.trim()}%`);
  }
  if (query.from) {
    whereParts.push('created_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    whereParts.push('created_at <= ?');
    params.push(query.to);
  }
  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM auth_audit_log ${whereClause}`)
      .get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM auth_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  const logs = rows.map((row) => ({
    id: Number(row.id),
    event_type: row.event_type as AuthEventType,
    username: String(row.username),
    actor_username:
      typeof row.actor_username === 'string' ? row.actor_username : null,
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    details: parseJsonDetails(row.details),
    created_at: String(row.created_at),
  }));

  return { logs, total, limit, offset };
}

export function getAuthAuditLogs(limit = 100, offset = 0): AuthAuditLog[] {
  return queryAuthAuditLogs({ limit, offset }).logs;
}

export function checkLoginRateLimitFromAudit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number; attempts: number } {
  if (maxAttempts <= 0) return { allowed: true, attempts: 0 };
  const windowStart = new Date(
    Date.now() - lockoutMinutes * 60 * 1000,
  ).toISOString();
  const rows = db
    .prepare(
      `
      SELECT created_at
      FROM auth_audit_log
      WHERE event_type = 'login_failed'
        AND username = ?
        AND ip_address = ?
        AND created_at >= ?
        AND (details IS NULL OR details NOT LIKE '%"reason":"rate_limited"%')
      ORDER BY created_at ASC
      `,
    )
    .all(username, ip, windowStart) as Array<{ created_at: string }>;

  const attempts = rows.length;
  if (attempts < maxAttempts) return { allowed: true, attempts };

  const oldest = rows[0]?.created_at;
  const oldestTs = oldest ? Date.parse(oldest) : Date.now();
  const retryAt = oldestTs + lockoutMinutes * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAt - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSeconds, attempts };
}

// ===================== Group Members =====================

export function addGroupMember(
  groupFolder: string,
  userId: string,
  role: 'owner' | 'member',
  addedBy?: string,
): void {
  db.prepare(
    `INSERT INTO group_members (group_folder, user_id, role, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, user_id) DO UPDATE SET
       role = CASE WHEN excluded.role = 'owner' THEN 'owner'
                   WHEN group_members.role = 'owner' THEN 'owner'
                   ELSE excluded.role END,
       added_by = COALESCE(excluded.added_by, group_members.added_by)`,
  ).run(groupFolder, userId, role, new Date().toISOString(), addedBy ?? null);
}

export function removeGroupMember(groupFolder: string, userId: string): void {
  db.prepare(
    'DELETE FROM group_members WHERE group_folder = ? AND user_id = ?',
  ).run(groupFolder, userId);
}

export function getGroupMembers(groupFolder: string): GroupMember[] {
  const rows = db
    .prepare(
      `SELECT gm.user_id, gm.role, gm.added_at, gm.added_by,
              u.username, COALESCE(u.display_name, '') as display_name
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_folder = ?
       ORDER BY gm.role DESC, gm.added_at ASC`,
    )
    .all(groupFolder) as Array<{
    user_id: string;
    role: string;
    added_at: string;
    added_by: string | null;
    username: string;
    display_name: string;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role as 'owner' | 'member',
    added_at: r.added_at,
    added_by: r.added_by ?? undefined,
    username: r.username,
    display_name: r.display_name,
  }));
}

export function getGroupMemberRole(
  groupFolder: string,
  userId: string,
): 'owner' | 'member' | null {
  const row = db
    .prepare(
      'SELECT role FROM group_members WHERE group_folder = ? AND user_id = ?',
    )
    .get(groupFolder, userId) as { role: string } | undefined;
  if (!row) return null;
  return row.role as 'owner' | 'member';
}

export function getUserMemberFolders(
  userId: string,
): Array<{ group_folder: string; role: 'owner' | 'member' }> {
  const rows = db
    .prepare('SELECT group_folder, role FROM group_members WHERE user_id = ?')
    .all(userId) as Array<{ group_folder: string; role: string }>;
  return rows.map((r) => ({
    group_folder: r.group_folder,
    role: r.role as 'owner' | 'member',
  }));
}

// ===================== Sub-Agent CRUD =====================

export function createAgent(agent: SubAgent): void {
  db.prepare(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_by, created_at, completed_at, result_summary, spawned_from_jid, source_kind, thread_id, root_message_id, title_source, last_active_at, last_im_jid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.group_folder,
    agent.chat_jid,
    agent.name,
    agent.prompt,
    agent.status,
    agent.kind || 'task',
    agent.created_by ?? null,
    agent.created_at,
    agent.completed_at ?? null,
    agent.result_summary ?? null,
    agent.spawned_from_jid ?? null,
    agent.source_kind ?? null,
    agent.thread_id ?? null,
    agent.root_message_id ?? null,
    agent.title_source ?? null,
    agent.last_active_at ?? null,
    agent.last_im_jid ?? null,
  );
}

export function getAgent(id: string): SubAgent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapAgentRow(row);
}

export function listAgentsByFolder(folder: string): SubAgent[] {
  const rows = db
    .prepare(
      'SELECT * FROM agents WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(folder) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function listAgentsByJid(chatJid: string): SubAgent[] {
  const rows = db
    .prepare('SELECT * FROM agents WHERE chat_jid = ? ORDER BY created_at DESC')
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  resultSummary?: string,
): void {
  const completedAt =
    status !== 'running' && status !== 'idle' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE agents SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?',
  ).run(status, completedAt, resultSummary ?? null, id);
}

export function updateAgentLastImJid(
  id: string,
  lastImJid: string | null,
): void {
  db.prepare('UPDATE agents SET last_im_jid = ? WHERE id = ?').run(
    lastImJid,
    id,
  );
}

export function updateAgentInfo(
  id: string,
  name: string,
  prompt: string,
): void {
  db.prepare('UPDATE agents SET name = ?, prompt = ? WHERE id = ?').run(
    name,
    prompt,
    id,
  );
}

export function updateAgentContextInfo(
  id: string,
  updates: Partial<
    Pick<
      SubAgent,
      | 'name'
      | 'source_kind'
      | 'thread_id'
      | 'root_message_id'
      | 'title_source'
      | 'last_active_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.source_kind !== undefined) {
    fields.push('source_kind = ?');
    values.push(updates.source_kind);
  }
  if (updates.thread_id !== undefined) {
    fields.push('thread_id = ?');
    values.push(updates.thread_id);
  }
  if (updates.root_message_id !== undefined) {
    fields.push('root_message_id = ?');
    values.push(updates.root_message_id);
  }
  if (updates.title_source !== undefined) {
    fields.push('title_source = ?');
    values.push(updates.title_source);
  }
  if (updates.last_active_at !== undefined) {
    fields.push('last_active_at = ?');
    values.push(updates.last_active_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteCompletedAgents(beforeTimestamp: string): number {
  const result = db
    .prepare(
      "DELETE FROM agents WHERE kind IN ('task', 'spawn') AND status IN ('completed', 'error') AND completed_at IS NOT NULL AND completed_at < ?",
    )
    .run(beforeTimestamp);
  return result.changes;
}

export function getRunningTaskAgentsByChat(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      "SELECT * FROM agents WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function markRunningTaskAgentsAsError(chatJid: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ? WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .run(now, chatJid);
  return result.changes;
}

export function markAllRunningTaskAgentsAsError(
  summary = '进程重启，任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'task' AND status = 'running'",
    )
    .run(now, summary);
  return result.changes;
}

/**
 * Mark stale spawn agents (idle/running) as error at startup.
 * After a process restart, spawn agents that were idle or running can never
 * resume — their in-memory task callbacks are lost. Mark them as error so
 * they don't render as "正在思考..." in the frontend.
 */
export function markStaleSpawnAgentsAsError(
  summary = '进程重启，并行任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'spawn' AND status IN ('idle', 'running')",
    )
    .run(now, summary);
  return result.changes;
}

export function listActiveConversationAgents(): SubAgent[] {
  return (
    db
      .prepare(
        "SELECT * FROM agents WHERE kind IN ('conversation', 'spawn') AND status IN ('running', 'idle')",
      )
      .all() as Record<string, unknown>[]
  ).map(mapAgentRow);
}

export function deleteAgent(id: string): void {
  // Delete associated session
  db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(id);
  deleteImContextBindingsByAgent(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgentRow(row: Record<string, unknown>): SubAgent {
  return {
    id: String(row.id),
    group_folder: String(row.group_folder),
    chat_jid: String(row.chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'running',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
    last_im_jid:
      typeof row.last_im_jid === 'string' ? row.last_im_jid : null,
    spawned_from_jid:
      typeof row.spawned_from_jid === 'string' ? row.spawned_from_jid : null,
    source_kind:
      typeof row.source_kind === 'string'
        ? (row.source_kind as 'manual' | 'feishu_thread' | 'auto_im')
        : null,
    thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title_source:
      typeof row.title_source === 'string'
        ? (row.title_source as
            | 'manual'
            | 'feishu_root'
            | 'auto'
            | 'auto_pending')
        : null,
    last_active_at:
      typeof row.last_active_at === 'string' ? row.last_active_at : null,
  };
}

export function deleteMessagesForChatJid(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
}

export function getMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: number;
} | null {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?',
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        sender: string | null;
        is_from_me: number;
      }
    | undefined;
  return row ?? null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
}

export function isGroupShared(groupFolder: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM group_members WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };
  return row.cnt > 1;
}

// --- Billing CRUD functions ---

export function getBillingPlan(id: string): BillingPlan | undefined {
  const row = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function getActiveBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare(
        'SELECT * FROM billing_plans WHERE is_active = 1 ORDER BY tier ASC, name ASC',
      )
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getAllBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare('SELECT * FROM billing_plans ORDER BY tier ASC, name ASC')
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getDefaultBillingPlan(): BillingPlan | undefined {
  const row = db
    .prepare('SELECT * FROM billing_plans WHERE is_default = 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function createBillingPlan(plan: BillingPlan): void {
  db.transaction(() => {
    // Clear old default BEFORE inserting the new plan to avoid brief dual-default
    if (plan.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE is_default = 1',
      ).run();
    }
    db.prepare(
      `INSERT INTO billing_plans (id, name, description, tier, monthly_cost_usd, monthly_token_quota, monthly_cost_quota,
       daily_cost_quota, weekly_cost_quota, daily_token_quota, weekly_token_quota,
       rate_multiplier, trial_days, sort_order, display_price, highlight,
       max_groups, max_concurrent_containers, max_im_channels, max_mcp_servers, max_storage_mb,
       allow_overage, features, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.name,
      plan.description,
      plan.tier,
      plan.monthly_cost_usd,
      plan.monthly_token_quota,
      plan.monthly_cost_quota,
      plan.daily_cost_quota,
      plan.weekly_cost_quota,
      plan.daily_token_quota,
      plan.weekly_token_quota,
      plan.rate_multiplier,
      plan.trial_days,
      plan.sort_order,
      plan.display_price,
      plan.highlight ? 1 : 0,
      plan.max_groups,
      plan.max_concurrent_containers,
      plan.max_im_channels,
      plan.max_mcp_servers,
      plan.max_storage_mb,
      plan.allow_overage ? 1 : 0,
      JSON.stringify(plan.features),
      plan.is_default ? 1 : 0,
      plan.is_active ? 1 : 0,
      plan.created_at,
      plan.updated_at,
    );
  })();
}

export function updateBillingPlan(
  id: string,
  updates: Partial<Omit<BillingPlan, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.tier !== undefined) {
    fields.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.monthly_cost_usd !== undefined) {
    fields.push('monthly_cost_usd = ?');
    values.push(updates.monthly_cost_usd);
  }
  if (updates.monthly_token_quota !== undefined) {
    fields.push('monthly_token_quota = ?');
    values.push(updates.monthly_token_quota);
  }
  if (updates.monthly_cost_quota !== undefined) {
    fields.push('monthly_cost_quota = ?');
    values.push(updates.monthly_cost_quota);
  }
  if (updates.daily_cost_quota !== undefined) {
    fields.push('daily_cost_quota = ?');
    values.push(updates.daily_cost_quota);
  }
  if (updates.weekly_cost_quota !== undefined) {
    fields.push('weekly_cost_quota = ?');
    values.push(updates.weekly_cost_quota);
  }
  if (updates.daily_token_quota !== undefined) {
    fields.push('daily_token_quota = ?');
    values.push(updates.daily_token_quota);
  }
  if (updates.weekly_token_quota !== undefined) {
    fields.push('weekly_token_quota = ?');
    values.push(updates.weekly_token_quota);
  }
  if (updates.rate_multiplier !== undefined) {
    fields.push('rate_multiplier = ?');
    values.push(updates.rate_multiplier);
  }
  if (updates.trial_days !== undefined) {
    fields.push('trial_days = ?');
    values.push(updates.trial_days);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sort_order);
  }
  if (updates.display_price !== undefined) {
    fields.push('display_price = ?');
    values.push(updates.display_price);
  }
  if (updates.highlight !== undefined) {
    fields.push('highlight = ?');
    values.push(updates.highlight ? 1 : 0);
  }
  if (updates.max_groups !== undefined) {
    fields.push('max_groups = ?');
    values.push(updates.max_groups);
  }
  if (updates.max_concurrent_containers !== undefined) {
    fields.push('max_concurrent_containers = ?');
    values.push(updates.max_concurrent_containers);
  }
  if (updates.max_im_channels !== undefined) {
    fields.push('max_im_channels = ?');
    values.push(updates.max_im_channels);
  }
  if (updates.max_mcp_servers !== undefined) {
    fields.push('max_mcp_servers = ?');
    values.push(updates.max_mcp_servers);
  }
  if (updates.max_storage_mb !== undefined) {
    fields.push('max_storage_mb = ?');
    values.push(updates.max_storage_mb);
  }
  if (updates.allow_overage !== undefined) {
    fields.push('allow_overage = ?');
    values.push(updates.allow_overage ? 1 : 0);
  }
  if (updates.features !== undefined) {
    fields.push('features = ?');
    values.push(JSON.stringify(updates.features));
  }
  if (updates.is_default !== undefined) {
    fields.push('is_default = ?');
    values.push(updates.is_default ? 1 : 0);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.transaction(() => {
    // Clear old default BEFORE setting new one to avoid brief dual-default state
    if (updates.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE id != ?',
      ).run(id);
    }
    db.prepare(
      `UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  })();
}

export function deleteBillingPlan(id: string): boolean {
  // Don't delete if users are subscribed
  const hasSubscribers = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(id) as { cnt: number };
  if (hasSubscribers.cnt > 0) return false;
  const result = db.prepare('DELETE FROM billing_plans WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapBillingPlanRow(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    tier: Number(row.tier) || 0,
    monthly_cost_usd: Number(row.monthly_cost_usd) || 0,
    monthly_token_quota:
      row.monthly_token_quota != null ? Number(row.monthly_token_quota) : null,
    monthly_cost_quota:
      row.monthly_cost_quota != null ? Number(row.monthly_cost_quota) : null,
    daily_cost_quota:
      row.daily_cost_quota != null ? Number(row.daily_cost_quota) : null,
    weekly_cost_quota:
      row.weekly_cost_quota != null ? Number(row.weekly_cost_quota) : null,
    daily_token_quota:
      row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
    weekly_token_quota:
      row.weekly_token_quota != null ? Number(row.weekly_token_quota) : null,
    rate_multiplier: Number(row.rate_multiplier) || 1.0,
    trial_days:
      row.trial_days != null ? Number(row.trial_days) : null,
    sort_order: Number(row.sort_order) || 0,
    display_price:
      typeof row.display_price === 'string' ? row.display_price : null,
    highlight: !!(row.highlight as number),
    max_groups: row.max_groups != null ? Number(row.max_groups) : null,
    max_concurrent_containers:
      row.max_concurrent_containers != null
        ? Number(row.max_concurrent_containers)
        : null,
    max_im_channels:
      row.max_im_channels != null ? Number(row.max_im_channels) : null,
    max_mcp_servers:
      row.max_mcp_servers != null ? Number(row.max_mcp_servers) : null,
    max_storage_mb:
      row.max_storage_mb != null ? Number(row.max_storage_mb) : null,
    allow_overage: !!(row.allow_overage as number),
    features: safeParseJsonArray(row.features),
    is_default: !!(row.is_default as number),
    is_active: !!(row.is_active as number),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function safeParseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- User Subscriptions ---

export function getUserActiveSubscription(
  userId: string,
): (UserSubscription & { plan: BillingPlan }) | undefined {
  const row = db
    .prepare(
      `SELECT s.*, p.name as plan_name FROM user_subscriptions s
       JOIN billing_plans p ON s.plan_id = p.id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const plan = getBillingPlan(String(row.plan_id));
  if (!plan) return undefined;
  return { ...mapSubscriptionRow(row), plan };
}

export function createUserSubscription(sub: UserSubscription): void {
  // Cancel existing active subscriptions
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(new Date().toISOString(), sub.user_id);

  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sub.id,
    sub.user_id,
    sub.plan_id,
    sub.status,
    sub.started_at,
    sub.expires_at,
    sub.cancelled_at,
    sub.trial_ends_at,
    sub.notes,
    sub.auto_renew ? 1 : 0,
    sub.created_at,
  );

  // Update user's subscription_plan_id
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    sub.plan_id,
    sub.user_id,
  );
}

export function cancelUserSubscription(userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(now, userId);
  db.prepare(
    'UPDATE users SET subscription_plan_id = NULL WHERE id = ?',
  ).run(userId);
}

export function expireSubscriptions(): number {
  const now = new Date().toISOString();

  // Phase 1: Handle auto_renew=1 subscriptions — renew them instead of expiring
  const renewableRows = db
    .prepare(
      "SELECT * FROM user_subscriptions WHERE status = 'active' AND auto_renew = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(now) as Record<string, unknown>[];

  let renewed = 0;
  for (const row of renewableRows) {
    const userId = String(row.user_id);
    const planId = String(row.plan_id);
    const oldId = String(row.id);
    const oldStarted = String(row.started_at);
    const oldExpires = String(row.expires_at);

    // Calculate same duration as original subscription
    const startMs = new Date(oldStarted).getTime();
    const expiresMs = new Date(oldExpires).getTime();
    const durationMs = expiresMs - startMs;
    if (durationMs <= 0) continue;

    const plan = getBillingPlan(planId);
    if (!plan || !plan.is_active) {
      // Plan no longer active, expire instead
      continue;
    }

    // Check if user has sufficient balance for paid plans
    if (plan.monthly_cost_usd > 0) {
      const balance = getUserBalance(userId);
      if (balance.balance_usd < plan.monthly_cost_usd) {
        // Insufficient balance, expire instead
        logBillingAudit('subscription_expired', userId, null, {
          planId,
          planName: plan.name,
          reason: 'insufficient_balance_for_renewal',
          balance: balance.balance_usd,
          required: plan.monthly_cost_usd,
        });
        continue;
      }
    }

    // Wrap the entire renewal in a transaction for atomicity
    const renewTx = db.transaction(() => {
      // Deduct subscription cost (if paid plan)
      if (plan.monthly_cost_usd > 0) {
        adjustUserBalance(
          userId,
          -plan.monthly_cost_usd,
          'deduction',
          `自动续费: ${plan.name}`,
          'subscription',
          oldId,
          null,
          null,
          {
            source: 'subscription_renewal',
            operatorType: 'system',
            notes: `自动续费扣款: ${plan.name}`,
          },
        );
      }

      // Expire old subscription
      db.prepare(
        "UPDATE user_subscriptions SET status = 'expired' WHERE id = ?",
      ).run(oldId);

      // Create new subscription with same duration
      const newNow = new Date();
      const newExpires = new Date(newNow.getTime() + durationMs).toISOString();
      const newSub = {
        id: `sub_${userId}_${Date.now()}_renew`,
        user_id: userId,
        plan_id: planId,
        status: 'active',
        started_at: newNow.toISOString(),
        expires_at: newExpires,
        cancelled_at: null,
        trial_ends_at: null,
        notes: '自动续费',
        auto_renew: 1,
        created_at: newNow.toISOString(),
      };

      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newSub.id, newSub.user_id, newSub.plan_id, newSub.status,
        newSub.started_at, newSub.expires_at, newSub.cancelled_at,
        newSub.trial_ends_at, newSub.notes, newSub.auto_renew, newSub.created_at,
      );

      logBillingAudit('subscription_assigned', userId, null, {
        planId,
        planName: plan.name,
        autoRenew: true,
        renewedFrom: oldId,
      });
    });

    try {
      renewTx();
      renewed++;
    } catch (err) {
      logBillingAudit('subscription_expired', userId, null, {
        planId,
        planName: plan.name,
        reason: 'renewal_transaction_failed',
        error: String(err),
      });
    }
  }

  // Phase 2: Expire remaining (non-auto-renew or failed renewal)
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .run(now);
  return result.changes + renewed;
}

export function updateSubscriptionAutoRenew(
  userId: string,
  autoRenew: boolean,
): boolean {
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET auto_renew = ? WHERE user_id = ? AND status = 'active'",
    )
    .run(autoRenew ? 1 : 0, userId);
  return result.changes > 0;
}

function mapSubscriptionRow(row: Record<string, unknown>): UserSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    status: String(row.status) as UserSubscription['status'],
    started_at: String(row.started_at),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    cancelled_at:
      typeof row.cancelled_at === 'string' ? row.cancelled_at : null,
    trial_ends_at:
      typeof row.trial_ends_at === 'string' ? row.trial_ends_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    auto_renew: !!(row.auto_renew as number),
    created_at: String(row.created_at),
  };
}

// --- User Balances ---

export function getUserBalance(userId: string): UserBalance {
  const row = db
    .prepare('SELECT * FROM user_balances WHERE user_id = ?')
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    // Auto-init balance
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);
    return {
      user_id: userId,
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: now,
    };
  }
  return {
    user_id: String(row.user_id),
    balance_usd: Number(row.balance_usd) || 0,
    total_deposited_usd: Number(row.total_deposited_usd) || 0,
    total_consumed_usd: Number(row.total_consumed_usd) || 0,
    updated_at: String(row.updated_at),
  };
}

export function adjustUserBalance(
  userId: string,
  amount: number,
  type: BalanceTransactionType,
  description: string | null,
  referenceType: BalanceReferenceType | null,
  referenceId: string | null,
  actorId: string | null,
  idempotencyKey?: string | null,
  options?: {
    source?: BalanceTransactionSource;
    operatorType?: BalanceOperatorType;
    notes?: string | null;
    allowNegative?: boolean;
  },
): BalanceTransaction {
  const source = options?.source ?? 'system_adjustment';
  const operatorType = options?.operatorType ?? 'system';
  const notes = options?.notes ?? description ?? null;
  const allowNegative = options?.allowNegative ?? false;

  // Idempotency check: if key already used, return the existing transaction
  if (idempotencyKey) {
    const existing = db
      .prepare(
        'SELECT * FROM balance_transactions WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: Number(existing.id),
        user_id: String(existing.user_id),
        type: String(existing.type) as BalanceTransactionType,
        amount_usd: Number(existing.amount_usd),
        balance_after: Number(existing.balance_after),
        description: typeof existing.description === 'string' ? existing.description : null,
        reference_type: typeof existing.reference_type === 'string' ? existing.reference_type as BalanceReferenceType : null,
        reference_id: typeof existing.reference_id === 'string' ? existing.reference_id : null,
        actor_id: typeof existing.actor_id === 'string' ? existing.actor_id : null,
        source:
          typeof existing.source === 'string'
            ? (existing.source as BalanceTransactionSource)
            : 'system_adjustment',
        operator_type:
          typeof existing.operator_type === 'string'
            ? (existing.operator_type as BalanceOperatorType)
            : 'system',
        notes: typeof existing.notes === 'string' ? existing.notes : null,
        idempotency_key:
          typeof existing.idempotency_key === 'string'
            ? existing.idempotency_key
            : null,
        created_at: String(existing.created_at),
      };
    }
  }

  const now = new Date().toISOString();

  // Wrap read-check-update-record in a transaction for atomicity
  const txFn = db.transaction(() => {
    // Ensure balance row exists
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);

    const currentRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const currentBalance = Number(currentRow.balance_usd);
    const nextBalance = currentBalance + amount;
    if (!allowNegative && nextBalance < 0) {
      throw new Error(
        `Balance cannot be negative: current=${currentBalance.toFixed(2)} next=${nextBalance.toFixed(2)}`,
      );
    }

    // Update balance
    if (amount > 0) {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_deposited_usd = total_deposited_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, amount, now, userId);
    } else {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_consumed_usd = total_consumed_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, Math.abs(amount), now, userId);
    }

    // Read new balance within the same transaction
    const newRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const balanceAfter = Number(newRow.balance_usd);

    // Record transaction
    const result = db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      type,
      amount,
      balanceAfter,
      description,
      referenceType,
      referenceId,
      actorId,
      source,
      operatorType,
      notes,
      now,
      idempotencyKey ?? null,
    );

    return {
      id: Number(result.lastInsertRowid),
      balanceAfter,
    };
  });

  const { id: txId, balanceAfter } = txFn();

  return {
    id: txId,
    user_id: userId,
    type,
    amount_usd: amount,
    balance_after: balanceAfter,
    description,
    reference_type: referenceType,
    reference_id: referenceId,
    actor_id: actorId,
    source,
    operator_type: operatorType,
    notes,
    idempotency_key: idempotencyKey ?? null,
    created_at: now,
  };
}

export function getBalanceTransactions(
  userId: string,
  limit = 50,
  offset = 0,
): { transactions: BalanceTransaction[]; total: number } {
  const total = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM balance_transactions WHERE user_id = ?',
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    transactions: rows.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      type: String(r.type) as BalanceTransactionType,
      amount_usd: Number(r.amount_usd),
      balance_after: Number(r.balance_after),
      description: typeof r.description === 'string' ? r.description : null,
      reference_type: typeof r.reference_type === 'string'
        ? (r.reference_type as BalanceReferenceType)
        : null,
      reference_id:
        typeof r.reference_id === 'string' ? r.reference_id : null,
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      source:
        typeof r.source === 'string'
          ? (r.source as BalanceTransactionSource)
          : 'system_adjustment',
      operator_type:
        typeof r.operator_type === 'string'
          ? (r.operator_type as BalanceOperatorType)
          : 'system',
      notes: typeof r.notes === 'string' ? r.notes : null,
      idempotency_key:
        typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Monthly Usage ---

function mapMonthlyUsageRow(row: Record<string, unknown>): MonthlyUsage {
  return {
    user_id: String(row.user_id),
    month: String(row.month),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
    updated_at: String(row.updated_at),
  };
}

export function getMonthlyUsage(
  userId: string,
  month: string,
): MonthlyUsage | undefined {
  const row = db
    .prepare(
      'SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?',
    )
    .get(userId, month) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapMonthlyUsageRow(row);
}

export function incrementMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, now);
}

export function getUserMonthlyUsageHistory(
  userId: string,
  months = 6,
): MonthlyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM monthly_usage WHERE user_id = ? ORDER BY month DESC LIMIT ?',
      )
      .all(userId, months) as Record<string, unknown>[]
  ).map(mapMonthlyUsageRow);
}

// --- Redeem Codes ---

export function getRedeemCode(code: string): RedeemCode | undefined {
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapRedeemCodeRow(row);
}

export function getAllRedeemCodes(): RedeemCode[] {
  return (
    db
      .prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(mapRedeemCodeRow);
}

export function createRedeemCode(code: RedeemCode): void {
  db.prepare(
    `INSERT INTO redeem_codes (code, type, value_usd, plan_id, duration_days, max_uses, used_count, expires_at, created_by, notes, batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code.code,
    code.type,
    code.value_usd,
    code.plan_id,
    code.duration_days,
    code.max_uses,
    code.used_count,
    code.expires_at,
    code.created_by,
    code.notes,
    code.batch_id,
    code.created_at,
  );
}

export function incrementRedeemCodeUsage(code: string, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?',
  ).run(code);
  db.prepare(
    'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
  ).run(code, userId, now);
}

export function deleteRedeemCode(code: string): boolean {
  const result = db.prepare('DELETE FROM redeem_codes WHERE code = ?').run(code);
  return result.changes > 0;
}

export function hasUserRedeemedCode(
  userId: string,
  code: string,
): boolean {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM redeem_code_usage WHERE user_id = ? AND code = ?',
    )
    .get(userId, code) as { cnt: number };
  return row.cnt > 0;
}

function mapRedeemCodeRow(row: Record<string, unknown>): RedeemCode {
  return {
    code: String(row.code),
    type: String(row.type) as RedeemCode['type'],
    value_usd: row.value_usd != null ? Number(row.value_usd) : null,
    plan_id: typeof row.plan_id === 'string' ? row.plan_id : null,
    duration_days:
      row.duration_days != null ? Number(row.duration_days) : null,
    max_uses: Number(row.max_uses) || 1,
    used_count: Number(row.used_count) || 0,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_by: String(row.created_by),
    notes: typeof row.notes === 'string' ? row.notes : null,
    batch_id: typeof row.batch_id === 'string' ? row.batch_id : null,
    created_at: String(row.created_at),
  };
}

// --- Billing Audit Log ---

export function logBillingAudit(
  eventType: BillingAuditEventType,
  userId: string,
  actorId: string | null,
  details: Record<string, unknown> | null,
): void {
  db.prepare(
    'INSERT INTO billing_audit_log (event_type, user_id, actor_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    eventType,
    userId,
    actorId,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

export function getBillingAuditLog(
  limit = 50,
  offset = 0,
  userId?: string,
  eventType?: string,
): { logs: BillingAuditLog[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM billing_audit_log ${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      `SELECT * FROM billing_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      event_type: String(r.event_type) as BillingAuditEventType,
      user_id: String(r.user_id),
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      details: typeof r.details === 'string'
        ? (JSON.parse(r.details) as Record<string, unknown>)
        : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Billing summary helpers ---

export function getUserGroupCount(userId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT rg.folder) as cnt FROM registered_groups rg WHERE rg.created_by = ? AND rg.jid LIKE 'web:%'",
    )
    .get(userId) as { cnt: number };
  return row.cnt;
}

export function getAllUserBillingOverview(): Array<{
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  plan_id: string | null;
  plan_name: string | null;
  balance_usd: number;
  current_month_cost: number;
}> {
  const month = new Date().toISOString().slice(0, 7);
  return db
    .prepare(
      `SELECT u.id as user_id, u.username, u.display_name, u.role,
              s.plan_id, p.name as plan_name,
              COALESCE(b.balance_usd, 0) as balance_usd,
              COALESCE(mu.total_cost_usd, 0) as current_month_cost
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       LEFT JOIN user_balances b ON b.user_id = u.id
       LEFT JOIN monthly_usage mu ON mu.user_id = u.id AND mu.month = ?
       WHERE u.status != 'deleted'
       ORDER BY u.created_at ASC`,
    )
    .all(month) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    plan_id: string | null;
    plan_name: string | null;
    balance_usd: number;
    current_month_cost: number;
  }>;
}

export function getRevenueStats(): {
  totalDeposited: number;
  totalConsumed: number;
  activeSubscriptions: number;
  currentMonthRevenue: number;
} {
  const month = new Date().toISOString().slice(0, 7);
  const deposited = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_deposited_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const consumed = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_consumed_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const activeSubs = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;
  const monthRevenue = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;
  return {
    totalDeposited: deposited,
    totalConsumed: consumed,
    activeSubscriptions: activeSubs,
    currentMonthRevenue: monthRevenue,
  };
}

// --- Daily Usage ---

function mapDailyUsageRow(row: Record<string, unknown>): DailyUsage {
  return {
    user_id: String(row.user_id),
    date: String(row.date),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
  };
}

export function incrementDailyUsage(
  userId: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `INSERT INTO daily_usage (user_id, date, total_input_tokens, total_output_tokens, total_cost_usd, message_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1`,
  ).run(userId, date, inputTokens, outputTokens, costUsd);
}

export function getDailyUsage(
  userId: string,
  date: string,
): DailyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM daily_usage WHERE user_id = ? AND date = ?')
    .get(userId, date) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapDailyUsageRow(row);
}

export function getWeeklyUsageSummary(
  userId: string,
): { totalCost: number; totalTokens: number } {
  // Align to calendar week (Monday–Sunday) to match checkQuota() reset logic
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  const startDate = monday.toISOString().slice(0, 10);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as totalTokens
       FROM daily_usage WHERE user_id = ? AND date >= ?`,
    )
    .get(userId, startDate) as { totalCost: number; totalTokens: number };
  return { totalCost: row.totalCost, totalTokens: row.totalTokens };
}

export function getUserDailyUsageHistory(
  userId: string,
  days = 14,
): DailyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT ?',
      )
      .all(userId, days) as Record<string, unknown>[]
  ).map(mapDailyUsageRow);
}

export function getDailyUsageSumForMonth(
  userId: string,
  month: string,
): { totalInputTokens: number; totalOutputTokens: number; totalCost: number; messageCount: number } {
  const startDate = `${month}-01`;
  // End date: first day of next month
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_input_tokens), 0) as totalInputTokens,
              COALESCE(SUM(total_output_tokens), 0) as totalOutputTokens,
              COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(message_count), 0) as messageCount
       FROM daily_usage WHERE user_id = ? AND date >= ? AND date < ?`,
    )
    .get(userId, startDate, endDate) as {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    messageCount: number;
  };
  return row;
}

export function correctMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  messageCount: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cost_usd = excluded.total_cost_usd,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, messageCount, now);
}

export function getSubscriptionHistory(
  userId: string,
): (UserSubscription & { plan_name: string })[] {
  return (
    db
      .prepare(
        `SELECT s.*, p.name as plan_name FROM user_subscriptions s
         JOIN billing_plans p ON s.plan_id = p.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[]
  ).map((row) => ({
    ...mapSubscriptionRow(row),
    plan_name: String(row.plan_name),
  }));
}

export function getRedeemCodeUsageDetails(
  code: string,
): Array<{ user_id: string; username: string; redeemed_at: string }> {
  return db
    .prepare(
      `SELECT rcu.user_id, u.username, rcu.redeemed_at
       FROM redeem_code_usage rcu
       LEFT JOIN users u ON u.id = rcu.user_id
       WHERE rcu.code = ?
       ORDER BY rcu.redeemed_at DESC`,
    )
    .all(code) as Array<{
    user_id: string;
    username: string;
    redeemed_at: string;
  }>;
}

export function getDashboardStats(): {
  activeUsers: number;
  totalUsers: number;
  planDistribution: Array<{ plan_name: string; count: number }>;
  todayCost: number;
  monthCost: number;
  activeSubscriptions: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const totalUsers = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status != 'deleted'")
      .get() as { cnt: number }
  ).cnt;

  const activeUsers = (
    db.prepare(
      "SELECT COUNT(DISTINCT user_id) as cnt FROM daily_usage WHERE date = ?",
    ).get(today) as { cnt: number }
  ).cnt;

  const planDistribution = db
    .prepare(
      `SELECT COALESCE(p.name, '无套餐') as plan_name, COUNT(*) as count
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       WHERE u.status != 'deleted'
       GROUP BY p.name
       ORDER BY count DESC`,
    )
    .all() as Array<{ plan_name: string; count: number }>;

  const todayCost = (
    db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM daily_usage WHERE date = ?',
    ).get(today) as { total: number }
  ).total;

  const monthCost = (
    db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
    ).get(month) as { total: number }
  ).total;

  const activeSubscriptions = (
    db.prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
    ).get() as { cnt: number }
  ).cnt;

  return {
    activeUsers,
    totalUsers,
    planDistribution,
    todayCost,
    monthCost,
    activeSubscriptions,
  };
}

export function getRevenueTrend(
  months = 6,
): Array<{ month: string; revenue: number; users: number }> {
  return db
    .prepare(
      `SELECT month, SUM(total_cost_usd) as revenue, COUNT(DISTINCT user_id) as users
       FROM monthly_usage
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
    )
    .all(months) as Array<{ month: string; revenue: number; users: number }>;
}

export function batchAssignPlan(
  userIds: string[],
  planId: string,
  actorId: string,
  durationDays?: number,
): number {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);

  const now = new Date();
  const expiresAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  let count = 0;
  const txn = db.transaction(() => {
    for (const userId of userIds) {
      // Cancel existing
      db.prepare(
        "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
      ).run(now.toISOString(), userId);

      const subId = `sub_${userId}_${Date.now()}_${count}`;
      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, auto_renew, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      ).run(subId, userId, planId, now.toISOString(), expiresAt, now.toISOString());

      db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
        planId,
        userId,
      );

      logBillingAudit('subscription_assigned', userId, actorId, {
        planId,
        planName: plan.name,
        durationDays: durationDays ?? null,
        batch: true,
      });
      count++;
    }
  });
  txn();
  return count;
}

export function getPlanSubscriberCount(planId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(planId) as { cnt: number };
  return row.cnt;
}

export function getAllPlanSubscriberCounts(): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT plan_id, COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id",
    )
    .all() as Array<{ plan_id: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.plan_id] = row.cnt;
  }
  return result;
}


/**
 * Atomically increment redeem code usage with optimistic locking.
 * Returns true if the increment succeeded (used_count < max_uses).
 */
export function tryIncrementRedeemCodeUsage(
  code: string,
  userId: string,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db
      .prepare(
        'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
      )
      .run(code);
    if (result.changes === 0) return false;
    db.prepare(
      'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).run(code, userId, now);
    return true;
  })();
}

/**
 * Close the database connection.
 * Should be called during graceful shutdown.
 */
export function closeDatabase(): void {
  _stmts = null;
  _newMsgStmtCache.clear();
  if (db) {
    db.close();
  }
}
