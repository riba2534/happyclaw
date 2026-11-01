import type { InteractionMode, ProcessVisibility } from './types.js';
import type { StreamEvent } from './stream-event.types.js';

export type PublicAgentKind = 'conversation' | 'spawn';

/**
 * Workspace interaction mode applies only to public, user-facing Agent loops.
 * Fire-and-forget spawn Agents retain the legacy contract.
 */
export function resolveRuntimeInteractionMode(
  workspaceMode: InteractionMode | null | undefined,
  input: {
    agentKind: PublicAgentKind;
  },
): InteractionMode {
  if (input.agentKind === 'spawn') return 'assistant';
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
  metadata?: {
    deliveryRole?: 'progress' | 'final' | 'separate' | null;
    inputTurnId?: string | null;
    logicalChatJid?: string | null;
  },
): {
  text: string;
  presentation?: 'native';
  deliveryRole?: 'progress' | 'final' | 'separate';
  inputTurnId?: string;
  logicalChatJid?: string;
} {
  return {
    text,
    ...(presentation === 'native' ? { presentation: 'native' as const } : {}),
    ...(metadata?.deliveryRole ? { deliveryRole: metadata.deliveryRole } : {}),
    ...(metadata?.inputTurnId ? { inputTurnId: metadata.inputTurnId } : {}),
    ...(metadata?.logicalChatJid
      ? { logicalChatJid: metadata.logicalChatJid }
      : {}),
  };
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
 * validation. Spawn outputs are always assistant semantics.
 */
export function resolveFrozenIpcInteractionMode(
  value: unknown,
  input: {
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
    mode: input.spawnAgent ? 'assistant' : payloadMode,
    valid,
    legacyDefaulted,
  };
}

/** Status texts that only mark a run's lifecycle, never carry news. */
const LIFECYCLE_STATUS_TEXTS: ReadonlySet<string> = new Set([
  'requesting',
  'idle',
  'interrupted',
]);

/**
 * What a proactive Workspace may show of a turn's process beside the spinner,
 * by event type. `activity` is the structure of the work (tools, sub-agents,
 * todos, hooks, phase); `full` adds the reasoning summary. These sets name
 * what is allowed: every other event type, including any a newer Runner
 * invents, is withheld.
 */
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool_use_start',
  'tool_use_end',
  'tool_progress',
  'tool_result',
  'task_start',
  'task_progress',
  'task_updated',
  'task_notification',
  'todo_update',
  'hook_started',
  'hook_progress',
  'hook_response',
  'permission_denied',
  'compact_boundary',
  'thinking_start',
  'thinking_end',
]);

/**
 * Tools whose input is a message the Agent sends the user. In a proactive
 * Workspace that message is delivered as a chat message of its own, so the
 * process view must not carry it a second time.
 */
const MESSAGE_DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__happyclaw__send_message',
]);

/**
 * Tools whose structured result is a workspace-memory receipt (`{ result, id, title }`)
 * rather than arbitrary tool output or model prose.
 */
export const MEMORY_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__happyclaw__workspace_memory_remember',
  'mcp__happyclaw__workspace_memory_update',
]);

/**
 * The ids of memory write calls seen starting, newest last. A tool's result
 * does not name its tool, only its call, so this is how a result is known to
 * be a memory receipt: what any other tool returned, whatever it looks like,
 * is withheld. Call ids are unique, so one bounded set serves every run.
 */
const memoryWriteCalls = new Set<string>();
const MAX_MEMORY_WRITE_CALLS = 256;

function noteMemoryWriteCall(event: StreamEvent): void {
  if (
    event.eventType !== 'tool_use_start' ||
    !event.toolUseId ||
    !isMemoryWriteTool(event.toolName) ||
    memoryWriteCalls.has(event.toolUseId)
  ) {
    return;
  }
  if (memoryWriteCalls.size >= MAX_MEMORY_WRITE_CALLS) {
    const oldest = memoryWriteCalls.values().next().value;
    if (oldest !== undefined) memoryWriteCalls.delete(oldest);
  }
  memoryWriteCalls.add(event.toolUseId);
}

function isLifecycleStatus(statusText: string | null | undefined): boolean {
  return statusText != null && LIFECYCLE_STATUS_TEXTS.has(statusText);
}

/** Whether `toolName` is the tool a proactive Agent speaks to the user through. */
export function isMessageDeliveryTool(toolName: string | undefined): boolean {
  return !!toolName && MESSAGE_DELIVERY_TOOL_NAMES.has(toolName);
}

