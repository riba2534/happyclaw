/**
 * Feishu Streaming Card Controller
 *
 * Three-level degradation chain:
 *   Level 0: Streaming mode — cardElement.content() with native typewriter effect
 *   Level 1: CardKit v1 — card.update() full JSON replacement (≥1000ms interval)
 *   Level 2: Legacy — im.message.create + im.message.patch
 *
 * Features:
 * - Native typewriter effect via Feishu streaming_mode (Level 0)
 * - Dual-track flushing: text (600ms) / auxiliary (1500ms) in streaming mode
 * - Auto-degradation on API failures (streaming → v1 → legacy)
 * - Code-block-safe text splitting (no truncation inside fenced code blocks)
 * - Schema 2.0 card format with body.elements
 * - Multi-card support for extremely long outputs (auto-split at ~45 elements)
 * - Measured CardKit capacity with lossless, adaptive continuation pages
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'crypto';
import { logger } from './logger.js';
import { optimizeMarkdownStyle } from './feishu-markdown-style.js';
import {
  buildAgentReplyCard,
  buildStreamingAgentCard,
  buildStreamingContentElements,
  STREAMING_CONFIG,
} from './feishu-cards/builder.js';
import { splitCardPages, type CardPage } from './feishu-cards/pagination.js';
import {
  CARDKIT_JSON_MAX_BYTES,
  fitsCardCapacity,
} from './feishu-cards/capacity.js';
import type { CardStatus, ToolCallStat } from './feishu-cards/types.js';
import {
  formatFeishuUsageNote,
  type FeishuUsageNoteInput,
} from './feishu-usage-display.js';
import {
  definitiveFeishuHttpRejection,
  definitiveFeishuPreAcceptanceFailure,
} from './feishu-capability.js';
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import {
  explicitImDeliveryPhase,
  ImDeliveryPhaseError,
} from './im-send-retry-policy.js';
import {
  CARD_ELEMENT_IDS,
  statusHeadline,
  buildStatusBannerText,
  buildProgressListText,
  buildToolsTimelineText,
  buildThinkingBlockquote,
  buildAskQuestionText,
  collectAskQuestions,
  buildTimelineText,
  buildStreamingDetails,
  formatRuntimeDetail,
  type StreamingPhase,
  type TodoItemView,
  type ToolCallView,
} from './feishu-cards/sections.js';

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
  /** When replying to a Feishu topic/thread, keep the card inside that thread. */
  replyInThread?: boolean;
  /** Called when the card is created or streaming fails */
  onFallback?: () => void;
  /** Called when the initial card is created and messageId is available */
  onCardCreated?: (messageId: string) => void;
  /** Durable lifecycle observer. Failures are isolated from provider delivery. */
  lifecycle?: StreamingCardLifecycle;
}

export interface StreamingCardLifecycleSnapshot {
  text: string;
  /** Visible page only; canonical text remains available separately. */
  visibleText?: string;
  thinking: string;
  state: StreamingState;
  backendMode: 'streaming' | 'v1' | 'legacy';
}

export interface StreamingCardLifecycleEvent {
  status:
    | 'creating'
    | 'streaming'
    | 'waiting_user'
    | 'running'
    | 'finalizing'
    | 'completed'
    | 'aborted'
    | 'failed';
  messageId: string | null;
  cardId: string | null;
  version: number;
  snapshot: StreamingCardLifecycleSnapshot;
  error?: string;
}

export interface StreamingCardLifecycle {
  onEvent(event: StreamingCardLifecycleEvent): void;
}

export interface InterruptedStreamingCardInput {
  messageId: string | null;
  cardId: string | null;
  version: number;
  snapshot?: unknown;
  reason?: string;
}

const DEFAULT_INTERRUPT_REASON = '上次服务中断，本次任务未完成';

/** Visible body stored on a leftover streaming-card snapshot. */
export function streamingCardSnapshotText(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const data = snapshot as { text?: unknown; visibleText?: unknown };
  const text =
    typeof data.visibleText === 'string' ? data.visibleText : data.text;
  return typeof text === 'string' ? text.trim() : '';
}

function streamingCardRecoveryCompleted(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const recovery = (snapshot as { recovery?: { completed?: unknown } })
    .recovery;
  return recovery?.completed === true;
}

/** Crash recovery rewrite: only an explicitly completed recovery looks done. */
export function resolveInterruptedStreamingCardRewrite(input: {
  snapshot?: unknown;
  reason?: string;
}): { text: string; status: 'done' | 'warning'; hasBody: boolean } {
  const body = streamingCardSnapshotText(input.snapshot);
  if (streamingCardRecoveryCompleted(input.snapshot)) {
    return { text: body, status: 'done', hasBody: body.length > 0 };
  }
  const reason = input.reason?.trim() || DEFAULT_INTERRUPT_REASON;
  return {
    text: body ? `${body}\n\n> ⚠️ ${reason}` : `> ⚠️ ${reason}`,
    status: 'warning',
    hasBody: body.length > 0,
  };
}

/** Extract the platform error code from both rejected SDK calls and resolved
 * error envelopes. Lark SDK versions differ in where they expose this field. */
function feishuErrorCode(value: unknown): number | undefined {
  const error = value as {
    code?: unknown;
    data?: { code?: unknown };
    response?: { data?: { code?: unknown } };
    message?: unknown;
  };
  const raw =
    error?.response?.data?.code ??
    error?.data?.code ??
    error?.code ??
    undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  const match =
    typeof error?.message === 'string'
      ? error.message.match(/\b(230071|230072)\b/)
      : null;
  return match ? Number(match[1]) : undefined;
}

function isReplyInThreadUnsupported(value: unknown): boolean {
  const code = feishuErrorCode(value);
  return code === 230071 || code === 230072;
}

/**
 * Reply in a topic when requested. Some Feishu chat/message combinations
 * reject `reply_in_thread` with 230071/230072 even though an ordinary reply to
 * the same message is legal. Retry exactly once without the flag; all other
 * errors remain fail-closed and bubble to the existing degradation/fallback.
 */
async function replyInteractiveCard(
  client: lark.Client,
  messageId: string,
  content: string,
  replyInThread: boolean,
): Promise<any> {
  const send = (inThread: boolean) =>
    client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content,
        msg_type: 'interactive',
        ...(inThread ? { reply_in_thread: true } : {}),
      },
    });

  try {
    const response = await send(replyInThread);
    if (replyInThread && isReplyInThreadUnsupported(response)) {
      logger.warn(
        { messageId, code: feishuErrorCode(response) },
        'reply_in_thread unsupported for streaming card, retrying plain reply',
      );
      return send(false);
    }
    return response;
  } catch (error) {
    if (!replyInThread || !isReplyInThreadUnsupported(error)) throw error;
    logger.warn(
      { messageId, code: feishuErrorCode(error) },
      'reply_in_thread unsupported for streaming card, retrying plain reply',
    );
    return send(false);
  }
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
 * Split text respecting fenced code block boundaries — never truncates inside
 * a code block without properly closing/reopening the fence.
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
/**
 * Per-card BODY byte budget for rollover/finalize splitting. Must be measured
 * in UTF-8 BYTES, not chars: CJK is 3 bytes/char, so an 18000-CHAR budget
 * yields ~54KB cards that the Feishu ~30KB API rejects — the exact failure
 * that made long Chinese replies finalize into a zombie「生成中」card. Leaves
 * headroom under CARD_SIZE_LIMIT for the card skeleton + JSON escaping.
 */
const FREEZE_SLICE_BYTES = 16 * 1024;

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf-8');

