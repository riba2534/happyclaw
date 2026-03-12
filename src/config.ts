import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'HappyClaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

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

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'happyclaw-agent:latest';
export const IPC_POLL_INTERVAL = 1000;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Web server configuration
export const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

// Cookie configuration
// Production (non-localhost): use __Host- prefix (requires Secure; Path=/; no Domain)
// Development (localhost): use plain name (no Secure flag needed)
const isProduction = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE_NAME = isProduction
  ? '__Host-happyclaw_session'
  : 'happyclaw_session';
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
