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

/**
 * The process environment's ENABLE_TOOL_SEARCH for a launch behind a custom
 * ANTHROPIC_BASE_URL that does not turn tool search on: 'false', unless the
 * environment already sets it. Claude Code 2.1.304 and later turn tool
 * search on there by themselves, which 2.1.296 did not. The process
 * environment is the lowest layer, so a connection's or the Workspace's own
 * env and every settings file still decide as they did.
 */
export function defaultToolSearchEnv(
  env: Readonly<Record<string, string | undefined>>,
  endpointKind: 'official' | 'custom',
  toolSearch: ContainerInput['toolSearch'],
): { ENABLE_TOOL_SEARCH?: 'false' } {
  return endpointKind === 'custom' && !toolSearch && !env.ENABLE_TOOL_SEARCH
    ? { ENABLE_TOOL_SEARCH: 'false' }
    : {};
}
