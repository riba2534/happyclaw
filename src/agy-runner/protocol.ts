import type { StreamEvent } from '../stream-event.types.js';

export const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolError {
  type?: string;
  message?: string;
}

export interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: AgyToolError;
}

export interface AgySubagentItem {
  type_name?: string;
  role?: string;
  conversation_id?: string;
  log_uri?: string;
  workspace_uris?: string[];
}

export interface AgySubagentInfo {
  subagents?: AgySubagentItem[];
}

export interface AgyInitPayload {
  model?: string;
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  agent?: string;
}

export interface AgyStepUpdatePayload {
  conversation_id?: string;
  step_index?: number;
  state?: 'ACTIVE' | 'DONE' | 'ERROR' | string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: AgyToolInfo;
  subagent_info?: AgySubagentInfo;
}

export interface AgyResultPayload {
  conversation_id?: string;
  status?:
    | 'SUCCESS'
    | 'ERROR'
    | 'CANCELED'
    | 'INTERRUPTED'
    | 'INVALID'
    | 'WAITING'
    | 'RUNNING'
    | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  denied_actions?: Array<{ action?: string; display_name?: string }>;
  finished_reason?: string;
}

export interface AgyStreamEvent {
  event: 'init' | 'step_update' | 'result' | string;
  conversation_id?: string;
  init?: AgyInitPayload;
  step_update?: AgyStepUpdatePayload;
  result?: AgyResultPayload;
}

export interface AgyRunnerOutputFrame {
  status: 'success' | 'error' | 'stream';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  queryRunId?: string;
  turnId?: string;
  inputTurnId?: string;
  inputTurnCompleted?: boolean;
  queryIdle?: boolean;
  ipcReceipts?: unknown[];
}

export interface AgyTurnCorrelation {
  queryRunId?: string;
  turnId?: string;
  inputTurnId?: string;
  ipcReceipts?: unknown[];
}

export function formatAgyUserEvent(content: string): string {
  return `${JSON.stringify({ event: 'user', message: { content } })}\n`;
}

function summarizeToolInput(
  toolName: string,
  params?: Record<string, unknown>,
): string | undefined {
  if (!params) return undefined;
  const preferredKeys = [
    'CommandLine',
    'command',
    'Path',
    'path',
    'AbsolutePath',
    'TargetFile',
    'Query',
    'query',
    'SearchPath',
    'DirectoryPath',
    'Url',
    'url',
  ];
  for (const key of preferredKeys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim().slice(0, 200);
    }
  }
  const serialized = JSON.stringify(params);
  if (!serialized || serialized === '{}') return toolName;
  return serialized.slice(0, 200);
}

function truncateToolResult(text: string, maxLen = 2000): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

/**
 * Stateful translator from `agy --output-format stream-json` NDJSON events to
 * HappyClaw `ContainerOutput` frames.
 */
export class AgyStreamTranslator {
  private sessionId?: string;
  private model?: string;
  private readonly startedToolSteps = new Set<number>();
  private readonly startedSubagents = new Set<string>();
  private correlation: AgyTurnCorrelation = {};

  constructor(initialSessionId?: string, initialModel?: string) {
    this.sessionId = initialSessionId;
    this.model = initialModel;
  }

