import type { Root, RootContent } from 'hast';
import { HTML_TAG_PATTERN, isMarkdownHtmlTag } from './html-tags';

interface RawNode {
  type: 'raw';
  value: string;
}

function escapeUnknownTags(value: string): string {
  return value.replace(HTML_TAG_PATTERN, (tag, name: string) =>
    isMarkdownHtmlTag(name) ? tag : `&lt;${tag.slice(1)}`,
  );
}

function walk(nodes: RootContent[]) {
  for (const node of nodes) {
    if ((node as { type: string }).type === 'raw') {
      const raw = node as unknown as RawNode;
      raw.value = escapeUnknownTags(raw.value);
    } else if ('children' in node) {
      walk(node.children as RootContent[]);
    }
  }
}

/**
 * Run before rehype-raw: inside an HTML block that also holds allowlisted
 * tags (`<summary>Promise<void></summary>`), escape the unknown ones so they
 * parse as text instead of being stripped by the sanitizer. Lone unknown tags
 * were already turned into text by `remarkLiteralHtml`.
 */
export function rehypeEscapeUnknownHtml() {
  return (tree: Root) => walk(tree.children);
}
