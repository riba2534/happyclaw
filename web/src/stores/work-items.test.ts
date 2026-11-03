import { beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../api/client', () => ({ api }));
vi.mock('../api/ws', () => ({ wsManager: { on: vi.fn(() => vi.fn()) } }));

const { useWorkItemsStore } = await import('./work-items');
import type { WorkItemView } from '../work-items';

const WS = 'web:alpha';
const item = (id: string, status: string, updatedAt: string) =>
  ({ id, workspaceJid: WS, status, updatedAt }) as WorkItemView;

const served: Record<string, WorkItemView[]> = {};
const paths = () => api.get.mock.calls.map(([path]) => path as string);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async (path: string) => ({
    items: served[new URL(path, 'http://x').searchParams.get('status')!] ?? [],
  }));
  served.open = [item('a', 'open', '2026-11-01T01:00:00Z')];
  served.ended = [item('b', 'ended', '2026-11-01T02:00:00Z')];
  useWorkItemsStore.setState({
    items: {},
    requested: {},
    loaded: false,
    pageWorkspaces: [],
  });
});

describe('fetching a workspace outside the page', () => {
  test('open items once; recent ones add the ended, once', async () => {
    const { ensureWorkspace } = useWorkItemsStore.getState();
    ensureWorkspace(WS);
    ensureWorkspace(WS);
    await flush();
    expect(paths()).toEqual([
      `/api/workspaces/web%3Aalpha/work-items?status=open`,
    ]);
    expect(Object.keys(useWorkItemsStore.getState().items)).toEqual(['a']);

    ensureWorkspace(WS, true);
    ensureWorkspace(WS, true);
    ensureWorkspace(WS);
    await flush();
    expect(paths().slice(1)).toEqual([
      `/api/workspaces/web%3Aalpha/work-items?status=open`,
      `/api/workspaces/web%3Aalpha/work-items?status=ended&limit=20`,
    ]);
    expect(Object.keys(useWorkItemsStore.getState().items).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  test('an update the socket delivered meanwhile is kept', async () => {
    const newer = item('a', 'ended', '2026-11-01T03:00:00Z');
    useWorkItemsStore.setState({ items: { a: newer } });
    useWorkItemsStore.getState().ensureWorkspace(WS, true);
    await flush();
    expect(useWorkItemsStore.getState().items.a).toBe(newer);
  });

  test('a reconnect refetches what was fetched, unless the page reloads it', async () => {
    useWorkItemsStore.getState().ensureWorkspace(WS, true);
    useWorkItemsStore.getState().ensureWorkspace('web:beta');
    await flush();
    api.get.mockClear();

    served.open = [item('a', 'ended', '2026-11-01T04:00:00Z')];
    useWorkItemsStore.getState().reloadRequested();
    await flush();
    expect(paths()).toEqual([
      `/api/workspaces/web%3Aalpha/work-items?status=open`,
      `/api/workspaces/web%3Aalpha/work-items?status=ended&limit=20`,
      `/api/workspaces/web%3Abeta/work-items?status=open`,
    ]);
    expect(useWorkItemsStore.getState().items.a.status).toBe('ended');

    api.get.mockClear();
    useWorkItemsStore.setState({ loaded: true, pageWorkspaces: [WS] });
    useWorkItemsStore.getState().reloadRequested();
    await flush();
    expect(paths()).toEqual([
      `/api/workspaces/web%3Abeta/work-items?status=open`,
    ]);
  });
});
