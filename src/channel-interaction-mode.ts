import type { ChannelMount, InteractionMode } from './types.js';
import {
  resolveRuntimeInteractionMode,
  type PublicAgentKind,
} from './workspace-interaction-runtime.js';

/** Only a persisted source mount belonging to this workspace can override its default. */
export function resolveSourceInteractionMode(
  input: {
    workspaceFolder: string;
    workspaceMode: InteractionMode;
    sourceJid?: string | null;
    agentKind: PublicAgentKind;
    scheduledTask?: boolean;
  },
  deps: {
    getMount: (sourceJid: string) => ChannelMount | undefined;
    getWorkspaceFolder: (workspaceJid: string) => string | undefined;
  },
): InteractionMode {
  const mount = input.sourceJid ? deps.getMount(input.sourceJid) : undefined;
  const override =
    mount &&
    deps.getWorkspaceFolder(mount.workspace_jid) === input.workspaceFolder
      ? mount.interaction_mode_override
      : null;
  return resolveRuntimeInteractionMode(override ?? input.workspaceMode, input);
}

/** A runner's prompt/output authority is fixed; retain every incompatible suffix for the next run. */
export function selectSourceInteractionModePrefix<T>(
  messages: readonly T[],
  modeFor: (message: T) => InteractionMode,
  defaultMode: InteractionMode,
): {
  messages: T[];
  interactionMode: InteractionMode;
  hasDeferredMessages: boolean;
} {
  const interactionMode = messages.length ? modeFor(messages[0]) : defaultMode;
  const boundary = messages.findIndex(
    (message) => modeFor(message) !== interactionMode,
  );
  const end = boundary < 0 ? messages.length : boundary;
  return {
    messages: messages.slice(0, end),
    interactionMode,
    hasDeferredMessages: end < messages.length,
  };
}

/** Legacy sessions predate mount overrides and therefore use their workspace/agent default. */
export function sessionInteractionModeChanged(input: {
  sessionId?: string | null;
  storedMode: InteractionMode | null;
  legacyMode: InteractionMode;
  requiredMode: InteractionMode;
}): boolean {
  return Boolean(
    input.sessionId &&
    (input.storedMode ?? input.legacyMode) !== input.requiredMode,
  );
}
