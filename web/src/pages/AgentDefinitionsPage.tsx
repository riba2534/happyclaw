import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  useAgentDefinitionsStore,
  type AgentDefinitionDetail,
} from '../stores/agent-definitions';

export function AgentDefinitionsPage() {
  const { agents, loading, error: listError, loadAgents, createAgent } =
    useAgentDefinitionsStore();
  const getAgentDetail = useAgentDefinitionsStore((s) => s.getAgentDetail);
  const updateAgent = useAgentDefinitionsStore((s) => s.updateAgent);
  const deleteAgent = useAgentDefinitionsStore((s) => s.deleteAgent);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Detail state
  const [detail, setDetail] = useState<AgentDefinitionDetail | null>(null);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  // Notice
  const [notice, setNotice] = useState<string | null>(null);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [showContent, setShowContent] = useState(false);

  const dirty = useMemo(() => content !== initialContent, [content, initialContent]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return agents.filter(
      (a) =>
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [agents, searchQuery]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    setNotice(null);
    try {
      const data = await getAgentDetail(id);
      setDetail(data);
      setContent(data.content);
      setInitialContent(data.content);
      setSelectedId(id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载失败');
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [getAgentDetail]);

  const handleSelectAgent = async (id: string) => {
    if (id === selectedId && isMobile) {
      setShowContent(true);
      return;
    }
    if (id === selectedId) return;
    if (dirty && !confirm('当前有未保存修改，切换会丢失。是否继续？')) return;
    await loadDetail(id);
    if (isMobile) setShowContent(true);
  };

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    setNotice(null);
    setDetailError(null);
    try {
      await updateAgent(detail.id, content);
      const updated = await getAgentDetail(detail.id);
      setDetail(updated);
      setContent(updated.content);
      setInitialContent(updated.content);
      setNotice('已保存');
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(`确认删除 Agent「${detail.name}」？`)) return;
    setDeleting(true);
    try {
      await deleteAgent(detail.id);
      setSelectedId(null);
      setDetail(null);
      setContent('');
      setInitialContent('');
      if (isMobile) setShowContent(false);
    } catch {
      // error handled by store
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const slug = createName.trim().toLowerCase().replace(/[^a-z0-9\-]/g, '-');
      const defaultContent = `---
name: ${slug}
description:
tools:
  - WebSearch
  - Read
  - Write
---

# ${createName.trim()}

（在此编写 Agent 指令）
`;
      const id = await createAgent(createName.trim(), defaultContent);
      setCreateName('');
      setShowCreate(false);
      await loadDetail(id);
      if (isMobile) setShowContent(true);
    } catch {
      // error handled by store
    } finally {
      setCreating(false);
    }
  };

  const updatedText = detail?.updatedAt
    ? new Date(detail.updatedAt).toLocaleString('zh-CN')
    : '未记录';

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header card */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-brand-100 rounded-lg">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Agent 管理</h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  管理 Agent 定义文件，通过 Task 工具的 subagent_type 调用。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadAgents} disabled={loading}>
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                刷新
              </Button>
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={16} />
                新建
              </Button>
            </div>
          </div>
          <div className="text-xs text-slate-500">
            已加载 Agent: {agents.length}
          </div>
        </div>

        {/* Grid: left list + right detail */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* Left: agent list */}
          {(!isMobile || !showContent) && (
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="mb-3">
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索 Agent 名称或描述"
                />
              </div>

              <div className="space-y-2 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
                {loading && agents.length === 0 ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="animate-spin text-primary" size={24} />
                  </div>
                ) : listError ? (
                  <div className="text-sm text-red-600 py-4 text-center">{listError}</div>
                ) : filtered.length === 0 ? (
                  <div className="text-sm text-slate-500 py-4 text-center">
                    {searchQuery ? '没有匹配的 Agent' : '暂无 Agent 定义'}
                  </div>
                ) : (
                  filtered.map((agent) => {
                    const active = agent.id === selectedId;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => handleSelectAgent(agent.id)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          active
                            ? 'border-primary bg-brand-50'
                            : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <div className="text-sm font-medium text-foreground truncate">
                          {agent.name}
                        </div>
                        <div className="text-[11px] text-slate-500 line-clamp-2 mt-0.5">
                          {agent.description || '无描述'}
                        </div>
                        {agent.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {agent.tools.slice(0, 4).map((tool) => (
                              <span
                                key={tool}
                                className="px-1.5 py-0.5 bg-muted text-slate-600 rounded text-[10px]"
                              >
                                {tool}
                              </span>
                            ))}
                            {agent.tools.length > 4 && (
                              <span className="px-1.5 py-0.5 text-slate-400 text-[10px]">
                                +{agent.tools.length - 4}
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Right: detail / editor */}
          {(!isMobile || showContent) && (
            <div className="bg-card rounded-xl border border-border p-4 lg:p-6 min-h-[calc(100dvh-280px)] lg:min-h-[560px]">
              {selectedId && detail ? (
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

                  {/* Meta info */}
                  <div className="mb-3">
                    <div className="text-sm font-semibold text-foreground break-all">{detail.name}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      最近更新时间: {updatedText} · 字节数: {new TextEncoder().encode(content).length}
                    </div>
                  </div>

                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="min-h-[calc(100dvh-380px)] lg:min-h-[460px] resize-y p-4 font-mono text-sm leading-6"
                    placeholder={loadingDetail ? '正在加载...' : '此 Agent 暂无内容'}
                    disabled={loadingDetail || saving}
                    spellCheck={false}
                  />

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button onClick={handleSave} disabled={loadingDetail || saving || !dirty}>
                      {saving && <Loader2 className="size-4 animate-spin" />}
                      <Save className="w-4 h-4" />
                      保存
                    </Button>

                    <Button
                      variant="outline"
                      onClick={() => loadDetail(selectedId)}
                      disabled={loadingDetail || saving}
                    >
                      <RefreshCw className="w-4 h-4" />
                      重新加载
                    </Button>

                    <Button
                      variant="outline"
                      onClick={handleDelete}
                      disabled={deleting || saving}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                    >
                      <Trash2 className="w-4 h-4" />
                      {deleting ? '删除中...' : '删除'}
                    </Button>

                    {dirty && <span className="text-sm text-amber-600">有未保存修改</span>}
                    {notice && <span className="text-sm text-green-600">{notice}</span>}
                    {detailError && <span className="text-sm text-red-600">{detailError}</span>}
                  </div>
                </>
              ) : loadingDetail ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="animate-spin text-primary" size={32} />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-slate-500">
                  {selectedId ? (detailError || '加载失败') : '选择一个 Agent 查看详情'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-foreground mb-4">新建 Agent</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  名称
                </label>
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="例如：code-reviewer"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground mt-1">
                  只允许小写字母、数字和连字符
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setShowCreate(false); setCreateName(''); }}>
                  取消
                </Button>
                <Button onClick={handleCreate} disabled={!createName.trim() || creating}>
                  {creating ? '创建中...' : '创建'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
