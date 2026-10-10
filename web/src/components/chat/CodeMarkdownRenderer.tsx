import {
  HIGHLIGHT_OPTIONS,
  rehypeHighlightShared,
} from './rehypeHighlightShared';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { REMARK_BASE } from '../../lib/markdown/pipeline';
import 'highlight.js/styles/github.css';

const REHYPE_PLUGINS = [[rehypeHighlightShared, HIGHLIGHT_OPTIONS] as const];

export function CodeMarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_BASE}
      rehypePlugins={REHYPE_PLUGINS}
      pipeline="code"
    />
  );
}
