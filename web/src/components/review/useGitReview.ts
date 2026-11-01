import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';
import { useChatStore } from '../../stores/chat';
import { sessionJidOf } from '../../lib/session-jid';
import type {
  GitDiffResponse,
  GitReviewFile,
  GitReviewScope,
  GitStatusResponse,
  ReviewLoad,
  ReviewRequestFailure,
} from './types';

// The backend runs several git commands per request, each capped at 15s;
// the client's 8s default would give up on a large repository first.
const REVIEW_REQUEST_TIMEOUT_MS = 30_000;

export function toReviewFailure(error: unknown): ReviewRequestFailure {
  if (error && typeof error === 'object' && 'status' in error) {
    const { status, message } = error as { status: unknown; message?: unknown };
    if (typeof status === 'number') {
      return { status, message: typeof message === 'string' ? message : '' };
    }
  }
  return {
    status: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function gitStatusUrl(
  groupJid: string,
  agentId: string | null,
  scope: GitReviewScope = 'working',
) {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (scope === 'branch') params.set('scope', 'branch');
  const query = params.toString();
  return `/api/groups/${encodeURIComponent(groupJid)}/git/status${
    query ? `?${query}` : ''
  }`;
}

export function gitDiffUrl(
  groupJid: string,
  agentId: string | null,
  file: Pick<GitReviewFile, 'path' | 'orig_path'>,
  scope: GitReviewScope = 'working',
) {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  params.set('path', file.path);
  if (file.orig_path) params.set('orig_path', file.orig_path);
  if (scope === 'branch') params.set('scope', 'branch');
  return `/api/groups/${encodeURIComponent(groupJid)}/git/diff?${params}`;
}

interface Request {
  seq: number;
  controller: AbortController | null;
}

/** Supersede the previous request and return a guard for the new one. */
function beginRequest(ref: { current: Request }) {
  ref.current.controller?.abort();
  const controller = new AbortController();
  const seq = ref.current.seq + 1;
  ref.current = { seq, controller };
  return {
    signal: controller.signal,
    isCurrent: () => ref.current.seq === seq,
  };
}

function cancelRequest(ref: { current: Request }) {
  ref.current.controller?.abort();
  ref.current = { seq: ref.current.seq + 1, controller: null };
}

/**
 * Status and diff of one conversation's checkout. State belongs to a single
 * (groupJid, agentId) scope: the caller remounts it with a `key` when the
 * scope changes. Responses of superseded or cancelled requests are dropped.
 */
export function useGitReview(groupJid: string, agentId: string | null) {
  const [scope, setScopeState] = useState<GitReviewScope>('working');
  const [status, setStatus] = useState<ReviewLoad<GitStatusResponse>>({
    kind: 'loading',
  });
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [selected, setSelected] = useState<GitReviewFile | null>(null);
  const [diff, setDiff] = useState<ReviewLoad<GitDiffResponse> | null>(null);
  const [diffRefreshing, setDiffRefreshing] = useState(false);

  const scopeRef = useRef<GitReviewScope>('working');
  const initialLoadDoneRef = useRef(false);
  const statusRequest = useRef<Request>({ seq: 0, controller: null });
  const diffRequest = useRef<Request>({ seq: 0, controller: null });
  const selectedRef = useRef<GitReviewFile | null>(null);

  const loadStatus = useCallback(
    async (targetScope: GitReviewScope = scopeRef.current) => {
      const request = beginRequest(statusRequest);
      setStatusRefreshing(true);
      try {
        const data = await apiFetch<GitStatusResponse>(
          gitStatusUrl(groupJid, agentId, targetScope),
          { signal: request.signal, timeoutMs: REVIEW_REQUEST_TIMEOUT_MS },
        );
        if (!request.isCurrent()) return;
        const isFirstLoad = !initialLoadDoneRef.current;
        initialLoadDoneRef.current = true;
        if (
          isFirstLoad &&
          targetScope === 'working' &&
          data.state === 'ok' &&
          data.files.length === 0 &&
          (data.baseAhead ?? 0) > 0
        ) {
          scopeRef.current = 'branch';
          setScopeState('branch');
          setStatus({ kind: 'loaded', data });
          void loadStatus('branch');
          return;
        }
        setStatus({ kind: 'loaded', data });
      } catch (error) {
        if (request.isCurrent()) {
          setStatus({ kind: 'failed', failure: toReviewFailure(error) });
        }
      } finally {
        if (request.isCurrent()) setStatusRefreshing(false);
      }
    },
    [groupJid, agentId],
  );

  const loadDiff = useCallback(
    async (
      file: GitReviewFile,
      targetScope: GitReviewScope = scopeRef.current,
    ) => {
      const request = beginRequest(diffRequest);
      setDiffRefreshing(true);
      try {
        const data = await apiFetch<GitDiffResponse>(
          gitDiffUrl(groupJid, agentId, file, targetScope),
          { signal: request.signal, timeoutMs: REVIEW_REQUEST_TIMEOUT_MS },
        );
        if (request.isCurrent()) setDiff({ kind: 'loaded', data });
      } catch (error) {
        if (request.isCurrent()) {
          setDiff({ kind: 'failed', failure: toReviewFailure(error) });
        }
      } finally {
        if (request.isCurrent()) setDiffRefreshing(false);
      }
    },
    [groupJid, agentId],
  );

  const refresh = useCallback(() => {
    void loadStatus(scopeRef.current);
    if (selectedRef.current)
      void loadDiff(selectedRef.current, scopeRef.current);
  }, [loadStatus, loadDiff]);

  const setScope = useCallback(
    (nextScope: GitReviewScope) => {
      if (nextScope === scopeRef.current) return;
      initialLoadDoneRef.current = true;
      scopeRef.current = nextScope;
      setScopeState(nextScope);
      cancelRequest(diffRequest);
      selectedRef.current = null;
      setSelected(null);
      setDiff(null);
      setDiffRefreshing(false);
      void loadStatus(nextScope);
    },
    [loadStatus],
  );

  const openFile = useCallback(
    (file: GitReviewFile) => {
      selectedRef.current = file;
      setSelected(file);
      setDiff({ kind: 'loading' });
      void loadDiff(file, scopeRef.current);
    },
    [loadDiff],
  );

  const closeFile = useCallback(() => {
    cancelRequest(diffRequest);
    selectedRef.current = null;
    setSelected(null);
    setDiff(null);
    setDiffRefreshing(false);
  }, []);

  const retryDiff = useCallback(() => {
    const file = selectedRef.current;
    if (!file) return;
    setDiff({ kind: 'loading' });
    void loadDiff(file, scopeRef.current);
  }, [loadDiff]);

  useEffect(() => {
    void loadStatus(scopeRef.current);
    return () => {
      cancelRequest(statusRequest);
      cancelRequest(diffRequest);
    };
  }, [loadStatus]);

  // A finished run is when the Agent's edits land; refresh then, never poll.
  const running = useChatStore(
    (s) => !!agentId && !!s.activeRuns[sessionJidOf(groupJid, agentId)],
  );
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  }, [running, refresh]);

  return {
    scope,
    setScope,
    status,
    statusRefreshing,
    selected,
    diff,
    diffRefreshing,
    refresh,
    openFile,
    closeFile,
    retryDiff,
  };
}
