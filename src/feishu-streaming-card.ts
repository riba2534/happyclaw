/**
 * Feishu Streaming Card Controller
 *
 * Implements CardKit 2.0 streaming cards with typing-machine effect.
 * Uses im.message.patch API to update card content in real-time.
 *
 * Rate limiting: Feishu patch API has ~1000ms minimum interval.
 * Text change threshold: skip patches if delta < 50 chars (reduce noise).
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface StreamingCardOptions {
  /** Lark SDK client instance */
  client: lark.Client;
  /** Chat ID to send the card to */
  chatId: string;
  /** Reply to this message ID (optional) */
  replyToMsgId?: string;
  /** Called when the card is created or streaming fails */
  onFallback?: () => void;
}

// ─── Card Template Builders ───────────────────────────────────

const CARD_MD_LIMIT = 4000;

function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildStreamingCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
): object {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  // Build card elements
  const elements: Array<Record<string, unknown>> = [];
  const contentToRender = body || text.trim();

  if (contentToRender.length > CARD_MD_LIMIT) {
    const chunks = splitAtParagraphs(contentToRender, CARD_MD_LIMIT);
    for (const chunk of chunks) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    const sections = contentToRender.split(/\n-{3,}\n/);
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      const s = sections[i].trim();
      if (s) elements.push({ tag: 'markdown', content: s });
    }
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || '...' });
  }

  // Status note
  const noteMap = {
    streaming: '⏳ 生成中...',
    completed: '',
    aborted: '⚠️ 已中断',
  };
  const headerTemplate = {
    streaming: 'wathet',
    completed: 'indigo',
    aborted: 'orange',
  };

  if (noteMap[state]) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: noteMap[state] },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: headerTemplate[state],
    },
    elements,
  };
}

// ─── Flush Controller ─────────────────────────────────────────

class FlushController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private lastFlushedLength = 0;
  private pendingFlush: (() => Promise<void>) | null = null;

  /** Minimum interval between flushes (ms) */
  private readonly minInterval: number;
  /** Minimum text change to trigger a flush (chars) */
  private readonly minDelta: number;

  constructor(minInterval = 1200, minDelta = 50) {
    this.minInterval = minInterval;
    this.minDelta = minDelta;
  }

  /**
   * Schedule a flush. If a flush is already pending, replace it.
   * The flush function will be called after the minimum interval.
   */
  schedule(currentLength: number, flushFn: () => Promise<void>): void {
    // Check text change threshold
    if (currentLength - this.lastFlushedLength < this.minDelta) {
      // Still schedule in case no more text comes (ensure eventual flush)
      if (!this.timer) {
        this.pendingFlush = flushFn;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.executeFlush();
        }, this.minInterval);
      } else {
        this.pendingFlush = flushFn;
      }
      return;
    }

    // Enough text change — schedule or execute
    this.pendingFlush = flushFn;
    const elapsed = Date.now() - this.lastFlushTime;
    if (elapsed >= this.minInterval) {
      // Can flush immediately
      this.clearTimer();
      this.executeFlush();
    } else if (!this.timer) {
      // Schedule for remaining interval
      this.timer = setTimeout(() => {
        this.timer = null;
        this.executeFlush();
      }, this.minInterval - elapsed);
    }
    // else: timer already running, will pick up pendingFlush
  }

  /** Force flush immediately (for complete/abort) */
  async forceFlush(flushFn: () => Promise<void>): Promise<void> {
    this.clearTimer();
    this.pendingFlush = flushFn;
    await this.executeFlush();
  }

  private async executeFlush(): Promise<void> {
    const fn = this.pendingFlush;
    this.pendingFlush = null;
    if (!fn) return;
    this.lastFlushTime = Date.now();
    try {
      await fn();
    } catch (err) {
      logger.debug({ err }, 'FlushController: flush failed');
    }
  }

  markFlushed(length: number): void {
    this.lastFlushedLength = length;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.pendingFlush = null;
  }
}

// ─── Streaming Card Controller ────────────────────────────────

export class StreamingCardController {
  private state: StreamingState = 'idle';
  private messageId: string | null = null;
  private accumulatedText = '';
  private flushCtrl: FlushController;
  private patchFailCount = 0;
  private readonly maxPatchFailures = 2;
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onFallback?: () => void;

  constructor(opts: StreamingCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.onFallback = opts.onFallback;
    this.flushCtrl = new FlushController();
  }

