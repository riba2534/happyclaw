export const SDK_AGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SdkAgentEffort = (typeof SDK_AGENT_EFFORT_LEVELS)[number];

const SDK_AGENT_EFFORT_LEVEL_SET = new Set<string>(SDK_AGENT_EFFORT_LEVELS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return only an explicit Agent effort. Undefined means inherit: the host has
 * kept the Provider's CLAUDE_CODE_EFFORT_LEVEL (if any), otherwise the SDK
 * selects its model-aware default.
 */
export function resolveAgentSdkEffort(
  runtimePolicy: unknown,
): SdkAgentEffort | undefined {
  if (!isRecord(runtimePolicy) || !isRecord(runtimePolicy.reasoning)) {
    return undefined;
  }
  const effort = runtimePolicy.reasoning.effort;
  return typeof effort === 'string' && SDK_AGENT_EFFORT_LEVEL_SET.has(effort)
    ? (effort as SdkAgentEffort)
    : undefined;
}

/**
 * The SDK `effort` option of a run. When the host resolved the launch's
 * effort (`launchEffort`, null for none) that decides, so a model that takes
 * no effort is sent none even if the Agent names one; otherwise (the
 * Workspace's own environment, a ChatGPT subscription) the Agent's explicit
 * effort goes as before.
 */
export function resolveRunSdkEffort(input: {
  launchEffort?: string | null;
  agentProfile?: { runtimePolicy?: unknown };
}): SdkAgentEffort | undefined {
  if (input.launchEffort !== undefined) {
    return input.launchEffort &&
      SDK_AGENT_EFFORT_LEVEL_SET.has(input.launchEffort)
      ? (input.launchEffort as SdkAgentEffort)
      : undefined;
  }
  return resolveAgentSdkEffort(input.agentProfile?.runtimePolicy);
}

export type RunSdkThinking =
  | { type: 'adaptive'; display: 'summarized' }
  | { type: 'disabled' };

/**
 * The SDK `thinking` option of a run. A model the host declared to take no
 * effort and not to reason runs with thinking off, and HappyClaw passes it no
 * effort either (the host sends `launchEffort: null`). Every other run lets
 * the model decide how much to think and streams the summary.
 */
export function resolveRunSdkThinking(input: {
  thinking?: 'disabled';
}): RunSdkThinking {
  return input.thinking === 'disabled'
    ? { type: 'disabled' }
    : { type: 'adaptive', display: 'summarized' };
}
