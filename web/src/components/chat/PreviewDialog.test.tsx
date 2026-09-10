// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const { PreviewDialog } = await import('./PreviewDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body
    .querySelectorAll('[data-slot="dialog-overlay"], [role="dialog"]')
    .forEach((node) => node.remove());
  root = null;
  container = null;
  window.getSelection()?.removeAllRanges();
});

function fireSelectAll(target: Element, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe('PreviewDialog Ctrl/Cmd+A', () => {
  test('selects only the marked preview body', async () => {
    await act(async () => {
      root?.render(
        <PreviewDialog title="preview" onClose={() => {}}>
          <div>
            <p>outside</p>
            <pre data-preview-select-root>body text</pre>
          </div>
        </PreviewDialog>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const body = document.querySelector('[data-preview-select-root]');
    expect(dialog).toBeTruthy();
    expect(body).toBeTruthy();
    fireSelectAll(dialog!);

    const selection = window.getSelection();
    expect(selection?.toString()).toBe('body text');
    expect(body?.contains(selection?.anchorNode ?? null)).toBe(true);
  });

  test('leaves image overlays without a select root alone', async () => {
    await act(async () => {
      root?.render(
        <PreviewDialog title="image" onClose={() => {}}>
          <img alt="photo" src="about:blank" />
        </PreviewDialog>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('does not override native textarea select-all', async () => {
    await act(async () => {
      root?.render(
        <PreviewDialog title="edit" onClose={() => {}}>
          <textarea defaultValue="editable" />
          <pre data-preview-select-root>preview body</pre>
        </PreviewDialog>,
      );
    });

    const textarea = document.querySelector('textarea');
    expect(textarea).toBeTruthy();
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { value: textarea });
    document.querySelector('[role="dialog"]')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
