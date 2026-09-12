import { splitCardPages } from './feishu-cards/pagination.js';
import { buildPostMdFallback } from './feishu-message-format.js';

// Defaults can be tightened for a provider rejection without changing source
// formatting or retrying an unchanged oversized physical message.
export const FEISHU_POST_MAX_BYTES = 150_000;
export const FEISHU_TEXT_MAX_BYTES = 150_000;

export interface FeishuMessageCapacityOptions {
  /** UTF-8 bytes of the inner `content` JSON, not its transport escaping. */
  maxBytes?: number;
}

function checkedBudget(value: number): number {
  if (!Number.isInteger(value) || value < 256) {
    throw new Error('Feishu message budget must be at least 256 bytes');
  }
  return value;
}

/**
 * Return original Markdown pages, adding only continuation syntax where
 * needed. Formatting is measured here and performed once at actual delivery;
 * pre-optimizing the returned text would apply heading/image changes twice.
 */
export function prepareFeishuPostTextPages(
  raw: string,
  options: FeishuMessageCapacityOptions = {},
): string[] {
  const maxBytes = checkedBudget(options.maxBytes ?? FEISHU_POST_MAX_BYTES);
  return splitCardPages(raw, {
    fits: (candidate) =>
      Buffer.byteLength(buildPostMdFallback(candidate)) <= maxBytes,
  }).map((page) => page.text);
}

/** Plain text has no Markdown interpretation or synthetic continuation text. */
export function prepareFeishuPlainTextPages(
  raw: string,
  options: FeishuMessageCapacityOptions = {},
): string[] {
  const maxBytes = checkedBudget(options.maxBytes ?? FEISHU_TEXT_MAX_BYTES);
  const fits = (text: string) =>
    Buffer.byteLength(JSON.stringify({ text })) <= maxBytes;
  if (fits(raw)) return [raw];

  // Only astral characters need a separate index. Never bisect a surrogate
  // pair when searching the largest source prefix that actually serializes.
  let offsets: number[] | undefined;
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(raw)) {
    offsets = [0];
    for (const point of raw)
      offsets.push(offsets[offsets.length - 1] + point.length);
  }
  const pointCount = offsets ? offsets.length - 1 : raw.length;
  const offsetAt = (point: number) => (offsets ? offsets[point] : point);
  const pages: string[] = [];
  let startPoint = 0;
  while (startPoint < pointCount) {
    const start = offsetAt(startPoint);
    if (fits(raw.slice(start))) {
      pages.push(raw.slice(start));
      break;
    }
    let low = startPoint;
    let high = pointCount;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(raw.slice(start, offsetAt(mid)))) low = mid;
      else high = mid - 1;
    }
    const capacityEnd = offsetAt(low);
    const sourcePayloadBytes = (end: number) =>
      Buffer.byteLength(JSON.stringify({ text: raw.slice(start, end) })) -
      Buffer.byteLength(JSON.stringify({ text: '' }));
    const minimumBytes = sourcePayloadBytes(capacityEnd) * 0.9;
    const paragraph = raw.lastIndexOf('\n\n', capacityEnd - 1) + 2;
    const newline = raw.lastIndexOf('\n', capacityEnd - 1) + 1;
    const semanticEnd = [paragraph, newline].find(
      (end) =>
        end > start &&
        end <= capacityEnd &&
        sourcePayloadBytes(end) >= minimumBytes,
    );
    const end = semanticEnd ?? capacityEnd;
    if (end <= start)
      throw new Error(
        'Feishu message capacity cannot fit one source character',
      );
    pages.push(raw.slice(start, end));
    if (!offsets) startPoint = end;
    else {
      // The preferred newline is a valid source boundary close to `low`.
      while (offsets[low] > end) low--;
      startPoint = low;
    }
  }
  return pages;
}