  setTurnCorrelation(correlation: AgyTurnCorrelation): void {
    this.correlation = { ...correlation };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  private baseStreamFields(): Pick<
    StreamEvent,
    'agentScope' | 'queryRunId' | 'turnId' | 'inputTurnId' | 'sessionId'
  > {
    return {
      agentScope: 'main',
      ...(this.correlation.queryRunId
        ? { queryRunId: this.correlation.queryRunId }
        : {}),
      ...(this.correlation.turnId ? { turnId: this.correlation.turnId } : {}),
      ...(this.correlation.inputTurnId
        ? { inputTurnId: this.correlation.inputTurnId }
        : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  translateLine(line: string): AgyRunnerOutputFrame[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];

    let parsed: AgyStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as AgyStreamEvent;
    } catch {
      return [];
    }
    return this.translateEvent(parsed);
  }

  translateEvent(evt: AgyStreamEvent): AgyRunnerOutputFrame[] {
    if (evt.conversation_id) {
      this.sessionId = evt.conversation_id;
    }

    if (evt.event === 'init') {
      if (evt.init?.model) {
        this.model = evt.init.model;
      }
      return [
        {
          status: 'stream',
          result: null,
          ...(this.sessionId ? { newSessionId: this.sessionId } : {}),
          ...(this.correlation.queryRunId
            ? { queryRunId: this.correlation.queryRunId }
            : {}),
          streamEvent: {
            ...this.baseStreamFields(),
            eventType: 'init',
            statusText: this.model ? `agy (${this.model})` : 'agy',
          },
        },
      ];
    }

    if (evt.event === 'step_update' && evt.step_update) {
      return this.translateStepUpdate(evt.step_update);
    }

    if (evt.event === 'result' && evt.result) {
      return this.translateResult(evt.result);
    }

    return [];
  }

  private translateStepUpdate(
    step: AgyStepUpdatePayload,
  ): AgyRunnerOutputFrame[] {
    if (step.conversation_id) {
      this.sessionId = step.conversation_id;
    }

    const frames: AgyRunnerOutputFrame[] = [];
    const base = this.baseStreamFields();
    const queryRunId = this.correlation.queryRunId;

    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
        frames.push({
          status: 'stream',
          result: null,
          ...(queryRunId ? { queryRunId } : {}),
          streamEvent: {
            ...base,
            eventType: 'text_delta',
            text: step.text_delta,
          },
        });
      }
      return frames;
    }

    if (step.step_type === 'tool') {
      const stepIdx = step.step_index ?? 0;
      const toolUseId = `agy-step-${stepIdx}`;
      const toolName = step.tool_name || step.tool_info?.name || 'tool';
      const params = step.tool_info?.parameters;

      if (!this.startedToolSteps.has(stepIdx)) {
        this.startedToolSteps.add(stepIdx);
        frames.push({
          status: 'stream',
          result: null,
          ...(queryRunId ? { queryRunId } : {}),
          streamEvent: {
            ...base,
            eventType: 'tool_use_start',
            toolName,
            toolUseId,
            toolInputSummary: summarizeToolInput(toolName, params),
            ...(params ? { toolInput: params } : {}),
          },
        });
      }

      if (step.state === 'DONE' || step.state === 'ERROR') {
        const isError = step.state === 'ERROR' || !!step.tool_info?.error;
        const rawOutput = isError
          ? step.tool_info?.error?.message ||
            step.tool_info?.output ||
            'Tool execution failed'
          : step.tool_info?.output || '';

        frames.push({
          status: 'stream',
          result: null,
          ...(queryRunId ? { queryRunId } : {}),
          streamEvent: {
            ...base,
            eventType: 'tool_use_end',
            toolName,
            toolUseId,
            ...(typeof step.duration_seconds === 'number'
              ? { elapsedSeconds: step.duration_seconds }
              : {}),
          },
        });

        frames.push({
          status: 'stream',
          result: null,
          ...(queryRunId ? { queryRunId } : {}),
          streamEvent: {
            ...base,
            eventType: 'tool_result',
            toolName,
            toolUseId,
            toolIsError: isError,
            toolResult: truncateToolResult(rawOutput),
            ...(typeof step.duration_seconds === 'number'
              ? { elapsedSeconds: step.duration_seconds }
              : {}),
          },
        });
      }
      return frames;
    }

    if (step.subagent_info?.subagents?.length) {
      for (const sub of step.subagent_info.subagents) {
        const taskId =
          sub.conversation_id ||
          `agy-subagent-${step.step_index ?? 0}-${sub.role || 'worker'}`;
        if (!this.startedSubagents.has(taskId)) {
          this.startedSubagents.add(taskId);
          frames.push({
            status: 'stream',
            result: null,
            ...(queryRunId ? { queryRunId } : {}),
            streamEvent: {
              ...base,
              eventType: 'task_start',
              taskId,
              taskType: 'subagent',
              subagentType: sub.type_name,
              taskDescription: sub.role || sub.type_name || 'Subagent',
            },
          });
        }
      }
    }

    return frames;
  }

  private translateResult(result: AgyResultPayload): AgyRunnerOutputFrame[] {
    if (result.conversation_id) {
      this.sessionId = result.conversation_id;
    }

    const frames: AgyRunnerOutputFrame[] = [];
    const base = this.baseStreamFields();
    const queryRunId = this.correlation.queryRunId;

    if (result.usage) {
      const inputTokens = result.usage.input_tokens ?? 0;
      const outputTokens = result.usage.output_tokens ?? 0;
      const cacheReadInputTokens = result.usage.cache_read_tokens ?? 0;
      const reasoningTokens = result.usage.thinking_tokens ?? 0;
      const durationMs = Math.round((result.duration_seconds ?? 0) * 1000);
      const numTurns = result.num_turns ?? 1;

      frames.push({
        status: 'stream',
        result: null,
        ...(queryRunId ? { queryRunId } : {}),
        streamEvent: {
          ...base,
          eventType: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            cacheReadInputTokens,
            cacheCreationInputTokens: 0,
            reasoningTokens,
            costUSD: 0,
            durationMs,
            numTurns,
            ...(this.model
              ? {
                  modelUsage: {
                    [this.model]: {
                      inputTokens,
                      outputTokens,
                      cacheReadInputTokens,
                      cacheCreationInputTokens: 0,
                      reasoningTokens,
                      costUSD: 0,
                    },
                  },
                }
              : {}),
          },
        },
      });
    }

    const isSuccess = result.status === 'SUCCESS';
    let responseText = result.response ?? '';
    if (
      isSuccess &&
      !responseText &&
      Array.isArray(result.denied_actions) &&
      result.denied_actions.length > 0
    ) {
      const names = result.denied_actions
        .map((d) => d.display_name || d.action || 'tool')
        .join(', ');
      responseText = `AGY 工具权限被拒绝：${names}`;
    }

    const receiptFields =
      this.correlation.ipcReceipts && this.correlation.ipcReceipts.length > 0
        ? { ipcReceipts: this.correlation.ipcReceipts }
        : {};
    const turnFields = {
      ...(this.correlation.turnId ? { turnId: this.correlation.turnId } : {}),
      ...(this.correlation.inputTurnId
        ? { inputTurnId: this.correlation.inputTurnId }
        : {}),
      ...receiptFields,
    };

    if (isSuccess) {
      frames.push({
        status: 'success',
        result: responseText || null,
        ...(this.sessionId ? { newSessionId: this.sessionId } : {}),
        ...(queryRunId ? { queryRunId } : {}),
        ...turnFields,
        inputTurnCompleted: true,
        queryIdle: true,
      });
    } else {
      const errorMsg =
        result.error ||
        `AGY turn ended with status: ${result.status || 'ERROR'}`;
      frames.push({
        status: 'error',
        result: null,
        error: errorMsg,
        ...(this.sessionId ? { newSessionId: this.sessionId } : {}),
        ...(queryRunId ? { queryRunId } : {}),
        ...turnFields,
        inputTurnCompleted: true,
        queryIdle: true,
      });
    }

    return frames;
  }
}
