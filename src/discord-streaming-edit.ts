/**
 * Discord Streaming Edit Controller
 *
 * Implements the same public API as DingTalkStreamingCardController so that
 * `feedStreamEventToCard()` can drive it without modification.
 *
 * Discord message edit lifecycle:
 *   1. channel.send() — create initial placeholder message
 *   2. message.edit() — throttled streaming updates (500ms)
 *   3. message.edit() — final content (may split into multiple messages if >2000 chars)
 *
 * Discord limits each message to 2000 characters. When content exceeds this,
 * the controller finalises the current message and sends continuation messages,
 * preserving code fence state across splits.
 */

import type { TextChannel, DMChannel, NewsChannel, Message } from 'discord.js';
import { logger } from './logger.js';
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import {
  classifyImSendFailure,
  explicitImDeliveryPhase,
  ImDeliveryPhaseError,
  preAcceptImDeliveryError,
} from './im-send-retry-policy.js';

// ─── Constants ───────────────────────────────────────────────

const STREAM_UPDATE_INTERVAL = 500; // ms
const DISCORD_MSG_LIMIT = 2000;
const MAX_THINKING_CHARS = 500;
const MAX_TOOLS_DISPLAY = 5;
const MAX_TOOL_SUMMARY_CHARS = 60;
const MAX_RECENT_EVENTS = 5;

function discordMessageCreateError(error: unknown): unknown {
  if (explicitImDeliveryPhase(error) !== undefined) return error;
  const status = Number(
    (error as { status?: unknown; httpStatus?: unknown } | null)?.status ??
      (error as { httpStatus?: unknown } | null)?.httpStatus,
  );
  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  ) {
    return new ImDeliveryPhaseError(
      'rejected',
      `Discord message create was rejected with HTTP ${status}`,
      { cause: error },
    );
  }
  return error;
}

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completing'
  | 'aborting'
  | 'completed'
  | 'aborted'
  | 'error';

// ─── Controller ──────────────────────────────────────────────

export class DiscordStreamingEditController {
  private state: StreamingState = 'idle';
  private channel: TextChannel | DMChannel | NewsChannel;
  private onCardCreated?: (messageId: string) => void;

  // Message state — we may need multiple messages if text exceeds 2000 chars
  private messages: Message[] = [];
  private accumulatedText = '';

  // Throttle
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFlushPromise: Promise<void> | null = null;
  private flushPending = false;

  // Auxiliary flush throttle
  private auxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAuxFlushPromise: Promise<void> | null = null;
  private auxFlushPending = false;
  private lastAuxFlushTime = 0;
  private static readonly AUX_FLUSH_INTERVAL = 1500; // ms

  // Auxiliary state (thinking, tools, status)
  private thinking = false;
  private thinkingText = '';
  private systemStatus: string | null = null;
  private tools = new Map<
    string,
    {
      name: string;
      status: 'running' | 'complete' | 'error';
      startTime: number;
      summary?: string;
    }
  >();
  private recentEvents: string[] = [];

  private terminalDeliveryError: unknown;
  // Creation guard
  private messageCreationPromise: Promise<void> | null = null;
  private messageCreationError: unknown;
  // 上次已推送到 Discord 的完整 content（含 aux prefix），用于跳过 no-op edit，
  // 避免在文本/工具状态未变化时仍占用 Discord 的 5/5s edit 配额。
  private lastPushedContent: string | null = null;

  constructor(
    channel: TextChannel | DMChannel | NewsChannel,
    opts?: {
      onCardCreated?: (messageId: string) => void;
      fallbackSend?: (text: string) => Promise<void>;
    },
  ) {
    this.channel = channel;
    this.onCardCreated = opts?.onCardCreated;
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  isActive(): boolean {
    return (
      this.acceptsStreamingUpdates() ||
      ((this.state === 'error' || this.state === 'aborted') &&
        this.terminalDeliveryError !== undefined &&
        classifyImSendFailure(this.terminalDeliveryError) === 'uncertain')
    );
  }

  append(text: string): void {
    if (!this.acceptsStreamingUpdates()) return;
    this.accumulatedText = text; // Full replacement (same as DingTalk pattern)
    this.thinkingText = ''; // Clear reasoning once real text arrives
    this.thinking = false; // No longer in active thinking phase
    this.scheduleFlush();
  }

  async complete(finalText: string): Promise<void> {
    if (this.terminalDeliveryError !== undefined) {
      throw this.terminalDeliveryError;
    }
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'completing' ||
      this.state === 'aborting'
    )
      return;
    this.state = 'completing';
    this.clearFlushTimer();
    if (this.currentFlushPromise)
      await this.currentFlushPromise.catch(() => {});
    if (this.currentAuxFlushPromise)
      await this.currentAuxFlushPromise.catch(() => {});
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }
    this.accumulatedText = finalText;

