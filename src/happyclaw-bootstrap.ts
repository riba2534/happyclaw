export interface HappyClawBootstrapTurn {
  turnId?: string;
  isHome: boolean;
  isDefaultProfile: boolean;
}

/**
 * Restrict the one-shot first-wake ritual to a turn of the built-in
 * HappyClaw in Home. Process warmups have no turnId; custom Agents and
 * non-Home workspaces are always excluded. The caller still requires the
 * turn to be the owner's own (never an automation run).
 */
export function isHappyClawBootstrapTurn(
  input: HappyClawBootstrapTurn,
): boolean {
  return Boolean(input.turnId && input.isHome && input.isDefaultProfile);
}

export interface HappyClawOwnerProfileRuntime {
  isHome: boolean;
  isDefaultProfile: boolean;
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
}

/**
 * Any conversation session of Home running the built-in HappyClaw has the
 * capability. Per-turn data and mutations remain host-authorized; task and
 * spawn runtimes never receive it.
 */
export function isHappyClawOwnerProfileRuntimeStructurallyEligible(
  input: HappyClawOwnerProfileRuntime,
): boolean {
  return (
    input.isHome &&
    input.isDefaultProfile &&
    input.runtimeAgentKind === 'conversation'
  );
}
