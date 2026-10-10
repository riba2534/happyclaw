import type { Html, Paragraph, Parent, Root, Text } from 'mdast';
import { HTML_TAG_PATTERN, isMarkdownHtmlTag } from './html-tags';

const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

function keepsAsHtml(value: string, inline: boolean): boolean {
  if (value.startsWith('<!--')) return true;
  if (inline) {
    const name = TAG_NAME.exec(value)?.[1];
    return name !== undefined && isMarkdownHtmlTag(name);
  }
  for (const match of value.matchAll(HTML_TAG_PATTERN)) {
    if (isMarkdownHtmlTag(match[1])) return true;
  }
  return false;
}

function walk(parent: Parent, inline: boolean) {
  const children = parent.children;
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node.type === 'html') {
      const html = node as Html;
      if (keepsAsHtml(html.value, inline)) continue;
      const text: Text = {
        type: 'text',
        value: html.value,
        position: html.position,
      };
      if (inline) {
        children[index] = text;
      } else {
        const paragraph: Paragraph = {
          type: 'paragraph',
          children: [text],
          position: html.position,
        };
        children[index] = paragraph;
      }
      continue;
    }
    if ('children' in node) {
      walk(
        node as Parent,
        inline ||
          node.type === 'paragraph' ||
          node.type === 'heading' ||
          node.type === 'tableCell',
      );
    }
  }
}

/**
 * Keep `<word>` text that is not an allowlisted HTML tag literal, such as
 * `Promise<void>` or `Array<string>`. The sanitizer used to strip those
 * "elements" once a reply settled, while the streaming view showed them.
 * Runs before remark-breaks so a converted block keeps its line breaks.
 */
export function remarkLiteralHtml() {
  return (tree: Root) => walk(tree, false);
}
