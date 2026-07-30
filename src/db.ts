import crypto from 'crypto';
import Database from './sqlite-compat.js';
import fs from 'fs';
import path from 'path';

import { STORE_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AgentProfile,
  AgentBuilderDefinition,
  AgentBuilderDraft,
  AgentProfilePromptMode,
  AgentProfilePrompts,
  AgentProfilePromptVersion,
  AgentProfileRuntimePolicy,
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
  ChannelMount,
  ChannelTurnContext,
  ChannelAccount,
  ChannelProvider,
  DailyUsage,
  ExecutionMode,
  InviteCode,
  InviteCodeWithCreator,
  InteractionMode,
  MessageFinalizationReason,
  FollowUpMode,
  FollowUpStatus,
  QueuedFollowUp,
  MonthlyUsage,
  NewMessage,
  MessageCursor,
  MessageSourceKind,
  ImContextBinding,
  RedeemCode,
  RegisteredGroup,
  ScheduledTask,
  SubAgent,
  ClaimedTaskRun,
  TaskRun,
  TaskRunDefinitionSnapshot,
  TaskRunNotificationStatus,
  TaskRunNotificationSummary,
  TaskRunStatus,
  TaskRunTrigger,
  TaskRunLog,
  User,
  UserBalance,
  UserPublic,
  UserStatus,
  UserRole,
  UserSubscription,
  UserSession,
  UserSessionWithUser,
  WorkspaceAgentProfileBinding,
  Permission,
  PermissionTemplateKey,
} from './types.js';
import { getDefaultPermissions, normalizePermissions } from './permissions.js';
import { channelConversationJid } from './channel-address.js';
import { getChannelFromJid } from './channel-prefixes.js';
import { parseAudienceMode } from './im-audience-policy.js';
import { parseContainerConfig } from './mount-security.js';
import {
  includeClaudePresetForMode,
  normalizeAgentProfilePrompts,
  promptModeFromLegacyPreset,
} from './agent-profile-prompts.js';
import {
  bindChannelReliabilityDatabase,
  createChannelReliabilitySchema,
} from './channel-reliability-store.js';
import {
  bindWorkspaceMemoryDatabase,
  createWorkspaceMemorySchema,
  deleteWorkspaceMemoryData,
  enforceHappyClawOwnerAddressCanonicalInvariant,
  resetWorkspaceMemoryData,
} from './memory-store.js';
import {
  bindOwnerProfileDatabase,
  createOwnerProfileSchema,
  HAPPYCLAW_OWNER_INTRODUCTION_FLOW_KEY,
  reconcileLegacyOwnerProfileMemory,
} from './owner-profile-store.js';
import { splitLegacyEmbeddedReferenceContent } from './message-prompt.js';

let db: InstanceType<typeof Database>;
/**
 * Exported so migration tests can assert "an old database reaches head" without
 * restating the number. Hardcoding it meant every schema bump edited a dozen
 * unrelated test files, which is churn that hides real assertion changes.
 */
export const CURRENT_SCHEMA_VERSION = 67;

