/**
 * Top-level Feishu v2 Agent reply card builders.
 *
 *   buildAgentReplyCard(input)
 *       Terminal (static) card. Header is status-driven: a successful `done`
 *       reply drops the header (unless an explicit title is passed) so short
 *       status messages aren't reduced to a truncated header, while
 *       running/warning/error keep a status-coloured header. Followed by body
 *       chunks + metadata row (2×2) + optional thinking/tool panels + footer.
 *       Suitable for finalized Agent replies and error cards.
 *
 *   buildStreamingAgentCard(opts)
 *       Initial streaming skeleton. Preserves the 5 slot element_ids that
 *       feishu-streaming-card.ts patches via cardElement.content(). The aux
 *       before/after slots remain plain markdown so the existing flush loop
 *       keeps working unchanged.
 */

import { optimizeMarkdownStyle } from '../feishu-markdown-style.js';
import type { AgentCardInput, CardMeta, FeishuCardV2 } from './types.js';
import {
  buildHeader,
  buildMetaRow,
  buildBodyChunks,
  buildThinkingPanel,
  buildToolsPanel,
  buildFooter,
  buildStreamingPanels,
  buildStatusBannerText,
  statusHeadline,
  CARD_ELEMENT_IDS,
  FEEDBACK_BUTTONS_V2,
  type StreamingPanelsInit,
} from './sections.js';

/** Per-platform typewriter tuning — mobile feels faster, PC breathes more. */
const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, android: 25, ios: 40, pc: 50 },
  print_step: { default: 2, android: 3, ios: 4, pc: 5 },
  print_strategy: 'fast' as const,
};

export function buildAgentReplyCard(input: AgentCardInput): FeishuCardV2 {
  // Apply Feishu-friendly markdown transformation once, up front.
  const optimizedText = optimizeMarkdownStyle(input.text, 2);
  const optimizedThinking = input.thinking
    ? optimizeMarkdownStyle(input.thinking, 2)
    : undefined;

  const explicitTitle = input.title?.trim();
  const body = optimizedText.trim();

  // Header policy: always render a status-coloured header so the
  // streaming→terminal transition stays visually consistent (blue「生成中」→
  // violet「已完成」is a colour change, not a header that suddenly vanishes).
  // The header title is the explicit title when present, otherwise a minimal
  // status word ('已完成'/'已中断'/'出错') — NEVER the body's first line, which
  // was the root cause of the header/first-line duplication (issue #488). Using
  // a fixed status word for `done` keeps issue #488 fixed while still giving the
  // completed reply a clear status anchor.
  const headlineTitle = explicitTitle ?? statusHeadline(input.status);
  const summaryTitle = input.titlePrefix
    ? `${input.titlePrefix}${headlineTitle}`
    : headlineTitle;

  const normalizedInput: AgentCardInput = {
    ...input,
    text: optimizedText,
    title: explicitTitle,
    thinking: optimizedThinking,
  };

  const header = buildHeader(normalizedInput);
  const elements: Array<Record<string, unknown>> = [];
  if (body) {
    elements.push(...buildBodyChunks(body));
  }

  const metaRow = buildMetaRow(input.meta);
  const thinkingPanel = buildThinkingPanel(optimizedThinking);
  const toolsPanel = buildToolsPanel(input.meta?.toolCalls);
  const footer = buildFooter(input.footer, input.completedAtMs);

  const hasFooterArea =
    metaRow.length + thinkingPanel.length + toolsPanel.length + footer.length >
    0;
  if (hasFooterArea) {
    // Native v2 hr — components.md §hr confirms it's a valid component outside
    // of CardKit's live-streaming patch surface.
    elements.push({ tag: 'hr' });
  }

  elements.push(...metaRow);
  elements.push(...thinkingPanel);
  elements.push(...toolsPanel);
  elements.push(...footer);

  // Add feedback buttons for completed messages
  if (input.status === 'done') {
    elements.push(FEEDBACK_BUTTONS_V2);
  }

  const config: Record<string, unknown> = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
  };
  if (summaryTitle) {
    config.summary = { content: summaryTitle };
  }

  const card: FeishuCardV2 = {
    schema: '2.0',
    config,
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements,
    },
  };
  return card;
}

export interface StreamingCardBuildOptions {
  /** Initial text to seed into the MAIN_CONTENT slot. */
  initialText?: string;
  /** Optional override title (otherwise extracted from initialText). */
  title?: string;
  /** Optional title prefix (e.g. AI name). */
  titlePrefix?: string;
  /** Optional subtitle shown under the title. */
  subtitle?: string;
  /** Optional meta (currently only `model` is used for the header tag). */
  meta?: Pick<CardMeta, 'model'>;
  /** Initial content for structured runtime panels. */
  panels?: StreamingPanelsInit;
  /**
   * If true, use the "rich" structured skeleton (STATUS_BANNER + 4 collapsible
   * panels). If false, use the legacy flat skeleton (AUX_BEFORE/AUX_AFTER).
   * Default: true.
   */
  rich?: boolean;
}

export function buildStreamingAgentCard(
  opts: StreamingCardBuildOptions = {},
): FeishuCardV2 {
  const initialText = opts.initialText ?? '';
  // Header/summary title follows the same status-driven policy as the terminal
  // card: an explicit title wins, otherwise a minimal status word ("生成中") —
  // never the reply's first line. This keeps the streaming→terminal transition
  // consistent instead of moving the first line between header and body.
  const displayTitle = opts.title?.trim() || statusHeadline('running');
  const useRich = opts.rich !== false;

  const header = buildHeader({
    text: initialText,
    status: 'running',
    title: opts.title,
    titlePrefix: opts.titlePrefix,
    subtitle: opts.subtitle,
    meta: opts.meta ? { model: opts.meta.model } : undefined,
  });

  const mainContentEl = {
    tag: 'markdown',
    content: initialText || '...',
    element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
  };
  const interruptBtn = {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 中断回复' },
    type: 'danger',
    value: { action: 'interrupt_stream' },
    element_id: CARD_ELEMENT_IDS.INTERRUPT_BTN,
  };
  const footerNote = {
    tag: 'markdown',
    content: `<font color='grey'>${buildStatusBannerText({ phase: 'streaming' })}</font>`,
    element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
    text_size: 'notation',
  };

  const baseConfig = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
    summary: { content: displayTitle },
    streaming_mode: true,
    streaming_config: STREAMING_CONFIG,
  };

  if (!useRich) {
    return {
      schema: '2.0',
      config: baseConfig,
      header,
      body: {
        direction: 'vertical',
        vertical_spacing: 'medium',
        elements: [
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_BEFORE,
            text_size: 'notation',
          },
          mainContentEl,
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_AFTER,
            text_size: 'notation',
          },
          interruptBtn,
          {
            tag: 'markdown',
            content: '⏳ 生成中...',
            element_id: CARD_ELEMENT_IDS.STATUS_NOTE,
            text_size: 'notation',
          },
        ],
      },
    };
  }

  // Default panel expansion for the streaming skeleton:
  //   thinking → expanded so the user can watch reasoning stream in as it arrives
  //   tools / progress → folded to keep the card compact; STATUS_BANNER still
  //                       surfaces the active tool / todo count at the top.
  const panelsInit: StreamingPanelsInit = {
    expandThinking: true,
    expandTools: false,
    expandProgress: false,
    ...(opts.panels ?? {}),
  };

  return {
    schema: '2.0',
    config: baseConfig,
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements: [
        ...buildStreamingPanels(panelsInit),
        mainContentEl,
        interruptBtn,
        footerNote,
      ],
    },
  };
}
