/**
 * StreamEventProcessor — encapsulates all streaming event processing logic
 * extracted from runQuery() in index.ts.
 *
 * Manages:
 * - Text/thinking buffering and flushing
 * - Tool use start/end tracking (top-level, nested, Skill, Task)
 * - Sub-agent message conversion to StreamEvents
 * - Cleanup of residual tool states
 */

import type { ContainerOutput, StreamEvent } from './types.js';
import {
  extractSkillName,
  shorten,
  summarizeToolInput,
  summarizeToolResult,
} from './utils.js';
import {
  workflowRunFromOutputFile,
  workflowRunFromTaskProgress,
  workflowRunFromToolInput,
} from './workflow-run.js';
import type { WorkflowRunSnapshot } from './stream-event.types.js';
import { BackgroundTaskDrainTracker } from './background-task-drain.js';

// SDK 任务终态（task_updated.patch.status 语义下"不会再有后续信号"的状态）。
// web/src/stores/chat.ts、src/web.ts、src/index.ts 各有等价映射——SDK 新增
// 终态时需同步检查；此处漏判的代价是 pendingSdkTasks 泄漏导致关流被永久推迟。
const SDK_TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/** Tools with specialized input_json_delta handling — generic accumulation is skipped for these. */
const SPECIAL_TOOLS = [
  'Skill',
  'Task',
  'Agent',
  'AskUserQuestion',
  'TodoWrite',
];

type EmitFn = (output: ContainerOutput) => void;
type LogFn = (message: string) => void;

type PendingSubAgentMessage = {
  message: any;
  timer: ReturnType<typeof setTimeout>;
};

export class StreamEventProcessor {
  private readonly emit: EmitFn;
  private readonly log: LogFn;
  private readonly backgroundDrain = new BackgroundTaskDrainTracker();
  private readonly backgroundLevelTaskIds = new Set<string>();

  // Text aggregation buffers — keyed by parentToolUseId (BUF_MAIN for top-level)
  private readonly BUF_MAIN = '__main__';
  private readonly streamBufs = new Map<
    string,
    { text: string; think: string }
  >();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private seenTextualResult = false;
  private readonly FLUSH_MS = 100;
  private readonly FLUSH_CHARS = 200;
  // thinking_tokens is intentionally reduced to a low-frequency semantic
  // heartbeat. Raw frames can arrive thousands of times in one reasoning-heavy
  // turn and previously froze the Web/card projections when broadcast 1:1.
  private lastThinkingTokenStatusAt: number | null = null;
  private readonly THINKING_TOKEN_STATUS_INTERVAL_MS = 2_000;

  // Full text accumulator — SDK's result.result only contains the last text block;
  // this accumulates all text_delta to produce the complete response.
  private fullTextAccumulator = '';

  // Top-level tool use tracking
  private activeTopLevelToolUseId: string | null = null;
  // Active Skill tool ID: tools called inside Skill may lack parent_tool_use_id
  private activeSkillToolUseId: string | null = null;

  // Accumulate Skill tool input_json_delta to extract skillName
  // Keyed by content block index (event.index) to match deltas correctly
  private readonly pendingSkillInput = new Map<
    number,
    {
      toolUseId: string;
      inputJson: string;
      resolved: boolean;
      parentToolUseId: string | null;
      isNested: boolean;
    }
  >();

  // Accumulate Task tool input_json_delta to extract description and team_name
  private readonly pendingTaskInput = new Map<
    number,
    {
      toolUseId: string;
      inputJson: string;
      resolved: boolean;
      isTeammate?: boolean;
    }
  >();

  // Accumulate AskUserQuestion tool input_json_delta to extract questions/options
  private readonly pendingAskUserInput = new Map<
    number,
    {
      toolUseId: string;
      inputJson: string;
      resolved: boolean;
      parentToolUseId: string | null;
      isNested: boolean;
    }
  >();

  // Accumulate TodoWrite tool input_json_delta to extract todos
  private readonly pendingTodoInput = new Map<
    number,
    {
      toolUseId: string;
      inputJson: string;
      resolved: boolean;
      parentToolUseId: string | null;
      isNested: boolean;
    }
  >();
  // Accumulate generic tool input_json_delta to extract toolInputSummary
  private readonly pendingGenericInput = new Map<
    number,
    {
      toolUseId: string;
      inputJson: string;
      resolved: boolean;
      parentToolUseId: string | null;
      isNested: boolean;
      toolName: string;
    }
  >();

  // Confirmed teammate Tasks (detected via team_name)
  private readonly teammateTaskToolUseIds = new Set<string>();

  // Task tool_use_ids — tool_use_end is only emitted via tool_use_summary,
  // not prematurely when the next content block starts
  private readonly taskToolUseIds = new Set<string>();

  // Best available completion summary per Task/Agent tool_use_id.
  private readonly taskSummariesByToolUseId = new Map<string, string>();

  // Track active nested tool per parent context (for synthetic tool_use_end)
  private readonly activeNestedToolByParent = new Map<
    string,
    { toolUseId: string; toolName: string }
  >();

  // Background Task tool_use_ids (run_in_background: true)
  private readonly backgroundTaskToolUseIds = new Set<string>();

  // Orphaned background agent notifications detected during resume.
  // SDK emits these when a background agent had no completion record from the
  // previous session (process was killed while it was still running).
  // Keyed by taskId to enable deduplication across multiple resumes.
  private readonly orphanedAgentTaskIds = new Set<string>();

  // SDK internal task_id → API tool_use_id mapping.
  // Built from task_started/task_progress system messages so that
  // task_notification (which carries SDK task_id) can be translated
  // back to the tool_use_id used at creation time.
  private readonly sdkTaskIdToToolUseId = new Map<string, string>();

  // Live Workflow plan keyed by the public tool_use_id. The SDK only sends
  // cumulative task_progress samples while the Workflow is running; retaining
  // the plan here lets those samples update real Agent rows instead of leaving
  // the static preview stuck at "等待" until task_notification arrives.
  private readonly workflowRunsByToolUseId = new Map<
    string,
    WorkflowRunSnapshot
  >();

  // 尚未 settle 的 SDK 任务。local_bash 在 SDK 明确报告
  // is_backgrounded=true 后属于已成功启动的 detached process：它仍保持
  // stream 存活，但不再阻止当前输入 receipt 提交。其他 Agent/workflow
  // 后台任务仍必须等待最终汇总后才能确认输入。
  // task_started 时登记；settle 走两条互补路径（缺一不可，不是重复防御）：
  // - task_notification：后台任务 / stopTask 的权威 settle 信号，任意 status
  //  （completed/failed/stopped）都算 settle；
  // - task_updated(terminal)：前台同步任务完成时以 patch.status 终态到达
  //  （实验证实前台任务两者都发，但不能假设未来版本仍冗余）。
  // 同步任务在 turn 内必然 settle，所以 result 到达时集合里剩下的就是跨 turn
  // 存活的后台任务（异步 Agent / backgrounded Bash）——runner 据此决定 result
  // 后是否推迟关流，避免把它们连坐杀掉。
  // skip_transcript 的 housekeeping 任务不登记，防止内部自务任务卡住收尾。
  private readonly pendingSdkTasks = new Map<
    string,
    {
      description: string;
      taskType?: string;
      isBackgrounded: boolean;
    }
  >();

  // Sub-agent active tools per parent task ID
  private readonly activeSubAgentToolsByTask = new Map<string, Set<string>>();

  // Sub-agent messages can arrive before the corresponding task_start event.
  // Buffer briefly and replay once the Task tool is registered.
  private readonly pendingSubAgentMessages = new Map<
    string,
    PendingSubAgentMessage[]
  >();
  private readonly PENDING_SUBAGENT_TIMEOUT_MS = 30_000;

  // 主 Agent thinking 是否已通过 content_block_delta 路径流出过。
  // 某些模型仍按 delta 下发 thinking；若 delta 路径已消费，processAssistantMessage
  // 必须跳过完整 block 的补发，避免同一段思考被 emit 两次。
  private mainThinkingStreamed = false;

