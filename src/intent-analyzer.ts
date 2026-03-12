export type MessageIntent = 'stop' | 'correction' | 'continue';

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

// Short keywords that are common substrings of other words (e.g., "esc" in
// "describe", "fix" in "prefix") — only match exactly, never as substrings.
const EXACT_ONLY = new Set(['esc', 'wait', 'fix', 'correct', 'redo']);

export function analyzeIntent(text: string): MessageIntent {
  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_MESSAGE_LENGTH) {
    return 'continue';
  }

  const lower = trimmed.toLowerCase();

  // Exact match first
  for (const kw of STOP_KEYWORDS) {
    if (lower === kw) return 'stop';
  }
  for (const kw of CORRECTION_KEYWORDS) {
    if (lower === kw) return 'correction';
  }

  // Substring match (skip keywords that are common substrings of normal words)
  for (const kw of STOP_KEYWORDS) {
    if (!EXACT_ONLY.has(kw) && lower.includes(kw)) return 'stop';
  }
  for (const kw of CORRECTION_KEYWORDS) {
    if (!EXACT_ONLY.has(kw) && lower.includes(kw)) return 'correction';
  }

  return 'continue';
}
