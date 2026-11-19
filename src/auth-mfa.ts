/**
 * Two-factor login: TOTP enrolment, the login challenge a correct password
 * earns when 2FA is on, and checking a second factor. Storage lives in
 * auth-factor-store.ts; the HTTP surface in routes/auth.ts.
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';

import {
  consumeRecoveryCode,
  deleteTwoFactorForUser,
  enableTotp,
  getUserTotp,
  isTotpEnabled,
  markTotpStepUsed,
  remainingRecoveryCodes,
  replaceRecoveryCodes,
  savePendingTotp,
} from './auth-factor-store.js';
import { openSecret, sealSecret } from './channel-account-secrets.js';
import { logger } from './logger.js';
import {
  base32Encode,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const CHALLENGE_MAX_ENTRIES = 10_000;
const TOTP_ISSUER = 'HappyClaw';

// --- Login challenges ---------------------------------------------------
//
// A challenge is what a correct password earns when 2FA is on: a random
// token bound to one user, valid for five minutes and five code attempts,
// spent by the first correct code. It lives in memory: a restart only asks
// for the password again.

interface MfaChallenge {
  userId: string;
  username: string;
  expiresAt: number;
  attempts: number;
}

const challenges = new Map<string, MfaChallenge>();

function pruneChallenges(now: number): void {
  for (const [token, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(token);
  }
  // Insertion order is age order; drop the oldest beyond the cap.
  for (const token of challenges.keys()) {
    if (challenges.size < CHALLENGE_MAX_ENTRIES) break;
    challenges.delete(token);
  }
}

export function createMfaChallenge(
  userId: string,
  username: string,
  now = Date.now(),
): string {
  pruneChallenges(now);
  const token = crypto.randomBytes(32).toString('base64url');
  challenges.set(token, {
    userId,
    username,
    expiresAt: now + CHALLENGE_TTL_MS,
    attempts: 0,
  });
  return token;
}

/** The live challenge for a token, or undefined (unknown, expired, spent). */
export function peekMfaChallenge(
  token: string,
  now = Date.now(),
): Readonly<MfaChallenge> | undefined {
  const challenge = challenges.get(token);
  if (!challenge) return undefined;
  if (challenge.expiresAt <= now) {
    challenges.delete(token);
    return undefined;
  }
  return challenge;
}

/** Count a wrong code; the challenge ends after the last allowed attempt. */
export function failMfaChallenge(token: string): void {
  const challenge = challenges.get(token);
  if (!challenge) return;
  challenge.attempts += 1;
  if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) challenges.delete(token);
}

export function spendMfaChallenge(token: string): void {
  challenges.delete(token);
}

/** Test-only. */
export function resetMfaChallengesForTest(): void {
  challenges.clear();
}

// --- Second factors -----------------------------------------------------

/**
 * The stored authenticator secret cannot be opened: the sealing key
 * (data/config/claude-provider.key) was lost or replaced since enrolment.
 * Recovery codes do not depend on it and still work.
 */
export class TotpSecretUnreadableError extends Error {
  constructor() {
    super('The authenticator secret cannot be read');
    this.name = 'TotpSecretUnreadableError';
  }
}

function readTotpSecret(userId: string, sealed: string): string {
  try {
    return openSecret(sealed);
  } catch (err) {
    logger.error(
      { err, userId },
      'Cannot open the TOTP secret; the sealing key (data/config/claude-provider.key) may have changed',
    );
    throw new TotpSecretUnreadableError();
  }
}

/** Ten codes of ten base32 characters (50 random bits each), `xxxxx-xxxxx`. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

export type SecondFactorMethod = 'totp' | 'recovery_code';

/**
 * Check a TOTP code (six digits) or a recovery code and spend it. A TOTP
 * step is accepted once; a recovery code once. Throws
 * TotpSecretUnreadableError for a TOTP code when the secret cannot be read.
 */
export function verifySecondFactor(
  userId: string,
  code: string,
  options: { allowRecoveryCode?: boolean; nowMs?: number } = {},
): SecondFactorMethod | null {
  const row = getUserTotp(userId);
  if (!row?.enabled_at) return null;
  const trimmed = code.trim();
  if (/^\d{3}\s?\d{3}$/.test(trimmed)) {
    const step = verifyTotp(readTotpSecret(userId, row.secret_enc), trimmed, {
      nowMs: options.nowMs,
      lastUsedStep: row.last_used_step,
    });
    return step !== null && markTotpStepUsed(userId, step) ? 'totp' : null;
  }
  if (options.allowRecoveryCode === false) return null;
  return trimmed && consumeRecoveryCode(userId, trimmed)
    ? 'recovery_code'
    : null;
}

export interface TwoFactorStatus {
  enabled: boolean;
  recovery_codes_remaining: number;
}

export function twoFactorStatus(userId: string): TwoFactorStatus {
  const enabled = isTotpEnabled(userId);
  return {
    enabled,
    recovery_codes_remaining: enabled ? remainingRecoveryCodes(userId) : 0,
  };
}

export interface TotpEnrolment {
  secret: string;
  otpauth_uri: string;
  qr_data_url: string;
}

/** A fresh secret awaiting confirmation; null while 2FA is already on. */
export async function startTotpEnrolment(
  userId: string,
  username: string,
): Promise<TotpEnrolment | null> {
  const secret = generateTotpSecret();
  if (!savePendingTotp(userId, sealSecret(secret))) return null;
  const uri = totpUri(secret, username, TOTP_ISSUER);
  return {
    secret,
    otpauth_uri: uri,
    qr_data_url: await QRCode.toDataURL(uri, { margin: 1, width: 220 }),
  };
}

/** Confirm an enrolment with its first code; returns the recovery codes. */
export function confirmTotpEnrolment(
  userId: string,
  code: string,
  nowMs?: number,
): string[] | null {
  const row = getUserTotp(userId);
  if (!row || row.enabled_at) return null;
  const step = verifyTotp(readTotpSecret(userId, row.secret_enc), code, {
    nowMs,
  });
  if (step === null) return null;
  const codes = generateRecoveryCodes();
  return enableTotp(userId, step, codes) ? codes : null;
}

export function regenerateRecoveryCodes(userId: string): string[] {
  const codes = generateRecoveryCodes();
  replaceRecoveryCodes(userId, codes);
  return codes;
}

export function removeTwoFactor(userId: string): boolean {
  const had = !!getUserTotp(userId);
  deleteTwoFactorForUser(userId);
  return had;
}
