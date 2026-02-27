import { useState, useEffect } from 'react';
import { wsManager } from '../api/ws';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

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

  if (!online) return 'offline';
  if (!wsConnected) return 'reconnecting';
  return 'connected';
}
