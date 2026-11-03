import { createHash } from 'node:crypto';

import type { SessionKind } from './session-kind.js';

export type PromptBlockScope = 'main' | 'subagent' | 'both';
export type PromptBlockOwner = 'platform' | 'agent_profile' | 'workspace';

export interface PromptBlockInput {
  id: string;
  version: number;
  scope: PromptBlockScope;
  owner: PromptBlockOwner;
  required: boolean;
  condition: string;
  text: string;
}

export interface PromptBlock extends PromptBlockInput {
  hash: string;
  bytes: number;
  estimatedTokens: number;
}

export interface PromptPlan {
  version: 1;
  blocks: PromptBlock[];
  text: string;
  hash: string;
  totalBytes: number;
  estimatedTokens: number;
  warnings: string[];
  errors: string[];
}

export interface HappyClawPromptSources {
  platformIdentity?: string;
  platformBootstrap?: string;
  agentIdentity?: string;
  /**
   * The engine layer: with the Claude Code preset, how it applies here
   * (`runtime-adaptation`); without it, the working basics it would have
   * given (`runtime-baseline`).
   */
  engine?: {
    id: 'runtime-adaptation' | 'runtime-baseline';
    text: string;
  };
  interaction: string;
  security: string;
  memory?: {
    id: 'memory-system.workspace';
    text: string;
  };
  agentBuilder?: string;
  /**
   * Team mode: the router's or the worker's contract, or a delegated item's
   * worker contract. It takes the place of the output and delivery
   * contracts, which are built on send_message.
   */
  team?: {
    id: RolePromptId;
    text: string;
  };
  /** Required, except that a team section replaces it. */
  output?: string;
  web?: string;
  backgroundTasks?: string;
  deliveryContract?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Deliberately conservative, dependency-free estimate used before the SDK is
 * initialized. The SDK's getContextUsage() result remains authoritative.
 */
export function estimatePromptTokens(text: string): number {
  const bytesEstimate = Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
  const nonAsciiChars = [...text].filter(
    (char) => char.codePointAt(0)! > 127,
  ).length;
  return Math.max(bytesEstimate, nonAsciiChars);
}

export function createPromptBlock(input: PromptBlockInput): PromptBlock {
  const text = input.text.trim();
  return {
    ...input,
    text,
    hash: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    estimatedTokens: estimatePromptTokens(text),
  };
}

export function createPromptPlan(inputs: PromptBlockInput[]): PromptPlan {
  const warnings: string[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const input of inputs) {
    if (seenIds.has(input.id)) {
      errors.push(`duplicate prompt block id: ${input.id}`);
    }
    seenIds.add(input.id);
    if (input.required && input.text.trim().length === 0) {
      errors.push(`required prompt block is empty: ${input.id}`);
    }
  }
  const blocks = inputs
    .filter((block) => block.text.trim().length > 0)
    .map(createPromptBlock);
  const text = blocks.map((block) => block.text).join('\n');
  const totalBytes = Buffer.byteLength(text, 'utf8');
  const estimatedTokens = estimatePromptTokens(text);

  // This is only a preflight guard against accidentally enormous generated
  // prompts. Model-aware limits are evaluated after SDK init.
  if (estimatedTokens >= 50_000) {
    warnings.push(
      `platform prompt estimate is ${estimatedTokens} tokens (warning threshold: 50000)`,
    );
  }
  if (estimatedTokens >= 100_000) {
    errors.push(
      `platform prompt estimate is ${estimatedTokens} tokens (hard threshold: 100000)`,
    );
  }

  return {
    version: 1,
    blocks,
    text,
    hash: sha256(
      JSON.stringify(
        blocks.map((block) => ({
          id: block.id,
          version: block.version,
          scope: block.scope,
          owner: block.owner,
          required: block.required,
          condition: block.condition,
          hash: block.hash,
        })),
      ),
    ),
    totalBytes,
    estimatedTokens,
    warnings,
    errors,
  };
}

/**
 * Background work is started with the Agent tool (still accepted under its
 * legacy name Task; agents run in the background by default) or Bash
 * `run_in_background`; its result arrives as a task notification and TaskStop
 * cancels it. Claude Code 2.1.277 removed the deprecated TaskOutput tool
 * (output files are read with Read), so the Agent/Task entry alone decides
 * whether the background-task guidance applies.
 */
export function hasBackgroundTaskTools(
  allowedTools: readonly string[],
): boolean {
  return allowedTools.includes('Task');
}

const ENGINE_CONDITIONS: Record<
  NonNullable<HappyClawPromptSources['engine']>['id'],
  string
> = {
  'runtime-adaptation': 'Claude Code preset is included',
  'runtime-baseline': 'Claude Code preset is not included',
};

const TEAM_CONDITIONS: Record<RolePromptId, string> = {
  'team-router': 'team mode router session',
  'team-worker': 'team mode worker session',
  'delegated-worker': 'multi-task mode delegated worker session',
};

/** A session role's section, named after its file under prompts/. */
export type RolePromptId = Exclude<SessionKind, 'single' | 'multi'>;

/** Background-task guidance, named after its file under prompts/. */
export type BackgroundTasksPromptId =
  | 'background-tasks'
  | 'background-tasks.team'
  | 'background-tasks.multi'
  | 'background-tasks.delegated';

/**
 * The role section and background-task guidance each kind of session gets:
 * a conversation of a multi-task workspace swaps in the delegation guidance,
 * and a delegated item's worker has a section of its own.
 */
export const SESSION_PROMPTS: Record<
  SessionKind,
  { role?: RolePromptId; backgroundTasks: BackgroundTasksPromptId }
> = {
  single: { backgroundTasks: 'background-tasks' },
  multi: { backgroundTasks: 'background-tasks.multi' },
  'team-router': {
    role: 'team-router',
    backgroundTasks: 'background-tasks.team',
  },
  'team-worker': {
    role: 'team-worker',
    backgroundTasks: 'background-tasks.team',
  },
  'delegated-worker': {
    role: 'delegated-worker',
    backgroundTasks: 'background-tasks.delegated',
  },
};

function wrap(tag: string, text: string): string {
  if (!text.trim()) return '';
  return `<${tag}>\n${text}\n</${tag}>`;
}

/** Build the main-agent platform contract in its documented, stable order. */
export function buildHappyClawPromptPlan(
  sources: HappyClawPromptSources,
): PromptPlan {
  const inputs: PromptBlockInput[] = [];

  // Directly after the Claude Code preset (or in its place), ahead of the
  // identity it defers to.
  if (sources.engine) {
    inputs.push({
      id: sources.engine.id,
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: ENGINE_CONDITIONS[sources.engine.id],
      text: wrap(sources.engine.id, sources.engine.text),
    });
  }

  if (sources.platformIdentity) {
    inputs.push({
      id: 'identity.happyclaw',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: 'built-in default HappyClaw AgentProfile',
      text: wrap('platform-identity', sources.platformIdentity),
    });
  }

  if (sources.platformBootstrap) {
    inputs.push({
      id: 'bootstrap.happyclaw',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: false,
      condition:
        'built-in HappyClaw Home runtime; each turn follows the host-authoritative owner-profile block',
      text: wrap('platform-bootstrap', sources.platformBootstrap),
    });
  }

  if (sources.agentIdentity) {
    inputs.push({
      id: 'agent-profile',
      version: 1,
      scope: 'main',
      owner: 'agent_profile',
      required: false,
      condition: 'agent_profile.identityPrompt is non-empty',
      text: sources.agentIdentity,
    });
  }

  inputs.push(
    {
      id: 'interaction',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: 'always',
      text: wrap('behavior', sources.interaction),
    },
    {
      id: 'security-rules',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: 'always',
      text: wrap('security', sources.security),
    },
  );

  if (sources.memory) {
    inputs.push({
      id: sources.memory.id,
      version: 1,
      scope: 'main',
      owner: 'workspace',
      required: false,
      condition: 'memory tools and workspace memory context are available',
      text: wrap('memory-system', sources.memory.text),
    });
  }

  if (sources.agentBuilder) {
    inputs.push({
      id: 'agent-builder',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: false,
      condition: 'interactive default AgentProfile with Agent Builder enabled',
      text: wrap('agent-builder', sources.agentBuilder),
    });
  }

  if (sources.team) {
    inputs.push({
      id: sources.team.id,
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: TEAM_CONDITIONS[sources.team.id],
      text: wrap(sources.team.id, sources.team.text),
    });
  }

  // A team section is the session's output contract.
  if (!sources.team) {
    inputs.push({
      id: 'output',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: true,
      condition: 'always',
      text: wrap('output-contract', sources.output ?? ''),
    });
  }

  if (sources.web) {
    inputs.push({
      id: 'web-fetch',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: false,
      condition: 'WebSearch or WebFetch is available',
      text: wrap('web-access', sources.web),
    });
  }

  if (sources.backgroundTasks) {
    inputs.push({
      id: 'background-tasks',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: false,
      condition: 'Task is available',
      text: wrap('background-tasks', sources.backgroundTasks),
    });
  }

  if (sources.deliveryContract) {
    inputs.push({
      id: 'delivery-contract',
      version: 1,
      scope: 'main',
      owner: 'platform',
      required: false,
      condition: 'conversation Agent runtime is active',
      text: wrap('delivery-contract', sources.deliveryContract),
    });
  }

  return createPromptPlan(inputs);
}
