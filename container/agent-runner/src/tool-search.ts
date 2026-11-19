import type { ContainerInput } from './types.js';

/**
 * Claude Code turns tool search on from ENABLE_TOOL_SEARCH, which any
 * settings file's `env` can set too. A connection's choice is pinned in the
 * flag settings' env, above the admin's, project and local settings: 'true'
 * where it is on, and 'false' where it is off, since Claude Code 2.1.304
 * and later turn it on by themselves behind a custom ANTHROPIC_BASE_URL.
 * Without a choice nothing is written.
 */
export function pinToolSearch<T extends { env: Record<string, string> }>(
  settings: T,
  toolSearch: ContainerInput['toolSearch'],
): T {
  return toolSearch === undefined
    ? settings
    : {
        ...settings,
        env: { ...settings.env, ENABLE_TOOL_SEARCH: String(toolSearch) },
      };
}
