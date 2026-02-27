import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Puzzle, Download } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { useSkillsStore } from '../stores/skills';
import { useAuthStore } from '../stores/auth';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';
import { InstallSkillDialog } from '../components/skills/InstallSkillDialog';

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    installing,
    syncing,
    loadSkills,
    installSkill,
    syncHostSkills,
  } = useSkillsStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  const manualUserSkills = filtered.filter((s) => s.source === 'user' && !s.syncedFromHost);
  const syncedUserSkills = filtered.filter((s) => s.source === 'user' && s.syncedFromHost);
  const projectSkills = filtered.filter((s) => s.source === 'project');

  const enabledCount = skills.filter((s) => s.enabled).length;

  const handleInstall = async (pkg: string) => {
    await installSkill(pkg);
  };

  const handleSync = async () => {
    setSyncMessage(null);
    try {
      const result = await syncHostSkills();
      const { added, updated, deleted, skipped } = result.stats;
      setSyncMessage(
        `同步完成：新增 ${added}，更新 ${updated}，删除 ${deleted}，跳过 ${skipped}（共 ${result.total} 个宿主机技能）`
      );
      setTimeout(() => setSyncMessage(null), 5000);
    } catch {
      // error handled by store
    }
  };

  return (
    <div className="min-h-full bg-slate-50">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-6 py-4">
          <PageHeader
            title="技能管理"
            subtitle={`用户级 ${manualUserSkills.length + syncedUserSkills.length}${syncedUserSkills.length > 0 ? `（含同步 ${syncedUserSkills.length}）` : ''} · 项目级 ${projectSkills.length} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                {isAdmin && (
                  <Button variant="outline" onClick={handleSync} disabled={syncing}>
                    <Download size={18} className={syncing ? 'animate-pulse' : ''} />
                    {syncing ? '同步中...' : '同步宿主机技能'}
                  </Button>
                )}
                <Button variant="outline" onClick={loadSkills} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  刷新
                </Button>
                <Button onClick={() => setShowInstallDialog(true)}>
                  <Plus size={18} />
                  安装技能
                </Button>
              </div>
            }
          />
        </div>

        {/* Sync message toast */}
        {syncMessage && (
          <div className="mx-6 mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {syncMessage}
          </div>
        )}

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* 左侧列表 */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索技能名称或描述"
              />
            </div>

            <div className="space-y-6">
              {loading && skills.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <div className="bg-white rounded-xl border border-red-200 p-6 text-center">
                  <p className="text-red-600">{error}</p>
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Puzzle}
                  title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
                />
              ) : (
                <>
                  {manualUserSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-slate-700 mb-3">
                        用户级技能 ({manualUserSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {manualUserSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {syncedUserSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-slate-700 mb-3">
                        宿主机同步 ({syncedUserSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {syncedUserSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {projectSkills.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-slate-700 mb-3">
                        项目级技能 ({projectSkills.length})
                      </h2>
                      <div className="space-y-2">
                        {projectSkills.map((skill) => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            selected={selectedId === skill.id}
                            onSelect={() => setSelectedId(skill.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情（桌面端） */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
        </div>

        {/* 移动端详情 */}
        {selectedId && (
          <div className="lg:hidden p-4">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
        )}
      </div>

      <InstallSkillDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        onInstall={handleInstall}
        installing={installing}
      />
    </div>
  );
}
