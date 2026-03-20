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

/**
 * Optimize Markdown style for Feishu card rendering.
 *
 * @param text - Raw Markdown text
 * @param cardVersion - Card schema version (1 = no <br>, 2 = with <br> spacing)
 */
export function optimizeMarkdownStyle(
  text: string,
  cardVersion = 2,
): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // ── 1. Extract code blocks, protect with placeholders ──────────
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // ── 2. Heading demotion ────────────────────────────────────────
  // Only demote when the original text contains H1~H3
  // Process H2~H6 first, then H1 (order matters to avoid double-matching)
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1'); // H1 → H4
  }

  if (cardVersion >= 2) {
    // ── 3. Consecutive heading spacing ─────────────────────────────
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

    // ── 4. Table spacing ───────────────────────────────────────────
    // 4a. Non-table line followed by table line → add blank line
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    // 4b. Table block preceded by blank line → insert <br>
    r = r.replace(
      /\n\n((?:\|.+\|[^\S\n]*\n?)+)/g,
      '\n\n<br>\n\n$1',
    );
    // 4c. Table block trailing → append <br>
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
    // 4d. Plain text before table: collapse extra blank lines
    r = r.replace(
      /^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm,
      '$1\n$2\n$3',
    );
    // 4d2. Bold text before table
    r = r.replace(
      /^(\*\*.+)\n\n(<br>)\n\n(\|)/gm,
      '$1\n$2\n\n$3',
    );
    // 4e. Plain text after table: collapse extra blank lines
    r = r.replace(
      /(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm,
      '$1$2$3',
    );

    // ── 5. Restore code blocks with <br> wrapping ──────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // ── 5. Restore code blocks (no <br>) ───────────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // ── 6. Compress excessive blank lines (3+ → 2) ────────────────
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`). Prevents CardKit error 200570.
 *
 * HTTP URLs and local paths are stripped — only `img_xxx` keys are valid
 * in Feishu card markdown elements.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return ''; // strip all non-img_ image references
  });
}