/** Whether `toolName` is a workspace memory write tool that leaves a receipt. */
export function isMemoryWriteTool(toolName: string | undefined): boolean {
  return !!toolName && MEMORY_WRITE_TOOL_NAMES.has(toolName);
}

function keepsMemoryWriteReceipt(event: StreamEvent): boolean {
  if (event.eventType !== 'tool_result' || event.toolIsError) return false;
  if (event.toolName) return isMemoryWriteTool(event.toolName);
  return !!event.toolUseId && memoryWriteCalls.has(event.toolUseId);
}

/**
 * A copy of `event` without the fields that carry the model's own words.
 * Returns `event` itself when there is nothing to remove. Hook output and the
 * short SDK/Runner summaries of tasks stay: they describe the work, they are
 * not the model speaking.
 */
function withoutModelText(event: StreamEvent): StreamEvent {
  const stripped: StreamEvent = { ...event };
  let changed = false;
  const drop = (key: keyof StreamEvent): void => {
    if (stripped[key] !== undefined) {
      delete stripped[key];
      changed = true;
    }
  };
  // What a tool returned, what a sub-agent finally answered and the questions
  // an AskUserQuestion call would put to the user. Memory write receipts stay
  // so `memoryReceipts(steps)` can link to the written/proposed item.
  if (!keepsMemoryWriteReceipt(event)) {
    drop('toolResult');
  }
  drop('taskResult');
  drop('toolInput');
  // How much a tool did (lines, files, exit code) is read from the same
  // structured output as that text, so it is withheld with it until the owner
  // decides otherwise. `toolIsError` is a flag, not text, and stays: it is what
  // lets a failed call read as failed.
  drop('toolResultFacts');
  if (event.eventType === 'tool_result') drop('detail');
  // The prompt handed to a sub-agent rides on task_started.
  if (event.eventType === 'task_start') drop('detail');
  // The input of send_message is the reply the user already receives as a chat
  // message; summarizing it again would repeat it, as raw JSON, in the process.
  if (event.toolName && MESSAGE_DELIVERY_TOOL_NAMES.has(event.toolName)) {
    drop('toolInputSummary');
    drop('summary');
    drop('detail');
  }
  if (
    event.workflowRun?.agents.some((a) => a.promptPreview || a.resultPreview)
  ) {
    stripped.workflowRun = {
      ...event.workflowRun,
      agents: event.workflowRun.agents.map(
        ({ promptPreview: _prompt, resultPreview: _result, ...agent }) => agent,
      ),
    };
    changed = true;
  }
  return changed ? stripped : event;
}

/**
 * The part of a turn's stream a Workspace lets the Web see, or null for none.
 *
 * - Assistant Workspaces show their whole process: the event passes unchanged.
 * - A proactive Workspace's SDK output is private model-loop state, so what
 *   the Web may see depends on its process visibility. `hidden` keeps the run
 *   lifecycle only (requesting/idle/interrupted: the spinner). `activity` adds
 *   the structure of the work, stripped of any text the model produced.
 *   `full` also streams the main Agent's and sub-Agents' reasoning summary and
 *   the narration the model wrote before a tool call (`commentary`, which the
 *   host composes from the Runner's text_delta; see process-commentary.ts).
 *   A progress statement the Agent sent the user in a Web turn (a
 *   `commentary` marked `progress`) shows at every level, but only the host
 *   writes one (projectProgressForWeb): here the mark is dropped.
 * - Never, at any level: text_delta itself (the model's own answer text, which
 *   reaches the user only through send_message), usage, memory_recall,
 *   prompt_suggestion, raw_sdk_event, notification and unknown event types.
 *
 * Status events in this stream are written by the SDK, the Runner or the host,
 * never by the model (a proactive turn's progress statement is a `commentary`),
 * so beyond the lifecycle ones they are plain phase information and follow
 * `activity`.
 *
 * `context_audit` passes through at every level: broadcastStreamEvent records
 * it for the Agent's context explainability and never forwards it to a
 * WebSocket.
 */
