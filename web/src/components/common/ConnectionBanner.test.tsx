// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { emulatePointer } from '../ui/overlay-test-utils';

const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    connected: true,
    handlers,
    emit(type: string) {
      ws.connected = type === 'connected';
      handlers.get(type)?.forEach((handler) => handler({}));
    },
  };
});
vi.mock('../../api/ws', () => ({
  wsManager: {
    isConnected: () => ws.connected,
    on(type: string, handler: (data: unknown) => void) {
      if (!ws.handlers.has(type)) ws.handlers.set(type, new Set());
      ws.handlers.get(type)!.add(handler);
      return () => ws.handlers.get(type)!.delete(handler);
    },
  },
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(() => 'error-id'),
  loading: vi.fn(() => 'loading-id'),
  success: vi.fn(() => 'success-id'),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

import { ConnectionBanner, RECONNECT_GRACE_MS } from './ConnectionBanner';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  ws.connected = true;
  ws.handlers.clear();
  Object.values(toast).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(kind: 'phone' | 'desktop', path = '/chat/alpha') {
  emulatePointer(kind);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <ConnectionBanner />
      </MemoryRouter>,
    ),
  );
}

const strip = () =>
  container!.querySelector<HTMLElement>('[data-connection-notice]');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('ConnectionBanner on a phone', () => {
  test('a reconnect inside the grace period shows nothing', () => {
    render('phone');
    act(() => ws.emit('disconnected'));
    advance(RECONNECT_GRACE_MS - 500);
    expect(strip()).toBeNull();
    act(() => ws.emit('connected'));
    advance(5000);
    expect(strip()).toBeNull();
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('a longer outage shows a strip that never takes taps, then one restored notice', () => {
    render('phone');
    act(() => ws.emit('disconnected'));
    advance(RECONNECT_GRACE_MS);
    expect(strip()?.dataset.connectionNotice).toBe('reconnecting');
    expect(strip()?.textContent).toContain('正在重连');
    expect(strip()?.className).toContain('pointer-events-none');
    // Under the 56px chat header.
    expect(strip()?.className).toContain('top-14');

    act(() => ws.emit('connected'));
    expect(strip()?.dataset.connectionNotice).toBe('restored');
    advance(2000);
    expect(strip()).toBeNull();
    // No toasts on a phone: they would cover the header.
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('the browser going offline while the socket is open says nothing', () => {
    render('phone');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    advance(RECONNECT_GRACE_MS * 4);
    expect(strip()).toBeNull();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    advance(5000);
    expect(strip()).toBeNull();
  });

  test('offline with the socket down shows after the grace period, under the page bar off the chat', () => {
    render('phone', '/automations');
    act(() => {
      // happy-dom keeps navigator.onLine; the event is what the hook hears.
      window.dispatchEvent(new Event('offline'));
      ws.emit('disconnected');
    });
    advance(RECONNECT_GRACE_MS - 1);
    expect(strip()).toBeNull();
    advance(1);
    expect(strip()?.dataset.connectionNotice).toBe('offline');
    expect(strip()?.className).toContain('top-13');

    // Once shown, the notice follows the status without another wait.
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(strip()?.dataset.connectionNotice).toBe('reconnecting');
    act(() => ws.emit('connected'));
    expect(strip()?.dataset.connectionNotice).toBe('restored');
  });

  test('a network handoff that heals inside the grace period shows nothing', () => {
    render('phone');
    act(() => {
      window.dispatchEvent(new Event('offline'));
      ws.emit('disconnected');
    });
    advance(1000);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    advance(500);
    act(() => ws.emit('connected'));
    advance(5000);
    expect(strip()).toBeNull();
  });
});

describe('ConnectionBanner on a desktop', () => {
  test('toasts only after the grace period, and the restored one replaces it', () => {
    render('desktop');
    act(() => ws.emit('disconnected'));
    advance(RECONNECT_GRACE_MS - 1);
    expect(toast.loading).not.toHaveBeenCalled();
    advance(1);
    expect(toast.loading).toHaveBeenCalledTimes(1);
    expect(strip()).toBeNull();

    act(() => ws.emit('connected'));
    expect(toast.dismiss).toHaveBeenCalledWith('loading-id');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
