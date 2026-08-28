import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  WEB_SESSION_SECRET,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from './config.js';
import { isSecureRequest } from './utils.js';

const BCRYPT_ROUNDS = 12;

// --- Password hashing ---

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
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
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  return { token, legacy: false };
}

/** Build a Set-Cookie header value for a session token (signs + flags secure/plain). */
export function setSessionCookie(c: any, token: string): string {
  const secure = isSecureRequest(c);
  const name = secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME_PLAIN;
  const secureSuffix = secure ? '; Secure' : '';
  const signedToken = signSessionToken(token);
  return `${name}=${signedToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}${secureSuffix}`;
}

/** Build a Set-Cookie header value that clears the session cookie. */
export function clearSessionCookie(c: any): string {
  const secure = isSecureRequest(c);
  const name = secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME_PLAIN;
  const secureSuffix = secure ? '; Secure' : '';
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureSuffix}`;
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

const loginAttempts = new Map<string, AttemptRecord>();

// Per-username global rate limit (防分布式暴力破解)
// 阈值为 per-ip 限制的 4 倍，窗口为 1 小时
const GLOBAL_USERNAME_MULTIPLIER = 4;
const GLOBAL_USERNAME_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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
    for (const [key, record] of loginAttempts) {
      if (now - record.firstAttempt > ATTEMPT_RECORD_RECLAIM_MS) {
        loginAttempts.delete(key);
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
  const record = loginAttempts.get(key);
  if (!record) return { allowed: true };

  if (now - record.firstAttempt > windowMs) {
    loginAttempts.delete(key);
    return { allowed: true };
  }

  if (record.count >= maxAttempts) {
    const retryAfter = Math.ceil((record.firstAttempt + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }

  return { allowed: true };
}

export function checkLoginRateLimit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number } {
  const windowMs = lockoutMinutes * 60 * 1000;

  // Check per-username:ip limit
  const ipCheck = checkAttemptRecord(`${username}:${ip}`, maxAttempts, windowMs);
  if (!ipCheck.allowed) return ipCheck;

  // Check per-username global limit (higher threshold, longer window)
  const globalMax = maxAttempts * GLOBAL_USERNAME_MULTIPLIER;
  const globalCheck = checkAttemptRecord(`user:${username}`, globalMax, GLOBAL_USERNAME_WINDOW_MS);
  if (!globalCheck.allowed) return globalCheck;

  return { allowed: true };
}

function incrementAttempt(key: string, now: number): void {
  const record = loginAttempts.get(key);
  if (record) {
    record.count += 1;
    record.lastAttempt = now;
  } else {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lastAttempt: now });
  }
}

export function recordLoginAttempt(username: string, ip: string): void {
  const now = Date.now();
  incrementAttempt(`${username}:${ip}`, now);
  incrementAttempt(`user:${username}`, now);
}

export function clearLoginAttempts(username: string, ip: string): void {
  // Only clear the per-IP record. The global per-username counter
  // (`user:${username}`) is intentionally left to expire via its TTL,
  // preventing an attacker from resetting the global rate limit by
  // successfully logging in from a known IP.
  loginAttempts.delete(`${username}:${ip}`);
}

// --- Session expiry ---

export function sessionExpiresAt(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function isSessionExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

// --- First-admin setup origin ---

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/**
 * True for IPv4 127.0.0.0/8, IPv6 ::1, IPv4-mapped loopback, and localhost.
 * Used by first-admin setup so a remote host cannot steal the initial admin
 * by hitting a publicly bound port.
 */
export function isLoopbackAddress(ip: string | null | undefined): boolean {
  if (!ip || typeof ip !== 'string') return false;
  let value = ip.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  if (value === 'localhost' || value === 'localhost.') return true;
  if (value === '::1') return true;

  if (/^127(?:\.(?:\d{1,3})){3}$/.test(value)) {
    return value.split('.').every((part) => {
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }

  // Node may emit ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (mapped.includes('.')) return isLoopbackAddress(mapped);
    const hex = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!hex) return false;
    return ((parseInt(hex[1], 16) >> 8) & 0xff) === 127;
  }

  return false;
}

function getDirectRemoteAddress(c: any): string {
  return (
    c?.env?.incoming?.socket?.remoteAddress ||
    c?.env?.remoteAddr ||
    c?.req?.raw?.socket?.remoteAddress ||
    ''
  );
}

/**
 * First-admin setup is loopback-only unless ALLOW_REMOTE_SETUP=1/true.
 *
 * X-Forwarded-For is untrusted unless the TCP peer is also loopback (a local
 * reverse proxy). A remote client spoofing XFF: 127.0.0.1 is rejected.
 * When the peer is loopback and XFF names a remote client, the request is
 * treated as remote.
 */
export function isLocalInitialSetupAllowed(c: any): boolean {
  if (isTruthyEnvFlag(process.env.ALLOW_REMOTE_SETUP)) return true;

  const socketIp = getDirectRemoteAddress(c);
  if (!isLoopbackAddress(socketIp)) return false;

  const xff = c?.req?.header?.('x-forwarded-for');
  if (xff) {
    const originalClient = xff.split(',')[0]?.trim();
    if (originalClient && !isLoopbackAddress(originalClient)) return false;
  }

  return true;
}
