import { useEffect, useState } from 'react';
import { useChatStore, type StreamingState } from '../stores/chat';
import {
  isWritingReply,
  replyRate,
  trackReplyText,
  type ReplyRateTrack,
} from '../lib/reply-rate';

/**
 * Estimated tok/s of the reply a run is writing, refreshed once a second;
 * `null` while it does anything else or the reading is in doubt. It follows
 * the run's own stream outside React, so the text's every frame re-renders
 * nothing but this value, and that at most once a second; the second's tick
 * runs only while it measures.
 */
export function useReplyRate(agentId: string): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    setRate(null);
    const read = (state: ReturnType<typeof useChatStore.getState>) =>
      state.agentStreaming[agentId];
    let track: ReplyRateTrack | null = null;
    let timer: number | undefined;
    const observe = (streaming: StreamingState | undefined) => {
      if (isWritingReply(streaming)) {
        track = trackReplyText(
          track,
          streaming.partialText,
          streaming.partialBase ?? 0,
          Date.now(),
        );
        timer ??= window.setInterval(() => {
          const value = replyRate(track, Date.now());
          setRate(value == null ? null : Math.round(value));
        }, 1000);
      } else if (track) {
        // Shown no longer, measured afresh once the text streams again.
        track = null;
        window.clearInterval(timer);
        timer = undefined;
        setRate(null);
      }
    };
    observe(read(useChatStore.getState()));
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      const streaming = read(state);
      if (streaming !== read(previous)) observe(streaming);
    });
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [agentId]);
  return rate;
}
