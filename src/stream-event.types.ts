/**
 * Canonical StreamEvent type definitions.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - container/agent-runner/src/stream-event.types.ts
 *   - src/stream-event.types.ts
 *   - web/src/stream-event.types.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make build`.
 */

export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'assistant_text_boundary'
  | 'sub_agent_result'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_start' | 'task_notification'
  | 'todo_update'
  | 'usage'
  | 'status' | 'init';

export interface StreamEvent {
  eventType: StreamEventType;
  /** Runtime that produced this event. Used for runtime-specific presentation. */
  runtime?: 'claude' | 'codex';
  /** Correlates all stream events for a single user turn. */
  turnId?: string;
  /** SDK session identifier if known. */
  sessionId?: string;
  /** SDK message uuid if known. */
  messageUuid?: string;
  /** Reserved — whether this event was synthesized locally rather than emitted directly by SDK semantics. */
  isSynthetic?: boolean;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** Token usage data emitted at query completion */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }>;
  };
  /** Previous assistant text segment (before a new top-level assistant message). */
  segmentText?: string;
  /** Sub-agent (Task/Agent tool) execution result extracted from tool_result block. */
  subAgentResult?: {
    toolUseId: string;
    description: string;
    summary: string;
    text: string;
  };
}
