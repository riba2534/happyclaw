import {
  getProviderById,
  type WebFetchPreflightPolicy,
} from './runtime-config.js';

/** Unset policies and launches without a saved connection enable the check. */
export function resolveProviderWebFetchPreflightPolicy(
  providerId: string | null,
): WebFetchPreflightPolicy {
  return providerId
    ? (getProviderById(providerId)?.webFetchPreflightPolicy ?? 'check')
    : 'check';
}
