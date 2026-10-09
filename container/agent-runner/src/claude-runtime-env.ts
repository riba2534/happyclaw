/**
 * Environment the runner adds to the Claude Code process.
 *
 * Settings that Claude Code reads only from its own process environment
 * belong here rather than in the `settings` option: an environment variable
 * outranks the corresponding setting, and some (transcript GC) cannot be
 * enabled from a settings `env` block at all.
 */

export type ClaudeRuntimeEnv = Record<string, string>;

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Translate the Agent's auto-compact policy into Claude Code's own knobs.
 *
 * - AUTO_COMPACT_PERCENTAGE (50-90) becomes CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
 *   which applies to whatever window Claude Code resolved for the model
 *   (including 1M windows on Sonnet 5+, Opus 4.7+ and Fable) and to
 *   subagents, so the runner no longer guesses the model's window.
 * - AUTO_COMPACT_WINDOW (absolute tokens) becomes
 *   CLAUDE_CODE_AUTO_COMPACT_WINDOW. A provider already setting that
 *   variable (a gateway capped below the model window) keeps the smaller
 *   value; Claude Code itself caps it at the model's context window.
 *
 * The percentage takes precedence when both are set, as before. The
 * `autoCompactWindow` setting is not used: CLAUDE_CODE_AUTO_COMPACT_WINDOW,
 * which third-party providers set, silently outranks it.
 */
export function resolveAutoCompactEnv(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeRuntimeEnv {
  const percentage = Number(env.AUTO_COMPACT_PERCENTAGE ?? '');
  if (Number.isInteger(percentage) && percentage >= 50 && percentage <= 90) {
    return { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percentage) };
  }
  const agentWindow = parsePositiveInteger(env.AUTO_COMPACT_WINDOW);
  if (!agentWindow) return {};
  const providerWindow = parsePositiveInteger(
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  );
  return {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(
      providerWindow ? Math.min(providerWindow, agentWindow) : agentWindow,
    ),
  };
}
