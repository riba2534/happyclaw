import crypto from 'crypto';
import net from 'net';
import {
  WEB_SESSION_SECRET,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from './config.js';
import {
  comparePasswordOffThread,
  hashPasswordOffThread,
} from './password-hash-worker.js';
import { isSecureRequest } from './utils.js';

const BCRYPT_ROUNDS = 12;

// --- Password hashing ---
// bcryptjs runs in a worker pool (see password-hash-worker.ts) so a login
// burst doesn't stall the event loop; hashes and cost factor are unchanged.

export async function hashPassword(password: string): Promise<string> {
  return hashPasswordOffThread(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return comparePasswordOffThread(password, hash);
}

// --- Session token generation & HMAC signing ---

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Sign a session token with HMAC-SHA256. Returns `token.signature`. */
export function signSessionToken(token: string): string {
  const sig = crypto
    .createHmac('sha256', WEB_SESSION_SECRET)
    .update(token)
    .digest('hex');
  return `${token}.${sig}`;
}

export interface VerifiedToken {
  token: string;
  /** True when the cookie was a legacy unsigned token, caller should upgrade via Set-Cookie. */
  legacy: boolean;
}

// 旧版未签名 session cookie 平滑迁移开关。默认关：HMAC 签名是设计用来防止
// 数据库 / 备份 / 日志泄漏 raw session token 后被冒名登录，永久接受未签名
// cookie 让该防护形同虚设。运维需要在线升级时可以临时设
// ALLOW_LEGACY_UNSIGNED_COOKIE=true 重启一次让旧 cookie 自动升级，然后回到默认。
const ALLOW_LEGACY_UNSIGNED_COOKIE =
  process.env.ALLOW_LEGACY_UNSIGNED_COOKIE === 'true';

/** Verify and extract the raw token from a signed cookie value. Returns null if invalid. */
export function verifySessionToken(signedValue: string): VerifiedToken | null {
  const dotIndex = signedValue.lastIndexOf('.');
  if (dotIndex === -1) {
    if (!ALLOW_LEGACY_UNSIGNED_COOKIE) return null;
    // Legacy unsigned token — accept and flag for upgrade. Token must look
    // like a 32-byte hex string (the only shape generateSessionToken emits)
    // to avoid accepting arbitrary attacker-supplied junk.
    if (!/^[0-9a-f]{64}$/.test(signedValue)) return null;
    return { token: signedValue, legacy: true };
  }
  const token = signedValue.substring(0, dotIndex);
  const sig = signedValue.substring(dotIndex + 1);
  // HMAC-SHA256 hex digest is always 64 characters
  if (sig.length !== 64) return null;
  const expected = crypto
    .createHmac('sha256', WEB_SESSION_SECRET)
    .update(token)
    .digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }
  return { token, legacy: false };
}

// The session lives under `__Host-happyclaw_session` on HTTPS and under
// `happyclaw_session` on plain HTTP. Every write sets one name and expires the
// other, so a browser that moved between schemes cannot keep a stale session
// under the other name. Each value must be its own Set-Cookie line: several
// cookies joined into one header value are unparseable for browsers, which is
// why the raw values stay private to the helpers below.
function sessionCookieValues(c: any, token: string): string[] {
  const signed = signSessionToken(token);
  const maxAge = 30 * 24 * 60 * 60;

  if (isSecureRequest(c)) {
    return [
      `${SESSION_COOKIE_NAME_SECURE}=${signed}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}; Secure`,
      `${SESSION_COOKIE_NAME_PLAIN}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    ];
  }

  return [
    `${SESSION_COOKIE_NAME_PLAIN}=${signed}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
    `${SESSION_COOKIE_NAME_SECURE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`,
  ];
}

function clearedSessionCookieValues(): string[] {
  return [
    `${SESSION_COOKIE_NAME_SECURE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`,
    `${SESSION_COOKIE_NAME_PLAIN}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  ];
}

type HeadersInitValue = ConstructorParameters<typeof Headers>[0];

function headersWithSetCookies(
  init: HeadersInitValue,
  cookies: string[],
): Headers {
  const headers = new Headers(init);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return headers;
}

/** Response headers that store the signed session `token` for this request's scheme. */
export function sessionCookieHeaders(
  c: any,
  token: string,
  init?: HeadersInitValue,
): Headers {
  return headersWithSetCookies(init, sessionCookieValues(c, token));
}

/** Response headers that expire the session cookie under both names. */
export function clearedSessionCookieHeaders(init?: HeadersInitValue): Headers {
  return headersWithSetCookies(init, clearedSessionCookieValues());
}

/** Append the session cookies for `token` to the response a Hono context is building. */
export function appendSessionCookies(c: any, token: string): void {
  for (const cookie of sessionCookieValues(c, token)) {
    c.header('Set-Cookie', cookie, { append: true });
  }
}

export function generateUserId(): string {
  return crypto.randomUUID();
}

export function generateInviteCode(): string {
  return crypto.randomBytes(16).toString('hex');
}

// --- Input validation ---

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export function validateUsername(username: string): string | null {
  if (!username || typeof username !== 'string') return '用户名不能为空';
  if (!USERNAME_RE.test(username)) return '用户名须为3-32位字母、数字或下划线';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password || typeof password !== 'string') return '密码不能为空';
  if (password.length < PASSWORD_MIN)
    return `密码长度不能少于${PASSWORD_MIN}位`;
  if (password.length > PASSWORD_MAX)
    return `密码长度不能超过${PASSWORD_MAX}位`;
  return null;
}

// --- Login rate limiting ---

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
}

// Insertion order == firstAttempt order: records are mutated in place and only
// re-inserted after their window expired, so the first keys are the oldest.
// Per-username lockouts live in their own map so a flood of per-IP / pair
// records (one per sprayed address) can never evict them.
const clientAttempts = new Map<string, AttemptRecord>();
const userAttempts = new Map<string, AttemptRecord>();

function attemptMapFor(key: string): Map<string, AttemptRecord> {
  return key.startsWith('user:') ? userAttempts : clientAttempts;
}

// Per-username global rate limit (防分布式暴力破解)
// 阈值为 per-ip 限制的 4 倍，窗口为 1 小时
const GLOBAL_USERNAME_MULTIPLIER = 4;
const GLOBAL_USERNAME_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Per-client-IP bucket (防用户名轮换喷洒): the username-keyed buckets above are
// bypassed by trying a new username per attempt, so failures from one client
// are also counted regardless of username. Scales with the admin's
// maxLoginAttempts over the same lockout window: 5 × 6 = 30 failures / 15 min
// by default — loose enough for a shared office NAT, tight enough to stop
// spraying from a single address.
const PER_IP_MULTIPLIER = 6;

// Hard cap on tracked keys. Each failed attempt can insert up to three keys and
// records live up to 24h, so without a cap a spraying client could grow the
// map without bound. With the per-IP bucket one address adds at most
// ~2 × 30 + 1 keys per window, so filling the cap takes hundreds of addresses
// each paying a full bcrypt compare per key.
export const LOGIN_ATTEMPTS_MAX_ENTRIES = 10_000;
/** Cap of the separate per-username lockout map. */
export const LOGIN_LOCKOUT_MAX_ENTRIES = 10_000;
/** Eviction inspects this many of the oldest records and drops the weakest. */
const EVICTION_SCAN = 256;

// Memory reclamation only. The authoritative expiry check is in
// checkAttemptRecord (based on firstAttempt + the relevant window). This TTL
// must therefore be >= every possible rate-limit window, or records would be
// reclaimed early and an attacker could reset the global limit by pausing.
// lockoutMinutes is runtime-configurable, so use a generous upper bound and
// key the reclamation on firstAttempt (not lastAttempt) to match the window
// semantics used by checkAttemptRecord.
const ATTEMPT_RECORD_RECLAIM_MS = Math.max(
  24 * 60 * 60 * 1000, // 24h safety upper bound
  GLOBAL_USERNAME_WINDOW_MS,
);
const loginAttemptsCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const map of [clientAttempts, userAttempts]) {
      for (const [key, record] of map) {
        if (now - record.firstAttempt > ATTEMPT_RECORD_RECLAIM_MS) {
          map.delete(key);
        }
      }
    }
  },
  10 * 60 * 1000,
);
// Don't keep short-lived CLI scripts (e.g. reset-admin) alive just for this
// housekeeping timer.
loginAttemptsCleanupTimer.unref?.();

function checkAttemptRecord(
  key: string,
  maxAttempts: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const map = attemptMapFor(key);
  const record = map.get(key);
  if (!record) return { allowed: true };

  if (now - record.firstAttempt > windowMs) {
    map.delete(key);
    return { allowed: true };
  }

  if (record.count >= maxAttempts) {
    const retryAfter = Math.ceil((record.firstAttempt + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }

  return { allowed: true };
}

// Usernames are capped by LoginSchema, and the client IP comes from the
// trusted proxy hop, but either can still be long or client-influenced.
// Over-long key parts are replaced by a digest so a single key stays small;
// real IPs and usernames are far below the bound and stay verbatim.
const MAX_KEY_PART_LENGTH = 64;

function boundedKeyPart(value: string): string {
  if (value.length <= MAX_KEY_PART_LENGTH) return value;
  return `#${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export interface LoginRateLimitOptions {
  /**
   * Also apply the per-client-IP bucket. Default true (login). Registration
   * keeps its own `register:${ip}` bucket and opts out so sign-ups and failed
   * logins don't drain each other's budget.
   */
  perIp?: boolean;
}

/**
 * Key for the per-IP bucket. IPv6 clients usually control a whole /64, so
 * rotating the interface ID must not mint a fresh bucket; IPv4-mapped IPv6
 * collapses to its IPv4 form. Returns null when the address can't identify a
 * client: `unknown` (no socket address) and loopback, which is what every
 * request looks like behind a same-host reverse proxy without TRUST_PROXY —
 * bucketing that would lock the whole site out after a few dozen failures.
 */
function ipBucketKey(ip: string): string | null {
  const raw = boundedKeyPart(ip.trim().toLowerCase());
  if (!raw || raw === 'unknown') return null;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const addr = mapped ? mapped[1] : raw;
  if (net.isIPv4(addr)) {
    return addr.startsWith('127.') ? null : `ip:${addr}`;
  }
  if (net.isIPv6(addr)) {
    if (addr === '::1') return null;
    const [head, tail = ''] = addr.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    const groups = addr.includes('::')
      ? [...headGroups, ...Array(Math.max(0, missing)).fill('0'), ...tailGroups]
      : headGroups;
    const prefix = groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ''))
      .join(':');
    return `ip:${prefix}::/64`;
  }
  return `ip:${addr}`;
}

/** The three bucket keys one login attempt is counted under. */
function attemptKeys(
  username: string,
  ip: string,
  options: LoginRateLimitOptions,
): { ipKey: string | null; pairKey: string; userKey: string } {
  const user = boundedKeyPart(username);
  return {
    ipKey: options.perIp === false ? null : ipBucketKey(ip),
    // Distinct prefixes and a NUL separator: a username can contain ':' and
    // must never alias another bucket's key.
    pairKey: `pair:${user}\0${boundedKeyPart(ip)}`,
    userKey: `user:${user}`,
  };
}

export function checkLoginRateLimit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
  options: LoginRateLimitOptions = {},
): { allowed: boolean; retryAfterSeconds?: number } {
  const windowMs = lockoutMinutes * 60 * 1000;
  const { ipKey, pairKey, userKey } = attemptKeys(username, ip, options);

  // Per-client-IP bucket first: it is the one username rotation can't dodge.
  if (ipKey) {
    const ipBucketCheck = checkAttemptRecord(
      ipKey,
      maxAttempts * PER_IP_MULTIPLIER,
      windowMs,
    );
    if (!ipBucketCheck.allowed) return ipBucketCheck;
  }

  // Check per-username:ip limit
  const ipCheck = checkAttemptRecord(pairKey, maxAttempts, windowMs);
  if (!ipCheck.allowed) return ipCheck;

  // Check per-username global limit (higher threshold, longer window)
  const globalMax = maxAttempts * GLOBAL_USERNAME_MULTIPLIER;
  const globalCheck = checkAttemptRecord(
    userKey,
    globalMax,
    GLOBAL_USERNAME_WINDOW_MS,
  );
  if (!globalCheck.allowed) return globalCheck;

  return { allowed: true };
}

