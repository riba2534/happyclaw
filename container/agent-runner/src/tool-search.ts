import type { ContainerInput } from './types.js';

/**
 * Claude Code turns tool search on from ENABLE_TOOL_SEARCH, which any
 * settings file's `env` can set too. A connection that turns it on pins
 * 'true' in the flag settings' env, above the admin's, project and local
 * settings. Without it nothing is written: a pinned 'false' would undo a
 * settings file that turns it on.
 */
export function pinToolSearch<T extends { env: Record<string, string> }>(
  settings: T,
  toolSearch: ContainerInput['toolSearch'],
): T {
  return toolSearch === true
    ? { ...settings, env: { ...settings.env, ENABLE_TOOL_SEARCH: 'true' } }
    : settings;
}
