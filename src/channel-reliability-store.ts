import crypto from 'node:crypto';

/**
 * Durable channel delivery primitives.
 *
 * This module deliberately owns only persistence and fencing. Provider I/O,
 * routing decisions and retry policy remain in the channel/runtime layers.
 * Keeping that boundary narrow makes the same inbox/run/outbox model usable
 * by Feishu, QQ, WeChat and future transports.
 */

interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
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

export type ChannelInboxStatus =
  | 'received'
  | 'admitted'
  | 'queued'
  | 'processing'
  | 'processed'
  | 'ignored'
  | 'failed';

export type ChannelTurnRunStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'waiting_user'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type ChannelOutboxKind = 'text' | 'image' | 'file' | 'card' | 'mutation';

export type ChannelOutboxStatus =
  | 'pending'
  | 'claimed'
  | 'retry_wait'
  | 'uploading'
  | 'uploaded'
  | 'sending'
  | 'delivered'
  | 'uncertain'
  | 'failed'
  | 'cancelled';

export type StreamingCardStatus =
  | 'creating'
  | 'streaming'
  | 'recovering'
  | 'completed'
  | 'aborted'
  | 'failed';

export interface ChannelRouteSnapshot {
  provider: string;
  accountId: string;
  sourceJid: string;
  chatId?: string | null;
  rootId?: string | null;
  threadId?: string | null;
}

