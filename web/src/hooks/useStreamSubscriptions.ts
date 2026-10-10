import { useEffect } from 'react';
import { wsManager } from '../api/ws';
import { useChatStore } from '../stores/chat';

const AGENT_MARKER = '#agent:';

/**
 * Apply every workspace's stream deltas and reconnect snapshots to the store,
 * not only the open workspace's. Run lifecycle events are global; when the
 * deltas were scoped to the mounted ChatView, leaving a workspace mid-reply
 * dropped every delta that arrived meanwhile and the reply came back with a
 * hole in it (and a broken fence after it) until the final message.
 */
export function useGlobalStreamSubscriptions(): void {
  useEffect(() => {
    const unsubEvent = wsManager.on('stream_event', (data: any) => {
      if (typeof data?.chatJid !== 'string' || !data.event) return;
      useChatStore
        .getState()
        .handleStreamEvent(data.chatJid, data.event, data.agentId, data.runId);
    });
    // Sent per active runtime on every (re)connect.
    const unsubSnapshot = wsManager.on('stream_snapshot', (data: any) => {
      if (typeof data?.chatJid !== 'string' || !data.snapshot) return;
      const markerIndex = data.chatJid.indexOf(AGENT_MARKER);
      const { handleStreamSnapshot } = useChatStore.getState();
      if (markerIndex >= 0) {
        handleStreamSnapshot(
          data.chatJid.slice(0, markerIndex),
          data.snapshot,
          data.chatJid.slice(markerIndex + AGENT_MARKER.length),
          data.runId,
        );
      } else {
        handleStreamSnapshot(
          data.chatJid,
          data.snapshot,
          undefined,
          data.runId,
        );
      }
    });
    return () => {
      unsubEvent();
      unsubSnapshot();
    };
  }, []);
}
