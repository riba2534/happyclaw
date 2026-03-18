export type MessageIntent = 'stop' | 'correction' | 'continue';

// Keywords that trigger stop/correction intent.
// ALL keywords use exact-match only to avoid false positives when a keyword
// appears as part of a normal sentence (e.g. "取消订单", "cancel the order").
const STOP_KEYWORDS = [
  '停',
  '暂停',
  '停止',
  '停下',
  '算了',
  '取消',
  '不用了',
  '别说了',
  '不要了',
  '够了',
  '闭嘴',
  '住嘴',
  '别回了',
  'stop',
  'cancel',
  'abort',
  'halt',
  'enough',
  'hold on',
  'nevermind',
  'shut up',
  'wait',
  'esc',
  'やめて',
  '止めて',
];
const CORRECTION_KEYWORDS = [
  '不对',
  '错了',
  '等等',
  '重来',
  '改一下',
  '换个方式',
  'wrong',
  'redo',
  'fix',
  'correct',
  'try again',
  'retry',
];

const MAX_SHORT_MESSAGE_LENGTH = 50;

export function analyzeIntent(text: string): MessageIntent {
  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_MESSAGE_LENGTH) {
    return 'continue';
  }

  const lower = trimmed.toLowerCase();

  // Exact match only — the entire message must be the keyword
  for (const kw of STOP_KEYWORDS) {
    if (lower === kw) return 'stop';
  }
  for (const kw of CORRECTION_KEYWORDS) {
    if (lower === kw) return 'correction';
  }

  return 'continue';
}
