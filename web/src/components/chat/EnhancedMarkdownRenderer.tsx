import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import { rehypeHighlightShared } from './rehypeHighlightShared';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import type { MarkdownFeatures } from './MarkdownRenderer';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

export interface EnhancedMarkdownRendererProps extends MarkdownRendererProps {
  features: MarkdownFeatures;
}

export function EnhancedMarkdownRenderer({
  features,
  streaming = false,
  ...props
}: EnhancedMarkdownRendererProps) {
  const remarkPlugins = useMemo(
    () =>
      streaming || !features.hasMath
        ? [remarkGfm, remarkBreaks]
        : [
            remarkGfm,
            remarkBreaks,
            [remarkMath, { singleDollarTextMath: false }] as const,
          ],
    [features.hasMath, streaming],
  );
  const rehypePlugins = useMemo(
    () =>
      streaming
        ? features.hasCodeFence
          ? [[rehypeHighlightShared, { plainText: ['mermaid'] }] as const]
          : []
        : [
            rehypeRaw,
            ...(features.hasCodeFence
              ? [[rehypeHighlightShared, { plainText: ['mermaid'] }] as const]
              : []),
            ...(features.hasMath
              ? [[rehypeKatex, { throwOnError: false, strict: false }] as const]
              : []),
            [rehypeSanitize, markdownSanitizeSchema] as const,
          ],
    [features.hasCodeFence, features.hasMath, streaming],
  );

  return (
    <MarkdownContent
      {...props}
      streaming={streaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      pipeline={`enhanced:${features.hasMath ? 'math' : ''}:${features.hasCodeFence ? 'code' : ''}`}
    />
  );
}

export default EnhancedMarkdownRenderer;