export function isDatabaseInitialized(): boolean {
  return Boolean(db?.open);
}

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
         WHERE chat_jid = ? AND turn_id = ?
           AND source_kind IN ('sdk_final','truncation_continue','scheduled_task_result')
         ORDER BY timestamp DESC LIMIT 1`,
      ),
      storeMessageInsert: db.prepare(
        `INSERT OR REPLACE INTO messages (
          id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me,
          attachments, token_usage, channel_context, turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, task_id,
          delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageInsert: db.prepare(
        `INSERT INTO usage_records (id, event_id, user_id, group_folder, agent_id, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          reasoning_output_tokens,
          cost_usd, provider_estimated_cost_usd, billed_cost_usd,
          duration_ms, num_turns, source, usage_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageUpsert: db.prepare(
        `INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_reasoning_tokens, total_cost_usd, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(user_id, model, date) DO UPDATE SET
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_reasoning_tokens = total_reasoning_tokens + excluded.total_reasoning_tokens,
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
        `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, channel_context, source_kind, task_id,
                delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
         FROM messages
         WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND is_from_me = 0
           AND COALESCE(delivery_status, '') NOT IN ('queued', 'promoting', 'cancelled')
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
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, channel_context, source_kind, task_id,
              delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
       FROM messages
       WHERE (timestamp > ? OR (timestamp = ? AND id > ?))
         AND chat_jid IN (${placeholders})
         AND is_from_me = 0
         AND COALESCE(source_kind, '') NOT IN ('user_command', 'scheduled_task_prompt')
         AND COALESCE(delivery_status, '') NOT IN ('queued', 'promoting', 'cancelled')
       ORDER BY timestamp ASC, id ASC`,
    );
    // Cap cache size to avoid unbounded growth in deployments where the
    // distinct jidCount values shift over time. better-sqlite3 does not
    // explicitly require finalization for prepared statements (it relies on
    // GC), so dropping the reference is safe. 64 entries covers any plausible
    // workload (the cache key is # of jids polled in one batch, normally 1..32).
    if (_newMsgStmtCache.size >= 64) {
      const firstKey = _newMsgStmtCache.keys().next().value as
        | number
        | undefined;
      if (firstKey !== undefined) _newMsgStmtCache.delete(firstKey);
    }
    _newMsgStmtCache.set(jidCount, s);
  } else {
    // touch — LRU: re-insert to move to end (Map preserves insertion order).
    _newMsgStmtCache.delete(jidCount);
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
  deliveryMode?: FollowUpMode | null;
  deliveryStatus?: FollowUpStatus | null;
  deliveryRunId?: string | null;
  deliveryPriority?: number | null;
  deliveryUpdatedAt?: string | null;
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

function tableExists(tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

function reportKnownForeignKeyOrphans(): void {
  if (!tableExists('users')) return;
  const specs: Array<{
    childTable: string;
    childColumn: string;
    parentTable: string;
    parentColumn: string;
  }> = [
    {
      childTable: 'user_balances',
      childColumn: 'user_id',
      parentTable: 'users',
      parentColumn: 'id',
    },
    {
      childTable: 'user_sessions',
      childColumn: 'user_id',
      parentTable: 'users',
      parentColumn: 'id',
    },
    {
      childTable: 'user_subscriptions',
      childColumn: 'user_id',
      parentTable: 'users',
      parentColumn: 'id',
    },
    {
      childTable: 'balance_transactions',
      childColumn: 'user_id',
      parentTable: 'users',
      parentColumn: 'id',
    },
  ];

  for (const spec of specs) {
    if (!tableExists(spec.childTable) || !tableExists(spec.parentTable)) {
      continue;
    }
    const result = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${spec.childTable}
         WHERE ${spec.childColumn} IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ${spec.parentTable}
             WHERE ${spec.parentTable}.${spec.parentColumn} = ${spec.childTable}.${spec.childColumn}
           )`,
      )
      .get() as { count: number };
    if (result.count > 0) {
      logger.warn(
        {
          table: spec.childTable,
          parentTable: spec.parentTable,
          rows: result.count,
        },
        'Preserving orphaned rows for operator review before foreign-key enforcement',
      );
    }
  }
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Create a self-contained, consistent snapshot before upgrading an existing
 * database. VACUUM INTO reads through SQLite's transaction layer, so committed
 * WAL pages are included. This function intentionally runs before any schema
 * or data-reconciliation write; a backup failure aborts startup.
 */
function createPreMigrationBackup(dbPath: string, schemaVersion: number): void {
  const configuredDir = process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  const backupDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(path.dirname(dbPath), 'migration-backups');
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `messages-v${schemaVersion}-to-v${CURRENT_SCHEMA_VERSION}-${timestamp}-${process.pid}.db`,
  );

  let probe: InstanceType<typeof Database> | undefined;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    db.exec(`VACUUM INTO ${sqliteStringLiteral(backupPath)}`);
    probe = new Database(backupPath);
    const result = probe.pragma('quick_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`quick_check returned ${String(result)}`);
    }
    probe.close();
    probe = undefined;
    fs.chmodSync(backupPath, 0o600);
    logger.info(
      {
        backupPath,
        fromVersion: schemaVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
      },
      'Created pre-migration SQLite backup',
    );
  } catch (error) {
    try {
      probe?.close();
    } catch {
      // Preserve the original backup/validation error.
    }
    for (const candidate of [
      backupPath,
      `${backupPath}-wal`,
      `${backupPath}-shm`,
    ]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Cleanup must not hide the backup failure that blocks migration.
      }
    }
    throw new Error(
      `Refusing database migration v${schemaVersion}→v${CURRENT_SCHEMA_VERSION}: pre-migration backup failed`,
      { cause: error },
    );
  }
}

function enforcePreMigrationBackup(dbPath: string): void {
  const rawVersion = getRouterStateInternal('schema_version');
  if (rawVersion === undefined) {
    // Pre-versioned installations (and partially damaged router_state rows)
    // can still carry the legacy memory chunk index. v67 drops those tables,
    // so treat their presence as an upgrade even without a version marker.
    // A genuinely fresh database has neither table and must not create an
    // empty, misleading migration backup.
    if (tableExists('memory_chunks') || tableExists('memory_chunks_fts')) {
      createPreMigrationBackup(dbPath, 0);
    }
    return;
  }

  const schemaVersion = Number(rawVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error(`Invalid database schema version: ${rawVersion}`);
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${schemaVersion} is newer than supported v${CURRENT_SCHEMA_VERSION}; refusing downgrade`,
    );
  }
  if (schemaVersion >= 39 && schemaVersion < CURRENT_SCHEMA_VERSION) {
    createPreMigrationBackup(dbPath, schemaVersion);
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  db.exec('PRAGMA busy_timeout = 5000');
  const rawSchemaVersionBeforeInit =
    getRouterStateInternal('schema_version') ?? null;
  try {
    enforcePreMigrationBackup(dbPath);
  } catch (error) {
    db.close();
    throw error;
  }

  // Enable WAL mode for better concurrency and performance only after the
  // upgrade backup gate has completed without mutating the source schema.
  db.exec('PRAGMA journal_mode = WAL');
  // WAL + NORMAL is the documented safe pairing: commits stop fsyncing the
  // WAL on every transaction (measured 21x on this driver's synchronous
  // writes) while checkpoints still sync. Worst case on power loss is losing
  // the last instants of committed work, never corruption.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
  reportKnownForeignKeyOrphans();
  // Enable foreign-key enforcement. SQLite defaults to OFF for backward
  // compatibility, so all FK declarations on existing schemas are silent
  // no-ops without this PRAGMA. `messages → chats` orphans are the residue of
  // an interrupted chat-deletion cascade, so completing that cascade here is
  // safe and keeps enforcement on. Any other violation class (e.g. billing
  // rows deliberately preserved for operator review) still resets enforcement
  // to OFF, because turning it on with violations would refuse the next write.
  try {
    db.exec('PRAGMA foreign_keys = ON');
    let violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }>;
    const messageOrphans = violations.filter(
      (v) => v.table === 'messages' && v.parent === 'chats',
    );
    if (messageOrphans.length > 0 && tableExists('chats')) {
      const repaired = db
        .prepare(
          'DELETE FROM messages WHERE chat_jid NOT IN (SELECT jid FROM chats)',
        )
        .run().changes;
      logger.info(
        { repaired },
        'Removed orphaned messages left behind by an interrupted chat deletion',
      );
      violations = db
        .prepare('PRAGMA foreign_key_check')
        .all() as typeof violations;
    }
    if (violations.length > 0) {
      const summary = violations
        .slice(0, 10)
        .map((v) => `${v.table} → ${v.parent}`)
        .join(', ');
      logger.warn(
        { violationCount: violations.length, sample: summary },
        'Foreign-key violations detected; disabling enforcement to avoid blocking writes. Clean up orphans (PRAGMA foreign_key_check) and restart to re-enable.',
      );
      db.exec('PRAGMA foreign_keys = OFF');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to enable foreign-key enforcement');
  }
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
      channel_context TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      delivery_mode TEXT,
      delivery_status TEXT,
      delivery_run_id TEXT,
      delivery_priority INTEGER NOT NULL DEFAULT 0,
      delivery_updated_at TEXT,
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
      notify_channels TEXT,
      running_until TEXT,
      runner_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
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

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL,
      idempotency_key TEXT,
      scheduled_for TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notification_error TEXT,
      notification_summary TEXT,
      notification_payload TEXT,
      notification_attempt INTEGER NOT NULL DEFAULT 0,
      notification_available_at TEXT,
      notification_lease_owner TEXT,
      notification_lease_token INTEGER NOT NULL DEFAULT 0,
      notification_lease_expires_at TEXT,
      notification_lease_payload TEXT,
      notification_generation INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_manual_idempotency
      ON task_runs(task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_one_nonterminal
      ON task_runs(task_id)
      WHERE status IN ('queued', 'running', 'retry_wait');
    CREATE INDEX IF NOT EXISTS idx_task_runs_due
      ON task_runs(status, available_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_runs_task_created
      ON task_runs(task_id, created_at DESC);
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
    CREATE TABLE IF NOT EXISTS channel_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_legacy_default INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT NOT NULL DEFAULT 'credentials',
      auth_status TEXT NOT NULL DEFAULT 'draft',
      transport_status TEXT NOT NULL DEFAULT 'disconnected',
      status TEXT NOT NULL DEFAULT 'disconnected',
      default_agent_profile_id TEXT,
      default_workspace_jid TEXT,
      last_error TEXT,
      connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, provider, name)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_accounts_owner_provider
      ON channel_accounts(owner_user_id, provider, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_one_default
      ON channel_accounts(owner_user_id, provider) WHERE is_default = 1;
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
    CREATE TABLE IF NOT EXISTS channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_workspace ON channel_mounts(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_session ON channel_mounts(session_id);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_type ON channel_mounts(channel_type);
    CREATE TABLE IF NOT EXISTS workspaces (
      jid TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_folder ON workspaces(folder);
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id, status);
    -- Runtime resume state projected from the legacy sessions table. This is
    -- deliberately not named sessions: product conversation Sessions live in
    -- agents, while these rows only track SDK/provider resume metadata.
    CREATE TABLE IF NOT EXISTS workspace_runtime_sessions (
      group_folder TEXT NOT NULL,
      runtime_agent_id TEXT NOT NULL DEFAULT '',
      workspace_jid TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT,
      agent_profile_id TEXT,
      agent_profile_version INTEGER,
      identity_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, runtime_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_workspace ON workspace_runtime_sessions(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_profile ON workspace_runtime_sessions(agent_profile_id);
    CREATE TABLE IF NOT EXISTS agent_channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      agent_profile_id TEXT,
      owner_user_id TEXT,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_profile ON agent_channel_mounts(agent_profile_id);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_workspace ON agent_channel_mounts(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_session ON agent_channel_mounts(session_id);
  `);

  // v64 -> v65: Workspace is the only durable memory continuity boundary.
  // Create and bind this before canonical projection reconciliation because
  // that pass can delete ghost workspaces and must also purge their memory
  // even when legacy FK violations forced foreign_keys=OFF.
  createWorkspaceMemorySchema(db);
  bindWorkspaceMemoryDatabase(db);

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
      default_require_mention INTEGER NOT NULL DEFAULT 0,
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

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // v65 -> v66: HappyClaw Owner Profile remains a reserved Workspace Memory
  // item; this table tracks only its one-shot onboarding lifecycle. Duplicate
  // legacy items must be reconciled before the reserved-key unique index is
  // installed.
  createOwnerProfileSchema(db);
  bindOwnerProfileDatabase(db);
  if (
    rawSchemaVersionBeforeInit !== null &&
    Number(rawSchemaVersionBeforeInit) < 66
  ) {
    reconcileLegacyOwnerProfileMemory();
  } else {
    // Fresh and already-v66 databases need the structural invariant, but must
    // not re-run legacy sentinel inference on every normal restart.
    enforceHappyClawOwnerAddressCanonicalInvariant();
  }

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

  // Top-level Agent Profiles: runtime identities/personas that own workspaces.
  // Do not confuse this with the legacy `agents` table above, which stores
  // workspace-scoped conversation/task/spawn agents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      include_claude_preset INTEGER NOT NULL DEFAULT 1,
      avatar_emoji TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      runtime_policy TEXT NOT NULL DEFAULT '{}',
      identity_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
      ON agent_profiles(owner_user_id)
      WHERE is_default = 1 AND status = 'active';
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_owner
      ON agent_profiles(owner_user_id, status);

    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL,
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);

    CREATE TABLE IF NOT EXISTS agent_builder_drafts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_chat_jid TEXT NOT NULL,
      target_agent_profile_id TEXT,
      base_agent_version INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'ready',
      definition_json TEXT NOT NULL,
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      prepared_turn_id TEXT,
      confirmation_phrase TEXT NOT NULL DEFAULT '',
      published_agent_profile_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_builder_drafts_owner
      ON agent_builder_drafts(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_agent_profiles (
      group_folder TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      interaction_mode TEXT NOT NULL DEFAULT 'assistant'
        CHECK (interaction_mode IN ('assistant', 'proactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_agent_profiles_profile
      ON workspace_agent_profiles(agent_profile_id);
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
      event_id TEXT,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      usage_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_date
      ON usage_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_group_date
      ON usage_events(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_agent_date
      ON usage_events(agent_id, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
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

  // v51 usage event ledger columns. These must be added before creating the
  // event/model uniqueness index because existing databases already have the
  // usage_records table.
  ensureColumn('usage_records', 'event_id', 'TEXT');
  ensureColumn(
    'usage_records',
    'provider_estimated_cost_usd',
    'REAL NOT NULL DEFAULT 0',
  );
  ensureColumn('usage_records', 'billed_cost_usd', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('usage_records', 'usage_date', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event_model
      ON usage_records(event_id, model) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_records(usage_date);
    CREATE INDEX IF NOT EXISTS idx_usage_user_usage_date
      ON usage_records(user_id, usage_date);
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
  // v56 -> v57: cache provider chat avatars so binding lists do not need an
  // N+1 provider lookup on every open. Provider sync refreshes this URL.
  ensureColumn('registered_groups', 'avatar_url', 'TEXT');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn(
    'users',
    'default_require_mention',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_mode', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_jid', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_folder', 'TEXT');
  ensureColumn('scheduled_tasks', 'running_until', 'TEXT');
  ensureColumn('scheduled_tasks', 'runner_id', 'TEXT');
  ensureColumn('scheduled_tasks', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('scheduled_tasks', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('scheduled_tasks', 'deleted_at', 'TEXT');
  // v62 -> v63: a task stored only the workspace-level `chat_jid`, so execution
  // had to re-derive its target and fell back to "any group in this folder,
  // preferring web:". Capture the concrete delivery route instead — HappyClaw's
  // JID already encodes provider, external chat, channel account and Feishu
  // thread/root, so one column carries the whole binding. Existing rows are
  // backfilled from `chat_jid`, which is exactly the route they used before.
  ensureColumn('scheduled_tasks', 'delivery_route_jid', 'TEXT');
  db.prepare(
    `UPDATE scheduled_tasks
     SET delivery_route_jid = chat_jid
     WHERE delivery_route_jid IS NULL AND chat_jid IS NOT NULL`,
  ).run();
  ensureColumn('task_runs', 'notification_summary', 'TEXT');
  ensureColumn('task_runs', 'notification_payload', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_attempt',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('task_runs', 'notification_available_at', 'TEXT');
  ensureColumn('task_runs', 'notification_lease_owner', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_lease_token',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('task_runs', 'notification_lease_expires_at', 'TEXT');
  ensureColumn('task_runs', 'notification_lease_payload', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_generation',
    'INTEGER NOT NULL DEFAULT 0',
  );
  // Old rows predate updated_at; created_at is the least-surprising baseline.
  db.prepare(
    "UPDATE scheduled_tasks SET updated_at = created_at WHERE updated_at = '' OR updated_at IS NULL",
  ).run();
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
  ensureColumn(
    'registered_groups',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  ensureColumn('registered_groups', 'owner_im_id', 'TEXT');
  ensureColumn('registered_groups', 'owner_claim_source', 'TEXT');
  // Existing owner anchors predate provenance and may include credentials that
  // were transferred between HappyClaw users. Keep them usable for legacy
  // owner-only commands, but never let an ordinary DM silently turn them into
  // Agent Builder trust; the user must re-pair or configure the owner in Web.
  db.prepare(
    `UPDATE registered_groups
     SET owner_claim_source = 'explicit'
     WHERE owner_im_id IS NOT NULL AND owner_im_id <> ''
       AND (owner_claim_source IS NULL OR owner_claim_source = '')`,
  ).run();
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
  ensureColumn(
    'registered_groups',
    'native_context_type',
    "TEXT DEFAULT 'none'",
  );
  ensureColumn('registered_groups', 'feishu_chat_mode', 'TEXT');
  ensureColumn('registered_groups', 'feishu_group_message_type', 'TEXT');
  ensureColumn('registered_groups', 'sender_allowlist', 'TEXT');
  ensureColumn(
    'channel_mounts',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  ensureColumn(
    'agent_channel_mounts',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  // v57 -> v58: split Feishu's composite owner_mentioned setting into two
  // orthogonal policies. Other providers keep their legacy mode until their
  // connector implements the same audience gate. This is a one-time semantic
  // migration: replaying it on every startup would overwrite a later explicit
  // user choice of audience_mode='everyone' whenever the durable owner anchor
  // (sender_allowlist) is still present.
  const audiencePolicySchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (audiencePolicySchemaVersion < 58) {
    db.exec(`
      UPDATE registered_groups
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only', require_mention = 1
      WHERE jid LIKE 'feishu:%' AND activation_mode = 'owner_mentioned';
      UPDATE registered_groups
      SET audience_mode = 'owner_only'
      WHERE jid LIKE 'feishu:%' AND sender_allowlist IS NOT NULL;
      UPDATE channel_mounts
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only'
      WHERE channel_type = 'feishu' AND activation_mode = 'owner_mentioned';
      UPDATE agent_channel_mounts
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only'
      WHERE channel_type = 'feishu' AND activation_mode = 'owner_mentioned';
    `);
  }
  // v58 -> v59: persist a sanitized, message-level channel context. Existing
  // rows intentionally remain NULL and continue to decode as context-less.
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'channel_context', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'sdk_message_uuid', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');
  ensureColumn('messages', 'task_id', 'TEXT');
  ensureColumn('messages', 'delivery_mode', 'TEXT');
  ensureColumn('messages', 'delivery_status', 'TEXT');
  ensureColumn('messages', 'delivery_run_id', 'TEXT');
  ensureColumn('messages', 'delivery_priority', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('messages', 'delivery_updated_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_follow_up_queue
      ON messages(chat_jid, delivery_status, delivery_priority, timestamp, id);
  `);
  // A process may have crashed after reserving a queued message for a card
  // action but before injecting it. Reservations are process-local, so make
  // those rows claimable again on startup.
  db.prepare(
    `UPDATE messages
     SET delivery_status = 'queued', delivery_updated_at = ?
     WHERE delivery_status = 'promoting'`,
  ).run(new Date().toISOString());
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
          avatar_url TEXT,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          custom_cwd TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          owner_claim_source TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT jid, name, folder, added_at, avatar_url, container_config, execution_mode, custom_cwd, NULL, NULL, NULL, NULL, 0 FROM registered_groups;
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
    'channel_context',
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
    'revision',
    'updated_at',
    'deleted_at',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'avatar_url',
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
    'default_require_mention',
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
  // Only backfill when the folder has exactly one distinct owner; otherwise
  // keep NULL to avoid misrouting ambiguous legacy data.
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
        ).run('free', '免费版', '基础免费套餐', 0, 0, 0, '[]', 1, 1, now, now);
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
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );

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
          COALESCE(json_extract(jme.value, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.cacheCreationInputTokens'), 0),
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

  // v39 → v40: Track the top-level AgentProfile identity used by each Claude
  // session. When a profile prompt changes, callers can detect the hash mismatch
  // and start a fresh SDK session without losing HappyClaw message history.
  ensureColumn('sessions', 'agent_profile_id', 'TEXT');
  ensureColumn('sessions', 'identity_hash', 'TEXT');
  ensureColumn('sessions', 'agent_profile_version', 'INTEGER');

  // v40 → v41: Allow each AgentProfile to opt out of the Claude Code
  // built-in system prompt preset and use only HappyClaw/Agent prompts.
  ensureColumn(
    'agent_profiles',
    'include_claude_preset',
    'INTEGER NOT NULL DEFAULT 1',
  );

  // v43 → v44: AgentProfile runtime policy moves provider/tool/skill/MCP
  // intent from workspace-level compatibility fields into the top-level Agent.
  ensureColumn(
    'agent_profiles',
    'runtime_policy',
    "TEXT NOT NULL DEFAULT '{}'",
  );
  // v46 → v47: profile-level avatar overrides. Null means inherit the
  // globally configured main HappyClaw avatar.
  ensureColumn('agent_profiles', 'avatar_emoji', 'TEXT');
  ensureColumn('agent_profiles', 'avatar_color', 'TEXT');
  ensureColumn('agent_profiles', 'avatar_url', 'TEXT');

  // v47 → v48: split the legacy all-in-one Agent prompt into the four
  // IDENTITY / SOUL / AGENTS / TOOLS sections. The legacy prompt represented
  // general operating instructions, so migrate it losslessly into AGENTS.
  const promptSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  ensureColumn('agent_profiles', 'soul_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agent_profiles', 'agents_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agent_profiles', 'tools_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    'agent_profiles',
    'prompt_mode',
    "TEXT NOT NULL DEFAULT 'append'",
  );
  ensureColumn(
    'agent_builder_drafts',
    'confirmation_phrase',
    "TEXT NOT NULL DEFAULT ''",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL,
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);
  `);
  if (promptSchemaVersion < 48) {
    const legacyRows = db
      .prepare('SELECT * FROM agent_profiles')
      .all() as Array<Record<string, unknown>>;
    db.transaction(() => {
      for (const row of legacyRows) {
        const legacyPrompt = String(row.identity_prompt ?? '');
        const includePreset = Number(row.include_claude_preset ?? 1) === 1;
        const prompts = normalizeAgentProfilePrompts({
          identity_prompt: '',
          soul_prompt: String(row.soul_prompt ?? ''),
          agents_prompt: String(row.agents_prompt ?? '') || legacyPrompt,
          tools_prompt: String(row.tools_prompt ?? ''),
          prompt_mode: promptModeFromLegacyPreset(includePreset),
        });
        const runtimePolicy = parseAgentProfileRuntimePolicy(
          row.runtime_policy,
        );
        const identityHash = computeAgentProfileIdentityHash(
          prompts,
          runtimePolicy,
          String(row.name ?? ''),
        );
        db.prepare(
          `UPDATE agent_profiles
           SET identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
               prompt_mode = ?, include_claude_preset = ?, identity_hash = ?
           WHERE id = ?`,
        ).run(
          prompts.identity_prompt,
          prompts.soul_prompt,
          prompts.agents_prompt,
          prompts.tools_prompt,
          prompts.prompt_mode,
          includeClaudePresetForMode(prompts.prompt_mode) ? 1 : 0,
          identityHash,
          String(row.id),
        );
        insertAgentProfilePromptVersionSnapshot({
          profileId: String(row.id),
          version: Number(row.version ?? 1),
          name: String(row.name ?? ''),
          prompts,
          identityHash,
          changeSource: 'migration',
          createdAt: String(
            row.updated_at ?? row.created_at ?? new Date().toISOString(),
          ),
        });
      }
    })();
  }

  // v48 → v49: first-class channel accounts. Credentials are stored outside
  // SQLite behind secret_ref; routing projections retain the account ID so
  // two bots in the same external chat cannot share a JID/mount accidentally.
  ensureColumn('registered_groups', 'channel_account_id', 'TEXT');
  ensureColumn('channel_mounts', 'channel_account_id', 'TEXT');
  ensureColumn('agent_channel_mounts', 'channel_account_id', 'TEXT');
  ensureColumn(
    'channel_accounts',
    'is_legacy_default',
    'INTEGER NOT NULL DEFAULT 0',
  );
  // v49 → v50: model authorization separately from the live transport.
  // QR protocols may have a socket running while still waiting for a scan;
  // that must never be published as a connected account.
  ensureColumn(
    'channel_accounts',
    'auth_mode',
    "TEXT NOT NULL DEFAULT 'credentials'",
  );
  ensureColumn(
    'channel_accounts',
    'auth_status',
    "TEXT NOT NULL DEFAULT 'draft'",
  );
  ensureColumn(
    'channel_accounts',
    'transport_status',
    "TEXT NOT NULL DEFAULT 'disconnected'",
  );
  db.exec(`
    UPDATE channel_accounts SET auth_mode = CASE
      WHEN provider IN ('wechat', 'whatsapp') THEN 'qr_session'
      WHEN provider IN ('telegram', 'discord') THEN 'bot_token'
      ELSE 'credentials'
    END
    WHERE auth_mode IS NULL OR auth_mode = '' OR auth_mode = 'credentials';
    UPDATE channel_accounts SET auth_status = CASE
      WHEN status = 'connected' THEN 'authorized'
      WHEN status = 'error' THEN 'error'
      ELSE auth_status
    END;
    UPDATE channel_accounts SET transport_status = status
      WHERE transport_status = 'disconnected' AND status != 'disconnected';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rg_channel_account
      ON registered_groups(channel_account_id);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_account
      ON channel_mounts(channel_account_id);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_account
      ON agent_channel_mounts(channel_account_id);
  `);

  // v44 → v45: make the SDK resume-state projection explicit. The former
  // `workspace_sessions` name looked like a product conversation model even
  // though it only mirrored `sessions` provider/SDK metadata.
  if (tableExists('workspace_sessions')) {
    db.transaction(() => {
      db.exec(`
        INSERT OR REPLACE INTO workspace_runtime_sessions (
          group_folder, runtime_agent_id, workspace_jid, sdk_session_id,
          provider_id, agent_profile_id, agent_profile_version, identity_hash,
          created_at, updated_at
        )
        SELECT group_folder, session_agent_id, workspace_jid, claude_session_id,
          provider_id, agent_profile_id, agent_profile_version, identity_hash,
          created_at, updated_at
        FROM workspace_sessions
      `);
      db.exec('DROP TABLE workspace_sessions');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_workspace
          ON workspace_runtime_sessions(workspace_jid);
        CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_profile
          ON workspace_runtime_sessions(agent_profile_id);
      `);
    })();
  }

  // v37 → v38: Added users.default_require_mention column (per-user default
  // for require_mention on auto-registered IM group chats). The actual
  // ensureColumn migration runs above with the other users.* additions —
  // its position before assertSchema('users', …) matters because the
  // schema check would otherwise reject pre-v38 databases on startup.

  // v38 → v39: Lowercase usernames + add COLLATE NOCASE uniqueness.
  // R1 added `username.toLowerCase()` to login/register/setup/admin-create/
  // profile-update routes for case-insensitive auth; without this migration
  // any pre-existing mixed-case username (e.g. 'Admin') is permanently
  // locked out (login lowercases input → DB lookup misses → 401).
  // We only run UPDATE; the existing UNIQUE constraint already prevents
  // future mixed-case inserts because the routes lowercase before INSERT.
  // Conflicts (e.g. both 'admin' and 'Admin' rows already exist) are rare
  // because the original UNIQUE was case-sensitive, so they exist only when
  // the operator manually inserted both. We log the conflict and refuse to
  // mutate that row, leaving the operator to clean up by hand.
  {
    const v = getRouterStateInternal('schema_version');
    const numV = v ? parseInt(v, 10) : 0;
    if (numV < 39 || !v) {
      const mixedCaseRows = db
        .prepare(
          // ORDER BY 让多次 dry-run 结果稳定 + 让"早创建的真账号"优先被
          // lowercase 化，避免后注册的混淆账号顶替原账号。
          'SELECT id, username FROM users WHERE username != lower(username) ORDER BY created_at ASC, id ASC',
        )
        .all() as Array<{ id: string; username: string }>;
      if (mixedCaseRows.length > 0) {
        const txn = db.transaction(() => {
          for (const row of mixedCaseRows) {
            const lower = row.username.toLowerCase();
            const conflict = db
              .prepare('SELECT id FROM users WHERE id != ? AND username = ?')
              .get(row.id, lower) as { id: string } | undefined;
            if (conflict) {
              logger.error(
                {
                  userId: row.id,
                  username: row.username,
                  conflictUserId: conflict.id,
                },
                'Username case-normalization migration: conflict, leaving row as-is',
              );
              continue;
            }
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(
              lower,
              row.id,
            );
          }
        });
        txn();
        logger.info(
          { rows: mixedCaseRows.length },
          'Username case-normalization migration v39 completed',
        );
      }
    }
  }

  // v42 → v43: top-level Agent ownership and canonical workspace/channel
  // projections. Tables are created with CREATE IF NOT EXISTS above; this
  // pass backfills sources and removes any projection-only ghosts.
  // v45 → v46: workspace sharing was removed. Drop the legacy membership
  // table so stale grants cannot survive an upgrade.
  // v60 -> v61: interaction behavior belongs to the Workspace↔Agent binding,
  // not the reusable AgentProfile. This column must exist before the generic
  // AgentProfile workspace backfill below: that backfill reads existing
  // bindings through getWorkspaceAgentProfileId(), whose row projection now
  // includes interaction_mode.
  ensureColumn(
    'workspace_agent_profiles',
    'interaction_mode',
    "TEXT NOT NULL DEFAULT 'assistant'",
  );

  // v61 -> v62: "persona" conflated identity with reply delivery. The mode is
  // now named "proactive": the Agent explicitly decides when to call
  // send_message, while its identity remains owned by AgentProfile.
  const replyModeSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (replyModeSchemaVersion < 62) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE workspace_agent_profiles_v62 (
          group_folder TEXT PRIMARY KEY,
          agent_profile_id TEXT NOT NULL,
          interaction_mode TEXT NOT NULL DEFAULT 'assistant'
            CHECK (interaction_mode IN ('assistant', 'proactive')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO workspace_agent_profiles_v62 (
          group_folder, agent_profile_id, interaction_mode, created_at, updated_at
        )
        SELECT
          group_folder,
          agent_profile_id,
          CASE
            WHEN interaction_mode IN ('persona', 'proactive') THEN 'proactive'
            ELSE 'assistant'
          END,
          created_at,
          updated_at
        FROM workspace_agent_profiles;
        DROP TABLE workspace_agent_profiles;
        ALTER TABLE workspace_agent_profiles_v62
          RENAME TO workspace_agent_profiles;
        CREATE INDEX idx_workspace_agent_profiles_profile
          ON workspace_agent_profiles(agent_profile_id);
      `);
    })();
  }
  db.prepare(
    `UPDATE workspace_agent_profiles
     SET interaction_mode = 'assistant'
     WHERE interaction_mode IS NULL
        OR interaction_mode NOT IN ('assistant', 'proactive')`,
  ).run();

  db.exec('DROP TABLE IF EXISTS group_members');
  backfillAgentProfileDefaultsAndWorkspaceMappings();
  removeLegacyAgentToolPolicies();
  reconcileCanonicalRuntimeProjections();

  // v50 -> v51: make usage a first-class, idempotent event ledger. Historical
  // rows predate event IDs, so each row becomes one explicitly marked legacy
  // event; we do not guess which old model rows belonged to the same run.
  // v55 -> v56: Kaboo-compatible reasoning is a fifth, independently visible
  // token class. Historical HappyClaw rows kept Claude thinking folded into
  // output, so they remain reasoning=0 rather than being guessed retroactively.
  ensureColumn(
    'usage_records',
    'reasoning_output_tokens',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(
    'usage_events',
    'reasoning_output_tokens',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(
    'usage_daily_summary',
    'total_reasoning_tokens',
    'INTEGER NOT NULL DEFAULT 0',
  );
  const v51Check = getRouterStateInternal('schema_version');
  if (!v51Check || parseInt(v51Check, 10) < 51) {
    db.transaction(() => {
      db.exec(`
        UPDATE usage_records
        SET provider_estimated_cost_usd = cost_usd
        WHERE provider_estimated_cost_usd = 0 AND cost_usd != 0;

        UPDATE usage_records
        SET usage_date = date(created_at, 'localtime')
        WHERE usage_date IS NULL OR usage_date = '';

        UPDATE usage_records
        SET user_id = COALESCE((
          SELECT rg.created_by FROM registered_groups rg
          WHERE rg.folder = usage_records.group_folder
            AND rg.created_by IS NOT NULL
          LIMIT 1
        ), user_id)
        WHERE user_id = 'system';

        UPDATE usage_records
        SET event_id = 'legacy:' || id
        WHERE event_id IS NULL OR event_id = '';

        INSERT OR IGNORE INTO usage_events (
          event_id, user_id, group_folder, agent_id, message_id,
          input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd,
          billed_cost_usd, duration_ms, num_turns, source, created_at
        )
        SELECT event_id, user_id, group_folder, agent_id, message_id,
          input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd,
          billed_cost_usd, duration_ms, num_turns, source, created_at
        FROM usage_records;
      `);
    })();
  }
  // Idempotent repair for installations that briefly ran an early v51 build
  // before usage_date was added to the finalized migration.
  db.exec(`
    UPDATE usage_records
    SET usage_date = date(created_at, 'localtime')
    WHERE usage_date IS NULL OR usage_date = '';
  `);

  // v59 -> v60: durable, provider-neutral channel inbox / Agent turn /
  // per-artifact outbox / streaming-card state. The store module owns the
  // schema and fenced APIs; db.ts only binds it to this process connection.
  createChannelReliabilitySchema(db);
  bindChannelReliabilityDatabase(db);

  // v63 -> v64: early Feishu reply enrichment embedded quoted ancestors in
  // messages.content, leaking prompt scaffolding into Web history and then
  // duplicating it again during fresh-session recovery. Clean only rows whose
  // direct parent is safely present in the same logical conversation; rows
  // whose quoted context is the sole surviving copy remain untouched.
  const embeddedReferenceSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (embeddedReferenceSchemaVersion < 64) {
    const candidates = db
      .prepare(
        `SELECT id, chat_jid, content, channel_context
         FROM messages
         WHERE content LIKE ?`,
      )
      .all('[引用消息链（最早到最近）]\n%') as Array<{
      id: string;
      chat_jid: string;
      content: string;
      channel_context: unknown;
    }>;
    const findParent = db.prepare(
      `SELECT sender_name, content
       FROM messages
       WHERE id = ? AND chat_jid = ?
       LIMIT 1`,
    );
    const updateMessage = db.prepare(
      `UPDATE messages
       SET content = ?, channel_context = ?
       WHERE id = ? AND chat_jid = ? AND content = ?`,
    );
    let migratedRows = 0;
    db.transaction(() => {
      for (const candidate of candidates) {
        const split = splitLegacyEmbeddedReferenceContent(candidate.content);
        const context = parseChannelTurnContext(candidate.channel_context);
        const parentId = context?.message?.parentId;
        if (!split || !context?.message || !parentId) continue;
        const parent = findParent.get(parentId, candidate.chat_jid) as
          | { sender_name: string | null; content: string }
          | undefined;
        if (!parent) continue;

        const parentText =
          splitLegacyEmbeddedReferenceContent(String(parent.content))
            ?.currentContent ?? String(parent.content);
        const referencedMessages = context.message.referencedMessages?.length
          ? context.message.referencedMessages
          : [
              {
                id: parentId,
                ...(parent.sender_name
                  ? { sender: String(parent.sender_name) }
                  : {}),
                text: parentText,
              },
            ];
        const migratedContext: ChannelTurnContext = {
          ...context,
          message: {
            ...context.message,
            referencedMessages,
          },
        };
        const result = updateMessage.run(
          split.currentContent,
          JSON.stringify(migratedContext),
          candidate.id,
          candidate.chat_jid,
          candidate.content,
        );
        migratedRows += Number(result.changes ?? 0);
      }
    })();
    if (migratedRows > 0) {
      logger.info(
        { migratedRows },
        'Separated legacy Feishu quoted context from canonical message content',
      );
    }
  }

  // v66 -> v67: drop the legacy pre-v65 memory chunk index. Workspace Memory
  // v2 (workspace_memory_* tables) replaced it; no code path reads or writes
  // memory_chunks anymore, yet with its FTS shadow tables it dominated
  // production database size (65% of the file, zero writes for months).
  const memoryChunksSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (memoryChunksSchemaVersion < 67) {
    const hadLegacyChunks = tableExists('memory_chunks');
    db.exec(`
      DROP TABLE IF EXISTS memory_chunks_fts;
      DROP TABLE IF EXISTS memory_chunks;
    `);
    if (hadLegacyChunks) {
      logger.info(
        'Dropped legacy memory_chunks tables superseded by Workspace Memory v2',
      );
    }
  }

  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', String(CURRENT_SCHEMA_VERSION));
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
        {
          field: warnField,
          byteLen: (value as Uint8Array).byteLength,
          sample: decoded.slice(0, 80),
        },
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
type RawMessageRow = Omit<NewMessage, 'channel_context'> & {
  channel_context?: unknown;
  is_from_me?: number;
};

function parseChannelTurnContext(
  value: unknown,
): ChannelTurnContext | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as ChannelTurnContext;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as ChannelTurnContext)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMessageRow(
  row: RawMessageRow & { is_from_me: number },
): NewMessage & { is_from_me: boolean };
function normalizeMessageRow(row: RawMessageRow): NewMessage;
function normalizeMessageRow(
  row: RawMessageRow,
): NewMessage & { is_from_me?: boolean } {
  const { is_from_me, content, channel_context, ...rest } = row;
  const parsedChannelContext = parseChannelTurnContext(channel_context);
  const out: NewMessage & { is_from_me?: boolean } = {
    ...rest,
    content: toUtf8String(content),
    ...(parsedChannelContext ? { channel_context: parsedChannelContext } : {}),
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
    channelContext?: ChannelTurnContext;
    meta?: StoredMessageMeta;
  },
): string {
  const { attachments, tokenUsage, sourceJid, channelContext, meta } =
    opts ?? {};
  // SDK/continuation/scheduled terminals share one logical final-answer row.
  // A scheduled terminal must upgrade an earlier held sdk_final checkpoint,
  // while replay of scheduled_task_result must remain idempotent.
  const existingFinalRow =
    (meta?.sourceKind === 'sdk_final' ||
      meta?.sourceKind === 'truncation_continue' ||
      meta?.sourceKind === 'scheduled_task_result') &&
    meta.turnId
      ? (stmts().storeMessageSelect.get(chatJid, meta.turnId) as
          | { id: string }
          | undefined)
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
    channelContext ? JSON.stringify(channelContext) : null,
    meta?.turnId ?? null,
    meta?.sessionId ?? null,
    meta?.sdkMessageUuid ?? null,
    meta?.sourceKind ?? null,
    meta?.finalizationReason ?? null,
    meta?.taskId ?? null,
    meta?.deliveryMode ?? null,
    meta?.deliveryStatus ?? null,
    meta?.deliveryRunId ?? null,
    meta?.deliveryPriority ?? 0,
    meta?.deliveryUpdatedAt ?? null,
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

/** Return the sanitized provider context bound to one exact persisted turn. */
export function getMessageChannelTurnContext(
  chatJid: string,
  messageId: string,
): ChannelTurnContext | null {
  const row = db
    .prepare(
      `SELECT channel_context FROM messages
       WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid) as { channel_context?: unknown } | undefined;
  return parseChannelTurnContext(row?.channel_context) ?? null;
}

function normalizeQueuedFollowUpRow(
  row: Record<string, unknown>,
): QueuedFollowUp {
  return {
    id: String(row.id),
    chat_jid: String(row.chat_jid),
    source_jid: row.source_jid ? String(row.source_jid) : undefined,
    sender: String(row.sender ?? ''),
    sender_name: String(row.sender_name ?? ''),
    content: toUtf8String(row.content, 'messages.content'),
    timestamp: String(row.timestamp),
    attachments: row.attachments ? String(row.attachments) : undefined,
    channel_context: parseChannelTurnContext(row.channel_context),
    delivery_mode: (row.delivery_mode === 'steer'
      ? 'steer'
      : 'queue') as FollowUpMode,
    delivery_status:
      row.delivery_status === 'promoting' ? 'promoting' : 'queued',
    delivery_run_id: row.delivery_run_id ? String(row.delivery_run_id) : null,
    delivery_priority: Number(row.delivery_priority ?? 0),
  };
}

const FOLLOW_UP_SELECT = `
  SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp,
         attachments, channel_context, delivery_mode, delivery_status, delivery_run_id,
         delivery_priority
  FROM messages
`;

export function setMessageFollowUp(
  chatJid: string,
  messageId: string,
  input: {
    mode: FollowUpMode;
    status: FollowUpStatus;
    runId?: string | null;
    priority?: number;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE messages
       SET delivery_mode = ?, delivery_status = ?, delivery_run_id = ?,
           delivery_priority = ?, delivery_updated_at = ?
       WHERE chat_jid = ? AND id = ? AND is_from_me = 0`,
    )
    .run(
      input.mode,
      input.status,
      input.runId ?? null,
      input.priority ?? 0,
      new Date().toISOString(),
      chatJid,
      messageId,
    );
  return result.changes === 1;
}

export function listQueuedFollowUps(chatJid: string): QueuedFollowUp[] {
  const rows = db
    .prepare(
      `${FOLLOW_UP_SELECT}
       WHERE chat_jid = ? AND delivery_status IN ('queued', 'promoting')
       ORDER BY delivery_priority ASC, timestamp ASC, id ASC`,
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(normalizeQueuedFollowUpRow);
}

export function getQueuedFollowUp(
  chatJid: string,
  messageId: string,
): QueuedFollowUp | null {
  const row = db
    .prepare(
      `${FOLLOW_UP_SELECT}
       WHERE chat_jid = ? AND id = ?
         AND delivery_status IN ('queued', 'promoting')
       LIMIT 1`,
    )
    .get(chatJid, messageId) as Record<string, unknown> | undefined;
  return row ? normalizeQueuedFollowUpRow(row) : null;
}

export function getQueuedFollowUpChatJids(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT chat_jid FROM messages
       WHERE delivery_status IN ('queued', 'promoting')
       ORDER BY chat_jid`,
    )
    .all() as Array<{ chat_jid: string }>;
  return rows.map((row) => row.chat_jid);
}

/**
 * Move a queued message to the front as an explicit steer request.
 *
 * Steering is deliberately represented as a durable queued row until the
 * active SDK query has acknowledged its interrupt.  This avoids injecting the
 * message as a weak `queued_command` attachment into the turn being stopped,
 * and also makes the hand-off recoverable if the host or runner exits between
 * the interrupt request and the next query.
 */
export function prioritizeQueuedFollowUp(
  chatJid: string,
  messageId: string,
  runId: string,
): QueuedFollowUp | null {
  const select = db.prepare(
    `${FOLLOW_UP_SELECT}
     WHERE chat_jid = ? AND id = ? AND delivery_status = 'queued'
     LIMIT 1`,
  );
  const selectMinPriority = db.prepare(
    `SELECT MIN(delivery_priority) AS min_priority
     FROM messages
     WHERE chat_jid = ? AND delivery_status IN ('queued', 'promoting')`,
  );
  const update = db.prepare(
    `UPDATE messages
     SET delivery_mode = 'steer', delivery_run_id = ?,
         delivery_priority = ?, delivery_updated_at = ?
     WHERE chat_jid = ? AND id = ? AND delivery_status = 'queued'`,
  );
  return db.transaction(() => {
    const current = select.get(chatJid, messageId) as
      | Record<string, unknown>
      | undefined;
    if (!current) return null;
    const priorityRow = selectMinPriority.get(chatJid) as
      | { min_priority?: number | null }
      | undefined;
    const minPriority = Number(priorityRow?.min_priority ?? 0);
    const priority = Math.max(Number.MIN_SAFE_INTEGER, minPriority - 1);
    const result = update.run(
      runId,
      priority,
      new Date().toISOString(),
      chatJid,
      messageId,
    );
    if (result.changes !== 1) return null;
    const updated = select.get(chatJid, messageId) as
      | Record<string, unknown>
      | undefined;
    return updated ? normalizeQueuedFollowUpRow(updated) : null;
  })();
}

/** Update the text of a message that is still waiting in the normal queue. */
export function updateQueuedFollowUpContent(
  chatJid: string,
  messageId: string,
  content: string,
): QueuedFollowUp | null {
  const normalizedContent = content.trim();
  if (!normalizedContent) return null;
  const result = db
    .prepare(
      `UPDATE messages
       SET content = ?, delivery_updated_at = ?
       WHERE chat_jid = ? AND id = ?
         AND delivery_status = 'queued' AND delivery_mode = 'queue'`,
    )
    .run(normalizedContent, new Date().toISOString(), chatJid, messageId);
  return result.changes === 1 ? getQueuedFollowUp(chatJid, messageId) : null;
}

/** Move a normal queued message one place while preserving durable FIFO order. */
export function moveQueuedFollowUp(
  chatJid: string,
  messageId: string,
  direction: 'up' | 'down',
): QueuedFollowUp | null {
  const select = db.prepare(
    `${FOLLOW_UP_SELECT}
     WHERE chat_jid = ? AND delivery_status = 'queued'
       AND delivery_mode = 'queue'
     ORDER BY delivery_priority ASC, timestamp ASC, id ASC`,
  );
  const update = db.prepare(
    `UPDATE messages
     SET delivery_priority = ?, delivery_updated_at = ?
     WHERE chat_jid = ? AND id = ?
       AND delivery_status = 'queued' AND delivery_mode = 'queue'`,
  );

  return db.transaction(() => {
    const rows = select.all(chatJid) as Array<Record<string, unknown>>;
    const currentIndex = rows.findIndex((row) => String(row.id) === messageId);
    if (currentIndex < 0) return null;
    const targetIndex =
      direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= rows.length) return null;

    [rows[currentIndex], rows[targetIndex]] = [
      rows[targetIndex],
      rows[currentIndex],
    ];
    const updatedAt = new Date().toISOString();
    for (const [priority, row] of rows.entries()) {
      update.run(priority, updatedAt, chatJid, String(row.id));
    }
    return getQueuedFollowUp(chatJid, messageId);
  })();
}

function transitionFollowUp(
  chatJid: string,
  messageId: string,
  from: Array<'queued' | 'promoting'>,
  to: FollowUpStatus,
  opts?: {
    runId?: string | null;
    priority?: number;
    updatedAt?: string;
  },
): QueuedFollowUp | null {
  const placeholders = from.map(() => '?').join(',');
  const update = db.prepare(
    `UPDATE messages
     SET delivery_status = ?,
         delivery_run_id = COALESCE(?, delivery_run_id),
         delivery_priority = COALESCE(?, delivery_priority),
         delivery_updated_at = ?
     WHERE chat_jid = ? AND id = ?
       AND delivery_status IN (${placeholders})`,
  );
  const select = db.prepare(
    `${FOLLOW_UP_SELECT} WHERE chat_jid = ? AND id = ? LIMIT 1`,
  );
  return db.transaction(() => {
    const current = select.get(chatJid, messageId) as
      | Record<string, unknown>
      | undefined;
    if (
      !current ||
      !from.includes(current.delivery_status as 'queued' | 'promoting')
    ) {
      return null;
    }
    const result = update.run(
      to,
      opts?.runId ?? null,
      opts?.priority ?? null,
      opts?.updatedAt ?? new Date().toISOString(),
      chatJid,
      messageId,
      ...from,
    );
    return result.changes === 1 ? normalizeQueuedFollowUpRow(current) : null;
  })();
}

export function claimNextQueuedFollowUp(
  chatJid: string,
  runId: string,
): QueuedFollowUp | null {
  const select = db.prepare(
    `${FOLLOW_UP_SELECT}
     WHERE chat_jid = ? AND delivery_status = 'queued'
     ORDER BY delivery_priority ASC, timestamp ASC, id ASC
     LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE messages
     SET delivery_status = 'promoting', delivery_run_id = ?,
         delivery_updated_at = ?
     WHERE chat_jid = ? AND id = ? AND delivery_status = 'queued'`,
  );
  return db.transaction(() => {
    const row = select.get(chatJid) as Record<string, unknown> | undefined;
    if (!row) return null;
    const result = update.run(
      runId,
      new Date().toISOString(),
      chatJid,
      String(row.id),
    );
    return result.changes === 1 ? normalizeQueuedFollowUpRow(row) : null;
  })();
}

export function releaseQueuedFollowUp(
  chatJid: string,
  messageId: string,
  runId: string,
  updatedAt?: string,
): QueuedFollowUp | null {
  return transitionFollowUp(
    chatJid,
    messageId,
    ['queued', 'promoting'],
    'released',
    {
      runId,
      updatedAt,
    },
  );
}

export function beginPromotingFollowUp(
  chatJid: string,
  messageId: string,
): QueuedFollowUp | null {
  return transitionFollowUp(chatJid, messageId, ['queued'], 'promoting');
}

export function restorePromotingFollowUp(
  chatJid: string,
  messageId: string,
): QueuedFollowUp | null {
  return transitionFollowUp(chatJid, messageId, ['promoting'], 'queued');
}

export function cancelQueuedFollowUp(
  chatJid: string,
  messageId: string,
  updatedAt?: string,
): QueuedFollowUp | null {
  return transitionFollowUp(
    chatJid,
    messageId,
    ['queued', 'promoting'],
    'cancelled',
    { updatedAt },
  );
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
    stmts().updateTokenUsageById.run(
      tokenUsage,
      costUsd ?? null,
      msgId,
      chatJid,
    );
  } else {
    stmts().updateTokenUsageLatest.run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Rebuild a message's cumulative usage snapshot from the immutable event
 * ledger. This keeps legacy message consumers accurate when one visible reply
 * receives multiple incremental SDK usage events.
 */
export function rebuildMessageTokenUsageFromLedger(
  chatJid: string,
  groupFolder: string,
  messageId: string,
): void {
  const total = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningTokens,
        COALESCE(SUM(provider_estimated_cost_usd), 0) AS costUSD,
        COALESCE(SUM(duration_ms), 0) AS durationMs,
        COALESCE(SUM(num_turns), 0) AS numTurns
       FROM usage_events WHERE group_folder = ? AND message_id = ?`,
    )
    .get(groupFolder, messageId) as Record<string, number>;
  const modelRows = db
    .prepare(
      `SELECT model, COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningTokens,
        COALESCE(SUM(provider_estimated_cost_usd), 0) AS costUSD
       FROM usage_records WHERE group_folder = ? AND message_id = ?
       GROUP BY model ORDER BY model`,
    )
    .all(groupFolder, messageId) as Array<Record<string, unknown>>;
  const modelUsage = Object.fromEntries(
    modelRows.map((row) => [
      String(row.model),
      {
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        cacheReadInputTokens: Number(row.cacheReadInputTokens) || 0,
        cacheCreationInputTokens: Number(row.cacheCreationInputTokens) || 0,
        reasoningTokens: Number(row.reasoningTokens) || 0,
        costUSD: Number(row.costUSD) || 0,
      },
    ]),
  );
  const tokenUsage = {
    inputTokens: Number(total.inputTokens) || 0,
    outputTokens: Number(total.outputTokens) || 0,
    cacheReadInputTokens: Number(total.cacheReadInputTokens) || 0,
    cacheCreationInputTokens: Number(total.cacheCreationInputTokens) || 0,
    reasoningTokens: Number(total.reasoningTokens) || 0,
    costUSD: Number(total.costUSD) || 0,
    durationMs: Number(total.durationMs) || 0,
    numTurns: Number(total.numTurns) || 0,
    modelUsage,
  };
  updateLatestMessageTokenUsage(
    chatJid,
    JSON.stringify(tokenUsage),
    messageId,
    tokenUsage.costUSD,
  );
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
  reasoning_tokens: number;
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
      json_extract(m.token_usage, '$.reasoningTokens') as reasoning_tokens,
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
    reasoning_tokens: number;
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
    reasoning_tokens: number;
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
    reasoningTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.reasoning_tokens += reasoningTokens;
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
        reasoning_tokens: reasoningTokens,
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
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
            reasoningTokens?: number;
            costUSD: number;
          }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            usage.cacheReadInputTokens || 0,
            usage.cacheCreationInputTokens || 0,
            usage.reasoningTokens || 0,
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
          row.reasoning_tokens || 0,
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
        row.reasoning_tokens || 0,
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
  totalReasoningTokens: number;
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
      COALESCE(SUM(json_extract(token_usage, '$.reasoningTokens')), 0) as total_reasoning,
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
    total_reasoning: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalReasoningTokens: row.total_reasoning,
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

export function getUsageDateWindow(
  days: number,
  now: Date = new Date(),
): { from: string; to: string; days: number; timezone: string } {
  const normalizedDays = Math.min(Math.max(Math.trunc(days) || 1, 1), 365);
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(12, 0, 0, 0);
  from.setDate(from.getDate() - (normalizedDays - 1));
  return {
    from: toLocalDateString(from),
    to: toLocalDateString(to),
    days: normalizedDays,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
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
  reasoningTokens?: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  recordUsageEventBatch({
    eventId: crypto.randomUUID(),
    userId: record.userId,
    groupFolder: record.groupFolder,
    agentId: record.agentId,
    messageId: record.messageId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    reasoningTokens: record.reasoningTokens || 0,
    providerEstimatedCostUSD: record.costUSD,
    billedCostUSD: 0,
    durationMs: record.durationMs,
    numTurns: record.numTurns,
    source: record.source,
    models: [
      {
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadInputTokens: record.cacheReadInputTokens,
        cacheCreationInputTokens: record.cacheCreationInputTokens,
        reasoningTokens: record.reasoningTokens || 0,
        providerEstimatedCostUSD: record.costUSD,
        billedCostUSD: 0,
      },
    ],
    trackBillingUsage: false,
  });
}

export interface UsageModelRecordInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens?: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number;
}

export interface UsagePricingBucketTotals {
  bucketStart: string;
  bucketEnd: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export function getRecordedUsageEventCost(
  eventId: string,
): { providerEstimatedCostUSD: number; billedCostUSD: number } | null {
  const row = db
    .prepare(
      `SELECT provider_estimated_cost_usd AS providerEstimatedCostUSD,
        billed_cost_usd AS billedCostUSD
       FROM usage_events WHERE event_id = ? LIMIT 1`,
    )
    .get(eventId) as Record<string, number> | undefined;
  return row
    ? {
        providerEstimatedCostUSD: Number(row.providerEstimatedCostUSD) || 0,
        billedCostUSD: Number(row.billedCostUSD) || 0,
      }
    : null;
}

/**
 * Return the existing raw-model usage in Kaboo's UTC 30-minute pricing bucket.
 * Cost is intentionally excluded: callers recompute both the old and new
 * bucket headline from tokens so an SDK-reported legacy cost cannot influence
 * Kaboo-aligned accounting.
 */
export function getUsagePricingBucketTotals(input: {
  userId: string;
  groupFolder: string;
  source: string;
  model: string;
  createdAt: string;
}): UsagePricingBucketTotals {
  const timestamp = new Date(input.createdAt);
  const safeTimestamp = Number.isFinite(timestamp.getTime())
    ? timestamp
    : new Date();
  const bucketStartMs =
    Math.floor(safeTimestamp.getTime() / (30 * 60 * 1000)) * (30 * 60 * 1000);
  const bucketStart = new Date(bucketStartMs).toISOString();
  const bucketEnd = new Date(bucketStartMs + 30 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadInputTokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
        COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningTokens
       FROM usage_records
       WHERE user_id = ? AND group_folder = ? AND source = ? AND model = ?
         AND created_at >= ? AND created_at < ?`,
    )
    .get(
      input.userId,
      input.groupFolder,
      input.source,
      input.model,
      bucketStart,
      bucketEnd,
    ) as Record<string, number>;
  return {
    bucketStart,
    bucketEnd,
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    cacheReadInputTokens: Number(row.cacheReadInputTokens) || 0,
    cacheCreationInputTokens: Number(row.cacheCreationInputTokens) || 0,
    reasoningTokens: Number(row.reasoningTokens) || 0,
  };
}

export interface UsageEventRecordInput {
  eventId: string;
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens?: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
  createdAt?: string;
  models: UsageModelRecordInput[];
  /** Update the quota/billing period ledgers in the same transaction. */
  trackBillingUsage?: boolean;
  /** Atomically deduct the already-rated billedCostUSD from the user wallet. */
  chargeBalance?: boolean;
}

/**
 * Persist one logical Agent run and all of its per-model calls atomically.
 * Replaying the same eventId is a no-op, including quota counters.
 */
export function recordUsageEventBatch(input: UsageEventRecordInput): {
  inserted: boolean;
} {
  if (!input.eventId.trim()) throw new Error('usage eventId is required');
  if (!input.userId.trim()) throw new Error('usage userId is required');
  if (!input.groupFolder.trim())
    throw new Error('usage groupFolder is required');

  const nonNegative = (value: number | undefined) => {
    const numeric = value ?? 0;
    return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
  };
  const createdAt = input.createdAt || new Date().toISOString();
  const localDate = toLocalDateString(createdAt);
  const source = input.source?.trim() || 'agent';
  const models = input.models.length
    ? input.models
    : [
        {
          model: 'unknown',
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cacheReadInputTokens: input.cacheReadInputTokens,
          cacheCreationInputTokens: input.cacheCreationInputTokens,
          reasoningTokens: input.reasoningTokens,
          providerEstimatedCostUSD: input.providerEstimatedCostUSD,
          billedCostUSD: input.billedCostUSD,
        },
      ];

  return db.transaction(() => {
    const eventInsert = db
      .prepare(
        `INSERT OR IGNORE INTO usage_events (
          event_id, user_id, group_folder, agent_id, message_id,
          input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd,
          billed_cost_usd, duration_ms, num_turns, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.userId,
        input.groupFolder,
        input.agentId ?? null,
        input.messageId ?? null,
        nonNegative(input.inputTokens),
        nonNegative(input.outputTokens),
        nonNegative(input.cacheReadInputTokens),
        nonNegative(input.cacheCreationInputTokens),
        nonNegative(input.reasoningTokens),
        nonNegative(input.providerEstimatedCostUSD),
        nonNegative(input.billedCostUSD),
        nonNegative(input.durationMs ?? 0),
        nonNegative(input.numTurns ?? 0),
        source,
        createdAt,
      );

    if (eventInsert.changes === 0) return { inserted: false };

    for (const modelUsage of models) {
      const model = modelUsage.model.trim() || 'unknown';
      const estimated = nonNegative(modelUsage.providerEstimatedCostUSD);
      const billed = nonNegative(modelUsage.billedCostUSD);
      stmts().insertUsageInsert.run(
        crypto.randomUUID(),
        input.eventId,
        input.userId,
        input.groupFolder,
        input.agentId ?? null,
        input.messageId ?? null,
        model,
        nonNegative(modelUsage.inputTokens),
        nonNegative(modelUsage.outputTokens),
        nonNegative(modelUsage.cacheReadInputTokens),
        nonNegative(modelUsage.cacheCreationInputTokens),
        nonNegative(modelUsage.reasoningTokens),
        estimated,
        estimated,
        billed,
        nonNegative(input.durationMs ?? 0),
        nonNegative(input.numTurns ?? 0),
        source,
        localDate,
        createdAt,
      );
      stmts().insertUsageUpsert.run(
        input.userId,
        model,
        localDate,
        nonNegative(modelUsage.inputTokens),
        nonNegative(modelUsage.outputTokens),
        nonNegative(modelUsage.cacheReadInputTokens),
        nonNegative(modelUsage.cacheCreationInputTokens),
        nonNegative(modelUsage.reasoningTokens),
        estimated,
      );
    }

    if (input.trackBillingUsage) {
      const d = new Date(createdAt);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const billableInput =
        nonNegative(input.inputTokens) +
        nonNegative(input.cacheReadInputTokens) +
        nonNegative(input.cacheCreationInputTokens);
      const billableOutput =
        nonNegative(input.outputTokens) + nonNegative(input.reasoningTokens);
      incrementUsageBoth(
        input.userId,
        month,
        localDate,
        billableInput,
        billableOutput,
        nonNegative(input.billedCostUSD),
      );
    }

    if (input.chargeBalance && nonNegative(input.billedCostUSD) > 0) {
      adjustUserBalance(
        input.userId,
        -nonNegative(input.billedCostUSD),
        'deduction',
        'AI 调用消费扣费',
        'usage_event',
        input.eventId,
        null,
        `usage_event_${input.eventId}`,
        {
          source: 'usage_charge',
          operatorType: 'system',
          notes: `用量事件消费扣费: ${input.eventId}`,
          allowNegative: true,
        },
      );
    }

    return { inserted: true };
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
  reasoning_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const window = getUsageDateWindow(days);
  const conditions: string[] = ['date >= ?', 'date <= ?'];
  const params: unknown[] = [window.from, window.to];

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
      total_reasoning_tokens as reasoning_tokens,
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
    reasoning_tokens: number;
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
  totalReasoningTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const window = getUsageDateWindow(days);
  const conditions: string[] = ['date >= ?', 'date <= ?'];
  const params: unknown[] = [window.from, window.to];

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
      COALESCE(SUM(total_reasoning_tokens), 0) as total_reasoning,
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
    total_reasoning: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalReasoningTokens: row.total_reasoning,
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

export interface UsageQueryFilters {
  from: string;
  to: string;
  userId?: string;
  model?: string;
  agentId?: string;
  groupFolder?: string;
  source?: string;
}

function buildUsageWhere(filters: UsageQueryFilters): {
  sql: string;
  params: unknown[];
} {
  const conditions = ['r.usage_date >= ?', 'r.usage_date <= ?'];
  const params: unknown[] = [filters.from, filters.to];
  const add = (column: string, value?: string) => {
    if (!value) return;
    conditions.push(`${column} = ?`);
    params.push(value);
  };
  add('r.user_id', filters.userId);
  add('r.model', filters.model);
  if (filters.agentId === '__main__') {
    conditions.push('r.agent_id IS NULL');
  } else {
    add('r.agent_id', filters.agentId);
  }
  add('r.group_folder', filters.groupFolder);
  add('r.source', filters.source);
  return { sql: conditions.join(' AND '), params };
}

export interface UsageAttributionItem {
  key: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number;
  runCount: number;
  modelCallCount: number;
}

export function getUsageAnalytics(filters: UsageQueryFilters): {
  summary: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    providerEstimatedCostUSD: number;
    billedCostUSD: number;
    runCount: number;
    modelCallCount: number;
    activeDays: number;
  };
  breakdown: Array<{
    date: string;
    model: string;
    user_id: string;
    agent_id: string | null;
    group_folder: string;
    source: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
    provider_estimated_cost_usd: number;
    cost_usd: number;
    billed_cost_usd: number;
    run_count: number;
    model_call_count: number;
  }>;
  daily: Array<{
    date: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
    provider_estimated_cost_usd: number;
    cost_usd: number;
    billed_cost_usd: number;
    run_count: number;
    model_call_count: number;
  }>;
  attributions: {
    models: UsageAttributionItem[];
    agents: UsageAttributionItem[];
    workspaces: UsageAttributionItem[];
    sources: UsageAttributionItem[];
  };
} {
  const where = buildUsageWhere(filters);
  const aggregateSelect = `
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cache_read_input_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(r.cache_creation_input_tokens), 0) AS cache_creation_tokens,
    COALESCE(SUM(r.reasoning_output_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(r.provider_estimated_cost_usd), 0) AS provider_cost,
    COALESCE(SUM(r.billed_cost_usd), 0) AS billed_cost,
    COUNT(DISTINCT r.event_id) AS run_count,
    COUNT(*) AS model_call_count`;
  const summaryRow = db
    .prepare(
      `SELECT ${aggregateSelect},
        COUNT(DISTINCT r.usage_date) AS active_days
       FROM usage_records r WHERE ${where.sql}`,
    )
    .get(...where.params) as Record<string, number>;

  const breakdown = db
    .prepare(
      `SELECT r.usage_date AS date, r.model, r.user_id,
        r.agent_id, r.group_folder, r.source, ${aggregateSelect}
       FROM usage_records r WHERE ${where.sql}
       GROUP BY r.usage_date, r.model, r.user_id,
         r.agent_id, r.group_folder, r.source
       ORDER BY date ASC, r.model ASC`,
    )
    .all(...where.params)
    .map((row: any) => ({
      date: String(row.date),
      model: String(row.model),
      user_id: String(row.user_id),
      agent_id: row.agent_id == null ? null : String(row.agent_id),
      group_folder: String(row.group_folder),
      source: String(row.source),
      input_tokens: Number(row.input_tokens) || 0,
      output_tokens: Number(row.output_tokens) || 0,
      cache_read_tokens: Number(row.cache_read_tokens) || 0,
      cache_creation_tokens: Number(row.cache_creation_tokens) || 0,
      reasoning_tokens: Number(row.reasoning_tokens) || 0,
      provider_estimated_cost_usd: Number(row.provider_cost) || 0,
      cost_usd: Number(row.provider_cost) || 0,
      billed_cost_usd: Number(row.billed_cost) || 0,
      run_count: Number(row.run_count) || 0,
      model_call_count: Number(row.model_call_count) || 0,
    }));

  const daily = db
    .prepare(
      `SELECT r.usage_date AS date, ${aggregateSelect}
       FROM usage_records r WHERE ${where.sql}
       GROUP BY r.usage_date
       ORDER BY date ASC`,
    )
    .all(...where.params)
    .map((row: any) => ({
      date: String(row.date),
      input_tokens: Number(row.input_tokens) || 0,
      output_tokens: Number(row.output_tokens) || 0,
      cache_read_tokens: Number(row.cache_read_tokens) || 0,
      cache_creation_tokens: Number(row.cache_creation_tokens) || 0,
      reasoning_tokens: Number(row.reasoning_tokens) || 0,
      provider_estimated_cost_usd: Number(row.provider_cost) || 0,
      cost_usd: Number(row.provider_cost) || 0,
      billed_cost_usd: Number(row.billed_cost) || 0,
      run_count: Number(row.run_count) || 0,
      model_call_count: Number(row.model_call_count) || 0,
    }));

  const attribution = (
    column: 'model' | 'agent_id' | 'group_folder' | 'source',
  ): UsageAttributionItem[] => {
    const keyExpression =
      column === 'agent_id'
        ? `COALESCE(CAST(r.agent_id AS TEXT), '__main__')`
        : `COALESCE(CAST(r.${column} AS TEXT), 'unassigned')`;
    const nameExpression =
      column === 'agent_id'
        ? `COALESCE(
            (SELECT a.name FROM agents a WHERE a.id = r.agent_id LIMIT 1),
            (SELECT ap.name FROM agent_profiles ap WHERE ap.id = r.agent_id LIMIT 1),
            CAST(r.agent_id AS TEXT), 'HappyClaw')`
        : column === 'group_folder'
          ? `COALESCE(
              (SELECT rg.name FROM registered_groups rg
               WHERE rg.folder = r.group_folder LIMIT 1),
              CAST(r.group_folder AS TEXT), 'unassigned')`
          : `COALESCE(CAST(r.${column} AS TEXT), 'unassigned')`;
    const rows = db
      .prepare(
        `SELECT ${keyExpression} AS key,
          ${nameExpression} AS name,
          ${aggregateSelect}
         FROM usage_records r WHERE ${where.sql}
         GROUP BY r.${column}
         ORDER BY provider_cost DESC, key ASC`,
      )
      .all(...where.params) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const input = Number(row.input_tokens) || 0;
      const output = Number(row.output_tokens) || 0;
      const cacheRead = Number(row.cache_read_tokens) || 0;
      const cacheCreation = Number(row.cache_creation_tokens) || 0;
      const reasoning = Number(row.reasoning_tokens) || 0;
      const key = String(row.key);
      return {
        key,
        name: String(row.name || key),
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        reasoningTokens: reasoning,
        totalTokens: input + output + cacheRead + cacheCreation + reasoning,
        providerEstimatedCostUSD: Number(row.provider_cost) || 0,
        billedCostUSD: Number(row.billed_cost) || 0,
        runCount: Number(row.run_count) || 0,
        modelCallCount: Number(row.model_call_count) || 0,
      };
    });
  };

  const inputTokens = Number(summaryRow.input_tokens) || 0;
  const outputTokens = Number(summaryRow.output_tokens) || 0;
  const cacheReadTokens = Number(summaryRow.cache_read_tokens) || 0;
  const cacheCreationTokens = Number(summaryRow.cache_creation_tokens) || 0;
  const reasoningTokens = Number(summaryRow.reasoning_tokens) || 0;
  return {
    summary: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      totalTokens:
        inputTokens +
        outputTokens +
        cacheReadTokens +
        cacheCreationTokens +
        reasoningTokens,
      providerEstimatedCostUSD: Number(summaryRow.provider_cost) || 0,
      billedCostUSD: Number(summaryRow.billed_cost) || 0,
      runCount: Number(summaryRow.run_count) || 0,
      modelCallCount: Number(summaryRow.model_call_count) || 0,
      activeDays: Number(summaryRow.active_days) || 0,
    },
    breakdown,
    daily,
    attributions: {
      models: attribution('model'),
      agents: attribution('agent_id'),
      workspaces: attribution('group_folder'),
      sources: attribution('source'),
    },
  };
}

export function getUsageModelsForFilters(filters: UsageQueryFilters): string[] {
  const where = buildUsageWhere({ ...filters, model: undefined });
  return (
    db
      .prepare(
        `SELECT DISTINCT r.model FROM usage_records r
         WHERE ${where.sql} ORDER BY r.model`,
      )
      .all(...where.params) as Array<{ model: string }>
  ).map((row) => row.model);
}

export function getUsageRecordsPage(
  filters: UsageQueryFilters,
  page: number,
  pageSize: number,
): { records: Array<Record<string, unknown>>; total: number } {
  const where = buildUsageWhere(filters);
  const safePage = Math.max(1, Math.trunc(page) || 1);
  // Public JSON routes cap this at 500. The higher internal ceiling is used by
  // the authenticated CSV export to avoid silently truncating downloads.
  const safePageSize = Math.min(
    Math.max(1, Math.trunc(pageSize) || 50),
    100_000,
  );
  const total = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM usage_records r WHERE ${where.sql}`,
        )
        .get(...where.params) as { count: number }
    ).count,
  );
  const records = db
    .prepare(
      `SELECT r.event_id AS eventId, r.user_id AS userId,
        r.group_folder AS groupFolder, r.agent_id AS agentId,
        r.message_id AS messageId, r.model,
        r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
        r.cache_read_input_tokens AS cacheReadTokens,
        r.cache_creation_input_tokens AS cacheCreationTokens,
        r.reasoning_output_tokens AS reasoningTokens,
        r.provider_estimated_cost_usd AS providerEstimatedCostUSD,
        r.billed_cost_usd AS billedCostUSD, r.duration_ms AS durationMs,
        r.num_turns AS numTurns, r.source, r.created_at AS createdAt
       FROM usage_records r WHERE ${where.sql}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...where.params, safePageSize, (safePage - 1) * safePageSize) as Array<
    Record<string, unknown>
  >;
  return { records, total };
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT r.user_id as id, COALESCE(u.username, r.user_id) as username
    FROM usage_records r
    LEFT JOIN users u ON u.id = r.user_id
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

type CreateTaskInput = Omit<
  ScheduledTask,
  'last_run' | 'last_result' | 'revision' | 'updated_at' | 'deleted_at'
> &
  Partial<Pick<ScheduledTask, 'revision' | 'updated_at' | 'deleted_at'>>;

export function createTask(task: CreateTaskInput): void {
  const updatedAt = task.updated_at ?? task.created_at;
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, execution_mode, next_run, status, created_at, created_by, notify_channels, revision, updated_at, deleted_at, delivery_route_jid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    toUtf8String(task.prompt, 'scheduled_tasks.prompt'),
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
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
    task.revision ?? 1,
    updatedAt,
    task.deleted_at ?? null,
    // Fall back to chat_jid so a caller that has no concrete route still records
    // an explicit binding rather than leaving execution to re-derive one.
    task.delivery_route_jid ?? task.chat_jid,
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
  if (!Number.isInteger(r.revision) || r.revision < 1) r.revision = 1;
  if (!r.updated_at) r.updated_at = r.created_at;
  if (r.deleted_at === undefined) r.deleted_at = null;
  // Rows written before the column existed behave as if bound to chat_jid,
  // which is the route they actually used.
  if (r.delivery_route_jid === undefined || r.delivery_route_jid === null) {
    r.delivery_route_jid = r.chat_jid ?? null;
  }
  // Defensive: legacy BLOB cells in TEXT-affinity columns come back as Buffer.
  r.prompt = toUtf8String(r.prompt);
  if (r.script_command !== undefined)
    r.script_command = toUtf8StringOrNull(r.script_command);
  return r as ScheduledTask;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  return row ? mapTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    )
    .all(groupFolder)
    .map(mapTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY created_at DESC',
    )
    .all()
    .map(mapTaskRow);
}

export function getDeletedTasks(): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC',
    )
    .all()
    .map(mapTaskRow);
}

export interface WorkspaceTaskRebuildPause {
  groupFolder: string;
  tasks: Array<{
    id: string;
    originalStatus: ScheduledTask['status'];
    originalNextRun: string | null;
    preparedRevision: number;
  }>;
  activeRunIds: string[];
}

/**
 * Freeze every runnable task definition before workspace rebuild performs its
 * first await. Completed tasks cannot run, and genuinely parsing tasks must
 * keep their revision so an in-flight parser is not orphaned if rebuild later
 * rolls back. Failure recovery restores changed rows with CAS.
 */
export function pauseWorkspaceTasksForRebuild(
  groupFolder: string,
): WorkspaceTaskRebuildPause {
  return db
    .transaction((): WorkspaceTaskRebuildPause => {
      const tasks = db
        .prepare(
          `SELECT * FROM scheduled_tasks
           WHERE group_folder = ? AND deleted_at IS NULL
           ORDER BY id`,
        )
        .all(groupFolder)
        .map(mapTaskRow);
      const now = new Date().toISOString();
      const pause = db.prepare(
        `UPDATE scheduled_tasks
         SET status = 'parsing', next_run = NULL, running_until = NULL,
             runner_id = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      );
      const snapshots: WorkspaceTaskRebuildPause['tasks'] = [];
      for (const task of tasks) {
        if (task.status === 'completed' || task.status === 'parsing') continue;
        const result = pause.run(now, task.id, task.revision);
        if (result.changes !== 1) {
          throw new Error(
            `Scheduled task changed while preparing workspace rebuild: ${task.id}`,
          );
        }
        snapshots.push({
          id: task.id,
          originalStatus: task.status,
          originalNextRun: task.next_run,
          preparedRevision: task.revision + 1,
        });
      }
      const activeRunIds = (
        db
          .prepare(
            `SELECT tr.id
             FROM task_runs tr
             JOIN scheduled_tasks st ON st.id = tr.task_id
             WHERE st.group_folder = ?
               AND (
                 tr.status IN ('queued','running','retry_wait')
                 OR (
                   tr.status = 'delivered'
                   AND json_valid(tr.definition_snapshot)
                   AND json_extract(
                     tr.definition_snapshot,
                     '$.context_mode'
                   ) = 'group'
                 )
               )
             ORDER BY tr.created_at, tr.id`,
          )
          .all(groupFolder) as Array<{ id: string }>
      ).map((row) => row.id);
      return { groupFolder, tasks: snapshots, activeRunIds };
    })
    .immediate();
}

