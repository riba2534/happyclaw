/**
 * Shared types for the Feishu v2 Agent reply card builder.
 *
 * The builder produces two shapes of cards from the same input surface:
 *   - Static (terminal) card: structured layout with collapsible sections.
 *   - Streaming card: slot-compatible skeleton (5 element_id slots) so the
 *     existing `feishu-streaming-card.ts` patch mechanism keeps working.
 */

export type CardStatus = 'running' | 'done' | 'warning' | 'error';

export interface ToolCallStat {
  name: string;
  count: number;
}

export interface CardMeta {
  /** Full model id, e.g. "claude-opus-4-7" — rendered as a short tag. */
  model?: string;
  /** Total wall-clock duration, in milliseconds. */
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Cached prompt tokens read this turn — surfaced so真实成本 isn't underestimated. */
  cacheReadInputTokens?: number;
  /** Prompt tokens written to cache this turn. */
  cacheCreationInputTokens?: number;
  costUSD?: number;
  numTurns?: number;
  /** Per-tool aggregated counts. Takes precedence over `toolCount`. */
  toolCalls?: ToolCallStat[];
  /** Simpler fallback when per-tool breakdown is not available. */
  toolCount?: number;
}

export interface AgentCardInput {
  /** Main reply body (markdown). Already untreated — builder applies Feishu markdown optimization. */
  text: string;
  /** Status controls header template and tag. */
  status: CardStatus;
  /** Override auto-extracted title. */
  title?: string;
  /** Optional title prefix (e.g. AI name). */
  titlePrefix?: string;
  /** Optional header subtitle (short summary shown under title). */
  subtitle?: string;
  /** Optional metadata block (duration / model / tokens / tools). */
  meta?: CardMeta;
  /** Optional thinking / reasoning dump (rendered as a collapsed panel). */
  thinking?: string;
  /** Optional footer note (source, session id, etc.). Rendered grey at notation size. */
  footer?: string;
  /**
   * Epoch milliseconds when the Agent finished replying. Appended to the
   * footer via Feishu's <local_datetime> tag so each viewer sees their own
   * timezone. Omit (or 0) to skip the timestamp.
   */
  completedAtMs?: number;
}

/** Opaque JSON shape for a Feishu v2 card. Consumers stringify it for the SDK. */
export type FeishuCardV2 = Record<string, unknown>;
