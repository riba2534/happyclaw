// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from './dialog';
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
  ui: (open: boolean) => React.ReactNode,
  open = true,
): { rerender: (open: boolean) => void } {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root!.render(ui(open)));
  return { rerender: (next) => act(() => root!.render(ui(next))) };
}

function form(
  props: { autoFocusOnPhone?: boolean; autoFocusAttr?: boolean } = {},
  onOpenChange: (open: boolean) => void = () => {},
) {
  return (open: boolean) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent autoFocusOnPhone={props.autoFocusOnPhone}>
        <DialogTitle>新建</DialogTitle>
        <DialogDescription>说明</DialogDescription>
        <input data-field autoFocus={props.autoFocusAttr} />
        <DialogFooter>
          <button type="button">保存</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const content = () =>
  document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
const field = () => document.querySelector<HTMLElement>('[data-field]')!;

describe('DialogContent focus on open', () => {
  test('a desktop focuses the first field as before', () => {
    emulatePointer('desktop');
    render(form());
    expect(document.activeElement).toBe(field());
  });

  test('a phone focuses the dialog, not a field', () => {
    emulatePointer('phone');
    render(form());
    expect(document.activeElement).toBe(content());
  });

  test('a field with its own autoFocus is undone on a phone', () => {
    emulatePointer('phone');
    render(form({ autoFocusAttr: true }));
    expect(document.activeElement).toBe(content());
  });

  test('autoFocusOnPhone lets a single-field dialog focus its field', () => {
    emulatePointer('phone');
    render(form({ autoFocusOnPhone: true }));
    expect(document.activeElement).toBe(field());
  });

  test("a caller's own onOpenAutoFocus still runs and wins", () => {
    emulatePointer('phone');
    const onOpenAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
      document.querySelector<HTMLElement>('[data-other]')?.focus();
    });
    render(() => (
      <Dialog open>
        <DialogContent onOpenAutoFocus={onOpenAutoFocus}>
          <DialogTitle>标题</DialogTitle>
          <DialogDescription>说明</DialogDescription>
          <input />
          <button type="button" data-other>
            其他
          </button>
        </DialogContent>
      </Dialog>
    ));
    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.querySelector('[data-other]'));
  });
});

describe('DialogContent on a phone', () => {
  test('is a bottom sheet that callers cannot resize back', () => {
    emulatePointer('phone');
    render(() => (
      <Dialog open>
        <DialogContent className="max-h-[85vh] sm:max-w-2xl">
          <DialogTitle>标题</DialogTitle>
          <DialogDescription>说明</DialogDescription>
        </DialogContent>
      </Dialog>
    ));
    const classes = content().className.split(' ');
    for (const name of [
      'phone:top-auto!',
      'phone:bottom-[var(--keyboard-inset,0px)]!',
      'phone:max-h-[calc(var(--vvh,100dvh)-3rem)]!',
      'phone:max-w-none!',
      'phone:rounded-b-none!',
    ]) {
      expect(classes).toContain(name);
    }
    // The caller's desktop sizing is still there for desktops.
    expect(classes).toContain('sm:max-w-2xl');
  });

  test('the footer carries the safe area and the close button is 44px', () => {
    emulatePointer('phone');
    render(form());
    const footer = document.querySelector('[data-slot="dialog-footer"]')!;
    expect(footer.className).toContain(
      'phone:pb-[calc(1rem+var(--safe-bottom,0px))]',
    );
    const close = document.querySelector('[data-slot="dialog-close"]')!;
    expect(close.className).toContain('phone:size-11');
  });

  test('system back closes it; other closes pop its entry', async () => {
    emulatePointer('phone');
    window.history.replaceState({ key: 'base' }, '', '/automations');
    const onOpenChange = vi.fn();
    const { rerender } = render(form({}, onOpenChange));
    await flushHistory(act);
    expect(window.history.state).toHaveProperty('__happyclawOverlays');

    act(() => window.history.back());
    await flushHistory(act);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(window.location.pathname).toBe('/automations');

    rerender(false);
    await flushHistory(act);
    rerender(true);
    await flushHistory(act);
    const back = vi.spyOn(window.history, 'back');
    rerender(false);
    await flushHistory(act);
    expect(back).toHaveBeenCalledTimes(1);
  });

  test('a desktop never touches history', async () => {
    emulatePointer('desktop');
    const push = vi.spyOn(window.history, 'pushState');
    render(form());
    await flushHistory(act);
    expect(push).not.toHaveBeenCalled();
  });
});
