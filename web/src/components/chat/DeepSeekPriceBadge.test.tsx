// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { DeepSeekPriceBadge } from './DeepSeekPriceBadge';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(model: string | null) {
  act(() =>
    root.render(
      <TooltipProvider>
        <DeepSeekPriceBadge model={model} />
      </TooltipProvider>,
    ),
  );
  return container.querySelector<HTMLElement>('[data-deepseek-period]');
}

describe('DeepSeekPriceBadge', () => {
  test('hidden for other models', () => {
    vi.setSystemTime(new Date('2026-11-16T10:00:00+08:00'));
    expect(render('claude-opus-5-5')).toBeNull();
    expect(render(null)).toBeNull();
  });

  test('peak on a weekday morning, switching at noon', () => {
    vi.setSystemTime(new Date('2026-11-16T10:00:00+08:00'));
    const badge = render('deepseek-v4-pro')!;
    expect(badge.dataset.deepseekPeriod).toBe('peak');
    expect(badge.getAttribute('aria-label')).toContain('高峰时段');
  });

  test('turns off-peak by itself when the window closes', () => {
    vi.setSystemTime(new Date('2026-11-16T11:59:00+08:00'));
    const badge = render('deepseek-v4-pro')!;
    expect(badge.dataset.deepseekPeriod).toBe('peak');
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(
      container.querySelector<HTMLElement>('[data-deepseek-period]')!.dataset
        .deepseekPeriod,
    ).toBe('off-peak');
  });
});
