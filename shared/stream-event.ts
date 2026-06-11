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
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress' | 'tool_result'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_start' | 'task_progress' | 'task_updated' | 'task_notification'
  | 'permission_denied' | 'memory_recall' | 'compact_boundary'
  | 'notification' | 'prompt_suggestion' | 'raw_sdk_event'
  | 'context_audit'
  | 'todo_update'
  | 'usage'
  | 'status' | 'init';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

export interface ClaudeContextFileAudit {
  sourcePath?: string;
  runtimePath?: string;
  status: 'linked' | 'mounted' | 'missing' | 'shadowed' | 'unavailable' | 'unknown';
  tokens?: number;
  loaded?: boolean;
}

export interface ClaudeContextRulesAudit {
  sourcePath?: string;
  runtimePath?: string;
  status: 'linked' | 'mounted' | 'missing' | 'unavailable' | 'unknown';
  fileCount: number;
  loadedFileCount?: number;
  loadedFiles?: Array<{ path: string; tokens?: number }>;
}

export interface ClaudeContextSkillsSourceAudit {
  name: 'builtin' | 'external' | 'project' | 'user' | 'plugin' | 'unknown';
  sourcePath?: string;
  runtimePath?: string;
  count?: number;
  tokens?: number;
}

export interface ClaudeContextSkillsAudit {
  totalSkills?: number;
  includedSkills?: number;
  tokens?: number;
  sources: ClaudeContextSkillsSourceAudit[];
}

export interface ClaudeContextPromptAudit {
  totalBytes: number;
  files: Array<{ name: string; bytes: number }>;
}

export interface ClaudeContextAudit {
  executionMode: 'host' | 'container';
  cwd?: string;
  claudeConfigDir?: string;
  externalClaudeDir?: string;
  claudeMd: ClaudeContextFileAudit;
  rules: ClaudeContextRulesAudit;
  skills: ClaudeContextSkillsAudit;
  happyclawPrompt: ClaudeContextPromptAudit;
  warnings: string[];
}

export interface StreamEvent {
  eventType: StreamEventType;
  /** Which runtime actor produced the event. */
  agentScope?: StreamAgentScope;
  /** Correlates all stream events for a single user turn. */
  turnId?: string;
  /** SDK session identifier if known. */
  sessionId?: string;
  /** SDK message uuid if known. */
  messageUuid?: string;
  /** Reserved — whether this event was synthesized locally rather than emitted directly by SDK semantics. */
  isSynthetic?: boolean;
  /** UI priority: primary is surfaced inline, detail in trace panels, debug in developer trace. */
  displayLevel?: StreamDisplayLevel;
  text?: string;
  title?: string;
  summary?: string;
  detail?: string;
  rawType?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  /** Tool execution result text (truncated + sanitized), carried on
   *  `tool_result` events so the card/Web can surface what a tool returned,
   *  aligning the trace with what Claude Code shows. */
  toolResult?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskPatch?: {
    status?: string;
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  subagentType?: string;
  lastToolName?: string;
  outputFile?: string;
  sdkTaskUsage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  permissionDenied?: {
    toolName: string;
    toolUseId: string;
    agentId?: string;
    reasonType?: string;
    reason?: string;
    message: string;
  };
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  rawEvent?: Record<string, unknown>;
  contextAudit?: ClaudeContextAudit;
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
}
