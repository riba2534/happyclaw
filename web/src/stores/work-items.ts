import { useEffect } from 'react';
import { create } from 'zustand';

import { api, type ApiError } from '../api/client';
import { wsManager } from '../api/ws';
import {
  WORK_RECENT_LIMIT,
  type TeamMountView,
  type TeamSettingsDraft,
  type WorkItemDetail,
} from '../lib/team-mode';
import type {
  WorkDecision,
  WorkItemView,
  WorkItemWsEvent,
} from '../work-items';

// Team mode (团队模式): work items, the decisions kept for review and the
// group mounts' settings, for the 工作项 page, the settings dialog and the
// session tree's tags. Multi-task mode's chat cards read the same items.

interface WorkItemsState {
  items: Record<string, WorkItemView>;
  /** `would_accept` decisions per workspace, newest first. */
  decisions: Record<string, WorkDecision[]>;
  details: Record<string, WorkItemDetail>;
  /** Workspaces the page loads; a reconnect reloads them. */
  pageWorkspaces: string[];
  /** What ensureWorkspace fetched per workspace. */
  requested: Record<string, FetchScope>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Items with a stop or approve request in flight. */
  busy: Record<string, boolean>;

  /** The page: every listed workspace's items and recorded decisions. */
  load: (workspaceJids: string[]) => Promise<void>;
  /**
   * Once per workspace outside the page: its open items (the session tree's
   * `#N` tags, the settings dialog), or with `recent` the recently ended
   * ones too (the chat's delegated task cards keep an ended task until the
   * person writes again).
   */
  ensureWorkspace: (workspaceJid: string, recent?: boolean) => void;
  /** After a reconnect: what ensureWorkspace fetched, unless the page did. */
  reloadRequested: () => void;
  loadDetail: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  approve: (id: string) => Promise<void>;
  handleUpdated: (event: WorkItemWsEvent) => void;
}

type FetchScope = 'open' | 'recent';

const enc = encodeURIComponent;

function fetchItems(jid: string, query: string) {
  return api
    .get<{
      items: WorkItemView[];
    }>(`/api/workspaces/${enc(jid)}/work-items?${query}`)
    .then((data) => data.items);
}

/** Open items and the recently ended ones. */
async function fetchRecentItems(jid: string) {
  const [open, ended] = await Promise.all([
    fetchItems(jid, 'status=open'),
    fetchItems(jid, `status=ended&limit=${WORK_RECENT_LIMIT}`),
  ]);
  return [...open, ...ended];
}

async function fetchWorkspace(jid: string) {
  const [items, decisions] = await Promise.all([
    fetchRecentItems(jid),
    api.get<{ decisions: WorkDecision[] }>(
      `/api/workspaces/${enc(jid)}/work-decisions?kind=would_accept&limit=${WORK_RECENT_LIMIT}`,
    ),
  ]);
  return { items, decisions: decisions.decisions };
}

// WS events refetch an open detail at most once per burst.
const REFRESH_DELAY_MS = 120;
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();

