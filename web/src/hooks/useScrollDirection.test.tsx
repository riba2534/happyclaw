// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createShellScrollTracker,
  stepShellScroll,
  useShellScrollState,
  type ShellScrollState,
} from './useScrollDirection';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function run(offsets: number[], start = 0): ShellScrollState[] {
  let tracker = createShellScrollTracker(start);
  return offsets.map((top) => {
    tracker = stepShellScroll(tracker, top);
    return tracker.state;
  });
}

describe('stepShellScroll', () => {
  test('stays expanded until past 64px, then compacts', () => {
    expect(run([20, 40, 64, 65])).toEqual([
      'expanded',
      'expanded',
      'expanded',
      'compact',
    ]);
  });

  test('scrolling back up reveals, and only within 24px expands', () => {
    expect(run([100, 200, 150, 60, 30, 23])).toEqual([
      'compact',
      'compact',
      'revealed',
      'revealed',
      'revealed',
      'expanded',
    ]);
  });

  test('jitter under 4px against the direction changes nothing', () => {
    // Down to 300, then a back-and-forth of a few pixels.
    expect(run([100, 300, 297, 299, 297, 300, 298])).toEqual(
      Array(7).fill('compact'),
    );
    // Revealed, then small downward wobbles stay revealed.
    expect(run([100, 300, 200, 203, 201, 203])).toEqual([
      'compact',
      'compact',
      'revealed',
      'revealed',
      'revealed',
      'revealed',
    ]);
  });

  test('a reversal is measured from the turning point', () => {
    // 1px steps up add up: the fourth one from the peak reveals.
    expect(run([100, 300, 299, 298, 297, 296])).toEqual([
      'compact',
      'compact',
      'compact',
      'compact',
      'compact',
      'revealed',
    ]);
  });

  test('starts compact when the page is already scrolled', () => {
    expect(createShellScrollTracker(500).state).toBe('compact');
    expect(createShellScrollTracker(40).state).toBe('expanded');
  });
});

describe('useShellScrollState', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    document.body.removeAttribute('data-scroll-locked');
    vi.restoreAllMocks();
  });

  test('follows the app scroll root and freezes while scroll is locked', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const scroller = document.body.appendChild(document.createElement('main'));
    scroller.dataset.appScrollRoot = 'true';
    Object.defineProperty(scroller, 'scrollHeight', { value: 5000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 800 });

    const seen: ShellScrollState[] = [];
    function Probe() {
      seen.push(useShellScrollState());
      return null;
    }
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    const scrollTo = (top: number) =>
      act(() => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event('scroll'));
        frames.splice(0).forEach((cb) => cb(0));
      });
    const last = () => seen[seen.length - 1];

    scrollTo(400);
    expect(last()).toBe('compact');

    // A dialog locks scrolling; whatever happens underneath is ignored.
    document.body.setAttribute('data-scroll-locked', '1');
    scrollTo(0);
    expect(last()).toBe('compact');

    // Unlocked: the next movement starts from where the lock left it.
    document.body.removeAttribute('data-scroll-locked');
    scroller.scrollTop = 400;
    scrollTo(402);
    expect(last()).toBe('compact');
    scrollTo(380);
    expect(last()).toBe('revealed');

    scroller.remove();
  });
});
