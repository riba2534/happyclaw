import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListGroup } from '@/components/common/ListRow';
import { confirmDialog } from '@/stores/confirm';
import { cn } from '@/lib/utils';
import type { AgentProfile, AgentProfilePromptVersion } from '@/types';
import {
  AGENT_PROMPT_SECTIONS,
  type AgentPromptParts,
} from '@/utils/agent-prompts';
import { AgentSection } from './AgentSection';

interface AgentPromptVersionHistoryProps {
  profileId: string;
  currentVersion: number;
  currentPrompts: AgentPromptParts;
  loadVersions: (profileId: string) => Promise<AgentProfilePromptVersion[]>;
  restoreVersion: (profileId: string, version: number) => Promise<AgentProfile>;
  onRestored: (profile: AgentProfile) => void;
  confirmDiscardUnsavedChanges: () => boolean;
}

export function AgentPromptVersionHistory({
  profileId,
  currentVersion,
  currentPrompts,
  loadVersions,
  restoreVersion,
  onRestored,
  confirmDiscardUnsavedChanges,
}: AgentPromptVersionHistoryProps) {
  const [versions, setVersions] = useState<AgentProfilePromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [comparing, setComparing] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadVersions(profileId)
      .then((items) => active && setVersions(items))
      .catch(() => active && toast.error('加载提示词历史失败'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [loadVersions, profileId]);

  const handleRestore = async (version: number) => {
    if (!confirmDiscardUnsavedChanges()) return;
    const confirmed = await confirmDialog({
      title: `恢复 v${version}`,
      message: `恢复 v${version} 的四段提示词？系统会先保留当前版本。`,
      confirmText: '恢复',
    });
    if (!confirmed) return;
    setRestoring(version);
    try {
      const profile = await restoreVersion(profileId, version);
      onRestored(profile);
      const items = await loadVersions(profileId);
      setVersions(items);
      toast.success(`已恢复 v${version}，并创建新的历史版本`);
    } catch {
      toast.error('恢复提示词版本失败');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <AgentSection
      title="提示词版本"
      description="保存和恢复都会留下版本，可以安全回退四段提示词与组合模式。"
    >
      <ListGroup>
        {loading ? (
          <div
            role="listitem"
            className="flex items-center gap-2 px-4 py-3 text-caption text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin" /> 加载历史…
          </div>
        ) : versions.length === 0 ? (
          <p
            role="listitem"
            className="px-4 py-3 text-caption text-muted-foreground"
          >
            暂无历史版本。
          </p>
        ) : (
          versions.slice(0, 12).map((item) => {
            const changedSections = AGENT_PROMPT_SECTIONS.filter(
              (section) =>
                item[section.field] !== currentPrompts[section.field],
            );
            const isCurrent = item.version === currentVersion;
            return (
              <div key={item.id} role="listitem" className="px-4 py-2.5">
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-body font-medium text-foreground tabular-nums">
                      v{item.version}
                    </span>
                    {isCurrent && <Badge variant="neutral">当前</Badge>}
                    <span className="text-caption text-muted-foreground">
                      {item.prompt_mode === 'append'
                        ? '保留并追加'
                        : '完全替换'}{' '}
                      · {new Date(item.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isCurrent}
                      onClick={() =>
                        setComparing(
                          comparing === item.version ? null : item.version,
                        )
                      }
                    >
                      {comparing === item.version
                        ? '收起对比'
                        : `对比当前${changedSections.length ? ` · ${changedSections.length} 段` : ''}`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isCurrent || restoring !== null}
                      onClick={() => void handleRestore(item.version)}
                    >
                      {restoring === item.version ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <RotateCcw />
                      )}
                      恢复
                    </Button>
                  </div>
                </div>
                {comparing === item.version && (
                  <div className="mt-2 mb-1 space-y-3 rounded-lg bg-muted/50 p-3">
                    {changedSections.length === 0 ? (
                      <p className="text-caption text-muted-foreground">
                        四段内容与当前版本一致。
                      </p>
                    ) : (
                      changedSections.map((section) => (
                        <div key={section.key}>
                          <div className="mb-1.5 text-caption font-medium text-muted-foreground">
                            {section.eyebrow} · {section.title}
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            <PromptSnapshot
                              label={`v${item.version}`}
                              value={item[section.field]}
                              tone="old"
                            />
                            <PromptSnapshot
                              label="当前"
                              value={currentPrompts[section.field]}
                              tone="new"
                            />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </ListGroup>
    </AgentSection>
  );
}

function PromptSnapshot({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'old' | 'new';
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-md p-2 ring-1',
        tone === 'old'
          ? 'bg-error/5 ring-error/20'
          : 'bg-success/5 ring-success/20',
      )}
    >
      <div className="mb-1 text-micro font-medium text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-40 overflow-auto text-caption leading-5 break-words whitespace-pre-wrap text-foreground">
        {value || '（空）'}
      </pre>
    </div>
  );
}
