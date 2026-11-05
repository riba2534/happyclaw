// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Closed while the page was frozen; the close event is not delivered yet. */
  dieQuietly() {
    this.readyState = FakeSocket.CLOSED;
  }

  close() {
    this.closeCalls++;
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }

  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

type Manager = (typeof import('./ws'))['wsManager'];
type Ws = typeof import('./ws');
let ws: Ws;
let manager: Manager;

const sockets = () => FakeSocket.instances;
const latest = () => sockets()[sockets().length - 1];

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  // A fresh manager per test; each import installs its own listeners.
  vi.resetModules();
  ws = await import('./ws');
  manager = ws.wsManager;
});

afterEach(() => {
  manager.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wsManager', () => {
  test('abandons a handshake that never completes and retries', () => {
    manager.connect();
    const first = latest();
    vi.advanceTimersByTime(ws.WS_HANDSHAKE_TIMEOUT_MS - 1);
    expect(first.closeCalls).toBe(0);

    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toBe(1);
    // Retry follows the usual backoff (1s ±30%).
    vi.advanceTimersByTime(1300);
    expect(sockets()).toHaveLength(2);
  });

  test('a handshake that completes in time is kept', () => {
    manager.connect();
    latest().open();
    vi.advanceTimersByTime(ws.WS_HANDSHAKE_TIMEOUT_MS * 2);
    expect(sockets()).toHaveLength(1);
    expect(latest().closeCalls).toBe(0);
  });

  test('going offline does not cancel the pending reconnect', () => {
    manager.connect();
    latest().open();
    latest().close();
    window.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(1300);
    expect(sockets()).toHaveLength(2);
  });

  test('coming online reconnects at once instead of waiting out the backoff', () => {
    manager.connect();
    latest().close();
    expect(sockets()).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(2);
  });

  test('back in the foreground, a socket that died unreported is replaced and resynced', () => {
    const connected = vi.fn();
    const disconnected = vi.fn();
    manager.on('connected', connected);
    manager.on('disconnected', disconnected);
    manager.connect();
    const dead = latest();
    dead.open();
    expect(connected).toHaveBeenLastCalledWith({ reconnect: false });

    setVisibility('hidden');
    dead.dieQuietly();
    setVisibility('visible');

    expect(sockets()).toHaveLength(2);
    // Its close event, delivered late, is not reported as a new outage.
    dead.onclose?.({ code: 1006 });
    expect(disconnected).not.toHaveBeenCalled();
    latest().open();
    expect(connected).toHaveBeenLastCalledWith({ reconnect: true });
  });

  test('back after a long absence, an open socket that answers the ping is kept', () => {
    manager.connect();
    latest().open();
    setVisibility('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    setVisibility('visible');
    expect(latest().sent).toEqual([JSON.stringify({ type: 'ping' })]);
    latest().receive({ type: 'pong' });
    vi.advanceTimersByTime(ws.WS_PROBE_TIMEOUT_MS + 100);
    expect(sockets()).toHaveLength(1);
    expect(latest().closeCalls).toBe(0);
  });

  test('back after a long absence, an open socket that stays silent is replaced and resynced', () => {
    const connected = vi.fn();
    const disconnected = vi.fn();
    manager.on('connected', connected);
    manager.on('disconnected', disconnected);
    manager.connect();
    const stale = latest();
    stale.open();
    setVisibility('hidden');
    vi.advanceTimersByTime(5 * 60_000);
    setVisibility('visible');
    // Resume events arriving together send one ping.
    window.dispatchEvent(new Event('online'));
    expect(stale.sent).toHaveLength(1);
    vi.advanceTimersByTime(ws.WS_PROBE_TIMEOUT_MS + 100);
    expect(stale.closeCalls).toBe(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(sockets()).toHaveLength(2);
    latest().open();
    expect(connected).toHaveBeenLastCalledWith({ reconnect: true });
  });

  test('a short trip to the background does not probe', () => {
    manager.connect();
    latest().open();
    setVisibility('hidden');
    vi.advanceTimersByTime(ws.WS_PROBE_AFTER_HIDDEN_MS - 1000);
    setVisibility('visible');
    expect(latest().sent).toEqual([]);
  });

  test('a pending handshake is left alone and keeps its first-open meaning', () => {
    const connected = vi.fn();
    manager.on('connected', connected);
    manager.connect();
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    expect(sockets()).toHaveLength(1);
    latest().open();
    expect(connected).toHaveBeenCalledWith({ reconnect: false });
  });

  test('back in the foreground, a closed socket reconnects without waiting', () => {
    manager.connect();
    latest().open();
    latest().close();
    setVisibility('visible');
    expect(sockets()).toHaveLength(2);
  });

  test('a page restored from the back/forward cache reconnects a dead socket', () => {
    manager.connect();
    latest().open();
    latest().dieQuietly();
    const firstLoad = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(firstLoad, 'persisted', { value: false });
    window.dispatchEvent(firstLoad);
    expect(sockets()).toHaveLength(1);

    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(sockets()).toHaveLength(2);
  });

  test('resume events arriving together open one socket, not one each', () => {
    manager.connect();
    latest().open();
    latest().dieQuietly();
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    window.dispatchEvent(new Event('online'));
    setVisibility('visible');
    expect(sockets()).toHaveLength(2);
    expect(latest().closeCalls).toBe(0);
  });

  test('reconnect attempts back off 1s, 2s, 4s… up to 30s, one at a time', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    manager.connect();
    latest().close();
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      const count = sockets().length;
      let waited = 0;
      while (sockets().length === count) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      expect(sockets()).toHaveLength(count + 1);
      gaps.push(waited);
      latest().close();
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    vi.mocked(Math.random).mockRestore();
  });

  test('the browser going offline pings an open socket once, and keeps it if it answers', () => {
    const disconnected = vi.fn();
    manager.on('disconnected', disconnected);
    manager.connect();
    latest().open();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(latest().sent).toEqual([JSON.stringify({ type: 'ping' })]);
    latest().receive({ type: 'pong' });
    vi.advanceTimersByTime(ws.WS_PROBE_TIMEOUT_MS);
    expect(sockets()).toHaveLength(1);
    expect(disconnected).not.toHaveBeenCalled();
  });

  test('the browser going offline replaces an open socket that stays silent', () => {
    const disconnected = vi.fn();
    manager.on('disconnected', disconnected);
    manager.connect();
    const stale = latest();
    stale.open();
    window.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(ws.WS_PROBE_TIMEOUT_MS - 1);
    expect(disconnected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stale.closeCalls).toBe(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(sockets()).toHaveLength(2);
  });

  test('the browser going offline with no socket wanted does nothing', () => {
    window.dispatchEvent(new Event('offline'));
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(0);
  });

  test('stays down after disconnect() even when the page returns', () => {
    manager.connect();
    latest().open();
    manager.disconnect();
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  test('a throwing handler does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    manager.on('task_notification', () => {
      throw new Error('boom');
    });
    manager.on('task_notification', after);
    manager.connect();
    latest().open();
    latest().receive({ type: 'task_notification', id: 1 });
    expect(after).toHaveBeenCalledWith({ type: 'task_notification', id: 1 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
