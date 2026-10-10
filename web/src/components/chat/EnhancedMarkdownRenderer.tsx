import { useMemo } from 'react';
import remarkMath from 'remark-math';
import {
  HIGHLIGHT_OPTIONS,
  rehypeHighlightShared,
} from './rehypeHighlightShared';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import type { MarkdownFeatures } from './MarkdownRenderer';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';
import { KATEX_OPTIONS, REMARK_BASE } from '../../lib/markdown/pipeline';
import { rehypeEscapeUnknownHtml } from '../../lib/markdown/rehype-escape-unknown-html';
import { rehypeKatexScroll } from '../../lib/markdown/rehype-katex-scroll';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

export interface EnhancedMarkdownRendererProps extends MarkdownRendererProps {
  features: MarkdownFeatures;
}

/**
 * Plugin order follows rehype-katex's guidance: sanitize user HTML first,
 * then let highlight.js and KaTeX add their classes, inline styles and SVG.
 * Sanitizing last stripped KaTeX's `\sqrt` SVG (a formula silently lost its
 * root sign whenever the reply also had code) and needed `class`/`style`
 * exceptions that user HTML could abuse.
 */
export function EnhancedMarkdownRenderer({
  features,
  streaming = false,
  ...props
}: EnhancedMarkdownRendererProps) {
  const math = features.hasMath && !streaming;
  const rawHtml = features.hasRawHtml && !streaming;
  const remarkPlugins = useMemo(
    () =>
      math
        ? [
            ...REMARK_BASE,
            [remarkMath, { singleDollarTextMath: false }] as const,
          ]
        : REMARK_BASE,
    [math],
  );
  const rehypePlugins = useMemo(
    () => [
      ...(rawHtml
        ? [
            rehypeEscapeUnknownHtml,
            rehypeRaw,
            [rehypeSanitize, markdownSanitizeSchema] as const,
          ]
        : []),
      ...(features.hasCodeFence
        ? [[rehypeHighlightShared, HIGHLIGHT_OPTIONS] as const]
        : []),
      ...(math
        ? [[rehypeKatex, KATEX_OPTIONS] as const, rehypeKatexScroll]
        : []),
    ],
    [features.hasCodeFence, math, rawHtml],
  );

  return (
    <MarkdownContent
      {...props}
      streaming={streaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      pipeline={`enhanced:${math ? 'math' : ''}:${features.hasCodeFence ? 'code' : ''}:${rawHtml ? 'raw' : ''}`}
    />
  );
}

export default EnhancedMarkdownRenderer;