    // Empty final: never leave a thinking placeholder behind with a false ACK.
    // Mirror abort() by awaiting in-flight create, then terminalize any visible
    // message (edit to empty-notice) before success. Mutation failure surfaces
    // Partial/uncertain so the host does not skip static fallback.
    if (!finalText.trim()) {
      if (this.messageCreationPromise) {
        await this.messageCreationPromise.catch(() => {});
      }
      if (this.terminalDeliveryError !== undefined) {
        this.state = 'aborted';
        throw this.terminalDeliveryError;
      }

      if (this.messages.length === 0) {
        this.state = 'completed';
        return;
      }

      this.thinkingText = '';
      this.thinking = false;
      const emptyNotice = '> ⚠️ 本次运行没有生成可展示的最终内容。';
      try {
        const lastMsg = this.messages[this.messages.length - 1];
        await lastMsg.edit(emptyNotice);
        this.lastPushedContent = emptyNotice;
        this.state = 'completed';
        return;
      } catch (err: any) {
        logger.warn(
          { err: err.message },
          'Discord empty-complete placeholder terminalize failed',
        );
        throw this.terminalizeDeliveryFailure(err);
      }
    }

    logger.info(
      {
        state: this.state,
        hasMessages: this.messages.length > 0,
        textLen: finalText.length,
      },
      'Discord streaming edit complete() called',
    );

