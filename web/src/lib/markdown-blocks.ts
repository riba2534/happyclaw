/**
 * Top-level Markdown block helpers for streamed text. Pure functions shared by
 * the streaming renderer and the chat store.
 */

import { RAW_HTML_PATTERN } from './markdown/html-tags';

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Split Markdown at top-level block boundaries: blank lines outside code
 * fences and `$$` math, unless the next line continues the block (indented
 * content, or another item of the same list). Earlier blocks never change as
 * text is appended, so a streamed reply can render them once.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let inMath = false;
  let lastContentLine = '';
  let pendingBlank = false;

  const flush = () => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };

  for (const line of lines) {
    if (fence) {
      current.push(line);
      const close = FENCE_PATTERN.exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        line.trim() === close[1]
      ) {
        fence = null;
      }
      continue;
    }
    if (inMath) {
      current.push(line);
      if (line.trim() === '$$') inMath = false;
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) pendingBlank = true;
      current.push(line);
      continue;
    }
    if (pendingBlank) {
      const continues =
        /^[ \t]/.test(line) ||
        (LIST_ITEM_PATTERN.test(line) &&
          LIST_ITEM_PATTERN.test(lastContentLine));
      if (!continues) {
        // Blank lines stay with the block they end, so blocks join back
        // into exactly the original text.
        flush();
      }
      pendingBlank = false;
    }
    current.push(line);
    const open = FENCE_PATTERN.exec(line);
    if (open) fence = { char: open[1][0], length: open[1].length };
    else if (line.trim() === '$$') inMath = true;
    if (!/^[ \t]/.test(line)) lastContentLine = line;
  }
  flush();
  return blocks;
}

/**
 * `splitMarkdownBlocks(text)` reusing the split of an earlier `previous`
 * that `text` extends: only the previous last block and what follows it are
 * scanned again (earlier blocks never change as text is appended), so a long
 * streamed reply is not re-scanned in full on every render.
 */
export function extendMarkdownBlocks(
  previous: { text: string; blocks: string[] } | null,
  text: string,
): string[] {
  if (
    !previous ||
    previous.blocks.length === 0 ||
    text.length < previous.text.length ||
    !text.startsWith(previous.text)
  ) {
    return splitMarkdownBlocks(text);
  }
  const settled = previous.blocks.slice(0, -1);
  let offset = 0;
  for (const block of settled) offset += block.length + 1;
  return settled.concat(splitMarkdownBlocks(text.slice(offset)));
}

/**
 * The last blocks of `text` totalling about `keep` characters, for previews
 * that only show a tail (sub-agent progress). Cutting at a block boundary
 * keeps fences and tables intact.
 */
export function markdownTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const blocks = splitMarkdownBlocks(text);
  let size = 0;
  let start = blocks.length;
  while (start > 0 && size + blocks[start - 1].length <= keep) {
    start -= 1;
    size += blocks[start].length + 1;
  }
  if (start === blocks.length) {
    // One block longer than the budget: fall back to its last lines. A code
    // block keeps its opening fence line, or the tail would render as prose
    // and every later fence would flip.
    const last = blocks[blocks.length - 1];
    const cut = last.indexOf('\n', last.length - keep);
    const lines = cut >= 0 ? last.slice(cut + 1) : last.slice(-keep);
    const firstLine = last.slice(0, Math.max(0, last.indexOf('\n')));
    const fence = FENCE_PATTERN.test(firstLine) ? `${firstLine}\n` : '';
    return `…\n\n${fence}${lines}`;
  }
  return `…\n\n${blocks.slice(start).join('\n')}`;
}

/** Calls `visit` for every line outside fenced code, with its fence state. */
function scanOutsideFences(
  text: string,
  visit: (line: string) => void,
): boolean {
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_PATTERN.exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        line.trim() === close[1]
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_PATTERN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    visit(line);
  }
  return fence !== null;
}

/** True when `text` ends inside a code fence that has not closed yet. */
export function endsInOpenFence(text: string): boolean {
  return scanOutsideFences(text, () => {});
}

const LINK_DEFINITION_PATTERN = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
const FOOTNOTE_DEFINITION_PATTERN = /^ {0,3}\[\^[^\]\s]+\]:/;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^[^\]\s]+\]/;

/**
 * Definitions that resolve across the whole document: reference-style link
 * definitions (`[ref]: url`) and footnotes (`[^1]` / `[^1]: …`).
 */
export function findMarkdownDefinitions(text: string): {
  links: string[];
  footnotes: boolean;
} {
  const links: string[] = [];
  let footnotes = false;
  // Cheap native checks first: streamed replies call this on every render.
  if (!text.includes(']:') && !text.includes('[^')) {
    return { links, footnotes };
  }
  scanOutsideFences(text, (line) => {
    if (LINK_DEFINITION_PATTERN.test(line)) links.push(line.trim());
    else if (
      FOOTNOTE_DEFINITION_PATTERN.test(line) ||
      FOOTNOTE_REFERENCE_PATTERN.test(line)
    ) {
      footnotes = true;
    }
  });
  return { links, footnotes };
}

/** Inline code spans on one line (a span over several lines stays in). */
const INLINE_CODE_SPAN = /(`+)(?!`)[^\n]*?[^`]\1(?!`)|(`+)(?!`)[^`\n]\2(?!`)/g;

/**
 * Raw HTML the sanitizer keeps, written as HTML rather than shown as code:
 * outside fenced code and inline code spans. `<div>` in a React snippet or
 * `` `<br>` `` in prose is text, not markup.
 */
export function hasRawHtmlOutsideCode(text: string): boolean {
  if (!RAW_HTML_PATTERN.test(text)) return false;
  let found = false;
  scanOutsideFences(text, (line) => {
    if (!found && RAW_HTML_PATTERN.test(line.replace(INLINE_CODE_SPAN, ''))) {
      found = true;
    }
  });
  return found;
}

/**
 * Block-by-block rendering matches whole-document rendering unless the text
 * relies on document-wide definitions (reference links, footnotes) or raw
 * HTML that may wrap several blocks (`<details>` around paragraphs).
 */
export function canRenderBlockwise(text: string): boolean {
  if (hasRawHtmlOutsideCode(text)) return false;
  const { links, footnotes } = findMarkdownDefinitions(text);
  return links.length === 0 && !footnotes;
}
