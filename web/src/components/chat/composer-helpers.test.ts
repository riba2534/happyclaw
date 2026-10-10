// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';
import {
  composerTextAfterSend,
  isGlobalStopEscape,
  parseQueuedImageAttachments,
  queuedFollowUpLabel,
} from './composer-helpers';

describe('composerTextAfterSend', () => {
  test('clears the composer when nothing was typed during the send', () => {
    expect(composerTextAfterSend('hello', 'hello')).toBe('');
    expect(composerTextAfterSend('hello \n', 'hello')).toBe('');
  });

  test('keeps what was typed after the sent text', () => {
    expect(
      composerTextAfterSend('first message second thought', 'first message'),
    ).toBe('second thought');
    expect(composerTextAfterSend('first\n\nmore', 'first')).toBe('more');
  });

  test('keeps the composer untouched when the sent text was edited away', () => {
    expect(composerTextAfterSend('rewritten', 'first message')).toBe(
      'rewritten',
    );
    expect(composerTextAfterSend('', 'first message')).toBe('');
  });
});

describe('queued follow-up attachments', () => {
  test('turns stored image attachments into previews', () => {
    expect(
      parseQueuedImageAttachments(
        JSON.stringify([
          { type: 'image', data: 'AAA', mimeType: 'image/jpeg' },
          { type: 'image', data: 'BBB' },
          { type: 'file', data: 'CCC' },
          { type: 'image', data: '' },
        ]),
      ),
    ).toEqual([
      { src: 'data:image/jpeg;base64,AAA' },
      { src: 'data:image/png;base64,BBB' },
    ]);
  });

  test('ignores missing or malformed attachments', () => {
    expect(parseQueuedImageAttachments(undefined)).toEqual([]);
    expect(parseQueuedImageAttachments('not json')).toEqual([]);
    expect(parseQueuedImageAttachments('{"type":"image"}')).toEqual([]);
  });

  test('labels image-only items', () => {
    expect(queuedFollowUpLabel('  ', 2)).toBe('[图片]');
    expect(queuedFollowUpLabel(' 文本 ', 1)).toBe('文本');
    expect(queuedFollowUpLabel('', 0)).toBe('');
  });
});

describe('isGlobalStopEscape', () => {
  const escape = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      ...init,
    });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('stops only when nothing has focus and no layer is open', () => {
    expect(isGlobalStopEscape(escape())).toBe(true);
    expect(isGlobalStopEscape(escape({ shiftKey: true }))).toBe(false);
    expect(isGlobalStopEscape(new KeyboardEvent('keydown', { key: 'a' }))).toBe(
      false,
    );

    const consumed = escape();
    consumed.preventDefault();
    expect(isGlobalStopEscape(consumed)).toBe(false);
  });

  test('leaves Esc to inputs, dialogs and menus', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(isGlobalStopEscape(escape())).toBe(false);
    input.blur();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    expect(isGlobalStopEscape(escape())).toBe(false);
  });
});