  get currentState(): StreamingState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === 'streaming' || this.state === 'creating';
  }

  /**
   * Append text to the streaming card.
   * Creates the card on first call, then patches on subsequent calls.
   */
  append(text: string): void {
    this.accumulatedText = text;

    if (this.state === 'idle') {
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn({ err, chatId: this.chatId }, 'Streaming card: initial create failed, will use fallback');
        this.state = 'error';
        this.onFallback?.();
      });
      return;
    }

    if (this.state === 'streaming') {
      this.schedulePatch();
    }
    // If 'creating', the text will be picked up after creation completes
  }

  /**
   * Complete the streaming card with final text.
   */
  async complete(finalText: string): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'creating') return;

    this.accumulatedText = finalText;
    this.state = 'completed';
    this.flushCtrl.dispose();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
      } catch (err) {
        logger.debug({ err, chatId: this.chatId }, 'Streaming card: final patch failed');
      }
    }
  }

  /**
   * Abort the streaming card (e.g., user interrupted).
   */
  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;

    const wasActive = this.isActive();
    this.state = 'aborted';
    this.flushCtrl.dispose();

    if (this.messageId && wasActive) {
      if (reason) {
        this.accumulatedText += `\n\n---\n*${reason}*`;
      }
      try {
        await this.patchCard('aborted');
      } catch (err) {
        logger.debug({ err, chatId: this.chatId }, 'Streaming card: abort patch failed');
      }
    }
  }

  dispose(): void {
    this.flushCtrl.dispose();
  }

  // ─── Internal Methods ──────────────────────────────────

  private async createInitialCard(): Promise<void> {
    const card = buildStreamingCard(
      this.accumulatedText || '...',
      'streaming',
    );
    const content = JSON.stringify(card);

    try {
      let resp: any;

      if (this.replyToMsgId) {
        resp = await this.client.im.message.reply({
          path: { message_id: this.replyToMsgId },
          data: { content, msg_type: 'interactive' },
        });
      } else {
        resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.chatId,
            msg_type: 'interactive',
            content,
          },
        });
      }

      this.messageId = resp?.data?.message_id || null;
      if (!this.messageId) {
        throw new Error('No message_id in response');
      }

      // Check if state changed while we were awaiting the API call.
      // complete() or abort() may have been called during createInitialCard().
      if (this.state !== 'creating') {
        // Apply the pending final state now that we have a messageId.
        const finalState = this.state as 'completed' | 'aborted';
        logger.debug(
          { chatId: this.chatId, messageId: this.messageId, finalState },
          'Streaming card created but state already changed, patching to final',
        );
        try {
          await this.patchCard(finalState);
        } catch (err) {
          logger.debug({ err, chatId: this.chatId }, 'Failed to patch to final state after late creation');
        }
        return;
      }

      this.state = 'streaming';
      logger.debug(
        { chatId: this.chatId, messageId: this.messageId },
        'Streaming card created',
      );

      // If text accumulated while creating, schedule a patch
      if (this.accumulatedText.length > 3) {
        this.schedulePatch();
      }
    } catch (err) {
      this.state = 'error';
      throw err;
    }
  }

  private schedulePatch(): void {
    if (this.patchFailCount >= this.maxPatchFailures) {
      // Too many failures, fall back to static card
      logger.info(
        { chatId: this.chatId },
        'Streaming card: too many patch failures, falling back',
      );
      this.state = 'error';
      this.flushCtrl.dispose();
      this.onFallback?.();
      return;
    }

    this.flushCtrl.schedule(this.accumulatedText.length, async () => {
      await this.patchCard('streaming');
    });
  }

  private async patchCard(
    displayState: 'streaming' | 'completed' | 'aborted',
  ): Promise<void> {
    if (!this.messageId) return;

    const card = buildStreamingCard(this.accumulatedText, displayState);
    const content = JSON.stringify(card);

    try {
      await this.client.im.v1.message.patch({
        path: { message_id: this.messageId },
        data: { content },
      });
      this.flushCtrl.markFlushed(this.accumulatedText.length);
      this.patchFailCount = 0; // Reset on success
    } catch (err) {
      this.patchFailCount++;
      logger.debug(
        { err, chatId: this.chatId, failCount: this.patchFailCount },
        'Streaming card patch failed',
      );
      throw err;
    }
  }
}

// ─── Streaming Session Registry ───────────────────────────────
// Global registry for tracking active streaming sessions.
// Used by shutdown hooks to abort all active sessions.

const activeSessions = new Map<string, StreamingCardController>();

/**
 * Register a streaming session for a chatJid.
 * Replaces any existing session for the same chatJid.
 */
export function registerStreamingSession(
  chatJid: string,
  session: StreamingCardController,
): void {
  const existing = activeSessions.get(chatJid);
  if (existing && existing.isActive()) {
    // Abort (not just dispose) so the old card shows "已中断" instead of stuck "生成中..."
    existing.abort('新的回复已开始').catch(() => {});
  }
  activeSessions.set(chatJid, session);
}

/**
 * Remove a streaming session from the registry.
 */
export function unregisterStreamingSession(chatJid: string): void {
  activeSessions.delete(chatJid);
}

/**
 * Get the active streaming session for a chatJid.
 */
export function getStreamingSession(
  chatJid: string,
): StreamingCardController | undefined {
  return activeSessions.get(chatJid);
}

/**
 * Check if there's an active streaming session for a chatJid.
 */
export function hasActiveStreamingSession(chatJid: string): boolean {
  const session = activeSessions.get(chatJid);
  return session?.isActive() ?? false;
}

/**
 * Abort all active streaming sessions.
 * Called during graceful shutdown.
 */
export async function abortAllStreamingSessions(
  reason = '服务维护中',
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [chatJid, session] of activeSessions.entries()) {
    if (session.isActive()) {
      promises.push(
        session.abort(reason).catch((err) => {
          logger.debug(
            { err, chatJid },
            'Failed to abort streaming session during shutdown',
          );
        }),
      );
    }
  }
  await Promise.allSettled(promises);
  activeSessions.clear();
  logger.info(
    { count: promises.length },
    'All streaming sessions aborted',
  );
}
