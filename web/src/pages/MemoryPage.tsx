import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useGroupsStore } from '../stores/groups';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMediaQuery } from '@/hooks/useMediaQuery';

type MemoryType = 'global' | 'heartbeat' | 'session' | 'date' | 'conversation';

interface MemorySource {
  path: string;
  label: string;
  type: MemoryType;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
  folder?: string;
}

interface MemoryFile {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

interface MemorySearchHit {
  path: string;
  hits: number;
  snippet: string;
}

const MEMORY_TYPES: MemoryType[] = ['global', 'heartbeat', 'session', 'date', 'conversation'];
const FOLDER_SUB_GROUPED: Set<MemoryType> = new Set(['session', 'date', 'conversation']);

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function typeLabel(type: MemoryType): string {
  switch (type) {
    case 'global': return '全局记忆';
    case 'heartbeat': return '每日心跳';
    case 'session': return '会话记忆';
    case 'date': return '日期记忆';
    case 'conversation': return '对话归档';
    default: return '其他';
  }
}

function SourceItem({
  source,
  active,
  hit,
  onSelect,
}: {
  source: MemorySource;
  active: boolean;
  hit?: MemorySearchHit;
  onSelect: (path: string) => void;
}) {
  // Show filename part only (strip folder prefix from label)
  const displayLabel = source.label.includes(' / ')
    ? source.label.split(' / ').slice(1).join(' / ')
    : source.label;
  return (
    <button
      onClick={() => onSelect(source.path)}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
        active
          ? 'border-primary bg-brand-50'
          : 'border-border hover:bg-muted/50'
      }`}
    >
      <div className="text-sm font-medium text-foreground truncate">
        {displayLabel}
      </div>
      <div className="text-[11px] text-muted-foreground truncate mt-0.5">
        {source.path}
      </div>
      <div className="text-[11px] mt-1 text-muted-foreground">
        {source.writable ? '可编辑' : '只读'} · {source.exists ? `${source.size} B` : '文件不存在'}
      </div>
      {hit && (
        <div className="text-[11px] mt-1 text-primary truncate">
          命中 {hit.hits} 次 · {hit.snippet}
        </div>
      )}
    </button>
  );
}

function subGroupByFolder(items: MemorySource[]): Record<string, MemorySource[]> {
  const map: Record<string, MemorySource[]> = {};
  for (const source of items) {
    const folder = source.folder || 'unknown';
    if (!map[folder]) map[folder] = [];
    map[folder].push(source);
  }
  return map;
}

export function MemoryPage() {
  const [searchParams] = useSearchParams();
  const folderParam = searchParams.get('folder');

  const [sources, setSources] = useState<MemorySource[]>([]);
  const storeGroups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => {
    if (Object.keys(storeGroups).length === 0) loadGroups();
  }, [loadGroups, storeGroups]);
  const folderNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(storeGroups)) {
      if (info.folder && info.name && !map[info.folder]) {
        map[info.folder] = info.name;
      }
    }
    return map;
  }, [storeGroups]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [fileMeta, setFileMeta] = useState<MemoryFile | null>(null);
  const [keyword, setKeyword] = useState('');
  const [searchHits, setSearchHits] = useState<Record<string, MemorySearchHit>>({});

  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchingContent, setSearchingContent] = useState(false);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [showContent, setShowContent] = useState(false);

  const dirty = useMemo(() => content !== initialContent, [content, initialContent]);

  const filteredSources = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((s) =>
      `${s.label} ${s.path}`.toLowerCase().includes(text) || Boolean(searchHits[s.path]),
    );
  }, [sources, keyword, searchHits]);

  const groupedSources = useMemo(() => {
    const groups: Record<MemoryType, MemorySource[]> = {
      global: [],
      heartbeat: [],
      session: [],
      date: [],
      conversation: [],
    };
    for (const source of filteredSources) {
      if (groups[source.type]) groups[source.type].push(source);
      else groups[source.type] = [source];
    }
    return groups;
  }, [filteredSources]);

  // Collapsed state: type-level and folder sub-group level
  const [collapsedTypes, setCollapsedTypes] = useState<Record<string, boolean>>({
    global: true,
    heartbeat: true,
    session: true,
    date: true,
    conversation: true,
  });
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const toggleType = (type: string) =>
    setCollapsedTypes((prev) => ({ ...prev, [type]: !prev[type] }));
  const toggleFolder = (folder: string) =>
    setCollapsedFolders((prev) => ({ ...prev, [folder]: !prev[folder] }));

  // Auto-expand type/folder containing the selected file
  useEffect(() => {
    if (!selectedPath) return;
    const selected = sources.find((s) => s.path === selectedPath);
    if (!selected) return;
    setCollapsedTypes((prev) => ({ ...prev, [selected.type]: false }));
    if (FOLDER_SUB_GROUPED.has(selected.type)) {
      const folder = selected.folder || 'unknown';
      setCollapsedFolders((prev) => ({ ...prev, [folder]: false }));
    }
  }, [selectedPath, sources]);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    try {
      const data = await api.get<MemoryFile>(
        `/api/memory/file?${new URLSearchParams({ path })}`,
      );
      setSelectedPath(path);
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载记忆文件失败'));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const data = await api.get<{ sources: MemorySource[] }>('/api/memory/sources');
      setSources(data.sources);

      const available = new Set(data.sources.map((s) => s.path));
      let nextSelected = selectedPath && available.has(selectedPath) ? selectedPath : null;

      if (!nextSelected) {
        // If folder param provided, try to find matching session CLAUDE.md first
        if (folderParam) {
          nextSelected =
            data.sources.find(
              (s) => s.type === 'session' && s.path.includes(`/${folderParam}/`) && s.path.endsWith('CLAUDE.md'),
            )?.path || null;
        }
      }

      if (!nextSelected) {
        // Default: global CLAUDE.md → first session CLAUDE.md → first available
        nextSelected =
          data.sources.find((s) => s.type === 'global')?.path ||
          data.sources.find((s) => s.type === 'session' && s.path.endsWith('CLAUDE.md'))?.path ||
          data.sources[0]?.path ||
          null;
      }

      if (nextSelected) {
        await loadFile(nextSelected);
      } else {
        setSelectedPath(null);
        setContent('');
        setInitialContent('');
        setFileMeta(null);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '加载记忆源失败'));
    } finally {
      setLoadingSources(false);
    }
  }, [loadFile, selectedPath, folderParam]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setSearchHits({});
      setSearchingContent(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearchingContent(true);
      try {
        const data = await api.get<{ hits: MemorySearchHit[] }>(
          `/api/memory/search?${new URLSearchParams({ q, limit: '120' })}`,
        );
        const next: Record<string, MemorySearchHit> = {};
        for (const hit of data.hits) {
          next[hit.path] = hit;
        }
        setSearchHits(next);
      } catch {
        setSearchHits({});
      } finally {
        setSearchingContent(false);
      }
    }, 280);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keyword]);

  const handleSelectSource = async (path: string) => {
    if (path === selectedPath && isMobile) {
      setShowContent(true);
      return;
    }
    if (path === selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，切换会丢失。是否继续？')) {
      return;
    }
    await loadFile(path);
    if (isMobile) setShowContent(true);
  };

  const handleSave = async () => {
    if (!selectedPath || !fileMeta?.writable) return;

    setSaving(true);
    try {
      const data = await api.put<MemoryFile>('/api/memory/file', {
        path: selectedPath,
        content,
      });
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
      toast.success('已保存');
      await loadSources();
    } catch (err) {
      toast.error(getErrorMessage(err, '保存记忆文件失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleReloadFile = async () => {
    if (!selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，重新加载会覆盖。是否继续？')) {
      return;
    }
    await loadFile(selectedPath);
  };

  const updatedText = fileMeta?.updatedAt
    ? new Date(fileMeta.updatedAt).toLocaleString('zh-CN')
    : '未记录';

  // Render a list of sources, optionally sub-grouped by folder
  const renderSourceList = (type: MemoryType, items: MemorySource[]) => {
    if (!FOLDER_SUB_GROUPED.has(type)) {
      return items.map((source) => (
        <SourceItem
          key={source.path}
          source={source}
          active={source.path === selectedPath}
          hit={searchHits[source.path]}
          onSelect={handleSelectSource}
        />
      ));
    }

    const byFolder = subGroupByFolder(items);
    return Object.entries(byFolder).map(([folder, folderItems]) => {
      const isFolderCollapsed = collapsedFolders[folder] !== false;
      return (
        <div key={folder}>
          <button
            onClick={() => toggleFolder(folder)}
            className="flex items-center gap-1 w-full text-left text-[11px] font-medium text-muted-foreground py-1 hover:text-foreground transition-colors"
          >
            {isFolderCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {folderNames[folder] || folder}
            <span className="text-muted-foreground/60 ml-1">({folderItems.length})</span>
          </button>
          {!isFolderCollapsed && (
            <div className="space-y-1 ml-3">
              {folderItems.map((source) => (
                <SourceItem
                  key={source.path}
                  source={source}
                  active={source.path === selectedPath}
                  hit={searchHits[source.path]}
                  onSelect={handleSelectSource}
                />
              ))}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <Card>
          <CardContent>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-brand-100 rounded-lg">
                <BookOpen className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">记忆管理</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  管理全局记忆、心跳摘要、会话记忆、日期记忆与对话归档。
                </p>
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              已加载记忆源: {sources.length}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {(!isMobile || !showContent) && (
          <Card>
            <CardContent>
              <div className="mb-3">
              <Input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索记忆源（路径 + 全文）"
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                {keyword.trim()
                  ? searchingContent
                    ? '正在做全文检索...'
                    : `全文命中：${Object.keys(searchHits).length} 个文件`
                  : '可按文件名、路径或内容关键词检索'}
              </div>
            </div>

            <div className="space-y-2 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
              {MEMORY_TYPES.map((type) => {
                const items = groupedSources[type];
                if (items.length === 0) return null;
                const isCollapsed = !!collapsedTypes[type];
                return (
                  <div key={type}>
                    <button
                      onClick={() => toggleType(type)}
                      className="flex items-center gap-1 w-full text-left text-xs font-semibold text-muted-foreground mb-1 hover:text-foreground transition-colors"
                    >
                      {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {typeLabel(type)} ({items.length})
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-1 ml-1">
                        {renderSourceList(type, items)}
                      </div>
                    )}
                  </div>
                );
              })}

              {!loadingSources && filteredSources.length === 0 && (
                <div className="text-sm text-muted-foreground">没有匹配的记忆源</div>
              )}
              </div>
            </CardContent>
          </Card>
          )}

          {(!isMobile || showContent) && (
          <Card>
            <CardContent>
              {selectedPath ? (
                <>
                  {isMobile && (
                    <button
                      onClick={() => setShowContent(false)}
                      className="flex items-center gap-1 text-sm text-primary mb-3 hover:underline"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      返回列表
                    </button>
                  )}
                  <div className="mb-3">
                    <div className="text-sm font-semibold text-foreground break-all">{selectedPath}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      最近更新时间: {updatedText} · 字节数: {new TextEncoder().encode(content).length} · {fileMeta?.writable ? '可编辑' : '只读'}
                    </div>
                  </div>

                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[calc(100dvh-380px)] lg:min-h-[460px] resize-y p-4 font-mono text-sm leading-6 disabled:bg-muted"
                    placeholder={loadingFile ? '正在加载...' : '此记忆源暂无内容'}
                    disabled={loadingFile || saving || !fileMeta?.writable}
                  />

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      onClick={handleSave}
                      disabled={loadingFile || saving || !fileMeta?.writable || !dirty}
                    >
                      {saving && <Loader2 className="size-4 animate-spin" />}
                      <Save className="w-4 h-4" />
                      保存
                    </Button>

                    <Button
                      variant="outline"
                      onClick={handleReloadFile}
                      disabled={loadingFile || saving}
                    >
                      <RefreshCw className="w-4 h-4" />
                      重新加载当前
                    </Button>

                    <Button
                      variant="outline"
                      onClick={loadSources}
                      disabled={loadingSources || loadingFile || saving}
                    >
                      <RefreshCw className="w-4 h-4" />
                      刷新记忆源
                    </Button>

                    {dirty && <span className="text-sm text-warning">有未保存修改</span>}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">暂无可用记忆源</div>
              )}
            </CardContent>
          </Card>
          )}
        </div>
      </div>
    </div>
  );
}
