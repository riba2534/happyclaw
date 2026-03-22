import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, CheckCircle2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

type QRStatus = 'loading' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';

interface QRCodeResponse {
  qrcode: string;
  qrcodeUrl: string;
}

interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
}

interface WeChatQRDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function WeChatQRDialog({ isOpen, onClose, onSuccess }: WeChatQRDialogProps) {
  const [status, setStatus] = useState<QRStatus>('loading');
  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closingRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchQRCode = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setQrcodeUrl(null);
    setQrcode(null);
    clearPoll();

    try {
      const data = await api.post<QRCodeResponse>('/api/config/user-im/wechat/qrcode');
      setQrcodeUrl(data.qrcodeUrl);
      setQrcode(data.qrcode);
      setStatus('wait');
    } catch (err) {
      setError(getErrorMessage(err, '获取二维码失败'));
      setStatus('error');
    }
  }, [clearPoll]);

  // Start polling when QR code is ready
  useEffect(() => {
    if (!qrcode || status === 'confirmed' || status === 'expired' || status === 'error') return;

    pollRef.current = setInterval(async () => {
      try {
        const data = await api.get<QRStatusResponse>(
          `/api/config/user-im/wechat/qrcode-status?qrcode=${encodeURIComponent(qrcode)}`,
        );
        setStatus(data.status);

        if (data.status === 'confirmed') {
          clearPoll();
          setTimeout(() => {
            if (!closingRef.current) {
              onSuccess();
            }
          }, 2000);
        } else if (data.status === 'expired') {
          clearPoll();
        }
      } catch {
        // Ignore polling errors silently
      }
    }, 2000);

    return clearPoll;
  }, [qrcode, status, clearPoll, onSuccess]);

  // Fetch QR code when dialog opens
  useEffect(() => {
    if (isOpen) {
      closingRef.current = false;
      fetchQRCode();
    } else {
      closingRef.current = true;
      clearPoll();
      setStatus('loading');
      setQrcodeUrl(null);
      setQrcode(null);
      setError(null);
    }
  }, [isOpen, fetchQRCode, clearPoll]);

  const statusText: Record<QRStatus, string> = {
    loading: '正在获取二维码...',
    wait: '请使用微信扫描二维码',
    scaned: '已扫码，请在手机上确认',
    confirmed: '登录成功！',
    expired: '二维码已过期',
    error: error || '获取二维码失败',
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>微信扫码登录</DialogTitle>
          <DialogDescription>使用微信扫描下方二维码完成登录绑定</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          {/* QR Code Area */}
          <div className="w-64 h-64 rounded-xl border border-border bg-white flex items-center justify-center overflow-hidden">
            {status === 'loading' && <Loader2 className="size-8 animate-spin text-muted-foreground" />}
            {status === 'error' && (
              <div className="text-center px-4">
                <p className="text-sm text-destructive mb-2">{error}</p>
                <Button variant="outline" size="sm" onClick={fetchQRCode}>
                  <RefreshCw className="size-3.5" />
                  重试
                </Button>
              </div>
            )}
            {(status === 'wait' || status === 'scaned') && qrcodeUrl && (
              <img src={qrcodeUrl} alt="微信登录二维码" className="w-full h-full object-contain p-2" />
            )}
            {status === 'confirmed' && (
              <div className="text-center">
                <CheckCircle2 className="size-16 text-emerald-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-emerald-600">登录成功</p>
              </div>
            )}
            {status === 'expired' && (
              <div className="text-center px-4">
                <p className="text-sm text-muted-foreground mb-2">二维码已过期</p>
                <Button variant="outline" size="sm" onClick={fetchQRCode}>
                  <RefreshCw className="size-3.5" />
                  重新获取
                </Button>
              </div>
            )}
          </div>

          {/* Status Text */}
          <p
            className={`text-sm text-center ${
              status === 'confirmed'
                ? 'text-emerald-600 font-medium'
                : status === 'error'
                  ? 'text-destructive'
                  : status === 'scaned'
                    ? 'text-amber-600'
                    : 'text-muted-foreground'
            }`}
          >
            {status === 'scaned' && <Loader2 className="size-3.5 animate-spin inline-block mr-1.5 -mt-0.5" />}
            {statusText[status]}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
