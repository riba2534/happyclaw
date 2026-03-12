import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api/client';
import { getErrorMessage } from '../types';
import { copyToClipboard } from '../../../utils/clipboard';

interface PairingCodeResult {
  code: string;
  expiresAt: number;
  ttlSeconds: number;
}

interface UsePairingCodeOptions {
  /** API endpoint for generating pairing codes, e.g. '/api/config/user-im/telegram/pairing-code' */
  endpoint: string;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function usePairingCode({ endpoint, setNotice, setError }: UsePairingCodeOptions) {
  const [code, setCode] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const startCountdown = useCallback((expiresAt: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    const update = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) {
        setCode(null);
        if (countdownRef.current) clearInterval(countdownRef.current);
      }
    };
    update();
    countdownRef.current = setInterval(update, 1000);
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<PairingCodeResult>(endpoint);
      setCode(result.code);
      startCountdown(Date.now() + result.ttlSeconds * 1000);
    } catch (err) {
      setError(getErrorMessage(err, '生成配对码失败'));
    } finally {
      setGenerating(false);
    }
  }, [endpoint, setNotice, setError, startCountdown]);

  const copyCommand = useCallback(() => {
    if (!code) return;
    copyToClipboard(`/pair ${code}`)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        setError('复制失败，请手动复制');
      });
  }, [code, setError]);

  return { code, countdown, generating, copied, generate, copyCommand };
}
