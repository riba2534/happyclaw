/** The usage fields the metrics below read; every field is optional. */
export interface UsageMetricsInput {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  streamOutputTokens?: number;
  streamMs?: number;
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Share of the prompt read from the provider's cache, 0–1: cache reads over
 * all input (uncached, cache reads and cache writes). `null` without input.
 */
export function cacheHitRate(usage: UsageMetricsInput): number | null {
  const read = count(usage.cacheReadInputTokens);
  const total =
    count(usage.inputTokens) + read + count(usage.cacheCreationInputTokens);
  return total > 0 ? read / total : null;
}

/**
 * Generation speed in output tokens per second over the time the streamed
 * calls spent generating; prefill, tool runs and waits are excluded. `null`
 * when no call was timed (older replies, non-streaming providers).
 */
export function generationTokensPerSecond(
  usage: UsageMetricsInput,
): number | null {
  const tokens = count(usage.streamOutputTokens);
  const ms = count(usage.streamMs);
  return tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null;
}

export function formatHitRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function formatTokensPerSecond(tps: number): string {
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

// --- DeepSeek peak / off-peak pricing ---------------------------------------
//
// DeepSeek's official pricing page: "北京时间周一至周五（不含中国法定节假日）
// 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
// 全天均为空闲时段", off-peak at half the peak price. Read literally, a make-up
// workday (调休上班) that falls on a weekend is still off-peak.

/** Statutory holidays (放假调休 days), from the State Council notices. */
const CN_HOLIDAY_RANGES: ReadonlyArray<readonly [string, string]> = [
  // 国办发明电〔2025〕7号
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
  // 国办发明电〔2026〕10号
  ['2027-01-01', '2027-01-03'],
  ['2027-02-05', '2027-02-13'],
  ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'],
  ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'],
  ['2027-10-01', '2027-10-07'],
];

/** Last year the holiday table covers; later years count weekdays only. */
export const CN_HOLIDAY_TABLE_LAST_YEAR = 2027;

const CN_HOLIDAYS: ReadonlySet<string> = (() => {
  const days = new Set<string>();
  for (const [from, to] of CN_HOLIDAY_RANGES) {
    const end = Date.parse(`${to}T00:00:00Z`);
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
      days.add(new Date(t).toISOString().slice(0, 10));
    }
  }
  return days;
})();

/** Peak windows, minutes after midnight Beijing time: [start, end). */
const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function isDeepSeekModel(model: string | null | undefined): boolean {
  return !!model && /deepseek/i.test(model);
}

export interface DeepSeekPricePeriod {
  peak: boolean;
  /** When the current period ends (the next switch between peak and off-peak). */
  until: Date;
}

/** Beijing-time wall clock of an instant, as fields of a UTC date. */
function beijingWallClock(at: Date): Date {
  return new Date(at.getTime() + BEIJING_OFFSET_MS);
}

function isPeakDay(wall: Date): boolean {
  const weekday = wall.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !CN_HOLIDAYS.has(wall.toISOString().slice(0, 10));
}

function isPeakAt(at: Date): boolean {
  const wall = beijingWallClock(at);
  if (!isPeakDay(wall)) return false;
  const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return DEEPSEEK_PEAK_WINDOWS.some(
    ([start, end]) => minute >= start && minute < end,
  );
}

/** Instants (UTC ms) where a peak window opens or closes on the given day. */
function boundariesOfDay(dayStartWallMs: number): number[] {
  return DEEPSEEK_PEAK_WINDOWS.flatMap(([start, end]) => [start, end]).map(
    (minute) => dayStartWallMs + minute * 60_000 - BEIJING_OFFSET_MS,
  );
}

/** DeepSeek's price period at an instant and when it next changes. */
export function deepSeekPricePeriod(at: Date): DeepSeekPricePeriod {
  const peak = isPeakAt(at);
  const wall = beijingWallClock(at);
  const todayWallStart = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
  );
  // A boundary only matters on a peak day; at most a long holiday plus a
  // weekend (well under 31 days) separates two peak days.
  for (let day = 0; day <= 31; day += 1) {
    const dayWallStart = todayWallStart + day * 86_400_000;
    if (!isPeakDay(new Date(dayWallStart))) continue;
    for (const boundary of boundariesOfDay(dayWallStart)) {
      if (boundary > at.getTime() && isPeakAt(new Date(boundary)) !== peak) {
        return { peak, until: new Date(boundary) };
      }
    }
  }
  return { peak, until: new Date(at.getTime() + 31 * 86_400_000) };
}
