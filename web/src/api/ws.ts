import { replaceInApp, withBasePath } from '../utils/url';

type WsHandler = (data: any) => void;

/** A handshake still pending after this long is abandoned and retried. */
export const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
/** An open socket that answers nothing this long after a ping is replaced. */
export const WS_PROBE_TIMEOUT_MS = 4_000;
/** Back after this long hidden (or on `online`), an open socket is probed. */
export const WS_PROBE_AFTER_HIDDEN_MS = 30_000;

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  /** Whether a socket of this page has opened before (later opens are reconnects). */
  private openedBefore = false;
  private failedBeforeOpen = false;
  /** connect() was called and disconnect() has not been since. */
  private wanted = false;
  /** Anything received on the current socket bumps this. */
  private received = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;

  connect() {
    this.wanted = true;
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.clearReconnectTimer();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${withBasePath('/ws')}`,
    );
    this.ws = ws;
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearHandshakeTimer();
      this.reconnectDelay = 1000;
      // Listeners reconcile state missed while the socket was down; the
      // page's first open follows the initial HTTP loads, so it says so.
      // A failed attempt before the first open (e.g. the server was
      // restarting during page load) means events may already be missing.
      const reconnect = this.openedBefore || this.failedBeforeOpen;
      this.openedBefore = true;
      this.emit('connected', { reconnect });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.received += 1;
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.emit(data.type, data);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.clearHandshakeTimer();
      this.clearProbeTimer();
      if (!this.openedBefore) this.failedBeforeOpen = true;
      this.emit('disconnected', {});
      // 1008 = Policy Violation (backend auth failure), 4001 = custom auth error
      if (event.code === 1008 || event.code === 4001) {
        this.ws = null;
        this.wanted = false;
        replaceInApp('/login');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      ws.close();
    };
  }

  disconnect() {
    this.wanted = false;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
    this.clearProbeTimer();
    const ws = this.ws;
    // Detach first so its close is not taken for an outage to recover from.
    this.ws = null;
    ws?.close();
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  on(type: string, handler: WsHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, data: any) {
    this.handlers.get(type)?.forEach((h) => {
      // One failing listener must not starve the others of the event.
      try {
        h(data);
      } catch (err) {
        console.error(`[ws] "${type}" handler failed`, err);
      }
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearProbeTimer() {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    // ±30% jitter so tabs dropped together (e.g. a server restart) don't
    // all reconnect and refetch in the same second.
    const jitter = 0.7 + Math.random() * 0.6;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay,
        );
        this.connect();
      },
      Math.round(this.reconnectDelay * jitter),
    );
  }

  /**
   * Reconnect now unless the socket is open or its handshake is pending
   * (resume often fires pageshow, online and visibilitychange together; the
   * handshake deadline covers one that hangs). With `probe`, an open socket
   * is asked for a pong: a phone back from the background or a network
   * change can hold a socket that still reads OPEN but reaches nothing, and
   * the server's protocol pings are invisible here. Any message within the
   * deadline keeps it; silence replaces it. A replaced socket's close is
   * ignored; the new socket's open reports `reconnect: true`, which runs the
   * usual missed-state sync.
   */
  private ensureLive(probe = false) {
    if (!this.wanted) return;
    const ws = this.ws;
    const state = ws?.readyState;
    if (state === WebSocket.CONNECTING) return;
    if (ws && state === WebSocket.OPEN) {
      if (probe) this.probe(ws);
      return;
    }
    if (this.ws && !this.openedBefore) this.failedBeforeOpen = true;
    this.clearReconnectTimer();
    this.reconnectDelay = 1000;
    this.connect();
  }

  /**
   * Ask an open socket for a pong, once at a time: a probe already in flight
   * answers for every later request. Any message within the deadline keeps
   * the socket; silence replaces it and reports the loss.
   */
  private probe(ws: WebSocket) {
    if (this.probeTimer) return;
    const before = this.received;
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      // A send that throws is as good as silence.
    }
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws !== ws || this.received !== before) return;
      this.ws = null;
      ws.close();
      this.emit('disconnected', {});
      this.reconnectDelay = 1000;
      this.connect();
    }, WS_PROBE_TIMEOUT_MS);
  }

  /** Watch page lifecycle and network changes to recover a lost connection. */
  setupNetworkListeners() {
    // Network restored or page back in front: a socket that closed while the
    // page was frozen or offline need not wait out its backoff. Going
    // offline leaves the backoff running; nothing ever cancels it.
    window.addEventListener('online', () => this.ensureLive(true));
    // The browser's offline flag alone is not proof: it flickers on a network
    // handoff while the socket carries on. Only a socket that then fails its
    // ping counts as lost.
    window.addEventListener('offline', () => {
      if (this.wanted && this.ws?.readyState === WebSocket.OPEN) {
        this.probe(this.ws);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        return;
      }
      const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
      this.hiddenAt = null;
      this.ensureLive(away >= WS_PROBE_AFTER_HIDDEN_MS);
    });
    // A page restored from the back/forward cache resumes with whatever
    // became of its socket while frozen.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.ensureLive(true);
    });
  }
}

export const wsManager = new WsManager();
// Stores import the manager (auth disconnects on logout), and their unit
// tests load it outside a browser.
if (typeof window !== 'undefined') wsManager.setupNetworkListeners();
