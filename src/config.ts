import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CronExpressionParser } from 'cron-parser';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'HappyClaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
// Conversation/spawn sessions with no activity for this long are archived to
// 'completed'; a new message in the bound thread still revives the session.
export const CONVERSATION_AGENT_ARCHIVE_DAYS = 30;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

// Mount security: allowlist in project config/ directory
export const MOUNT_ALLOWLIST_PATH = path.resolve(
  PROJECT_ROOT,
  'config',
  'mount-allowlist.json',
);
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'db');
export const GROUPS_DIR = path.join(DATA_DIR, 'groups');
export const MAIN_GROUP_FOLDER = 'main';

// 文件大小上限（MB）。Web 文件面板上传与 IM 渠道收文件（feishu/telegram/qq/
// dingtalk/discord/wechat inbound）共用此上限。注意：Web 下载是流式返回已存在
// 的文件，不受此上限约束。通过 MAX_FILE_SIZE_MB 环境变量调整（默认 50MB）；
// 非法值回退到 50。
const _maxFileSizeMb = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
export const MAX_FILE_SIZE_MB =
  Number.isFinite(_maxFileSizeMb) && _maxFileSizeMb > 0 ? _maxFileSizeMb : 50;
export const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'riba2534/happyclaw-agent:latest';

export function deriveContainerProfileImage(
  image: string,
  profile: 'headroom',
): string | null {
  if (image.includes('@')) return null;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  const repository = colon > slash ? image.slice(0, colon) : image;
  const tag = colon > slash ? image.slice(colon + 1) : 'latest';
  return `${repository}:${tag}-${profile}`;
}

export const CONTAINER_IMAGE_HEADROOM =
  process.env.CONTAINER_IMAGE_HEADROOM ||
  deriveContainerProfileImage(CONTAINER_IMAGE, 'headroom') ||
  '';

export interface ContainerProxyConfig {
  httpsProxy: string;
  httpProxy: string;
  noProxy: string;
}

/**
 * Read the host proxy variables forwarded to container agents. Each variable
 * is independent, and lower-case aliases are accepted for common shell setups.
 */
export function readContainerProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContainerProxyConfig {
  return {
    httpsProxy: env.HTTPS_PROXY || env.https_proxy || '',
    httpProxy: env.HTTP_PROXY || env.http_proxy || '',
    noProxy: env.NO_PROXY || env.no_proxy || '',
  };
}

// These values are written to the per-container 0600 runtime env file instead
// of docker argv, keeping credentials out of process listings and debug logs.
const CONTAINER_PROXY_CONFIG = readContainerProxyConfig();
export const CONTAINER_HTTPS_PROXY = CONTAINER_PROXY_CONFIG.httpsProxy;
export const CONTAINER_HTTP_PROXY = CONTAINER_PROXY_CONFIG.httpProxy;
export const CONTAINER_NO_PROXY = CONTAINER_PROXY_CONFIG.noProxy;

// Timezone for scheduled tasks (cron expressions, etc.). The resolved zone is
// also the TZ of the main process and host agents/script tasks (src/index.ts)
// and of containers (`docker run -e TZ`), so it must mean the same clock to
// cron-parser, Intl and libc.

/** Whether the scheduler's cron parser can evaluate schedules in `zone`. */
function cronAcceptsTimeZone(zone: string): boolean {
  try {
    CronExpressionParser.parse('0 0 * * *', { tz: zone }).next();
    return true;
  } catch {
    return false;
  }
}

function intlTimeZoneName(zone: string): string | null {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions()
        .timeZone ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Return the zone as a correctly cased IANA region/alias name, or null when it
 * is not one. glibc looks TZ up case-sensitively in zoneinfo (`asia/shanghai`
 * silently becomes UTC), so the case is repaired from Intl. The name itself is
 * kept: Intl's canonical form can be a legacy CLDR alias (`Asia/Kolkata` ->
 * `Asia/Calcutta`) that some zoneinfo installs no longer ship.
 */
function ianaTimeZoneName(zone: string): string | null {
  const intlName = intlTimeZoneName(zone);
  // Intl also accepts offset zones such as "+08:00"; those are not IANA names.
  if (!intlName || !/^[A-Za-z]/.test(intlName) || !cronAcceptsTimeZone(zone)) {
    return null;
  }
  return intlName.toLowerCase() === zone.toLowerCase() ? intlName : zone;
}

