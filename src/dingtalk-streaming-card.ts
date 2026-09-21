/**
 * DingTalk AI Card Streaming Controller
 *
 * Implements the same public API as Feishu's StreamingCardController so that
 * `feedStreamEventToCard()` can drive it without modification.
 *
 * DingTalk AI Card API lifecycle:
 *   1. POST /v1.0/card/instances        → create card
 *   2. POST /v1.0/card/instances/deliver → deliver to user/group
 *   3. PUT  /v1.0/card/instances         → switch to INPUTING
 *   4. PUT  /v1.0/card/streaming         → stream content (throttled 500ms)
 *   5. PUT  /v1.0/card/streaming         → isFinalize=true (last frame)
 *   6. PUT  /v1.0/card/instances         → switch to FINISHED
 */

import https from 'node:https';
import { logger } from './logger.js';
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import {
  classifyImSendFailure,
  ImDeliveryPhaseError,
  preAcceptImDeliveryError,
} from './im-send-retry-policy.js';

// ─── Constants ───────────────────────────────────────────────

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

const FlowStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
  EXECUTING: '4',
  FAILED: '5',
} as const;

const STREAM_UPDATE_INTERVAL = 500; // ms — conservative 2 QPS

// ─── Types ───────────────────────────────────────────────────

export interface DingTalkStreamingCardConfig {
  clientId: string;
  clientSecret: string;
}

export type DingTalkCardTarget =
  | { type: 'user'; userId: string }
  | { type: 'group'; openConversationId: string };

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completing'
  | 'aborting'
  | 'completed'
  | 'aborted'
  | 'error';

interface TokenInfo {
  token: string;
  expiresAt: number;
}

// ─── Token Management ────────────────────────────────────────

const tokenCache = new Map<string, TokenInfo>();

async function getAccessToken(
  config: DingTalkStreamingCardConfig,
): Promise<string> {
  const cached = tokenCache.get(config.clientId);
  if (cached && Date.now() < cached.expiresAt - 300_000) {
    return cached.token;
  }

  return new Promise<string>((resolve, reject) => {
    const url = new URL('https://oapi.dingtalk.com/gettoken');
    url.searchParams.set('appkey', config.clientId);
    url.searchParams.set('appsecret', config.clientSecret);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (data.errcode !== 0) {
              reject(
                new ImDeliveryPhaseError(
                  'rejected',
                  `DingTalk token error: ${data.errmsg}`,
                ),
              );
              return;
            }
            const expiresIn = Number(data.expires_in) || 7200;
            tokenCache.set(config.clientId, {
              token: data.access_token,
              expiresAt: Date.now() + expiresIn * 1000,
            });
            resolve(data.access_token);
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── HTTP Helper ─────────────────────────────────────────────

interface ApiResponse {
  [key: string]: unknown;
}

function dingTalkCardApiError(message: string, status?: number): Error {
  const definitiveRejection =
    status === undefined ||
    status < 400 ||
    (status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 425 &&
      status !== 429);
  return definitiveRejection
    ? new ImDeliveryPhaseError('rejected', message)
    : new Error(message);
}

async function apiRequest(
  config: DingTalkStreamingCardConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  logLabel?: string,
): Promise<ApiResponse> {
  const token = await getAccessToken(config);
  const url = new URL(path, DINGTALK_API_BASE);
  const bodyStr = body ? JSON.stringify(body) : undefined;

  return new Promise<ApiResponse>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
          ...(bodyStr
            ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const label = logLabel ?? `${method} ${path}`;
          try {
            const data = JSON.parse(text);

            // DingTalk often returns HTTP 200 with error codes in the body
            if (
              data.code &&
              data.code !== '0' &&
              data.code !== '200' &&
              data.code !== 'success'
            ) {
              const errMsg = `DingTalk Card API ${label} error: code=${data.code}, message=${data.message || data.msg || text}`;
              logger.warn(
                {
                  label,
                  code: data.code,
                  message: data.message,
                  statusCode: res.statusCode,
                },
                errMsg,
              );
              reject(dingTalkCardApiError(errMsg, res.statusCode));
              return;
            }

            if (res.statusCode && res.statusCode >= 400) {
              reject(
                dingTalkCardApiError(
                  `DingTalk Card API ${label} HTTP failed (${res.statusCode}): ${data.message || text}`,
                  res.statusCode,
                ),
              );
              return;
            }

            logger.debug(
              {
                label,
                statusCode: res.statusCode,
                responseBody: text.slice(0, 500),
              },
              `DingTalk Card API ${label} response`,
            );
            resolve(data as ApiResponse);
          } catch {
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                dingTalkCardApiError(
                  `DingTalk Card API ${label} HTTP failed (${res.statusCode}): ${text}`,
                  res.statusCode,
                ),
              );
            } else {
              resolve({});
            }
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function isOfficialCardDeliverAck(resp: ApiResponse): boolean {
  // DELIVER is the visible IM ACK. Keep apiRequest soft-resolve({}) for PUT
  // streaming/inputing/status, but do not mint cardInstanceId without an
  // official deliver envelope (success===true or code 0/200/success).
  if (resp.success === true) return true;
  if (resp.success === false) return false;
  const code = resp.code;
  return code === '0' || code === '200' || code === 'success';
}

// ─── Build deliver body ──────────────────────────────────────

function buildDeliverBody(
  cardInstanceId: string,
  target: DingTalkCardTarget,
  robotCode: string,
): Record<string, unknown> {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };

  if (target.type === 'group') {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }

  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: {
      spaceType: 'IM_ROBOT',
      robotCode,
      extension: { dynamicSummary: 'true' },
    },
  };
}

// ─── Markdown helpers ────────────────────────────────────────

function ensureTableBlankLines(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  const tableDividerRegex = /^\s*\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?\s*$/;
  const tableRowRegex = /^\s*\|?.*\|.*\|?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1] ?? '';
    if (
      tableRowRegex.test(currentLine) &&
      tableDividerRegex.test(nextLine) &&
      i > 0 &&
      lines[i - 1].trim() !== '' &&
      !tableRowRegex.test(lines[i - 1])
    ) {
      result.push('');
    }
    result.push(currentLine);
  }
  return result.join('\n');
}

