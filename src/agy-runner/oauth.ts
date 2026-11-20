/**
 * Official Antigravity (`agy`) CLI OAuth login manager.
 *
 * Each AGY provider gets its own isolated profile directory under
 * `data/config/agy-profiles/<profileId>` (mode 0700). Login spawns the
 * official `agy acp --login` terminal auth flow with `HOME=<profileDir>`,
 * extracts the Google OAuth URL for the browser, and feeds the pasted
 * authorization code / callback URL back to `agy` on stdin.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import type { ProviderModelEntry } from '../model-providers.js';
import { discoverAgyModels, resolveAgyBinary } from './models.js';

const AGY_PROFILES_ROOT = path.join(DATA_DIR, 'config', 'agy-profiles');
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
const START_URL_TIMEOUT_MS = 15_000;
const EXCHANGE_TIMEOUT_MS = 45_000;
const MAX_PENDING_LOGINS = 8;

const OAUTH_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/;
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

interface PendingAgyLogin {
  state: string;
  profileId: string;
  profileDir: string;
  targetProviderId?: string;
  child: ChildProcess;
  outputTail: string;
  exited: boolean;
  exitCode: number | null;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingLogins = new Map<string, PendingAgyLogin>();

export function isValidAgyProfileId(id: unknown): id is string {
  return typeof id === 'string' && PROFILE_ID_RE.test(id);
}

/**
 * Resolve the isolated HOME directory for a stored `agyProfileId`.
 * Returns `undefined` when absent (legacy host-HOME provider).
 */
export function resolveAgyProfileHomeDir(
  agyProfileId?: string | null,
): string | undefined {
  if (!isValidAgyProfileId(agyProfileId)) return undefined;
  return path.join(AGY_PROFILES_ROOT, agyProfileId);
}

export function deleteAgyProfileDir(agyProfileId?: string | null): void {
  const dir = resolveAgyProfileHomeDir(agyProfileId);
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function cleanupPending(state: string, removeDir: boolean): void {
  const entry = pendingLogins.get(state);
  if (!entry) return;
  pendingLogins.delete(state);
  clearTimeout(entry.timer);
  if (!entry.exited) {
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (removeDir) {
    try {
      fs.rmSync(entry.profileDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function extractAgyOAuthUrl(text: string): string | null {
  const match = text.match(OAUTH_URL_RE);
  return match ? match[0] : null;
}

/**
 * Start an official `agy acp --login` flow in a fresh isolated profile dir.
 */
export async function startAgyOAuthLogin(options?: {
  targetProviderId?: string;
}): Promise<{ authorizeUrl: string; state: string }> {
  // Evict expired or excess pending logins
  const now = Date.now();
  for (const [key, item] of pendingLogins.entries()) {
    if (now - item.createdAt > PENDING_LOGIN_TTL_MS || item.exited) {
      cleanupPending(key, true);
    }
  }
  if (pendingLogins.size >= MAX_PENDING_LOGINS) {
    const oldest = [...pendingLogins.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    )[0];
    if (oldest) cleanupPending(oldest.state, true);
  }

  fs.mkdirSync(AGY_PROFILES_ROOT, { recursive: true, mode: 0o700 });
  const profileId = crypto.randomBytes(12).toString('hex');
  const profileDir = path.join(AGY_PROFILES_ROOT, profileId);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const agyBin = resolveAgyBinary();
  const child = spawn(agyBin, ['acp', '--login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: profileDir,
      DISPLAY: '',
      BROWSER: '',
    },
  });

  const state = crypto.randomBytes(16).toString('hex');
  const entry: PendingAgyLogin = {
    state,
    profileId,
    profileDir,
    targetProviderId: options?.targetProviderId,
    child,
    outputTail: '',
    exited: false,
    exitCode: null,
    createdAt: Date.now(),
    timer: setTimeout(() => cleanupPending(state, true), PENDING_LOGIN_TTL_MS),
  };
  pendingLogins.set(state, entry);

  return new Promise((resolve, reject) => {
    let settled = false;
    const urlTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupPending(state, true);
      reject(new Error('等待 agy 生成 Google 授权链接超时'));
    }, START_URL_TIMEOUT_MS);

    const onChunk = (chunk: Buffer | string) => {
      const text = chunk.toString('utf-8');
      entry.outputTail = (entry.outputTail + text).slice(-8000);
      if (!settled) {
        const url = extractAgyOAuthUrl(entry.outputTail);
        if (url) {
          settled = true;
          clearTimeout(urlTimer);
          resolve({ authorizeUrl: url, state });
        }
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      entry.exited = true;
      if (!settled) {
        settled = true;
        clearTimeout(urlTimer);
        cleanupPending(state, true);
        reject(new Error(`启动 agy 登录失败：${err.message}`));
      }
    });

    child.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      if (!settled) {
        settled = true;
        clearTimeout(urlTimer);
        const detail = entry.outputTail.trim().slice(-400);
        cleanupPending(state, true);
        reject(
          new Error(
            detail || `agy 登录进程提前退出（exit code ${code ?? 'unknown'}）`,
          ),
        );
      }
    });
  });
}

/**
 * Feed the pasted authorization code (or full callback URL) into the pending
 * `agy acp --login` process, wait for it to finish, and verify by listing models.
 */
export async function completeAgyOAuthLogin(
  state: string,
  codeOrUrl: string,
): Promise<{
  profileId: string;
  profileDir: string;
  models: ProviderModelEntry[];
  targetProviderId?: string;
}> {
  const entry = pendingLogins.get(state);
  if (!entry) {
    throw new Error('授权会话已过期或不存在，请重新点击登录 Antigravity');
  }
  const trimmed = codeOrUrl.trim();
  if (!trimmed) {
    throw new Error('请粘贴授权码或回调页面完整地址');
  }
  if (entry.exited) {
    cleanupPending(state, true);
    throw new Error('授权进程已结束，请重新点击登录 Antigravity');
  }

  // Consume the pending entry immediately so it cannot be submitted twice
  pendingLogins.delete(state);
  clearTimeout(entry.timer);

  try {
    await new Promise<void>((resolve, reject) => {
      const doneTimer = setTimeout(() => {
        try {
          entry.child.kill('SIGTERM');
        } catch {
          // ignore
        }
        reject(new Error('等待 agy 完成 OAuth 换取超时，请重试'));
      }, EXCHANGE_TIMEOUT_MS);

      entry.child.once('exit', (code) => {
        clearTimeout(doneTimer);
        if (code === 0) {
          resolve();
        } else {
          const detail = entry.outputTail.trim().slice(-500);
          reject(
            new Error(
              detail ||
                `Antigravity 授权失败（exit code ${code ?? 'unknown'}）`,
            ),
          );
        }
      });

      entry.child.stdin?.write(`${trimmed}\n`);
      entry.child.stdin?.end();
    });

    const models = await discoverAgyModels({
      homeDir: entry.profileDir,
      timeoutMs: 20_000,
    });
    if (models.length === 0) {
      throw new Error('登录完成但未能获取到可用模型列表，请检查账号权限');
    }

    return {
      profileId: entry.profileId,
      profileDir: entry.profileDir,
      models,
      targetProviderId: entry.targetProviderId,
    };
  } catch (err) {
    try {
      fs.rmSync(entry.profileDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}