// Fixed offsets cron-parser understands: luxon's "UTC±H[:MM]" specifier and
// Intl's canonical "±HH:MM" offset zone.
const LUXON_UTC_OFFSET_RE = /^utc(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/i;
const INTL_UTC_OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;

function parseUtcOffsetMinutes(zone: string): number | null {
  const match = LUXON_UTC_OFFSET_RE.exec(zone) ?? INTL_UTC_OFFSET_RE.exec(zone);
  if (!match) return null;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const offset = (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
  // Real zones span UTC-12..UTC+14; anything else is a typo, not a clock.
  if (minutes > 59 || offset < -12 * 60 || offset > 14 * 60) return null;
  return offset;
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

type NormalizedTimeZone = {
  timezone: string;
  /** False when the zone has no IANA name libc could read identically. */
  libcCompatible: boolean;
};

/**
 * Normalize a zone the cron parser accepts into the name exported to child
 * processes, or return null when the scheduler cannot use it.
 *
 * cron-parser also accepts "UTC+8"-style offsets, but libc (and Node's local
 * clock) read those with POSIX semantics, where "UTC+8" means UTC-8. Whole-hour
 * offsets are therefore rewritten to the equivalent "Etc/GMT∓N" IANA zone
 * (whose sign follows the same POSIX convention: Etc/GMT-8 is UTC+8). Other
 * offsets have no IANA equivalent; they become an Intl offset zone ("+05:30"),
 * which the scheduler and the agent runner's Intl clock understand but libc
 * does not.
 */
function normalizeTimeZone(zone: string): NormalizedTimeZone | null {
  const ianaName = ianaTimeZoneName(zone);
  if (ianaName) return { timezone: ianaName, libcCompatible: true };
  if (!cronAcceptsTimeZone(zone)) return null;
  const offset = parseUtcOffsetMinutes(intlTimeZoneName(zone) ?? zone);
  // Remaining cron-parser keywords ("local", "system") name no fixed clock.
  if (offset === null) return null;
  if (offset === 0) return { timezone: 'UTC', libcCompatible: true };
  if (offset % 60 === 0) {
    const hours = offset / 60;
    return {
      timezone: `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`,
      libcCompatible: true,
    };
  }
  const intlOffset = formatUtcOffset(offset);
  return {
    timezone: cronAcceptsTimeZone(intlOffset) ? intlOffset : zone,
    libcCompatible: false,
  };
}

export type SchedulerTimezoneResolution = {
  timezone: string;
  source: 'env' | 'system' | 'fallback';
  /** The ignored TZ value when it had to fall back. */
  invalidValue: string | null;
  /** The TZ value when it is a UTC offset libc cannot represent. */
  libcIncompatibleValue: string | null;
};

/**
 * Resolve the scheduler timezone. An unusable TZ never fails startup: it falls
 * back to the system zone, then to the built-in default (IANA names only), and
 * the caller reports the ignored value.
 *
 * `TZ` accepts any string and Node silently falls back to UTC for names it does
 * not know, but `cron-parser` throws `CronDate: unhandled timestamp` for them.
 * Values users commonly copy from container docs (`GMT+8`, `GMT+0800`) are in
 * that second group, and an unvalidated value would fail *every* cron task
 * operation with an error that never mentions the timezone. Surrounding
 * whitespace is normalized because it is a likely `.env` artifact (JS Date
 * tolerates it, the cron parser does not).
 */
export function resolveSchedulerTimezone(
  envValue: string | undefined,
  systemZone: string | undefined,
  fallbackZone: string,
): SchedulerTimezoneResolution {
  const candidate = envValue?.trim();
  let invalidValue: string | null = null;
  if (candidate) {
    const normalized = normalizeTimeZone(candidate);
    if (normalized) {
      return {
        timezone: normalized.timezone,
        source: 'env',
        invalidValue: null,
        libcIncompatibleValue: normalized.libcCompatible ? null : candidate,
      };
    }
    invalidValue = candidate;
  }
  const system = systemZone?.trim();
  const systemName = system ? ianaTimeZoneName(system) : null;
  if (systemName) {
    return {
      timezone: systemName,
      source: 'system',
      invalidValue,
      libcIncompatibleValue: null,
    };
  }
  return {
    timezone: fallbackZone,
    source: 'fallback',
    invalidValue,
    libcIncompatibleValue: null,
  };
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const schedulerTimezone = resolveSchedulerTimezone(
  process.env.TZ,
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  DEFAULT_TIMEZONE,
);

export const TIMEZONE = schedulerTimezone.timezone;

// config.ts is imported before the logger exists, so TZ problems are reported
// on stderr instead of silently changing the scheduling clock.
if (schedulerTimezone.invalidValue !== null) {
  console.warn(
    `[happyclaw] TZ="${schedulerTimezone.invalidValue}" is not a time zone ` +
      `the scheduler can use; falling back to "${TIMEZONE}" ` +
      `(${schedulerTimezone.source}). Set TZ to an IANA name such as ` +
      `"Asia/Shanghai" or "UTC".`,
  );
} else if (schedulerTimezone.libcIncompatibleValue !== null) {
  console.warn(
    `[happyclaw] TZ="${schedulerTimezone.libcIncompatibleValue}" is a UTC ` +
      `offset without an IANA zone name. Cron schedules use "${TIMEZONE}", ` +
      `but one-time task times, shells and other libc-based tools in agents ` +
      `and script tasks cannot represent it. Set TZ to your region's IANA ` +
      `name (such as "Asia/Kolkata") instead.`,
  );
}

// Web server configuration
export const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

// Cookie configuration
// When accessed over HTTPS: use __Host- prefix (requires Secure; Path=/; no Domain)
// When accessed over HTTP (localhost dev or no TLS): use plain name
// Determined per-request via isSecureRequest(), not at startup
export const SESSION_COOKIE_NAME_SECURE = '__Host-happyclaw_session';
export const SESSION_COOKIE_NAME_PLAIN = 'happyclaw_session';
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'config', 'session-secret.key');

function getOrCreateSessionSecret(): string {
  // 1. Environment variable (highest priority — allows container/operator override)
  if (process.env.WEB_SESSION_SECRET) {
    return process.env.WEB_SESSION_SECRET;
  }

  // 2. File-persisted secret (survives restarts)
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const stored = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored) return stored;
    }
  } catch {
    // ignore read errors, fall through
  }

  // 3. Generate and persist
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, generated + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // non-fatal: secret works for this process, just won't survive restart
  }
  return generated;
}

export const WEB_SESSION_SECRET = getOrCreateSessionSecret();

// Proxy trust configuration
// Set TRUST_PROXY=true when behind a reverse proxy (nginx, Cloudflare, etc.)
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Docker availability check (cached for the lifetime of the process)
const execFileAsync = promisify(execFile);
let _dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    await execFileAsync('docker', ['info'], { timeout: 10000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}
