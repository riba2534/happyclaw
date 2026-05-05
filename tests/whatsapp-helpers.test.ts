import { describe, expect, test } from 'vitest';
import type { proto } from '@whiskeysockets/baileys';

import {
  extractMessageText,
  extFromMime,
  guessMimeType,
  isMentioningBot,
  normalizeTimestamp,
  stripChannelPrefix,
} from '../src/whatsapp.js';

describe('extractMessageText', () => {
  test('plain conversation', () => {
    expect(
      extractMessageText({ conversation: 'hi' } as proto.IMessage),
    ).toBe('hi');
  });

  test('extendedTextMessage', () => {
    expect(
      extractMessageText({
        extendedTextMessage: { text: 'hello world' },
      } as proto.IMessage),
    ).toBe('hello world');
  });

  test('ephemeral wraps inner content', () => {
    expect(
      extractMessageText({
        ephemeralMessage: { message: { conversation: 'secret' } },
      } as proto.IMessage),
    ).toBe('secret');
  });

  test('viewOnceMessageV2 wraps inner content', () => {
    expect(
      extractMessageText({
        viewOnceMessageV2: {
          message: { extendedTextMessage: { text: 'inner' } },
        },
      } as proto.IMessage),
    ).toBe('inner');
  });

  test('image caption acts as text', () => {
    expect(
      extractMessageText({
        imageMessage: { caption: 'a photo' },
      } as proto.IMessage),
    ).toBe('a photo');
  });

  test('media without caption returns null', () => {
    expect(
      extractMessageText({
        imageMessage: { mimetype: 'image/jpeg' },
      } as proto.IMessage),
    ).toBeNull();
  });

  test('empty content returns null', () => {
    expect(extractMessageText({} as proto.IMessage)).toBeNull();
  });
});

describe('normalizeTimestamp', () => {
  test('number unix seconds → ms', () => {
    expect(normalizeTimestamp(1700000000)).toBe(1700000000_000);
  });

  test('null/undefined → 0', () => {
    expect(normalizeTimestamp(null)).toBe(0);
    expect(normalizeTimestamp(undefined)).toBe(0);
  });

  test('Long-like with toNumber', () => {
    const longLike = { toNumber: () => 1700000001 };
    expect(normalizeTimestamp(longLike as never)).toBe(1700000001_000);
  });
});

describe('guessMimeType', () => {
  test('common image types', () => {
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg');
    expect(guessMimeType('photo.JPEG')).toBe('image/jpeg');
    expect(guessMimeType('icon.png')).toBe('image/png');
    expect(guessMimeType('a.webp')).toBe('image/webp');
  });

  test('document types', () => {
    expect(guessMimeType('report.pdf')).toBe('application/pdf');
    expect(guessMimeType('a.docx')).toMatch(/wordprocessing/);
    expect(guessMimeType('list.csv')).toBe('text/csv');
  });

  test('unknown extension returns null', () => {
    expect(guessMimeType('mystery.xyz')).toBeNull();
    expect(guessMimeType('noext')).toBeNull();
  });
});

describe('extFromMime', () => {
  test('image mimes', () => {
    expect(extFromMime('image/jpeg')).toBe('.jpg');
    expect(extFromMime('image/png')).toBe('.png');
  });

  test('audio is contextual: mpeg + audio prefix → mp3', () => {
    expect(extFromMime('audio/mpeg')).toBe('.mp3');
  });

  test('null/empty input', () => {
    expect(extFromMime(null)).toBeNull();
    expect(extFromMime(undefined)).toBeNull();
    expect(extFromMime('')).toBeNull();
  });
});

describe('stripChannelPrefix', () => {
  test('strips whatsapp: prefix', () => {
    expect(stripChannelPrefix('whatsapp:123@s.whatsapp.net')).toBe(
      '123@s.whatsapp.net',
    );
  });

  test('passes through when no prefix', () => {
    expect(stripChannelPrefix('123@g.us')).toBe('123@g.us');
  });
});

describe('isMentioningBot', () => {
  const SELF = '15551234567:42@s.whatsapp.net';

  test('returns false when mentions empty', () => {
    expect(
      isMentioningBot({ extendedTextMessage: { text: 'hi' } } as proto.IMessage, SELF),
    ).toBe(false);
  });

  test('returns true when bot jid mentioned (with device suffix variants)', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            text: '@bot hi',
            contextInfo: {
              mentionedJid: ['15551234567@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(true);
  });

  test('returns false when other user mentioned', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            text: '@friend hi',
            contextInfo: {
              mentionedJid: ['9999999999@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(false);
  });

  test('mention also detected on imageMessage contextInfo', () => {
    expect(
      isMentioningBot(
        {
          imageMessage: {
            caption: '@bot look',
            contextInfo: {
              mentionedJid: ['15551234567@s.whatsapp.net'],
            },
          },
        } as proto.IMessage,
        SELF,
      ),
    ).toBe(true);
  });

  test('safety degrade: no selfJid → returns true (no gating)', () => {
    expect(
      isMentioningBot(
        {
          extendedTextMessage: {
            contextInfo: { mentionedJid: ['anyone@s.whatsapp.net'] },
          },
        } as proto.IMessage,
        null,
      ),
    ).toBe(true);
  });
});