export interface ChannelInboxItem extends ChannelRouteSnapshot {
  id: string;
  externalMessageId: string;
  status: ChannelInboxStatus;
  rawPayload: unknown | null;
  normalizedPayload: unknown | null;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ClaimedChannelInboxItem extends ChannelInboxItem {
  status: 'processing';
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface ChannelTurnRun extends ChannelRouteSnapshot {
  id: string;
  inboxId: string | null;
  idempotencyKey: string;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  status: ChannelTurnRunStatus;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attempt: number;
  revision: number;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ClaimedChannelTurnRun extends ChannelTurnRun {
  status: 'running';
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface ChannelOutboxItem extends ChannelRouteSnapshot {
  id: string;
  turnRunId: string;
  ordinal: number;
  kind: ChannelOutboxKind;
  idempotencyKey: string;
  payload: unknown | null;
  payloadHash: string;
  status: ChannelOutboxStatus;
  providerMessageId: string | null;
  providerUploadKey: string | null;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  attempt: number;
  revision: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface ClaimedChannelOutboxItem extends ChannelOutboxItem {
  status: 'claimed';
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface StreamingCardRecord extends ChannelRouteSnapshot {
  id: string;
  turnRunId: string;
  messageId: string | null;
  cardId: string | null;
  version: number;
  snapshot: unknown | null;
  status: StreamingCardStatus;
  revision: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ChannelCursor {
  provider: string;
  accountId: string;
  scope: string;
  chatId: string | null;
  cursor: string;
  position: number;
  tieBreaker: string;
  createdAt: string;
  updatedAt: string;
}

const INBOX_TERMINAL: readonly ChannelInboxStatus[] = [
  'processed',
  'ignored',
  'failed',
];
const TURN_TERMINAL: readonly ChannelTurnRunStatus[] = [
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];
const OUTBOX_TERMINAL: readonly ChannelOutboxStatus[] = [
  'delivered',
  'failed',
  'cancelled',
];
const CARD_TERMINAL: readonly StreamingCardStatus[] = [
  'completed',
  'aborted',
  'failed',
];

function requireDatabase(): SqliteDatabase {
  if (!database) {
    throw new Error('Channel reliability store is not initialized');
  }
  return database;
}

function isoNow(now?: Date | string): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}

function addMilliseconds(nowIso: string, milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error('leaseMs must be a positive finite number');
  }
  return new Date(new Date(nowIso).getTime() + milliseconds).toISOString();
}

function normalizeRoute(route: ChannelRouteSnapshot): ChannelRouteSnapshot {
  const provider = route.provider.trim();
  const accountId = route.accountId.trim();
  const sourceJid = route.sourceJid.trim();
  if (!provider || !accountId || !sourceJid) {
    throw new Error('provider, accountId and sourceJid are required');
  }
  return {
    provider,
    accountId,
    sourceJid,
    chatId: route.chatId?.trim() || null,
    rootId: route.rootId?.trim() || null,
    threadId: route.threadId?.trim() || null,
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJsonValue(item)]),
    );
  }
  return value;
}

function stringifyPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const encoded = JSON.stringify(stableJsonValue(value));
  if (encoded === undefined) {
    throw new Error('Payload must be JSON serializable');
  }
  return encoded;
}

function parsePayload(value: unknown): unknown | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Stable SHA-256 used by outbox idempotency and audit tooling. */
export function channelPayloadHash(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(stringifyPayload(payload) ?? 'null')
    .digest('hex');
}

export function createChannelReliabilitySchema(
  connection: SqliteDatabase,
): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS channel_inbox (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      raw_payload TEXT,
      normalized_payload TEXT,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(provider, account_id, external_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_inbox_nonterminal
      ON channel_inbox(status, available_at, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_inbox_route
      ON channel_inbox(provider, account_id, source_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_cursors (
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL,
      position INTEGER NOT NULL,
      tie_breaker TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, account_id, scope, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_cursors_account
      ON channel_cursors(provider, account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS turn_runs (
      id TEXT PRIMARY KEY,
      inbox_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      agent_id TEXT,
      session_id TEXT,
      correlation_id TEXT,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (inbox_id) REFERENCES channel_inbox(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_runs_inbox
      ON turn_runs(inbox_id) WHERE inbox_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_turn_runs_nonterminal
      ON turn_runs(status, available_at, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_runs_session
      ON turn_runs(session_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_turn_runs_route
      ON turn_runs(provider, account_id, source_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_outbox (
      id TEXT PRIMARY KEY,
      turn_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      payload TEXT,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      provider_upload_key TEXT,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(turn_run_id, ordinal),
      FOREIGN KEY (turn_run_id) REFERENCES turn_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_nonterminal
      ON channel_outbox(status, available_at, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_run
      ON channel_outbox(turn_run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_route
      ON channel_outbox(provider, account_id, source_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS streaming_cards (
      id TEXT PRIMARY KEY,
      turn_run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      message_id TEXT,
      card_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      snapshot TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (turn_run_id) REFERENCES turn_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_streaming_cards_run
      ON streaming_cards(turn_run_id);
    CREATE INDEX IF NOT EXISTS idx_streaming_cards_nonterminal
      ON streaming_cards(status, updated_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_cards_message
      ON streaming_cards(provider, account_id, message_id);
  `);
}

export function bindChannelReliabilityDatabase(
  connection: SqliteDatabase | null,
): void {
  database = connection;
}

interface CursorRow {
  provider: string;
  account_id: string;
  scope: string;
  chat_id: string;
  cursor: string;
  position: number;
  tie_breaker: string;
  created_at: string;
  updated_at: string;
}

function mapCursor(row: CursorRow): ChannelCursor {
  return {
    provider: row.provider,
    accountId: row.account_id,
    scope: row.scope,
    chatId: row.chat_id || null,
    cursor: row.cursor,
    position: row.position,
    tieBreaker: row.tie_breaker,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AdvanceChannelCursorInput {
  provider: string;
  accountId: string;
  scope: string;
  chatId?: string | null;
  cursor: string;
  /** Monotonic provider timestamp/sequence. Must be a safe integer. */
  position: number;
  /** Deterministic ordering for two events at the same position. */
  tieBreaker?: string;
  now?: Date | string;
}

export function advanceChannelCursor(input: AdvanceChannelCursorInput): {
  advanced: boolean;
  cursor: ChannelCursor;
} {
  const connection = requireDatabase();
  const provider = input.provider.trim();
  const accountId = input.accountId.trim();
  const scope = input.scope.trim();
  const chatId = input.chatId?.trim() || '';
  const cursor = input.cursor.trim();
  const tieBreaker = input.tieBreaker ?? '';
  if (!provider || !accountId || !scope || !cursor) {
    throw new Error('provider, accountId, scope and cursor are required');
  }
  if (!Number.isSafeInteger(input.position) || input.position < 0) {
    throw new Error('position must be a non-negative safe integer');
  }
  const now = isoNow(input.now);
  return connection.transaction(() => {
    const changed = connection
      .prepare(
        `INSERT INTO channel_cursors (
           provider, account_id, scope, chat_id, cursor, position,
           tie_breaker, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, account_id, scope, chat_id) DO UPDATE SET
           cursor = excluded.cursor,
           position = excluded.position,
           tie_breaker = excluded.tie_breaker,
           updated_at = excluded.updated_at
         WHERE excluded.position > channel_cursors.position
            OR (excluded.position = channel_cursors.position
                AND excluded.tie_breaker > channel_cursors.tie_breaker)`,
      )
      .run(
        provider,
        accountId,
        scope,
        chatId,
        cursor,
        input.position,
        tieBreaker,
        now,
        now,
      );
    const row = connection
      .prepare(
        `SELECT * FROM channel_cursors
         WHERE provider = ? AND account_id = ? AND scope = ? AND chat_id = ?`,
      )
      .get(provider, accountId, scope, chatId) as CursorRow;
    return { advanced: changed.changes === 1, cursor: mapCursor(row) };
  })();
}

export function getChannelCursor(input: {
  provider: string;
  accountId: string;
  scope: string;
  chatId?: string | null;
}): ChannelCursor | undefined {
  const row = requireDatabase()
    .prepare(
      `SELECT * FROM channel_cursors
       WHERE provider = ? AND account_id = ? AND scope = ? AND chat_id = ?`,
    )
    .get(
      input.provider.trim(),
      input.accountId.trim(),
      input.scope.trim(),
      input.chatId?.trim() || '',
    ) as CursorRow | undefined;
  return row ? mapCursor(row) : undefined;
}

export function listChannelCursors(
  input: { provider?: string; accountId?: string; limit?: number } = {},
): ChannelCursor[] {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 100)));
  return (
    requireDatabase()
      .prepare(
        `SELECT * FROM channel_cursors
         WHERE (? IS NULL OR provider = ?) AND (? IS NULL OR account_id = ?)
         ORDER BY updated_at DESC, provider, account_id, scope, chat_id LIMIT ?`,
      )
      .all(
        input.provider ?? null,
        input.provider ?? null,
        input.accountId ?? null,
        input.accountId ?? null,
        limit,
      ) as CursorRow[]
  ).map(mapCursor);
}

/** Explicit CAS deletion for a decommissioned transport/scope. */
export function deleteChannelCursor(input: {
  provider: string;
  accountId: string;
  scope: string;
  chatId?: string | null;
  expectedPosition: number;
  expectedTieBreaker?: string;
}): boolean {
  const changed = requireDatabase()
    .prepare(
      `DELETE FROM channel_cursors
       WHERE provider = ? AND account_id = ? AND scope = ? AND chat_id = ?
         AND position = ? AND tie_breaker = ?`,
    )
    .run(
      input.provider.trim(),
      input.accountId.trim(),
      input.scope.trim(),
      input.chatId?.trim() || '',
      input.expectedPosition,
      input.expectedTieBreaker ?? '',
    );
  return changed.changes === 1;
}

interface InboxRow {
  id: string;
  provider: string;
  account_id: string;
  external_message_id: string;
  source_jid: string;
  chat_id: string | null;
  root_id: string | null;
  thread_id: string | null;
  raw_payload: string | null;
  normalized_payload: string | null;
  status: ChannelInboxStatus;
  available_at: string;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapInbox(row: InboxRow): ChannelInboxItem {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.account_id,
    externalMessageId: row.external_message_id,
    sourceJid: row.source_jid,
    chatId: row.chat_id,
    rootId: row.root_id,
    threadId: row.thread_id,
    status: row.status,
    rawPayload: parsePayload(row.raw_payload),
    normalizedPayload: parsePayload(row.normalized_payload),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface RecordChannelInboxInput extends ChannelRouteSnapshot {
  externalMessageId: string;
  rawPayload?: unknown;
  normalizedPayload?: unknown;
  status?: Extract<ChannelInboxStatus, 'received' | 'admitted' | 'queued'>;
  availableAt?: string;
  now?: Date | string;
}

export function recordChannelInbox(input: RecordChannelInboxInput): {
  created: boolean;
  item: ChannelInboxItem;
} {
  const connection = requireDatabase();
  const route = normalizeRoute(input);
  const externalMessageId = input.externalMessageId.trim();
  if (!externalMessageId) throw new Error('externalMessageId is required');
  const now = isoNow(input.now);
  const id = crypto.randomUUID();
  const status = input.status ?? 'received';
  return connection.transaction(() => {
    const inserted = connection
      .prepare(
        `INSERT OR IGNORE INTO channel_inbox (
           id, provider, account_id, external_message_id, source_jid,
           chat_id, root_id, thread_id, raw_payload, normalized_payload,
           status, available_at, lease_owner, lease_token, lease_expires_at,
           attempt, error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL,
                   0, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        route.provider,
        route.accountId,
        externalMessageId,
        route.sourceJid,
        route.chatId,
        route.rootId,
        route.threadId,
        stringifyPayload(input.rawPayload),
        stringifyPayload(input.normalizedPayload),
        status,
        input.availableAt ?? now,
        now,
        now,
      );
    const row = connection
      .prepare(
        `SELECT * FROM channel_inbox
         WHERE provider = ? AND account_id = ? AND external_message_id = ?`,
      )
      .get(route.provider, route.accountId, externalMessageId) as InboxRow;
    return { created: inserted.changes === 1, item: mapInbox(row) };
  })();
}

export function getChannelInboxItem(id: string): ChannelInboxItem | undefined {
  const row = requireDatabase()
    .prepare('SELECT * FROM channel_inbox WHERE id = ?')
    .get(id) as InboxRow | undefined;
  return row ? mapInbox(row) : undefined;
}

export function transitionChannelInbox(
  id: string,
  expectedStatus: ChannelInboxStatus,
  nextStatus: ChannelInboxStatus,
  input: {
    normalizedPayload?: unknown;
    error?: string | null;
    availableAt?: string;
    now?: Date | string;
  } = {},
): boolean {
  const now = isoNow(input.now);
  const terminal = INBOX_TERMINAL.includes(nextStatus) ? now : null;
  const result = requireDatabase()
    .prepare(
      `UPDATE channel_inbox
       SET status = ?, normalized_payload = CASE WHEN ? = 1 THEN ? ELSE normalized_payload END,
           error = ?, available_at = COALESCE(?, available_at),
           completed_at = ?, updated_at = ?
       WHERE id = ? AND status = ? AND lease_owner IS NULL`,
    )
    .run(
      nextStatus,
      input.normalizedPayload === undefined ? 0 : 1,
      stringifyPayload(input.normalizedPayload),
      input.error ?? null,
      input.availableAt ?? null,
      terminal,
      now,
      id,
      expectedStatus,
    );
  return result.changes === 1;
}

export function claimNextChannelInbox(
  owner: string,
  leaseMs: number,
  options: {
    provider?: string;
    accountId?: string;
    now?: Date | string;
  } = {},
): ClaimedChannelInboxItem | undefined {
  return claimChannelInbox(owner, leaseMs, options);
}

export function claimChannelInboxById(
  id: string,
  owner: string,
  leaseMs: number,
  now?: Date | string,
): ClaimedChannelInboxItem | undefined {
  return claimChannelInbox(owner, leaseMs, { now }, id);
}

function claimChannelInbox(
  owner: string,
  leaseMs: number,
  options: {
    provider?: string;
    accountId?: string;
    now?: Date | string;
  },
  inboxId?: string,
): ClaimedChannelInboxItem | undefined {
  const connection = requireDatabase();
  const now = isoNow(options.now);
  const expires = addMilliseconds(now, leaseMs);
  return connection.transaction(() => {
    const candidate = connection
      .prepare(
        `SELECT * FROM channel_inbox
         WHERE (? IS NULL OR provider = ?)
           AND (? IS NULL OR account_id = ?)
           AND (? IS NULL OR id = ?)
           AND (
             (
               (
                 (? IS NOT NULL AND status IN ('received','admitted','queued'))
                 OR (? IS NULL AND status = 'queued')
               )
               AND available_at <= ? AND lease_owner IS NULL
             )
             OR (status = 'processing' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= ?)
           )
         ORDER BY available_at, created_at LIMIT 1`,
      )
      .get(
        options.provider ?? null,
        options.provider ?? null,
        options.accountId ?? null,
        options.accountId ?? null,
        inboxId ?? null,
        inboxId ?? null,
        inboxId ?? null,
        inboxId ?? null,
        now,
        now,
      ) as InboxRow | undefined;
    if (!candidate) return undefined;
    const token = candidate.lease_token + 1;
    const changed = connection
      .prepare(
        `UPDATE channel_inbox
         SET status = 'processing', lease_owner = ?, lease_token = ?,
             lease_expires_at = ?, attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND lease_token = ? AND (
           (status = ? AND status IN ('received','admitted','queued')
             AND available_at <= ? AND lease_owner IS NULL)
           OR (status = 'processing' AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?)
         )`,
      )
      .run(
        owner,
        token,
        expires,
        now,
        candidate.id,
        candidate.lease_token,
        candidate.status,
        now,
        now,
      );
    if (changed.changes !== 1) return undefined;
    return mapInbox(
      connection
        .prepare('SELECT * FROM channel_inbox WHERE id = ?')
        .get(candidate.id) as InboxRow,
    ) as ClaimedChannelInboxItem;
  })();
}

export function updateClaimedChannelInbox(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: {
    normalizedPayload?: unknown;
    error?: string | null;
    now?: Date | string;
  },
): boolean {
  const now = isoNow(input.now);
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_inbox
       SET normalized_payload = CASE WHEN ? = 1 THEN ? ELSE normalized_payload END,
           error = ?, updated_at = ?
       WHERE id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      input.normalizedPayload === undefined ? 0 : 1,
      stringifyPayload(input.normalizedPayload),
      input.error ?? null,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

/**
 * Extend an in-flight inbox lease without changing its fencing token. The
 * claim must still be live; an expired/stolen claim can never be resurrected.
 */
export function renewChannelInboxClaim(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  leaseMs: number,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const expires = addMilliseconds(now, leaseMs);
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_inbox
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(expires, now, claim.id, claim.leaseOwner, claim.leaseToken, now);
  return changed.changes === 1;
}

function finishClaimedInbox(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: {
    status: Extract<ChannelInboxStatus, 'processed' | 'ignored' | 'failed'>;
    error?: string | null;
    now?: Date | string;
  },
): boolean {
  const now = isoNow(input.now);
  const result = requireDatabase()
    .prepare(
      `UPDATE channel_inbox
       SET status = ?, error = ?, completed_at = ?, updated_at = ?,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      input.status,
      input.error ?? null,
      now,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return result.changes === 1;
}

export function completeChannelInbox(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  now?: Date | string,
): boolean {
  return finishClaimedInbox(claim, { status: 'processed', now });
}

export function ignoreChannelInbox(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  reason?: string | null,
  now?: Date | string,
): boolean {
  return finishClaimedInbox(claim, { status: 'ignored', error: reason, now });
}

export function failChannelInbox(
  claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: {
    error: string;
    retryAt?: string;
    now?: Date | string;
  },
): boolean {
  const now = isoNow(input.now);
  if (!input.retryAt) {
    return finishClaimedInbox(claim, {
      status: 'failed',
      error: input.error,
      now,
    });
  }
  const result = requireDatabase()
    .prepare(
      `UPDATE channel_inbox
       SET status = 'queued', error = ?, available_at = ?, updated_at = ?,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      input.error,
      input.retryAt,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return result.changes === 1;
}

interface TurnRow {
  id: string;
  inbox_id: string | null;
  idempotency_key: string;
  provider: string;
  account_id: string;
  source_jid: string;
  chat_id: string | null;
  root_id: string | null;
  thread_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  correlation_id: string | null;
  status: ChannelTurnRunStatus;
  available_at: string;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  revision: number;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function mapTurn(row: TurnRow): ChannelTurnRun {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    accountId: row.account_id,
    sourceJid: row.source_jid,
    chatId: row.chat_id,
    rootId: row.root_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    correlationId: row.correlation_id,
    status: row.status,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    attempt: row.attempt,
    revision: row.revision,
    result: parsePayload(row.result),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface CreateChannelTurnRunInput extends ChannelRouteSnapshot {
  id?: string;
  inboxId?: string | null;
  idempotencyKey: string;
  agentId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  availableAt?: string;
  now?: Date | string;
}

export function createChannelTurnRun(input: CreateChannelTurnRunInput): {
  created: boolean;
  run: ChannelTurnRun;
} {
  const connection = requireDatabase();
  const route = normalizeRoute(input);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required');
  const id = input.id?.trim() || crypto.randomUUID();
  const now = isoNow(input.now);
  return connection.transaction(() => {
    const inserted = connection
      .prepare(
        `INSERT OR IGNORE INTO turn_runs (
           id, inbox_id, idempotency_key, provider, account_id, source_jid,
           chat_id, root_id, thread_id, agent_id, session_id, correlation_id,
           status, available_at, lease_owner, lease_token, lease_expires_at,
           heartbeat_at, attempt, revision, result, error, created_at,
           updated_at, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL,
                   0, NULL, NULL, 0, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        input.inboxId ?? null,
        idempotencyKey,
        route.provider,
        route.accountId,
        route.sourceJid,
        route.chatId,
        route.rootId,
        route.threadId,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.correlationId ?? null,
        input.availableAt ?? now,
        now,
        now,
      );
    const row = connection
      .prepare(
        `SELECT * FROM turn_runs
         WHERE idempotency_key = ? OR (? IS NOT NULL AND inbox_id = ?)
         ORDER BY CASE WHEN idempotency_key = ? THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(
        idempotencyKey,
        input.inboxId ?? null,
        input.inboxId ?? null,
        idempotencyKey,
      ) as TurnRow | undefined;
    if (!row) {
      throw new Error(`Could not resolve duplicate turn: ${idempotencyKey}`);
    }
    const run = mapTurn(row);
    if (
      inserted.changes === 0 &&
      (run.idempotencyKey !== idempotencyKey ||
        run.provider !== route.provider ||
        run.accountId !== route.accountId ||
        run.sourceJid !== route.sourceJid)
    ) {
      throw new Error(`Turn idempotency conflict: ${idempotencyKey}`);
    }
    return { created: inserted.changes === 1, run };
  })();
}

export function getChannelTurnRun(id: string): ChannelTurnRun | undefined {
  const row = requireDatabase()
    .prepare('SELECT * FROM turn_runs WHERE id = ?')
    .get(id) as TurnRow | undefined;
  return row ? mapTurn(row) : undefined;
}

export const MANUAL_RECONCILIATION_ERROR_PREFIX = '[manual_reconciliation] ';

export function manualReconciliationError(reason: string): string {
  const normalized = reason.trim();
  return normalized.startsWith(MANUAL_RECONCILIATION_ERROR_PREFIX)
    ? normalized
    : `${MANUAL_RECONCILIATION_ERROR_PREFIX}${normalized}`;
}

export function requiresManualReconciliation(
  error: string | null | undefined,
): boolean {
  if (!error) return false;
  return (
    error.startsWith(MANUAL_RECONCILIATION_ERROR_PREFIX) ||
    // Backward compatibility for v60 rows written before structured codes.
    error.toLowerCase().includes('manual reconciliation required')
  );
}

export const DELIVERED_EFFECT_RECONCILIATION_REASON = manualReconciliationError(
  'A channel side effect was already delivered before Turn completion; manual reconciliation required',
);

/**
 * Fence one non-terminal Turn when durable state proves that a user-visible
 * side effect already completed. This must run before a new execution claim:
 * replaying the Agent loop could otherwise create a sibling output after a
 * crash between provider ACK persistence and Turn completion.
 */
export function interruptChannelTurnRunWithDeliveredEffect(
  id: string,
  nowInput?: Date | string,
): boolean {
  const connection = requireDatabase();
  const now = isoNow(nowInput);
  return connection.transaction(() => {
    const changed = connection
      .prepare(
        `UPDATE turn_runs
         SET status = 'interrupted', completed_at = ?, updated_at = ?,
             error = ?, lease_owner = NULL, lease_expires_at = NULL,
             lease_token = lease_token + 1, revision = revision + 1
         WHERE id = ?
           AND status IN ('queued','running','retry_wait','waiting_user','finalizing')
           AND (
             EXISTS (
               SELECT 1 FROM channel_outbox
               WHERE channel_outbox.turn_run_id = turn_runs.id
                 AND channel_outbox.status = 'delivered'
             )
             OR EXISTS (
               SELECT 1 FROM streaming_cards
               WHERE streaming_cards.turn_run_id = turn_runs.id
                 AND streaming_cards.status = 'completed'
             )
           )`,
      )
      .run(now, now, DELIVERED_EFFECT_RECONCILIATION_REASON, id);
    return changed.changes === 1;
  })();
}

/**
 * Startup counterpart of the pre-claim fence. An unexpired execution lease is
 * never overridden because a second service instance may still own it.
 */
export function interruptChannelTurnRunsWithDeliveredEffects(
  nowInput?: Date | string,
): number {
  const now = isoNow(nowInput);
  return requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'interrupted', completed_at = ?, updated_at = ?,
           error = ?, lease_owner = NULL, lease_expires_at = NULL,
           lease_token = lease_token + 1, revision = revision + 1
       WHERE status IN ('queued','running','retry_wait','waiting_user','finalizing')
         AND NOT (
           status IN ('running','finalizing')
           AND lease_owner IS NOT NULL
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > ?
         )
         AND (
           EXISTS (
             SELECT 1 FROM channel_outbox
             WHERE channel_outbox.turn_run_id = turn_runs.id
               AND channel_outbox.status = 'delivered'
           )
           OR EXISTS (
             SELECT 1 FROM streaming_cards
             WHERE streaming_cards.turn_run_id = turn_runs.id
               AND streaming_cards.status = 'completed'
           )
         )`,
    )
    .run(now, now, DELIVERED_EFFECT_RECONCILIATION_REASON, now).changes;
}

export function claimNextChannelTurnRun(
  owner: string,
  leaseMs: number,
  options: { provider?: string; accountId?: string; now?: Date | string } = {},
): ClaimedChannelTurnRun | undefined {
  return claimChannelTurnRun(owner, leaseMs, options);
}

export function claimChannelTurnRunById(
  id: string,
  owner: string,
  leaseMs: number,
  now?: Date | string,
): ClaimedChannelTurnRun | undefined {
  return claimChannelTurnRun(owner, leaseMs, { now }, id);
}

function claimChannelTurnRun(
  owner: string,
  leaseMs: number,
  options: { provider?: string; accountId?: string; now?: Date | string },
  runId?: string,
): ClaimedChannelTurnRun | undefined {
  const connection = requireDatabase();
  const now = isoNow(options.now);
  const expires = addMilliseconds(now, leaseMs);
  return connection.transaction(() => {
    const candidate = connection
      .prepare(
        `SELECT * FROM turn_runs
         WHERE status IN ('queued','retry_wait') AND available_at <= ?
           AND lease_owner IS NULL
           AND (? IS NULL OR id = ?)
           AND (? IS NULL OR provider = ?)
           AND (? IS NULL OR account_id = ?)
         ORDER BY available_at, created_at LIMIT 1`,
      )
      .get(
        now,
        runId ?? null,
        runId ?? null,
        options.provider ?? null,
        options.provider ?? null,
        options.accountId ?? null,
        options.accountId ?? null,
      ) as TurnRow | undefined;
    if (!candidate) return undefined;
    const token = candidate.lease_token + 1;
    const changed = connection
      .prepare(
        `UPDATE turn_runs
         SET status = 'running', lease_owner = ?, lease_token = ?,
             lease_expires_at = ?, heartbeat_at = ?, attempt = attempt + 1,
             revision = revision + 1, started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE id = ? AND lease_token = ? AND status IN ('queued','retry_wait')
           AND available_at <= ? AND lease_owner IS NULL`,
      )
      .run(
        owner,
        token,
        expires,
        now,
        now,
        now,
        candidate.id,
        candidate.lease_token,
        now,
      );
    if (changed.changes !== 1) return undefined;
    return mapTurn(
      connection
        .prepare('SELECT * FROM turn_runs WHERE id = ?')
        .get(candidate.id) as TurnRow,
    ) as ClaimedChannelTurnRun;
  })();
}

export function heartbeatChannelTurnRun(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  leaseMs: number,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const expires = addMilliseconds(now, leaseMs);
  const result = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running','finalizing')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(now, expires, now, claim.id, claim.leaseOwner, claim.leaseToken, now);
  return result.changes === 1;
}

export function markChannelTurnFinalizing(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const result = requireDatabase()
    .prepare(
      `UPDATE turn_runs SET status = 'finalizing', revision = revision + 1,
           updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(now, claim.id, claim.leaseOwner, claim.leaseToken, now);
  return result.changes === 1;
}

export function waitChannelTurnForUser(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  result?: unknown,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const changed = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'waiting_user', result = ?, lease_owner = NULL,
           lease_expires_at = NULL, heartbeat_at = ?, revision = revision + 1,
           updated_at = ?
       WHERE id = ? AND status IN ('running','finalizing')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      stringifyPayload(result),
      now,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

export function resumeWaitingChannelTurn(
  id: string,
  expectedRevision: number,
  availableAt?: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const changed = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'queued', available_at = ?, result = NULL, error = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'waiting_user' AND revision = ?`,
    )
    .run(availableAt ?? now, now, id, expectedRevision);
  return changed.changes === 1;
}

export function retryChannelTurnRun(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: { availableAt: string; error: string; now?: Date | string },
): boolean {
  const now = isoNow(input.now);
  const changed = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'retry_wait', available_at = ?, error = ?,
           lease_owner = NULL, lease_expires_at = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      input.availableAt,
      input.error,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

/**
 * Release a live execution fence for a retry without turning the logical input
 * into a terminal receipt. The next queue attempt reclaims the same run id and
 * therefore preserves provider/idempotency history across retries.
 */
export function retryChannelTurnRunNow(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  error: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  return retryChannelTurnRun(claim, {
    availableAt: now,
    error,
    now,
  });
}

export function completeChannelTurnRun(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: {
    status?: Extract<
      ChannelTurnRunStatus,
      'completed' | 'failed' | 'cancelled'
    >;
    result?: unknown;
    error?: string | null;
    now?: Date | string;
  } = {},
): boolean {
  const now = isoNow(input.now);
  const status = input.status ?? 'completed';
  const changed = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = ?, result = ?, error = ?, completed_at = ?,
           lease_owner = NULL, lease_expires_at = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status IN ('running','finalizing')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?
         AND (
           ? <> 'completed'
           OR NOT EXISTS (
             SELECT 1 FROM channel_outbox
             WHERE turn_run_id = turn_runs.id
               AND status IN (
                 'pending','claimed','retry_wait','uploading',
                 'uploaded','sending','uncertain'
               )
           )
         )`,
    )
    .run(
      status,
      stringifyPayload(input.result),
      input.error ?? null,
      now,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
      status,
    );
  return changed.changes === 1;
}

/** Expired Agent execution is not replayed automatically because side effects are unknowable. */
export function interruptExpiredChannelTurnRuns(
  nowInput?: Date | string,
): number {
  const now = isoNow(nowInput);
  const error = manualReconciliationError(
    'Process stopped after Agent execution began; manual reconciliation required',
  );
  return requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'interrupted', completed_at = ?, updated_at = ?,
           error = COALESCE(error, ?),
           lease_owner = NULL, lease_expires_at = NULL,
           lease_token = lease_token + 1, revision = revision + 1
       WHERE status IN ('running','finalizing')
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    )
    .run(now, now, error, now).changes;
}

/**
 * Explicitly fence one live conversation Turn (stop button, shutdown, or
 * unrecoverable card/run reconciliation). Terminal rows are immutable, so
 * repeating the same interrupt is a no-op.
 */
export function interruptChannelTurnRunById(
  id: string,
  reason: string,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('interrupt reason is required');
  const changed = requireDatabase()
    .prepare(
      `UPDATE turn_runs
       SET status = 'interrupted', completed_at = ?, updated_at = ?,
           error = ?, lease_owner = NULL, lease_expires_at = NULL,
           lease_token = lease_token + 1, revision = revision + 1
       WHERE id = ?
         AND status IN ('queued','running','finalizing','waiting_user','retry_wait')`,
    )
    .run(now, now, normalizedReason, id);
  return changed.changes === 1;
}

interface OutboxRow {
  id: string;
  turn_run_id: string;
  ordinal: number;
  kind: ChannelOutboxKind;
  idempotency_key: string;
  provider: string;
  account_id: string;
  source_jid: string;
  chat_id: string | null;
  root_id: string | null;
  thread_id: string | null;
  payload: string | null;
  payload_hash: string;
  status: ChannelOutboxStatus;
  provider_message_id: string | null;
  provider_upload_key: string | null;
  available_at: string;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  attempt: number;
  revision: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function mapOutbox(row: OutboxRow): ChannelOutboxItem {
  return {
    id: row.id,
    turnRunId: row.turn_run_id,
    ordinal: row.ordinal,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    accountId: row.account_id,
    sourceJid: row.source_jid,
    chatId: row.chat_id,
    rootId: row.root_id,
    threadId: row.thread_id,
    payload: parsePayload(row.payload),
    payloadHash: row.payload_hash,
    status: row.status,
    providerMessageId: row.provider_message_id,
    providerUploadKey: row.provider_upload_key,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    revision: row.revision,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

export interface EnqueueChannelOutboxInput extends ChannelRouteSnapshot {
  id?: string;
  turnRunId: string;
  ordinal: number;
  kind: ChannelOutboxKind;
  idempotencyKey?: string;
  payload: unknown;
  availableAt?: string;
  now?: Date | string;
}

export function enqueueChannelOutbox(input: EnqueueChannelOutboxInput): {
  created: boolean;
  item: ChannelOutboxItem;
} {
  const connection = requireDatabase();
  const route = normalizeRoute(input);
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error('ordinal must be a non-negative integer');
  }
  const hash = channelPayloadHash(input.payload);
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `${input.turnRunId}:${input.ordinal}:${input.kind}:${hash}`;
  const now = isoNow(input.now);
  const id = input.id?.trim() || crypto.randomUUID();
  return connection.transaction(() => {
    const inserted = connection
      .prepare(
        `INSERT OR IGNORE INTO channel_outbox (
           id, turn_run_id, ordinal, kind, idempotency_key, provider,
           account_id, source_jid, chat_id, root_id, thread_id, payload,
           payload_hash, status, provider_message_id, provider_upload_key,
           available_at, lease_owner, lease_token, lease_expires_at, attempt,
           revision, error, created_at, updated_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL,
                   NULL, ?, NULL, 0, NULL, 0, 0, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.turnRunId,
        input.ordinal,
        input.kind,
        idempotencyKey,
        route.provider,
        route.accountId,
        route.sourceJid,
        route.chatId,
        route.rootId,
        route.threadId,
        stringifyPayload(input.payload),
        hash,
        input.availableAt ?? now,
        now,
        now,
      );
    const row = connection
      .prepare(
        `SELECT * FROM channel_outbox
         WHERE idempotency_key = ? OR (turn_run_id = ? AND ordinal = ?)
         ORDER BY CASE WHEN idempotency_key = ? THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(idempotencyKey, input.turnRunId, input.ordinal, idempotencyKey) as
      | OutboxRow
      | undefined;
    if (!row) {
      throw new Error(
        `Could not resolve duplicate outbox item: ${idempotencyKey}`,
      );
    }
    const item = mapOutbox(row);
    if (
      inserted.changes === 0 &&
      (item.idempotencyKey !== idempotencyKey ||
        item.payloadHash !== hash ||
        item.turnRunId !== input.turnRunId ||
        item.ordinal !== input.ordinal ||
        item.kind !== input.kind ||
        item.sourceJid !== route.sourceJid ||
        item.accountId !== route.accountId)
    ) {
      throw new Error(`Outbox idempotency conflict: ${idempotencyKey}`);
    }
    return { created: inserted.changes === 1, item };
  })();
}

export function getChannelOutboxItem(
  id: string,
): ChannelOutboxItem | undefined {
  const row = requireDatabase()
    .prepare('SELECT * FROM channel_outbox WHERE id = ?')
    .get(id) as OutboxRow | undefined;
  return row ? mapOutbox(row) : undefined;
}

/**
 * Any uncertain physical side effect fences the entire turn. Until an
 * operator reconciles it, creating a sibling row could duplicate a message
 * that the provider already accepted before its ACK was lost.
 */
export function getUncertainChannelOutboxForTurn(
  turnRunId: string,
): ChannelOutboxItem | undefined {
  const row = requireDatabase()
    .prepare(
      `SELECT * FROM channel_outbox
       WHERE turn_run_id = ? AND status = 'uncertain'
       ORDER BY updated_at, id LIMIT 1`,
    )
    .get(turnRunId) as OutboxRow | undefined;
  return row ? mapOutbox(row) : undefined;
}

export function hasUncertainChannelOutbox(turnRunId: string): boolean {
  return Boolean(getUncertainChannelOutboxForTurn(turnRunId));
}

/**
 * Every uncertain side effect awaiting reconciliation, oldest first.
 *
 * An uncertain row fences its whole turn until someone decides whether the
 * provider actually accepted the message. Nothing in the runtime can make that
 * call, so this backs the operator surface that does — without it the fence
 * has no release and the rows are unreachable.
 */
export function listUncertainChannelOutbox(limit = 100): ChannelOutboxItem[] {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 0, 1), 500);
  const rows = requireDatabase()
    .prepare(
      `SELECT * FROM channel_outbox
       WHERE status = 'uncertain'
       ORDER BY updated_at, id LIMIT ?`,
    )
    .all(bounded) as OutboxRow[];
  return rows.map(mapOutbox);
}

export function claimNextChannelOutbox(
  owner: string,
  leaseMs: number,
  options: { provider?: string; accountId?: string; now?: Date | string } = {},
): ClaimedChannelOutboxItem | undefined {
  return claimChannelOutbox(owner, leaseMs, options);
}

export function claimChannelOutboxById(
  id: string,
  owner: string,
  leaseMs: number,
  now?: Date | string,
): ClaimedChannelOutboxItem | undefined {
  return claimChannelOutbox(owner, leaseMs, { now }, id);
}

function claimChannelOutbox(
  owner: string,
  leaseMs: number,
  options: { provider?: string; accountId?: string; now?: Date | string },
  itemId?: string,
): ClaimedChannelOutboxItem | undefined {
  const connection = requireDatabase();
  const now = isoNow(options.now);
  const expires = addMilliseconds(now, leaseMs);
  return connection.transaction(() => {
    const candidate = connection
      .prepare(
        `SELECT * FROM channel_outbox
         WHERE status IN ('pending','retry_wait') AND available_at <= ?
           AND lease_owner IS NULL
           AND (? IS NULL OR id = ?)
           AND (? IS NULL OR provider = ?)
           AND (? IS NULL OR account_id = ?)
         ORDER BY available_at, turn_run_id, ordinal, created_at LIMIT 1`,
      )
      .get(
        now,
        itemId ?? null,
        itemId ?? null,
        options.provider ?? null,
        options.provider ?? null,
        options.accountId ?? null,
        options.accountId ?? null,
      ) as OutboxRow | undefined;
    if (!candidate) return undefined;
    const token = candidate.lease_token + 1;
    const changed = connection
      .prepare(
        `UPDATE channel_outbox
         SET status = 'claimed', lease_owner = ?, lease_token = ?,
             lease_expires_at = ?, attempt = attempt + 1,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND lease_token = ? AND status IN ('pending','retry_wait')
           AND available_at <= ? AND lease_owner IS NULL`,
      )
      .run(
        owner,
        token,
        expires,
        now,
        candidate.id,
        candidate.lease_token,
        now,
      );
    if (changed.changes !== 1) return undefined;
    return mapOutbox(
      connection
        .prepare('SELECT * FROM channel_outbox WHERE id = ?')
        .get(candidate.id) as OutboxRow,
    ) as ClaimedChannelOutboxItem;
  })();
}

export function renewChannelOutboxLease(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  leaseMs: number,
  nowInput?: Date | string,
): boolean {
  const now = isoNow(nowInput);
  const expires = addMilliseconds(now, leaseMs);
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_outbox SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('claimed','uploading','uploaded','sending')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(expires, now, claim.id, claim.leaseOwner, claim.leaseToken, now);
  return changed.changes === 1;
}

function transitionClaimedOutbox(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  expectedStatuses: readonly ChannelOutboxStatus[],
  nextStatus: ChannelOutboxStatus,
  input: {
    providerUploadKey?: string | null;
    providerMessageId?: string | null;
    error?: string | null;
    now?: Date | string;
  } = {},
): boolean {
  const now = isoNow(input.now);
  const placeholders = expectedStatuses.map(() => '?').join(',');
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_outbox
       SET status = ?,
           provider_upload_key = COALESCE(?, provider_upload_key),
           provider_message_id = COALESCE(?, provider_message_id),
           error = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status IN (${placeholders}) AND lease_owner = ?
         AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      nextStatus,
      input.providerUploadKey ?? null,
      input.providerMessageId ?? null,
      input.error ?? null,
      now,
      claim.id,
      ...expectedStatuses,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

export function markChannelOutboxUploading(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  now?: Date | string,
): boolean {
  return transitionClaimedOutbox(claim, ['claimed'], 'uploading', { now });
}

export function markChannelOutboxUploaded(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  providerUploadKey: string,
  now?: Date | string,
): boolean {
  return transitionClaimedOutbox(claim, ['claimed', 'uploading'], 'uploaded', {
    providerUploadKey,
    now,
  });
}

export function markChannelOutboxSending(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  now?: Date | string,
): boolean {
  return transitionClaimedOutbox(claim, ['claimed', 'uploaded'], 'sending', {
    now,
  });
}

export function completeChannelOutbox(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: { providerMessageId: string; now?: Date | string },
): boolean {
  const now = isoNow(input.now);
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_outbox
       SET status = 'delivered', provider_message_id = ?, delivered_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, error = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status IN ('claimed','uploaded','sending')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      input.providerMessageId,
      now,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

export function failChannelOutbox(
  claim: Pick<ClaimedChannelOutboxItem, 'id' | 'leaseOwner' | 'leaseToken'>,
  input: {
    error: string;
    retryAt?: string;
    uncertain?: boolean;
    now?: Date | string;
  },
): boolean {
  const now = isoNow(input.now);
  const nextStatus: ChannelOutboxStatus = input.uncertain
    ? 'uncertain'
    : input.retryAt
      ? 'retry_wait'
      : 'failed';
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_outbox
       SET status = ?, error = ?, available_at = COALESCE(?, available_at),
           lease_owner = NULL, lease_expires_at = NULL,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status IN ('claimed','uploading','uploaded','sending')
         AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?`,
    )
    .run(
      nextStatus,
      input.error,
      input.retryAt ?? null,
      now,
      claim.id,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

/**
 * Reconcile crashed delivery leases. Pre-send claims are safe to retry;
 * `sending` is fenced as uncertain because the provider may have accepted it.
 */
export function reconcileExpiredChannelOutbox(nowInput?: Date | string): {
  retryable: number;
  uncertain: number;
} {
  const connection = requireDatabase();
  const now = isoNow(nowInput);
  return connection.transaction(() => {
    const retryable = connection
      .prepare(
        `UPDATE channel_outbox
         SET status = 'retry_wait', available_at = ?,
             error = COALESCE(error, 'Delivery worker lease expired before send'),
             lease_owner = NULL, lease_expires_at = NULL,
             lease_token = lease_token + 1, revision = revision + 1,
             updated_at = ?
         WHERE status IN ('claimed','uploading','uploaded')
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now, now).changes;
    const uncertain = connection
      .prepare(
        `UPDATE channel_outbox
         SET status = 'uncertain',
             error = COALESCE(error,
               'Delivery lease expired after send began; reconcile provider receipt before retry'),
             lease_owner = NULL, lease_expires_at = NULL,
             lease_token = lease_token + 1, revision = revision + 1,
             updated_at = ?
         WHERE status = 'sending' AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .run(now, now).changes;
    return { retryable, uncertain };
  })();
}

export function resolveUncertainChannelOutbox(
  id: string,
  expectedRevision: number,
  input:
    | {
        resolution: 'delivered';
        providerMessageId: string;
        now?: Date | string;
      }
    | { resolution: 'failed'; error: string; now?: Date | string },
): boolean {
  const now = isoNow(input.now);
  const nextStatus = input.resolution === 'delivered' ? 'delivered' : 'failed';
  const changed = requireDatabase()
    .prepare(
      `UPDATE channel_outbox
       SET status = ?,
           provider_message_id = CASE WHEN ? = 'delivered' THEN ? ELSE provider_message_id END,
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END,
           error = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'uncertain' AND revision = ?`,
    )
    .run(
      nextStatus,
      input.resolution,
      input.resolution === 'delivered' ? input.providerMessageId : null,
      input.resolution,
      now,
      input.resolution,
      input.resolution === 'failed' ? input.error : null,
      now,
      id,
      expectedRevision,
    );
  return changed.changes === 1;
}

interface CardRow {
  id: string;
  turn_run_id: string;
  provider: string;
  account_id: string;
  source_jid: string;
  chat_id: string | null;
  root_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  card_id: string | null;
  version: number;
  snapshot: string | null;
  status: StreamingCardStatus;
  revision: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapCard(row: CardRow): StreamingCardRecord {
  return {
    id: row.id,
    turnRunId: row.turn_run_id,
    provider: row.provider,
    accountId: row.account_id,
    sourceJid: row.source_jid,
    chatId: row.chat_id,
    rootId: row.root_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    cardId: row.card_id,
    version: row.version,
    snapshot: parsePayload(row.snapshot),
    status: row.status,
    revision: row.revision,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface CreateStreamingCardRecordInput extends ChannelRouteSnapshot {
  id?: string;
  turnRunId: string;
  messageId?: string | null;
  cardId?: string | null;
  version?: number;
  snapshot?: unknown;
  status?: Extract<StreamingCardStatus, 'creating' | 'streaming'>;
  now?: Date | string;
}

export function createStreamingCardRecord(
  input: CreateStreamingCardRecordInput,
): { created: boolean; card: StreamingCardRecord } {
  const connection = requireDatabase();
  const route = normalizeRoute(input);
  const id = input.id?.trim() || crypto.randomUUID();
  const now = isoNow(input.now);
  return connection.transaction(() => {
    const inserted = connection
      .prepare(
        `INSERT OR IGNORE INTO streaming_cards (
           id, turn_run_id, provider, account_id, source_jid, chat_id,
           root_id, thread_id, message_id, card_id, version, snapshot,
           status, revision, error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.turnRunId,
        route.provider,
        route.accountId,
        route.sourceJid,
        route.chatId,
        route.rootId,
        route.threadId,
        input.messageId ?? null,
        input.cardId ?? null,
        input.version ?? 0,
        stringifyPayload(input.snapshot),
        input.status ?? 'creating',
        now,
        now,
      );
    const row = connection
      .prepare('SELECT * FROM streaming_cards WHERE id = ?')
      .get(id) as CardRow | undefined;
    if (!row) {
      throw new Error(`Could not create streaming card record: ${id}`);
    }
    const card = mapCard(row);
    if (
      inserted.changes === 0 &&
      (card.turnRunId !== input.turnRunId ||
        card.accountId !== route.accountId ||
        card.sourceJid !== route.sourceJid)
    ) {
      throw new Error(
        `Streaming card route conflict for run ${input.turnRunId}`,
      );
    }
    return { created: inserted.changes === 1, card };
  })();
}

export function getStreamingCardRecord(
  id: string,
): StreamingCardRecord | undefined {
  const row = requireDatabase()
    .prepare('SELECT * FROM streaming_cards WHERE id = ?')
    .get(id) as CardRow | undefined;
  return row ? mapCard(row) : undefined;
}

/**
 * Roll back a reservation which provably never reached the provider. The
 * execution lease, run/card identity and card revision are checked in the
 * same DELETE statement. Any provider identity or potentially-visible Outbox
 * state makes the operation fail closed.
 */
export function rollbackUnpublishedStreamingCardReservation(
  claim: Pick<ClaimedChannelTurnRun, 'id' | 'leaseOwner' | 'leaseToken'>,
  card: Pick<StreamingCardRecord, 'id' | 'turnRunId' | 'revision'>,
  nowInput?: Date | string,
): boolean {
  if (card.turnRunId !== claim.id) return false;
  const now = isoNow(nowInput);
  const changed = requireDatabase()
    .prepare(
      `DELETE FROM streaming_cards
       WHERE id = ? AND turn_run_id = ? AND revision = ?
         AND status = 'creating'
         AND message_id IS NULL AND card_id IS NULL
         AND EXISTS (
           SELECT 1 FROM turn_runs
           WHERE turn_runs.id = streaming_cards.turn_run_id
             AND turn_runs.status IN ('running','finalizing')
             AND turn_runs.lease_owner = ?
             AND turn_runs.lease_token = ?
             AND turn_runs.lease_expires_at > ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM channel_outbox
           WHERE channel_outbox.turn_run_id = streaming_cards.turn_run_id
             AND channel_outbox.status IN (
               'claimed','sending','uncertain','delivered'
             )
         )`,
    )
    .run(
      card.id,
      card.turnRunId,
      card.revision,
      claim.leaseOwner,
      claim.leaseToken,
      now,
    );
  return changed.changes === 1;
}

export function updateStreamingCardRecord(
  id: string,
  expectedRevision: number,
  input: {
    status?: StreamingCardStatus;
    messageId?: string | null;
    cardId?: string | null;
    version?: number;
    snapshot?: unknown;
    error?: string | null;
    now?: Date | string;
  },
): StreamingCardRecord | undefined {
  const connection = requireDatabase();
  const now = isoNow(input.now);
  const status = input.status;
  const completedAt = status && CARD_TERMINAL.includes(status) ? now : null;
  const changed = connection
    .prepare(
      `UPDATE streaming_cards
       SET status = COALESCE(?, status),
           message_id = CASE WHEN ? = 1 THEN ? ELSE message_id END,
           card_id = CASE WHEN ? = 1 THEN ? ELSE card_id END,
           version = COALESCE(?, version),
           snapshot = CASE WHEN ? = 1 THEN ? ELSE snapshot END,
           error = ?, completed_at = COALESCE(?, completed_at),
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?
         AND status NOT IN ('completed','aborted','failed')`,
    )
    .run(
      status ?? null,
      input.messageId === undefined ? 0 : 1,
      input.messageId ?? null,
      input.cardId === undefined ? 0 : 1,
      input.cardId ?? null,
      input.version ?? null,
      input.snapshot === undefined ? 0 : 1,
      stringifyPayload(input.snapshot),
      input.error ?? null,
      completedAt,
      now,
      id,
      expectedRevision,
    );
  if (changed.changes !== 1) return undefined;
  return getStreamingCardRecord(id);
}

export function finalizeStreamingCardRecord(
  id: string,
  expectedRevision: number,
  input: {
    status: Extract<StreamingCardStatus, 'completed' | 'aborted' | 'failed'>;
    version?: number;
    snapshot?: unknown;
    error?: string | null;
    now?: Date | string;
  },
): StreamingCardRecord | undefined {
  return updateStreamingCardRecord(id, expectedRevision, input);
}

/**
 * Fence a non-terminal card before performing provider-side recovery. A
 * process that still owns a stale in-memory revision can no longer mutate the
 * card after this CAS succeeds. `recovering` deliberately remains
 * non-terminal: if provider I/O fails or this process crashes, a later pass can
 * claim the same record again and retry the original-card update.
 */
export function claimStreamingCardRecovery(
  id: string,
  expectedRevision: number,
  nowInput?: Date | string,
  recoveryLeaseMs = 45_000,
): StreamingCardRecord | undefined {
  const connection = requireDatabase();
  const now = isoNow(nowInput);
  const staleBefore = new Date(
    new Date(now).getTime() - Math.max(1_000, recoveryLeaseMs),
  ).toISOString();
  const changed = connection
    .prepare(
      `UPDATE streaming_cards
       SET status = 'recovering', error = 'Streaming card recovery in progress',
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?
         AND (status IN ('creating','streaming')
           OR (status = 'recovering' AND updated_at <= ?))`,
    )
    .run(now, id, expectedRevision, staleBefore);
  return changed.changes === 1 ? getStreamingCardRecord(id) : undefined;
}

/** Release a failed recovery claim so an account-ready pass can retry now. */
export function releaseStreamingCardRecovery(
  id: string,
  expectedRevision: number,
  error: string,
  nowInput?: Date | string,
): StreamingCardRecord | undefined {
  const connection = requireDatabase();
  const now = isoNow(nowInput);
  const changed = connection
    .prepare(
      `UPDATE streaming_cards
       SET status = 'streaming', error = ?, revision = revision + 1,
           updated_at = ?
       WHERE id = ? AND revision = ? AND status = 'recovering'`,
    )
    .run(error, now, id, expectedRevision);
  return changed.changes === 1 ? getStreamingCardRecord(id) : undefined;
}

/** Read all non-terminal cards in deterministic pages without a hard cap. */
export function listAllNonterminalStreamingCards(
  pageSize = 1_000,
): StreamingCardRecord[] {
  const connection = requireDatabase();
  const limit = Math.max(1, Math.min(10_000, Math.trunc(pageSize)));
  const cards: StreamingCardRecord[] = [];
  let updatedAfter = '';
  let idAfter = '';
  while (true) {
    const rows = connection
      .prepare(
        `SELECT * FROM streaming_cards
         WHERE status NOT IN ('completed','aborted','failed')
           AND (updated_at > ? OR (updated_at = ? AND id > ?))
         ORDER BY updated_at, id LIMIT ?`,
      )
      .all(updatedAfter, updatedAfter, idAfter, limit) as CardRow[];
    if (rows.length === 0) break;
    cards.push(...rows.map(mapCard));
    const last = rows[rows.length - 1];
    updatedAfter = last.updated_at;
    idAfter = last.id;
    if (rows.length < limit) break;
  }
  return cards;
}

export interface ChannelReliabilityNonterminalSnapshot {
  inbox: ChannelInboxItem[];
  turns: ChannelTurnRun[];
  outbox: ChannelOutboxItem[];
  cards: StreamingCardRecord[];
}

export function scanChannelReliabilityNonterminal(
  limitPerTable = 100,
): ChannelReliabilityNonterminalSnapshot {
  const connection = requireDatabase();
  const limit = Math.max(1, Math.min(10_000, Math.trunc(limitPerTable)));
  return {
    inbox: (
      connection
        .prepare(
          `SELECT * FROM channel_inbox
           WHERE status NOT IN ('processed','ignored','failed')
           ORDER BY updated_at, created_at LIMIT ?`,
        )
        .all(limit) as InboxRow[]
    ).map(mapInbox),
    turns: (
      connection
        .prepare(
          `SELECT * FROM turn_runs
           WHERE status NOT IN ('completed','failed','interrupted','cancelled')
           ORDER BY updated_at, created_at LIMIT ?`,
        )
        .all(limit) as TurnRow[]
    ).map(mapTurn),
    outbox: (
      connection
        .prepare(
          `SELECT * FROM channel_outbox
           WHERE status NOT IN ('delivered','failed','cancelled')
           ORDER BY updated_at, turn_run_id, ordinal LIMIT ?`,
        )
        .all(limit) as OutboxRow[]
    ).map(mapOutbox),
    cards: (
      connection
        .prepare(
          `SELECT * FROM streaming_cards
           WHERE status NOT IN ('completed','aborted','failed')
           ORDER BY updated_at, created_at LIMIT ?`,
        )
        .all(limit) as CardRow[]
    ).map(mapCard),
  };
}

export interface CleanupChannelReliabilityInput {
  /** Redact large request/output/card bodies while retaining idempotency receipts. */
  payloadsBefore: string;
  /** Delete terminal audit rows; should exceed every provider replay window. */
  recordsBefore?: string;
  /** Explicitly delete cursors for transports decommissioned before this time. */
  cursorsBefore?: string;
}

export function cleanupChannelReliability(
  input: CleanupChannelReliabilityInput,
): {
  inboxPayloadsCleared: number;
  turnResultsCleared: number;
  outboxPayloadsCleared: number;
  cardSnapshotsCleared: number;
  inboxDeleted: number;
  turnsDeleted: number;
  cursorsDeleted: number;
} {
  const connection = requireDatabase();
  return connection.transaction(() => {
    const inboxPayloadsCleared = connection
      .prepare(
        `UPDATE channel_inbox SET raw_payload = NULL, normalized_payload = NULL
         WHERE status IN ('processed','ignored','failed') AND updated_at < ?
           AND (raw_payload IS NOT NULL OR normalized_payload IS NOT NULL)`,
      )
      .run(input.payloadsBefore).changes;
    const outboxPayloadsCleared = connection
      .prepare(
        `UPDATE channel_outbox SET payload = NULL
         WHERE status IN ('delivered','failed','cancelled') AND updated_at < ?
           AND payload IS NOT NULL`,
      )
      .run(input.payloadsBefore).changes;
    const turnResultsCleared = connection
      .prepare(
        `UPDATE turn_runs SET result = NULL
         WHERE status IN ('completed','failed','interrupted','cancelled')
           AND updated_at < ? AND result IS NOT NULL`,
      )
      .run(input.payloadsBefore).changes;
    const cardSnapshotsCleared = connection
      .prepare(
        `UPDATE streaming_cards SET snapshot = NULL
         WHERE status IN ('completed','aborted','failed') AND updated_at < ?
           AND snapshot IS NOT NULL`,
      )
      .run(input.payloadsBefore).changes;
    let inboxDeleted = 0;
    let turnsDeleted = 0;
    let cursorsDeleted = 0;
    if (input.recordsBefore) {
      // Cascades remove outbox/cards before their terminal parent run.
      turnsDeleted = connection
        .prepare(
          `DELETE FROM turn_runs
           WHERE status IN ('completed','failed','interrupted','cancelled')
             AND updated_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM channel_outbox
               WHERE channel_outbox.turn_run_id = turn_runs.id
                 AND channel_outbox.status NOT IN ('delivered','failed','cancelled')
             )
             AND NOT EXISTS (
               SELECT 1 FROM streaming_cards
               WHERE streaming_cards.turn_run_id = turn_runs.id
                 AND streaming_cards.status NOT IN ('completed','aborted','failed')
             )`,
        )
        .run(input.recordsBefore).changes;
      inboxDeleted = connection
        .prepare(
          `DELETE FROM channel_inbox
           WHERE status IN ('processed','ignored','failed')
             AND updated_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM turn_runs
               WHERE turn_runs.inbox_id = channel_inbox.id
             )`,
        )
        .run(input.recordsBefore).changes;
    }
    if (input.cursorsBefore) {
      cursorsDeleted = connection
        .prepare('DELETE FROM channel_cursors WHERE updated_at < ?')
        .run(input.cursorsBefore).changes;
    }
    return {
      inboxPayloadsCleared,
      turnResultsCleared,
      outboxPayloadsCleared,
      cardSnapshotsCleared,
      inboxDeleted,
      turnsDeleted,
      cursorsDeleted,
    };
  })();
}

// Export terminal sets for health/recovery consumers without duplicating the
// schema contract. Freeze copies so callers cannot mutate module invariants.
export const CHANNEL_RELIABILITY_TERMINAL_STATUSES = Object.freeze({
  inbox: [...INBOX_TERMINAL],
  turns: [...TURN_TERMINAL],
  outbox: [...OUTBOX_TERMINAL],
  cards: [...CARD_TERMINAL],
});