export function projectSdkStreamEventForWeb(
  mode: InteractionMode,
  visibility: ProcessVisibility,
  event: StreamEvent,
): StreamEvent | null {
  if (mode === 'assistant') return event;
  noteMemoryWriteCall(event);
  const type = event.eventType;
  if (type === 'context_audit') return event;
  if (type === 'status') {
    if (isLifecycleStatus(event.statusText)) return event;
    return visibility === 'hidden' ? null : event;
  }
  // Only the host writes a progress statement (projectProgressForWeb, which
  // does not come through here). A Runner event that claims to be one is
  // narration like any other.
  if (type === 'commentary' && event.progress !== undefined) {
    const { progress: _progress, ...narration } = event;
    event = narration;
  }
  if (visibility === 'hidden') return null;
  // The reasoning summary and the narration before a tool call (written by the
  // host, see process-commentary.ts) are the model's words about its work.
  if (type === 'thinking_delta' || type === 'commentary') {
    return visibility === 'full' ? event : null;
  }
  if (!ACTIVITY_EVENT_TYPES.has(type)) return null;
  return withoutModelText(event);
}

/** Most of a progress statement kept on its step, as for narration. */
const MAX_PROGRESS_CHARS = 4000;

/**
 * What a progress statement the Agent wrote becomes once its own turn takes
 * it in (`send_message` with `delivery_role=progress`, staged by the output
 * router): `step` is the commentary the turn's trace records (the tracker
 * applies the Workspace's limits), `web` the events the Web is sent now.
 *
 * An Assistant turn shows the statement as a commentary step and as the run's
 * status line. A proactive turn shows it as a commentary step marked
 * `progress` at every process visibility: it is the Agent speaking to the
 * user, not detail of the process, and the Web folds it into the process once
 * the final lands.
 *
 * `turn.turnId` is the id the turn's Runner events carry (a warm turn's own,
 * not its input's): the Web starts a new card on a change of it, so a
 * proactive step carries the same one to land on the card it belongs to.
 */
export function projectProgressForWeb(
  mode: InteractionMode,
  text: string,
  turn: { inputTurnId: string; turnId?: string; sessionId?: string },
): { step: StreamEvent; web: StreamEvent[] } {
  const step: StreamEvent = {
    eventType: 'commentary',
    agentScope: 'main',
    text: text.slice(0, MAX_PROGRESS_CHARS),
    // An Assistant turn keeps the input's id it always had.
    turnId:
      mode === 'proactive'
        ? (turn.turnId ?? turn.inputTurnId)
        : turn.inputTurnId,
    inputTurnId: turn.inputTurnId,
    sessionId: turn.sessionId,
    ...(mode === 'proactive' ? { progress: true } : {}),
  };
  if (mode === 'proactive') return { step, web: [step] };
  // An Assistant turn shows everything (the gate passes it unchanged).
  return {
    step,
    web: [
      step,
      {
        eventType: 'status',
        agentScope: 'system',
        statusText: text.slice(0, 160),
        summary: text.slice(0, 500),
        isSynthetic: true,
        displayLevel: 'primary',
        turnId: step.turnId,
        inputTurnId: turn.inputTurnId,
        sessionId: turn.sessionId,
      },
    ],
  };
}

/**
 * Whether the Web is told about sub-agent task lifecycle (agent_status) so its
 * Task tabs match the task events it receives.
 */
export function shouldBroadcastTaskAgentStatus(
  mode: InteractionMode,
  visibility: ProcessVisibility,
): boolean {
  return mode === 'assistant' || visibility !== 'hidden';
}

/** How a proactive turn that sent progress ended without a reply. */
export type ProactiveTurnEnding = 'stopped' | 'steered' | 'failed';

/**
 * The reply a proactive Web turn that sent progress is given when it ends
 * without one of its own: the turn's process, with that progress, hangs on it
 * as on any reply, so the progress stays with the turn after a refresh (an IM
 * turn's progress is a message of its own already).
 */
export function proactiveClosingNote(ending: ProactiveTurnEnding): string {
  switch (ending) {
    case 'stopped':
      return '已停止。';
    case 'steered':
      return '已转向新的消息。';
    case 'failed':
      return '⚠️ 本轮在给出最终回复前中断，已发出的进展在“处理过程”里。';
  }
}

export const PROACTIVE_TAIL_INTERRUPTION_NOTICE =
  '⚠️ 本轮处理在已发送部分消息后异常中断。为避免重复发言，系统没有自动重放；上面的内容可能不完整，请重新询问以继续。';

export function shouldSendProactiveTailInterruptionNotice(input: {
  mode: InteractionMode;
  utteranceDelivered: boolean;
  runnerFailed: boolean;
  healthyInputTurnCompleted: boolean;
}): boolean {
  return (
    input.mode === 'proactive' &&
    input.utteranceDelivered &&
    input.runnerFailed &&
    !input.healthyInputTurnCompleted
  );
}