export function extractTitleAndBody(text: string): {
  title: string;
  body: string;
} {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
    } else {
      const firstLine = lines[i].replace(/[*_`#\[\]]/g, '').trim();
      title =
        firstLine.length > 40 ? firstLine.slice(0, 37) + '...' : firstLine;
    }
    bodyStartIdx = i + 1;
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  if (!title) title = 'Reply';

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
  // When the auto-extracted title is the first line, body excludes that line so
  // we don't echo it back into the content area (issue #488). With an
  // overrideTitle the first line is ordinary content (e.g. mid-stream text on a
  // continuation card, possibly a ``` fence line) — dropping it would silently
  // lose content, so render the full text instead.
  const rendered = overrideTitle ? text : body;
  const contentToRender = rendered ? optimizeMarkdownStyle(rendered, 2) : '';
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

  return { title, contentElements: elements };
}

// ─── Interrupt Button Element ────────────────────────────────

/**
 * Schema 2.0 standalone button — used by every card path (legacy + CardKit).
 * Interrupting is a routine user choice, not a destructive action, so the button
 * stays a neutral `default` button. Reserve the red `danger` accent for genuine
 * error states (failed/timeout cards) so red keeps its "something went wrong"
 * meaning instead of glowing on every in-progress reply.
 */
const INTERRUPT_BUTTON_V2 = {
  tag: 'button',
  text: { tag: 'plain_text', content: '⏹ 中断回复' },
  type: 'default',
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

const STREAMING_PLACEHOLDER = '> 正在处理请求…';

// ─── Tool Progress & Elapsed Helpers ─────────────────────────

/** Extended tool call state with timing and parameter summary */
interface ToolCallState {
  name: string;
  status: 'running' | 'complete' | 'error';
  startTime: number;
  endTime?: number;
  toolInputSummary?: string;
  /** When wrapping a Skill, the concrete skill name for display. */
  skillName?: string;
  /** True for tool calls spawned inside a Task sub-agent. */
  isNested?: boolean;
  /** Raw tool input, needed for AskUserQuestion structured rendering. */
  toolInput?: Record<string, unknown>;
}

interface TaskRunState {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'error' | 'backgrounded';
  subagentType?: string;
  lastToolName?: string;
  summary?: string;
  updatedAt: number;
}

/** Extra metadata a caller can attach to a running tool call. */
export interface ToolCallMeta {
  skillName?: string;
  isNested?: boolean;
  toolInput?: Record<string, unknown>;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.floor(sec % 60)}s`;
}

// ─── Auxiliary State & Builder ────────────────────────────────

const MAX_THINKING_CHARS = 2000;
const MAX_RECENT_EVENTS = 20;
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
  tasks: Map<string, TaskRunState>;
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

  // ② Thinking — v2-styled with text_tag + blockquote so the legacy degraded
  // path mirrors the structured thinking panel used in streaming mode.
  if (aux.isThinking && aux.thinkingText) {
    const truncated =
      aux.thinkingText.length > MAX_THINKING_CHARS
        ? '…' + aux.thinkingText.slice(-(MAX_THINKING_CHARS - 1))
        : aux.thinkingText;
    const quoted = truncated
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');
    before.push({
      tag: 'markdown',
      content:
        `<text_tag color='blue'>思考中</text_tag> 🧠 <font color='grey'>正在推理…</font>\n${quoted}`.slice(
          0,
          MAX_ELEMENT_CHARS,
        ),
      text_size: 'notation',
    });
  } else if (aux.isThinking) {
    before.push({
      tag: 'markdown',
      content:
        "<text_tag color='blue'>思考中</text_tag> 🧠 <font color='grey'>正在推理…</font>",
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
      const icon =
        tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
      const elapsed = formatElapsed((tc.endTime ?? now) - tc.startTime);
      let summary = '';
      if (tc.toolInputSummary) {
        const s =
          tc.toolInputSummary.length > MAX_TOOL_SUMMARY_CHARS
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

  // ④ Task / sub-agent status
  if (aux.tasks.size > 0) {
    const tasks = Array.from(aux.tasks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    const lines = tasks.map((task) => {
      const icon =
        task.status === 'running'
          ? '🔄'
          : task.status === 'completed'
            ? '✅'
            : task.status === 'backgrounded'
              ? '🌙'
              : '❌';
      const type = task.subagentType
        ? ` <font color='grey'>${task.subagentType}</font>`
        : '';
      const last = task.lastToolName ? ` [${task.lastToolName}]` : '';
      const summary = task.summary
        ? `\n  <font color='grey'>${task.summary.slice(0, 160)}</font>`
        : '';
      return `${icon} **${task.title.slice(0, 80)}**${type}${last}${summary}`;
    });
    before.push({
      tag: 'markdown',
      content: `🤖 **子 Agent / Task**\n${lines.join('\n')}`.slice(
        0,
        MAX_ELEMENT_CHARS,
      ),
      text_size: 'notation',
    });
  }

  // ⑤ Hook Status
  if (aux.activeHook) {
    before.push({
      tag: 'markdown',
      content: `🔗 Hook: ${aux.activeHook.hookName || aux.activeHook.hookEvent}`,
      text_size: 'notation',
    });
  }

  // ⑥ Todo Progress
  if (aux.todos && aux.todos.length > 0) {
    const total = aux.todos.length;
    const done = aux.todos.filter((t) => t.status === 'completed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const header = `📋 **${done}/${total} (${pct}%)**`;
    const items = aux.todos.slice(0, MAX_TODO_DISPLAY).map((t) => {
      const icon =
        t.status === 'completed'
          ? '✅'
          : t.status === 'in_progress'
            ? '⏳'
            : '○';
      return `${icon} ${t.content}`;
    });
    const extra =
      total > MAX_TODO_DISPLAY ? `\n... +${total - MAX_TODO_DISPLAY} 项` : '';
    before.push({
      tag: 'markdown',
      content: `${header}\n${items.join('\n')}${extra}`.slice(
        0,
        MAX_ELEMENT_CHARS,
      ),
      text_size: 'notation',
    });
  }

  // ⑦ Recent Events (call trace)
  if (aux.recentEvents.length > 0) {
    const lines = aux.recentEvents.map((e) => `- ${e.text}`);
    after.push({
      tag: 'markdown',
      content: `📝 **调用轨迹**\n${lines.join('\n')}`.slice(
        0,
        MAX_ELEMENT_CHARS,
      ),
      text_size: 'notation',
    });
  }

  return { before, after };
}

// ─── Legacy Card Builder (Schema 2.0, im.v1.message.patch path) ──────
//
// Used when CardKit streaming_mode / updateCard are unavailable and we fall
// back to patching the full interactive card JSON via im.v1.message.patch.
// The shape is v2 throughout — no `action`/`note` containers, no
// `wide_screen_mode` — so Feishu clients render it with the same look as the
// CardKit-driven path. Layout stays flat (no collapsible panels) because each
// patch resends the full card JSON and we want payloads to stay small.

function buildStreamingCard(
  text: string,
  state: 'streaming' | 'completed' | 'aborted',
  footerNote?: string,
): object {
  // Terminal states delegate to the structured v2 builder, which drives the
  // header off status: `done` drops the header so short replies aren't reduced
  // to a truncated title (issue #488), while `aborted`→warning keeps an orange
  // status header. Body, metadata slot and grey-notation footer match every
  // other reply.
  if (state === 'completed') {
    return buildAgentReplyCard({
      status: 'done',
      text,
      footer: footerNote,
    });
  }
  if (state === 'aborted') {
    return buildAgentReplyCard({
      status: 'warning',
      text,
      footer: footerNote,
    });
  }

  // Streaming state — flat v2 layout for cheap full-card patches. The header is
  // a fixed status word ("生成中"), never the reply's first line: keeping the
  // body intact (first line stays in MAIN_CONTENT) means the streaming→terminal
  // transition no longer shuffles the first line between header and body.
  const optimized = optimizeMarkdownStyle(text || STREAMING_PLACEHOLDER, 2);
  const streamingTitle = statusHeadline('running');
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: optimized,
      element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
    },
    { ...INTERRUPT_BUTTON_V2, element_id: CARD_ELEMENT_IDS.INTERRUPT_BTN },
    {
      tag: 'markdown',
      content: '⏳ 生成中...',
      element_id: CARD_ELEMENT_IDS.STATUS_NOTE,
      text_size: 'notation',
    },
  ];
  if (footerNote) {
    elements.push({
      tag: 'markdown',
      content: footerNote,
      text_size: 'notation',
      element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
    });
  }
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      summary: { content: streamingTitle },
    },
    header: {
      title: { tag: 'plain_text', content: streamingTitle },
      template: 'blue',
    },
    body: { elements },
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
  streaming: 'blue',
  completed: 'violet',
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
  if (
    state === 'streaming' &&
    text === STREAMING_PLACEHOLDER &&
    contentElements.length === 0
  ) {
    contentElements.push({
      tag: 'markdown',
      content: STREAMING_PLACEHOLDER,
      element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
    });
  }
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
      width_mode: 'fill',
      summary: { content: displayTitle },
    },
    header: {
      title: { tag: 'plain_text', content: displayTitle },
      template: SCHEMA2_HEADER_MAP[state],
    },
    body: { elements },
  };
}

/**
 * Pick the primary model name from a per-model usage breakdown — the model that
 * produced the most output tokens (the one that actually generated the reply,
 * not a cheap summarizer/router model). Falls back to the first key.
 */
function pickPrimaryModel(
  modelUsage: Record<string, { outputTokens?: number }> | undefined,
): string | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;
  let best = entries[0][0];
  let bestOut = entries[0][1]?.outputTokens ?? 0;
  for (const [name, mu] of entries) {
    const out = mu?.outputTokens ?? 0;
    if (out > bestOut) {
      best = name;
      bestOut = out;
    }
  }
  return best;
}

// ─── Streaming Mode Card Builder ──────────────────────────────

function buildStreamingModeCard(initialText: string): object {
  // Delegate to the shared rich skeleton: STATUS_BANNER + PROGRESS / TOOLS /
  // THINKING collapsible_panels + MAIN_CONTENT (typewriter) + INTERRUPT button
  // + FOOTER_NOTE. Each panel wraps a markdown element with its own element_id
  // so the controller can patch slots independently.
  return buildStreamingAgentCard({ initialText, rich: true });
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

class CardKitRejectedError extends Error {
  readonly code: number;

  constructor(operation: string, code: number, message: string) {
    super(
      `${operation} was rejected by CardKit (code=${code}, msg=${message})`,
    );
    this.name = 'CardKitRejectedError';
    this.code = code;
  }
}

function standaloneFeishuProviderErrorCode(value: unknown): number | undefined {
  if (
    value &&
    typeof value === 'object' &&
    (value as { response?: unknown }).response
  ) {
    // HTTP 408/5xx responses are deliberately excluded by
    // definitiveFeishuHttpRejection: their body code must not re-authorize a
    // second presentation after an intermediary/upstream ambiguous response.
    return undefined;
  }
  return feishuErrorCode(value);
}

function feishuCardResourceError(operation: string, error: unknown): Error {
  const phase = explicitImDeliveryPhase(error);
  if (phase) return error as Error;
  const rejection =
    error instanceof CardKitRejectedError
      ? error
      : definitiveFeishuHttpRejection(error);
  return new ImDeliveryPhaseError(
    rejection ? 'rejected' : 'pre_accept',
    `${operation} failed before any visible Feishu card message was sent`,
    { cause: rejection ?? error },
  );
}

function feishuVisibleCardMutationError(
  operation: string,
  error: unknown,
): Error {
  const phase = explicitImDeliveryPhase(error);
  if (phase) return error as Error;
  const preAccept = definitiveFeishuPreAcceptanceFailure(error);
  if (preAccept) {
    return new ImDeliveryPhaseError(
      'pre_accept',
      `${operation} failed before Feishu could accept the card message`,
      { cause: preAccept },
    );
  }
  const rejection =
    error instanceof CardKitRejectedError
      ? error
      : definitiveFeishuHttpRejection(error);
  if (rejection || standaloneFeishuProviderErrorCode(error) !== undefined) {
    return new ImDeliveryPhaseError(
      'rejected',
      `${operation} was definitively rejected by Feishu`,
      { cause: rejection ?? error },
    );
  }
  return new ImDeliveryPhaseError(
    'uncertain',
    `${operation} may have been accepted; refusing a second card presentation`,
    { cause: error },
  );
}

function canSwitchFeishuCardBackend(error: unknown): boolean {
  const phase = explicitImDeliveryPhase(error);
  if (phase) return phase === 'pre_accept' || phase === 'rejected';
  return Boolean(
    error instanceof CardKitRejectedError ||
    definitiveFeishuPreAcceptanceFailure(error) ||
    definitiveFeishuHttpRejection(error) ||
    standaloneFeishuProviderErrorCode(error) !== undefined,
  );
}

function requireFeishuCardMessageId(
  response: unknown,
  operation: string,
): string {
  const code = feishuErrorCode(response);
  if (code !== undefined && code !== 0) {
    throw new CardKitRejectedError(
      operation,
      code,
      String((response as { msg?: unknown })?.msg ?? ''),
    );
  }
  const messageId = (response as { data?: { message_id?: unknown } })?.data
    ?.message_id;
  if (typeof messageId !== 'string' || !messageId.trim()) {
    throw new Error(`${operation} returned no provider message_id`);
  }
  return messageId.trim();
}

function visibleFeishuCardProgressError(error: unknown): Error {
  if (
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'CHANNEL_DELIVERY_PARTIAL'
  ) {
    return error as Error;
  }
  return new PartialChannelDeliveryError(1, 2, error);
}

function assertCardKitAcknowledged(response: unknown, operation: string): void {
  const envelope = response as { code?: unknown; msg?: unknown } | undefined;
  if (envelope?.code === undefined || envelope.code === null) {
    throw new ImDeliveryPhaseError(
      'uncertain',
      `${operation} returned no explicit provider acknowledgement`,
      { cause: response },
    );
  }
  const code = Number(envelope.code);
  if (!Number.isFinite(code)) {
    throw new ImDeliveryPhaseError(
      'uncertain',
      `${operation} returned an invalid provider acknowledgement`,
      { cause: response },
    );
  }
  if (code !== 0) {
    throw new CardKitRejectedError(operation, code, String(envelope.msg ?? ''));
  }
}

function cardMutationUuid(
  cardId: string,
  sequence: number,
  operation: string,
  payloadHash: string,
): string {
  return `hc_${quickHash(`${cardId}:${sequence}:${operation}:${payloadHash}`)}`;
}

function collectElementContentHashes(
  value: unknown,
  hashes: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectElementContentHashes(item, hashes);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.element_id === 'string' &&
    typeof record.content === 'string'
  ) {
    hashes.set(record.element_id, quickHash(record.content));
  }
  for (const child of Object.values(record)) {
    collectElementContentHashes(child, hashes);
  }
}

/** Per-card request pacing, including diagnostic fallback and interaction-lock retries. */
class CardMutationGate {
  private lastStartedAt = 0;

  async request<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const delay = Math.max(0, 120 - (Date.now() - this.lastStartedAt));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastStartedAt = Date.now();
      try {
        const response = await send();
        assertCardKitAcknowledged(response, 'CardKit mutation');
        return response;
      } catch (error) {
        const code = feishuErrorCode(error);
        // These are explicit non-acceptance responses. Do not retry ambiguous
        // network errors or schema/auth failures with a fresh sequence.
        if (
          attempt >= 3 ||
          ![200810, 99991400, 99991401].includes(code ?? -1)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
}

class CardKitBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private lastContentHash = '';
  private readonly client: lark.Client;
  /**
   * Serializes update requests for this card. Flush controllers can overlap
   * (a slow request still in flight when the next flush fires); without
   * serialization the later sequence can land first and Feishu rejects the
   * stale one, inflating patch failure counts with phantom errors.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    client: lark.Client,
    readonly mutations = new CardMutationGate(),
  ) {
    this.client = client;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  getCardId(): string | null {
    return this.cardId;
  }

  getSequence(): number {
    return this.acknowledgedSequence;
  }

  /**
   * Create a CardKit card instance.
   * Returns the card_id for subsequent updates.
   */
  async createCard(cardJson: object): Promise<string> {
    let cardId: string;
    try {
      const resp = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardJson),
        },
      });

      const rawCardId = resp?.data?.card_id;
      if (!rawCardId) {
        const code = (resp as any)?.code;
        const msg = (resp as any)?.msg;
        if (typeof code === 'number' && code !== 0) {
          throw new CardKitRejectedError('CardKit card.create', code, msg);
        }
        throw new Error(
          `CardKit card.create returned no card_id (code=${code}, msg=${msg})`,
        );
      }
      cardId = rawCardId;
    } catch (error) {
      throw feishuCardResourceError('CardKit card.create', error);
    }

    this.cardId = cardId;
    this.sequence = 1;
    this.acknowledgedSequence = 1;
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
    replyInThread = false,
  ): Promise<string> {
    if (!this.cardId) {
      throw new Error('Cannot sendCard before createCard');
    }

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });

    let messageId: string;
    try {
      const resp = replyToMsgId
        ? await replyInteractiveCard(
            this.client,
            replyToMsgId,
            content,
            replyInThread,
          )
        : await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content,
            },
          });
      messageId = requireFeishuCardMessageId(resp, 'CardKit sendCard');
    } catch (error) {
      throw feishuVisibleCardMutationError('CardKit sendCard', error);
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
    return this.enqueue(async () => {
      const hash = quickHash(dataStr);
      if (hash === this.lastContentHash) return; // no change

      const sequence = ++this.sequence;
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.card.update({
          path: { card_id: this.cardId! },
          data: {
            card: { type: 'card_json', data: dataStr },
            sequence,
            uuid: cardMutationUuid(this.cardId!, sequence, 'card.update', hash),
          },
        }),
      );
      assertCardKitAcknowledged(response, 'card.update');
      this.acknowledgedSequence = sequence;

      this.lastContentHash = hash;
    });
  }

  /**
   * Adopt an existing card_id + messageId (for degradation from streaming mode).
   */
  adoptCard(cardId: string, messageId: string, sequence: number): void {
    this.cardId = cardId;
    this._messageId = messageId;
    this.sequence = sequence;
    this.acknowledgedSequence = sequence;
  }
}

// ─── Streaming Mode Backend ───────────────────────────────────

const DETAIL_CONTENT_IDS: Set<string> = new Set([
  CARD_ELEMENT_IDS.PROGRESS_CONTENT,
  CARD_ELEMENT_IDS.TASK_CONTENT,
  CARD_ELEMENT_IDS.TOOLS_CONTENT,
  CARD_ELEMENT_IDS.THINKING_CONTENT,
  CARD_ELEMENT_IDS.TIMELINE_CONTENT,
]);

class StreamingModeBackend {
  private cardId: string | null = null;
  private _messageId: string | null = null;
  private sequence = 0;
  /** Highest provider-acknowledged sequence exposed to durable lifecycle. */
  private acknowledgedSequence = 0;
  private lastAuxBeforeHash = '';
  private lastAuxAfterHash = '';
  private readonly richSlotHashes = new Map<string, string>();
  private readonly client: lark.Client;
  /**
   * Serializes all CardKit calls for this card. The text flush (300-600ms) and
   * aux flush (800-1500ms) controllers fire independently; without a single
   * in-flight chain their requests can reach Feishu out of sequence order and
   * the stale sequence gets rejected — phantom failures that push
   * patchFailCount toward degradation even though nothing is wrong.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    client: lark.Client,
    readonly mutations = new CardMutationGate(),
  ) {
    this.client = client;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  getCardId(): string | null {
    return this.cardId;
  }

  getSequence(): number {
    return this.acknowledgedSequence;
  }

  private nextSequence(): number {
    return ++this.sequence;
  }

  private mutationIdentity(
    operation: string,
    payloadHash: string,
  ): { sequence: number; uuid: string } {
    const sequence = this.nextSequence();
    return {
      sequence,
      uuid: cardMutationUuid(this.cardId!, sequence, operation, payloadHash),
    };
  }

  /**
   * Create a CardKit card instance with streaming_mode enabled.
   */
  async createCard(cardJson: object): Promise<string> {
    let cardId: string;
    try {
      const resp = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardJson),
        },
      });

      const rawCardId = resp?.data?.card_id;
      if (!rawCardId) {
        const code = (resp as any)?.code;
        const msg = (resp as any)?.msg;
        if (typeof code === 'number' && code !== 0) {
          throw new CardKitRejectedError('Streaming card.create', code, msg);
        }
        throw new Error(
          `Streaming card.create returned no card_id (code=${code}, msg=${msg})`,
        );
      }
      cardId = rawCardId;
    } catch (error) {
      throw feishuCardResourceError('Streaming card.create', error);
    }

    this.cardId = cardId;
    this.sequence = 1;
    this.acknowledgedSequence = 1;
    collectElementContentHashes(cardJson, this.richSlotHashes);
    this.lastAuxBeforeHash =
      this.richSlotHashes.get(ELEMENT_IDS.AUX_BEFORE) ?? '';
    this.lastAuxAfterHash =
      this.richSlotHashes.get(ELEMENT_IDS.AUX_AFTER) ?? '';
    logger.debug({ cardId }, 'Streaming mode card created');
    return cardId;
  }

  /**
   * Send the card as a message. Returns message_id.
   */
  async sendCard(
    chatId: string,
    replyToMsgId?: string,
    replyInThread = false,
  ): Promise<string> {
    if (!this.cardId) throw new Error('Cannot sendCard before createCard');

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });

    let messageId: string;
    try {
      const resp = replyToMsgId
        ? await replyInteractiveCard(
            this.client,
            replyToMsgId,
            content,
            replyInThread,
          )
        : await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content },
          });
      messageId = requireFeishuCardMessageId(resp, 'Streaming mode sendCard');
    } catch (error) {
      throw feishuVisibleCardMutationError('Streaming mode sendCard', error);
    }

    this._messageId = messageId;
    return messageId;
  }

  /**
   * Stream text content via cardElement.content() — platform renders typewriter effect.
   * MD5 dedup to avoid redundant pushes.
   * Auto-retries once on streaming timeout/closed errors.
   */
  async streamBody(text: string): Promise<void> {
    const elements = buildStreamingContentElements(text);
    await this.enqueue(async () => {
      const ids = elements.map((element) => String(element.element_id));
      const existing = [...this.richSlotHashes.keys()].filter(
        (id) =>
          id === ELEMENT_IDS.MAIN_CONTENT || /^main_content_\d+$/.test(id),
      );
      const missing = elements.filter(
        (element) => !this.richSlotHashes.has(String(element.element_id)),
      );
      const removed = existing.filter((id) => !ids.includes(id));
      const actions: object[] = [];
      if (missing.length)
        actions.push({
          action: 'add_elements',
          params: {
            type: 'insert_after',
            target_element_id: existing.at(-1) ?? ELEMENT_IDS.MAIN_CONTENT,
            elements: missing.map((element) => ({ ...element, content: '' })),
          },
        });
      if (removed.length)
        actions.push({
          action: 'delete_elements',
          params: { element_ids: removed },
        });
      if (!actions.length) return;
      const data = JSON.stringify(actions);
      const mutation = this.mutationIdentity(
        'card.batchUpdate:body-slots',
        quickHash(data),
      );
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.card.batchUpdate({
          path: { card_id: this.cardId! },
          data: { actions: data, ...mutation },
        }),
      );
      assertCardKitAcknowledged(response, 'card.batchUpdate:body-slots');
      this.acknowledgedSequence = mutation.sequence;
      for (const element of missing)
        this.richSlotHashes.set(String(element.element_id), quickHash(''));
      for (const id of removed) this.richSlotHashes.delete(id);
    });
    for (const element of elements)
      await this.streamContent(
        String(element.content),
        String(element.element_id),
      );
  }

  async streamContent(
    text: string,
    elementId: string = ELEMENT_IDS.MAIN_CONTENT,
  ): Promise<void> {
    if (!this.cardId) return;

    // The controller budgets the complete page against measured CardKit limits.
    // Never truncate an accepted canonical page inside the transport.
    const content = text;

    return this.enqueue(async () => {
      const hash = quickHash(content);
      if (hash === this.richSlotHashes.get(elementId)) return;
      const mutation = this.mutationIdentity(
        `cardElement.content:${elementId}`,
        hash,
      );

      try {
        const response = await this.mutations.request(() =>
          this.client.cardkit.v1.cardElement.content({
            path: {
              card_id: this.cardId!,
              element_id: elementId,
            },
            data: { content, ...mutation },
          }),
        );
        assertCardKitAcknowledged(response, 'cardElement.content');
        this.acknowledgedSequence = mutation.sequence;
        this.richSlotHashes.set(elementId, hash);
      } catch (err: any) {
        const code = err?.code ?? err?.response?.data?.code;
        // 200850 = streaming timeout, 300309 = streaming closed
        if (code === 200850 || code === 300309) {
          logger.info(
            { code, cardId: this.cardId },
            'Streaming mode expired, re-enabling',
          );
          // Raw call (not the public wrapper) — we're already inside the chain;
          // enqueueing here would deadlock on ourselves.
          await this.enableStreamingModeRaw();
          // Re-enabling consumed a newer sequence, so the replacement content
          // must use a sequence after that settings mutation. Error 200850 /
          // 300309 is an explicit "streaming closed" rejection, not an
          // ambiguous transport timeout; the first content mutation was not
          // accepted.
          const retryMutation = this.mutationIdentity(
            `cardElement.content:${elementId}:reenabled`,
            hash,
          );
          const response = await this.mutations.request(() =>
            this.client.cardkit.v1.cardElement.content({
              path: {
                card_id: this.cardId!,
                element_id: elementId,
              },
              data: { content, ...retryMutation },
            }),
          );
          assertCardKitAcknowledged(response, 'cardElement.content retry');
          this.acknowledgedSequence = retryMutation.sequence;
          this.richSlotHashes.set(elementId, hash);
        } else {
          throw err;
        }
      }
    });
  }

  /**
   * Update an auxiliary element via cardElement.update() — instant replacement.
   */
  async updateAuxiliary(
    elementId: typeof ELEMENT_IDS.AUX_BEFORE | typeof ELEMENT_IDS.AUX_AFTER,
    content: string,
  ): Promise<void> {
    if (!this.cardId) return;

    return this.enqueue(async () => {
      const hash = quickHash(content);
      const hashField =
        elementId === ELEMENT_IDS.AUX_BEFORE
          ? 'lastAuxBeforeHash'
          : 'lastAuxAfterHash';
      if (hash === this[hashField]) return;

      const element = JSON.stringify({
        tag: 'markdown',
        content,
        element_id: elementId,
        text_size: 'notation',
      });

      const mutation = this.mutationIdentity(
        `cardElement.update:${elementId}`,
        hash,
      );
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.cardElement.update({
          path: { card_id: this.cardId!, element_id: elementId },
          data: { element, ...mutation },
        }),
      );
      assertCardKitAcknowledged(response, 'cardElement.update');
      this.acknowledgedSequence = mutation.sequence;
      this[hashField] = hash;
    });
  }

  /**
   * Patch a single markdown element's text content (cardElement.content()).
   * Works for any markdown element in the card tree, including ones nested
   * inside collapsible_panel.
   */
  async updateMarkdownContent(
    elementId: string,
    content: string,
  ): Promise<void> {
    if (!this.cardId) return;
    return this.enqueue(async () => {
      const hash = quickHash(content);
      if (this.richSlotHashes.get(elementId) === hash) return;
      const mutation = this.mutationIdentity(
        `cardElement.content:${elementId}`,
        hash,
      );
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId!, element_id: elementId },
          data: { content, ...mutation },
        }),
      );
      assertCardKitAcknowledged(response, 'cardElement.content');
      this.acknowledgedSequence = mutation.sequence;
      this.richSlotHashes.set(elementId, hash);
    });
  }

  /**
   * Update a set of rich markdown slots on the shared per-card queue. Each
   * slot is acknowledged independently so one malformed optional panel cannot
   * suppress later critical status/footer updates.
   */
  async updateMarkdownContents(
    patches: ReadonlyArray<{ elementId: string; content: string }>,
    details?: object | null,
  ): Promise<{ updated: string[]; failed: string[] }> {
    if (!this.cardId) return { updated: [], failed: [] };
    return this.enqueue(async () => {
      const hadDetails = this.richSlotHashes.has(
        CARD_ELEMENT_IDS.PROGRESS_CONTENT,
      );
      const inserting =
        details !== undefined && details !== null && !hadDetails;
      const removing = details === null && hadDetails;
      const structural: Array<Record<string, unknown>> = inserting
        ? [
            {
              action: 'add_elements',
              params: {
                type: 'insert_before',
                target_element_id: CARD_ELEMENT_IDS.INTERRUPT_BTN,
                elements: [details],
              },
            },
          ]
        : removing
          ? [
              {
                action: 'delete_elements',
                params: { element_ids: [CARD_ELEMENT_IDS.DETAILS_PANEL] },
              },
            ]
          : [];
      const changed = patches
        .map((patch) => ({
          ...patch,
          content:
            details !== undefined && DETAIL_CONTENT_IDS.has(patch.elementId)
              ? formatRuntimeDetail(patch.elementId, patch.content)
              : patch.content,
        }))
        .filter(
          (patch) =>
            details === undefined ||
            !DETAIL_CONTENT_IDS.has(patch.elementId) ||
            (!inserting && !removing && hadDetails),
        )
        .map((patch) => ({ ...patch, hash: quickHash(patch.content) }))
        .filter(
          (patch) => this.richSlotHashes.get(patch.elementId) !== patch.hash,
        );
      if (changed.length === 0 && structural.length === 0)
        return { updated: [], failed: [] };

      // Normal path: one CardKit mutation for every auxiliary slot. This
      // prevents a single semantic event from becoming an 8-request QPS burst.
      const actions = JSON.stringify([
        ...structural,
        ...changed.map((patch) => ({
          action: 'partial_update_element',
          params: {
            element_id: patch.elementId,
            partial_element: { content: patch.content },
          },
        })),
      ]);
      const mutation = this.mutationIdentity(
        'card.batchUpdate:rich-slots',
        quickHash(actions),
      );
      const runBatch = async (): Promise<void> => {
        const response = await this.mutations.request(() =>
          this.client.cardkit.v1.card.batchUpdate({
            path: { card_id: this.cardId! },
            data: { actions, ...mutation },
          }),
        );
        assertCardKitAcknowledged(response, 'card.batchUpdate');
      };

      let batchFailure: unknown;
      try {
        await runBatch();
      } catch (firstError) {
        if (firstError instanceof CardKitRejectedError) {
          // A non-zero response code is a deterministic provider rejection.
          // Sending the identical batch again only burns QPS.
          batchFailure = firstError;
        } else {
          try {
            // Same logical request, same sequence and UUID: safe when the first
            // call reached CardKit but its acknowledgement was lost.
            await runBatch();
          } catch (retryError) {
            batchFailure = retryError;
          }
        }
      }

      if (batchFailure !== undefined) {
        // A structural batch must not fall back to content requests against
        // slots that have not been created (or may have been removed).
        if (structural.length > 0 || !canSwitchFeishuCardBackend(batchFailure))
          throw batchFailure;
        logger.debug(
          {
            err: batchFailure,
            cardId: this.cardId,
            slots: changed.map((patch) => patch.elementId),
          },
          'CardKit rich-slot batch failed; isolating slots',
        );
        // Diagnostic fallback: update slots independently. One invalid
        // optional panel then cannot block status/footer visibility.
        const updated: string[] = [];
        const failed: string[] = [];
        for (const patch of changed) {
          const slotMutation = this.mutationIdentity(
            `cardElement.content:${patch.elementId}:batch-fallback`,
            patch.hash,
          );
          try {
            const response = await this.mutations.request(() =>
              this.client.cardkit.v1.cardElement.content({
                path: {
                  card_id: this.cardId!,
                  element_id: patch.elementId,
                },
                data: { content: patch.content, ...slotMutation },
              }),
            );
            assertCardKitAcknowledged(response, 'cardElement.content');
            this.acknowledgedSequence = slotMutation.sequence;
            this.richSlotHashes.set(patch.elementId, patch.hash);
            updated.push(patch.elementId);
          } catch (error) {
            if (!canSwitchFeishuCardBackend(error)) throw error;
            failed.push(patch.elementId);
            logger.debug(
              {
                err: error,
                cardId: this.cardId,
                elementId: patch.elementId,
              },
              'CardKit rich slot update failed; continuing remaining slots',
            );
          }
        }
        return { updated, failed };
      }

      this.acknowledgedSequence = mutation.sequence;
      if (inserting) collectElementContentHashes(details, this.richSlotHashes);
      if (removing) {
        for (const id of DETAIL_CONTENT_IDS) this.richSlotHashes.delete(id);
      }
      for (const patch of changed) {
        this.richSlotHashes.set(patch.elementId, patch.hash);
      }
      return {
        updated: [
          ...changed.map((patch) => patch.elementId),
          ...(structural.length ? [CARD_ELEMENT_IDS.DETAILS_PANEL] : []),
        ],
        failed: [],
      };
    });
  }

  /**
   * Replace a whole element (structure + content) via cardElement.update().
   * Used to toggle collapsible_panel expanded state mid-stream.
   */
  async replaceElement(elementId: string, elementJson: object): Promise<void> {
    if (!this.cardId) return;
    return this.enqueue(async () => {
      const element = JSON.stringify(elementJson);
      const mutation = this.mutationIdentity(
        `cardElement.update:${elementId}`,
        quickHash(element),
      );
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.cardElement.update({
          path: { card_id: this.cardId!, element_id: elementId },
          data: {
            element,
            ...mutation,
          },
        }),
      );
      assertCardKitAcknowledged(response, 'cardElement.update');
      this.acknowledgedSequence = mutation.sequence;
    });
  }

  /** Enable streaming mode via card.settings() — chain-internal raw call. */
  private async enableStreamingModeRaw(): Promise<void> {
    if (!this.cardId) return;
    const settings = JSON.stringify({
      config: {
        streaming_mode: true,
        streaming_config: STREAMING_CONFIG,
      },
    });
    const mutation = this.mutationIdentity(
      'card.settings:enable',
      quickHash(settings),
    );
    const response = await this.mutations.request(() =>
      this.client.cardkit.v1.card.settings({
        path: { card_id: this.cardId! },
        data: {
          settings,
          ...mutation,
        },
      }),
    );
    assertCardKitAcknowledged(response, 'card.settings enable');
    this.acknowledgedSequence = mutation.sequence;
  }

  /**
   * Enable streaming mode via card.settings().
   */
  async enableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    return this.enqueue(() => this.enableStreamingModeRaw());
  }

  /**
   * Disable streaming mode via card.settings().
   */
  async disableStreamingMode(): Promise<void> {
    if (!this.cardId) return;
    return this.enqueue(async () => {
      const settings = JSON.stringify({
        config: { streaming_mode: false },
      });
      const mutation = this.mutationIdentity(
        'card.settings:disable',
        quickHash(settings),
      );
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.card.settings({
          path: { card_id: this.cardId! },
          data: {
            settings,
            ...mutation,
          },
        }),
      );
      assertCardKitAcknowledged(response, 'card.settings disable');
      this.acknowledgedSequence = mutation.sequence;
    });
  }

  /**
   * Full card update (used for final state after disabling streaming).
   */
  async updateCardFull(cardJson: object): Promise<void> {
    if (!this.cardId) return;
    return this.enqueue(async () => {
      const data = JSON.stringify(cardJson);
      const mutation = this.mutationIdentity('card.update', quickHash(data));
      const response = await this.mutations.request(() =>
        this.client.cardkit.v1.card.update({
          path: { card_id: this.cardId! },
          data: {
            card: { type: 'card_json', data },
            ...mutation,
          },
        }),
      );
      assertCardKitAcknowledged(response, 'card.update');
      this.acknowledgedSequence = mutation.sequence;
      this.richSlotHashes.clear();
      collectElementContentHashes(cardJson, this.richSlotHashes);
      this.lastAuxBeforeHash =
        this.richSlotHashes.get(ELEMENT_IDS.AUX_BEFORE) ?? '';
      this.lastAuxAfterHash =
        this.richSlotHashes.get(ELEMENT_IDS.AUX_AFTER) ?? '';
    });
  }

  async drain(): Promise<void> {
    await this.chain;
  }
}

// ─── Multi-Card Manager ───────────────────────────────────────

class MultiCardManager {
  private cards: CardKitBackend[] = [];
  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly replyInThread: boolean;
  private readonly onCardCreated?: (messageId: string) => void;
  private cardIndex = 0;
  private readonly MAX_ELEMENTS = 45; // safety margin (Feishu limit ~50)
  /**
   * Chars of the full accumulated text already frozen into previous cards.
   * commitContent() always receives the FULL text (the controller re-renders
   * the whole state on every flush); after a split, only the unfrozen tail
   * belongs to the current card. Without this offset every post-split flush
   * would re-exceed the size limit and split again — one duplicate card per
   * flush, i.e. a message flood.
   */
  private frozenPrefixChars = 0;
  /** Fence reopener when a freeze boundary fell inside a ``` code block. */
  private continuationPrefix = '';
  /**
   * Serializes commitContent calls. rollover() is a multi-await
   * read-modify-write of frozenPrefixChars; two overlapping flushes (a slow
   * one still in flight when the next fires) would double-freeze the same
   * slice — losing ~16KB of text, duplicating (续) cards, and stranding a
   * zombie「生成中」card. One in-flight chain makes the whole commit atomic.
   */
  private commitChain: Promise<unknown> = Promise.resolve();

  constructor(
    client: lark.Client,
    chatId: string,
    replyToMsgId?: string,
    replyInThread = false,
    onCardCreated?: (messageId: string) => void,
  ) {
    this.client = client;
    this.chatId = chatId;
    this.replyToMsgId = replyToMsgId;
    this.replyInThread = replyInThread;
    this.onCardCreated = onCardCreated;
  }

  getCardCount(): number {
    return this.cards.length;
  }

  /** The unfrozen tail represented by this manager's current card. */
  getVisibleText(fullText: string): string {
    return this.activeView(fullText);
  }

  /** The slice of the full text still owned by the current (last) card. */
  private activeView(fullText: string): string {
    return this.frozenPrefixChars > 0
      ? this.continuationPrefix + fullText.slice(this.frozenPrefixChars)
      : fullText;
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
      this.replyInThread,
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
    // Serialize: rollover's frozenPrefixChars RMW must not interleave with
    // another flush or a terminal patchCard.
    const run = this.commitChain.then(() =>
      this.commitContentInner(text, state, auxiliaryState, footerNote),
    );
    this.commitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async commitContentInner(
    text: string,
    state: 'streaming' | 'completed' | 'aborted',
    auxiliaryState?: AuxiliaryState,
    footerNote?: string,
  ): Promise<void> {
    // Roll over whenever the current card would exceed limits — for streaming
    // AND terminal states. A long reply's final append can push past the byte
    // budget and then immediately complete()/abort(); without terminal-state
    // rollover that produces one oversized card the Feishu API rejects (the
    // CJK >30KB zombie-card case). rollover() freezes prior cards and leaves
    // the unfrozen tail for the current card; the terminal render below then
    // applies `state` only to that bounded tail.
    if (this.needsRollover(text, auxiliaryState, footerNote)) {
      await this.rollover(text);
    }

    const currentCard = this.cards[this.cards.length - 1];
    if (!currentCard) return;

    const titlePrefix = this.cardIndex > 0 ? '(续) ' : '';
    // Continuation cards keep the title extracted from the FULL text so all
    // cards of one reply share a consistent header.
    const overrideTitle =
      this.cardIndex > 0 ? extractTitleAndBody(text).title : undefined;

    // After rollover the tail may STILL exceed one card (rollover caps at 8
    // freezes, and the final unfrozen slice can be a full budget). For terminal
    // states render the tail across as many cards as needed so nothing is
    // dropped and no single card overflows.
    const activeText = this.activeView(text);
    if (state !== 'streaming' && byteLen(activeText) > FREEZE_SLICE_BYTES) {
      await this.renderTerminalTail(
        activeText,
        state,
        titlePrefix,
        overrideTitle,
        footerNote,
      );
      return;
    }

    const cardJson = buildSchema2Card(
      activeText,
      state,
      titlePrefix,
      overrideTitle,
      auxiliaryState,
      footerNote,
    );
    await currentCard.updateCard(cardJson);
  }

  /**
   * Render an over-budget terminal tail across multiple cards: the current card
   * + fresh continuation cards, each within FREEZE_SLICE_BYTES, only the last
   * carrying the real terminal `state`.
   */
  private async renderTerminalTail(
    tail: string,
    state: 'completed' | 'aborted',
    firstTitlePrefix: string,
    overrideTitle: string | undefined,
    footerNote?: string,
  ): Promise<void> {
    const chunks = splitCodeBlockSafe(tail, CARD_MD_LIMIT);
    const groups: string[][] = [];
    let cur: string[] = [];
    let curBytes = 0;
    for (const chunk of chunks) {
      const cb = byteLen(chunk);
      if (cur.length > 0 && curBytes + cb > FREEZE_SLICE_BYTES) {
        groups.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(chunk);
      curBytes += cb;
    }
    if (cur.length > 0) groups.push(cur);

    for (let i = 0; i < groups.length; i++) {
      const isLast = i === groups.length - 1;
      const groupText = groups[i].join('\n\n');
      const groupState = isLast ? state : ('frozen' as const);
      const prefix = i === 0 ? firstTitlePrefix : '(续) ';
      const titleOverride =
        i === 0 ? overrideTitle : extractTitleAndBody(tail).title;
      if (i === 0) {
        const currentCard = this.cards[this.cards.length - 1];
        if (!currentCard) return;
        await currentCard.updateCard(
          buildSchema2Card(
            groupText,
            groupState,
            prefix,
            titleOverride,
            undefined,
            isLast ? footerNote : undefined,
          ),
        );
      } else {
        const contCard = new CardKitBackend(this.client);
        await contCard.createCard(
          buildSchema2Card(
            groupText,
            groupState,
            prefix,
            titleOverride,
            undefined,
            isLast ? footerNote : undefined,
          ),
        );
        const newMsgId = await contCard.sendCard(
          this.chatId,
          this.replyToMsgId,
          this.replyInThread,
        );
        this.cards.push(contCard);
        this.onCardCreated?.(newMsgId);
      }
    }
  }

  /** Whether the current card would exceed element-count or byte limits. */
  private needsRollover(
    fullText: string,
    auxiliaryState?: AuxiliaryState,
    footerNote?: string,
  ): boolean {
    const activeText = this.activeView(fullText);
    const { contentElements } = buildCardContent(
      activeText,
      splitCodeBlockSafe,
    );
    const auxCount = auxiliaryState
      ? (() => {
          const { before, after } = buildAuxiliaryElements(auxiliaryState);
          return before.length + after.length;
        })()
      : 0;
    // button + note + optional footer
    const fixedCount = 2 + (footerNote ? 1 : 0);
    if (contentElements.length + auxCount + fixedCount > this.MAX_ELEMENTS) {
      return true;
    }
    const cardJson = buildSchema2Card(
      activeText,
      'streaming',
      this.cardIndex > 0 ? '(续) ' : '',
      undefined,
      auxiliaryState,
      footerNote,
    );
    return (
      Buffer.byteLength(JSON.stringify(cardJson), 'utf-8') > CARD_SIZE_LIMIT
    );
  }

  /**
   * Pick a freeze boundary near FREEZE_SLICE_BYTES (UTF-8) on a paragraph/line
   * break. Byte-based so CJK content (3 bytes/char) doesn't overshoot the card
   * size limit — a char-based budget would freeze ~3x too much per card.
   */
  private pickSliceEnd(active: string): number {
    if (byteLen(active) <= FREEZE_SLICE_BYTES) return active.length;
    // Binary-search the char index whose UTF-8 prefix fits the byte budget.
    let lo = 0;
    let hi = active.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (byteLen(active.slice(0, mid)) <= FREEZE_SLICE_BYTES) lo = mid;
      else hi = mid - 1;
    }
    const budgetEnd = lo; // largest char count fitting the byte budget
    // Prefer a paragraph/line break at or before budgetEnd for clean splits.
    let idx = active.lastIndexOf('\n\n', budgetEnd);
    if (idx < budgetEnd * 0.3) idx = active.lastIndexOf('\n', budgetEnd);
    if (idx < budgetEnd * 0.3) idx = budgetEnd;
    return idx;
  }

  /** Whether the active (unfrozen) view still exceeds one card's byte budget. */
  private activeExceedsBudget(fullText: string): boolean {
    return byteLen(this.activeView(fullText)) > FREEZE_SLICE_BYTES;
  }

  /**
   * Freeze the current card's pending text and open a fresh card for the
   * remainder. Advances frozenPrefixChars so subsequent commits only render
   * the unfrozen tail — each split happens exactly once per ~18K chars of NEW
   * text, never repeatedly for the same content.
   */
  private async rollover(fullText: string): Promise<void> {
    const { title } = extractTitleAndBody(fullText);
    // A degradation handover can dump a large backlog in one commit; freeze it
    // across multiple cards. Guard caps pathological loops.
    let guard = 0;
    do {
      const active = this.activeView(fullText);
      const sliceEnd = this.pickSliceEnd(active);
      let frozenText = active.slice(0, sliceEnd);

      // Freeze boundary inside a fenced code block → close the fence here and
      // reopen it on the next card.
      let reopener = '';
      const ranges = findCodeBlockRanges(frozenText);
      const last = ranges[ranges.length - 1];
      if (
        last &&
        last.close === frozenText.length &&
        !/```\s*$/.test(frozenText)
      ) {
        frozenText += '\n```';
        reopener = '```' + last.lang + '\n';
      }

      // Open the fresh card FIRST. If createCard/sendCard throws, nothing has
      // been mutated yet — the next flush simply retries the rollover. The old
      // order (advance offsets → create card) lost the frozen slice when card
      // creation failed: the offset had moved, so subsequent flushes rendered
      // only the tail into the OLD card, overwriting the frozen content.
      const newCard = new CardKitBackend(this.client);
      const newCardJson = buildSchema2Card('...', 'streaming', '(续) ', title);
      await newCard.createCard(newCardJson);
      const newMessageId = await newCard.sendCard(
        this.chatId,
        this.replyToMsgId,
        this.replyInThread,
      );

      // Freeze the old card (best-effort — on failure it keeps its last
      // streamed view; the content is still readable).
      // Card 0 keeps the strip-first-line-as-title behavior (#488); continuation
      // cards get the override title so their first line stays in the body.
      const frozenCard = buildSchema2Card(
        frozenText,
        'frozen',
        this.cardIndex > 0 ? '(续) ' : '',
        this.cardIndex > 0 ? title : undefined,
      );
      const currentCard = this.cards[this.cards.length - 1];
      if (currentCard) {
        try {
          await currentCard.updateCard(frozenCard);
        } catch (err) {
          logger.debug(
            { err, chatId: this.chatId },
            'MultiCard freeze update failed (non-fatal, continuing rollover)',
          );
        }
      }

      // Commit: advance the frozen offset by the chars consumed from the full
      // text (sliceEnd is measured on `active`, which starts with the reopener
      // prefix from the previous split), then adopt the new card.
      this.frozenPrefixChars += Math.max(
        0,
        sliceEnd - this.continuationPrefix.length,
      );
      this.continuationPrefix = reopener;
      this.cardIndex++;
      this.cards.push(newCard);
      // Register the new card's messageId for interrupt button routing
      this.onCardCreated?.(newMessageId);
    } while (this.activeExceedsBudget(fullText) && ++guard < 8);
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

  getLatestCardId(): string | null {
    return this.cards[this.cards.length - 1]?.getCardId() ?? null;
  }

  getLatestVersion(): number {
    return this.cards[this.cards.length - 1]?.getSequence() ?? 0;
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
  private readonly replyInThread: boolean;
  private readonly onFallback?: () => void;
  private readonly onCardCreated?: (messageId: string) => void;
  private readonly lifecycle?: StreamingCardLifecycle;

  // CardKit mode
  private useCardKit = false;
  private multiCard: MultiCardManager | null = null;

  // Streaming mode (Level 0)
  private streamingBackend: StreamingModeBackend | null = null;
  private backendTransition: Promise<void> | null = null;
  private nativeCards: Array<{
    backend: StreamingModeBackend;
    text: string;
    streaming: boolean;
    rawEnd: number;
  }> = [];
  private nativeCanonicalText = '';
  private nativeCapacityScale = 1;
  private nativePageChain: Promise<unknown> = Promise.resolve();
  private nativeFullUpdates = false;
  private textFlushCtrl: FlushController | null = null;
  private auxFlushCtrl: FlushController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Usage that arrived before finalize settled, parked for redelivery. */
  private pendingUsage: FeishuUsageNoteInput | null = null;
  /** True once complete() has finished writing the terminal card(s). */
  private finalizeSettled = false;
  /** Serializes legacy im.v1.message.patch calls — that API has no sequence
   * number, so an in-flight「生成中」patch landing AFTER the terminal patch
   * would permanently revert the card to streaming state. */
  private legacyPatchChain: Promise<unknown> = Promise.resolve();
  /** In-flight createInitialCard() — complete() awaits it so a creation that
   * fails AFTER complete() returned doesn't end as "no card AND no static
   * fallback" (silent reply loss). */
  private creationPromise: Promise<void> | null = null;
  /** Sticky physical-delivery evidence. Once a visible card mutation becomes
   * uncertain, neither complete(), abort(), nor a backend switch may create a
   * second presentation for the same logical reply. */
  private terminalDeliveryError: unknown;

  // Streaming state
  private thinking = false;
  private thinkingText = '';
  private toolCalls = new Map<string, ToolCallState>();
  private toolTotals = new Map<string, number>();
  private countedToolIds = new Set<string>();
  private tasks = new Map<string, TaskRunState>();
  private startTime = 0;
  private backendMode: 'streaming' | 'v1' | 'legacy' = 'v1';

  // Auxiliary display state
  private systemStatus: string | null = null;
  /** 挂起完成状态：本 turn 回复已送达但后台任务/截断续写未结束，卡片保持
   * 打开等待追加。pendingTasks=null 表示截断自动续写中。任何新 turn 活动
   * （append/appendThinking/startTool）自动清除。 */
  private heldOpen: { pendingTasks: number | null } | null = null;
  private activeHook: { hookName: string; hookEvent: string } | null = null;
  private todos: Array<{ id: string; content: string; status: string }> | null =
    null;
  private recentEvents: Array<{ text: string }> = [];
  private traceUrl: string | null = null;
  private stateVersion = 0;

  constructor(opts: StreamingCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.replyInThread = opts.replyInThread === true;
    this.onFallback = opts.onFallback;
    this.onCardCreated = opts.onCardCreated;
    this.lifecycle = opts.lifecycle;
    this.flushCtrl = new FlushController();
  }

  private lifecycleIdentity(): {
    messageId: string | null;
    cardId: string | null;
    version: number;
  } {
    if (this.streamingBackend) {
      return {
        messageId: this.streamingBackend.messageId,
        cardId: this.streamingBackend.getCardId(),
        version: this.streamingBackend.getSequence(),
      };
    }
    if (this.multiCard) {
      return {
        messageId: this.multiCard.getLatestMessageId(),
        cardId: this.multiCard.getLatestCardId(),
        version: this.multiCard.getLatestVersion(),
      };
    }
    return { messageId: this.messageId, cardId: null, version: 0 };
  }

  private emitLifecycle(
    status: StreamingCardLifecycleEvent['status'],
    error?: unknown,
  ): void {
    if (!this.lifecycle) return;
    const identity = this.lifecycleIdentity();
    const visibleText =
      this.backendMode === 'streaming' && this.nativeCards.length > 0
        ? this.nativeCards.find(
            (page) => page.backend === this.streamingBackend,
          )?.text
        : this.backendMode === 'v1' && this.multiCard
          ? this.multiCard.getVisibleText(this.accumulatedText)
          : undefined;
    try {
      this.lifecycle.onEvent({
        status,
        ...identity,
        snapshot: {
          text: this.accumulatedText,
          ...(typeof visibleText === 'string' &&
          visibleText !== this.accumulatedText
            ? { visibleText }
            : {}),
          thinking: this.thinkingText,
          state: this.state,
          backendMode: this.backendMode,
        },
        ...(error !== undefined
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      });
    } catch (lifecycleError) {
      logger.error(
        { err: lifecycleError, chatId: this.chatId, status },
        'Streaming card lifecycle hook failed; stopping provider mutation',
      );
      throw lifecycleError;
    }
  }

  private beginCreation(): void {
    this.state = 'creating';
    this.emitLifecycle('creating');
    this.creationPromise = this.createInitialCard();
    this.creationPromise.catch((err) => {
      this.terminalDeliveryError ??= err;
      logger.warn(
        { err, chatId: this.chatId },
        'Streaming card: initial create failed',
      );
      this.state = 'error';
      this.emitLifecycle('failed', err);
      this.onFallback?.();
    });
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
    return (
      this.state === 'streaming' ||
      this.state === 'creating' ||
      (this.state === 'error' && this.terminalDeliveryError !== undefined)
    );
  }

  /**
   * Get all messageIds across all cards (for multi-card cleanup).
   */
  getAllMessageIds(): string[] {
    if (this.backendMode === 'streaming' && this.nativeCards.length)
      return this.nativeCards
        .map((page) => page.backend.messageId!)
        .filter(Boolean);
    if (this.streamingBackend?.messageId)
      return [this.streamingBackend.messageId];
    if (this.multiCard) return this.multiCard.getAllMessageIds();
    return this.messageId ? [this.messageId] : [];
  }

  getAcknowledgedProviderOutputCount(): number {
    return this.getAllMessageIds().length;
  }

  /**
   * Signal that the agent is in thinking state (before text arrives).
   */
  setThinking(): void {
    this.thinking = true;
    if (this.state === 'idle') {
      // Create card immediately with thinking placeholder.
      this.beginCreation();
    }
  }

  /**
   * Signal that a tool has started executing.
   */
  startTool(toolId: string, toolName: string): void {
    this.heldOpen = null; // 新 turn 活动，退出挂起态
    if (toolName === 'AskUserQuestion') {
      // The model has yielded control to the user. Preserve thinkingText for
      // the terminal audit panel, but do not leave the live state marked as
      // thinking while the card is explicitly waiting for input.
      this.thinking = false;
      this.emitLifecycle('waiting_user');
    }
    if (
      !this.countedToolIds.has(toolId) &&
      toolName !== 'Task' &&
      !toolName.startsWith('Task:')
    ) {
      this.countedToolIds.add(toolId);
      this.toolTotals.set(toolName, (this.toolTotals.get(toolName) ?? 0) + 1);
    }
    this.toolCalls.set(toolId, {
      name: toolName,
      status: 'running',
      startTime: Date.now(),
    });
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Attach extra metadata to an already-started tool call. Called separately
   * from startTool() so the cross-IM StreamingSession union doesn't need to
   * widen its common signature. A no-op if the toolId is unknown.
   */
  setToolMeta(toolId: string, meta: ToolCallMeta): void {
    const tc = this.toolCalls.get(toolId);
    if (!tc) return;
    if (meta.skillName !== undefined) tc.skillName = meta.skillName;
    if (meta.isNested !== undefined) tc.isNested = meta.isNested;
    if (meta.toolInput !== undefined) tc.toolInput = meta.toolInput;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Signal that a tool has finished executing.
   */
  endTool(toolId: string, isError: boolean): void {
    const tc = this.toolCalls.get(toolId);
    if (tc) {
      const wasWaiting =
        tc.name === 'AskUserQuestion' && tc.status === 'running';
      tc.status = isError ? 'error' : 'complete';
      tc.endTime ??= Date.now();
      if (wasWaiting) this.emitLifecycle('running');
      this.stateVersion++;
      this.purgeOldTools();
      if (this.state === 'streaming') {
        this.backendMode === 'streaming'
          ? this.scheduleAuxFlush()
          : this.schedulePatch();
      }
    }
  }

  /**
   * Purge completed/error tools older than MAX_COMPLETED_TOOL_AGE to prevent unbounded growth.
   */
  private purgeOldTools(): void {
    const cutoff = Date.now() - MAX_COMPLETED_TOOL_AGE;
    for (const [id, tc] of this.toolCalls) {
      if (tc.status !== 'running' && (tc.endTime ?? tc.startTime) < cutoff) {
        this.toolCalls.delete(id);
      }
    }
  }

  /**
   * Append thinking text (accumulated, tail-truncated at MAX_THINKING_CHARS).
   */
  appendThinking(text: string): void {
    this.heldOpen = null; // 新 turn 活动，退出挂起态
    this.thinkingText += text;
    if (this.thinkingText.length > MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;
    this.stateVersion++;
    if (this.state === 'idle') {
      this.beginCreation();
    } else if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set or clear system status text (e.g. "上下文压缩中").
   */
  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * 标记卡片进入「挂起完成」态：本 turn 回复已送达，但后台任务（异步 Agent /
   * backgrounded Bash）或截断自动续写仍在进行，卡片不定稿、状态横幅切到
   * 「后台任务运行中 ⏳」。pendingTasks 为后台任务数，null 表示截断续写中。
   * 下一 turn 的任何活动（append/appendThinking/startTool）自动清除该态，
   * 恢复正常的 phase 推导。
   */
  setHeldOpen(pendingTasks: number | null): void {
    this.heldOpen = { pendingTasks };
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set or clear active hook state.
   */
  setHook(hook: { hookName: string; hookEvent: string } | null): void {
    this.activeHook = hook;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  /**
   * Set the todo list for progress panel display.
   */
  setTodos(
    todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    this.todos = todos;
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
    }
  }

  updateTask(
    taskId: string,
    patch: Partial<Omit<TaskRunState, 'id' | 'updatedAt'>>,
  ): void {
    const existing = this.tasks.get(taskId);
    const next: TaskRunState = {
      id: taskId,
      title: patch.title || existing?.title || 'Task',
      status: patch.status || existing?.status || 'running',
      subagentType: patch.subagentType ?? existing?.subagentType,
      lastToolName: patch.lastToolName ?? existing?.lastToolName,
      summary: patch.summary ?? existing?.summary,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, next);
    this.stateVersion++;
    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleAuxFlush()
        : this.schedulePatch();
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
        this.backendMode === 'streaming'
          ? this.scheduleAuxFlush()
          : this.schedulePatch();
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
    if (this.terminalDeliveryError !== undefined) return;
    this.heldOpen = null; // 新 turn 文本到达，退出挂起态
    this.accumulatedText = text;
    this.thinking = false; // Text arrived, no longer just thinking

    if (this.state === 'idle') {
      this.beginCreation();
      return;
    }

    if (this.state === 'streaming') {
      this.backendMode === 'streaming'
        ? this.scheduleTextFlush()
        : this.schedulePatch();
    }
    // If 'creating', the text will be picked up after creation completes
  }

  /**
   * Complete the streaming card with final text.
   */
  async complete(finalText: string): Promise<void> {
    await this.backendTransition;
    if (
      this.terminalDeliveryError !== undefined &&
      (this.state === 'error' || this.state === 'aborted')
    ) {
      throw this.terminalDeliveryError;
    }
    if (this.state !== 'streaming' && this.state !== 'creating') return;

    // Card creation still in flight — wait for it to settle first. Returning
    // "success" while the creation later fails would leave NO card and NO
    // static fallback (the caller marks the IM delivery as handled), silently
    // losing the reply.
    if (this.state === 'creating' && this.creationPromise) {
      await this.creationPromise.catch(() => {});
      if ((this.state as StreamingState) === 'error') {
        throw (
          this.terminalDeliveryError ??
          new Error('streaming card creation failed during complete()')
        );
      }
    }
    if (this.state !== 'streaming' && this.state !== 'creating') return;

    this.accumulatedText = finalText;
    this.emitLifecycle('finalizing');
    this.state = 'completed';
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
    this.stopHeartbeat();

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        await this.finalizeStreamingCard('completed');
      } else if (this.messageId || this.multiCard) {
        await this.patchCard('completed', this.traceFooterLink());
      }
      this.emitLifecycle('completed');
    } catch (err) {
      const deliveryError =
        this.messageId || this.streamingBackend?.messageId || this.multiCard
          ? visibleFeishuCardProgressError(err)
          : err;
      this.terminalDeliveryError ??= deliveryError;
      // A provider-visible card already exists. Keep abort() from issuing a
      // second terminal mutation after an unknown final ACK.
      this.state = 'error';
      this.emitLifecycle('failed', deliveryError);
      throw deliveryError;
    }

    this.finalizeSettled = true;
    if (this.pendingUsage) {
      const parked = this.pendingUsage;
      this.pendingUsage = null;
      await this.patchUsageNote(parked);
    }
  }

  /**
   * Patch a completed card to append a usage note at the bottom.
   * Called AFTER complete() because agent-runner emits usage after the final result.
   */
  async patchUsageNote(usage: FeishuUsageNoteInput): Promise<void> {
    if (this.state === 'aborted' || this.state === 'error') {
      this.pendingUsage = null;
      return;
    }
    if (this.state !== 'completed' || !this.finalizeSettled) {
      this.pendingUsage = usage;
      return;
    }

    try {
      if (this.backendMode === 'streaming' && this.streamingBackend) {
        const note = this.mergeFooterNote(formatFeishuUsageNote(usage));
        if (!note) return;
        // The terminal skeleton reserves this footer. Updating only its
        // content keeps the answer, scroll position and expanded details intact.
        await this.streamingBackend.updateMarkdownContents([
          {
            elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
            content: `<font color='grey'>${note}</font>`,
          },
        ]);
      } else if (this.messageId || this.multiCard) {
        const note = this.mergeFooterNote(formatFeishuUsageNote(usage));
        if (!note) return;
        await this.patchCard('completed', note);
      }
    } catch (err) {
      logger.warn(
        { err, chatId: this.chatId },
        'Streaming card: patchUsageNote failed (non-fatal)',
      );
    }
  }

  /**
   * Abort the streaming card (e.g., user interrupted).
   */
  async abort(reason?: string): Promise<void> {
    await this.backendTransition;
    if (this.terminalDeliveryError !== undefined) {
      this.state = 'aborted';
      this.pendingUsage = null;
      this.flushCtrl.dispose();
      this.textFlushCtrl?.dispose();
      this.auxFlushCtrl?.dispose();
      this.stopHeartbeat();
      this.emitLifecycle('failed', this.terminalDeliveryError);
      throw this.terminalDeliveryError;
    }
    if (this.state === 'completed' || this.state === 'aborted') return;

    const wasActive = this.isActive();
    const creationInFlight =
      this.state === 'creating' ? this.creationPromise : null;
    this.state = 'aborted';
    this.pendingUsage = null;
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
    this.stopHeartbeat();

    if (reason) {
      this.accumulatedText += `\n\n---\n*${reason}*`;
    }

    this.emitLifecycle('finalizing');
    let finalizationError: unknown;

    // If provider creation was in-flight, finishCardCreation observes the
    // aborted state and leaves finalization to this method. Awaiting it closes
    // the crash window where persistence said "aborted" while Feishu still
    // showed a newly-created "生成中" card.
    if (creationInFlight) {
      try {
        await creationInFlight;
      } catch (error) {
        finalizationError = error;
      }
    }

    if (
      finalizationError === undefined &&
      this.backendMode === 'streaming' &&
      this.streamingBackend &&
      wasActive
    ) {
      try {
        await this.finalizeStreamingCard('aborted');
      } catch (err) {
        finalizationError = err;
        logger.debug(
          { err, chatId: this.chatId },
          'Streaming card: abort finalize failed',
        );
      }
    } else if (
      finalizationError === undefined &&
      (this.messageId || this.multiCard) &&
      wasActive
    ) {
      try {
        await this.patchCard('aborted');
      } catch (err) {
        finalizationError = err;
        logger.debug(
          { err, chatId: this.chatId },
          'Streaming card: abort patch failed',
        );
      }
    }
    if (finalizationError !== undefined) {
      const deliveryError =
        this.messageId || this.streamingBackend?.messageId || this.multiCard
          ? visibleFeishuCardProgressError(finalizationError)
          : finalizationError;
      this.terminalDeliveryError ??= deliveryError;
      this.emitLifecycle('failed', this.terminalDeliveryError);
      throw this.terminalDeliveryError;
    }
    this.emitLifecycle('aborted');
  }

  dispose(): void {
    this.flushCtrl.dispose();
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
    this.stopHeartbeat();
  }

  // ─── Internal Methods ──────────────────────────────────

  private async createInitialCard(): Promise<void> {
    // Keep the independent fallback transports on their existing small budget.
    const initialText = splitCardPages(
      this.accumulatedText || STREAMING_PLACEHOLDER,
      { maxBytes: 12000 },
    )[0].text;

    // ── Level 0: Try streaming mode (cardElement.content typewriter) ──
    try {
      const backend = new StreamingModeBackend(this.client);
      let page: CardPage;
      for (;;) {
        page = this.planNativePages(
          this.accumulatedText || STREAMING_PLACEHOLDER,
        )[0];
        try {
          await backend.createCard(buildStreamingModeCard(page.text));
          break;
        } catch (error) {
          if (!this.reduceNativeCapacity(error)) throw error;
        }
      }
      const messageId = await backend.sendCard(
        this.chatId,
        this.replyToMsgId,
        this.replyInThread,
      );

      this.streamingBackend = backend;
      this.nativeCards = [
        {
          backend,
          text: page.text,
          streaming: true,
          rawEnd: this.accumulatedText ? page.rawEnd : 0,
        },
      ];
      this.nativeCanonicalText = this.accumulatedText;
      this.messageId = messageId;
      this.backendMode = 'streaming';
      this.useCardKit = true;
      this.startTime = Date.now();
      // Streaming mode: 600ms text flush, 1500ms aux flush.
      // Keep ordinary traffic below the per-card 10 QPS ceiling; text (1.7/s) + aux
      // (banner/footer/panels, ≤2-3 calls per flush after hash dedup) must
      // stay under that together, or pushes start failing and the controller
      // wrongly degrades. The native typewriter effect keeps 600ms smooth.
      this.textFlushCtrl = new FlushController(600, 30);
      this.auxFlushCtrl = new FlushController(1500, 0);
      this.maxPatchFailures = 3;

      logger.info(
        { chatId: this.chatId, messageId, mode: 'streaming' },
        'Streaming card created via streaming mode',
      );

      this.finishCardCreation();
      return;
    } catch (streamingErr) {
      if (!canSwitchFeishuCardBackend(streamingErr)) throw streamingErr;
      logger.info(
        { err: streamingErr, chatId: this.chatId },
        'Streaming mode was rejected before visibility, falling back to CardKit v1',
      );
      this.streamingBackend = null;
    }

    // ── Level 1: Try CardKit v1 full-update (card.update with full JSON) ──
    try {
      this.multiCard = new MultiCardManager(
        this.client,
        this.chatId,
        this.replyToMsgId,
        this.replyInThread,
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

      logger.info(
        { chatId: this.chatId, messageId, mode: 'cardkit-v1' },
        'Streaming card created via CardKit v1',
      );
    } catch (v1Err) {
      if (!canSwitchFeishuCardBackend(v1Err)) throw v1Err;
      // ── Level 2: Legacy message.create + message.patch ──
      logger.info(
        { err: v1Err, chatId: this.chatId },
        'CardKit full-update was rejected before visibility, falling back to message.patch',
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
      const resp = this.replyToMsgId
        ? await replyInteractiveCard(
            this.client,
            this.replyToMsgId,
            content,
            this.replyInThread,
          )
        : await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: this.chatId,
              msg_type: 'interactive',
              content,
            },
          });

      this.messageId = requireFeishuCardMessageId(
        resp,
        'Legacy streaming card create',
      );

      logger.info(
        { chatId: this.chatId, messageId: this.messageId, mode: 'legacy' },
        'Streaming card created via legacy path',
      );

      this.finishCardCreation();
    } catch (err) {
      this.state = 'error';
      throw feishuVisibleCardMutationError('Legacy streaming card create', err);
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
      // abort() owns and awaits the provider finalization after this creation
      // promise resolves. Starting an untracked patch here would let durable
      // state reach terminal before the provider update is acknowledged.
      return;
    }

    this.state = 'streaming';
    if (this.backendMode === 'streaming') this.startHeartbeat();
    this.emitLifecycle('streaming');
    if (this.messageId) {
      this.onCardCreated?.(this.messageId);
    }

    if (this.backendMode === 'streaming') {
      // Replace the skeleton's neutral preparation state with the current
      // deterministic phase even when the model has emitted no text delta.
      this.scheduleAuxFlush();
    }

    // If text accumulated while creating, schedule a flush/patch
    if (this.accumulatedText.length > 3) {
      this.backendMode === 'streaming'
        ? this.scheduleTextFlush()
        : this.schedulePatch();
    }
  }

  private fenceVisibleCardMutation(error: unknown): Error {
    const deliveryError = visibleFeishuCardProgressError(error);
    this.terminalDeliveryError ??= deliveryError;
    if (this.state === 'streaming' || this.state === 'creating') {
      this.state = 'error';
      this.flushCtrl.dispose();
      this.textFlushCtrl?.dispose();
      this.auxFlushCtrl?.dispose();
      this.stopHeartbeat();
      this.emitLifecycle('failed', this.terminalDeliveryError);
      this.onFallback?.();
    }
    return this.terminalDeliveryError as Error;
  }

  private schedulePatch(): void {
    // Terminal guard: a late/in-flight flush failure after complete()/abort()
    // must never re-render the finalized card back to「生成中」(the patchCard
    // callback below hardcodes 'streaming').
    if (this.state === 'completed' || this.state === 'aborted') return;
    if (this.patchFailCount >= this.maxPatchFailures) {
      logger.info(
        { chatId: this.chatId, useCardKit: this.useCardKit },
        'Streaming card: too many patch failures, fencing visible delivery',
      );
      this.fenceVisibleCardMutation(
        new Error('too many streaming card patch failures'),
      );
      return;
    }

    // Use effectiveLength so FlushController detects non-text state changes
    // (thinking, tool status, system status, etc.)
    const effectiveLength =
      this.accumulatedText.length + this.stateVersion * 1000;
    this.flushCtrl.schedule(effectiveLength, async () => {
      // Execution-time terminal guard: the callback runs after a delay, during
      // which complete()/abort() may have finalized the card. Without this the
      // v1 path (unlike scheduleTextFlush/scheduleAuxFlush) could repaint a
      // finalized card back to「生成中」.
      if (this.state !== 'streaming' && this.state !== 'creating') return;
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
      tasks: this.tasks,
    };
  }

  /**
   * The canonical reducer is allowed to retract provisional narration back to
   * an empty string when the same assistant message turns into a tool call.
   * Provider projections must keep a visible neutral surface during that
   * transition without mutating canonical accumulatedText.
   */
  private liveDisplayText(): string {
    return this.accumulatedText || STREAMING_PLACEHOLDER;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'streaming') return;
      // Elapsed time is bucketed by buildRichPanelPatches(), so this remains a
      // low-frequency liveness signal rather than an update storm.
      this.scheduleAuxFlush();
    }, 5000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  setTraceUrl(url: string | null): void {
    this.traceUrl = url;
  }

  private traceFooterLink(): string | undefined {
    return this.traceUrl ? `[查看完整运行轨迹](${this.traceUrl})` : undefined;
  }

  private mergeFooterNote(note?: string): string | undefined {
    const trace = this.traceFooterLink();
    if (note && trace) return `${note}\n${trace}`;
    return note || trace;
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
      // Terminal guard: the controller may have completed/aborted between
      // scheduling and execution — don't push stale streaming content, and
      // never let a post-finalize failure count toward degradation.
      if (
        this.state !== 'streaming' ||
        !this.streamingBackend ||
        this.backendTransition
      )
        return;
      try {
        const run = this.nativePageChain.then(async () => {
          if (this.terminalDeliveryError !== undefined)
            throw this.terminalDeliveryError;
          if (this.state !== 'streaming' || this.backendTransition) return;
          await this.syncNativePages(this.liveDisplayText());
        });
        this.nativePageChain = run.catch((error) => {
          // A continuation send can lose its ACK while complete()/abort() is
          // waiting for this drain. Record uncertainty before resolving the
          // drain; terminal guards must not erase that visible-send boundary.
          if (!canSwitchFeishuCardBackend(error)) {
            this.terminalDeliveryError ??=
              visibleFeishuCardProgressError(error);
          }
        });
        await run;
        this.textFlushCtrl!.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
        this.emitLifecycle('streaming');
      } catch (err) {
        if (this.state !== 'streaming') return;
        if (!canSwitchFeishuCardBackend(err)) {
          this.fenceVisibleCardMutation(err);
          return;
        }
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'streaming',
          },
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
  /** Explicit platform size rejections are safe to repartition; uncertain
   * visible ACKs must escape unchanged to the existing sticky delivery fence. */
  private reduceNativeCapacity(error: unknown): boolean {
    if (!canSwitchFeishuCardBackend(error)) return false;
    let cause: unknown = error;
    for (let depth = 0; cause && depth < 8; depth++) {
      const code = feishuErrorCode(cause);
      if (code === 200860) {
        if (this.nativeCapacityScale < 0.08) return false;
        this.nativeCapacityScale *= 0.8;
        logger.info(
          { chatId: this.chatId, code, scale: this.nativeCapacityScale },
          'CardKit rejected page capacity; retrying smaller canonical pages',
        );
        return true;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
    return false;
  }

  private planNativePages(
    text: string,
    frozenBoundaries: number[] = [],
  ): CardPage[] {
    const panels = this.buildRichPanelPatches();
    const budget = Math.floor(
      CARDKIT_JSON_MAX_BYTES * this.nativeCapacityScale,
    );
    return splitCardPages(text, {
      frozenBoundaries,
      preserveFrozenCapacity: true,
      fits: (pageText) => {
        if (byteLen(JSON.stringify(pageText)) > budget - 3000) return false;
        const live = buildStreamingAgentCard({ initialText: pageText, panels });
        const final = this.buildStructuredFinalCard(
          'completed',
          undefined,
          pageText,
        );
        // Current diagnostics are measured; reserve room for later diagnostic
        // growth, the warning state and the in-place usage/footer update.
        return (
          fitsCardCapacity(live, { maxBytes: budget - 3000 }) &&
          fitsCardCapacity(final, { maxBytes: budget - 3000 })
        );
      },
    });
  }

  /** Keep accepted prefix boundaries stable on append. On a definite size
   * rejection only the rejected page and following pages are repartitioned. */
  private async syncNativePages(
    text: string,
    terminal?: 'completed' | 'aborted',
  ): Promise<void> {
    let boundaries = text.startsWith(this.nativeCanonicalText)
      ? this.nativeCards
          .filter((entry) => entry.text !== '')
          .slice(0, -1)
          .map((entry) => entry.rawEnd)
      : [];
    let retryFrom = 0;
    for (;;) {
      const pages = this.planNativePages(text, boundaries);
      let pageIndex = 0;
      try {
        await this.applyNativePages(pages, terminal, retryFrom, (index) => {
          pageIndex = index;
        });
        this.nativeCanonicalText = text;
        return;
      } catch (error) {
        if (!this.reduceNativeCapacity(error)) throw error;
        boundaries = pages.slice(0, pageIndex).map((page) => page.rawEnd);
        retryFrom = pageIndex;
      }
    }
  }

  private async applyNativePages(
    pages: CardPage[],
    terminal: 'completed' | 'aborted' | undefined,
    startAt: number,
    onPage: (index: number) => void,
  ): Promise<void> {
    for (let i = startAt; i < pages.length; i++) {
      onPage(i);
      const page = pages[i];
      const tail = i === pages.length - 1;
      const live = tail && !terminal;
      let entry = this.nativeCards[i];
      if (!entry) {
        const backend = new StreamingModeBackend(this.client);
        await backend.createCard(
          buildStreamingAgentCard({ initialText: page.text }),
        );
        const messageId = await backend.sendCard(
          this.chatId,
          this.replyToMsgId,
          this.replyInThread,
        );
        entry = {
          backend,
          text: page.text,
          streaming: true,
          rawEnd: page.rawEnd,
        };
        this.nativeCards.push(entry);
        this.streamingBackend = backend;
        this.messageId = messageId;
        this.onCardCreated?.(messageId);
        this.emitLifecycle('streaming');
      }
      if (!live) {
        const wasStreaming = entry.streaming;
        if (entry.streaming) {
          await entry.backend.drain();
          await entry.backend.disableStreamingMode();
          entry.streaming = false;
        }
        if (terminal || wasStreaming || entry.text !== page.text) {
          const card =
            tail && terminal
              ? this.buildStructuredFinalCard(terminal, undefined, page.text)
              : buildAgentReplyCard({
                  text: page.text,
                  status:
                    terminal === 'aborted'
                      ? 'warning'
                      : terminal
                        ? 'done'
                        : 'running',
                  title: terminal ? undefined : '回复继续中',
                  footer: terminal
                    ? undefined
                    : '后续内容将在下一张卡片继续显示',
                });
          await entry.backend.updateCardFull(card);
        }
      } else if (!entry.streaming || this.nativeFullUpdates) {
        const card = buildStreamingAgentCard({
          initialText: page.text,
          panels: this.buildRichPanelPatches(),
        });
        if (this.nativeFullUpdates) {
          (card.config as Record<string, unknown>).streaming_mode = false;
        }
        await entry.backend.updateCardFull(card);
        entry.streaming = !this.nativeFullUpdates;
      } else {
        await entry.backend.streamBody(page.text);
      }
      entry.text = page.text;
      entry.rawEnd = page.rawEnd;
    }
    // The canonical reducer can retract provisional text. Never leave stale
    // output on previously visible continuation cards after such a revision.
    for (let i = pages.length; i < this.nativeCards.length; i++) {
      const entry = this.nativeCards[i];
      if (entry.text === '') continue;
      if (entry.streaming) await entry.backend.disableStreamingMode();
      await entry.backend.updateCardFull(
        buildAgentReplyCard({
          text: '此页内容已更新，请查看前面的回复。',
          status: 'done',
        }),
      );
      entry.text = '';
      entry.streaming = false;
    }
    const tail = this.nativeCards[pages.length - 1];
    this.streamingBackend = tail.backend;
    this.messageId = tail.backend.messageId;
  }

  private derivePhase(): StreamingPhase {
    // 挂起完成态优先：本 turn 已答复、等后台任务/续写。放在最前是有意的——
    // backgrounded Bash 等工具的 tool_use 可能永远等不到 end 事件而滞留
    // 'running'，若 tooling 优先会把挂起期一直显示成「调用工具」。
    // 新 turn 的任何活动（append/appendThinking/startTool）会清除 heldOpen。
    if (this.heldOpen) return 'waiting_bg';
    // A live AskUserQuestion is not an ordinary tool call. It is a protocol
    // boundary where the agent has yielded and is waiting for the user. Keep
    // it ahead of tooling/thinking so the banner can never claim 「思考中」and
    // 「等待输入」both at once.
    for (const tc of this.toolCalls.values()) {
      if (tc.name === 'AskUserQuestion' && tc.status === 'running') {
        return 'waiting';
      }
    }
    // Priority: active tool > hook > thinking > streaming text > working > idle
    for (const tc of this.toolCalls.values()) {
      if (tc.status === 'running') return 'tooling';
    }
    if (this.activeHook) return 'hook';
    if (this.thinking && !this.accumulatedText) return 'thinking';
    if (this.accumulatedText) return 'streaming';
    if (this.systemStatus) return 'working';
    return 'idle';
  }

  private deriveBannerDetail(phase: StreamingPhase): string | undefined {
    if (phase === 'tooling') {
      const running = Array.from(this.toolCalls.values()).filter(
        (tc) => tc.status === 'running',
      );
      if (running.length === 0) return undefined;
      const primary = running[0];
      const name =
        primary.name === 'Skill' && primary.skillName
          ? primary.skillName
          : primary.name;
      const summary = primary.toolInputSummary
        ? `: ${primary.toolInputSummary.slice(0, 40)}`
        : '';
      const extra =
        running.length > 1
          ? ` <text_tag color='blue'>+${running.length - 1}</text_tag>`
          : '';
      return `\`${name}\`${summary}${extra}`;
    }
    if (phase === 'hook') {
      return this.activeHook
        ? `${this.activeHook.hookName || this.activeHook.hookEvent}`
        : undefined;
    }
    if (phase === 'streaming') {
      const chars = this.accumulatedText.length;
      return `已输出 ${chars} 字`;
    }
    if (phase === 'waiting_bg') {
      if (this.systemStatus) return this.systemStatus;
      const n = this.heldOpen?.pendingTasks;
      return n ? `${n} 个后台任务运行中，完成后将继续汇总` : '自动续写中…';
    }
    if (phase === 'working') {
      return this.systemStatus ?? undefined;
    }
    return undefined;
  }

  private buildRichPanelPatches(): {
    statusBanner: string;
    progressContent?: string;
    taskContent: string;
    toolsContent: string;
    thinkingContent?: string;
    askContent?: string;
    timelineContent?: string;
    footerNote: string;
  } {
    this.purgeOldTools();
    const phase = this.derivePhase();
    // Bucket elapsed to 5s so the banner text doesn't change on every single
    // aux flush — sub-second precision would defeat the hash dedup and turn
    // each flush into 2 guaranteed API calls (banner + footer echo).
    const elapsedMs =
      this.startTime > 0
        ? Math.floor((Date.now() - this.startTime) / 5000) * 5000
        : 0;
    const statusBanner = buildStatusBannerText({
      phase,
      detail: this.deriveBannerDetail(phase),
      elapsedMs,
    });
    const footerNote = this.traceFooterLink() ?? '';

    const progressContent =
      this.todos && this.todos.length > 0
        ? buildProgressListText(
            this.todos.map((t) => ({
              content: t.content,
              status: t.status as TodoItemView['status'],
            })),
          )
        : undefined;

    const now = Date.now();
    const taskViews = Array.from(this.tasks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
    const taskContent =
      taskViews.length > 0
        ? taskViews
            .map((task) => {
              const tagColor =
                task.status === 'running'
                  ? 'blue'
                  : task.status === 'completed'
                    ? 'green'
                    : task.status === 'backgrounded'
                      ? 'grey'
                      : 'red';
              const tagText =
                task.status === 'running'
                  ? '运行'
                  : task.status === 'completed'
                    ? '完成'
                    : task.status === 'backgrounded'
                      ? '后台'
                      : '失败';
              const type = task.subagentType
                ? ` <font color='grey'>${task.subagentType}</font>`
                : '';
              const last = task.lastToolName
                ? ` <font color='grey'>[${task.lastToolName}]</font>`
                : '';
              const summary = task.summary
                ? `\n  <font color='grey'>${task.summary.slice(0, 180)}</font>`
                : '';
              return `<text_tag color='${tagColor}'>${tagText}</text_tag> **${task.title.slice(0, 80)}**${type}${last}${summary}`;
            })
            .join('\n')
        : '';

    // Filter out AskUserQuestion from the tools timeline — it gets its own panel.
    const toolViews: ToolCallView[] = Array.from(this.toolCalls.values())
      .filter((tc) => tc.name !== 'AskUserQuestion')
      .map((tc) => ({
        name: tc.name,
        status: tc.status,
        durationMs: (tc.endTime ?? now) - tc.startTime,
        summary: tc.toolInputSummary,
        skillName: tc.skillName,
        isNested: tc.isNested,
      }));
    const toolsContent = toolViews.length
      ? buildToolsTimelineText(toolViews)
      : '';

    const thinkingContent = this.thinkingText
      ? buildThinkingBlockquote(this.thinkingText)
      : undefined;

    // AskUserQuestion: gather every running tool of that name and flatten to
    // a question list (mirrors web AskUserQuestionCard).
    const askQuestions = Array.from(this.toolCalls.values())
      .filter((tc) => tc.name === 'AskUserQuestion' && tc.status === 'running')
      .flatMap((tc) => collectAskQuestions(tc.toolInput));
    const askContent =
      askQuestions.length > 0
        ? `**❓ 等待你的回复**\n${buildAskQuestionText(askQuestions)}`
        : undefined;

    const timelineContent =
      this.recentEvents.length > 0
        ? buildTimelineText(this.recentEvents.map((e) => ({ text: e.text })))
        : undefined;

    const bounded = (content: string | undefined): string => {
      if (!content) return '';
      if (byteLen(content) <= 1800) return content;
      let prefix = '';
      // Truncated diagnostic text must not leave an unterminated Feishu tag.
      const plain = content.replace(/<[^>]*>/g, '');
      for (const point of plain) {
        if (byteLen(prefix + point) > 1650) break;
        prefix += point;
      }
      return `${prefix}\n… 已省略部分过程详情`;
    };
    return {
      statusBanner,
      progressContent: bounded(progressContent),
      taskContent: bounded(taskContent),
      toolsContent: bounded(toolsContent),
      thinkingContent: bounded(thinkingContent),
      askContent,
      timelineContent: bounded(timelineContent),
      footerNote,
    };
  }

  private scheduleAuxFlush(): void {
    if (!this.streamingBackend || !this.auxFlushCtrl) {
      this.schedulePatch();
      return;
    }

    this.auxFlushCtrl.schedule(this.stateVersion * 1000, async () => {
      await this.nativePageChain;
      // Terminal guard — mirror of scheduleTextFlush.
      if (
        this.state !== 'streaming' ||
        !this.streamingBackend ||
        this.backendTransition
      )
        return;
      const patches = this.buildRichPanelPatches();
      const details = buildStreamingDetails(patches)[0] ?? null;

      let result: { updated: string[]; failed: string[] };
      try {
        result = await this.streamingBackend!.updateMarkdownContents(
          [
            {
              elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
              content: patches.statusBanner,
            },
            {
              elementId: CARD_ELEMENT_IDS.ASK_CONTENT,
              content: patches.askContent ?? '',
            },
            {
              elementId: CARD_ELEMENT_IDS.PROGRESS_CONTENT,
              content: patches.progressContent ?? '',
            },
            {
              elementId: CARD_ELEMENT_IDS.TASK_CONTENT,
              content: patches.taskContent,
            },
            {
              elementId: CARD_ELEMENT_IDS.TOOLS_CONTENT,
              content: patches.toolsContent,
            },
            {
              elementId: CARD_ELEMENT_IDS.THINKING_CONTENT,
              content: patches.thinkingContent ?? '',
            },
            {
              elementId: CARD_ELEMENT_IDS.TIMELINE_CONTENT,
              content: patches.timelineContent ?? '',
            },
            {
              elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
              content: patches.footerNote,
            },
          ],
          details,
        );
      } catch (error) {
        if (this.state !== 'streaming') return;
        if (!canSwitchFeishuCardBackend(error)) {
          this.fenceVisibleCardMutation(error);
          return;
        }
        this.patchFailCount++;
        if (this.patchFailCount >= this.maxPatchFailures) this.degradeToV1();
        return;
      }
      if (result.updated.length > 0) {
        // Persist the provider-acknowledged sequence. Without this, a crash
        // after heartbeat/auxiliary mutations would leave recovery using an
        // older sequence that CardKit correctly rejects as stale.
        this.emitLifecycle('streaming');
      }
      if (result.failed.length > 0) {
        logger.debug(
          {
            chatId: this.chatId,
            mode: 'streaming',
            failedSlots: result.failed,
          },
          'Some rich panel slots failed to update (non-fatal)',
        );
      }
    });
  }

  /**
   * Degrade from streaming mode to v1 full-update mode.
   */
  private degradeToV1(): void {
    if (!this.streamingBackend || this.backendTransition) return;
    if (this.state !== 'streaming' && this.state !== 'creating') return;
    this.textFlushCtrl?.dispose();
    this.auxFlushCtrl?.dispose();
    this.stopHeartbeat();

    // Keep a single owner until every old mutation, including settings, has
    // been acknowledged. The adopted backend starts at that exact sequence.
    this.backendTransition = (async () => {
      try {
        await this.nativePageChain;
        if (this.terminalDeliveryError !== undefined)
          throw this.terminalDeliveryError;
        const backend = this.streamingBackend;
        if (!backend) return;
        await backend.drain();
        await backend.disableStreamingMode();
        if (this.state !== 'streaming' && this.state !== 'creating') return;
        if (this.nativeCards.length > 1) {
          this.nativeFullUpdates = true;
          this.textFlushCtrl = new FlushController(1000, 30);
          this.auxFlushCtrl = new FlushController(1500, 0);
          this.patchFailCount = 0;
          return;
        }
        const adopted = new CardKitBackend(this.client, backend.mutations);
        adopted.adoptCard(
          backend.getCardId()!,
          this.messageId!,
          backend.getSequence(),
        );
        this.multiCard = new MultiCardManager(
          this.client,
          this.chatId,
          this.replyToMsgId,
          this.replyInThread,
          this.onCardCreated,
        );
        this.multiCard.adoptExistingCard(adopted);
        this.streamingBackend = null;
        this.backendMode = 'v1';
        this.textFlushCtrl = null;
        this.auxFlushCtrl = null;
        this.patchFailCount = 0;
        this.flushCtrl.dispose();
        this.flushCtrl = new FlushController(1000, 50);
        logger.warn(
          { chatId: this.chatId },
          'Streaming card handed over to full updates',
        );
      } catch (error) {
        this.fenceVisibleCardMutation(error);
      }
    })().finally(() => {
      this.backendTransition = null;
      if (this.state === 'streaming') {
        if (this.nativeFullUpdates) {
          this.startHeartbeat();
          this.scheduleTextFlush();
        } else if (this.backendMode === 'v1') this.schedulePatch();
      }
    });
  }

  /**
   * Build a structured terminal card from the controller's accumulated state.
   * Reuses the shared v2 builder so the visual surface matches non-streaming
   * replies (metadata row, collapsible thinking/tool panels, grey footer). The
   * builder keeps a compact status header and places execution details after
   * the answer in both live and terminal layouts.
   */
  private buildStructuredFinalCard(
    finalState: 'completed' | 'aborted',
    usage?: {
      inputTokens: number;
      outputTokens: number;
      costUSD: number;
      durationMs: number;
      numTurns: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
      modelUsage?: Record<string, { outputTokens?: number }>;
    },
    text = this.accumulatedText,
  ): object {
    const status: CardStatus = finalState === 'aborted' ? 'warning' : 'done';
    const toolCalls: ToolCallStat[] = Array.from(
      this.toolTotals,
      ([name, count]) => ({ name, count }),
    );
    const thinking = this.thinkingText.trim() || undefined;
    const card = buildAgentReplyCard({
      status,
      text: text || '> ⚠️ 本次运行没有生成可展示的最终内容。',
      thinking,

      meta: {
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        durationMs: usage?.durationMs,
        model: pickPrimaryModel(usage?.modelUsage),
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadInputTokens: usage?.cacheReadInputTokens,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens,
        reasoningTokens: usage?.reasoningTokens,
        costUSD: usage?.costUSD,
        numTurns: usage?.numTurns,
      },
    });
    (card.body as { elements: object[] }).elements.push({
      tag: 'markdown',
      element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
      text_size: 'notation',
      content: this.traceFooterLink() ?? '',
    });
    return card;
  }

  /**
   * Finalize a streaming card: disable streaming mode, then set final state.
   */
  private async finalizeStreamingCard(
    finalState: 'completed' | 'aborted',
  ): Promise<void> {
    await this.nativePageChain;
    if (this.terminalDeliveryError !== undefined)
      throw this.terminalDeliveryError;
    const backend = this.streamingBackend!;
    try {
      await this.syncNativePages(this.accumulatedText, finalState);
    } catch (err) {
      if (!canSwitchFeishuCardBackend(err) || this.nativeCards.length > 1)
        throw err;
      logger.debug(
        { err, chatId: this.chatId },
        'Streaming finalize was rejected, trying a simpler answer card',
      );
      // This path owns a single page. Strip
      // optional presentation detail on a schema rejection, retaining the
      // complete answer instead of silently truncating it.
      try {
        const fallbackCard = buildSchema2Card(
          this.accumulatedText,
          finalState,
          '',
          statusHeadline(finalState === 'aborted' ? 'warning' : 'done'),
        );
        (fallbackCard as { body: { elements: object[] } }).body.elements.push({
          tag: 'markdown',
          element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
          text_size: 'notation',
          content: this.traceFooterLink() ?? '',
        });
        await backend.updateCardFull(fallbackCard);
      } catch (fallbackErr) {
        logger.warn(
          { err: fallbackErr, chatId: this.chatId },
          'Streaming finalize simple fallback also failed',
        );
        // Both attempts failed — the card face is still stuck on「生成中」.
        // Rethrow so complete() reverts state and the caller falls back to a
        // static IM message; swallowing here would silently lose the reply
        // AND leave a zombie card.
        throw fallbackErr;
      }
    }
  }

  private async patchCard(
    displayState: 'streaming' | 'completed' | 'aborted',
    footerNote?: string,
  ): Promise<void> {
    const displayText =
      displayState === 'streaming'
        ? this.liveDisplayText()
        : this.accumulatedText;
    if (this.useCardKit && this.multiCard) {
      // CardKit v1 path — pass auxiliary state for rich display
      const auxState =
        displayState === 'streaming' ? this.getAuxiliaryState() : undefined;
      try {
        await this.multiCard.commitContent(
          displayText,
          displayState,
          auxState,
          footerNote,
        );
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
        if (displayState === 'streaming') this.emitLifecycle('streaming');
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'cardkit',
          },
          'CardKit card update failed',
        );
        throw canSwitchFeishuCardBackend(err)
          ? err
          : this.fenceVisibleCardMutation(err);
      }
    } else {
      // Legacy message.patch path (no auxiliary content)
      if (!this.messageId) return;

      const card = buildStreamingCard(displayText, displayState, footerNote);
      const content = JSON.stringify(card);

      try {
        const messageId = this.messageId;
        const run = this.legacyPatchChain.then(async () => {
          const response = await this.client.im.v1.message.patch({
            path: { message_id: messageId },
            data: { content },
          });
          assertCardKitAcknowledged(response, 'im.message.patch');
        });
        this.legacyPatchChain = run.then(
          () => undefined,
          () => undefined,
        );
        await run;
        this.flushCtrl.markFlushed(this.accumulatedText.length);
        this.patchFailCount = 0;
        if (displayState === 'streaming') this.emitLifecycle('streaming');
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            err,
            chatId: this.chatId,
            failCount: this.patchFailCount,
            mode: 'legacy',
          },
          'Streaming card patch failed',
        );
        throw canSwitchFeishuCardBackend(err)
          ? err
          : this.fenceVisibleCardMutation(err);
      }
    }
  }
}

/**
 * Close a card left non-terminal by a dead process. This deliberately updates
 * the original card/message; creating a replacement would leave two active
 * cards for the same logical turn after SIGKILL recovery.
 */
export async function reconcileInterruptedStreamingCard(
  client: lark.Client,
  input: InterruptedStreamingCardInput,
): Promise<{ version: number; method: 'cardkit' | 'message_patch' }> {
  const rewrite = resolveInterruptedStreamingCardRewrite(input);
  const card = buildAgentReplyCard({
    status: rewrite.status,
    text: rewrite.text,
  });

  if (input.cardId) {
    let version = Math.max(0, Math.trunc(input.version));
    try {
      const settings = JSON.stringify({ config: { streaming_mode: false } });
      const sequence = ++version;
      const response = await client.cardkit.v1.card.settings({
        path: { card_id: input.cardId },
        data: {
          settings,
          sequence,
          uuid: cardMutationUuid(
            input.cardId,
            sequence,
            'reconcile:settings',
            quickHash(settings),
          ),
        },
      });
      assertCardKitAcknowledged(response, 'card.settings reconcile');
    } catch (error) {
      // A provider may report that streaming already expired. The original
      // card can still accept a full update, so do not create a second card.
      logger.debug(
        { err: error, cardId: input.cardId },
        'Interrupted card streaming disable failed; trying full update',
      );
    }
    const data = JSON.stringify(card);
    const sequence = ++version;
    const response = await client.cardkit.v1.card.update({
      path: { card_id: input.cardId },
      data: {
        card: { type: 'card_json', data },
        sequence,
        uuid: cardMutationUuid(
          input.cardId,
          sequence,
          'reconcile:update',
          quickHash(data),
        ),
      },
    });
    assertCardKitAcknowledged(response, 'card.update reconcile');
    return { version, method: 'cardkit' };
  }

  if (!input.messageId) {
    throw new Error('Interrupted streaming card has no cardId or messageId');
  }
  const response = await client.im.v1.message.patch({
    path: { message_id: input.messageId },
    data: { content: JSON.stringify(card) },
  });
  assertCardKitAcknowledged(response, 'im.message.patch reconcile');
  return {
    version: Math.max(0, Math.trunc(input.version)),
    method: 'message_patch',
  };
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
export function resolveJidByMessageId(messageId: string): string | undefined {
  return messageIdToChatJid.get(messageId);
}

/**
 * Remove a messageId mapping.
 */
export function unregisterMessageId(messageId: string): void {
  messageIdToChatJid.delete(messageId);
}

// ─── Streaming Session Registry ───────────────────────────────

/**
 * Minimal interface for any streaming card session (Feishu, DingTalk, etc.)
 * Both StreamingCardController and DingTalkStreamingCardController implement this.
 */
export interface IStreamingSession {
  isActive(): boolean;
  abort(reason?: string): Promise<void>;
  getAllMessageIds(): string[];
}

// Global registry for tracking active streaming sessions.
// Used by shutdown hooks to abort all active sessions.
const activeSessions = new Map<string, IStreamingSession>();

/**
 * Register a streaming session for a chatJid.
 * Replaces any existing session for the same chatJid.
 */
export function registerStreamingSession(
  chatJid: string,
  session: IStreamingSession,
): void {
  const existing = activeSessions.get(chatJid);
  if (existing && existing !== session) {
    if (existing.isActive()) {
      // Abort (not just dispose) so the old card shows "已中断" instead of stuck "生成中..."
      existing.abort('新的回复已开始').catch(() => {});
    }
    // Drop the replaced card's messageId routing entries — its interrupt
    // button is gone after abort, so keeping them only leaks the Map.
    for (const msgId of existing.getAllMessageIds()) {
      unregisterMessageId(msgId);
    }
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
): IStreamingSession | undefined {
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
  logger.info({ count: promises.length }, 'All streaming sessions aborted');
}