/**
 * Best-effort CAS rollback for the preparatory task pause. A concurrent task
 * edit wins rather than being overwritten by rebuild failure recovery.
 */
export function restoreWorkspaceTasksAfterFailedRebuild(
  pause: WorkspaceTaskRebuildPause,
): { restored: string[]; conflicts: string[] } {
  return db
    .transaction(() => {
      const restored: string[] = [];
      const conflicts: string[] = [];
      const now = new Date().toISOString();
      const restore = db.prepare(
        `UPDATE scheduled_tasks
         SET status = ?, next_run = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      );
      for (const task of pause.tasks) {
        const result = restore.run(
          task.originalStatus,
          task.originalNextRun,
          now,
          task.id,
          task.preparedRevision,
        );
        if (result.changes === 1) restored.push(task.id);
        else conflicts.push(task.id);
      }
      return { restored, conflicts };
    })
    .immediate();
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
      | 'delivery_route_jid'
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
        : toUtf8String(
            updates.script_command,
            'scheduled_tasks.script_command',
          ),
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
    values.push(
      updates.notify_channels != null
        ? JSON.stringify(updates.notify_channels)
        : null,
    );
  }
  if (updates.chat_jid !== undefined) {
    fields.push('chat_jid = ?');
    values.push(updates.chat_jid);
  }
  if (updates.delivery_route_jid !== undefined) {
    fields.push('delivery_route_jid = ?');
    values.push(updates.delivery_route_jid);
  }
  if (updates.group_folder !== undefined) {
    fields.push('group_folder = ?');
    values.push(updates.group_folder);
  }

  if (fields.length === 0) return;

  fields.push('revision = revision + 1');
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
  ).run(...values);
}

export type TaskRevisionMutationResult =
  | { status: 'updated'; task: ScheduledTask }
  | { status: 'conflict'; task: ScheduledTask }
  | { status: 'not_found' };

export type TaskSoftDeleteMutationResult =
  | TaskRevisionMutationResult
  | { status: 'active_run'; task: ScheduledTask; run: TaskRun };

export type TaskPermanentDeleteMutationResult =
  | { status: 'deleted'; task_ids: string[] }
  | { status: 'conflict'; task: ScheduledTask }
  | { status: 'not_deleted'; task: ScheduledTask }
  | { status: 'active_run'; task: ScheduledTask; run: TaskRun }
  | { status: 'not_found'; task_id: string };

/**
 * Optimistic mutation used by V2 REST/MCP callers. Legacy updateTask remains
 * available while all in-process clients migrate to this contract.
 */
export function updateTaskWithRevision(
  id: string,
  expectedRevision: number,
  updates: Parameters<typeof updateTask>[1],
): TaskRevisionMutationResult {
  const current = getTaskById(id);
  if (!current || current.deleted_at) return { status: 'not_found' };
  if (current.revision !== expectedRevision) {
    return { status: 'conflict', task: current };
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  const pushText = (field: string, value: unknown) => {
    fields.push(`${field} = ?`);
    values.push(value);
  };
  if (updates.prompt !== undefined)
    pushText('prompt', toUtf8String(updates.prompt, 'scheduled_tasks.prompt'));
  if (updates.schedule_type !== undefined)
    pushText('schedule_type', updates.schedule_type);
  if (updates.schedule_value !== undefined)
    pushText('schedule_value', updates.schedule_value);
  if (updates.context_mode !== undefined)
    pushText('context_mode', updates.context_mode);
  if (updates.execution_type !== undefined)
    pushText('execution_type', updates.execution_type);
  if (updates.execution_mode !== undefined)
    pushText('execution_mode', updates.execution_mode);
  if (updates.script_command !== undefined) {
    pushText(
      'script_command',
      updates.script_command == null
        ? null
        : toUtf8String(
            updates.script_command,
            'scheduled_tasks.script_command',
          ),
    );
  }
  if (updates.next_run !== undefined) pushText('next_run', updates.next_run);
  if (updates.status !== undefined) pushText('status', updates.status);
  if (updates.notify_channels !== undefined) {
    pushText(
      'notify_channels',
      updates.notify_channels == null
        ? null
        : JSON.stringify(updates.notify_channels),
    );
  }
  if (updates.chat_jid !== undefined) pushText('chat_jid', updates.chat_jid);
  if (updates.delivery_route_jid !== undefined)
    pushText('delivery_route_jid', updates.delivery_route_jid);
  if (updates.group_folder !== undefined)
    pushText('group_folder', updates.group_folder);

  if (fields.length === 0) return { status: 'updated', task: current };
  fields.push('revision = revision + 1', 'updated_at = ?');
  values.push(new Date().toISOString(), id, expectedRevision);
  const result = db
    .prepare(
      `UPDATE scheduled_tasks SET ${fields.join(', ')}
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
    )
    .run(...values);
  const latest = getTaskById(id);
  if (result.changes === 1 && latest)
    return { status: 'updated', task: latest };
  if (!latest || latest.deleted_at) return { status: 'not_found' };
  return { status: 'conflict', task: latest };
}

export function softDeleteTaskWithRevision(
  id: string,
  expectedRevision: number,
): TaskSoftDeleteMutationResult {
  return db
    .transaction((): TaskSoftDeleteMutationResult => {
      const current = getTaskById(id);
      if (!current || current.deleted_at) return { status: 'not_found' };
      if (current.revision !== expectedRevision) {
        return { status: 'conflict', task: current };
      }
      const activeRun = getActiveTaskRunForTask(id);
      if (activeRun) {
        return { status: 'active_run', task: current, run: activeRun };
      }
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `UPDATE scheduled_tasks
           SET deleted_at = ?, status = 'paused', next_run = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM task_runs
               WHERE task_id = scheduled_tasks.id
                 AND status IN ('queued','running','retry_wait')
             )`,
        )
        .run(now, now, id, expectedRevision);
      const latest = getTaskById(id);
      if (result.changes === 1 && latest) {
        return { status: 'updated', task: latest };
      }
      if (!latest || latest.deleted_at) return { status: 'not_found' };
      const racedRun = getActiveTaskRunForTask(id);
      if (racedRun) {
        return { status: 'active_run', task: latest, run: racedRun };
      }
      return { status: 'conflict', task: latest };
    })
    .immediate();
}

/** Restore only the definition/history; the user must explicitly resume it. */
export function restoreTaskWithRevision(
  id: string,
  expectedRevision: number,
): TaskRevisionMutationResult {
  return db
    .transaction((): TaskRevisionMutationResult => {
      const current = getTaskById(id);
      if (!current) return { status: 'not_found' };
      if (current.revision !== expectedRevision) {
        return { status: 'conflict', task: current };
      }
      if (!current.deleted_at) return { status: 'updated', task: current };
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `UPDATE scheduled_tasks
           SET deleted_at = NULL, status = 'paused', next_run = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`,
        )
        .run(now, id, expectedRevision);
      const latest = getTaskById(id);
      if (result.changes === 1 && latest)
        return { status: 'updated', task: latest };
      if (!latest) return { status: 'not_found' };
      return { status: 'conflict', task: latest };
    })
    .immediate();
}

/**
 * Permanently remove soft-deleted task definitions and their run history.
 * The whole batch is atomic: a stale revision, restored task, or active run
 * aborts the operation so "empty recycle bin" cannot silently skip records.
 */
export function permanentlyDeleteTasksWithRevisions(
  tasks: Array<{ id: string; expectedRevision: number }>,
): TaskPermanentDeleteMutationResult {
  return db
    .transaction((): TaskPermanentDeleteMutationResult => {
      const currentTasks: ScheduledTask[] = [];
      for (const requested of tasks) {
        const current = getTaskById(requested.id);
        if (!current) {
          return { status: 'not_found', task_id: requested.id };
        }
        if (current.revision !== requested.expectedRevision) {
          return { status: 'conflict', task: current };
        }
        if (!current.deleted_at) {
          return { status: 'not_deleted', task: current };
        }
        const activeRun = getActiveTaskRunForTask(requested.id);
        if (activeRun) {
          return { status: 'active_run', task: current, run: activeRun };
        }
        currentTasks.push(current);
      }

      const deleteRunLogs = db.prepare(
        'DELETE FROM task_run_logs WHERE task_id = ?',
      );
      const deleteRuns = db.prepare('DELETE FROM task_runs WHERE task_id = ?');
      const deleteDefinition = db.prepare(
        `DELETE FROM scheduled_tasks
         WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`,
      );
      for (const task of currentTasks) {
        deleteRunLogs.run(task.id);
        deleteRuns.run(task.id);
        const result = deleteDefinition.run(task.id, task.revision);
        if (result.changes !== 1) {
          throw new Error(
            `Failed to permanently delete task ${task.id} after validation`,
          );
        }
      }

      return {
        status: 'deleted',
        task_ids: currentTasks.map((task) => task.id),
      };
    })
    .immediate();
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
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `DELETE FROM task_runs
       WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)`,
    ).run(folder);
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
	    WHERE status = 'active'
	      AND deleted_at IS NULL
	      AND next_run IS NOT NULL
	      AND next_run <= ?
	      AND (running_until IS NULL OR running_until <= ?)
	    ORDER BY next_run
	  `,
    )
    .all(now, now)
    .map(mapTaskRow);
}

/** V2 ignores the legacy definition-level lease; ownership lives on task_runs. */
export function getDueTaskDefinitionsV2(limit = 100): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND deleted_at IS NULL
         AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run LIMIT ?`,
    )
    .all(now, limit)
    .map(mapTaskRow);
}

// Clear every task's run lease (running_until/runner_id) unconditionally.
// Must be called once at scheduler process startup, before the first
// getDueTasks() poll: a lease held in the DB can only have been acquired by
// a runner process that no longer exists (this process just started, and
// its own in-memory runningTaskIds is freshly cleared too), so any lease
// still on disk is stale by definition — leaving it in place would hide a
// crash-interrupted task from getDueTasks() until the lease's absolute
// expiry, and if that expiry lands past the backfill grace window the
// interrupted run is silently skipped forever instead of retried.
export function clearStaleTaskLeases(): number {
  const result = db
    .prepare(
      `
    UPDATE scheduled_tasks
    SET running_until = NULL, runner_id = NULL
    WHERE running_until IS NOT NULL OR runner_id IS NOT NULL
  `,
    )
    .run();
  return result.changes;
}

export function claimTaskForRun(
  id: string,
  runnerId: string,
  leaseMs: number,
): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const result = db
    .prepare(
      `
    UPDATE scheduled_tasks
    SET runner_id = ?, running_until = ?
    WHERE id = ?
      AND status = 'active'
      AND next_run IS NOT NULL
      AND next_run <= ?
      AND (running_until IS NULL OR running_until <= ?)
  `,
    )
    .run(runnerId, leaseUntil, id, nowIso, nowIso);
  return result.changes === 1;
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
	    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
	        running_until = NULL, runner_id = NULL
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
	    SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
	        running_until = NULL, runner_id = NULL
    WHERE id = ?
  `,
  ).run(nextRun, nextRun, id);
}

// Pause a recurring task that just ran but whose schedule produces no next_run
// (corrupted schedule_value, cron parse failure). Unlike updateTaskAfterRun(null)
// it does NOT flip status to 'completed' (which would silently disable it);
// it records THIS run's last_run/last_result so the task detail view is accurate
// and clears next_run so the owner can fix the schedule and re-activate.
export function pauseTaskAfterRun(id: string, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
	    SET next_run = NULL, last_run = ?, last_result = ?, status = 'paused',
	        running_until = NULL, runner_id = NULL
    WHERE id = ?
  `,
  ).run(now, lastResult, id);
}

interface TaskRunRow {
  id: string;
  task_id: string;
  occurrence_key: string;
  trigger_type: TaskRunTrigger;
  idempotency_key: string | null;
  scheduled_for: string;
  definition_revision: number;
  definition_snapshot: string;
  status: TaskRunStatus;
  attempt: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  duration_ms: number;
  result: string | null;
  error: string | null;
  notification_status: TaskRunNotificationStatus;
  notification_error: string | null;
  notification_summary: string | null;
  notification_payload: string | null;
  notification_attempt: number;
  notification_available_at: string | null;
  notification_lease_owner: string | null;
  notification_lease_token: number;
  notification_lease_expires_at: string | null;
  notification_lease_payload: string | null;
  notification_generation: number;
}

function taskDefinitionSnapshot(
  task: ScheduledTask,
): TaskRunDefinitionSnapshot {
  return {
    prompt: task.prompt,
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    delivery_route_jid: task.delivery_route_jid ?? task.chat_jid,
    context_mode: task.context_mode,
    execution_type: task.execution_type,
    execution_mode: task.execution_mode ?? null,
    script_command: task.script_command,
    notify_channels: task.notify_channels ?? null,
  };
}

function mapTaskRunRow(row: TaskRunRow): TaskRun {
  let snapshot: TaskRunDefinitionSnapshot;
  try {
    snapshot = JSON.parse(row.definition_snapshot) as TaskRunDefinitionSnapshot;
    if (snapshot.delivery_route_jid === undefined) {
      snapshot.delivery_route_jid = snapshot.chat_jid || null;
    }
  } catch {
    snapshot = {
      prompt: '',
      group_folder: '',
      chat_jid: '',
      delivery_route_jid: null,
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: null,
      script_command: null,
      notify_channels: null,
    };
  }
  let notificationSummary: TaskRunNotificationSummary | null = null;
  if (row.notification_summary) {
    try {
      notificationSummary = JSON.parse(
        row.notification_summary,
      ) as TaskRunNotificationSummary;
    } catch {
      notificationSummary = null;
    }
  }
  return {
    ...row,
    definition_snapshot: snapshot,
    notification_summary: notificationSummary,
  };
}

function insertTaskRunRow(
  task: ScheduledTask,
  input: {
    id: string;
    occurrenceKey: string;
    triggerType: TaskRunTrigger;
    idempotencyKey: string | null;
    scheduledFor: string;
    status: 'queued' | 'missed';
    availableAt: string;
    result?: string | null;
    error?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const terminal = input.status === 'missed' ? now : null;
  db.prepare(
    `INSERT INTO task_runs (
       id, task_id, occurrence_key, trigger_type, idempotency_key,
       scheduled_for, definition_revision, definition_snapshot, status,
       attempt, available_at, lease_owner, lease_token, lease_expires_at,
       started_at, completed_at, created_at, updated_at, duration_ms,
       result, error, notification_status, notification_error,
       notification_summary, notification_payload, notification_attempt,
       notification_available_at, notification_lease_owner,
       notification_lease_token, notification_lease_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 0, NULL,
               NULL, ?, ?, ?, 0, ?, ?, ?, NULL,
               NULL, NULL, 0, NULL, NULL, 0, NULL)`,
  ).run(
    input.id,
    task.id,
    input.occurrenceKey,
    input.triggerType,
    input.idempotencyKey,
    input.scheduledFor,
    task.revision,
    JSON.stringify(taskDefinitionSnapshot(task)),
    input.status,
    input.availableAt,
    terminal,
    now,
    now,
    input.result ?? null,
    input.error ?? null,
    input.status === 'missed' ? 'skipped' : 'pending',
  );
}

export interface CreateTaskRunInput {
  task: ScheduledTask;
  triggerType: TaskRunTrigger;
  scheduledFor?: string;
  idempotencyKey?: string | null;
  availableAt?: string;
}

export interface CreateTaskRunResult {
  created: boolean;
  reason?: 'duplicate' | 'active_conflict';
  run: TaskRun;
}

/**
 * Create a manual occurrence. Scheduled/backfill occurrences should normally
 * use materializeTaskOccurrence so cursor advancement is atomic with creation.
 */
export function createTaskRun(input: CreateTaskRunInput): CreateTaskRunResult {
  const task = input.task;
  if (task.deleted_at)
    throw new Error('Cannot create a run for a deleted task');
  const scheduledFor = input.scheduledFor ?? new Date().toISOString();
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const id = crypto.randomUUID();
  const occurrenceKey =
    input.triggerType === 'manual'
      ? `${task.id}:manual:${idempotencyKey ?? id}`
      : `${task.id}:${scheduledFor}`;
  const availableAt = input.availableAt ?? new Date().toISOString();

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM task_runs WHERE occurrence_key = ?')
      .get(occurrenceKey) as TaskRunRow | undefined;
    if (existing) {
      return {
        created: false,
        reason: 'duplicate' as const,
        run: mapTaskRunRow(existing),
      };
    }
    if (idempotencyKey) {
      const idempotent = db
        .prepare(
          'SELECT * FROM task_runs WHERE task_id = ? AND idempotency_key = ?',
        )
        .get(task.id, idempotencyKey) as TaskRunRow | undefined;
      if (idempotent) {
        return {
          created: false,
          reason: 'duplicate' as const,
          run: mapTaskRunRow(idempotent),
        };
      }
    }
    const active = db
      .prepare(
        `SELECT * FROM task_runs
         WHERE task_id = ? AND status IN ('queued','running','retry_wait')
         ORDER BY created_at LIMIT 1`,
      )
      .get(task.id) as TaskRunRow | undefined;
    if (active) {
      return {
        created: false,
        reason: 'active_conflict' as const,
        run: mapTaskRunRow(active),
      };
    }
    insertTaskRunRow(task, {
      id,
      occurrenceKey,
      triggerType: input.triggerType,
      idempotencyKey,
      scheduledFor,
      status: 'queued',
      availableAt,
    });
    return {
      created: true,
      run: getTaskRunById(id)!,
    };
  })();
}

export interface MaterializeTaskOccurrenceInput {
  taskId: string;
  scheduledFor: string;
  nextRun: string | null;
  triggerType: 'scheduled' | 'backfill';
  /** Intentionally skipped occurrences are persisted as terminal missed rows. */
  missedReason?: string;
}

/**
 * Atomically materialize one due occurrence and advance its definition cursor.
 * A still-active previous occurrence never overlaps: this occurrence is
 * recorded as missed and the schedule continues.
 */
export function materializeTaskOccurrence(
  input: MaterializeTaskOccurrenceInput,
): CreateTaskRunResult | undefined {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE id = ? AND deleted_at IS NULL AND status = 'active'
           AND next_run = ?`,
      )
      .get(input.taskId, input.scheduledFor);
    if (!row) return undefined;
    const task = mapTaskRow(row);
    const occurrenceKey = `${task.id}:${input.scheduledFor}`;
    const existing = db
      .prepare('SELECT * FROM task_runs WHERE occurrence_key = ?')
      .get(occurrenceKey) as TaskRunRow | undefined;
    if (existing) {
      return {
        created: false,
        reason: 'duplicate' as const,
        run: mapTaskRunRow(existing),
      };
    }
    const active = db
      .prepare(
        `SELECT * FROM task_runs
         WHERE task_id = ? AND status IN ('queued','running','retry_wait')
         ORDER BY created_at LIMIT 1`,
      )
      .get(task.id) as TaskRunRow | undefined;
    const missedReason =
      input.missedReason ??
      (active
        ? `Skipped: previous occurrence ${active.id} is still active`
        : null);
    const status = missedReason ? 'missed' : 'queued';
    const runId = crypto.randomUUID();
    insertTaskRunRow(task, {
      id: runId,
      occurrenceKey,
      triggerType: input.triggerType,
      idempotencyKey: null,
      scheduledFor: input.scheduledFor,
      status,
      availableAt: new Date().toISOString(),
      error: missedReason,
    });
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE scheduled_tasks
       SET next_run = ?, updated_at = ?
       WHERE id = ? AND next_run = ? AND deleted_at IS NULL`,
    ).run(input.nextRun, now, task.id, input.scheduledFor);
    if (
      status === 'missed' &&
      task.schedule_type === 'once' &&
      input.nextRun === null
    ) {
      db.prepare(
        `UPDATE scheduled_tasks SET status = 'completed', updated_at = ?
         WHERE id = ? AND status = 'active' AND next_run IS NULL`,
      ).run(now, task.id);
    }
    return { created: true, run: getTaskRunById(runId)! };
  })();
}

export function getTaskRunById(id: string): TaskRun | undefined {
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as
    | TaskRunRow
    | undefined;
  return row ? mapTaskRunRow(row) : undefined;
}

export function getActiveTaskRunForTask(taskId: string): TaskRun | undefined {
  const row = db
    .prepare(
      `SELECT * FROM task_runs
       WHERE task_id = ?
         AND (
           status IN ('queued','running','retry_wait')
           OR (
             status = 'delivered'
             AND json_valid(definition_snapshot)
             AND json_extract(definition_snapshot, '$.context_mode') = 'group'
           )
         )
       ORDER BY
         CASE WHEN status IN ('queued','running','retry_wait') THEN 0 ELSE 1 END,
         created_at
       LIMIT 1`,
    )
    .get(taskId) as TaskRunRow | undefined;
  return row ? mapTaskRunRow(row) : undefined;
}

export function getTaskRunsForTask(taskId: string, limit = 20): TaskRun[] {
  return (
    db
      .prepare(
        `SELECT * FROM task_runs WHERE task_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as TaskRunRow[]
  ).map(mapTaskRunRow);
}

export function getTaskRunsByStatus(
  statuses: TaskRunStatus[],
  limit = 100,
): TaskRun[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  return (
    db
      .prepare(
        `SELECT * FROM task_runs WHERE status IN (${placeholders})
         ORDER BY available_at, created_at LIMIT ?`,
      )
      .all(...statuses, limit) as TaskRunRow[]
  ).map(mapTaskRunRow);
}

export function claimNextTaskRun(
  owner: string,
  leaseMs: number,
): ClaimedTaskRun | undefined {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT * FROM task_runs
         WHERE (
           status IN ('queued','retry_wait') AND available_at <= ?
         ) OR (
           status = 'running' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ? AND started_at IS NULL
         )
         ORDER BY available_at, scheduled_for, created_at LIMIT 1`,
      )
      .get(nowIso, nowIso) as TaskRunRow | undefined;
    if (!candidate) return undefined;
    const nextToken = candidate.lease_token + 1;
    const result = db
      .prepare(
        `UPDATE task_runs
         SET status = 'running', lease_owner = ?, lease_token = ?,
             lease_expires_at = ?, attempt = attempt + 1,
             updated_at = ?
         WHERE id = ? AND (
           (status IN ('queued','retry_wait') AND available_at <= ?)
           OR (status = 'running' AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ? AND started_at IS NULL)
         )`,
      )
      .run(owner, nextToken, expiresAt, nowIso, candidate.id, nowIso, nowIso);
    if (result.changes !== 1) return undefined;
    return getTaskRunById(candidate.id) as ClaimedTaskRun;
  })();
}

/** Mark the irreversible execution boundary before invoking Agent/script/group. */
export function markTaskRunExecutionStarted(
  id: string,
  owner: string,
  token: number,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE task_runs SET started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM scheduled_tasks
           WHERE scheduled_tasks.id = task_runs.task_id
             AND scheduled_tasks.deleted_at IS NULL
             AND scheduled_tasks.status IN ('active','paused')
         )`,
    )
    .run(now, now, id, owner, token, now);
  return result.changes === 1;
}

/**
 * A process crash after execution started is not known-safe to replay. Record
 * it as interrupted instead of blindly repeating possible external effects.
 */
export function failExpiredStartedTaskRuns(): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const expired = db
      .prepare(
        `SELECT id, task_id FROM task_runs
         WHERE status = 'running' AND started_at IS NOT NULL
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .all(now) as Array<{ id: string; task_id: string }>;
    if (expired.length === 0) return 0;
    const failOne = db.prepare(
      `UPDATE task_runs
       SET status = 'failed', completed_at = ?, updated_at = ?,
           error = COALESCE(error, 'Process stopped after execution began; not retried to avoid duplicate side effects'),
           notification_status = CASE
             WHEN notification_status = 'pending'
                  AND notification_payload IS NULL THEN 'skipped'
             ELSE notification_status
           END,
           notification_lease_owner = NULL,
           notification_lease_expires_at = NULL,
           notification_lease_payload = NULL,
           lease_owner = NULL, lease_expires_at = NULL,
           lease_token = lease_token + 1
       WHERE id = ? AND status = 'running' AND started_at IS NOT NULL
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    );
    let changed = 0;
    const taskIdSet = new Set<string>();
    for (const run of expired) {
      const result = failOne.run(now, now, run.id, now);
      if (result.changes === 1) {
        changed++;
        taskIdSet.add(run.task_id);
      }
    }
    const taskIds = [...taskIdSet];
    if (taskIds.length === 0) return 0;
    const taskPlaceholders = taskIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'completed', updated_at = ?
       WHERE id IN (${taskPlaceholders}) AND schedule_type = 'once'
         AND next_run IS NULL AND status IN ('active','paused')`,
    ).run(now, ...taskIds);
    return changed;
  })();
}

/**
 * Lease expiry decides who may *take over*, never who may *commit*.
 *
 * `renew`/`release`/`complete` fence on `lease_owner` + `lease_token` only. A
 * worker whose lease lapsed while nobody claimed it still owns its result and
 * can settle it; the moment another owner claims the row the token advances and
 * every write from the old worker is rejected. Gating these writes on
 * `lease_expires_at > now` as well produced the opposite failure: a run that had
 * actually finished — possibly after already sending its output to the user —
 * could not be committed, stayed `running`, and was later marked `failed` by
 * `failExpiredStartedTaskRuns`. Because started runs are deliberately
 * at-most-once, that lost the execution outright and raised a false failure
 * alert.
 *
 * Every takeover path (`claimNextTaskRun`, `cancelTaskRun`,
 * `failExpiredStartedTaskRuns`) increments `lease_token`, so dropping the time
 * condition does not open a double-write window.
 */
