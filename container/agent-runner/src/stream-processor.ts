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
import { extractSkillName, summarizeToolInput } from './utils.js';

type EmitFn = (output: ContainerOutput) => void;
type LogFn = (message: string) => void;

export class StreamEventProcessor {
  private readonly emit: EmitFn;
  private readonly log: LogFn;

  // Text aggregation buffers — keyed by parentToolUseId (BUF_MAIN for top-level)
  private readonly BUF_MAIN = '__main__';
  private readonly streamBufs = new Map<string, { text: string; think: string }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private seenTextualResult = false;
  private readonly FLUSH_MS = 100;
  private readonly FLUSH_CHARS = 200;

  // Full text accumulator — SDK's result.result only contains the last text block;
  // this accumulates all text_delta to produce the complete response.
  private fullTextAccumulator = '';

  // Top-level tool use tracking
  private activeTopLevelToolUseId: string | null = null;
  // Active Skill tool ID: tools called inside Skill may lack parent_tool_use_id
  private activeSkillToolUseId: string | null = null;

  // Accumulate Skill tool input_json_delta to extract skillName
  // Keyed by content block index (event.index) to match deltas correctly
  private readonly pendingSkillInput = new Map<number, {
    toolUseId: string; inputJson: string; resolved: boolean;
    parentToolUseId: string | null; isNested: boolean;
  }>();

  // Accumulate Task tool input_json_delta to extract description and team_name
  private readonly pendingTaskInput = new Map<number, {
    toolUseId: string; inputJson: string; resolved: boolean; isTeammate?: boolean;
  }>();
  // Confirmed teammate Tasks (detected via team_name)
  private readonly teammateTaskToolUseIds = new Set<string>();

  // Task tool_use_ids — tool_use_end is only emitted via tool_use_summary,
  // not prematurely when the next content block starts
  private readonly taskToolUseIds = new Set<string>();

  // Track active nested tool per parent context (for synthetic tool_use_end)
  private readonly activeNestedToolByParent = new Map<string, { toolUseId: string; toolName: string }>();

  // Background Task tool_use_ids (run_in_background: true)
  private readonly backgroundTaskToolUseIds = new Set<string>();

  // Sub-agent active tools per parent task ID
  private readonly activeSubAgentToolsByTask = new Map<string, Set<string>>();

  constructor(emit: EmitFn, log: LogFn) {
    this.emit = emit;
    this.log = log;
  }

  /** Get or create a buffer for a given key. */
  private getBuf(key: string): { text: string; think: string } {
    let b = this.streamBufs.get(key);
    if (!b) { b = { text: '', think: '' }; this.streamBufs.set(key, b); }
    return b;
  }

  /** Flush all pending text/thinking buffers. */
  private flushBuffers(): void {
    for (const [key, buf] of this.streamBufs) {
      const pid = key === this.BUF_MAIN ? undefined : key;
      if (buf.text) {
        this.emit({ status: 'stream', result: null, streamEvent: { eventType: 'text_delta', text: buf.text, parentToolUseId: pid } });
        buf.text = '';
      }
      if (buf.think) {
        this.emit({ status: 'stream', result: null, streamEvent: { eventType: 'thinking_delta', text: buf.think, parentToolUseId: pid } });
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
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flushBuffers();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushBuffers(), this.FLUSH_MS);
    }
  }

