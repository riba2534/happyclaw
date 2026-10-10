import { lazy, memo, Suspense } from 'react';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { REMARK_BASE } from '../../lib/markdown/pipeline';
import { RAW_HTML_PATTERN } from '../../lib/markdown/html-tags';

const EnhancedMarkdownRenderer = lazy(() =>
  import('./EnhancedMarkdownRenderer').then((module) => ({
    default: module.EnhancedMarkdownRenderer,
  })),
);
const CodeMarkdownRenderer = lazy(() =>
  import('./CodeMarkdownRenderer').then((module) => ({
    default: module.CodeMarkdownRenderer,
  })),
);
const MathMarkdownRenderer = lazy(() =>
  import('./MathMarkdownRenderer').then((module) => ({
    default: module.MathMarkdownRenderer,
  })),
);
const RawMarkdownRenderer = lazy(() =>
  import('./RawMarkdownRenderer').then((module) => ({
    default: module.RawMarkdownRenderer,
  })),
);

const BASIC_REHYPE_PLUGINS: [] = [];

export interface MarkdownFeatures {
  hasMath: boolean;
  hasCodeFence: boolean;
  hasRawHtml: boolean;
}

export function detectMarkdownFeatures(content: string): MarkdownFeatures {
  return {
    hasMath: content.includes('$$'),
    hasCodeFence: content.includes('```') || content.includes('~~~'),
    // Only HTML the sanitizer keeps: `Promise<void>` stays literal text.
    hasRawHtml: RAW_HTML_PATTERN.test(content),
  };
}

export function needsEnhancedMarkdown(
  features: MarkdownFeatures,
  streaming: boolean,
): boolean {
  if (features.hasCodeFence) return true;
  if (streaming) return false;
  return features.hasMath || features.hasRawHtml;
}

/**
 * Keep ordinary chat messages on the small synchronous Markdown path. Code,
 * math and trusted raw-HTML handling retain the previous pipeline, but load it
 * only when stable content actually needs those processors.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  streaming = false,
  ...props
}: MarkdownRendererProps) {
  const features = detectMarkdownFeatures(props.content);
  const basic = (
    <MarkdownContent
      {...props}
      streaming={streaming}
      remarkPlugins={REMARK_BASE}
      rehypePlugins={BASIC_REHYPE_PLUGINS}
      pipeline="basic"
    />
  );

  if (!needsEnhancedMarkdown(features, streaming)) return basic;

  const enhanced = streaming ? (
    <CodeMarkdownRenderer {...props} streaming />
  ) : features.hasCodeFence && !features.hasMath && !features.hasRawHtml ? (
    <CodeMarkdownRenderer {...props} streaming={streaming} />
  ) : features.hasMath && !features.hasCodeFence && !features.hasRawHtml ? (
    <MathMarkdownRenderer {...props} streaming={streaming} />
  ) : features.hasRawHtml && !features.hasCodeFence && !features.hasMath ? (
    <RawMarkdownRenderer {...props} streaming={streaming} />
  ) : (
    <EnhancedMarkdownRenderer
      {...props}
      streaming={streaming}
      features={features}
    />
  );

  return (
    <Suspense
      fallback={
        <div className="contents" data-markdown-pending="true">
          {basic}
        </div>
      }
    >
      {enhanced}
    </Suspense>
  );
});

export type { MarkdownRendererProps } from './MarkdownContent';
