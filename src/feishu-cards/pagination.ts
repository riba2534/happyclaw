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
  /**
   * GFM tables allowed on one page. Bounds each page's search window before
   * any `fits` probe, so table-dense answers never measure huge candidates.
   */
  maxTables?: number;
}

/**
 * A fenced code block or GFM table located in Markdown source. Offsets are
 * UTF-16 indices into the scanned text; `end` includes the closing line's
 * newline. `prefix` is the syntax to replay on a continuation (opener line, or
 * table header + delimiter row); `suffix` closes a split fence.
 */
export interface MarkdownBlock {
  kind: 'fence' | 'table';
  start: number;
  end: number;
  prefix: string;
  suffix: string;
  /** Fence marker (``` / ~~~ / ````…); empty for tables. */
  marker: string;
  /** False for a fence the upstream stream has not closed yet. */
  closed: boolean;
}

/** CommonMark fence opener; a backtick info string may not contain backticks. */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/;
/**
 * GFM delimiter row, including single-column tables (`|---|`). A pipe is
 * required so a bare `---` thematic break / setext underline never matches.
 */
const TABLE_DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

export function isMarkdownTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && TABLE_DELIMITER.test(trimmed);
}

/** Fence opener marker for a line, or null when the line opens no fence. */
export function markdownFenceOpener(line: string): string | null {
  const opener = line.match(FENCE_OPENER);
  if (!opener || (opener[1][0] === '`' && opener[2].includes('`'))) return null;
  return opener[1];
}

/** Whether `line` closes a fence opened with `marker`. */
export function closesMarkdownFence(line: string, marker: string): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[\t \r]*\n?$/);
  return Boolean(
    match && match[1][0] === marker[0] && match[1].length >= marker.length,
  );
}

/**
 * Locate fenced code blocks (``` / ~~~ / longer fences, any info string such
 * as ```c++) and GFM tables in one linear pass. Tables inside fences are
 * literal code and never reported.
 */
export function findMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0];
    const start = lines[i].index!;
    const marker = markdownFenceOpener(line);
    if (marker) {
      let end = text.length;
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closesMarkdownFence(lines[i][0], marker)) {
          end = lines[i].index! + lines[i][0].length;
          closed = true;
          break;
        }
      }
      blocks.push({
        kind: 'fence',
        start,
        // Include the final boundary when an upstream stream has not closed
        // the fence yet, so the independently rendered page still closes it.
        end: closed ? end : end + 1,
        prefix: `${line.replace(/\r?\n$/, '')}\n`,
        suffix: `\n${marker}\n`,
        marker,
        closed,
      });
      continue;
    }
    const table =
      line.includes('|') &&
      lines[i + 1] !== undefined &&
      isMarkdownTableDelimiter(lines[i + 1][0]);
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
        kind: 'table',
        start,
        end: last.index! + last[0].length,
        prefix,
        suffix: '',
        marker: '',
        closed: true,
      });
      i--;
    }
  }
  return blocks;
}

/** GFM tables outside fenced code. Feishu limits these per Markdown element. */
export function countMarkdownTables(text: string): number {
  if (!text.includes('|') || !text.includes('-')) return 0;
  let tables = 0;
  for (const block of findMarkdownBlocks(text))
    if (block.kind === 'table') tables++;
  return tables;
}

const markdownBlocks = findMarkdownBlocks;

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
  const tables = blocks.filter((block) => block.kind === 'table');
  /** Source offset where a page starting at `start` must end at the latest. */
  const tableCap = (start: number): number => {
    if (options.maxTables === undefined) return text.length;
    let seen = 0;
    for (const table of tables) {
      if (table.end <= start) continue;
      if (++seen > options.maxTables && table.start > start) return table.start;
    }
    return text.length;
  };
  const containing = (offset: number) =>
    blocks.find((block) => offset > block.start && offset < block.end);
  const render = (start: number, end: number) =>
    (containing(start)?.prefix ?? '') +
    text.slice(start, end) +
    (containing(end)?.suffix ?? '');

  // Check the complete answer before seeking any semantic boundary. A block
  // beginning near the top must never turn an otherwise fitting answer into
  // a nearly empty introduction card and a separate opening-fence card.
  if (
    !options.frozenBoundaries?.length &&
    tableCap(0) === text.length &&
    fits(render(0, text.length))
  ) {
    return [{ rawStart: 0, rawEnd: text.length, text: render(0, text.length) }];
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
  // A capacity predicate can build complete live/final cards. Repeated fence
  // languages share the same continuation, so measure that syntax once per
  // pagination call rather than rebuilding cards once per source block.
  const continuationFits = new Map<string, boolean>();
  const fitsContinuation = (block: MarkdownBlock): boolean => {
    const value = block.prefix + block.suffix;
    const cached = continuationFits.get(value);
    if (cached !== undefined) return cached;
    const accepted = fits(value);
    continuationFits.set(value, accepted);
    return accepted;
  };
  // Evaluated lazily, only for blocks overlapping a page that actually has to
  // be cut. Appending to a long streamed answer re-plans with frozen earlier
  // pages; probing every historical table row there cost hundreds of full
  // card builds per flush even though no frozen page could be re-cut.
  const indivisibleCache = new Map<MarkdownBlock, boolean>();
  const isIndivisible = (block: MarkdownBlock): boolean => {
    const cached = indivisibleCache.get(block);
    if (cached !== undefined) return cached;
    const value =
      !fitsContinuation(block) ||
      (!block.suffix &&
        text
          .slice(block.start + block.prefix.length, block.end)
          .split('\n')
          .some((row) => !fits(block.prefix + row + '\n')));
    indivisibleCache.set(block, value);
    return value;
  };
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
      const cap = tableCap(start);
      if (cap === text.length && fits(pageText(start, text.length))) {
        pages.push({
          rawStart: start,
          rawEnd: text.length,
          text: pageText(start, text.length),
        });
        break;
      }
      const startIndex = indexAt(start);
      let low = startIndex;
      let high = cap === text.length ? pointCount : indexAt(cap);
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
          blocks.some(
            (block) =>
              block.start < end && block.end > start && isIndivisible(block),
          )
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
