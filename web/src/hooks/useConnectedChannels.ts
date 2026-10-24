import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CHANNEL_OPTIONS } from '../utils/task-utils';
import { useIsGuest } from '../stores/auth';

/**
 * Fetch connected IM channel status once on mount.
 * Returns a stable Record<string, boolean> keyed by channel name.
 */
export function useConnectedChannels(): Record<string, boolean> {
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  // Guests cannot read channel accounts; they only view tasks anyway.
  const isGuest = useIsGuest();

  useEffect(() => {
    if (isGuest) return;
    api
      .get<Record<string, boolean>>('/api/channel-accounts/status')
      .then((data) => {
        const result: Record<string, boolean> = {};
        for (const ch of CHANNEL_OPTIONS) {
          result[ch.key] = !!data[ch.key];
        }
        setConnected(result);
      })
      .catch(() => {
        /* ignore */
      });
  }, [isGuest]);

  return connected;
}
