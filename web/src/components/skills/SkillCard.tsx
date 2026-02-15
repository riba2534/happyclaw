import { Lock } from 'lucide-react';
import type { Skill } from '../../stores/skills';

interface SkillCardProps {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}

export function SkillCard({ skill, selected, onSelect }: SkillCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-all ${
        selected
          ? 'ring-2 ring-ring bg-brand-50 border-primary'
          : 'border-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-slate-900 truncate">{skill.name}</h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${
                skill.source === 'user'
                  ? 'bg-brand-100 text-primary'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {skill.source === 'user' ? '用户级' : '项目级'}
            </span>
            {skill.userInvocable && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                可调用
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 line-clamp-2">{skill.description}</p>
        </div>

        <div className="flex items-center gap-2">
          <Lock size={16} className="text-slate-400" />
          <button
            disabled
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              skill.enabled ? 'bg-primary' : 'bg-slate-300'
            } opacity-50 cursor-not-allowed`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                skill.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>
    </button>
  );
}
