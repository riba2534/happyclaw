/**
 * Feishu Streaming Card Controller
 *
 * Implements CardKit 2.0 streaming cards with typing-machine effect.
 * Primary path: CardKit card.create + card.update (with sequence-based optimistic locking).
 * Fallback path: im.message.create + im.message.patch (original behavior).
 *
 * Features:
 * - Code-block-safe text splitting (no truncation inside fenced code blocks)
 * - Schema 2.0 card format with body.elements
 * - Multi-card support for extremely long outputs (auto-split at ~45 elements)
 * - Automatic fallback to message.patch if CardKit API is unavailable
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'crypto';
import { logger } from './logger.js';
import { optimizeMarkdownStyle } from './feishu-markdown-style.js';

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
  /** Called when the initial card is created and messageId is available */
  onCardCreated?: (messageId: string) => void;
}

// ─── Code-Block-Safe Splitting ───────────────────────────────

interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

/**
 * Scan text for fenced code block ranges (``` ... ```).
 */
function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block — treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

/**
 * Check if a position falls inside any code block range.
 * Returns the range if found, null otherwise.
 */
function findContainingBlock(
  pos: number,
  ranges: CodeBlockRange[],
): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Split text respecting fenced code block boundaries.
 * Unlike splitAtParagraphs(), this never truncates inside a code block
 * without properly closing/reopening the fence.
 */
function splitCodeBlockSafe(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Recompute ranges on current remaining text each iteration.
    // This handles synthetic reopeners correctly since all positions
    // are relative to `remaining`, not the original text.
    const ranges = findCodeBlockRanges(remaining);

    // Find a split point around maxLen
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      // Split point is inside a code block
      if (block.open > 0 && block.open > maxLen * 0.3) {
        // Retreat to just before the code block opening
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        // Block starts too early to retreat — split inside but close/reopen fence
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

const CARD_MD_LIMIT = 4000;
const CARD_SIZE_LIMIT = 25 * 1024; // Feishu limit ~30KB, 5KB safety margin

// ─── Legacy Card Builder (Fallback) ──────────────────────────

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

function extractTitleAndBody(text: string): { title: string; body: string } {
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

  return { title, body };
}

// ─── Shared Card Content Builder ─────────────────────────────

interface CardContentResult {
  title: string;
  contentElements: Array<Record<string, unknown>>;
}

/**
 * Build the content elements shared by both Legacy and Schema 2.0 card builders.
 * Splits long text, handles `---` section dividers, and extracts the title.
 * Applies optimizeMarkdownStyle() for proper Feishu rendering.
 */
function buildCardContent(
  text: string,
  splitFn: (text: string, maxLen: number) => string[],
  overrideTitle?: string,
): CardContentResult {
  const { title: extractedTitle, body } = extractTitleAndBody(text);
  const title = overrideTitle || extractedTitle;
  // Apply Markdown optimization for Feishu card rendering
  const rawContent = body || text.trim();
  const contentToRender = optimizeMarkdownStyle(rawContent, 2);
  const elements: Array<Record<string, unknown>> = [];

  if (contentToRender.length > CARD_MD_LIMIT) {
    for (const chunk of splitFn(contentToRender, CARD_MD_LIMIT)) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    // Keep --- as markdown content instead of using { tag: 'hr' }
    // because Schema 2.0 (CardKit) does not support the hr tag.
    elements.push({ tag: 'markdown', content: contentToRender });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || '...' });
  }

  return { title, contentElements: elements };
}

// ─── Interrupt Button Element ────────────────────────────────

/** Schema 1.0: `action` container wrapping a button (used by legacy message.patch path) */
const INTERRUPT_BUTTON = {
  tag: 'action',
  actions: [{
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 中断回复' },
    type: 'danger',
    value: { action: 'interrupt_stream' },
  }],
} as const;

/** Schema 2.0: standalone button (CardKit rejects `tag: 'action'` in v2 cards) */
const INTERRUPT_BUTTON_V2 = {
  tag: 'button',
  text: { tag: 'plain_text', content: '⏹ 中断回复' },
  type: 'danger',
  value: { action: 'interrupt_stream' },
} as const;

