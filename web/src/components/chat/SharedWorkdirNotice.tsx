import { useCallback, useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api } from '../../api/client';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { useChatStore } from '../../stores/chat';
import { cn } from '@/lib/utils';

export interface WorkdirPeer {
  workspace_jid: string;
  workspace_name: string;
  kind: 'session' | 'task';
  session_id: string | null;
  session_name: string | null;
}

interface WorkdirPeersState {
  peers: WorkdirPeer[];
  hiddenCount: number;
}

const NO_PEERS: WorkdirPeersState = { peers: [], hiddenCount: 0 };
/** Runs this client is not told about (another user's) surface this late. */
const FALLBACK_POLL_MS = 60_000;

/**
 * Other conversations running a turn in this conversation's working
 * directory. Only reported: sessions may run in parallel by design, they can
 * just overwrite each other's edits. Rechecked whenever a run this client
 * knows of starts or stops, and slowly polled while the page is visible.
 */
export function useWorkdirPeers(
  groupJid: string,
  agentId: string | null,
  enabled: boolean,
): WorkdirPeersState {
  const [state, setState] = useState<WorkdirPeersState>(NO_PEERS);
  const on = enabled && !!agentId;
  const scope = `${groupJid}\n${agentId ?? ''}\n${on}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    if (!agentId) return;
    const requested = scope;
    let next = NO_PEERS;
    try {
      const data = await api.get<{
        peers: WorkdirPeer[];
        hidden_count: number;
      }>(
        `/api/groups/${encodeURIComponent(groupJid)}/workdir/peers?agentId=${encodeURIComponent(agentId)}`,
      );
      next = { peers: data.peers, hiddenCount: data.hidden_count };
    } catch {
      // A failed check shows nothing rather than a stale warning.
    }
    if (scopeRef.current === requested) setState(next);
  }, [scope, groupJid, agentId]);

  const runKeys = useChatStore((s) =>
    Object.keys(s.activeRuns).sort().join('\n'),
  );
  useEffect(() => setState(NO_PEERS), [scope]);
  useEffect(() => {
    if (on) void load();
  }, [on, load, runKeys]);
  useVisibleInterval(load, FALLBACK_POLL_MS, on);

  return state;
}

function describePeer(peer: WorkdirPeer, groupJid: string): string {
  const conversation =
    peer.kind === 'task'
      ? '自动化'
      : `会话「${peer.session_name || '新会话'}」`;
  return peer.workspace_jid === groupJid
    ? conversation
    : `工作区「${peer.workspace_name}」的${conversation}`;
}

/** Non-blocking hint that edits in a shared directory may collide. */
export function SharedWorkdirNotice({
  groupJid,
  peers,
  hiddenCount,
  className,
}: {
  groupJid: string;
  peers: WorkdirPeer[];
  hiddenCount: number;
  className?: string;
}) {
  const names = peers.map((peer) => describePeer(peer, groupJid));
  if (hiddenCount > 0) names.push(`${hiddenCount} 个其他会话`);
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2 border-b border-surface-border bg-warning/10 px-4 py-1.5 text-caption text-muted-foreground lg:px-5',
        className,
      )}
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        另一个会话正在同一目录中运行，改动可能互相覆盖（{names.join('、')}
        ）。需要并行修改时，可以新建独立 worktree 会话。
      </span>
    </div>
  );
}
