import { getProviderById } from './runtime-config.js';

/**
 * The policy the Runner pins, read from the connection selected for this
 * launch. Only `skip` is pinned; a connection left at the default and a
 * launch on the workspace's own Provider env follow Claude Code's settings.
 */
export function resolveProviderWebFetchPreflightPolicy(
  providerId: string | null,
): 'skip' | undefined {
  return providerId
    ? getProviderById(providerId)?.webFetchPreflightPolicy
    : undefined;
}
