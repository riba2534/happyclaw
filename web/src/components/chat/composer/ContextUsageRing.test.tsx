// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { load, wsHandlers } = vi.hoisted(() => ({
  load: vi.fn(async () => undefined),
  wsHandlers: new Map<string, Set<(data: unknown) => void>>(),
}));

vi.mock('../../../stores/chat', async () => {
  const { create } = await import('zustand');
  return {
    useChatStore: create(() => ({
      contextUsage: {} as Record<string, unknown>,
      loadContextUsage: load,
    })),
  };
});

vi.mock('../../../api/ws', () => ({
  wsManager: {
    on(type: string, handler: (data: unknown) => void) {
      if (!wsHandlers.has(type)) wsHandlers.set(type, new Set());
      wsHandlers.get(type)!.add(handler);
      return () => wsHandlers.get(type)?.delete(handler);
    },
  },
}));

const emit = (type: string, data: unknown) =>
  act(() => wsHandlers.get(type)?.forEach((handler) => handler(data)));

const { useChatStore } = await import('../../../stores/chat');
const {
  ConversationContextUsage,
  ContextUsageRing,
  contextUsageFigures,
  formatTokenCount,
} = await import('./ContextUsageRing');

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
});

function render(node: React.ReactNode) {
  container ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(container);
  act(() => root!.render(node));
  return container.querySelector<HTMLElement>('[data-context-usage]');
}

const usage = (usedTokens: number | null, contextWindow: number | null) => ({
  usedTokens,
  contextWindow,
  percentage: null,
});

describe('formatTokenCount', () => {
  test.each([
    [0, '0'],
    [950, '950'],
    [12_345, '12.3K'],
    [120_000, '120K'],
    [200_000, '200K'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [1_500_000, '1.5M'],
  ])('%d → %s', (tokens, text) => {
    expect(formatTokenCount(tokens)).toBe(text);
  });
});

describe('ContextUsageRing', () => {
  test('shows the percentage, with the tokens in its tooltip label', () => {
    const ring = render(<ContextUsageRing usage={usage(120_000, 1_000_000)} />);
    expect(ring?.textContent).toBe('12%');
    expect(ring?.getAttribute('aria-label')).toBe(
      '上下文 已用 120K / 1M（12%）',
    );
  });

  test('hidden without data', () => {
    expect(render(<ContextUsageRing usage={undefined} />)).toBeNull();
    expect(render(<ContextUsageRing usage={null} />)).toBeNull();
    expect(render(<ContextUsageRing usage={usage(null, null)} />)).toBeNull();
  });

  test('falls back to the reported percentage without token counts', () => {
    expect(
      contextUsageFigures({ ...usage(null, null), percentage: 41.6 }),
    ).toEqual({ percent: 42, label: '上下文 已用 42%' });
  });

  test.each([
    [79, 'text-muted-foreground'],
    [80, 'text-warning'],
    [94, 'text-warning'],
    [95, 'text-error'],
    [100, 'text-error'],
  ])('%d%% is colored %s', (percent, tone) => {
    const ring = render(
      <ContextUsageRing usage={usage(percent * 2_000, 200_000)} />,
    );
    expect(ring?.classList.contains(tone)).toBe(true);
    for (const other of [
      'text-muted-foreground',
      'text-warning',
      'text-error',
    ]) {
      if (other !== tone) expect(ring?.classList.contains(other)).toBe(false);
    }
  });

  test('the arc follows the percentage and holds still with less motion', () => {
    const ring = render(<ContextUsageRing usage={usage(50_000, 200_000)} />)!;
    const [, arc] = ring.querySelectorAll('circle');
    const circumference = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      circumference * 0.75,
    );
    expect(arc.getAttribute('class')).toContain(
      'motion-reduce:transition-none',
    );
    expect(ring.className).toContain('motion-reduce:animate-none');
  });
});

describe('ConversationContextUsage', () => {
  test('shows the usage stored for its conversation only', () => {
    useChatStore.setState({
      contextUsage: {
        'web:g1#agent:a0': usage(10_000, 200_000),
        'web:g1#agent:a1': usage(150_000, 200_000),
      },
    });
    expect(
      render(<ConversationContextUsage jid="web:g1" agentId="a1" />)
        ?.textContent,
    ).toBe('75%');
    expect(
      render(<ConversationContextUsage jid="web:g1" agentId="a0" />)
        ?.textContent,
    ).toBe('5%');
    expect(
      render(<ConversationContextUsage jid="web:g1" agentId="a2" />),
    ).toBeNull();
  });
});

describe('loading', () => {
  test('a shown ring loads its conversation, again after a reconnect', () => {
    load.mockClear();
    render(<ConversationContextUsage jid="web:g1" agentId="a0" />);
    expect(load.mock.calls).toEqual([['web:g1', 'a0']]);

    render(<ConversationContextUsage jid="web:g1" agentId="a1" />);
    expect(load.mock.calls.at(-1)).toEqual(['web:g1', 'a1']);

    emit('connected', { reconnect: false });
    expect(load).toHaveBeenCalledTimes(2);
    emit('connected', { reconnect: true });
    expect(load.mock.calls.at(-1)).toEqual(['web:g1', 'a1']);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
