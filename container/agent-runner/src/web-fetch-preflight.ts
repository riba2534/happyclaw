import type { ContainerInput } from './types.js';

/**
 * Claude Code reads `skipWebFetchPreflight` only from settings. A connection
 * set to skip pins it above the admin's, project and local settings; without
 * it the key is left to them.
 */
export function webFetchPreflightSettings(
  policy: ContainerInput['webFetchPreflightPolicy'],
): { skipWebFetchPreflight?: true } {
  return policy === 'skip' ? { skipWebFetchPreflight: true } : {};
}
