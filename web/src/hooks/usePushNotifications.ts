import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ensurePushRegistration,
  fetchVapidPublicKey,
  getPushSupport,
  registerSubscription,
  setPushSubscribed,
  unregisterSubscription,
  urlBase64ToUint8Array,
} from '../utils/webPush';
import { api } from '../api/client';

export type PushStatus =
  /** Looking at the worker, the server key and the existing subscription. */
  | 'checking'
  /** This browser has no Web Push. */
  | 'unsupported'
  /** iOS: only an app added to the Home Screen can receive push. */
  | 'needs-install'
  /** The server has no push identity (or cannot be reached). */
  | 'unavailable'
  /** The browser's notification permission is denied. */
  | 'denied'
  /** Not subscribed on this device. */
  | 'off'
  /** Subscribed, and the server knows it. */
  | 'on';

export interface PushNotificationsApi {
  status: PushStatus;
  busy: boolean;
  /** The last action's failure, in words for the person. */
  error: string | null;
  /** Result of the last test push; null before one was sent. */
  testResult: 'sent' | 'failed' | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
}

function describeError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

/**
 * Push settings of this device. On mount it registers the push worker and
 * fetches the server's key, so that `enable` can call `pushManager.subscribe`
 * as the very first thing in the tap handler: iOS only honours the call while
 * the user gesture is still alive, which an `await` before it would end.
 * Nothing here asks for the permission before `enable` runs.
 */
export function usePushNotifications(): PushNotificationsApi {
  const [status, setStatus] = useState<PushStatus>(() => {
    const support = getPushSupport();
    return support === 'supported' ? 'checking' : support;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<'sent' | 'failed' | null>(null);

  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const keyRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (getPushSupport() !== 'supported') return;
    let cancelled = false;
    void (async () => {
      try {
        const publicKey = await fetchVapidPublicKey();
        if (cancelled) return;
        if (!publicKey) {
          setStatus('unavailable');
          return;
        }
        keyRef.current = urlBase64ToUint8Array(publicKey);
        const registration = await ensurePushRegistration();
        if (cancelled) return;
        registrationRef.current = registration;
        const subscription = await registration.pushManager.getSubscription();
        if (cancelled) return;
        if (Notification.permission === 'denied') {
          setStatus('denied');
        } else if (subscription && Notification.permission === 'granted') {
          setStatus('on');
          setPushSubscribed(true);
          // Make sure the server has it (it may have lost the row).
          await registerSubscription(subscription).catch(() => {});
        } else {
          setStatus('off');
        }
      } catch (err) {
        if (cancelled) return;
        setError(describeError(err, '无法初始化推送通知'));
        setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    const registration = registrationRef.current;
    const key = keyRef.current;
    if (!registration || !key) {
      setError('推送通知尚未就绪，请稍后再试');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let subscription: PushSubscription;
      const options = { userVisibleOnly: true, applicationServerKey: key };
      try {
        // First call of the tap handler, no await before it (see above).
        subscription = await registration.pushManager.subscribe(options);
      } catch (err) {
        // A browser that wants the permission asked for explicitly.
        if (Notification.permission !== 'default') throw err;
        if ((await Notification.requestPermission()) !== 'granted') throw err;
        subscription = await registration.pushManager.subscribe(options);
      }
      await registerSubscription(subscription);
      setPushSubscribed(true);
      setStatus('on');
    } catch (err) {
      if (Notification.permission === 'denied') {
        setStatus('denied');
      } else {
        setError(describeError(err, '开启推送通知失败'));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const subscription =
        await registrationRef.current?.pushManager.getSubscription();
      if (subscription) {
        let serverError: unknown = null;
        try {
          await unregisterSubscription(subscription.endpoint);
        } catch (err) {
          serverError = err;
        }
        await subscription.unsubscribe();
        if (serverError) {
          setError('已在本机关闭，服务器上的记录会在下次推送时自动清理');
        }
      }
      setPushSubscribed(false);
      setStatus(Notification.permission === 'denied' ? 'denied' : 'off');
    } catch (err) {
      setError(describeError(err, '关闭推送通知失败'));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await api.post<{ success: boolean }>('/api/push/test');
      setTestResult(result.success ? 'sent' : 'failed');
    } catch (err) {
      setTestResult('failed');
      setError(describeError(err, '发送测试通知失败'));
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, testResult, enable, disable, sendTest };
}
