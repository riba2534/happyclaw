import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast';

/** Full-width and CJK punctuation never belongs to a bare URL. */
const CJK_PUNCTUATION =
  /[\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\ufe30-\ufe4f\uff00-\uffef]/;
/** CJK letters (Han, kana, Hangul). */
const CJK_LETTER =
  /[\u2e80-\u2fff\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
/** Separators after which CJK letters are part of the URL (`/wiki/北京`). */
const URL_SEPARATOR = /[/?#=&]/;
/** GFM drops these from the end of a literal autolink. */
const TRAILING_PUNCTUATION = /[?!.,:*_~]$/;

/** Index where the URL text should end, or -1 to keep it whole. */
export function cjkAutolinkCut(text: string): number {
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (CJK_PUNCTUATION.test(char)) return index;
    if (CJK_LETTER.test(char)) {
      const previous = text[index - 1];
      if (URL_SEPARATOR.test(previous) || CJK_LETTER.test(previous)) continue;
      return index;
    }
  }
  return -1;
}

function trimTrailing(url: string): string {
  let result = url;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(result)) {
      result = result.slice(0, -1);
      continue;
    }
    if (result.endsWith(')')) {
      const open = result.split('(').length - 1;
      const close = result.split(')').length - 1;
      if (close > open) {
        result = result.slice(0, -1);
        continue;
      }
    }
    return result;
  }
}

/** Split one literal autolink, returning its replacement nodes. */
function splitLink(link: Link): PhrasingContent[] | null {
  if (link.children.length !== 1 || link.children[0].type !== 'text') {
    return null;
  }
  const text = link.children[0].value;
  // Only literal autolinks: their text is the URL (`www.` ones gain a scheme).
  if (link.url !== text && link.url !== `http://${text}`) return null;
  const cut = cjkAutolinkCut(text);
  if (cut < 0) return null;

  const kept = trimTrailing(text.slice(0, cut));
  const rest: Text = { type: 'text', value: text.slice(kept.length) };
  const host = kept.replace(/^[a-z][a-z0-9+.-]*:\/\/|^www\./i, '');
  if (!/[\p{L}\p{N}]/u.test(host)) {
    return [{ type: 'text', value: text }];
  }
  const prefix = link.url.slice(0, link.url.length - text.length);
  return [
    {
      ...link,
      url: prefix + kept,
      children: [{ type: 'text', value: kept }],
      position: undefined,
    },
    rest,
  ];
}

function walk(parent: Parent) {
  const children = parent.children;
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node.type === 'link') {
      const replacement = splitLink(node as Link);
      if (replacement) {
        children.splice(index, 1, ...(replacement as typeof children));
        index += replacement.length - 1;
      }
      continue;
    }
    if ('children' in node) walk(node as Parent);
  }
}

/**
 * GFM literal autolinks only stop at whitespace, so in Chinese text
 * `https://example.com/chat，后面是中文` linked the rest of the sentence.
 * End the link at the first full-width punctuation, or at the first CJK
 * letter that does not follow a URL separator.
 */
export function remarkCjkAutolink() {
  return (tree: Root) => walk(tree);
}
