import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useSearchParams,
  type BlockerFunction,
} from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  CircleDotDashed,
  FileText,
  History,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, apiFetch } from '../api/client';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { createUnsavedNavigationGuard } from '@/utils/unsaved-navigation';
import {
  ConfirmDialog,
  EmptyState,
  IconButton,
  ListGroup,
  PageContainer,
  PageHeader,
  SegmentedControl,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  KIND_META,
  WORKSPACE_MEMORY_KINDS,
  memoryItemPath,
  memoryItemsPath,
  memoryKindCounts,
  memoryVersionsPath,
  revisionConflictFrom,
  type RevisionConflict,
  type WorkspaceMemoryCollection,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryItemResult,
  type WorkspaceMemoryKind,
  type WorkspaceMemoryProvenance,
  type WorkspaceMemorySearchResult,
  type WorkspaceMemoryVersion,
  type WorkspaceMemoryVersionsResult,
  type WorkspaceSummary,
} from '@/features/workspace-memory/model';

type KindFilter = 'all' | WorkspaceMemoryKind;

interface Draft {
  kind: WorkspaceMemoryKind;
  title: string;
  content: string;
  sessionId: string;
}

const EMPTY_DRAFT: Draft = {
  kind: 'fact',
  title: '',
  content: '',
  sessionId: '',
};

const KIND_ICONS: Record<WorkspaceMemoryKind, typeof FileText> = {
  fact: FileText,
  decision: CheckCircle2,
  lesson: Lightbulb,
  open_loop: CircleDotDashed,
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  web_user: 'Web 用户',
  agent_runtime: 'Agent Runtime',
  scheduled_task: '定时任务',
  migration: '迁移',
};

const CHANGE_TYPE_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  forget: '忘记',
};

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN');
}

function provenanceLabel(source: WorkspaceMemoryProvenance): string {
  const typeLabel =
    SOURCE_TYPE_LABELS[source.sourceType] || source.sourceType || '未知来源';
  if (source.sessionId) return `${typeLabel} · Session ${source.sessionId}`;
  if (source.sourceId) return `${typeLabel} · ${source.sourceId}`;
  return typeLabel;
}

function MemoryKindBadge({ kind }: { kind: WorkspaceMemoryKind }) {
  const Icon = KIND_ICONS[kind];
  return (
    <Badge variant="neutral">
      <Icon />
      {KIND_META[kind].label}
    </Badge>
  );
}

