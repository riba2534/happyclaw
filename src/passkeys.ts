/**
 * Passkeys (WebAuthn): which origin a ceremony belongs to, the server-side
 * challenges, and registration and login on @simplewebauthn/server.
 *
 * Origin: there is no configured public URL, so the expected origin is the
 * page's own, taken from the request's Origin header, and accepted only when
 * it is the same origin as the request (Origin host = Host header, the rule
 * the WebSocket upgrade uses), localhost, or listed in CORS_ALLOWED_ORIGINS
 * (a reverse proxy that rewrites Host). The RP ID is that origin's host
 * name. A credential is stored with its RP ID and only ever accepted for
 * that RP ID, so a page on another host cannot use it even if it reached
 * this server; the browser enforces the same binding on its side.
 */
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import {
  getPasskey,
  insertPasskey,
  listPasskeys,
  recordPasskeyUse,
  type PasskeyRow,
} from './auth-factor-store.js';

const RP_NAME = 'HappyClaw';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ENTRIES = 10_000;
export const MAX_PASSKEYS_PER_USER = 20;

// --- Origin -------------------------------------------------------------

export interface PasskeyOrigin {
  origin: string;
  rpId: string;
}

export type PasskeyOriginProblem = 'no_origin' | 'insecure' | 'not_allowed';

function listedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS || '';
  // '*' turns the WebSocket check off; it never vouches for a passkey origin.
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item !== '*');
}

/** The origin a ceremony on this request belongs to, or why there is none. */
export function resolvePasskeyOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): PasskeyOrigin | { problem: PasskeyOriginProblem } {
  if (!originHeader) return { problem: 'no_origin' };
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return { problem: 'no_origin' };
  }
  const origin = url.origin;
  const localhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // WebAuthn needs a secure context: HTTPS, or localhost over HTTP.
  if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) {
    return { problem: 'insecure' };
  }
  const sameOrigin = !!hostHeader && url.host === hostHeader;
  const allowLocalhost = process.env.CORS_ALLOW_LOCALHOST !== 'false';
  if (
    !sameOrigin &&
    !(localhost && allowLocalhost) &&
    !listedOrigins().includes(origin)
  ) {
    return { problem: 'not_allowed' };
  }
  return { origin, rpId: url.hostname };
}

// --- Challenges ---------------------------------------------------------
//
// One challenge per ceremony, kept server-side: single use, five minutes,
// bound to the purpose, the origin and (for registration) the user.

interface PendingChallenge {
  purpose: 'register' | 'login';
  userId: string | null;
  origin: string;
  rpId: string;
  expiresAt: number;
}

const challenges = new Map<string, PendingChallenge>();

function rememberChallenge(challenge: string, pending: PendingChallenge) {
  const now = Date.now();
  for (const [key, value] of challenges) {
    if (value.expiresAt <= now) challenges.delete(key);
  }
  for (const key of challenges.keys()) {
    if (challenges.size < CHALLENGE_MAX_ENTRIES) break;
    challenges.delete(key);
  }
  challenges.set(challenge, pending);
}

/** Spend a challenge if it matches; any lookup, matching or not, spends it. */
function takeChallenge(
  challenge: string,
  expected: Omit<PendingChallenge, 'expiresAt'>,
): boolean {
  const pending = challenges.get(challenge);
  challenges.delete(challenge);
  return (
    !!pending &&
    pending.expiresAt > Date.now() &&
    pending.purpose === expected.purpose &&
    pending.userId === expected.userId &&
    pending.origin === expected.origin &&
    pending.rpId === expected.rpId
  );
}

/** Test-only. */
export function resetPasskeyChallengesForTest(): void {
  challenges.clear();
}

function newChallenge(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

// --- Registration -------------------------------------------------------

export async function passkeyRegistrationOptions(
  user: { id: string; username: string; display_name?: string | null },
  where: PasskeyOrigin,
) {
  const challenge = newChallenge();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: where.rpId,
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    // A stable handle that is not the username, so a renamed user keeps it.
    userID: new TextEncoder().encode(user.id),
    challenge,
    attestationType: 'none',
    excludeCredentials: listPasskeys(user.id)
      .filter((row) => row.rp_id === where.rpId)
      .map((row) => ({
        id: row.id,
        transports: parseTransports(row.transports),
      })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  rememberChallenge(options.challenge, {
    purpose: 'register',
    userId: user.id,
    origin: where.origin,
    rpId: where.rpId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return options;
}

export async function registerPasskey(
  userId: string,
  where: PasskeyOrigin,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyRow | null> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) =>
        takeChallenge(challenge, {
          purpose: 'register',
          userId,
          origin: where.origin,
          rpId: where.rpId,
        }),
      expectedOrigin: where.origin,
      expectedRPID: where.rpId,
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  const { credential } = verification.registrationInfo;
  if (getPasskey(credential.id)) return null;
  const row = {
    id: credential.id,
    user_id: userId,
    rp_id: where.rpId,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports
      ? JSON.stringify(credential.transports)
      : null,
    name,
    created_at: new Date().toISOString(),
  };
  insertPasskey(row);
  return { ...row, last_used_at: null };
}

// --- Login --------------------------------------------------------------

/** Options for a username-less login (discoverable credentials). */
export async function passkeyLoginOptions(where: PasskeyOrigin) {
  const challenge = newChallenge();
  const options = await generateAuthenticationOptions({
    rpID: where.rpId,
    challenge,
    userVerification: 'required',
  });
  rememberChallenge(options.challenge, {
    purpose: 'login',
    userId: null,
    origin: where.origin,
    rpId: where.rpId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return options;
}

/** The user ID a login response proves, or null. */
export async function verifyPasskeyLogin(
  where: PasskeyOrigin,
  response: AuthenticationResponseJSON,
): Promise<string | null> {
  const row = getPasskey(response.id);
  // Unknown, or created for another host: refuse before any verification,
  // and spend the challenge either way.
  if (!row || row.rp_id !== where.rpId) {
    takeChallengeFromResponse(response);
    return null;
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) =>
        takeChallenge(challenge, {
          purpose: 'login',
          userId: null,
          origin: where.origin,
          rpId: where.rpId,
        }),
      expectedOrigin: where.origin,
      expectedRPID: where.rpId,
      credential: {
        id: row.id,
        publicKey: Buffer.from(row.public_key, 'base64url'),
        counter: row.counter,
        transports: parseTransports(row.transports) as never,
      },
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  recordPasskeyUse(row.id, verification.authenticationInfo.newCounter);
  return row.user_id;
}

function takeChallengeFromResponse(response: AuthenticationResponseJSON) {
  try {
    const client = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString(
        'utf8',
      ),
    ) as { challenge?: unknown };
    if (typeof client.challenge === 'string') {
      challenges.delete(client.challenge);
    }
  } catch {
    /* malformed: nothing to spend */
  }
}
