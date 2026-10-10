/**
 * Top-level Markdown block helpers for streamed text. Pure functions shared by
 * the streaming renderer and the chat store.
 */

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
    // One block longer than the budget: fall back to its last lines.
    const last = blocks[blocks.length - 1];
    const cut = last.indexOf('\n', last.length - keep);
    return `…\n\n${cut >= 0 ? last.slice(cut + 1) : last.slice(-keep)}`;
  }
  return `…\n\n${blocks.slice(start).join('\n')}`;
}
