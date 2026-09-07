import { apiFetch } from './client';
import type {
  EvalCase,
  EvalCompareSummary,
  EvalHumanFeedback,
  EvalRun,
  EvalRunCase,
  EvalSuite,
} from '../types';

export async function fetchEvalSuites(): Promise<EvalSuite[]> {
  const data = await apiFetch<{ suites: EvalSuite[] }>('/api/eval/suites');
  return data.suites;
}

export async function fetchEvalSuiteDetail(
  id: string,
): Promise<EvalSuite & { cases: EvalCase[] }> {
  const data = await apiFetch<{ suite: EvalSuite & { cases: EvalCase[] } }>(
    `/api/eval/suites/${id}`,
  );
  return data.suite;
}

export async function fetchEvalRuns(
  agentProfileId?: string,
): Promise<EvalRun[]> {
  const path = agentProfileId
    ? `/api/eval/runs?agent_profile_id=${encodeURIComponent(agentProfileId)}`
    : '/api/eval/runs';
  const data = await apiFetch<{ runs: EvalRun[] }>(path);
  return data.runs;
}

export async function fetchEvalRunSummary(
  id: string,
): Promise<EvalCompareSummary> {
  const data = await apiFetch<{ summary: EvalCompareSummary }>(
    `/api/eval/runs/${id}`,
  );
  return data.summary;
}

export async function startEvalRunApi(params: {
  agent_profile_id: string;
  suite_id?: string;
  mode?: 'single' | 'compare';
  base_version?: number;
  target_version?: number;
  model?: string;
}): Promise<EvalRun> {
  const data = await apiFetch<{ run: EvalRun }>('/api/eval/runs', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.run;
}

export async function cancelEvalRunApi(id: string): Promise<boolean> {
  const data = await apiFetch<{ success: boolean }>(
    `/api/eval/runs/${id}/cancel`,
    {
      method: 'POST',
    },
  );
  return data.success;
}

export async function submitCaseFeedbackApi(
  caseRunId: string,
  feedback: EvalHumanFeedback,
  notes?: string | null,
): Promise<EvalRunCase> {
  const data = await apiFetch<{ case: EvalRunCase }>(
    `/api/eval/cases/${caseRunId}/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({ feedback, notes }),
    },
  );
  return data.case;
}
