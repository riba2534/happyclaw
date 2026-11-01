import { useEffect } from 'react';
import { wsManager } from '../api/ws';
import { useChatStore } from '../stores/chat';
import { sessionIdOf, workspaceJidOf } from '../lib/session-jid';

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
    // Sent per active session runtime on every (re)connect.
    const unsubSnapshot = wsManager.on('stream_snapshot', (data: any) => {
      if (typeof data?.chatJid !== 'string' || !data.snapshot) return;
      const agentId = sessionIdOf(data.chatJid);
      if (!agentId) return;
      useChatStore
        .getState()
        .handleStreamSnapshot(
          workspaceJidOf(data.chatJid),
          data.snapshot,
          agentId,
          data.runId,
        );
    });
    return () => {
      unsubEvent();
      unsubSnapshot();
    };
  }, []);
}
