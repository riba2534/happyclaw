import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcut registry. Keys use a small portable syntax:
 * `mod` = ⌘ on macOS / Ctrl elsewhere, joined with `+`, e.g. `mod+shift+o`.
 */
export const SHORTCUTS = {
  commandPalette: 'mod+k',
  toggleSidebar: 'mod+b',
  newConversation: 'mod+shift+o',
  steer: 'mod+shift+enter',
  save: 'mod+s',
} as const;

export type ShortcutName = keyof typeof SHORTCUTS;

const MODIFIERS = ['mod', 'ctrl', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function parse(keys: string) {
  const parts = keys.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1) as Modifier[]);
  return { key, mods };
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

const OTHER_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** Split a shortcut into display keycaps, e.g. `mod+shift+o` → ⌘ ⇧ O. */
export function formatKeys(keys: string, mac = isMacPlatform()): string[] {
  const { key, mods } = parse(keys);
  const labels = mac ? MAC_SYMBOLS : OTHER_LABELS;
  const ordered = MODIFIERS.filter((m) => mods.has(m)).map((m) => labels[m]);
  const keyLabel = labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...ordered, keyLabel];
}

/** Whether a keyboard event matches the shortcut exactly (no extra modifiers). */
export function matchShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
  keys: string,
  mac = isMacPlatform(),
): boolean {
  const { key, mods } = parse(keys);
  if (event.key?.toLowerCase() !== key) return false;
  const wantMeta = mac && mods.has('mod');
  const wantCtrl = mods.has('ctrl') || (!mac && mods.has('mod'));
  return (
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.altKey === mods.has('alt') &&
    event.shiftKey === mods.has('shift')
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Global keydown binding. Shortcuts with a modifier fire inside inputs by
 * default (⌘K should work while typing); bare keys never do.
 */
export function useShortcut(
  keys: string | null,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; allowInInputs?: boolean } = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { enabled = true } = options;
  const allowInInputs =
    options.allowInInputs ?? (keys ? keys.includes('+') : false);

  useEffect(() => {
    if (!keys || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!matchShortcut(event, keys)) return;
      if (!allowInInputs && isEditableTarget(event.target)) return;
      event.preventDefault();
      handlerRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keys, enabled, allowInInputs]);
}
