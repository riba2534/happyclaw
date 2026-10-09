/**
 * Lightweight Claude Agent SDK wrapper for simple text-in → text-out queries.
 * Replaces all `claude --print` CLI calls so authentication uses the
 * provider configured in the settings page (ANTHROPIC_API_KEY / OAuth / Base URL).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeEnvLines,
  clearInheritedClaudeProviderEnv,
  getClaudeProviderConfig,
} from './runtime-config.js';
import { logger } from './logger.js';

/**
 * Send a prompt to Claude and return the plain-text response.
 * Uses the provider configured in the web settings (not a separate CLI install).
 *
 * @param prompt  The user prompt text
 * @param opts.model   Override model (defaults to provider config)
 * @param opts.timeout Timeout in ms (default 60 000)
 * @returns The assistant's text response, or null on failure
 */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;

  // 构造隔离的 env 副本传给 SDK（options.env 是子进程 env 的权威来源）。
  // 不再突变全局 process.env、也无需 mutex 串行化，因此多个 sdkQuery（/recall、
  // 自动标题、bug 上报、task 解析等）可并发执行、凭据互不串扰。
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  clearInheritedClaudeProviderEnv(env);
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  // Third-party providers default the Agent effort to max. These are short
  // text utilities (titles, recall, task parsing), so the effort below must
  // not be outranked by that provider-wide environment default.
  delete env.CLAUDE_CODE_EFFORT_LEVEL;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        env,
        maxTurns: 2,
        // sdkQuery is intentionally text-only. allowedTools controls permission
        // prompts, not tool visibility, so isolate both tools and settings/skills.
        tools: [],
        skills: [],
        settingSources: [],
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        // One-shot utility calls: no transcript in the service user's
        // ~/.claude/projects, no extended thinking, minimal effort.
        persistSession: false,
        thinking: { type: 'disabled' as const },
        effort: 'low' as const,
        abortController,
      },
    });

    for await (const event of conversation) {
      // A success result with is_error carries the API error text in
      // `result`; it must not be returned as generated content.
      if (
        event.type === 'result' &&
        event.subtype === 'success' &&
        !event.is_error
      ) {
        result = event.result;
      }
    }

    return result.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'sdkQuery failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
