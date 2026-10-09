import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { rehypeHighlightShared } from './rehypeHighlightShared';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import 'highlight.js/styles/github.css';

export function CodeMarkdownRenderer(props: MarkdownRendererProps) {
  const rehypePlugins = useMemo(
    () => [[rehypeHighlightShared, { plainText: ['mermaid'] }] as const],
    [],
  );
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={rehypePlugins}
    />
  );
}
