import { replaceInApp, withBasePath } from '../utils/url';

type WsHandler = (data: any) => void;

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WsHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  /** Whether a socket of this page has opened before (later opens are reconnects). */
  private openedBefore = false;
  private failedBeforeOpen = false;

  connect() {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${withBasePath('/ws')}`,
    );
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
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
      try {
        const data = JSON.parse(event.data);
        this.emit(data.type, data);
      } catch {}
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      if (!this.openedBefore) this.failedBeforeOpen = true;
      this.emit('disconnected', {});
      // 1008 = Policy Violation (backend auth failure), 4001 = custom auth error
      if (event.code === 1008 || event.code === 4001) {
        this.ws = null;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
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
    this.handlers.get(type)?.forEach((h) => h(data));
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

  /** Listen for network status changes to reconnect immediately or pause retries. */
  setupNetworkListeners() {
    window.addEventListener('online', () => {
      // Network restored — reconnect immediately, reset backoff
      if (!this.isConnected()) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.reconnectDelay = 1000;
        this.connect();
      }
    });
    window.addEventListener('offline', () => {
      // Network lost — cancel pending reconnect to avoid wasted attempts
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });
  }
}

export const wsManager = new WsManager();
wsManager.setupNetworkListeners();
