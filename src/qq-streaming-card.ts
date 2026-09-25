/**
 * QQ C2C Streaming Message Controller
 *
 * Implements typewriter-style progressive message delivery using
 * QQ Bot API v2's stream_messages endpoint (C2C only).
 *
 * Protocol:
 *   POST /v2/users/{openid}/stream_messages
 *   - input_mode: "replace" (each chunk replaces entire message)
 *   - input_state: 1 (GENERATING) / 10 (DONE)
 *   - First chunk returns stream_msg_id; subsequent chunks must include it
 *   - msg_seq: shared across all chunks in the same session
 *
 * Lifecycle: idle → streaming → completed / aborted
 * Fallback: if stream API fails, falls back to plain sendQQMessage()
 *
 * ─── Inactive aux-surface scaffolding (INTENTIONALLY UNUSED) ────
 *
 * The following members are reserved for a future auxiliary-display surface
 * (thinking stream / tool activity / recent events / system status) but are
 * currently NOT surfaced to the user during streaming:
 *
 *   - thinking / thinkingText
 *   - systemStatus
 *   - tools (Map) + purgeOldTools()
 *   - recentEvents
 *   - auxiliary prefix rendering
 *   - setThinking() / appendThinking() / setSystemStatus()
 *   - startTool() / endTool() / updateToolSummary() / pushRecentEvent()
 *
 * Rationale for keeping this dormant: QQ's stream_messages endpoint enforces
 * strict prefix stability across chunks — any mutation of an aux prefix
 * mid-stream would break the protocol. These hooks are preserved so that a
 * future out-of-band aux channel (e.g. a secondary message or sidebar card)
 * can be wired in without reconstructing the tracking logic. `scheduleAuxFlush`
 * is deliberately a no-op; see the comment at its definition.
 */

import { logger } from './logger.js';
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import {
  classifyImSendFailure,
  ImDeliveryPhaseError,
  preAcceptImDeliveryError,
} from './im-send-retry-policy.js';

// ─── Constants ───────────────────────────────────────────────

const STREAM_UPDATE_INTERVAL = 500; // ms — throttle between API calls
const MAX_STREAM_CONTENT = 4500; // QQ content_raw conservative upper bound (leave small buffer under ~5000)

// ─── Types ───────────────────────────────────────────────────

/** Callback to send a stream chunk via QQ API */
export type SendStreamChunkFn = (
  openid: string,
  params: {
    input_mode: string;
    input_state: number;
    content_type: string;
    content_raw: string;
    msg_seq: number;
    index: number;
    stream_msg_id?: string;
    msg_id?: string;
    event_id?: string;
  },
) => Promise<{ id?: string }>;

/** Callback to send a plain message (fallback) */
export type FallbackSendFn = (text: string) => Promise<void>;

type StreamingState =
  | 'idle'
  | 'streaming'
  | 'completing' // complete() in progress, awaiting in-flight flush
  | 'aborting' // abort() in progress, awaiting in-flight flush
  | 'completed'
  | 'aborted';

// ─── Controller ──────────────────────────────────────────────

export class QQStreamingController {
  private state: StreamingState = 'idle';
  private accumulatedText = '';

  // Stream session state
  private streamMsgId: string | null = null;
  private msgSeq: number;
  private streamIndex = 0;
  private sentChunkCount = 0;
  private missingChunkIdLogged = false;

  // Throttle
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFlushPromise: Promise<void> | null = null;
  private flushPending = false;

  // Dependencies
  private openid: string;
  private sendStreamChunk: SendStreamChunkFn;
  private passiveMsgId: string | undefined;
  private definitiveStartRejection = false;
  private definitiveStartError: unknown;
  private uncertainStartError: unknown;
  private terminalDeliveryError: unknown;
  private onDefinitiveRejection?: (error: unknown) => boolean;

  // Tool state remains available to the shared streaming-session interface.
  private tools = new Map<
    string,
    {
      name: string;
      status: 'running' | 'complete' | 'error';
      startTime: number;
      summary?: string;
    }
  >();
  // Display limits

  constructor(opts: {
    openid: string;
    msgSeq: number;
    sendStreamChunk: SendStreamChunkFn;
    fallbackSend: FallbackSendFn;
    /** Latest incoming msg_id from this openid. Required by QQ stream API. */
    passiveMsgId?: string;
    /** Proves a failed start was rejected before any stream became visible. */
    onDefinitiveRejection?: (error: unknown) => boolean;
  }) {
    this.openid = opts.openid;
    this.msgSeq = opts.msgSeq;
    this.sendStreamChunk = opts.sendStreamChunk;
    this.passiveMsgId = opts.passiveMsgId;
    this.onDefinitiveRejection = opts.onDefinitiveRejection;
  }

  // ─── StreamingSession interface ─────────────────────────────