export function renewTaskRunLease(
  id: string,
  owner: string,
  token: number,
  leaseMs: number,
): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = db
    .prepare(
      `UPDATE task_runs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_token = ?`,
    )
    .run(expiresAt, nowIso, id, owner, token);
  return result.changes === 1;
}

/**
 * `attempt` is incremented by `claimNextTaskRun`, so it counts claims. A
 * release that is not the run's own fault must give that budget back, otherwise
 * process shutdown burns the pre-execution retry allowance: five ordinary
 * restarts would permanently fail an occurrence that never executed once.
 * Mirrors the reference runtime's `incrementFailure=false` release.
 */
export function releaseTaskRunForRetry(
  id: string,
  owner: string,
  token: number,
  availableAt: string,
  error: string,
  options: { countsAsAttempt?: boolean } = {},
): boolean {
  const now = new Date().toISOString();
  const attemptExpr =
    options.countsAsAttempt === false ? 'MAX(0, attempt - 1)' : 'attempt';
  const result = db
    .prepare(
      `UPDATE task_runs
       SET status = 'retry_wait', available_at = ?, error = ?,
           attempt = ${attemptExpr},
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_token = ?`,
    )
    .run(availableAt, error, now, id, owner, token);
  return result.changes === 1;
}

export interface CompleteTaskRunInput {
  status: Extract<
    TaskRunStatus,
    'success' | 'failed' | 'cancelled' | 'delivered'
  >;
  result?: string | null;
  error?: string | null;
  notificationStatus?: TaskRunNotificationStatus;
  notificationError?: string | null;
}

export function completeTaskRun(
  id: string,
  owner: string,
  token: number,
  input: CompleteTaskRunInput,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const current = db
      .prepare('SELECT * FROM task_runs WHERE id = ?')
      .get(id) as TaskRunRow | undefined;
    // Fencing is owner+token only; see renewTaskRunLease for why an expired
    // but unclaimed lease must still be able to settle its own result.
    if (
      !current ||
      current.status !== 'running' ||
      current.lease_owner !== owner ||
      current.lease_token !== token
    ) {
      return false;
    }
    const startedAt = current.started_at
      ? new Date(current.started_at).getTime()
      : new Date(current.created_at).getTime();
    const durationMs = Math.max(0, Date.now() - startedAt);
    // IPC delivery can finish before the Agent process exits. Do not replace a
    // real receipt with the isolated-run fallback `pending` value.
    const requestedNotificationStatus =
      input.notificationStatus ?? current.notification_status;
    const effectiveNotificationStatus = current.notification_payload
      ? requestedNotificationStatus === 'success' ||
        requestedNotificationStatus === 'skipped'
        ? current.notification_status === 'pending'
          ? 'failed'
          : current.notification_status
        : requestedNotificationStatus === 'pending' &&
            current.notification_status !== 'pending'
          ? current.notification_status
          : requestedNotificationStatus
      : requestedNotificationStatus === 'pending' &&
          current.notification_status !== 'pending'
        ? current.notification_status
        : requestedNotificationStatus;
    const effectiveNotificationError =
      effectiveNotificationStatus === current.notification_status &&
      current.notification_status !== 'pending'
        ? current.notification_error
        : (input.notificationError ?? null);
    const changed = db
      .prepare(
        `UPDATE task_runs
         SET status = ?, result = ?, error = ?, notification_status = ?,
             notification_error = ?, duration_ms = ?, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_token = ?`,
      )
      .run(
        input.status,
        input.result ?? null,
        input.error ?? null,
        effectiveNotificationStatus,
        effectiveNotificationError,
        durationMs,
        now,
        now,
        id,
        owner,
        token,
      );
    if (changed.changes !== 1) return false;
    const summary = input.error
      ? `Error: ${input.error}`
      : input.result?.slice(0, 200) ||
        (input.status === 'delivered' ? 'Delivered' : 'Completed');
    db.prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?,
           status = CASE
             WHEN schedule_type = 'once' AND next_run IS NULL THEN 'completed'
             ELSE status
           END,
           updated_at = ?
       WHERE id = ?`,
    ).run(now, summary, now, current.task_id);
    return true;
  })();
}

/**
 * Atomically terminalize one fenced isolated execution and enqueue its
 * canonical Web workspace result.
 *
 * The Agent may already have performed arbitrary tool side effects by this
 * point, so persisting the execution terminal separately from the Web repair
 * intent would create an avoidable replay window. The notification worker
 * performs only the idempotent workspace projection; it never reruns Agent
 * work or interprets Agent-owned tools such as feishu-cli.
 */
export function completeIsolatedTaskRunWithWorkspaceResultIntent(input: {
  runId: string;
  taskId: string;
  leaseOwner: string;
  leaseToken: number;
  status: 'success' | 'failed';
  result?: string | null;
  error?: string | null;
  payload: TaskRunTextNotificationPayload;
}): boolean {
  if (
    input.payload.kind !== 'workspace_result' ||
    input.payload.groupRunId ||
    input.payload.groupTaskId ||
    input.payload.options?.sourceKind !== 'scheduled_task_result' ||
    input.payload.options.messageId !== `scheduled-task-result:${input.runId}`
  ) {
    return false;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  return db.transaction(() => {
    const current = db
      .prepare('SELECT * FROM task_runs WHERE id = ?')
      .get(input.runId) as TaskRunRow | undefined;
    if (
      !current ||
      current.task_id !== input.taskId ||
      current.status !== 'running' ||
      current.lease_owner !== input.leaseOwner ||
      current.lease_token !== input.leaseToken
    ) {
      return false;
    }

    let currentPayload: TaskRunNotificationPayload | null = null;
    let currentSummary: TaskRunNotificationSummary = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failed_channels: [],
    };
    try {
      currentPayload = current.notification_payload
        ? (JSON.parse(
            current.notification_payload,
          ) as TaskRunNotificationPayload)
        : null;
      currentSummary = current.notification_summary
        ? (JSON.parse(
            current.notification_summary,
          ) as TaskRunNotificationSummary)
        : currentSummary;
    } catch {
      return false;
    }

    const mergedPayload = mergeTaskRunNotificationPayloads(
      currentPayload,
      input.payload,
    );
    if (!mergedPayload) return false;
    const notificationStatus: TaskRunNotificationStatus =
      current.notification_status === 'failed' ||
      current.notification_status === 'partial_failed'
        ? current.notification_status
        : 'pending';
    const startedAt = current.started_at
      ? new Date(current.started_at).getTime()
      : new Date(current.created_at).getTime();
    const durationMs = Math.max(0, now.getTime() - startedAt);
    const availableAt =
      current.notification_available_at &&
      current.notification_available_at < nowIso
        ? current.notification_available_at
        : nowIso;
    const changed = db
      .prepare(
        `UPDATE task_runs
         SET status = ?, result = ?, error = ?,
             notification_status = ?, notification_error = ?,
             notification_summary = ?, notification_payload = ?,
             notification_attempt = CASE
               WHEN notification_lease_owner IS NULL THEN 0
               ELSE notification_attempt
             END,
             notification_available_at = ?,
             notification_generation = notification_generation + 1,
             duration_ms = ?, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'running'
           AND lease_owner = ? AND lease_token = ?`,
      )
      .run(
        input.status,
        input.result ?? null,
        input.error ?? null,
        notificationStatus,
        current.notification_error,
        JSON.stringify(currentSummary),
        JSON.stringify(mergedPayload),
        availableAt,
        durationMs,
        nowIso,
        nowIso,
        input.runId,
        input.taskId,
        input.leaseOwner,
        input.leaseToken,
      );
    if (changed.changes !== 1) return false;

    const summary = input.error
      ? `Error: ${input.error}`
      : input.result?.slice(0, 200) || 'Completed';
    db.prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?,
           status = CASE
             WHEN schedule_type = 'once' AND next_run IS NULL THEN 'completed'
             ELSE status
           END,
           updated_at = ?
       WHERE id = ?`,
    ).run(nowIso, summary, nowIso, input.taskId);
    return true;
  })();
}

export interface StoreScheduledGroupPromptInput {
  runId: string;
  taskId: string;
  leaseOwner: string;
  leaseToken: number;
  messageId: string;
  chatJid: string;
  senderId: string;
  senderName: string;
  text: string;
  queuedResult: string;
}

/**
 * Atomically cross the group-mode execution boundary.
 *
 * Persisting the prompt and releasing the run lease in separate transactions
 * leaves a crash window where the workspace later executes the prompt while
 * lease recovery marks its run failed. Keeping both writes under one SQLite
 * transaction makes either the prompt+delivered hand-off visible together or
 * neither visible.
 */
export function storeScheduledGroupPromptAndCompleteRun(
  input: StoreScheduledGroupPromptInput,
): string {
  return db.transaction(() => {
    const run = db
      .prepare(
        `SELECT task_id, status, lease_owner, lease_token, started_at, created_at
         FROM task_runs WHERE id = ?`,
      )
      .get(input.runId) as
      | Pick<
          TaskRunRow,
          | 'task_id'
          | 'status'
          | 'lease_owner'
          | 'lease_token'
          | 'started_at'
          | 'created_at'
        >
      | undefined;
    if (!run || run.task_id !== input.taskId) {
      throw new Error(
        `Group task run ${input.runId} does not belong to task ${input.taskId}`,
      );
    }

    ensureChatExists(input.chatJid);
    const messageId = storeMessageDirect(
      input.messageId,
      input.chatJid,
      input.senderId,
      input.senderName,
      input.text,
      new Date().toISOString(),
      false,
      {
        meta: {
          sourceKind: 'scheduled_task_prompt',
          taskId: input.taskId,
        },
      },
    );

    const now = new Date().toISOString();
    const startedAt = run.started_at
      ? new Date(run.started_at).getTime()
      : new Date(run.created_at).getTime();
    const durationMs = Math.max(0, Date.now() - startedAt);
    const changed = db
      .prepare(
        `UPDATE task_runs
         SET status = 'delivered', result = ?, error = NULL,
             notification_status = 'skipped', notification_error = NULL,
             duration_ms = ?, completed_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'running'
           AND lease_owner = ? AND lease_token = ?`,
      )
      .run(
        input.queuedResult,
        durationMs,
        now,
        now,
        input.runId,
        input.taskId,
        input.leaseOwner,
        input.leaseToken,
      );
    if (changed.changes !== 1) {
      throw new Error(
        `Group task run ${input.runId} lost its execution fence during prompt delivery`,
      );
    }
    db.prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?,
           status = CASE
             WHEN schedule_type = 'once' AND next_run IS NULL THEN 'completed'
             ELSE status
           END,
           updated_at = ?
       WHERE id = ?`,
    ).run(now, input.queuedResult.slice(0, 200), now, input.taskId);
    return messageId;
  })();
}

/**
 * Replace a group-mode run's queue acknowledgement with the exact Assistant
 * outcome produced by that scheduler-owned prompt.
 *
 * Group execution crosses an asynchronous workspace queue boundary, so its
 * lease is intentionally released as `delivered` after prompt injection. The
 * stable prompt message id later identifies this exact run. Only that terminal
 * hand-off state may be upgraded; ordinary conversations and another
 * occurrence of the same task cannot overwrite it.
 */
export function finalizeDeliveredGroupTaskRun(
  id: string,
  taskId: string,
  input: {
    status?: 'success' | 'failed' | 'cancelled';
    result?: string | null;
    error?: string | null;
  },
): boolean {
  return db.transaction(() =>
    finalizeDeliveredGroupTaskRunInTransaction(id, taskId, input),
  )();
}

function finalizeDeliveredGroupTaskRunInTransaction(
  id: string,
  taskId: string,
  input: {
    status?: 'success' | 'failed' | 'cancelled';
    result?: string | null;
    error?: string | null;
  },
): boolean {
  const resultText = input.result?.trim() || null;
  const errorText = input.error?.trim() || null;
  const status = input.status ?? (errorText ? 'failed' : 'success');
  const now = new Date().toISOString();
  const current = db
    .prepare(
      `SELECT task_id, status, result, error, completed_at
         FROM task_runs WHERE id = ?`,
    )
    .get(id) as
    | Pick<
        TaskRunRow,
        'task_id' | 'status' | 'result' | 'error' | 'completed_at'
      >
    | undefined;
  if (!current || current.task_id !== taskId) return false;

  // Duplicate SDK terminal frames and replay-safe Web writes are no-ops.
  if (
    current.status === status &&
    current.result === resultText &&
    current.error === errorText
  ) {
    return true;
  }
  if (current.status !== 'delivered') return false;

  const changed = db
    .prepare(
      `UPDATE task_runs
         SET status = ?, result = ?, error = ?, completed_at = ?,
             duration_ms = CASE
               WHEN started_at IS NULL THEN duration_ms
               ELSE MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
             END,
             updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'delivered'`,
    )
    .run(status, resultText, errorText, now, now, now, id, taskId);
  if (changed.changes !== 1) return false;

  const summary = errorText
    ? `Error: ${errorText}`
    : resultText?.slice(0, 200) || 'Completed';
  // Do not let a late result from an older group occurrence overwrite a
  // newer run's task-list summary.
  db.prepare(
    `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?, updated_at = ?
       WHERE id = ?
         AND (last_run = ? OR last_run IS NULL)`,
  ).run(now, summary, now, taskId, current.completed_at);
  return true;
}

export interface ScheduledGroupWorkspaceFinalization {
  runId: string;
  taskId: string;
  status?: 'success' | 'failed' | 'cancelled';
  result?: string | null;
  error?: string | null;
}

export interface StoreScheduledGroupWorkspaceResultInput {
  messageId: string;
  chatJid: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sdkMessageUuid?: string;
    sourceKind?: MessageSourceKind;
    finalizationReason?: MessageFinalizationReason;
  };
  finalizations: ScheduledGroupWorkspaceFinalization[];
}

/**
 * Atomically persist one canonical group result and terminalize every exact
 * scheduler occurrence represented by that result.
 *
 * The WebSocket broadcast deliberately happens at the caller after this
 * transaction commits. A crash before commit leaves both message and runs
 * untouched; a crash after commit leaves a durable message that polling can
 * recover while the stable scheduler prompts are already terminal.
 */
export function storeScheduledGroupWorkspaceResultAndFinalize(
  input: StoreScheduledGroupWorkspaceResultInput,
): string {
  if (input.finalizations.length === 0) {
    throw new Error('Scheduled group workspace result has no run finalization');
  }
  return db.transaction(() => {
    ensureChatExists(input.chatJid);
    const messageId = storeMessageDirect(
      input.messageId,
      input.chatJid,
      input.senderId,
      input.senderName,
      input.text,
      input.timestamp,
      true,
      { meta: input.messageMeta },
    );
    for (const finalization of input.finalizations) {
      if (
        !finalizeDeliveredGroupTaskRunInTransaction(
          finalization.runId,
          finalization.taskId,
          {
            status: finalization.status,
            result: finalization.result,
            error: finalization.error,
          },
        )
      ) {
        throw new Error(
          `Group task run ${finalization.runId} could not atomically accept its workspace result`,
        );
      }
    }
    return messageId;
  })();
}

/** Cancellation increments the fencing token so a late worker cannot commit. */
export function cancelTaskRun(
  id: string,
  reason = 'Cancelled by user',
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT task_id FROM task_runs
         WHERE id = ? AND status IN ('queued','running','retry_wait')`,
      )
      .get(id) as { task_id: string } | undefined;
    if (!current) return false;
    const result = db
      .prepare(
        `UPDATE task_runs
         SET status = 'cancelled', error = ?, completed_at = ?, updated_at = ?,
             notification_status = 'skipped', notification_error = NULL,
             notification_payload = NULL, notification_available_at = NULL,
             notification_lease_owner = NULL,
             notification_lease_expires_at = NULL,
             notification_lease_payload = NULL,
             lease_owner = NULL, lease_expires_at = NULL,
             lease_token = lease_token + 1
         WHERE id = ? AND status IN ('queued','running','retry_wait')`,
      )
      .run(reason, now, now, id);
    if (result.changes !== 1) return false;
    db.prepare(
      `UPDATE scheduled_tasks SET status = 'completed', updated_at = ?
       WHERE id = ? AND schedule_type = 'once' AND next_run IS NULL
         AND status IN ('active','paused')`,
    ).run(now, current.task_id);
    return true;
  })();
}

/**
 * Cancel a group occurrence after its prompt crossed the workspace queue
 * boundary. `delivered` is terminal only for the scheduler worker; the Agent
 * still owes a business result, so user cancellation must remain available.
 *
 * The cancelled business terminal and its canonical Web projection intent are
 * committed together. The notification worker may then idempotently store and
 * broadcast the cancellation result without replaying Agent work.
 */
export function cancelDeliveredGroupTaskRunWithWorkspaceIntent(input: {
  runId: string;
  taskId: string;
  reason: string;
  payload: TaskRunTextNotificationPayload;
}): boolean {
  if (
    input.payload.kind !== 'workspace_result' ||
    input.payload.groupRunId !== input.runId ||
    input.payload.groupTaskId !== input.taskId ||
    input.payload.groupStatus !== 'cancelled' ||
    input.payload.groupResult !== null ||
    input.payload.groupError !== input.reason ||
    input.payload.options?.sourceKind !== 'scheduled_task_result' ||
    input.payload.options.messageId !==
      `scheduled-group-terminal:${input.runId}`
  ) {
    return false;
  }
  const payloadOptions = input.payload.options;

  const now = new Date().toISOString();
  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT task_id, definition_snapshot
           FROM task_runs
          WHERE id = ? AND task_id = ? AND status = 'delivered'`,
      )
      .get(input.runId, input.taskId) as
      | Pick<TaskRunRow, 'task_id' | 'definition_snapshot'>
      | undefined;
    if (!current) return false;

    let snapshot: TaskRunDefinitionSnapshot;
    try {
      snapshot = JSON.parse(
        current.definition_snapshot,
      ) as TaskRunDefinitionSnapshot;
    } catch {
      return false;
    }
    const deliveryRouteJid = snapshot.delivery_route_jid || snapshot.chat_jid;
    if (
      snapshot.context_mode !== 'group' ||
      input.payload.chatJid !== deliveryRouteJid ||
      payloadOptions.workspaceFolder !== snapshot.group_folder
    ) {
      return false;
    }

    const summary: TaskRunNotificationSummary = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failed_channels: [],
    };
    const changed = db
      .prepare(
        `UPDATE task_runs
            SET status = 'cancelled', result = NULL, error = ?,
                completed_at = ?, updated_at = ?,
                duration_ms = CASE
                  WHEN started_at IS NULL THEN duration_ms
                  ELSE MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
                END,
                notification_status = 'pending',
                notification_error = NULL,
                notification_summary = ?,
                notification_payload = ?,
                notification_attempt = 0,
                notification_available_at = ?,
                notification_lease_owner = NULL,
                notification_lease_expires_at = NULL,
                notification_lease_payload = NULL,
                notification_generation = notification_generation + 1,
                lease_owner = NULL, lease_expires_at = NULL,
                lease_token = lease_token + 1
          WHERE id = ? AND task_id = ? AND status = 'delivered'`,
      )
      .run(
        input.reason,
        now,
        now,
        now,
        JSON.stringify(summary),
        JSON.stringify(input.payload),
        now,
        input.runId,
        input.taskId,
      );
    if (changed.changes !== 1) return false;

    db.prepare(
      `UPDATE scheduled_tasks SET status = 'completed', updated_at = ?
       WHERE id = ? AND schedule_type = 'once' AND next_run IS NULL
         AND status IN ('active','paused')`,
    ).run(now, input.taskId);
    return true;
  })();
}

export function updateTaskRunNotification(
  id: string,
  status: TaskRunNotificationStatus,
  error: string | null = null,
  summary: TaskRunNotificationSummary | null = null,
): boolean {
  return db.transaction(() => {
    const current = db
      .prepare(
        `SELECT status, notification_status, notification_error,
                notification_summary, notification_payload
         FROM task_runs WHERE id = ?`,
      )
      .get(id) as
      | Pick<
          TaskRunRow,
          | 'status'
          | 'notification_status'
          | 'notification_error'
          | 'notification_summary'
          | 'notification_payload'
        >
      | undefined;
    if (
      !current ||
      current.status === 'cancelled' ||
      current.status === 'missed'
    ) {
      return false;
    }

    // A queued retry is authoritative evidence that delivery is unfinished.
    // Never let a late/coarse status-only write hide durable retry work.
    const preserveRetryState =
      current.notification_payload !== null &&
      (status === 'success' || status === 'skipped');
    const effectiveStatus = preserveRetryState
      ? current.notification_status === 'success' ||
        current.notification_status === 'skipped'
        ? 'failed'
        : current.notification_status
      : status;
    const effectiveError = preserveRetryState
      ? current.notification_error
      : error;
    const effectiveSummary = preserveRetryState
      ? current.notification_summary
      : summary
        ? JSON.stringify(summary)
        : null;

    const result = db
      .prepare(
        `UPDATE task_runs SET notification_status = ?, notification_error = ?,
           notification_summary = ?,
           notification_generation = notification_generation + 1,
           updated_at = ? WHERE id = ? AND status NOT IN ('cancelled','missed')`,
      )
      .run(
        effectiveStatus,
        effectiveError,
        effectiveSummary,
        new Date().toISOString(),
        id,
      );
    return result.changes === 1;
  })();
}

export interface TaskRunTextNotificationPayload {
  kind: 'store_result_and_notify' | 'send_message' | 'workspace_result';
  chatJid: string;
  text: string;
  /** Optional group-mode terminal transition completed after Web persistence. */
  groupRunId?: string;
  groupTaskId?: string;
  groupStatus?: 'success' | 'failed' | 'cancelled';
  groupResult?: string | null;
  groupError?: string | null;
  options?: {
    ownerId?: string;
    notifyChannels?: string[] | null;
    sourceKind?: string;
    /** Stable id for replay-safe Web workspace projection. */
    messageId?: string;
    skipStore?: boolean;
    workspaceFolder?: string;
    /** The source IM received this exact message through a prior strict ACK. */
    sourceAlreadyDelivered?: boolean;
  };
  sendOptions?: { source?: string };
}

export interface TaskRunImMessageNotificationPayload {
  kind: 'im_message';
  targetJid: string;
  text: string;
  localImagePaths: string[];
}

export interface TaskRunImImageNotificationPayload {
  kind: 'im_image';
  targetJid: string;
  workspaceFolder: string;
  filePath: string;
  mimeType: string;
  caption?: string;
  fileName?: string;
}

export interface TaskRunImFileNotificationPayload {
  kind: 'im_file';
  targetJid: string;
  workspaceFolder: string;
  filePath: string;
  fileName: string;
}

export type TaskRunAtomicNotificationPayload =
  | TaskRunTextNotificationPayload
  | TaskRunImMessageNotificationPayload
  | TaskRunImImageNotificationPayload
  | TaskRunImFileNotificationPayload;

export type TaskRunNotificationPayload =
  | TaskRunAtomicNotificationPayload
  | { kind: 'batch'; items: TaskRunAtomicNotificationPayload[] };

export interface TaskRunNotificationReceipt {
  status: Exclude<TaskRunNotificationStatus, 'pending'>;
  summary: TaskRunNotificationSummary;
  error?: string | null;
}

export interface ClaimedTaskRunNotification {
  runId: string;
  payload: TaskRunNotificationPayload;
  attempt: number;
  owner: string;
  token: number;
  expiresAt: string;
  generation: number;
  notificationStatus: TaskRunNotificationStatus;
  notificationSummary: TaskRunNotificationSummary | null;
  notificationError: string | null;
}

const MAX_TASK_NOTIFICATION_ATTEMPTS = 5;
const FINAL_NOTIFICATION_UNKNOWN_ERROR =
  'Final notification attempt expired; delivery outcome is unknown';
const PENDING_NOTIFICATION_RETRY_ERROR =
  'Notification retry work remains pending delivery';

function mergeTaskRunNotificationPayloads(
  current: TaskRunNotificationPayload | null,
  next: TaskRunNotificationPayload | undefined,
): TaskRunNotificationPayload | null {
  if (!next) return current;
  const currentItems = !current
    ? []
    : current.kind === 'batch'
      ? current.items
      : [current];
  const nextItems = next.kind === 'batch' ? next.items : [next];
  const items = [
    ...new Map(
      [...currentItems, ...nextItems].map((item) => [
        JSON.stringify(item),
        item,
      ]),
    ).values(),
  ];
  return items.length === 1 ? items[0] : { kind: 'batch', items };
}

function notificationPayloadAddsNewWork(
  current: TaskRunNotificationPayload | null,
  next: TaskRunNotificationPayload | undefined,
): boolean {
  if (!next) return false;
  const existing = new Set(
    taskRunNotificationPayloadItems(current).map((item) =>
      JSON.stringify(item),
    ),
  );
  return taskRunNotificationPayloadItems(next).some(
    (item) => !existing.has(JSON.stringify(item)),
  );
}

function taskRunNotificationPayloadItems(
  payload: TaskRunNotificationPayload | null | undefined,
): TaskRunAtomicNotificationPayload[] {
  if (!payload) return [];
  return payload.kind === 'batch' ? payload.items : [payload];
}

function notificationPayloadOwnsCancelledGroupWorkspaceRun(
  payload: TaskRunNotificationPayload | null | undefined,
  runId: string,
): boolean {
  return taskRunNotificationPayloadItems(payload).some(
    (item) =>
      item.kind === 'workspace_result' &&
      item.groupRunId === runId &&
      Boolean(item.groupTaskId) &&
      item.groupStatus === 'cancelled',
  );
}

function cancelledGroupWorkspaceRetryPayload(
  payload: TaskRunNotificationPayload | null | undefined,
  runId: string,
): TaskRunNotificationPayload | null {
  const items = taskRunNotificationPayloadItems(payload).filter(
    (item) =>
      item.kind === 'workspace_result' &&
      item.groupRunId === runId &&
      Boolean(item.groupTaskId) &&
      item.groupStatus === 'cancelled',
  );
  return items.length === 0
    ? null
    : items.length === 1
      ? items[0]
      : { kind: 'batch', items };
}

/**
 * Notification exhaustion must not leave the asynchronous group execution in
 * `delivered` forever. Execution and projection status remain independent:
 * settle the exact business outcome carried by the payload while the
 * notification row keeps its failed/unknown delivery audit.
 */
function settleDiscardedGroupWorkspaceResults(
  runId: string,
  payload: TaskRunNotificationPayload | null | undefined,
): number {
  let settled = 0;
  for (const item of taskRunNotificationPayloadItems(payload)) {
    if (
      item.kind !== 'workspace_result' ||
      item.groupRunId !== runId ||
      !item.groupTaskId
    ) {
      continue;
    }
    if (
      finalizeDeliveredGroupTaskRunInTransaction(runId, item.groupTaskId, {
        status: item.groupStatus,
        result: item.groupResult,
        error: item.groupError,
      })
    ) {
      settled++;
    }
  }
  return settled;
}

/** Remove exactly the atomic work owned by one claim from the latest queue. */
function subtractTaskRunNotificationPayload(
  current: TaskRunNotificationPayload | null,
  claimed: TaskRunNotificationPayload,
): TaskRunNotificationPayload | null {
  const claimedCounts = new Map<string, number>();
  for (const item of taskRunNotificationPayloadItems(claimed)) {
    const key = JSON.stringify(item);
    claimedCounts.set(key, (claimedCounts.get(key) ?? 0) + 1);
  }
  const remaining = taskRunNotificationPayloadItems(current).filter((item) => {
    const key = JSON.stringify(item);
    const count = claimedCounts.get(key) ?? 0;
    if (count <= 0) return true;
    claimedCounts.set(key, count - 1);
    return false;
  });
  return remaining.length === 0
    ? null
    : remaining.length === 1
      ? remaining[0]
      : { kind: 'batch', items: remaining };
}

function notificationPayloadChannels(
  payload: TaskRunNotificationPayload | null,
): string[] {
  return [
    ...new Set(
      taskRunNotificationPayloadItems(payload).map((item) =>
        'targetJid' in item
          ? item.targetJid.split(':', 1)[0] || item.targetJid
          : (item.options?.notifyChannels?.[0] ?? item.chatJid),
      ),
    ),
  ];
}

function subtractNotificationSummary(
  current: TaskRunNotificationSummary | null,
  baseline: TaskRunNotificationSummary | null,
  remainingPayload: TaskRunNotificationPayload | null,
): TaskRunNotificationSummary {
  const attempted = Math.max(
    0,
    (current?.attempted ?? 0) - (baseline?.attempted ?? 0),
  );
  const succeeded = Math.max(
    0,
    (current?.succeeded ?? 0) - (baseline?.succeeded ?? 0),
  );
  const failed = Math.max(0, (current?.failed ?? 0) - (baseline?.failed ?? 0));
  let failedChannels: string[] = [];
  if (failed > 0) {
    const baselineChannels = new Set(baseline?.failed_channels ?? []);
    failedChannels = (current?.failed_channels ?? []).filter(
      (channel) => !baselineChannels.has(channel),
    );
    if (failedChannels.length === 0) {
      failedChannels = notificationPayloadChannels(remainingPayload);
    }
    if (failedChannels.length === 0) {
      failedChannels = [...(current?.failed_channels ?? [])];
    }
  }
  return { attempted, succeeded, failed, failed_channels: failedChannels };
}

function subtractNotificationError(
  current: string | null,
  baseline: string | null,
): string | null {
  if (!current || current === baseline) return null;
  if (baseline && current.startsWith(`${baseline}; `)) {
    return current.slice(baseline.length + 2) || null;
  }
  return current;
}

function removeNotificationError(
  current: string | null,
  removed: string | null | undefined,
): string | null {
  if (!current || !removed) return current;
  if (current === removed) return null;
  if (current.startsWith(`${removed}; `)) {
    return current.slice(removed.length + 2) || null;
  }
  if (current.endsWith(`; ${removed}`)) {
    return current.slice(0, -(removed.length + 2)) || null;
  }
  const marker = `; ${removed}; `;
  const index = current.indexOf(marker);
  if (index >= 0) {
    return `${current.slice(0, index)}; ${current.slice(index + marker.length)}`;
  }
  return current;
}

function notificationStatusForSummary(
  summary: TaskRunNotificationSummary,
): TaskRunNotificationReceipt['status'] {
  return summary.failed === 0
    ? summary.attempted === 0
      ? 'skipped'
      : 'success'
    : summary.succeeded > 0
      ? 'partial_failed'
      : 'failed';
}

function mergeTaskRunNotificationReceipts(
  currentStatus: TaskRunNotificationStatus,
  currentSummary: TaskRunNotificationSummary | null,
  currentError: string | null,
  next: TaskRunNotificationReceipt,
): TaskRunNotificationReceipt {
  if (!currentSummary || currentStatus === 'pending') return next;
  const summary: TaskRunNotificationSummary = {
    attempted: currentSummary.attempted + next.summary.attempted,
    succeeded: currentSummary.succeeded + next.summary.succeeded,
    failed: currentSummary.failed + next.summary.failed,
    failed_channels: [
      ...new Set([
        ...currentSummary.failed_channels,
        ...next.summary.failed_channels,
      ]),
    ],
  };
  return {
    status:
      summary.failed === 0
        ? summary.attempted === 0
          ? 'skipped'
          : 'success'
        : summary.succeeded > 0
          ? 'partial_failed'
          : 'failed',
    summary,
    error: [currentError, next.error].filter(Boolean).join('; ') || null,
  };
}

function keepRetryWorkNonSuccessful(
  receipt: TaskRunNotificationReceipt,
  payload: TaskRunNotificationPayload | null,
): TaskRunNotificationReceipt {
  if (
    !payload ||
    (receipt.status !== 'success' && receipt.status !== 'skipped')
  ) {
    return receipt;
  }
  return {
    ...receipt,
    status: 'failed',
    error: receipt.error || PENDING_NOTIFICATION_RETRY_ERROR,
  };
}

/** Persist an immediate delivery receipt; failures become notification-only retry work. */
export function recordTaskRunNotificationReceipt(
  runId: string,
  receipt: TaskRunNotificationReceipt,
  retryPayload?: TaskRunNotificationPayload,
): boolean {
  return db.transaction(() =>
    recordTaskRunNotificationReceiptInTransaction(runId, receipt, retryPayload),
  )();
}

function recordTaskRunNotificationReceiptInTransaction(
  runId: string,
  receipt: TaskRunNotificationReceipt,
  retryPayload?: TaskRunNotificationPayload,
  allowCancelledWorkspaceRun = false,
): boolean {
  const now = new Date();
  const row = db
    .prepare(
      `SELECT status, notification_status, notification_error,
                notification_summary, notification_payload,
                notification_available_at,
                notification_lease_owner,
                notification_generation
         FROM task_runs WHERE id = ?`,
    )
    .get(runId) as
    | Pick<
        TaskRunRow,
        | 'status'
        | 'notification_status'
        | 'notification_error'
        | 'notification_summary'
        | 'notification_payload'
        | 'notification_available_at'
        | 'notification_lease_owner'
        | 'notification_generation'
      >
    | undefined;
  // Cancellation/misfire is authoritative. Late IPC files must not notify
  // the user or resurrect notification-only retry work.
  if (
    !row ||
    (row.status === 'cancelled' && !allowCancelledWorkspaceRun) ||
    row.status === 'missed'
  ) {
    return false;
  }
  let currentSummary: TaskRunNotificationSummary | null = null;
  let currentPayload: TaskRunNotificationPayload | null = null;
  try {
    currentSummary = row.notification_summary
      ? (JSON.parse(row.notification_summary) as TaskRunNotificationSummary)
      : null;
    currentPayload = row.notification_payload
      ? (JSON.parse(row.notification_payload) as TaskRunNotificationPayload)
      : null;
  } catch {
    // A new valid receipt repairs malformed legacy/internal JSON.
  }
  let mergedReceipt = mergeTaskRunNotificationReceipts(
    row.notification_status,
    currentSummary,
    row.notification_error,
    receipt,
  );
  const shouldRetry =
    (receipt.status === 'failed' || receipt.status === 'partial_failed') &&
    !!retryPayload;
  const mergedPayload = mergeTaskRunNotificationPayloads(
    currentPayload,
    shouldRetry ? retryPayload : undefined,
  );
  mergedReceipt = keepRetryWorkNonSuccessful(mergedReceipt, mergedPayload);
  const addedNewRetryWork = notificationPayloadAddsNewWork(
    currentPayload,
    shouldRetry ? retryPayload : undefined,
  );
  const retryAt = new Date(now.getTime() + 1_000).toISOString();
  const availableAt = mergedPayload
    ? [
        currentPayload && !row.notification_lease_owner
          ? row.notification_available_at
          : null,
        shouldRetry ? retryAt : null,
      ]
        .filter((value): value is string => !!value)
        .sort()[0] || retryAt
    : null;
  const result = db
    .prepare(
      `UPDATE task_runs
         SET notification_status = ?, notification_error = ?,
             notification_summary = ?, notification_payload = ?,
             notification_attempt = CASE WHEN ? AND notification_lease_owner IS NULL THEN 0
                                         ELSE notification_attempt END,
             notification_available_at = ?,
             notification_generation = notification_generation + 1,
             updated_at = ?
         WHERE id = ?
           AND (
             status NOT IN ('cancelled','missed')
             OR (? = 1 AND status = 'cancelled')
           )`,
    )
    .run(
      mergedReceipt.status,
      mergedReceipt.error ?? null,
      JSON.stringify(mergedReceipt.summary),
      mergedPayload ? JSON.stringify(mergedPayload) : null,
      addedNewRetryWork ? 1 : 0,
      availableAt,
      now.toISOString(),
      runId,
      allowCancelledWorkspaceRun ? 1 : 0,
    );
  return result.changes === 1;
}

/**
 * Atomically persist canonical Web projection repair work and settle the exact
 * group execution outcome. Neither the notification repair nor the business
 * terminal is allowed to become visible alone across a crash.
 */
export function recordGroupWorkspaceProjectionFailureAndFinalize(input: {
  runId: string;
  taskId: string;
  receipt: TaskRunNotificationReceipt;
  payload: TaskRunTextNotificationPayload;
  status?: 'success' | 'failed' | 'cancelled';
  result?: string | null;
  error?: string | null;
}): boolean {
  if (
    input.payload.kind !== 'workspace_result' ||
    input.payload.groupRunId !== input.runId ||
    input.payload.groupTaskId !== input.taskId
  ) {
    return false;
  }
  try {
    return db.transaction(() => {
      if (
        !recordTaskRunNotificationReceiptInTransaction(
          input.runId,
          input.receipt,
          input.payload,
          input.status === 'cancelled',
        )
      ) {
        return false;
      }
      if (
        !finalizeDeliveredGroupTaskRunInTransaction(input.runId, input.taskId, {
          status: input.status,
          result: input.result,
          error: input.error,
        })
      ) {
        throw new Error(
          `Group task run ${input.runId} could not atomically settle its workspace projection failure`,
        );
      }
      return true;
    })();
  } catch {
    return false;
  }
}

/**
 * Atomically supersede one provisional failure with its fallback outcome.
 * The exact retry item is consumed, while unrelated IPC/channel failures stay
 * durable. This is used when a strict source send fails but the normal owner
 * notification fallback subsequently succeeds (or yields better retry work).
 */
export function replaceTaskRunNotificationReceipt(
  runId: string,
  previousReceipt: TaskRunNotificationReceipt,
  previousPayload: TaskRunNotificationPayload,
  nextReceipt: TaskRunNotificationReceipt,
  nextRetryPayload?: TaskRunNotificationPayload,
): boolean {
  const now = new Date();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT status, notification_status, notification_error,
                notification_summary, notification_payload,
                notification_attempt, notification_available_at,
                notification_generation
         FROM task_runs WHERE id = ?`,
      )
      .get(runId) as
      | Pick<
          TaskRunRow,
          | 'status'
          | 'notification_status'
          | 'notification_error'
          | 'notification_summary'
          | 'notification_payload'
          | 'notification_attempt'
          | 'notification_available_at'
          | 'notification_generation'
        >
      | undefined;
    if (
      !row ||
      row.status === 'cancelled' ||
      row.status === 'missed' ||
      !row.notification_payload ||
      !row.notification_summary
    ) {
      return false;
    }

    let currentPayload: TaskRunNotificationPayload;
    let currentSummary: TaskRunNotificationSummary;
    try {
      currentPayload = JSON.parse(
        row.notification_payload,
      ) as TaskRunNotificationPayload;
      currentSummary = JSON.parse(
        row.notification_summary,
      ) as TaskRunNotificationSummary;
    } catch {
      return false;
    }
    const previousItems = taskRunNotificationPayloadItems(previousPayload);
    const remainingPayload = subtractTaskRunNotificationPayload(
      currentPayload,
      previousPayload,
    );
    if (
      taskRunNotificationPayloadItems(currentPayload).length -
        taskRunNotificationPayloadItems(remainingPayload).length !==
      previousItems.length
    ) {
      return false;
    }

    const baseSummary: TaskRunNotificationSummary = {
      attempted: Math.max(
        0,
        currentSummary.attempted - previousReceipt.summary.attempted,
      ),
      succeeded: Math.max(
        0,
        currentSummary.succeeded - previousReceipt.summary.succeeded,
      ),
      failed: Math.max(
        0,
        currentSummary.failed - previousReceipt.summary.failed,
      ),
      failed_channels: [],
    };
    if (baseSummary.failed > 0) {
      const removedChannels = new Set(previousReceipt.summary.failed_channels);
      const remainingChannels = notificationPayloadChannels(remainingPayload);
      baseSummary.failed_channels = [
        ...new Set([
          ...currentSummary.failed_channels.filter(
            (channel) => !removedChannels.has(channel),
          ),
          ...remainingChannels,
        ]),
      ];
      if (baseSummary.failed_channels.length === 0) {
        baseSummary.failed_channels = [...currentSummary.failed_channels];
      }
    }
    const baseError = removeNotificationError(
      row.notification_error,
      previousReceipt.error,
    );
    const baseReceipt: TaskRunNotificationReceipt = {
      status: notificationStatusForSummary(baseSummary),
      summary: baseSummary,
      error: baseError,
    };
    let mergedReceipt =
      baseSummary.attempted === 0
        ? nextReceipt
        : mergeTaskRunNotificationReceipts(
            baseReceipt.status,
            baseReceipt.summary,
            baseReceipt.error ?? null,
            nextReceipt,
          );
    const shouldRetryNext =
      (nextReceipt.status === 'failed' ||
        nextReceipt.status === 'partial_failed') &&
      !!nextRetryPayload;
    const mergedPayload = mergeTaskRunNotificationPayloads(
      remainingPayload,
      shouldRetryNext ? nextRetryPayload : undefined,
    );
    mergedReceipt = keepRetryWorkNonSuccessful(mergedReceipt, mergedPayload);
    const addedNewRetryWork = notificationPayloadAddsNewWork(
      remainingPayload,
      shouldRetryNext ? nextRetryPayload : undefined,
    );
    const retryAt = new Date(now.getTime() + 1_000).toISOString();
    const availableCandidates = [
      remainingPayload ? row.notification_available_at : null,
      shouldRetryNext ? retryAt : null,
    ].filter((value): value is string => !!value);
    const result = db
      .prepare(
        `UPDATE task_runs
         SET notification_status = ?, notification_error = ?,
             notification_summary = ?, notification_payload = ?,
             notification_attempt = CASE WHEN ? THEN 0
                                         ELSE notification_attempt END,
             notification_available_at = ?,
             notification_generation = notification_generation + 1,
             updated_at = ?
         WHERE id = ? AND notification_generation = ?
           AND status NOT IN ('cancelled','missed')`,
      )
      .run(
        mergedReceipt.status,
        mergedReceipt.error ?? null,
        JSON.stringify(mergedReceipt.summary),
        mergedPayload ? JSON.stringify(mergedPayload) : null,
        addedNewRetryWork ? 1 : 0,
        mergedPayload ? (availableCandidates.sort()[0] ?? retryAt) : null,
        now.toISOString(),
        runId,
        row.notification_generation,
      );
    return result.changes === 1;
  })();
}