// ─── Tool Progress & Elapsed Helpers ─────────────────────────

function buildToolProgressMarkdown(
  tools: Map<string, { name: string; status: string }>,
): string {
  if (tools.size === 0) return '';
  const parts: string[] = [];
  for (const [, tc] of tools) {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    parts.push(`${icon} \`${tc.name}\``);
  }
  return parts.join('  ');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.floor(sec % 60)}s`;
}

// ─── Legacy Card Builder (Fallback) ──────────────────────────

function buildStreamingCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
): object {
  const { title, contentElements: elements } = buildCardContent(text, splitAtParagraphs);

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

  if (state === 'streaming') {
    elements.push(INTERRUPT_BUTTON);
  }

  if (noteMap[state]) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: noteMap[state] }],
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

// ─── Schema 2.0 Card Builder ─────────────────────────────────

type Schema2State = 'streaming' | 'completed' | 'aborted' | 'frozen';

const SCHEMA2_NOTE_MAP: Record<Schema2State, string> = {
  streaming: '⏳ 生成中...',
  completed: '',
  aborted: '⚠️ 已中断',
  frozen: '',
};

const SCHEMA2_HEADER_MAP: Record<Schema2State, string> = {
  streaming: 'wathet',
  completed: 'indigo',
  aborted: 'orange',
  frozen: 'grey',
};

function buildSchema2Card(
  text: string,
  state: Schema2State,
  titlePrefix = '',
  overrideTitle?: string,
): object {
  const { title, contentElements: elements } = buildCardContent(
    text,
    splitCodeBlockSafe,
    overrideTitle,
  );
  const displayTitle = titlePrefix ? `${titlePrefix}${title}` : title;

  if (state === 'streaming') {
    elements.push(INTERRUPT_BUTTON_V2);
  }

  if (SCHEMA2_NOTE_MAP[state]) {
    elements.push({
      tag: 'markdown',
      content: SCHEMA2_NOTE_MAP[state],
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: displayTitle },
    },
    header: {
      title: { tag: 'plain_text', content: displayTitle },
      template: SCHEMA2_HEADER_MAP[state],
    },
    body: { elements },
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

// ─── CardKit Backend ──────────────────────────────────────────

function quickHash(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

class CardKitBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  private lastContentHash = '';
  private readonly client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  /**
   * Create a CardKit card instance.
   * Returns the card_id for subsequent updates.
   */
  async createCard(cardJson: object): Promise<string> {
    const resp = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });

    const cardId = resp?.data?.card_id;
    if (!cardId) {
      const code = (resp as any)?.code;
      const msg = (resp as any)?.msg;
      throw new Error(
        `CardKit card.create returned no card_id (code=${code}, msg=${msg})`,
      );
    }

    this.cardId = cardId;
    this.sequence = 1;
    this.lastContentHash = quickHash(JSON.stringify(cardJson));
    logger.debug({ cardId }, 'CardKit card created');
    return cardId;
  }

  /**
   * Send the card as a message (referencing card_id).
   * Returns the message_id.
   */
  async sendCard(
    chatId: string,
    replyToMsgId?: string,
  ): Promise<string> {
    if (!this.cardId) {
      throw new Error('Cannot sendCard before createCard');
    }

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });

    let resp: any;
    if (replyToMsgId) {
      resp = await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    const messageId = resp?.data?.message_id;
    if (!messageId) {
      throw new Error('No message_id in sendCard response');
    }

    this._messageId = messageId;
    return messageId;
  }

  /**
   * Update the card via CardKit card.update with sequence-based optimistic locking.
   * Skips if content hash is unchanged.
   */
  async updateCard(cardJson: object): Promise<void> {
    if (!this.cardId) return;

    const dataStr = JSON.stringify(cardJson);
    const hash = quickHash(dataStr);
    if (hash === this.lastContentHash) return; // no change

    this.sequence++;
    await this.client.cardkit.v1.card.update({
      path: { card_id: this.cardId },
      data: {
        card: { type: 'card_json', data: dataStr },
        sequence: this.sequence,
      },
    });

    this.lastContentHash = hash;
  }

}


// ─── Multi-Card Manager ───────────────────────────────────────

class MultiCardManager {
  private cards: CardKitBackend[] = [];
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onCardCreated?: (messageId: string) => void;
  private cardIndex = 0;
  private readonly MAX_ELEMENTS = 45; // safety margin (Feishu limit ~50)

  constructor(
    client: lark.Client,
    chatId: string,
    replyToMsgId?: string,
    onCardCreated?: (messageId: string) => void,
  ) {
    this.client = client;
    this.chatId = chatId;
    this.replyToMsgId = replyToMsgId;
    this.onCardCreated = onCardCreated;
  }

  /**
   * Create the first card and send it as a message.
   * Returns the initial messageId.
   */
  async initialize(initialText: string): Promise<string> {
    const card = new CardKitBackend(this.client);
    const cardJson = buildSchema2Card(initialText, 'streaming');
    await card.createCard(cardJson);
    const messageId = await card.sendCard(
      this.chatId,
      this.replyToMsgId,
    );
    this.cards.push(card);
    this.cardIndex = 0;
    return messageId;
  }

  /**
   * Commit content: update the current card, auto-splitting if needed.
   */
  async commitContent(
    text: string,
    state: 'streaming' | 'completed' | 'aborted',
  ): Promise<void> {
    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';

    // Estimate element count using buildCardContent for accuracy
    const { contentElements } = buildCardContent(text, splitCodeBlockSafe);
    const fixedCount = (state === 'streaming' ? 1 : 0)        // button
                     + (SCHEMA2_NOTE_MAP[state] ? 1 : 0);     // note
    const totalElements = contentElements.length + fixedCount;

    if (totalElements > this.MAX_ELEMENTS && state === 'streaming') {
      // Need to split: freeze current card and create a new one
      await this.splitToNewCard(text);
      return;
    }

    // Normal update on current card
    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    const cardJson = buildSchema2Card(text, state, titlePrefix);

    // Byte size check (Feishu limit ~30KB, use 25KB safety margin)
    const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');
    if (cardSize > CARD_SIZE_LIMIT && state === 'streaming') {
      await this.splitToNewCard(text);
      return;
    }

    await currentCard.updateCard(cardJson);
  }

  /**
   * Split content across cards when element limit is reached.
   */
  private async splitToNewCard(text: string): Promise<void> {
    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    // Extract title once so all sub-cards share the same title
    const { title: consistentTitle } = extractTitleAndBody(text);

    // Determine how much content the current card can hold
    const maxChunksPerCard = this.MAX_ELEMENTS - 3; // reserve for fixed elements
    const chunks = splitCodeBlockSafe(text, CARD_MD_LIMIT);

    // Content for the current (frozen) card
    const frozenChunks = chunks.slice(0, maxChunksPerCard);
    const frozenText = frozenChunks.join('\n\n');
    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';

    // Freeze current card with consistent title
    const frozenCard = buildSchema2Card(frozenText, 'frozen', titlePrefix, consistentTitle);
    await currentCard.updateCard(frozenCard);

    // Create new card for remaining content
    this.cardIndex++;
    const newTitlePrefix = '(续) ';
    const remainingChunks = chunks.slice(maxChunksPerCard);
    const remainingText = remainingChunks.join('\n\n');

    const newCard = new CardKitBackend(this.client);
    const newCardJson = buildSchema2Card(
      remainingText || '...',
      'streaming',
      newTitlePrefix,
      consistentTitle,
    );
    await newCard.createCard(newCardJson);
    // New card is sent as a fresh message (not reply)
    const newMessageId = await newCard.sendCard(this.chatId);
    this.cards.push(newCard);

    // Register the new card's messageId for interrupt button routing
    this.onCardCreated?.(newMessageId);
  }

  getAllMessageIds(): string[] {
    return this.cards
      .map((c) => c.messageId)
      .filter((id): id is string => id !== null);
  }

  getLatestMessageId(): string | null {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      if (this.cards[i].messageId) return this.cards[i].messageId;
    }
    return null;
  }
}

// ─── Streaming Card Controller ────────────────────────────────

export class StreamingCardController {
  private state: StreamingState = 'idle';
  private messageId: string | null = null;
  private accumulatedText = '';
  private flushCtrl: FlushController;
  private patchFailCount = 0;
  private maxPatchFailures = 2;
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly onFallback?: () => void;
  private readonly onCardCreated?: (messageId: string) => void;

  // CardKit mode
  private useCardKit = false;
  private multiCard: MultiCardManager | null = null;

  // Streaming state
  private thinking = false;
  private toolCalls = new Map<string, { name: string; status: 'running' | 'complete' | 'error' }>();
  private startTime = 0;
  private backendMode: 'v1' | 'legacy' = 'v1';

  constructor(opts: StreamingCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.onFallback = opts.onFallback;
    this.onCardCreated = opts.onCardCreated;
    this.flushCtrl = new FlushController();
  }

  get currentState(): StreamingState {
    return this.state;
  }

  get currentMessageId(): string | null {
    if (this.multiCard) return this.multiCard.getLatestMessageId();
    return this.messageId;
  }

  isActive(): boolean {
    return this.state === 'streaming' || this.state === 'creating';
  }

  /**
   * Get all messageIds across all cards (for multi-card cleanup).
   */
  getAllMessageIds(): string[] {
    if (this.multiCard) return this.multiCard.getAllMessageIds();
    return this.messageId ? [this.messageId] : [];
  }

  /**
   * Signal that the agent is in thinking state (before text arrives).
   */
  setThinking(): void {
    this.thinking = true;
    if (this.state === 'idle') {
      // Create card immediately with thinking placeholder
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn({ err, chatId: this.chatId }, 'Streaming card: initial create failed (thinking), will use fallback');
        this.state = 'error';
        this.onFallback?.();
      });
    }
  }

  /**
   * Signal that a tool has started executing.
   */
  startTool(toolId: string, toolName: string): void {
    this.toolCalls.set(toolId, { name: toolName, status: 'running' });
    if (this.state === 'streaming') {
      this.schedulePatch();
    }
  }

  /**
   * Signal that a tool has finished executing.
   */
  endTool(toolId: string, isError: boolean): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      if (this.state === 'streaming') {
        this.schedulePatch();
      }
    }
  }

  /**
   * Append text to the streaming card.
   * Creates the card on first call, then patches on subsequent calls.
   */
  append(text: string): void {
    this.accumulatedText = text;
    this.thinking = false; // Text arrived, no longer just thinking

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

    if (this.messageId || this.multiCard) {
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

    if ((this.messageId || this.multiCard) && wasActive) {
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
    const initialText = this.accumulatedText || (this.thinking ? '' : '...');

    // ── Try CardKit full-update (card.update with full JSON) ──
    // Preferred over cardElement.content typewriter mode because full-update
    // supports richer streaming UI (interrupt button, thinking status, tool progress).
    try {
      this.multiCard = new MultiCardManager(
        this.client,
        this.chatId,
        this.replyToMsgId,
        this.onCardCreated,
      );
      const messageId = await this.multiCard.initialize(initialText);

      this.messageId = messageId;
      this.backendMode = 'v1';
      this.useCardKit = true;
      this.startTime = Date.now();
      // CardKit v1 mode: 1000ms interval, bump failure tolerance
      this.flushCtrl.dispose();
      this.flushCtrl = new FlushController(1000, 50);
      this.maxPatchFailures = 3;

      logger.debug(
        { chatId: this.chatId, messageId, mode: 'cardkit-v1' },
        'Streaming card created via CardKit v1',
      );
    } catch (v1Err) {
      // CardKit full-update failed — fall back to legacy message.create + message.patch
      logger.info(
        { err: v1Err, chatId: this.chatId },
        'CardKit full-update unavailable, falling back to message.patch',
      );
      this.multiCard = null;
      this.useCardKit = false;
      this.backendMode = 'legacy';
      this.startTime = Date.now();

      await this.createLegacyCard(initialText);
      return;
    }

    // Handle state changes during await (same logic for both paths)
    this.finishCardCreation();
  }

  private async createLegacyCard(initialText: string): Promise<void> {
    const card = buildStreamingCard(initialText, 'streaming');
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

      logger.debug(
        { chatId: this.chatId, messageId: this.messageId, mode: 'legacy' },
        'Streaming card created via legacy path',
      );

      this.finishCardCreation();
    } catch (err) {
      this.state = 'error';
      throw err;
    }
  }

  private finishCardCreation(): void {
    // Check if state changed while we were awaiting the API call.
    if (this.state !== 'creating') {
      const finalState = this.state as 'completed' | 'aborted';
      logger.debug(
        { chatId: this.chatId, messageId: this.messageId, finalState },
        'Streaming card created but state already changed, patching to final',
      );
      this.patchCard(finalState).catch((err) => {
        logger.debug({ err, chatId: this.chatId }, 'Failed to patch to final state after late creation');
      });
      return;
    }

    this.state = 'streaming';
    if (this.messageId) {
      this.onCardCreated?.(this.messageId);
    }

    // If text accumulated while creating, schedule a patch
    if (this.accumulatedText.length > 3) {
      this.schedulePatch();
    }
  }

  private schedulePatch(): void {
    if (this.patchFailCount >= this.maxPatchFailures) {
      logger.info(
        { chatId: this.chatId, useCardKit: this.useCardKit },
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
    if (this.useCardKit && this.multiCard) {
      // CardKit v1 path
      try {
        await this.multiCard.commitContent(this.accumulatedText, displayState);
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          { err, chatId: this.chatId, failCount: this.patchFailCount, mode: 'cardkit' },
          'CardKit card update failed',
        );
        throw err;
      }
    } else {
      // Legacy message.patch path
      if (!this.messageId) return;

      const card = buildStreamingCard(this.accumulatedText, displayState);
      const content = JSON.stringify(card);

      try {
        await this.client.im.v1.message.patch({
          path: { message_id: this.messageId },
          data: { content },
        });
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          { err, chatId: this.chatId, failCount: this.patchFailCount, mode: 'legacy' },
          'Streaming card patch failed',
        );
        throw err;
      }
    }
  }

}

// ─── MessageId → ChatJid Mapping ─────────────────────────────
// Reverse lookup for card callback: given a Feishu messageId from a button click,
// find which chatJid (streaming session) it belongs to.

const messageIdToChatJid = new Map<string, string>();

/**
 * Register a messageId → chatJid mapping for card callback routing.
 */
export function registerMessageIdMapping(
  messageId: string,
  chatJid: string,
): void {
  messageIdToChatJid.set(messageId, chatJid);
}

/**
 * Resolve a chatJid from a Feishu messageId.
 */
export function resolveJidByMessageId(
  messageId: string,
): string | undefined {
  return messageIdToChatJid.get(messageId);
}

/**
 * Remove a messageId mapping.
 */
export function unregisterMessageId(messageId: string): void {
  messageIdToChatJid.delete(messageId);
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
 * Also cleans up all messageId → chatJid mappings (including multi-card).
 */
export function unregisterStreamingSession(chatJid: string): void {
  const session = activeSessions.get(chatJid);
  if (session) {
    for (const msgId of session.getAllMessageIds()) {
      unregisterMessageId(msgId);
    }
  }
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
  // Clean up messageId → chatJid mappings before clearing sessions
  for (const session of activeSessions.values()) {
    for (const msgId of session.getAllMessageIds()) {
      unregisterMessageId(msgId);
    }
  }
  activeSessions.clear();
  logger.info(
    { count: promises.length },
    'All streaming sessions aborted',
  );
}
