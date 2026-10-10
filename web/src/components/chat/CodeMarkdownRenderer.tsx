import {
  HIGHLIGHT_OPTIONS,
  rehypeHighlightShared,
} from './rehypeHighlightShared';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { REMARK_BASE } from '../../lib/markdown/pipeline';
import { endsInOpenFence } from '../../lib/markdown-blocks';
import 'highlight.js/styles/github.css';

const REHYPE_PLUGINS = [[rehypeHighlightShared, HIGHLIGHT_OPTIONS] as const];
const NO_REHYPE_PLUGINS: [] = [];

export function CodeMarkdownRenderer(props: MarkdownRendererProps) {
  // A fence still being streamed re-parses on every update; highlighting
  // all of it each time cost ~3x the parse (48ms per update for 120 lines at
  // 4x CPU). It shows as plain code until it closes, then highlights once.
  const plain = !!props.streaming && endsInOpenFence(props.content);
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_BASE}
      rehypePlugins={plain ? NO_REHYPE_PLUGINS : REHYPE_PLUGINS}
      pipeline={plain ? 'code-open' : 'code'}
    />
  );
}
