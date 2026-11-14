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
  /**
   * What the model said before it called a tool, as one passage in `text`.
   * Written by the host, never the Runner, and only for a proactive Workspace
   * that shows its whole process: its `text_delta` stays private there, so this
   * is the one way the narration between tool calls reaches the Web. Never the
   * text that ends a turn.
   */
  | 'commentary'
  | 'thinking_delta'
  /** The model opened a reasoning block, whether or not it returns any text. */
  | 'thinking_start'
  /** The reasoning block closed; `thinkingDurationMs` is the Runner's timing. */
  | 'thinking_end'
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

/**
 * What a tool did, as numbers and flags, read by the Runner from the SDK's
 * structured `tool_use_result`. Never a path, file content or model text, so a
 * UI can show "+12 −3" or "读取 120 行" without carrying the result itself.
 * Every field is optional: a tool fills what it knows. Declared identically in
 * shared/stream-event.ts and shared/stream-steps.ts (tests keep them equal).
 */
export interface ToolResultFacts {
  /** Lines an edit or write added / removed. */
  added?: number;
  removed?: number;
  /** A Write created the file (rather than updating it). */
  created?: boolean;
  /** Read: lines returned, and the file's total. */
  lines?: number;
  totalLines?: number;
  /** Glob / Grep: files and matches found. */
  files?: number;
  matches?: number;
  /** A failed command's exit code (parsed from `Exit code N`). */
  exitCode?: number;
  /** WebFetch: HTTP status and bytes received. */
  httpCode?: number;
  bytes?: number;
  /** WebSearch: searches made. */
  searches?: number;
  /** Duration the tool itself reported. */
  durationMs?: number;
  /** A sub-agent's totals, from the Task / Agent tool's result. */
  agent?: {
    toolUses?: number;
    reads?: number;
    searches?: number;
    edits?: number;
    commands?: number;
    added?: number;
    removed?: number;
    tokens?: number;
    durationMs?: number;
  };
}

export interface StreamEvent {
  eventType: StreamEventType;
  /** Which runtime actor produced the event. */
  agentScope?: StreamAgentScope;
  /** Exact GroupQueue query attempt that produced this event. */
  queryRunId?: string;
  /** Correlates all stream events for a single user turn. */
  turnId?: string;
  /** Immutable input identity for usage-to-answer correlation; IPC uses deliveryId. */
  inputTurnId?: string;
  /** SDK session identifier if known. */
  sessionId?: string;
  /** SDK message uuid if known. */
  messageUuid?: string;
  /** Reserved — whether this event was synthesized locally rather than emitted directly by SDK semantics. */
  isSynthetic?: boolean;
  /** UI priority: primary is surfaced inline, detail in trace panels, debug in developer trace. */
  displayLevel?: StreamDisplayLevel;
  text?: string;
  /**
   * `commentary` only: the passage is a progress statement the Agent sent with
   * send_message(delivery_role=progress) in a Web turn, not the narration
   * before a tool call. A proactive Workspace shows it at every process
   * visibility; narration only at `full`.
   */
  progress?: boolean;
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
  /** `tool_result` events: the SDK's own `is_error` flag. Authoritative; the
   *  "⚠️" prefix of `toolResult` is the older signal and misses a failure with
   *  no text. */
  toolIsError?: boolean;
  /** `tool_result` events: what the tool did, as numbers (see ToolResultFacts). */
  toolResultFacts?: ToolResultFacts;
  elapsedSeconds?: number;
  /** Wall-clock length of one reasoning block, set on `thinking_end`. */
  thinkingDurationMs?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  /** Final text answer of a finished sub-agent Task, captured by the runner
   *  from the sub-agent's own stream (bounded). Only set on
   *  `task_notification`; the host checkpoints it so a replayed turn can reuse
   *  finished sub-agent work instead of redoing it. Host-only: stripped
   *  before stream events reach the Web. */
  taskResult?: string;
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
  /** input_total is a complete per-input display snapshot, never a billable delta. */
  usageProjection?: 'input_total';
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
    /**
     * Output tokens of the streamed API calls and the time they spent
     * generating (message_start to the final message_delta, summed). Their
     * ratio is the generation speed; tool runs and prefill are excluded.
     */
    streamOutputTokens?: number;
    streamMs?: number;
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
