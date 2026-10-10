import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { ListItem, Nodes, Parents, RootContent, Table } from 'mdast';

const parser = unified().use(remarkParse).use(remarkGfm);

function inlineText(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value;
    case 'html':
      return node.value.replace(/<[^>]+>/g, '');
    case 'break':
      return '\n';
    case 'image':
      return node.alt ?? '';
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`;
    default:
      return 'children' in node
        ? (node as Parents).children.map(inlineText).join('')
        : '';
  }
}

function indent(text: string, prefix: string): string {
  const pad = ' '.repeat(prefix.length);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? prefix + line : line ? pad + line : line))
    .join('\n');
}

function tableText(node: Table): string {
  return node.children
    .map((row) => row.children.map(inlineText).join('\t'))
    .join('\n');
}

function blockText(node: RootContent): string {
  switch (node.type) {
    case 'code':
      // Code is copied verbatim: no fence, no Markdown cleanup inside it.
      return node.value;
    case 'list': {
      const start = node.start ?? 1;
      return node.children
        .map((item: ListItem, i) => {
          const marker = node.ordered ? `${start + i}. ` : '- ';
          const check =
            item.checked === true
              ? '[x] '
              : item.checked === false
                ? '[ ] '
                : '';
          const body = item.children
            .map(blockText)
            .join(item.spread ? '\n\n' : '\n');
          return indent(check + body, marker);
        })
        .join(node.spread ? '\n\n' : '\n');
    }
    case 'blockquote':
      return node.children.map(blockText).join('\n\n');
    case 'table':
      return tableText(node);
    case 'thematicBreak':
      return '----';
    case 'footnoteDefinition':
      return `[${node.label ?? node.identifier}] ${node.children
        .map(blockText)
        .join('\n')}`;
    case 'definition':
      return '';
    default:
      return inlineText(node);
  }
}

/**
 * Plain text of a Markdown message as a reader would retype it: Markdown
 * syntax goes, list numbers and bullets stay, code blocks and inline code are
 * copied verbatim (a regex strip used to turn `*args` into `args`).
 */
export function markdownToPlainText(markdown: string): string {
  const tree = parser.parse(markdown);
  return tree.children
    .map(blockText)
    .filter((text) => text !== '')
    .join('\n\n');
}
