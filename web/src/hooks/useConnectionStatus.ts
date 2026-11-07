import { useState, useEffect } from 'react';
import { wsManager } from '../api/ws';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

/**
 * The socket is the authority. An open one means connected even while the
 * browser says offline (that flag flickers on a network handoff; wsManager
 * pings the socket then, and drops it if the ping goes unanswered). A socket
 * that is down is `offline` when the browser also has no network, otherwise
 * `reconnecting`. Either is still unconfirmed: ConnectionBanner waits out a
 * grace period before saying anything.
 */
export function deriveConnectionStatus(
  wsConnected: boolean,
  browserOnline: boolean,
): ConnectionStatus {
  if (wsConnected) return 'connected';
  return browserOnline ? 'reconnecting' : 'offline';
}

export function useConnectionStatus(): ConnectionStatus {
  const [wsConnected, setWsConnected] = useState(wsManager.isConnected());
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    setWsConnected(wsManager.isConnected()); // 同步当前真实状态，防止错过 connected 事件
    const unsubConn = wsManager.on('connected', () => setWsConnected(true));
    const unsubDisc = wsManager.on('disconnected', () => setWsConnected(false));
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      unsubConn();
      unsubDisc();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return deriveConnectionStatus(wsConnected, online);
}
