import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import 'katex/dist/katex.min.css';

const REMARK_PLUGINS = [
  remarkGfm,
  remarkBreaks,
  [remarkMath, { singleDollarTextMath: false }] as const,
];
const REHYPE_PLUGINS = [
  [rehypeKatex, { throwOnError: false, strict: false }] as const,
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
