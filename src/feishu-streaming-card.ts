/**
 * Feishu Streaming Card Controller
 *
 * Three-level degradation chain:
 *   Level 0: Streaming mode — cardElement.content() with native typewriter effect (70ms/char)
 *   Level 1: CardKit v1 — card.update() full JSON replacement (≥1000ms interval)
 *   Level 2: Legacy — im.message.create + im.message.patch
 *
 * Features:
 * - Native typewriter effect via Feishu streaming_mode (Level 0)
 * - Dual-track flushing: text (300ms) / auxiliary (800ms) in streaming mode
 * - Auto-degradation on API failures (streaming → v1 → legacy)
 * - Code-block-safe text splitting (no truncation inside fenced code blocks)
 * - Schema 2.0 card format with body.elements
 * - Multi-card support for extremely long outputs (auto-split at ~45 elements)
 * - 100K character single-element support in streaming mode
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

// ─── Streaming Mode Constants ─────────────────────────────────

const ELEMENT_IDS = {
  AUX_BEFORE: 'aux_before',
  MAIN_CONTENT: 'main_content',
  AUX_AFTER: 'aux_after',
  INTERRUPT_BTN: 'interrupt_btn',
  STATUS_NOTE: 'status_note',
} as const;

const STREAMING_CONFIG = {
  print_frequency_ms: { default: 50 },
  print_step: { default: 2 },
  print_strategy: 'fast' as const,
};

const MAX_STREAMING_CONTENT = 100000; // cardElement.content() supports 100K chars

// ─── Tool Progress & Elapsed Helpers ─────────────────────────

/** Extended tool call state with timing and parameter summary */
interface ToolCallState {
  name: string;
  status: 'running' | 'complete' | 'error';
  startTime: number;
  toolInputSummary?: string;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.floor(sec % 60)}s`;
}

// ─── Auxiliary State & Builder ────────────────────────────────

const MAX_THINKING_CHARS = 800;
const MAX_RECENT_EVENTS = 5;
const MAX_TOOL_DISPLAY = 5;
const MAX_TODO_DISPLAY = 10;
const MAX_TOOL_SUMMARY_CHARS = 60;
const MAX_ELEMENT_CHARS = 4000;
const MAX_COMPLETED_TOOL_AGE = 30000; // 30s — purge completed tools after this

export interface AuxiliaryState {
  thinkingText: string;
  isThinking: boolean;
  toolCalls: Map<string, ToolCallState>;
  systemStatus: string | null;
  activeHook: { hookName: string; hookEvent: string } | null;
  todos: Array<{ id: string; content: string; status: string }> | null;
  recentEvents: Array<{ text: string }>;
}

/**
 * Build auxiliary markdown elements for the streaming card.
 * Returns elements to insert before and after the main text content.
 */
function buildAuxiliaryElements(aux: AuxiliaryState): {
  before: Array<Record<string, unknown>>;
  after: Array<Record<string, unknown>>;
} {
  const before: Array<Record<string, unknown>> = [];
  const after: Array<Record<string, unknown>> = [];

  // ① System Status
  if (aux.systemStatus) {
    before.push({
      tag: 'markdown',
      content: `⏳ ${aux.systemStatus}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  // ② Thinking
  if (aux.isThinking && aux.thinkingText) {
    const truncated = aux.thinkingText.length > MAX_THINKING_CHARS
      ? '...' + aux.thinkingText.slice(-(MAX_THINKING_CHARS - 3))
      : aux.thinkingText;
    // Escape content for blockquote (each line gets "> " prefix)
    const quoted = truncated
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    before.push({
      tag: 'markdown',
      content: `💭 **Reasoning...**\n${quoted}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  } else if (aux.isThinking) {
    before.push({
      tag: 'markdown',
      content: '💭 **Thinking...**',
      text_size: 'notation',
    });
  }

  // ③ Active Tools (running first, then recent completed, max MAX_TOOL_DISPLAY)
  const now = Date.now();
  const running: Array<[string, ToolCallState]> = [];
  const completed: Array<[string, ToolCallState]> = [];
  for (const [id, tc] of aux.toolCalls) {
    if (tc.status === 'running') running.push([id, tc]);
    else completed.push([id, tc]);
  }
  // Show running tools first, fill remaining slots with latest completed
  const display = [
    ...running,
    ...completed.slice(-Math.max(0, MAX_TOOL_DISPLAY - running.length)),
  ].slice(0, MAX_TOOL_DISPLAY);

  if (display.length > 0) {
    const lines = display.map(([, tc]) => {
      const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
      const elapsed = formatElapsed(now - tc.startTime);
      let summary = '';
      if (tc.toolInputSummary) {
        const s = tc.toolInputSummary.length > MAX_TOOL_SUMMARY_CHARS
          ? tc.toolInputSummary.slice(0, MAX_TOOL_SUMMARY_CHARS) + '...'
          : tc.toolInputSummary;
        summary = `  ${s}`;
      }
      return `${icon} \`${tc.name}\` (${elapsed})${summary}`;
    });
    before.push({
      tag: 'markdown',
      content: lines.join('\n').slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  // ④ Hook Status
  if (aux.activeHook) {
    before.push({
      tag: 'markdown',
      content: `🔗 Hook: ${aux.activeHook.hookName || aux.activeHook.hookEvent}`,
      text_size: 'notation',
    });
  }

  // ⑤ Todo Progress
  if (aux.todos && aux.todos.length > 0) {
    const total = aux.todos.length;
    const done = aux.todos.filter((t) => t.status === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const header = `📋 **${done}/${total} (${pct}%)**`;
    const items = aux.todos.slice(0, MAX_TODO_DISPLAY).map((t) => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '⏳' : '○';
      return `${icon} ${t.content}`;
    });
    const extra = total > MAX_TODO_DISPLAY ? `\n... +${total - MAX_TODO_DISPLAY} 项` : '';
    before.push({
      tag: 'markdown',
      content: `${header}\n${items.join('\n')}${extra}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  // ⑦ Recent Events (call trace)
  if (aux.recentEvents.length > 0) {
    const lines = aux.recentEvents.map((e) => `- ${e.text}`);
    after.push({
      tag: 'markdown',
      content: `📝 **调用轨迹**\n${lines.join('\n')}`.slice(0, MAX_ELEMENT_CHARS),
      text_size: 'notation',
    });
  }

  return { before, after };
}

// ─── Legacy Card Builder (Fallback) ──────────────────────────

function buildStreamingCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
  footerNote?: string,
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

  if (footerNote) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: footerNote }],
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
  auxiliaryState?: AuxiliaryState,
  footerNote?: string,
): object {
  const { title, contentElements } = buildCardContent(
    text,
    splitCodeBlockSafe,
    overrideTitle,
  );
  const displayTitle = titlePrefix ? `${titlePrefix}${title}` : title;

  // Build final elements array with auxiliary sections
  const elements: Array<Record<string, unknown>> = [];

  if (auxiliaryState) {
    const { before, after } = buildAuxiliaryElements(auxiliaryState);
    elements.push(...before);
    elements.push(...contentElements);
    elements.push(...after);
  } else {
    elements.push(...contentElements);
  }

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

  if (footerNote) {
    elements.push({
      tag: 'markdown',
      content: footerNote,
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

// ─── Usage Note Formatter ─────────────────────────────────────

function formatUsageNote(usage: {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}): string {
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  const parts: string[] = [];
  parts.push(`${fmt(usage.inputTokens)} / ${fmt(usage.outputTokens)} tokens`);
  if (usage.costUSD > 0) parts.push(`$${usage.costUSD.toFixed(4)}`);
  if (usage.durationMs > 0)
    parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  if (usage.numTurns > 1) parts.push(`${usage.numTurns} turns`);
  return `💰 ${parts.join(' · ')}`;
}

// ─── Streaming Mode Card Builder ──────────────────────────────

function buildStreamingModeCard(initialText: string): object {
  const { title } = extractTitleAndBody(initialText);
  const displayTitle = title || '...';
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: displayTitle },
      streaming_mode: true,
      streaming_config: STREAMING_CONFIG,
    },
    header: {
      title: { tag: 'plain_text', content: displayTitle },
      template: 'wathet',
    },
    body: {
      elements: [
        { tag: 'markdown', content: '', element_id: ELEMENT_IDS.AUX_BEFORE, text_size: 'notation' },
        { tag: 'markdown', content: initialText || '...', element_id: ELEMENT_IDS.MAIN_CONTENT },
        { tag: 'markdown', content: '', element_id: ELEMENT_IDS.AUX_AFTER, text_size: 'notation' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⏹ 中断回复' },
          type: 'danger',
          value: { action: 'interrupt_stream' },
          element_id: ELEMENT_IDS.INTERRUPT_BTN,
        },
        { tag: 'markdown', content: '⏳ 生成中...', element_id: ELEMENT_IDS.STATUS_NOTE, text_size: 'notation' },
      ],
    },
  };
}

/**
 * Serialize auxiliary element array into a single markdown string.
 * Reuses output from buildAuxiliaryElements().
 */
function serializeAuxContent(elements: Array<Record<string, unknown>>): string {
  return elements
    .map((e) => (e as { content?: string }).content || '')
    .filter(Boolean)
    .join('\n\n');
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

  /**
   * Adopt an existing card_id + messageId (for degradation from streaming mode).
   */
  adoptCard(cardId: string, messageId: string, sequence: number): void {
    this.cardId = cardId;
    this._messageId = messageId;
    this.sequence = sequence;
  }
}

// ─── Streaming Mode Backend ───────────────────────────────────

class StreamingModeBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  private lastMainHash = '';
  private lastAuxBeforeHash = '';
  private lastAuxAfterHash = '';
  private readonly client: lark.Client;

  constructor(client: lark.Client) {
    this.client = client;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  getCardId(): string | null {
    return this.cardId;
  }

  getSequence(): number {
    return this.sequence;
  }

  private nextSequence(): number {
    return ++this.sequence;
  }

  /**
   * Create a CardKit card instance with streaming_mode enabled.
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
        `Streaming card.create returned no card_id (code=${code}, msg=${msg})`,
      );
    }

    this.cardId = cardId;
    this.sequence = 1;
    logger.debug({ cardId }, 'Streaming mode card created');
    return cardId;
  }

  /**
   * Send the card as a message. Returns message_id.
   */
  async sendCard(chatId: string, replyToMsgId?: string): Promise<string> {
    if (!this.cardId) throw new Error('Cannot sendCard before createCard');

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
        data: { receive_id: chatId, msg_type: 'interactive', content },
      });
    }

    const messageId = resp?.data?.message_id;
    if (!messageId) throw new Error('No message_id in streaming sendCard response');

    this._messageId = messageId;
    return messageId;
  }

  /**
   * Stream text content via cardElement.content() — platform renders typewriter effect.
   * MD5 dedup to avoid redundant pushes.
   * Auto-retries once on streaming timeout/closed errors.
   */
  async streamContent(text: string): Promise<void> {
    if (!this.cardId) return;

    // Truncate at 100K char limit (hint at end, slice adjusted for hint length)
    const truncHint = `\n\n> ⚠️ 输出已截断（超过 ${MAX_STREAMING_CONTENT} 字符）`;
    const content = text.length > MAX_STREAMING_CONTENT
      ? text.slice(0, MAX_STREAMING_CONTENT - truncHint.length) + truncHint
      : text;

    const hash = quickHash(content);
    if (hash === this.lastMainHash) return;

    try {
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: ELEMENT_IDS.MAIN_CONTENT },
        data: { content, sequence: this.nextSequence() },
      });
      this.lastMainHash = hash;
    } catch (err: any) {
      const code = err?.code ?? err?.response?.data?.code;
      // 200850 = streaming timeout, 300309 = streaming closed
      if (code === 200850 || code === 300309) {
        logger.info({ code, cardId: this.cardId }, 'Streaming mode expired, re-enabling');
        await this.enableStreamingMode();
        // Retry once
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId, element_id: ELEMENT_IDS.MAIN_CONTENT },
          data: { content, sequence: this.nextSequence() },
        });
        this.lastMainHash = hash;
      } else {
        throw err;
      }
    }
  }

  /**
   * Update an auxiliary element via cardElement.update() — instant replacement.
   */
  async updateAuxiliary(
    elementId: typeof ELEMENT_IDS.AUX_BEFORE | typeof ELEMENT_IDS.AUX_AFTER,
    content: string,
  ): Promise<void> {
    if (!this.cardId) return;

    const hash = quickHash(content);
    const hashField = elementId === ELEMENT_IDS.AUX_BEFORE ? 'lastAuxBeforeHash' : 'lastAuxAfterHash';
    if (hash === this[hashField]) return;

    const element = JSON.stringify({
      tag: 'markdown',
      content,
      element_id: elementId,
      text_size: 'notation',
    });

    await this.client.cardkit.v1.cardElement.update({
      path: { card_id: this.cardId, element_id: elementId },
      data: { element, sequence: this.nextSequence() },
    });
    this[hashField] = hash;
  }

  /**
   * Enable streaming mode via card.settings().
   */
  async enableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: true,
            streaming_config: STREAMING_CONFIG,
          },
        }),
        sequence: this.nextSequence(),
      },
    });
  }

  /**
   * Disable streaming mode via card.settings().
   */
  async disableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({
          config: { streaming_mode: false },
        }),
        sequence: this.nextSequence(),
      },
    });
  }

  /**
   * Full card update (used for final state after disabling streaming).
   */
  async updateCardFull(cardJson: object): Promise<void> {
    if (!this.cardId) return;
    await this.client.cardkit.v1.card.update({
      path: { card_id: this.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(cardJson) },
        sequence: this.nextSequence(),
      },
    });
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

  getCardCount(): number {
    return this.cards.length;
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
   * Adopt an existing card (for degradation from streaming mode, avoids creating a new message).
   */
  adoptExistingCard(card: CardKitBackend): void {
    this.cards.push(card);
    this.cardIndex = 0;
  }

  /**
   * Commit content: update the current card, auto-splitting if needed.
   */
  async commitContent(
    text: string,
    state: 'streaming' | 'completed' | 'aborted',
    auxiliaryState?: AuxiliaryState,
    footerNote?: string,
  ): Promise<void> {
    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';

    // Estimate element count: content + auxiliary + fixed elements
    const { contentElements } = buildCardContent(text, splitCodeBlockSafe);
    const auxCount = auxiliaryState
      ? (() => {
          const { before, after } = buildAuxiliaryElements(auxiliaryState);
          return before.length + after.length;
        })()
      : 0;
    const fixedCount = (state === 'streaming' ? 1 : 0)        // button
                     + (SCHEMA2_NOTE_MAP[state] ? 1 : 0)      // note
                     + (footerNote ? 1 : 0);                   // footer
    const totalElements = contentElements.length + auxCount + fixedCount;

    if (totalElements > this.MAX_ELEMENTS && state === 'streaming') {
      // Need to split: freeze current card and create a new one
      await this.splitToNewCard(text);
      return;
    }

    // Normal update on current card
    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    const cardJson = buildSchema2Card(text, state, titlePrefix, undefined, auxiliaryState, footerNote);

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

  // Streaming mode (Level 0)
  private streamingBackend: StreamingModeBackend | null = null;
  private textFlushCtrl: FlushController | null = null;
  private auxFlushCtrl: FlushController | null = null;
  private lastAuxSnapshot = '';

  // Streaming state
  private thinking = false;
  private thinkingText = '';
  private toolCalls = new Map<string, ToolCallState>();
  private startTime = 0;
  private backendMode: 'streaming' | 'v1' | 'legacy' = 'v1';

  // Auxiliary display state
  private systemStatus: string | null = null;
  private activeHook: { hookName: string; hookEvent: string } | null = null;
  private todos: Array<{ id: string; content: string; status: string }> | null = null;
  private recentEvents: Array<{ text: string }> = [];
  private stateVersion = 0;

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
    if (this.streamingBackend) return this.streamingBackend.messageId;
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
    if (this.streamingBackend?.messageId) return [this.streamingBackend.messageId];
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
    this.toolCalls.set(toolId, { name: toolName, status: 'running', startTime: Date.now() });
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
    }
  }

  /**
   * Signal that a tool has finished executing.
   */
  endTool(toolId: string, isError: boolean): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      this.stateVersion++;
      this.purgeOldTools();
      if (this.state === 'streaming') {
        this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
      }
    }
  }

  /**
   * Purge completed/error tools older than MAX_COMPLETED_TOOL_AGE to prevent unbounded growth.
   */
  private purgeOldTools(): void {
    const cutoff = Date.now() - MAX_COMPLETED_TOOL_AGE;
    for (const [id, tc] of this.toolCalls) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.toolCalls.delete(id);
      }
    }
  }

  /**
   * Append thinking text (accumulated, tail-truncated at MAX_THINKING_CHARS).
   */
  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > MAX_THINKING_CHARS) {
      this.thinkingText = '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;
    this.stateVersion++;
    if (this.state === 'idle') {
      this.state = 'creating';
      this.createInitialCard().catch((err) => {
        logger.warn({ err, chatId: this.chatId }, 'Streaming card: initial create failed (thinking), will use fallback');
        this.state = 'error';
        this.onFallback?.();
      });
    } else if (this.state === 'streaming') {
      this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
    }
  }

  /**
   * Set or clear system status text (e.g. "上下文压缩中").
   */
  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
    }
  }

  /**
   * Set or clear active hook state.
   */
  setHook(hook: { hookName: string; hookEvent: string } | null): void {
    this.activeHook = hook;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
    }
  }

  /**
   * Set the todo list for progress panel display.
   */
  setTodos(todos: Array<{ id: string; content: string; status: string }>): void {
    this.todos = todos;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
    }
  }

  /**
   * Push a recent event to the call trace log (FIFO, max MAX_RECENT_EVENTS).
   * Does NOT trigger schedulePatch — piggybacks on other events.
   */
  pushRecentEvent(text: string): void {
    this.recentEvents.push({ text });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
  }

  /**
   * Update a tool's input summary (displayed as parameter hint).
   */
  updateToolSummary(toolId: string, summary: string): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      tc.toolInputSummary = summary;
      this.stateVersion++;
      if (this.state === 'streaming') {
        this.backendMode === 'streaming' ? this.scheduleAuxFlush() : this.schedulePatch();
      }
    }
  }

  /**
   * Get tool info by ID (for building call trace text).
   */
  getToolInfo(toolId: string): { name: string } | undefined {
    const tc = this.toolCalls.get(toolId);
    return tc ? { name: tc.name } : undefined;
  }

  /**
   * Append text to the streaming card.
   * Creates the card on first call, then patches on subsequent calls.
   */
  append(text: string): void {
    this.accumulatedText = text;
    this.thinking = false; // Text arrived, no longer just thinking
    this.thinkingText = ''; // Clear thinking text once real text arrives

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
      this.backendMode === 'streaming' ? this.scheduleTextFlush() : this.schedulePatch();
    }
    // If 'creating', the text will be picked up after creation completes
  }

  /**
   * Complete the streaming card with final text.
   */
  async complete(finalText: string): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'creating') return;

    const prevState = this.state;
    this.accumulatedText = finalText;
    this.state = 'completed';
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        await this.finalizeStreamingCard('completed');
      } else if (this.messageId || this.multiCard) {
        await this.patchCard('completed');
      }
    } catch (err) {
      // Revert state so abort() doesn't bail on the 'completed' check
      this.state = prevState;
      throw err;
    }
  }

  /**
   * Patch a completed card to append a usage note at the bottom.
   * Called AFTER complete() because agent-runner emits usage after the final result.
   */
  async patchUsageNote(usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {
    if (this.state !== 'completed') return;

    const note = formatUsageNote(usage);
    if (!note) return;

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        const cardJson = buildSchema2Card(
          this.accumulatedText,
          'completed',
          '',
          undefined,
          undefined,
          note,
        );
        // Skip if card was split during finalization — rebuilding a single card
        // would overwrite the first card with full text while continuation cards remain.
        const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');
        if (cardSize > CARD_SIZE_LIMIT) return;
        await this.streamingBackend.updateCardFull(cardJson);
      } else if (this.messageId || this.multiCard) {
        // For CardKit v1 / legacy: skip if multiCard has split content
        if (this.multiCard && this.multiCard.getCardCount() > 1) return;
        await this.patchCard('completed', note);
      }
    } catch (err) {
      logger.debug(
        { err, chatId: this.chatId },
        'Streaming card: patchUsageNote failed (non-fatal)',
      );
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
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();

    if (reason) {
      this.accumulatedText += `\n\n---\n*${reason}*`;
    }

    if (this.backendMode === 'streaming' && this.streamingBackend && wasActive) {
      try {
        await this.finalizeStreamingCard('aborted');
      } catch (err) {
        logger.debug({ err, chatId: this.chatId }, 'Streaming card: abort finalize failed');
      }
    } else if ((this.messageId || this.multiCard) && wasActive) {
      try {
        await this.patchCard('aborted');
      } catch (err) {
        logger.debug({ err, chatId: this.chatId }, 'Streaming card: abort patch failed');
      }
    }
  }

  dispose(): void {
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
  }

  // ─── Internal Methods ──────────────────────────────────

  private async createInitialCard(): Promise<void> {
    const initialText = this.accumulatedText || (this.thinking ? '' : '...');

    // ── Level 0: Try streaming mode (cardElement.content typewriter) ──
    try {
      const backend = new StreamingModeBackend(this.client);
      const cardJson = buildStreamingModeCard(initialText);
      await backend.createCard(cardJson);
      const messageId = await backend.sendCard(this.chatId, this.replyToMsgId);

      this.streamingBackend = backend;
      this.messageId = messageId;
      this.backendMode = 'streaming';
      this.useCardKit = true;
      this.startTime = Date.now();
      // Streaming mode: 300ms text flush, 800ms aux flush
      this.textFlushCtrl = new FlushController(300, 30);
      this.auxFlushCtrl = new FlushController(800, 0);
      this.maxPatchFailures = 3;

      logger.debug(
        { chatId: this.chatId, messageId, mode: 'streaming' },
        'Streaming card created via streaming mode',
      );

      this.finishCardCreation();
      return;
    } catch (streamingErr) {
      logger.info(
        { err: streamingErr, chatId: this.chatId },
        'Streaming mode unavailable, falling back to CardKit v1',
      );
      this.streamingBackend = null;
    }

    // ── Level 1: Try CardKit v1 full-update (card.update with full JSON) ──
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
      // ── Level 2: Legacy message.create + message.patch ──
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
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        this.finalizeStreamingCard(finalState).catch((err) => {
          logger.debug({ err, chatId: this.chatId }, 'Failed to finalize streaming card after late creation');
        });
      } else {
        this.patchCard(finalState).catch((err) => {
          logger.debug({ err, chatId: this.chatId }, 'Failed to patch to final state after late creation');
        });
      }
      return;
    }

    this.state = 'streaming';
    if (this.messageId) {
      this.onCardCreated?.(this.messageId);
    }

    // If text accumulated while creating, schedule a flush/patch
    if (this.accumulatedText.length > 3) {
      this.backendMode === 'streaming' ? this.scheduleTextFlush() : this.schedulePatch();
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

    // Use effectiveLength so FlushController detects non-text state changes
    // (thinking, tool status, system status, etc.)
    const effectiveLength = this.accumulatedText.length + this.stateVersion * 1000;
    this.flushCtrl.schedule(effectiveLength, async () => {
      await this.patchCard('streaming');
    });
  }

  private getAuxiliaryState(): AuxiliaryState {
    return {
      thinkingText: this.thinkingText,
      isThinking: this.thinking,
      toolCalls: this.toolCalls,
      systemStatus: this.systemStatus,
      activeHook: this.activeHook,
      todos: this.todos,
      recentEvents: this.recentEvents,
    };
  }

  // ─── Streaming Mode Methods ──────────────────────────────

  /**
   * Schedule a text content flush for streaming mode.
   * Falls back to schedulePatch() if streaming backend is not available.
   */
  private scheduleTextFlush(): void {
    if (!this.streamingBackend || !this.textFlushCtrl) {
      this.schedulePatch();
      return;
    }

    this.textFlushCtrl.schedule(this.accumulatedText.length, async () => {
      try {
        await this.streamingBackend!.streamContent(this.accumulatedText);
        this.textFlushCtrl!.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          { err, chatId: this.chatId, failCount: this.patchFailCount, mode: 'streaming' },
          'Streaming content push failed',
        );
        if (this.patchFailCount >= this.maxPatchFailures) {
          this.degradeToV1();
        }
      }
    });
  }

  /**
   * Schedule an auxiliary content flush for streaming mode.
   * Falls back to schedulePatch() if streaming backend is not available.
   */
  private scheduleAuxFlush(): void {
    if (!this.streamingBackend || !this.auxFlushCtrl) {
      this.schedulePatch();
      return;
    }

    this.auxFlushCtrl.schedule(this.stateVersion * 1000, async () => {
      // Recalculate aux state inside callback to avoid stale closures
      const auxState = this.getAuxiliaryState();
      const { before, after } = buildAuxiliaryElements(auxState);
      const auxBefore = serializeAuxContent(before);
      const auxAfter = serializeAuxContent(after);
      const snapshot = auxBefore + '||' + auxAfter;
      if (snapshot === this.lastAuxSnapshot) return;

      try {
        await this.streamingBackend!.updateAuxiliary(ELEMENT_IDS.AUX_BEFORE, auxBefore);
        await this.streamingBackend!.updateAuxiliary(ELEMENT_IDS.AUX_AFTER, auxAfter);
        this.lastAuxSnapshot = snapshot;
      } catch (err) {
        // Auxiliary update failures do NOT count toward degradation
        logger.debug(
          { err, chatId: this.chatId, mode: 'streaming' },
          'Streaming auxiliary update failed (non-critical)',
        );
      }
    });
  }

  /**
   * Degrade from streaming mode to v1 full-update mode.
   */
  private degradeToV1(): void {
    logger.warn(
      { chatId: this.chatId },
      'Streaming mode: degrading to v1 full-update',
    );

    // Save card_id and sequence from streaming backend before clearing
    const existingCardId = this.streamingBackend!.getCardId();
    const existingSeq = this.streamingBackend!.getSequence();

    // Try to disable streaming mode gracefully (fire and forget)
    this.streamingBackend?.disableStreamingMode().catch(() => {});

    this.backendMode = 'v1';
    this.streamingBackend = null;
    this.textFlushCtrl?.dispose();
    this.textFlushCtrl = null;
    this.auxFlushCtrl?.dispose();
    this.auxFlushCtrl = null;
    this.patchFailCount = 0;

    // Set up v1 flush controller
    this.flushCtrl.dispose();
    this.flushCtrl = new FlushController(1000, 50);

    // Adopt the existing streaming card into a CardKitBackend (reuses card_id, no new message)
    const adoptedCard = new CardKitBackend(this.client);
    adoptedCard.adoptCard(existingCardId!, this.messageId!, existingSeq);

    this.multiCard = new MultiCardManager(
      this.client,
      this.chatId,
      this.replyToMsgId,
      this.onCardCreated,
    );
    this.multiCard.adoptExistingCard(adoptedCard);

    // Schedule an immediate patch to sync the current state
    this.schedulePatch();
  }

  /**
   * Finalize a streaming card: disable streaming mode, then set final state.
   */
  private async finalizeStreamingCard(
    finalState: 'completed' | 'aborted',
  ): Promise<void> {
    const backend = this.streamingBackend!;

    try {
      // 1. Disable streaming mode (allows header/button changes)
      await backend.disableStreamingMode();

      // 2. Build final card with optimizeMarkdownStyle
      const cardJson = buildSchema2Card(this.accumulatedText, finalState);
      const cardSize = Buffer.byteLength(JSON.stringify(cardJson), 'utf-8');

      if (cardSize <= CARD_SIZE_LIMIT) {
        // 3a. Single card fits
        await backend.updateCardFull(cardJson);
      } else {
        // 3b. Too large for single card — split on finalize
        await this.splitOnFinalize(finalState);
      }
    } catch (err) {
      logger.debug({ err, chatId: this.chatId }, 'Streaming finalize failed, trying truncated fallback');
      // Fallback: truncate and try once more
      try {
        const truncated = this.accumulatedText.slice(0, 20000);
        const fallbackCard = buildSchema2Card(truncated + '\n\n> ⚠️ 输出已截断', finalState);
        await backend.updateCardFull(fallbackCard);
      } catch (fallbackErr) {
        logger.debug({ err: fallbackErr, chatId: this.chatId }, 'Streaming finalize truncated fallback also failed');
      }
    }
  }

  /**
   * Split content into multiple cards on finalize (only when streaming card content exceeds CARD_SIZE_LIMIT).
   * The first card (existing streaming card) gets frozen, subsequent cards are new.
   */
  private async splitOnFinalize(
    finalState: 'completed' | 'aborted',
  ): Promise<void> {
    const backend = this.streamingBackend!;
    const { title } = extractTitleAndBody(this.accumulatedText);
    const chunks = splitCodeBlockSafe(this.accumulatedText, CARD_MD_LIMIT);

    // How many chunks fit in the first card?
    const MAX_ELEMENTS_PER_CARD = 45;
    const fixedElements = 2; // note + margin
    const maxChunksFirst = MAX_ELEMENTS_PER_CARD - fixedElements;

    const firstChunks = chunks.slice(0, maxChunksFirst);
    const firstText = firstChunks.join('\n\n');

    // Use finalState if all content fits in the first card, otherwise freeze
    const firstCardState = chunks.length <= maxChunksFirst ? finalState : 'frozen';
    const frozenCard = buildSchema2Card(firstText, firstCardState, '', title);
    await backend.updateCardFull(frozenCard);

    // Create continuation cards
    let remaining = chunks.slice(maxChunksFirst);
    while (remaining.length > 0) {
      const batch = remaining.slice(0, maxChunksFirst);
      remaining = remaining.slice(maxChunksFirst);
      const batchText = batch.join('\n\n');
      const state = remaining.length === 0 ? finalState : 'frozen';
      const contCard = new CardKitBackend(this.client);
      const contCardJson = buildSchema2Card(batchText, state, '(续) ', title);
      await contCard.createCard(contCardJson);
      const newMsgId = await contCard.sendCard(this.chatId);
      this.onCardCreated?.(newMsgId);
    }
  }

  private async patchCard(
    displayState: 'streaming' | 'completed' | 'aborted',
    footerNote?: string,
  ): Promise<void> {
    if (this.useCardKit && this.multiCard) {
      // CardKit v1 path — pass auxiliary state for rich display
      const auxState = displayState === 'streaming' ? this.getAuxiliaryState() : undefined;
      try {
        await this.multiCard.commitContent(this.accumulatedText, displayState, auxState, footerNote);
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
      // Legacy message.patch path (no auxiliary content)
      if (!this.messageId) return;

      const card = buildStreamingCard(this.accumulatedText, displayState, footerNote);
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
