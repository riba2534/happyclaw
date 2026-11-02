import type { ContainerInput } from './types.js';

/** Always pin the connection choice above native user/project/local settings. */
export function webFetchPreflightSettings(
  policy: ContainerInput['webFetchPreflightPolicy'],
): { skipWebFetchPreflight: boolean } {
  return { skipWebFetchPreflight: policy === 'skip' };
}
