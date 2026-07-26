import type { GroupInfo, InteractionMode } from '../types';

export const DEFAULT_INTERACTION_MODE: InteractionMode = 'assistant';

export function normalizeInteractionMode(value: unknown): InteractionMode {
  return value === 'proactive' || value === 'persona'
    ? 'proactive'
    : DEFAULT_INTERACTION_MODE;
}

export function normalizeGroupInteractionMode(group: GroupInfo): GroupInfo {
  return {
    ...group,
    interaction_mode: normalizeInteractionMode(group.interaction_mode),
  };
}

export function shouldShowStreamingPartialText(
  interactionMode: InteractionMode,
): boolean {
  return interactionMode === 'assistant';
}
