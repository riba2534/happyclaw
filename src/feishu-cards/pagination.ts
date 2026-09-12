import { unicodeCodePointLength } from './capacity.js';

/** A rendered page plus its exact, contiguous span in the original text. */
export interface CardPage {
  rawStart: number;
  rawEnd: number;
  text: string;
}

export interface CardPageOptions {
  /** Optional raw/rendered UTF-8 bound; defaults to 18KB for legacy callers. */
  maxBytes?: number;
  /** Unicode code points, including repeated headers and repaired fences. */
  maxChars?: number;
  /** Test the complete rendered card(s), including JSON escaping and layout. */
  fits?: (pageText: string) => boolean;
  /** Absolute source offsets of pages already frozen by the caller. */
  frozenBoundaries?: readonly number[];
  /** Keep provider-accepted pages when only the remaining page budget shrinks. */
  preserveFrozenCapacity?: boolean;
}

interface MarkdownBlock {
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0];
    const start = lines[i].index!;
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      const marker = opener[1];
      const closing = new RegExp(
        `^ {0,3}${marker[0]}{${marker.length},}[\\t \\r]*\\n?$`,
      );
      let end = text.length;
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closing.test(lines[i][0])) {
          end = lines[i].index! + lines[i][0].length;
          closed = true;
          break;
        }
      }
      blocks.push({
        start,
        // Include the final boundary when an upstream stream has not closed
        // the fence yet, so the independently rendered page still closes it.
        end: closed ? end : end + 1,
        prefix: `${line.replace(/\r?\n$/, '')}\n`,
        suffix: `\n${marker}\n`,
      });
      continue;
    }
    const separator = lines[i + 1]?.[0].trim() ?? '';
    const table =
      line.includes('|') &&
      /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(separator);
    if (table) {
      const prefix = line + lines[i + 1][0];
      i += 2;
      while (
        i < lines.length &&
        lines[i][0].trim() &&
        lines[i][0].includes('|')
      )
        i++;
      const last = lines[i - 1];
      blocks.push({
        start,
        end: last.index! + last[0].length,
        prefix,
        suffix: '',
      });
      i--;
    }
  }
  return blocks;
}

/**
 * Preserve every source character across capacity-bounded cards. `fits` can
 * measure the actual live and final JSON, while source spans remain independent
 * of synthetic Markdown syntax. Existing callers can still use a byte budget.
 */