/**
 * Make room for one record: among the oldest EVICTION_SCAN records drop the
 * one with the fewest failures (ties: the oldest), so records that enforce a
 * lockout outlive throwaway one-attempt records.
 */
function evictOne(map: Map<string, AttemptRecord>): void {
  let victim: string | undefined;
  let victimCount = Infinity;
  let scanned = 0;
  for (const [key, record] of map) {
    if (record.count < victimCount) {
      victim = key;
      victimCount = record.count;
      if (victimCount <= 1) break;
    }
    if (++scanned >= EVICTION_SCAN) break;
  }
  if (victim !== undefined) map.delete(victim);
}

function incrementAttempt(key: string, now: number): void {
  const map = attemptMapFor(key);
  const record = map.get(key);
  if (record) {
    record.count += 1;
    record.lastAttempt = now;
    return;
  }
  const cap =
    map === userAttempts
      ? LOGIN_LOCKOUT_MAX_ENTRIES
      : LOGIN_ATTEMPTS_MAX_ENTRIES;
  while (map.size >= cap) evictOne(map);
  map.set(key, { count: 1, firstAttempt: now, lastAttempt: now });
}

function decrementAttempt(key: string): void {
  const map = attemptMapFor(key);
  const record = map.get(key);
  if (!record) return;
  record.count -= 1;
  if (record.count <= 0) map.delete(key);
}

