/**
 * Feishu Markdown Style Optimizer
 *
 * Pre-processes standard Markdown text for optimal rendering in Feishu cards.
 * Adapted from openclaw-lark (MIT license).
 *
 * Key transformations:
 * - Heading demotion: H1 → H4, H2~H6 → H5 (card headings are visually too large)
 * - Code block protection: preserved untouched during processing
 * - Table spacing: <br> padding around tables
 * - Consecutive heading spacing: <br> between adjacent headings
 * - Blank line compression: 3+ → 2
 * - Invalid image cleanup: strip non-img_ image references
 */

import { findMarkdownBlocks } from './feishu-cards/pagination.js';

/**
 * Optimize Markdown style for Feishu card rendering.
 *
 * @param text - Raw Markdown text
 * @param cardVersion - Card schema version (1 = no <br>, 2 = with <br> spacing)
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    return _optimizeMarkdownStyle(text, cardVersion);
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // ── 1. Extract code blocks, protect with placeholders ──────────
  const { content, codeBlocks, tokenPattern } = protectFencedCode(text);
  let r = content;

  // ── 2. Heading demotion ────────────────────────────────────────
  // Only demote when the original text contains H1~H3
  // Process H2~H6 first, then H1 (order matters to avoid double-matching)
  const hasH1toH3 = /^#{1,3} /m.test(r);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1'); // H1 → H4
  }

  if (cardVersion >= 2) {
    // ── 3. Consecutive heading spacing ─────────────────────────────
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

    // ── 4. Table spacing ───────────────────────────────────────────
    // One linear pass over real GFM tables (header + delimiter row). The
    // former regex chain also matched pipe-heavy prose and was quadratic on a
    // long `a|b|c…` line, which stalled the event loop on every flush.
    r = spaceMarkdownTables(r);

    // Add spacing while the code itself is still protected. An unfinished
    // upstream fence must not acquire a literal <br> inside its code body.
    r = r.replace(tokenPattern, (token, index: string) =>
      codeBlocks[Number(index)].closed
        ? `\n<br>\n${token}\n<br>\n`
        : `\n<br>\n${token}`,
    );
  }

  // Cleanup only prose: code blank lines and image syntax are literal data.
  r = r.replace(/\n{3,}/g, '\n\n');
  r = stripInvalidImageKeys(r);

  // Function replacers preserve literal $&, $', $`, and $1 in source code.
  // Restore every placeholder in one pass. Replacing each block separately
  // rescans/copies the growing answer once per fence and becomes quadratic
  // for long answers containing thousands of short examples.
  r = r.replace(
    tokenPattern,
    (_token, index: string) => codeBlocks[Number(index)].source,
  );

  return r;
}

/** Protect CommonMark backtick/tilde fences, including an unfinished tail. */
function protectFencedCode(text: string): {
  content: string;
  codeBlocks: Array<{ token: string; source: string; closed: boolean }>;
  tokenPattern: RegExp;
} {
  let prefix = '\uE000HC_CODE_';
  while (text.includes(prefix)) prefix += '_';
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const codeBlocks: Array<{ token: string; source: string; closed: boolean }> =
    [];
  let content = '';
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const opener = lines[i][0].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (!opener || (opener[1][0] === '`' && opener[2].includes('`'))) continue;
    const start = lines[i].index!;
    const closing = new RegExp(
      `^ {0,3}${opener[1][0]}{${opener[1].length},}[\\t \\r]*\\n?$`,
    );
    let end = text.length;
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (closing.test(lines[i][0])) {
        // Keep the line ending outside the protected span so surrounding
        // prose retains its original block boundary when the token is used.
        end = lines[i].index! + lines[i][0].replace(/\r?\n$/, '').length;
        closed = true;
        break;
      }
    }
    const token = `${prefix}${codeBlocks.length}\uE001`;
    codeBlocks.push({ token, source: text.slice(start, end), closed });
    content += text.slice(cursor, start) + token;
    cursor = end;
  }
  return {
    content: content + text.slice(cursor),
    codeBlocks,
    tokenPattern: new RegExp(`${prefix}(\\d+)\uE001`, 'g'),
  };
}

// ---------------------------------------------------------------------------
// Table spacing
// ---------------------------------------------------------------------------

const DEMOTED_HEADING = /^#{4,5} /;

/**
 * Pad each GFM table with `<br>` lines so Feishu card Markdown renders it as
 * a separate block. Only header + delimiter-row tables qualify: prose such as
 * `|x| 表示绝对值` and rows without a trailing pipe are left intact.
 *
 * Spacing reproduces the long-standing card layout:
 * - prose line before → `P\n<br>\nTABLE`; a `**bold**` line keeps a blank
 *   line after the `<br>`; a demoted heading keeps `P\n\n<br>\n\nTABLE`;
 * - a table at the very start gets no leading `<br>`;
 * - after the table → `TABLE\n<br>\n…`, except that a directly following
 *   heading or bold line stays separated by a blank line.
 */