export function splitCardPages(
  text: string,
  options: CardPageOptions = {},
): CardPage[] {
  const maxBytes =
    options.maxBytes ??
    (options.fits || options.maxChars !== undefined ? Infinity : 18_000);
  const maxChars = options.maxChars ?? Infinity;
  if (
    maxBytes !== Infinity &&
    (!Number.isInteger(maxBytes) || maxBytes < 256)
  ) {
    throw new Error('Card page budget must be at least 256 bytes');
  }
  if (maxChars !== Infinity && (!Number.isInteger(maxChars) || maxChars < 1)) {
    throw new Error('Card page character budget must be a positive integer');
  }
  const fits = (value: string) =>
    (maxBytes === Infinity || Buffer.byteLength(value) <= maxBytes) &&
    (maxChars === Infinity || unicodeCodePointLength(value) <= maxChars) &&
    (options.fits?.(value) ?? true);
  if (!text) return [{ rawStart: 0, rawEnd: 0, text: '' }];
  const blocks = markdownBlocks(text);
  const containing = (offset: number) =>
    blocks.find((block) => offset > block.start && offset < block.end);
  const render = (start: number, end: number) =>
    (containing(start)?.prefix ?? '') +
    text.slice(start, end) +
    (containing(end)?.suffix ?? '');

  // Check the complete answer before seeking any semantic boundary. A block
  // beginning near the top must never turn an otherwise fitting answer into
  // a nearly empty introduction card and a separate opening-fence card.
  const fullText = render(0, text.length);
  if (!options.frozenBoundaries?.length && fits(fullText)) {
    return [{ rawStart: 0, rawEnd: text.length, text: fullText }];
  }

  // Most source text has identical code-point and UTF-16 indices. Allocate an
  // index only for astral characters, and only after the one-card fast path.
  // Avoid an O(n) Map of every offset on each nested builder capacity probe.
  let offsets: number[] | undefined;
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) {
    offsets = [0];
    for (const point of text)
      offsets.push(offsets[offsets.length - 1] + point.length);
  }
  const pointCount = offsets ? offsets.length - 1 : text.length;
  const offsetAt = (index: number) => (offsets ? offsets[index] : index);
  const indexAt = (offset: number) => {
    if (!offsets) return offset;
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return offsets[low] === offset ? low : -1;
  };
  const maxSuffixChars = blocks.reduce(
    (maximum, block) => Math.max(maximum, unicodeCodePointLength(block.suffix)),
    0,
  );

  // An oversized header, fence info string or table row cannot be repeated
  // safely. Degrade from the affected page, preserving earlier frozen pages.
  const indivisible = blocks.filter(
    (block) =>
      !fits(block.prefix + block.suffix) ||
      (!block.suffix &&
        text
          .slice(block.start + block.prefix.length, block.end)
          .split('\n')
          .some((row) => !fits(block.prefix + row + '\n'))),
  );
  const paginate = (
    rawFallback: boolean,
    precedingPages: CardPage[] = [],
  ): CardPage[] => {
    const notice = '> 内容较长，以下按原文分段展示。\n\n';
    // Extremely small custom budgets may not even fit the explanatory notice.
    // Keep the source deliverable in that case, without an unbounded prefix.
    const rawPrefix =
      rawFallback && fits(notice + String.fromCodePoint(text.codePointAt(0)!))
        ? notice
        : '';
    const pageText = rawFallback
      ? (start: number, end: number) => rawPrefix + text.slice(start, end)
      : render;
    const pages: CardPage[] = [...precedingPages];
    let start = pages.at(-1)?.rawEnd ?? 0;
    let frozenIndex = pages.length;
    let preserveFrozen = true;
    while (start < text.length) {
      const forcedEnd = options.frozenBoundaries?.[frozenIndex];
      if (preserveFrozen && forcedEnd !== undefined) {
        if (
          forcedEnd > start &&
          forcedEnd <= text.length &&
          Number.isInteger(forcedEnd) &&
          indexAt(forcedEnd) !== -1 &&
          (options.preserveFrozenCapacity || fits(pageText(start, forcedEnd)))
        ) {
          pages.push({
            rawStart: start,
            rawEnd: forcedEnd,
            text: pageText(start, forcedEnd),
          });
          start = forcedEnd;
          frozenIndex++;
          continue;
        }
        // Changed capacity/layout can require a shorter page. Preserve the
        // preceding frozen prefix and reflow only from the first affected page.
        preserveFrozen = false;
      }
      if (fits(pageText(start, text.length))) {
        pages.push({
          rawStart: start,
          rawEnd: text.length,
          text: pageText(start, text.length),
        });
        break;
      }
      const startIndex = indexAt(start);
      let low = startIndex;
      let high = pointCount;
      if (maxChars !== Infinity) {
        const prefix = rawFallback
          ? rawPrefix
          : (containing(start)?.prefix ?? '');
        high = Math.max(
          startIndex,
          Math.min(
            high,
            startIndex + maxChars - unicodeCodePointLength(prefix),
          ),
        );
        if (!options.fits && maxBytes === Infinity) {
          // With only a content-field character limit, the largest raw span is
          // known directly. Only fence repair can reduce it, by a few chars.
          low = Math.max(startIndex, high - (rawFallback ? 0 : maxSuffixChars));
        }
      }
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(pageText(start, offsetAt(mid)))) low = mid;
        else high = mid - 1;
      }
      let end = offsetAt(low);
      if (end <= start) {
        if (!rawFallback) return paginate(true, pages);
        throw new Error('Card capacity cannot fit one source character');
      }
      if (!rawFallback) {
        if (
          indivisible.some((block) => block.start < end && block.end > start)
        ) {
          return paginate(true, pages);
        }
        const candidateBlock = containing(end);
        // Prefer semantic boundaries only near the actual capacity. Otherwise
        // split long prose/code lines and repair the surrounding fence.
        const minimumIndex = startIndex + Math.ceil((low - startIndex) * 0.9);
        const minimumEnd = offsetAt(minimumIndex);
        const paragraph = text.lastIndexOf('\n\n', end - 1) + 2;
        const newline = text.lastIndexOf('\n', end - 1) + 1;
        const candidates = [
          candidateBlock?.start ?? 0,
          ...(!candidateBlock ? [paragraph] : []),
          newline,
        ];
        const semanticEnd = candidates.find(
          (candidate) =>
            candidate >= minimumEnd &&
            candidate <= end &&
            candidate > start &&
            fits(pageText(start, candidate)),
        );
        if (semanticEnd !== undefined) end = semanticEnd;

        // Tables need complete rows; a mid-row split cannot be repaired by
        // repeating the header. Prefer the preceding row even if its boundary
        // is less dense, provided that at least one data row stays on the page.
        const table = containing(end);
        if (table && !table.suffix && text[end - 1] !== '\n') {
          const rowEnd = text.lastIndexOf('\n', end - 1) + 1;
          const dataStart = Math.max(start, table.start + table.prefix.length);
          if (rowEnd <= dataStart || !fits(pageText(start, rowEnd))) {
            return paginate(true, pages);
          }
          end = rowEnd;
        }
      }
      const value = pageText(start, end);
      // The callback may include Markdown-dependent rendering; validate the
      // selected boundary again rather than assuming its cost is raw bytes.
      if (!fits(value)) {
        if (!rawFallback) return paginate(true, pages);
        throw new Error('Card capacity rejected the selected source span');
      }
      pages.push({ rawStart: start, rawEnd: end, text: value });
      start = end;
    }
    return pages;
  };

  return paginate(false);
}
