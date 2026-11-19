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
export const MAX_SUBAGENT_TOOL_CHARS = 200;
/** The highest cap an Agent may set (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
export const MAX_CONCURRENT_SUBAGENTS = 20;

/**
 * A tool rule of a sub-agent: a tool name (`Read`, `mcp__github__get_issue`,
 * `mcp__github__*`), optionally with its argument in parentheses
 * (`Bash(git log:*)`), which may hold spaces. Commas and line breaks
 * separate rules where they are typed, so a rule holds neither.
 */
export const SUBAGENT_TOOL_RE = /^[A-Za-z][\w.*-]*(?:\([^,\r\n\0]*\))?$/;

/**
 * Built-in tools the Runner removes from every session
 * (RUNNER_DISALLOWED_BUILTIN_TOOLS in the Runner's builtin-tool-policy.ts):
 * they depend on a Claude Code process that outlives the turn or wait for
 * an approval no one gives. A sub-agent that lists one does not get it.
 */
export const SUBAGENT_UNAVAILABLE_TOOLS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
];

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
    if (
      tool.length <= MAX_SUBAGENT_TOOL_CHARS &&
      SUBAGENT_TOOL_RE.test(tool) &&
      !tools.includes(tool)
    ) {
      tools.push(tool);
    }
  }
  return tools.slice(0, MAX_SUBAGENT_TOOLS);
}

/** The tool a rule names: `Bash` for `Bash(git log:*)`. */
function toolRuleName(rule: string): string {
  const open = rule.indexOf('(');
  return open === -1 ? rule : rule.slice(0, open);
}

/** Whether a tool rule names a tool no session has. */
export function isUnavailableSubagentTool(tool: string): boolean {
  return SUBAGENT_UNAVAILABLE_TOOLS.includes(toolRuleName(tool));
}

/** A sub-agent's tools without those no session has. */
export function availableSubagentTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => !isUnavailableSubagentTool(tool));
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

/**
 * The part of a policy that is the Agent's identity: the custom sub-agents,
 * whose descriptions the Agent tool lists to the model, as Skills and MCP
 * are listed. The cap and the default sub-agent model only change how a
 * Runner starts: saving them restarts the Runner, as any policy change does,
 * and keeps the SDK session. Undefined without custom sub-agents, so an
 * Agent without them keeps the identity it had before.
 */
export function subagentIdentity(
  policy: AgentSubagentPolicy | undefined,
): Pick<AgentSubagentPolicy, 'definitions'> | undefined {
  return policy && policy.definitions.length > 0
    ? { definitions: policy.definitions }
    : undefined;
}

/**
 * The policy without the model names it holds, which belong to a connection
 * of this instance: for an export or an import, or a copy whose connection
 * no longer offers them. `keep` says which names stay. Undefined when
 * nothing else is set.
 */
export function subagentPolicyWithoutModels(
  policy: AgentSubagentPolicy | undefined,
  keep: (model: string) => boolean = () => false,
): AgentSubagentPolicy | undefined {
  if (!policy) return undefined;
  const kept = (model: string | null) => (model && keep(model) ? model : null);
  return normalizeSubagentPolicy({
    ...policy,
    model: kept(policy.model),
    definitions: policy.definitions.map((definition) => ({
      ...definition,
      model: kept(definition.model),
    })),
  });
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
  /**
   * Whether a definition's effort goes to the model it runs on: its own (a
   * model id of the connection), or null for the one it inherits (the
   * default sub-agent model, else the turn's).
   */
  takesEffort: (model: string | null, effort: SubagentEffortLevel) => boolean;
}

/**
 * Resolve a policy for one launch. Names of the Agent's connection apply only
 * on that connection and only while it still offers them; otherwise the
 * definition inherits and the connection's role decides the default. An
 * effort goes only where `takesEffort` says the model takes it, and a
 * definition's tools leave out those no session has.
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
  const result: SubagentLaunch = {};
  const defaultEntry = entryOf(policy.model);
  if (defaultEntry) result.defaultModel = defaultEntry.id;
  if (policy.max_concurrent !== null) {
    result.maxConcurrent = policy.max_concurrent;
  }
  if (policy.definitions.length > 0) {
    result.agents = {};
    for (const definition of policy.definitions) {
      const entry = entryOf(definition.model);
      const model = entry
        ? launchModelName(entry.id, windowOf(input.models, entry.id))
        : undefined;
      const effort =
        definition.effort &&
        input.takesEffort(entry?.id ?? null, definition.effort)
          ? definition.effort
          : undefined;
      result.agents[definition.name] = {
        description: definition.description,
        prompt: definition.prompt,
        ...(definition.tools
          ? { tools: availableSubagentTools(definition.tools) }
          : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    }
  }
  return result;
}

/**
 * A policy for a launch without a connection (the Workspace's own
 * environment): no model name applies, the definitions and the cap still
 * do, and an effort goes as picked, like the Agent's own there.
 */
export function resolveSubagentLaunchWithoutConnection(
  policy: AgentSubagentPolicy | undefined,
): SubagentLaunch {
  return resolveSubagentLaunch({
    policy,
    onAgentConnection: false,
    models: [],
    takesEffort: () => true,
  });
}

/** Who chose the model a launch's sub-agents run on by default. */
export type SubagentDefaultSource =
  /** The Agent's default sub-agent model. */
  | 'agent'
  /** The connection's 「后台与子代理」 role. */
  | 'connection'
  /** Nothing chose one: the turn's model. */
  | 'turn'
  /** Nothing chose one on the official endpoint: Claude Code decides. */
  | 'claude_code';

/**
 * The model the sub-agents of a launch on a connection run on when they name
 * none (CLAUDE_CODE_SUBAGENT_MODEL as buildClaudeEnvLines writes it): the
 * Agent's default (`agentDefault`, already resolved for the connection),
 * else on a third-party endpoint the connection's role, else the turn's
 * model. A ChatGPT subscription runs every tier on the turn's model; the
 * official endpoint is given only the Agent's.
 */
export function launchSubagentDefault(
  connection: {
    anthropicBaseUrl: string;
    codexOAuthCredentials?: unknown;
    roles?: { subagent?: string };
  },
  agentDefault: string | undefined,
  turnModel: string,
): { model: string | null; source: SubagentDefaultSource } {
  if (connection.codexOAuthCredentials) {
    return { model: turnModel || null, source: 'turn' };
  }
  if (agentDefault) return { model: agentDefault, source: 'agent' };
  if (!connection.anthropicBaseUrl) {
    return { model: null, source: 'claude_code' };
  }
  if (connection.roles?.subagent) {
    return { model: connection.roles.subagent, source: 'connection' };
  }
  return { model: turnModel || null, source: 'turn' };
}

/**
 * The models a launch's custom sub-agents name; their declared reply limits
 * count toward CLAUDE_CODE_MAX_OUTPUT_TOKENS like the roles'.
 */
export function subagentLaunchModels(launch: SubagentLaunch): string[] {
  const models = Object.values(launch.agents ?? {})
    .map((agent) => agent.model)
    .filter((model): model is string => !!model);
  return [...new Set(models)];
}