/** Mark a completed isolated run with no outbound IPC as intentionally skipped. */
export function finalizeTaskRunNotificationIfPending(runId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE task_runs
       SET notification_status = 'skipped', notification_error = NULL,
           notification_summary = ?,
           notification_generation = notification_generation + 1,
           updated_at = ?
       WHERE id = ? AND notification_status = 'pending'
         AND notification_payload IS NULL
         AND status NOT IN ('cancelled','missed')`,
    )
    .run(
      JSON.stringify({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failed_channels: [],
      } satisfies TaskRunNotificationSummary),
      now,
      runId,
    );
  return result.changes === 1;
}

export function claimNextTaskRunNotification(
  owner: string,
  leaseMs: number,
): ClaimedTaskRunNotification | undefined {
  return claimTaskRunNotification(owner, leaseMs);
}

/** Claim notification work for one known run (used by targeted recovery/tests). */
export function claimTaskRunNotificationById(
  runId: string,
  owner: string,
  leaseMs: number,
): ClaimedTaskRunNotification | undefined {
  return claimTaskRunNotification(owner, leaseMs, runId);
}

function claimTaskRunNotification(
  owner: string,
  leaseMs: number,
  runId?: string,
): ClaimedTaskRunNotification | undefined {
  finalizeExpiredTaskRunNotificationAttempts();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, status, notification_payload, notification_attempt,
                notification_lease_token, notification_generation,
                notification_status, notification_summary,
                notification_error
         FROM task_runs
         WHERE notification_payload IS NOT NULL
           AND (? IS NULL OR id = ?)
           AND (
             status IN ('success','failed','delivered')
             OR (
               status = 'cancelled'
               AND CASE
                 WHEN json_valid(notification_payload) THEN (
                   (
                     json_extract(notification_payload, '$.kind') = 'workspace_result'
                     AND json_extract(notification_payload, '$.groupRunId') = id
                     AND json_extract(notification_payload, '$.groupTaskId') IS NOT NULL
                     AND json_extract(notification_payload, '$.groupStatus') = 'cancelled'
                   )
                   OR (
                     json_extract(notification_payload, '$.kind') = 'batch'
                     AND EXISTS (
                       SELECT 1
                       FROM json_each(notification_payload, '$.items') AS item
                       WHERE json_extract(item.value, '$.kind') = 'workspace_result'
                         AND json_extract(item.value, '$.groupRunId') = id
                         AND json_extract(item.value, '$.groupTaskId') IS NOT NULL
                         AND json_extract(item.value, '$.groupStatus') = 'cancelled'
                     )
                   )
                 )
                 ELSE 0
               END
             )
           )
           AND notification_attempt < ?
           AND (
             (notification_status IN ('failed','partial_failed','pending')
               AND notification_available_at IS NOT NULL
               AND notification_available_at <= ?
               AND notification_lease_owner IS NULL)
             OR (notification_lease_expires_at IS NOT NULL
                 AND notification_lease_expires_at <= ?)
           )
         ORDER BY CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END,
                  notification_available_at, completed_at, created_at
         LIMIT 32`,
      )
      .all(
        runId ?? null,
        runId ?? null,
        MAX_TASK_NOTIFICATION_ATTEMPTS,
        nowIso,
        nowIso,
      ) as Array<{
      id: string;
      status: TaskRunStatus;
      notification_payload: string;
      notification_attempt: number;
      notification_lease_token: number;
      notification_generation: number;
      notification_status: TaskRunNotificationStatus;
      notification_summary: string | null;
      notification_error: string | null;
    }>;
    for (const row of rows) {
      let payload: TaskRunNotificationPayload;
      try {
        payload = JSON.parse(
          row.notification_payload,
        ) as TaskRunNotificationPayload;
      } catch {
        db.prepare(
          `UPDATE task_runs SET notification_status='failed',
             notification_error='Invalid persisted notification payload',
             notification_payload=NULL, notification_available_at=NULL,
             notification_lease_owner=NULL,
             notification_lease_expires_at=NULL,
             notification_lease_payload=NULL, updated_at=?
           WHERE id=? AND notification_lease_token=?`,
        ).run(nowIso, row.id, row.notification_lease_token);
        continue;
      }
      if (
        row.status === 'cancelled' &&
        !notificationPayloadOwnsCancelledGroupWorkspaceRun(payload, row.id)
      ) {
        continue;
      }

      const token = row.notification_lease_token + 1;
      const changed = db
        .prepare(
          `UPDATE task_runs
         SET notification_lease_owner = ?, notification_lease_token = ?,
             notification_lease_expires_at = ?,
             notification_lease_payload = notification_payload,
             notification_attempt = notification_attempt + 1,
             updated_at = ?
         WHERE id = ? AND notification_lease_token = ?`,
        )
        .run(
          owner,
          token,
          expiresAt,
          nowIso,
          row.id,
          row.notification_lease_token,
        );
      if (changed.changes !== 1) continue;
      try {
        return {
          runId: row.id,
          payload,
          attempt: row.notification_attempt + 1,
          owner,
          token,
          expiresAt,
          generation: row.notification_generation,
          notificationStatus: row.notification_status,
          notificationSummary: row.notification_summary
            ? (JSON.parse(
                row.notification_summary,
              ) as TaskRunNotificationSummary)
            : null,
          notificationError: row.notification_error,
        };
      } catch {
        db.prepare(
          `UPDATE task_runs SET notification_status='failed',
             notification_error='Invalid persisted notification payload',
             notification_payload=NULL, notification_available_at=NULL,
             notification_lease_owner=NULL,
             notification_lease_expires_at=NULL,
             notification_lease_payload=NULL, updated_at=?
           WHERE id=? AND notification_lease_owner=?
             AND notification_lease_token=?`,
        ).run(nowIso, row.id, owner, token);
      }
    }
    return undefined;
  })();
}

/** A crashed final notification attempt has an unknowable delivery outcome.
 * Fence it terminally instead of replaying (duplicate risk) or busy-looping. */
export function finalizeExpiredTaskRunNotificationAttempts(): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, status, notification_error, notification_summary,
                notification_payload, notification_attempt,
                notification_available_at, notification_lease_owner,
                notification_lease_token, notification_lease_expires_at,
                notification_lease_payload, notification_generation
         FROM task_runs
         WHERE notification_payload IS NOT NULL
           AND notification_attempt >= ?
           AND notification_lease_owner IS NOT NULL
           AND notification_lease_expires_at IS NOT NULL
           AND notification_lease_expires_at <= ?`,
      )
      .all(MAX_TASK_NOTIFICATION_ATTEMPTS, now) as Array<
      Pick<
        TaskRunRow,
        | 'id'
        | 'status'
        | 'notification_error'
        | 'notification_summary'
        | 'notification_payload'
        | 'notification_attempt'
        | 'notification_available_at'
        | 'notification_lease_owner'
        | 'notification_lease_token'
        | 'notification_lease_expires_at'
        | 'notification_lease_payload'
        | 'notification_generation'
      >
    >;
    let changed = 0;
    for (const row of rows) {
      let currentPayload: TaskRunNotificationPayload;
      let claimedPayload: TaskRunNotificationPayload;
      let currentSummary: TaskRunNotificationSummary | null = null;
      try {
        currentPayload = JSON.parse(
          row.notification_payload!,
        ) as TaskRunNotificationPayload;
      } catch {
        // Invalid work cannot be retried safely. Treat the whole opaque value as
        // the expired claim so this row becomes terminal below.
        currentPayload = { kind: 'batch', items: [] };
      }
      try {
        // A v53 process may have crashed with a lease immediately before the
        // v54 upgrade. With no snapshot, fail closed by treating all current
        // work as the unknown final claim instead of replaying it.
        claimedPayload = JSON.parse(
          row.notification_lease_payload!,
        ) as TaskRunNotificationPayload;
      } catch {
        claimedPayload = currentPayload;
      }
      try {
        currentSummary = row.notification_summary
          ? (JSON.parse(row.notification_summary) as TaskRunNotificationSummary)
          : null;
      } catch {
        currentSummary = null;
      }
      let remainingPayload = subtractTaskRunNotificationPayload(
        currentPayload,
        claimedPayload,
      );
      const ownsCancelledGroupWorkspaceRun =
        row.status === 'cancelled' &&
        notificationPayloadOwnsCancelledGroupWorkspaceRun(
          claimedPayload,
          row.id,
        );
      if (ownsCancelledGroupWorkspaceRun) {
        // Cancellation is authoritative. Late notification-only work appended
        // before the cancellation became visible must not keep a cancelled
        // run reclaimable forever.
        remainingPayload = null;
      }
      const summary: TaskRunNotificationSummary = {
        attempted: (currentSummary?.attempted ?? 0) + 1,
        succeeded: currentSummary?.succeeded ?? 0,
        failed: (currentSummary?.failed ?? 0) + 1,
        failed_channels: [
          ...new Set([
            ...(currentSummary?.failed_channels ?? []),
            ...notificationPayloadChannels(claimedPayload),
          ]),
        ],
      };
      const error = [row.notification_error, FINAL_NOTIFICATION_UNKNOWN_ERROR]
        .filter(Boolean)
        .join('; ');
      const result = db
        .prepare(
          `UPDATE task_runs
           SET notification_status = ?, notification_error = ?,
               notification_summary = ?, notification_payload = ?,
               notification_attempt = ?, notification_available_at = ?,
               notification_lease_owner = NULL,
               notification_lease_expires_at = NULL,
               notification_lease_payload = NULL,
               notification_generation = notification_generation + 1,
               updated_at = ?
           WHERE id = ? AND notification_lease_owner = ?
             AND notification_lease_token = ?
             AND notification_lease_expires_at <= ?
             AND notification_generation = ?
             AND (
               status NOT IN ('cancelled','missed')
               OR (? = 1 AND status = 'cancelled')
             )`,
        )
        .run(
          notificationStatusForSummary(summary),
          error,
          JSON.stringify(summary),
          remainingPayload ? JSON.stringify(remainingPayload) : null,
          remainingPayload ? 0 : row.notification_attempt,
          remainingPayload
            ? (row.notification_available_at ??
                new Date(Date.now() + 1_000).toISOString())
            : null,
          now,
          row.id,
          row.notification_lease_owner,
          row.notification_lease_token,
          now,
          row.notification_generation,
          ownsCancelledGroupWorkspaceRun ? 1 : 0,
        );
      if (result.changes === 1) {
        settleDiscardedGroupWorkspaceResults(row.id, claimedPayload);
      }
      changed += result.changes;
    }
    return changed;
  })();
}

/** Extend one notification delivery lease without changing its fencing token. */
export function renewTaskRunNotificationLease(
  claim: ClaimedTaskRunNotification,
  leaseMs: number,
): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = db
    .prepare(
      `UPDATE task_runs SET notification_lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND notification_payload IS NOT NULL
         AND notification_lease_owner = ? AND notification_lease_token = ?
         AND notification_lease_expires_at > ?`,
    )
    .run(expiresAt, nowIso, claim.runId, claim.owner, claim.token, nowIso);
  if (result.changes === 1) claim.expiresAt = expiresAt;
  return result.changes === 1;
}

export function completeTaskRunNotificationAttempt(
  claim: ClaimedTaskRunNotification,
  receipt: TaskRunNotificationReceipt,
  retryPayload?: TaskRunNotificationPayload,
): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const workerRetryable =
    (receipt.status === 'failed' || receipt.status === 'partial_failed') &&
    claim.attempt < MAX_TASK_NOTIFICATION_ATTEMPTS &&
    !!retryPayload;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, claim.attempt - 1));
  const workerAvailableAt = workerRetryable
    ? new Date(now.getTime() + delayMs).toISOString()
    : null;
  const ownsCancelledGroupWorkspaceRun =
    notificationPayloadOwnsCancelledGroupWorkspaceRun(
      claim.payload,
      claim.runId,
    );
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT status, notification_status, notification_error,
                notification_summary, notification_payload,
                notification_attempt, notification_available_at,
                notification_lease_owner, notification_lease_token,
                notification_lease_expires_at, notification_generation
         FROM task_runs WHERE id = ?`,
      )
      .get(claim.runId) as
      | Pick<
          TaskRunRow,
          | 'status'
          | 'notification_status'
          | 'notification_error'
          | 'notification_summary'
          | 'notification_payload'
          | 'notification_attempt'
          | 'notification_available_at'
          | 'notification_lease_owner'
          | 'notification_lease_token'
          | 'notification_lease_expires_at'
          | 'notification_generation'
        >
      | undefined;
    if (
      !row ||
      (row.status === 'cancelled' && !ownsCancelledGroupWorkspaceRun) ||
      row.status === 'missed' ||
      row.notification_lease_owner !== claim.owner ||
      row.notification_lease_token !== claim.token ||
      !row.notification_lease_expires_at ||
      row.notification_lease_expires_at <= nowIso
    ) {
      return false;
    }

    let currentPayload: TaskRunNotificationPayload | null = null;
    let currentSummary: TaskRunNotificationSummary | null = null;
    try {
      currentPayload = row.notification_payload
        ? (JSON.parse(row.notification_payload) as TaskRunNotificationPayload)
        : null;
      currentSummary = row.notification_summary
        ? (JSON.parse(row.notification_summary) as TaskRunNotificationSummary)
        : null;
    } catch {
      return false;
    }

    const concurrentWrite = row.notification_generation !== claim.generation;
    const latePayload = concurrentWrite
      ? subtractTaskRunNotificationPayload(currentPayload, claim.payload)
      : null;
    const cancelledAuthoritative =
      row.status === 'cancelled' && ownsCancelledGroupWorkspaceRun;
    const nextPayload = cancelledAuthoritative
      ? workerRetryable
        ? cancelledGroupWorkspaceRetryPayload(retryPayload, claim.runId)
        : null
      : mergeTaskRunNotificationPayloads(
          latePayload,
          workerRetryable ? retryPayload : undefined,
        );

    // A final-attempt crash is terminal historical evidence: later work may
    // succeed, but it cannot retroactively prove that unknown delivery A did
    // not happen. Preserve that audit receipt while settling fresh batch B.
    const claimedSummaryIsHistoricalSuccess =
      !!claim.notificationSummary &&
      claim.notificationSummary.failed === 0 &&
      (claim.notificationStatus === 'pending' ||
        claim.notificationError === PENDING_NOTIFICATION_RETRY_ERROR);
    let nextReceipt =
      currentSummary &&
      row.notification_error?.includes(FINAL_NOTIFICATION_UNKNOWN_ERROR)
        ? mergeTaskRunNotificationReceipts(
            row.notification_status,
            currentSummary,
            row.notification_error,
            receipt,
          )
        : claimedSummaryIsHistoricalSuccess && claim.notificationSummary
          ? mergeTaskRunNotificationReceipts(
              notificationStatusForSummary(claim.notificationSummary),
              claim.notificationSummary,
              null,
              receipt,
            )
          : receipt;
    if (concurrentWrite) {
      const lateSummary = subtractNotificationSummary(
        currentSummary,
        claim.notificationSummary,
        latePayload,
      );
      if (
        lateSummary.attempted > 0 ||
        lateSummary.succeeded > 0 ||
        lateSummary.failed > 0
      ) {
        nextReceipt = mergeTaskRunNotificationReceipts(
          nextReceipt.status,
          nextReceipt.summary,
          nextReceipt.error ?? null,
          {
            status:
              lateSummary.failed === 0
                ? lateSummary.attempted === 0
                  ? 'skipped'
                  : 'success'
                : lateSummary.succeeded > 0
                  ? 'partial_failed'
                  : 'failed',
            summary: lateSummary,
            error: subtractNotificationError(
              row.notification_error,
              claim.notificationError,
            ),
          },
        );
      }
    }
    nextReceipt = keepRetryWorkNonSuccessful(nextReceipt, nextPayload);

    const availableCandidates = [
      latePayload ? row.notification_available_at : null,
      workerRetryable ? workerAvailableAt : null,
    ].filter((value): value is string => !!value);
    const nextAvailableAt = nextPayload
      ? (availableCandidates.sort()[0] ??
        new Date(now.getTime() + 1_000).toISOString())
      : null;
    // The late payload was appended after this claim began and has not itself
    // consumed an attempt. Reset the shared batch counter so its next claim is
    // attempt 1 (and the merged batch receives a complete retry budget).
    const nextAttempt =
      latePayload && !cancelledAuthoritative ? 0 : row.notification_attempt;
    const result = db
      .prepare(
        `UPDATE task_runs
         SET notification_status = ?, notification_error = ?,
             notification_summary = ?, notification_payload = ?,
             notification_attempt = ?, notification_available_at = ?,
             notification_lease_owner = NULL,
             notification_lease_expires_at = NULL,
             notification_lease_payload = NULL,
             notification_generation = notification_generation + 1,
             updated_at = ?
         WHERE id = ? AND notification_lease_owner = ?
           AND notification_lease_token = ?
           AND notification_lease_expires_at > ?
           AND notification_generation = ?
           AND (
             status NOT IN ('cancelled','missed')
             OR (? = 1 AND status = 'cancelled')
           )`,
      )
      .run(
        nextReceipt.status,
        nextReceipt.error ?? null,
        JSON.stringify(nextReceipt.summary),
        nextPayload ? JSON.stringify(nextPayload) : null,
        nextAttempt,
        nextAvailableAt,
        nowIso,
        claim.runId,
        claim.owner,
        claim.token,
        nowIso,
        row.notification_generation,
        ownsCancelledGroupWorkspaceRun ? 1 : 0,
      );
    const discardedPayload =
      !workerRetryable &&
      (receipt.status === 'failed' || receipt.status === 'partial_failed')
        ? (retryPayload ?? claim.payload)
        : null;
    if (result.changes === 1 && discardedPayload) {
      settleDiscardedGroupWorkspaceResults(claim.runId, discardedPayload);
    }
    return result.changes === 1;
  })();
}

/** Earliest retry/queued admission or expired running lease. */
export function getNextTaskRunWakeAt(): string | null {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT MIN(wake_at) AS wake_at FROM (
         SELECT available_at AS wake_at FROM task_runs
           WHERE status IN ('queued','retry_wait')
         UNION ALL
         SELECT lease_expires_at AS wake_at FROM task_runs
           WHERE status = 'running' AND lease_expires_at IS NOT NULL
         UNION ALL
         SELECT notification_available_at AS wake_at FROM task_runs
           WHERE notification_payload IS NOT NULL
             AND notification_attempt < 5
             AND notification_available_at IS NOT NULL
             AND notification_lease_owner IS NULL
             AND status IN ('success','failed','delivered')
             AND notification_status IN ('failed','partial_failed','pending')
         UNION ALL
         SELECT notification_lease_expires_at AS wake_at FROM task_runs
           WHERE notification_lease_owner IS NOT NULL
             AND notification_lease_expires_at IS NOT NULL
             AND (notification_attempt < 5 OR notification_lease_expires_at > ?)
       )`,
    )
    .get(now) as { wake_at: string | null };
  const cancelledWorkspaceRows = db
    .prepare(
      `SELECT id, notification_payload, notification_available_at
       FROM task_runs
       WHERE status = 'cancelled'
         AND notification_payload IS NOT NULL
         AND notification_attempt < ?
         AND notification_available_at IS NOT NULL
         AND notification_lease_owner IS NULL
         AND notification_status IN ('failed','partial_failed','pending')`,
    )
    .all(MAX_TASK_NOTIFICATION_ATTEMPTS) as Array<{
    id: string;
    notification_payload: string;
    notification_available_at: string;
  }>;
  let cancelledWakeAt: string | null = null;
  for (const candidate of cancelledWorkspaceRows) {
    try {
      const payload = JSON.parse(
        candidate.notification_payload,
      ) as TaskRunNotificationPayload;
      if (
        !notificationPayloadOwnsCancelledGroupWorkspaceRun(
          payload,
          candidate.id,
        )
      ) {
        continue;
      }
      if (
        !cancelledWakeAt ||
        candidate.notification_available_at < cancelledWakeAt
      ) {
        cancelledWakeAt = candidate.notification_available_at;
      }
    } catch {
      // Invalid cancelled payloads are not scheduler-owned repair work.
    }
  }
  return (
    [row.wake_at, cancelledWakeAt]
      .filter((value): value is string => !!value)
      .sort()[0] ?? null
  );
}

export function getNextScheduledTaskWakeAt(): string | null {
  const row = db
    .prepare(
      `SELECT MIN(next_run) AS wake_at FROM scheduled_tasks
       WHERE status = 'active' AND deleted_at IS NULL AND next_run IS NOT NULL`,
    )
    .get() as { wake_at: string | null };
  return row.wake_at ?? null;
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
  updates: {
    duration_ms: number;
    status: 'success' | 'error';
    result: string | null;
    error: string | null;
  },
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
  const durable = db
    .prepare(
      `DELETE FROM task_runs
       WHERE completed_at IS NOT NULL AND completed_at < ?
         AND status IN ('success','failed','cancelled','missed')`,
    )
    .run(cutoff);
  return result.changes + durable.changes;
}

export function cleanupOldDailyUsage(retentionDays = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
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

/**
 * Persist several router_state keys in one transaction. The cursor save path
 * runs on every processed message batch; four independent auto-committed
 * writes meant four WAL syncs where one suffices.
 */
export function setRouterStateBatch(
  entries: ReadonlyArray<readonly [key: string, value: string]>,
): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  );
  db.transaction(() => {
    for (const [key, value] of entries) stmt.run(key, value);
  })();
}

/** All chat JIDs currently present, for cursor-map pruning. */
export function getAllChatJids(): string[] {
  return (
    db.prepare('SELECT jid FROM chats').all() as Array<{ jid: string }>
  ).map((row) => row.jid);
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

function sessionChannelOwnerKey(
  groupFolder: string,
  agentId?: string | null,
): string {
  return `channel_session_owner:${groupFolder}:${agentId || 'main'}`;
}

/** The first native transport that owns a logical warm Session. */
export function getSessionChannelOwner(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  return getRouterState(sessionChannelOwnerKey(groupFolder, agentId));
}

/** Persist-once: later Web or sibling IM inputs cannot steal ownership. */
export function setSessionChannelOwnerOnce(
  groupFolder: string,
  agentId: string | null | undefined,
  sourceJid: string,
): string {
  const key = sessionChannelOwnerKey(groupFolder, agentId);
  db.prepare(
    'INSERT OR IGNORE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, sourceJid);
  return getRouterState(key) ?? sourceJid;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
  agentIdentity?: {
    agentProfileId?: string | null;
    agentProfileVersion?: number | null;
    identityHash?: string | null;
  },
): void {
  const effectiveAgentId = agentId || '';
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (group_folder, session_id, agent_id) VALUES (?, ?, ?)
       ON CONFLICT(group_folder, agent_id) DO UPDATE SET session_id = excluded.session_id`,
    ).run(groupFolder, sessionId, effectiveAgentId);
    if (agentIdentity) {
      db.prepare(
        `UPDATE sessions
         SET agent_profile_id = ?, agent_profile_version = ?, identity_hash = ?
         WHERE group_folder = ? AND agent_id = ?`,
      ).run(
        agentIdentity.agentProfileId ?? null,
        agentIdentity.agentProfileVersion ?? null,
        agentIdentity.identityHash ?? null,
        groupFolder,
        effectiveAgentId,
      );
    }
    syncWorkspaceRuntimeSessionProjection(groupFolder, effectiveAgentId);
  })();
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.transaction(() => {
    db.prepare(
      'DELETE FROM sessions WHERE group_folder = ? AND agent_id = ?',
    ).run(groupFolder, effectiveAgentId);
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ? AND runtime_agent_id = ?',
    ).run(groupFolder, effectiveAgentId);
  })();
}

/**
 * Forget the transport identity of a logical conversation. SDK/provider resume
 * resets must not call this: the first native channel remains the Session
 * owner across model/profile recovery. Only explicit conversation deletion or
 * user-requested reset starts a new channel-ownership lifecycle.
 */
export function clearSessionChannelOwner(
  groupFolder: string,
  agentId?: string | null,
): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(
    sessionChannelOwnerKey(groupFolder, agentId),
  );
}

