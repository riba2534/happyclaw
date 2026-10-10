export interface FeishuTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

export interface FeishuUsageNoteInput extends FeishuTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatFeishuTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '-';
  // Switch units where one-decimal rounding would print `1000.0K`.
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

/** Format Kaboo's five Claude token classes, with one authoritative total. */
export function formatFeishuTokenSummary(usage: FeishuTokenUsage): string {
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const reasoningTokens = tokenCount(usage.reasoningTokens);
  const totalTokens =
    inputTokens +
    outputTokens +
    cacheReadInputTokens +
    cacheCreationInputTokens +
    reasoningTokens;
  // Claude Agent SDK/provider adapters sometimes emit a usage envelope with
  // every class set to zero when billing data was not returned. Rendering that
  // as an authoritative "0 tokens" is misleading; a real report necessarily
  // has at least one positive class.
  if (totalTokens === 0) return 'Token 未上报';

  const details = [
    `输入 ${formatFeishuTokenCount(usage.inputTokens)}`,
    `输出 ${formatFeishuTokenCount(usage.outputTokens)}`,
  ];

  if (cacheReadInputTokens > 0) {
    details.push(`缓存读取 ${formatFeishuTokenCount(cacheReadInputTokens)}`);
  }
  if (cacheCreationInputTokens > 0) {
    details.push(
      `缓存写入 ${formatFeishuTokenCount(cacheCreationInputTokens)}`,
    );
  }
  if (reasoningTokens > 0) {
    details.push(`推理 ${formatFeishuTokenCount(reasoningTokens)}`);
  }

  return `${formatFeishuTokenCount(totalTokens)} tokens（${details.join(' · ')}）`;
}

export function formatFeishuUsageNote(usage: FeishuUsageNoteInput): string {
  const parts = [formatFeishuTokenSummary(usage)];
  if (usage.costUSD > 0) parts.push(`$${usage.costUSD.toFixed(4)}`);
  if (usage.durationMs > 0) {
    parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  }
  if (usage.numTurns > 1) parts.push(`${usage.numTurns} turns`);
  return `💰 ${parts.join(' · ')}`;
}
