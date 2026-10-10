// Day separators in the chat transcript. Recent days read as "今天" / "昨天" /
// a weekday; older ones keep the full date. Every label carries the full
// date (with weekday) as its tooltip.

// Intl.DateTimeFormat construction is expensive; share one instance per shape.
const FULL_DATE = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const FULL_DATE_WITH_WEEKDAY = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});
const WEEKDAY = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });

export interface ChatDateLabel {
  label: string;
  title: string;
}

/** Local calendar day as one integer, for caching a label per day. */
export function localDayKey(date: Date): number {
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
}

/** Midnight that starts the local calendar day of `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Milliseconds until the next local midnight (DST-safe). */
export function msUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Whole calendar days from `date` back from `now`; 0 is the same day. */
function calendarDaysAgo(date: Date, now: Date): number {
  // UTC of the local calendar dates, so DST shifts don't skew the count.
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - day) / 86_400_000);
}

/**
 * Label for the separator above a day's messages. Weeks start on Monday, so
 * on a Wednesday "星期一" is this week's Monday and anything older shows its
 * date.
 */
export function formatChatDateLabel(date: Date, now: Date): ChatDateLabel {
  const title = FULL_DATE_WITH_WEEKDAY.format(date);
  const daysAgo = calendarDaysAgo(date, now);
  if (daysAgo === 0) return { label: '今天', title };
  if (daysAgo === 1) return { label: '昨天', title };
  const daysSinceMonday = (now.getDay() + 6) % 7;
  if (daysAgo > 1 && daysAgo <= daysSinceMonday) {
    return { label: WEEKDAY.format(date), title };
  }
  return { label: FULL_DATE.format(date), title };
}
