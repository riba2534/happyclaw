/**
 * Second login factors: a TOTP authenticator and its one-time recovery codes.
 *
 * db.ts binds this module to its connection; no other module touches these
 * tables directly. The TOTP secret is stored sealed (see sealSecret); a row
 * whose enabled_at is NULL is an enrolment awaiting its first code. Recovery
 * codes are stored only as SHA-256 hashes: they carry 50 random bits and the
 * login rate limit applies, so a slow hash adds nothing.
 */
import crypto from 'node:crypto';

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export interface UserTotpRow {
  user_id: string;
  secret_enc: string;
  enabled_at: string | null;
  last_used_step: number | null;
  created_at: string;
}

let database: SqliteDatabase | null = null;
const statements = new Map<string, SqliteStatement>();

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Auth factor store is not initialized');
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
export function initAuthFactorStore(db: SqliteDatabase | null): void {
  database = db;
  statements.clear();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_totp (
      user_id TEXT PRIMARY KEY,
      secret_enc TEXT NOT NULL,
      enabled_at TEXT,
      last_used_step INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_recovery_codes (
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY (user_id, code_hash)
    );
  `);
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function getUserTotp(userId: string): UserTotpRow | undefined {
  return stmt('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as
    | UserTotpRow
    | undefined;
}

export function isTotpEnabled(userId: string): boolean {
  return !!getUserTotp(userId)?.enabled_at;
}

/** Start (or restart) an enrolment; refuses while 2FA is on. */
export function savePendingTotp(
  userId: string,
  secretEnc: string,
  now = new Date().toISOString(),
): boolean {
  const result = stmt(
    `INSERT INTO user_totp (user_id, secret_enc, enabled_at, last_used_step, created_at)
     VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       secret_enc = excluded.secret_enc, created_at = excluded.created_at
     WHERE user_totp.enabled_at IS NULL`,
  ).run(userId, secretEnc, now);
  return result.changes > 0;
}

/** Turn a pending enrolment on and replace the recovery codes, atomically. */
export function enableTotp(
  userId: string,
  step: number,
  recoveryCodes: string[],
  now = new Date().toISOString(),
): boolean {
  return requireDatabase().transaction(() => {
    const result = stmt(
      `UPDATE user_totp SET enabled_at = ?, last_used_step = ?
       WHERE user_id = ? AND enabled_at IS NULL`,
    ).run(now, step, userId);
    if (result.changes === 0) return false;
    replaceRecoveryCodes(userId, recoveryCodes);
    return true;
  })();
}

/**
 * Record a used step. Only moves forward, so two requests racing with the
 * same code cannot both succeed.
 */
export function markTotpStepUsed(userId: string, step: number): boolean {
  const result = stmt(
    `UPDATE user_totp SET last_used_step = ?
     WHERE user_id = ? AND enabled_at IS NOT NULL
       AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).run(step, userId, step);
  return result.changes > 0;
}

export function replaceRecoveryCodes(userId: string, codes: string[]): void {
  requireDatabase().transaction(() => {
    stmt('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    for (const code of codes) {
      stmt(
        'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)',
      ).run(userId, hashRecoveryCode(code));
    }
  })();
}

/** Spend a recovery code; false when it is unknown or already used. */
export function consumeRecoveryCode(
  userId: string,
  code: string,
  now = new Date().toISOString(),
): boolean {
  const result = stmt(
    `UPDATE user_recovery_codes SET used_at = ?
     WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
  ).run(now, userId, hashRecoveryCode(code));
  return result.changes > 0;
}

export function remainingRecoveryCodes(userId: string): number {
  const row = stmt(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
  ).get(userId) as { n: number };
  return row.n;
}

/** Remove every second factor of a user (disable, admin reset, deletion). */
export function deleteAuthFactorsForUser(userId: string): void {
  requireDatabase().transaction(() => {
    stmt('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    stmt('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  })();
}
