import type { z } from 'zod';

import { subagentPolicyWithoutModels } from './agent-subagents.js';
import { parseManagedMcpReference } from './mcp-utils.js';
import { AgentProfileExportAgentSchema } from './schemas.js';
import type { AgentProfile, AgentProfileRuntimePolicy } from './types.js';

export const AGENT_EXPORT_FORMAT = 'happyclaw-agent';
export const AGENT_EXPORT_VERSION = 1;

export type AgentProfileExportAgent = z.infer<
  typeof AgentProfileExportAgentSchema
>;

export interface AgentProfileExportDocument {
  format: typeof AGENT_EXPORT_FORMAT;
  version: typeof AGENT_EXPORT_VERSION;
  exported_at: string;
  agent: Required<AgentProfileExportAgent>;
}

/** MCP references always carry their scope so they read the same anywhere. */
function portableMcpReferences(ids: string[]): string[] {
  return ids.map((reference) => {
    const { scope, id } = parseManagedMcpReference(reference);
    return `${scope}:${id}`;
  });
}

/**
 * The policy with its sub-agent model names cleared but those `keep`
 * accepts: the names belong to one connection of this instance, so an
 * exported, imported or copied Agent's sub-agents follow the connection it
 * ends up on instead. Sub-agent settings left with nothing are dropped.
 */
export function withoutSubagentModels(
  policy: AgentProfileRuntimePolicy,
  keep?: (model: string) => boolean,
): AgentProfileRuntimePolicy {
  const { subagents: current, ...rest } = policy;
  const subagents = subagentPolicyWithoutModels(current, keep);
  return subagents ? { ...rest, subagents } : rest;
}

/**
 * The sub-agents as a file carries them: the custom sub-agents and the cap,
 * without the model names (the binding does not leave the instance either).
 */
function portableSubagents(
  policy: AgentProfileRuntimePolicy,
): Pick<NonNullable<AgentProfileExportAgent['runtime_policy']>, 'subagents'> {
  const subagents = withoutSubagentModels(policy).subagents;
  if (!subagents) return {};
  return {
    subagents: {
      max_concurrent: subagents.max_concurrent,
      definitions: subagents.definitions.map(
        ({ model: _model, ...definition }) => definition,
      ),
    },
  };
}

/**
 * An Agent as a self-contained file: identity, prompts and the capability
 * policy with Skills and MCP referenced by name, and its custom sub-agents.
 * The model binding (sub-agent models included), uploaded avatar,
 * Workspaces and channels belong to this instance and stay behind.
 */
export function buildAgentProfileExport(
  profile: AgentProfile,
  now = new Date(),
): AgentProfileExportDocument {
  const policy = profile.runtime_policy;
  return {
    format: AGENT_EXPORT_FORMAT,
    version: AGENT_EXPORT_VERSION,
    exported_at: now.toISOString(),
    agent: {
      name: profile.name,
      avatar_emoji: profile.avatar_emoji,
      avatar_color: profile.avatar_color,
      identity_prompt: profile.identity_prompt,
      soul_prompt: profile.soul_prompt,
      agents_prompt: profile.agents_prompt,
      tools_prompt: profile.tools_prompt,
      prompt_mode: profile.prompt_mode,
      runtime_policy: {
        reasoning: { ...policy.reasoning },
        context: { ...policy.context },
        skills: {
          mode: policy.skills.mode,
          ids: [...policy.skills.ids],
          host: policy.skills.host
            ? {
                mode: policy.skills.host.mode,
                ids: [...policy.skills.host.ids],
              }
            : { mode: 'disabled', ids: [] },
        },
        mcp: {
          mode: policy.mcp.mode,
          ids: portableMcpReferences(policy.mcp.ids),
        },
        ...portableSubagents(policy),
      },
    },
  };
}

export type AgentProfileImportParseResult =
  | { ok: true; agent: AgentProfileExportAgent }
  | {
      ok: false;
      code: 'INVALID_AGENT_EXPORT' | 'UNSUPPORTED_AGENT_EXPORT_VERSION';
      error: string;
    };

export function parseAgentProfileExport(
  data: unknown,
): AgentProfileImportParseResult {
  const document =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!document || document.format !== AGENT_EXPORT_FORMAT) {
    return {
      ok: false,
      code: 'INVALID_AGENT_EXPORT',
      error: '不是 HappyClaw 智能体导出文件',
    };
  }
  if (document.version !== AGENT_EXPORT_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_AGENT_EXPORT_VERSION',
      error: `不支持的导出文件版本：${String(document.version)}`,
    };
  }
  const parsed = AgentProfileExportAgentSchema.safeParse(document.agent);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: 'INVALID_AGENT_EXPORT',
      error: `导出文件内容无效：${issue?.path.join('.') || 'agent'}`,
    };
  }
  return { ok: true, agent: parsed.data };
}

export type HostGrant = 'host_context' | 'host_skills';

/** The host resources a policy reaches: only an admin may hold them. */
export function hostGrantsOf(policy: AgentProfileRuntimePolicy): HostGrant[] {
  const grants: HostGrant[] = [];
  if (policy.context.source === 'host_claude') grants.push('host_context');
  if (policy.skills.host && policy.skills.host.mode !== 'disabled') {
    grants.push('host_skills');
  }
  return grants;
}

/**
 * A non-admin cannot hold the host Claude context or host Skills. A copied
 * or imported Agent loses them (reported to the caller) instead of failing.
 */
export function stripHostGrants(
  source: AgentProfileRuntimePolicy,
  isAdmin: boolean,
): { policy: AgentProfileRuntimePolicy; stripped: HostGrant[] } {
  const policy: AgentProfileRuntimePolicy = {
    ...source,
    context: { ...source.context },
    skills: {
      ...source.skills,
      host: source.skills.host ?? { mode: 'disabled', ids: [] },
    },
  };
  const stripped = isAdmin ? [] : hostGrantsOf(policy);
  if (stripped.includes('host_context')) policy.context.source = 'managed';
  if (stripped.includes('host_skills')) {
    policy.skills.host = { mode: 'disabled', ids: [] };
  }
  return { policy, stripped };
}

/**
 * Remove references this account cannot resolve. A custom selection left
 * with nothing selected turns the source off instead of widening it.
 */
export function dropMissingReferences(
  policy: AgentProfileRuntimePolicy,
  missing: { skills: string[]; host_skills: string[]; mcp: string[] },
): AgentProfileRuntimePolicy {
  const keep = <
    T extends { mode: 'inherit' | 'custom' | 'disabled'; ids: string[] },
  >(
    selection: T,
    gone: string[],
  ): T => {
    if (selection.mode !== 'custom' || gone.length === 0) return selection;
    const ids = selection.ids.filter((id) => !gone.includes(id));
    return { ...selection, ids, mode: ids.length > 0 ? 'custom' : 'disabled' };
  };
  return {
    ...policy,
    skills: {
      ...keep(policy.skills, missing.skills),
      ...(policy.skills.host
        ? { host: keep(policy.skills.host, missing.host_skills) }
        : {}),
    },
    mcp: keep(policy.mcp, missing.mcp),
  };
}
