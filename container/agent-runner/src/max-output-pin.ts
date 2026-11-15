import type { ContainerInput } from './types.js';

/**
 * The reply limit the host derived from the launch's models goes into the
 * flag settings' env, above the admin's, project and local settings: a
 * settings file that raises CLAUDE_CODE_MAX_OUTPUT_TOKENS would otherwise
 * ask a model for longer replies than it declares, which its upstream may
 * refuse. Without a derived value nothing is written, so an admin's or a
 * workspace's own value still applies where HappyClaw has no say.
 */
export function pinMaxOutputTokens<T extends { env: Record<string, string> }>(
  settings: T,
  maxOutputTokens: ContainerInput['maxOutputTokens'],
): T {
  return typeof maxOutputTokens === 'number' &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxOutputTokens > 0
    ? {
        ...settings,
        env: {
          ...settings.env,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
        },
      }
    : settings;
}
