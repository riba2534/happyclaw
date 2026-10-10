// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useKeyboardHeight } from './useKeyboardHeight';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight;
  scale = 1;
}

let viewport: FakeVisualViewport;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useKeyboardHeight> | null = null;
const originalViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
);

function Probe() {
  latest = useKeyboardHeight();
  return null;
}

const cssHeight = () =>
  document.documentElement.style.getPropertyValue('--keyboard-height');

async function resize(height: number, scale = 1) {
  await act(async () => {
    viewport.height = height;
    viewport.scale = scale;
    viewport.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  document.documentElement.style.removeProperty('--keyboard-height');
  if (originalViewport) {
    Object.defineProperty(window, 'visualViewport', originalViewport);
  }
});

describe('useKeyboardHeight', () => {
  test('pads for a software keyboard and resets when the composer unmounts', async () => {
    await act(async () => root?.render(<Probe />));
    expect(cssHeight()).toBe('0px');

    await resize(window.innerHeight - 320);
    expect(latest).toEqual({ keyboardHeight: 320, isKeyboardVisible: true });
    expect(cssHeight()).toBe('320px');

    await act(async () => root?.unmount());
    root = null;
    expect(cssHeight()).toBe('');
  });

  test('picks up a keyboard that is already up when it mounts', async () => {
    viewport.height = window.innerHeight - 280;
    await act(async () => root?.render(<Probe />));
    expect(latest?.keyboardHeight).toBe(280);
    expect(cssHeight()).toBe('280px');
  });

  test('ignores pinch-zoom and sub-keyboard gaps', async () => {
    await act(async () => root?.render(<Probe />));

    await resize(window.innerHeight / 2, 2);
    expect(latest).toEqual({ keyboardHeight: 0, isKeyboardVisible: false });
    expect(cssHeight()).toBe('0px');

    await resize(window.innerHeight - 20);
    expect(latest?.isKeyboardVisible).toBe(false);
  });
});