function spaceMarkdownTables(text: string): string {
  if (!text.includes('|')) return text;
  const tables = findMarkdownBlocks(text).filter(
    (block) => block.kind === 'table',
  );
  if (tables.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const table of tables) {
    const segment = text.slice(cursor, table.start);
    const head = segment.replace(/\n+$/, '');
    let gap = segment.length - head.length;
    let previousLine: string | undefined;
    if (head) {
      parts.push(head);
      previousLine = head.slice(head.lastIndexOf('\n') + 1);
    } else if (parts.length > 0) {
      // Only blank lines since the previous table: its trailing `<br>` line
      // is the preceding prose for this one.
      const last = parts.pop()!;
      const trimmed = last.replace(/\n+$/, '');
      gap += last.length - trimmed.length;
      parts.push(trimmed);
      previousLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    }

    if (previousLine === undefined) {
      // Nothing but blank lines before a leading table.
      parts.push(gap >= 2 ? `${segment}<br>\n\n` : segment);
    } else if (gap >= 3 || DEMOTED_HEADING.test(previousLine)) {
      parts.push('\n\n<br>\n\n');
    } else if (previousLine.startsWith('**')) {
      parts.push('\n<br>\n\n');
    } else {
      parts.push('\n<br>\n');
    }

    const body = text.slice(table.start, table.end);
    parts.push(body.endsWith('\n') ? body : `${body}\n`);
    const nextBreak = text.indexOf('\n', table.end);
    const nextLine =
      table.end >= text.length
        ? ''
        : text.slice(table.end, nextBreak < 0 ? text.length : nextBreak);
    parts.push(
      nextLine && (DEMOTED_HEADING.test(nextLine) || nextLine.startsWith('**'))
        ? '\n<br>\n'
        : '<br>\n',
    );
    cursor = table.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** Malformed `![` attempts tolerated per line before the rest is left as is. */
const MAX_FAILED_IMAGE_PARSES_PER_LINE = 64;
const MAX_IMAGE_ALT_CHARS = 4096;

interface InlineImage {
  /** Offset just past the closing `)`. */
  end: number;
  alt: string;
  destination: string;
}

/** Parse a CommonMark inline image starting at `![` (single line). */
function parseInlineImage(line: string, at: number): InlineImage | null {
  let i = at + 2;
  let depth = 0;
  const altLimit = Math.min(line.length, i + MAX_IMAGE_ALT_CHARS);
  for (; i < altLimit; i++) {
    const ch = line[i];
    if (ch === '\\') i++;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (line[i] !== ']' || line[i + 1] !== '(') return null;
  const alt = line.slice(at + 2, i);
  i += 2;
  while (line[i] === ' ' || line[i] === '\t') i++;

  let destination: string;
  if (line[i] === '<') {
    const close = line.indexOf('>', i + 1);
    if (close < 0) return null;
    destination = line.slice(i + 1, close);
    i = close + 1;
  } else {
    const start = i;
    let parens = 0;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t') break;
      if (ch === '(') parens++;
      else if (ch === ')') {
        if (parens === 0) break;
        parens--;
      }
    }
    destination = line.slice(start, i);
  }

  while (line[i] === ' ' || line[i] === '\t') i++;
  const opener = line[i];
  if (opener === '"' || opener === "'" || opener === '(') {
    const closer = opener === '(' ? ')' : opener;
    const close = line.indexOf(closer, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (line[i] === ' ' || line[i] === '\t') i++;
  }
  if (line[i] !== ')') return null;
  return { end: i + 1, alt, destination };
}

/** Destination of a link whose text ends right before `offset` (`](…)`). */
function wrappingLinkDestination(line: string, offset: number): string {
  if (line[offset] !== ']' || line[offset + 1] !== '(') return '';
  const close = line.indexOf(')', offset + 2);
  return close < 0 ? '' : line.slice(offset + 2, close).trim();
}

function stripImagesInProse(segment: string): string {
  if (!segment.includes('![')) return segment;
  let out = '';
  let cursor = 0;
  let searchFrom = 0;
  let failures = 0;
  for (;;) {
    const at = segment.indexOf('![', searchFrom);
    if (at < 0) break;
    const image = parseInlineImage(segment, at);
    if (!image) {
      searchFrom = at + 2;
      if (++failures >= MAX_FAILED_IMAGE_PARSES_PER_LINE) break;
      continue;
    }
    out += segment.slice(cursor, at);
    if (image.destination.startsWith('img_')) {
      out += segment.slice(at, image.end);
    } else if (segment[at - 1] === '[') {
      // Badge-style `[![alt](src)](href)`: removing the image entirely
      // would leave an invisible, empty link. Keep readable link text.
      out +=
        image.alt.trim() ||
        wrappingLinkDestination(segment, image.end) ||
        'link';
    }
    cursor = searchFrom = image.end;
  }
  return out + segment.slice(cursor);
}

/** Inline code spans on one line, as [start, end) pairs. */
function inlineCodeSpans(line: string): Array<[number, number]> {
  if (!line.includes('`')) return [];
  const runs: Array<{ start: number; length: number }> = [];
  const runPattern = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = runPattern.exec(line)))
    runs.push({ start: match.index, length: match[0].length });
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const list = byLength.get(run.length) ?? [];
    list.push(index);
    byLength.set(run.length, list);
  });
  const pointers = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < runs.length; ) {
    const run = runs[index];
    const list = byLength.get(run.length)!;
    let pointer = pointers.get(run.length) ?? 0;
    while (pointer < list.length && list[pointer] <= index) pointer++;
    pointers.set(run.length, pointer);
    if (pointer < list.length) {
      const closing = runs[list[pointer]];
      spans.push([run.start, closing.start + closing.length]);
      index = list[pointer] + 1;
    } else {
      index++;
    }
  }
  return spans;
}

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`). Prevents CardKit error 200570.
 *
 * HTTP URLs and local paths are stripped — only `img_xxx` keys are valid
 * in Feishu card markdown elements. Titles, `<…>` destinations and balanced
 * parentheses in URLs are understood; inline code spans stay literal.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('![')) return line;
      const spans = inlineCodeSpans(line);
      if (spans.length === 0) return stripImagesInProse(line);
      let out = '';
      let cursor = 0;
      for (const [start, end] of spans) {
        out += stripImagesInProse(line.slice(cursor, start));
        out += line.slice(start, end);
        cursor = end;
      }
      return out + stripImagesInProse(line.slice(cursor));
    })
    .join('\n');
}
