// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const html = fs.readFileSync(
  path.join(process.cwd(), 'web/index.html'),
  'utf8',
);

// The pre-paint bootstrap is the only inline script that touches the theme keys.
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((body) => body.includes('happyclaw-color-scheme'));

// Node ships its own (disabled) global localStorage, so the script gets an
// in-memory storage explicitly instead of relying on bare globals.
function runBootstrap(scheme: string | null, theme: string | null = null) {
  const values = new Map<string, string>();
  if (scheme !== null) values.set('happyclaw-color-scheme', scheme);
  if (theme !== null) values.set('happyclaw-theme', theme);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  document.documentElement.className = '';
  new Function('localStorage', 'getComputedStyle', bootstrap!)(
    storage,
    window.getComputedStyle.bind(window),
  );
  return document.documentElement.classList;
}

describe('theme bootstrap before first paint', () => {
  afterEach(() => {
    document.documentElement.className = '';
  });

  test('exists in index.html', () => {
    expect(bootstrap).toBeTruthy();
  });

  test('treats a missing key as the default orange scheme, like useTheme', () => {
    // setColorScheme('orange') removes the key, so this is the common case.
    const classes = runBootstrap(null);
    expect(classes.contains('theme-orange')).toBe(true);
    expect(classes.contains('theme-neutral')).toBe(false);
  });

  test('applies explicit schemes', () => {
    expect(runBootstrap('orange').contains('theme-orange')).toBe(true);
    const neutral = runBootstrap('neutral');
    expect(neutral.contains('theme-neutral')).toBe(true);
    expect(neutral.contains('theme-orange')).toBe(false);
    const teal = runBootstrap('default');
    expect(teal.contains('theme-orange')).toBe(false);
    expect(teal.contains('theme-neutral')).toBe(false);
  });

  test('applies dark mode only when stored as dark', () => {
    expect(runBootstrap(null, 'dark').contains('dark')).toBe(true);
    expect(runBootstrap(null).contains('dark')).toBe(false);
  });

  test('keeps the hook fallback and storage semantics aligned', () => {
    const hook = fs.readFileSync(
      path.join(process.cwd(), 'web/src/hooks/useTheme.ts'),
      'utf8',
    );
    expect(hook).toContain(
      "if (s === 'orange') window.localStorage.removeItem(SCHEME_KEY);",
    );
    expect(hook).toMatch(/function readColorScheme[\s\S]*?return 'orange';\n}/);
  });
});
