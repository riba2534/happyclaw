import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import {
  ASSISTANT_NAME,
  IS_PRODUCTION,
  WEB_PORT,
  WEB_SESSION_SECRET as WEB_SESSION_SECRET_ENV,
  TRUST_PROXY,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  TELEGRAM_BOT_TOKEN,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_HOST_PROCESSES,
  TIMEZONE,
} from './environment.js';

export {
  ASSISTANT_NAME,
  WEB_PORT,
  TRUST_PROXY,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  TELEGRAM_BOT_TOKEN,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_HOST_PROCESSES,
  TIMEZONE,
};

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

export const IPC_POLL_INTERVAL = 1000;
export const MAX_CONCURRENT_CONTAINERS = 20;

// Cookie configuration
// Production (non-localhost): use __Host- prefix (requires Secure; Path=/; no Domain)
// Development (localhost): use plain name (no Secure flag needed)
export const SESSION_COOKIE_NAME = IS_PRODUCTION
  ? '__Host-happyclaw_session'
  : 'happyclaw_session';
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'config', 'session-secret.key');

function getOrCreateSessionSecret(): string {
  // 1. Environment variable (highest priority — allows container/operator override)
  if (WEB_SESSION_SECRET_ENV) {
    return WEB_SESSION_SECRET_ENV;
  }

  // 2. File-persisted secret (survives restarts without .env)
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
    fs.writeFileSync(SESSION_SECRET_FILE, generated + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // non-fatal: secret works for this process, just won't survive restart
  }
  return generated;
}

export const WEB_SESSION_SECRET = getOrCreateSessionSecret();

/**
 * Call at startup to validate required config. Exits if invalid.
 * Admin creation is handled via the web setup wizard (POST /api/auth/setup).
 */
export function validateConfig(): void {
  // No-op: admin setup handled via web wizard.
}
