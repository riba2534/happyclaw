import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  capabilityRowButtonClass,
  capabilityRowClass,
} from '@/components/capabilities/capability-ui';
import type { Skill } from '../../stores/skills';
import { useSkillsStore } from '../../stores/skills';
import { isReadonlySkill, skillConflictLabel } from '../../utils/skill-sources';

interface SkillCardProps {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}

export function SkillCard({ skill, selected, onSelect }: SkillCardProps) {
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const isReadonly = isReadonlySkill(skill);
  const conflictLabel = skillConflictLabel(skill);
  const managedBy = `由${skill.source === 'external' ? '宿主机' : '系统'}管理`;

  return (
    <div
      role="listitem"
      data-selected={selected || undefined}
      className={capabilityRowClass(selected)}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={capabilityRowButtonClass}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-foreground">
              {skill.name}
            </span>
            {skill.userInvocable && <Badge variant="neutral">可调用</Badge>}
            {conflictLabel && (
              <Badge variant={skill.effective ? 'success' : 'warning'}>
                {conflictLabel}
              </Badge>
            )}
          </span>
          {skill.description && (
            <span className="mt-0.5 line-clamp-1 text-caption text-muted-foreground">
              {skill.description}
            </span>
          )}
          {skill.packageName && (
            <span className="mt-0.5 block truncate font-mono text-micro text-faint-foreground">
              {skill.packageName}
            </span>
          )}
        </span>
      </button>

      {isReadonly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="grid size-7 shrink-0 place-items-center text-faint-foreground">
              <Lock className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{managedBy}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{managedBy}</TooltipContent>
        </Tooltip>
      )}

      {skill.source === 'user' && (
        <Switch
          checked={skill.enabled}
          onCheckedChange={(checked) => void toggleSkill(skill.id, checked)}
          aria-label={`${checkedLabel(skill.enabled)}技能 ${skill.name}`}
        />
      )}
    </div>
  );
}

function checkedLabel(enabled: boolean): string {
  return enabled ? '停用' : '启用';
}
