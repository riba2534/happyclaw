import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { useIsPhone } from '../layout/phone';

/**
 * A reconnect this quick is not worth a word: a phone coming back to the
 * foreground reconnects in about a second, and used to flash two toasts. The
 * browser going offline waits the same: a network handoff flips that flag
 * for a moment while the socket survives.
 */
export const RECONNECT_GRACE_MS = 2500;
const RESTORED_MS = 2000;

type Notice = 'offline' | 'reconnecting' | 'restored';

const NOTICE_TEXT: Record<Notice, string> = {
  offline: '网络已断开',
  reconnecting: '连接中断，正在重连…',
  restored: '已恢复连接',
};

/** What to tell the user about the connection, after the grace period. */
function useConnectionNotice(): Notice | null {
  const status = useConnectionStatus();
  const [notice, setNotice] = useState<Notice | null>(null);
  // A cold start goes from "not yet connected" to connected without ever
  // having been cut off: only a real reconnect is announced as restored.
  const connectedOnce = useRef(false);

  useEffect(() => {
    if (status !== 'connected') {
      // Neither a dropped socket nor the browser's offline flag is proof of
      // an outage on its own. Once a notice shows, it follows the status at
      // once; before that, a cut that heals inside the grace period is
      // never mentioned.
      setNotice((current) =>
        current === 'offline' || current === 'reconnecting' ? status : current,
      );
      const timer = window.setTimeout(
        () => setNotice(status),
        RECONNECT_GRACE_MS,
      );
      return () => window.clearTimeout(timer);
    }
    const reconnected = connectedOnce.current;
    connectedOnce.current = true;
    setNotice((current) =>
      reconnected && (current === 'offline' || current === 'reconnecting')
        ? 'restored'
        : null,
    );
  }, [status]);

  useEffect(() => {
    if (notice !== 'restored') return;
    const timer = window.setTimeout(() => setNotice(null), RESTORED_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return notice;
}

/**
 * Connection problems. A desktop shows them as toasts; a phone as a thin
 * strip under the page's header (cindy's ConnectionNoticeOverlay), which
 * never takes a tap, so back and ⋯ stay usable while it shows.
 */
export function ConnectionBanner() {
  const notice = useConnectionNotice();
  const isPhone = useIsPhone();
  const isChatRoute = useLocation().pathname.startsWith('/chat');
  useEffect(() => {
    if (isPhone || !notice) return;
    const id =
      notice === 'offline'
        ? toast.error(NOTICE_TEXT.offline, { duration: Infinity })
        : notice === 'reconnecting'
          ? toast.loading(NOTICE_TEXT.reconnecting, { duration: Infinity })
          : toast.success(NOTICE_TEXT.restored, { duration: RESTORED_MS });
    return () => {
      toast.dismiss(id);
    };
  }, [notice, isPhone]);

  if (!isPhone || !notice) return null;
  return (
    <div
      role="status"
      data-connection-notice={notice}
      className={cn(
        'pointer-events-none absolute inset-x-0 z-40 flex h-7 items-center justify-center gap-1.5 border-b border-surface-border bg-surface-raised/95 px-4 text-caption text-foreground backdrop-blur-sm',
        // The chat header and the phone home bar are 56px, the page bar 52px.
        isChatRoute ? 'top-14' : 'top-13',
      )}
    >
      {notice === 'offline' ? (
        <WifiOff className="size-3.5 shrink-0 text-error" aria-hidden="true" />
      ) : notice === 'reconnecting' ? (
        <Spinner
          role="presentation"
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
      )}
      <span className="truncate">{NOTICE_TEXT[notice]}</span>
    </div>
  );
}
