import { describe, expect, test } from 'vitest';

import {
  base32Decode,
  base32Encode,
  totpCode,
  totpUri,
  verifyTotp,
} from '../src/totp.js';

// RFC 6238 appendix B, SHA-1 seed; the 8-digit values end in these 6.
const SEED = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  test('matches the RFC 6238 test vectors', () => {
    expect(totpCode(SEED, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(SEED, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(SEED, Math.floor(2000000000 / 30))).toBe('279037');
  });

  test('base32 round-trips and ignores spacing and case', () => {
    const bytes = Buffer.from('happyclaw secret');
    const text = base32Encode(bytes);
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(
      bytes,
    );
  });

  test('accepts one step either side and refuses a used step', () => {
    const nowMs = 1_800_000_000_000;
    const step = Math.floor(nowMs / 30_000);
    expect(verifyTotp(SEED, totpCode(SEED, step - 1), { nowMs })).toBe(
      step - 1,
    );
    expect(verifyTotp(SEED, totpCode(SEED, step + 1), { nowMs })).toBe(
      step + 1,
    );
    expect(verifyTotp(SEED, totpCode(SEED, step - 2), { nowMs })).toBeNull();
    expect(
      verifyTotp(SEED, totpCode(SEED, step), { nowMs, lastUsedStep: step }),
    ).toBeNull();
    expect(verifyTotp(SEED, 'abcdef', { nowMs })).toBeNull();
  });

  test('builds an otpauth URI', () => {
    expect(totpUri('ABC', 'alice', 'HappyClaw')).toBe(
      'otpauth://totp/HappyClaw%3Aalice?secret=ABC&issuer=HappyClaw&algorithm=SHA1&digits=6&period=30',
    );
  });
});