/** Invalidate every SDK resume token associated with a workspace. */
export function deleteWorkspaceSessions(groupFolder: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ?',
    ).run(groupFolder);
  })();
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
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (group_folder, session_id, agent_id, provider_id)
       VALUES (?, '', ?, ?)
       ON CONFLICT(group_folder, agent_id) DO UPDATE SET provider_id = excluded.provider_id`,
    ).run(groupFolder, effectiveAgentId, providerId);
    syncWorkspaceRuntimeSessionProjection(groupFolder, effectiveAgentId);
  })();
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ?',
    ).run(groupFolder);
    db.prepare('DELETE FROM router_state WHERE key LIKE ?').run(
      `channel_session_owner:${groupFolder}:%`,
    );
  })();
}

export interface SessionAgentIdentity {
  agent_profile_id: string | null;
  agent_profile_version: number | null;
  identity_hash: string | null;
}

export function getSessionAgentIdentity(
  groupFolder: string,
  agentId?: string | null,
): SessionAgentIdentity | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      `SELECT agent_profile_id, agent_profile_version, identity_hash
       FROM sessions
       WHERE group_folder = ? AND agent_id = ?`,
    )
    .get(groupFolder, effectiveAgentId) as SessionAgentIdentity | undefined;
  return row;
}

const DEFAULT_AGENT_PROFILE_RUNTIME_POLICY: AgentProfileRuntimePolicy = {
  context: {
    source: 'managed',
    auto_compact_window: 0,
    auto_compact_percentage: 0,
  },
  skills: { mode: 'inherit', ids: [] },
  mcp: { mode: 'inherit', ids: [] },
};

type RuntimePolicyInput = Partial<{
  context: Partial<AgentProfileRuntimePolicy['context']> | null;
  skills:
    | (Partial<Omit<AgentProfileRuntimePolicy['skills'], 'host'>> & {
        host?: Partial<
          NonNullable<AgentProfileRuntimePolicy['skills']['host']>
        > | null;
      })
    | null;
  mcp: Partial<AgentProfileRuntimePolicy['mcp']> | null;
}>;

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeMode<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeAgentProfileRuntimePolicy(
  input?: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
): AgentProfileRuntimePolicy {
  const raw = (input ?? {}) as RuntimePolicyInput | AgentProfileRuntimePolicy;
  const normalized: AgentProfileRuntimePolicy = {
    context: {
      source: normalizeMode(
        raw.context?.source,
        ['managed', 'host_claude'] as const,
        'managed',
      ),
      auto_compact_window: (() => {
        const value = raw.context?.auto_compact_window;
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value <= 0
        ) {
          return 0;
        }
        return Math.min(1_000_000, Math.max(100_000, Math.floor(value)));
      })(),
      auto_compact_percentage: (() => {
        const value = raw.context?.auto_compact_percentage;
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value <= 0
        ) {
          return 0;
        }
        return Math.min(90, Math.max(50, Math.floor(value)));
      })(),
    },
    skills: {
      mode: normalizeMode(
        raw.skills?.mode,
        ['inherit', 'custom', 'disabled'] as const,
        'inherit',
      ),
      ids: normalizeIdList(raw.skills?.ids),
      ...(raw.skills?.host
        ? {
            host: {
              mode: normalizeMode(
                raw.skills.host.mode,
                ['inherit', 'custom', 'disabled'] as const,
                'disabled',
              ),
              ids: normalizeIdList(raw.skills.host.ids),
            },
          }
        : {}),
    },
    mcp: {
      mode: normalizeMode(
        raw.mcp?.mode,
        ['inherit', 'custom', 'disabled'] as const,
        'inherit',
      ),
      ids: normalizeIdList(raw.mcp?.ids),
    },
  };
  if (normalized.context.auto_compact_percentage > 0) {
    normalized.context.auto_compact_window = 0;
  }
  return normalized;
}

/** Merge a PATCH-shaped policy without resetting omitted sibling fields. */
export function mergeAgentProfileRuntimePolicy(
  current: AgentProfileRuntimePolicy,
  patch: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
): AgentProfileRuntimePolicy {
  if (patch === null) return normalizeAgentProfileRuntimePolicy();
  const has = (key: keyof RuntimePolicyInput) =>
    Object.prototype.hasOwnProperty.call(patch, key);
  const mergeCapability = <T extends 'skills' | 'mcp'>(key: T) => {
    const value = patch[key];
    if (value === null) return DEFAULT_AGENT_PROFILE_RUNTIME_POLICY[key];
    const merged = {
      mode: value?.mode ?? current[key].mode,
      ids: value?.ids ?? current[key].ids,
    };
    if (key !== 'skills') return merged;
    const skillsValue = value as RuntimePolicyInput['skills'];
    if (skillsValue?.host === null) return merged;
    const currentHost = current.skills.host;
    if (skillsValue?.host !== undefined) {
      return {
        ...merged,
        host: {
          mode: skillsValue.host.mode ?? currentHost?.mode ?? 'disabled',
          ids: skillsValue.host.ids ?? currentHost?.ids ?? [],
        },
      };
    }
    return currentHost ? { ...merged, host: currentHost } : merged;
  };

  return normalizeAgentProfileRuntimePolicy({
    context: has('context')
      ? patch.context === null
        ? DEFAULT_AGENT_PROFILE_RUNTIME_POLICY.context
        : {
            source: patch.context?.source ?? current.context.source,
            auto_compact_window:
              patch.context?.auto_compact_window ??
              current.context.auto_compact_window,
            auto_compact_percentage:
              patch.context?.auto_compact_percentage ??
              current.context.auto_compact_percentage,
          }
      : current.context,
    skills: has('skills') ? mergeCapability('skills') : current.skills,
    mcp: has('mcp') ? mergeCapability('mcp') : current.mcp,
  });
}

export function serializeAgentProfileRuntimePolicy(
  input?: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
): string {
  return JSON.stringify(normalizeAgentProfileRuntimePolicy(input));
}

/**
 * Remove the retired Agent-level tool boundary from persisted profiles.
 * Profiles that previously restricted tools receive a new identity version so
 * their next run cannot resume a session created under the old restriction.
 */
function removeLegacyAgentToolPolicies(): void {
  const rows = db.prepare('SELECT * FROM agent_profiles').all() as Array<
    Record<string, unknown>
  >;
  const legacyRows = rows.filter((row) => {
    try {
      const parsed =
        typeof row.runtime_policy === 'string'
          ? JSON.parse(row.runtime_policy)
          : row.runtime_policy;
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        Object.prototype.hasOwnProperty.call(parsed, 'tools')
      );
    } catch {
      return false;
    }
  });
  if (legacyRows.length === 0) return;

  const update = db.prepare(
    `UPDATE agent_profiles
     SET runtime_policy = ?, identity_hash = ?, version = ?, updated_at = ?
     WHERE id = ?`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of legacyRows) {
      const profile = mapAgentProfileRow(row);
      const identityHash = computeAgentProfileIdentityHash(
        profile,
        profile.runtime_policy,
        profile.name,
      );
      const identityChanged = identityHash !== profile.identity_hash;
      update.run(
        serializeAgentProfileRuntimePolicy(profile.runtime_policy),
        identityHash,
        identityChanged ? profile.version + 1 : profile.version,
        identityChanged ? now : profile.updated_at,
        profile.id,
      );
    }
  })();
  logger.info(
    { rows: legacyRows.length },
    'Removed retired Agent tool policies from persisted profiles',
  );
}

export function migrateAgentProfileAutoCompactWindow(
  legacyValue: number | undefined,
): number {
  if (legacyValue === undefined) return 0;
  const value = Math.min(1_000_000, Math.max(100_000, Math.floor(legacyValue)));
  const rows = db
    .prepare(
      'SELECT id, runtime_policy FROM agent_profiles WHERE is_default = 0',
    )
    .all() as Array<{ id: string; runtime_policy: unknown }>;
  const update = db.prepare(
    'UPDATE agent_profiles SET runtime_policy = ? WHERE id = ?',
  );
  let migrated = 0;
  db.transaction(() => {
    for (const row of rows) {
      let raw: Record<string, unknown> = {};
      try {
        const parsed =
          typeof row.runtime_policy === 'string'
            ? JSON.parse(row.runtime_policy)
            : row.runtime_policy;
        if (parsed && typeof parsed === 'object') {
          raw = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid legacy policy is normalized below.
      }
      const rawContext =
        raw.context && typeof raw.context === 'object'
          ? (raw.context as Record<string, unknown>)
          : {};
      if (
        Object.prototype.hasOwnProperty.call(rawContext, 'auto_compact_window')
      ) {
        continue;
      }
      const normalized = normalizeAgentProfileRuntimePolicy(
        raw as RuntimePolicyInput,
      );
      normalized.context.auto_compact_window = value;
      update.run(JSON.stringify(normalized), row.id);
      migrated += 1;
    }
  })();
  return migrated;
}

function parseAgentProfileRuntimePolicy(
  raw: unknown,
): AgentProfileRuntimePolicy {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as RuntimePolicyInput;
      return normalizeAgentProfileRuntimePolicy(parsed);
    } catch {
      return normalizeAgentProfileRuntimePolicy();
    }
  }
  if (raw && typeof raw === 'object') {
    return normalizeAgentProfileRuntimePolicy(raw as RuntimePolicyInput);
  }
  return normalizeAgentProfileRuntimePolicy();
}

export function computeAgentProfileIdentityHash(
  identityPrompt: string,
  includeClaudePreset?: boolean,
  runtimePolicy?: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
  name?: string,
): string;
export function computeAgentProfileIdentityHash(
  prompts: AgentProfilePrompts,
  runtimePolicy?: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
  name?: string,
): string;
export function computeAgentProfileIdentityHash(
  promptsOrIdentity: string | AgentProfilePrompts,
  includeOrRuntime:
    | boolean
    | RuntimePolicyInput
    | AgentProfileRuntimePolicy
    | null = true,
  runtimeOrName?:
    | RuntimePolicyInput
    | AgentProfileRuntimePolicy
    | null
    | string,
  legacyName = '',
): string {
  const legacyCall = typeof promptsOrIdentity === 'string';
  const prompts = legacyCall
    ? normalizeAgentProfilePrompts({
        identity_prompt: promptsOrIdentity,
        prompt_mode: promptModeFromLegacyPreset(
          typeof includeOrRuntime === 'boolean' ? includeOrRuntime : true,
        ),
      })
    : normalizeAgentProfilePrompts(promptsOrIdentity);
  const runtimePolicy = legacyCall
    ? (runtimeOrName as
        | RuntimePolicyInput
        | AgentProfileRuntimePolicy
        | null
        | undefined)
    : (includeOrRuntime as
        | RuntimePolicyInput
        | AgentProfileRuntimePolicy
        | null
        | undefined);
  const name = legacyCall
    ? legacyName
    : typeof runtimeOrName === 'string'
      ? runtimeOrName
      : '';
  const normalizedPolicy = normalizeAgentProfileRuntimePolicy(runtimePolicy);
  const payload: {
    prompts: AgentProfilePrompts;
    runtimePolicy?: Record<string, unknown>;
    name?: string;
  } = { prompts };
  const identityPolicy = {
    context: { source: normalizedPolicy.context.source },
    skills: normalizedPolicy.skills,
    mcp: normalizedPolicy.mcp,
  };
  const defaultIdentityPolicy = {
    context: { source: DEFAULT_AGENT_PROFILE_RUNTIME_POLICY.context.source },
    skills: DEFAULT_AGENT_PROFILE_RUNTIME_POLICY.skills,
    mcp: DEFAULT_AGENT_PROFILE_RUNTIME_POLICY.mcp,
  };
  if (name) payload.name = name;
  if (
    JSON.stringify(identityPolicy) !== JSON.stringify(defaultIdentityPolicy)
  ) {
    payload.runtimePolicy = identityPolicy;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function mapAgentProfilePromptVersionRow(
  row: Record<string, unknown>,
): AgentProfilePromptVersion {
  return {
    id: String(row.id),
    agent_profile_id: String(row.agent_profile_id),
    version: Number(row.version),
    name: String(row.name),
    identity_prompt: String(row.identity_prompt ?? ''),
    soul_prompt: String(row.soul_prompt ?? ''),
    agents_prompt: String(row.agents_prompt ?? ''),
    tools_prompt: String(row.tools_prompt ?? ''),
    prompt_mode: row.prompt_mode === 'replace' ? 'replace' : 'append',
    identity_hash: String(row.identity_hash),
    change_source:
      row.change_source === 'create' ||
      row.change_source === 'restore' ||
      row.change_source === 'migration'
        ? row.change_source
        : 'update',
    restored_from_version:
      row.restored_from_version == null
        ? null
        : Number(row.restored_from_version),
    created_at: String(row.created_at),
  };
}

function insertAgentProfilePromptVersionSnapshot(input: {
  profileId: string;
  version: number;
  name: string;
  prompts: AgentProfilePrompts;
  identityHash: string;
  changeSource: AgentProfilePromptVersion['change_source'];
  restoredFromVersion?: number | null;
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_profile_prompt_versions (
      id, agent_profile_id, version, name,
      identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode,
      identity_hash, change_source, restored_from_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.profileId,
    input.version,
    input.name,
    input.prompts.identity_prompt,
    input.prompts.soul_prompt,
    input.prompts.agents_prompt,
    input.prompts.tools_prompt,
    input.prompts.prompt_mode,
    input.identityHash,
    input.changeSource,
    input.restoredFromVersion ?? null,
    input.createdAt ?? new Date().toISOString(),
  );
}

export function listAgentProfilePromptVersions(
  profileId: string,
  ownerUserId: string,
): AgentProfilePromptVersion[] {
  const profile = getAgentProfileForUser(profileId, ownerUserId);
  if (!profile) return [];
  const rows = db
    .prepare(
      `SELECT * FROM agent_profile_prompt_versions
       WHERE agent_profile_id = ? ORDER BY version DESC`,
    )
    .all(profileId) as Array<Record<string, unknown>>;
  return rows.map(mapAgentProfilePromptVersionRow);
}

export function getAgentProfilePromptVersion(
  profileId: string,
  ownerUserId: string,
  version: number,
): AgentProfilePromptVersion | undefined {
  const profile = getAgentProfileForUser(profileId, ownerUserId);
  if (!profile) return undefined;
  const row = db
    .prepare(
      `SELECT * FROM agent_profile_prompt_versions
       WHERE agent_profile_id = ? AND version = ?`,
    )
    .get(profileId, version) as Record<string, unknown> | undefined;
  return row ? mapAgentProfilePromptVersionRow(row) : undefined;
}

function mapAgentProfileRow(row: Record<string, unknown>): AgentProfile {
  const name = String(row.name);
  const persistedIncludeClaudePreset =
    Number(row.include_claude_preset ?? 1) === 1;
  const prompts = normalizeAgentProfilePrompts({
    identity_prompt: String(row.identity_prompt ?? ''),
    soul_prompt: String(row.soul_prompt ?? ''),
    agents_prompt: String(row.agents_prompt ?? ''),
    tools_prompt: String(row.tools_prompt ?? ''),
    prompt_mode:
      row.prompt_mode === 'replace' || row.prompt_mode === 'append'
        ? row.prompt_mode
        : promptModeFromLegacyPreset(persistedIncludeClaudePreset),
  });
  const includeClaudePreset = includeClaudePresetForMode(prompts.prompt_mode);
  const runtimePolicy = parseAgentProfileRuntimePolicy(row.runtime_policy);
  return {
    id: String(row.id),
    owner_user_id: String(row.owner_user_id),
    name,
    ...prompts,
    include_claude_preset: includeClaudePreset,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    runtime_policy: runtimePolicy,
    identity_hash: String(
      row.identity_hash ??
        computeAgentProfileIdentityHash(prompts, runtimePolicy, name),
    ),
    version: Number(row.version ?? 1),
    is_default: Number(row.is_default ?? 0) === 1,
    status: row.status === 'archived' ? 'archived' : 'active',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getAgentProfile(profileId: string): AgentProfile | undefined {
  const row = db
    .prepare('SELECT * FROM agent_profiles WHERE id = ?')
    .get(profileId) as Record<string, unknown> | undefined;
  return row ? mapAgentProfileRow(row) : undefined;
}

export function getAgentProfileForUser(
  profileId: string,
  userId: string,
): AgentProfile | undefined {
  const row = db
    .prepare(
      "SELECT * FROM agent_profiles WHERE id = ? AND owner_user_id = ? AND status = 'active'",
    )
    .get(profileId, userId) as Record<string, unknown> | undefined;
  return row ? mapAgentProfileRow(row) : undefined;
}

function mapAgentBuilderDraftRow(
  row: Record<string, unknown>,
): AgentBuilderDraft {
  let definition: AgentBuilderDefinition;
  let assumptions: string[];
  try {
    definition = JSON.parse(String(row.definition_json));
  } catch {
    throw new Error(
      `Invalid Agent Builder draft definition: ${String(row.id)}`,
    );
  }
  try {
    const parsed = JSON.parse(String(row.assumptions_json ?? '[]'));
    assumptions = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    assumptions = [];
  }
  return {
    id: String(row.id),
    owner_user_id: String(row.owner_user_id),
    source_group: String(row.source_group),
    source_chat_jid: String(row.source_chat_jid),
    target_agent_profile_id:
      typeof row.target_agent_profile_id === 'string'
        ? row.target_agent_profile_id
        : null,
    base_agent_version:
      row.base_agent_version == null ? null : Number(row.base_agent_version),
    revision: Number(row.revision),
    state:
      row.state === 'published' || row.state === 'discarded'
        ? row.state
        : 'ready',
    definition,
    assumptions,
    prepared_turn_id:
      typeof row.prepared_turn_id === 'string' ? row.prepared_turn_id : null,
    confirmation_phrase:
      typeof row.confirmation_phrase === 'string'
        ? row.confirmation_phrase
        : '',
    published_agent_profile_id:
      typeof row.published_agent_profile_id === 'string'
        ? row.published_agent_profile_id
        : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getAgentBuilderDraftForUser(
  draftId: string,
  ownerUserId: string,
): AgentBuilderDraft | undefined {
  const row = db
    .prepare(
      'SELECT * FROM agent_builder_drafts WHERE id = ? AND owner_user_id = ?',
    )
    .get(draftId, ownerUserId) as Record<string, unknown> | undefined;
  return row ? mapAgentBuilderDraftRow(row) : undefined;
}

export function listReadyAgentBuilderDraftsForUser(
  ownerUserId: string,
): AgentBuilderDraft[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_builder_drafts
       WHERE owner_user_id = ? AND state = 'ready'
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(ownerUserId) as Array<Record<string, unknown>>;
  return rows.map(mapAgentBuilderDraftRow);
}

export function saveAgentBuilderDraft(input: {
  id?: string;
  ownerUserId: string;
  sourceGroup: string;
  sourceChatJid: string;
  targetAgentProfileId: string | null;
  baseAgentVersion: number | null;
  expectedRevision?: number;
  definition: AgentBuilderDefinition;
  assumptions?: string[];
  preparedTurnId?: string | null;
  confirmationPhrase: string;
}): AgentBuilderDraft | undefined {
  const now = new Date().toISOString();
  if (input.id) {
    const current = getAgentBuilderDraftForUser(input.id, input.ownerUserId);
    if (
      !current ||
      current.state !== 'ready' ||
      input.expectedRevision === undefined ||
      current.revision !== input.expectedRevision
    ) {
      return undefined;
    }
    const nextRevision = current.revision + 1;
    const result = db
      .prepare(
        `UPDATE agent_builder_drafts
         SET source_group = ?, source_chat_jid = ?, target_agent_profile_id = ?,
             base_agent_version = ?, revision = ?, definition_json = ?,
             assumptions_json = ?, prepared_turn_id = ?,
             confirmation_phrase = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND revision = ? AND state = 'ready'`,
      )
      .run(
        input.sourceGroup,
        input.sourceChatJid,
        input.targetAgentProfileId,
        input.baseAgentVersion,
        nextRevision,
        JSON.stringify(input.definition),
        JSON.stringify(input.assumptions ?? []),
        input.preparedTurnId ?? null,
        input.confirmationPhrase,
        now,
        input.id,
        input.ownerUserId,
        current.revision,
      );
    if (result.changes === 0) return undefined;
    return getAgentBuilderDraftForUser(input.id, input.ownerUserId);
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_builder_drafts (
      id, owner_user_id, source_group, source_chat_jid,
      target_agent_profile_id, base_agent_version, revision, state,
      definition_json, assumptions_json, prepared_turn_id,
      confirmation_phrase, published_agent_profile_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'ready', ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.ownerUserId,
    input.sourceGroup,
    input.sourceChatJid,
    input.targetAgentProfileId,
    input.baseAgentVersion,
    JSON.stringify(input.definition),
    JSON.stringify(input.assumptions ?? []),
    input.preparedTurnId ?? null,
    input.confirmationPhrase,
    now,
    now,
  );
  return getAgentBuilderDraftForUser(id, input.ownerUserId);
}

export function discardAgentBuilderDraft(
  draftId: string,
  ownerUserId: string,
  expectedRevision: number,
): AgentBuilderDraft | undefined {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE agent_builder_drafts
       SET state = 'discarded', updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND revision = ? AND state = 'ready'`,
    )
    .run(now, draftId, ownerUserId, expectedRevision);
  return result.changes > 0
    ? getAgentBuilderDraftForUser(draftId, ownerUserId)
    : undefined;
}

export function commitAgentBuilderDraft(
  draftId: string,
  ownerUserId: string,
  expectedRevision: number,
  commit: (draft: AgentBuilderDraft) => AgentProfile,
): { draft: AgentBuilderDraft; profile: AgentProfile } | undefined {
  return db.transaction(() => {
    const draft = getAgentBuilderDraftForUser(draftId, ownerUserId);
    if (
      !draft ||
      draft.state !== 'ready' ||
      draft.revision !== expectedRevision
    ) {
      return undefined;
    }
    const profile = commit(draft);
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE agent_builder_drafts
         SET state = 'published', published_agent_profile_id = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND revision = ? AND state = 'ready'`,
      )
      .run(profile.id, now, draftId, ownerUserId, expectedRevision);
    if (result.changes === 0) throw new Error('Agent Builder draft changed');
    return {
      draft: getAgentBuilderDraftForUser(draftId, ownerUserId)!,
      profile,
    };
  })();
}

const DEFAULT_AGENT_PROFILE_NAME = 'HappyClaw';
const LEGACY_DEFAULT_AGENT_PROFILE_NAME = 'Default Agent';

export function getOrCreateDefaultAgentProfile(userId: string): AgentProfile {
  const existing = db
    .prepare(
      "SELECT * FROM agent_profiles WHERE owner_user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1",
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (existing) {
    const profile = mapAgentProfileRow(existing);
    const migrateName = profile.name === LEGACY_DEFAULT_AGENT_PROFILE_NAME;
    if (!migrateName) return profile;

    const now = new Date().toISOString();
    const name = migrateName ? DEFAULT_AGENT_PROFILE_NAME : profile.name;
    const runtimePolicy = profile.runtime_policy;
    const identityHash = computeAgentProfileIdentityHash(
      profile,
      runtimePolicy,
      name,
    );
    const nextVersion = profile.version + 1;
    db.transaction(() => {
      db.prepare(
        `UPDATE agent_profiles
         SET name = ?, runtime_policy = ?, identity_hash = ?, version = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        name,
        serializeAgentProfileRuntimePolicy(runtimePolicy),
        identityHash,
        nextVersion,
        now,
        profile.id,
      );
    })();
    return getAgentProfile(profile.id)!;
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const name = DEFAULT_AGENT_PROFILE_NAME;
  const prompts = normalizeAgentProfilePrompts();
  const runtimePolicy = normalizeAgentProfileRuntimePolicy();
  const identityHash = computeAgentProfileIdentityHash(
    prompts,
    runtimePolicy,
    name,
  );
  const runtimePolicyJson = serializeAgentProfileRuntimePolicy(runtimePolicy);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, owner_user_id, name,
        identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode,
        include_claude_preset, runtime_policy, identity_hash, version,
        is_default, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active', ?, ?)`,
    ).run(
      id,
      userId,
      name,
      prompts.identity_prompt,
      prompts.soul_prompt,
      prompts.agents_prompt,
      prompts.tools_prompt,
      prompts.prompt_mode,
      includeClaudePresetForMode(prompts.prompt_mode) ? 1 : 0,
      runtimePolicyJson,
      identityHash,
      now,
      now,
    );
    insertAgentProfilePromptVersionSnapshot({
      profileId: id,
      version: 1,
      name,
      prompts,
      identityHash,
      changeSource: 'create',
      createdAt: now,
    });
  })();
  return getAgentProfile(id)!;
}

export function listAgentProfilesForUser(userId: string): AgentProfile[] {
  getOrCreateDefaultAgentProfile(userId);
  const rows = db
    .prepare(
      `SELECT * FROM agent_profiles
       WHERE owner_user_id = ? AND status = 'active'
       ORDER BY is_default DESC, updated_at DESC, created_at ASC`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(mapAgentProfileRow);
}

export function createAgentProfile(input: {
  profileId?: string;
  ownerUserId: string;
  name: string;
  identityPrompt?: string;
  soulPrompt?: string;
  agentsPrompt?: string;
  toolsPrompt?: string;
  promptMode?: AgentProfilePromptMode;
  includeClaudePreset?: boolean;
  avatarEmoji?: string | null;
  avatarColor?: string | null;
  runtimePolicy?: RuntimePolicyInput | AgentProfileRuntimePolicy | null;
}): AgentProfile {
  const now = new Date().toISOString();
  const id = input.profileId ?? crypto.randomUUID();
  const prompts = normalizeAgentProfilePrompts({
    identity_prompt: input.identityPrompt ?? '',
    soul_prompt: input.soulPrompt ?? '',
    agents_prompt: input.agentsPrompt ?? '',
    tools_prompt: input.toolsPrompt ?? '',
    prompt_mode:
      input.promptMode ??
      promptModeFromLegacyPreset(input.includeClaudePreset ?? true),
  });
  const runtimePolicy = normalizeAgentProfileRuntimePolicy(input.runtimePolicy);
  const runtimePolicyJson = serializeAgentProfileRuntimePolicy(runtimePolicy);
  const identityHash = computeAgentProfileIdentityHash(
    prompts,
    runtimePolicy,
    input.name,
  );
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_profiles (
        id, owner_user_id, name,
        identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode,
        include_claude_preset, avatar_emoji, avatar_color, runtime_policy, identity_hash, version,
        is_default, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'active', ?, ?)`,
    ).run(
      id,
      input.ownerUserId,
      input.name,
      prompts.identity_prompt,
      prompts.soul_prompt,
      prompts.agents_prompt,
      prompts.tools_prompt,
      prompts.prompt_mode,
      includeClaudePresetForMode(prompts.prompt_mode) ? 1 : 0,
      input.avatarEmoji ?? null,
      input.avatarColor ?? null,
      runtimePolicyJson,
      identityHash,
      now,
      now,
    );
    insertAgentProfilePromptVersionSnapshot({
      profileId: id,
      version: 1,
      name: input.name,
      prompts,
      identityHash,
      changeSource: 'create',
      createdAt: now,
    });
  })();
  return getAgentProfile(id)!;
}

export function updateAgentProfile(
  profileId: string,
  ownerUserId: string,
  updates: {
    name?: string;
    identityPrompt?: string;
    soulPrompt?: string;
    agentsPrompt?: string;
    toolsPrompt?: string;
    promptMode?: AgentProfilePromptMode;
    includeClaudePreset?: boolean;
    avatarEmoji?: string | null;
    avatarColor?: string | null;
    avatarUrl?: string | null;
    runtimePolicy?: RuntimePolicyInput | AgentProfileRuntimePolicy | null;
    changeSource?: AgentProfilePromptVersion['change_source'];
    restoredFromVersion?: number | null;
  },
): AgentProfile | undefined {
  const existing = getAgentProfileForUser(profileId, ownerUserId);
  if (!existing) return undefined;
  const nextName = updates.name ?? existing.name;
  const nextPromptMode =
    updates.promptMode ??
    (updates.includeClaudePreset === undefined
      ? existing.prompt_mode
      : promptModeFromLegacyPreset(updates.includeClaudePreset));
  const nextPrompts = normalizeAgentProfilePrompts({
    identity_prompt: updates.identityPrompt ?? existing.identity_prompt,
    soul_prompt: updates.soulPrompt ?? existing.soul_prompt,
    agents_prompt: updates.agentsPrompt ?? existing.agents_prompt,
    tools_prompt: updates.toolsPrompt ?? existing.tools_prompt,
    prompt_mode: nextPromptMode,
  });
  const nextRuntimePolicy =
    updates.runtimePolicy !== undefined
      ? mergeAgentProfileRuntimePolicy(
          existing.runtime_policy,
          updates.runtimePolicy,
        )
      : existing.runtime_policy;
  const nextAvatarEmoji =
    updates.avatarEmoji === undefined
      ? existing.avatar_emoji
      : updates.avatarEmoji;
  const nextAvatarColor =
    updates.avatarColor === undefined
      ? existing.avatar_color
      : updates.avatarColor;
  const nextAvatarUrl =
    updates.avatarUrl === undefined ? existing.avatar_url : updates.avatarUrl;
  const nextHash = computeAgentProfileIdentityHash(
    nextPrompts,
    nextRuntimePolicy,
    nextName,
  );
  const identityChanged = nextHash !== existing.identity_hash;
  const promptChanged =
    nextPrompts.identity_prompt !== existing.identity_prompt ||
    nextPrompts.soul_prompt !== existing.soul_prompt ||
    nextPrompts.agents_prompt !== existing.agents_prompt ||
    nextPrompts.tools_prompt !== existing.tools_prompt ||
    nextPrompts.prompt_mode !== existing.prompt_mode;
  const nextVersion = identityChanged ? existing.version + 1 : existing.version;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE agent_profiles
       SET name = ?, identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
           prompt_mode = ?, include_claude_preset = ?, avatar_emoji = ?, avatar_color = ?, avatar_url = ?,
           runtime_policy = ?, identity_hash = ?, version = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND status = 'active'`,
    ).run(
      nextName,
      nextPrompts.identity_prompt,
      nextPrompts.soul_prompt,
      nextPrompts.agents_prompt,
      nextPrompts.tools_prompt,
      nextPrompts.prompt_mode,
      includeClaudePresetForMode(nextPrompts.prompt_mode) ? 1 : 0,
      nextAvatarEmoji,
      nextAvatarColor,
      nextAvatarUrl,
      serializeAgentProfileRuntimePolicy(nextRuntimePolicy),
      nextHash,
      nextVersion,
      now,
      profileId,
      ownerUserId,
    );
    // Runtime identity versions intentionally also advance for name and
    // capability-policy changes so existing SDK sessions are invalidated.
    // Prompt history, however, is a history of the four prompt sections and
    // prompt mode only; recording unrelated identity versions here would show
    // duplicate prompt revisions in the editor.
    if (promptChanged) {
      insertAgentProfilePromptVersionSnapshot({
        profileId,
        version: nextVersion,
        name: nextName,
        prompts: nextPrompts,
        identityHash: nextHash,
        changeSource: updates.changeSource ?? 'update',
        restoredFromVersion: updates.restoredFromVersion,
        createdAt: now,
      });
    }
  })();
  return getAgentProfile(profileId);
}

export function archiveAgentProfile(
  profileId: string,
  ownerUserId: string,
): 'ok' | 'not_found' | 'is_default' | 'has_workspaces' | 'has_mounts' {
  const existing = getAgentProfileForUser(profileId, ownerUserId);
  if (!existing) return 'not_found';
  if (existing.is_default) return 'is_default';
  const count = countWorkspaceAgentProfileMappings(profileId);
  if (count > 0) return 'has_workspaces';
  if (countAgentChannelMountsForProfile(profileId) > 0) return 'has_mounts';
  db.prepare(
    "UPDATE agent_profiles SET status = 'archived', updated_at = ? WHERE id = ? AND owner_user_id = ?",
  ).run(new Date().toISOString(), profileId, ownerUserId);
  return 'ok';
}

export function assignWorkspaceAgentProfile(
  groupFolder: string,
  profileId: string,
  interactionMode?: InteractionMode,
): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    const home = db
      .prepare(
        `SELECT created_by
         FROM registered_groups
         WHERE folder = ? AND jid LIKE 'web:%' AND is_home = 1
         ORDER BY added_at ASC
         LIMIT 1`,
      )
      .get(groupFolder) as { created_by: string | null } | undefined;
    if (home?.created_by) {
      const defaultProfile = getOrCreateDefaultAgentProfile(home.created_by);
      if (profileId !== defaultProfile.id) {
        throw new Error(
          'Home Workspace must remain bound to the built-in HappyClaw Agent',
        );
      }
    }
    db.prepare(
      `INSERT INTO workspace_agent_profiles (
        group_folder, agent_profile_id, interaction_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_folder) DO UPDATE SET
        agent_profile_id = excluded.agent_profile_id,
        interaction_mode = CASE
          WHEN ? IS NULL THEN workspace_agent_profiles.interaction_mode
          ELSE excluded.interaction_mode
        END,
        updated_at = excluded.updated_at`,
    ).run(
      groupFolder,
      profileId,
      interactionMode ?? 'assistant',
      now,
      now,
      interactionMode ?? null,
    );
    syncAgentChannelMountsForWorkspaceFolder(groupFolder);
  })();
}

function parseInteractionMode(
  value: unknown,
  groupFolder: string,
): InteractionMode {
  if (value === 'proactive' || value === 'persona') return 'proactive';
  if (value !== 'assistant' && value != null && value !== '') {
    logger.warn(
      { groupFolder, interactionMode: value },
      'Invalid workspace interaction mode; falling back to assistant',
    );
  }
  return 'assistant';
}

export function getWorkspaceAgentProfileBinding(
  groupFolder: string,
): WorkspaceAgentProfileBinding | undefined {
  const row = db
    .prepare(
      `SELECT group_folder, agent_profile_id, interaction_mode, created_at, updated_at
       FROM workspace_agent_profiles
       WHERE group_folder = ?`,
    )
    .get(groupFolder) as
    | {
        group_folder: string;
        agent_profile_id: string;
        interaction_mode: unknown;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    group_folder: row.group_folder,
    agent_profile_id: row.agent_profile_id,
    interaction_mode: parseInteractionMode(
      row.interaction_mode,
      row.group_folder,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getWorkspaceAgentProfileId(
  groupFolder: string,
): string | undefined {
  return getWorkspaceAgentProfileBinding(groupFolder)?.agent_profile_id;
}

export function getWorkspaceInteractionMode(
  groupFolder: string,
): InteractionMode {
  return (
    getWorkspaceAgentProfileBinding(groupFolder)?.interaction_mode ??
    'assistant'
  );
}

export function setWorkspaceInteractionMode(
  groupFolder: string,
  interactionMode: InteractionMode,
): boolean {
  const result = db
    .prepare(
      `UPDATE workspace_agent_profiles
       SET interaction_mode = ?, updated_at = ?
       WHERE group_folder = ?`,
    )
    .run(interactionMode, new Date().toISOString(), groupFolder);
  return result.changes > 0;
}

export function deleteWorkspaceAgentProfile(groupFolder: string): void {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM workspace_agent_profiles WHERE group_folder = ?',
    ).run(groupFolder);
    syncAgentChannelMountsForWorkspaceFolder(groupFolder);
  })();
}

export function countWorkspaceAgentProfileMappings(profileId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM workspace_agent_profiles WHERE agent_profile_id = ?',
    )
    .get(profileId) as { count: number };
  return row.count;
}

/**
 * Read-only projection of getAgentProfileForWorkspace for list/GET endpoints.
 * The full resolver self-heals (materializes a default profile, repairs the
 * workspace binding) inside write transactions — correct for runtime paths,
 * but a GET such as /api/groups must never open a write transaction as a side
 * effect of listing. Startup backfill and runtime resolution keep ownership
 * of the repairs; this variant only reports current state.
 */
export function peekAgentProfileForWorkspace(
  groupFolder: string,
  ownerUserId?: string | null,
): AgentProfile | undefined {
  const readDefaultProfile = (userId: string): AgentProfile | undefined => {
    const row = db
      .prepare(
        "SELECT * FROM agent_profiles WHERE owner_user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1",
      )
      .get(userId) as Record<string, unknown> | undefined;
    return row ? mapAgentProfileRow(row) : undefined;
  };
  const home = db
    .prepare(
      `SELECT created_by
       FROM registered_groups
       WHERE folder = ? AND jid LIKE 'web:%' AND is_home = 1
       ORDER BY added_at ASC
       LIMIT 1`,
    )
    .get(groupFolder) as { created_by: string | null } | undefined;
  if (home?.created_by) return readDefaultProfile(home.created_by);
  const mappedId = getWorkspaceAgentProfileId(groupFolder);
  if (mappedId) {
    const mapped = getAgentProfile(mappedId);
    if (mapped?.status === 'active') return mapped;
  }
  if (!ownerUserId) return undefined;
  return readDefaultProfile(ownerUserId);
}

export function getAgentProfileForWorkspace(
  groupFolder: string,
  ownerUserId?: string | null,
): AgentProfile | undefined {
  const home = db
    .prepare(
      `SELECT created_by
       FROM registered_groups
       WHERE folder = ? AND jid LIKE 'web:%' AND is_home = 1
       ORDER BY added_at ASC
       LIMIT 1`,
    )
    .get(groupFolder) as { created_by: string | null } | undefined;
  if (home?.created_by) {
    const defaultProfile = getOrCreateDefaultAgentProfile(home.created_by);
    if (getWorkspaceAgentProfileId(groupFolder) !== defaultProfile.id) {
      assignWorkspaceAgentProfile(groupFolder, defaultProfile.id);
    }
    return defaultProfile;
  }
  const mappedId = getWorkspaceAgentProfileId(groupFolder);
  if (mappedId) {
    const mapped = getAgentProfile(mappedId);
    if (mapped?.status === 'active') return mapped;
  }
  if (!ownerUserId) return undefined;
  const fallback = getOrCreateDefaultAgentProfile(ownerUserId);
  // Runtime fallback may materialize a previously-unmapped default ownership,
  // but Agent PATCH snapshots use the same default fallback before this write.
  // Therefore the workspace is already included in the default profile lock's
  // quiesce set; it cannot appear as a new membership outside that snapshot.
  assignWorkspaceAgentProfile(groupFolder, fallback.id);
  return fallback;
}