// ─── Controller ──────────────────────────────────────────────

export class DingTalkStreamingCardController {
  private state: StreamingState = 'idle';
  private config: DingTalkStreamingCardConfig;
  private target: DingTalkCardTarget;
  private onCardCreated?: (messageId: string) => void;

  // Card state
  private cardInstanceId: string | null = null;
  private inputingStarted = false;
  private cardCreationError: unknown;
  private accumulatedText = '';

  // Throttle
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFlushPromise: Promise<void> | null = null;
  private flushPending = false;

  private terminalDeliveryError: unknown;

  // Auxiliary flush throttle (separate from text flush)
  private auxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAuxFlushPromise: Promise<void> | null = null;
  private auxFlushPending = false;
  private lastAuxFlushTime = 0;
  private static readonly AUX_FLUSH_INTERVAL = 1500; // ms

  // Auxiliary state (thinking, tools, status) — prepended to msgContent
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
  private recentEvents: Array<string> = [];
  private lastPushedContent: string | null = null;

  // Display config
  private static readonly MAX_THINKING_CHARS = 500;
  private static readonly MAX_TOOLS_DISPLAY = 5;
  private static readonly MAX_TOOL_SUMMARY_CHARS = 60;
  private static readonly MAX_RECENT_EVENTS = 5;

  constructor(
    config: DingTalkStreamingCardConfig,
    target: DingTalkCardTarget,
    opts?: {
      onCardCreated?: (messageId: string) => void;
      fallbackSend?: (text: string) => Promise<void>;
    },
  ) {
    this.config = config;
    this.target = target;
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
    // `isActive()` also exposes sticky uncertain provider evidence to the
    // host finalizer. It must not make the failed card writable again.
    if (!this.acceptsStreamingUpdates()) return;
    this.accumulatedText = text; // Full replacement (same as Feishu pattern)
    this.thinkingText = ''; // Clear reasoning once real text arrives (align with Feishu)
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

    // If there's no text at all, skip card creation entirely
    if (!finalText.trim()) {
      this.state = 'completed';
      return;
    }

    logger.info(
      {
        state: this.state,
        hasCard: !!this.cardInstanceId,
        textLen: finalText.length,
      },
      'DingTalk AI Card complete() called',
    );

    // Ensure card exists before finalizing — complete() may be called
    // before the 500ms flush timer fires, so we need to create the card
    // synchronously here instead of relying on the scheduled flush.
    try {
      await this.ensureCard();
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'DingTalk AI Card ensureCard failed in complete()',
      );
      throw this.terminalizeDeliveryFailure(err);
    }

