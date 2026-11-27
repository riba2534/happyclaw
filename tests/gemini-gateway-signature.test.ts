import { beforeEach, describe, expect, test } from 'vitest';

import {
  clearGeminiSignatureCacheForTest,
  decodeSignatureCarrier,
  encodeSignatureCarrier,
  geminiToolUseId,
  recallToolSignature,
  rememberToolSignature,
} from '../src/gemini-gateway/signature.js';
import { GEMINI_SIGNATURE_PREFIX } from '../src/gemini-gateway/types.js';

beforeEach(() => {
  clearGeminiSignatureCacheForTest();
});

describe('signature carrier', () => {
  test('round-trips a text signature without a call id', () => {
    const encoded = encodeSignatureCarrier({
      signature: 'sig-1',
      kind: 'text',
    });
    expect(encoded.startsWith(GEMINI_SIGNATURE_PREFIX)).toBe(true);
    expect(decodeSignatureCarrier(encoded)).toEqual({
      signature: 'sig-1',
      kind: 'text',
    });
  });

  test('round-trips a tool signature with its call id', () => {
    const encoded = encodeSignatureCarrier({
      signature: 'sig-2',
      kind: 'tool',
      callId: 'call-9',
    });
    expect(decodeSignatureCarrier(encoded)).toEqual({
      signature: 'sig-2',
      kind: 'tool',
      callId: 'call-9',
    });
  });

  test.each([
    null,
    undefined,
    '',
    'not-a-carrier',
    `${GEMINI_SIGNATURE_PREFIX}%%%`,
  ])('ignores a value that is not a carrier: %s', (value) => {
    expect(decodeSignatureCarrier(value)).toBeNull();
  });

  test('a prefixed payload without a signature is not a carrier', () => {
    const encoded = `${GEMINI_SIGNATURE_PREFIX}${Buffer.from(
      JSON.stringify({ s: '', k: 'tool', i: 'call' }),
    ).toString('base64url')}`;
    expect(decodeSignatureCarrier(encoded)).toBeNull();
  });

  test('an unknown kind decodes as text', () => {
    const encoded = `${GEMINI_SIGNATURE_PREFIX}${Buffer.from(
      JSON.stringify({ s: 'sig', k: 'weird' }),
    ).toString('base64url')}`;
    expect(decodeSignatureCarrier(encoded)).toEqual({
      signature: 'sig',
      kind: 'text',
    });
  });
});

describe('geminiToolUseId', () => {
  test('is stable for the same call and Anthropic-shaped', () => {
    const id = geminiToolUseId('call-1', 'read_file');
    expect(id).toMatch(/^toolu_[A-Za-z0-9_-]{24}$/);
    expect(geminiToolUseId('call-1', 'read_file')).toBe(id);
  });

  test('differs per call id and per name when the call id is absent', () => {
    expect(geminiToolUseId('call-1', 'read_file')).not.toBe(
      geminiToolUseId('call-2', 'read_file'),
    );
    expect(geminiToolUseId(null, 'read_file')).not.toBe(
      geminiToolUseId(null, 'write_file'),
    );
  });
});

describe('signature cache', () => {
  test('recalls a remembered signature and refreshes its recency', () => {
    rememberToolSignature('toolu_a', {
      signature: 'sig-a',
      callId: 'call-a',
      name: 'read_file',
    });
    expect(recallToolSignature('toolu_a')).toEqual({
      signature: 'sig-a',
      callId: 'call-a',
      name: 'read_file',
    });
    expect(recallToolSignature('toolu_missing')).toBeNull();
  });

  test('re-remembering an id replaces the previous entry', () => {
    rememberToolSignature('toolu_a', {
      signature: 'sig-old',
      callId: null,
      name: 'read_file',
    });
    rememberToolSignature('toolu_a', {
      signature: 'sig-new',
      callId: 'call-b',
      name: 'read_file',
    });
    expect(recallToolSignature('toolu_a')?.signature).toBe('sig-new');
  });

  test('stays bounded so a long conversation cannot grow it forever', () => {
    for (let i = 0; i < 2_100; i += 1) {
      rememberToolSignature(`toolu_${i}`, {
        signature: `sig-${i}`,
        callId: `call-${i}`,
        name: 'read_file',
      });
    }
    expect(recallToolSignature('toolu_0')).toBeNull();
    expect(recallToolSignature('toolu_2099')).not.toBeNull();
  });
});
