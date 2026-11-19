/**
 * Login factors beyond the password: a TOTP authenticator with its one-time
 * recovery codes, and passkeys (WebAuthn credentials).
 *
 * db.ts binds this module to its connection; no other module touches these
 * tables directly. The TOTP secret is stored sealed (see sealSecret); a row
 * whose enabled_at is NULL is an enrolment awaiting its first code. Recovery
 * codes are stored only as salted SHA-256 hashes, each with its own random
 * salt: they carry 50 random bits and the login rate limit applies, so a slow
 * hash adds nothing. They need no key, so they still work when the sealing
 * key is lost and the authenticator can no longer be checked.
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user
      ON user_recovery_codes(user_id);
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
      ON webauthn_credentials(user_id);
  `);
}

/** Case and separators do not matter: `ABCDE-FGHIJ` is `abcdefghij`. */
function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashRecoveryCode(salt: Buffer, code: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(salt)
    .update(normalizeRecoveryCode(code))
    .digest();
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
      const salt = crypto.randomBytes(16);
      stmt(
        'INSERT INTO user_recovery_codes (user_id, salt, code_hash) VALUES (?, ?, ?)',
      ).run(
        userId,
        salt.toString('hex'),
        hashRecoveryCode(salt, code).toString('hex'),
      );
    }
  })();
}

/**
 * Spend a recovery code; false when it is unknown or already used. Every
 * unused code is compared, in constant time, whatever matches.
 */
export function consumeRecoveryCode(
  userId: string,
  code: string,
  now = new Date().toISOString(),
): boolean {
  return requireDatabase().transaction(() => {
    const rows = stmt(
      'SELECT id, salt, code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    ).all(userId) as Array<{ id: number; salt: string; code_hash: string }>;
    let matched: number | null = null;
    for (const row of rows) {
      const expected = Buffer.from(row.code_hash, 'hex');
      const actual = hashRecoveryCode(Buffer.from(row.salt, 'hex'), code);
      if (
        expected.length === actual.length &&
        crypto.timingSafeEqual(expected, actual)
      ) {
        matched = row.id;
      }
    }
    if (matched === null) return false;
    return (
      stmt(
        'UPDATE user_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
      ).run(now, matched).changes > 0
    );
  })();
}

export function remainingRecoveryCodes(userId: string): number {
  const row = stmt(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
  ).get(userId) as { n: number };
  return row.n;
}

/** Remove the authenticator and recovery codes (disable, admin reset). */
export function deleteTwoFactorForUser(userId: string): void {
  requireDatabase().transaction(() => {
    stmt('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    stmt('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  })();
}

/** Remove every login factor of a user, passkeys included (deletion). */
export function deleteAuthFactorsForUser(userId: string): void {
  requireDatabase().transaction(() => {
    deleteTwoFactorForUser(userId);
    deletePasskeysForUser(userId);
  })();
}

// --- Passkeys ---

export interface PasskeyRow {
  /** Credential ID, base64url. */
  id: string;
  user_id: string;
  /** The RP ID (host name) it was created for; only usable there. */
  rp_id: string;
  /** COSE public key, base64url. */
  public_key: string;
  counter: number;
  /** JSON array of transports, or null. */
  transports: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export function insertPasskey(row: Omit<PasskeyRow, 'last_used_at'>): void {
  stmt(
    `INSERT INTO webauthn_credentials
       (id, user_id, rp_id, public_key, counter, transports, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.user_id,
    row.rp_id,
    row.public_key,
    row.counter,
    row.transports,
    row.name,
    row.created_at,
  );
}

export function getPasskey(id: string): PasskeyRow | undefined {
  return stmt('SELECT * FROM webauthn_credentials WHERE id = ?').get(id) as
    | PasskeyRow
    | undefined;
}

export function listPasskeys(userId: string): PasskeyRow[] {
  return stmt(
    'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at',
  ).all(userId) as PasskeyRow[];
}

export function countPasskeys(userId: string): number {
  const row = stmt(
    'SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?',
  ).get(userId) as { n: number };
  return row.n;
}

/** Remove all of a user's passkeys (admin revocation); returns how many. */
export function deletePasskeysForUser(userId: string): number {
  return stmt('DELETE FROM webauthn_credentials WHERE user_id = ?').run(userId)
    .changes;
}

export function recordPasskeyUse(
  id: string,
  counter: number,
  now = new Date().toISOString(),
): void {
  stmt(
    'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
  ).run(counter, now, id);
}

export function renamePasskey(
  userId: string,
  id: string,
  name: string,
): boolean {
  return (
    stmt(
      'UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?',
    ).run(name, id, userId).changes > 0
  );
}

export function deletePasskey(userId: string, id: string): boolean {
  return (
    stmt('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(
      id,
      userId,
    ).changes > 0
  );
}