  /** Clean up tools associated with a Task. */
  private cleanupTaskTools(taskId: string): void {
    const nested = this.activeNestedToolByParent.get(taskId);
    if (nested) {
      this.emit({ status: 'stream', result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: nested.toolUseId, parentToolUseId: taskId },
      });
      this.activeNestedToolByParent.delete(taskId);
    }
    const subTools = this.activeSubAgentToolsByTask.get(taskId);
    if (subTools) {
      for (const toolId of subTools) {
        this.emit({ status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: toolId, parentToolUseId: taskId },
        });
      }
      this.activeSubAgentToolsByTask.delete(taskId);
    }
  }

  /**
   * Process a stream_event message from the SDK.
   * Returns true if the message was handled (caller should continue to next message).
   */
  processStreamEvent(message: { type: string; parent_tool_use_id?: string | null; event: any; }): boolean {
    const parentToolUseId =
      message.parent_tool_use_id === undefined ? null : message.parent_tool_use_id;
    const isNested = parentToolUseId !== null;

    const event = message.event;
    // Diagnostic log: print non-delta nested events
    if (isNested && event.type !== 'content_block_delta') {
      const evtType = event.type === 'content_block_start'
        ? `block_start/${event.content_block?.type}${event.content_block?.name ? `:${event.content_block.name}` : ''}`
        : event.type;
      this.log(`[stream-nested] parent=${parentToolUseId} evt=${evtType} tasks=[${[...this.taskToolUseIds].map(id => id.slice(0, 12)).join(',')}]`);
    }

    if (event.type === 'content_block_start') {
      const _b = event.content_block;
      this.log(`[stream] parent=${parentToolUseId ?? 'null'} block=${_b?.type}${_b?.name ? ` name=${_b.name}` : ''}${_b?.id ? ` id=${_b.id.slice(0, 12)}` : ''}`);
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
    const isInsideSkill = !isNested && this.activeSkillToolUseId && block.name !== 'Skill';
    const effectiveIsNested = isNested || !!isInsideSkill;
    const effectiveParentToolUseId = isInsideSkill ? this.activeSkillToolUseId : parentToolUseId;

    if (!effectiveIsNested && this.activeTopLevelToolUseId && this.activeTopLevelToolUseId !== block.id) {
      // Task tool_use_end only via tool_use_summary (not premature)
      if (!this.taskToolUseIds.has(this.activeTopLevelToolUseId)) {
        this.emit({
          status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: this.activeTopLevelToolUseId },
        });
      }
      if (this.activeTopLevelToolUseId === this.activeSkillToolUseId) {
        this.activeSkillToolUseId = null;
      }
    }
    if (!effectiveIsNested) this.activeTopLevelToolUseId = block.id || null;

    // Track nested tools: end previous active tool under same parent
    if (effectiveIsNested && effectiveParentToolUseId) {
      const prevNested = this.activeNestedToolByParent.get(effectiveParentToolUseId);
      if (prevNested && prevNested.toolUseId !== block.id) {
        this.emit({
          status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: prevNested.toolUseId, parentToolUseId: effectiveParentToolUseId },
        });
      }
      this.activeNestedToolByParent.set(effectiveParentToolUseId, { toolUseId: block.id || '', toolName: block.name });
    }

    this.emit({
      status: 'stream', result: null,
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
          toolUseId: block.id, inputJson: '', resolved: false,
          parentToolUseId, isNested,
        });
      }
    }

    // Track Task tool
    if (block.name === 'Task' && block.id) {
      this.taskToolUseIds.add(block.id);
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'task_start', toolUseId: block.id, toolName: 'Task' },
      });
      if (typeof blockIndex === 'number') {
        this.pendingTaskInput.set(blockIndex, {
          toolUseId: block.id, inputJson: '', resolved: false,
        });
      }
    }
  }

  /** Handle text content_block_start. */
  private handleTextBlockStart(parentToolUseId: string | null, isNested: boolean): void {
    // New text block means top-level tool has finished executing (main agent only)
    if (!isNested && this.activeTopLevelToolUseId) {
      if (!this.taskToolUseIds.has(this.activeTopLevelToolUseId)) {
        this.emit({
          status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: this.activeTopLevelToolUseId },
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
          status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: prevNested.toolUseId, parentToolUseId },
        });
        this.activeNestedToolByParent.delete(parentToolUseId);
      }
    }
  }

  /** Handle content_block_delta events (text, thinking, input_json). */
  private handleContentBlockDelta(event: any, parentToolUseId: string | null): void {
    const delta = event.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      const bufKey = parentToolUseId || this.BUF_MAIN;
      this.getBuf(bufKey).text += delta.text;
      if (bufKey === this.BUF_MAIN) this.fullTextAccumulator += delta.text;
      this.scheduleFlush();
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
      const bufKey = parentToolUseId || this.BUF_MAIN;
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
          status: 'stream', result: null,
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

    // Accumulate Task input JSON
    const pendingTask = this.pendingTaskInput.get(blockIndex);
    if (pendingTask && !pendingTask.resolved) {
      pendingTask.inputJson += partialJson;
      // Detect team_name
      if (!pendingTask.isTeammate) {
        const teamMatch = pendingTask.inputJson.match(/"team_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (teamMatch) {
          pendingTask.isTeammate = true;
          this.teammateTaskToolUseIds.add(pendingTask.toolUseId);
        }
      }
      const descMatch = pendingTask.inputJson.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (descMatch) {
        pendingTask.resolved = true;
        this.pendingTaskInput.delete(blockIndex);
        const isTeammate = pendingTask.isTeammate || false;
        if (isTeammate) this.teammateTaskToolUseIds.add(pendingTask.toolUseId);
        this.emit({
          status: 'stream', result: null,
          streamEvent: {
            eventType: 'task_start',
            toolUseId: pendingTask.toolUseId,
            toolName: 'Task',
            taskDescription: descMatch[1].replace(/\\"/g, '"').slice(0, 200),
            ...(isTeammate ? { isTeammate: true } : {}),
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
      message.parent_tool_use_id === undefined ? null : message.parent_tool_use_id;
    this.emit({
      status: 'stream', result: null,
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
      ? message.preceding_tool_use_ids.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    this.log(`[tool_use_summary] ids=[${ids.map((id: string) => id.slice(0, 12)).join(',')}] taskToolUseIds=[${[...this.taskToolUseIds].map(id => id.slice(0, 12)).join(',')}] bgTasks=[${[...this.backgroundTaskToolUseIds].map(id => id.slice(0, 12)).join(',')}]`);
    for (const id of ids) {
      // Foreground Task completion: synthesize task_notification
      if (this.taskToolUseIds.has(id) && !this.backgroundTaskToolUseIds.has(id)) {
        this.log(`Synthesizing task_notification for foreground Task ${id.slice(0, 12)}`);
        this.cleanupTaskTools(id);
        this.emit({
          status: 'stream', result: null,
          streamEvent: {
            eventType: 'task_notification',
            taskId: id,
            taskStatus: 'completed',
            taskSummary: '',
          },
        });
      }
      this.taskToolUseIds.delete(id);
      this.backgroundTaskToolUseIds.delete(id);
      this.emit({
        status: 'stream', result: null,
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
    if (message.subtype === 'status') {
      const statusText = message.status?.type || null;
      this.emit({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText } });
      return true;
    }
    if (message.subtype === 'hook_started') {
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'hook_started', hookName: message.hook_name, hookEvent: message.hook_event },
      });
      return true;
    }
    if (message.subtype === 'hook_progress') {
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'hook_progress', hookName: message.hook_name, hookEvent: message.hook_event },
      });
      return true;
    }
    if (message.subtype === 'hook_response') {
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'hook_response', hookName: message.hook_name, hookEvent: message.hook_event, hookOutcome: message.outcome },
      });
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
      return false;
    }

    if (message.type === 'assistant') {
      const subContent = message.message?.content as Array<{
        type: string; text?: string; thinking?: string;
        name?: string; id?: string; input?: Record<string, unknown>;
      }> | undefined;
      if (Array.isArray(subContent)) {
        // End previous sub-agent active tools
        const prevTools = this.activeSubAgentToolsByTask.get(msgParentToolUseId);
        if (prevTools && prevTools.size > 0) {
          for (const toolId of prevTools) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'tool_use_end', toolUseId: toolId, parentToolUseId: msgParentToolUseId },
            });
          }
          prevTools.clear();
        }
        for (const block of subContent) {
          if (block.type === 'thinking' && block.thinking) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'thinking_delta', text: block.thinking, parentToolUseId: msgParentToolUseId },
            });
          }
          if (block.type === 'text' && block.text) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'text_delta', text: block.text, parentToolUseId: msgParentToolUseId },
            });
          }
          if (block.type === 'tool_use' && block.id) {
            this.emit({ status: 'stream', result: null,
              streamEvent: {
                eventType: 'tool_use_start',
                toolName: block.name || 'unknown',
                toolUseId: block.id,
                parentToolUseId: msgParentToolUseId,
                isNested: true,
                toolInputSummary: summarizeToolInput(block.input),
              },
            });
            if (!this.activeSubAgentToolsByTask.has(msgParentToolUseId)) {
              this.activeSubAgentToolsByTask.set(msgParentToolUseId, new Set());
            }
            this.activeSubAgentToolsByTask.get(msgParentToolUseId)!.add(block.id);
          }
        }
        this.log(`[sub-agent] parent=${msgParentToolUseId.slice(0, 12)} blocks=${subContent.length} types=[${subContent.map(b => b.type).join(',')}]`);
      }
    }

    if (message.type === 'user') {
      const rawContent = message.message?.content;
      if (typeof rawContent === 'string' && rawContent) {
        this.emit({ status: 'stream', result: null,
          streamEvent: { eventType: 'text_delta', text: rawContent, parentToolUseId: msgParentToolUseId },
        });
      } else if (Array.isArray(rawContent)) {
        const activeSub = this.activeSubAgentToolsByTask.get(msgParentToolUseId);
        for (const block of rawContent as Array<{ type: string; text?: string; thinking?: string; tool_use_id?: string }>) {
          if (block.type === 'text' && block.text) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'text_delta', text: block.text, parentToolUseId: msgParentToolUseId },
            });
          }
          if (block.type === 'thinking' && block.thinking) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'thinking_delta', text: block.thinking, parentToolUseId: msgParentToolUseId },
            });
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.emit({ status: 'stream', result: null,
              streamEvent: { eventType: 'tool_use_end', toolUseId: block.tool_use_id, parentToolUseId: msgParentToolUseId },
            });
            activeSub?.delete(block.tool_use_id);
          }
        }
      }
    }

    return true;
  }

  /**
   * Process an assistant message for Skill/Task fallback extraction and pending tracker cleanup.
   */
  processAssistantMessage(message: any): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    // Fallback: extract skill name from complete assistant message
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Skill' && block.id && block.input) {
        const skillName = extractSkillName(block.name, block.input);
        if (skillName) {
          let alreadyResolved = false;
          for (const pending of this.pendingSkillInput.values()) {
            if (pending.toolUseId === block.id && pending.resolved) {
              alreadyResolved = true;
              break;
            }
          }
          if (!alreadyResolved) {
            this.emit({
              status: 'stream', result: null,
              streamEvent: { eventType: 'tool_progress', toolName: 'Skill', toolUseId: block.id, skillName },
            });
          }
        }
      }
    }

    // Fallback: identify background Tasks and Teammate Tasks from complete input
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Task' && block.id && block.input) {
        const taskInput = block.input as Record<string, unknown>;
        if (taskInput.run_in_background === true) {
          this.backgroundTaskToolUseIds.add(block.id);
          this.log(`Task ${block.id.slice(0, 12)} marked as background`);
        }
        if (taskInput.team_name && !this.teammateTaskToolUseIds.has(block.id)) {
          this.teammateTaskToolUseIds.add(block.id);
          this.log(`Task ${block.id.slice(0, 12)} marked as teammate (team=${taskInput.team_name})`);
          this.emit({
            status: 'stream', result: null,
            streamEvent: { eventType: 'task_start', toolUseId: block.id, toolName: 'Task', isTeammate: true },
          });
        }
      }
    }

    // Clear pending trackers to avoid memory leaks
    this.pendingSkillInput.clear();
    this.pendingTaskInput.clear();
  }

  /**
   * Process a task_notification system message.
   */
  processTaskNotification(message: { task_id: string; status: string; summary: string }): void {
    this.log(`Task notification: task=${message.task_id} status=${message.status} summary=${message.summary}`);
    this.emit({
      status: 'stream', result: null,
      streamEvent: {
        eventType: 'task_notification',
        taskId: message.task_id,
        taskStatus: message.status,
        taskSummary: message.summary,
      },
    });
    this.cleanupTaskTools(message.task_id);
    this.backgroundTaskToolUseIds.delete(message.task_id);
    if (this.taskToolUseIds.has(message.task_id)) {
      this.taskToolUseIds.delete(message.task_id);
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: message.task_id },
      });
      if (this.activeTopLevelToolUseId === message.task_id) {
        this.activeTopLevelToolUseId = null;
      }
    }
  }

  /**
   * Process a result message. Handles flushing and returns the effective result text.
   * Returns null if there's no textual result.
   */
  processResult(textResult: string | null | undefined): { effectiveResult: string | null; seenTextual: boolean } {
    if (textResult) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.flushBuffers();
      this.seenTextualResult = true;
    }
    // Use fullTextAccumulator if it's more complete than SDK's result
    const effectiveResult = this.fullTextAccumulator.length > (textResult?.length || 0)
      ? this.fullTextAccumulator
      : (textResult || null);
    // Reset accumulator for next query loop
    this.fullTextAccumulator = '';
    return { effectiveResult, seenTextual: !!textResult };
  }

  /** Reset the full text accumulator (e.g., on context overflow). */
  resetFullTextAccumulator(): void {
    this.fullTextAccumulator = '';
  }

  /**
   * Cleanup all residual state after the query loop ends.
   * Must be called after the for-await loop completes or on error.
   */
  cleanup(): void {
    // Cancel pending timer, then flush or clear remaining buffers
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
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
          status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: this.activeTopLevelToolUseId },
        });
      }
      this.activeTopLevelToolUseId = null;
      this.activeSkillToolUseId = null;
    }

    // Safety net: emit completion signals for pending Task tools
    if (this.taskToolUseIds.size > 0) {
      this.log(`[safety-net] ${this.taskToolUseIds.size} Task tools still pending: [${[...this.taskToolUseIds].map(id => id.slice(0, 12)).join(',')}]`);
    }
    for (const id of this.taskToolUseIds) {
      if (!this.backgroundTaskToolUseIds.has(id)) {
        this.log(`[safety-net] Synthesizing task_notification for Task ${id.slice(0, 12)}`);
        this.cleanupTaskTools(id);
        this.emit({
          status: 'stream', result: null,
          streamEvent: { eventType: 'task_notification', taskId: id, taskStatus: 'completed', taskSummary: '' },
        });
      }
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: id },
      });
    }
    this.taskToolUseIds.clear();

    // Clean up residual nested tool tracking
    for (const [parentId, nested] of this.activeNestedToolByParent) {
      this.emit({
        status: 'stream', result: null,
        streamEvent: { eventType: 'tool_use_end', toolUseId: nested.toolUseId, parentToolUseId: parentId },
      });
    }
    this.activeNestedToolByParent.clear();

    // Clean up residual sub-agent active tools
    for (const [taskId, subTools] of this.activeSubAgentToolsByTask) {
      for (const toolId of subTools) {
        this.emit({ status: 'stream', result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: toolId, parentToolUseId: taskId },
        });
      }
    }
    this.activeSubAgentToolsByTask.clear();
  }

  /** Get the accumulated full text (for result comparison). */
  getFullText(): string {
    return this.fullTextAccumulator;
  }
}
