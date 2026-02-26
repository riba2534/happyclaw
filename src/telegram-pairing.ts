/**
 * Telegram Pairing Code — generate & verify one-time codes for chat binding.
 *
 * - 6-character uppercase alphanumeric code (crypto random)
 * - 5-minute expiry, single use, one active code per user
 * - No periodic cleanup needed: generatePairingCode() enforces one code per user,
 *   and verifyPairingCode() lazily cleans expired entries on access.
 */
import crypto from 'crypto';

interface PairingEntry {
  userId: string;
  expiresAt: number; // epoch ms
}

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CODE_LENGTH = 6;

// code → entry
const codes = new Map<string, PairingEntry>();
// userId → code  (ensures only one active code per user)
const userCodes = new Map<string, string>();

function randomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const limit = 256 - (256 % chars.length); // 252 — eliminates modulo bias
  let result = '';
  while (result.length < CODE_LENGTH) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) result += chars[byte % chars.length];
  }
  return result;
}

export function generatePairingCode(userId: string): { code: string; expiresAt: number; ttlSeconds: number } {
  // Revoke any previous code for this user
  const prev = userCodes.get(userId);
  if (prev) codes.delete(prev);

  let code: string;
  do {
    code = randomCode();
  } while (codes.has(code)); // extremely unlikely collision

  const expiresAt = Date.now() + PAIRING_TTL_MS;
  codes.set(code, { userId, expiresAt });
  userCodes.set(userId, code);

  return { code, expiresAt, ttlSeconds: PAIRING_TTL_MS / 1000 };
}

export function verifyPairingCode(code: string): { userId: string } | null {
  const entry = codes.get(code.toUpperCase());
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    // Expired — clean up
    codes.delete(code.toUpperCase());
    if (userCodes.get(entry.userId) === code.toUpperCase()) {
      userCodes.delete(entry.userId);
    }
    return null;
  }
  // Consume (single use)
  codes.delete(code.toUpperCase());
  if (userCodes.get(entry.userId) === code.toUpperCase()) {
    userCodes.delete(entry.userId);
  }
  return { userId: entry.userId };
}
