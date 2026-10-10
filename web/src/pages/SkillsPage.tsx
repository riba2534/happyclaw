import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Puzzle, Trash2 } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Callout,
  CapabilityListSection,
  CapabilityListSkeleton,
  CapabilityNotice,
  CapabilitySectionActions,
  CapabilityToolbar,
  StickyDetailPane,
} from '@/components/capabilities/capability-ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { confirmDialog } from '@/stores/confirm';
import { toast } from 'sonner';
import { useSkillsStore } from '../stores/skills';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';
import { InstallSkillDialog } from '../components/skills/InstallSkillDialog';

type SourceFilter = 'all' | 'user' | 'project' | 'external';

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'user', label: '我的' },
  { value: 'project', label: 'HappyClaw 内置' },
  { value: 'external', label: '宿主机' },
];

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    installing,
    loadSkills,
    installSkill,
    importSkillFromGit,
    importSkillArchive,
    deleteAllUserSkills,
  } = useSkillsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        (sourceFilter === 'all' || s.source === sourceFilter) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)),
    );
  }, [skills, searchQuery, sourceFilter]);

  const userSkills = filtered.filter((s) => s.source === 'user');
  const externalSkills = filtered.filter((s) => s.source === 'external');
  const projectSkills = filtered.filter((s) => s.source === 'project');

  const enabledCount = skills.filter((s) => s.enabled).length;
  const hasRows = !error && filtered.length > 0;

  const handleInstall = async (pkg: string) => {
    await installSkill(pkg);
  };

  const handleDeleteAll = async () => {
    const confirmed = await confirmDialog({
      title: '删除全部用户 Skills',
      message: '确定删除所有用户级技能？宿主机技能不受影响。',
      confirmText: '全部删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeletingAll(true);
    try {
      const n = await deleteAllUserSkills();
      setSelectedId(null);
      toast.success(`已删除 ${n} 个用户级技能`);
    } catch {
      /* handled by store */
    }
    setDeletingAll(false);
  };

  const renderRows = (items: typeof filtered) =>
    items.map((skill) => (
      <SkillCard
        key={skill.sourceKey}
        skill={skill}
        selected={selectedId === skill.sourceKey}
        onSelect={() => setSelectedId(skill.sourceKey)}
      />
    ));

  return (
    <div className="space-y-4">
      <CapabilitySectionActions>
        <IconButton
          label="刷新"
          icon={<RefreshCw className={loading ? 'animate-spin' : undefined} />}
          onClick={loadSkills}
          disabled={loading}
        />
        <Button size="sm" onClick={() => setShowInstallDialog(true)}>
          <Plus />
          <span className="max-sm:sr-only">安装技能</span>
        </Button>
      </CapabilitySectionActions>

      <CapabilityNotice>
        “我的 Skills”可安装和管理；HappyClaw 内置与宿主机 Skills
        只读。智能体可以独立选择不使用、使用部分或使用全部宿主机
        Skills，不必同时继承宿主机 Prompt 或 Rules。不同来源的同名项会并列显示。
      </CapabilityNotice>

      <CapabilityToolbar
        summary={`我的 ${skills.filter((item) => item.source === 'user').length} · HappyClaw 内置 ${skills.filter((item) => item.source === 'project').length} · 宿主机 ${skills.filter((item) => item.source === 'external').length} · 启用 ${enabledCount}`}
      >
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索技能名称或描述"
          className="w-full @lg:w-72"
        />
        <SegmentedControl
          label="Skill 来源筛选"
          value={sourceFilter}
          options={SOURCE_FILTERS}
          onChange={setSourceFilter}
        />
      </CapabilityToolbar>

      <div
        className={
          hasRows
            ? 'grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'
            : undefined
        }
      >
        <div className="min-w-0 space-y-6">
          {loading && skills.length === 0 ? (
            <CapabilityListSkeleton />
          ) : error ? (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Puzzle}
              title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
              className="border border-surface-border"
            />
          ) : (
            <>
              {userSkills.length > 0 && (
                <CapabilityListSection
                  title={`我的 Skills (${userSkills.length})`}
                  actions={
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground hover:text-error"
                      disabled={deletingAll}
                      onClick={() => void handleDeleteAll()}
                    >
                      <Trash2 />
                      {deletingAll ? '删除中...' : '删除全部用户 Skills'}
                    </Button>
                  }
                >
                  {renderRows(userSkills)}
                </CapabilityListSection>
              )}

              {externalSkills.length > 0 && (
                <CapabilityListSection
                  title={`宿主机 Skills (${externalSkills.length})`}
                >
                  {renderRows(externalSkills)}
                </CapabilityListSection>
              )}

              {projectSkills.length > 0 && (
                <CapabilityListSection
                  title={`HappyClaw 内置 (${projectSkills.length})`}
                >
                  {renderRows(projectSkills)}
                </CapabilityListSection>
              )}
            </>
          )}
        </div>

        {/* 右侧详情（桌面端） */}
        <div className={hasRows ? 'hidden min-w-0 lg:block' : 'hidden'}>
          <StickyDetailPane>
            {isDesktop && (
              <SkillDetail
                skillId={selectedId}
                onDeleted={() => setSelectedId(null)}
              />
            )}
          </StickyDetailPane>
        </div>
      </div>

      {/* 移动端详情 */}
      <Sheet
        open={!isDesktop && !!selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
      >
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-xl p-0 pt-8 *:data-[slot=detail-panel]:rounded-none *:data-[slot=detail-panel]:ring-0"
        >
          <SheetTitle className="sr-only">技能详情</SheetTitle>
          <SheetDescription className="sr-only">
            查看所选技能的说明、来源与文件
          </SheetDescription>
          {!isDesktop && (
            <SkillDetail
              skillId={selectedId}
              onDeleted={() => setSelectedId(null)}
            />
          )}
        </SheetContent>
      </Sheet>

      <InstallSkillDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        onInstall={handleInstall}
        onImportGit={importSkillFromGit}
        onImportArchive={importSkillArchive}
        installing={installing}
      />
    </div>
  );
}
