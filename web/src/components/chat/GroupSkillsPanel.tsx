import { useEffect, useState, useCallback } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { useChatStore } from '../../stores/chat';

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
}

interface GroupSkillsPanelProps {
  groupJid: string;
  onClose?: () => void;
}

export function GroupSkillsPanel({ groupJid }: GroupSkillsPanelProps) {
  const group = useChatStore(s => s.groups[groupJid]);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null); // null = 全部选中
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // 加载可用 skills
  useEffect(() => {
    setLoading(true);
    api.get<{ skills: Skill[] }>('/api/skills')
      .then(data => {
        setAllSkills(data.skills);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // 从群组数据初始化选中状态
  useEffect(() => {
    if (!group) return;
    const ss = group.selected_skills;
    if (ss === null || ss === undefined) {
      setSelectedIds(null); // 全部选中
    } else {
      setSelectedIds(new Set(ss));
    }
    setDirty(false);
  }, [group?.selected_skills]);

  const allSelected = selectedIds === null;

  const isSelected = useCallback((id: string) => {
    return allSelected || selectedIds!.has(id);
  }, [allSelected, selectedIds]);

  const toggleSkill = (id: string) => {
    setDirty(true);
    if (allSelected) {
      // 从"全选"切换为显式选择：选中除当前项外的所有
      const newSet = new Set(allSkills.map(s => s.id));
      newSet.delete(id);
      setSelectedIds(newSet);
    } else {
      const newSet = new Set(selectedIds!);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      // 如果全部选中，切换回 null
      if (newSet.size === allSkills.length) {
        setSelectedIds(null);
      } else {
        setSelectedIds(newSet);
      }
    }
  };

  const selectAll = () => {
    if (!allSelected) {
      setSelectedIds(null);
      setDirty(true);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = allSelected ? null : Array.from(selectedIds!);
      await api.patch(`/api/groups/${encodeURIComponent(groupJid)}`, { selected_skills: payload });
      // 更新本地 store
      useChatStore.setState(s => {
        const g = s.groups[groupJid];
        if (!g) return s;
        return {
          ...s,
          groups: { ...s.groups, [groupJid]: { ...g, selected_skills: payload } },
        };
      });
      setDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {allSelected ? '全部启用' : `${selectedIds!.size}/${allSkills.length} 已选`}
          </span>
          {!allSelected && (
            <button
              onClick={selectAll}
              className="text-xs text-primary hover:underline cursor-pointer"
            >
              全选
            </button>
          )}
        </div>
        <Button
          size="sm"
          variant={saveSuccess ? 'outline' : 'default'}
          disabled={!dirty || saving}
          onClick={handleSave}
          className="h-7 text-xs"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
          {saveSuccess ? '已保存' : '保存'}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {allSkills.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            暂无可用 Skills
          </div>
        ) : (
          <div className="divide-y divide-border">
            {allSkills.map(skill => (
              <label
                key={skill.id}
                className="flex items-start gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={isSelected(skill.id)}
                  onChange={() => toggleSkill(skill.id)}
                  className="mt-0.5 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{skill.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                      {skill.source === 'user' ? '用户' : '项目'}
                    </span>
                  </div>
                  {skill.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border">
        <p className="text-[11px] text-muted-foreground">
          更改将在下次容器启动时生效
        </p>
      </div>
    </div>
  );
}