export function recordLoginAttempt(
  username: string,
  ip: string,
  options: LoginRateLimitOptions = {},
): void {
  const now = Date.now();
  const { ipKey, pairKey, userKey } = attemptKeys(username, ip, options);
  if (ipKey) incrementAttempt(ipKey, now);
  incrementAttempt(pairKey, now);
  incrementAttempt(userKey, now);
}

export function clearLoginAttempts(username: string, ip: string): void {
  // Only clear the per-IP record. The global per-username counter
  // (`user:${username}`) is intentionally left to expire via its TTL,
  // preventing an attacker from resetting the global rate limit by
  // successfully logging in from a known IP. The per-client-IP bucket is
  // likewise left alone, or one valid account would reset spraying limits.
  clientAttempts.delete(attemptKeys(username, ip, {}).pairKey);
}

/**
 * Check every bucket and, when allowed, count the attempt in all of them in
 * the same synchronous step. Counting only after the awaited bcrypt compare
 * let N concurrent attempts all pass the check before any was recorded (60
 * parallel failures from one IP all reached bcrypt and none got 429).
 * Settle the reservation with {@link settleLoginAttempt} once the outcome is
 * known.
 */
export function reserveLoginAttempt(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
  options: LoginRateLimitOptions = {},
): { allowed: boolean; retryAfterSeconds?: number } {
  const check = checkLoginRateLimit(
    username,
    ip,
    maxAttempts,
    lockoutMinutes,
    options,
  );
  if (check.allowed) recordLoginAttempt(username, ip, options);
  return check;
}

