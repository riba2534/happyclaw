/**
 * Pure section constructors for the Feishu v2 Agent reply card.
 *
 * Each builder returns a 0..N element array so the top-level builder can
 * concatenate them without null checks. Padding is always four-valued (v2
 * strict); colors are always v2 enum tokens (never hex).
 */

import type { AgentCardInput, CardMeta, ToolCallStat } from './types.js';
import { resolveStatusTheme } from './status-theme.js';
import { splitIntoBodySections } from './length.js';
import { isMarkdownTableDelimiter, markdownFenceOpener } from './pagination.js';
import {
  formatFeishuTokenCount,
  formatFeishuTokenSummary,
} from '../feishu-usage-display.js';
import { neutralizeFeishuMentions } from '../feishu-errors.js';

/** Element ids for both the structured streaming layout and the static terminal card.
 *
 *  Feishu constraint (observed from server error 300301 / 1002):
 *    - Only [a-zA-Z][a-zA-Z0-9_]* is allowed
 *    - Length ≤ 20 characters
 *    - Must be unique within a card
 *  Keep every value below under 20 chars.
 *
 *  Streaming runtime panels (normally an outer `*_PANEL` collapsible and an
 *  inner `*_CONTENT` markdown patchable via cardElement.content). ASK_CONTENT
 *  is intentionally a standalone blank slot so no waiting panel appears
 *  before a real AskUserQuestion call.
 *  Final card uses a distinct set suffixed `_final` so both can coexist when
 *  transitioning from streaming to completed.
 */
export const CARD_ELEMENT_IDS = {
  // Legacy / baseline streaming slots (kept for fallback to v1 updateCard path)
  AUX_BEFORE: 'aux_before',
  AUX_AFTER: 'aux_after',
  STATUS_NOTE: 'status_note',

  // Rich streaming slots (Phase C)
  STATUS_BANNER: 'status_banner',
  PROGRESS_PANEL: 'progress_panel',
  PROGRESS_CONTENT: 'progress_md',
  TASK_PANEL: 'task_live',
  TASK_CONTENT: 'task_live_md',
  TOOLS_PANEL: 'tools_live',
  TOOLS_CONTENT: 'tools_live_md',
  THINKING_PANEL: 'thinking_live',
  THINKING_CONTENT: 'thinking_live_md',
  // Phase F — aligning with web StreamingDisplay
  ASK_CONTENT: 'ask_md',
  TIMELINE_PANEL: 'timeline_panel',
  TIMELINE_CONTENT: 'timeline_md',
  DETAILS_PANEL: 'runtime_details',

  // Shared core slots
  MAIN_CONTENT: 'main_content',
  INTERRUPT_BTN: 'interrupt_btn',
  FOOTER_NOTE: 'footer_note',

  // Static terminal card extras
  META_ROW: 'meta_row',
  THINKING_PANEL_FINAL: 'thinking_final',
  THINKING_CONTENT_FINAL: 'thinking_fin_md',
  TOOLS_PANEL_FINAL: 'tools_final',
  FOOTER: 'footer',
} as const;

/** v2 rejects two-value padding strings like "4px 8px"; must be single value or four values. */
const PANEL_PADDING = '6px 10px 6px 10px';
const PANEL_ICON = {
  tag: 'standard_icon',
  token: 'down-small-ccm_outlined',
} as const;

/**
 * Per-panel header tints. collapsible_panel header.background_color must be an
 * ENUM colour token — the API rejects rgba()/rgb()/hex here with
 * `code=11310 collapsible panel header background color is invalid`, which
 * silently fails card.create and forces the whole streaming card to degrade
 * from the L0 typewriter path down to L1 CardKit full-update on every reply.
 * Use the light `-50` gradient tokens: near-white fills that keep the dark
 * title legible while still differentiating the panels, and that the API
 * actually accepts.
 */
const PANEL_TINT = {
  thinking: 'blue-50', // light blue
  tools: 'wathet-50', // light cyan/sky
} as const;

