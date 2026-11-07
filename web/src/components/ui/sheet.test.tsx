// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  bottomSheetSnapHeights,
  settleBottomSheet,
} from './sheet';
import { emulatePointer, flushHistory } from './overlay-test-utils';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await flushHistory(act);
  vi.restoreAllMocks();
});

function render(
  onOpenChange: (open: boolean) => void,
  ref?: unknown,
  detents = false,
  extra: Partial<React.ComponentProps<typeof SheetContent>> = {},
) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          // A present but undefined ref, as some callers pass it.
          ref={ref as never}
          detents={detents}
          {...extra}
        >
          <SheetHeader data-header>
            <SheetTitle>标题</SheetTitle>
            <SheetDescription>说明</SheetDescription>
            <button type="button" data-header-button>
              筛选
            </button>
          </SheetHeader>
          <SheetBody data-body>内容</SheetBody>
        </SheetContent>
      </Sheet>,
    ),
  );
  const content = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  )!;
  const handle = content.querySelector<HTMLElement>('[data-sheet-handle]')!;
  return { content, handle };
}

/** A drag on the handle; `slow` spaces the moves out so it is no flick. */
async function drag(handle: Element, from: number, to: number, slow = false) {
  const fire = (type: string, clientY: number) =>
    act(() => {
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: 'touch',
          clientY,
        }),
      );
    });
  const pause = () =>
    slow ? new Promise((resolve) => setTimeout(resolve, 120)) : undefined;
  fire('pointerdown', from);
  await pause();
  fire('pointermove', (from + to) / 2);
  await pause();
  fire('pointermove', to);
  await pause();
  fire('pointerup', to);
}

describe('bottom sheet detents (cindy contextSheetModel)', () => {
  test('half is 56% of the screen, full leaves 64px above', () => {
    expect(bottomSheetSnapHeights(844)).toEqual({ half: 473, full: 780 });
    // Small screens keep at least 320px.
    expect(bottomSheetSnapHeights(480)).toEqual({ half: 320, full: 416 });
    // Too short a half for the content leaves only full.
    expect(bottomSheetSnapHeights(664, 440)).toEqual({ half: 600, full: 600 });
    expect(bottomSheetSnapHeights(844, 440)).toEqual({ half: 473, full: 780 });
  });

  test('a release settles to the nearest detent, or closes well below half', () => {
    const heights = { half: 473, full: 780 };
    expect(settleBottomSheet(700, heights)).toBe('full');
    expect(settleBottomSheet(600, heights)).toBe('half');
    expect(settleBottomSheet(300, heights)).toBe('half');
    expect(settleBottomSheet(280, heights)).toBe('dismiss');
  });
});

