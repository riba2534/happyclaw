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
  Check,
  CheckCircle2,
  CircleDotDashed,
  Clock,
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
import { createUnsavedNavigationGuard } from '@/utils/unsaved-navigation';
import { Badge } from '@/components/ui/badge';
import { getMemoryValidityInfo } from '../utils/memory-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
    <Badge variant="secondary">
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
  const validity = getMemoryValidityInfo(item);

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
        active
          ? 'border-primary bg-primary/5 ring-1 ring-primary/15'
          : 'border-border bg-background hover:bg-muted/50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {item.title?.trim() || item.content.split('\n')[0] || '无标题记忆'}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {snippet || item.content}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <MemoryKindBadge kind={item.kind} />
          <Badge variant={validity.badgeVariant} className="text-[10px]">
            {validity.label}
          </Badge>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>{provenanceLabel(item.provenance)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatTime(item.provenance.observedAt || item.updatedAt)}</span>
        <span aria-hidden="true">·</span>
        <span>r{item.revision}</span>
        {validity.validityRangeText && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-[180px]">
              {validity.validityRangeText}
            </span>
          </>
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground/80 truncate">
        {validity.reason}
      </div>
    </button>
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
  const [statusFilter, setStatusFilter] = useState<
    | 'all'
    | 'active'
    | 'proposed'
    | 'conflicted'
    | 'effective'
    | 'future'
    | 'expired'
  >('all');
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  const kindFilterRef = useRef<KindFilter>('all');
  const statusFilterRef = useRef<
    | 'all'
    | 'active'
    | 'proposed'
    | 'conflicted'
    | 'effective'
    | 'future'
    | 'expired'
  >('all');
  queryRef.current = query;
  kindFilterRef.current = kindFilter;
  statusFilterRef.current = statusFilter;
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
    const trimmed = query.trim().toLowerCase();
    let list = items;

    if (trimmed) {
      if (statusFilter === 'all') {
        // 在全部状态下搜索：以 searchHits 命中文档为基础，同时合入匹配关键词的候选/冲突记录，防止被仅活跃召回接口冲掉
        const matchedActive = searchHits
          ? searchHits.map((hit) => hit.item)
          : items.filter(
              (it) =>
                (it.title && it.title.toLowerCase().includes(trimmed)) ||
                it.content.toLowerCase().includes(trimmed),
            );
        const matchedNonActive = items.filter(
          (it) =>
            it.status !== 'active' &&
            ((it.title && it.title.toLowerCase().includes(trimmed)) ||
              it.content.toLowerCase().includes(trimmed)),
        );
        const byId = new Map<string, WorkspaceMemoryItem>();
        for (const it of matchedActive) byId.set(it.id, it);
        for (const it of matchedNonActive) byId.set(it.id, it);
        list = Array.from(byId.values());
      } else if (statusFilter === 'active' || statusFilter === 'effective') {
        list = searchHits ? searchHits.map((hit) => hit.item) : items;
      } else {
        // proposed, conflicted, future, expired 等：在对应集合中按关键词检索
        list = list.filter(
          (item) =>
            (item.title && item.title.toLowerCase().includes(trimmed)) ||
            item.content.toLowerCase().includes(trimmed),
        );
      }
    }

    if (kindFilter !== 'all') {
      list = list.filter((item) => item.kind === kindFilter);
    }
    if (statusFilter === 'all') return list;
    if (statusFilter === 'proposed') {
      return list.filter((item) => item.status === 'proposed');
    }
    if (statusFilter === 'conflicted') {
      return list.filter((item) => item.status === 'conflicted');
    }
    if (statusFilter === 'active') {
      return list.filter((item) => item.status === 'active');
    }
    if (statusFilter === 'effective') {
      return list.filter(
        (item) => getMemoryValidityInfo(item).status === 'active_valid',
      );
    }
    if (statusFilter === 'future') {
      return list.filter(
        (item) => getMemoryValidityInfo(item).status === 'future',
      );
    }
    if (statusFilter === 'expired') {
      return list.filter(
        (item) => getMemoryValidityInfo(item).status === 'expired',
      );
    }
    return list;
  }, [items, kindFilter, query, searchHits, statusFilter]);
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
        const currentStatus = statusFilterRef.current;
        const requestedStatus =
          currentStatus === 'proposed'
            ? 'proposed'
            : currentStatus === 'conflicted'
              ? 'conflicted'
              : 'active';
        const params = new URLSearchParams({
          status: requestedStatus,
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

        let mergedItems = data.items;
        // 如果是 'all' 状态且非游标翻页，尝试并发拉取 proposed 与 conflicted 记忆合并展示
        if (currentStatus === 'all' && !options?.cursor) {
          try {
            const [proposedData, conflictedData] = await Promise.all([
              api
                .get<WorkspaceMemoryCollection>(
                  `${memoryItemsPath(workspaceJid)}?status=proposed&limit=50`,
                )
                .catch(() => null),
              api
                .get<WorkspaceMemoryCollection>(
                  `${memoryItemsPath(workspaceJid)}?status=conflicted&limit=50`,
                )
                .catch(() => null),
            ]);
            if (
              (proposedData?.items && proposedData.items.length > 0) ||
              (conflictedData?.items && conflictedData.items.length > 0)
            ) {
              const byId = new Map<string, WorkspaceMemoryItem>();
              for (const it of mergedItems) byId.set(it.id, it);
              for (const it of proposedData?.items ?? []) byId.set(it.id, it);
              for (const it of conflictedData?.items ?? []) byId.set(it.id, it);
              mergedItems = Array.from(byId.values()).sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
              );
            }
          } catch {
            // best-effort 合并
          }
        }

        // 第二段异步结束后重新校验 workspace 与代次，防止切换工作区或筛选后旧请求覆盖
        if (
          !isCurrentWorkspace(workspaceJid, workspaceEpoch) ||
          listGenerationRef.current !== requestGeneration
        ) {
          return;
        }

        setItems((current) =>
          append ? [...current, ...mergedItems] : mergedItems,
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
  }, [selectedWorkspaceJid, statusFilter, loadItems]);

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

  const handleConfirmProposed = async () => {
    if (
      !selectedWorkspaceJid ||
      !selectedItem ||
      selectedItem.status !== 'proposed'
    )
      return;
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
          status: 'active',
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
      const nextValidity = getMemoryValidityInfo(result.item);
      if (nextValidity.status === 'active_valid') {
        toast.success('已采纳候选记忆为正式有效记忆，当前已进入召回池');
      } else if (nextValidity.status === 'future') {
        toast.success(`已采纳候选记忆（${nextValidity.reason}）`);
      } else if (nextValidity.status === 'expired') {
        toast.warning(`已采纳该记录，但当前已过期（${nextValidity.reason}）`);
      } else {
        toast.success('已采纳候选记忆');
      }
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
        toast.error(getErrorMessage(error, '采纳候选记忆失败'));
      }
    } finally {
      if (saveGenerationRef.current === requestGeneration) {
        setSaving(false);
      }
    }
  };

  const handleResolveConflict = async () => {
    if (
      !selectedWorkspaceJid ||
      !selectedItem ||
      selectedItem.status !== 'conflicted'
    )
      return;
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
          status: 'active',
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
      const nextValidity = getMemoryValidityInfo(result.item);
      if (nextValidity.status === 'active_valid') {
        toast.success('已解决冲突并保存为正式有效记忆，当前已进入召回池');
      } else if (nextValidity.status === 'future') {
        toast.success(`已解决冲突并保存（${nextValidity.reason}）`);
      } else if (nextValidity.status === 'expired') {
        toast.warning(
          `已解决冲突并保存，但当前已过期（${nextValidity.reason}）`,
        );
      } else {
        toast.success('已解决冲突并保存');
      }
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
        toast.error(getErrorMessage(error, '解决冲突失败'));
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

  const itemSnippet = (itemId: string): string | undefined =>
    searchHits?.find((hit) => hit.item.id === itemId)?.snippet;

  return (
    <div className="min-h-full bg-background p-4 lg:p-8" data-memory-v2="true">
      <div className="mx-auto max-w-7xl space-y-4">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-brand-100 p-2.5">
                  <BookOpen className="size-5 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-foreground">
                    Workspace Memory
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                    沉淀当前工作区跨 Session
                    可复用的事实、决策、经验和待跟进事项。
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56">
                  <Label
                    htmlFor="memory-workspace"
                    className="mb-1.5 block text-xs text-muted-foreground"
                  >
                    工作区
                  </Label>
                  <Select
                    value={selectedWorkspaceJid}
                    onValueChange={handleWorkspaceChange}
                    disabled={workspaceLoading || workspaces.length === 0}
                  >
                    <SelectTrigger
                      id="memory-workspace"
                      className="h-9 w-full min-w-56"
                    >
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
                </div>
                <Button
                  className="h-9"
                  onClick={openCreate}
                  disabled={!selectedWorkspaceJid || !canModify}
                >
                  <Plus />
                  新建记忆
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-primary/15 bg-primary/5 px-4 py-3 text-sm">
              <div className="flex items-start gap-2.5">
                <MessageSquareText className="mt-0.5 size-4 shrink-0 text-primary" />
                <div>
                  <div className="font-medium text-foreground">
                    Workspace Memory 与 Session 历史彼此独立
                  </div>
                  <p className="mt-0.5 leading-5 text-muted-foreground">
                    Session 保留一段对话的上下文；这里仅保存经过提炼、可跨
                    Session
                    使用的工作区知识。忘记一条工作区记忆不会删除聊天历史。
                  </p>
                </div>
              </div>
            </div>

            {selectedWorkspace && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selectedWorkspace.name}
                </span>
                <span>·</span>
                <span>
                  {selectedWorkspace.agent_profile?.name || '主智能体'}
                </span>
                <span>·</span>
                <span>{canModify ? '可编辑' : '只读'}</span>
                {storeRevision !== null && (
                  <>
                    <span>·</span>
                    <span>Store revision {storeRevision}</span>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {workspaceError && (
          <Card>
            <CardContent role="alert" className="text-sm text-destructive">
              {workspaceError}
            </CardContent>
          </Card>
        )}

        {!workspaceLoading && !workspaceError && workspaces.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <BookOpen className="mx-auto size-8 text-muted-foreground" />
              <h2 className="mt-3 font-semibold text-foreground">
                还没有工作区
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                创建工作区后，才能沉淀该工作区的长期记忆。
              </p>
            </CardContent>
          </Card>
        )}

        {selectedWorkspaceJid && (
          <>
            <Card>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {WORKSPACE_MEMORY_KINDS.map((kind) => {
                    const Icon = KIND_ICONS[kind];
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() =>
                          setKindFilter((current) =>
                            current === kind ? 'all' : kind,
                          )
                        }
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          kindFilter === kind
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <Icon className="size-4 text-primary" />
                          <span className="text-lg font-semibold text-foreground">
                            {counts[kind]}
                            {nextCursor ? '+' : ''}
                          </span>
                        </div>
                        <div className="mt-2 text-sm font-medium text-foreground">
                          {KIND_META[kind].label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {KIND_META[kind].description}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="h-10 pl-9"
                      placeholder="搜索当前工作区的记忆"
                      aria-label="搜索当前工作区的记忆"
                    />
                    {searching && (
                      <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="h-10"
                    onClick={() => void refreshMemoryView()}
                    disabled={listLoading || searching}
                  >
                    <RefreshCw
                      className={listLoading || searching ? 'animate-spin' : ''}
                    />
                    刷新
                  </Button>
                </div>

                {/* 状态与有效性筛选器 (R10) */}
                <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                  <span className="mr-1 text-xs text-muted-foreground">
                    状态：
                  </span>
                  {[
                    { key: 'all', label: '全部状态' },
                    { key: 'active', label: '活跃 (active)' },
                    { key: 'proposed', label: '候选待确认 (proposed)' },
                    { key: 'conflicted', label: '冲突待解决 (conflicted)' },
                    { key: 'effective', label: '当前可召回' },
                    { key: 'future', label: '未来生效' },
                    { key: 'expired', label: '已过期' },
                  ].map((tab) => (
                    <Button
                      key={tab.key}
                      type="button"
                      variant={statusFilter === tab.key ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        searchGenerationRef.current += 1;
                        setSearchHits(null);
                        setStatusFilter(tab.key as any);
                      }}
                    >
                      {tab.label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
              {(!isMobile || !showDetail) && (
                <Card>
                  <CardContent>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <h2 className="font-semibold text-foreground">
                          {kindFilter === 'all'
                            ? '全部工作区记忆'
                            : KIND_META[kindFilter].label}
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {searchHits
                            ? `${searchHits.length} 条搜索结果`
                            : `${visibleItems.length} 条活跃记忆`}
                        </p>
                      </div>
                      {kindFilter !== 'all' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setKindFilter('all')}
                        >
                          清除筛选
                        </Button>
                      )}
                    </div>

                    {listError && (
                      <div
                        role="alert"
                        className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"
                      >
                        {listError}
                      </div>
                    )}

                    <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
                      {listLoading && visibleItems.length === 0 && (
                        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" />
                          正在加载工作区记忆
                        </div>
                      )}
                      {!listLoading && visibleItems.length === 0 && (
                        <div className="py-12 text-center">
                          <BookOpen className="mx-auto size-7 text-muted-foreground" />
                          <p className="mt-3 text-sm font-medium text-foreground">
                            {query.trim()
                              ? '没有匹配的记忆'
                              : '这个工作区还没有记忆'}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {query.trim()
                              ? '换一个关键词，或清除类别筛选后重试。'
                              : canModify
                                ? '创建第一条事实、决策、经验或待跟进事项。'
                                : '你可以查看该工作区，但不能修改它。'}
                          </p>
                        </div>
                      )}
                      {visibleItems.map((item) => (
                        <MemoryListItem
                          key={item.id}
                          item={item}
                          active={item.id === selectedId}
                          snippet={itemSnippet(item.id)}
                          onSelect={(next) => void loadDetail(next.id)}
                        />
                      ))}
                      {!searchHits && nextCursor && (
                        <Button
                          variant="outline"
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
                    </div>
                  </CardContent>
                </Card>
              )}

              {(!isMobile || showDetail) && (
                <Card>
                  <CardContent>
                    {isMobile && (
                      <Button
                        variant="ghost"
                        className="mb-3"
                        onClick={() => setShowDetail(false)}
                      >
                        <ArrowLeft />
                        返回记忆列表
                      </Button>
                    )}

                    {detailLoading && !selectedItem && (
                      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        正在加载记忆详情
                      </div>
                    )}

                    {!selectedItem && !detailLoading && (
                      <div className="py-16 text-center">
                        <FileText className="mx-auto size-8 text-muted-foreground" />
                        <h2 className="mt-3 font-semibold text-foreground">
                          选择一条工作区记忆
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          查看来源与修订记录，或在有权限时编辑和忘记它。
                        </p>
                      </div>
                    )}

                    {selectedItem &&
                      (() => {
                        const selectedValidity =
                          getMemoryValidityInfo(selectedItem);

                        return (
                          <div className="space-y-5">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <MemoryKindBadge kind={selectedItem.kind} />
                                  <Badge variant="outline">
                                    Revision {selectedItem.revision}
                                  </Badge>
                                  <Badge
                                    variant={selectedValidity.badgeVariant}
                                  >
                                    {selectedValidity.label}
                                  </Badge>
                                  {selectedValidity.isRecalible ? (
                                    <Badge
                                      variant="secondary"
                                      className="text-emerald-700 dark:text-emerald-300"
                                    >
                                      <Check className="mr-1 size-3" />
                                      当前可召回
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="text-muted-foreground"
                                    >
                                      <Clock className="mr-1 size-3" />
                                      不可召回
                                    </Badge>
                                  )}
                                </div>
                                <h2 className="mt-3 text-lg font-semibold text-foreground">
                                  {selectedItem.title || '无标题记忆'}
                                </h2>
                              </div>
                              {canModify && (
                                <Button
                                  variant="destructive"
                                  onClick={() => setForgetOpen(true)}
                                >
                                  <Trash2 />
                                  忘记
                                </Button>
                              )}
                            </div>

                            {/* 生效状态与原因说明 (R10) */}
                            <div className="rounded-xl border border-border bg-muted/10 p-3.5 text-xs">
                              <div className="flex items-center justify-between font-medium text-foreground">
                                <span>生效与召回状态</span>
                                <span className="text-muted-foreground">
                                  {selectedValidity.label}
                                </span>
                              </div>
                              <div className="mt-1.5 leading-relaxed text-muted-foreground">
                                {selectedValidity.reason}
                              </div>
                              {selectedValidity.validityRangeText && (
                                <div className="mt-1 text-muted-foreground/80">
                                  有效区间：{selectedValidity.validityRangeText}
                                </div>
                              )}
                            </div>

                            {/* 候选记忆采纳确认 (R10) */}
                            {selectedItem.status === 'proposed' &&
                              canModify && (
                                <div className="rounded-xl border border-purple-500/30 bg-purple-50/50 p-4 dark:border-purple-500/20 dark:bg-purple-950/20">
                                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                      <div className="font-semibold text-purple-900 dark:text-purple-100">
                                        这是候选记忆 (待确认)
                                      </div>
                                      <p className="mt-0.5 text-xs text-purple-800 dark:text-purple-300">
                                        需经确认采纳后，方可正式生效并进入工作区智能体的召回池。
                                      </p>
                                    </div>
                                    <Button
                                      size="sm"
                                      disabled={saving}
                                      onClick={() =>
                                        void handleConfirmProposed()
                                      }
                                      className="bg-purple-600 hover:bg-purple-700 text-white gap-1.5 shrink-0"
                                    >
                                      {saving ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : (
                                        <Check className="size-3.5" />
                                      )}
                                      采纳为正式记忆
                                    </Button>
                                  </div>
                                </div>
                              )}

                            {/* 冲突处理提示与解决操作 (R10) */}
                            {selectedItem.status === 'conflicted' &&
                              canModify && (
                                <div
                                  role="alert"
                                  className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-foreground"
                                >
                                  <div className="flex items-start gap-2.5">
                                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                                    <div className="min-w-0 flex-1">
                                      <div className="font-medium text-foreground">
                                        待解决冲突：此记忆存在多方更新或版本冲突
                                      </div>
                                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                        当前不可直接参与召回。请核对下方编辑框中的内容，修改修正后点击“解决冲突并生效”完成
                                        CAS 校验与转正。
                                      </p>
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        <Button
                                          size="sm"
                                          disabled={
                                            saving || !draft.content.trim()
                                          }
                                          onClick={() =>
                                            void handleResolveConflict()
                                          }
                                          className="gap-1.5"
                                        >
                                          {saving ? (
                                            <Loader2 className="size-3.5 animate-spin" />
                                          ) : (
                                            <CheckCircle2 className="size-3.5" />
                                          )}
                                          解决冲突并生效
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}

                            {conflict && (
                              <div
                                role="alert"
                                className="rounded-xl border border-warning/30 bg-warning-bg p-4"
                              >
                                <div className="flex items-start gap-2.5">
                                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">
                                      保存冲突：这条记忆已被其他会话更新
                                    </div>
                                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                                      你的草稿仍保留在编辑框中。当前服务端
                                      revision{' '}
                                      {conflict.currentRevision ?? '未知'}
                                      ，store revision{' '}
                                      {conflict.storeRevision ?? '未知'}
                                      。加载最新版会覆盖当前草稿。
                                    </p>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="mt-3"
                                      onClick={() => void reloadAfterConflict()}
                                    >
                                      <RefreshCw />
                                      加载服务端最新版
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 text-sm sm:grid-cols-3">
                              <div>
                                <div className="text-xs text-muted-foreground">
                                  来源
                                </div>
                                <div className="mt-1 break-all font-medium text-foreground">
                                  {provenanceLabel(selectedItem.provenance)}
                                </div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">
                                  观察时间
                                </div>
                                <div className="mt-1 font-medium text-foreground">
                                  {formatTime(
                                    selectedItem.provenance.observedAt ||
                                      selectedItem.createdAt,
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">
                                  最近修订
                                </div>
                                <div className="mt-1 font-medium text-foreground">
                                  r{selectedItem.revision} ·{' '}
                                  {formatTime(selectedItem.updatedAt)}
                                </div>
                              </div>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
                              <div>
                                <Label htmlFor="memory-kind">类别</Label>
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
                                  <SelectTrigger
                                    id="memory-kind"
                                    className="mt-1.5 w-full"
                                  >
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
                              <div>
                                <Label htmlFor="memory-title">标题</Label>
                                <Input
                                  id="memory-title"
                                  className="mt-1.5"
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

                            <div>
                              <Label htmlFor="memory-content">内容</Label>
                              <Textarea
                                id="memory-content"
                                className="mt-1.5 min-h-52 resize-y text-sm leading-6"
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

                            {canModify && (
                              <div className="flex flex-wrap items-center gap-3">
                                <Button
                                  onClick={() => void handleSave()}
                                  disabled={
                                    !dirty || !draft.content.trim() || saving
                                  }
                                >
                                  {saving && (
                                    <Loader2 className="animate-spin" />
                                  )}
                                  <Save />
                                  保存 revision
                                </Button>
                                {dirty && (
                                  <span className="text-sm text-warning">
                                    有未保存修改
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="border-t border-border pt-5">
                              <div className="mb-3 flex items-center gap-2">
                                <History className="size-4 text-muted-foreground" />
                                <h3 className="font-semibold text-foreground">
                                  修订记录
                                </h3>
                              </div>
                              {versions.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                  暂无可用修订记录。
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  {versions.map((version) => (
                                    <div
                                      key={version.revision}
                                      className="rounded-lg border border-border px-3 py-2.5"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          <Badge variant="outline">
                                            r{version.revision}
                                          </Badge>
                                          <span className="text-sm font-medium text-foreground">
                                            {CHANGE_TYPE_LABELS[
                                              version.changeType
                                            ] || version.changeType}
                                          </span>
                                        </div>
                                        <span className="text-xs text-muted-foreground">
                                          {formatTime(version.createdAt)}
                                        </span>
                                      </div>
                                      <div className="mt-1.5 text-xs text-muted-foreground">
                                        {provenanceLabel(version.provenance)}
                                      </div>
                                    </div>
                                  ))}
                                  {versionNextCursor && (
                                    <Button
                                      variant="outline"
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
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}
      </div>

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
            <div>
              <Label htmlFor="create-memory-kind">类别</Label>
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
                <SelectTrigger
                  id="create-memory-kind"
                  className="mt-1.5 w-full"
                >
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
            <div>
              <Label htmlFor="create-memory-title">标题（可选）</Label>
              <Input
                id="create-memory-title"
                className="mt-1.5"
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
            <div>
              <Label htmlFor="create-memory-content">内容</Label>
              <Textarea
                id="create-memory-content"
                className="mt-1.5 min-h-36"
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
            <div>
              <Label htmlFor="create-memory-session">
                来源 Session ID（可选）
              </Label>
              <Input
                id="create-memory-session"
                className="mt-1.5"
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

      <AlertDialog open={forgetOpen} onOpenChange={setForgetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>忘记这条工作区记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              它将从未来 Session 的 Workspace Memory 检索中移除，但不会删除来源
              Session 或聊天历史。此操作使用当前 revision{' '}
              {selectedItem?.revision ?? '—'}，若内容已更新会先提示冲突。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forgetting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={forgetting}
              onClick={(event) => {
                event.preventDefault();
                void handleForget();
              }}
            >
              {forgetting && <Loader2 className="animate-spin" />}
              确认忘记
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
