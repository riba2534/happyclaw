/**
 * Format a thinking duration in milliseconds as a short human-readable label
 * for the Reasoning header (e.g. "已思考 3.2 秒" or "已思考 1 分 12 秒").
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '已思考 0 秒';
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `已思考 ${rounded} 秒`;
  }
  if (totalSeconds < 60) {
    return `已思考 ${Math.round(totalSeconds)} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  if (seconds === 0) return `已思考 ${minutes} 分`;
  return `已思考 ${minutes} 分 ${seconds} 秒`;
}
