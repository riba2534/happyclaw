// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  measureVisualViewport,
  resizedForKeyboard,
  undoFocusScroll,
  useKeyboardInset,
  useVisualViewportVars,
} from './useVisualViewport';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
}

let viewport: FakeVisualViewport;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let inset: number | null = null;
const originalViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
);

function Vars() {
  useVisualViewportVars();
  return null;
}

function Inset() {
  inset = useKeyboardInset();
  return null;
}

const cssVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

async function move(next: Partial<FakeVisualViewport>, type = 'resize') {
  await act(async () => {
    Object.assign(viewport, next);
    viewport.dispatchEvent(new Event(type));
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
  inset = null;
  if (originalViewport) {
    Object.defineProperty(window, 'visualViewport', originalViewport);
  }
});

describe('measureVisualViewport', () => {
  const vv = (height: number, offsetTop = 0, scale = 1) => ({
    height,
    offsetTop,
    scale,
  });

  test('counts only what the keyboard still covers after the iOS pan', () => {
    expect(measureVisualViewport(844, vv(500))).toEqual({
      height: 500,
      keyboardInset: 344,
      keyboardOpen: true,
    });
    // iOS panned the page up 100px: 100px of the gap is page, not keyboard.
    expect(measureVisualViewport(844, vv(500, 100))).toEqual({
      height: 500,
      keyboardInset: 244,
      keyboardOpen: true,
    });
  });

  test('reports no keyboard while pinch-zoomed and keeps the layout height', () => {
    expect(measureVisualViewport(844, vv(422, 200, 2))).toEqual({
      height: 844,
      keyboardInset: 0,
      keyboardOpen: false,
    });
  });

  test('treats gaps under 50px as browser chrome', () => {
    expect(measureVisualViewport(844, vv(795)).keyboardInset).toBe(0);
    expect(measureVisualViewport(844, vv(794)).keyboardInset).toBe(50);
    expect(measureVisualViewport(844, vv(500, 300)).keyboardInset).toBe(0);
  });

  test('falls back to the layout viewport without visualViewport', () => {
    expect(measureVisualViewport(700, null)).toEqual({
      height: 700,
      keyboardInset: 0,
      keyboardOpen: false,
    });
  });
});

describe('resizedForKeyboard', () => {
  test('counts a drop of 150px or more from the tallest height', () => {
    // A real iPhone web app: 894 tall, 478 with the keyboard up.
    expect(resizedForKeyboard(478, 894)).toBe(true);
    expect(resizedForKeyboard(745, 894)).toBe(false);
    expect(resizedForKeyboard(894, 894)).toBe(false);
  });
});

describe('useVisualViewportVars', () => {
  test('a shorter window with nothing focused is not a keyboard', async () => {
    const root0 = document.documentElement;
    const full = 894;
    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    await act(async () => root?.render(<Vars />));

    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    await move({ height: 600 });
    expect(root0.dataset.keyboard).toBeUndefined();

    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    delete (root0 as { clientHeight?: number }).clientHeight;
  });

  test('a blur keeps the keyboard open until the page grows back', async () => {
    const root0 = document.documentElement;
    const full = 894;
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    await act(async () => root?.render(<Vars />));
    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => 478,
    });
    await move({ height: 478 });
    expect(root0.dataset.keyboard).toBe('open');

    // Dismissing the keyboard blurs the field first; the page is still short.
    await act(async () => field.blur());
    expect(root0.dataset.keyboard).toBe('open');

    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    expect(root0.dataset.keyboard).toBeUndefined();
    delete (root0 as { clientHeight?: number }).clientHeight;
    field.remove();
  });

  test('marks the keyboard open when iOS resizes the whole page above it', async () => {
    const root0 = document.documentElement;
    const full = 894;
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    await act(async () => root?.render(<Vars />));
    expect(root0.dataset.keyboard).toBeUndefined();

    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => 478,
    });
    await move({ height: 478 });
    expect(cssVar('--keyboard-inset')).toBe('0px');
    expect(root0.dataset.keyboard).toBe('open');

    Object.defineProperty(root0, 'clientHeight', {
      configurable: true,
      get: () => full,
    });
    await move({ height: full });
    expect(root0.dataset.keyboard).toBeUndefined();
    delete (root0 as { clientHeight?: number }).clientHeight;
    field.remove();
  });

  test('publishes --vvh and --keyboard-inset and follows the viewport', async () => {
    const h = window.innerHeight;
    await act(async () => root?.render(<Vars />));
    expect(cssVar('--vvh')).toBe(`${h}px`);
    expect(cssVar('--keyboard-inset')).toBe('0px');

    await move({ height: h - 300 });
    expect(cssVar('--vvh')).toBe(`${h - 300}px`);
    expect(cssVar('--keyboard-inset')).toBe('300px');

    // The iOS pan arrives as a visualViewport scroll, not a resize.
    await move({ offsetTop: 120 }, 'scroll');
    expect(cssVar('--keyboard-inset')).toBe('180px');

    await act(async () => root?.unmount());
    root = null;
    expect(cssVar('--vvh')).toBe('');
    expect(cssVar('--keyboard-inset')).toBe('');
  });

  test('shares one set of listeners between all subscribers', async () => {
    const add = vi.spyOn(viewport, 'addEventListener');
    const remove = vi.spyOn(viewport, 'removeEventListener');
    await act(async () =>
      root?.render(
        <>
          <Vars />
          <Inset />
          <Inset />
        </>,
      ),
    );
    expect(add.mock.calls.map(([type]) => type).sort()).toEqual([
      'resize',
      'scroll',
    ]);

    await move({ height: window.innerHeight - 260 });
    expect(inset).toBe(260);

    await act(async () => root?.unmount());
    root = null;
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe('useKeyboardInset', () => {
  test('reads a keyboard that is already up when it mounts', async () => {
    viewport.height = window.innerHeight - 280;
    await act(async () => root?.render(<Inset />));
    expect(inset).toBe(280);

    await move({ height: window.innerHeight / 2, scale: 2 });
    expect(inset).toBe(0);
  });
});

describe('undoFocusScroll', () => {
  function field(overflowY: string) {
    const box = document.createElement('div');
    box.style.overflowY = overflowY;
    const input = document.createElement('textarea');
    box.appendChild(input);
    container?.appendChild(box);
    return { box, input };
  }

  test('undoes the iOS focus scroll of a hidden box around the focused field', () => {
    const { box, input } = field('hidden');
    input.focus();
    box.scrollTop = 120;
    undoFocusScroll();
    expect(box.scrollTop).toBe(0);
  });

  test('leaves real scrollers and unfocused boxes alone', () => {
    const scroller = field('auto');
    scroller.input.focus();
    scroller.box.scrollTop = 120;
    undoFocusScroll();
    expect(scroller.box.scrollTop).toBe(120);

    const hidden = field('hidden');
    hidden.box.scrollTop = 80;
    (document.activeElement as HTMLElement | null)?.blur();
    undoFocusScroll();
    expect(hidden.box.scrollTop).toBe(80);
  });

  test('runs on the scroll iOS fires once the shell is mounted', async () => {
    await act(async () => root?.render(<Vars />));
    const { box, input } = field('clip');
    input.focus();
    box.scrollTop = 60;
    box.dispatchEvent(new Event('scroll'));
    expect(box.scrollTop).toBe(0);
  });
});

describe('installed iOS web app', () => {
  function clientHeight(px: number) {
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      get: () => px,
    });
  }
  afterEach(() => {
    delete (document.documentElement as { clientHeight?: number }).clientHeight;
  });

  test('measures against the layout viewport when innerHeight shrinks with the keyboard', async () => {
    const full = window.innerHeight;
    clientHeight(full);
    await act(async () => root?.render(<Vars />));
    // iOS 27 standalone: innerHeight follows the visual viewport.
    const inner = vi
      .spyOn(window, 'innerHeight', 'get')
      .mockReturnValue(full - 397);
    await move({ height: full - 397 });
    expect(cssVar('--keyboard-inset')).toBe('397px');
    inner.mockRestore();
  });

  test('reads again after focus leaves, when iOS dropped the viewport event', async () => {
    vi.useFakeTimers();
    clientHeight(window.innerHeight);
    await act(async () => root?.render(<Vars />));
    await move({ height: window.innerHeight - 300 });
    expect(cssVar('--keyboard-inset')).toBe('300px');
    // The keyboard went away while the page was in the background.
    viewport.height = window.innerHeight;
    await act(async () => {
      document.dispatchEvent(new Event('focusout'));
      vi.advanceTimersByTime(400);
    });
    expect(cssVar('--keyboard-inset')).toBe('0px');
    vi.useRealTimers();
  });
});