export const useWorkItemsStore = create<WorkItemsState>((set, get) => {
  const fetchScope = (jid: string, scope: FetchScope) =>
    (scope === 'recent'
      ? fetchRecentItems(jid)
      : fetchItems(jid, 'status=open')
    )
      .then((fetched) =>
        set((state) => {
          const items = { ...state.items };
          for (const item of fetched) {
            // An update the socket delivered meanwhile is newer: keep it.
            const known = items[item.id];
            if (!known || known.updatedAt <= item.updatedAt)
              items[item.id] = item;
          }
          return { items };
        }),
      )
      .catch(() => undefined);

  const putItem = (item: WorkItemView) =>
    set((state) => ({
      items: { ...state.items, [item.id]: item },
      details: state.details[item.id]
        ? { ...state.details, [item.id]: { ...state.details[item.id], item } }
        : state.details,
    }));

  const act = async (id: string, action: 'stop' | 'approve') => {
    set((state) => ({ busy: { ...state.busy, [id]: true } }));
    try {
      const data = await api.post<{ item: WorkItemView }>(
        `/api/work-items/${enc(id)}/${action}`,
      );
      putItem(data.item);
      void get()
        .loadDetail(id)
        .catch(() => undefined);
    } finally {
      set((state) => {
        const busy = { ...state.busy };
        delete busy[id];
        return { busy };
      });
    }
  };

  return {
    items: {},
    decisions: {},
    details: {},
    pageWorkspaces: [],
    requested: {},
    loaded: false,
    loading: false,
    error: null,
    busy: {},

    load: async (workspaceJids) => {
      set({ loading: true, pageWorkspaces: workspaceJids });
      const results = await Promise.allSettled(
        workspaceJids.map(async (jid) => ({
          jid,
          ...(await fetchWorkspace(jid)),
        })),
      );
      // A workspace this user cannot run team mode in answers 404: skip it.
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' &&
          (result.reason as ApiError)?.status !== 404,
      );
      const fetched = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const replaced = new Set(fetched.map((result) => result.jid));
      set((state) => {
        // A fetched workspace's list replaces what the store had for it.
        const items = Object.fromEntries(
          Object.entries(state.items).filter(
            ([, item]) => !replaced.has(item.workspaceJid),
          ),
        );
        const decisions = { ...state.decisions };
        for (const result of fetched) {
          for (const item of result.items) items[item.id] = item;
          decisions[result.jid] = result.decisions;
        }
        return {
          items,
          decisions,
          loaded: true,
          loading: false,
          error: failure
            ? (failure.reason as ApiError)?.message || '加载工作项失败'
            : null,
        };
      });
    },

    ensureWorkspace: (workspaceJid, recent = false) => {
      const had = get().requested[workspaceJid];
      if (had === 'recent' || (had && !recent)) return;
      const scope: FetchScope = recent ? 'recent' : 'open';
      set((state) => ({
        requested: { ...state.requested, [workspaceJid]: scope },
      }));
      void fetchScope(workspaceJid, scope);
    },

    reloadRequested: () => {
      const { requested, loaded, pageWorkspaces } = get();
      for (const [jid, scope] of Object.entries(requested))
        if (!(loaded && pageWorkspaces.includes(jid)))
          void fetchScope(jid, scope);
    },

    loadDetail: async (id) => {
      try {
        const detail = await api.get<WorkItemDetail>(
          `/api/work-items/${enc(id)}`,
        );
        set((state) => ({
          items: { ...state.items, [id]: detail.item },
          details: { ...state.details, [id]: detail },
        }));
      } catch (err) {
        if ((err as ApiError).status !== 404) throw err;
        set((state) => {
          const items = { ...state.items };
          const details = { ...state.details };
          delete items[id];
          delete details[id];
          return { items, details };
        });
      }
    },

    stop: (id) => act(id, 'stop'),
    approve: (id) => act(id, 'approve'),

    handleUpdated: (event) => {
      if (!event?.item?.id) return;
      putItem(event.item);
      const id = event.item.id;
      if (!get().details[id] || pendingRefresh.has(id)) return;
      pendingRefresh.set(
        id,
        setTimeout(() => {
          pendingRefresh.delete(id);
          void get()
            .loadDetail(id)
            .catch(() => undefined);
        }, REFRESH_DELAY_MS),
      );
    },
  };
});

/** Keep work items current; mount once for the signed-in app. */
export function useWorkItemSubscription(): void {
  useEffect(() => {
    const unsubs = [
      wsManager.on('work_item_updated', (data: WorkItemWsEvent) =>
        useWorkItemsStore.getState().handleUpdated(data),
      ),
      // Events missed while the socket was down.
      wsManager.on('connected', (data: { reconnect?: boolean }) => {
        if (!data?.reconnect) return;
        const { loaded, pageWorkspaces, load, reloadRequested } =
          useWorkItemsStore.getState();
        if (loaded) void load(pageWorkspaces);
        reloadRequested();
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, []);
}

/** The work item a worker session runs, once its workspace is loaded. */
export function useWorkItemForSession(
  workspaceJid: string,
  agentId: string,
  enabled: boolean,
): WorkItemView | undefined {
  const ensureWorkspace = useWorkItemsStore((s) => s.ensureWorkspace);
  useEffect(() => {
    if (enabled) ensureWorkspace(workspaceJid);
  }, [enabled, workspaceJid, ensureWorkspace]);
  return useWorkItemsStore((s) =>
    enabled
      ? Object.values(s.items).find((item) => item.agentId === agentId)
      : undefined,
  );
}

// ── Group mount settings ───────────────────────────────────────────────

export async function fetchTeamMounts(
  workspaceJid: string,
): Promise<TeamMountView[]> {
  const data = await api.get<{ mounts: TeamMountView[] }>(
    `/api/workspaces/${enc(workspaceJid)}/team-mounts`,
  );
  return data.mounts;
}

export async function saveTeamMount(
  workspaceJid: string,
  channelJid: string,
  settings: TeamSettingsDraft,
): Promise<TeamMountView> {
  const data = await api.put<{ mount: TeamMountView }>(
    `/api/workspaces/${enc(workspaceJid)}/team-mounts/${enc(channelJid)}`,
    { settings },
  );
  return data.mount;
}
