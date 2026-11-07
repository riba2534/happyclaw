// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Users } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmptyState } from '../src/components/common/EmptyState';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function art() {
  return container.querySelector<HTMLElement>('[data-slot="empty-art"]');
}

describe('EmptyState', () => {
  it('draws the illustration for an existing caller without new props', () => {
    act(() => root.render(<EmptyState icon={Users} title="暂无用户" />));
    expect(art()?.dataset.variant).toBe('empty');
    expect(art()?.getAttribute('aria-hidden')).toBe('true');
    // The caller's icon sits inside the scene's SVG.
    expect(art()?.querySelector('svg svg.lucide')).not.toBeNull();
    expect(container.textContent).toBe('暂无用户');
  });

  it('draws the scene without an icon', () => {
    act(() =>
      root.render(<EmptyState title="没有匹配的渠道" variant="search" />),
    );
    expect(art()?.dataset.variant).toBe('search');
    expect(art()?.querySelector('svg svg')).toBeNull();
    expect(art()?.querySelectorAll('circle[r="11"]')).toHaveLength(1);
  });

  it('marks the error scene with a badge in the error colour', () => {
    act(() =>
      root.render(<EmptyState icon={Users} variant="error" title="加载失败" />),
    );
    expect(art()?.dataset.variant).toBe('error');
    expect(art()?.querySelector('g.text-error circle[r="9"]')).not.toBeNull();
  });
});
