import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';
import { REMARK_BASE } from '../../lib/markdown/pipeline';
import { rehypeEscapeUnknownHtml } from '../../lib/markdown/rehype-escape-unknown-html';

const REHYPE_PLUGINS = [
  rehypeEscapeUnknownHtml,
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema] as const,
];

export function RawMarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={REMARK_BASE}
      rehypePlugins={REHYPE_PLUGINS}
      pipeline="raw"
    />
  );
}
