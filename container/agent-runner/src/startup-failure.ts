export type PreInitResultDisposition =
  | { kind: 'resume_failed' }
  | { kind: 'startup_failed'; reason?: string; message: string };

/**
 * Classify an error result that arrived before system/init.
 *
 * With CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 Claude Code names a known
 * startup failure in `startup_failure_reason` (proxy_invalid, cwd_unavailable,
 * session_held_by_background, ...). Only an unnamed failure while resuming
 * (e.g. "No conversation found with session ID") means the session itself
 * cannot be resumed; anything else must keep the session and surface the
 * error instead of silently starting a fresh conversation.
 */
export function classifyPreInitErrorResult(input: {
  resuming: boolean;
  result: Record<string, unknown>;
}): PreInitResultDisposition {
  const reason =
    typeof input.result.startup_failure_reason === 'string' &&
    input.result.startup_failure_reason
      ? input.result.startup_failure_reason
      : undefined;
  if (input.resuming && !reason) return { kind: 'resume_failed' };
  const errors = Array.isArray(input.result.errors)
    ? input.result.errors.filter(
        (error): error is string => typeof error === 'string' && !!error,
      )
    : [];
  const subtype =
    typeof input.result.subtype === 'string' ? input.result.subtype : 'error';
  return {
    kind: 'startup_failed',
    ...(reason ? { reason } : {}),
    message: `Claude Code failed to start${reason ? ` (${reason})` : ''}: ${
      errors.join('; ') || subtype
    }`,
  };
}
