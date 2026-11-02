import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('chat store source encoding', () => {
  test('uses a visible NUL escape without embedding a binary byte', () => {
    const source = readFileSync(new URL('./chat.ts', import.meta.url));
    expect(source.includes(0)).toBe(false);
    expect(source.toString('utf8')).toContain(
      'return `${chatJid}\\0${messageId}`;',
    );
  });
});