describe('the bottom sheet', () => {
  test('has a rounded top, a handle and safe-area padding', () => {
    const { content, handle } = render(vi.fn());
    expect(handle).not.toBeNull();
    expect(content.className).toContain('data-[side=bottom]:rounded-t-[12px]');
    expect(content.className).toContain(
      'data-[side=bottom]:pb-[var(--safe-bottom,0px)]',
    );
    expect(content.className).toContain('motion-reduce:transition-none');
  });

  test('short content keeps its height and closes when dragged down', async () => {
    const onOpenChange = vi.fn();
    const { content, handle } = render(onOpenChange, undefined);
    expect(content.hasAttribute('data-snap')).toBe(false);
    // A short, slow drag springs back.
    await drag(handle, 600, 640, true);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(content.style.transform).toBe('');
    // Far enough down, it closes; so does a quick flick.
    await drag(handle, 600, 760, true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a quick downward flick closes it even when short', async () => {
    const onOpenChange = vi.fn();
    const { handle } = render(onOpenChange);
    await drag(handle, 600, 640);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('with detents it opens at half, drags to full, and closes from there', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 700;
      },
    );
    const onOpenChange = vi.fn();
    const { content, handle } = render(onOpenChange, undefined, true);
    expect(content.dataset.snap).toBe('half');
    expect(content.style.height).toBe('473px');

    await drag(handle, 400, 100, true);
    expect(content.dataset.snap).toBe('full');
    expect(content.style.height).toBe('780px');

    await drag(handle, 100, 700, true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('bottom sheet structure', () => {
  test('the whole header drags it closed, like the handle', async () => {
    const onOpenChange = vi.fn();
    render(onOpenChange);
    const header = document.querySelector('[data-header]')!;
    expect(header.className).toContain('touch-none');
    await drag(header.querySelector('h2')!, 600, 760, true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("a header button's press is a tap, not a drag", async () => {
    const onOpenChange = vi.fn();
    render(onOpenChange);
    await drag(document.querySelector('[data-header-button]')!, 600, 760);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('SheetBody is the scroll region under a fixed header', () => {
    render(vi.fn());
    const body = document.querySelector('[data-body]')!;
    expect(body.getAttribute('data-slot')).toBe('sheet-body');
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');
    expect(body.className).toContain('overflow-y-auto');
  });

  test('it sits above the keyboard, within the visible viewport', () => {
    const { content } = render(vi.fn());
    expect(content.className).toContain(
      'data-[side=bottom]:bottom-[var(--keyboard-inset,0px)]',
    );
    expect(content.className).not.toContain('data-[side=bottom]:bottom-0');
    expect(content.className).toContain('max-h-[calc(var(--vvh,100dvh)-4rem)]');
  });

  test('a controlled detent follows the caller and reports drags', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 700;
      },
    );
    const onSnapChange = vi.fn();
    const { content, handle } = render(vi.fn(), undefined, true, {
      snap: 'full',
      onSnapChange,
    });
    expect(content.dataset.snap).toBe('full');
    expect(content.style.height).toBe('780px');
    // Down to about half, slowly enough not to count as a flick.
    const fire = (type: string, clientY: number) =>
      act(() => {
        handle.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 1, clientY }),
        );
      });
    fire('pointerdown', 100);
    for (const y of [180, 260, 340, 400]) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      fire('pointermove', y);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    fire('pointerup', 400);
    expect(onSnapChange).toHaveBeenCalledWith('half');
  });
});

describe('side sheets and back', () => {
  function side(sideName: 'left' | 'right', className?: string) {
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() =>
      root!.render(
        <Sheet open>
          <SheetContent side={sideName} className={className}>
            <SheetTitle>标题</SheetTitle>
            <SheetDescription>说明</SheetDescription>
          </SheetContent>
        </Sheet>,
      ),
    );
    return document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!;
  }

  test('left and right sheets pad the safe area, unless the caller pads', () => {
    expect(side('left').className).toContain('pl-[env(safe-area-inset-left)]');
    act(() => root?.unmount());
    expect(side('right').className).toContain(
      'pr-[env(safe-area-inset-right)]',
    );
    act(() => root?.unmount());
    expect(side('left', 'px-6').className).not.toContain(
      'pl-[env(safe-area-inset-left)]',
    );
  });

  test('the close button is 44px on phones', () => {
    side('right');
    const close = document.querySelector('[data-slot="sheet-close"]')!;
    expect(close.className).toContain('phone:size-11');
  });

  test('on a phone, back closes an uncontrolled sheet and stays put', async () => {
    emulatePointer('phone');
    window.history.replaceState({ key: 'base' }, '', '/capabilities');
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() =>
      root!.render(
        <Sheet>
          <SheetTrigger data-open-sheet>打开</SheetTrigger>
          <SheetContent side="bottom">
            <SheetTitle>标题</SheetTitle>
            <SheetDescription>说明</SheetDescription>
          </SheetContent>
        </Sheet>,
      ),
    );
    act(() =>
      document.querySelector<HTMLElement>('[data-open-sheet]')!.click(),
    );
    await flushHistory(act);
    expect(
      document.querySelector('[data-slot="sheet-content"]'),
    ).not.toBeNull();
    act(() => window.history.back());
    await flushHistory(act);
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(window.location.pathname).toBe('/capabilities');
    expect(window.history.state).toEqual({ key: 'base' });
  });
});
