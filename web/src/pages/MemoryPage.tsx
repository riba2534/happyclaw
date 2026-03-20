import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Loader2, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface MemorySource {
  path: string;
  label: string;
  scope: 'user-global' | 'main' | 'flow' | 'session';
  kind: 'claude' | 'note' | 'session';
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
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

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function scopeLabel(scope: MemorySource['scope']): string {
  switch (scope) {
    case 'user-global':
      return '我的全局记忆';
    case 'main':
      return '主会话';
    case 'flow':
      return '会话流';
    case 'session':
      return '自动记忆';
    default:
      return '其他';
  }
}

export function MemoryPage() {
  const [sources, setSources] = useState<MemorySource[]>([]);
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
    const groups: Record<MemorySource['scope'], MemorySource[]> = {
      'user-global': [],
      main: [],
      flow: [],
      session: [],
    };
    for (const source of filteredSources) {
      groups[source.scope].push(source);
    }
    return groups;
  }, [filteredSources]);

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
        // Default: first user-global CLAUDE.md, then main, then first available
        nextSelected =
          data.sources.find((s) => s.scope === 'user-global' && s.kind === 'claude')?.path ||
          data.sources.find((s) => s.scope === 'main' && s.kind === 'claude')?.path ||
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
  }, [loadFile, selectedPath]);

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
      // Mobile: re-tap selected item to show content panel
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
                  管理个人全局记忆、主会话记忆、各会话流记忆，以及可读取的自动记忆文件。
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

            <div className="space-y-4 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
              {(['user-global', 'main', 'flow', 'session'] as const).map((scope) => {
                const items = groupedSources[scope];
                if (items.length === 0) return null;
                return (
                  <div key={scope}>
                    <div className="text-xs font-semibold text-muted-foreground mb-2">
                      {scopeLabel(scope)} ({items.length})
                    </div>
                    <div className="space-y-1">
                      {items.map((source) => {
                        const active = source.path === selectedPath;
                        const hit = searchHits[source.path];
                        return (
                          <button
                            key={source.path}
                            onClick={() => handleSelectSource(source.path)}
                            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                              active
                                ? 'border-primary bg-brand-50'
                                : 'border-border hover:bg-muted/50'
                            }`}
                          >
                            <div className="text-sm font-medium text-foreground truncate">
                              {source.label}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {source.path}
                            </div>
                            <div className="text-[11px] mt-1 text-slate-500">
                              {source.writable ? '可编辑' : '只读'} · {source.exists ? `${source.size} B` : '文件不存在'}
                            </div>
                            {hit && (
                              <div className="text-[11px] mt-1 text-primary truncate">
                                命中 {hit.hits} 次 · {hit.snippet}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
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
