import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { api } from '@/api/client';
import { IconButton } from '@/components/common/IconButton';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  AgentCapabilityPreview,
  AgentProfileRuntimePolicy,
  AgentProfileWorkspace,
  EffectiveCapabilityEntry,
  RunContextSnapshot,
  RunContextStatus,
} from '@/types';
import { capabilitySourceLabel } from '@/utils/capability-sources';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';
import { AgentSection } from './AgentSection';

export function EffectiveCapabilitiesPreview({
  profileId,
  runtimePolicy,
  workspaces,
}: {
  profileId: string;
  runtimePolicy: AgentProfileRuntimePolicy;
  workspaces: AgentProfileWorkspace[];
}) {
  const [workspaceJid, setWorkspaceJid] = useState('none');
  const [preview, setPreview] = useState<AgentCapabilityPreview | null>(null);
  const [runContext, setRunContext] = useState<RunContextSnapshot | null>(null);
  const [runContextStatus, setRunContextStatus] =
    useState<RunContextStatus>('none');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const policyKey = useMemo(
    () => JSON.stringify(runtimePolicy),
    [runtimePolicy],
  );

  useEffect(() => {
    if (
      workspaceJid !== 'none' &&
      !workspaces.some((item) => item.jid === workspaceJid)
    ) {
      setWorkspaceJid('none');
    }
  }, [workspaceJid, workspaces]);

  const loadPreview = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{
        preview: AgentCapabilityPreview;
        run_context: RunContextSnapshot | null;
        run_context_status: RunContextStatus;
      }>(
        `/api/agent-profiles/${encodeURIComponent(profileId)}/effective-capabilities`,
        {
          runtime_policy: runtimePolicy,
          workspace_jid: workspaceJid === 'none' ? undefined : workspaceJid,
        },
      );
      if (sequence === requestSequence.current) {
        setPreview(result.preview);
        setRunContext(result.run_context);
        setRunContextStatus(result.run_context_status);
      }
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(
          cause instanceof Error ? cause.message : '无法计算最终生效能力',
        );
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [profileId, runtimePolicy, workspaceJid]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPreview(), 250);
    return () => window.clearTimeout(timer);
  }, [loadPreview, policyKey]);

  return (
    <AgentSection
      title="最终生效能力"
      description="按来源展示 HappyClaw、宿主机和工作区能力，并标出同名来源冲突。 系统内置能力始终生效，不进入用户选择器。"
      actions={
        <>
          <Select value={workspaceJid} onValueChange={setWorkspaceJid}>
            <SelectTrigger className="w-[180px]" aria-label="预览工作区">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不指定工作区</SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.jid} value={workspace.jid}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IconButton
            label="刷新最终生效能力"
            variant="outline"
            size="icon"
            onClick={() => void loadPreview()}
            disabled={loading}
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
          />
        </>
      }
    >
      <SettingsGroup>
        {loading && !preview ? (
          <div className="flex items-center gap-2 px-4 py-4 text-body text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在计算
          </div>
        ) : error ? (
          <div
            className="flex items-center gap-2 px-4 py-3 text-body text-error"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </div>
        ) : preview ? (
          <>
            <PreviewRow label="上下文">
              <Badge variant="neutral">
                {preview.context.source === 'host_claude'
                  ? '宿主机 ~/.claude'
                  : 'HappyClaw 管理'}
              </Badge>
              {preview.context.source === 'host_claude' && (
                <span className="text-caption text-muted-foreground">
                  提示词 {preview.context.claudeMd ? '已加载' : '缺失'} ·{' '}
                  {preview.context.rules} 项 Rules ·{' '}
                  {preview.context.nativeConfig.settingsFiles.length} 个配置文件
                  · {preview.context.nativeConfig.entries.length} 类原生能力 ·
                  宿主机 Skills 按独立策略加载
                </span>
              )}
            </PreviewRow>
            <CapabilityEntriesRow
              label="HappyClaw Skills"
              entries={preview.skills.entries.filter(
                (entry) =>
                  entry.source !== 'host' && entry.source !== 'workspace',
              )}
              emptyText="无生效项"
            />
            <CapabilityEntriesRow
              label="宿主机 Skills"
              entries={preview.skills.entries.filter(
                (entry) => entry.source === 'host',
              )}
              emptyText={
                preview.skills.host.mode === 'disabled'
                  ? '未启用'
                  : '当前无宿主机来源胜出项'
              }
            />
            <CapabilityEntriesRow
              label="工作区 Skills"
              entries={preview.skills.entries.filter(
                (entry) => entry.source === 'workspace',
              )}
              emptyText={
                workspaceJid === 'none'
                  ? '选择工作区后预览'
                  : '该工作区没有生效的 Skill'
              }
            />
            {preview.skills.conflicts.length > 0 && (
              <PreviewRow label="Skill 覆盖">
                <span className="text-caption text-warning">
                  {preview.skills.conflicts.length} 个同名覆盖：
                  {preview.skills.conflicts.join('、')}
                </span>
              </PreviewRow>
            )}
            <CapabilityEntriesRow
              label="MCP"
              entries={preview.mcp.entries}
              conflicts={preview.mcp.conflicts}
            />
            <RunContextRow
              snapshot={runContext}
              status={runContextStatus}
              workspaceSelected={workspaceJid !== 'none'}
            />
            {preview.notes.length > 0 && (
              <div className="space-y-1 px-4 py-3">
                {preview.notes.map((note) => (
                  <p
                    key={note}
                    className="text-caption leading-5 text-muted-foreground"
                  >
                    {note}
                  </p>
                ))}
              </div>
            )}
          </>
        ) : null}
      </SettingsGroup>
    </AgentSection>
  );
}

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(
    value,
  );
}