export function backfillAgentProfileDefaultsAndWorkspaceMappings(): void {
  // initDatabase invokes this before the web server publishes routes or starts
  // runners, so no process-local profile membership lock is necessary here.
  const tx = db.transaction(() => {
    const users = db
      .prepare("SELECT id FROM users WHERE status != 'deleted'")
      .all() as Array<{ id: string }>;
    for (const user of users) {
      getOrCreateDefaultAgentProfile(user.id);
    }

    const webWorkspaces = db
      .prepare(
        `SELECT folder, created_by, MAX(is_home) AS is_home
         FROM registered_groups
         WHERE jid LIKE 'web:%' AND created_by IS NOT NULL
         GROUP BY folder, created_by`,
      )
      .all() as Array<{
      folder: string;
      created_by: string;
      is_home: number;
    }>;
    for (const ws of webWorkspaces) {
      const profile = getOrCreateDefaultAgentProfile(ws.created_by);
      if (ws.is_home) {
        assignWorkspaceAgentProfile(ws.folder, profile.id);
        continue;
      }
      if (getWorkspaceAgentProfileId(ws.folder)) continue;
      assignWorkspaceAgentProfile(ws.folder, profile.id);
    }
  });
  tx();
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
function deleteSessionsByProviderIdInCurrentTransaction(
  providerId: string,
  options?: { includeUnboundFolders?: string[] },
): {
  deletedCount: number;
  affectedFolders: string[];
} {
  const includeUnboundFolders = Array.from(
    new Set(
      (options?.includeUnboundFolders ?? []).filter(
        (folder): folder is string => typeof folder === 'string' && !!folder,
      ),
    ),
  );
  const placeholders = includeUnboundFolders.map(() => '?').join(', ');
  const unboundClause = includeUnboundFolders.length
    ? ` OR (provider_id IS NULL AND group_folder IN (${placeholders}))`
    : '';
  const params = [providerId, ...includeUnboundFolders];
  const rows = db
    .prepare(
      `SELECT DISTINCT group_folder FROM sessions WHERE provider_id = ?${unboundClause}`,
    )
    .all(...params) as Array<{ group_folder: string }>;
  db.prepare(
    `DELETE FROM workspace_runtime_sessions WHERE provider_id = ?${unboundClause}`,
  ).run(...params);
  const result = db
    .prepare(`DELETE FROM sessions WHERE provider_id = ?${unboundClause}`)
    .run(...params);
  return {
    deletedCount: result.changes,
    affectedFolders: rows.map((r) => r.group_folder),
  };
}

export function deleteSessionsByProviderId(
  providerId: string,
  options?: { includeUnboundFolders?: string[] },
): {
  deletedCount: number;
  affectedFolders: string[];
} {
  return db.transaction(() =>
    deleteSessionsByProviderIdInCurrentTransaction(providerId, options),
  )();
}

/**
 * Delete attributable provider sessions and execute a synchronous config
 * commit in one SQLite transaction. If config validation/persistence throws,
 * session deletion rolls back, so an invalid provider PATCH cannot destroy a
 * still-valid resume token.
 */
export function deleteSessionsByProviderIdAroundCommit<T>(
  providerId: string,
  options: { includeUnboundFolders?: string[] } | undefined,
  commit: () => T,
): {
  value: T;
  deletedCount: number;
  affectedFolders: string[];
} {
  return db.transaction(() => {
    const cleanup = deleteSessionsByProviderIdInCurrentTransaction(
      providerId,
      options,
    );
    const value = commit();
    return { value, ...cleanup };
  })();
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
  avatar_url: string | null;
  container_config: string | null;
  execution_mode: string | null;
  custom_cwd: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  created_by: string | null;
  channel_account_id: string | null;
  is_home: number;
  selected_skills: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  reply_policy: string | null;
  require_mention: number;
  activation_mode: string | null;
  audience_mode: string | null;
  owner_im_id: string | null;
  owner_claim_source: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
  conversation_source: string | null;
  conversation_nav_mode: string | null;
  binding_mode: string | null;
  native_context_type: string | null;
  feishu_chat_mode: string | null;
  feishu_group_message_type: string | null;
  sender_allowlist: string | null;
};

function parsePersistedContainerConfig(
  jid: string,
  raw: string | null,
): Pick<RegisteredGroup, 'containerConfig' | 'containerConfigError'> {
  if (!raw) return {};

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    const containerConfigError = 'container_config contains malformed JSON';
    logger.warn(
      { jid, err, raw: raw.slice(0, 200) },
      'parseGroupRow: malformed container_config retained as a runtime safety block',
    );
    return { containerConfigError };
  }

  const parsed = parseContainerConfig(decoded);
  if (parsed.error) {
    logger.warn(
      { jid, error: parsed.error },
      'parseGroupRow: invalid container_config retained as a runtime safety block',
    );
    return { containerConfigError: parsed.error };
  }
  return parsed.config ? { containerConfig: parsed.config } : {};
}

/** Convert a raw DB row into a RegisteredGroup domain object. */
function parseGroupRow(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  // Invalid container config must not be silently dropped: doing so could turn
  // a corrupt persisted authorization boundary into an apparently safe group.
  const parsedContainerConfig = parsePersistedContainerConfig(
    row.jid,
    row.container_config,
  );
  let senderAllowlist: string[] | undefined;
  if (row.sender_allowlist != null) {
    try {
      const parsed = JSON.parse(row.sender_allowlist) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        senderAllowlist = parsed as string[];
      } else {
        // Fail-closed：semantics 层把 [] 视为「禁止所有发送者」。坏数据回退
        // 到 [] 比 undefined（=允许全部）更安全 —— 与 R0 的 owner-only 默认
        // 一致，不会把限制群默默改成开放群。
        senderAllowlist = [];
        logger.warn(
          { jid: row.jid },
          'parseGroupRow: sender_allowlist not a string[], falling back to [] (fail-closed)',
        );
      }
    } catch (err) {
      // 解析失败同样 fail-closed：[] = 禁止所有，等待运维修复。
      senderAllowlist = [];
      logger.warn(
        { jid: row.jid, err, raw: row.sender_allowlist.slice(0, 200) },
        'parseGroupRow: sender_allowlist JSON malformed, falling back to [] (fail-closed)',
      );
    }
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    avatar_url: row.avatar_url ?? undefined,
    ...parsedContainerConfig,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    channel_account_id: row.channel_account_id ?? undefined,
    is_home: row.is_home === 1,
    target_agent_id: row.target_agent_id ?? undefined,
    target_main_jid: row.target_main_jid ?? undefined,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    require_mention: row.require_mention === 1,
    activation_mode: parseActivationMode(row.activation_mode),
    audience_mode: parseAudienceMode(row.audience_mode),
    owner_im_id: row.owner_im_id ?? undefined,
    owner_claim_source:
      row.owner_claim_source === 'explicit' ||
      row.owner_claim_source === 'configured' ||
      row.owner_claim_source === 'trusted_direct' ||
      row.owner_claim_source === 'auto_feishu' ||
      row.owner_claim_source === 'transfer_reset'
        ? row.owner_claim_source
        : undefined,
    conversation_source:
      row.conversation_source === 'native_thread' ||
      row.conversation_source === 'feishu_thread'
        ? row.conversation_source
        : 'manual',
    conversation_nav_mode:
      row.conversation_nav_mode === 'vertical_threads'
        ? 'vertical_threads'
        : 'horizontal',
    binding_mode:
      row.binding_mode === 'thread_map' ? 'thread_map' : 'single_context',
    native_context_type:
      row.native_context_type === 'thread' ? 'thread' : 'none',
    feishu_chat_mode: row.feishu_chat_mode ?? undefined,
    feishu_group_message_type: row.feishu_group_message_type ?? undefined,
    sender_allowlist: senderAllowlist,
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
    return raw as
      | 'auto'
      | 'always'
      | 'when_mentioned'
      | 'owner_mentioned'
      | 'disabled';
  return 'auto';
}

export interface WorkspaceRecord {
  jid: string;
  folder: string;
  owner_user_id: string | null;
  name: string;
  status: 'active' | 'archived';
  is_home: boolean;
  created_at: string;
  updated_at: string;
}

/** SDK/provider resume state. This is not a user-visible product Session. */
export interface WorkspaceRuntimeSessionRecord {
  group_folder: string;
  runtime_agent_id: string;
  workspace_jid: string;
  sdk_session_id: string;
  provider_id: string | null;
  agent_profile_id: string | null;
  agent_profile_version: number | null;
  identity_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentChannelMountRecord extends ChannelMount {
  agent_profile_id: string | null;
  owner_user_id: string | null;
  workspace_folder: string | null;
}

function parseWorkspaceRecord(row: Record<string, unknown>): WorkspaceRecord {
  return {
    jid: String(row.jid),
    folder: String(row.folder),
    owner_user_id:
      typeof row.owner_user_id === 'string' ? row.owner_user_id : null,
    name: String(row.name),
    status: row.status === 'archived' ? 'archived' : 'active',
    is_home: Number(row.is_home ?? 0) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseWorkspaceRuntimeSessionRecord(
  row: Record<string, unknown>,
): WorkspaceRuntimeSessionRecord {
  return {
    group_folder: String(row.group_folder),
    runtime_agent_id: String(row.runtime_agent_id ?? ''),
    workspace_jid: String(row.workspace_jid),
    sdk_session_id: String(row.sdk_session_id ?? ''),
    provider_id: typeof row.provider_id === 'string' ? row.provider_id : null,
    agent_profile_id:
      typeof row.agent_profile_id === 'string' ? row.agent_profile_id : null,
    agent_profile_version:
      typeof row.agent_profile_version === 'number'
        ? row.agent_profile_version
        : row.agent_profile_version == null
          ? null
          : Number(row.agent_profile_version),
    identity_hash:
      typeof row.identity_hash === 'string' ? row.identity_hash : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseAgentChannelMountRecord(
  row: ChannelMountRow & Record<string, unknown>,
): AgentChannelMountRecord {
  return {
    ...parseChannelMountRow(row),
    agent_profile_id:
      typeof row.agent_profile_id === 'string' ? row.agent_profile_id : null,
    owner_user_id:
      typeof row.owner_user_id === 'string' ? row.owner_user_id : null,
    workspace_folder:
      typeof row.workspace_folder === 'string' ? row.workspace_folder : null,
  };
}

function getWorkspaceJidForFolder(groupFolder: string): string | null {
  const row = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%' ORDER BY is_home DESC, added_at ASC LIMIT 1",
    )
    .get(groupFolder) as { jid: string } | undefined;
  return row?.jid ?? null;
}

function syncWorkspaceFromRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!jid.startsWith('web:')) return;
  const now = new Date().toISOString();
  const existing = getWorkspaceRecord(jid);
  db.prepare(
    `INSERT INTO workspaces (
      jid, folder, owner_user_id, name, status, is_home, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      folder = excluded.folder,
      owner_user_id = excluded.owner_user_id,
      name = excluded.name,
      status = 'active',
      is_home = excluded.is_home,
      updated_at = excluded.updated_at`,
  ).run(
    jid,
    group.folder,
    group.created_by ?? null,
    group.name,
    group.is_home ? 1 : 0,
    existing?.created_at ?? group.added_at ?? now,
    now,
  );
}

function deleteWorkspaceMirror(jid: string, folder?: string): void {
  deleteWorkspaceMemoryData(jid);
  db.prepare('DELETE FROM workspaces WHERE jid = ?').run(jid);
  db.prepare(
    'DELETE FROM workspace_runtime_sessions WHERE workspace_jid = ?',
  ).run(jid);
  db.prepare('DELETE FROM agent_channel_mounts WHERE workspace_jid = ?').run(
    jid,
  );
  db.prepare('DELETE FROM channel_mounts WHERE workspace_jid = ?').run(jid);
  if (folder) {
    const replacementJid = getWorkspaceJidForFolder(folder);
    if (replacementJid) {
      const rows = db
        .prepare('SELECT agent_id FROM sessions WHERE group_folder = ?')
        .all(folder) as Array<{ agent_id: string | null }>;
      for (const row of rows) {
        syncWorkspaceRuntimeSessionProjection(folder, row.agent_id ?? '');
      }
    } else {
      db.prepare(
        'DELETE FROM workspace_runtime_sessions WHERE group_folder = ?',
      ).run(folder);
    }
  }
}

function syncWorkspaceRuntimeSessionProjection(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      `SELECT session_id, provider_id, agent_profile_id, agent_profile_version, identity_hash
       FROM sessions
       WHERE group_folder = ? AND agent_id = ?`,
    )
    .get(groupFolder, effectiveAgentId) as
    | {
        session_id: string;
        provider_id: string | null;
        agent_profile_id: string | null;
        agent_profile_version: number | null;
        identity_hash: string | null;
      }
    | undefined;
  if (!row) {
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ? AND runtime_agent_id = ?',
    ).run(groupFolder, effectiveAgentId);
    return;
  }
  const workspaceJid = getWorkspaceJidForFolder(groupFolder);
  if (!workspaceJid) {
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ? AND runtime_agent_id = ?',
    ).run(groupFolder, effectiveAgentId);
    return;
  }
  const now = new Date().toISOString();
  const existing = getWorkspaceRuntimeSession(groupFolder, effectiveAgentId);
  db.prepare(
    `INSERT INTO workspace_runtime_sessions (
      group_folder, runtime_agent_id, workspace_jid, sdk_session_id,
      provider_id, agent_profile_id, agent_profile_version, identity_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_folder, runtime_agent_id) DO UPDATE SET
      workspace_jid = excluded.workspace_jid,
      sdk_session_id = excluded.sdk_session_id,
      provider_id = excluded.provider_id,
      agent_profile_id = excluded.agent_profile_id,
      agent_profile_version = excluded.agent_profile_version,
      identity_hash = excluded.identity_hash,
      updated_at = excluded.updated_at`,
  ).run(
    groupFolder,
    effectiveAgentId,
    workspaceJid,
    row.session_id,
    row.provider_id ?? null,
    row.agent_profile_id ?? null,
    row.agent_profile_version ?? null,
    row.identity_hash ?? null,
    existing?.created_at ?? now,
    now,
  );
}

function syncWorkspaceRuntimeSessionsForFolder(groupFolder: string): void {
  const rows = db
    .prepare('SELECT agent_id FROM sessions WHERE group_folder = ?')
    .all(groupFolder) as Array<{ agent_id: string | null }>;
  for (const row of rows) {
    syncWorkspaceRuntimeSessionProjection(groupFolder, row.agent_id ?? '');
  }
}

function syncAgentChannelMountFromMount(mount: ChannelMount): void {
  const workspace = getRegisteredGroup(mount.workspace_jid);
  const agentProfileId = workspace
    ? (getWorkspaceAgentProfileId(workspace.folder) ?? null)
    : null;
  db.prepare(
    `INSERT INTO agent_channel_mounts (
      channel_jid, channel_account_id, agent_profile_id, owner_user_id, channel_type,
      workspace_jid, workspace_folder, session_id, routing_mode, reply_policy,
      activation_mode, audience_mode, owner_im_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_jid) DO UPDATE SET
      channel_account_id = excluded.channel_account_id,
      agent_profile_id = excluded.agent_profile_id,
      owner_user_id = excluded.owner_user_id,
      channel_type = excluded.channel_type,
      workspace_jid = excluded.workspace_jid,
      workspace_folder = excluded.workspace_folder,
      session_id = excluded.session_id,
      routing_mode = excluded.routing_mode,
      reply_policy = excluded.reply_policy,
      activation_mode = excluded.activation_mode,
      audience_mode = excluded.audience_mode,
      owner_im_id = excluded.owner_im_id,
      updated_at = excluded.updated_at`,
  ).run(
    mount.channel_jid,
    mount.channel_account_id ?? null,
    agentProfileId,
    workspace?.created_by ?? null,
    mount.channel_type,
    mount.workspace_jid,
    workspace?.folder ?? null,
    mount.session_id ?? null,
    mount.routing_mode,
    mount.reply_policy,
    mount.activation_mode,
    mount.audience_mode,
    mount.owner_im_id ?? null,
    mount.created_at,
    mount.updated_at,
  );
}

function syncAgentChannelMountsForWorkspaceFolder(groupFolder: string): void {
  const rows = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
    )
    .all(groupFolder) as Array<{ jid: string }>;
  for (const row of rows) {
    const mounts = listChannelMountsByWorkspace(row.jid);
    for (const mount of mounts) {
      syncAgentChannelMountFromMount(mount);
    }
  }
}

function syncAgentChannelMountsForWorkspaceJid(workspaceJid: string): void {
  for (const mount of listChannelMountsByWorkspace(workspaceJid)) {
    syncAgentChannelMountFromMount(mount);
  }
}

export function getWorkspaceRecord(jid: string): WorkspaceRecord | undefined {
  const row = db.prepare('SELECT * FROM workspaces WHERE jid = ?').get(jid) as
    | Record<string, unknown>
    | undefined;
  return row ? parseWorkspaceRecord(row) : undefined;
}

export function listWorkspaceRecords(): WorkspaceRecord[] {
  const rows = db
    .prepare('SELECT * FROM workspaces ORDER BY updated_at DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(parseWorkspaceRecord);
}

export function getWorkspaceRuntimeSession(
  groupFolder: string,
  agentId?: string | null,
): WorkspaceRuntimeSessionRecord | undefined {
  const row = db
    .prepare(
      'SELECT * FROM workspace_runtime_sessions WHERE group_folder = ? AND runtime_agent_id = ?',
    )
    .get(groupFolder, agentId || '') as Record<string, unknown> | undefined;
  return row ? parseWorkspaceRuntimeSessionRecord(row) : undefined;
}

export function listWorkspaceRuntimeSessionsByWorkspace(
  workspaceJid: string,
): WorkspaceRuntimeSessionRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM workspace_runtime_sessions WHERE workspace_jid = ? ORDER BY updated_at DESC',
    )
    .all(workspaceJid) as Array<Record<string, unknown>>;
  return rows.map(parseWorkspaceRuntimeSessionRecord);
}

export function getAgentChannelMount(
  channelJid: string,
): AgentChannelMountRecord | undefined {
  const row = db
    .prepare('SELECT * FROM agent_channel_mounts WHERE channel_jid = ?')
    .get(channelJid) as (ChannelMountRow & Record<string, unknown>) | undefined;
  return row ? parseAgentChannelMountRecord(row) : undefined;
}

export function listAgentChannelMountsForProfile(
  agentProfileId: string,
): AgentChannelMountRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_channel_mounts WHERE agent_profile_id = ? ORDER BY updated_at DESC',
    )
    .all(agentProfileId) as Array<ChannelMountRow & Record<string, unknown>>;
  return rows.map(parseAgentChannelMountRecord);
}

export function listAgentChannelMountsByWorkspace(
  workspaceJid: string,
): AgentChannelMountRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_channel_mounts WHERE workspace_jid = ? ORDER BY updated_at DESC',
    )
    .all(workspaceJid) as Array<ChannelMountRow & Record<string, unknown>>;
  return rows.map(parseAgentChannelMountRecord);
}

export function countAgentChannelMountsForProfile(
  agentProfileId: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM agent_channel_mounts WHERE agent_profile_id = ?',
    )
    .get(agentProfileId) as { count: number };
  return row.count;
}

export function syncAllWorkspacesFromRegisteredGroups(): void {
  const rows = db
    .prepare("SELECT * FROM registered_groups WHERE jid LIKE 'web:%'")
    .all() as RegisteredGroupRow[];
  for (const row of rows) {
    syncWorkspaceFromRegisteredGroup(row.jid, parseGroupRow(row));
  }
}

export function syncAllWorkspaceRuntimeSessionsFromSessions(): void {
  const rows = db
    .prepare('SELECT group_folder, agent_id FROM sessions')
    .all() as Array<{ group_folder: string; agent_id: string | null }>;
  for (const row of rows) {
    syncWorkspaceRuntimeSessionProjection(row.group_folder, row.agent_id ?? '');
  }
}

/**
 * Rebuild compatibility projections from their authoritative source tables.
 * The whole pass is atomic and removes projection-only ghosts left by crashes
 * or historical non-transactional dual writes.
 */
