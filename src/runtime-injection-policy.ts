import type { AgentRuntime } from './types.js';

export type NativeProjectInstructionPolicy = 'allow' | 'disable' | 'unknown';
export type ContextInjectionPolicy = 'never' | 'always' | 'when_soft_inject';
export type RecentHistoryPolicy =
  | 'never'
  | 'when_no_native_session'
  | 'when_soft_inject';

export interface RuntimeInjectionPolicy {
  runtime: AgentRuntime;
  nativeProjectInstructions: NativeProjectInstructionPolicy;
  injectWorkspaceInstructions: ContextInjectionPolicy;
  injectGlobalMemory: ContextInjectionPolicy;
  injectRecentHistory: RecentHistoryPolicy;
  preserveStablePrefix: boolean;
}

const POLICIES: Record<AgentRuntime, RuntimeInjectionPolicy> = {
  claude: {
    runtime: 'claude',
    nativeProjectInstructions: 'allow',
    injectWorkspaceInstructions: 'never',
    injectGlobalMemory: 'always',
    injectRecentHistory: 'when_soft_inject',
    preserveStablePrefix: true,
  },
  codex: {
    runtime: 'codex',
    nativeProjectInstructions: 'allow',
    injectWorkspaceInstructions: 'never',
    injectGlobalMemory: 'always',
    injectRecentHistory: 'when_soft_inject',
    preserveStablePrefix: true,
  },
};

export function getRuntimeInjectionPolicy(
  runtime: AgentRuntime | undefined,
): RuntimeInjectionPolicy {
  return POLICIES[runtime || 'claude'];
}
