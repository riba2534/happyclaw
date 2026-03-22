import { useEffect, useState } from 'react';
import { Loader2, Plus, Puzzle, ToggleLeft, ToggleRight, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/common/EmptyState';
import { useWorkspaceConfigStore, type WorkspaceSkill } from '../../stores/workspace-config';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface WorkspaceSkillsPanelProps {
  groupJid: string;
  onClose?: () => void;
}

export function WorkspaceSkillsPanel({ groupJid, onClose: _onClose }: WorkspaceSkillsPanelProps) {
  const {
    skills,
    skillsLoading,
    skillsError,
    skillsInstalling,
    loadWorkspaceSkills,
    installWorkspaceSkill,
    toggleWorkspaceSkill,
    deleteWorkspaceSkill,
  } = useWorkspaceConfigStore();

  const [installPkg, setInstallPkg] = useState('');
  const [showInstall, setShowInstall] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    loadWorkspaceSkills(groupJid);
  }, [groupJid, loadWorkspaceSkills]);

  const handleInstall = async () => {
    if (!installPkg.trim()) return;
    try {
      await installWorkspaceSkill(groupJid, installPkg.trim());
      setInstallPkg('');
      setShowInstall(false);
    } catch {
      // error in store
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWorkspaceSkill(groupJid, deleteTarget);
    } catch {
      // error in store
    }
    setDeleteTarget(null);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <h3 className="text-sm font-medium text-foreground">工作区 Skills</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadWorkspaceSkills(groupJid)}
            disabled={skillsLoading}
            className="h-7 w-7 p-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${skillsLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowInstall(!showInstall)}
            className="h-7 w-7 p-0"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Install form */}
      {showInstall && (
        <div className="px-4 py-2 border-b border-border flex-shrink-0">
          <div className="flex gap-2">
            <Input
              value={installPkg}
              onChange={(e) => setInstallPkg(e.target.value)}
              placeholder="owner/repo 或 URL"
              className="h-8 text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
            />
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={skillsInstalling || !installPkg.trim()}
              className="h-8 px-3"
            >
              {skillsInstalling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                '安装'
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            安装 skills.sh 上的技能到当前工作区
          </p>
        </div>
      )}

      {/* Error */}
      {skillsError && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex-shrink-0">
          {skillsError}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {skillsLoading && skills.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : skills.length === 0 ? (
          <EmptyState
            icon={Puzzle}
            title="无工作区 Skills"
            description="当前工作区 .claude/skills/ 下没有自定义技能"
            action={
              <Button variant="outline" size="sm" onClick={() => setShowInstall(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                安装技能
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                onToggle={(enabled) => toggleWorkspaceSkill(groupJid, skill.id, enabled)}
                onDelete={() => setDeleteTarget(skill.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="删除技能"
        message={`确定要从工作区删除技能 "${deleteTarget}" 吗？此操作不可撤销。`}
        confirmText="删除"
        confirmVariant="danger"
      />
    </div>
  );
}

function SkillRow({
  skill,
  onToggle,
  onDelete,
}: {
  skill: WorkspaceSkill;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground truncate">
            {skill.name}
          </span>
          {!skill.enabled && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1 py-px rounded">
              已禁用
            </span>
          )}
        </div>
        {skill.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {skill.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onToggle(!skill.enabled)}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
          title={skill.enabled ? '禁用' : '启用'}
        >
          {skill.enabled ? (
            <ToggleRight className="w-4 h-4 text-emerald-500" />
          ) : (
            <ToggleLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
