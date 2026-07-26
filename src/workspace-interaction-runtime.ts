import type { InteractionMode } from './types.js';

export type PublicAgentKind = 'main' | 'conversation' | 'spawn';

/**
 * Workspace interaction mode applies only to public, user-facing Agent loops.
 * Scheduled work and fire-and-forget spawn Agents retain the legacy contract.
 */
export function resolveRuntimeInteractionMode(
  workspaceMode: InteractionMode | null | undefined,
  input: {
    agentKind: PublicAgentKind;
    scheduledTask?: boolean;
  },
): InteractionMode {
  if (input.scheduledTask || input.agentKind === 'spawn') return 'assistant';
  return workspaceMode === 'proactive' ? 'proactive' : 'assistant';
}

export function publishesFrameworkAnswer(mode: InteractionMode): boolean {
  return mode === 'assistant';
}

/**
 * A successful Proactive runner output is lifecycle/control-plane data only.
 *
 * This deliberately includes interim background-task results and the
 * session-only success emitted by the runner's SIGTERM handler. Neither has
 * to carry `inputTurnCompleted`, and allowing either to reach the primary
 * answer coordinator can resurrect hidden SDK text into a Web `sdk_final`.
 */
export function isProactiveControlPlaneSuccess(input: {
  mode: InteractionMode;
  status: 'success' | 'error' | 'stream' | 'closed';
  providerFailure?: boolean;
}): boolean {
  return (
    input.mode === 'proactive' &&
    input.status === 'success' &&
    !input.providerFailure
  );
}

/**
 * Only Assistant-mode SDK finals participate in primary-answer recovery.
 * Proactive speech is already durable at the native send_message boundary.
 */
export function shouldResolveFrameworkPrimaryAnswer(input: {
  mode: InteractionMode;
  status: 'success' | 'error' | 'stream' | 'closed';
  sourceKind?: string | null;
  providerFailure?: boolean;
}): boolean {
  return (
    publishesFrameworkAnswer(input.mode) &&
    input.status === 'success' &&
    !input.providerFailure &&
    (input.sourceKind ?? 'sdk_final') === 'sdk_final'
  );
}

/**
 * Assistant turns require a healthy SDK terminal plus a physical reply ACK.
 * Proactive turns may intentionally stay silent; once an utterance was delivered,
 * a later runner error must not replay the user's input and duplicate it.
 */
export function isInteractionTurnSettled(input: {
  mode: InteractionMode;
  healthyInputTurnCompleted: boolean;
  utteranceDelivered: boolean;
}): boolean {
  return input.mode === 'proactive'
    ? input.healthyInputTurnCompleted || input.utteranceDelivered
    : input.healthyInputTurnCompleted && input.utteranceDelivered;
}

export function usesNativeMessagePresentation(mode: InteractionMode): boolean {
  return mode === 'proactive';
}

export function buildInteractionTextOutboxPayload(
  text: string,
  presentation?: 'default' | 'native',
): { text: string; presentation?: 'native' } {
  return presentation === 'native'
    ? { text, presentation: 'native' }
    : { text };
}

export interface FrozenIpcInteractionMode {
  mode: InteractionMode;
  valid: boolean;
  legacyDefaulted: boolean;
}

/**
 * IPC delivery must use the contract frozen by the runner when the file was
 * written. A later workspace setting change cannot reinterpret an old side
 * effect. Missing values are legacy assistant payloads; malformed values fail
 * validation. Scheduled and spawn outputs are always assistant semantics.
 */
export function resolveFrozenIpcInteractionMode(
  value: unknown,
  input: {
    scheduledTask: boolean;
    spawnAgent: boolean;
  },
): FrozenIpcInteractionMode {
  const legacyDefaulted = value === undefined;
  const valid =
    legacyDefaulted ||
    value === 'assistant' ||
    value === 'proactive' ||
    value === 'persona';
  const payloadMode: InteractionMode =
    value === 'proactive' || value === 'persona' ? 'proactive' : 'assistant';
  return {
    mode: input.scheduledTask || input.spawnAgent ? 'assistant' : payloadMode,
    valid,
    legacyDefaulted,
  };
}

/**
 * Proactive mode exposes only lifecycle boundaries required to start/stop the
 * public spinner. Model thoughts, tools, usage, workflows and free-form status
 * narration remain private.
 */
export function shouldBroadcastSdkStreamEvent(
  mode: InteractionMode,
  event: { eventType: string; statusText?: string | null },
): boolean {
  if (mode === 'assistant') return true;
  if (event.eventType !== 'status') return false;
  return (
    event.statusText === 'requesting' ||
    event.statusText === 'idle' ||
    event.statusText === 'interrupted'
  );
}

export const PROACTIVE_TAIL_INTERRUPTION_NOTICE =
  '⚠️ 本轮处理在已发送部分消息后异常中断。为避免重复发言，系统没有自动重放；上面的内容可能不完整，请重新询问以继续。';

export function shouldSendProactiveTailInterruptionNotice(input: {
  mode: InteractionMode;
  utteranceDelivered: boolean;
  runnerFailed: boolean;
}): boolean {
  return (
    input.mode === 'proactive' && input.utteranceDelivered && input.runnerFailed
  );
}
