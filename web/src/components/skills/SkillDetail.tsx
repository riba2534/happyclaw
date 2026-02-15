import { useState, useEffect } from 'react';
import { File, Folder, Loader2, Lock } from 'lucide-react';
import { useSkillsStore, type SkillDetail as SkillDetailType } from '../../stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface SkillDetailProps {
  skillId: string | null;
}

export function SkillDetail({ skillId }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getSkillDetail = useSkillsStore((state) => state.getSkillDetail);

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
              {detail.userInvocable && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                  可调用
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600">{detail.description}</p>
          </div>

          <div className="flex items-center gap-2">
            <Lock size={16} className="text-slate-400" />
            <button
              disabled
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                detail.enabled ? 'bg-primary' : 'bg-slate-300'
              } opacity-50 cursor-not-allowed`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  detail.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        {/* 元信息区域 */}
        <div className="space-y-2 text-sm">
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
        <div className="prose prose-sm max-w-none">
          <MarkdownRenderer content={detail.content} />
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
            ? '宿主机技能为只读，如需修改请直接编辑 ~/.claude/skills/ 目录'
            : '项目级技能不可修改'}
        </p>
      </div>
    </div>
  );
}