    // Ensure message exists before finalizing
    try {
      await this.ensureMessage();
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'Discord ensureMessage failed in complete()',
      );
      throw this.terminalizeDeliveryFailure(err);
    }

    if (this.messages.length === 0) {
      logger.warn(
        { state: this.state },
        'Discord complete(): no messages after ensureMessage',
      );
      const creationError =
        this.terminalDeliveryError ??
        this.messageCreationError ??
        preAcceptImDeliveryError('Discord streaming message was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    try {
      // Clear auxiliary state for final render — only keep reply body
      this.thinkingText = '';
      this.thinking = false;

      // Split and send final content (clean, no aux prefix)
      await this.splitAndSend(finalText);
      this.state = 'completed';
      logger.info(
        { messageCount: this.messages.length },
        'Discord streaming edit completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'Discord streaming edit finalize failed, degrading',
      );
      throw this.terminalizeDeliveryFailure(err);
    }
  }

  async abort(reason?: string): Promise<void> {
    if (this.terminalDeliveryError !== undefined) {
      throw this.terminalDeliveryError;
    }
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'completing' ||
      this.state === 'aborting'
    )
      return;
    this.state = 'aborting';
    this.clearFlushTimer();
    if (this.currentFlushPromise)
      await this.currentFlushPromise.catch(() => {});
    if (this.currentAuxFlushPromise)
      await this.currentAuxFlushPromise.catch(() => {});
    if (this.messageCreationPromise)
      await this.messageCreationPromise.catch(() => {});
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }

    const displayText = this.accumulatedText
      ? this.accumulatedText + `\n\n> ⚠️ 已中断: ${reason ?? '用户取消'}`
      : `⚠️ 已中断: ${reason ?? '用户取消'}`;

    if (this.messages.length === 0) {
      this.state = 'aborted';
      return;
    }

    try {
      const lastMsg = this.messages[this.messages.length - 1];
      const truncated = displayText.slice(-DISCORD_MSG_LIMIT);
      await lastMsg.edit(truncated);
    } catch (err: any) {
      logger.debug(
        { err: err.message },
        'Discord streaming edit abort update failed',
      );
      throw this.terminalizeDeliveryFailure(err);
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearFlushTimer();
  }

  // ─── Auxiliary display (prepended as markdown) ─────────────

  setThinking(): void {
    this.thinking = true;
    if (this.messages.length === 0 && this.state === 'idle') {
      // Trigger message creation early so user sees placeholder
      this.state = 'creating';
      this.ensureMessage().catch(() => {
        this.state = 'error';
      });
    }
  }

  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;
    if (this.messages.length === 0 && this.state === 'idle') {
      this.state = 'creating';
      this.ensureMessage().catch(() => {
        this.state = 'error';
      });
    } else if (this.state === 'streaming') {
      this.scheduleAuxFlush();
    }
  }

  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  setHook(_hook: { hookName: string; hookEvent: string } | null): void {
    // Hooks are less meaningful in Discord — skip rendering
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Todos are too verbose for Discord messages — skip
  }

  pushRecentEvent(text: string): void {
    this.recentEvents.push(text);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
    // Piggyback on other flush events — don't trigger standalone flush
  }

  startTool(toolId: string, toolName: string): void {
    this.tools.set(toolId, {
      name: toolName,
      status: 'running',
      startTime: Date.now(),
    });
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  endTool(toolId: string, isError: boolean): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      this.purgeOldTools();
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  updateToolSummary(toolId: string, summary: string): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.summary = summary;
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  getToolInfo(toolId: string): { name: string } | undefined {
    return this.tools.get(toolId);
  }

  async patchUsageNote(_usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {
    // Usage notes are not meaningful for Discord messages — no-op
  }

  getAllMessageIds(): string[] {
    return this.messages.map((m) => m.id);
  }

  getAcknowledgedProviderOutputCount(): number {
    return this.messages.length;
  }

  // ─── Auxiliary Build ────────────────────────────────────────

  /**
   * Build auxiliary prefix (thinking + tools + status) to prepend to content.
   * Renders as compact markdown above the main response text.
   */
  private buildAuxPrefix(): string {
    const parts: string[] = [];

    // 1. System status
    if (this.systemStatus) {
      parts.push(`⏳ ${this.systemStatus}`);
    }

    // 2. Thinking / Reasoning
    if (this.thinkingText) {
      const label = this.thinking ? '💭 **Reasoning...**' : '💭 **Reasoned**';
      const truncated =
        this.thinkingText.length > MAX_THINKING_CHARS
          ? '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3))
          : this.thinkingText;
      const quoted = truncated
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      parts.push(`${label}\n${quoted}`);
    } else if (this.thinking) {
      parts.push('💭 **Thinking...**');
    }

    // 3. Active tools
    const now = Date.now();
    const display: Array<{
      name: string;
      status: string;
      elapsed: string;
      summary?: string;
    }> = [];
    for (const [, tc] of this.tools) {
      if (display.length >= MAX_TOOLS_DISPLAY) break;
      const elapsed = DiscordStreamingEditController.formatElapsed(
        now - tc.startTime,
      );
      display.push({
        name: tc.name,
        status: tc.status,
        elapsed,
        summary: tc.summary,
      });
    }
    if (display.length > 0) {
      const lines = display.map((d) => {
        const icon =
          d.status === 'running' ? '🔄' : d.status === 'complete' ? '✅' : '❌';
        const summary = d.summary
          ? `  ${d.summary.length > MAX_TOOL_SUMMARY_CHARS ? d.summary.slice(0, MAX_TOOL_SUMMARY_CHARS) + '...' : d.summary}`
          : '';
        return `${icon} \`${d.name}\` (${d.elapsed})${summary}`;
      });
      parts.push(lines.join('\n'));
    }

    // 4. Recent events
    if (this.recentEvents.length > 0) {
      const eventLines = this.recentEvents.map((e) => `- ${e}`);
      parts.push(`📝 **调用轨迹**\n${eventLines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n---\n\n' : '';
  }

  /** Format elapsed time */
  private static formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    return `${min}m ${Math.floor(sec % 60)}s`;
  }

  /** Purge completed/error tools older than 30s */
  private purgeOldTools(): void {
    const cutoff = Date.now() - 30_000;
    for (const [id, tc] of this.tools) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.tools.delete(id);
      }
    }
  }

  /** Schedule auxiliary-only flush (throttled) */
  private scheduleAuxFlush(): void {
    if (!this.acceptsStreamingUpdates()) return;
    this.auxFlushPending = true;
    if (
      this.auxFlushTimer ||
      this.currentAuxFlushPromise ||
      this.flushTimer ||
      this.currentFlushPromise
    )
      return;
    const elapsed = Date.now() - this.lastAuxFlushTime;
    const delay = Math.max(
      0,
      DiscordStreamingEditController.AUX_FLUSH_INTERVAL - elapsed,
    );
    this.auxFlushTimer = setTimeout(() => {
      this.auxFlushTimer = null;
      if (!this.acceptsStreamingUpdates()) {
        this.auxFlushPending = false;
        return;
      }
      if (this.currentFlushPromise || this.currentAuxFlushPromise) return;
      this.auxFlushPending = false;
      this.lastAuxFlushTime = Date.now();
      // Push combined content (aux prefix + main text)
      const content = this.buildAuxPrefix() + this.accumulatedText;
      this.currentAuxFlushPromise = this.editLastMessage(content)
        .catch((err: any) => {
          this.terminalizeDeliveryFailure(err);
          logger.debug({ err: err.message }, 'Discord aux flush failed');
        })
        .finally(() => {
          this.currentAuxFlushPromise = null;
          if (this.flushPending && this.acceptsStreamingUpdates()) {
            this.scheduleFlush();
          } else if (this.auxFlushPending && this.acceptsStreamingUpdates()) {
            this.scheduleAuxFlush();
          }
        });
    }, delay);
  }

  // ─── Internal: message creation ────────────────────────────

  private async ensureMessage(): Promise<void> {
    if (this.messages.length > 0) return;

    // If message creation is already in progress, await it
    if (this.messageCreationPromise) {
      await this.messageCreationPromise;
      return;
    }

    if (this.state !== 'completing' && this.state !== 'aborting') {
      this.state = 'creating';
    }
    this.messageCreationPromise = (async () => {
      try {
        const msg = await this.channel.send('💭 思考中...');
        this.messages.push(msg);
        this.messageCreationError = undefined;
        if (this.state === 'creating') this.state = 'streaming';
        if (this.onCardCreated) this.onCardCreated(msg.id);
      } catch (err: any) {
        const creationError = discordMessageCreateError(err);
        this.messageCreationError = creationError;
        this.terminalizeDeliveryFailure(creationError);
        logger.warn(
          { err: err.message },
          'Discord initial message creation failed',
        );
      } finally {
        this.messageCreationPromise = null;
      }
    })();

    try {
      await this.messageCreationPromise;
    } catch {
      // Already handled inside the promise
    }
  }

  // ─── Internal: streaming ────────────────────────────────────

  private scheduleFlush(): void {
    if (!this.acceptsStreamingUpdates()) return;
    this.flushPending = true;
    if (
      this.flushTimer ||
      this.currentFlushPromise ||
      this.auxFlushTimer ||
      this.currentAuxFlushPromise
    )
      return;

    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, STREAM_UPDATE_INTERVAL - elapsed);

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.currentFlushPromise || this.currentAuxFlushPromise) return;
      this.flushPending = false;
      this.currentFlushPromise = this.doFlush()
        .catch((err: any) => {
          this.terminalizeDeliveryFailure(err);
          logger.debug(
            { err: err.message },
            'Discord streaming edit flush failed',
          );
        })
        .finally(() => {
          this.currentFlushPromise = null;
          if (this.flushPending && this.acceptsStreamingUpdates()) {
            this.scheduleFlush();
          } else if (this.auxFlushPending && this.acceptsStreamingUpdates()) {
            this.scheduleAuxFlush();
          }
        });
    }, delay);
  }

  private async doFlush(): Promise<void> {
    if (!this.acceptsStreamingUpdates()) return;

    if (!this.accumulatedText.trim() && !this.thinking && !this.systemStatus) {
      return;
    }

    // Let the host choose the one durable static fallback. The controller
    // cannot know whether a failed creation request was accepted before its
    // ACK was lost.
    if (this.state === 'error') {
      const creationError =
        this.messageCreationError ??
        preAcceptImDeliveryError('Discord streaming message was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    await this.ensureMessage();

    if (this.messages.length === 0) {
      const creationError =
        this.messageCreationError ??
        preAcceptImDeliveryError('Discord streaming message was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    const content = this.buildAuxPrefix() + this.accumulatedText;

    // During streaming, if content exceeds limit, truncate from the beginning
    // (full split only happens on complete())
    if (content.length > DISCORD_MSG_LIMIT) {
      const truncated = '...' + content.slice(-(DISCORD_MSG_LIMIT - 3));
      await this.editLastMessage(truncated);
    } else {
      await this.editLastMessage(content);
    }

    this.lastUpdateTime = Date.now();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.auxFlushTimer) {
      clearTimeout(this.auxFlushTimer);
      this.auxFlushTimer = null;
    }
  }

  private acceptsStreamingUpdates(): boolean {
    return (
      (this.state === 'idle' ||
        this.state === 'creating' ||
        this.state === 'streaming') &&
      this.terminalDeliveryError === undefined
    );
  }

  private terminalizeDeliveryFailure(error: unknown): unknown {
    const deliveryError =
      this.messages.length > 0 &&
      !(error instanceof PartialChannelDeliveryError)
        ? new PartialChannelDeliveryError(
            this.messages.length,
            this.messages.length + 1,
            error,
          )
        : error;
    this.terminalDeliveryError ??= deliveryError;
    this.state = 'aborted';
    this.clearFlushTimer();
    return this.terminalDeliveryError;
  }

  /**
   * Edit the last message in the chain. discord.js handles rate limits
   * internally via its built-in queue, so we don't need manual retry logic.
   */
  private async editLastMessage(content: string): Promise<void> {
    if (this.messages.length === 0) return;
    const payload = content || '\u200b'; // Zero-width space if empty
    if (payload === this.lastPushedContent) return;
    const lastMsg = this.messages[this.messages.length - 1];
    try {
      await lastMsg.edit(payload);
      this.lastPushedContent = payload;
    } catch (err: any) {
      logger.debug(
        { err: err.message, messageId: lastMsg.id },
        'Discord message edit failed',
      );
      throw err;
    }
  }

  /**
   * Split final text into 2000-char chunks preserving code fences,
   * editing existing messages and sending new ones as needed.
   */
  private async splitAndSend(fullContent: string): Promise<void> {
    const chunks = splitWithCodeFences(fullContent, DISCORD_MSG_LIMIT);
    let firstError: Error | null = null;
    let acknowledgedOutputs = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (i < this.messages.length) {
        // Edit existing message
        try {
          await this.messages[i].edit(chunks[i]);
          acknowledgedOutputs += 1;
        } catch (err: any) {
          logger.warn(
            { err: err.message, index: i },
            'Discord message edit failed during split',
          );
          if (!firstError) firstError = err;
          break;
        }
      } else {
        // Send new continuation message
        try {
          const msg = await this.channel.send(chunks[i]);
          this.messages.push(msg);
          acknowledgedOutputs += 1;
        } catch (err: any) {
          logger.warn(
            { err: err.message, index: i },
            'Discord continuation message send failed',
          );
          if (!firstError) firstError = err;
          break;
        }
      }
    }

    // Propagate the first error. Once any final mutation has an ACK, an
    // all-text fallback would duplicate that prefix and must be fenced.
    if (firstError) {
      if (acknowledgedOutputs > 0) {
        throw new PartialChannelDeliveryError(
          acknowledgedOutputs,
          chunks.length,
          firstError,
        );
      }
      throw firstError;
    }
  }
}

// ─── Code fence-aware text splitting ─────────────────────────

/**
 * Split text into chunks of at most `limit` characters, preserving code fences.
 *
 * When a split occurs inside a fenced code block (``` ... ```), the current
 * chunk is closed with ``` and the next chunk reopens with ```lang.
 */
function splitWithCodeFences(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeFenceLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point — prefer splitting at newlines near the limit
    let splitAt = limit;

    // Reserve space for potential closing/opening fences
    const reservedChars = insideCodeBlock ? 8 : 0; // "```\n" = 4, "```lang\n" ≈ up to ~20
    const effectiveLimit = limit - reservedChars;

    // Look for a newline near the effective limit (search within last 200 chars)
    const searchStart = Math.max(0, effectiveLimit - 200);
    const searchRegion = remaining.slice(searchStart, effectiveLimit);
    const lastNewline = searchRegion.lastIndexOf('\n');
    if (lastNewline !== -1) {
      splitAt = searchStart + lastNewline + 1; // Split after the newline
    } else {
      splitAt = effectiveLimit;
    }

    // Ensure we always make progress
    if (splitAt <= 0) splitAt = effectiveLimit > 0 ? effectiveLimit : limit;

    let chunk = remaining.slice(0, splitAt);

    // Track code fence state within this chunk
    const fenceState = trackCodeFences(chunk, insideCodeBlock, codeFenceLang);

    if (fenceState.insideCodeBlock) {
      // We're splitting inside a code block — close it
      chunk = chunk + '\n```';
      insideCodeBlock = true;
      codeFenceLang = fenceState.lang;
    } else {
      insideCodeBlock = false;
      codeFenceLang = '';
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt);

    // If we were inside a code block, reopen it in the next chunk
    if (insideCodeBlock && remaining.length > 0) {
      const opener = codeFenceLang ? '```' + codeFenceLang + '\n' : '```\n';
      remaining = opener + remaining;
    }
  }

  return chunks;
}

/**
 * Simple state machine to track whether we end up inside a code fence
 * after processing the given text.
 */
function trackCodeFences(
  text: string,
  initiallyInside: boolean,
  initialLang: string,
): { insideCodeBlock: boolean; lang: string } {
  let inside = initiallyInside;
  let lang = initialLang;

  // Match lines that start with ``` (with optional language tag)
  const fenceRegex = /^(`{3,})(.*)?$/gm;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (!inside) {
      // Opening fence
      inside = true;
      lang = (match[2] || '').trim();
    } else {
      // Closing fence
      inside = false;
      lang = '';
    }
  }

  return { insideCodeBlock: inside, lang };
}
