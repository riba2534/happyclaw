// @vitest-environment happy-dom

// The sanitizer hook itself is covered in a real browser by
// web/tests/e2e/markdown-render.spec.ts: DOMPurify does not sanitize
// correctly on happy-dom's DOM.
import { describe, expect, test, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { openMermaidLink } from './mermaid-svg';

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
  '<a xlink:href="https://example.com/doc"><rect id="safe"/></a>',
  '<a xlink:href="javascript:alert(1)"><rect id="js"/></a>',
  '<rect id="plain"/>',
  '</svg>',
].join('');

function click(id: string) {
  const host = document.createElement('div');
  host.innerHTML = SVG;
  const event = {
    target: host.querySelector(`#${id}`),
    currentTarget: host,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  const handled = openMermaidLink(event as unknown as MouseEvent<HTMLElement>);
  return { handled, event };
}

describe('openMermaidLink', () => {
  test('opens a diagram link in a new tab instead of navigating', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { handled, event } = click('safe');
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://example.com/doc',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  test('swallows links that are not http(s) or mailto', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { handled, event } = click('js');
    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  test('ignores clicks outside links', () => {
    const { handled, event } = click('plain');
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
