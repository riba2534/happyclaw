// @vitest-environment happy-dom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEdgeSwipe } from '../src/hooks/useEdgeSwipe';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let standalone = true;

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('standalone') ? standalone : true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function Harness(props: { onBack?: () => void; onForward?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeSwipe(ref, props);
  return (
    <div ref={ref} data-testid="pane">
      <pre data-swipe-back-ignore="true">wide code</pre>
    </div>
  );
}

function touch(target: Element, type: string, x: number, y = 300) {
  const point = { clientX: x, clientY: y, target } as unknown as Touch;
  const event = new Event(type, { bubbles: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [point],
  });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  target.dispatchEvent(event);
}

function swipe(target: Element, from: number, to: number) {
  act(() => {
    touch(target, 'touchstart', from);
    touch(target, 'touchmove', from + (to - from) / 2);
    touch(target, 'touchmove', to);
    touch(target, 'touchend', to);
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('useEdgeSwipe', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    standalone = true;
    stubMatchMedia();
    Object.defineProperty(window, 'innerWidth', {
      value: 400,
      configurable: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pane = () => container.querySelector('[data-testid="pane"]')!;

  it('goes back from the left edge and forward from the right edge', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    act(() => root.render(<Harness onBack={onBack} onForward={onForward} />));

    swipe(pane(), 5, 300);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).not.toHaveBeenCalled();

    swipe(pane(), 395, 100);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores short swipes, mid-screen starts and missing directions', () => {
    const onBack = vi.fn();
    act(() => root.render(<Harness onBack={onBack} />));

    swipe(pane(), 5, 100); // under the 40% threshold
    swipe(pane(), 200, 395); // not from the edge
    swipe(pane(), 395, 100); // no forward handler
    expect(onBack).not.toHaveBeenCalled();
    expect((pane() as HTMLElement).style.transform).toBe('');
  });

  it('never starts on horizontally scrolling content', () => {
    const onBack = vi.fn();
    act(() => root.render(<Harness onBack={onBack} />));

    swipe(container.querySelector('pre')!, 5, 300);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('leaves Safari tabs to the system gestures', () => {
    standalone = false;
    const onBack = vi.fn();
    act(() => root.render(<Harness onBack={onBack} />));

    swipe(pane(), 5, 300);
    expect(onBack).not.toHaveBeenCalled();
  });
});
