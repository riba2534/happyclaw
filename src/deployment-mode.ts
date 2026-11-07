/**
 * Deployment mode: `multi_user` (today's behaviour: members, Docker
 * isolation, billing) or `single_user_host` (one person, every workspace runs
 * on the host, Docker is never used, multi-user surfaces are off).
 *
 * The setting is stored as configured (`''` = unset) and resolved here per
 * key: system setting, then `HAPPYCLAW_DEPLOYMENT_MODE`, then `multi_user`.
 * Callers read the effective switches below instead of rewriting the stored
 * `adminHostOnlyMode`, registration or billing settings, so switching back to
 * `multi_user` restores what was configured.
 */
import {
  DEPLOYMENT_MODES,
  getSystemSettings,
  type DeploymentMode,
} from './runtime-config.js';

export type { DeploymentMode };
export type DeploymentModeSource = 'settings' | 'env' | 'default';

export const DEPLOYMENT_MODE_ENV = 'HAPPYCLAW_DEPLOYMENT_MODE';
export const DEFAULT_DEPLOYMENT_MODE: DeploymentMode = 'multi_user';

export function parseDeploymentMode(value: unknown): DeploymentMode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return (DEPLOYMENT_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DeploymentMode)
    : null;
}

export interface DeploymentModeResolution {
  mode: DeploymentMode;
  source: DeploymentModeSource;
  /** The stored setting, or null when unset. */
  configured: DeploymentMode | null;
}

/** Pure: the mode a stored setting and an environment value resolve to. */
export function resolveDeploymentMode(input: {
  configured: string;
  env: string | undefined;
}): DeploymentModeResolution {
  const configured = parseDeploymentMode(input.configured);
  if (configured) return { mode: configured, source: 'settings', configured };
  const fromEnv = parseDeploymentMode(input.env);
  if (fromEnv) return { mode: fromEnv, source: 'env', configured: null };
  return { mode: DEFAULT_DEPLOYMENT_MODE, source: 'default', configured: null };
}

export function getDeploymentModeResolution(): DeploymentModeResolution {
  return resolveDeploymentMode({
    configured: getSystemSettings().deploymentMode,
    env: process.env[DEPLOYMENT_MODE_ENV],
  });
}

export function getDeploymentMode(): DeploymentMode {
  return getDeploymentModeResolution().mode;
}

export function isSingleUserHost(): boolean {
  return getDeploymentMode() === 'single_user_host';
}

/**
 * Admin-owned workspaces must run on the host: the stored admin host-only
 * switch, or single-user host mode (where every workspace is admin-owned).
 */
export function isAdminHostOnlyEffective(): boolean {
  return getSystemSettings().adminHostOnlyMode || isSingleUserHost();
}
