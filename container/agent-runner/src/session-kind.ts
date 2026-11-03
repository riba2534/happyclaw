import type { ContainerInput } from './types.js';

/**
 * What a session is, which decides its work tools and its prompt sections.
 * A team role outranks the work mode (the host never sends both); a worker
 * of a delegated item is not a team worker.
 */
export type SessionKind =
  | 'single'
  | 'multi'
  | 'team-router'
  | 'team-worker'
  | 'delegated-worker';

export function sessionKind(
  input: Pick<ContainerInput, 'teamRole' | 'workMode'>,
): SessionKind {
  const { teamRole } = input;
  if (!teamRole) return input.workMode === 'multi' ? 'multi' : 'single';
  if (teamRole.role === 'router') return 'team-router';
  return teamRole.origin === 'delegated' ? 'delegated-worker' : 'team-worker';
}
