import { useState, useEffect } from 'react';
import { File, Folder, Loader2, Lock, Trash2, RefreshCw, Package } from 'lucide-react';
import { useSkillsStore, type SkillDetail as SkillDetailType } from '../../stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface SkillDetailProps {
  skillId: string | null;
  onDeleted?: () => void;
}

export function SkillDetail({ skillId, onDeleted }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const getSkillDetail = useSkillsStore((state) => state.getSkillDetail);
  const deleteSkill = useSkillsStore((state) => state.deleteSkill);
  const reinstallSkill = useSkillsStore((state) => state.reinstallSkill);

  useEffect(() => {
    if (!skillId) {
      setDetail(null);
      setError(null);
      return;
    }

    const loadDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getSkillDetail(skillId);
        setDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
        setDetail(null);
      } finally {
        setLoading(false);
      }
    };

    loadDetail();
  }, [skillId, getSkillDetail]);

  if (!skillId) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 flex items-center justify-center">
        <p className="text-slate-400 text-center">选择一个技能查看详情</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 flex items-center justify-center">
        <p className="text-red-600 text-center">{error || '加载失败'}</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-slate-900">{detail.name}</h2>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  detail.source === 'user'
                    ? 'bg-brand-100 text-primary'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {detail.source === 'user' ? '用户级' : '项目级'}
              </span>
              {detail.syncedFromHost && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                  已同步
                </span>
              )}
              {detail.userInvocable && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                  可调用
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600">{detail.description}</p>
          </div>

          {detail.source === 'project' ? (
            <div className="flex items-center gap-2">
              <Lock size={16} className="text-slate-400" />
              <div
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  detail.enabled ? 'bg-primary' : 'bg-slate-300'
                } opacity-50`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    detail.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {detail.packageName && (
                <button
                  disabled={reinstalling || deleting}
                  onClick={async () => {
                    if (!confirm(`确认重新安装技能「${detail.name}」？`)) return;
                    setReinstalling(true);
                    try {
                      await reinstallSkill(detail.id);
                      // Reload detail after reinstall
                      const data = await getSkillDetail(detail.id);
                      setDetail(data);
                    } catch {
                      // error handled by store
                    } finally {
                      setReinstalling(false);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={16} className={reinstalling ? 'animate-spin' : ''} />
                  {reinstalling ? '重装中...' : '重新安装'}
                </button>
              )}
              <button
                disabled={deleting || reinstalling}
                onClick={async () => {
                  if (!confirm(`确认删除技能「${detail.name}」？`)) return;
                  setDeleting(true);
                  try {
                    await deleteSkill(detail.id);
                    onDeleted?.();
                  } catch {
                    // error is handled by the store
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <Trash2 size={16} />
                {deleting ? '删除中...' : '删除'}
              </button>
            </div>
          )}
        </div>

        {/* 元信息区域 */}
        <div className="space-y-2 text-sm">
          {detail.packageName && (
            <div className="flex items-center gap-1.5">
              <Package size={14} className="text-slate-400" />
              <span className="text-slate-500">来源：</span>
              <span className="text-slate-700 font-mono text-xs">{detail.packageName}</span>
            </div>
          )}
          {detail.installedAt && (
            <div>
              <span className="text-slate-500">安装时间：</span>
              <span className="text-slate-700 ml-1">
                {new Date(detail.installedAt).toLocaleString('zh-CN')}
              </span>
            </div>
          )}
          {detail.allowedTools && detail.allowedTools.length > 0 && (
            <div>
              <span className="text-slate-500">允许工具：</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {detail.allowedTools.map((tool: string) => (
                  <span
                    key={tool}
                    className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {detail.argumentHint && (
            <div>
              <span className="text-slate-500">参数提示：</span>
              <span className="text-slate-700 ml-2">{detail.argumentHint}</span>
            </div>
          )}
        </div>
      </div>

      {/* SKILL.md 内容 */}
      <div className="p-6 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">技能说明</h3>
        <div className="max-w-none">
          <MarkdownRenderer content={detail.content} variant="docs" />
        </div>
      </div>

      {/* 文件列表 */}
      {detail.files && detail.files.length > 0 && (
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">文件列表</h3>
          <div className="space-y-1">
            {detail.files.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-2 text-sm text-slate-600"
              >
                {file.type === 'directory' ? (
                  <Folder size={16} className="text-slate-400" />
                ) : (
                  <File size={16} className="text-slate-400" />
                )}
                <span>{file.name}</span>
                {file.type === 'file' && (
                  <span className="text-xs text-slate-400">({file.size} B)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部操作区 */}
      <div className="p-6 bg-slate-50">
        <p className="text-sm text-slate-500">
          {detail.source === 'user'
            ? detail.syncedFromHost
              ? '从宿主机同步，可启停和删除。重新同步时会恢复'
              : detail.packageName
                ? `通过 ${detail.packageName} 安装，可重新安装以获取最新版本`
                : '用户级技能可启用/禁用或删除，也可在对话中让 AI 安装或卸载技能'
            : '项目级技能为只读，不可修改或删除'}
        </p>
      </div>
    </div>
  );
}
