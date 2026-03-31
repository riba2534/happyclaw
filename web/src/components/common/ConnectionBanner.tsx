import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConnectionStatus, type ConnectionStatus } from '../../hooks/useConnectionStatus';

/**
 * ConnectionBanner — now toast-based, renders no DOM.
 * Shows toast notifications for connection status changes.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  const prevStatus = useRef<ConnectionStatus>(status);
  const offlineToastId = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 'offline' && prev !== 'offline') {
      // Dismiss any existing toast first
      if (offlineToastId.current) toast.dismiss(offlineToastId.current);
      offlineToastId.current = toast.error('网络已断开', { duration: Infinity });
    } else if (status === 'reconnecting' && prev !== 'reconnecting') {
      if (offlineToastId.current) toast.dismiss(offlineToastId.current);
      offlineToastId.current = toast.loading('连接中断，正在重连...', { duration: Infinity });
    } else if (status === 'connected' && (prev === 'offline' || prev === 'reconnecting')) {
      if (offlineToastId.current) {
        toast.dismiss(offlineToastId.current);
        offlineToastId.current = undefined;
      }
      toast.success('已恢复连接', { duration: 2000 });
    }

    return () => {
      if (offlineToastId.current) {
        toast.dismiss(offlineToastId.current);
        offlineToastId.current = undefined;
      }
    };
  }, [status]);

  return null;
}