export function reconcileCanonicalRuntimeProjections(): void {
  db.transaction(() => {
    const ghostWorkspaces = db
      .prepare(
        `SELECT jid FROM workspaces
         WHERE NOT EXISTS (
           SELECT 1 FROM registered_groups rg
           WHERE rg.jid = workspaces.jid AND rg.jid LIKE 'web:%'
         )`,
      )
      .all() as Array<{ jid: string }>;
    for (const workspace of ghostWorkspaces) {
      deleteWorkspaceMemoryData(workspace.jid);
    }
    db.exec(`
      DELETE FROM workspaces
      WHERE NOT EXISTS (
        SELECT 1 FROM registered_groups rg
        WHERE rg.jid = workspaces.jid AND rg.jid LIKE 'web:%'
      )
    `);
    syncAllWorkspacesFromRegisteredGroups();
    db.exec(`
      DELETE FROM workspace_agent_profiles
      WHERE NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.folder = workspace_agent_profiles.group_folder
      )
    `);

    db.exec(`
      DELETE FROM workspace_runtime_sessions
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.group_folder = workspace_runtime_sessions.group_folder
          AND s.agent_id = workspace_runtime_sessions.runtime_agent_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM registered_groups rg
        WHERE rg.jid = workspace_runtime_sessions.workspace_jid
          AND rg.jid LIKE 'web:%'
          AND rg.folder = workspace_runtime_sessions.group_folder
      )
    `);
    syncAllWorkspaceRuntimeSessionsFromSessions();

    // Channel projections are cheap to rebuild and their source can change
    // shape (workspace vs product Session target), so a full replace is safer
    // than trying to infer every stale-target case.
    syncAllChannelMountsFromRegisteredGroups();
  })();
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

type ChannelAccountRow = {
  id: string;
  owner_user_id: string;
  provider: string;
  name: string;
  secret_ref: string;
  enabled: number;
  is_default: number;
  is_legacy_default: number;
  auth_mode: string;
  auth_status: string;
  transport_status: string;
  status: string;
  default_agent_profile_id: string | null;
  default_workspace_jid: string | null;
  last_error: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseChannelAccountRow(row: ChannelAccountRow): ChannelAccount {
  const transportStatus = [
    'connecting',
    'reconnecting',
    'connected',
    'error',
  ].includes(row.transport_status || row.status)
    ? ((row.transport_status ||
        row.status) as ChannelAccount['transport_status'])
    : 'disconnected';
  const authMode = ['bot_token', 'qr_session'].includes(row.auth_mode)
    ? (row.auth_mode as ChannelAccount['auth_mode'])
    : 'credentials';
  const authStatus = [
    'awaiting_scan',
    'authorized',
    'revoked',
    'error',
  ].includes(row.auth_status)
    ? (row.auth_status as ChannelAccount['auth_status'])
    : 'draft';
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    provider: row.provider as ChannelProvider,
    name: row.name,
    secret_ref: row.secret_ref,
    enabled: row.enabled === 1,
    is_default: row.is_default === 1,
    is_legacy_default: row.is_legacy_default === 1,
    auth_mode: authMode,
    auth_status: authStatus,
    transport_status: transportStatus,
    status: transportStatus,
    default_agent_profile_id: row.default_agent_profile_id,
    default_workspace_jid: row.default_workspace_jid,
    last_error: row.last_error,
    connected_at: row.connected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createChannelAccount(input: {
  id?: string;
  owner_user_id: string;
  provider: ChannelProvider;
  name: string;
  secret_ref: string;
  enabled?: boolean;
  is_default?: boolean;
  is_legacy_default?: boolean;
  auth_mode?: ChannelAccount['auth_mode'];
  auth_status?: ChannelAccount['auth_status'];
  default_agent_profile_id?: string | null;
  default_workspace_jid?: string | null;
}): ChannelAccount {
  return db.transaction(() => {
    const id = input.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const wantsDefault = input.is_default === true;
    const existingCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM channel_accounts WHERE owner_user_id = ? AND provider = ?',
      )
      .get(input.owner_user_id, input.provider) as { count: number };
    const isDefault = wantsDefault || existingCount.count === 0;
    if (isDefault) {
      db.prepare(
        'UPDATE channel_accounts SET is_default = 0, updated_at = ? WHERE owner_user_id = ? AND provider = ?',
      ).run(now, input.owner_user_id, input.provider);
    }
    db.prepare(
      `INSERT INTO channel_accounts (
        id, owner_user_id, provider, name, secret_ref, enabled, is_default, is_legacy_default,
        auth_mode, auth_status, transport_status, status, default_agent_profile_id, default_workspace_jid,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', 'disconnected', ?, ?, ?, ?)`,
    ).run(
      id,
      input.owner_user_id,
      input.provider,
      input.name.trim(),
      input.secret_ref,
      input.enabled === false ? 0 : 1,
      isDefault ? 1 : 0,
      input.is_legacy_default === true ? 1 : 0,
      input.auth_mode ?? 'credentials',
      input.auth_status ?? 'draft',
      input.default_agent_profile_id ?? null,
      input.default_workspace_jid ?? null,
      now,
      now,
    );
    return getChannelAccount(id)!;
  })();
}

export function getChannelAccount(id: string): ChannelAccount | undefined {
  const row = db
    .prepare('SELECT * FROM channel_accounts WHERE id = ?')
    .get(id) as ChannelAccountRow | undefined;
  return row ? parseChannelAccountRow(row) : undefined;
}

export function getChannelAccountForUser(
  id: string,
  ownerUserId: string,
): ChannelAccount | undefined {
  const row = db
    .prepare(
      'SELECT * FROM channel_accounts WHERE id = ? AND owner_user_id = ?',
    )
    .get(id, ownerUserId) as ChannelAccountRow | undefined;
  return row ? parseChannelAccountRow(row) : undefined;
}

export function getDefaultChannelAccount(
  ownerUserId: string,
  provider: ChannelProvider,
): ChannelAccount | undefined {
  const row = db
    .prepare(
      'SELECT * FROM channel_accounts WHERE owner_user_id = ? AND provider = ? ORDER BY is_default DESC, created_at ASC LIMIT 1',
    )
    .get(ownerUserId, provider) as ChannelAccountRow | undefined;
  return row ? parseChannelAccountRow(row) : undefined;
}

/** The account that owns historical unscoped JIDs, independent of UI default. */
export function getLegacyChannelAccount(
  ownerUserId: string,
  provider: ChannelProvider,
): ChannelAccount | undefined {
  const row = db
    .prepare(
      'SELECT * FROM channel_accounts WHERE owner_user_id = ? AND provider = ? AND is_legacy_default = 1 ORDER BY created_at ASC LIMIT 1',
    )
    .get(ownerUserId, provider) as ChannelAccountRow | undefined;
  return row ? parseChannelAccountRow(row) : undefined;
}

export function listChannelAccountsForUser(
  ownerUserId: string,
): ChannelAccount[] {
  const rows = db
    .prepare(
      'SELECT * FROM channel_accounts WHERE owner_user_id = ? ORDER BY provider, is_default DESC, created_at ASC',
    )
    .all(ownerUserId) as ChannelAccountRow[];
  return rows.map(parseChannelAccountRow);
}

export function listEnabledChannelAccounts(): ChannelAccount[] {
  return (
    db
      .prepare(
        'SELECT * FROM channel_accounts WHERE enabled = 1 ORDER BY owner_user_id, provider, created_at',
      )
      .all() as ChannelAccountRow[]
  ).map(parseChannelAccountRow);
}

export function updateChannelAccount(
  id: string,
  ownerUserId: string,
  patch: Partial<
    Pick<
      ChannelAccount,
      | 'name'
      | 'enabled'
      | 'is_default'
      | 'default_agent_profile_id'
      | 'default_workspace_jid'
    >
  >,
): ChannelAccount | undefined {
  return db.transaction(() => {
    const current = getChannelAccountForUser(id, ownerUserId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    if (patch.is_default === true) {
      db.prepare(
        'UPDATE channel_accounts SET is_default = 0, updated_at = ? WHERE owner_user_id = ? AND provider = ? AND id != ?',
      ).run(now, ownerUserId, current.provider, id);
    }
    db.prepare(
      `UPDATE channel_accounts SET
        name = ?, enabled = ?, is_default = ?, default_agent_profile_id = ?,
        default_workspace_jid = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ?`,
    ).run(
      patch.name?.trim() ?? current.name,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      (patch.is_default ?? current.is_default) ? 1 : 0,
      patch.default_agent_profile_id === undefined
        ? current.default_agent_profile_id
        : patch.default_agent_profile_id,
      patch.default_workspace_jid === undefined
        ? current.default_workspace_jid
        : patch.default_workspace_jid,
      now,
      id,
      ownerUserId,
    );
    if (current.is_default && patch.is_default === false) {
      const replacement = db
        .prepare(
          'SELECT id FROM channel_accounts WHERE owner_user_id = ? AND provider = ? AND id != ? ORDER BY created_at ASC LIMIT 1',
        )
        .get(ownerUserId, current.provider, id) as { id: string } | undefined;
      if (replacement) {
        db.prepare(
          'UPDATE channel_accounts SET is_default = 1, updated_at = ? WHERE id = ?',
        ).run(now, replacement.id);
      } else {
        db.prepare(
          'UPDATE channel_accounts SET is_default = 1, updated_at = ? WHERE id = ?',
        ).run(now, id);
      }
    }
    return getChannelAccountForUser(id, ownerUserId);
  })();
}

export function updateChannelAccountStatus(
  id: string,
  status: ChannelAccount['status'],
  error?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE channel_accounts SET
       transport_status = ?, status = ?, last_error = ?,
       connected_at = CASE
         WHEN ? = 'connected' THEN ?
         WHEN ? = 'reconnecting' THEN connected_at
         ELSE NULL
       END,
       updated_at = ?
     WHERE id = ?`,
  ).run(status, status, error ?? null, status, now, status, now, id);
}

export function updateChannelAccountAuthStatus(
  id: string,
  authStatus: ChannelAccount['auth_status'],
  error?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE channel_accounts SET auth_status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(authStatus, error ?? null, now, id);
}

export function countChannelAccountBindings(id: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
        SELECT jid AS key FROM registered_groups WHERE channel_account_id = ?
        UNION SELECT channel_jid AS key FROM channel_mounts WHERE channel_account_id = ?
        UNION SELECT channel_jid AS key FROM agent_channel_mounts WHERE channel_account_id = ?
      )`,
    )
    .get(id, id, id) as { count: number };
  return row.count;
}

export function deleteChannelAccount(id: string, ownerUserId: string): boolean {
  return db.transaction(() => {
    const current = getChannelAccountForUser(id, ownerUserId);
    if (!current) return false;
    const result = db
      .prepare(
        'DELETE FROM channel_accounts WHERE id = ? AND owner_user_id = ?',
      )
      .run(id, ownerUserId);
    if (result.changes > 0 && current.is_default) {
      const replacement = db
        .prepare(
          'SELECT id FROM channel_accounts WHERE owner_user_id = ? AND provider = ? ORDER BY created_at ASC LIMIT 1',
        )
        .get(ownerUserId, current.provider) as { id: string } | undefined;
      if (replacement) {
        db.prepare(
          'UPDATE channel_accounts SET is_default = 1, updated_at = ? WHERE id = ?',
        ).run(new Date().toISOString(), replacement.id);
      }
    }
    return result.changes > 0;
  })();
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (group.containerConfigError) {
    throw new Error(
      `Refusing to persist group with invalid container config: ${group.containerConfigError}`,
    );
  }
  const parsedContainerConfig = parseContainerConfig(group.containerConfig);
  if (parsedContainerConfig.error) {
    throw new Error(
      `Invalid container config for group "${jid}": ${parsedContainerConfig.error}`,
    );
  }

  db.transaction(() => {
    const existing = getRegisteredGroup(jid);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at, avatar_url, container_config, execution_mode, custom_cwd, init_source_path, init_git_url, created_by, channel_account_id, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, audience_mode, owner_im_id, owner_claim_source, mcp_mode, selected_mcps, conversation_source, conversation_nav_mode, binding_mode, native_context_type, feishu_chat_mode, feishu_group_message_type, sender_allowlist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         folder = excluded.folder,
         added_at = excluded.added_at,
         avatar_url = COALESCE(excluded.avatar_url, registered_groups.avatar_url),
         container_config = excluded.container_config,
         execution_mode = excluded.execution_mode,
         custom_cwd = excluded.custom_cwd,
         init_source_path = excluded.init_source_path,
         init_git_url = excluded.init_git_url,
         created_by = excluded.created_by,
         channel_account_id = excluded.channel_account_id,
         is_home = excluded.is_home,
         selected_skills = excluded.selected_skills,
         target_agent_id = excluded.target_agent_id,
         target_main_jid = excluded.target_main_jid,
         reply_policy = excluded.reply_policy,
         require_mention = excluded.require_mention,
         activation_mode = excluded.activation_mode,
         audience_mode = excluded.audience_mode,
         owner_im_id = excluded.owner_im_id,
         owner_claim_source = excluded.owner_claim_source,
         mcp_mode = excluded.mcp_mode,
         selected_mcps = excluded.selected_mcps,
         conversation_source = excluded.conversation_source,
         conversation_nav_mode = excluded.conversation_nav_mode,
         binding_mode = excluded.binding_mode,
         native_context_type = excluded.native_context_type,
         feishu_chat_mode = excluded.feishu_chat_mode,
         feishu_group_message_type = excluded.feishu_group_message_type,
         sender_allowlist = excluded.sender_allowlist`,
    ).run(
      jid,
      group.name,
      group.folder,
      group.added_at,
      group.avatar_url ?? null,
      parsedContainerConfig.config
        ? JSON.stringify(parsedContainerConfig.config)
        : null,
      group.executionMode ?? 'container',
      group.customCwd ?? null,
      group.initSourcePath ?? null,
      group.initGitUrl ?? null,
      group.created_by ?? null,
      group.channel_account_id ?? null,
      group.is_home ? 1 : 0,
      null, // selected_skills: deprecated, always null (user-level skills apply globally)
      group.target_agent_id ?? null,
      group.target_main_jid ?? null,
      group.reply_policy ?? 'source_only',
      group.require_mention === true ? 1 : 0,
      group.activation_mode ?? 'auto',
      parseAudienceMode(group.audience_mode),
      group.owner_im_id ?? null,
      group.owner_claim_source ?? null,
      'inherit', // mcp_mode: deprecated, always inherit (user-level MCP applies globally)
      null, // selected_mcps: deprecated, always null
      group.conversation_source ?? 'manual',
      group.conversation_nav_mode ?? 'horizontal',
      group.binding_mode ?? 'single_context',
      group.native_context_type ?? 'none',
      group.feishu_chat_mode ?? null,
      group.feishu_group_message_type ?? null,
      group.sender_allowlist != null
        ? JSON.stringify(group.sender_allowlist)
        : null,
    );
    syncWorkspaceFromRegisteredGroup(jid, group);
    syncChannelMountFromRegisteredGroup(jid, group);
    if (jid.startsWith('web:')) {
      if (existing?.folder && existing.folder !== group.folder) {
        syncWorkspaceRuntimeSessionsForFolder(existing.folder);
      }
      syncWorkspaceRuntimeSessionsForFolder(group.folder);
      syncAgentChannelMountsForWorkspaceJid(jid);
    }
  })();
}

/**
 * Refresh the provider-hosted avatar for an already registered external chat.
 * Discovery invokes onNewChat first, so a missing row means the chat was not
 * admitted and must not be created as a side effect of avatar synchronization.
 */
export function updateRegisteredGroupAvatar(
  jid: string,
  avatarUrl: string,
): boolean {
  const normalized = avatarUrl.trim();
  if (!normalized) return false;
  const result = db
    .prepare(
      `UPDATE registered_groups
       SET avatar_url = ?
       WHERE jid = ? AND COALESCE(avatar_url, '') <> ?`,
    )
    .run(normalized, jid, normalized);
  return result.changes > 0;
}

export function deleteRegisteredGroup(jid: string): void {
  db.transaction(() => {
    const existing = getRegisteredGroup(jid);
    deleteChannelMount(jid);
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    if (jid.startsWith('web:')) {
      db.prepare(
        `UPDATE registered_groups
         SET target_main_jid = NULL, binding_mode = 'single_context'
         WHERE target_main_jid = ? OR target_main_jid = ?`,
      ).run(jid, existing?.folder ? `web:${existing.folder}` : jid);
      deleteWorkspaceMirror(jid, existing?.folder);
      if (existing?.folder && !getWorkspaceJidForFolder(existing.folder)) {
        db.prepare(
          'DELETE FROM workspace_agent_profiles WHERE group_folder = ?',
        ).run(existing.folder);
      }
    }
  })();
}

/**
 * Find Feishu groups that still need owner learning: either their allowlist is
 * the empty-array "owner-locked trap", or owner_im_id was never populated.
 */
export function findEmptyAllowlistFeishuGroupsForUser(
  userId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT jid FROM registered_groups
       WHERE created_by = ? AND jid LIKE 'feishu:%'
         AND COALESCE(owner_claim_source, '') <> 'transfer_reset'
         AND (sender_allowlist = '[]' OR owner_im_id IS NULL OR owner_im_id = '')`,
    )
    .all(userId) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/**
 * Persist the owner learned from a trusted Feishu P2P DM and replace an empty
 * allowlist with that owner. Existing non-empty owner/allowlist values are not
 * overwritten. Returns all changed JIDs so the caller can refresh its cache.
 */
export function backfillEmptyAllowlistsForUser(
  userId: string,
  ownerOpenId: string,
): string[] {
  const jids = findEmptyAllowlistFeishuGroupsForUser(userId);
  return persistLearnedFeishuOwner(jids, ownerOpenId);
}

/**
 * Persist owner learning through the canonical group writer so the legacy
 * group row and both channel-mount projections change together.
 */
function persistLearnedFeishuOwner(
  jids: string[],
  ownerOpenId: string,
): string[] {
  const normalizedOwner = ownerOpenId.trim();
  if (!normalizedOwner) return [];
  const changed: string[] = [];
  for (const jid of jids) {
    const group = getRegisteredGroup(jid);
    if (!group || group.owner_claim_source === 'transfer_reset') continue;
    const ownerMissing = !group.owner_im_id?.trim();
    const emptyAllowlist =
      Array.isArray(group.sender_allowlist) &&
      group.sender_allowlist.length === 0;
    if (!ownerMissing && !emptyAllowlist) continue;
    setRegisteredGroup(jid, {
      ...group,
      ...(ownerMissing
        ? {
            owner_im_id: normalizedOwner,
            owner_claim_source: 'auto_feishu' as const,
          }
        : {}),
      ...(emptyAllowlist ? { sender_allowlist: [normalizedOwner] } : {}),
    });
    changed.push(jid);
  }
  return changed;
}

/** Account-scoped counterpart used by first-class Feishu bots. */
export function backfillEmptyAllowlistsForChannelAccount(
  userId: string,
  channelAccountId: string,
  ownerOpenId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT jid FROM registered_groups
       WHERE created_by = ? AND channel_account_id = ?
         AND jid LIKE 'feishu:%'
         AND COALESCE(owner_claim_source, '') <> 'transfer_reset'
         AND (sender_allowlist = '[]' OR owner_im_id IS NULL OR owner_im_id = '')`,
    )
    .all(userId, channelAccountId) as Array<{ jid: string }>;
  if (!rows.length) return [];
  return persistLearnedFeishuOwner(
    rows.map((row) => row.jid),
    ownerOpenId,
  );
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

type ChannelMountRow = {
  channel_jid: string;
  channel_account_id: string | null;
  channel_type: string;
  workspace_jid: string;
  session_id: string | null;
  routing_mode: string | null;
  reply_policy: string | null;
  activation_mode: string | null;
  audience_mode: string | null;
  owner_im_id: string | null;
  created_at: string;
  updated_at: string;
};

function parseChannelMountRow(row: ChannelMountRow): ChannelMount {
  return {
    channel_jid: row.channel_jid,
    channel_account_id: row.channel_account_id,
    channel_type: row.channel_type,
    workspace_jid: row.workspace_jid,
    session_id: row.session_id,
    routing_mode:
      row.routing_mode === 'thread_map' ? 'thread_map' : 'single_session',
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    activation_mode: parseActivationMode(row.activation_mode),
    audience_mode: parseAudienceMode(row.audience_mode),
    owner_im_id: row.owner_im_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function resolveWorkspaceJidForMount(targetMainJid?: string): string | null {
  if (!targetMainJid) return null;
  const exists = db
    .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
    .get(targetMainJid);
  if (exists) return targetMainJid;
  if (!targetMainJid.startsWith('web:')) return null;
  const folder = targetMainJid.slice(4);
  const row = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%' ORDER BY is_home DESC, added_at ASC LIMIT 1",
    )
    .get(folder) as { jid: string } | undefined;
  return row?.jid ?? null;
}

function channelMountFromRegisteredGroup(
  channelJid: string,
  group: RegisteredGroup,
): Omit<ChannelMount, 'created_at' | 'updated_at'> | null {
  const channelType = getChannelFromJid(channelJid);
  if (channelType === 'web') return null;

  if (group.target_agent_id) {
    const agent = getAgent(group.target_agent_id);
    if (!agent?.chat_jid) return null;
    return {
      channel_jid: channelJid,
      channel_account_id: group.channel_account_id ?? null,
      channel_type: channelType,
      workspace_jid: agent.chat_jid,
      session_id: group.target_agent_id,
      routing_mode: 'single_session',
      reply_policy: group.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      activation_mode: group.activation_mode ?? 'auto',
      audience_mode: parseAudienceMode(group.audience_mode),
      owner_im_id: group.owner_im_id ?? null,
    };
  }

  if (group.target_main_jid) {
    const workspaceJid = resolveWorkspaceJidForMount(group.target_main_jid);
    if (!workspaceJid) return null;
    return {
      channel_jid: channelJid,
      channel_account_id: group.channel_account_id ?? null,
      channel_type: channelType,
      workspace_jid: workspaceJid,
      session_id: null,
      routing_mode:
        group.binding_mode === 'thread_map' ? 'thread_map' : 'single_session',
      reply_policy: group.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      activation_mode: group.activation_mode ?? 'auto',
      audience_mode: parseAudienceMode(group.audience_mode),
      owner_im_id: group.owner_im_id ?? null,
    };
  }

  return null;
}

export function upsertChannelMount(
  mount: Omit<ChannelMount, 'created_at' | 'updated_at'> &
    Partial<Pick<ChannelMount, 'created_at' | 'updated_at'>>,
): ChannelMount {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const existing = getChannelMount(mount.channel_jid);
    const createdAt = mount.created_at ?? existing?.created_at ?? now;
    const updatedAt = mount.updated_at ?? now;
    db.prepare(
      `INSERT INTO channel_mounts (
        channel_jid, channel_account_id, channel_type, workspace_jid, session_id, routing_mode,
        reply_policy, activation_mode, audience_mode, owner_im_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_jid) DO UPDATE SET
        channel_account_id = excluded.channel_account_id,
        channel_type = excluded.channel_type,
        workspace_jid = excluded.workspace_jid,
        session_id = excluded.session_id,
        routing_mode = excluded.routing_mode,
        reply_policy = excluded.reply_policy,
        activation_mode = excluded.activation_mode,
        audience_mode = excluded.audience_mode,
        owner_im_id = excluded.owner_im_id,
        updated_at = excluded.updated_at`,
    ).run(
      mount.channel_jid,
      mount.channel_account_id ?? null,
      mount.channel_type,
      mount.workspace_jid,
      mount.session_id ?? null,
      mount.routing_mode,
      mount.reply_policy,
      mount.activation_mode,
      mount.audience_mode ?? 'everyone',
      mount.owner_im_id ?? null,
      createdAt,
      updatedAt,
    );
    const saved = getChannelMount(mount.channel_jid)!;
    syncAgentChannelMountFromMount(saved);
    return saved;
  })();
}

export function deleteChannelMount(channelJid: string): void {
  if (!db) return;
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM channel_mounts WHERE channel_jid = ?').run(
        channelJid,
      );
      db.prepare('DELETE FROM agent_channel_mounts WHERE channel_jid = ?').run(
        channelJid,
      );
    })();
  } catch {
    // Startup can call legacy group deletion paths before a pre-v42 DB has
    // created channel_mounts. The next init pass will create and backfill it.
  }
}

export function getChannelMount(channelJid: string): ChannelMount | undefined {
  const row = db
    .prepare('SELECT * FROM channel_mounts WHERE channel_jid = ?')
    .get(channelJid) as ChannelMountRow | undefined;
  return row ? parseChannelMountRow(row) : undefined;
}

export function listChannelMounts(): ChannelMount[] {
  const rows = db
    .prepare('SELECT * FROM channel_mounts ORDER BY updated_at DESC')
    .all() as ChannelMountRow[];
  return rows.map(parseChannelMountRow);
}

export function listChannelMountsByWorkspace(
  workspaceJid: string,
): ChannelMount[] {
  const rows = db
    .prepare(
      'SELECT * FROM channel_mounts WHERE workspace_jid = ? ORDER BY updated_at DESC',
    )
    .all(workspaceJid) as ChannelMountRow[];
  return rows.map(parseChannelMountRow);
}

export function listChannelMountsBySession(sessionId: string): ChannelMount[] {
  const rows = db
    .prepare(
      'SELECT * FROM channel_mounts WHERE session_id = ? ORDER BY updated_at DESC',
    )
    .all(sessionId) as ChannelMountRow[];
  return rows.map(parseChannelMountRow);
}

export function syncChannelMountFromRegisteredGroup(
  channelJid: string,
  group: RegisteredGroup,
): void {
  if (getChannelFromJid(channelJid) === 'web') {
    deleteChannelMount(channelJid);
    return;
  }
  const mount = channelMountFromRegisteredGroup(channelJid, group);
  if (!mount) {
    deleteChannelMount(channelJid);
    return;
  }
  upsertChannelMount(mount);
}

export function syncAllChannelMountsFromRegisteredGroups(): void {
  db.prepare('DELETE FROM channel_mounts').run();
  db.prepare('DELETE FROM agent_channel_mounts').run();
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  for (const row of rows) {
    syncChannelMountFromRegisteredGroup(row.jid, parseGroupRow(row));
  }
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
    .get(sourceJid, contextType, contextId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapImContextBindingRow(row) : undefined;
}

/**
 * Resolve a context whose canonical ID was created before Feishu returned a
 * thread_id. The root message remains stable across root and follow-up events.
 */
export function getImContextBindingByRootMessageId(
  sourceJid: string,
  contextType: 'thread',
  rootMessageId: string,
): ImContextBinding | undefined {
  const row = db
    .prepare(
      `SELECT * FROM im_context_bindings
       WHERE source_jid = ? AND context_type = ? AND root_message_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(sourceJid, contextType, rootMessageId) as
    | Record<string, unknown>
    | undefined;
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

export function listImContextBindingsByAgent(
  agentId: string,
): ImContextBinding[] {
  const rows = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE agent_id = ? ORDER BY last_active_at DESC, created_at DESC',
    )
    .all(agentId) as Record<string, unknown>[];
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

/** List native-thread agent IDs for a workspace JID (legacy Feishu included). */
export function listFeishuThreadAgentIds(workspaceJid: string): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM agents WHERE chat_jid = ? AND source_kind IN ('native_thread', 'feishu_thread')",
    )
    .all(workspaceJid) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Find a user's home group (is_home=1 + created_by=userId).
 */
export function getUserHomeGroup(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare(
      'SELECT * FROM registered_groups WHERE is_home = 1 AND created_by = ?',
    )
    .get(userId) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Ensure a user has a home group. If not, create one.
 * The first admin keeps the legacy web:main home. Every other account gets an
 * owner-specific home workspace. Admin homes use host execution; member homes
 * use container execution.
 * Returns the JID of the home group.
 */
export function ensureUserHomeGroup(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserHomeGroup(userId);
  if (existing) {
    assignWorkspaceAgentProfile(
      existing.folder,
      getOrCreateDefaultAgentProfile(userId).id,
    );
    return existing.jid;
  }

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const existingMain = isAdmin ? getRegisteredGroup('web:main') : undefined;
  const useLegacyMain = isAdmin && (!existingMain || !existingMain.created_by);
  const jid = useLegacyMain ? 'web:main' : `web:home-${userId}`;
  const folder = useLegacyMain ? 'main' : `home-${userId}`;

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
  assignWorkspaceAgentProfile(
    folder,
    getOrCreateDefaultAgentProfile(userId).id,
  );

  // Ensure chat row exists
  ensureChatExists(jid);

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
 * Clear all knowledge owned by a retained workspace during a content rebuild.
 * The generic Memory lineage and the hidden Home Owner Profile lifecycle are
 * reset atomically, while the workspace identity/configuration remains intact.
 */
export function resetWorkspaceKnowledgeForRebuild(workspaceJid: string): void {
  db.transaction(() => {
    const workspace = db
      .prepare('SELECT is_home FROM workspaces WHERE jid = ?')
      .get(workspaceJid) as { is_home: number } | undefined;
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceJid}`);
    }

    resetWorkspaceMemoryData(workspaceJid);
    db.prepare(
      `DELETE FROM workspace_onboarding_states
       WHERE workspace_jid = ? AND flow_key = ?`,
    ).run(workspaceJid, HAPPYCLAW_OWNER_INTRODUCTION_FLOW_KEY);

    if (workspace.is_home === 1) {
      const at = new Date().toISOString();
      db.prepare(
        `INSERT INTO workspace_onboarding_states (
          workspace_jid, flow_key, state, revision, lease_owner, lease_token,
          lease_expires_at, first_wake_at, completed_at, skipped_at,
          created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(workspaceJid, HAPPYCLAW_OWNER_INTRODUCTION_FLOW_KEY, at, at);
    }
  })();
}

export class WorkspaceRebuildPersistentStateError extends Error {
  constructor(
    public readonly code: 'workspace_missing' | 'active_task_runs',
    message: string,
    public readonly activeRunIds: string[] = [],
  ) {
    super(message);
    this.name = 'WorkspaceRebuildPersistentStateError';
  }
}

export interface WorkspaceRebuildPersistentStateResult {
  deletedAgentIds: string[];
  recycledTaskIds: string[];
}

/**
 * Commit every SQLite-owned part of a workspace rebuild as one transaction.
 * Filesystem staging is handled by the route before this call; throwing here
 * leaves all database state untouched so the route can restore staged files.
 */
export function rebuildWorkspacePersistentState(input: {
  groupFolder: string;
  workspaceJids: string[];
  siblingJids: string[];
}): WorkspaceRebuildPersistentStateResult {
  return db
    .transaction((): WorkspaceRebuildPersistentStateResult => {
      const workspaceJids = [...new Set(input.workspaceJids)];
      const siblingJids = [...new Set(input.siblingJids)];
      for (const workspaceJid of workspaceJids) {
        const workspace = db
          .prepare('SELECT folder FROM workspaces WHERE jid = ?')
          .get(workspaceJid) as { folder: string } | undefined;
        if (!workspace || workspace.folder !== input.groupFolder) {
          throw new WorkspaceRebuildPersistentStateError(
            'workspace_missing',
            `Workspace changed while rebuilding: ${workspaceJid}`,
          );
        }
      }

      const activeRunIds = (
        db
          .prepare(
            `SELECT tr.id
             FROM task_runs tr
             JOIN scheduled_tasks st ON st.id = tr.task_id
             WHERE st.group_folder = ?
               AND (
                 tr.status IN ('queued','running','retry_wait')
                 OR (
                   tr.status = 'delivered'
                   AND json_valid(tr.definition_snapshot)
                   AND json_extract(
                     tr.definition_snapshot,
                     '$.context_mode'
                   ) = 'group'
                 )
               )
             ORDER BY tr.created_at, tr.id`,
          )
          .all(input.groupFolder) as Array<{ id: string }>
      ).map((row) => row.id);
      if (activeRunIds.length > 0) {
        throw new WorkspaceRebuildPersistentStateError(
          'active_task_runs',
          'Scheduled task runs are still active during workspace rebuild',
          activeRunIds,
        );
      }

      const recycledTaskIds = (
        db
          .prepare(
            `SELECT id FROM scheduled_tasks
             WHERE group_folder = ? AND deleted_at IS NULL
             ORDER BY id`,
          )
          .all(input.groupFolder) as Array<{ id: string }>
      ).map((row) => row.id);
      if (recycledTaskIds.length > 0) {
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE task_run_logs
           SET status = 'error',
               error = COALESCE(error, 'Workspace rebuilt while task was running')
           WHERE status = 'running'
             AND task_id IN (
               SELECT id FROM scheduled_tasks
               WHERE group_folder = ? AND deleted_at IS NULL
             )`,
        ).run(input.groupFolder);
        db.prepare(
          `UPDATE scheduled_tasks
           SET deleted_at = ?, status = 'paused', next_run = NULL,
               running_until = NULL, runner_id = NULL,
               workspace_jid = NULL, workspace_folder = NULL,
               revision = revision + 1, updated_at = ?
           WHERE group_folder = ? AND deleted_at IS NULL`,
        ).run(now, now, input.groupFolder);
      }

      const agents = db
        .prepare(
          `SELECT id, chat_jid FROM agents
             WHERE group_folder = ?
             ORDER BY id`,
        )
        .all(input.groupFolder) as Array<{
        id: string;
        chat_jid: string;
      }>;
      const deletedAgentIds = agents.map((agent) => agent.id);

      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(
        input.groupFolder,
      );
      db.prepare(
        'DELETE FROM workspace_runtime_sessions WHERE group_folder = ?',
      ).run(input.groupFolder);
      db.prepare('DELETE FROM router_state WHERE key = ?').run(
        sessionChannelOwnerKey(input.groupFolder),
      );
      for (const agentId of deletedAgentIds) {
        db.prepare('DELETE FROM router_state WHERE key = ?').run(
          sessionChannelOwnerKey(input.groupFolder, agentId),
        );
      }

      for (const workspaceJid of workspaceJids) {
        resetWorkspaceKnowledgeForRebuild(workspaceJid);
        db.prepare(
          'DELETE FROM im_context_bindings WHERE workspace_jid = ?',
        ).run(workspaceJid);
      }

      for (const siblingJid of siblingJids) {
        db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(siblingJid);
        db.prepare('DELETE FROM chats WHERE jid = ?').run(siblingJid);
      }
      for (const agent of agents) {
        const virtualJid = `${agent.chat_jid}#agent:${agent.id}`;
        db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(virtualJid);
        db.prepare('DELETE FROM chats WHERE jid = ?').run(virtualJid);
      }

      if (deletedAgentIds.length > 0) {
        const placeholders = deletedAgentIds.map(() => '?').join(', ');
        db.prepare(
          `UPDATE registered_groups
           SET target_agent_id = NULL, binding_mode = 'single_context'
           WHERE target_agent_id IN (${placeholders})`,
        ).run(...deletedAgentIds);
        db.prepare(
          `DELETE FROM channel_mounts
           WHERE session_id IN (${placeholders})`,
        ).run(...deletedAgentIds);
        db.prepare(
          `DELETE FROM agent_channel_mounts
           WHERE session_id IN (${placeholders})`,
        ).run(...deletedAgentIds);
        db.prepare(
          `DELETE FROM im_context_bindings
           WHERE agent_id IN (${placeholders})`,
        ).run(...deletedAgentIds);
      }
      db.prepare('DELETE FROM agents WHERE group_folder = ?').run(
        input.groupFolder,
      );

      for (const siblingJid of siblingJids) {
        ensureChatExists(siblingJid);
      }
      return { deletedAgentIds, recycledTaskIds };
    })
    .immediate();
}

/**
 * Delete an IM group's registered_groups entry and all jid-scoped data
 * (messages, chat record, pinned references). Does NOT touch folder-scoped
 * data (sessions, scheduled_tasks) because IM groups typically
 * share their folder with the owner's home workspace.
 *
 * Used when an IM group is detected as dead (bot removed, group disbanded,
 * health-check unreachable, or repeated send failures) and for the manual
 * "delete this IM binding" UI button.
 */
export function deleteImGroupRecord(jid: string): void {
  const tx = db.transaction(() => {
    const conversationJid = channelConversationJid(jid);
    const replyAgents = db
      .prepare(
        'SELECT id, last_im_jid FROM agents WHERE last_im_jid IS NOT NULL',
      )
      .all() as Array<{ id: string; last_im_jid: string }>;
    const clearLastImJid = db.prepare(
      'UPDATE agents SET last_im_jid = NULL WHERE id = ?',
    );
    for (const agent of replyAgents) {
      if (channelConversationJid(agent.last_im_jid) === conversationJid) {
        clearLastImJid.run(agent.id);
      }
    }
    db.prepare('DELETE FROM channel_mounts WHERE channel_jid = ?').run(jid);
    db.prepare('DELETE FROM agent_channel_mounts WHERE channel_jid = ?').run(
      jid,
    );
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM im_context_bindings WHERE source_jid = ?').run(jid);
    // Feishu thread agents (source_kind='feishu_thread') and other chat-scoped
    // agents reference this jid via agents.chat_jid — without this, deleting
    // an IM group leaves orphan agent rows visible in the agents list.
    db.prepare(
      `DELETE FROM workspace_runtime_sessions
       WHERE runtime_agent_id IN (SELECT id FROM agents WHERE chat_jid = ?)`,
    ).run(jid);
    db.prepare(
      `DELETE FROM sessions
       WHERE agent_id IN (SELECT id FROM agents WHERE chat_jid = ?)`,
    ).run(jid);
    db.prepare('DELETE FROM agents WHERE chat_jid = ?').run(jid);
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

export function deleteGroupData(
  jid: string,
  folder: string,
  options: {
    /**
     * Channel reroutes committed atomically with the workspace deletion.
     * Callers update their live routing cache only after this transaction
     * succeeds.
     */
    channelUpdates?: Array<{ jid: string; group: RegisteredGroup }>;
  } = {},
): void {
  const tx = db.transaction(() => {
    const legacyMainJid = `web:${folder}`;
    for (const update of options.channelUpdates ?? []) {
      setRegisteredGroup(update.jid, update.group);
    }
    db.prepare(
      `UPDATE channel_accounts
       SET default_workspace_jid = (
             SELECT home.jid
             FROM registered_groups AS home
             WHERE home.created_by = channel_accounts.owner_user_id
               AND home.is_home = 1
               AND home.jid != ?
             ORDER BY home.added_at ASC
             LIMIT 1
           ),
           updated_at = ?
       WHERE default_workspace_jid = ? OR default_workspace_jid = ?`,
    ).run(jid, new Date().toISOString(), jid, legacyMainJid);
    db.prepare(
      `UPDATE registered_groups
       SET target_main_jid = NULL, binding_mode = 'single_context'
       WHERE target_main_jid = ? OR target_main_jid = ?`,
    ).run(jid, legacyMainJid);
    db.prepare(
      `UPDATE registered_groups
       SET target_agent_id = NULL, binding_mode = 'single_context'
       WHERE target_agent_id IN (
         SELECT id FROM agents WHERE group_folder = ? OR chat_jid = ?
       )`,
    ).run(folder, jid);
    db.prepare('DELETE FROM channel_mounts WHERE workspace_jid = ?').run(jid);
    db.prepare('DELETE FROM agent_channel_mounts WHERE workspace_jid = ?').run(
      jid,
    );
    db.prepare('DELETE FROM im_context_bindings WHERE workspace_jid = ?').run(
      jid,
    );
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除 workspace -> AgentProfile 归属映射
    db.prepare(
      'DELETE FROM workspace_agent_profiles WHERE group_folder = ?',
    ).run(folder);
    // 3b. 删除 canonical workspace/session 镜像
    deleteWorkspaceMemoryData(jid);
    db.prepare('DELETE FROM workspaces WHERE jid = ?').run(jid);
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE group_folder = ?',
    ).run(folder);
    // 4. 删除注册信息
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    // 5. 删除会话与 workspace-owned agents
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    db.prepare('DELETE FROM agents WHERE group_folder = ? OR chat_jid = ?').run(
      folder,
      jid,
    );
    // 6. 删除聊天记录
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM messages WHERE chat_jid LIKE ?').run(
      `${jid}#agent:%`,
    );
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid LIKE ?').run(`${jid}#agent:%`);
    // 7. 删除 pin 记录
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // 8. 清除定时任务的工作区关联（任务本身不删，只断开绑定）
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
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
             delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
             delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
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
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
              delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
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
/**
 * Latest-message preview per chat. Callers previously shared one global
 * top-N window over all requested chats, which a single busy chat exhausts —
 * 13 of 18 production workspaces silently lost their sidebar preview.
 * Partitioning by chat fixes that, and previews deliberately skip the
 * attachments column: it is irrelevant for a preview yet dominated row bytes
 * in production (single rows up to 6.4MB of embedded attachment JSON).
 */
export function getLatestMessagePreviewPerChat(
  chatJids: string[],
): Map<string, { content: string; timestamp: string }> {
  const result = new Map<string, { content: string; timestamp: string }>();
  if (chatJids.length === 0) return result;
  const placeholders = chatJids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT chat_jid, content, timestamp FROM (
         SELECT chat_jid, content, timestamp,
                ROW_NUMBER() OVER (
                  PARTITION BY chat_jid ORDER BY timestamp DESC, id DESC
                ) AS rn
         FROM messages
         WHERE chat_jid IN (${placeholders})
       ) WHERE rn = 1`,
    )
    .all(...chatJids) as Array<{
    chat_jid: string;
    content: unknown;
    timestamp: string;
  }>;
  for (const row of rows) {
    result.set(row.chat_jid, {
      content: toUtf8String(row.content),
      timestamp: row.timestamp,
    });
  }
  return result;
}

export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
              delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
              delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
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
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, channel_context,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason,
              delivery_mode, delivery_status, delivery_run_id, delivery_priority, delivery_updated_at
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
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, channel_context,
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
    .all(userId) as RegisteredGroupRow[];

  return rows.map(parseGroupRow);
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
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    default_require_mention: !!row.default_require_mention,
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
    default_require_mention: user.default_require_mention,
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
  getOrCreateDefaultAgentProfile(user.id);
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
      | 'default_require_mention'
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
  if (updates.default_require_mention !== undefined) {
    fields.push('default_require_mention = ?');
    values.push(updates.default_require_mention ? 1 : 0);
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
  const row = stmts().getSessionWithUser.get(sessionId) as
    | Record<string, unknown>
    | undefined;
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
      getOrCreateDefaultAgentProfile(params.id);

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
    getOrCreateDefaultAgentProfile(input.id);
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

/**
 * Archive conversation/spawn sessions with no activity since the cutoff.
 * Rows stay resolvable (thread bindings keep pointing at them), so a new
 * message in an old topic still revives the same session; archived rows just
 * stop participating in startup recovery, which otherwise grows unboundedly.
 */
export function archiveInactiveConversationAgents(
  beforeTimestamp: string,
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE agents SET status = 'completed', completed_at = ?
       WHERE kind IN ('conversation', 'spawn') AND status IN ('running', 'idle')
         AND COALESCE(last_active_at, created_at) < ?`,
    )
    .run(now, beforeTimestamp);
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
  db.transaction(() => {
    // A product Session can own an SDK runtime resume row and channel mounts;
    // clear all three projections together so direct DB callers cannot leave
    // routable ghosts behind.
    db.prepare(
      `UPDATE registered_groups
       SET target_agent_id = NULL, binding_mode = 'single_context'
       WHERE target_agent_id = ?`,
    ).run(id);
    db.prepare('DELETE FROM channel_mounts WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM agent_channel_mounts WHERE session_id = ?').run(id);
    db.prepare(
      'DELETE FROM workspace_runtime_sessions WHERE runtime_agent_id = ?',
    ).run(id);
    db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(id);
    deleteImContextBindingsByAgent(id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  })();
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
    last_im_jid: typeof row.last_im_jid === 'string' ? row.last_im_jid : null,
    spawned_from_jid:
      typeof row.spawned_from_jid === 'string' ? row.spawned_from_jid : null,
    source_kind:
      typeof row.source_kind === 'string'
        ? (row.source_kind as
            | 'manual'
            | 'native_thread'
            | 'feishu_thread'
            | 'auto_im')
        : null,
    thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title_source:
      typeof row.title_source === 'string'
        ? (row.title_source as
            | 'manual'
            | 'native_root'
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

/** Read the host-persisted human input used to authorize Agent Builder calls. */
export function getAgentBuilderInputMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  content: string;
  sender: string | null;
  source_jid: string | null;
  is_from_me: number;
  source_kind: string | null;
  task_id: string | null;
} | null {
  const row = db
    .prepare(
      `SELECT id, chat_jid, content, sender, source_jid, is_from_me, source_kind, task_id
       FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        content: unknown;
        sender: string | null;
        source_jid: string | null;
        is_from_me: number;
        source_kind: string | null;
        task_id: string | null;
      }
    | undefined;
  return row
    ? {
        ...row,
        content: toUtf8String(row.content),
      }
    : null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
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
      db.prepare('UPDATE billing_plans SET is_default = 0 WHERE id != ?').run(
        id,
      );
    }
    db.prepare(
      `UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  })();
}

export function deleteBillingPlan(id: string): boolean {
  // Don't delete if any subscription (any status) references this plan.
  // PRAGMA foreign_keys=ON 会因 cancelled/expired 残留行让 DELETE 抛
  // SQLITE_CONSTRAINT_FOREIGNKEY 把请求 500；先在应用层校验给 caller 一个
  // 干净的 false 返回，运维需要手动迁移残留订阅再删 plan。
  const hasReferences = db
    .prepare('SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ?')
    .get(id) as { cnt: number };
  if (hasReferences.cnt > 0) return false;
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
    trial_days: row.trial_days != null ? Number(row.trial_days) : null,
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
  // Wrap in a transaction so partial failure can't leave the user without an
  // active subscription (cancel succeeded, insert/update failed). Same shape
  // as expireSubscriptions / batchAssignPlan elsewhere in this file.
  const txn = db.transaction(() => {
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
  });
  txn();
}

export function cancelUserSubscription(userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(now, userId);
  db.prepare('UPDATE users SET subscription_plan_id = NULL WHERE id = ?').run(
    userId,
  );
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
        newSub.id,
        newSub.user_id,
        newSub.plan_id,
        newSub.status,
        newSub.started_at,
        newSub.expires_at,
        newSub.cancelled_at,
        newSub.trial_ends_at,
        newSub.notes,
        newSub.auto_renew,
        newSub.created_at,
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
      .prepare('SELECT * FROM balance_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: Number(existing.id),
        user_id: String(existing.user_id),
        type: String(existing.type) as BalanceTransactionType,
        amount_usd: Number(existing.amount_usd),
        balance_after: Number(existing.balance_after),
        description:
          typeof existing.description === 'string'
            ? existing.description
            : null,
        reference_type:
          typeof existing.reference_type === 'string'
            ? (existing.reference_type as BalanceReferenceType)
            : null,
        reference_id:
          typeof existing.reference_id === 'string'
            ? existing.reference_id
            : null,
        actor_id:
          typeof existing.actor_id === 'string' ? existing.actor_id : null,
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
    const result = db
      .prepare(
        `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      reference_type:
        typeof r.reference_type === 'string'
          ? (r.reference_type as BalanceReferenceType)
          : null,
      reference_id: typeof r.reference_id === 'string' ? r.reference_id : null,
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
    .prepare('SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?')
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

/**
 * Atomic monthly+daily usage increment. Wraps the two UPSERTs in a single
 * SQLite transaction so a crash between them can't leave the two tables
 * divergent for that turn (silent drift over time). billing.ts uses this
 * instead of calling the two helpers in sequence.
 */
export function incrementUsageBoth(
  userId: string,
  month: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const txn = db.transaction(() => {
    incrementMonthlyUsage(userId, month, inputTokens, outputTokens, costUsd);
    incrementDailyUsage(userId, date, inputTokens, outputTokens, costUsd);
  });
  txn();
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
  const row = db
    .prepare('SELECT * FROM redeem_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
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
  const result = db
    .prepare('DELETE FROM redeem_codes WHERE code = ?')
    .run(code);
  return result.changes > 0;
}

export function hasUserRedeemedCode(userId: string, code: string): boolean {
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
    duration_days: row.duration_days != null ? Number(row.duration_days) : null,
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
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
      // 防御性 parse：单行损坏不应让整个审计 API 500（事故排查的关键时刻
      // 不能因一行坏数据看不到日志）。parseJsonDetails 出错时返回 null。
      details: parseJsonDetails(r.details),
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

export function getWeeklyUsageSummary(userId: string): {
  totalCost: number;
  totalTokens: number;
} {
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
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  messageCount: number;
} {
  const startDate = `${month}-01`;
  // End date: first day of next month
  const [y, m] = month.split('-').map(Number);
  const nextMonth =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
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
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE status != 'deleted'")
      .get() as { cnt: number }
  ).cnt;

  const activeUsers = (
    db
      .prepare(
        'SELECT COUNT(DISTINCT user_id) as cnt FROM daily_usage WHERE date = ?',
      )
      .get(today) as { cnt: number }
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
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM daily_usage WHERE date = ?',
      )
      .get(today) as { total: number }
  ).total;

  const monthCost = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;

  const activeSubscriptions = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
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
      ).run(
        subId,
        userId,
        planId,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      );

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
  bindChannelReliabilityDatabase(null);
  bindWorkspaceMemoryDatabase(null);
  bindOwnerProfileDatabase(null);
  if (db) {
    db.close();
  }
}
