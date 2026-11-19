import { sessionKind } from './session-kind.js';
import type { ContainerInput } from './types.js';

type SubagentDefinitions = NonNullable<
  NonNullable<ContainerInput['subagents']>['agents']
>;

/**
 * CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS for the Agent's cap; nothing without
 * one, so Claude Code's own limit (or one an admin set) stays.
 */
export function subagentConcurrencyEnv(
  subagents: ContainerInput['subagents'],
): Record<string, string> {
  const cap = subagents?.maxConcurrent;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0
    ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(cap) }
    : {};
}

/**
 * The Agent's cap goes into the flag settings' env as well, above the
 * admin's, project and local settings: a settings file the CLI reads cannot
 * raise it. Without a cap nothing is written.
 */
export function pinSubagentConcurrency<
  T extends { env: Record<string, string> },
>(settings: T, subagents: ContainerInput['subagents']): T {
  const env = subagentConcurrencyEnv(subagents);
  return Object.keys(env).length > 0
    ? { ...settings, env: { ...settings.env, ...env } }
    : settings;
}

/**
 * The Agent's custom sub-agents for SDK `options.agents`, or nothing. A team
 * router only routes: it gets none, so a sub-agent cannot do the work the
 * router hands to work items.
 */
export function sdkSubagentDefinitions(
  input: Pick<ContainerInput, 'subagents' | 'teamRole' | 'workMode'>,
): SubagentDefinitions | undefined {
  if (sessionKind(input) === 'team-router') return undefined;
  const agents = input.subagents?.agents;
  return agents && Object.keys(agents).length > 0 ? agents : undefined;
}