type El = Record<string, unknown>;

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-';
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const restSec = Math.floor(sec % 60);
  return restSec === 0 ? `${min}m` : `${min}m ${restSec}s`;
}

export function formatTokens(n: number | undefined): string {
  return formatFeishuTokenCount(n);
}

export function shortModel(model: string): string {
  // "claude-opus-4-7" → "opus-4.7", "claude-opus-5-20261001" → "opus-5".
  // A minor version is one or two digits; a date suffix is never a version.
  const m =
    model.match(/claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i) ??
    model.match(/(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i);
  if (m) {
    const family = m[1].toLowerCase();
    return m[3] ? `${family}-${m[2]}.${m[3]}` : `${family}-${m[2]}`;
  }
  return model.length > 20 ? model.slice(0, 17) + '...' : model;
}

/**
 * Escape a tool/model/user value interpolated into one line of panel
 * Markdown: no mentions, no line breaks, no table pipes, no code-span
 * backticks, no tags (`</font>` would close the surrounding markup) and no
 * leading heading marker. Feishu card Markdown decodes the `&#N;` entities.
 */
export function escapeFeishuPanelInline(value: string): string {
  return neutralizeFeishuMentions(value, 'card')
    .replace(/\r\n?|\n/g, ' ')
    .replace(/</g, '&#60;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/^(\s*)#/, '$1&#35;');
}

/** A value rendered inside a Markdown code span: keep it on one line. */
function codeSpanText(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ').replace(/`/g, "'");
}

export interface TitleExtractResult {
  title: string;
  bodyStartIndex: number;
}

/**
 * Extract a short title (≤40 chars) from the first H1-H3 heading, or from the
 * first non-empty line. `bodyStartIndex` is the line index where the body starts
 * so the caller can strip the heading from the rendered body.
 */
export function extractTitle(text: string): TitleExtractResult {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // A fence opener or table row is content, not a title: eat nothing.
    if (
      markdownFenceOpener(lines[i]) ||
      isMarkdownTableDelimiter(lines[i]) ||
      (lines[i].includes('|') &&
        lines[i + 1] !== undefined &&
        isMarkdownTableDelimiter(lines[i + 1]))
    ) {
      return { title: 'Reply', bodyStartIndex: 0 };
    }
    if (/^#{1,3}\s+/.test(lines[i])) {
      return {
        title: lines[i].replace(/^#+\s*/, '').trim(),
        bodyStartIndex: i + 1,
      };
    }
    const firstLine = lines[i].replace(/[*_`#\[\]]/g, '').trim();
    const title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
    return { title, bodyStartIndex: i + 1 };
  }
  return { title: 'Reply', bodyStartIndex: 0 };
}

/**
 * Minimal status word shown as the header title when no explicit title is
 * provided. Never derive the title from the body's first line — that was the
 * root cause of the header/first-line duplication (issue #488). For terminal
 * states we want a short, unambiguous status word instead.
 */
export function statusHeadline(status: AgentCardInput['status']): string {
  switch (status) {
    case 'running':
      return '生成中';
    case 'warning':
      return '已中断';
    case 'error':
      return '出错';
    case 'done':
    default:
      return '已完成';
  }
}

export function buildHeader(input: AgentCardInput): El {
  const theme = resolveStatusTheme(input.status);
  const explicitTitle = input.title?.trim();
  const baseTitle = explicitTitle || statusHeadline(input.status);
  const displayTitle = input.titlePrefix
    ? `${input.titlePrefix}${baseTitle}`
    : baseTitle;

  const header: El = {
    title: { tag: 'plain_text', content: displayTitle },
    template: theme.template,
  };
  if (input.subtitle) {
    (header as { subtitle?: unknown }).subtitle = {
      tag: 'plain_text',
      content: input.subtitle,
    };
  }
  const tags: El[] = [];
  if (input.meta?.model) {
    tags.push({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: shortModel(input.meta.model) },
      color: theme.template,
    });
  }
  tags.push({
    tag: 'text_tag',
    text: { tag: 'plain_text', content: theme.tagText },
    color: theme.tagColor,
  });
  (header as { text_tag_list?: unknown }).text_tag_list = tags;
  return header;
}

/** Compact metadata columns that wrap into rows on narrow clients. */
export function buildMetaRow(meta: CardMeta | undefined): El[] {
  if (!meta) return [];
  const fields: El[] = [];
  const push = (title: string, value: string): void => {
    fields.push({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'markdown',
          content: `**${title}**\n${value}`,
          text_size: 'notation',
        },
      ],
    });
  };
  if (meta.durationMs !== undefined)
    push('⏱ 耗时', formatDuration(meta.durationMs));
  if (meta.model)
    push('🤖 模型', `\`${codeSpanText(shortModel(meta.model))}\``);
  if (
    meta.inputTokens !== undefined ||
    meta.outputTokens !== undefined ||
    meta.cacheReadInputTokens !== undefined ||
    meta.cacheCreationInputTokens !== undefined ||
    meta.reasoningTokens !== undefined
  ) {
    push('💡 Token', formatFeishuTokenSummary(meta));
  }
  const toolCount = meta.toolCalls?.length
    ? meta.toolCalls.reduce((s, t) => s + t.count, 0)
    : meta.toolCount;
  if (toolCount !== undefined && toolCount > 0)
    push('🛠 工具', `${toolCount} 次`);
  if (fields.length === 0) return [];
  return [
    {
      tag: 'column_set',
      flex_mode: 'stretch',
      background_style: 'default',
      horizontal_spacing: '8px',
      columns: fields,
      element_id: CARD_ELEMENT_IDS.META_ROW,
    },
  ];
}

/** Main content + collapsible "continue reading" sections for overflow. */
export function buildBodyChunks(bodyText: string): El[] {
  const sections = splitIntoBodySections(bodyText);
  if (sections.length === 0) {
    return [
      {
        tag: 'markdown',
        content: '> 暂无可展示的内容。',
        element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
      },
    ];
  }
  // Keep all body sections visible. The 4K target is a layout choice; actual
  // provider byte limits and continuation cards belong to the delivery layer.
  const els: El[] = sections.map((section, i) => ({
    tag: 'markdown',
    content: section.text,
    // Only the first chunk keeps the streaming element_id so cardElement.content()
    // patches continue to target it; follow-up chunks are static.
    element_id: i === 0 ? CARD_ELEMENT_IDS.MAIN_CONTENT : `body_${i}`,
  }));
  return els;
}

export function buildThinkingPanel(thinking: string | undefined): El[] {
  const trimmed = thinking?.trim();
  if (!trimmed) return [];
  return [
    collapsiblePanel({
      title: '**💭 思考过程**',
      expanded: false,
      elementId: CARD_ELEMENT_IDS.THINKING_PANEL_FINAL,
      backgroundColor: PANEL_TINT.thinking,
      elements: [
        {
          tag: 'markdown',
          content: neutralizeFeishuMentions(trimmed, 'card'),
          element_id: CARD_ELEMENT_IDS.THINKING_CONTENT_FINAL,
        },
      ],
    }),
  ];
}

export function buildToolsPanel(toolCalls: ToolCallStat[] | undefined): El[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const total = toolCalls.reduce((s, t) => s + t.count, 0);
  const sorted = [...toolCalls].sort((a, b) => b.count - a.count);
  const MAX_VISIBLE = 10;
  const top = sorted.slice(0, MAX_VISIBLE);
  const rest = sorted.slice(MAX_VISIBLE);
  // Use <number_tag> for per-tool counts — cleaner than inline text counters.
  const lines = top.map(
    (t) =>
      `- \`${codeSpanText(t.name)}\` <number_tag background_color='grey' font_color='white'>${clampNumberTag(t.count)}</number_tag>`,
  );
  if (rest.length > 0) {
    const restTotal = rest.reduce((s, t) => s + t.count, 0);
    lines.push(`- _… 其余 ${rest.length} 种共 ${restTotal} 次_`);
  }
  // Title uses a number_tag badge so the total glows as a pill, not plain text.
  const totalBadge = `<number_tag background_color='violet' font_color='white'>${clampNumberTag(total)}</number_tag>`;
  return [
    collapsiblePanel({
      title: `**🛠 工具调用** ${totalBadge}`,
      expanded: false,
      elementId: CARD_ELEMENT_IDS.TOOLS_PANEL_FINAL,
      backgroundColor: PANEL_TINT.tools,
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    }),
  ];
}

/** number_tag accepts integers 1-99 only; clamp to stay in-range. */
function clampNumberTag(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n > 99) return 99;
  return Math.floor(n);
}

export function buildFooter(
  footer: string | undefined,
  completedAtMs?: number,
): El[] {
  const text = footer?.trim();
  const hasTimestamp = completedAtMs !== undefined && completedAtMs > 0;
  if (!text && !hasTimestamp) return [];

  const parts: string[] = [];
  if (text) parts.push(text);
  if (hasTimestamp) {
    // <local_datetime> renders per-viewer timezone; date_num = "2026/04/18 18:09"
    parts.push(
      `<local_datetime millisecond='${completedAtMs}' format_type='date_num'></local_datetime>`,
    );
  }
  return [
    {
      tag: 'markdown',
      text_size: 'notation',
      content: `<font color='grey'>${parts.join(' · ')}</font>`,
      element_id: CARD_ELEMENT_IDS.FOOTER,
    },
  ];
}

// ─── Streaming-runtime markdown builders ────────────────────────────────
//
// Each function returns a ready-to-patch markdown string — the streaming
// controller feeds the output into cardElement.content() for a specific
// element_id slot.

export type StreamingPhase =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'tooling'
  | 'hook'
  | 'streaming'
  | 'waiting'
  | 'waiting_bg'
  | 'completed'
  | 'aborted'
  | 'error';

/** Single-line banner summarising what the agent is doing right now. */
export function buildStatusBannerText(input: {
  phase: StreamingPhase;
  detail?: string;
  elapsedMs?: number;
}): string {
  const { phase, detail, elapsedMs } = input;
  const elapsed =
    elapsedMs !== undefined && elapsedMs > 0
      ? ` <font color='grey'>· 已用 ${formatDuration(elapsedMs)}</font>`
      : '';
  const tag = (text: string, color: string) =>
    `<text_tag color='${color}'>${text}</text_tag>`;
  // `detail` is caller-built markup; values inside it are escaped there.
  const detailPart = detail
    ? ` <font color='grey'>${neutralizeFeishuMentions(detail, 'card')}</font>`
    : '';
  switch (phase) {
    case 'thinking':
      return `${tag('思考中', 'blue')} 🧠${detailPart}${elapsed}`;
    case 'working':
      return `${tag('执行中', 'turquoise')} ⚙️${detailPart}${elapsed}`;
    case 'tooling':
      return `${tag('调用工具', 'turquoise')} 🛠${detailPart}${elapsed}`;
    case 'hook':
      return `${tag('运行 Hook', 'indigo')} 🔗${detailPart}${elapsed}`;
    case 'streaming':
      return `${tag('生成回复', 'violet')} ✨${detailPart}${elapsed}`;
    case 'waiting':
      return `${tag('等待输入', 'grey')} ⏸${detailPart}`;
    case 'waiting_bg':
      // 本 turn 回复已送达，但后台任务（异步 Agent / 截断自动续写）仍在跑，
      // 卡片保持打开等待追加——不能显示成绿色「已完成」误导用户。
      return `${tag('后台任务运行中', 'violet')} ⏳${detailPart}${elapsed}`;
    case 'completed':
      return `${tag('已完成', 'green')} ✅${detailPart}${elapsed}`;
    case 'aborted':
      return `${tag('已中断', 'orange')} ⚠️${detailPart}`;
    case 'error':
      return `${tag('出错', 'red')} ❌${detailPart}`;
    case 'idle':
    default:
      return `${tag('准备中', 'grey')} ⏳`;
  }
}

export interface TodoItemView {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** TodoWrite list with pseudo progress bar. */
export function buildProgressListText(todos: TodoItemView[]): string {
  if (todos.length === 0) return "<font color='grey'>暂无任务计划</font>";
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const barFilled = Math.max(0, Math.min(10, Math.round((done / total) * 10)));
  const bar = '▓'.repeat(barFilled) + '░'.repeat(10 - barFilled);
  const header = `**进度 ${done}/${total}** <font color='grey'>${bar} ${pct}%</font>`;
  const MAX_VISIBLE = 12;
  const items = todos.slice(0, MAX_VISIBLE).map((t) => {
    const icon =
      t.status === 'completed'
        ? '✅'
        : t.status === 'in_progress'
          ? '🔄'
          : '⏳';
    const content = escapeFeishuPanelInline(t.content);
    const styled =
      t.status === 'in_progress'
        ? `**${content}** <font color='blue'>_(进行中)_</font>`
        : t.status === 'completed'
          ? `<font color='grey'>${content}</font>`
          : content;
    return `${icon} ${styled}`;
  });
  const extra =
    total > MAX_VISIBLE
      ? `\n<font color='grey'>… 还有 ${total - MAX_VISIBLE} 项未展开</font>`
      : '';
  return `${header}\n\n${items.join('\n')}${extra}`;
}

export interface ToolCallView {
  name: string;
  status: 'running' | 'complete' | 'error';
  durationMs: number;
  summary?: string;
  /** When the tool invocation is wrapping a Skill, display this instead of name. */
  skillName?: string;
  /** Sub-agent tool calls get visual indentation. */
  isNested?: boolean;
}

/** Map a tool name + summary to a labeled parameter (mirrors Web parseToolParam). */
export function parseToolParam(
  toolName: string,
  summary: string | undefined,
): { label: string; value: string } | null {
  if (!summary) return null;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
      return { label: 'path', value: summary };
    case 'Bash':
      return { label: 'cmd', value: summary };
    case 'Grep':
      return { label: 'pattern', value: summary };
    case 'Agent':
    case 'Task':
      return { label: 'task', value: summary };
    default:
      return { label: 'input', value: summary };
  }
}

/** Tool timeline with status tags, elapsed time, labeled params, skill + nested hints. */
export function buildToolsTimelineText(
  tools: ToolCallView[],
  opts: { maxVisible?: number } = {},
): string {
  if (tools.length === 0) return "<font color='grey'>尚未调用任何工具</font>";
  const maxVisible = opts.maxVisible ?? 8;
  const running = tools.filter((t) => t.status === 'running');
  const recent = tools.filter((t) => t.status !== 'running').slice(-maxVisible);
  const picked = [...running, ...recent].slice(0, maxVisible);
  const lines = picked.map((t) => {
    const tagColor =
      t.status === 'running' ? 'blue' : t.status === 'error' ? 'red' : 'green';
    const tagText =
      t.status === 'running' ? '运行' : t.status === 'error' ? '失败' : '完成';
    const elapsed =
      t.durationMs > 0
        ? ` <font color='grey'>(${formatDuration(t.durationMs)})</font>`
        : '';
    // Use skillName when the tool is a Skill wrapper, mirrors web ToolActivityCard.
    const displayName =
      t.name === 'Skill' && t.skillName ? t.skillName : t.name;
    const param = parseToolParam(t.name, t.summary);
    const paramLine = param
      ? `\n  <font color='grey'>${param.label}: ${escapeFeishuPanelInline(truncate(param.value, 90))}</font>`
      : '';
    const indent = t.isNested ? '    ' : '';
    return `${indent}<text_tag color='${tagColor}'>${tagText}</text_tag> \`${codeSpanText(displayName)}\`${elapsed}${paramLine}`;
  });
  const hidden = tools.length - picked.length;
  const more =
    hidden > 0
      ? `\n<font color='grey'>… 另有 ${hidden} 条工具记录已收起</font>`
      : '';
  return `${lines.join('\n')}${more}`;
}

/** Blockquoted reasoning stream. Keeps the most recent ~2000 chars (single
 *  markdown element supports ≤4000 chars; leave headroom for blockquote prefix). */
export function buildThinkingBlockquote(text: string): string {
  const MAX = 2000;
  if (!text.trim()) return "<font color='grey'>暂无思考记录</font>";
  // Reasoning keeps its Markdown, but may never @ anyone. Slice by code
  // points so the tail never starts with a lone low surrogate.
  const neutral = neutralizeFeishuMentions(text, 'card');
  const sliced =
    neutral.length > MAX ? '…' + takeLastCodePoints(neutral, MAX - 1) : neutral;
  return sliced
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

// ─── AskUserQuestion card ──────────────────────────────────────

export interface AskQuestionView {
  question: string;
  options?: Array<{ value?: string; label?: string }>;
}

/** Render an AskUserQuestion set as a markdown block with option tags. */
export function buildAskQuestionText(questions: AskQuestionView[]): string {
  if (questions.length === 0) return '';
  return questions
    .map((q) => {
      const head = `**${escapeFeishuPanelInline(q.question)}**`;
      const opts = q.options ?? [];
      if (opts.length === 0) return head;
      const tags = opts
        .map((o) => {
          const label = escapeFeishuPanelInline(o.label || o.value || '—');
          return `<text_tag color='blue'>${label}</text_tag>`;
        })
        .join(' ');
      return `${head}\n${tags}\n<font color='grey'>请在智能体终端回复</font>`;
    })
    .join('\n\n');
}

/** Extract question objects from a raw AskUserQuestion tool input payload. */
export function collectAskQuestions(
  toolInput: Record<string, unknown> | undefined,
): AskQuestionView[] {
  if (!toolInput) return [];
  const out: AskQuestionView[] = [];
  if (Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      if (q && typeof q === 'object' && 'question' in q) {
        const cast = q as AskQuestionView;
        if (typeof cast.question === 'string') out.push(cast);
      }
    }
  } else if (typeof toolInput.question === 'string') {
    out.push({
      question: toolInput.question,
      options: Array.isArray(toolInput.options)
        ? (toolInput.options as AskQuestionView['options'])
        : undefined,
    });
  }
  return out;
}

// ─── Call-trace timeline (recent events) ───────────────────────

export interface TimelineEventView {
  text: string;
}

export function buildTimelineText(events: TimelineEventView[]): string {
  if (events.length === 0) return "<font color='grey'>暂无调用记录</font>";
  const MAX = 20;
  const tail = events.slice(-MAX);
  const hidden = events.length - tail.length;
  // Event text carries caller-built markup (grey labels, tool code spans);
  // keep it on one list line and never let quoted tool output @ anyone.
  const lines = tail.map(
    (e) =>
      `- ${neutralizeFeishuMentions(e.text, 'card').replace(/\r\n?|\n/g, ' ')}`,
  );
  const more =
    hidden > 0 ? `\n<font color='grey'>… 较早 ${hidden} 条已省略</font>` : '';
  return `${lines.join('\n')}${more}`;
}

/** Truncate to `limit` code points (never leaving a lone surrogate). */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return points.slice(0, limit - 1).join('') + '…';
}

function takeLastCodePoints(text: string, count: number): string {
  const points = Array.from(text);
  return points.length <= count ? text : points.slice(-count).join('');
}

// ─── Streaming panels (structured skeleton pieces) ──────────────────────

export interface StreamingPanelsInit {
  /** Initial markdown content for each slot — empty strings get placeholder text. */
  statusBanner?: string;
  progressContent?: string;
  taskContent?: string;
  toolsContent?: string;
  thinkingContent?: string;
  askContent?: string;
  timelineContent?: string;
  /** Show panels expanded (true) or folded (false) at creation time. */
  expandProgress?: boolean;
  expandTools?: boolean;
  expandThinking?: boolean;
  expandTimeline?: boolean;
}

/** Stable detail slots share one optional, collapsed execution panel. */
const DETAIL_SLOTS = [
  ['progressContent', CARD_ELEMENT_IDS.PROGRESS_CONTENT, '任务进度'],
  ['taskContent', CARD_ELEMENT_IDS.TASK_CONTENT, '子任务'],
  ['toolsContent', CARD_ELEMENT_IDS.TOOLS_CONTENT, '工具调用'],
  ['thinkingContent', CARD_ELEMENT_IDS.THINKING_CONTENT, '思考摘要'],
  ['timelineContent', CARD_ELEMENT_IDS.TIMELINE_CONTENT, '最近活动'],
] as const;

/** Apply the same labels when creating a slot and updating its content. */
export function formatRuntimeDetail(
  elementId: string,
  content: string,
): string {
  if (!content.trim()) return '';
  const slot = DETAIL_SLOTS.find((entry) => entry[1] === elementId);
  return slot ? `**${slot[2]}**\n${content}` : content;
}

export function buildStreamingDetails(init: StreamingPanelsInit): El[] {
  if (!DETAIL_SLOTS.some(([key]) => init[key]?.trim())) return [];
  return [
    collapsiblePanel({
      elementId: CARD_ELEMENT_IDS.DETAILS_PANEL,
      title: '**执行详情**',
      expanded:
        init.expandProgress ||
        init.expandTools ||
        init.expandThinking ||
        init.expandTimeline ||
        false,
      backgroundColor: 'grey-50',
      elements: DETAIL_SLOTS.map(([key, elementId]) => ({
        tag: 'markdown',
        element_id: elementId,
        content: formatRuntimeDetail(elementId, init[key] ?? ''),
        text_size: 'notation',
      })),
    }),
  ];
}

/** The caller places the main answer between these fixed slots and details. */
export function buildStreamingPanels(init: StreamingPanelsInit): El[] {
  return [
    {
      tag: 'markdown',
      element_id: CARD_ELEMENT_IDS.STATUS_BANNER,
      content: init.statusBanner ?? buildStatusBannerText({ phase: 'idle' }),
      text_size: 'notation',
    },
    {
      tag: 'markdown',
      element_id: CARD_ELEMENT_IDS.ASK_CONTENT,
      content: init.askContent ?? '',
    },
  ];
}

/** Keep the completed reply's answer → details → metadata reading order. */
export function buildFinalDetails(input: AgentCardInput): El[] {
  const tools = input.meta?.toolCalls;
  const toolsContent = tools?.length
    ? tools
        .map((tool) => `- \`${codeSpanText(tool.name)}\` · ${tool.count} 次`)
        .join('\n')
    : '';
  return buildStreamingDetails({
    thinkingContent: input.thinking
      ? neutralizeFeishuMentions(input.thinking, 'card')
      : input.thinking,
    toolsContent,
  });
}

/** One runtime panel (collapsible wrapping a single patchable markdown). */
export function buildRuntimePanel(opts: {
  elementId: string;
  contentElementId: string;
  title: string;
  expanded: boolean;
  content: string;
  backgroundColor?: string;
}): El {
  return collapsiblePanel({
    title: opts.title,
    expanded: opts.expanded,
    elementId: opts.elementId,
    backgroundColor: opts.backgroundColor,
    elements: [
      {
        tag: 'markdown',
        element_id: opts.contentElementId,
        content: opts.content,
      },
    ],
  });
}

interface CollapsibleOpts {
  title: string;
  expanded: boolean;
  elements: El[];
  elementId?: string;
  /**
   * Header tint. Defaults to neutral grey. Semantic panels get a restrained
   * accent (thinking→wathet, tools→turquoise, ask→orange) so the eye can tell
   * them apart at a glance without the card turning into a colour soup — keep
   * the palette to ≤3 accents plus grey.
   */
  backgroundColor?: string;
  /** Header leading icon. Defaults to the shared fold chevron. */
  icon?: El;
}

function collapsiblePanel(opts: CollapsibleOpts): El {
  const panel: El = {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: {
      title: { tag: 'markdown', content: opts.title },
      background_color: opts.backgroundColor ?? 'grey',
      padding: PANEL_PADDING,
      icon: opts.icon ?? PANEL_ICON,
    },
    elements: opts.elements,
  };
  if (opts.elementId) {
    (panel as { element_id?: string }).element_id = opts.elementId;
  }
  return panel;
}
