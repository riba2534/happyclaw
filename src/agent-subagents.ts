import {
  findModelEntry,
  launchModelName,
  windowOf,
  type ProviderModelEntry,
} from './model-providers.js';
import type {
  AgentSubagentDefinition,
  AgentSubagentPolicy,
  SubagentEffortLevel,
} from './types.js';

/**
 * Sub-agents of an Agent Profile: a default sub-agent model, the CLI's
 * concurrency cap and user-defined sub-agents (SDK `options.agents`).
 *
 * One Claude Code process talks to one endpoint with one credential, and an
 * AgentDefinition has no endpoint of its own, so every model here is a model
 * of the Agent's own connection. When a turn runs on another connection (the
 * session picked one) these names do not apply and the turn's connection
 * decides, the same way a session pick drops `agent_profiles.model`.
 */

export const SUBAGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly SubagentEffortLevel[];

export const SUBAGENT_NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const MAX_SUBAGENT_DEFINITIONS = 20;
export const MAX_SUBAGENT_DESCRIPTION_CHARS = 1000;
export const MAX_SUBAGENT_PROMPT_CHARS = 20000;
export const MAX_SUBAGENT_TOOLS = 100;
/** The CLI's own default (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
export const MAX_CONCURRENT_SUBAGENTS = 20;

/** Built-in agent types a definition must not shadow. */
export const RESERVED_SUBAGENT_NAMES: ReadonlySet<string> = new Set([
  'general-purpose',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
  'explore',
  'plan',
  'fork',
]);

const EFFORT_SET = new Set<string>(SUBAGENT_EFFORT_LEVELS);

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTools(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tools: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tool = item.trim();
    if (tool && !tools.includes(tool)) tools.push(tool);
  }
  return tools.slice(0, MAX_SUBAGENT_TOOLS);
}

function normalizeDefinition(raw: unknown): AgentSubagentDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = text(record.name, 48);
  if (!SUBAGENT_NAME_RE.test(name) || RESERVED_SUBAGENT_NAMES.has(name)) {
    return null;
  }
  const description = text(record.description, MAX_SUBAGENT_DESCRIPTION_CHARS);
  const prompt = text(record.prompt, MAX_SUBAGENT_PROMPT_CHARS);
  if (!description || !prompt) return null;
  return {
    name,
    description,
    prompt,
    tools: normalizeTools(record.tools),
    model: optionalId(record.model),
    effort:
      typeof record.effort === 'string' && EFFORT_SET.has(record.effort)
        ? (record.effort as SubagentEffortLevel)
        : null,
  };
}

/**
 * The stored shape, or undefined when nothing is set: an Agent that does not
 * use sub-agent settings keeps the policy (and identity hash) it had before.
 */
export function normalizeSubagentPolicy(
  raw: unknown,
): AgentSubagentPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const definitions: AgentSubagentDefinition[] = [];
  if (Array.isArray(record.definitions)) {
    for (const item of record.definitions) {
      const definition = normalizeDefinition(item);
      if (!definition) continue;
      if (definitions.some((other) => other.name === definition.name)) continue;
      definitions.push(definition);
      if (definitions.length >= MAX_SUBAGENT_DEFINITIONS) break;
    }
  }
  const concurrent = record.max_concurrent;
  const policy: AgentSubagentPolicy = {
    model: optionalId(record.model),
    max_concurrent:
      typeof concurrent === 'number' && Number.isFinite(concurrent)
        ? Math.min(
            MAX_CONCURRENT_SUBAGENTS,
            Math.max(1, Math.floor(concurrent)),
          )
        : null,
    definitions,
  };
  return policy.model === null &&
    policy.max_concurrent === null &&
    policy.definitions.length === 0
    ? undefined
    : policy;
}

/** The models a policy names, for checking them against a connection. */
export function subagentPolicyModels(
  policy: AgentSubagentPolicy | undefined,
): string[] {
  if (!policy) return [];
  const models = [
    policy.model,
    ...policy.definitions.map((definition) => definition.model),
  ].filter((model): model is string => !!model);
  return [...new Set(models)];
}

/** What a launch hands the runner: SDK-ready definitions and the cap. */
export interface SubagentLaunch {
  /** Overrides the connection's `roles.subagent`: a model id of it. */
  defaultModel?: string;
  maxConcurrent?: number;
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      effort?: SubagentEffortLevel;
    }
  >;
}

export interface SubagentLaunchInput {
  policy: AgentSubagentPolicy | undefined;
  /** Whether the turn runs on the Agent's own connection. */
  onAgentConnection: boolean;
  /** The models of the turn's connection; empty when it has no list. */
  models: readonly ProviderModelEntry[];
  /** The efforts a model takes, or null when it takes none. */
  effortsOf: (modelId: string) => readonly string[] | null;
  /**
   * The efforts of the model an inheriting definition runs on: the default
   * sub-agent model (this policy's, else the connection's role), else the
   * turn's model.
   */
  inheritedEfforts: readonly string[] | null;
}

/**
 * Resolve a policy for one launch. Names of the Agent's connection apply only
 * on that connection and only while it still offers them; otherwise the
 * definition inherits and the connection's role decides the default. An
 * effort is sent only to a model that takes it, as for the main model.
 */
export function resolveSubagentLaunch(
  input: SubagentLaunchInput,
): SubagentLaunch {
  const { policy } = input;
  if (!policy) return {};
  const entryOf = (id: string | null): ProviderModelEntry | undefined =>
    id && input.onAgentConnection
      ? findModelEntry(input.models, id)
      : undefined;
  const launchName = (id: string | null): string | undefined => {
    const entry = entryOf(id);
    return entry
      ? launchModelName(entry.id, windowOf(input.models, entry.id))
      : undefined;
  };
  const result: SubagentLaunch = {};
  const defaultEntry = entryOf(policy.model);
  if (defaultEntry) result.defaultModel = defaultEntry.id;
  if (policy.max_concurrent !== null) {
    result.maxConcurrent = policy.max_concurrent;
  }
  if (policy.definitions.length > 0) {
    result.agents = {};
    for (const definition of policy.definitions) {
      const model = launchName(definition.model);
      const efforts = model
        ? input.effortsOf(definition.model!)
        : input.inheritedEfforts;
      const effort =
        definition.effort && efforts?.includes(definition.effort)
          ? definition.effort
          : undefined;
      result.agents[definition.name] = {
        description: definition.description,
        prompt: definition.prompt,
        ...(definition.tools ? { tools: definition.tools } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    }
  }
  return result;
}