function RunContextRow({
  snapshot,
  status,
  workspaceSelected,
}: {
  snapshot: RunContextSnapshot | null;
  status: RunContextStatus;
  workspaceSelected: boolean;
}) {
  if (!snapshot) {
    return (
      <PreviewRow label="最近真实运行">
        <span className="text-caption leading-5 text-muted-foreground">
          {workspaceSelected
            ? '这个工作区还没有可用的运行快照；发送一条消息后刷新即可查看。'
            : '选择一个工作区后，可查看真实请求实际加载的提示词、Skill 和上下文总预算。'}
        </span>
      </PreviewRow>
    );
  }

  const usage = snapshot.sdkContext;
  const isStale = status === 'stale_profile' || status === 'stale_config';
  const budgetLabel =
    snapshot.budget?.status === 'hard_exceeded'
      ? '超过硬限制'
      : snapshot.budget?.status === 'warning'
        ? '接近预算'
        : snapshot.budget?.status === 'ok'
          ? '预算正常'
          : '预算未知';

  return (
    <PreviewRow label="最近真实运行">
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {isStale && (
            <Badge variant="error">
              {status === 'stale_profile'
                ? '来自旧智能体配置'
                : '来自旧能力配置'}
            </Badge>
          )}
          <Badge
            variant={
              snapshot.budget?.status === 'hard_exceeded' ? 'error' : 'neutral'
            }
          >
            {budgetLabel}
          </Badge>
          <span className="text-caption text-muted-foreground">
            {usage
              ? `总上下文 ${compactNumber(usage.totalTokens)} / ${compactNumber(usage.maxTokens)} tokens（${usage.percentage.toFixed(1)}%）`
              : 'SDK 未返回总上下文用量'}
          </span>
          {usage && (
            <span className="text-caption text-muted-foreground">
              MCP {usage.mcpTools.length} 个 ·{' '}
              {compactNumber(
                usage.mcpTools.reduce((sum, tool) => sum + tool.tokens, 0),
              )}{' '}
              tokens
            </span>
          )}
          {snapshot.budget?.startupTokens !== undefined && (
            <span className="text-caption text-muted-foreground">
              静态启动 {compactNumber(snapshot.budget.startupTokens)} /{' '}
              {compactNumber(snapshot.budget.hardThreshold)} tokens
            </span>
          )}
          <span className="text-caption text-muted-foreground">
            {new Date(snapshot.capturedAt).toLocaleString('zh-CN')}
          </span>
        </div>

        <dl className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-caption text-muted-foreground">平台提示词</dt>
            <dd className="mt-0.5 text-label text-foreground">
              {compactNumber(snapshot.prompt.estimatedTokens)} tokens ·{' '}
              {snapshot.prompt.blocks.length} 个区块
            </dd>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-caption text-muted-foreground">Skills</dt>
            <dd className="mt-0.5 text-label text-foreground">
              {compactNumber(snapshot.skills.included)} /{' '}
              {compactNumber(snapshot.skills.total)} 已加载 ·{' '}
              {compactNumber(snapshot.skills.tokens)} tokens
            </dd>
            {snapshot.skills.manifestHash && (
              <div className="mt-0.5 text-micro text-muted-foreground">
                Manifest {snapshot.skills.manifestHash.slice(0, 10)} ·{' '}
                {snapshot.skills.selectedSkillIds.length} IDs
              </div>
            )}
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-caption text-muted-foreground">Rules</dt>
            <dd className="mt-0.5 text-label text-foreground">
              {compactNumber(snapshot.rules.loaded)} /{' '}
              {compactNumber(snapshot.rules.discovered)} 已加载
            </dd>
          </div>
        </dl>

        {snapshot.prompt.blocks.length > 0 && (
          <div>
            <div className="text-caption font-medium text-muted-foreground">
              Prompt Plan
              {snapshot.prompt.planHash
                ? ` · ${snapshot.prompt.planHash.slice(0, 10)}`
                : ''}
            </div>
            <div className="mt-1 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
              {snapshot.prompt.blocks.map((block) => (
                <Badge
                  key={`${block.id}-${block.hash ?? block.version ?? 0}`}
                  variant="outline"
                  title={
                    [block.condition, block.hash ? `hash ${block.hash}` : null]
                      .filter(Boolean)
                      .join(' · ') || undefined
                  }
                >
                  {block.id} · {block.owner ?? 'unknown'} ·{' '}
                  {compactNumber(block.estimatedTokens)} tokens
                </Badge>
              ))}
            </div>
          </div>
        )}

        {snapshot.subagentContract?.enabled && (
          <p className="text-caption leading-5 text-muted-foreground">
            Subagent 运行契约已启用 ·{' '}
            {snapshot.subagentContract.hash.slice(0, 10)} · SDK{' '}
            {snapshot.subagentContract.sdkCompatibility}
          </p>
        )}
        {snapshot.mcp.manifestHash && (
          <p className="text-caption leading-5 text-muted-foreground">
            MCP Manifest · {snapshot.mcp.manifestHash.slice(0, 10)} ·{' '}
            {snapshot.mcp.serverIds.length} servers
          </p>
        )}
        {snapshot.warnings.length > 0 && (
          <p className="text-caption leading-5 text-warning">
            {snapshot.warnings.join('；')}
          </p>
        )}
      </div>
    </PreviewRow>
  );
}

function PreviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[120px_1fr] sm:items-start">
      <div className="text-caption font-medium text-muted-foreground">
        {label}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function CapabilityEntriesRow({
  label,
  entries,
  conflicts = [],
  emptyText = '无',
}: {
  label: string;
  entries: EffectiveCapabilityEntry[];
  conflicts?: string[];
  emptyText?: string;
}) {
  return (
    <PreviewRow label={label}>
      {entries.length === 0 ? (
        <span className="text-caption text-muted-foreground">{emptyText}</span>
      ) : (
        <div className="flex max-h-28 min-w-0 flex-wrap gap-1.5 overflow-y-auto">
          {entries.map((entry) => (
            <Badge
              key={entry.id}
              variant="outline"
              className={!entry.available ? 'opacity-50 line-through' : ''}
              title={
                entry.overrides.length > 0
                  ? `覆盖：${entry.overrides.map(capabilitySourceLabel).join('、')}`
                  : undefined
              }
            >
              {entry.id} · {capabilitySourceLabel(entry.source)}
            </Badge>
          ))}
        </div>
      )}
      {conflicts.length > 0 && (
        <span className="basis-full text-caption text-warning">
          {conflicts.length} 个同名覆盖：{conflicts.join('、')}
        </span>
      )}
    </PreviewRow>
  );
}
