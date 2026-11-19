// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PasswordInput } from './PasswordInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<PasswordInput id="pw" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const toggle = () =>
  container.querySelector<HTMLButtonElement>('button[aria-controls="pw"]')!;

describe('PasswordInput', () => {
  test('the toggle is centred without a translate the pressed state overrides', () => {
    // The Button's active state sets a translate; a toggle centred by
    // -translate-y-1/2 jumped down mid-press and the click landed on the input.
    const classes = toggle().className.split(/\s+/);
    expect(classes).not.toContain('-translate-y-1/2');
    expect(classes).not.toContain('top-1/2');
    expect(classes).toEqual(
      expect.arrayContaining(['absolute', 'inset-y-0', 'my-auto']),
    );
  });

  test('the toggle reveals and hides the password', async () => {
    const input = container.querySelector<HTMLInputElement>('#pw')!;
    expect(input.type).toBe('password');
    await act(async () => toggle().click());
    expect(input.type).toBe('text');
    await act(async () => toggle().click());
    expect(input.type).toBe('password');
  });
});
