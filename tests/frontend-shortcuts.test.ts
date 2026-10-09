import { describe, expect, test } from 'vitest';
import { SHORTCUTS, formatKeys, matchShortcut } from '../web/src/lib/shortcuts';

const key = (
  k: string,
  mods: Partial<
    Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>
  > = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keyboard shortcut helpers', () => {
  test('formats keycaps per platform in modifier order', () => {
    expect(formatKeys('mod+shift+o', true)).toEqual(['⌘', '⇧', 'O']);
    expect(formatKeys('mod+shift+o', false)).toEqual(['Ctrl', 'Shift', 'O']);
    expect(formatKeys('shift+mod+enter', true)).toEqual(['⌘', '⇧', '↵']);
    expect(formatKeys('escape', false)).toEqual(['Esc']);
  });

  test('maps mod to Meta on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(key('k', { metaKey: true }), 'mod+k', true)).toBe(
      true,
    );
    expect(matchShortcut(key('k', { ctrlKey: true }), 'mod+k', true)).toBe(
      false,
    );
    expect(matchShortcut(key('k', { ctrlKey: true }), 'mod+k', false)).toBe(
      true,
    );
    expect(matchShortcut(key('K', { ctrlKey: true }), 'mod+k', false)).toBe(
      true,
    );
  });

  test('rejects extra modifiers so mod+k does not also fire on mod+shift+k', () => {
    expect(
      matchShortcut(key('k', { metaKey: true, shiftKey: true }), 'mod+k', true),
    ).toBe(false);
    expect(
      matchShortcut(
        key('o', { metaKey: true, shiftKey: true }),
        SHORTCUTS.newConversation,
        true,
      ),
    ).toBe(true);
  });
});
