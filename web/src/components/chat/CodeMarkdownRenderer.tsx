import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { rehypeHighlightShared } from './rehypeHighlightShared';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import 'highlight.js/styles/github.css';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [
  [rehypeHighlightShared, { plainText: ['mermaid'] }] as const,
];

export function CodeMarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      pipeline="code"
    />
  );
}
