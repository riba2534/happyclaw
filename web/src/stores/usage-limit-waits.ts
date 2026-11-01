import { useEffect } from 'react';
import { create } from 'zustand';

import { wsManager } from '../api/ws';
import { sessionJidOf } from '../lib/session-jid';

/** A Session whose input waits for a usage-limit reset. */
export interface UsageLimitWait {
  resumeAt: string;
  waitCount: number;
}

interface UsageLimitWaitMessage {
  chatJid?: string;
  agentId?: string;
  resumeAt?: string | null;
  waitCount?: number;
}

interface UsageLimitWaitsState {
  waits: Record<string, UsageLimitWait>;
  apply: (message: UsageLimitWaitMessage) => void;
  replace: (messages: UsageLimitWaitMessage[]) => void;
}

function toEntry(
  message: UsageLimitWaitMessage,
): [string, UsageLimitWait] | null {
  if (!message.chatJid || !message.agentId || !message.resumeAt) return null;
  return [
    sessionJidOf(message.chatJid, message.agentId),
    { resumeAt: message.resumeAt, waitCount: message.waitCount ?? 1 },
  ];
}

export const useUsageLimitWaits = create<UsageLimitWaitsState>((set) => ({
  waits: {},
  apply: (message) => {
    // Every input waits in a session.
    if (!message.chatJid || !message.agentId) return;
    const key = sessionJidOf(message.chatJid, message.agentId);
    const entry = toEntry(message);
    set((state) => {
      const waits = { ...state.waits };
      if (entry) waits[key] = entry[1];
      else delete waits[key];
      return { waits };
    });
  },
  // A reconnect snapshot is the whole truth: waits it omits have ended.
  replace: (messages) =>
    set({
      waits: Object.fromEntries(
        messages
          .map(toEntry)
          .filter((entry): entry is [string, UsageLimitWait] => !!entry),
      ),
    }),
}));

/** Keep the waits current; mount once for the signed-in app. */
export function useUsageLimitWaitSubscription(): void {
  useEffect(() => {
    const unsubWait = wsManager.on('usage_limit_wait', (data: any) =>
      useUsageLimitWaits.getState().apply(data ?? {}),
    );
    const unsubSnapshot = wsManager.on('active_run_snapshot', (data: any) =>
      useUsageLimitWaits
        .getState()
        .replace(
          Array.isArray(data?.usageLimitWaits) ? data.usageLimitWaits : [],
        ),
    );
    return () => {
      unsubWait();
      unsubSnapshot();
    };
  }, []);
}

/** `HH:MM` today, `M月D日 HH:MM` on another day, in the viewer's time. */
export function formatResumeTime(resumeAt: string, now = new Date()): string {
  const at = new Date(resumeAt);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}
