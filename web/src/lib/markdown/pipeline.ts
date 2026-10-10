import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly';
import { remarkCjkAutolink } from './remark-cjk-autolink';
import { remarkLiteralHtml } from './remark-literal-html';

/**
 * remark plugins every Markdown pipeline shares, so streamed and settled
 * replies parse the same text the same way:
 * - CJK-friendly emphasis/strikethrough: `**注意：**正文` is bold although
 *   CommonMark's flanking rules reject a closing `**` after full-width
 *   punctuation.
 * - Literal autolinks end before Chinese text.
 * - `<word>` that is not an allowlisted HTML tag stays text.
 */
export const REMARK_BASE = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  remarkCjkAutolink,
  remarkLiteralHtml,
  remarkBreaks,
] as const;

/** remark-rehype options: Chinese footnote labels. */
export const REMARK_REHYPE_OPTIONS = {
  footnoteLabel: '脚注',
  footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number) =>
    `返回引用 ${referenceIndex + 1}${rereferenceIndex > 1 ? `-${rereferenceIndex}` : ''}`,
};

/**
 * KaTeX runs after sanitizing, so its output is trusted as generated; cap
 * user-specified sizes (`\rule{999em}{999em}`, `\kern`) so a formula cannot
 * cover the surrounding message.
 */
export const KATEX_OPTIONS = {
  throwOnError: false,
  strict: false,
  maxSize: 20,
} as const;
