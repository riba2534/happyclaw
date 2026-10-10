import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyToClipboard } from '../../utils/clipboard';

const COPIED_MS = 2000;

/**
 * Copy text and report the outcome: `copied` turns on only after the write
 * resolved, and a failure (no clipboard access, e.g. plain-HTTP installs
 * where even the fallback is refused) shows a toast instead.
 */
export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback((text: string) => {
    copyToClipboard(text).then(
      () => {
        if (!mounted.current) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => toast.error('复制失败，请手动选择文本复制'),
    );
  }, []);

  return { copied, copy };
}
