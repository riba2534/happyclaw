import { createHash } from 'node:crypto';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

export type HappyClawSystemPrompt = NonNullable<Options['systemPrompt']>;

/**
 * Since SDK/CLI 0.3.267 / 2.1.267 a custom prompt or a preset `append` is
 * recorded on the conversation's first request and replayed verbatim on every
 * later request and `resume` until compaction. HappyClaw rebuilds this text for
 * every runner from the current AgentProfile, prompts/*.md and per-turn
 * conditions, restarts warm runners when that identity changes, and audits the
 * rebuilt text as the PromptPlan. A recorded prompt would keep sending the
 * session's first text instead, so opt out and render it on every request as
 * Claude Code did before 2.1.267.
 */
export function buildHappyClawSystemPrompt(
  promptText: string,
  includeClaudePreset: boolean,
): HappyClawSystemPrompt {
  return includeClaudePreset
    ? {
        type: 'preset',
        preset: 'claude_code',
        append: promptText,
        snapshot: false,
      }
    : { type: 'custom', prompt: promptText, snapshot: false };
}

export const HAPPYCLAW_SUBAGENT_RUNTIME_CONTRACT = `## HappyClaw delegated-task contract

You are executing a task delegated by a parent agent. Return the requested findings or work product to that parent agent; do not act as though your text is the final user-facing reply. Stay within the delegated scope. Do not independently operate HappyClaw memory or Agent Builder unless the delegated task explicitly requires it.`;

export interface SubagentRuntimeContractAudit {
  enabled: boolean;
  hash: string;
  sdkCompatibility: 'claude-agent-sdk-0.3.280';
  cliCompatibility: 'claude-code-2.1.280';
}

type HiddenSubagentPromptOption = {
  appendSubagentSystemPrompt: string;
};

type SdkOptionsWithEnv = {
  env?: Record<string, string | undefined>;
};

function contractHash(): string {
  return createHash('sha256')
    .update(HAPPYCLAW_SUBAGENT_RUNTIME_CONTRACT, 'utf8')
    .digest('hex');
}

/**
 * Isolates the SDK/CLI 0.3.280 / 2.1.280 undocumented compatibility surface.
 * The SDK serializes appendSubagentSystemPrompt during its initialize control
 * request, while this CLI version gates consumption behind the environment flag.
 */
export function withHappyClawSubagentContract<
  T extends Record<string, unknown>,
>(
  options: T,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): {
  options: T & SdkOptionsWithEnv & HiddenSubagentPromptOption;
  audit: SubagentRuntimeContractAudit;
} {
  const enabled =
    process.env.HAPPYCLAW_DISABLE_SUBAGENT_RUNTIME_CONTRACT !== 'true';
  const existingEnv = (options as T & SdkOptionsWithEnv).env;
  const hash = contractHash();
  const audit: SubagentRuntimeContractAudit = {
    enabled,
    hash,
    sdkCompatibility: 'claude-agent-sdk-0.3.280',
    cliCompatibility: 'claude-code-2.1.280',
  };

  if (!enabled) {
    return {
      options: options as T & SdkOptionsWithEnv & HiddenSubagentPromptOption,
      audit,
    };
  }

  return {
    options: {
      ...options,
      env: {
        ...inheritedEnv,
        ...existingEnv,
        CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT: '1',
      },
      appendSubagentSystemPrompt: HAPPYCLAW_SUBAGENT_RUNTIME_CONTRACT,
    },
    audit,
  };
}
