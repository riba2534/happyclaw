import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { KATEX_OPTIONS, REMARK_BASE } from '../../lib/markdown/pipeline';
import { rehypeKatexScroll } from '../../lib/markdown/rehype-katex-scroll';
import 'katex/dist/katex.min.css';

const REMARK_PLUGINS = [
  ...REMARK_BASE,
  [remarkMath, { singleDollarTextMath: false }] as const,
];
// No raw HTML reaches this pipeline (it would select the raw one), so
// KaTeX output needs no sanitizing.
const REHYPE_PLUGINS = [
  [rehypeKatex, KATEX_OPTIONS] as const,
  rehypeKatexScroll,
];

export function MathMarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      pipeline="math"
    />
  );
}
