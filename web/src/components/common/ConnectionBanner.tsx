import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConnectionStatus, type ConnectionStatus } from '../../hooks/useConnectionStatus';

/**
 * ConnectionBanner — now uses toast notifications instead of a banner overlay.
 * Renders nothing in the DOM.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  const prevStatus = useRef<ConnectionStatus>(status);
  const toastId = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 'reconnecting' && prev === 'connected') {
      // Show persistent reconnecting toast
      toastId.current = toast.loading('连接中断，正在重连...', { duration: Infinity });
    } else if (status === 'offline' && prev !== 'offline') {
      // Dismiss reconnecting toast, show offline
      if (toastId.current) toast.dismiss(toastId.current);
      toastId.current = toast.error('网络已断开', { duration: Infinity });
    } else if (status === 'connected' && prev !== 'connected') {
      // Dismiss any previous toast, show brief success
      if (toastId.current) toast.dismiss(toastId.current);
      toastId.current = undefined;
      toast.success('已恢复连接', { duration: 2000 });
    }
  }, [status]);

  return null;
}
