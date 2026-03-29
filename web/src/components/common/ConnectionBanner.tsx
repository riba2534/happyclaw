import { useState, useEffect, useRef } from 'react';
import { Loader2, WifiOff, CheckCircle2 } from 'lucide-react';
import { useConnectionStatus, type ConnectionStatus } from '../../hooks/useConnectionStatus';

/**
 * ConnectionBanner uses absolute positioning to overlay the content
 * instead of being in the flex flow, preventing layout shifts (jitter)
 * when the banner appears/disappears during WS reconnection.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  const [showRecovered, setShowRecovered] = useState(false);
  const prevStatus = useRef<ConnectionStatus>(status);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (prevStatus.current !== 'connected' && status === 'connected') {
      setShowRecovered(true);
      timerRef.current = setTimeout(() => setShowRecovered(false), 2000);
    }
    prevStatus.current = status;
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [status]);

  if (status === 'connected' && !showRecovered) return null;

  // Common absolute positioning: overlay on top of content, no layout shift
  const baseClass = "absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium";

  if (showRecovered) {
    return (
      <div className={`${baseClass} bg-emerald-50 dark:bg-emerald-950/50 border-b border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 transition-all duration-300 animate-in fade-in slide-in-from-top-2`}>
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>已恢复连接</span>
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div className={`${baseClass} bg-red-50 dark:bg-red-950/50 border-b border-red-200 dark:border-red-800 text-red-700 dark:text-red-300`}>
        <WifiOff className="w-3.5 h-3.5" />
        <span>网络已断开</span>
      </div>
    );
  }

  // reconnecting
  return (
    <div className={`${baseClass} bg-amber-50 dark:bg-amber-950/50 border-b border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300`}>
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span>连接中断，正在重连...</span>
    </div>
  );
}