    if (!this.cardInstanceId) {
      // Card creation didn't produce an instance (e.g. state was 'error')
      logger.warn(
        { state: this.state },
        'DingTalk AI Card complete(): no cardInstanceId after ensureCard',
      );
      const creationError =
        this.terminalDeliveryError ??
        this.cardCreationError ??
        preAcceptImDeliveryError('DingTalk streaming card was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    try {
      // 1. Final streaming frame — clear reasoning, only keep reply body
      this.thinkingText = '';
      this.thinking = false;
      const finalContent = ensureTableBlankLines(finalText);
      await this.pushStreamingContent(finalContent, true);
      // 2. Switch to FINISHED
      await this.updateFlowStatus(FlowStatus.FINISHED, finalContent);
      this.state = 'completed';
      logger.info(
        { cardId: this.cardInstanceId },
        'DingTalk AI Card completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message, cardId: this.cardInstanceId },
        'DingTalk AI Card finalize failed, degrading',
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
    if (this.cardCreationPromise)
      await this.cardCreationPromise.catch(() => {});
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      throw this.terminalDeliveryError;
    }

    const displayText = this.accumulatedText
      ? this.accumulatedText + `\n\n> ⚠️ 已中断: ${reason ?? '用户取消'}`
      : `⚠️ 已中断: ${reason ?? '用户取消'}`;

    if (!this.cardInstanceId) {
      this.state = 'aborted';
      return;
    }

    try {
      await this.pushStreamingContent(displayText, true);
      await this.updateFlowStatus(FlowStatus.FAILED, displayText);
    } catch (err: any) {
      logger.debug(
        { err: err.message },
        'DingTalk AI Card abort update failed',
      );
      throw this.terminalizeDeliveryFailure(err);
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearFlushTimer();
  }

  // ─── Auxiliary display (prepended to msgContent as markdown) ───

  setThinking(): void {
    this.thinking = true;
    if (!this.cardInstanceId && this.state === 'idle') {
      // Trigger card creation early so user sees "Thinking..." placeholder
      this.state = 'creating';
      this.ensureCard().catch(() => {
        this.state = 'error';
      });
    }
  }

  appendThinking(text: string): void {
    this.thinkingText += text;
    if (
      this.thinkingText.length >
      DingTalkStreamingCardController.MAX_THINKING_CHARS
    ) {
      this.thinkingText =
        '...' +
        this.thinkingText.slice(
          -(DingTalkStreamingCardController.MAX_THINKING_CHARS - 3),
        );
    }
    this.thinking = true;
    if (!this.cardInstanceId && this.state === 'idle') {
      this.state = 'creating';
      this.ensureCard().catch(() => {
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
    // Hooks are less meaningful in DingTalk — skip rendering
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Todos are too verbose for single-field card — skip
  }

  pushRecentEvent(text: string): void {
    this.recentEvents.push(text);
    if (
      this.recentEvents.length >
      DingTalkStreamingCardController.MAX_RECENT_EVENTS
    ) {
      this.recentEvents = this.recentEvents.slice(
        -DingTalkStreamingCardController.MAX_RECENT_EVENTS,
      );
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

  // ─── Auxiliary Build ────────────────────────────────────────

  /**
   * Build auxiliary prefix (thinking + tools + status) to prepend to msgContent.
   * Renders as compact markdown above the main response text.
   */
  private buildAuxPrefix(): string {
    const parts: string[] = [];

    // ① System status
    if (this.systemStatus) {
      parts.push(`⏳ ${this.systemStatus}`);
    }

    // ② Thinking / Reasoning
    //    Active thinking phase → "💭 Reasoning..."
    //    After text arrived (thinking=false but thinkingText remains) → "💭 Reasoned"
    if (this.thinkingText) {
      const label = this.thinking ? '💭 **Reasoning...**' : '💭 **Reasoned**';
      const truncated =
        this.thinkingText.length >
        DingTalkStreamingCardController.MAX_THINKING_CHARS
          ? '...' +
            this.thinkingText.slice(
              -(DingTalkStreamingCardController.MAX_THINKING_CHARS - 3),
            )
          : this.thinkingText;
      const quoted = truncated
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      parts.push(`${label}\n${quoted}`);
    } else if (this.thinking) {
      parts.push('💭 **Thinking...**');
    }

    // ③ Active tools
    const now = Date.now();
    const display: Array<{
      name: string;
      status: string;
      elapsed: string;
      summary?: string;
    }> = [];
    for (const [, tc] of this.tools) {
      if (display.length >= DingTalkStreamingCardController.MAX_TOOLS_DISPLAY)
        break;
      const elapsed = DingTalkStreamingCardController.formatElapsed(
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
          ? `  ${d.summary.length > DingTalkStreamingCardController.MAX_TOOL_SUMMARY_CHARS ? d.summary.slice(0, DingTalkStreamingCardController.MAX_TOOL_SUMMARY_CHARS) + '...' : d.summary}`
          : '';
        return `${icon} \`${d.name}\` (${d.elapsed})${summary}`;
      });
      parts.push(lines.join('\n'));
    }

    // ④ Recent events
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
      DingTalkStreamingCardController.AUX_FLUSH_INTERVAL - elapsed,
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
      const content =
        this.buildAuxPrefix() + ensureTableBlankLines(this.accumulatedText);
      this.currentAuxFlushPromise = this.pushStreamingContent(content, false)
        .catch((err: any) => {
          this.terminalizeDeliveryFailure(err);
          logger.debug({ err: err.message }, 'DingTalk aux flush failed');
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

  async patchUsageNote(_usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {}

  getAllMessageIds(): string[] {
    return this.cardInstanceId ? [this.cardInstanceId] : [];
  }

  getAcknowledgedProviderOutputCount(): number {
    return this.cardInstanceId ? 1 : 0;
  }

  // ─── Internal: card creation ────────────────────────────────

  // Guard: when appendThinking() fires ensureCard() asynchronously, the
  // API call may still be in-flight when complete() calls ensureCard().
  // Without this guard, complete()'s ensureCard() sees state='creating'
  // and returns early, falling back to plain sendMessage.
  private cardCreationPromise: Promise<void> | null = null;

  private async ensureCard(): Promise<void> {
    if (this.cardInstanceId) return;

    // If card creation is already in progress, await for it to finish
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }
    // Don't check this.state here — appendThinking() sets state='creating'
    // before calling ensureCard(), which would cause us to return early.
    // Instead, the cardCreationPromise guard above prevents double-creation.

    if (this.state !== 'completing' && this.state !== 'aborting') {
      this.state = 'creating';
    }
    this.cardCreationPromise = (async () => {
      try {
        const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        // 1. Create card instance
        let createResp: ApiResponse;
        try {
          createResp = await apiRequest(
            this.config,
            'POST',
            '/v1.0/card/instances',
            {
              cardTemplateId: AI_CARD_TEMPLATE_ID,
              outTrackId: cardId,
              cardData: {
                cardParamMap: {
                  config: JSON.stringify({ autoLayout: true }),
                },
              },
              callbackType: 'STREAM',
              imGroupOpenSpaceModel: { supportForward: true },
              imRobotOpenSpaceModel: { supportForward: true },
            },
            'card-create',
          );
        } catch (error) {
          // Creating an undelivered card resource cannot produce a visible IM
          // presentation. Static delivery remains safe even when its resource
          // ACK was lost.
          throw preAcceptImDeliveryError(
            'DingTalk card resource creation failed before visible delivery',
            error,
          );
        }
        logger.info({ cardId, createResp }, 'DingTalk AI Card create response');

        // 2. Deliver to target
        const deliverBody = buildDeliverBody(
          cardId,
          this.target,
          this.config.clientId,
        );
        const deliverResp = await apiRequest(
          this.config,
          'POST',
          '/v1.0/card/instances/deliver',
          deliverBody,
          'card-deliver',
        );
        logger.info(
          { cardId, target: this.target, deliverResp },
          'DingTalk AI Card deliver response',
        );

        // DELIVER is the only call that proves a visible card preview.
        // Empty / HTML / broken-JSON / {success:false} 2xx must not mint
        // cardInstanceId (apiRequest still soft-resolves {} so PUT streaming
        // stays soft; CREATE ACK hardening is #730 — do not restack here).
        if (!isOfficialCardDeliverAck(deliverResp)) {
          throw preAcceptImDeliveryError(
            'DingTalk card delivery failed before visible presentation',
            dingTalkCardApiError(
              'DingTalk Card API card-deliver 2xx missing official success envelope',
            ),
          );
        }

        this.cardInstanceId = cardId;
        this.cardCreationError = undefined;
        if (this.state === 'creating') this.state = 'streaming';
        this.onCardCreated?.(cardId);
        logger.info({ cardId }, 'DingTalk AI Card created and delivered');
      } catch (err: any) {
        this.cardCreationError = err;
        this.terminalizeDeliveryFailure(err);
        logger.warn(
          { err: err.message },
          'DingTalk AI Card creation failed; preserving delivery evidence for the host',
        );
      } finally {
        this.cardCreationPromise = null;
      }
    })();

    try {
      await this.cardCreationPromise;
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
          logger.debug({ err: err.message }, 'DingTalk AI Card flush failed');
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
    if (!this.accumulatedText.trim()) return;

    // Let the host choose the one durable static fallback.
    if (this.state === 'error') {
      const creationError =
        this.cardCreationError ??
        preAcceptImDeliveryError('DingTalk streaming card was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    await this.ensureCard();

    if (!this.cardInstanceId) {
      const creationError =
        this.cardCreationError ??
        preAcceptImDeliveryError('DingTalk streaming card was not created');
      throw this.terminalizeDeliveryFailure(creationError);
    }

    const content =
      this.buildAuxPrefix() + ensureTableBlankLines(this.accumulatedText);
    await this.pushStreamingContent(content, false);
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
      this.state === 'idle' ||
      this.state === 'creating' ||
      this.state === 'streaming'
    );
  }

  private terminalizeDeliveryFailure(error: unknown): unknown {
    const deliveryError =
      this.cardInstanceId && !(error instanceof PartialChannelDeliveryError)
        ? new PartialChannelDeliveryError(1, 2, error)
        : error;
    this.terminalDeliveryError ??= deliveryError;
    this.state = 'aborted';
    this.clearFlushTimer();
    return this.terminalDeliveryError;
  }

  private async pushStreamingContent(
    content: string,
    isFinal: boolean,
  ): Promise<void> {
    if (!this.cardInstanceId) return;
    if (!isFinal && content === this.lastPushedContent) return;

    // First stream call: switch to INPUTING
    if (!this.inputingStarted) {
      const inputingResp = await apiRequest(
        this.config,
        'PUT',
        '/v1.0/card/instances',
        {
          outTrackId: this.cardInstanceId,
          cardData: {
            cardParamMap: {
              flowStatus: FlowStatus.INPUTING,
              msgContent: content,
              staticMsgContent: '',
              sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
              config: JSON.stringify({ autoLayout: true }),
            },
          },
        },
        'card-inputing',
      );
      logger.info(
        { cardId: this.cardInstanceId, inputingResp },
        'DingTalk AI Card INPUTING response',
      );
      this.inputingStarted = true;
    }

    // Stream content
    await apiRequest(
      this.config,
      'PUT',
      '/v1.0/card/streaming',
      {
        outTrackId: this.cardInstanceId,
        guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key: 'msgContent',
        content: ensureTableBlankLines(content),
        isFull: true,
        isFinalize: isFinal,
        isError: false,
      },
      'card-streaming',
    );
    this.lastPushedContent = content;
  }

  private async updateFlowStatus(
    flowStatus: string,
    content: string,
  ): Promise<void> {
    if (!this.cardInstanceId) return;

    const resp = await apiRequest(
      this.config,
      'PUT',
      '/v1.0/card/instances',
      {
        outTrackId: this.cardInstanceId,
        cardData: {
          cardParamMap: {
            flowStatus,
            msgContent: ensureTableBlankLines(content),
            staticMsgContent: '',
            sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
            config: JSON.stringify({ autoLayout: true }),
          },
        },
        cardUpdateOptions: { updateCardDataByKey: true },
      },
      `card-status-${flowStatus}`,
    );
    logger.info(
      { cardId: this.cardInstanceId, flowStatus, resp },
      'DingTalk AI Card updateFlowStatus response',
    );
  }
}
