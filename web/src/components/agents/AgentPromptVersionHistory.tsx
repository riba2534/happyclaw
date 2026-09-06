import { useEffect, useState } from 'react';
import { FlaskConical, History, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { AgentProfile, AgentProfilePromptVersion } from '@/types';
import {
  AGENT_PROMPT_SECTIONS,
  type AgentPromptParts,
} from '@/utils/agent-prompts';
import { AgentPromptEvalDialog } from './AgentPromptEvalDialog';

interface AgentPromptVersionHistoryProps {
  profileId: string;
  agentName?: string;
  currentVersion: number;
  currentPrompts: AgentPromptParts;
  loadVersions: (profileId: string) => Promise<AgentProfilePromptVersion[]>;
  restoreVersion: (profileId: string, version: number) => Promise<AgentProfile>;
  onRestored: (profile: AgentProfile) => void;
  confirmDiscardUnsavedChanges: () => boolean;
}

export function AgentPromptVersionHistory({
  profileId,
  agentName = '智能体',
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
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalCompareVersion, setEvalCompareVersion] = useState<number | null>(
    null,
  );

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
    if (!confirm(`恢复 v${version} 的四段提示词？系统会先保留当前版本。`))
      return;
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
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <History className="mt-0.5 size-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              提示词版本
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              保存和恢复都会留下版本，可按需触发典型任务效果评测与对比。
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => {
            setEvalCompareVersion(null);
            setEvalOpen(true);
          }}
        >
          <FlaskConical className="size-3.5 text-primary" />
          版本效果评测
        </Button>
      </div>
      <div className="divide-y divide-border">
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> 加载历史…
          </div>
        ) : versions.length === 0 ? (
          <p className="px-5 py-5 text-xs text-muted-foreground">
            暂无历史版本。
          </p>
        ) : (
          versions.slice(0, 12).map((item) => {
            const changedSections = AGENT_PROMPT_SECTIONS.filter(
              (section) =>
                item[section.field] !== currentPrompts[section.field],
            );
            return (
              <div key={item.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      v{item.version}
                      {item.version === currentVersion && (
                        <span className="text-[10px] font-normal text-primary">
                          当前
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {item.prompt_mode === 'append'
                        ? '保留并追加'
                        : '完全替换'}{' '}
                      · {new Date(item.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={item.version === currentVersion}
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
                      className="gap-1 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        setEvalCompareVersion(item.version);
                        setEvalOpen(true);
                      }}
                    >
                      <FlaskConical className="size-3.5" />
                      评测
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={
                        item.version === currentVersion || restoring !== null
                      }
                      onClick={() => void handleRestore(item.version)}
                    >
                      {restoring === item.version ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      恢复
                    </Button>
                  </div>
                </div>
                {comparing === item.version && (
                  <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3">
                    {changedSections.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        四段内容与当前版本一致。
                      </p>
                    ) : (
                      changedSections.map((section) => (
                        <div key={section.key}>
                          <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
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
      </div>

      <AgentPromptEvalDialog
        open={evalOpen}
        onOpenChange={setEvalOpen}
        profileId={profileId}
        agentName={agentName}
        currentVersion={currentVersion}
        compareVersion={evalCompareVersion}
      />
    </section>
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
      className={`min-w-0 rounded-md border p-2 ${tone === 'old' ? 'border-error/20 bg-error-bg/30' : 'border-success/20 bg-success-bg/30'}`}
    >
      <div className="mb-1 text-[10px] font-medium text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-foreground">
        {value || '（空）'}
      </pre>
    </div>
  );
}
