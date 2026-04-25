/**
 * Top-level Feishu v2 Agent reply card builders.
 *
 *   buildAgentReplyCard(input)
 *       Terminal (static) card. Structured body: title + body with collapsible
 *       overflow sections + metadata row (2×2) + optional thinking/tool panels
 *       + footer. Suitable for finalized Agent replies and error cards.
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
  buildPriorSegmentsPanels,
  buildSubAgentPanels,
  buildCodexTodoPanel,
  buildCodexOperationsPanel,
  buildStreamingPanels,
  buildStatusBannerText,
  extractTitle,
  stripTitleFromBody,
  CARD_ELEMENT_IDS,
  type StreamingCardRuntimeProfile,
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

  const { title: autoTitle, bodyStartIndex } = extractTitle(optimizedText);
  const displayTitle = input.title ?? autoTitle;
  const body = stripTitleFromBody(optimizedText, bodyStartIndex);

  const normalizedInput: AgentCardInput = {
    ...input,
    text: optimizedText,
    thinking: optimizedThinking,
  };

  const header = buildHeader(normalizedInput);

  // New layout: Header → process panels (collapsed) → hr → Body → metaRow.
  //
  // Process-area panels in order of "abstract → concrete → prelude":
  //   1. codex todos/operations (Codex SDK process artifacts, when present)
  //   2. thinking     (what the agent was reasoning about)
  //   3. sub-agents   (discrete sub-tasks delegated to Task/Agent tools)
  //   4. prior text   (earlier assistant segments, closest to final Body)
  //
  // Note: tools panel intentionally omitted — per-tool stats clutter the
  //       final card; users care about sub-agent results, not tool counts.
  const thinkingPanel = buildThinkingPanel(optimizedThinking);
  const codexTodoPanel = buildCodexTodoPanel(input.codexTodos);
  const codexOperationsPanel = buildCodexOperationsPanel(input.codexOperations);
  const subAgentPanels = buildSubAgentPanels(input.subAgentResults);
  const priorSegmentsPanels = buildPriorSegmentsPanels(input.priorTextSegments);
  const metaRow = buildMetaRow(input.meta, input.completedAtMs);

  const elements: Array<Record<string, unknown>> = [];

  // ── Process area (all collapsed by default) ──
  elements.push(...codexTodoPanel);
  elements.push(...codexOperationsPanel);
  elements.push(...thinkingPanel);
  elements.push(...subAgentPanels);
  elements.push(...priorSegmentsPanels);

  const hasProcessArea =
    codexTodoPanel.length +
    codexOperationsPanel.length +
    thinkingPanel.length +
    subAgentPanels.length +
    priorSegmentsPanels.length > 0;

  // ── Divider between process area and main content ──
  if (hasProcessArea) {
    // Native v2 hr — components.md §hr confirms it's a valid component outside
    // of CardKit's live-streaming patch surface.
    elements.push({ tag: 'hr' });
  }

  // ── Main content (Body) ──
  elements.push(...buildBodyChunks(body || optimizedText.trim()));

  // ── Footer: metaRow carries timestamp (replaces the old standalone footer) ──
  elements.push(...metaRow);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: true,
      width_mode: 'fill',
      summary: { content: displayTitle },
    },
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements,
    },
  };
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
  /** Runtime profile controls streaming panel labels/placeholders. */
  runtimeProfile?: StreamingCardRuntimeProfile;
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
  const { title: autoTitle } = extractTitle(initialText);
  const displayTitle = opts.title ?? autoTitle ?? '...';
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
    content: `<font color='grey'>${buildStatusBannerText({
      phase: 'streaming',
      runtimeProfile: opts.runtimeProfile,
    })}</font>`,
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
    const statusNote =
      opts.runtimeProfile === 'codex' ? '⏳ Codex 处理中...' : '⏳ 生成中...';
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
            content: statusNote,
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
    runtimeProfile: opts.runtimeProfile,
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