  constructor(emit: EmitFn, log: LogFn) {
    this.emit = emit;
    this.log = log;
  }

  private emitStreamEvent(streamEvent: StreamEvent): void {
    this.emit({ status: 'stream', result: null, streamEvent });
  }

  private normalizeTaskUsage(
    usage: any,
  ): StreamEvent['sdkTaskUsage'] | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    return {
      totalTokens: Number(usage.total_tokens || 0),
      toolUses: Number(usage.tool_uses || 0),
      durationMs: Number(usage.duration_ms || 0),
    };
  }

  private rawType(message: any): string {
    return message?.subtype
      ? `${message.type}/${message.subtype}`
      : String(message?.type || 'unknown');
  }

  private buildRawEvent(message: any): Record<string, unknown> {
    const raw: Record<string, unknown> = {};
    for (const key of [
      'type',
      'subtype',
      'uuid',
      'session_id',
      'parent_tool_use_id',
      'task_id',
      'tool_use_id',
      'status',
      'state',
      'summary',
      'description',
      'subagent_type',
      'last_tool_name',
      'key',
      'priority',
      'error',
      'message',
      'mcp_server_name',
      'elicitation_id',
    ]) {
      if (message?.[key] !== undefined) raw[key] = message[key];
    }
    if (typeof message?.content === 'string')
      raw.content = message.content.slice(0, 2000);
    if (typeof message?.suggestion === 'string')
      raw.suggestion = message.suggestion.slice(0, 1000);
    if (Array.isArray(message?.files)) raw.files = message.files.slice(0, 20);
    if (Array.isArray(message?.failed))
      raw.failed = message.failed.slice(0, 20);
    return raw;
  }

  private emitRawSdkEvent(
    message: any,
    title?: string,
    displayLevel: StreamEvent['displayLevel'] = 'debug',
  ): void {
    this.emitStreamEvent({
      eventType: 'raw_sdk_event',
      agentScope: 'system',
      rawType: this.rawType(message),
      title: title || this.rawType(message),
      summary:
        typeof message?.summary === 'string' ? message.summary : undefined,
      detail:
        typeof message?.message === 'string' ? message.message : undefined,
      displayLevel,
      messageUuid: message?.uuid,
      sessionId: message?.session_id,
      rawEvent: this.buildRawEvent(message),
    });
  }

  private registerTaskToolUse(toolUseId: string, sdkTaskId?: string): void {
    this.taskToolUseIds.add(toolUseId);
    if (sdkTaskId) this.sdkTaskIdToToolUseId.set(sdkTaskId, toolUseId);
    this.replayPendingSubAgentMessages(toolUseId);
  }

  private queuePendingSubAgentMessage(
    parentToolUseId: string,
    message: any,
  ): void {
    const timer = setTimeout(() => {
      const pending = this.pendingSubAgentMessages.get(parentToolUseId) || [];
      const remaining = pending.filter((item) => item.message !== message);
      if (remaining.length > 0) {
        this.pendingSubAgentMessages.set(parentToolUseId, remaining);
      } else {
        this.pendingSubAgentMessages.delete(parentToolUseId);
      }
      this.log(
        `[WARN] Sub-agent message timed out: parent=${parentToolUseId.slice(0, 12)} type=${message.type}`,
      );
      this.emitRawSdkEvent(
        message,
        `Unmatched sub-agent message ${parentToolUseId.slice(0, 12)}`,
        'debug',
      );
    }, this.PENDING_SUBAGENT_TIMEOUT_MS);
    const list = this.pendingSubAgentMessages.get(parentToolUseId) || [];
    list.push({ message, timer });
    this.pendingSubAgentMessages.set(parentToolUseId, list);
    this.log(
      `[sub-agent] queued early message parent=${parentToolUseId.slice(0, 12)} type=${message.type}`,
    );
  }

  private replayPendingSubAgentMessages(parentToolUseId: string): void {
    const pending = this.pendingSubAgentMessages.get(parentToolUseId);
    if (!pending || pending.length === 0) return;
    this.pendingSubAgentMessages.delete(parentToolUseId);
    this.log(
      `[sub-agent] replaying ${pending.length} queued message(s) for parent=${parentToolUseId.slice(0, 12)}`,
    );
    for (const item of pending) {
      clearTimeout(item.timer);
      this.processSubAgentMessage(item.message);
    }
  }

  /** Get or create a buffer for a given key. */
  private getBuf(key: string): { text: string; think: string } {
    let b = this.streamBufs.get(key);
    if (!b) {
      b = { text: '', think: '' };
      this.streamBufs.set(key, b);
    }
    return b;
  }

  /** Flush all pending text/thinking buffers. */
  private flushBuffers(): void {
    for (const [key, buf] of this.streamBufs) {
      const pid = key === this.BUF_MAIN ? undefined : key;
      if (buf.text) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'text_delta',
            agentScope: pid ? 'subagent' : 'main',
            text: buf.text,
            parentToolUseId: pid,
          },
        });
        buf.text = '';
      }
      if (buf.think) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'thinking_delta',
            agentScope: pid ? 'subagent' : 'main',
            text: buf.think,
            parentToolUseId: pid,
          },
        });
        buf.think = '';
      }
    }
    this.flushTimer = null;
  }

  /** Schedule a flush, either immediately (if buffer is large enough) or after FLUSH_MS. */
  private scheduleFlush(): void {
    let maxLen = 0;
    for (const buf of this.streamBufs.values()) {
      maxLen = Math.max(maxLen, buf.text.length, buf.think.length);
    }
    if (maxLen >= this.FLUSH_CHARS) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushBuffers();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushBuffers(), this.FLUSH_MS);
    }
  }

  /** Clean up tools associated with a Task. */
  private cleanupTaskTools(taskId: string): void {
    const nested = this.activeNestedToolByParent.get(taskId);
    if (nested) {
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_end',
          toolUseId: nested.toolUseId,
          parentToolUseId: taskId,
        },
      });
      this.activeNestedToolByParent.delete(taskId);
    }
    const subTools = this.activeSubAgentToolsByTask.get(taskId);
    if (subTools) {
      for (const toolId of subTools) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: toolId,
            parentToolUseId: taskId,
          },
        });
      }
      this.activeSubAgentToolsByTask.delete(taskId);
    }
  }

  /**
   * Process a stream_event message from the SDK.
   * Returns true if the message was handled (caller should continue to next message).
   */
  processStreamEvent(message: {
    type: string;
    parent_tool_use_id?: string | null;
    uuid?: string;
    session_id?: string;
    event: any;
  }): boolean {
    const parentToolUseId =
      message.parent_tool_use_id === undefined
        ? null
        : message.parent_tool_use_id;
    const isNested = parentToolUseId !== null;

    const event = message.event;
    // A message_stop is the semantic commit boundary for the host-side answer
    // reducer. Flush any short (< FLUSH_CHARS) delta first; otherwise the stop
    // would close the message and the timer would later misclassify its text as
    // a new implicit AssistantMessage.
    if (event.type === 'message_stop') {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushBuffers();
    }
    if (event.type === 'message_start' || event.type === 'message_stop') {
      this.emitStreamEvent({
        eventType: 'raw_sdk_event',
        agentScope: isNested ? 'subagent' : 'main',
        rawType: `stream_event/${event.type}`,
        title:
          event.type === 'message_start'
            ? 'Assistant message started'
            : 'Assistant message completed',
        messageUuid: message.uuid || event.message?.id,
        sessionId: message.session_id,
        parentToolUseId,
        displayLevel: 'debug',
      });
    }
    // Diagnostic log: print non-delta nested events
    if (isNested && event.type !== 'content_block_delta') {
      const evtType =
        event.type === 'content_block_start'
          ? `block_start/${event.content_block?.type}${event.content_block?.name ? `:${event.content_block.name}` : ''}`
          : event.type;
      this.log(
        `[stream-nested] parent=${parentToolUseId} evt=${evtType} tasks=[${[...this.taskToolUseIds].map((id) => id.slice(0, 12)).join(',')}]`,
      );
    }

    if (event.type === 'content_block_start') {
      const _b = event.content_block;
      this.log(
        `[stream] parent=${parentToolUseId ?? 'null'} block=${_b?.type}${_b?.name ? ` name=${_b.name}` : ''}${_b?.id ? ` id=${_b.id.slice(0, 12)}` : ''}`,
      );
      const block = event.content_block;

      if (block?.type === 'tool_use') {
        this.handleToolUseStart(block, parentToolUseId, isNested, event.index);
      } else if (block?.type === 'text') {
        this.handleTextBlockStart(parentToolUseId, isNested);
      }
    } else if (event.type === 'content_block_delta') {
      this.handleContentBlockDelta(event, parentToolUseId);
    }

    return true;
  }

  /** Handle tool_use content_block_start. */
  private handleToolUseStart(
    block: { type: string; name: string; id?: string; input?: unknown },
    parentToolUseId: string | null,
    isNested: boolean,
    blockIndex?: number,
  ): void {
    // Determine if this is inside a Skill: SDK may not set parent_tool_use_id
    const isInsideSkill =
      !isNested && this.activeSkillToolUseId && block.name !== 'Skill';
    const effectiveIsNested = isNested || !!isInsideSkill;
    const effectiveParentToolUseId = isInsideSkill
      ? this.activeSkillToolUseId
      : parentToolUseId;

    if (
      !effectiveIsNested &&
      this.activeTopLevelToolUseId &&
      this.activeTopLevelToolUseId !== block.id
    ) {
      // Task tool_use_end only via tool_use_summary (not premature)
      if (!this.taskToolUseIds.has(this.activeTopLevelToolUseId)) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: this.activeTopLevelToolUseId,
          },
        });
      }
      if (this.activeTopLevelToolUseId === this.activeSkillToolUseId) {
        this.activeSkillToolUseId = null;
      }
    }
    if (!effectiveIsNested) this.activeTopLevelToolUseId = block.id || null;

    // Track nested tools: end previous active tool under same parent
    if (effectiveIsNested && effectiveParentToolUseId) {
      const prevNested = this.activeNestedToolByParent.get(
        effectiveParentToolUseId,
      );
      if (prevNested && prevNested.toolUseId !== block.id) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: prevNested.toolUseId,
            parentToolUseId: effectiveParentToolUseId,
          },
        });
      }
      this.activeNestedToolByParent.set(effectiveParentToolUseId, {
        toolUseId: block.id || '',
        toolName: block.name,
      });
    }

    this.emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'tool_use_start',
        toolName: block.name,
        toolUseId: block.id,
        parentToolUseId: effectiveParentToolUseId,
        isNested: effectiveIsNested,
        skillName: extractSkillName(block.name, block.input),
        toolInputSummary: summarizeToolInput(block.input),
      },
    });

    // Track Skill tool_use block
    if (block.name === 'Skill' && block.id) {
      this.activeSkillToolUseId = block.id;
      if (typeof blockIndex === 'number') {
        this.pendingSkillInput.set(blockIndex, {
          toolUseId: block.id,
          inputJson: '',
          resolved: false,
          parentToolUseId,
          isNested,
        });
      }
    }

    // Track AskUserQuestion tool
    if (block.name === 'AskUserQuestion' && block.id) {
      if (typeof blockIndex === 'number') {
        this.pendingAskUserInput.set(blockIndex, {
          toolUseId: block.id,
          inputJson: '',
          resolved: false,
          parentToolUseId,
          isNested,
        });
      }
    }

    // Track TodoWrite tool
    if (block.name === 'TodoWrite' && block.id) {
      if (typeof blockIndex === 'number') {
        this.pendingTodoInput.set(blockIndex, {
          toolUseId: block.id,
          inputJson: '',
          resolved: false,
          parentToolUseId,
          isNested,
        });
      }
    }

    // Track generic tools for input_json_delta → toolInputSummary
    if (
      block.name &&
      !SPECIAL_TOOLS.includes(block.name) &&
      typeof blockIndex === 'number'
    ) {
      this.pendingGenericInput.set(blockIndex, {
        toolUseId: block.id || '',
        inputJson: '',
        resolved: false,
        parentToolUseId: effectiveParentToolUseId,
        isNested: effectiveIsNested,
        toolName: block.name,
      });
    }

    // Track Task / Agent tool (both spawn sub-agents whose messages need forwarding)
    if ((block.name === 'Task' || block.name === 'Agent') && block.id) {
      this.registerTaskToolUse(block.id);
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'task_start',
          agentScope: 'task',
          toolUseId: block.id,
          toolName: block.name,
          displayLevel: 'primary',
        },
      });
      if (typeof blockIndex === 'number') {
        this.pendingTaskInput.set(blockIndex, {
          toolUseId: block.id,
          inputJson: '',
          resolved: false,
        });
      }
    }
  }

  /** Handle text content_block_start. */
  private handleTextBlockStart(
    parentToolUseId: string | null,
    isNested: boolean,
  ): void {
    // New text block means top-level tool has finished executing (main agent only)
    if (!isNested && this.activeTopLevelToolUseId) {
      if (!this.taskToolUseIds.has(this.activeTopLevelToolUseId)) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: this.activeTopLevelToolUseId,
          },
        });
      }
      this.activeTopLevelToolUseId = null;
      this.activeSkillToolUseId = null;
    }
    // Nested text block: end active nested tool under that parent
    if (isNested && parentToolUseId) {
      const prevNested = this.activeNestedToolByParent.get(parentToolUseId);
      if (prevNested) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: prevNested.toolUseId,
            parentToolUseId,
          },
        });
        this.activeNestedToolByParent.delete(parentToolUseId);
      }
    }
  }

  /** Handle content_block_delta events (text, thinking, input_json). */
  private handleContentBlockDelta(
    event: any,
    parentToolUseId: string | null,
  ): void {
    const delta = event.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      const bufKey = parentToolUseId || this.BUF_MAIN;
      this.getBuf(bufKey).text += delta.text;
      if (bufKey === this.BUF_MAIN) {
        this.fullTextAccumulator += delta.text;
        // 主 agent 有新输出 ⇒ "上一个 textual result 之后无未定稿文本"不再成立。
        // 否则单 query 多 turn（follow-up / 后台任务唤醒的汇总 turn）被中断时，
        // cleanup() 会把新 turn 的缓冲尾巴当上一 turn 的残渣丢弃。
        this.seenTextualResult = false;
      }
      this.scheduleFlush();
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
      const bufKey = parentToolUseId || this.BUF_MAIN;
      if (!parentToolUseId) {
        this.mainThinkingStreamed = true;
        this.seenTextualResult = false;
      }
      this.getBuf(bufKey).think += delta.thinking;
      this.scheduleFlush();
    } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
      const blockIndex = event.index;
      if (typeof blockIndex === 'number') {
        this.handleInputJsonDelta(blockIndex, delta.partial_json);
      }
    }
  }

  /** Handle input_json_delta for Skill and Task tools. */
  private handleInputJsonDelta(blockIndex: number, partialJson: string): void {
    // Accumulate Skill input JSON
    const pending = this.pendingSkillInput.get(blockIndex);
    if (pending && !pending.resolved) {
      pending.inputJson += partialJson;
      const skillMatch = pending.inputJson.match(/"skill"\s*:\s*"([^"]+)"/);
      if (skillMatch) {
        pending.resolved = true;
        this.pendingSkillInput.delete(blockIndex);
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_progress',
            toolName: 'Skill',
            toolUseId: pending.toolUseId,
            parentToolUseId: pending.parentToolUseId,
            isNested: pending.isNested,
            skillName: skillMatch[1],
          },
        });
      }
    }

    // Accumulate AskUserQuestion input JSON
    const pendingAsk = this.pendingAskUserInput.get(blockIndex);
    if (pendingAsk && !pendingAsk.resolved) {
      pendingAsk.inputJson += partialJson;
      // Try to parse once we see "questions" field
      if (pendingAsk.inputJson.includes('"question')) {
        try {
          const parsed = JSON.parse(pendingAsk.inputJson);
          if (parsed.question || parsed.questions) {
            pendingAsk.resolved = true;
            this.pendingAskUserInput.delete(blockIndex);
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'tool_progress',
                toolName: 'AskUserQuestion',
                toolUseId: pendingAsk.toolUseId,
                parentToolUseId: pendingAsk.parentToolUseId,
                isNested: pendingAsk.isNested,
                toolInput: parsed,
              },
            });
          }
        } catch {
          // JSON not complete yet, continue accumulating
        }
      }
    }

    // Accumulate TodoWrite input JSON
    const pendingTodo = this.pendingTodoInput.get(blockIndex);
    if (pendingTodo && !pendingTodo.resolved) {
      pendingTodo.inputJson += partialJson;
      if (pendingTodo.inputJson.includes('"todos"')) {
        try {
          const parsed = JSON.parse(pendingTodo.inputJson);
          if (Array.isArray(parsed.todos)) {
            pendingTodo.resolved = true;
            this.pendingTodoInput.delete(blockIndex);
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'todo_update',
                todos: parsed.todos,
              },
            });
          }
        } catch {
          // JSON not complete yet, continue accumulating
        }
      }
    }

    // Accumulate Task input JSON
    const pendingTask = this.pendingTaskInput.get(blockIndex);
    if (pendingTask && !pendingTask.resolved) {
      pendingTask.inputJson += partialJson;
      // Detect team_name
      if (!pendingTask.isTeammate) {
        const teamMatch = pendingTask.inputJson.match(
          /"team_name"\s*:\s*"((?:[^"\\]|\\.)*)"/,
        );
        if (teamMatch) {
          pendingTask.isTeammate = true;
          this.teammateTaskToolUseIds.add(pendingTask.toolUseId);
        }
      }
      const descMatch = pendingTask.inputJson.match(
        /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/,
      );
      if (descMatch) {
        pendingTask.resolved = true;
        this.pendingTaskInput.delete(blockIndex);
        const isTeammate = pendingTask.isTeammate || false;
        if (isTeammate) this.teammateTaskToolUseIds.add(pendingTask.toolUseId);
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'task_start',
            agentScope: 'task',
            toolUseId: pendingTask.toolUseId,
            taskId: pendingTask.toolUseId,
            toolName: 'Task',
            taskDescription: descMatch[1].replace(/\\"/g, '"').slice(0, 200),
            ...(isTeammate ? { isTeammate: true } : {}),
            displayLevel: 'primary',
          },
        });
      }
    }

    // Accumulate generic tool input JSON for toolInputSummary.
    // Only attempt JSON.parse when the accumulated string looks complete (ends with '}')
    // to avoid O(n^2) repeated parse failures on large tool inputs.
    // Cap at 10KB to avoid unbounded memory growth on tools with large inputs (Write, Edit).
    const GENERIC_INPUT_MAX = 10_240;
    const pendingGeneric = this.pendingGenericInput.get(blockIndex);
    if (pendingGeneric && !pendingGeneric.resolved) {
      if (pendingGeneric.inputJson.length >= GENERIC_INPUT_MAX) {
        pendingGeneric.resolved = true;
        this.pendingGenericInput.delete(blockIndex);
        return;
      }
      pendingGeneric.inputJson += partialJson;
      const trimmed = pendingGeneric.inputJson.trimEnd();
      const summary = trimmed.endsWith('}')
        ? summarizeToolInput(
            (() => {
              try {
                return JSON.parse(pendingGeneric.inputJson);
              } catch {
                return null;
              }
            })(),
          )
        : undefined;
      if (summary) {
        pendingGeneric.resolved = true;
        this.pendingGenericInput.delete(blockIndex);
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_progress',
            toolName: pendingGeneric.toolName,
            toolUseId: pendingGeneric.toolUseId,
            parentToolUseId: pendingGeneric.parentToolUseId,
            isNested: pendingGeneric.isNested,
            toolInputSummary: summary,
          },
        });
      }
    }
  }

  /**
   * Process a tool_progress message.
   */
  processToolProgress(message: any): void {
    const parentToolUseId =
      message.parent_tool_use_id === undefined
        ? null
        : message.parent_tool_use_id;
    this.emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'tool_progress',
        toolName: message.tool_name,
        toolUseId: message.tool_use_id,
        parentToolUseId,
        isNested: parentToolUseId !== null,
        elapsedSeconds: message.elapsed_time_seconds,
      },
    });
  }

  /**
   * Process a tool_use_summary message.
   */
  processToolUseSummary(message: any): void {
    const ids = Array.isArray(message.preceding_tool_use_ids)
      ? message.preceding_tool_use_ids.filter(
          (id: unknown): id is string => typeof id === 'string',
        )
      : [];
    this.log(
      `[tool_use_summary] ids=[${ids.map((id: string) => id.slice(0, 12)).join(',')}] taskToolUseIds=[${[...this.taskToolUseIds].map((id) => id.slice(0, 12)).join(',')}] bgTasks=[${[...this.backgroundTaskToolUseIds].map((id) => id.slice(0, 12)).join(',')}]`,
    );
    const summary = typeof message.summary === 'string' ? message.summary : '';
    for (const id of ids) {
      if (summary) this.taskSummariesByToolUseId.set(id, summary);
      // Foreground Task completion: synthesize task_notification
      if (
        this.taskToolUseIds.has(id) &&
        !this.backgroundTaskToolUseIds.has(id)
      ) {
        this.log(
          `Synthesizing task_notification for foreground Task ${id.slice(0, 12)}`,
        );
        this.cleanupTaskTools(id);
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'task_notification',
            agentScope: 'task',
            taskId: id,
            toolUseId: id,
            taskStatus: 'completed',
            taskSummary: summary,
            summary,
            isSynthetic: true,
            displayLevel: 'primary',
          },
        });
      }
      this.taskToolUseIds.delete(id);
      this.backgroundTaskToolUseIds.delete(id);
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: id },
      });
      if (this.activeTopLevelToolUseId === id) {
        this.activeTopLevelToolUseId = null;
      }
    }
  }

  /**
   * Process system messages (status, hook_started, hook_progress, hook_response).
   * Returns true if the message was handled.
   */
  processSystemMessage(message: any): boolean {
    if (message.subtype === 'init') {
      return false;
    }
    if (message.subtype === 'status') {
      // SDKStatus 是字符串字面量（'compacting' | 'requesting' | null），不是带 .type 的对象。
      // 旧代码读 message.status?.type 恒为 undefined，导致前端永远收不到"压缩中"状态。
      // 注：compact_result / compact_error 确实存在于 SDKStatusMessage（仅在 status=null 的压缩
      // 完成/失败消息上携带）；此处移除 detail 仅因当前前端 status 分支只消费 statusText，
      // 不渲染 detail——若日后要向用户暴露压缩成败，可在 compact_error 存在时另发一条事件。
      const statusText = message.status || null;
      this.emitStreamEvent({
        eventType: 'status',
        agentScope: 'system',
        statusText,
        displayLevel: 'primary',
      });
      return true;
    }
    if (message.subtype === 'hook_started') {
      this.emitStreamEvent({
        eventType: 'hook_started',
        agentScope: 'system',
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'hook_progress') {
      this.emitStreamEvent({
        eventType: 'hook_progress',
        agentScope: 'system',
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        detail: message.output || message.stdout || message.stderr,
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'hook_response') {
      this.emitStreamEvent({
        eventType: 'hook_response',
        agentScope: 'system',
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        hookOutcome: message.outcome,
        detail: message.output || message.stdout || message.stderr,
        displayLevel: 'detail',
      });
      return true;
    }
    // API retry — emit status so user sees retry progress and activity stays alive
    if (message.subtype === 'api_retry') {
      const attempt = message.attempt ?? '?';
      const max = message.max_retries ?? '?';
      const delayMs = message.retry_delay_ms ?? 0;
      const delaySec = Math.round(delayMs / 1000);
      this.emitStreamEvent({
        eventType: 'status',
        agentScope: 'system',
        statusText: `API 重试中 (${attempt}/${max})，${delaySec}s 后重试`,
        displayLevel: 'primary',
      });
      return true;
    }
    // task_started / task_progress — preserve the structured SDK task state.
    if (message.subtype === 'task_started') {
      if (message.task_id && message.tool_use_id) {
        this.registerTaskToolUse(message.tool_use_id, message.task_id);
      }
      const effectiveToolUseId =
        message.tool_use_id ||
        this.sdkTaskIdToToolUseId.get(message.task_id) ||
        message.task_id;
      const desc = message.description || message.prompt || '';
      if (message.task_id && !message.skip_transcript) {
        this.backgroundDrain.taskStarted(message.task_id);
        this.pendingSdkTasks.set(message.task_id, {
          description: desc,
          taskType:
            typeof message.task_type === 'string'
              ? message.task_type
              : undefined,
          isBackgrounded: false,
        });
        this.log(
          `[pending-tasks] +${message.task_id.slice(0, 12)} (${shorten(desc, 60)}) → ${this.pendingSdkTasks.size} pending`,
        );
      }
      this.emitStreamEvent({
        eventType: 'task_start',
        agentScope: 'task',
        taskId: effectiveToolUseId,
        toolUseId: effectiveToolUseId,
        taskDescription: desc,
        summary: message.summary,
        detail: message.prompt,
        taskType: message.task_type,
        workflowName: message.workflow_name,
        subagentType: message.subagent_type,
        displayLevel: message.skip_transcript ? 'detail' : 'primary',
      });
      return true;
    }
    if (message.subtype === 'task_progress') {
      if (message.task_id && message.tool_use_id) {
        this.registerTaskToolUse(message.tool_use_id, message.task_id);
      }
      const effectiveToolUseId =
        message.tool_use_id ||
        this.sdkTaskIdToToolUseId.get(message.task_id) ||
        message.task_id;
      if (message.summary)
        this.taskSummariesByToolUseId.set(effectiveToolUseId, message.summary);
      const liveWorkflow = this.workflowRunsByToolUseId.get(effectiveToolUseId);
      const workflowRun = liveWorkflow
        ? workflowRunFromTaskProgress(liveWorkflow, {
            label: message.last_tool_name,
            summary: message.summary,
            usage: message.usage,
          })
        : undefined;
      if (workflowRun) {
        this.workflowRunsByToolUseId.set(effectiveToolUseId, workflowRun);
      }
      this.emitStreamEvent({
        eventType: 'task_progress',
        agentScope: 'task',
        taskId: effectiveToolUseId,
        toolUseId: effectiveToolUseId,
        taskDescription: message.description,
        summary: message.summary,
        taskSummary: message.summary,
        subagentType: message.subagent_type,
        lastToolName: message.last_tool_name,
        sdkTaskUsage: this.normalizeTaskUsage(message.usage),
        workflowRun,
        displayLevel: 'primary',
      });
      return true;
    }
    if (message.subtype === 'task_updated') {
      const effectiveToolUseId =
        this.sdkTaskIdToToolUseId.get(message.task_id) || message.task_id;
      const patchStatus = message.patch?.status;
      const pending = this.pendingSdkTasks.get(message.task_id);
      if (pending && message.patch?.is_backgrounded === true) {
        pending.isBackgrounded = true;
        if (pending.taskType === 'local_bash') {
          this.backgroundDrain.markNonBlocking(message.task_id);
        } else {
          this.backgroundDrain.markBackground(message.task_id);
        }
      }
      if (patchStatus && SDK_TERMINAL_TASK_STATUSES.has(patchStatus)) {
        this.backgroundDrain.taskTerminal(message.task_id);
        this.settlePendingSdkTask(
          message.task_id,
          `task_updated:${patchStatus}`,
        );
      }
      this.emitStreamEvent({
        eventType: 'task_updated',
        agentScope: 'task',
        taskId: effectiveToolUseId,
        toolUseId: effectiveToolUseId,
        taskPatch: message.patch,
        summary: message.patch?.error || message.patch?.description,
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'task_notification') {
      this.processTaskNotification(message);
      return true;
    }
    if (message.subtype === 'background_tasks_changed') {
      const tasks: Array<{
        task_id: string;
        task_type?: string;
        description?: string;
      }> = Array.isArray(message.tasks)
        ? (message.tasks as unknown[]).filter(
            (
              task: unknown,
            ): task is {
              task_id: string;
              task_type?: string;
              description?: string;
            } =>
              typeof task === 'object' &&
              task !== null &&
              typeof (task as { task_id?: unknown }).task_id === 'string',
          )
        : [];
      const nextIds = new Set(tasks.map((task) => task.task_id));
      for (const previousId of this.backgroundLevelTaskIds) {
        if (!nextIds.has(previousId)) {
          this.pendingSdkTasks.delete(previousId);
        }
      }
      this.backgroundLevelTaskIds.clear();
      for (const task of tasks) {
        this.backgroundLevelTaskIds.add(task.task_id);
        const existing = this.pendingSdkTasks.get(task.task_id);
        if (!existing) {
          this.pendingSdkTasks.set(task.task_id, {
            description: task.description || task.task_id,
            taskType: task.task_type,
            isBackgrounded: true,
          });
        } else {
          existing.isBackgrounded = true;
          existing.taskType ??= task.task_type;
        }
      }
      this.backgroundDrain.replaceBackgroundTasks([...nextIds]);
      this.emitRawSdkEvent(message, this.rawType(message), 'debug');
      return true;
    }
    if (message.subtype === 'permission_denied') {
      this.emitStreamEvent({
        eventType: 'permission_denied',
        agentScope: message.agent_id ? 'subagent' : 'system',
        toolName: message.tool_name,
        toolUseId: message.tool_use_id,
        title: `Permission denied: ${message.tool_name}`,
        summary: message.decision_reason || message.message,
        detail: message.message,
        permissionDenied: {
          toolName: message.tool_name,
          toolUseId: message.tool_use_id,
          agentId: message.agent_id,
          reasonType: message.decision_reason_type,
          reason: message.decision_reason,
          message: message.message,
        },
        displayLevel: 'primary',
      });
      return true;
    }
    if (message.subtype === 'memory_recall') {
      const count = Array.isArray(message.memories)
        ? message.memories.length
        : 0;
      this.emitStreamEvent({
        eventType: 'memory_recall',
        agentScope: 'system',
        title: 'Memory recall',
        summary: `${message.mode || 'memory'} recalled ${count} item(s)`,
        detail: Array.isArray(message.memories)
          ? message.memories
              .map(
                (m: any) => `${m.scope || 'memory'}: ${m.path || '<memory>'}`,
              )
              .slice(0, 10)
              .join('\n')
          : undefined,
        rawEvent: this.buildRawEvent(message),
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'compact_boundary') {
      const meta = message.compact_metadata || {};
      this.emitStreamEvent({
        eventType: 'compact_boundary',
        agentScope: 'system',
        title: 'Context compacted',
        summary: `${meta.trigger || 'compact'}: ${meta.pre_tokens || 0} → ${meta.post_tokens ?? '?'} tokens`,
        detail: meta.duration_ms ? `${meta.duration_ms}ms` : undefined,
        rawEvent: this.buildRawEvent(message),
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'notification') {
      this.emitStreamEvent({
        eventType: 'notification',
        agentScope: 'system',
        title: message.key,
        summary: message.text,
        detail: message.priority,
        displayLevel:
          message.priority === 'high' || message.priority === 'immediate'
            ? 'primary'
            : 'detail',
      });
      return true;
    }
    if (message.subtype === 'local_command_output') {
      this.emitStreamEvent({
        eventType: 'notification',
        agentScope: 'system',
        title: 'Local command',
        summary:
          typeof message.content === 'string'
            ? message.content.slice(0, 500)
            : undefined,
        detail: message.content,
        displayLevel: 'detail',
      });
      return true;
    }
    if (message.subtype === 'files_persisted') {
      const files = Array.isArray(message.files) ? message.files.length : 0;
      const failed = Array.isArray(message.failed) ? message.failed.length : 0;
      this.emitStreamEvent({
        eventType: 'notification',
        agentScope: 'system',
        title: 'Files persisted',
        summary: `${files} file(s), ${failed} failed`,
        rawEvent: this.buildRawEvent(message),
        displayLevel: failed > 0 ? 'primary' : 'detail',
      });
      return true;
    }
    if (
      message.subtype === 'session_state_changed' ||
      message.subtype === 'elicitation_complete' ||
      message.subtype === 'mirror_error' ||
      message.subtype === 'plugin_install'
    ) {
      this.emitRawSdkEvent(
        message,
        this.rawType(message),
        message.subtype === 'mirror_error' ? 'primary' : 'debug',
      );
      return true;
    }
    // `thinking_tokens` is a high-frequency approximate counter. Preserve its
    // liveness semantics without broadcasting the raw counter or chain of
    // thought: at most one synthesized heartbeat per 2 seconds.
    if (message.subtype === 'thinking_tokens') {
      const now = Date.now();
      if (
        this.lastThinkingTokenStatusAt === null ||
        now - this.lastThinkingTokenStatusAt >=
          this.THINKING_TOKEN_STATUS_INTERVAL_MS
      ) {
        this.lastThinkingTokenStatusAt = now;
        this.emitStreamEvent({
          eventType: 'status',
          agentScope: 'system',
          statusText: '正在深入分析…',
          summary: '模型正在进行推理',
          isSynthetic: true,
          displayLevel: 'primary',
          messageUuid: message.uuid,
          sessionId: message.session_id,
        });
      }
      return true;
    }
    this.emitRawSdkEvent(message);
    return true;
  }

  /**
   * Convenience: emit a status StreamEvent.
   */
  emitStatus(statusText: string): void {
    this.emit({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'status', statusText },
    });
  }

  /**
   * Process SDK messages that are not stream_event/tool/system/assistant/user/result.
   * Returns true if the message was handled.
   */
  processMiscMessage(message: any): boolean {
    if (message.type === 'prompt_suggestion') {
      this.emitStreamEvent({
        eventType: 'prompt_suggestion',
        agentScope: 'system',
        title: 'Prompt suggestion',
        summary: message.suggestion,
        detail: message.suggestion,
        displayLevel: 'detail',
        messageUuid: message.uuid,
        sessionId: message.session_id,
      });
      return true;
    }
    if (message.type === 'auth_status') {
      this.emitStreamEvent({
        eventType: 'notification',
        agentScope: 'system',
        title: message.isAuthenticating ? 'Authenticating' : 'Authentication',
        summary: Array.isArray(message.output)
          ? message.output.join('\n').slice(0, 500)
          : message.error,
        detail: message.error,
        displayLevel: message.error ? 'primary' : 'detail',
        messageUuid: message.uuid,
        sessionId: message.session_id,
      });
      return true;
    }
    if (message.type === 'rate_limit_event') return false;
    if (message.type === 'system') return false;
    if (
      message.type === 'assistant' ||
      message.type === 'user' ||
      message.type === 'result'
    )
      return false;
    if (message.type) {
      this.emitRawSdkEvent(message);
      return true;
    }
    return false;
  }

  /**
   * Process sub-agent messages (assistant/user with parent_tool_use_id that matches a Task).
   * Returns true if the message was handled as a sub-agent message.
   */
  processSubAgentMessage(message: any): boolean {
    const msgParentToolUseId = message.parent_tool_use_id ?? null;
    if (!msgParentToolUseId || !this.taskToolUseIds.has(msgParentToolUseId)) {
      if (
        msgParentToolUseId &&
        (message.type === 'assistant' || message.type === 'user')
      ) {
        this.queuePendingSubAgentMessage(msgParentToolUseId, message);
        return true;
      }
      return false;
    }

    if (message.type === 'assistant') {
      const subContent = message.message?.content as
        | Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            id?: string;
            input?: Record<string, unknown>;
          }>
        | undefined;
      if (Array.isArray(subContent)) {
        // End previous sub-agent active tools
        const prevTools =
          this.activeSubAgentToolsByTask.get(msgParentToolUseId);
        if (prevTools && prevTools.size > 0) {
          for (const toolId of prevTools) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'tool_use_end',
                toolUseId: toolId,
                parentToolUseId: msgParentToolUseId,
              },
            });
          }
          prevTools.clear();
        }
        for (const block of subContent) {
          if (block.type === 'thinking' && block.thinking) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'thinking_delta',
                agentScope: 'subagent',
                text: block.thinking,
                parentToolUseId: msgParentToolUseId,
                subagentType: message.subagent_type,
                taskDescription: message.task_description,
              },
            });
          }
          if (block.type === 'text' && block.text) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'text_delta',
                agentScope: 'subagent',
                text: block.text,
                parentToolUseId: msgParentToolUseId,
                subagentType: message.subagent_type,
                taskDescription: message.task_description,
              },
            });
          }
          if (block.type === 'tool_use' && block.id) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'tool_use_start',
                toolName: block.name || 'unknown',
                toolUseId: block.id,
                parentToolUseId: msgParentToolUseId,
                isNested: true,
                agentScope: 'subagent',
                subagentType: message.subagent_type,
                taskDescription: message.task_description,
                toolInputSummary: summarizeToolInput(block.input),
              },
            });
            if (!this.activeSubAgentToolsByTask.has(msgParentToolUseId)) {
              this.activeSubAgentToolsByTask.set(msgParentToolUseId, new Set());
            }
            this.activeSubAgentToolsByTask
              .get(msgParentToolUseId)!
              .add(block.id);
          }
        }
        this.log(
          `[sub-agent] parent=${msgParentToolUseId.slice(0, 12)} blocks=${subContent.length} types=[${subContent.map((b) => b.type).join(',')}]`,
        );
      }
    }

    if (message.type === 'user') {
      const rawContent = message.message?.content;
      if (typeof rawContent === 'string' && rawContent) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'text_delta',
            agentScope: 'subagent',
            text: rawContent,
            parentToolUseId: msgParentToolUseId,
            subagentType: message.subagent_type,
            taskDescription: message.task_description,
          },
        });
      } else if (Array.isArray(rawContent)) {
        const activeSub =
          this.activeSubAgentToolsByTask.get(msgParentToolUseId);
        for (const block of rawContent as Array<{
          type: string;
          text?: string;
          thinking?: string;
          tool_use_id?: string;
        }>) {
          if (block.type === 'text' && block.text) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'text_delta',
                agentScope: 'subagent',
                text: block.text,
                parentToolUseId: msgParentToolUseId,
                subagentType: message.subagent_type,
                taskDescription: message.task_description,
              },
            });
          }
          if (block.type === 'thinking' && block.thinking) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'thinking_delta',
                agentScope: 'subagent',
                text: block.thinking,
                parentToolUseId: msgParentToolUseId,
                subagentType: message.subagent_type,
                taskDescription: message.task_description,
              },
            });
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'tool_use_end',
                toolUseId: block.tool_use_id,
                parentToolUseId: msgParentToolUseId,
              },
            });
            const rb = block as { content?: unknown; is_error?: boolean };
            const resultText = summarizeToolResult(rb.content);
            if (resultText) {
              // ToolResultBlockParam.is_error marks a failed tool call — prefix
              // so the trace distinguishes failures from normal output.
              const shown = rb.is_error ? `⚠️ ${resultText}` : resultText;
              this.emit({
                status: 'stream',
                result: null,
                streamEvent: {
                  eventType: 'tool_result',
                  toolUseId: block.tool_use_id,
                  toolResult: shown,
                  detail: shown,
                  parentToolUseId: msgParentToolUseId,
                },
              });
            }
            activeSub?.delete(block.tool_use_id);
          }
        }
      }
    }

    return true;
  }

  /**
   * Surface tool results for the MAIN agent (parent_tool_use_id == null).
   * The sub-agent path emits its own tool_result events; the main path's
   * tool_use_end is inferred from the partial stream and the result block was
   * previously dropped entirely, so we extract it here (truncated + sanitized)
   * and emit a `tool_result` event so the trace shows what a tool returned.
   */
  processMainToolResults(message: any): void {
    if (message.type !== 'user') return;
    if ((message.parent_tool_use_id ?? null) !== null) return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const resultText = summarizeToolResult(block.content);
        if (resultText) {
          // is_error marks a failed tool call — prefix so failures stand out.
          const shown = block.is_error ? `⚠️ ${resultText}` : resultText;
          this.emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'tool_result',
              toolUseId: block.tool_use_id,
              toolResult: shown,
              detail: shown,
            },
          });
        }
      }
    }
  }

  /** Check if a tool_use was already resolved by the streaming accumulator. */
  private isPendingResolved(
    pendingMap: Map<number, { toolUseId: string; resolved: boolean }>,
    toolUseId: string,
  ): boolean {
    for (const pending of pendingMap.values()) {
      if (pending.toolUseId === toolUseId && pending.resolved) return true;
    }
    return false;
  }

  /**
   * Process an assistant message for Skill/Task fallback extraction and pending tracker cleanup.
   */
  processAssistantMessage(message: any): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    // 主 Agent thinking 补发:
    // - 子 Agent 消息 (parent_tool_use_id 非空) 的 thinking 已由 processSubAgentMessage
    //   emit (带 parentToolUseId), 这里若再 emit 会挂到主 Agent 气泡导致重复展示。
    // - 主 Agent 若 delta 路径已消费过 thinking (mainThinkingStreamed=true),
    //   再从完整 block emit 会导致同一段思考被显示两次。
    const isSubAgent = (message.parent_tool_use_id ?? null) !== null;
    if (!isSubAgent && !this.mainThinkingStreamed) {
      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          this.emit({
            status: 'stream',
            result: null,
            streamEvent: { eventType: 'thinking_delta', text: block.thinking },
          });
        }
      }
    }
    if (!isSubAgent) this.mainThinkingStreamed = false;

    // Fallback: extract skill name from complete assistant message
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Skill' &&
        block.id &&
        block.input
      ) {
        const skillName = extractSkillName(block.name, block.input);
        if (
          skillName &&
          !this.isPendingResolved(this.pendingSkillInput, block.id)
        ) {
          this.emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'tool_progress',
              toolName: 'Skill',
              toolUseId: block.id,
              skillName,
            },
          });
        }
      }
    }

    // Fallback: identify background Tasks and Teammate Tasks from complete input
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        (block.name === 'Task' || block.name === 'Agent') &&
        block.id &&
        block.input
      ) {
        const taskInput = block.input as Record<string, unknown>;
        if (taskInput.run_in_background === true) {
          this.backgroundTaskToolUseIds.add(block.id);
          this.log(`Task ${block.id.slice(0, 12)} marked as background`);
        }
        if (taskInput.team_name && !this.teammateTaskToolUseIds.has(block.id)) {
          this.teammateTaskToolUseIds.add(block.id);
          this.log(
            `Task ${block.id.slice(0, 12)} marked as teammate (team=${taskInput.team_name})`,
          );
          this.emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'task_start',
              agentScope: 'task',
              taskId: block.id,
              toolUseId: block.id,
              toolName: 'Task',
              taskDescription:
                typeof taskInput.description === 'string'
                  ? taskInput.description
                  : undefined,
              isTeammate: true,
              displayLevel: 'primary',
            },
          });
        }
      }
    }

    // Workflow is an SDK background task with a richer plan than a generic
    // Task. Surface the plan as soon as the complete tool input is available;
    // task_started/task_progress will subsequently update its runtime state.
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Workflow' &&
        block.id &&
        block.input &&
        typeof block.input === 'object'
      ) {
        this.registerTaskToolUse(block.id);
        const workflowRun = workflowRunFromToolInput(
          block.id,
          block.input as Record<string, unknown>,
        );
        this.workflowRunsByToolUseId.set(block.id, workflowRun);
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'task_start',
            agentScope: 'task',
            taskId: block.id,
            toolUseId: block.id,
            toolName: 'Workflow',
            taskType: 'local_workflow',
            workflowName: workflowRun.workflowName,
            taskDescription: workflowRun.summary,
            workflowRun,
            displayLevel: 'primary',
          },
        });
      }
    }

    // Fallback: extract AskUserQuestion input from complete assistant message
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'AskUserQuestion' &&
        block.id &&
        block.input
      ) {
        if (!this.isPendingResolved(this.pendingAskUserInput, block.id)) {
          this.emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'tool_progress',
              toolName: 'AskUserQuestion',
              toolUseId: block.id,
              toolInput: block.input as Record<string, unknown>,
            },
          });
        }
      }
    }

    // Fallback: extract TodoWrite todos from complete assistant message
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'TodoWrite' &&
        block.id &&
        block.input
      ) {
        if (!this.isPendingResolved(this.pendingTodoInput, block.id)) {
          const todoInput = block.input as Record<string, unknown>;
          if (Array.isArray(todoInput.todos)) {
            this.emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'todo_update',
                todos: todoInput.todos as Array<{
                  id: string;
                  content: string;
                  status: 'pending' | 'in_progress' | 'completed';
                }>,
              },
            });
          }
        }
      }
    }

    // Clear pending trackers to avoid memory leaks
    this.pendingSkillInput.clear();
    this.pendingTaskInput.clear();
    this.pendingAskUserInput.clear();
    this.pendingTodoInput.clear();
    this.pendingGenericInput.clear();
  }

  /**
   * Process a task_notification system message.
   * The SDK's task_id differs from the API's tool_use_id used at task creation.
   * We resolve the effective toolUseId via: message.tool_use_id → sdkTaskId map → raw task_id.
   */
  processTaskNotification(message: {
    task_id: string;
    tool_use_id?: string;
    status: string;
    summary: string;
    output_file?: string;
    usage?: any;
  }): void {
    this.backgroundDrain.taskNotification(message.task_id);
    this.settlePendingSdkTask(
      message.task_id,
      `task_notification:${message.status}`,
    );
    const effectiveToolUseId =
      message.tool_use_id ||
      this.sdkTaskIdToToolUseId.get(message.task_id) ||
      message.task_id;
    if (effectiveToolUseId !== message.task_id) {
      this.log(
        `Task notification: sdkTaskId=${message.task_id} → toolUseId=${effectiveToolUseId} status=${message.status}`,
      );
    } else {
      this.log(
        `Task notification: task=${message.task_id} status=${message.status} summary=${message.summary}`,
      );
    }
    const completedWorkflowRun = workflowRunFromOutputFile({
      taskId: effectiveToolUseId,
      outputFile: message.output_file,
      status: message.status,
      summary: message.summary,
      usage: message.usage,
    });
    this.emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'task_notification',
        agentScope: 'task',
        taskId: effectiveToolUseId,
        toolUseId: effectiveToolUseId,
        taskStatus: message.status,
        taskSummary: message.summary,
        summary: message.summary,
        outputFile: message.output_file,
        sdkTaskUsage: this.normalizeTaskUsage(message.usage),
        workflowRun: completedWorkflowRun,
        isBackground: true,
        displayLevel: 'primary',
      },
    });
    if (message.summary)
      this.taskSummariesByToolUseId.set(effectiveToolUseId, message.summary);
    // Detect orphaned background agent notifications from SDK resume.
    // These indicate a background agent was killed when the previous process exited.
    // SDK error format: "No completion record was found for background agent \"...\"
    // from the previous session." — require "No completion record" as primary signal.
    if (
      (message.status === 'failed' || message.status === 'stopped') &&
      message.summary &&
      message.summary.includes('No completion record')
    ) {
      this.orphanedAgentTaskIds.add(effectiveToolUseId);
      this.log(
        `[orphan-detect] Background agent orphaned: ${effectiveToolUseId} — "${message.summary.slice(0, 80)}"`,
      );
    }
    this.cleanupTaskTools(effectiveToolUseId);
    this.backgroundTaskToolUseIds.delete(effectiveToolUseId);
    this.workflowRunsByToolUseId.delete(effectiveToolUseId);
    if (this.taskToolUseIds.has(effectiveToolUseId)) {
      this.taskToolUseIds.delete(effectiveToolUseId);
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_end',
          toolUseId: effectiveToolUseId,
        },
      });
      if (this.activeTopLevelToolUseId === effectiveToolUseId) {
        this.activeTopLevelToolUseId = null;
      }
    }
    // Clean up the mapping entry
    this.sdkTaskIdToToolUseId.delete(message.task_id);
  }

  private settlePendingSdkTask(
    taskId: string | undefined,
    reason: string,
  ): void {
    if (!taskId || !this.pendingSdkTasks.has(taskId)) return;
    this.pendingSdkTasks.delete(taskId);
    this.log(
      `[pending-tasks] -${taskId.slice(0, 12)} (${reason}) → ${this.pendingSdkTasks.size} pending`,
    );
  }

  /** 尚未 settle 的 SDK 任务数（异步 Agent / backgrounded Bash 等）。 */
  getPendingSdkTaskCount(): number {
    return this.pendingSdkTasks.size;
  }

  /** Tasks which still make replay unsafe. A detached local bash command has
   * acknowledged startup and may outlive the turn; finite Agent/workflow tasks
   * still require their final summary. */
  getBlockingPendingSdkTaskCount(): number {
    let count = 0;
    for (const pending of this.pendingSdkTasks.values()) {
      if (!(pending.taskType === 'local_bash' && pending.isBackgrounded))
        count++;
    }
    return count;
  }

  /** Notification completions which the main Agent has not yet consumed. */
  getBlockingBackgroundCompletionDebtCount(): number {
    return this.backgroundDrain.completionDebtCount;
  }

  /**
   * Composite protocol count used for input completion. The live SDK map and
   * the replace-level tracker overlap for ordinary events, so take their max
   * before adding completion debts.
   */
  getBlockingBackgroundProtocolCount(): number {
    return (
      Math.max(
        this.getBlockingPendingSdkTaskCount(),
        this.backgroundDrain.pendingBlockingCount,
      ) + this.backgroundDrain.completionDebtCount
    );
  }

  /**
   * Main-Agent activity after a task completion notification. The next result
   * may repay the debt; activity alone is deliberately insufficient.
   */
  observeBackgroundNotificationActivity(taskId?: string): void {
    this.backgroundDrain.notificationActivityObserved(taskId);
    this.backgroundDrain.invalidateObservedResult();
  }

  /** Record a result boundary and report whether all background debt is paid. */
  observeBackgroundResult(originKind?: string): boolean {
    return this.backgroundDrain.resultObserved(originKind);
  }

  /** Used after a late authoritative level update. */
  canCompleteObservedBackgroundResult(): boolean {
    return this.backgroundDrain.canCompleteObservedResult();
  }

  invalidateObservedBackgroundResult(): void {
    this.backgroundDrain.invalidateObservedResult();
  }

  observeBackgroundNotificationWithoutQuery(): void {
    this.backgroundDrain.notificationWillNotQuery();
  }

  commitObservedBackgroundResult(): void {
    this.backgroundDrain.commitObservedResult();
  }

  requiresBackgroundResultQuiescence(): boolean {
    return this.backgroundDrain.requiresQuiescence;
  }

  /** pending 任务的简述列表，用于日志与前端提示。 */
  describePendingSdkTasks(): string[] {
    return [...this.pendingSdkTasks.values()].map((pending) =>
      shorten(pending.description, 80),
    );
  }

  /** Returns true if SDK orphaned-agent notifications were detected during this query. */
  hasOrphanedAgentNotifications(): boolean {
    return this.orphanedAgentTaskIds.size > 0;
  }

  /** Consume and clear orphaned agent task IDs (returns them for dedup in the main loop). */
  consumeOrphanedAgentTaskIds(): Set<string> {
    const ids = new Set(this.orphanedAgentTaskIds);
    this.orphanedAgentTaskIds.clear();
    return ids;
  }

  /**
   * Process a result message. Handles flushing and returns the effective result text.
   * Returns null if there's no textual result.
   */
  processResult(textResult: string | null | undefined): {
    effectiveResult: string | null;
    seenTextual: boolean;
  } {
    if (textResult) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushBuffers();
      this.seenTextualResult = true;
    }
    // Use fullTextAccumulator if it's more complete than SDK's result
    const effectiveResult =
      this.fullTextAccumulator.length > (textResult?.length || 0)
        ? this.fullTextAccumulator
        : textResult || null;
    // Reset accumulator for next query loop
    this.fullTextAccumulator = '';
    this.lastThinkingTokenStatusAt = null;
    return { effectiveResult, seenTextual: !!textResult };
  }

  /** Reset the full text accumulator (e.g., on context overflow). */
  resetFullTextAccumulator(): void {
    this.fullTextAccumulator = '';
  }

  /** Drop a provider/system notice that will be retried and must stay hidden. */
  discardPendingTextOutput(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.streamBufs.clear();
    this.fullTextAccumulator = '';
    this.lastThinkingTokenStatusAt = null;
    // Make cleanup clear rather than flush any late buffer from the spent SDK stream.
    this.seenTextualResult = true;
  }

  /**
   * Cleanup all residual state after the query loop ends.
   * Must be called after the for-await loop completes or on error.
   */
  cleanup(): void {
    // Cancel pending timer, then flush or clear remaining buffers
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.seenTextualResult) {
      // Textual result already emitted. Drop buffered tail to avoid stale residue.
      this.streamBufs.clear();
    } else {
      this.flushBuffers();
    }

    // Emit tool_use_end for active top-level tool (except Task tools)
    if (this.activeTopLevelToolUseId) {
      if (!this.taskToolUseIds.has(this.activeTopLevelToolUseId)) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: this.activeTopLevelToolUseId,
          },
        });
      }
      this.activeTopLevelToolUseId = null;
      this.activeSkillToolUseId = null;
    }

    // Safety net: emit completion signals for pending Task tools
    if (this.taskToolUseIds.size > 0) {
      this.log(
        `[safety-net] ${this.taskToolUseIds.size} Task tools still pending: [${[...this.taskToolUseIds].map((id) => id.slice(0, 12)).join(',')}]`,
      );
    }
    for (const id of this.taskToolUseIds) {
      if (!this.backgroundTaskToolUseIds.has(id)) {
        this.log(
          `[safety-net] Synthesizing task_notification for Task ${id.slice(0, 12)}`,
        );
        this.cleanupTaskTools(id);
        const summary = this.taskSummariesByToolUseId.get(id) || '';
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'task_notification',
            agentScope: 'task',
            taskId: id,
            toolUseId: id,
            taskStatus: 'completed',
            taskSummary: summary,
            summary,
            isSynthetic: true,
            displayLevel: 'primary',
          },
        });
      }
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: id },
      });
    }
    this.taskToolUseIds.clear();

    // Clean up residual nested tool tracking
    for (const [parentId, nested] of this.activeNestedToolByParent) {
      this.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_use_end',
          toolUseId: nested.toolUseId,
          parentToolUseId: parentId,
        },
      });
    }
    this.activeNestedToolByParent.clear();

    // Clean up residual sub-agent active tools
    for (const [taskId, subTools] of this.activeSubAgentToolsByTask) {
      for (const toolId of subTools) {
        this.emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'tool_use_end',
            toolUseId: toolId,
            parentToolUseId: taskId,
          },
        });
      }
    }
    this.activeSubAgentToolsByTask.clear();

    for (const pending of this.pendingSubAgentMessages.values()) {
      for (const item of pending) {
        clearTimeout(item.timer);
        this.emitRawSdkEvent(
          item.message,
          `Unmatched sub-agent message ${(item.message.parent_tool_use_id || '').slice(0, 12)}`,
          'debug',
        );
      }
    }
    this.pendingSubAgentMessages.clear();
    this.taskSummariesByToolUseId.clear();
    this.sdkTaskIdToToolUseId.clear();
    this.lastThinkingTokenStatusAt = null;
  }

  /** Get the accumulated full text (for result comparison). */
  getFullText(): string {
    return this.fullTextAccumulator;
  }
}
