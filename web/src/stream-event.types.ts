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
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'tool_result'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'task_start'
  | 'task_progress'
  | 'task_updated'
  | 'task_notification'
  | 'permission_denied'
  | 'memory_recall'
  | 'compact_boundary'
  | 'notification'
  | 'prompt_suggestion'
  | 'raw_sdk_event'
  | 'context_audit'
  | 'todo_update'
  | 'usage'
  | 'status'
  | 'init';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

export interface WorkflowPhaseSnapshot {
  index: number;
  title: string;
  detail?: string;
}

export interface WorkflowAgentSnapshot {
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  fallbackModel?: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

/** Persistable, user-facing projection of one Claude Code dynamic Workflow. */
export interface WorkflowRunSnapshot {
  taskId: string;
  runId?: string;
  workflowName?: string;
  summary: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  startTime?: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases: WorkflowPhaseSnapshot[];
  agents: WorkflowAgentSnapshot[];
}

export interface ClaudeContextFileAudit {
  sourcePath?: string;
  runtimePath?: string;
  status:
    | 'linked'
    | 'mounted'
    | 'missing'
    | 'shadowed'
    | 'unavailable'
    | 'unknown';
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
  name:
    | 'builtin'
    | 'external'
    | 'project'
    | 'managed'
    | 'workspace'
    | 'user'
    | 'plugin'
    | 'unknown';
  sourcePath?: string;
  runtimePath?: string;
  count?: number;
  tokens?: number;
}

export interface ClaudeContextSkillsAudit {
  totalSkills?: number;
  includedSkills?: number;
  tokens?: number;
  manifestHash?: string;
  selectedSkillIds?: string[];
  sources: ClaudeContextSkillsSourceAudit[];
}

export interface ClaudeContextPromptAudit {
  totalBytes: number;
  estimatedTokens?: number;
  planHash?: string;
  turnAnchor?: {
    provider: 'custom';
    maxChars: number;
    sourceChars: number;
    anchoredChars: number;
    truncated: boolean;
    estimatedTokens: number;
  };
  files: Array<{
    name: string;
    bytes: number;
    id?: string;
    version?: number;
    scope?: 'main' | 'subagent' | 'both';
    owner?: 'platform' | 'agent_profile' | 'workspace' | 'channel';
    required?: boolean;
    condition?: string;
    hash?: string;
    estimatedTokens?: number;
  }>;
}

export interface ClaudeSdkContextUsageAudit {
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: Array<
    Array<{
      color: string;
      isFilled: boolean;
      categoryName: string;
      tokens: number;
      percentage: number;
      squareFullness: number;
    }>
  >;
  model: string;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  deferredBuiltinTools?: Array<{
    name: string;
    tokens: number;
    isLoaded: boolean;
  }>;
  systemTools?: Array<{ name: string; tokens: number }>;
  systemPromptSections?: Array<{ name: string; tokens: number }>;
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{
      name: string;
      source: string;
      tokens: number;
    }>;
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: Array<{
      name: string;
      callTokens: number;
      resultTokens: number;
    }>;
    attachmentsByType: Array<{ name: string; tokens: number }>;
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

export interface ClaudeContextAudit {
  executionMode: 'host' | 'container';
  agentProfile?: {
    id: string;
    version: number;
    identityHash: string;
    runtimePolicyHash?: string;
  };
  cwd?: string;
  /** HappyClaw repository root used to distinguish platform memory from workspace memory. */
  projectRoot?: string;
  claudeConfigDir?: string;
  externalClaudeDir?: string;
  /** SDK memory exclusion patterns applied for this run. */
  claudeMdExcludes?: string[];
  claudeMd: ClaudeContextFileAudit;
  rules: ClaudeContextRulesAudit;
  nativeConfig?: {
    enabled: boolean;
    settingSources: Array<'user' | 'project' | 'local'>;
    entries: Array<{
      name: string;
      kind: 'file' | 'directory' | 'settings';
      sourcePath?: string;
      runtimePath?: string;
      status: 'linked' | 'mounted' | 'merged' | 'missing' | 'unavailable';
      entryCount?: number;
    }>;
  };
  skills: ClaudeContextSkillsAudit;
  mcp?: { manifestHash: string; serverIds: string[] };
  happyclawPrompt: ClaudeContextPromptAudit;
  sdkContextUsage?: ClaudeSdkContextUsageAudit;
  contextBudget?: {
    status: 'unavailable' | 'ok' | 'warning' | 'hard_exceeded';
    startupTokens?: number;
    totalTokens?: number;
    maxTokens?: number;
    warningThreshold?: number;
    hardThreshold?: number;
    warning?: string;
    error?: string;
  };
  subagentContract?: {
    enabled: boolean;
    hash: string;
    sdkCompatibility: string;
    cliCompatibility: string;
  };
  warnings: string[];
}

export interface StreamEvent {
  eventType: StreamEventType;
  /** Which runtime actor produced the event. */
  agentScope?: StreamAgentScope;
  /** Exact GroupQueue query attempt that produced this event. */
  queryRunId?: string;
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
  /** SDK task discriminant, e.g. `local_workflow` or `subagent`. */
  taskType?: string;
  /** Claude Code Workflow meta.name (only present for workflow tasks). */
  workflowName?: string;
  /** Live/completed dynamic Workflow projection for first-class UI rendering. */
  workflowRun?: WorkflowRunSnapshot;
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
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  /** Token usage data emitted at query completion */
  usage?: {
    /** Stable logical run ID used to make analytics and billing idempotent. */
    eventId?: string;
    /** Position inside one result's per-message ledger batch (0-based). */
    batchIndex?: number;
    batchCount?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        reasoningTokens: number;
        costUSD: number;
      }
    >;
  };
}
