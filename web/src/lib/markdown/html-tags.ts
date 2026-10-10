/**
 * Raw HTML elements chat Markdown keeps. This is the sanitize schema's tag
 * list (GitHub's allowlist plus a few harmless inline tags), shared with the
 * parser so a tag the sanitizer would strip is shown as the text it was
 * written as: `Promise<void>` must not lose `<void>` once a reply settles.
 */
export const MARKDOWN_HTML_TAG_NAMES = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
] as const;

const ALLOWED = new Set<string>(MARKDOWN_HTML_TAG_NAMES);

export function isMarkdownHtmlTag(name: string): boolean {
  return ALLOWED.has(name.toLowerCase());
}

/**
 * Whether text contains raw HTML the sanitizing pipeline would keep: an
 * allowlisted tag or a comment (which it removes). Other `<word>` sequences
 * stay literal text and do not need the raw-HTML pipeline.
 */
export const RAW_HTML_PATTERN = new RegExp(
  `<(?:!--|/?(?:${MARKDOWN_HTML_TAG_NAMES.join('|')})(?=[\\s/>]))`,
  'i',
);

/** An HTML open or close tag, with its name in group 1. */
export const HTML_TAG_PATTERN =
  /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s+[^<>]*?)?\/?>/g;
