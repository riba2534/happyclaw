import { Lock } from 'lucide-react';
import type { Skill } from '../../stores/skills';
import { useSkillsStore } from '../../stores/skills';

interface SkillCardProps {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}

const SOURCE_LABELS: Record<Skill['source'], string> = {
  user: '用户级',
  project: '项目级',
};

export function SkillCard({ skill, selected, onSelect }: SkillCardProps) {
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const isReadonly = skill.source === 'project';

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
              {SOURCE_LABELS[skill.source]}
            </span>
            {skill.syncedFromHost && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                已同步
              </span>
            )}
            {skill.userInvocable && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                可调用
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 line-clamp-2">{skill.description}</p>
          {skill.packageName && (
            <p className="text-xs text-slate-400 mt-1 font-mono truncate">{skill.packageName}</p>
          )}
        </div>

        {isReadonly && (
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-slate-400" />
            <div
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                skill.enabled ? 'bg-primary' : 'bg-slate-300'
              } opacity-50`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  skill.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </div>
          </div>
        )}

        {skill.source === 'user' && (
          <div
            className="flex items-center"
            onClick={(e) => {
              e.stopPropagation();
              toggleSkill(skill.id, !skill.enabled);
            }}
          >
            <div
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                skill.enabled ? 'bg-primary' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  skill.enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </div>
          </div>
        )}
      </div>
    </button>
  );
}