/**
 * Settle a reserved attempt. A failure keeps the counts. A success refunds
 * this attempt's per-IP and per-username increments (earlier failures stay
 * counted, as before) and clears the username+IP pair. An attempt that was
 * never evaluated (password hashing overloaded) refunds all three.
 */
export function settleLoginAttempt(
  username: string,
  ip: string,
  outcome: 'failure' | 'success' | 'not_evaluated',
  options: LoginRateLimitOptions = {},
): void {
  if (outcome === 'failure') return;
  const { ipKey, pairKey, userKey } = attemptKeys(username, ip, options);
  if (ipKey) decrementAttempt(ipKey);
  decrementAttempt(userKey);
  if (outcome === 'success') clientAttempts.delete(pairKey);
  else decrementAttempt(pairKey);
}

/** Tracked rate-limit keys, for tests and diagnostics. */
export function loginAttemptStats(): {
  entries: number;
  clientEntries: number;
  userEntries: number;
  maxKeyLength: number;
} {
  let maxKeyLength = 0;
  for (const map of [clientAttempts, userAttempts]) {
    for (const key of map.keys()) {
      maxKeyLength = Math.max(maxKeyLength, key.length);
    }
  }
  return {
    entries: clientAttempts.size + userAttempts.size,
    clientEntries: clientAttempts.size,
    userEntries: userAttempts.size,
    maxKeyLength,
  };
}

/** Test-only: forget all rate-limit state. */
export function resetLoginAttemptsForTest(): void {
  clientAttempts.clear();
  userAttempts.clear();
}

// --- Session expiry ---

export function sessionExpiresAt(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function isSessionExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