  isActive(): boolean {
    if (this.acceptsStreamingUpdates()) return true;
    const deliveryError =
      this.terminalDeliveryError ?? this.uncertainStartError;
    return (
      deliveryError !== undefined &&
      (this.state === 'idle' ||
        this.state === 'streaming' ||
        this.state === 'aborted') &&
      classifyImSendFailure(deliveryError) === 'uncertain'
    );
  }

  append(text: string): void {
    if (!this.acceptsStreamingUpdates()) return;
    const isFirst = this.accumulatedText.length === 0;
    this.accumulatedText = text;
    if (isFirst) {
      logger.info(
        { openid: this.openid, textLen: text.length },
        'QQ streaming first append()',
      );
    }
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
    ) {
      return;
    }
    // Enter terminal-pending state IMMEDIATELY so any text_delta arriving
    // during the awaits below is dropped by isActive(). Otherwise it would
    // overwrite accumulatedText and schedule a flush that races the DONE
    // chunk, breaking QQ's strict prefix-stability requirement.
    this.state = 'completing';
    this.clearTimers();

    // Wait for any in-flight flush to settle so we don't race the DONE chunk
    if (this.currentFlushPromise) {
      await this.currentFlushPromise.catch(() => {});
    }
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }

    // Now safe to set baseline. accumulatedText is whatever the last
    // successful flush sent (or finalText if none flushed yet).
    const baseline = this.accumulatedText;
    // DONE text must be an extension of the QQ baseline. If finalText
    // diverges from what we've already streamed, fall back to baseline
    // for the DONE chunk and let fallback path handle the difference.
    const safeFinal = finalText.startsWith(baseline) ? finalText : baseline;
    if (safeFinal !== finalText) {
      logger.warn(
        {
          openid: this.openid,
          baselineLen: baseline.length,
          finalLen: finalText.length,
        },
        'QQ streaming finalText diverges from streamed baseline, using baseline for DONE',
      );
    }
    this.accumulatedText = safeFinal;

    logger.info(
      {
        openid: this.openid,
        state: this.state,
        sentChunks: this.sentChunkCount,
        textLen: finalText.length,
      },
      'QQ streaming complete() entry',
    );

    if (!finalText.trim()) {
      this.state = 'completed';
      return;
    }

    if (this.definitiveStartRejection) {
      logger.warn(
        { openid: this.openid },
        'QQ stream start was rejected; delegating static fallback to the durable host Outbox',
      );
      const rejected = new ImDeliveryPhaseError(
        'rejected',
        'QQ stream start was definitively rejected',
        { cause: this.definitiveStartError },
      );
      this.terminalDeliveryError ??= rejected;
      this.state = 'aborted';
      throw rejected;
    }
    if (this.uncertainStartError) {
      this.terminalDeliveryError ??= this.uncertainStartError;
      this.state = 'aborted';
      throw this.uncertainStartError;
    }

    // If we never managed to start a stream, use fallback for the full text
    if (this.sentChunkCount === 0) {
      await this.tryStartStream(safeFinal);
      if (this.definitiveStartRejection) {
        const rejected = new ImDeliveryPhaseError(
          'rejected',
          'QQ stream start was definitively rejected',
          { cause: this.definitiveStartError },
        );
        this.terminalDeliveryError ??= rejected;
        this.state = 'aborted';
        throw rejected;
      }
      if (this.uncertainStartError) {
        this.terminalDeliveryError ??= this.uncertainStartError;
        this.state = 'aborted';
        throw this.uncertainStartError;
      }
      if (!this.streamMsgId) {
        this.terminalDeliveryError ??= new Error(
          'QQ streaming start returned no provider receipt; delivery outcome is uncertain',
        );
        this.state = 'aborted';
        throw this.terminalDeliveryError;
      }
    }

    try {
      // Send DONE with the prefix-safe text. In the rare divergent case,
      // safeFinal is the streamed baseline (a prefix of what we'd ideally
      // send) — DONE succeeds and the user sees a slightly truncated final.
      // Logged above; investigate via logs if it ever appears in production.
      await this.doSendChunk(safeFinal, 10); // DONE
      this.state = 'completed';
      logger.info(
        { openid: this.openid, chunks: this.sentChunkCount },
        'QQ streaming completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message, openid: this.openid },
        'QQ streaming finalize failed; refusing duplicate plain fallback',
      );
      this.terminalDeliveryError ??= new PartialChannelDeliveryError(
        this.sentChunkCount,
        this.sentChunkCount + 1,
        err,
      );
      this.state = 'aborted';
      throw this.terminalDeliveryError;
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
    ) {
      return;
    }
    // Same reasoning as complete(): block late append() during awaits below.
    this.state = 'aborting';
    this.clearTimers();

    if (this.currentFlushPromise) {
      await this.currentFlushPromise.catch(() => {});
    }
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }
    if (this.definitiveStartRejection) {
      const rejected = new ImDeliveryPhaseError(
        'rejected',
        'QQ stream start was definitively rejected',
        { cause: this.definitiveStartError },
      );
      this.terminalDeliveryError ??= rejected;
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }
    if (this.uncertainStartError !== undefined) {
      this.terminalDeliveryError ??= this.uncertainStartError;
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }

    if (this.streamMsgId) {
      // accumulatedText here reflects the last successfully-streamed baseline,
      // so appending the abort notice keeps prefix stability.
      const abortText = this.accumulatedText
        ? this.accumulatedText + `\n\n⚠️ 已中断: ${reason ?? '用户取消'}`
        : `⚠️ 已中断: ${reason ?? '用户取消'}`;
      try {
        await this.doSendChunk(abortText, 10); // DONE
      } catch (err: any) {
        logger.debug({ err: err.message }, 'QQ streaming abort chunk failed');
        this.terminalDeliveryError ??= new PartialChannelDeliveryError(
          this.sentChunkCount,
          this.sentChunkCount + 1,
          err,
        );
        this.state = 'aborted';
        throw this.terminalDeliveryError;
      }
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearTimers();
  }

  // ─── Auxiliary display methods ──────────────────────────────

  setThinking(): void {
    // QQ's prefix-stable stream has no auxiliary presentation surface.
  }

  appendThinking(_text: string): void {
    // Intentionally hidden; emitting it would violate QQ prefix stability.
  }

  setSystemStatus(_status: string | null): void {
    // Intentionally hidden; emitting it would violate QQ prefix stability.
  }

  setHook(_hook: { hookName: string; hookEvent: string } | null): void {
    // Not meaningful for QQ plain text
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Too verbose for plain text
  }

  pushRecentEvent(_text: string): void {
    // Intentionally hidden; emitting it would violate QQ prefix stability.
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
  }): Promise<void> {}

  getAllMessageIds(): string[] {
    return [];
  }

  getAcknowledgedProviderOutputCount(): number {
    return this.sentChunkCount;
  }

  private purgeOldTools(): void {
    const cutoff = Date.now() - 30_000;
    for (const [id, tc] of this.tools) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.tools.delete(id);
      }
    }
  }

  // ─── Internal: streaming ────────────────────────────────────

  private scheduleFlush(): void {
    if (!this.acceptsStreamingUpdates()) return;
    this.flushPending = true;
    // Serialize: only one flush in-flight at a time.
    // If another is running or scheduled, mark pending and let it reschedule itself.
    if (this.flushTimer || this.currentFlushPromise) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, STREAM_UPDATE_INTERVAL - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending = false;
      this.currentFlushPromise = this.doFlush()
        .catch((err: any) => {
          logger.debug({ err: err.message }, 'QQ streaming flush failed');
        })
        .finally(() => {
          this.currentFlushPromise = null;
          if (this.flushPending && this.acceptsStreamingUpdates()) {
            this.scheduleFlush();
          }
        });
    }, delay);
  }

  private scheduleAuxFlush(): void {
    // intentionally no-op: aux surface disabled to protect prefix stability invariant; see comments at top of file.
    // Aux state (thinking/tools/recentEvents/systemStatus) is still tracked
    // internally via setThinking/startTool/etc so a future out-of-band surface
    // can consume it without reconstructing tracking logic.
  }

  private async doFlush(): Promise<void> {
    if (!this.acceptsStreamingUpdates()) return;
    const rawText = this.accumulatedText;
    if (!rawText.trim()) return;
    if (this.definitiveStartRejection || this.uncertainStartError) return;

    // Length guard: QQ stream_messages caps content_raw (~5000 chars). A plain
    // fallback is safe only before any stream mutation is visible. Once a
    // preview exists, sending the whole body again would duplicate it; fence
    // the partial-visible delivery for host-side manual reconciliation.
    if (rawText.length > MAX_STREAM_CONTENT) {
      logger.warn(
        {
          openid: this.openid,
          contentLen: rawText.length,
          limit: MAX_STREAM_CONTENT,
        },
        'QQ streaming accumulated text exceeds per-chunk cap',
      );
      this.clearTimers();
      this.flushPending = false;
      if (this.sentChunkCount === 0) {
        const fallbackRequired = preAcceptImDeliveryError(
          `QQ streaming content exceeds ${MAX_STREAM_CONTENT} characters; use durable static delivery`,
        );
        this.terminalDeliveryError ??= fallbackRequired;
        this.state = 'aborted';
        throw fallbackRequired;
      }
      const overflow = new Error(
        `QQ streaming content exceeds ${MAX_STREAM_CONTENT} characters after a visible preview`,
      );
      this.terminalDeliveryError ??= new PartialChannelDeliveryError(
        this.sentChunkCount,
        this.sentChunkCount + 1,
        overflow,
      );
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }

    // CRITICAL: QQ stream API requires strict prefix stability across chunks.
    // - Never transform markdown (markdownToPlainText is non-monotonic:
    //   incomplete `**bold` stays literal, later completed `**bold**` gets stripped).
    // - Never prepend aux info (thinking/tools state changes during stream).
    // Send raw text as-is; QQ renders content_type: markdown natively.
    if (!this.streamMsgId) {
      await this.tryStartStream(rawText);
      if (!this.streamMsgId) return; // Failed, will retry next flush
    } else {
      try {
        await this.doSendChunk(rawText, 1); // GENERATING
        this.lastUpdateTime = Date.now();
      } catch (err: any) {
        logger.warn(
          { err: err.message, contentLen: rawText.length },
          'QQ streaming chunk failed',
        );
        this.terminalDeliveryError ??= new PartialChannelDeliveryError(
          this.sentChunkCount,
          this.sentChunkCount + 1,
          err,
        );
        this.state = 'aborted';
        throw this.terminalDeliveryError;
      }
    }
  }

  private async tryStartStream(content: string): Promise<void> {
    try {
      // Raw content only — no transformation. Prefix must stay stable across chunks.
      const displayContent = content.trim() || '💭 思考中...';
      const resp = await this.sendStreamChunk(this.openid, {
        input_mode: 'replace',
        input_state: 1, // GENERATING
        content_type: 'markdown',
        content_raw: displayContent,
        msg_seq: this.msgSeq,
        index: this.streamIndex++,
        msg_id: this.passiveMsgId,
        event_id: this.passiveMsgId,
      });

      if (resp.id) {
        this.streamMsgId = resp.id;
        // Only transition to 'streaming' from idle. If we're already in a
        // terminal-pending state (completing/aborting), preserve it so late
        // append() events stay blocked.
        if (this.state === 'idle') {
          this.state = 'streaming';
        }
        this.sentChunkCount++;
        this.lastUpdateTime = Date.now();
        logger.info(
          { openid: this.openid, streamMsgId: resp.id },
          'QQ streaming started',
        );
      } else {
        logger.warn(
          { openid: this.openid, resp },
          'QQ stream API returned no id; delivery outcome is uncertain',
        );
        this.uncertainStartError = new Error(
          'QQ stream API returned no provider receipt',
        );
      }
    } catch (err: any) {
      const definitivelyRejected = this.onDefinitiveRejection?.(err) === true;
      logger.warn(
        {
          err: err.message,
          openid: this.openid,
          outcome: definitivelyRejected ? 'rejected' : 'uncertain',
        },
        definitivelyRejected
          ? 'QQ streaming start was definitively rejected'
          : 'QQ streaming start failed with an uncertain outcome',
      );
      if (definitivelyRejected) {
        this.definitiveStartRejection = true;
        this.definitiveStartError = err;
      } else {
        // Reusing the same (msg_id,msg_seq) or sending a plain fallback could
        // duplicate a stream the provider accepted before its ACK was lost.
        this.uncertainStartError = err;
      }
    }
  }

  private async doSendChunk(
    content: string,
    inputState: number,
  ): Promise<void> {
    const resp = await this.sendStreamChunk(this.openid, {
      input_mode: 'replace',
      input_state: inputState,
      content_type: 'markdown',
      content_raw: content,
      msg_seq: this.msgSeq,
      index: this.streamIndex++,
      stream_msg_id: this.streamMsgId ?? undefined,
      msg_id: this.passiveMsgId,
      event_id: this.passiveMsgId,
    });
    // QQ has not published the response of follow-up GENERATING/DONE frames
    // (only the first frame's id, reused as stream_msg_id, is relied upon), so
    // a 2xx without an id still counts as delivered; it is logged once per
    // stream rather than on every throttled chunk. Explicit business errors
    // are thrown by the transport, and callers fence them as partial delivery.
    const id = resp?.id;
    if (
      (typeof id !== 'string' || id.trim() === '') &&
      !this.missingChunkIdLogged
    ) {
      this.missingChunkIdLogged = true;
      logger.warn(
        {
          openid: this.openid,
          inputState,
          responseKeys:
            resp && typeof resp === 'object' && !Array.isArray(resp)
              ? Object.keys(resp)
              : [],
        },
        'QQ stream chunk ACK has no id; treating the 2xx response as delivered',
      );
    }
    this.sentChunkCount++;
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private acceptsStreamingUpdates(): boolean {
    return (
      (this.state === 'idle' || this.state === 'streaming') &&
      !this.definitiveStartRejection &&
      this.uncertainStartError === undefined &&
      this.terminalDeliveryError === undefined
    );
  }
}
