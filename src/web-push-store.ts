/**
 * Web Push subscriptions: one row per browser push endpoint, owned by the
 * user who registered it.
 *
 * db.ts binds this module to its connection; no other module touches the
 * table directly. The endpoint is the key: it identifies one browser
 * installation. Each row also records the login session that registered it
 * and goes away with that session (logout, revocation, a password change or
 * reset, disabling the account, expiry): a device signed out of HappyClaw
 * gets no more of its notifications. An endpoint another account holds is
 * never moved over silently; see upsertWebPushSubscription.
 */

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
}

export interface WebPushSubscription {
  endpoint: string;
  user_id: string;
  /** user_sessions.id of the login that registered it. */
  session_id: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
}

export interface WebPushSubscriptionInput {
  endpoint: string;
  userId: string;
  sessionId: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

let database: SqliteDatabase | null = null;
const statements = new Map<string, SqliteStatement>();

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Web push store is not initialized');
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

/** Create the table (idempotent) and bind the store; null unbinds it. */
export function initWebPushStore(db: SqliteDatabase | null): void {
  database = db;
  statements.clear();
  if (!db) return;
  // An earlier build created the table without session_id. Its rows are not
  // tied to a login, so they are dropped with it; browsers register again.
  const columns = db
    .prepare('PRAGMA table_info(web_push_subscriptions)')
    .all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((c) => c.name === 'session_id')) {
    db.exec('DROP TABLE web_push_subscriptions');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_success_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
      ON web_push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_session
      ON web_push_subscriptions(session_id);
  `);
  // Every way a login session ends deletes its row in user_sessions; the
  // trigger follows all of them, also with foreign keys switched off.
  const hasSessions = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_sessions'",
    )
    .get();
  if (hasSessions) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_web_push_subscriptions_session_end
      AFTER DELETE ON user_sessions
      BEGIN
        DELETE FROM web_push_subscriptions WHERE session_id = OLD.id;
      END;
    `);
  }
}

export type WebPushUpsertResult =
  | 'stored'
  /**
   * The endpoint was registered by another account. That row is deleted and
   * nothing is stored: the browser must unsubscribe, and this account opt in
   * again with a new subscription.
   */
  | 'conflict';

/**
 * Store or refresh the caller's subscription. Re-registering one's own
 * endpoint (a refresh, a new login) moves it to the current session.
 */
export function upsertWebPushSubscription(
  input: WebPushSubscriptionInput,
  now = new Date().toISOString(),
): WebPushUpsertResult {
  const existing = getWebPushSubscription(input.endpoint);
  if (existing && existing.user_id !== input.userId) {
    deleteWebPushSubscriptionByEndpoint(input.endpoint);
    return 'conflict';
  }
  stmt(
    `INSERT INTO web_push_subscriptions
       (endpoint, user_id, session_id, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       session_id = excluded.session_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       updated_at = excluded.updated_at
     WHERE web_push_subscriptions.user_id = excluded.user_id`,
  ).run(
    input.endpoint,
    input.userId,
    input.sessionId,
    input.p256dh,
    input.auth,
    input.userAgent ?? null,
    now,
    now,
  );
  return 'stored';
}

export function listWebPushSubscriptions(
  userId: string,
): WebPushSubscription[] {
  return stmt(
    `SELECT * FROM web_push_subscriptions
     WHERE user_id = ? ORDER BY created_at ASC, endpoint ASC`,
  ).all(userId) as WebPushSubscription[];
}

export function getWebPushSubscription(
  endpoint: string,
): WebPushSubscription | undefined {
  return stmt('SELECT * FROM web_push_subscriptions WHERE endpoint = ?').get(
    endpoint,
  ) as WebPushSubscription | undefined;
}

/** Remove one endpoint of `userId`; another user's endpoint is left alone. */
export function deleteWebPushSubscription(
  endpoint: string,
  userId: string,
): boolean {
  return (
    stmt(
      'DELETE FROM web_push_subscriptions WHERE endpoint = ? AND user_id = ?',
    ).run(endpoint, userId).changes > 0
  );
}

/** Remove an endpoint the push service reported gone (404 / 410). */
export function deleteWebPushSubscriptionByEndpoint(endpoint: string): boolean {
  return (
    stmt('DELETE FROM web_push_subscriptions WHERE endpoint = ?').run(endpoint)
      .changes > 0
  );
}

/**
 * The user's subscriptions past the newest `keep` by last registration: the
 * ones a device stopped refreshing.
 */
export function listStaleWebPushSubscriptions(
  userId: string,
  keep: number,
): WebPushSubscription[] {
  return stmt(
    `SELECT * FROM web_push_subscriptions
     WHERE user_id = ? ORDER BY updated_at DESC, endpoint DESC
     LIMIT -1 OFFSET ?`,
  ).all(userId, Math.max(0, keep)) as WebPushSubscription[];
}

/**
 * Move a session's subscriptions to the session replacing it, so the device
 * that changed the password keeps its push while the old session ends.
 */
export function moveWebPushSubscriptionsToSession(
  userId: string,
  fromSessionId: string,
  toSessionId: string,
): number {
  return stmt(
    `UPDATE web_push_subscriptions SET session_id = ?
     WHERE user_id = ? AND session_id = ?`,
  ).run(toSessionId, userId, fromSessionId).changes;
}

export function deleteWebPushSubscriptionsForUser(userId: string): number {
  return stmt('DELETE FROM web_push_subscriptions WHERE user_id = ?').run(
    userId,
  ).changes;
}

export function markWebPushSuccess(
  endpoint: string,
  now = new Date().toISOString(),
): void {
  stmt(
    'UPDATE web_push_subscriptions SET last_success_at = ? WHERE endpoint = ?',
  ).run(now, endpoint);
}
