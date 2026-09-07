import { useEffect, useState, useRef } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileDown,
  FlaskConical,
  Loader2,
  StopCircle,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type {
  EvalCompareSummary,
  EvalHumanFeedback,
  EvalRun,
  EvalSuite,
} from '@/types';
import {
  cancelEvalRunApi,
  fetchEvalRuns,
  fetchEvalRunSummary,
  fetchEvalSuites,
  startEvalRunApi,
  submitCaseFeedbackApi,
} from '@/api/eval';

interface AgentPromptEvalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  agentName: string;
  currentVersion: number;
  compareVersion?: number | null;
}

export function AgentPromptEvalDialog({
  open,
  onOpenChange,
  profileId,
  agentName,
  currentVersion,
  compareVersion,
}: AgentPromptEvalDialogProps) {
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>('');
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [summary, setSummary] = useState<EvalCompareSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<Record<string, string>>({});
  const [savingFeedback, setSavingFeedback] = useState<Record<string, boolean>>(
    {},
  );

  const baseVer = compareVersion ?? Math.max(1, currentVersion - 1);
  const targetVer = currentVersion;

  // Polling ref for running evaluations
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      return;
    }

    let active = true;
    setLoading(true);

    void Promise.all([fetchEvalSuites(), fetchEvalRuns(profileId)])
      .then(([suiteList, runList]) => {
        if (!active) return;
        setSuites(suiteList);
        if (suiteList.length > 0) {
          setSelectedSuiteId(suiteList[0].id);
        }
        setRuns(runList);
        if (runList.length > 0) {
          setSelectedRunId(runList[0].id);
        }
      })
      .catch(() => {
        if (active) toast.error('加载评测数据失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [open, profileId]);

  // Load selected run details & summary
  useEffect(() => {
    if (!selectedRunId || !open) {
      setSummary(null);
      return;
    }

    let active = true;

    const loadSummary = async () => {
      try {
        const data = await fetchEvalRunSummary(selectedRunId);
        if (!active) return;
        setSummary(data);

        // Continue polling if still running
        if (data.run.status === 'running' || data.run.status === 'pending') {
          pollTimerRef.current = setTimeout(loadSummary, 1200);
        }
      } catch {
        if (active) toast.error('获取评测运行结果失败');
      }
    };

    void loadSummary();

    return () => {
      active = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [selectedRunId, open]);

  const handleStartRun = async () => {
    setStarting(true);
    try {
      const run = await startEvalRunApi({
        agent_profile_id: profileId,
        suite_id: selectedSuiteId || undefined,
        mode: 'compare',
        base_version: baseVer,
        target_version: targetVer,
      });
      toast.success('已启动提示词对比评测');
      setRuns((prev) => [run, ...prev]);
      setSelectedRunId(run.id);
    } catch (err: unknown) {
      toast.error((err as Error).message || '启动评测失败');
    } finally {
      setStarting(false);
    }
  };

  const handleCancelRun = async () => {
    if (!selectedRunId) return;
    setCancelling(true);
    try {
      await cancelEvalRunApi(selectedRunId);
      toast.info('已取消评测运行');
      const updated = await fetchEvalRunSummary(selectedRunId);
      setSummary(updated);
    } catch {
      toast.error('取消评测失败');
    } finally {
      setCancelling(false);
    }
  };

  const handleFeedback = async (
    caseRunId: string,
    caseId: string,
    feedback: EvalHumanFeedback,
  ) => {
    setSavingFeedback((prev) => ({ ...prev, [caseRunId]: true }));
    try {
      const notes = editingNotes[caseId];
      await submitCaseFeedbackApi(caseRunId, feedback, notes);
      toast.success('已更新人工反馈');
      if (selectedRunId) {
        const updated = await fetchEvalRunSummary(selectedRunId);
        setSummary(updated);
      }
    } catch {
      toast.error('保存人工反馈失败');
    } finally {
      setSavingFeedback((prev) => ({ ...prev, [caseRunId]: false }));
    }
  };

  const selectedSuite = suites.find((s) => s.id === selectedSuiteId);
  const isRunning =
    summary?.run.status === 'running' || summary?.run.status === 'pending';
  const progressPercent = summary
    ? Math.round((summary.run.completed_cases / summary.run.total_cases) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                <FlaskConical className="size-5 text-primary" />
                提示词版本对比评测 · {agentName}
              </DialogTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                使用脱敏真实典型工程任务对比新旧提示词执行效果、质量通过率、耗时与成本。
              </p>
            </div>
            {summary && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() =>
                    window.open(`/api/eval/runs/${summary.run.id}/report.md`)
                  }
                >
                  <Download className="size-3.5" />
                  下载 Markdown 报告
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() =>
                    window.open(`/api/eval/runs/${summary.run.id}/report.json`)
                  }
                >
                  <FileDown className="size-3.5" />
                  JSON
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="max-h-[calc(90vh-140px)] overflow-y-auto px-6 py-4 space-y-6">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="size-3.5 animate-spin" /> 正在加载评测数据…
            </div>
          )}

          {/* Action & Config Bar */}
          <div className="rounded-lg border border-border bg-card/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div>
                  <span className="text-muted-foreground">对比版本: </span>
                  <span className="font-semibold text-foreground">
                    v{baseVer}（基准） vs v{targetVer}（目标）
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">评测集: </span>
                  <select
                    className="rounded border border-border bg-background px-2 py-1 text-xs font-medium"
                    value={selectedSuiteId}
                    onChange={(e) => setSelectedSuiteId(e.target.value)}
                    disabled={isRunning || starting}
                  >
                    {suites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.case_count} 案例)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={cancelling}
                    onClick={handleCancelRun}
                    className="gap-1.5"
                  >
                    {cancelling ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <StopCircle className="size-3.5" />
                    )}
                    取消评测
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={starting}
                    onClick={handleStartRun}
                    className="gap-1.5"
                  >
                    {starting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <FlaskConical className="size-3.5" />
                    )}
                    开始对比评测
                  </Button>
                )}
              </div>
            </div>

            {selectedSuite && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {selectedSuite.description}
              </p>
            )}
          </div>

          {/* Running progress bar */}
          {isRunning && summary && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium text-primary">
                  <Loader2 className="size-3.5 animate-spin" />
                  评测运行中… 已完成 {summary.run.completed_cases} /{' '}
                  {summary.run.total_cases} 个案例
                </span>
                <span className="font-semibold">{progressPercent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Core metrics comparison summary cards */}
          {summary && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    通过率 (Pass Rate)
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-lg font-bold text-foreground">
                      {summary.targetSummary?.passRate}%
                    </span>
                    {summary.baseSummary && (
                      <span className="text-xs text-muted-foreground">
                        (基准: {summary.baseSummary.passRate}%)
                      </span>
                    )}
                  </div>
                  {summary.delta && (
                    <div
                      className={`mt-1 text-[11px] font-medium ${
                        summary.delta.passRateDelta >= 0
                          ? 'text-success'
                          : 'text-error'
                      }`}
                    >
                      {summary.delta.passRateDelta >= 0 ? '+' : ''}
                      {summary.delta.passRateDelta}%
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    平均耗时 (Latency)
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-lg font-bold text-foreground">
                      {summary.targetSummary?.avgDurationMs}
                      <span className="text-xs font-normal"> ms</span>
                    </span>
                  </div>
                  {summary.delta && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      差异: {summary.delta.durationDeltaMs >= 0 ? '+' : ''}
                      {summary.delta.durationDeltaMs} ms
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    总 Token 消耗
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-lg font-bold text-foreground">
                      {summary.targetSummary?.totalTokens}
                    </span>
                  </div>
                  {summary.baseSummary && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      基准: {summary.baseSummary.totalTokens}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    估算成本 (USD)
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-lg font-bold text-foreground">
                      ${summary.targetSummary?.estimatedCostUsd}
                    </span>
                  </div>
                  {summary.delta && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      差异: {summary.delta.costDeltaUsd >= 0 ? '+' : ''}$
                      {summary.delta.costDeltaUsd}
                    </div>
                  )}
                </div>
              </div>

              {summary.delta && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge
                    variant="outline"
                    className="gap-1 border-success/30 text-success"
                  >
                    改善用例: {summary.delta.improvedCases.length}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="gap-1 border-error/30 text-error"
                  >
                    退步用例: {summary.delta.regressedCases.length}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="gap-1 border-border text-muted-foreground"
                  >
                    平稳用例: {summary.delta.unchangedCases.length}
                  </Badge>
                </div>
              )}
            </div>
          )}

          {/* Cases List */}
          {summary && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                典型任务案例评测明细 ({summary.cases.length})
              </h3>

              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {summary.cases.map((c) => {
                  const isExpanded = expandedCaseId === c.caseId;
                  const targetRes = c.targetResult;
                  const baseRes = c.baseResult;
                  const targetVerdict = targetRes?.auto_verdict;
                  const baseVerdict = baseRes?.auto_verdict;

                  return (
                    <div key={c.caseId} className="p-3.5 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2 text-left"
                          onClick={() =>
                            setExpandedCaseId(isExpanded ? null : c.caseId)
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-xs font-medium text-foreground">
                            {c.caseName}
                          </span>
                          <Badge variant="secondary" className="text-[10px]">
                            {c.category}
                          </Badge>
                        </button>

                        <div className="flex items-center gap-3 shrink-0 text-xs">
                          {baseRes && (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <span className="text-[11px]">
                                v{summary.run.base_version}:
                              </span>
                              {baseVerdict === 'pass' ? (
                                <CheckCircle2 className="size-3.5 text-success" />
                              ) : (
                                <XCircle className="size-3.5 text-error" />
                              )}
                            </div>
                          )}

                          {targetRes && (
                            <div className="flex items-center gap-1 font-medium">
                              <span className="text-[11px] text-primary">
                                v{summary.run.target_version}:
                              </span>
                              {targetVerdict === 'pass' ? (
                                <Badge className="gap-1 bg-success/20 text-success hover:bg-success/30 border-0">
                                  <CheckCircle2 className="size-3" />
                                  通过 ({targetRes.auto_score}分)
                                </Badge>
                              ) : (
                                <Badge className="gap-1 bg-error/20 text-error hover:bg-error/30 border-0">
                                  <XCircle className="size-3" />
                                  未通过 ({targetRes.auto_score}分)
                                </Badge>
                              )}
                            </div>
                          )}

                          {targetRes && (
                            <span className="text-[11px] text-muted-foreground">
                              {targetRes.duration_ms} ms
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Expanded case detail */}
                      {isExpanded && targetRes && (
                        <div className="mt-3 space-y-3 rounded-md border border-border/60 bg-muted/20 p-3 text-xs">
                          {targetRes.eval_details.reasons &&
                            targetRes.eval_details.reasons.length > 0 && (
                              <div>
                                <div className="font-semibold text-muted-foreground">
                                  判定依据 / 扣分点:
                                </div>
                                <ul className="mt-1 list-disc pl-4 space-y-0.5 text-muted-foreground">
                                  {targetRes.eval_details.reasons.map(
                                    (r, i) => (
                                      <li key={i}>{r}</li>
                                    ),
                                  )}
                                </ul>
                              </div>
                            )}

                          <div>
                            <div className="font-semibold text-muted-foreground">
                              模型生成输出 (v{summary.run.target_version}):
                            </div>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-card p-2 text-[11px] text-foreground border">
                              {targetRes.actual_output || '(无输出)'}
                            </pre>
                          </div>

                          {/* Human Feedback Controls */}
                          <div className="border-t border-border/40 pt-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-semibold text-muted-foreground">
                                人工审核与反馈:
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  size="sm"
                                  variant={
                                    targetRes.human_feedback === 'accepted'
                                      ? 'default'
                                      : 'outline'
                                  }
                                  className="h-7 gap-1 text-[11px]"
                                  disabled={savingFeedback[targetRes.id]}
                                  onClick={() =>
                                    handleFeedback(
                                      targetRes.id,
                                      c.caseId,
                                      'accepted',
                                    )
                                  }
                                >
                                  <ThumbsUp className="size-3" /> 采纳
                                </Button>
                                <Button
                                  size="sm"
                                  variant={
                                    targetRes.human_feedback === 'rejected'
                                      ? 'destructive'
                                      : 'outline'
                                  }
                                  className="h-7 gap-1 text-[11px]"
                                  disabled={savingFeedback[targetRes.id]}
                                  onClick={() =>
                                    handleFeedback(
                                      targetRes.id,
                                      c.caseId,
                                      'rejected',
                                    )
                                  }
                                >
                                  <ThumbsDown className="size-3" /> 拒绝
                                </Button>
                                <Button
                                  size="sm"
                                  variant={
                                    targetRes.human_feedback === 'unresolved'
                                      ? 'secondary'
                                      : 'outline'
                                  }
                                  className="h-7 gap-1 text-[11px]"
                                  disabled={savingFeedback[targetRes.id]}
                                  onClick={() =>
                                    handleFeedback(
                                      targetRes.id,
                                      c.caseId,
                                      'unresolved',
                                    )
                                  }
                                >
                                  <AlertCircle className="size-3" /> 缺陷
                                </Button>
                              </div>
                            </div>

                            <div className="mt-2 flex gap-2">
                              <input
                                type="text"
                                className="flex-1 rounded border border-border bg-background px-2.5 py-1 text-xs"
                                placeholder={
                                  targetRes.human_notes ||
                                  '添加人工批注或未解决反馈描述…'
                                }
                                value={editingNotes[c.caseId] ?? ''}
                                onChange={(e) =>
                                  setEditingNotes((prev) => ({
                                    ...prev,
                                    [c.caseId]: e.target.value,
                                  }))
                                }
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                disabled={
                                  savingFeedback[targetRes.id] ||
                                  !editingNotes[c.caseId]
                                }
                                onClick={() =>
                                  handleFeedback(
                                    targetRes.id,
                                    c.caseId,
                                    targetRes.human_feedback,
                                  )
                                }
                              >
                                保存批注
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Past runs history */}
          {runs.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground">
                历史评测运行 ({runs.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {runs.slice(0, 8).map((r) => (
                  <Button
                    key={r.id}
                    size="sm"
                    variant={selectedRunId === r.id ? 'secondary' : 'ghost'}
                    className="h-7 text-[11px] gap-1.5"
                    onClick={() => setSelectedRunId(r.id)}
                  >
                    {r.status === 'completed' && (
                      <CheckCircle2 className="size-3 text-success" />
                    )}
                    {r.status === 'running' && (
                      <Loader2 className="size-3 animate-spin text-primary" />
                    )}
                    {r.status === 'cancelled' && (
                      <StopCircle className="size-3 text-muted-foreground" />
                    )}
                    v{r.base_version ?? '-'} vs v{r.target_version ?? '-'} ·{' '}
                    {new Date(r.created_at).toLocaleTimeString()}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