function MemoryListItem({
  item,
  active,
  snippet,
  onSelect,
}: {
  item: WorkspaceMemoryItem;
  active: boolean;
  snippet?: string;
  onSelect: (item: WorkspaceMemoryItem) => void;
}) {
  const Icon = KIND_ICONS[item.kind];
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={() => onSelect(item)}
        aria-current={active || undefined}
        data-selected={active || undefined}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset',
          active && 'bg-surface-selected hover:bg-surface-selected',
        )}
      >
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
              {item.title?.trim() ||
                item.content.split('\n')[0] ||
                '无标题记忆'}
            </span>
            <span className="shrink-0 text-micro text-faint-foreground tabular-nums">
              r{item.revision}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">
            {snippet || item.content}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-micro text-faint-foreground">
            <span>{KIND_META[item.kind].label}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{provenanceLabel(item.provenance)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {formatTime(item.provenance.observedAt || item.updatedAt)}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

export function MemoryPage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationGuardRef = useRef(createUnsavedNavigationGuard());
  const setAllowedSearchParams = useCallback(
    (next: URLSearchParams, options: { replace?: boolean } = {}) => {
      const serialized = next.toString();
      const token = navigationGuardRef.current.allowNext({
        pathname: location.pathname,
        search: serialized ? `?${serialized}` : '',
        hash: location.hash,
      });
      setSearchParams(next, options);
      queueMicrotask(() => navigationGuardRef.current.cancelAllowance(token));
    },
    [location.hash, location.pathname, setSearchParams],
  );
  const requestedWorkspace = searchParams.get('workspace');
  const legacyFolder = searchParams.get('folder');
  const isMobile = useMediaQuery('(max-width: 1023px)');

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceJid, setSelectedWorkspaceJid] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [items, setItems] = useState<WorkspaceMemoryItem[]>([]);
  const [storeRevision, setStoreRevision] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  const kindFilterRef = useRef<KindFilter>('all');
  queryRef.current = query;
  kindFilterRef.current = kindFilter;
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<
    WorkspaceMemorySearchResult['hits'] | null
  >(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<WorkspaceMemoryItem | null>(
    null,
  );
  const [versions, setVersions] = useState<WorkspaceMemoryVersion[]>([]);
  const [versionNextCursor, setVersionNextCursor] = useState<string | null>(
    null,
  );
  const [loadingMoreVersions, setLoadingMoreVersions] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const createIdempotencyKey = useRef('');

  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const activeWorkspaceRef = useRef('');
  const workspaceEpochRef = useRef(0);
  const detailTargetRef = useRef<string | null>(null);
  const listGenerationRef = useRef(0);
  const searchGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const versionsGenerationRef = useRef(0);
  const createGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const forgetGenerationRef = useRef(0);

  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.jid === selectedWorkspaceJid),
    [selectedWorkspaceJid, workspaces],
  );
  const canModify = selectedWorkspace?.can_modify === true;

  const visibleItems = useMemo(() => {
    if (searchHits) return searchHits.map((hit) => hit.item);
    if (kindFilter === 'all') return items;
    return items.filter((item) => item.kind === kindFilter);
  }, [items, kindFilter, searchHits]);
  const counts = useMemo(() => memoryKindCounts(items), [items]);
  const dirty = useMemo(() => {
    if (!selectedItem) return false;
    return (
      draft.kind !== selectedItem.kind ||
      draft.title !== (selectedItem.title || '') ||
      draft.content !== selectedItem.content
    );
  }, [draft, selectedItem]);
  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      navigationGuardRef.current.shouldBlock(
        dirty,
        currentLocation,
        nextLocation,
      ),
    [dirty],
  );
  const navigationBlocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [dirty],
    ),
  );

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return;
    if (window.confirm('当前记忆有未保存修改，离开页面会丢失。是否继续？')) {
      navigationBlocker.proceed();
    } else {
      navigationBlocker.reset();
    }
  }, [navigationBlocker]);

  const syncSelectedItem = useCallback((item: WorkspaceMemoryItem | null) => {
    detailTargetRef.current = item?.id || null;
    setSelectedItem(item);
    setSelectedId(item?.id || null);
    setDraft(
      item
        ? {
            kind: item.kind,
            title: item.title || '',
            content: item.content,
            sessionId: item.provenance.sessionId || '',
          }
        : EMPTY_DRAFT,
    );
    setConflict(null);
  }, []);

  const isCurrentWorkspace = useCallback(
    (workspaceJid: string, epoch: number) =>
      activeWorkspaceRef.current === workspaceJid &&
      workspaceEpochRef.current === epoch,
    [],
  );

  const activateWorkspace = useCallback(
    (workspaceJid: string) => {
      if (activeWorkspaceRef.current === workspaceJid) {
        setSelectedWorkspaceJid(workspaceJid);
        return;
      }

      activeWorkspaceRef.current = workspaceJid;
      workspaceEpochRef.current += 1;
      detailTargetRef.current = null;
      listGenerationRef.current += 1;
      searchGenerationRef.current += 1;
      detailGenerationRef.current += 1;
      versionsGenerationRef.current += 1;
      createGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      forgetGenerationRef.current += 1;

      setSelectedWorkspaceJid(workspaceJid);
      setItems([]);
      setStoreRevision(null);
      setNextCursor(null);
      setListLoading(false);
      setLoadingMore(false);
      setListError(null);
      setSearchHits(null);
      setSearching(false);
      setQuery('');
      syncSelectedItem(null);
      setVersions([]);
      setVersionNextCursor(null);
      setLoadingMoreVersions(false);
      setDetailLoading(false);
      setShowDetail(false);
      setCreateOpen(false);
      setCreating(false);
      setForgetOpen(false);
      setForgetting(false);
      setSaving(false);
    },
    [syncSelectedItem],
  );

  const updateWorkspaceParam = useCallback(
    (workspaceJid: string) => {
      const next = new URLSearchParams(searchParams);
      next.delete('folder');
      next.set('workspace', workspaceJid);
      setAllowedSearchParams(next, { replace: true });
    },
    [searchParams, setAllowedSearchParams],
  );

  useEffect(() => {
    let cancelled = false;
    setWorkspaceLoading(true);
    api
      .get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
      .then(({ workspaces: loaded }) => {
        if (cancelled) return;
        const active = loaded.filter(
          (workspace) => workspace.status === 'active',
        );
        setWorkspaces(active);
        setWorkspaceError(null);

        const requested = requestedWorkspace
          ? active.find((workspace) => workspace.jid === requestedWorkspace)
          : undefined;
        const legacy = legacyFolder
          ? active.find((workspace) => workspace.folder === legacyFolder)
          : undefined;
        const next =
          requested ||
          legacy ||
          active.find((workspace) => workspace.is_home) ||
          active[0];
        activateWorkspace(next?.jid || '');
        if (next && next.jid !== requestedWorkspace) {
          updateWorkspaceParam(next.jid);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceError(getErrorMessage(error, '工作区加载失败'));
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activateWorkspace,
    legacyFolder,
    requestedWorkspace,
    updateWorkspaceParam,
  ]);

  const loadItems = useCallback(
    async (options?: { append?: boolean; cursor?: string | null }) => {
      const workspaceJid = selectedWorkspaceJid;
      const workspaceEpoch = workspaceEpochRef.current;
      if (!workspaceJid || !isCurrentWorkspace(workspaceJid, workspaceEpoch)) {
        setItems([]);
        return;
      }
      const append = options?.append === true;
      const requestGeneration = ++listGenerationRef.current;
      append ? setLoadingMore(true) : setListLoading(true);
      try {
        const params = new URLSearchParams({
          status: 'active',
          limit: '100',
        });
        if (options?.cursor) params.set('cursor', options.cursor);
        const data = await api.get<WorkspaceMemoryCollection>(
          `${memoryItemsPath(workspaceJid)}?${params}`,
        );
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          listGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setStoreRevision(data.storeRevision);
        setNextCursor(data.nextCursor);
        setItems((current) =>
          append ? [...current, ...data.items] : data.items,
        );
        setListError(null);
      } catch (error) {
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          listGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setListError(getErrorMessage(error, '工作区记忆加载失败'));
      } finally {
        if (
          isCurrentWorkspace(workspaceJid, workspaceEpoch) &&
          listGenerationRef.current === requestGeneration
        ) {
          append ? setLoadingMore(false) : setListLoading(false);
        }
      }
    },
    [isCurrentWorkspace, selectedWorkspaceJid],
  );

  useEffect(() => {
    if (selectedWorkspaceJid) void loadItems();
  }, [selectedWorkspaceJid, loadItems]);

  const loadSearch = useCallback(
    async (options?: { query?: string; kind?: KindFilter }) => {
      const trimmed = (options?.query ?? queryRef.current).trim();
      const requestedKind = options?.kind ?? kindFilterRef.current;
      const workspaceJid = activeWorkspaceRef.current;
      const workspaceEpoch = workspaceEpochRef.current;
      if (
        !trimmed ||
        !workspaceJid ||
        !isCurrentWorkspace(workspaceJid, workspaceEpoch)
      ) {
        searchGenerationRef.current += 1;
        setSearchHits(null);
        setSearching(false);
        return;
      }

      const requestGeneration = ++searchGenerationRef.current;
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: trimmed, limit: '100' });
        if (requestedKind !== 'all') params.set('kind', requestedKind);
        const data = await api.get<WorkspaceMemorySearchResult>(
          `${memoryItemsPath(workspaceJid)}/search?${params}`,
        );
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          searchGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setStoreRevision(data.storeRevision);
        setSearchHits(data.hits);
      } catch (error) {
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          searchGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        setSearchHits([]);
        toast.error(getErrorMessage(error, '搜索工作区记忆失败'));
      } finally {
        if (
          isCurrentWorkspace(workspaceJid, workspaceEpoch) &&
          searchGenerationRef.current === requestGeneration
        ) {
          setSearching(false);
        }
      }
    },
    [isCurrentWorkspace],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !selectedWorkspaceJid) {
      searchGenerationRef.current += 1;
      setSearchHits(null);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void loadSearch({ query: trimmed, kind: kindFilter });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      // Invalidate a request that may already have started before dependencies
      // changed, so it cannot briefly repaint results for the previous query.
      searchGenerationRef.current += 1;
    };
  }, [kindFilter, loadSearch, query, selectedWorkspaceJid]);

  const refreshMemoryView = useCallback(async () => {
    const refreshes: Promise<void>[] = [loadItems()];
    if (queryRef.current.trim()) refreshes.push(loadSearch());
    await Promise.all(refreshes);
  }, [loadItems, loadSearch]);

  const loadDetail = useCallback(
    async (itemId: string, options?: { discardDraft?: boolean }) => {
      const workspaceJid = selectedWorkspaceJid;
      const workspaceEpoch = workspaceEpochRef.current;
      if (!workspaceJid || !isCurrentWorkspace(workspaceJid, workspaceEpoch)) {
        return;
      }
      if (dirty && !options?.discardDraft) {
        const shouldDiscard = window.confirm(
          '当前有未保存修改，切换记忆会丢失这些修改。是否继续？',
        );
        if (!shouldDiscard) return;
      }
      const requestGeneration = ++detailGenerationRef.current;
      const versionsGeneration = ++versionsGenerationRef.current;
      saveGenerationRef.current += 1;
      forgetGenerationRef.current += 1;
      detailTargetRef.current = itemId;
      setSelectedId(itemId);
      setSelectedItem(null);
      setDraft(EMPTY_DRAFT);
      setConflict(null);
      setVersions([]);
      setVersionNextCursor(null);
      setLoadingMoreVersions(false);
      setSaving(false);
      setForgetOpen(false);
      setForgetting(false);
      setDetailLoading(true);
      try {
        const [itemData, versionData] = await Promise.all([
          api.get<WorkspaceMemoryItemResult>(
            memoryItemPath(workspaceJid, itemId),
          ),
          api.get<WorkspaceMemoryVersionsResult>(
            `${memoryVersionsPath(workspaceJid, itemId)}?limit=20`,
          ),
        ]);
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          detailGenerationRef.current !== requestGeneration ||
          versionsGenerationRef.current !== versionsGeneration ||
          detailTargetRef.current !== itemId
        ) {
          return;
        }
        syncSelectedItem(itemData.item);
        setVersions(versionData.versions);
        setVersionNextCursor(versionData.nextCursor);
        setStoreRevision(
          Math.max(itemData.storeRevision, versionData.storeRevision),
        );
        if (isMobile) setShowDetail(true);
      } catch (error) {
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          detailGenerationRef.current !== requestGeneration ||
          detailTargetRef.current !== itemId
        ) {
          return;
        }
        toast.error(getErrorMessage(error, '记忆详情加载失败'));
      } finally {
        if (
          isCurrentWorkspace(workspaceJid, workspaceEpoch) &&
          detailGenerationRef.current === requestGeneration &&
          detailTargetRef.current === itemId
        ) {
          setDetailLoading(false);
        }
      }
    },
    [
      dirty,
      isCurrentWorkspace,
      isMobile,
      selectedWorkspaceJid,
      syncSelectedItem,
    ],
  );

  const loadMoreVersions = useCallback(async () => {
    if (!selectedWorkspaceJid || !selectedItem || !versionNextCursor) return;
    const workspaceJid = selectedWorkspaceJid;
    const workspaceEpoch = workspaceEpochRef.current;
    const itemId = selectedItem.id;
    if (!isCurrentWorkspace(workspaceJid, workspaceEpoch)) return;

    const requestGeneration = ++versionsGenerationRef.current;
    setLoadingMoreVersions(true);
    try {
      const params = new URLSearchParams({
        limit: '20',
        cursor: versionNextCursor,
      });
      const data = await api.get<WorkspaceMemoryVersionsResult>(
        `${memoryVersionsPath(workspaceJid, itemId)}?${params}`,
      );
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        versionsGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      setVersions((current) => [...current, ...data.versions]);
      setVersionNextCursor(data.nextCursor);
      setStoreRevision(data.storeRevision);
    } catch (error) {
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        versionsGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      toast.error(getErrorMessage(error, '修订记录加载失败'));
    } finally {
      if (
        isCurrentWorkspace(workspaceJid, workspaceEpoch) &&
        versionsGenerationRef.current === requestGeneration &&
        detailTargetRef.current === itemId
      ) {
        setLoadingMoreVersions(false);
      }
    }
  }, [
    isCurrentWorkspace,
    selectedItem,
    selectedWorkspaceJid,
    versionNextCursor,
  ]);

  const handleWorkspaceChange = (workspaceJid: string) => {
    if (
      dirty &&
      !window.confirm('当前有未保存修改，切换工作区会丢失。是否继续？')
    ) {
      return;
    }
    activateWorkspace(workspaceJid);
    updateWorkspaceParam(workspaceJid);
  };

  const openCreate = () => {
    createIdempotencyKey.current =
      globalThis.crypto?.randomUUID?.() ||
      `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCreateDraft(EMPTY_DRAFT);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!selectedWorkspaceJid || !createDraft.content.trim()) return;
    const workspaceJid = selectedWorkspaceJid;
    const workspaceEpoch = workspaceEpochRef.current;
    if (!isCurrentWorkspace(workspaceJid, workspaceEpoch)) return;
    const requestGeneration = ++createGenerationRef.current;
    setCreating(true);
    try {
      const result = await api.post<WorkspaceMemoryItemResult>(
        memoryItemsPath(workspaceJid),
        {
          kind: createDraft.kind,
          content: createDraft.content.trim(),
          ...(createDraft.title.trim()
            ? { title: createDraft.title.trim() }
            : {}),
          provenance: {
            observedAt: new Date().toISOString(),
            ...(createDraft.sessionId.trim()
              ? { sessionId: createDraft.sessionId.trim() }
              : {}),
          },
          idempotencyKey: createIdempotencyKey.current,
        },
      );
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        createGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      setCreateOpen(false);
      setStoreRevision(result.storeRevision);
      toast.success('已添加到当前工作区记忆');
      await refreshMemoryView();
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        createGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      await loadDetail(result.item.id, { discardDraft: true });
    } catch (error) {
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        createGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      toast.error(getErrorMessage(error, '创建工作区记忆失败'));
    } finally {
      if (createGenerationRef.current === requestGeneration) {
        setCreating(false);
      }
    }
  };

  const handleSave = async () => {
    if (!selectedWorkspaceJid || !selectedItem || !draft.content.trim()) return;
    const workspaceJid = selectedWorkspaceJid;
    const workspaceEpoch = workspaceEpochRef.current;
    const itemId = selectedItem.id;
    if (!isCurrentWorkspace(workspaceJid, workspaceEpoch)) return;
    const requestGeneration = ++saveGenerationRef.current;
    setSaving(true);
    setConflict(null);
    try {
      const result = await api.patch<WorkspaceMemoryItemResult>(
        memoryItemPath(workspaceJid, itemId),
        {
          expectedRevision: selectedItem.revision,
          kind: draft.kind,
          title: draft.title.trim() || null,
          content: draft.content.trim(),
          provenance: {
            observedAt: new Date().toISOString(),
          },
        },
      );
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        saveGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      toast.success(`已保存 revision ${result.item.revision}`);
      setStoreRevision(result.storeRevision);
      syncSelectedItem(result.item);
      await refreshMemoryView();
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        saveGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      await loadDetail(result.item.id, { discardDraft: true });
    } catch (error) {
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        saveGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      const nextConflict = revisionConflictFrom(error);
      if (nextConflict) {
        setConflict(nextConflict);
      } else {
        toast.error(getErrorMessage(error, '保存工作区记忆失败'));
      }
    } finally {
      if (saveGenerationRef.current === requestGeneration) {
        setSaving(false);
      }
    }
  };

  const handleForget = async () => {
    if (!selectedWorkspaceJid || !selectedItem) return;
    const workspaceJid = selectedWorkspaceJid;
    const workspaceEpoch = workspaceEpochRef.current;
    const itemId = selectedItem.id;
    if (!isCurrentWorkspace(workspaceJid, workspaceEpoch)) return;
    const requestGeneration = ++forgetGenerationRef.current;
    setForgetting(true);
    try {
      await apiFetch<WorkspaceMemoryItemResult>(
        memoryItemPath(workspaceJid, itemId),
        {
          method: 'DELETE',
          body: JSON.stringify({
            expectedRevision: selectedItem.revision,
            reason: 'Forgotten from Workspace Memory UI',
            provenance: {
              observedAt: new Date().toISOString(),
            },
          }),
        },
      );
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        forgetGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      setForgetOpen(false);
      toast.success('已忘记这条工作区记忆');
      syncSelectedItem(null);
      setVersions([]);
      setShowDetail(false);
      await refreshMemoryView();
    } catch (error) {
      if (
        !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
        forgetGenerationRef.current !== requestGeneration ||
        detailTargetRef.current !== itemId
      ) {
        return;
      }
      const nextConflict = revisionConflictFrom(error);
      if (nextConflict) {
        setForgetOpen(false);
        setConflict(nextConflict);
      } else {
        toast.error(getErrorMessage(error, '忘记工作区记忆失败'));
      }
    } finally {
      if (forgetGenerationRef.current === requestGeneration) {
        setForgetting(false);
      }
    }
  };

  const reloadAfterConflict = async () => {
    if (!selectedItem) return;
    await loadDetail(selectedItem.id, { discardDraft: true });
  };

  // A search without hits clears the detail pane, unless it holds unsaved
  // edits; the selection comes back once the query changes.
  const shownItem = searchHits?.length === 0 && !dirty ? null : selectedItem;

  const itemSnippet = (itemId: string): string | undefined =>
    searchHits?.find((hit) => hit.item.id === itemId)?.snippet;

  const kindOptions = [
    {
      value: 'all' as KindFilter,
      label: `全部 ${items.length}${nextCursor ? '+' : ''}`,
    },
    ...WORKSPACE_MEMORY_KINDS.map((kind) => ({
      value: kind as KindFilter,
      label: `${KIND_META[kind].label} ${counts[kind]}${nextCursor ? '+' : ''}`,
      icon: KIND_ICONS[kind],
    })),
  ];

  return (
    <PageContainer size="wide" className="space-y-5" data-memory-v2="true">
      <div>
        <PageHeader
          title="记忆"
          subtitle="沉淀当前工作区跨 Session 可复用的事实、决策、经验和待跟进事项。"
          className="flex-col gap-3 sm:flex-row"
          actions={
            <>
              <Label htmlFor="memory-workspace" className="sr-only">
                工作区
              </Label>
              <Select
                value={selectedWorkspaceJid}
                onValueChange={handleWorkspaceChange}
                disabled={workspaceLoading || workspaces.length === 0}
              >
                <SelectTrigger id="memory-workspace" className="w-48 sm:w-56">
                  <SelectValue placeholder="选择工作区" />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.jid} value={workspace.jid}>
                      {workspace.name}
                      {workspace.is_home ? ' · Home' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={openCreate}
                disabled={!selectedWorkspaceJid || !canModify}
              >
                <Plus />
                新建记忆
              </Button>
            </>
          }
        />
        {selectedWorkspace && (
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground">
            <span className="font-medium text-foreground">
              {selectedWorkspace.name}
            </span>
            <span aria-hidden="true">·</span>
            <span>{selectedWorkspace.agent_profile?.name || '主智能体'}</span>
            <span aria-hidden="true">·</span>
            <span>{canModify ? '可编辑' : '只读'}</span>
            {storeRevision !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  Store revision {storeRevision}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl bg-surface-raised px-4 py-3 ring-1 ring-surface-border">
        <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-label text-foreground">
            Workspace Memory 与 Session 历史彼此独立
          </div>
          <p className="mt-0.5 text-caption text-muted-foreground">
            Session 保留一段对话的上下文；这里仅保存经过提炼、可跨 Session
            使用的工作区知识。忘记一条工作区记忆不会删除聊天历史。
          </p>
        </div>
      </div>

      {workspaceError && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-body text-destructive"
        >
          {workspaceError}
        </div>
      )}

      {!workspaceLoading && !workspaceError && workspaces.length === 0 && (
        <div className="rounded-xl bg-surface-raised ring-1 ring-surface-border">
          <EmptyState
            icon={BookOpen}
            title="还没有工作区"
            description="创建工作区后，才能沉淀该工作区的长期记忆。"
          />
        </div>
      )}

      {selectedWorkspaceJid && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pr-8 pl-8"
                placeholder="搜索当前工作区的记忆"
                aria-label="搜索当前工作区的记忆"
              />
              {searching && (
                <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <SegmentedControl
                label="按类别筛选"
                value={kindFilter}
                options={kindOptions}
                onChange={setKindFilter}
                className="min-w-0 flex-1 sm:flex-none"
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void refreshMemoryView()}
                disabled={listLoading || searching}
              >
                <RefreshCw
                  className={cn((listLoading || searching) && 'animate-spin')}
                />
                刷新
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
            {(!isMobile || !showDetail) && (
              <section aria-label="记忆列表" className="min-w-0 space-y-2">
                <div className="flex items-baseline justify-between gap-2 px-1">
                  <h2 className="text-title-sm text-foreground">
                    {kindFilter === 'all'
                      ? '全部工作区记忆'
                      : KIND_META[kindFilter].label}
                  </h2>
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {searchHits
                      ? `${searchHits.length} 条搜索结果`
                      : `${visibleItems.length} 条活跃记忆`}
                  </span>
                </div>

                {listError && (
                  <div
                    role="alert"
                    className="rounded-lg bg-destructive/10 px-3 py-2 text-caption text-destructive"
                  >
                    {listError}
                  </div>
                )}

                {visibleItems.length === 0 ? (
                  <div className="rounded-xl bg-surface-raised ring-1 ring-surface-border">
                    {listLoading ? (
                      <div className="flex items-center justify-center gap-2 py-12 text-body text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        正在加载工作区记忆
                      </div>
                    ) : (
                      <EmptyState
                        icon={BookOpen}
                        title={
                          query.trim()
                            ? '没有匹配的记忆'
                            : '这个工作区还没有记忆'
                        }
                        description={
                          query.trim()
                            ? '换一个关键词，或清除类别筛选后重试。'
                            : canModify
                              ? '创建第一条事实、决策、经验或待跟进事项。'
                              : '你可以查看该工作区，但不能修改它。'
                        }
                      />
                    )}
                  </div>
                ) : (
                  <ListGroup className="max-h-[620px] overflow-y-auto">
                    {visibleItems.map((item) => (
                      <MemoryListItem
                        key={item.id}
                        item={item}
                        active={item.id === selectedId}
                        snippet={itemSnippet(item.id)}
                        onSelect={(next) => void loadDetail(next.id)}
                      />
                    ))}
                  </ListGroup>
                )}

                {!searchHits && nextCursor && (
                  <Button
                    variant="ghost"
                    className="w-full"
                    disabled={loadingMore}
                    onClick={() =>
                      void loadItems({ append: true, cursor: nextCursor })
                    }
                  >
                    {loadingMore && <Loader2 className="animate-spin" />}
                    加载更多
                  </Button>
                )}
              </section>
            )}

            {(!isMobile || showDetail) && (
              <section
                aria-label="记忆详情"
                className="min-w-0 overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border"
              >
                {(isMobile || shownItem) && (
                  <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2">
                    {isMobile && (
                      <IconButton
                        label="返回记忆列表"
                        icon={<ArrowLeft />}
                        onClick={() => setShowDetail(false)}
                      />
                    )}
                    {shownItem && (
                      <>
                        <MemoryKindBadge kind={shownItem.kind} />
                        <Badge variant="outline" className="tabular-nums">
                          Revision {shownItem.revision}
                        </Badge>
                        {dirty && (
                          <span className="text-caption text-warning">
                            有未保存修改
                          </span>
                        )}
                        {canModify && (
                          <div className="ml-auto flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setForgetOpen(true)}
                            >
                              <Trash2 />
                              忘记
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => void handleSave()}
                              disabled={
                                !dirty || !draft.content.trim() || saving
                              }
                            >
                              {saving ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <Save />
                              )}
                              保存 revision
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {detailLoading && !selectedItem && (
                  <div className="flex items-center justify-center gap-2 py-16 text-body text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    正在加载记忆详情
                  </div>
                )}

                {!shownItem && !detailLoading && (
                  <EmptyState
                    icon={FileText}
                    title="选择一条工作区记忆"
                    description="查看来源与修订记录，或在有权限时编辑和忘记它。"
                    className="py-16"
                  />
                )}

                {shownItem && (
                  <div className="space-y-5 p-4 sm:p-5">
                    <h2 className="text-title text-foreground">
                      {shownItem.title || '无标题记忆'}
                    </h2>

                    {conflict && (
                      <div
                        role="alert"
                        className="flex items-start gap-2.5 rounded-lg bg-warning/10 px-4 py-3"
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        <div className="min-w-0 flex-1">
                          <div className="text-label text-foreground">
                            保存冲突：这条记忆已被其他会话更新
                          </div>
                          <p className="mt-1 text-caption leading-5 text-muted-foreground">
                            你的草稿仍保留在编辑框中。当前服务端 revision{' '}
                            {conflict.currentRevision ?? '未知'}，store revision{' '}
                            {conflict.storeRevision ?? '未知'}
                            。加载最新版会覆盖当前草稿。
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2.5"
                            onClick={() => void reloadAfterConflict()}
                          >
                            <RefreshCw />
                            加载服务端最新版
                          </Button>
                        </div>
                      </div>
                    )}

                    <dl className="grid gap-x-6 gap-y-3 rounded-lg px-4 py-3 ring-1 ring-surface-border sm:grid-cols-3">
                      <div className="min-w-0">
                        <dt className="text-caption text-muted-foreground">
                          来源
                        </dt>
                        <dd className="mt-0.5 text-body break-all text-foreground">
                          {provenanceLabel(shownItem.provenance)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-caption text-muted-foreground">
                          观察时间
                        </dt>
                        <dd className="mt-0.5 text-body text-foreground tabular-nums">
                          {formatTime(
                            shownItem.provenance.observedAt ||
                              shownItem.createdAt,
                          )}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-caption text-muted-foreground">
                          最近修订
                        </dt>
                        <dd className="mt-0.5 text-body text-foreground tabular-nums">
                          r{shownItem.revision} ·{' '}
                          {formatTime(shownItem.updatedAt)}
                        </dd>
                      </div>
                    </dl>

                    <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
                      <div className="space-y-1.5">
                        <Label htmlFor="memory-kind" className="text-label">
                          类别
                        </Label>
                        <Select
                          value={draft.kind}
                          onValueChange={(value) =>
                            setDraft((current) => ({
                              ...current,
                              kind: value as WorkspaceMemoryKind,
                            }))
                          }
                          disabled={!canModify || saving}
                        >
                          <SelectTrigger id="memory-kind" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WORKSPACE_MEMORY_KINDS.map((kind) => (
                              <SelectItem key={kind} value={kind}>
                                {KIND_META[kind].label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="memory-title" className="text-label">
                          标题
                        </Label>
                        <Input
                          id="memory-title"
                          value={draft.title}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              title: event.target.value,
                            }))
                          }
                          disabled={!canModify || saving}
                          placeholder="简短描述这条记忆"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="memory-content" className="text-label">
                        内容
                      </Label>
                      <Textarea
                        id="memory-content"
                        className="min-h-52 resize-y text-body leading-6"
                        value={draft.content}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            content: event.target.value,
                          }))
                        }
                        disabled={!canModify || saving}
                      />
                    </div>

                    <section className="space-y-2 border-t border-surface-border pt-5">
                      <h3 className="flex items-center gap-2 text-title-sm text-foreground">
                        <History className="size-4 text-muted-foreground" />
                        修订记录
                      </h3>
                      {versions.length === 0 ? (
                        <p className="text-caption text-muted-foreground">
                          暂无可用修订记录。
                        </p>
                      ) : (
                        <>
                          <div className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border">
                            {versions.map((version) => (
                              <div
                                key={version.revision}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                              >
                                <Badge
                                  variant="outline"
                                  className="tabular-nums"
                                >
                                  r{version.revision}
                                </Badge>
                                <span className="text-label text-foreground">
                                  {CHANGE_TYPE_LABELS[version.changeType] ||
                                    version.changeType}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                                  {provenanceLabel(version.provenance)}
                                </span>
                                <span className="text-caption text-muted-foreground tabular-nums">
                                  {formatTime(version.createdAt)}
                                </span>
                              </div>
                            ))}
                          </div>
                          {versionNextCursor && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full"
                              disabled={loadingMoreVersions}
                              onClick={() => void loadMoreVersions()}
                            >
                              {loadingMoreVersions && (
                                <Loader2 className="animate-spin" />
                              )}
                              加载更多修订
                            </Button>
                          )}
                        </>
                      )}
                    </section>
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工作区记忆</DialogTitle>
            <DialogDescription>
              这条记忆只属于 {selectedWorkspace?.name || '当前工作区'}
              ，不会在不同工作区之间共享。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="create-memory-kind" className="text-label">
                类别
              </Label>
              <Select
                value={createDraft.kind}
                onValueChange={(value) =>
                  setCreateDraft((current) => ({
                    ...current,
                    kind: value as WorkspaceMemoryKind,
                  }))
                }
                disabled={creating}
              >
                <SelectTrigger id="create-memory-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKSPACE_MEMORY_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {KIND_META[kind].label} · {KIND_META[kind].description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-memory-title" className="text-label">
                标题（可选）
              </Label>
              <Input
                id="create-memory-title"
                value={createDraft.title}
                onChange={(event) =>
                  setCreateDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                disabled={creating}
                placeholder="例如：采用 SQLite 作为 canonical store"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-memory-content" className="text-label">
                内容
              </Label>
              <Textarea
                id="create-memory-content"
                className="min-h-36"
                value={createDraft.content}
                onChange={(event) =>
                  setCreateDraft((current) => ({
                    ...current,
                    content: event.target.value,
                  }))
                }
                disabled={creating}
                placeholder="写下可供未来 Session 复用的结论和必要背景。"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="create-memory-session" className="text-label">
                来源 Session ID（可选）
              </Label>
              <Input
                id="create-memory-session"
                value={createDraft.sessionId}
                onChange={(event) =>
                  setCreateDraft((current) => ({
                    ...current,
                    sessionId: event.target.value,
                  }))
                }
                disabled={creating}
                placeholder="用于回溯产生这条记忆的 Session"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!createDraft.content.trim() || creating}
            >
              {creating && <Loader2 className="animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={forgetOpen}
        onClose={() => {
          if (!forgetting) setForgetOpen(false);
        }}
        onConfirm={() => void handleForget()}
        title="忘记这条工作区记忆？"
        message={`它将从未来 Session 的 Workspace Memory 检索中移除，但不会删除来源 Session 或聊天历史。此操作使用当前 revision ${selectedItem?.revision ?? '—'}，若内容已更新会先提示冲突。`}
        confirmText="确认忘记"
        confirmVariant="danger"
        loading={forgetting}
      />
    </PageContainer>
  );
}
