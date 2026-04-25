import type { ContainerInput, ContainerOutput } from './types.js';

export interface RuntimeRunInput {
  input: ContainerInput;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
  cwd: string;
  systemPromptAppend: string;
  additionalDirectories?: string[];
  model?: string | null;
  images?: Array<{ data: string; mimeType?: string }>;
  resumeMode?: 'resume' | 'fresh' | 'soft_inject';
  inputContextHash?: string | null;
  workspaceInstructionHash?: string | null;
  softInjectionReason?: string | null;
  resumeFailureFallbackPrompt?: string | null;
  resumeFailureFallbackInputContextHash?: string | null;
  resumeFailureFallbackWorkspaceInstructionHash?: string | null;
  resumeFailureFallbackSoftInjectionReason?: string | null;
}

export interface RuntimeEmit {
  (output: ContainerOutput): void;
}

export interface RuntimeRunResult {
  status: 'success' | 'error' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorClass?: RuntimeErrorClass;
  runtimeContext?: RuntimeContextMeta;
}

export type RuntimeErrorClass =
  | 'auth'
  | 'unsupported_model'
  | 'rate_limit'
  | 'quota'
  | 'network'
  | 'runtime_unavailable'
  | 'permission'
  | 'cancelled'
  | 'unknown';

export interface AgentRuntimeAdapter {
  runtime: 'claude' | 'codex';
  supportsNativeResume?: boolean;
  supportsLiveInput?: boolean;
  supportsPreCompactHook?: boolean;
  run(input: RuntimeRunInput, emit: RuntimeEmit): Promise<RuntimeRunResult>;
  cancel?(runId: string): Promise<void>;
  drain?(scopeId: string): Promise<void>;
  canNativeResume?(sessionId: string | null | undefined): boolean;
  classifyError?(error: unknown): RuntimeErrorClass;
}

export interface RuntimeContextMeta {
  resumeMode?: 'resume' | 'fresh' | 'soft_inject';
  inputContextHash?: string | null;
  workspaceInstructionHash?: string | null;
  softInjectionReason?: string | null;
}

export function runtimeContextMetaFromRunInput(
  input: RuntimeRunInput,
): RuntimeContextMeta {
  return {
    resumeMode: input.resumeMode,
    inputContextHash: input.inputContextHash ?? null,
    workspaceInstructionHash: input.workspaceInstructionHash ?? null,
    softInjectionReason: input.softInjectionReason ?? null,
  };
}

export function buildResumeFailureRetryInput(
  input: RuntimeRunInput,
  reason: string,
): RuntimeRunInput {
  return {
    ...input,
    prompt: input.resumeFailureFallbackPrompt || input.prompt,
    sessionId: undefined,
    resumeMode: 'soft_inject',
    inputContextHash:
      input.resumeFailureFallbackInputContextHash ?? input.inputContextHash,
    workspaceInstructionHash:
      input.resumeFailureFallbackWorkspaceInstructionHash ??
      input.workspaceInstructionHash,
    softInjectionReason:
      input.resumeFailureFallbackSoftInjectionReason ||
      input.softInjectionReason ||
      reason,
  };
}

export function runtimeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function classifyRuntimeError(error: unknown): RuntimeErrorClass {
  const err = error as NodeJS.ErrnoException;
  const message = runtimeErrorMessage(error);
  const haystack = `${err?.code || ''} ${message}`.toLowerCase();

  if (/abort|aborted|cancelled|canceled|sigterm|sigint/.test(haystack)) {
    return 'cancelled';
  }
  if (
    /auth|unauthori[sz]ed|api key|apikey|oauth|login|credential|forbidden|401|403/.test(
      haystack,
    )
  ) {
    return 'auth';
  }
  if (
    /unsupported model|model .*not found|invalid model|unknown model|model_not_found/.test(
      haystack,
    )
  ) {
    return 'unsupported_model';
  }
  if (/rate.?limit|too many requests|429/.test(haystack)) {
    return 'rate_limit';
  }
  if (/quota|billing|insufficient_quota|credit|subscription/.test(haystack)) {
    return 'quota';
  }
  if (
    /enotfound|econnreset|econnrefused|etimedout|network|dns|tls|socket|timeout/.test(
      haystack,
    )
  ) {
    return 'network';
  }
  if (
    /command not found|enoent|unable to locate|not installed|missing executable|spawn .* enoent/.test(
      haystack,
    )
  ) {
    return 'runtime_unavailable';
  }
  if (/permission denied|eacces|eperm|sandbox|approval/.test(haystack)) {
    return 'permission';
  }
  return 'unknown';
}
