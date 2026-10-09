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
    iconClass: 'text-primary animate-spin motion-reduce:animate-none',
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
      className: 'text-primary animate-spin motion-reduce:animate-none',
    };
  return {
    label: '等待',
    icon: CircleDashed,
    className: 'text-muted-foreground',
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
      <Icon className={`h-4 w-4 shrink-0 ${meta.className}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {agent.label}
      </span>
      <span className="text-xs text-muted-foreground">{meta.label}</span>
      {tokens && (
        <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
          {tokens}
        </span>
      )}
      {elapsed && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {elapsed}
        </span>
      )}
      {hasDetails && (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open/agent:rotate-180 motion-reduce:transition-none" />
      )}
    </>
  );

  if (!hasDetails) {
    return (
      <div className="flex min-h-11 items-center gap-2 border-t border-border/60 px-3 py-2 text-sm first:border-t-0">
        {row}
      </div>
    );
  }

  return (
    <details className="group/agent border-t border-border/60 first:border-t-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60">
        {row}
      </summary>
      <div className="space-y-2 border-t border-border/50 bg-muted/15 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
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
          <p className="break-words text-foreground/75">
            {agent.lastToolSummary}
          </p>
        )}
        {agent.promptPreview && (
          <div>
            <div className="mb-1 font-medium text-foreground/70">任务摘要</div>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">
              {agent.promptPreview}
            </p>
          </div>
        )}
        {agent.resultPreview && (
          <div>
            <div className="mb-1 font-medium text-foreground/70">结果摘要</div>
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
      className="mb-3 overflow-hidden rounded-xl border border-border/80 bg-background font-sans"
      aria-label={`动态工作流：${run.summary}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-150 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 motion-reduce:transition-none sm:px-4"
        aria-expanded={expanded}
      >
        <GitFork className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {run.summary}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
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
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground"
          aria-live="polite"
        >
          <StatusIcon className={`h-4 w-4 ${meta.iconClass}`} aria-hidden />
          {meta.label}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {expanded && (
        <div className="border-t border-border/70">
          {totalAgents > 0 && (
            <div className="px-3 pb-2 pt-3 sm:px-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
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
            <div>
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
                    <div className="flex items-center gap-2 border-t border-border/60 bg-muted/20 px-3 py-2 first:border-t-0 sm:px-4">
                      <PhaseIcon
                        className={`h-4 w-4 shrink-0 ${isDone ? 'text-success' : isActive ? 'animate-spin text-primary motion-reduce:animate-none' : 'text-muted-foreground'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 text-xs font-semibold text-foreground">
                        {phase.title}
                        {phase.detail && (
                          <span className="ml-2 font-normal text-muted-foreground">
                            {phase.detail}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {isDone ? '已完成' : isActive ? '执行中' : '等待'}
                      </span>
                    </div>
                    {phase.agents.length > 0 ? (
                      <div className="px-1 sm:px-2">
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
                      <div className="px-4 py-3 text-xs text-muted-foreground">
                        等待运行时 Agent 信息…
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              正在生成执行计划…
            </div>
          )}

          {hasTechnicalDetails && (
            <details className="group/execution border-t border-border/70">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 sm:px-4">
                <Wrench className="h-3.5 w-3.5" aria-hidden />
                执行信息
                <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform duration-200 group-open/execution:rotate-180 motion-reduce:transition-none" />
              </summary>
              <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground sm:px-4">
                {run.totalToolCalls !== undefined && run.totalToolCalls > 0 && (
                  <span>{run.totalToolCalls} 次工具调用</span>
                )}
                {run.workflowName && <span>工作流：{run.workflowName}</span>}
                {run.runId && <span>Run ID：{run.runId}</span>}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
