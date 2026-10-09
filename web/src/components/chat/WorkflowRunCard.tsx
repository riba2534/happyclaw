import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  GitFork,
  Loader2,
  OctagonAlert,
  Wrench,
} from 'lucide-react';

import type {
  WorkflowAgentSnapshot,
  WorkflowRunSnapshot,
} from '../../stream-event.types';

function compactNumber(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString('zh-CN');
}

function duration(value: number | undefined): string | null {
  // Sub-second SDK samples round to a noisy "0.0 秒" while a workflow is
  // starting. Hide them until the elapsed time is meaningful to a person.
  if (value === undefined || !Number.isFinite(value) || value < 1000)
    return null;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function statusMeta(run: WorkflowRunSnapshot) {
  if (run.status === 'completed')
    return {
      label: '已完成',
      icon: CheckCircle2,
      iconClass: 'text-success',
    };
  if (run.status === 'failed' || run.status === 'stopped')
    return {
      label: run.status === 'failed' ? '执行失败' : '已停止',
      icon: OctagonAlert,
      iconClass: 'text-error',
    };
  return {
    label: '执行中',
    icon: Loader2,
    iconClass: 'text-muted-foreground animate-spin motion-reduce:animate-none',
  };
}

function agentStatus(agent: WorkflowAgentSnapshot) {
  if (agent.state === 'done')
    return {
      label: '完成',
      icon: CheckCircle2,
      className: 'text-success',
    };
  if (agent.state === 'failed' || agent.state === 'stopped')
    return {
      label: agent.state === 'failed' ? '失败' : '停止',
      icon: OctagonAlert,
      className: 'text-error',
    };
  if (agent.state === 'running')
    return {
      label: '执行中',
      icon: Loader2,
      className:
        'text-muted-foreground animate-spin motion-reduce:animate-none',
    };
  return {
    label: '等待',
    icon: CircleDashed,
    className: 'text-faint-foreground',
  };
}

function AgentRow({ agent }: { agent: WorkflowAgentSnapshot }) {
  const meta = agentStatus(agent);
  const Icon = meta.icon;
  const hasDetails = Boolean(
    agent.promptPreview ||
    agent.resultPreview ||
    agent.lastToolSummary ||
    agent.model,
  );
  const tokens = compactNumber(agent.tokens);
  const elapsed = duration(agent.durationMs);
  const row = (
    <>
      <Icon className={`size-4 shrink-0 ${meta.className}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {agent.label}
      </span>
      <span className="text-caption text-muted-foreground">{meta.label}</span>
      {tokens && (
        <span className="hidden text-caption tabular-nums text-faint-foreground sm:inline">
          {tokens}
        </span>
      )}
      {elapsed && (
        <span className="text-caption tabular-nums text-faint-foreground">
          {elapsed}
        </span>
      )}
      {hasDetails && (
        <ChevronDown className="size-3.5 shrink-0 text-faint-foreground transition-transform duration-200 group-open/agent:rotate-180 motion-reduce:transition-none" />
      )}
    </>
  );

  if (!hasDetails) {
    return (
      <div className="flex min-h-8 items-center gap-2 py-1.5 pr-3 pl-9 text-body pointer-coarse:min-h-11 sm:pr-4 sm:pl-10">
        {row}
      </div>
    );
  }

  return (
    <details className="group/agent">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 pr-3 pl-9 text-body transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none pointer-coarse:min-h-11 sm:pr-4 sm:pl-10 [&::-webkit-details-marker]:hidden">
        {row}
      </summary>
      <div className="space-y-2 pt-0.5 pr-3 pb-2.5 pl-15 text-caption leading-5 text-muted-foreground sm:pr-4 sm:pl-16">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {agent.model && <span>模型：{agent.model}</span>}
          {agent.attempt && <span>尝试：{agent.attempt}</span>}
          {agent.toolCalls !== undefined && agent.toolCalls > 0 && (
            <span>工具调用：{agent.toolCalls}</span>
          )}
          {tokens && (
            <span>Token：{agent.tokens?.toLocaleString('zh-CN')}</span>
          )}
        </div>
        {agent.lastToolSummary && (
          <p className="break-words text-foreground">{agent.lastToolSummary}</p>
        )}
        {agent.promptPreview && (
          <div>
            <div className="mb-0.5 font-medium text-foreground">任务摘要</div>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">
              {agent.promptPreview}
            </p>
          </div>
        )}
        {agent.resultPreview && (
          <div>
            <div className="mb-0.5 font-medium text-foreground">结果摘要</div>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
              {agent.resultPreview}
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

export function WorkflowRunCard({ run }: { run: WorkflowRunSnapshot }) {
  const [expanded, setExpanded] = useState(run.status === 'running');
  const previousStatus = useRef(run.status);
  useEffect(() => {
    if (previousStatus.current === 'running' && run.status !== 'running') {
      setExpanded(false);
    }
    previousStatus.current = run.status;
  }, [run.status]);

  const meta = statusMeta(run);
  const StatusIcon = meta.icon;
  const grouped = useMemo(() => {
    const known: Array<{
      index: number;
      title: string;
      detail?: string;
      agents: WorkflowAgentSnapshot[];
    }> = run.phases.map((phase) => ({
      ...phase,
      agents: run.agents.filter(
        (agent) =>
          agent.phaseIndex === phase.index || agent.phaseTitle === phase.title,
      ),
    }));
    const assigned = new Set(known.flatMap((phase) => phase.agents));
    const unassigned = run.agents.filter((agent) => !assigned.has(agent));
    if (known.length === 0 && unassigned.length > 0) {
      return [{ index: 1, title: '执行', agents: unassigned }];
    }
    if (unassigned.length > 0) {
      known.push({
        index: known.length + 1,
        title: '其他任务',
        agents: unassigned,
      });
    }
    return known;
  }, [run.agents, run.phases]);

  const tokens = compactNumber(run.totalTokens);
  const elapsed = duration(run.durationMs);
  const completedAgents = run.agents.filter(
    (agent) => agent.state === 'done',
  ).length;
  const totalAgents = Math.max(run.agentCount ?? 0, run.agents.length);
  const progress =
    totalAgents > 0
      ? Math.min(100, Math.round((completedAgents / totalAgents) * 100))
      : 0;
  const activePhaseIndex = grouped.findIndex(
    (phase) =>
      phase.agents.length === 0 ||
      phase.agents.some((agent) => agent.state !== 'done'),
  );
  const currentPhase =
    run.status === 'completed'
      ? grouped.length
      : activePhaseIndex >= 0
        ? activePhaseIndex + 1
        : grouped.length || undefined;
  const hasTechnicalDetails = Boolean(
    run.runId ||
    run.workflowName ||
    (run.totalToolCalls !== undefined && run.totalToolCalls > 0),
  );

  return (
    <section
      className="mb-3 overflow-hidden rounded-xl bg-surface-raised font-sans ring-1 ring-surface-border"
      aria-label={`动态工作流：${run.summary}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none sm:px-4"
        aria-expanded={expanded}
      >
        <GitFork
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title-sm text-foreground">
            {run.summary}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground tabular-nums">
            {grouped.length > 0 && currentPhase !== undefined && (
              <span>
                阶段 {currentPhase}/{grouped.length}
              </span>
            )}
            {totalAgents > 0 && (
              <span>
                已完成 {completedAgents}/{totalAgents} 个 Agent
              </span>
            )}
            {tokens && <span>{tokens} tokens</span>}
            {elapsed && <span>{elapsed}</span>}
          </span>
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground"
          aria-live="polite"
        >
          <StatusIcon className={`size-4 ${meta.iconClass}`} aria-hidden />
          {meta.label}
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-faint-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="border-t border-surface-border">
          {totalAgents > 0 && (
            <div className="px-3 pt-3 pb-1 sm:px-4">
              <div className="h-1 overflow-hidden rounded-full bg-surface-selected">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${run.status === 'running' ? 'bg-primary' : 'bg-faint-foreground'}`}
                  style={{ width: `${progress}%` }}
                  role="progressbar"
                  aria-label="工作流完成进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                />
              </div>
            </div>
          )}

          {grouped.length > 0 ? (
            <div className="pb-1">
              {grouped.map((phase, index) => {
                const isDone =
                  phase.agents.length > 0 &&
                  phase.agents.every((agent) => agent.state === 'done');
                const isActive =
                  run.status === 'running' && index === activePhaseIndex;
                const PhaseIcon = isDone
                  ? CheckCircle2
                  : isActive
                    ? Loader2
                    : CircleDashed;
                return (
                  <div key={`${phase.index}-${phase.title}`}>
                    <div className="flex min-h-8 items-center gap-2 px-3 py-1.5 sm:px-4">
                      <PhaseIcon
                        className={`size-4 shrink-0 ${isDone ? 'text-success' : isActive ? 'animate-spin text-muted-foreground motion-reduce:animate-none' : 'text-faint-foreground'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 text-label text-foreground">
                        {phase.title}
                        {phase.detail && (
                          <span className="ml-2 font-normal text-muted-foreground">
                            {phase.detail}
                          </span>
                        )}
                      </span>
                      <span className="text-caption text-muted-foreground">
                        {isDone ? '已完成' : isActive ? '执行中' : '等待'}
                      </span>
                    </div>
                    {phase.agents.length > 0 ? (
                      <div>
                        {phase.agents.map((agent) => (
                          <AgentRow
                            key={
                              agent.agentId ?? `${agent.index}-${agent.label}`
                            }
                            agent={agent}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="pr-3 pb-1.5 pl-9 text-caption text-faint-foreground sm:pr-4 sm:pl-10">
                        等待运行时 Agent 信息…
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-2.5 text-body text-muted-foreground sm:px-4">
              正在生成执行计划…
            </div>
          )}

          {hasTechnicalDetails && (
            <details className="group/execution border-t border-surface-border">
              <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none pointer-coarse:min-h-11 sm:px-4 [&::-webkit-details-marker]:hidden">
                <Wrench
                  className="size-3.5 text-faint-foreground"
                  aria-hidden
                />
                执行信息
                <ChevronDown className="ml-auto size-3.5 text-faint-foreground transition-transform duration-200 group-open/execution:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-0.5 pb-2.5 pl-8.5 text-caption text-muted-foreground tabular-nums sm:px-4 sm:pl-9.5">
                {run.totalToolCalls !== undefined && run.totalToolCalls > 0 && (
                  <span>{run.totalToolCalls} 次工具调用</span>
                )}
                {run.workflowName && <span>工作流：{run.workflowName}</span>}
                {run.runId && (
                  <span>
                    Run ID：<span className="font-mono">{run.runId}</span>
                  </span>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
