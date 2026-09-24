import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses TZ env var with Asia/Shanghai fallback.

/** Whether the runtime can resolve this zone name (IANA, case-insensitive). */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type SchedulerTimezoneResolution = {
  timezone: string;
  source: 'env' | 'system' | 'fallback';
  invalidValue: string | null;
};

/**
 * Resolve the scheduler timezone to a zone name the cron parser can
 * interpret.
 *
 * `TZ` accepts any string and Node silently falls back to UTC for names it does
 * not know, but `cron-parser` throws `CronDate: unhandled timestamp` for them.
 * Values users commonly copy from container docs (`GMT+8`, `GMT+0800`) are in
 * that second group, and an unvalidated value would fail *every* cron task
 * operation with an error that never mentions the timezone. Resolving the zone
 * once keeps the scheduler, the container environment and the UI on a usable
 * name; surrounding whitespace is normalized because it is a likely `.env`
 * artifact (JS Date tolerates it, the cron parser does not).
 */
export function resolveSchedulerTimezone(
  envValue: string | undefined,
  systemZone: string | undefined,
  fallbackZone: string,
): SchedulerTimezoneResolution {
  const candidate = envValue?.trim();
  if (candidate) {
    if (isValidTimeZone(candidate)) {
      return { timezone: candidate, source: 'env', invalidValue: null };
    }
    const invalidValue = candidate;
    const usableSystem = systemZone?.trim();
    if (usableSystem && isValidTimeZone(usableSystem)) {
      return { timezone: usableSystem, source: 'system', invalidValue };
    }
    return { timezone: fallbackZone, source: 'fallback', invalidValue };
  }
  const usableSystem = systemZone?.trim();
  if (usableSystem && isValidTimeZone(usableSystem)) {
    return { timezone: usableSystem, source: 'system', invalidValue: null };
  }
  return { timezone: fallbackZone, source: 'fallback', invalidValue: null };
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const schedulerTimezone = resolveSchedulerTimezone(
  process.env.TZ,
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  DEFAULT_TIMEZONE,
);

export const TIMEZONE = schedulerTimezone.timezone;

// config.ts is imported before the logger exists, so a misconfigured zone is
// reported on stderr instead of silently changing the scheduling clock.
if (schedulerTimezone.invalidValue !== null) {
  console.error(
    `[happyclaw] Ignoring invalid TZ="${schedulerTimezone.invalidValue}": ` +
      `not a recognizable time zone name. Scheduled tasks now use ` +
      `"${TIMEZONE}" (${schedulerTimezone.source}). Set TZ to an IANA name ` +
      `such as "Asia/Shanghai" or "UTC".`,
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
