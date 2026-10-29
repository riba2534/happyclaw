// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  bottomSheetSnapHeights,
  settleBottomSheet,
} from './sheet';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function render(
  onOpenChange: (open: boolean) => void,
  ref?: unknown,
  detents: boolean | 'half' | 'full' = false,
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
        >
          <SheetTitle>标题</SheetTitle>
          <SheetDescription>说明</SheetDescription>
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
async function drag(
  handle: HTMLElement,
  from: number,
  to: number,
  slow = false,
) {
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
      'data-[side=bottom]:pb-[env(safe-area-inset-bottom)]',
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

  test("detents='full' opens at full and drags down to half", async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 700;
      },
    );
    const { content, handle } = render(vi.fn(), undefined, 'full');
    expect(content.dataset.snap).toBe('full');
    expect(content.style.height).toBe('780px');

    // Down past the midpoint and held still before letting go: no flick.
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
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    fire('pointerdown', 100);
    for (const clientY of [160, 220, 280, 280]) {
      await pause();
      fire('pointermove', clientY);
    }
    fire('pointerup', 280);
    expect(content.dataset.snap).toBe('half');
    expect(content.style.height).toBe('473px');
  });
});
