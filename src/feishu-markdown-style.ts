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
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    return _optimizeMarkdownStyle(text, cardVersion);
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // ── 1. Extract code blocks, protect with placeholders ──────────
  const { content, codeBlocks } = protectFencedCode(text);
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
    // 4a. Non-table line followed by table line → add blank line
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    // 4b. Table block preceded by blank line → insert <br>
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    // 4c. Table block trailing → append <br>
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
    // 4d. Plain text before table: collapse extra blank lines
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
    // 4d2. Bold text before table
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
    // 4e. Plain text after table: collapse extra blank lines
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

    // Add spacing while the code itself is still protected. An unfinished
    // upstream fence must not acquire a literal <br> inside its code body.
    codeBlocks.forEach(({ token, closed }) => {
      r = r.replace(token, () =>
        closed ? `\n<br>\n${token}\n<br>\n` : `\n<br>\n${token}`,
      );
    });
  }

  // Cleanup only prose: code blank lines and image syntax are literal data.
  r = r.replace(/\n{3,}/g, '\n\n');
  r = stripInvalidImageKeys(r);

  // Function replacers preserve literal $&, $', $`, and $1 in source code.
  codeBlocks.forEach(({ token, source }) => {
    r = r.replace(token, () => source);
  });

  return r;
}

/** Protect CommonMark backtick/tilde fences, including an unfinished tail. */
function protectFencedCode(text: string): {
  content: string;
  codeBlocks: Array<{ token: string; source: string; closed: boolean }>;
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
  return { content: content + text.slice(cursor), codeBlocks };
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
